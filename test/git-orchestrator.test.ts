import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { git, repositoryIdentity } from "../src/git.js";
import { GitOrchestrator } from "../src/git-orchestrator.js";
import { DispatchService } from "../src/dispatch.js";
import { ReviewService } from "../src/review.js";
import { createResultTemplate } from "../src/contracts.js";
import { StateStore } from "../src/state.js";
import { ScopeGate } from "../src/gates.js";
import { sha256 } from "../src/utils.js";
import { ValidationError } from "../src/errors.js";
import { resolveMergeTaskWorktree, resolveTaskIdentityWorktree } from "../src/worktree-ownership.js";
import { stagingFilePath } from "../src/security.js";

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

const completeSpecReview = (store: StateStore, runId: string): void => {
  const row = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-spec' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string };
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, row.dispatch_id, "review-spec"), summary: "passed", verification: [{ command: "review", outcome: "completed" }], payload: { finding_ids: [] } }), new Date().toISOString(), row.dispatch_id);
};

const completeFrozenTest = (store: StateStore, runId: string, commit: string, completedAt = new Date().toISOString()): void => {
  const dispatches = new DispatchService(store);
  const testDispatch = dispatches.create(runId, "test", {
    objective: "Verify frozen integration", allowed_read_paths: ["README.md"], allowed_write_paths: [], acceptance_criteria: ["passes"], context: { implementation_commit: commit, implementation_committed: true, changed_paths: ["README.md"] },
  });
  fixtureCompleteTest(store, runId, testDispatch, completedAt);
  const packet = dispatches.buildReviewPacket(runId);
  assert.ok(packet);
  dispatches.create(runId, "code-reviewer", packet);
};

const fixtureCompleteTest = (store: StateStore, runId: string, dispatchId: string, completedAt = new Date().toISOString()): void => {
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, dispatchId, "test"), summary: "passed", verification: [{ command: "test", outcome: "passed" }], payload: { checks: [{ command: "test", outcome: "passed" }] } }), completedAt, dispatchId);
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
    const suffix = runId.slice(-8).toLowerCase();
    const prepared = await fixture.orchestrator.prepareTask(runId, "API-Fix");
    assert.equal(prepared.branch, `task/20260813-feature.alpha/${suffix}/api-fix`);
    assert.equal(prepared.path, await import("node:fs/promises").then(({ realpath }) => realpath(join(fixture.root, ".worktrees", "tasks", "20260813-feature.alpha", suffix, "api-fix"))));
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
    const competing = await fixture.orchestrator.prepareTask(competingRun, "api-fix");
    assert.notEqual(competing.path, prepared.path);
    assert.notEqual(competing.branch, prepared.branch);
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.worktree.create'").get(competingRun) as { count: number }).count,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});

test("planned runs use revision-scoped plan and task worktrees without run-short segments", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260813-feature";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", "007", "tasks");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "TASK-001.md"), "# TASK-001\n");
    await writeFile(join(taskRoot, "TASK-002.md"), "# TASK-002\n");
    await rawGit(fixture.root, ["add", ".ai-team"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze split tasks"]);
    const runId = fixture.store.createRun({
      repoId: (await repositoryIdentity(fixture.root)).repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision: "007",
      baseCommit: await rawGit(fixture.root, ["rev-parse", "HEAD"]),
      targetBranch: "main",
    });
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const planRevision = `${planId}-007`;
    assert.equal(plan.branch, `plan/${planId}/${planRevision}`);
    assert.equal(plan.path, await import("node:fs/promises").then(({ realpath }) => realpath(join(fixture.root, ".worktrees", "plans", planId, planRevision))));
    assert.equal(plan.branch.includes(runId.slice(-8).toLowerCase()), false);
    fixture.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_wrong_direct", runId, `integration/direct-${runId.slice(-8).toLowerCase()}/${runId.slice(-8).toLowerCase()}`, `/tmp/${runId}-wrong-direct`, plan.base_commit, "9999-12-31T23:59:59.999Z");

    const first = await fixture.orchestrator.prepareTask(runId, "TASK-001");
    assert.equal(first.branch, `task/${planId}/${planRevision}--task-001`);
    assert.equal(first.path, await import("node:fs/promises").then(({ realpath }) => realpath(join(fixture.root, ".worktrees", "tasks", planId, `${planRevision}--task-001`))));
    assert.equal(first.base_commit, await rawGit(plan.path, ["rev-parse", "HEAD"]));
    await assert.rejects(
      fixture.orchestrator.prepareTask(runId, "TASK-002", "a".repeat(40)),
      /base must equal the current plan worktree HEAD/,
    );

    await writeFile(join(first.path, "task-one.txt"), "task one\n");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["task-one.txt"], first.worktree_id);
    await fixture.orchestrator.commit(runId, first.worktree_id, "Complete TASK-001", ["task-one.txt"]);
    const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, first.worktree_id);
    const second = await fixture.orchestrator.prepareTask(runId, "TASK-002");
    assert.equal(second.branch, `task/${planId}/${planRevision}--task-002`);
    assert.equal(second.base_commit, merged);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND branch LIKE 'task/%'").get(runId) as { count: number }).count, 2);
    const statuses = await fixture.orchestrator.status(runId);
    const planStatus = statuses.find(({ type }) => type === "plan");
    assert.deepEqual(planStatus && {
      type: planStatus.type,
      owner: planStatus.owner,
      branch: planStatus.branch,
      base: planStatus.base_commit,
      head: planStatus.head,
      state: planStatus.state,
      clean: planStatus.clean,
    }, {
      type: "plan",
      owner: planId,
      branch: `plan/${planId}/${planRevision}`,
      base: plan.base_commit,
      head: merged,
      state: "active",
      clean: true,
    });
  } finally {
    await fixture.dispose();
  }
});

test("planned pre_commit accepts the exact plan-owned worktree without changing its owner", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260818-plan-owned-scope";
    const identity = await repositoryIdentity(fixture.root);
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision: "001",
      baseCommit: await rawGit(fixture.root, ["rev-parse", "HEAD"]),
      targetBranch: "main",
    });
    const planOwnerRunId = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "feature", targetBranch: "main" });
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    await fixture.orchestrator.transfer(planOwnerRunId, plan.worktree_id);
    assert.deepEqual(await fixture.orchestrator.prepareIntegration(runId), { ...plan, reused: true });

    await writeFile(join(plan.path, "plan-owned.txt"), "planned change\n");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["plan-owned.txt"], plan.worktree_id);
    const committed = await fixture.orchestrator.commit(runId, plan.worktree_id, "Commit plan-owned implementation", ["plan-owned.txt"]);
    assert.match(committed.commit, /^[a-f0-9]{40}$/);
    assert.equal((fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(plan.worktree_id) as { run_id: string }).run_id, planOwnerRunId);
  } finally {
    await fixture.dispose();
  }
});

test("planned resume replaces a clean stale next-Task worktree from current plan HEAD without replaying the prior merge", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260818-stale-task";
    const revision = "001";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "tasks");
    await mkdir(join(fixture.root, ".ai-team", "index"), { recursive: true });
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(fixture.root, "MEMORY.md"), "# fixture\n");
    await writeFile(join(fixture.root, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
    await writeFile(join(taskRoot, "TASK-001.md"), "# TASK-001\n");
    await writeFile(join(taskRoot, "TASK-002.md"), "# TASK-002\n");
    await rawGit(fixture.root, ["add", ".ai-team", "MEMORY.md"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze stale task fixture"]);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const identity = await repositoryIdentity(fixture.root);
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision,
      baseCommit,
      targetBranch: "main",
    });
    fixture.store.initializeRunTasks(runId, ["TASK-001", "TASK-002"].map((taskId, index) => ({
      task_id: taskId,
      source_path: `.ai-team/plans/${planId}/revisions/${revision}/tasks/${taskId}.md`,
      source_digest: String(index + 1).repeat(64),
      write_paths: [taskId === "TASK-001" ? "task-one.txt" : "task-two.txt"],
    })));
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const staleSecond = await fixture.orchestrator.prepareTask(runId, "TASK-002");
    const first = await fixture.orchestrator.prepareTask(runId, "TASK-001");
    await writeFile(join(first.path, "task-one.txt"), "task one\n");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["task-one.txt"], first.worktree_id);
    await fixture.orchestrator.commit(runId, first.worktree_id, "Complete TASK-001", ["task-one.txt"]);
    const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, first.worktree_id);

    const dispatches = new DispatchService(fixture.store);
    const packet = {
      objective: "Recover the stale next Task",
      allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "task-one.txt"],
      allowed_write_paths: [],
      acceptance_criteria: ["Preserve prior integration"],
      context: {},
    };
    const explorerId = dispatches.create(runId, "file-explorer", { ...packet, allowed_read_paths: ["."] });
    const explorerResult = {
      ...createResultTemplate(runId, explorerId, "file-explorer"),
      summary: "scope complete",
      verification: [{ command: "fixture", outcome: "passed" }],
      payload: {
        allowed_read_paths: packet.allowed_read_paths,
        entry_points: ["MEMORY.md"],
        test_commands: ["fixture"],
        project_context: {
          project_shape: "fixture",
          memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
          navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["MEMORY.md"], module_boundary: "root" }],
          maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
        },
      },
    };
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(explorerResult), new Date().toISOString(), explorerId);
    const coordinatorId = dispatches.create(runId, "coding", { ...packet, context: { explorer_dispatch_id: explorerId, worktree_id: plan.worktree_id } });
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify({ ...createResultTemplate(runId, coordinatorId, "coding"), summary: "TASK-001 integrated", verification: [], payload: { actions: [] } }), new Date().toISOString(), coordinatorId);

    const resumed = dispatches.resume(runId);
    const replacement = resumed.pending_dispatches.find(({ role }) => role === "git-operator")!;
    const replacementPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(replacement.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(replacementPacket.context.task_id, "TASK-002");
    assert.equal(replacementPacket.context.base_commit, merged);
    assert.equal(replacementPacket.context.replace_worktree_id, staleSecond.worktree_id);
    assert.equal(replacementPacket.context.replace_base_commit, baseCommit);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.merge.task'").get(runId) as { count: number }).count, 1);

    dispatches.claim(runId, replacement.dispatch_id, "git-operator");
    const refreshed = await fixture.orchestrator.prepareTask(runId, "TASK-002", merged, undefined, replacement.dispatch_id);
    assert.equal(refreshed.worktree_id, staleSecond.worktree_id);
    assert.equal(refreshed.base_commit, merged);
    assert.equal(await rawGit(refreshed.path, ["rev-parse", "HEAD"]), merged);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.merge.task'").get(runId) as { count: number }).count, 1);
  } finally {
    await fixture.dispose();
  }
});

test("planned single explicit Task reuses the plan worktree and reaches final Test only after integration", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260818-single-task";
    const revision = "001";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "tasks");
    await mkdir(join(fixture.root, ".ai-team", "index"), { recursive: true });
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(fixture.root, "MEMORY.md"), "# fixture\n");
    await writeFile(join(fixture.root, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
    await writeFile(join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "plan.md"), "# plan\n");
    const taskContent = "# TASK-001\n\n- 允许写入路径：`single.txt`\n";
    await writeFile(join(taskRoot, "TASK-001.md"), taskContent);
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }));
    await rawGit(fixture.root, ["add", ".ai-team", "MEMORY.md", "package.json"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze single task fixture"]);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const identity = await repositoryIdentity(fixture.root);
    fixture.store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
      .run(planId, revision, identity.repoId, "main", "b".repeat(64), baseCommit, new Date().toISOString());
    const runId = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "planned", planId, revision, baseCommit, targetBranch: "main", planDigest: "b".repeat(64) });
    fixture.store.initializeRunTasks(runId, [{
      task_id: "TASK-001",
      source_path: `.ai-team/plans/${planId}/revisions/${revision}/tasks/TASK-001.md`,
      source_digest: sha256(taskContent),
      write_paths: ["single.txt"],
    }]);
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const dispatches = new DispatchService(fixture.store);
    const packet = (allowedReadPaths: string[] = []) => ({
      objective: "Exercise a single frozen Task",
      allowed_read_paths: allowedReadPaths,
      allowed_write_paths: [],
      acceptance_criteria: ["Preserve the single Task identity"],
      context: {},
    });
    const result = (dispatchId: string, role: Parameters<typeof createResultTemplate>[2], payload: Record<string, unknown>) => ({
      ...createResultTemplate(runId, dispatchId, role),
      summary: `${role} completed`,
      verification: [{ command: "fixture", outcome: "passed" }],
      payload,
    });
    const explorerId = dispatches.create(runId, "file-explorer", packet(["."]));
    dispatches.claim(runId, explorerId, "file-explorer");
    const explored = await dispatches.submitValue(runId, explorerId, "file-explorer", result(explorerId, "file-explorer", {
      allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "single.txt"],
      entry_points: ["MEMORY.md"],
      test_commands: ["npm run test"],
      project_context: {
        project_shape: "fixture",
        memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
        navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["MEMORY.md"], module_boundary: "root" }],
        maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
      },
    }));
    const verifyPlan = explored.continuation.pending_dispatches.find(({ role }) => role === "git-operator")!;
    dispatches.claim(runId, verifyPlan.dispatch_id, "git-operator");
    const verified = await dispatches.submitValue(runId, verifyPlan.dispatch_id, "git-operator", result(verifyPlan.dispatch_id, "git-operator", {
      operations: [{ command: "verify plan worktree", outcome: plan.worktree_id }],
    }));
    assert.deepEqual(fixture.store.runTasks(runId).map(({ state, worktree_id }) => ({ state, worktree_id })), [{ state: "prepared", worktree_id: plan.worktree_id }]);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND branch LIKE 'task/%'").get(runId) as { count: number }).count, 0);

    const coordinator = verified.continuation.pending_dispatches.find(({ role }) => role === "coding")!;
    dispatches.claim(runId, coordinator.dispatch_id, "coding");
    const developerId = dispatches.create(runId, "backend-developer", {
      ...packet(["single.txt"]),
      allowed_write_paths: ["single.txt"],
      context: {
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: coordinator.dispatch_id,
        task_id: "TASK-001",
        worktree_id: plan.worktree_id,
        worktree_path: plan.path,
      },
    }, "coding", coordinator.dispatch_id);
    dispatches.claim(runId, developerId, "backend-developer");
    await writeFile(join(plan.path, "single.txt"), "single task\n");
    await dispatches.submitValue(runId, coordinator.dispatch_id, "coding", result(coordinator.dispatch_id, "coding", { actions: ["implement TASK-001"] }));
    await dispatches.submitValue(runId, developerId, "backend-developer", result(developerId, "backend-developer", {
      modified_paths: ["single.txt"], self_tests: [{ command: "npm run test", outcome: "passed" }],
    }));
    assert.equal(fixture.store.runTasks(runId)[0]!.state, "implemented");

    const taskTest = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "test")!;
    const taskTestPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(taskTest.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(taskTestPacket.context.phase, "task_test");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["single.txt"], plan.worktree_id);
    dispatches.claim(runId, taskTest.dispatch_id, "test");
    await dispatches.submitValue(runId, taskTest.dispatch_id, "test", result(taskTest.dispatch_id, "test", {
      checks: taskTestPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })),
    }));
    assert.equal(fixture.store.runTasks(runId)[0]!.state, "tested");

    const commitContinuation = dispatches.resume(runId).pending_dispatches.find(({ role }) => role === "coding")!;
    dispatches.claim(runId, commitContinuation.dispatch_id, "coding");
    const commitDispatch = dispatches.create(runId, "git-operator", {
      ...packet(["single.txt"]),
      context: { phase: "commit_implementation", explorer_dispatch_id: explorerId, task_id: "TASK-001", worktree_id: plan.worktree_id },
    }, "coding", commitContinuation.dispatch_id);
    dispatches.claim(runId, commitDispatch, "git-operator");
    const committed = await fixture.orchestrator.commit(runId, plan.worktree_id, "Complete TASK-001", ["single.txt"], commitDispatch);
    await dispatches.submitValue(runId, commitDispatch, "git-operator", result(commitDispatch, "git-operator", {
      operations: [{ command: "commit TASK-001", outcome: committed.commit }],
    }));
    assert.equal(fixture.store.runTasks(runId)[0]!.state, "integrated");

    const finalTest = dispatches.continuation(runId).pending_dispatches.find(({ role, dispatch_id }) => {
      if (role !== "test") return false;
      const row = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
      return JSON.parse(row.packet_json).context.phase !== "task_test";
    })!;
    const finalPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(finalTest.dispatch_id) as { packet_json: string }).packet_json);
    assert.deepEqual(finalPacket.context.frozen_task_ids, ["TASK-001"]);
    assert.deepEqual(finalPacket.context.implementation_artifacts.map((artifact: { task_id: string }) => artifact.task_id), ["TASK-001"]);
    assert.deepEqual(finalPacket.context.changed_paths, ["single.txt"]);
  } finally {
    await fixture.dispose();
  }
});

test("planned multi-task run continues from prepare through test and derives the next task from the no-ff merge", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260817-continuation";
    const revision = "001";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "tasks");
    await mkdir(join(fixture.root, ".ai-team", "index"), { recursive: true });
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(fixture.root, "MEMORY.md"), "# fixture\n");
    await writeFile(join(fixture.root, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
    await writeFile(join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "plan.md"), "# plan\n\n## 验证\n\n- Run repository scripts.\n");
    const taskContents = new Map([
      ["TASK-001", "# TASK-001\n\n- 允许写入路径：`task-one.txt`\n"],
      ["TASK-002", "# TASK-002\n\n- 允许写入路径：`task-two.txt`\n"],
      ["TASK-003", "# TASK-003\n\n- 允许写入路径：`test/generated.test.ts`\n"],
    ]);
    for (const [taskId, content] of taskContents) await writeFile(join(taskRoot, `${taskId}.md`), content);
    await mkdir(join(fixture.root, "test"), { recursive: true });
    await writeFile(join(fixture.root, "test", "existing.test.ts"), "// Explorer baseline\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint ." } }));
    await rawGit(fixture.root, ["add", ".ai-team", "MEMORY.md", "package.json", "test/existing.test.ts"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze continuation tasks"]);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const identity = await repositoryIdentity(fixture.root);
    fixture.store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
      .run(planId, revision, identity.repoId, "main", "a".repeat(64), baseCommit, new Date().toISOString());
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision,
      baseCommit,
      targetBranch: "main",
      planDigest: "a".repeat(64),
    });
    fixture.store.initializeRunTasks(runId, ["TASK-001", "TASK-002", "TASK-003"].map((taskId) => ({
      task_id: taskId,
      source_path: `.ai-team/plans/${planId}/revisions/${revision}/tasks/${taskId}.md`,
      source_digest: sha256(taskContents.get(taskId)!),
      write_paths: taskId === "TASK-001" ? ["task-one.txt"] : taskId === "TASK-002" ? ["task-two.txt"] : ["test/generated.test.ts"],
    })));
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const dispatches = new DispatchService(fixture.store);
    const packet = (allowedReadPaths: string[] = []) => ({
      objective: "Exercise the planned task continuation",
      allowed_read_paths: allowedReadPaths,
      allowed_write_paths: [],
      acceptance_criteria: ["Preserve the frozen task identity"],
      context: {},
    });
    const result = (dispatchId: string, role: Parameters<typeof createResultTemplate>[2], payload: Record<string, unknown>) => ({
      ...createResultTemplate(runId, dispatchId, role),
      summary: `${role} completed`,
      verification: [{ command: "fixture verification", outcome: "passed" }],
      payload,
    });
    const authorizedPaths = ["MEMORY.md", ".ai-team/index/feature-navigation.md", "task-one.txt", "task-two.txt", "test/existing.test.ts"];
    const explorerId = dispatches.create(runId, "file-explorer", packet(["."]));
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify(result(explorerId, "file-explorer", {
      allowed_read_paths: authorizedPaths,
      entry_points: ["MEMORY.md"],
      test_commands: ["fixture verification"],
      project_context: {
        project_shape: "fixture",
        memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
        navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["MEMORY.md"], module_boundary: "root" }],
        maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
      },
    })), new Date().toISOString(), explorerId);
    const coordinatorId = dispatches.create(runId, "coding", { ...packet(authorizedPaths), context: { explorer_dispatch_id: explorerId, worktree_id: plan.worktree_id } });
    dispatches.claim(runId, coordinatorId, "coding");
    const prepareId = dispatches.create(runId, "git-operator", {
      ...packet([]),
      context: { phase: "prepare_implementation_worktree", task_id: "TASK-001", explorer_dispatch_id: explorerId, coordinator_dispatch_id: coordinatorId },
    }, "coding", coordinatorId);
    dispatches.claim(runId, prepareId, "git-operator");
    const firstTask = await fixture.orchestrator.prepareTask(runId, "TASK-001", undefined, undefined, prepareId);
    await dispatches.submitValue(runId, coordinatorId, "coding", result(coordinatorId, "coding", { actions: ["prepare TASK-001"] }));
    const prepared = await dispatches.submitValue(runId, prepareId, "git-operator", result(prepareId, "git-operator", {
      operations: [{ command: "ai-team git prepare --task-id TASK-001", outcome: firstTask.worktree_id }],
    }));
    const implementationContinuationId = prepared.continuation.pending_dispatches[0]!.dispatch_id;
    dispatches.claim(runId, implementationContinuationId, "coding");
    const developerId = dispatches.create(runId, "backend-developer", {
      ...packet(["task-one.txt"]),
      allowed_write_paths: ["task-one.txt"],
      context: {
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: implementationContinuationId,
        task_id: "TASK-001",
        worktree_id: firstTask.worktree_id,
        worktree_path: firstTask.path,
      },
    }, "coding", implementationContinuationId);
    dispatches.claim(runId, developerId, "backend-developer");
    await writeFile(join(firstTask.path, "task-one.txt"), "task one\n");
    await dispatches.submitValue(runId, implementationContinuationId, "coding", result(implementationContinuationId, "coding", { actions: ["dispatch TASK-001 developer"] }));
    await dispatches.submitValue(runId, developerId, "backend-developer", result(developerId, "backend-developer", {
      modified_paths: ["task-one.txt"], self_tests: [{ command: "fixture verification", outcome: "passed" }],
    }));

    const taskTest = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "test")!;
    const taskTestPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(taskTest.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(taskTestPacket.context.phase, "task_test");
    assert.equal(taskTestPacket.context.task_id, "TASK-001");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["task-one.txt"], firstTask.worktree_id);
    dispatches.claim(runId, taskTest.dispatch_id, "test");
    await dispatches.submitValue(runId, taskTest.dispatch_id, "test", result(taskTest.dispatch_id, "test", {
      checks: taskTestPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })),
    }));

    const commitContinuation = dispatches.resume(runId).pending_dispatches[0]!;
    dispatches.claim(runId, commitContinuation.dispatch_id, "coding");
    const commitDispatchId = dispatches.create(runId, "git-operator", {
      ...packet(["task-one.txt"]),
      context: { phase: "commit_implementation", explorer_dispatch_id: explorerId, worktree_id: firstTask.worktree_id, task_id: "TASK-001" },
    }, "coding", commitContinuation.dispatch_id);
    dispatches.claim(runId, commitDispatchId, "git-operator");
    const committed = await fixture.orchestrator.commit(runId, firstTask.worktree_id, "Complete TASK-001", ["task-one.txt"], commitDispatchId);
    await dispatches.submitValue(runId, commitDispatchId, "git-operator", result(commitDispatchId, "git-operator", {
      operations: [{ command: "ai-team git commit", outcome: committed.commit }],
    }));
    const mergeDispatch = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "git-operator")!;
    const mergePacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(mergeDispatch.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(mergePacket.context.task_id, "TASK-001");
    assert.equal(mergePacket.context.task_worktree_id, firstTask.worktree_id);
    assert.equal(mergePacket.context.implementation_worktree_id, firstTask.worktree_id);
    dispatches.claim(runId, mergeDispatch.dispatch_id, "git-operator");
    const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, "TASK-001", mergeDispatch.dispatch_id);
    await dispatches.submitValue(runId, mergeDispatch.dispatch_id, "git-operator", result(mergeDispatch.dispatch_id, "git-operator", {
      operations: [{ command: "ai-team git merge-task", outcome: merged }],
    }));
    assert.equal((await rawGit(plan.path, ["rev-list", "--parents", "-n", "1", merged])).split(" ").length, 3);

    const nextPrepare = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "git-operator")!;
    const nextPreparePacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(nextPrepare.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(nextPreparePacket.context.phase, "prepare_implementation_worktree");
    assert.equal(nextPreparePacket.context.task_id, "TASK-002");
    assert.equal(nextPreparePacket.context.base_commit, merged);
    dispatches.claim(runId, nextPrepare.dispatch_id, "git-operator");
    const secondTask = await fixture.orchestrator.prepareTask(runId, "TASK-002", merged, undefined, nextPrepare.dispatch_id);
    assert.equal(secondTask.base_commit, merged);
    const secondPrepared = await dispatches.submitValue(runId, nextPrepare.dispatch_id, "git-operator", result(nextPrepare.dispatch_id, "git-operator", {
      operations: [{ command: "ai-team git prepare --task-id TASK-002", outcome: secondTask.worktree_id }],
    }));
    const completeTask = async (
      taskId: string,
      task: typeof secondTask,
      path: string,
      continuationId: string,
      writePaths = [path],
      readPaths = [path],
    ): Promise<string> => {
      dispatches.claim(runId, continuationId, "coding");
      const developerId = dispatches.create(runId, "backend-developer", {
        ...packet(readPaths),
        allowed_write_paths: writePaths,
        context: {
          explorer_dispatch_id: explorerId,
          coordinator_dispatch_id: continuationId,
          task_id: taskId,
          worktree_id: task.worktree_id,
          worktree_path: task.path,
        },
      }, "coding", continuationId);
      dispatches.claim(runId, developerId, "backend-developer");
      await writeFile(join(task.path, path), `${taskId}\n`);
      await dispatches.submitValue(runId, continuationId, "coding", result(continuationId, "coding", { actions: [`dispatch ${taskId} developer`] }));
      await dispatches.submitValue(runId, developerId, "backend-developer", result(developerId, "backend-developer", {
        modified_paths: [path], self_tests: [{ command: "fixture verification", outcome: "passed" }],
      }));

      const testDispatch = dispatches.continuation(runId).pending_dispatches.find(({ role, dispatch_id }) => {
        if (role !== "test") return false;
        const row = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
        return JSON.parse(row.packet_json).context.task_id === taskId;
      })!;
      const testPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(testDispatch.dispatch_id) as { packet_json: string }).packet_json);
      assert.equal(testPacket.context.phase, "task_test");
      new ScopeGate(fixture.store).check(runId, "pre_commit", [path], task.worktree_id);
      dispatches.claim(runId, testDispatch.dispatch_id, "test");
      await dispatches.submitValue(runId, testDispatch.dispatch_id, "test", result(testDispatch.dispatch_id, "test", {
        checks: testPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })),
      }));

      const commitContinuation = dispatches.resume(runId).pending_dispatches.find(({ role, dispatch_id }) => {
        if (role !== "coding") return false;
        const row = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
        return JSON.parse(row.packet_json).context.phase === "continue_commit";
      })!;
      dispatches.claim(runId, commitContinuation.dispatch_id, "coding");
      const commitDispatchId = dispatches.create(runId, "git-operator", {
        ...packet(readPaths),
        allowed_write_paths: writePaths,
        context: { phase: "commit_implementation", explorer_dispatch_id: explorerId, worktree_id: task.worktree_id, task_id: taskId },
      }, "coding", commitContinuation.dispatch_id);
      dispatches.claim(runId, commitDispatchId, "git-operator");
      const committed = await fixture.orchestrator.commit(runId, task.worktree_id, `Complete ${taskId}`, writePaths, commitDispatchId);
      await dispatches.submitValue(runId, commitDispatchId, "git-operator", result(commitDispatchId, "git-operator", {
        operations: [{ command: "ai-team git commit", outcome: committed.commit }],
      }));
      const mergeDispatch = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "git-operator")!;
      dispatches.claim(runId, mergeDispatch.dispatch_id, "git-operator");
      const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, taskId, mergeDispatch.dispatch_id);
      await dispatches.submitValue(runId, mergeDispatch.dispatch_id, "git-operator", result(mergeDispatch.dispatch_id, "git-operator", {
        operations: [{ command: "ai-team git merge-task", outcome: merged }],
      }));
      return merged;
    };

    const taskContinuationId = (pending: typeof secondPrepared.continuation.pending_dispatches, taskId: string): string => pending.find(({ role, dispatch_id }) => {
      if (role !== "coding") return false;
      const row = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
      const context = JSON.parse(row.packet_json).context;
      return context.phase === "continue_implementation" && context.task_id === taskId;
    })!.dispatch_id;
    const secondContinuationId = taskContinuationId(secondPrepared.continuation.pending_dispatches, "TASK-002");
    const secondMerged = await completeTask("TASK-002", secondTask, "task-two.txt", secondContinuationId);
    assert.equal((fixture.store.db.prepare(`SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'
      AND COALESCE(json_extract(packet_json,'$.context.phase'),'')!='task_test'`).get(runId) as { count: number }).count, 0);
    const thirdPrepare = dispatches.continuation(runId).pending_dispatches.find(({ role }) => role === "git-operator")!;
    const thirdPreparePacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(thirdPrepare.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(thirdPreparePacket.context.task_id, "TASK-003");
    assert.equal(thirdPreparePacket.context.base_commit, secondMerged);
    dispatches.claim(runId, thirdPrepare.dispatch_id, "git-operator");
    const thirdTask = await fixture.orchestrator.prepareTask(runId, "TASK-003", secondMerged, undefined, thirdPrepare.dispatch_id);
    const thirdPrepared = await dispatches.submitValue(runId, thirdPrepare.dispatch_id, "git-operator", result(thirdPrepare.dispatch_id, "git-operator", {
      operations: [{ command: "ai-team git prepare --task-id TASK-003", outcome: thirdTask.worktree_id }],
    }));
    const thirdContinuationId = taskContinuationId(thirdPrepared.continuation.pending_dispatches, "TASK-003");
    const thirdMerged = await completeTask("TASK-003", thirdTask, "test/generated.test.ts", thirdContinuationId, ["test/generated.test.ts"], ["test/existing.test.ts"]);
    const finalTest = dispatches.continuation(runId).pending_dispatches.find(({ role, dispatch_id }) => {
      if (role !== "test") return false;
      const row = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
      return JSON.parse(row.packet_json).context.phase !== "task_test";
    })!;
    const finalPacket = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(finalTest.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(finalPacket.context.implementation_commit, thirdMerged);
    assert.deepEqual(finalPacket.context.frozen_task_ids, ["TASK-001", "TASK-002", "TASK-003"]);
    assert.deepEqual(finalPacket.context.implementation_artifacts.map((artifact: { task_id: string }) => artifact.task_id).sort(), ["TASK-001", "TASK-002", "TASK-003"]);
    assert.deepEqual(finalPacket.context.changed_paths.sort(), ["task-one.txt", "task-two.txt", "test/generated.test.ts"]);
    assert.deepEqual(fixture.store.runTasks(runId).map(({ state }) => state), ["integrated", "integrated", "integrated"]);

    const resumed = dispatches.resume(runId);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND json_extract(packet_json,'$.context.phase')='continue_implementation' AND json_extract(packet_json,'$.context.task_id')='TASK-001'").get(runId) as { count: number }).count, 1);
    assert.equal(resumed.pending_decision, null);
  } finally {
    await fixture.dispose();
  }
});

test("historical planned merge reissues failed ownership repair, adopts only the task, and remains idempotent", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260818-ownership-recovery";
    const revision = "001";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "tasks");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "TASK-001.md"), "# TASK-001\n");
    await writeFile(join(taskRoot, "TASK-002.md"), "# TASK-002\n");
    await rawGit(fixture.root, ["add", ".ai-team"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze ownership recovery tasks"]);
    const identity = await repositoryIdentity(fixture.root);
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision,
      baseCommit: await rawGit(fixture.root, ["rev-parse", "HEAD"]),
      targetBranch: "main",
    });
    const legacyRunId = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "feature", targetBranch: "main" });
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const task = await fixture.orchestrator.prepareTask(runId, "TASK-001");
    await writeFile(join(task.path, "task-one.txt"), "task one\n");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["task-one.txt"], task.worktree_id);
    await fixture.orchestrator.commit(runId, task.worktree_id, "Complete TASK-001", ["task-one.txt"]);
    await fixture.orchestrator.transfer(legacyRunId, plan.worktree_id);
    await fixture.orchestrator.transfer(legacyRunId, task.worktree_id);

    const dispatches = new DispatchService(fixture.store);
    const mergeDispatchId = dispatches.create(runId, "git-operator", {
      objective: "Merge TASK-001 into the plan worktree",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge the task exactly once"],
      context: {
        phase: "integrate_implementation",
        integration_worktree_id: plan.worktree_id,
        task_id: "TASK-001",
        task_worktree_id: task.worktree_id,
        task_worktree_ids: [task.worktree_id],
        implementation_worktree_id: task.worktree_id,
        worktree_id: task.worktree_id,
      },
    });
    dispatches.claim(runId, mergeDispatchId, "git-operator");
    await assert.rejects(
      fixture.orchestrator.mergeTask(runId, plan.worktree_id, "TASK-001", mergeDispatchId),
      (error: Error) => error.message.includes(`worktree ${task.worktree_id} is not consumable by run ${runId}`)
        && error.message.includes("constraint=run_id=expected_run_id")
        && error.message.includes(`actual_run_id=${legacyRunId}`),
    );
    const historicalFailure = {
      ...createResultTemplate(runId, mergeDispatchId, "git-operator"),
      status: "failed",
      summary: "Registered worktrees have stale ownership",
      verification: [],
      failure_class: "temporary_tool_failure",
      side_effect_state: "none",
      payload: { operations: [] },
    };
    fixture.store.db.prepare("UPDATE dispatches SET state='failed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(historicalFailure), new Date().toISOString(), mergeDispatchId);
    fixture.store.db.prepare("UPDATE runs SET state='failed' WHERE run_id=?").run(runId);
    assert.equal(dispatches.resume(runId).pending_dispatches.length, 0);

    const revived = dispatches.reissue(runId, mergeDispatchId, "git-operator", "coding", "revive historical no-side-effect failure");
    assert.equal(fixture.store.getRun(runId).state, "active");
    const ownershipDispatchId = revived.dispatch_id;
    const ownershipRow = fixture.store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(ownershipDispatchId) as { replacement_for: string; packet_json: string };
    const ownershipPacket = JSON.parse(ownershipRow.packet_json);
    assert.equal(ownershipRow.replacement_for, mergeDispatchId);
    assert.equal(ownershipPacket.context.phase, "reconcile_worktree_ownership");
    assert.equal(ownershipPacket.context.task_id, "TASK-001");
    assert.equal(ownershipPacket.context.task_worktree_id, task.worktree_id);
    assert.equal(ownershipPacket.context.implementation_worktree_id, task.worktree_id);
    const taskCommit = await rawGit(task.path, ["rev-parse", "HEAD"]);
    assert.deepEqual(ownershipPacket.context.worktree_ids, [task.worktree_id]);
    assert.deepEqual(ownershipPacket.context.task_worktrees, [{
      worktree_id: task.worktree_id,
      path: task.path,
      branch: task.branch,
      base_commit: plan.base_commit,
      commit: taskCommit,
    }]);

    dispatches.claim(runId, ownershipDispatchId, "git-operator");
    await assert.rejects(
      fixture.orchestrator.adopt(runId, plan.path, plan.branch, plan.base_commit, plan.base_commit, ownershipDispatchId),
      /direct-child commit/,
    );
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.worktree.adopt'").get(runId) as { count: number }).count, 0);
    const rejected = await dispatches.submitValue(runId, ownershipDispatchId, "git-operator", {
      ...createResultTemplate(runId, ownershipDispatchId, "git-operator"),
      status: "failed",
      summary: "Plan worktree was rejected before Git changed",
      verification: [],
      failure_class: "invalid_operation_order",
      side_effect_state: "none",
      payload: { operations: [] },
    });
    assert.equal(rejected.submission.dispatch_state, "retryable_failure");
    assert.equal(fixture.store.getRun(runId).state, "retryable_failure");

    const retry = dispatches.resume(runId).pending_dispatches[0]!;
    dispatches.claim(runId, retry.dispatch_id, "git-operator");
    const adopted = await fixture.orchestrator.adopt(runId, task.path, task.branch, plan.base_commit, taskCommit, retry.dispatch_id);
    assert.equal(adopted.worktree_id, task.worktree_id);
    assert.equal((await fixture.orchestrator.adopt(runId, task.path, task.branch, plan.base_commit, taskCommit, retry.dispatch_id)).reused, true);
    assert.deepEqual(
      fixture.store.db.prepare("SELECT run_id,adopted_from_run_id FROM worktrees WHERE worktree_id=?").get(task.worktree_id),
      { run_id: runId, adopted_from_run_id: legacyRunId },
    );
    assert.equal((fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(plan.worktree_id) as { run_id: string }).run_id, legacyRunId);
    const repaired = await dispatches.submitValue(runId, retry.dispatch_id, "git-operator", {
      ...createResultTemplate(runId, retry.dispatch_id, "git-operator"),
      summary: "Ownership restored",
      verification: [{ command: "ai-team git adopt", outcome: "TASK-001 adopted" }],
      payload: { operations: [{ command: "ai-team git adopt", outcome: "completed" }] },
    });
    const replacement = repaired.continuation.pending_dispatches.find(({ role }) => role === "git-operator")!;
    assert.notEqual(replacement.dispatch_id, mergeDispatchId);
    const replacementRow = fixture.store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(replacement.dispatch_id) as { replacement_for: string; packet_json: string };
    assert.equal(replacementRow.replacement_for, retry.dispatch_id);
    const replacementPacket = JSON.parse(replacementRow.packet_json);
    assert.equal(replacementPacket.context.phase, "integrate_implementation");
    assert.equal(replacementPacket.context.task_id, "TASK-001");
    assert.equal(replacementPacket.context.task_worktree_id, task.worktree_id);
    assert.equal(replacementPacket.context.implementation_worktree_id, task.worktree_id);

    dispatches.claim(runId, replacement.dispatch_id, "git-operator");
    const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, "TASK-001", replacement.dispatch_id);
    await dispatches.submitValue(runId, replacement.dispatch_id, "git-operator", {
      ...createResultTemplate(runId, replacement.dispatch_id, "git-operator"),
      summary: "TASK-001 merged",
      verification: [{ command: "git rev-list --parents -n 1", outcome: "no-ff merge" }],
      payload: { operations: [{ command: "ai-team git merge-task", outcome: merged }] },
    });
    assert.equal((await rawGit(plan.path, ["rev-list", "--parents", "-n", "1", merged])).split(" ").length, 3);
    assert.equal(await fixture.orchestrator.mergeTask(runId, plan.worktree_id, task.worktree_id), merged);
    dispatches.resume(runId);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.merge.task'").get(runId) as { count: number }).count, 1);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND json_extract(packet_json,'$.context.phase')='integrate_implementation'").get(runId) as { count: number }).count, 2);
    assert.equal((fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(plan.worktree_id) as { run_id: string }).run_id, legacyRunId);
  } finally {
    await fixture.dispose();
  }
});

test("planned merge reconciles completed transfer and adopt before merging exactly once", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260818-partial-ownership";
    const revision = "001";
    const taskRoot = join(fixture.root, ".ai-team", "plans", planId, "revisions", revision, "tasks");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "TASK-001.md"), "# TASK-001\n");
    await writeFile(join(taskRoot, "TASK-002.md"), "# TASK-002\n");
    await rawGit(fixture.root, ["add", ".ai-team"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze partial ownership tasks"]);
    const identity = await repositoryIdentity(fixture.root);
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision,
      baseCommit: await rawGit(fixture.root, ["rev-parse", "HEAD"]),
      targetBranch: "main",
    });
    const legacyRunId = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "feature", targetBranch: "main" });
    const plan = await fixture.orchestrator.prepareIntegration(runId);
    const task = await fixture.orchestrator.prepareTask(runId, "TASK-001");
    await writeFile(join(task.path, "task-one.txt"), "task one\n");
    new ScopeGate(fixture.store).check(runId, "pre_commit", ["task-one.txt"], task.worktree_id);
    await fixture.orchestrator.commit(runId, task.worktree_id, "Complete TASK-001", ["task-one.txt"]);
    await fixture.orchestrator.transfer(legacyRunId, plan.worktree_id);
    await fixture.orchestrator.transfer(legacyRunId, task.worktree_id);

    const dispatches = new DispatchService(fixture.store);
    const mergePacket = {
      objective: "Restore ownership and merge TASK-001",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge the task exactly once"],
      context: {
        phase: "integrate_implementation",
        worktree_id: plan.worktree_id,
        integration_worktree_id: plan.worktree_id,
        task_id: "TASK-001",
        task_worktree_id: task.worktree_id,
        task_worktree_ids: [task.worktree_id],
      },
    };
    const originalMergeDispatchId = dispatches.create(runId, "git-operator", mergePacket);
    const superseded = dispatches.supersede(runId, originalMergeDispatchId, "git-operator", "coding", "freeze explicit managed worktree bindings", mergePacket);
    const mergeDispatchId = superseded.dispatch_id;
    assert.deepEqual(dispatches.mergeWorktreeBindings(runId, mergeDispatchId), {
      integration_worktree_id: plan.worktree_id,
      task_worktree_ids: [task.worktree_id],
    });
    dispatches.claim(runId, mergeDispatchId, "git-operator");
    assert.equal((await fixture.orchestrator.transfer(runId, plan.worktree_id, mergeDispatchId)).reused, false);
    const taskCommit = await rawGit(task.path, ["rev-parse", "HEAD"]);
    assert.equal((await fixture.orchestrator.adopt(runId, task.path, task.branch, plan.base_commit, taskCommit, mergeDispatchId)).reused, false);
    assert.equal((await fixture.orchestrator.transfer(runId, plan.worktree_id, mergeDispatchId)).reused, true);
    assert.equal((await fixture.orchestrator.adopt(runId, task.path, task.branch, plan.base_commit, taskCommit, mergeDispatchId)).reused, true);
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.worktree.transfer'").get(runId) as { count: number }).count,
      1,
    );
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.worktree.adopt'").get(runId) as { count: number }).count,
      1,
    );

    await dispatches.submitValue(runId, mergeDispatchId, "git-operator", {
      ...createResultTemplate(runId, mergeDispatchId, "git-operator"),
      status: "retryable_failure",
      summary: "Ownership completed before the client disconnected",
      verification: [{ command: "ai-team git transfer/adopt", outcome: "completed" }],
      failure_class: "client_disconnect",
      side_effect_state: "none",
      payload: { operations: [{ command: "ai-team git transfer/adopt", outcome: "completed" }] },
    });

    const resumed = dispatches.resume(runId);
    assert.equal(resumed.recovery?.side_effect_state, "completed");
    assert.match(resumed.recovery?.next_command ?? "", /dispatch reconcile/);
    assert.match((await fixture.orchestrator.reconcile(runId))[0]?.fact ?? "", /merge not started/);

    const reconciled = dispatches.reconcile(runId, mergeDispatchId, "git-operator", "coding", "ownership completed; merge did not start");
    const replacementRow = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(reconciled.dispatch_id) as { packet_json: string };
    assert.equal(JSON.parse(replacementRow.packet_json).context.phase, "integrate_implementation");
    assert.deepEqual(dispatches.mergeWorktreeBindings(runId, reconciled.dispatch_id), {
      integration_worktree_id: plan.worktree_id,
      task_worktree_ids: [task.worktree_id],
    });
    dispatches.claim(runId, reconciled.dispatch_id, "git-operator");
    await assert.rejects(
      fixture.orchestrator.mergeTask(runId, "worktree_unbound_integration", "TASK-001", reconciled.dispatch_id),
      (error: Error) => error.message.includes("expected_task_id=TASK-001")
        && error.message.includes("actual_task_id=TASK-001")
        && error.message.includes(`expected_task_worktree_id=${task.worktree_id}`)
        && error.message.includes(`actual_task_worktree_id=${task.worktree_id}`)
        && error.message.includes("expected_integration_worktree_id=worktree_unbound_integration")
        && error.message.includes(`actual_integration_worktree_id=${plan.worktree_id}`),
    );
    const merged = await fixture.orchestrator.mergeTask(runId, plan.worktree_id, "TASK-001", reconciled.dispatch_id);
    assert.equal((await rawGit(plan.path, ["rev-list", "--parents", "-n", "1", merged])).split(" ").length, 3);
    assert.equal(await fixture.orchestrator.mergeTask(runId, plan.worktree_id, task.worktree_id), merged);
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.merge.task'").get(runId) as { count: number }).count,
      1,
    );
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind IN ('git.worktree.transfer','git.worktree.adopt')").get(runId) as { count: number }).count,
      2,
    );
  } finally {
    await fixture.dispose();
  }
});

test("planned run recovery reuses a run-owned legacy integration worktree", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260813-legacy";
    const runId = fixture.store.createRun({
      repoId: (await repositoryIdentity(fixture.root)).repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision: "003",
      baseCommit: await rawGit(fixture.root, ["rev-parse", "HEAD"]),
      targetBranch: "main",
    });
    fixture.store.db.prepare("UPDATE runs SET mode='implementation' WHERE run_id=?").run(runId);
    const legacy = await fixture.orchestrator.prepareIntegration(runId);
    fixture.store.db.prepare("UPDATE runs SET mode='planned' WHERE run_id=?").run(runId);

    const recovered = await fixture.orchestrator.prepareIntegration(runId);
    assert.deepEqual(recovered, { ...legacy, reused: true });
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND state='active'").get(runId) as { count: number }).count,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});

test("planned run does not select a direct integration worktree without planned provenance", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260813-direct");
    const direct = await fixture.orchestrator.prepareIntegration(runId);
    fixture.store.db.prepare("UPDATE runs SET mode='planned',revision='004' WHERE run_id=?").run(runId);

    await assert.rejects(fixture.orchestrator.prepareIntegration(runId), /unknown side effect/);
    assert.deepEqual(
      fixture.store.db.prepare("SELECT run_id,branch,path FROM worktrees WHERE worktree_id=?").get(direct.worktree_id),
      { run_id: runId, branch: direct.branch, path: direct.path },
    );
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});

test("managed adopt binds a direct-child commit and transfer changes only the registered owner", async () => {
  const fixture = await createFixture();
  try {
    const sourceRun = fixture.createRun("20260813-recovery.alpha");
    const targetRun = fixture.createRun("20260813-recovery.alpha");
    const base = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const path = join(fixture.root, ".worktrees", "tasks", "legacy", "implementation");
    const branch = "task/legacy/implementation";
    await mkdir(join(path, ".."), { recursive: true });
    await rawGit(fixture.root, ["worktree", "add", "-b", branch, path, base]);
    await writeFile(join(path, "README.md"), "recovered\n");
    await rawGit(path, ["add", "README.md"]);
    await rawGit(path, ["commit", "-m", "Recovered implementation"]);
    const implementation = await rawGit(path, ["rev-parse", "HEAD"]);

    const adopted = await fixture.orchestrator.adopt(sourceRun, path, branch, base, implementation);
    assert.equal((fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(adopted.worktree_id) as { run_id: string }).run_id, sourceRun);
    const transferred = await fixture.orchestrator.transfer(targetRun, adopted.worktree_id);
    assert.equal(transferred.worktree_id, adopted.worktree_id);
    assert.deepEqual(
      fixture.store.db.prepare("SELECT run_id,adopted_from_run_id FROM worktrees WHERE worktree_id=?").get(adopted.worktree_id),
      { run_id: targetRun, adopted_from_run_id: sourceRun },
    );
    const commitRun = fixture.createRun("20260813-recovery.beta");
    const adoptedCommit = await fixture.orchestrator.adoptCommit(commitRun, implementation);
    assert.equal(await rawGit(adoptedCommit.path, ["rev-parse", "HEAD"]), implementation);
    assert.equal(
      (fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(adoptedCommit.worktree_id) as { run_id: string }).run_id,
      commitRun,
    );
  } finally {
    await fixture.dispose();
  }
});

test("recoverTaskWorktree atomically carries a dirty managed Task into its direct superseding revision", async () => {
  const fixture = await createFixture();
  try {
    const planId = "20260820-worktree-recovery";
    const identity = await repositoryIdentity(fixture.root);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const sourceDigest = "1".repeat(64);
    const targetDigest = "2".repeat(64);
    fixture.store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready','main',?,?,?)")
      .run(planId, "001", identity.repoId, sourceDigest, baseCommit, new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,supersedes,created_at) VALUES (?,?,?,'ready','main',?,?,?,?)")
      .run(planId, "002", identity.repoId, targetDigest, baseCommit, "001", new Date().toISOString());
    const sourceRun = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "planned", planId, revision: "001", baseCommit, targetBranch: "main", planDigest: sourceDigest });
    const targetRun = fixture.store.createRun({ repoId: identity.repoId, profile: "coding", mode: "planned", planId, revision: "002", baseCommit, targetBranch: "main", planDigest: targetDigest });
    fixture.store.initializeRunTasks(sourceRun, [{ task_id: "TASK-001", source_path: "tasks/TASK-001.md", source_digest: "a".repeat(64), write_paths: ["README.md", "untracked.txt"] }]);
    fixture.store.initializeRunTasks(targetRun, [{ task_id: "TASK-001", source_path: "tasks/TASK-001.md", source_digest: "b".repeat(64), write_paths: ["README.md", "test/core.test.ts", "untracked.txt"] }]);

    const worktreePath = join(fixture.root, ".worktrees", "tasks", planId, `${planId}-001--task-001`);
    const branch = `task/${planId}/${planId}-001--task-001`;
    await mkdir(join(worktreePath, ".."), { recursive: true });
    await rawGit(fixture.root, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
    const worktreeId = "worktree_recover_dirty_task";
    fixture.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, sourceRun, branch, worktreePath, baseCommit, new Date().toISOString());
    const developerId = "dispatch_source_developer";
    fixture.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,completed_at,created_at)
      VALUES (?,?,'backend-developer','completed',?,'fixture','{}','{}',?,?)`)
      .run(developerId, sourceRun, JSON.stringify({ context: { task_id: "TASK-001", worktree_id: worktreeId } }), new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("UPDATE run_tasks SET state='implemented',worktree_id=?,developer_dispatch_id=? WHERE run_id=? AND task_id='TASK-001'")
      .run(worktreeId, developerId, sourceRun);
    const artifactId = "artifact_source_task_001";
    const artifactDigest = "d".repeat(64);
    fixture.store.db.prepare("INSERT INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
      .run(artifactId, sourceRun, developerId, "/managed/source-result.json", artifactDigest, new Date().toISOString());

    await writeFile(join(worktreePath, "README.md"), "staged\n");
    await rawGit(worktreePath, ["add", "README.md"]);
    await writeFile(join(worktreePath, "README.md"), "staged\nunstaged\n");
    await writeFile(join(worktreePath, "untracked.txt"), "untracked bytes\n");
    const before = {
      head: await rawGit(worktreePath, ["rev-parse", "HEAD"]),
      branch: await rawGit(worktreePath, ["branch", "--show-current"]),
      staged: await rawGit(worktreePath, ["diff", "--cached", "--binary"]),
      unstaged: await rawGit(worktreePath, ["diff", "--binary"]),
      untracked: await readFile(join(worktreePath, "untracked.txt"), "utf8"),
    };

    const request = {
      project: fixture.root, worktreeId, fromPlanId: planId, fromRevision: "001", toPlanId: planId,
      toRevision: "002", toRunId: targetRun, taskId: "TASK-001", expectedHead: baseCommit,
      expectedSourceArtifact: artifactId,
    };
    const assertNoRecoverySideEffects = () => {
      assert.equal((fixture.store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id=?").get(worktreeId) as { run_id: string }).run_id, sourceRun);
      assert.equal((fixture.store.db.prepare("SELECT worktree_id FROM run_tasks WHERE run_id=? AND task_id='TASK-001'").get(targetRun) as { worktree_id?: string }).worktree_id, null);
      assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE kind='git.worktree.recover'").get() as { count: number }).count, 0);
    };

    fixture.store.db.prepare("UPDATE revisions SET supersedes='000' WHERE repo_id=? AND plan_id=? AND revision='002'").run(identity.repoId, planId);
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree(request), /directly supersede/);
    assertNoRecoverySideEffects();
    fixture.store.db.prepare("UPDATE revisions SET supersedes='001' WHERE repo_id=? AND plan_id=? AND revision='002'").run(identity.repoId, planId);
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree({ ...request, expectedHead: "f".repeat(40) }), /HEAD does not match/);
    assertNoRecoverySideEffects();
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree({ ...request, expectedSourceArtifact: "artifact_wrong" }), /artifact does not match/);
    assertNoRecoverySideEffects();
    await writeFile(join(worktreePath, "outside-scope.txt"), "must be rejected\n");
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree(request), /dirty path is outside target task scope: outside-scope.txt/);
    assertNoRecoverySideEffects();
    await rm(join(worktreePath, "outside-scope.txt"));

    const holderId = "dispatch_active_recovery_holder";
    fixture.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at)
      VALUES (?,?,'git-operator','claimed','{}','fixture','{}','{}',?,?)`).run(holderId, sourceRun, new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO dispatch_worktree_bindings(dispatch_id,run_id,binding_kind,worktree_id,created_at) VALUES (?,?,'task',?,?)")
      .run(holderId, sourceRun, worktreeId, new Date().toISOString());
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree(request), /held by another active dispatch/);
    assertNoRecoverySideEffects();
    fixture.store.db.prepare("UPDATE dispatches SET state='failed' WHERE dispatch_id=?").run(holderId);

    const legacyDispatchId = "dispatch_legacy_recovery_task_001";
    const legacyPacket = (sourceWorktreeId: string) => JSON.stringify({ context: {
      phase: "recover_implementation_worktree", task_id: "TASK-001", source_worktree_id: sourceWorktreeId, source_run_id: sourceRun,
    } });
    fixture.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at)
      VALUES (?,?,'git-operator','claimed',?,'fixture','{}','{}',?,?)`)
      .run(legacyDispatchId, targetRun, legacyPacket("worktree_wrong_source"), new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO dispatch_worktree_bindings(dispatch_id,run_id,binding_kind,worktree_id,created_at) VALUES (?,?,'task',?,?)")
      .run(legacyDispatchId, targetRun, worktreeId, new Date().toISOString());
    const stagingId = "staging_legacy_recovery_task_001";
    const stagingBytes = "{\"legacy\":\"recovery result bytes\"}\n";
    const stagingDigest = sha256(stagingBytes);
    const stagingPath = stagingFilePath(fixture.store.paths.staging, targetRun, 1, "dispatch-result", "git-operator");
    await mkdir(dirname(stagingPath), { recursive: true });
    await writeFile(stagingPath, stagingBytes);
    const now = new Date().toISOString();
    fixture.store.db.prepare(`INSERT INTO staging_entries(staging_id,run_id,sequence_no,dispatch_id,role,kind,state,content_sha256,content_bytes,created_at,updated_at,expires_at)
      VALUES (?,?,1,?,'git-operator','dispatch-result','ready',?,?,?,?,?)`)
      .run(stagingId, targetRun, legacyDispatchId, stagingDigest, Buffer.byteLength(stagingBytes), now, now, "9999-12-31T23:59:59.999Z");
    const replacementRequest = { ...request, replacesStagingId: stagingId };
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree(replacementRequest), /does not match the legacy task worktree recovery lineage/);
    assertNoRecoverySideEffects();
    assert.deepEqual(fixture.store.db.prepare("SELECT state,replaced_by_operation_id FROM staging_entries WHERE staging_id=?").get(stagingId), {
      state: "ready", replaced_by_operation_id: null,
    });
    assert.equal(await readFile(stagingPath, "utf8"), stagingBytes);
    fixture.store.db.prepare("UPDATE dispatches SET packet_json=? WHERE dispatch_id=?").run(legacyPacket(worktreeId), legacyDispatchId);

    fixture.store.db.exec(`CREATE TEMP TRIGGER fail_recovery_audit BEFORE INSERT ON run_events
      WHEN NEW.type='worktree.recovered' BEGIN SELECT RAISE(ABORT, 'injected recovery audit failure'); END;`);
    await assert.rejects(fixture.orchestrator.recoverTaskWorktree(replacementRequest), /injected recovery audit failure/);
    assertNoRecoverySideEffects();
    assert.deepEqual(fixture.store.db.prepare("SELECT state,replaced_by_operation_id FROM staging_entries WHERE staging_id=?").get(stagingId), {
      state: "ready", replaced_by_operation_id: null,
    });
    fixture.store.db.exec("DROP TRIGGER fail_recovery_audit");

    const recovered = await fixture.orchestrator.recoverTaskWorktree(replacementRequest);
    assert.equal(recovered.reused, false);
    assert.equal(recovered.worktree_id, worktreeId);
    assert.deepEqual(recovered.dirty_paths, ["README.md", "untracked.txt"]);
    assert.deepEqual(recovered.replaced_staging, {
      staging_id: stagingId, dispatch_id: legacyDispatchId, digest: stagingDigest,
      before_state: "ready", after_state: "canceled", operation_id: recovered.recovery_id,
    });
    assert.deepEqual(fixture.store.db.prepare("SELECT run_id,adopted_from_run_id FROM worktrees WHERE worktree_id=?").get(worktreeId), {
      run_id: targetRun, adopted_from_run_id: sourceRun,
    });
    assert.deepEqual(fixture.store.db.prepare("SELECT state,worktree_id FROM run_tasks WHERE run_id=? AND task_id='TASK-001'").get(targetRun), {
      state: "prepared", worktree_id: worktreeId,
    });
    assert.equal(resolveTaskIdentityWorktree(fixture.store, targetRun, "TASK-001").branch, branch);
    assert.equal(resolveMergeTaskWorktree(fixture.store, targetRun, worktreeId).branch, branch);
    assert.deepEqual(fixture.store.db.prepare("SELECT state,replaced_by_operation_id FROM staging_entries WHERE staging_id=?").get(stagingId), {
      state: "canceled", replaced_by_operation_id: recovered.recovery_id,
    });
    assert.equal(await readFile(stagingPath, "utf8"), stagingBytes);
    assert.deepEqual({
      head: await rawGit(worktreePath, ["rev-parse", "HEAD"]),
      branch: await rawGit(worktreePath, ["branch", "--show-current"]),
      staged: await rawGit(worktreePath, ["diff", "--cached", "--binary"]),
      unstaged: await rawGit(worktreePath, ["diff", "--binary"]),
      untracked: await readFile(join(worktreePath, "untracked.txt"), "utf8"),
    }, before);
    assert.deepEqual(await fixture.orchestrator.recoverTaskWorktree(replacementRequest), { ...recovered, reused: true });
  } finally {
    await fixture.dispose();
  }
});

test("claimed planned developer scope recovery supersedes without touching its dirty task worktree", async () => {
  const fixture = await createFixture();
  try {
    const identity = await repositoryIdentity(fixture.root);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const runId = fixture.store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId: "20260820-scope-recovery",
      revision: "001",
      baseCommit,
      targetBranch: "main",
      request: "recover frozen claimed developer scope",
      planVerification: {
        acceptance_criteria: ["AC-001"],
        acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
        task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
        test_commands: ["npm test"],
      },
    });
    fixture.store.initializeRunTasks(runId, [{
      task_id: "TASK-001",
      source_path: "tasks/TASK-001.md",
      source_digest: "a".repeat(64),
      write_paths: ["README.md"],
      verification: {
        acceptance_criteria: ["AC-001"],
        acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
        task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
        test_commands: ["npm test"],
        tdd_cycles: [{ acceptance_criterion: "AC-001", test_path: "test/authority.test.ts", red: { command: "npm test", expected_failure: "fails" }, green: { implementation_steps: ["implement"], command: "npm test", expected_result: "passes" }, refactor: { scope: "none", command: "npm test", expected_result: "passes" } }],
      },
    }, {
      task_id: "TASK-002",
      source_path: "tasks/TASK-002.md",
      source_digest: "b".repeat(64),
      write_paths: ["README.md"],
    }]);
    const taskPath = join(fixture.root, ".worktrees", "tasks", "20260820-scope-recovery", "20260820-scope-recovery-001--task-001");
    const taskBranch = "task/20260820-scope-recovery/20260820-scope-recovery-001--task-001";
    await mkdir(dirname(taskPath), { recursive: true });
    await rawGit(fixture.root, ["worktree", "add", "-b", taskBranch, taskPath, baseCommit]);
    const prepared = { worktree_id: "worktree_scope_recovery", path: taskPath };
    fixture.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(prepared.worktree_id, runId, taskBranch, taskPath, baseCommit, new Date().toISOString());
    fixture.store.db.prepare("UPDATE run_tasks SET state='prepared',worktree_id=? WHERE run_id=? AND task_id='TASK-001'")
      .run(prepared.worktree_id, runId);
    const dispatches = new DispatchService(fixture.store);
    const explorerId = "dispatch_scope_recovery_explorer";
    fixture.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,result_json,completed_at,created_at)
      VALUES (?,?,'file-explorer','completed','{}','fixture','{}','{}',?,?,?)`)
      .run(explorerId, runId, JSON.stringify({ payload: { allowed_read_paths: ["README.md"] } }), new Date().toISOString(), new Date().toISOString());
    const sourceId = dispatches.create(runId, "backend-developer", {
      objective: "Implement TASK-001", allowed_read_paths: ["README.md"], allowed_write_paths: ["README.md"], acceptance_criteria: ["Preserve task identity"],
      context: {
        phase: "implementation",
        task_id: "TASK-001",
        worktree_id: prepared.worktree_id,
        worktree_path: prepared.path,
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: "dispatch_coordinator",
        prepare_git_dispatch_id: "dispatch_prepare",
      },
    });
    dispatches.claim(runId, sourceId, "backend-developer");

    await writeFile(join(prepared.path, "README.md"), "staged\n");
    await rawGit(prepared.path, ["add", "README.md"]);
    await writeFile(join(prepared.path, "README.md"), "staged\nunstaged\n");
    await writeFile(join(prepared.path, "dirty.txt"), "untracked\n");
    fixture.store.db.prepare("UPDATE run_tasks SET write_paths_json=? WHERE run_id=? AND task_id='TASK-001'")
      .run(JSON.stringify(["README.md", "dirty.txt"]), runId);
    const before = {
      head: await rawGit(prepared.path, ["rev-parse", "HEAD"]),
      staged: await rawGit(prepared.path, ["diff", "--cached", "--binary"]),
      unstaged: await rawGit(prepared.path, ["diff", "--binary"]),
      untracked: await readFile(join(prepared.path, "dirty.txt"), "utf8"),
    };

    await mkdir(join(fixture.root, "src", "commands"), { recursive: true });
    await writeFile(join(fixture.root, "src", "contracts.ts"), "export {};\n");
    await writeFile(join(fixture.root, "src", "commands", "planning-run.ts"), "export {};\n");
    await rawGit(fixture.root, ["add", "src"]);
    await rawGit(fixture.root, ["commit", "-m", "Add scope recovery authority"]);
    const authorityCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);

    const recovered = dispatches.recoverClaimedTaskScope({
      runId,
      dispatchId: sourceId,
      authorityCommit,
      expectedHead: baseCommit,
      addedWritePaths: ["src/contracts.ts", "src/commands/planning-run.ts"],
    });
    assert.equal(recovered.action, "superseded");
    assert.equal(recovered.role, "git-operator");
    assert.equal(recovered.claim_command, `ai-team dispatch claim --run-id ${runId} --dispatch-id ${recovered.dispatch_id} --role git-operator --bundle`);
    assert.deepEqual(recovered.allowed_write_paths, ["README.md", "dirty.txt", "src/commands/planning-run.ts", "src/contracts.ts"]);
    assert.deepEqual(recovered.dirty_paths, ["README.md", "dirty.txt"]);
    assert.deepEqual(fixture.store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(sourceId), { state: "failed" });
    assert.deepEqual(fixture.store.db.prepare("SELECT role,state,replacement_for FROM dispatches WHERE dispatch_id=?").get(recovered.dispatch_id), { role: "git-operator", state: "pending", replacement_for: sourceId });
    const replacement = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(recovered.dispatch_id) as { packet_json: string };
    const packet = JSON.parse(replacement.packet_json) as { allowed_write_paths: string[]; context: Record<string, unknown> };
    assert.deepEqual(packet.allowed_write_paths, recovered.allowed_write_paths);
    assert.equal(packet.context.phase, "apply_task_authority");
    assert.equal(packet.context.operation, "apply-task-authority");
    assert.equal(typeof packet.context.verification_digest, "string");
    assert.equal(packet.context.superseded_developer_dispatch_id, sourceId);
    assert.deepEqual(packet.context.scope_recovery, {
      authority_commit: authorityCommit,
      expected_head: baseCommit,
      original_allowed_write_paths: ["README.md", "dirty.txt"],
      added_write_paths: ["src/commands/planning-run.ts", "src/contracts.ts"],
      allowed_write_paths: ["README.md", "dirty.txt", "src/commands/planning-run.ts", "src/contracts.ts"],
      dirty_paths: ["README.md", "dirty.txt"],
    });
    assert.equal(packet.context.explorer_dispatch_id, explorerId);
    assert.equal(packet.context.coordinator_dispatch_id, "dispatch_coordinator");
    assert.equal(packet.context.prepare_git_dispatch_id, "dispatch_prepare");
    assert.deepEqual(fixture.store.db.prepare("SELECT developer_dispatch_id,write_paths_json FROM run_tasks WHERE run_id=? AND task_id='TASK-001'").get(runId), {
      developer_dispatch_id: null,
      write_paths_json: JSON.stringify(recovered.allowed_write_paths),
    });
    assert.deepEqual({
      head: await rawGit(prepared.path, ["rev-parse", "HEAD"]),
      staged: await rawGit(prepared.path, ["diff", "--cached", "--binary"]),
      unstaged: await rawGit(prepared.path, ["diff", "--binary"]),
      untracked: await readFile(join(prepared.path, "dirty.txt"), "utf8"),
    }, before);
    const legacyPacket = structuredClone(packet) as unknown as { context: Record<string, unknown>; execution_contract: { source: { role: string } } };
    delete legacyPacket.context.operation;
    delete legacyPacket.context.authority_commit;
    delete legacyPacket.context.expected_head;
    delete legacyPacket.context.superseded_developer_dispatch_id;
    delete (legacyPacket.context.scope_recovery as Record<string, unknown>).allowed_write_paths;
    legacyPacket.context.phase = "implementation";
    legacyPacket.context.stage = "coding";
    legacyPacket.execution_contract.source.role = "backend-developer";
    fixture.store.db.prepare("UPDATE dispatches SET role='backend-developer',packet_json=? WHERE dispatch_id=?")
      .run(JSON.stringify(legacyPacket), recovered.dispatch_id);
    assert.throws(() => dispatches.claim(runId, recovered.dispatch_id, "git-operator"), /identity does not match/);
    const repaired = dispatches.repairClaimedTaskScopeReplacement({ runId, dispatchId: recovered.dispatch_id });
    assert.deepEqual(repaired, {
      action: "repaired",
      dispatch_id: recovered.dispatch_id,
      role: "git-operator",
      claim_command: recovered.claim_command,
      reused: false,
    });
    assert.deepEqual(dispatches.repairClaimedTaskScopeReplacement({ runId, dispatchId: recovered.dispatch_id }), { ...repaired, reused: true });
    const repairedRow = fixture.store.db.prepare("SELECT role,state,packet_json,schema_json,template_json FROM dispatches WHERE dispatch_id=?")
      .get(recovered.dispatch_id) as { role: string; state: string; packet_json: string; schema_json: string; template_json: string };
    const repairedPacket = JSON.parse(repairedRow.packet_json) as { allowed_read_paths: string[]; allowed_write_paths: string[]; context: Record<string, unknown>; execution_contract: { source: { role: string } } };
    assert.equal(repairedRow.role, "git-operator");
    assert.equal(repairedRow.state, "pending");
    assert.deepEqual(repairedPacket.allowed_read_paths, []);
    assert.deepEqual(repairedPacket.allowed_write_paths, recovered.allowed_write_paths);
    assert.equal(repairedPacket.context.operation, "apply-task-authority");
    assert.equal(repairedPacket.execution_contract.source.role, "git-operator");
    assert.equal(JSON.parse(repairedRow.template_json).role, "git-operator");
    assert.equal(JSON.parse(repairedRow.schema_json).properties.payload.properties.operations.items.properties.command.type, "string");
    assert.deepEqual(fixture.store.db.prepare("SELECT type FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1").get(runId), {
      type: "dispatch.claimed_task_scope_replacement_repaired",
    });
    const resumed = dispatches.resume(runId);
    assert.equal(resumed.next_action?.command, recovered.claim_command);
    assert.deepEqual(dispatches.recoverClaimedTaskScope({
      runId, dispatchId: sourceId, authorityCommit, expectedHead: baseCommit,
      addedWritePaths: ["src/contracts.ts", "src/commands/planning-run.ts"],
    }), { ...recovered, reused: true });
    dispatches.claim(runId, recovered.dispatch_id, "git-operator");
    await assert.rejects(
      fixture.orchestrator.commit(runId, "worktree_not_authorized", "must not commit", [], recovered.dispatch_id),
      /only authorizes apply-task-authority/,
    );
    const applied = await fixture.orchestrator.applyTaskAuthority({
      runId,
      dispatchId: recovered.dispatch_id,
      worktreeId: prepared.worktree_id,
      authorityCommit,
      expectedHead: baseCommit,
    });
    assert.equal(applied.head, baseCommit);
    assert.deepEqual(applied.dirty_paths, ["README.md", "dirty.txt"]);
    assert.deepEqual({
      head: await rawGit(prepared.path, ["rev-parse", "HEAD"]),
      staged: await rawGit(prepared.path, ["diff", "--cached", "--binary", "--", "README.md"]),
      unstaged: await rawGit(prepared.path, ["diff", "--binary", "--", "README.md"]),
      untracked: await readFile(join(prepared.path, "dirty.txt"), "utf8"),
    }, { head: baseCommit, staged: before.staged, unstaged: before.unstaged, untracked: "untracked\n" });
    const authorityReceipt = {
      ...createResultTemplate(runId, recovered.dispatch_id, "git-operator"),
      summary: "Applied the recorded task authority commit",
      verification: [{ command: "ai-team git apply-task-authority", outcome: "passed" }],
      payload: { operations: [{ command: "ai-team git apply-task-authority", outcome: applied.operation_id }] },
    };
    assert.doesNotThrow(() => dispatches.validateValue(runId, recovered.dispatch_id, "git-operator", authorityReceipt));
    await dispatches.submitValue(runId, recovered.dispatch_id, "git-operator", authorityReceipt);
    const developer = fixture.store.db.prepare("SELECT dispatch_id,replacement_for,packet_json FROM dispatches WHERE run_id=? AND role='backend-developer' AND replacement_for=?")
      .get(runId, sourceId) as { dispatch_id: string; replacement_for: string; packet_json: string };
    const developerPacket = JSON.parse(developer.packet_json) as { allowed_write_paths: string[]; context: Record<string, unknown> };
    assert.deepEqual(developerPacket.allowed_write_paths, recovered.allowed_write_paths);
    assert.equal(developerPacket.context.authority_apply_git_dispatch_id, recovered.dispatch_id);
    assert.equal(developerPacket.context.explorer_dispatch_id, explorerId);
    assert.equal(developerPacket.context.coordinator_dispatch_id, "dispatch_coordinator");
    assert.equal(developerPacket.context.prepare_git_dispatch_id, "dispatch_prepare");
    assert.deepEqual(fixture.store.db.prepare("SELECT developer_dispatch_id FROM run_tasks WHERE run_id=? AND task_id='TASK-001'").get(runId), { developer_dispatch_id: developer.dispatch_id });
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

test("commit keeps integrated task worktrees read-only without side effects", async () => {
  const fixture = await createFixture();
  try {
    const revision = "001";
    const planIds = ["20260819-integrated-multi", "20260819-integrated-single"];
    const taskIds = [["TASK-001", "TASK-002"], ["TASK-001"]];
    for (let index = 0; index < planIds.length; index += 1) {
      const taskRoot = join(fixture.root, ".ai-team", "plans", planIds[index]!, "revisions", revision, "tasks");
      await mkdir(taskRoot, { recursive: true });
      for (const taskId of taskIds[index]!) await writeFile(join(taskRoot, `${taskId}.md`), `# ${taskId}\n`);
    }
    await rawGit(fixture.root, ["add", ".ai-team"]);
    await rawGit(fixture.root, ["commit", "-m", "Freeze integrated task fixtures"]);
    const baseCommit = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    const identity = await repositoryIdentity(fixture.root);

    const assertReadOnly = async (runId: string, taskId: string, worktreeId: string, path: string): Promise<void> => {
      const snapshot = async () => ({
        head: await rawGit(path, ["rev-parse", "HEAD"]),
        dirty: await rawGit(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
        operations: fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=?").get(runId),
        events: fixture.store.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=?").get(runId),
        worktree: fixture.store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=?").get(worktreeId),
      });
      const before = await snapshot();
      let rejected: unknown;
      try {
        await fixture.orchestrator.commit(runId, worktreeId, `Retry ${taskId}`, ["**"]);
      } catch (error) {
        rejected = error;
      }
      assert.ok(rejected instanceof Error);
      assert.equal(rejected.message, `integrated task worktree is read-only: task_id=${taskId}; worktree_id=${worktreeId}`);
      assert.deepEqual((rejected as Error & { details?: unknown }).details, {
        reason: "integrated_task_worktree_read_only",
        task_id: taskId,
        worktree_id: worktreeId,
      });
      assert.deepEqual(await snapshot(), before);
    };

    const multiRun = fixture.store.createRun({
      repoId: identity.repoId, profile: "coding", mode: "planned", planId: planIds[0]!, revision, baseCommit, targetBranch: "main",
    });
    fixture.store.initializeRunTasks(multiRun, taskIds[0]!.map((taskId, index) => ({
      task_id: taskId,
      source_path: `.ai-team/plans/${planIds[0]}/revisions/${revision}/tasks/${taskId}.md`,
      source_digest: String(index + 1).repeat(64),
      write_paths: [`task-${index + 1}.txt`],
    })));
    await fixture.orchestrator.prepareIntegration(multiRun);
    const multiWorktrees = await Promise.all(taskIds[0]!.map((taskId) => fixture.orchestrator.prepareTask(multiRun, taskId)));
    await writeFile(join(multiWorktrees[0]!.path, "task-1.txt"), "dirty integrated task\n");
    for (let index = 0; index < multiWorktrees.length; index += 1) {
      const task = multiWorktrees[index]!;
      fixture.store.db.prepare("UPDATE run_tasks SET state='integrated',worktree_id=? WHERE run_id=? AND task_id=?")
        .run(task.worktree_id, multiRun, taskIds[0]![index]);
      await assertReadOnly(multiRun, taskIds[0]![index]!, task.worktree_id, task.path);
    }

    const singleRun = fixture.store.createRun({
      repoId: identity.repoId, profile: "coding", mode: "planned", planId: planIds[1]!, revision, baseCommit, targetBranch: "main",
    });
    fixture.store.initializeRunTasks(singleRun, [{
      task_id: "TASK-001",
      source_path: `.ai-team/plans/${planIds[1]}/revisions/${revision}/tasks/TASK-001.md`,
      source_digest: "3".repeat(64),
      write_paths: ["single.txt"],
    }]);
    const plan = await fixture.orchestrator.prepareIntegration(singleRun);
    await writeFile(join(plan.path, "single.txt"), "dirty integrated single task\n");
    fixture.store.db.prepare("UPDATE run_tasks SET state='integrated',worktree_id=? WHERE run_id=? AND task_id='TASK-001'")
      .run(plan.worktree_id, singleRun);
    await assertReadOnly(singleRun, "TASK-001", plan.worktree_id, plan.path);
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

    completeFrozenTest(fixture.store, runId, integrationCommit);
    const reviews = new ReviewService(fixture.store);
    const staleCommit = await rawGit(integration.path, ["rev-parse", `${integrationCommit}^1`]);
    assert.throws(() => reviews.create(runId, staleCommit, false), /same integration commit/);
    const barrier = reviews.create(runId, integrationCommit, false);
    const reviewPacket = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { packet_json: string };
    const packet = JSON.parse(reviewPacket.packet_json);
    assert.match(packet.context.committed_diff, /feature\.ts/);
    assert.equal(packet.context.test_evidence.status, "completed");
    completeSpecReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "spec", summary: "passed", findings: [] });
    completeStandardsReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "passed", findings: [] });
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE run_id=? AND role='code-reviewer'")
      .run(new Date().toISOString(), runId);
    const dispatches = new DispatchService(fixture.store);
    const finalDispatch = fixture.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'
      AND json_extract(packet_json,'$.context.phase')='finalize_integration'`).get(runId) as { dispatch_id: string };
    dispatches.claim(runId, finalDispatch.dispatch_id, "git-operator");
    const targetCommit = await fixture.orchestrator.integrateTarget(runId, integration.worktree_id, finalDispatch.dispatch_id);
    assert.equal((await rawGit(fixture.root, ["rev-list", "--parents", "-n", "1", targetCommit])).split(" ").length, 3);
    assert.equal(fixture.store.getRun(runId).state, "active");

    const finalResult = {
      ...dispatches.template(runId, finalDispatch.dispatch_id, "git-operator"),
      summary: "integration and cleanup completed",
      verification: [{ command: "git rev-list", outcome: "merge verified" }],
      payload: { operations: [{ command: "git integrate", outcome: targetCommit }] },
    };
    await assert.rejects(
      dispatches.submitValue(runId, finalDispatch.dispatch_id, "git-operator", finalResult),
      /worktree cleanup could not be verified/,
    );

    const removed = await fixture.orchestrator.cleanup(runId, finalDispatch.dispatch_id);
    assert.deepEqual(new Set(removed), new Set([task.path, integration.path]));
    await assert.rejects(lstat(task.path), { code: "ENOENT" });
    await assert.rejects(lstat(integration.path), { code: "ENOENT" });
    const states = fixture.store.db.prepare("SELECT state FROM worktrees WHERE run_id=?").all(runId) as Array<{ state: string }>;
    assert.ok(states.length > 0);
    assert.ok(states.every(({ state }) => state === "removed"));
    fixture.store.db.prepare("UPDATE runs SET state='completed' WHERE run_id=?").run(runId);
    const reconciled = dispatches.reconcile(runId, finalDispatch.dispatch_id, "git-operator", "coding", "verified legacy finalization side effects");
    assert.equal(reconciled.resumed_finalization, true);
    assert.equal(fixture.store.getRun(runId).state, "active");
    assert.deepEqual(
      dispatches.reconcile(runId, finalDispatch.dispatch_id, "git-operator", "coding", "verified legacy finalization side effects"),
      { ...reconciled, reused: true },
    );
    assert.equal(await fixture.orchestrator.integrateTarget(runId, integration.worktree_id, finalDispatch.dispatch_id), targetCommit);
    assert.equal(await rawGit(fixture.root, ["rev-parse", "HEAD"]), targetCommit);
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.integrate'").get(runId) as { count: number }).count,
      1,
    );
    await dispatches.submitValue(runId, finalDispatch.dispatch_id, "git-operator", finalResult);
    assert.equal(fixture.store.getRun(runId).state, "completed");
    assert.equal(
      (fixture.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId) as { count: number }).count,
      0,
    );
  } finally {
    await fixture.dispose();
  }
});

test("review rejects a task commit and binds the tested integration commit", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun();
    const task = await fixture.orchestrator.prepareTask(runId, "direct-review");
    await mkdir(join(task.path, "src"));
    await writeFile(join(task.path, "src", "direct-review.ts"), "export const reviewed = true;\n");
    const implementation = await fixture.orchestrator.commit(runId, task.worktree_id, "Implement direct review", ["src/**"]);
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    assert.notEqual(await rawGit(integration.path, ["rev-parse", "HEAD"]), implementation.commit);

    const taskTest = new DispatchService(fixture.store).create(runId, "test", {
      objective: "Verify task commit", allowed_read_paths: ["README.md"], allowed_write_paths: [], acceptance_criteria: ["passes"], context: { implementation_commit: implementation.commit },
    });
    fixtureCompleteTest(fixture.store, runId, taskTest);
    const reviews = new ReviewService(fixture.store);
    assert.throws(() => reviews.create(runId, implementation.commit, false), /must equal the frozen integration HEAD/);

    const integrated = await fixture.orchestrator.mergeTask(runId, integration.worktree_id, task.worktree_id);
    completeFrozenTest(fixture.store, runId, integrated);
    const barrier = reviews.create(runId, integrated, false);
    const packet = JSON.parse((fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { packet_json: string }).packet_json);
    assert.equal(packet.context.review_strategy, "integration_head");
    completeSpecReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "spec", summary: "passed", findings: [] });
    completeStandardsReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "passed", findings: [] });
    assert.doesNotThrow(() => reviews.assertGate(runId, integrated));
  } finally {
    await fixture.dispose();
  }
});

test("resolved review persists the repair commit and Test artifact as the effective final head", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260819-review-repair-head");
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    await writeFile(join(integration.path, "reviewed.txt"), "reviewed\n");
    await rawGit(integration.path, ["add", "reviewed.txt"]);
    await rawGit(integration.path, ["commit", "-m", "Reviewed implementation"]);
    const reviewed = await rawGit(integration.path, ["rev-parse", "HEAD"]);
    completeFrozenTest(fixture.store, runId, reviewed);
    const reviews = new ReviewService(fixture.store);
    const barrier = reviews.create(runId, reviewed, false);
    const finding = {
      finding_id: "FIND-CODE-001", severity: "P1" as const, title: "Repair required", source: "standards",
      source_file: "reviewed.txt", source_line: 1, evidence: "reviewed", impact: "incorrect behavior", recommendation: "repair",
    };
    const leaf = fixture.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { dispatch_id: string };
    fixture.store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify({
      ...createResultTemplate(runId, leaf.dispatch_id, "review-standards"), summary: "blocked", findings: [finding],
      verification: [{ command: "review", outcome: "completed" }], payload: { finding_ids: [finding.finding_id] },
    }), new Date().toISOString(), leaf.dispatch_id);
    completeSpecReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "spec", summary: "passed", findings: [] });
    assert.equal(reviews.submit(runId, barrier.barrier_id, { axis: "standards", summary: "blocked", findings: [finding] }).state, "blocked");

    await writeFile(join(integration.path, "reviewed.txt"), "repaired\n");
    await rawGit(integration.path, ["add", "reviewed.txt"]);
    await rawGit(integration.path, ["commit", "-m", "Repair review finding"]);
    const repair = await rawGit(integration.path, ["rev-parse", "HEAD"]);
    const dispatches = new DispatchService(fixture.store);
    const testId = dispatches.create(runId, "test", {
      objective: "Verify repair", allowed_read_paths: ["reviewed.txt"], allowed_write_paths: [], acceptance_criteria: ["pass"],
      context: { implementation_commit: repair, implementation_committed: true, changed_paths: ["reviewed.txt"] },
    });
    dispatches.claim(runId, testId, "test");
    const submission = await dispatches.submitValue(runId, testId, "test", {
      ...createResultTemplate(runId, testId, "test"), summary: "repair passed",
      verification: [{ command: "test", outcome: "passed" }], payload: { checks: [{ command: "test", outcome: "passed" }] },
    });
    const resolutions = [{ finding_id: finding.finding_id, change_evidence: repair, verification_evidence: submission.submission.artifact_id }];
    reviews.resolve(runId, barrier.barrier_id, resolutions);
    const status = reviews.status(runId, barrier.barrier_id) as { repair_commit: string; effective_reviewed_head: string; verification_evidence: string };
    assert.equal(status.repair_commit, repair);
    assert.equal(status.effective_reviewed_head, repair);
    assert.equal(JSON.parse(status.verification_evidence).artifact_id, submission.submission.artifact_id);
    const final = fixture.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='finalize_integration'").get(runId) as { packet_json: string };
    assert.equal(JSON.parse(final.packet_json).context.revision_sha, repair);

    fixture.store.db.prepare("UPDATE review_barriers SET repair_commit=NULL,verification_evidence=NULL WHERE barrier_id=?").run(barrier.barrier_id);
    fixture.store.db.prepare("UPDATE runs SET state='failed',stage='git-operator' WHERE run_id=?").run(runId);
    reviews.resolve(runId, barrier.barrier_id, resolutions);
    const recovered = reviews.status(runId, barrier.barrier_id) as { repair_commit: string; effective_reviewed_head: string; verification_evidence: string };
    assert.equal(recovered.repair_commit, repair);
    assert.equal(recovered.effective_reviewed_head, repair);
    assert.equal(JSON.parse(recovered.verification_evidence).artifact_id, submission.submission.artifact_id);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM finding_resolutions WHERE barrier_id=?").get(barrier.barrier_id) as { count: number }).count, 1);
    assert.equal((fixture.store.getRun(runId) as { state: string }).state, "failed");

    await writeFile(join(integration.path, "target-sync.txt"), "later sync\n");
    await rawGit(integration.path, ["add", "target-sync.txt"]);
    await rawGit(integration.path, ["commit", "-m", "Later synchronization"]);
    reviews.resolve(runId, barrier.barrier_id, resolutions);
    assert.equal((reviews.status(runId, barrier.barrier_id) as { repair_commit: string }).repair_commit, repair);
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

    completeFrozenTest(fixture.store, runId, reviewedCommit, "2026-08-14T00:00:00.000Z");
    const reviews = new ReviewService(fixture.store);
    const barrier = reviews.create(runId, reviewedCommit, false);
    completeSpecReview(fixture.store, runId);
    reviews.submit(runId, barrier.barrier_id, { axis: "spec", summary: "passed", findings: [] });
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

test("dirty target precondition records a snapshot and preserves untracked user files", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260819-dirty-target");
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    const userFile = join(fixture.root, "opencode.json");
    await writeFile(userFile, "{\"preserve\":true}\n");

    await assert.rejects(fixture.orchestrator.integrateTarget(runId, integration.worktree_id), /target worktree must be clean/);
    assert.match(await rawGit(fixture.root, ["status", "--porcelain=v1", "--untracked-files=all"]), /\?\? opencode\.json/);
    const event = fixture.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='git.target_dirty_blocked' ORDER BY event_id DESC LIMIT 1")
      .get(runId) as { payload_json: string };
    assert.deepEqual(JSON.parse(event.payload_json).snapshot.untracked, ["opencode.json"]);
    assert.equal((await readFile(userFile, "utf8")).trim(), "{\"preserve\":true}");
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind IN ('git.sync','git.integrate')").get(runId) as { count: number }).count, 0);
  } finally {
    await fixture.dispose();
  }
});

test("conflict continuation scopes developer resolutions while accepting target-only inherited paths", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260819-conflict-lineage");
    const dispatches = new DispatchService(fixture.store);
    const recoveryDispatchId = dispatches.create(runId, "git-operator", {
      objective: "Recover target synchronization",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Continue only the recorded conflict"],
      context: { stage: "git-operator", phase: "sync_recovery" },
    });
    dispatches.claim(runId, recoveryDispatchId, "git-operator");
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    await writeFile(join(integration.path, "README.md"), "integration side\n");
    await rawGit(integration.path, ["add", "README.md"]);
    await rawGit(integration.path, ["commit", "-m", "Integration change"]);

    await writeFile(join(fixture.root, "README.md"), "target side\n");
    await mkdir(join(fixture.root, ".ai-team", "plans", "target-only"), { recursive: true });
    const inherited = ".ai-team/plans/target-only/plan.yaml";
    await writeFile(join(fixture.root, inherited), "plan_id: target-only\n");
    await rawGit(fixture.root, ["add", "README.md", inherited]);
    await rawGit(fixture.root, ["commit", "-m", "Advance target with inherited plan"]);

    await assert.rejects(fixture.orchestrator.integrateTarget(runId, integration.worktree_id), /synchronization conflicted/);
    assert.match(await rawGit(integration.path, ["rev-parse", "MERGE_HEAD"]), /^[a-f0-9]{40}$/);
    const pendingSync = fixture.store.db.prepare("SELECT request_json FROM operations WHERE run_id=? AND kind='git.sync' AND state='pending'").get(runId) as { request_json: string };
    assert.equal(JSON.parse(pendingSync.request_json).integration_worktree_id, integration.worktree_id);
    fixture.store.db.prepare("UPDATE runs SET state='failed',stage='git-operator' WHERE run_id=?").run(runId);
    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.equal(resumed.recovery?.next_command, `ai-team git continue-conflict --run-id ${runId} --dispatch-id ${recoveryDispatchId} --integration-id ${integration.worktree_id} --scope README.md`);
    const reconcile = await fixture.orchestrator.reconcile(runId);
    assert.equal(reconcile[0]?.state, "conflicted");
    await writeFile(join(integration.path, "README.md"), "resolved\n");
    await rawGit(integration.path, ["add", "README.md"]);
    const commit = await fixture.orchestrator.continueConflict(runId, integration.worktree_id, ["README.md"], recoveryDispatchId);
    assert.equal((await rawGit(integration.path, ["rev-list", "--parents", "-n", "1", commit])).split(" ").length, 3);
    assert.equal(await rawGit(integration.path, ["show", `${commit}:${inherited}`]), "plan_id: target-only");
    const operation = fixture.store.db.prepare("SELECT state,evidence_json FROM operations WHERE run_id=? AND kind='git.sync'").get(runId) as { state: string; evidence_json: string };
    assert.equal(operation.state, "completed");
    assert.deepEqual(JSON.parse(operation.evidence_json).target_inherited_paths, [inherited]);
  } finally {
    await fixture.dispose();
  }
});

test("legacy git.sync conflict evidence restores a failed run and its claimed dispatch", async () => {
  const fixture = await createFixture();
  try {
    const runId = fixture.createRun("20260819-legacy-sync-recovery");
    const dispatches = new DispatchService(fixture.store);
    const recoveryDispatchId = dispatches.create(runId, "git-operator", {
      objective: "Recover legacy target synchronization",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Continue the explicitly evidenced conflict"],
      context: { stage: "git-operator", phase: "sync_recovery" },
    });
    dispatches.claim(runId, recoveryDispatchId, "git-operator");
    const integration = await fixture.orchestrator.prepareIntegration(runId);
    await writeFile(join(integration.path, "README.md"), "integration side\n");
    await rawGit(integration.path, ["add", "README.md"]);
    await rawGit(integration.path, ["commit", "-m", "Integration change"]);
    const integrationHeadBefore = await rawGit(integration.path, ["rev-parse", "HEAD"]);

    await writeFile(join(fixture.root, "README.md"), "target side\n");
    await rawGit(fixture.root, ["add", "README.md"]);
    await rawGit(fixture.root, ["commit", "-m", "Advance target"]);
    const targetHead = await rawGit(fixture.root, ["rev-parse", "HEAD"]);
    await assert.rejects(fixture.orchestrator.integrateTarget(runId, integration.worktree_id), /synchronization conflicted/);

    const operation = fixture.store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND kind='git.sync' AND state='pending'").get(runId) as { operation_id: string };
    fixture.store.db.prepare("UPDATE operations SET request_json=?,evidence_json=NULL WHERE operation_id=?").run(JSON.stringify({ target: targetHead }), operation.operation_id);
    fixture.store.db.prepare("UPDATE runs SET state='failed',stage='git-operator' WHERE run_id=?").run(runId);
    const evidence = {
      integration_worktree_id: integration.worktree_id,
      conflict_paths: ["README.md"],
      integration_head_before: integrationHeadBefore,
      target_head: targetHead,
    };

    const legacyResume = dispatches.resume(runId);
    assert.equal((legacyResume.run as { state: string }).state, "failed");
    assert.equal(legacyResume.recovery?.next_command, `ai-team git reconcile --run-id ${runId} --dispatch-id ${recoveryDispatchId} --operation-id ${operation.operation_id} --state conflicted --input-stdin`);
    assert.deepEqual(legacyResume.recovery?.evidence_template, {
      integration_worktree_id: "<worktree-id>", conflict_paths: ["<repository-relative-conflict-path>"],
      integration_head_before: "<40-character-commit-sha>", target_head: "<40-character-commit-sha>",
    });

    await assert.rejects(
      fixture.orchestrator.reconcileSyncConflict(runId, operation.operation_id, {}, recoveryDispatchId),
      (error: unknown) => {
        const details = error instanceof ValidationError ? error.details : undefined;
        return error instanceof Error && error.message === "conflicted git.sync reconciliation evidence is invalid"
          && Array.isArray(details) && details.length === 4;
      },
    );
    const reconciled = await fixture.orchestrator.reconcileSyncConflict(runId, operation.operation_id, evidence, recoveryDispatchId);
    assert.equal((fixture.store.getRun(runId) as { state: string }).state, "active");
    assert.equal((fixture.store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(recoveryDispatchId) as { state: string }).state, "claimed");
    const pending = fixture.store.db.prepare("SELECT state,evidence_json,request_json FROM operations WHERE operation_id=?").get(operation.operation_id) as { state: string; evidence_json: string; request_json: string };
    assert.equal(pending.state, "pending");
    assert.deepEqual(JSON.parse(pending.request_json), { target: targetHead });
    assert.deepEqual(JSON.parse(pending.evidence_json), { state: "conflicted", ...evidence });
    assert.equal(reconciled[0]?.next_command, `ai-team git continue-conflict --run-id ${runId} --dispatch-id ${recoveryDispatchId} --integration-id ${integration.worktree_id} --scope README.md`);

    await writeFile(join(integration.path, "README.md"), "resolved\n");
    await rawGit(integration.path, ["add", "README.md"]);
    const commit = await fixture.orchestrator.continueConflict(runId, integration.worktree_id, ["README.md"], recoveryDispatchId);
    assert.equal((await rawGit(integration.path, ["rev-list", "--parents", "-n", "1", commit])).split(" ").length, 3);
    assert.equal((fixture.store.db.prepare("SELECT state FROM operations WHERE operation_id=?").get(operation.operation_id) as { state: string }).state, "completed");
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
