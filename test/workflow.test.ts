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
import { ReviewService, type ReviewResult } from "../src/review.js";
import { StateStore } from "../src/state.js";
import { WorkflowService } from "../src/workflow.js";

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

const openStore = async (): Promise<{ store: StateStore; home: string }> => {
  const home = await temporaryDirectory();
  return { store: await StateStore.open(home), home };
};

const REVIEW_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
    objective: "independent verification", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["tests pass"], context: { implementation_commit: REVIEW_HEAD, changed_paths: ["package.json"] },
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

test("direct and formal reviews require the correct axes and run once per frozen revision", async () => {
  const { store, home } = await openStore();
  try {
    const reviews = new ReviewService(store);
    const directRun = createRun(store);
    await completeTest(store, directRun);
    assert.throws(() => reviews.create(directRun, REVIEW_HEAD, true), /require direct review axes/);
    assert.throws(() => reviews.create(directRun, "0".repeat(40), false), /commit does not exist/);
    const direct = reviews.create(directRun, REVIEW_HEAD, false);
    assert.deepEqual(direct.axes, ["standards"]);
    assert.deepEqual(
      (store.db.prepare("SELECT role FROM dispatches WHERE run_id=? AND role LIKE 'review-%' ORDER BY role").all(directRun) as Array<{ role: string }>).map(({ role }) => role),
      ["review-standards"],
    );
    assert.throws(() => reviews.submit(directRun, direct.barrier_id, result("spec")), /not required/);
    assert.equal(submitReview(reviews, store, directRun, direct.barrier_id, result("standards")).state, "passed");
    assert.equal(reviews.submit(directRun, direct.barrier_id, result("standards")).state, "passed");
    assert.deepEqual(reviews.create(directRun, REVIEW_HEAD, false), { ...direct, reused: true });

    const formalRun = createRun(store, "planned");
    await completeTest(store, formalRun);
    assert.throws(() => reviews.create(formalRun, REVIEW_HEAD, false), /require formal review axes/);
    const formal = reviews.create(formalRun, REVIEW_HEAD, true);
    assert.deepEqual(formal.axes, ["spec", "standards"]);
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
    completeTest(store, runId);
    const barrier = reviews.create(runId, REVIEW_HEAD, false);
    const findings: ReviewResult["findings"] = [
      { finding_id: "FIND-SEC-001", severity: "P0", title: "P0", source: "spec", source_file: "spec.md", source_line: 1, evidence: "e0", impact: "security", recommendation: "fix" },
      { finding_id: "FIND-CODE-002", severity: "P1", title: "P1", source: "code", source_file: "src/a.ts", source_line: 2, evidence: "e1", impact: "bug", recommendation: "fix" },
      { finding_id: "FIND-TEST-003", severity: "P2", title: "P2", source: "test", source_file: "test/a.ts", source_line: 3, evidence: "e2", impact: "coverage", recommendation: "test" },
    ];
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
        && assert.deepEqual(error.details, { missing: ["FIND-CODE-002"], unknown: [] }) === undefined,
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

test("review gate requires both a completed test dispatch and a passed review", async () => {
  const { store, home } = await openStore();
  try {
    const reviews = new ReviewService(store);
    const runId = createRun(store);
    assert.throws(() => reviews.create(runId, REVIEW_HEAD, false), /requires a completed independent test/);
    completeTest(store, runId);
    const barrier = reviews.create(runId, REVIEW_HEAD, false);
    assert.throws(() => reviews.submit(runId, barrier.barrier_id, result("standards")), /leaf dispatch has not completed/);
    submitReview(reviews, store, runId, barrier.barrier_id, result("standards"));
    assert.doesNotThrow(() => reviews.assertGate(runId));

    const unreviewedRun = createRun(store);
    completeTest(store, unreviewedRun);
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
  const specDocument = ["# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景", "## 功能需求", "REQ-001", "## 验收标准", "AC-001", "## 数据与接口", "无", "## 兼容约束", "macOS", "## 安全约束", "本地", "## 错误与边界", "失败", "## 迁移发布回滚", "回滚", "## 已确认偏好", "中文", "## 默认取舍", "默认", "## 已关闭问题", "无", "## 未决问题", "none"].join("\n");
  const planDocument = ["# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", "REQ-001", "## 验证", "验证", "## 发布与回滚", "回滚"].join("\n");
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
        && assert.deepEqual(error.details, [
          { path: "/spec", message: "must be a string" },
          { path: "/plan", message: "must be a string" },
        ]) === undefined,
    );
    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", { spec: "REQ-001 AC-001", plan: "REQ-001 AC-001" }),
      /missing required sections/,
    );
    await assert.rejects(
      () => writeRevision(project, planId, "001", "main", { spec: specDocument, plan: planDocument }),
      /coverage is incomplete/,
    );

    const written = await writeRevision(project, planId, "001", "main", {
      spec: specDocument,
      plan: planDocument,
      tasks: "# Tasks\nAC-001",
    }, "000");
    const spec = await readFile(path.join(written.path, "spec.md"), "utf8");
    assert.match(spec, /^---\nplan_id: 20260813-workflow\nrevision: "001"\ntarget_branch: main\nsupersedes: "000"\n---\n\n# Spec/);
    assert.match(written.digest, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () => writeRevision(project, "20260813-workflow-abcd", "002", "main", {
        spec: specDocument,
        plan: planDocument,
        tasks: "# Tasks\nAC-001",
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

    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run("plan", "001", identity.repoId, "ready", "main", new Date().toISOString());
    const started = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan" });
    const run = store.getRun(started.run_id);
    assert.equal(run.mode, "planned");
    assert.equal(run.plan_id, "plan");
    assert.equal(run.revision, "001");
    assert.equal(run.target_branch, "main");
    assert.equal(run.base_commit, repository.head);
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

    store.db.prepare(`INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at)
      VALUES (?,?,?,?,?,?)`).run("plan", "002", identity.repoId, "ready", "main", new Date().toISOString());
    await assert.rejects(
      () => workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan" }),
      /multiple ready revisions/,
    );
    const selected = await workflow.codingStart({ project: repository.directory, mode: "planned", planId: "plan", revision: "002" });
    assert.equal(store.getRun(selected.run_id).revision, "002");

    const blockedPlan = "blocked-plan";
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

test("frozen coding runs hand off to one linked planning run without transferring task worktrees", async () => {
  const repository = await createRepository();
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
  const { store, home } = await openStore();
  try {
    const workflow = new WorkflowService(store);
    const identity = await repositoryIdentity(repository.directory);
    store.registerRepository(identity.repoId, identity.commonDir, identity.root);
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-auto", "001", identity.repoId, "ready", "main", new Date().toISOString());
    const planned = await workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test");
    assert.equal(planned.triage, "planned");
    assert.equal(store.getRun(planned.run_id!).plan_id, "20260814-auto");

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
