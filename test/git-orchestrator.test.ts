import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { git, repositoryIdentity } from "../src/git.js";
import { GitOrchestrator } from "../src/git-orchestrator.js";
import { StateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);

const rawGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
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
    profile: "test",
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

    const competingRun = fixture.createRun("20260813-feature.alpha");
    await assert.rejects(
      fixture.orchestrator.prepareTask(competingRun, "api-fix"),
      /branch or worktree belongs to another run/,
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
