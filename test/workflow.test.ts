import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const createRun = (store: StateStore, mode = "feature"): string => {
  store.registerRepository("repo", path.resolve(REVIEW_COMMON_DIR), process.cwd());
  return store.createRun({ repoId: "repo", profile: "coding", mode });
};

const result = (axis: "spec" | "standards", findings: ReviewResult["findings"] = []): ReviewResult => ({
  axis,
  summary: `${axis} review complete`,
  findings,
});

const completeTest = (store: StateStore, runId: string): void => {
  const dispatchId = new WorkflowService(store).dispatches.create(runId, "test", {
    objective: "independent verification", allowed_read_paths: ["package.json"], allowed_write_paths: [], acceptance_criteria: ["tests pass"], context: {},
  });
  store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
    .run(JSON.stringify({ ...createResultTemplate(runId, dispatchId, "test"), summary: "tests passed", verification: [{ command: "npm test", outcome: "passed" }], payload: { checks: [{ command: "npm test", outcome: "passed" }] } }), new Date().toISOString(), dispatchId);
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
    completeTest(store, directRun);
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
    assert.throws(() => reviews.submit(directRun, direct.barrier_id, result("standards")), /already complete/);
    assert.throws(() => reviews.create(directRun, REVIEW_HEAD, false), /reviews run once/);

    const formalRun = createRun(store, "planned");
    completeTest(store, formalRun);
    assert.throws(() => reviews.create(formalRun, REVIEW_HEAD, false), /require formal review axes/);
    const formal = reviews.create(formalRun, REVIEW_HEAD, true);
    assert.deepEqual(formal.axes, ["spec", "standards"]);
    assert.deepEqual(
      (store.db.prepare("SELECT role FROM dispatches WHERE run_id=? AND role LIKE 'review-%' ORDER BY role").all(formalRun) as Array<{ role: string }>).map(({ role }) => role),
      ["review-spec", "review-standards"],
    );
    assert.equal(submitReview(reviews, store, formalRun, formal.barrier_id, result("spec")).state, "pending");
    assert.throws(() => reviews.submit(formalRun, formal.barrier_id, result("spec")), /already submitted/);
    assert.equal(submitReview(reviews, store, formalRun, formal.barrier_id, result("standards")).state, "passed");
  } finally {
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

test("project init is Git-only, idempotent, and never changes AGENTS.md", async () => {
  const nonRepository = await temporaryDirectory();
  const repository = await createRepository();
  try {
    await assert.rejects(() => initializeProject(nonRepository), /Git command failed/);
    await assert.rejects(() => stat(path.join(nonRepository, ".ai-team")));

    const agentsPath = path.join(repository.directory, "AGENTS.md");
    await writeFile(agentsPath, "# Existing instructions\n");
    const first = await initializeProject(repository.directory);
    const second = await initializeProject(repository.directory);
    assert.deepEqual(first.additions, ["/.worktree/", "/.ai-team/runtime/"]);
    assert.deepEqual(second.additions, []);
    assert.equal(await readFile(agentsPath, "utf8"), "# Existing instructions\n");
    const ignore = await readFile(path.join(repository.directory, ".gitignore"), "utf8");
    assert.equal(ignore.match(/^\/\.worktree\/$/gm)?.length, 1);
    assert.equal(ignore.match(/^\/\.ai-team\/runtime\/$/gm)?.length, 1);
    await stat(path.join(repository.directory, ".ai-team", "project.yaml"));
    await stat(path.join(repository.directory, ".ai-team", "standards"));
    await stat(path.join(repository.directory, ".ai-team", "plans"));
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
    assert.deepEqual(plan.additions, ["/.worktree/", "/.ai-team/runtime/"]);
    await assert.rejects(() => initializeProject(repository.directory), /confirmation required/);
    assert.equal(await readFile(path.join(repository.directory, ".gitignore"), "utf8"), "dist/\ncoverage/\n");
    await assert.rejects(() => stat(path.join(repository.directory, ".ai-team")));

    await initializeProject(repository.directory, true);
    assert.equal(
      await readFile(path.join(repository.directory, ".gitignore"), "utf8"),
      "dist/\ncoverage/\n/.worktree/\n/.ai-team/runtime/\n",
    );
  } finally {
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("revision writing enforces coverage, frontmatter, and immutability", async () => {
  const project = await temporaryDirectory();
  const planId = "20260813-workflow-abcd";
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
    assert.match(spec, /^---\nplan_id: 20260813-workflow-abcd\nrevision: "001"\ntarget_branch: main\nsupersedes: "000"\n---\n\n# Spec/);
    assert.match(written.digest, /^[a-f0-9]{64}$/);

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

    const bug = await workflow.codingStart({ project: repository.directory, mode: "bug", request: "Fix REQ-001" });
    const feature = await workflow.codingStart({ project: repository.directory, mode: "feature", request: "Add AC-001" });
    const cases: Array<[string, "bug" | "feature", string]> = [
      [bug.run_id, "bug", "Fix REQ-001"],
      [feature.run_id, "feature", "Add AC-001"],
    ];
    for (const [runId, mode, request] of cases) {
      const run = store.getRun(runId);
      assert.equal(run.mode, mode);
      assert.equal(run.request, request);
      assert.equal(run.target_branch, "main");
      assert.equal(run.base_commit, repository.head);
    }
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
      .run("20260814-auto-abcd", "001", identity.repoId, "ready", "main", new Date().toISOString());
    const planned = await workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test");
    assert.equal(planned.triage, "planned");
    assert.equal(store.getRun(planned.run_id!).plan_id, "20260814-auto-abcd");

    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-explicit-abcd", "001", identity.repoId, "ready", "main", new Date(Date.now() + 1).toISOString());
    await assert.rejects(
      workflow.codingStartAuto(repository.directory, "actual: broken\nexpected: works\nevidence: failing test"),
      /multiple ready revisions; specify a plan/,
    );
    const explicit = await workflow.codingStartAuto(repository.directory, undefined, "20260814-explicit-abcd", "001");
    assert.equal(explicit.triage, "planned");
    assert.equal(store.getRun(explicit.run_id!).plan_id, "20260814-explicit-abcd");

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
