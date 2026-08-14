import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { git, repositoryIdentity } from "../src/git.js";
import { GitOrchestrator } from "../src/git-orchestrator.js";
import { DispatchService } from "../src/dispatch.js";
import { ReviewService } from "../src/review.js";
import { createResultTemplate } from "../src/contracts.js";
import { StateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);

const rawGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
};

const completeStandardsReview = (store: StateStore, runId: string, summary = "passed"): void => {
  const row = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-standards' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string };
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, row.dispatch_id, "review-standards"), summary, verification: [{ command: "review", outcome: "completed" }], payload: { finding_ids: [] } }), new Date().toISOString(), row.dispatch_id);
};

interface Fixture {
  root: string;
  store: StateStore;
  orchestrator: GitOrchestrator;
  createRun: (planId?: string) => string;
  dispose: () => Promise<void>;
}

const createFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "ai-team-git-test-"));
  const createdRoot = join(directory, "repository");
  const home = join(directory, "home");
  await mkdir(createdRoot);
  await rawGit(createdRoot, ["init", "-b", "main"]);
  await rawGit(createdRoot, ["config", "user.name", "AI Team Test"]);
  await rawGit(createdRoot, ["config", "user.email", "ai-team@example.test"]);
  await writeFile(join(createdRoot, "README.md"), "initial\n");
  await rawGit(createdRoot, ["add", "README.md"]);
  await rawGit(createdRoot, ["commit", "-m", "Initial commit"]);

  const identity = await repositoryIdentity(createdRoot);
  const root = identity.root;
  const store = await StateStore.open(home);
  store.registerRepository(identity.repoId, identity.commonDir, identity.root);
  const orchestrator = new GitOrchestrator(store);
  const createRun = (planId = "20260813-git-orchestration") => store.createRun({
    repoId: identity.repoId,
    profile: "coding",
    mode: "implementation",
    planId,
    baseCommit: rawHead,
    targetBranch: "main",
    request: "test Git orchestration",
  });
  const rawHead = await rawGit(root, ["rev-parse", "HEAD"]);

  return {
    root,
    store,
    orchestrator,
    createRun,
    dispose: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("git rejects forbidden operations and unsafe commit or merge flags", async () => {
  const fixture = await createFixture();
  try {
    const forbidden = ["push", "tag", "rebase", "reset", "clean", "stash", "cherry-pick", "am"];
    for (const operation of forbidden) {
      await assert.rejects(git(fixture.root, [operation]), /forbidden Git operation/);
    }
    await assert.rejects(git(fixture.root, ["commit", "--amend"]), /forbidden Git operation/);
    await assert.rejects(git(fixture.root, ["merge", "--squash", "main"]), /forbidden Git operation/);
    assert.equal((await git(fixture.root, ["branch", "--show-current"])).stdout, "main");
  } finally {
    await fixture.dispose();
  }
});

test("prepareTask owns deterministic names and is idempotent per run", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260813-feature.alpha");
    const prepared = await fixture.orchestrator.prepareTask(runId, "API-Fix");
    assert.equal(prepared.branch, "task/20260813-feature.alpha/api-fix");
    assert.equal(prepared.path, await import("node:fs/promises").then(({ realpath }) => realpath(join(fixture.root, ".worktree", "tasks", "20260813-feature.alpha", "api-fix"))));
    assert.match(prepared.worktree_id, /^worktree_[a-f0-9]{24}$/);
    assert.equal(prepared.reused, false);

    const repeated = await fixture.orchestrator.prepareTask(runId, "API-Fix");
    assert.deepEqual(repeated, { ...prepared, reused: true });

    await writeFile(join(prepared.path, "dependency.txt"), "dependency\n");
    await fixture.orchestrator.commit(runId, prepared.worktree_id, "Complete dependency", ["dependency.txt"]);
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    await fixture.orchestrator.mergeTask(runId, integration.worktree_id, prepared.worktree_id);
    const dependent = await fixture.orchestrator.prepareTask(runId, "dependent", undefined, prepared.worktree_id);
    assert.equal(dependent.base_commit, await rawGit(integration.path, ["rev-parse", "HEAD"]));

    const competingRun = fixture.createRun("20260813-feature.alpha");
    await assert.rejects(
      fixture.orchestrator.prepareTask(competingRun, "api-fix"),
      /branch or worktree belongs to another run/,
    );
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.worktree.create'").get(competingRun) as { count: number }).count,
      0,
    );
  } finally {
    await fixture.dispose();
  }
});

test("commit accepts changed files in scope and rejects files outside it", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "scope-test");
    await mkdir(join(task.path, "src"));
    await writeFile(join(task.path, "src", "allowed.ts"), "export const allowed = true;\n");

    const committed = await fixture.orchestrator.commit(runId, task.worktree_id, "Add allowed file", ["src/**"]);
    assert.deepEqual(committed.paths, ["src/allowed.ts"]);
    assert.match(committed.commit, /^[a-f0-9]{40}$/);
    assert.equal(await rawGit(task.path, ["show", "--format=", "--name-only", committed.commit]), "src/allowed.ts");

    await writeFile(join(task.path, "README.md"), "outside scope\n");
    await assert.rejects(
      fixture.orchestrator.commit(runId, task.worktree_id, "Change outside scope", ["src/**"]),
      /changed path is outside allowed scope: README\.md/,
    );
  } finally {
    await fixture.dispose();
  }
});

test("integration uses no-ff merges and cleanup removes owned worktrees", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "implementation");
    await mkdir(join(task.path, "src"));
    await writeFile(join(task.path, "src", "feature.ts"), "export const feature = true;\n");
    await fixture.orchestrator.commit(runId, task.worktree_id, "Implement feature", ["src/**"]);

    const integration = await fixture.orchestrator.prepareIntegration(runId);
    const integrationCommit = await fixture.orchestrator.mergeTask(runId, integration.worktree_id, task.worktree_id);
    assert.equal((await rawGit(integration.path, ["rev-list", "--parents", "-n", "1", integrationCommit])).split(" ").length, 3);

    const testDispatch = new DispatchService(fixture.store).create(runId, "test", {
      objective: "Verify integration", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["passes"], context: {},
    });
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), testDispatch);
    const reviews = new ReviewService(fixture.store);
    const staleCommit = await rawGit(integration.path, ["rev-parse", `${integrationCommit}^1`]);
    assert.throws(() => reviews.create(runId, staleCommit, false), /stale for the current integration HEAD/);
    const barrier = reviews.create(runId, integrationCommit, false);
    const reviewPacket = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { packet_json: string };
    const packet = JSON.parse(reviewPacket.packet_json);
    assert.match(packet.context.committed_diff, /feature\.ts/);
    assert.equal(packet.context.test_evidence.state, "completed");
    completeStandardsReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "passed", findings: [] });
    const targetCommit = await fixture.orchestrator.integrateTarget(runId, integration.worktree_id);
    assert.equal((await rawGit(fixture.root, ["rev-list", "--parents", "-n", "1", targetCommit])).split(" ").length, 3);
    assert.equal(fixture.store.getRun(runId).state, "completed");

    const removed = await fixture.orchestrator.cleanup(runId);
    assert.deepEqual(new Set(removed), new Set([task.path, integration.path]));
    await assert.rejects(lstat(task.path), { code: "ENOENT" });
    await assert.rejects(lstat(integration.path), { code: "ENOENT" });
    const states = fixture.store.db.prepare("SELECT state FROM worktrees WHERE run_id=?").all(runId) as Array<{ state: string }>;
    assert.ok(states.length > 0);
    assert.ok(states.every(({ state }) => state === "removed"));
  } finally {
    await fixture.dispose();
  }
});

test("review may bind the task implementation commit before an equivalent integration merge", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "direct-review");
    await mkdir(join(task.path, "src"));
    await writeFile(join(task.path, "src", "direct-review.ts"), "export const reviewed = true;\n");
    const implementation = await fixture.orchestrator.commit(runId, task.worktree_id, "Implement direct review", ["src/**"]);
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    assert.notEqual(await rawGit(integration.path, ["rev-parse", "HEAD"]), implementation.commit);

    const testDispatch = new DispatchService(fixture.store).create(runId, "test", {
      objective: "Verify implementation", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["passes"], context: {},
    });
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), testDispatch);
    const reviews = new ReviewService(fixture.store);
    const barrier = reviews.create(runId, implementation.commit, false);
    const packet = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { packet_json: string }).packet_json);
    assert.equal(packet.context.review_strategy, "implementation_commit");
    completeStandardsReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "passed", findings: [] });

    const integrated = await fixture.orchestrator.mergeTask(runId, integration.worktree_id, task.worktree_id);
    assert.doesNotThrow(() => reviews.assertGate(runId, integrated));
  } finally {
    await fixture.dispose();
  }
});

test("target drift sync runs once and requires a newer final test before integration", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "drift-sync");
    await mkdir(join(task.path, "src"));
    await writeFile(join(task.path, "src", "feature.ts"), "export const feature = true;\n");
    await fixture.orchestrator.commit(runId, task.worktree_id, "Implement feature", ["src/**"]);
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    const reviewedCommit = await fixture.orchestrator.mergeTask(runId, integration.worktree_id, task.worktree_id);

    const dispatches = new DispatchService(fixture.store);
    const initialTest = dispatches.create(runId, "test", {
      objective: "Verify frozen implementation", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["passes"], context: {},
    });
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?").run("2026-08-14T00:00:00.000Z", initialTest);
    const reviews = new ReviewService(fixture.store);
    const barrier = reviews.create(runId, reviewedCommit, false);
    completeStandardsReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "passed", findings: [] });

    await writeFile(join(fixture.root, "target.txt"), "target drift\n");
    await rawGit(fixture.root, ["add", "target.txt"]);
    await rawGit(fixture.root, ["commit", "-m", "Advance target"]);

    await assert.rejects(
      fixture.orchestrator.integrateTarget(runId, integration.worktree_id),
      /latest independent test dispatch has not completed/,
    );
    const finalTests = fixture.store.db.prepare("SELECT dispatch_id,state,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at").all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string }>;
    assert.equal(finalTests.length, 2);
    assert.equal(finalTests[1]?.state, "pending");
    assert.equal(JSON.parse(finalTests[1]!.packet_json).context.synchronization_commit, await rawGit(integration.path, ["rev-parse", "HEAD"]));
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?").run("9999-12-31T23:59:59.999Z", finalTests[1]!.dispatch_id);

    const integrated = await fixture.orchestrator.integrateTarget(runId, integration.worktree_id);
    assert.match(integrated, /^[a-f0-9]{40}$/);
    const syncOperations = fixture.store.db.prepare("SELECT state FROM operations WHERE run_id=? AND kind='git.sync'").all(runId) as Array<{ state: string }>;
    assert.deepEqual(syncOperations, [{ state: "completed" }]);
    const testCount = fixture.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number };
    assert.equal(testCount.count, 2);
  } finally {
    await fixture.dispose();
  }
});

test("cleanup validation failure does not create a pending side-effect operation", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "dirty-cleanup");
    await writeFile(join(task.path, "dirty.txt"), "dirty\n");
    fixture.store.db.prepare("UPDATE runs SET state='completed' WHERE run_id=?").run(runId);

    await assert.rejects(fixture.orchestrator.cleanup(runId), /worktree is dirty/);
    const count = fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.cleanup'").get(runId) as { count: number };
    assert.equal(count.count, 0);
  } finally {
    await fixture.dispose();
  }
});

test("conflict continuation refuses ordinary staged changes without MERGE_HEAD", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    await writeFile(join(integration.path, "README.md"), "ordinary change\n");
    await assert.rejects(
      fixture.orchestrator.continueConflict(runId, integration.worktree_id, ["README.md"]),
      /no merge conflict in progress/,
    );
  } finally { await fixture.dispose(); }
});

test("commit rejects sensitive files and symlinks escaping the worktree", async (context) => {
  await context.test("sensitive path", async () => {
    const fixture = await createFixture();
    try {
      const runId = fixture.createRun();
      const task = await fixture.orchestrator.prepareTask(runId, "sensitive-path");
      await writeFile(join(task.path, ".env.local"), "TOKEN=secret\n");
      await assert.rejects(
        fixture.orchestrator.commit(runId, task.worktree_id, "Add environment", ["**"]),
        /writing sensitive path is forbidden: \.env\.local/,
      );
    } finally {
      await fixture.dispose();
    }
  });

  await context.test("symlink escape", async () => {
    const fixture = await createFixture();
    try {
      const runId = fixture.createRun();
      const task = await fixture.orchestrator.prepareTask(runId, "symlink-escape");
      const outside = join(fixture.root, "..", "outside.txt");
      await writeFile(outside, "outside\n");
      await mkdir(join(task.path, "src"));
      await symlink(outside, join(task.path, "src", "outside-link"));
      await assert.rejects(
        fixture.orchestrator.commit(runId, task.worktree_id, "Add escaping link", ["src/**"]),
        /path escapes repository through canonicalization: src\/outside-link/,
      );
    } finally {
      await fixture.dispose();
    }
  });
});
