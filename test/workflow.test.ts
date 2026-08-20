import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ValidationError } from "../src/errors.js";
import { createResultTemplate } from "../src/contracts.js";
import { repositoryIdentity } from "../src/git.js";
import { assertCoverage, validateCoverage, writeRevision } from "../src/planning.js";
import { initializeProject, planProjectInit } from "../src/project.js";
import { validateResearchConclusions, type ResearchConclusion } from "../src/research.js";
import { REVIEW_RESOLUTION_SCHEMA, REVIEW_RESOLUTION_TEMPLATE, REVIEW_RESULT_SCHEMA, ReviewService, checkReviewResolutions, type ReviewResult } from "../src/review.js";
import { StateStore } from "../src/state.js";
import { WorkflowService } from "../src/workflow.js";
import { GitOrchestrator } from "../src/git-orchestrator.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
};

const temporaryDirectory = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "ai-team-test-"));

const createRepository = async (): Promise<{ directory: string; head: string }> => {
  const directory = await temporaryDirectory();
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "AI Team Tests");
  await git(directory, "config", "user.email", "ai-team-tests@example.invalid");
  await writeFile(path.join(directory, "README.md"), "# Fixture\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-m", "fixture");
  return { directory, head: await git(directory, "rev-parse", "HEAD") };
};

const initializeRepositoryContext = async (repository: { directory: string; head: string }): Promise<void> => {
  await initializeProject(repository.directory, true);
  await git(repository.directory, "add", "--", ".gitignore", ".ai-team", "MEMORY.md");
  await git(repository.directory, "commit", "-m", "initialize project context");
  repository.head = await git(repository.directory, "rev-parse", "HEAD");
};

const commitPlanRevision = async (repository: { directory: string; head: string }, planId: string, revision: string, taskIds: string[] = []): Promise<void> => {
  const planRoot = path.join(repository.directory, ".ai-team", "plans", planId);
  const revisionRoot = path.join(planRoot, "revisions", revision);
  const mappedTaskIds = taskIds.length ? taskIds : ["TASK-001"];
  const planVerification = {
    acceptance_criteria: ["AC-001"],
    acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
    task_mapping: mappedTaskIds.map((task_id) => ({ task_id, acceptance_criteria: ["AC-001"] })),
    test_commands: ["npm test"],
  };
  await mkdir(path.join(revisionRoot, "tasks"), { recursive: true });
  await writeFile(path.join(planRoot, "plan.yaml"), `plan_id: ${planId}\nactive_revision: ${revision}\n`);
  await writeFile(path.join(revisionRoot, "spec.md"), `# ${planId} ${revision} spec\n`);
  await writeFile(path.join(revisionRoot, "plan.md"), `# ${planId} ${revision} plan\n\n## 方案验收契约\n\n\`\`\`json\n${JSON.stringify(planVerification, null, 2)}\n\`\`\`\n`);
  for (const taskId of taskIds) {
    const taskVerification = {
      ...planVerification,
      task_mapping: [{ task_id: taskId, acceptance_criteria: ["AC-001"] }],
      tdd_cycles: [{ acceptance_criterion: "AC-001", test_path: `test/${taskId.toLowerCase()}.test.ts`, red: { command: "npm test", expected_failure: "fails" }, green: { implementation_steps: ["implement"], command: "npm test", expected_result: "passes" }, refactor: { scope: "none", command: "npm test", expected_result: "passes" } }],
    };
    await writeFile(path.join(revisionRoot, "tasks", `${taskId}.md`), `# ${taskId}\n\n- Allowed write paths: \`src/${taskId.toLowerCase()}.ts\`\n\n## 任务验收契约\n\n\`\`\`json\n${JSON.stringify(taskVerification, null, 2)}\n\`\`\`\n`);
  }
  await git(repository.directory, "add", "--", path.relative(repository.directory, planRoot));
  await git(repository.directory, "commit", "-m", `freeze ${planId} ${revision}`);
  repository.head = await git(repository.directory, "rev-parse", "HEAD");
};

const openStore = async (): Promise<{ store: StateStore; home: string }> => {
  const home = await temporaryDirectory();
  return { store: await StateStore.open(home), home };
};

const REVIEW_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const REVIEW_BASE = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
const REVIEW_COMMON_DIR = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
let formalRunSequence = 0;
const createRun = (store: StateStore, mode = "feature"): string => {
  store.registerRepository("repo", path.resolve(REVIEW_COMMON_DIR), process.cwd());
  const formal = mode === "planned" ? { planId: `review-plan-${++formalRunSequence}`, revision: "001" } : {};
  return store.createRun({ repoId: "repo", profile: "coding", mode, baseCommit: REVIEW_HEAD, ...formal });
};

const result = (axis: "spec" | "standards", findings: ReviewResult["findings"] = []): ReviewResult => ({
  axis,
  summary: `${axis} review complete`,
  findings,
});

const completeTest = async (store: StateStore, runId: string, legacyPlanned = false): Promise<void> => {
  const run = store.getRun(runId) as { mode: string; plan_id?: string; revision?: string };
  store.db.prepare("UPDATE runs SET base_commit=? WHERE run_id=?").run(REVIEW_BASE, runId);
  store.db.prepare("UPDATE worktrees SET state='removed' WHERE path=? AND state='active'").run(process.cwd());
  let branch = `integration/test/${runId.slice(-12)}`;
  let worktreePath = process.cwd();
  if (run.mode === "planned" && run.plan_id && run.revision) {
    const finalSegment = legacyPlanned ? runId.slice(-8).toLowerCase() : `${run.plan_id}-${run.revision}`;
    branch = legacyPlanned ? `integration/${run.plan_id}/${finalSegment}` : `plan/${run.plan_id}/${finalSegment}`;
    worktreePath = path.join(process.cwd(), ".worktrees", legacyPlanned ? "integration" : "plans", run.plan_id, finalSegment);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await symlink(process.cwd(), worktreePath, "dir");
    if (legacyPlanned) {
      const operation = store.beginOperation("git.integration.create", `integration:create:${runId}:${REVIEW_HEAD}`, { branch, path: worktreePath, base: REVIEW_HEAD }, runId);
      store.finishOperation(operation.operationId, { worktreeId: `worktree_${runId.slice(-12)}`, head: REVIEW_HEAD });
    }
  }
  store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
    .run(`worktree_${runId.slice(-12)}`, runId, branch, worktreePath, REVIEW_HEAD, new Date().toISOString());
  const dispatchId = new WorkflowService(store).dispatches.create(runId, "test", {
    objective: "independent verification", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["tests pass"], context: { implementation_commit: REVIEW_HEAD, implementation_committed: true, changed_paths: ["package.json"] },
  });
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, dispatchId, "test"), summary: "tests passed", verification: [{ command: "npm test", outcome: "passed" }], payload: { checks: [{ command: "npm test", outcome: "passed" }] } }), new Date().toISOString(), dispatchId);
  const reviewPacket = new WorkflowService(store).dispatches.buildReviewPacket(runId);
  assert.ok(reviewPacket);
  new WorkflowService(store).dispatches.create(runId, "code-reviewer", reviewPacket);
};

const cleanupTestPlanWorktrees = async (store: StateStore): Promise<void> => {
  const root = path.join(process.cwd(), ".worktrees");
  const rows = store.db.prepare("SELECT path FROM worktrees WHERE branch LIKE 'plan/%' OR branch LIKE 'integration/%'").all() as Array<{ path: string }>;
  for (const row of rows) {
    if (row.path.startsWith(`${root}${path.sep}`)) await rm(path.dirname(row.path), { recursive: true, force: true });
  }
};

const prepareCompletedImplementation = async (store: StateStore): Promise<{
  runId: string;
  coordinatorDispatchId: string;
  developerDispatchId: string;
  worktreeId: string;
  worktreePath: string;
}> => {
  const runId = createRun(store, "planned");
  const run = store.getRun(runId) as { plan_id: string; revision: string };
  store.db.prepare("UPDATE runs SET plan_digest=? WHERE run_id=?").run("plan-digest-fixture", runId);
  const worktreeId = `worktree_${runId.slice(-12)}`;
  const worktreePath = path.join(process.cwd(), ".worktrees", "plans", run.plan_id, `${run.plan_id}-${run.revision}`);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await symlink(process.cwd(), worktreePath, "dir");
  store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
    .run(worktreeId, runId, `plan/${run.plan_id}/${run.plan_id}-${run.revision}`, worktreePath, REVIEW_BASE, new Date().toISOString());

  const dispatches = new WorkflowService(store).dispatches;
  const authorizedPaths = execFileSync("git", ["diff", "--name-only", REVIEW_BASE, REVIEW_HEAD], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const explorerDispatchId = dispatches.create(runId, "file-explorer", {
    objective: "authorize implementation fixture",
    allowed_read_paths: ["."],
    allowed_write_paths: [],
    acceptance_criteria: ["authorize exact paths"],
    context: {},
  });
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify({
    ...createResultTemplate(runId, explorerDispatchId, "file-explorer"),
    payload: {
      allowed_read_paths: authorizedPaths,
      entry_points: ["src/dispatch.ts"],
      test_commands: ["npm test"],
      project_context: { project_shape: "fixture", memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] }, navigation: [], maintenance: { status: "current", paths: [] } },
    },
  }), new Date().toISOString(), explorerDispatchId);

  const coordinatorDispatchId = dispatches.create(runId, "coding", {
    objective: "coordinate implementation fixture",
    allowed_read_paths: authorizedPaths,
    allowed_write_paths: [],
    acceptance_criteria: ["dispatch frontend implementation"],
    context: { explorer_dispatch_id: explorerDispatchId, worktree_id: worktreeId },
  });
  dispatches.claim(runId, coordinatorDispatchId, "coding");
  const developerDispatchId = dispatches.create(runId, "frontend-developer", {
    objective: "complete frontend implementation fixture",
    allowed_read_paths: authorizedPaths,
    allowed_write_paths: ["src/dispatch.ts"],
    acceptance_criteria: ["report modified paths"],
    context: { explorer_dispatch_id: explorerDispatchId, worktree_id: worktreeId },
  }, "coding", coordinatorDispatchId);

  await dispatches.submitValue(runId, coordinatorDispatchId, "coding", {
    ...createResultTemplate(runId, coordinatorDispatchId, "coding"),
    summary: "coordination completed first",
    payload: { actions: ["frontend dispatched"] },
  });
  dispatches.claim(runId, developerDispatchId, "frontend-developer");
  await dispatches.submitValue(runId, developerDispatchId, "frontend-developer", {
    ...createResultTemplate(runId, developerDispatchId, "frontend-developer"),
    summary: "frontend completed second",
    payload: { modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] },
  });
  return { runId, coordinatorDispatchId, developerDispatchId, worktreeId, worktreePath };
};

const completeReviewLeaf = (store: StateStore, runId: string, review: ReviewResult): void => {
  const role = review.axis === "spec" ? "review-spec" : "review-standards";
  const row = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC LIMIT 1").get(runId, role) as { dispatch_id: string };
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, row.dispatch_id, role), summary: review.summary, findings: review.findings, verification: [{ command: "review", outcome: "completed" }], payload: { finding_ids: review.findings.map(({ finding_id }) => finding_id) } }), new Date().toISOString(), row.dispatch_id);
};

const submitReview = (reviews: ReviewService, store: StateStore, runId: string, barrierId: string, review: ReviewResult) => {
  completeReviewLeaf(store, runId, review);
  return reviews.submit(runId, barrierId, review);
};

test("all coding reviews require both axes and run once per frozen revision", async () => {
  const { store, home } = await openStore();
  try {
    const reviews = new ReviewService(store);
    const directRun = createRun(store);
    await completeTest(store, directRun);
    assert.throws(() => reviews.create(directRun, "0".repeat(40), true), /commit does not exist/);
    const direct = reviews.create(directRun, REVIEW_HEAD, false);
    assert.deepEqual(direct.axes, ["spec", "standards"]);
    assert.match(direct.spec_dispatch_id!, /^dispatch_/);
    assert.match(direct.standards_dispatch_id, /^dispatch_/);
    assert.deepEqual(
      (store.db.prepare("SELECT role FROM dispatches WHERE run_id=? AND role LIKE 'review-%' ORDER BY role").all(directRun) as Array<{ role: string }>).map(({ role }) => role),
      ["review-spec", "review-standards"],
    );
    assert.equal(submitReview(reviews, store, directRun, direct.barrier_id, result("spec")).state, "pending");
    assert.equal(submitReview(reviews, store, directRun, direct.barrier_id, result("standards")).state, "passed");
    assert.equal(reviews.submit(directRun, direct.barrier_id, result("standards")).state, "passed");
    assert.deepEqual(reviews.create(directRun, REVIEW_HEAD, true), { ...direct, reused: true });

    const formalRun = createRun(store, "planned");
    await completeTest(store, formalRun);
    const formal = reviews.create(formalRun, REVIEW_HEAD, true);
    assert.deepEqual(formal.axes, ["spec", "standards"]);
    assert.match(formal.spec_dispatch_id!, /^dispatch_/);
    assert.match(formal.standards_dispatch_id, /^dispatch_/);
    assert.deepEqual(
      (store.db.prepare("SELECT role FROM dispatches WHERE run_id=? AND role LIKE 'review-%' ORDER BY role").all(formalRun) as Array<{ role: string }>).map(({ role }) => role),
      ["review-spec", "review-standards"],
    );
    assert.equal(submitReview(reviews, store, formalRun, formal.barrier_id, result("spec")).state, "pending");
    assert.equal(reviews.submit(formalRun, formal.barrier_id, result("spec")).state, "pending");
    assert.equal(submitReview(reviews, store, formalRun, formal.barrier_id, result("standards")).state, "passed");
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("direct review-repair Test completion does not create a second review coordinator", async () => {
  const { store, home } = await openStore();
  try {
    const runId = createRun(store);
    await completeTest(store, runId);
    const originalReview = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='code-reviewer'").get(runId) as { dispatch_id: string; packet_json: string };
    const originalPacket = JSON.parse(originalReview.packet_json);
    originalPacket.context.revision_sha = REVIEW_BASE;
    store.db.prepare("UPDATE dispatches SET packet_json=? WHERE dispatch_id=?").run(JSON.stringify(originalPacket), originalReview.dispatch_id);

    const dispatches = new WorkflowService(store).dispatches;
    const repairTestId = dispatches.create(runId, "test", {
      objective: "verify review repair",
      allowed_read_paths: ["package.json"],
      allowed_write_paths: [],
      acceptance_criteria: ["repair passes"],
      context: {
        phase: "review_repair_test",
        barrier_id: "review_aaaaaaaaaaaaaaaaaaaaaaaa",
        implementation_commit: REVIEW_HEAD,
        implementation_committed: true,
        changed_paths: ["package.json"],
      },
    });
    dispatches.claim(runId, repairTestId, "test");
    await dispatches.submitValue(runId, repairTestId, "test", {
      ...createResultTemplate(runId, repairTestId, "test"),
      summary: "repair verified",
      verification: [{ command: "npm test", outcome: "passed" }],
      payload: { checks: [{ command: "npm test", outcome: "passed" }], testedCommit: REVIEW_HEAD },
    });
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='code-reviewer'").get(runId) as { count: number }).count, 1);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("review submit owns leaf result registration and publishes the finding schema", async () => {
  const { store, home } = await openStore();
  try {
    assert.equal(REVIEW_RESULT_SCHEMA.properties.findings.items.properties.finding_id.description, "FIND-<AXIS>-<NNN>");
    assert.deepEqual(REVIEW_RESULT_SCHEMA.properties.findings.items.required, [
      "finding_id", "severity", "title", "source", "source_file", "source_line", "evidence", "impact", "recommendation",
    ]);
    const runId = createRun(store);
    await completeTest(store, runId);
    const reviews = new ReviewService(store);
    const created = reviews.create(runId, REVIEW_HEAD, true);
    new WorkflowService(store).dispatches.claim(runId, created.spec_dispatch_id!, "review-spec");
    await reviews.submitValue(runId, created.barrier_id, result("spec"));
    new WorkflowService(store).dispatches.claim(runId, created.standards_dispatch_id, "review-standards");
    const submitted = await reviews.submitValue(runId, created.barrier_id, result("standards"));
    assert.equal(submitted.dispatch_id, created.standards_dispatch_id);
    assert.equal(submitted.state, "passed");
    assert.equal(
      (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(created.standards_dispatch_id) as { state: string }).state,
      "completed",
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("run resume rebuilds a completed formal barrier and creates one final Git Operator dispatch", async () => {
  const { store, home } = await openStore();
  let reopened: StateStore | undefined;
  try {
    const runId = createRun(store, "planned");
    await completeTest(store, runId);
    const reviews = new ReviewService(store);
    const created = reviews.create(runId, REVIEW_HEAD, true);
    completeReviewLeaf(store, runId, result("spec"));
    completeReviewLeaf(store, runId, result("standards"));
    store.db.prepare("UPDATE runs SET stage='code-reviewer' WHERE run_id=?").run(runId);
    store.close();

    reopened = await StateStore.open(home);
    const dispatches = new WorkflowService(reopened).dispatches;
    const first = dispatches.resume(runId);
    const second = dispatches.resume(runId);
    assert.equal((first.run as { stage: string }).stage, "git-operator");
    assert.equal((second.run as { stage: string }).stage, "git-operator");

    const status = new ReviewService(reopened).status(runId, undefined, REVIEW_HEAD) as {
      barrier_id: string;
      state: string;
      axes: string[];
      spec_dispatch_id: string;
      standards_dispatch_id: string;
      result_artifact_digests: Record<string, string | null>;
      results: ReviewResult[];
    };
    assert.equal(status.barrier_id, created.barrier_id);
    assert.equal(status.state, "passed");
    assert.deepEqual(status.axes, ["spec", "standards"]);
    assert.ok(status.spec_dispatch_id);
    assert.ok(status.standards_dispatch_id);
    assert.equal(status.results.length, 2);
    assert.equal(Object.keys(status.result_artifact_digests).length, 2);

    const finalDispatches = reopened.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches
      WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='finalize_integration'`).all(runId) as Array<{ dispatch_id: string; packet_json: string }>;
    assert.equal(finalDispatches.length, 1);
    assert.equal(JSON.parse(finalDispatches[0]!.packet_json).context.revision_sha, REVIEW_HEAD);
    assert.equal(JSON.parse(finalDispatches[0]!.packet_json).context.barrier_id, created.barrier_id);
    assert.deepEqual(new ReviewService(reopened).create(runId, REVIEW_HEAD, true), { ...created, reused: true });
  } finally {
    await cleanupTestPlanWorktrees(reopened ?? store);
    if (reopened) reopened.close();
    else store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("completed but uncommitted implementation does not enter Test", async () => {
  const { store, home } = await openStore();
  try {
    const fixture = await prepareCompletedImplementation(store);
    const tests = store.db.prepare("SELECT dispatch_id,packet_json,state FROM dispatches WHERE run_id=? AND role='test'").all(fixture.runId) as Array<{ dispatch_id: string; packet_json: string; state: string }>;
    assert.equal(tests.length, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='code-reviewer'").get(fixture.runId) as { count: number }).count, 0);
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("run resume creates one continue_testing replacement with inherited evidence and cancels orphan staging", async () => {
  const { store, home } = await openStore();
  try {
    const fixture = await prepareCompletedImplementation(store);
    store.db.prepare("DELETE FROM dispatches WHERE run_id=? AND role='test'").run(fixture.runId);
    store.db.prepare("UPDATE runs SET stage='coding' WHERE run_id=?").run(fixture.runId);
    const commit = store.beginOperation("git.commit", `commit:${fixture.runId}:fixture`, { paths: ["src/dispatch.ts"] }, fixture.runId);
    store.finishOperation(commit.operationId, { commit: REVIEW_HEAD, paths: ["src/dispatch.ts"], worktree_id: fixture.worktreeId });
    const staging = await store.createStagingEntry({ runId: fixture.runId, dispatchId: fixture.coordinatorDispatchId, role: "coding", kind: "dispatch-packet" });
    await store.writeStagingEntry(staging.stagingId, JSON.stringify({ objective: "stale test packet" }), {
      runId: fixture.runId, dispatchId: fixture.coordinatorDispatchId, role: "coding", kind: "dispatch-packet",
    });

    const dispatches = new WorkflowService(store).dispatches;
    const first = dispatches.resume(fixture.runId);
    const second = dispatches.resume(fixture.runId);
    assert.equal(first.pending_dispatches.length, 1);
    assert.equal(second.pending_dispatches.length, 1);
    const replacementId = first.pending_dispatches[0]!.dispatch_id;
    assert.equal(second.pending_dispatches[0]!.dispatch_id, replacementId);
    const replacement = store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(replacementId) as { replacement_for: string; packet_json: string };
    assert.equal(replacement.replacement_for, fixture.coordinatorDispatchId);
    const packet = JSON.parse(replacement.packet_json);
    assert.equal(packet.context.phase, "continue_testing");
    assert.equal(packet.context.plan_id, (store.getRun(fixture.runId) as { plan_id: string }).plan_id);
    assert.equal(packet.context.revision, "001");
    assert.equal(packet.context.plan_digest, "plan-digest-fixture");
    assert.equal(packet.context.worktree_id, fixture.worktreeId);
    assert.equal(packet.context.worktree_path, fixture.worktreePath);
    assert.equal(packet.context.implementation_dispatch_id, fixture.developerDispatchId);
    assert.match(packet.context.implementation_artifact.artifact_id, /^artifact_/);
    assert.equal(store.getStagingEntry(staging.stagingId).state, "canceled");

    dispatches.claim(fixture.runId, replacementId, "coding");
    const invalidDeveloperPacket = { ...packet };
    delete invalidDeveloperPacket.execution_contract;
    assert.throws(() => dispatches.create(fixture.runId, "frontend-developer", invalidDeveloperPacket, "coding", replacementId), /only delegate to Test/);
    const testContext = {
      ...packet.context,
      stage: "test",
      coordinator_dispatch_id: replacementId,
      integration_worktree_id: packet.context.worktree_id,
    };
    const testDispatchId = dispatches.create(fixture.runId, "test", {
      objective: "independently verify the frozen implementation",
      allowed_read_paths: packet.allowed_read_paths,
      allowed_write_paths: [],
      acceptance_criteria: ["run every frozen test command"],
      context: testContext,
    }, "coding", replacementId);
    assert.match(testDispatchId, /^dispatch_/);
    const resumed = dispatches.resume(fixture.runId);
    assert.equal((resumed.run as { stage: string }).stage, "test");
    assert.equal(resumed.pending_dispatches.filter(({ role }) => role === "test").length, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='coding' AND json_extract(packet_json,'$.context.phase')='continue_testing'").get(fixture.runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(fixture.runId) as { count: number }).count, 1);
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("formal review accepts a provenance-bound legacy planned integration worktree", async () => {
  const { store, home } = await openStore();
  try {
    const runId = createRun(store, "planned");
    await completeTest(store, runId, true);
    const barrier = new ReviewService(store).create(runId, REVIEW_HEAD, true);
    assert.deepEqual(barrier.axes, ["spec", "standards"]);
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("formal review rejects a legacy planned integration worktree without provenance", async () => {
  const { store, home } = await openStore();
  try {
    const runId = createRun(store, "planned");
    await completeTest(store, runId, true);
    store.db.prepare("DELETE FROM operations WHERE run_id=?").run(runId);
    assert.throws(
      () => new ReviewService(store).create(runId, REVIEW_HEAD, true),
      /prepared active plan worktree/,
    );
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("completed review leaf submissions automatically aggregate once", async () => {
  const { store, home } = await openStore();
  try {
    const runId = createRun(store, "planned");
    await completeTest(store, runId);
    const reviews = new ReviewService(store);
    const barrier = reviews.create(runId, REVIEW_HEAD, true);
    const dispatches = new WorkflowService(store).dispatches;
    for (const axis of ["spec", "standards"] as const) {
      const role = axis === "spec" ? "review-spec" : "review-standards";
      const leaf = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role=?").get(runId, role) as { dispatch_id: string };
      dispatches.claim(runId, leaf.dispatch_id, role);
      const envelope = {
        ...createResultTemplate(runId, leaf.dispatch_id, role),
        summary: `${axis} review complete`,
        verification: [{ command: "review", outcome: "completed" }],
        payload: { finding_ids: [] },
      };
      assert.equal((dispatches.template(runId, leaf.dispatch_id, role).payload as { barrier_id: string }).barrier_id, barrier.barrier_id);
      assert.equal((await dispatches.submitValue(runId, leaf.dispatch_id, role, envelope)).reused, false);
      assert.equal((await dispatches.submitValue(runId, leaf.dispatch_id, role, structuredClone(envelope))).reused, true);
    }
    const status = reviews.status(runId, barrier.barrier_id) as {
      state: string;
      results: ReviewResult[];
      result_artifact_digests: Record<string, string>;
    };
    assert.equal(status.state, "passed");
    assert.equal(status.results.length, 2);
    assert.match(status.result_artifact_digests.spec!, /^[a-f0-9]{64}$/);
    assert.match(status.result_artifact_digests.standards!, /^[a-f0-9]{64}$/);
    assert.equal(
      (store.db.prepare(`SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'
        AND json_extract(packet_json,'$.context.phase')='finalize_integration'`).get(runId) as { count: number }).count,
      1,
    );
  } finally {
    await cleanupTestPlanWorktrees(store);
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("blocked review resolution maps every P0 and P1 finding exactly", async () => {
  const { store, home } = await openStore();
  try {
    const reviews = new ReviewService(store);
    const runId = createRun(store);
    await completeTest(store, runId);
    const barrier = reviews.create(runId, REVIEW_HEAD, true);
    const findings: ReviewResult["findings"] = [
      { finding_id: "FIND-SEC-001", severity: "P0", title: "P0", source: "spec", source_file: "spec.md", source_line: 1, evidence: "e0", impact: "security", recommendation: "fix" },
      { finding_id: "FIND-CODE-002", severity: "P1", title: "P1", source: "code", source_file: "src/a.ts", source_line: 2, evidence: "e1", impact: "bug", recommendation: "fix" },
      { finding_id: "FIND-TEST-003", severity: "P2", title: "P2", source: "test", source_file: "test/a.ts", source_line: 3, evidence: "e2", impact: "coverage", recommendation: "test" },
    ];
    assert.equal(submitReview(reviews, store, runId, barrier.barrier_id, result("spec")).state, "pending");
    assert.equal(submitReview(reviews, store, runId, barrier.barrier_id, result("standards", findings)).state, "blocked");
    new WorkflowService(store).dispatches.reconcileReview(runId, barrier.barrier_id);
    assert.equal(
      (store.db.prepare(`SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='coding'
        AND json_extract(packet_json,'$.context.phase')='review_resolution'`).get(runId) as { count: number }).count,
      1,
    );

    assert.throws(
      () => reviews.resolve(runId, barrier.barrier_id, [
        { finding_id: "FIND-SEC-001", change_evidence: "commit", verification_evidence: "test" },
      ]),
      (error: unknown) => error instanceof ValidationError
        && JSON.stringify(error.details).includes("missing blocking P0/P1 resolution: FIND-CODE-002"),
    );
    assert.throws(
      () => reviews.resolve(runId, barrier.barrier_id, [
        { finding_id: "FIND-SEC-001", change_evidence: "commit", verification_evidence: "test" },
        { finding_id: "FIND-CODE-002", change_evidence: "commit", verification_evidence: "test" },
        { finding_id: "FIND-OTHER-004", change_evidence: "commit", verification_evidence: "test" },
      ]),
      /incomplete/,
    );

    assert.deepEqual(reviews.resolve(runId, barrier.barrier_id, [
      { finding_id: "FIND-SEC-001", change_evidence: "commit-1", verification_evidence: "test-1" },
      { finding_id: "FIND-CODE-002", change_evidence: "commit-2", verification_evidence: "test-2" },
    ]), { state: "resolved" });
    const status = reviews.status(runId, barrier.barrier_id) as { state: string; resolutions: unknown[] };
    assert.equal(status.state, "resolved");
    assert.equal(status.resolutions.length, 2);
    assert.equal(
      (store.db.prepare(`SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'
        AND json_extract(packet_json,'$.context.phase')='finalize_integration'`).get(runId) as { count: number }).count,
      1,
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("review resolution exposes an array schema and rejects non-array input structurally", () => {
  assert.equal(REVIEW_RESOLUTION_SCHEMA.type, "array");
  assert.deepEqual(REVIEW_RESOLUTION_TEMPLATE, [{
    finding_id: "FIND-AXIS-001",
    change_evidence: "repair commit or change evidence",
    verification_evidence: "Test artifact and verification evidence",
  }]);
  const invalid = checkReviewResolutions({});
  assert.equal(invalid.valid, false);
  assert.ok(!invalid.valid && invalid.errors.some((error) => error.pointer === "/" && error.constraint === "type"));
});

test("review gate requires both a completed test dispatch and a passed review", async () => {
  const { store, home } = await openStore();
  try {
    const reviews = new ReviewService(store);
    const runId = createRun(store);
    assert.throws(() => reviews.create(runId, REVIEW_HEAD, true), /requires a completed independent test/);
    await completeTest(store, runId);
    const barrier = reviews.create(runId, REVIEW_HEAD, true);
    assert.throws(() => reviews.submit(runId, barrier.barrier_id, result("standards")), /leaf dispatch has not completed/);
    submitReview(reviews, store, runId, barrier.barrier_id, result("spec"));
    submitReview(reviews, store, runId, barrier.barrier_id, result("standards"));
    assert.doesNotThrow(() => reviews.assertGate(runId));

    const unreviewedRun = createRun(store);
    await completeTest(store, unreviewedRun);
    assert.throws(() => reviews.assertGate(unreviewedRun), /review gate has not passed/);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("research conclusions require every provenance field", () => {
  const valid: ResearchConclusion = {
    kind: "fact",
    statement: "The API is available.",
    url: "https://example.com/docs",
    accessed_at: "2026-08-13",
    applicable_version: "1.0.0",
    source_level: "official",
  };
  assert.doesNotThrow(() => validateResearchConclusions([valid]));
  assert.throws(() => validateResearchConclusions([]), /at least one conclusion/);

  const invalid: Array<[string, Partial<ResearchConclusion>]> = [
    ["kind", { kind: "opinion" as ResearchConclusion["kind"] }],
    ["statement", { statement: "" }],
    ["url", { url: "file:///tmp/source" }],
    ["accessed_at", { accessed_at: "2026/08/13" }],
    ["applicable_version", { applicable_version: "" }],
    ["source_level", { source_level: "unknown" as ResearchConclusion["source_level"] }],
  ];
  for (const [field, override] of invalid) {
    assert.throws(
      () => validateResearchConclusions([{ ...valid, ...override }]),
      (error: unknown) => error instanceof ValidationError,
      field,
    );
  }
});

test("project init is Git-only, idempotent, and appends the context rule once", async () => {
  const nonRepository = await temporaryDirectory();
  const repository = await createRepository();
  try {
    await assert.rejects(() => initializeProject(nonRepository), /Git command failed/);
    await assert.rejects(() => stat(path.join(nonRepository, ".ai-team")));

    const agentsPath = path.join(repository.directory, "AGENTS.md");
    await writeFile(agentsPath, "# Existing instructions\n");
    await assert.rejects(() => initializeProject(repository.directory), /confirmation required/);
    const first = await initializeProject(repository.directory, true);
    const second = await initializeProject(repository.directory);
    assert.deepEqual(first.additions, ["/.worktrees/", "/.ai-team/runtime/"]);
    assert.deepEqual(second.additions, []);
    const agents = await readFile(agentsPath, "utf8");
    assert.match(agents, /入口、职责或模块边界变化时/);
    assert.equal(agents.match(/入口、职责或模块边界变化时/g)?.length, 1);
    const ignore = await readFile(path.join(repository.directory, ".gitignore"), "utf8");
    assert.equal(ignore.match(/^\/\.worktrees\/$/gm)?.length, 1);
    assert.equal(ignore.match(/^\/\.ai-team\/runtime\/$/gm)?.length, 1);
    await stat(path.join(repository.directory, ".ai-team", "project.yaml"));
    await stat(path.join(repository.directory, ".ai-team", "standards"));
    await stat(path.join(repository.directory, ".ai-team", "plans"));
    await stat(path.join(repository.directory, "MEMORY.md"));
    await stat(path.join(repository.directory, ".ai-team", "index", "feature-navigation.md"));
  } finally {
    await rm(nonRepository, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("project init requires confirmation before appending to a dirty .gitignore", async () => {
  const repository = await createRepository();
  try {
    await writeFile(path.join(repository.directory, ".gitignore"), "dist/\n");
    await git(repository.directory, "add", ".gitignore");
    await git(repository.directory, "commit", "-m", "add ignore");
    await writeFile(path.join(repository.directory, ".gitignore"), "dist/\ncoverage/\n");
    const plan = await planProjectInit(repository.directory);
    assert.equal(plan.gitignoreDirty, true);
    assert.deepEqual(plan.additions, ["/.worktrees/", "/.ai-team/runtime/"]);
    await assert.rejects(() => initializeProject(repository.directory), /confirmation required/);
    assert.equal(await readFile(path.join(repository.directory, ".gitignore"), "utf8"), "dist/\ncoverage/\n");
    await assert.rejects(() => stat(path.join(repository.directory, ".ai-team")));

    await initializeProject(repository.directory, true);
    assert.equal(
      await readFile(path.join(repository.directory, ".gitignore"), "utf8"),
      "dist/\ncoverage/\n/.worktrees/\n/.ai-team/runtime/\n",
    );
  } finally {
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("revision writing enforces coverage, frontmatter, and immutability", async () => {
  const project = await temporaryDirectory();
  const planId = "20260813-workflow";
  const specDocument = ["# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景", "## 功能需求", "### REQ-001：需求", "对应验收 AC-001", "## 验收标准", "### AC-001：验收", "- Given：前置", "- When：操作", "- Then：结果", "- 覆盖需求：REQ-001", "- RED 判定：实施前失败", "- 可观察结果：实施后通过", "- 边界反例：无输入", "- 建议测试层级：unit", "## 数据与接口", "无", "## 兼容约束", "macOS", "## 安全约束", "本地", "## 错误与边界", "失败", "## 迁移发布回滚", "回滚", "## 已确认偏好", "中文", "## 默认取舍", "默认", "## 已关闭问题", "无", "## 未决问题", "none"].join("\n");
  const planContract = {
    acceptance_criteria: ["AC-001"],
    acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
    task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
    test_commands: ["npm test"],
  };
  const taskContract = {
    ...planContract,
    tdd_cycles: [{ acceptance_criterion: "AC-001", test_path: "test/example.test.ts", red: { command: "npm test", expected_failure: "fails" }, green: { implementation_steps: ["implement"], command: "npm test", expected_result: "passes" }, refactor: { scope: "none", command: "npm test", expected_result: "passes" } }],
  };
  const planDocument = ["# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", "REQ-001 AC-001", "## 验证", "验证", "## 方案验收契约", "```json", JSON.stringify(planContract), "```", "## 发布与回滚", "回滚"].join("\n");
  const taskDocument = ["# Tasks", "REQ-001 AC-001 TASK-001", "## 任务验收契约", "```json", JSON.stringify(taskContract), "```"].join("\n");
  try {
    assert.deepEqual(validateCoverage("REQ-001 AC-001", ["REQ-001 REQ-999"]), {
      requirements: ["AC-001", "REQ-001"],
      missing: ["AC-001"],
      unknown: ["REQ-999"],
    });
    assert.throws(() => assertCoverage("REQ-001 AC-001", ["REQ-001"]), /coverage is incomplete/);
    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", {} as never),
      (error: unknown) => error instanceof ValidationError
        && assert.deepEqual((error.details as Array<{ path: string; message: string }>).map(({ path, message }) => ({ path, message })), [
          { path: "/spec", message: "must be a string" },
          { path: "/plan", message: "must be a string" },
        ]) === undefined,
    );
    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", { spec: "REQ-001 AC-001", plan: "REQ-001 AC-001" }),
      /missing required sections/,
    );
    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", { spec: specDocument, plan: planDocument.replace("REQ-001 AC-001", "AC-001") }),
      /coverage is incomplete/,
    );

    const written = await writeRevision(project, planId, "001", "main", {
      spec: specDocument,
      plan: planDocument,
      tasks: taskDocument,
    }, "000");
    const spec = await readFile(path.join(written.path, "spec.md"), "utf8");
    assert.match(spec, /^---\nplan_id: 20260813-workflow\nrevision: "001"\ntarget_branch: main\nsupersedes: "000"\n---\n\n# Spec/);
    assert.match(written.digest, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () => writeRevision(project, "20260813-workflow-abcd", "002", "main", {
        spec: specDocument,
        plan: planDocument,
        tasks: taskDocument,
      }),
      /invalid plan id/,
    );

    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", { spec: "REQ-002", plan: "REQ-002" }),
      /revisions are immutable/,
    );
    assert.equal(await readFile(path.join(written.path, "spec.md"), "utf8"), spec);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("coding start validates planned parameters, branch, clean worktree, and HEAD baseline", async () => {
  const repository = await createRepository();
  await initializeRepositoryContext(repository);
  const { store, home } = await openStore();
  try {
    const workflow = new WorkflowService(store);
    const identity = await repositoryIdentity(repository.directory);
    store.registerRepository(identity.repoId, identity.commonDir, identity.root);

    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned" }),
      /requires plan-id/,
    );
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan", request: "extra" }),
      /forbids request/,
    );

    await commitPlanRevision(repository, "plan", "001", ["TASK-001"]);
    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run("plan", "001", identity.repoId, "ready", "main", new Date().toISOString());
    const started = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan" });
    const run = store.getRun(started.run_id);
    assert.equal(run.mode, "planned");
    assert.equal(run.plan_id, "plan");
    assert.equal(run.revision, "001");
    assert.equal(run.target_branch, "main");
    assert.equal(run.base_commit, repository.head);
    assert.equal(typeof run.plan_digest, "string");
    assert.ok((run.plan_digest as string).length > 0);
    assert.equal(started.role, "file-explorer");
    assert.deepEqual(started.depends_on, []);
    const planWorktree = store.db.prepare("SELECT run_id,branch,path,base_commit,state FROM worktrees WHERE run_id=?").get(started.run_id) as { run_id: string; branch: string; path: string; base_commit: string; state: string };
    assert.deepEqual(planWorktree, {
      run_id: started.run_id,
      branch: "plan/plan/plan-001",
      path: await realpath(path.join(repository.directory, ".worktrees", "plans", "plan", "plan-001")),
      base_commit: repository.head,
      state: "active",
    });
    const dispatch = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(started.dispatch_id) as { packet_json: string };
    assert.equal(JSON.parse(dispatch.packet_json).context.implementation_base_commit, repository.head);
    await readFile(path.join(planWorktree.path, ".ai-team", "plans", "plan", "plan.yaml"), "utf8");
    await readFile(path.join(planWorktree.path, ".ai-team", "plans", "plan", "revisions", "001", "spec.md"), "utf8");
    await readFile(path.join(planWorktree.path, ".ai-team", "plans", "plan", "revisions", "001", "plan.md"), "utf8");
    await readFile(path.join(planWorktree.path, ".ai-team", "plans", "plan", "revisions", "001", "tasks", "TASK-001.md"), "utf8");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(started.run_id) as { count: number }).count, 1);
    await assert.rejects(new GitOrchestrator(store).prepareTask(started.run_id, "TASK-001"), /uses its plan worktree directly/);

    await commitPlanRevision(repository, "plan", "002");
    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run("plan", "002", identity.repoId, "ready", "main", new Date().toISOString());
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan" }),
      /multiple ready revisions/,
    );
    const selected = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan", revision: "002" });
    assert.equal(store.getRun(selected.run_id).revision, "002");

    const blockedPlan = "blocked-plan";
    await commitPlanRevision(repository, blockedPlan, "001");
    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run(blockedPlan, "001", identity.repoId, "ready", "main", new Date().toISOString());
    const blockedBranch = `plan/${blockedPlan}/${blockedPlan}-001`;
    await git(repository.directory, "branch", blockedBranch, repository.head);
    let failedRunId = "";
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned", planId: blockedPlan, revision: "001" }),
      (error: unknown) => {
        if (!(error instanceof ValidationError)) return false;
        const details = error.details as { run_id: string; cause: string; retry: string };
        failedRunId = details.run_id;
        return /marked failed/.test(error.message) && /unowned branch already exists/.test(details.cause) && /start a new planned coding run/.test(details.retry);
      },
    );
    assert.equal(store.getRun(failedRunId).state, "failed");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=?").get(failedRunId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='run.start_failed'").get(failedRunId) as { count: number }).count, 1);
    await git(repository.directory, "branch", "-D", blockedBranch);
    const retried = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: blockedPlan, revision: "001" });
    assert.equal(store.getRun(retried.run_id).state, "active");
    assert.notEqual(retried.run_id, failedRunId);

    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run("wrong-branch", "001", identity.repoId, "ready", "release", new Date().toISOString());
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned", planId: "wrong-branch" }),
      /target branch differs/,
    );

    await writeFile(path.join(repository.directory, "dirty.txt"), "dirty\n");
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "bug", request: "fix" }),
      (error: unknown) => error instanceof ValidationError
        && (error.details as { untracked: string[] }).untracked.includes("dirty.txt"),
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("bug and feature coding modes require a request and capture their Git baseline", async () => {
  const repository = await createRepository();
  await initializeRepositoryContext(repository);
  const { store, home } = await openStore();
  try {
    const workflow = new WorkflowService(store);
    await assert.rejects(() => workflow.codingStart({ project: repository.directory, mode: "bug" }), /requires request/);
    await assert.rejects(() => workflow.codingStart({ project: repository.directory, mode: "feature", request: "   " }), /requires request/);
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "bug", request: "fix", planId: "plan" }),
      /forbids plan-id and revision/,
    );
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "feature", request: "add", revision: "001" }),
      /forbids plan-id and revision/,
    );

    const bugRequest = "actual: command fails\nexpected: command succeeds\nevidence: failing CLI test";
    const featureRequest = "goal: add command\nacceptance: exits zero\nscope: src/cli.ts\nmodule: cli";
    const bug = await workflow.codingStart({ project: repository.directory, mode: "bug", request: bugRequest });
    const feature = await workflow.codingStart({ project: repository.directory, mode: "feature", request: featureRequest });
    const cases: Array<[string, "bug" | "feature", string]> = [
      [bug.run_id, "bug", bugRequest],
      [feature.run_id, "feature", featureRequest],
    ];
    for (const [runId, mode, request] of cases) {
      const run = store.getRun(runId);
      assert.equal(run.mode, mode);
      assert.equal(run.request, request);
      assert.equal(run.target_branch, "main");
      assert.equal(run.base_commit, repository.head);
      assert.equal((store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count, 0);
      const contract = JSON.parse(run.plan_verification_json as string);
      assert.deepEqual(contract.acceptance_criteria, [`AC-001: ${request}`]);
      assert.deepEqual(contract.acceptance_steps[0].acceptance_criteria, contract.acceptance_criteria);
    }
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "bug", request: featureRequest }),
      /does not match inferred feature; planning required/,
    );
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "feature", request: bugRequest }),
      /does not match inferred bug; planning required/,
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("managed planned reconciliation cleans legacy worktrees, audits failed starts, and restarts idempotently", async () => {
  const repository = await createRepository();
  await initializeRepositoryContext(repository);
  await commitPlanRevision(repository, "20260817-recovery", "001");
  const { store, home } = await openStore();
  try {
    const identity = await repositoryIdentity(repository.directory);
    store.registerRepository(identity.repoId, identity.commonDir, identity.root);
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("20260817-recovery", "001", identity.repoId, "ready", "main", "b".repeat(64), repository.head, new Date().toISOString());
    const workflow = new WorkflowService(store);
    const started = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "20260817-recovery", revision: "001" });
    const taskBranch = "task/20260817-recovery/20260817-recovery-001--implementation";
    const taskPath = path.join(repository.directory, ".worktrees", "tasks", "20260817-recovery", "20260817-recovery-001--implementation");
    await mkdir(path.dirname(taskPath), { recursive: true });
    await git(repository.directory, "worktree", "add", "-b", taskBranch, taskPath, repository.head);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_legacy_implementation", started.run_id, taskBranch, taskPath, repository.head, new Date().toISOString());
    const failedRunId = store.createRun({ repoId: identity.repoId, profile: "coding", mode: "planned", planId: "20260817-recovery", revision: "001", baseCommit: repository.head, targetBranch: "main", planDigest: "b".repeat(64) });
    store.db.prepare("UPDATE runs SET state='failed',stage='git-operator' WHERE run_id=?").run(failedRunId);
    store.event(failedRunId, "run.start_failed", { cause: `branch or worktree belongs to another run: ${started.run_id}` });
    const blockedDispatchId = workflow.dispatches.create(started.run_id, "coding", {
      objective: "Recover the anomalous planned run",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Create a managed cleanup action"],
      context: { stage: "coding" },
    });
    store.db.prepare("UPDATE dispatches SET state='needs_decision' WHERE dispatch_id=?").run(blockedDispatchId);
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='coding' WHERE run_id=?").run(started.run_id);
    const decisionId = store.createDecision(started.run_id, "How should the planned run recover?", [
      { id: "managed-reconcile", label: "Managed reconciliation", impact: "Clean old ownership and restart" },
      { id: "stop", label: "Stop", impact: "Keep the run blocked" },
    ], "managed-reconcile", "planned_run_recovery_gap", blockedDispatchId);
    const cleanupDispatchId = workflow.dispatches.resolveDecision(started.run_id, decisionId, "managed-reconcile");
    assert.equal(workflow.dispatches.resolveDecision(started.run_id, decisionId, "managed-reconcile"), cleanupDispatchId);
    const cleanupPacket = JSON.parse((store.db.prepare("SELECT role,packet_json FROM dispatches WHERE dispatch_id=?").get(cleanupDispatchId) as { role: string; packet_json: string }).packet_json);
    assert.equal((store.db.prepare("SELECT role FROM dispatches WHERE dispatch_id=?").get(cleanupDispatchId) as { role: string }).role, "git-operator");
    assert.equal(cleanupPacket.context.phase, "cancel_cleanup");
    assert.deepEqual(cleanupPacket.context.reconciliation.conflicting_run_ids, [failedRunId]);
    assert.deepEqual(store.db.prepare("SELECT state,stage,source_run_id FROM runs WHERE run_id=?").get(failedRunId), { state: "canceled", stage: "reconciled", source_run_id: started.run_id });
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='run.failed_start_reconciled'").get(failedRunId) as { count: number }).count, 1);
    workflow.dispatches.claim(started.run_id, cleanupDispatchId, "git-operator");
    const removed = await new GitOrchestrator(store).cleanup(started.run_id, cleanupDispatchId);
    assert.equal(removed.length, 2);
    await workflow.dispatches.submitValue(started.run_id, cleanupDispatchId, "git-operator", {
      ...createResultTemplate(started.run_id, cleanupDispatchId, "git-operator"),
      summary: "Canceled run worktrees removed",
      verification: [{ command: "ai-team git status", outcome: "no active run-owned worktrees" }],
      payload: { operations: [{ command: "ai-team git cleanup", outcome: "removed the plan and obsolete implementation worktrees" }] },
    });
    assert.equal(store.getRun(started.run_id).state, "canceled");
    const replacement = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "20260817-recovery", revision: "001" });
    assert.notEqual(replacement.run_id, started.run_id);
    assert.equal(store.getRun(replacement.run_id).plan_digest, "b".repeat(64));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND state='active'").get(replacement.run_id) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%'").get(replacement.run_id) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND status='pending'").get(replacement.run_id) as { count: number }).count, 0);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("frozen coding runs hand off to one linked planning run without transferring task worktrees", async () => {
  const repository = await createRepository();
  await initializeRepositoryContext(repository);
  const { store, home } = await openStore();
  try {
    const workflow = new WorkflowService(store);
    const started = await workflow.codingStart({
      project: repository.directory,
      mode: "bug",
      request: "actual: scope drift\nexpected: planning reconciliation\nevidence: frozen run",
    });
    const now = new Date().toISOString();
    store.db.prepare("UPDATE runs SET state='frozen' WHERE run_id=?").run(started.run_id);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_handoff", started.run_id, "task/direct/handoff/implementation", path.join(repository.directory, ".worktrees", "handoff"), repository.head, now);

    const first = workflow.handoffToPlanning(started.run_id, "Reconcile the frozen scope through Planning.");
    const second = workflow.handoffToPlanning(started.run_id, "Reconcile the frozen scope through Planning.");
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.run_id, first.run_id);
    assert.equal(store.getRun(first.run_id).source_run_id, started.run_id);
    assert.equal((store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id='worktree_handoff'").get() as { run_id: string }).run_id, started.run_id);
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(started.dispatch_id) as { state: string }).state, "failed");
    assert.equal(workflow.completePlanningHandoff(first.run_id, "20260816-handoff", "001", "digest", "a".repeat(40)), started.run_id);
    const resumed = store.getRun(started.run_id);
    assert.equal(resumed.state, "active");
    assert.equal(resumed.stage, "coding");
    assert.equal(resumed.plan_id, "20260816-handoff");
    assert.equal(resumed.revision, "001");
    assert.equal((store.db.prepare("SELECT run_id FROM worktrees WHERE worktree_id='worktree_handoff'").get() as { run_id: string }).run_id, started.run_id);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("automatic coding triage prioritizes one ready revision and otherwise classifies evidence", async () => {
  const repository = await createRepository();
  await initializeRepositoryContext(repository);
  const { store, home } = await openStore();
  try {
    const workflow = new WorkflowService(store);
    const identity = await repositoryIdentity(repository.directory);
    store.registerRepository(identity.repoId, identity.commonDir, identity.root);
    await commitPlanRevision(repository, "20260814-auto", "001");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-auto", "001", identity.repoId, "ready", "main", new Date().toISOString());
    const planned = await workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test");
    assert.equal(planned.triage, "planned");
    assert.equal(store.getRun(planned.run_id!).plan_id, "20260814-auto");

    await commitPlanRevision(repository, "20260814-explicit", "001");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-explicit", "001", identity.repoId, "ready", "main", new Date(Date.now() + 1).toISOString());
    await assert.rejects(
      workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test"),
      /multiple ready revisions; specify a plan/,
    );
    const explicit = await workflow.codingStartAuto(repository.directory, undefined, "20260814-explicit", "001");
    assert.equal(explicit.triage, "planned");
    assert.equal(store.getRun(explicit.run_id!).plan_id, "20260814-explicit");

    store.db.prepare("UPDATE revisions SET state='implemented' WHERE repo_id=?").run(identity.repoId);
    const bug = await workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test");
    assert.equal(bug.triage, "bug");
    const feature = await workflow.codingStartAuto(repository.directory, "goal: add command\nacceptance: exits zero\nscope: src/cli.ts\nmodule: cli");
    assert.equal(feature.triage, "feature");
    assert.deepEqual(await workflow.codingStartAuto(repository.directory, "Please redesign several modules."), { triage: "planning" });
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});
