import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCommand } from "../src/command-contract.js";
import { checkDecisionInput, checkProjectContext, checkResultEnvelope, createResultTemplate, resultSchemaForRole, ROLE_PAYLOAD_SCHEMAS } from "../src/contracts.js";
import { DispatchService, type DispatchPacket } from "../src/dispatch.js";
import { ScopeGate } from "../src/gates.js";
import { ResearchService } from "../src/research-service.js";
import type { ResearchConclusion } from "../src/research.js";
import { ReviewService, type ReviewResult } from "../src/review.js";
import { StateStore } from "../src/state.js";

const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "ai-team-review-fixes-"));
const REVIEW_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const REVIEW_COMMON_DIR = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();

const withStore = async (callback: (store: StateStore, home: string) => Promise<void> | void): Promise<void> => {
  const home = await temporaryDirectory();
  const store = await StateStore.open(home);
  try {
    await callback(store, home);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
};

const createRun = (
  store: StateStore,
  profile: "planning" | "coding" = "coding",
  extra: { planId?: string; revision?: string } = {},
): string => {
  const repoId = "repo-review-fixture";
  store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
  return store.createRun({
    repoId,
    profile,
    mode: profile === "planning" ? "planned" : "feature",
    request: "review fixes",
    ...extra,
  });
};

const dispatchPacket = (allowedReadPaths: string[] = ["src/dispatch.ts"]): DispatchPacket => ({
  objective: "Exercise the frozen dispatch contract",
  allowed_read_paths: allowedReadPaths,
  allowed_write_paths: [],
  acceptance_criteria: ["Structured result is accepted"],
  context: {},
});

const completedResult = (
  runId: string,
  dispatchId: string,
  role: Parameters<typeof createResultTemplate>[2],
  payload: Record<string, unknown>,
) => ({
  ...createResultTemplate(runId, dispatchId, role),
  summary: `${role} completed`,
  verification: [{ command: "npm test", outcome: "passed" }],
  payload,
});

const projectContext = (entryPaths: string[] = ["src/dispatch.ts"]) => ({
  project_shape: "TypeScript CLI",
  memory: {
    domain_terms: ["dispatch"],
    repository_constraints: ["Node.js 22+"],
    responsibilities: ["src/dispatch.ts coordinates role dispatches"],
    module_boundaries: ["src contains runtime services"],
  },
  navigation: [{ feature: "Dispatch", keywords: ["dispatch"], entry_paths: entryPaths, module_boundary: "runtime" }],
  maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
});

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/review-fixes.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
});

test("an exact File Explorer result creates one planning or coding dispatch and duplicate submit reuses it", async () => {
  await withStore(async (store, home) => {
    for (const [profile, nextRole] of [["planning", "planning"], ["coding", "coding"]] as const) {
      const runId = createRun(store, profile);
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      const claimed = dispatches.claim(runId, explorerId, "file-explorer");
      assert.deepEqual(claimed.packet.allowed_read_paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md", "."]);
      const resultPath = join(home, `${profile}-file-explorer.json`);
      await writeFile(resultPath, JSON.stringify(fileExplorerResult(runId, explorerId)));

      const first = await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      assert.equal(first.reused, false);
      assert.equal(store.getRun(runId).stage, nextRole);
      const generated = store.db.prepare(
        "SELECT role, state, packet_json FROM dispatches WHERE run_id=? AND role=?",
      ).all(runId, nextRole) as Array<{ role: string; state: string; packet_json: string }>;
      assert.equal(generated.length, 1);
      assert.equal(generated[0]?.state, "pending");
      assert.deepEqual(JSON.parse(generated[0]?.packet_json ?? "{}").allowed_read_paths, [
        "MEMORY.md",
        ".ai-team/index/feature-navigation.md",
        "src/dispatch.ts",
        "test/review-fixes.test.ts",
      ]);

      const duplicate = await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      assert.deepEqual(duplicate, { reused: true, artifact: first.artifact });
      const count = store.db.prepare(
        "SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role=?",
      ).get(runId, nextRole) as { count: number };
      assert.equal(count.count, 1);
      if (profile === "coding") {
        const prepare = store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { state: string; packet_json: string };
        assert.equal(prepare.state, "pending");
        assert.equal(JSON.parse(prepare.packet_json).context.phase, "prepare_worktrees");
      }
    }
  });
});

test("dispatch lifecycle support cancels, reissues, and supersedes with audited lineage", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    const dispatches = new DispatchService(store);
    const original = dispatches.create(runId, "file-explorer", dispatchPacket(["src/dispatch.ts"]));
    dispatches.claim(runId, original, "file-explorer");

    const reissued = dispatches.reissue(runId, original, "file-explorer", "planning", "repair incomplete support dispatch");
    assert.equal(reissued.action, "reissued");
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(original) as { state: string }).state, "failed");
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(reissued.dispatch_id) as { replacement_for: string }).replacement_for, original);
    assert.deepEqual(dispatches.reissue(runId, original, "file-explorer", "planning", "repair incomplete support dispatch"), { ...reissued, reused: true });

    const replacementPacket = dispatchPacket(["src/planning.ts"]);
    const superseded = dispatches.supersede(runId, reissued.dispatch_id, "file-explorer", "planning", "correct authorized scope", replacementPacket);
    assert.equal(superseded.action, "superseded");
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(superseded.dispatch_id) as { replacement_for: string }).replacement_for, reissued.dispatch_id);
    assert.deepEqual(JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(superseded.dispatch_id) as { packet_json: string }).packet_json).allowed_read_paths, [
      "MEMORY.md", ".ai-team/index/feature-navigation.md", "src/planning.ts",
    ]);

    assert.deepEqual(dispatches.cancel(runId, superseded.dispatch_id, "file-explorer", "planning", "no longer required"), { action: "canceled", reused: false });
    assert.deepEqual(dispatches.cancel(runId, superseded.dispatch_id, "file-explorer", "planning", "no longer required"), { action: "canceled", reused: true });
    assert.deepEqual(
      (store.db.prepare("SELECT type FROM run_events WHERE type LIKE 'dispatch.%ed' ORDER BY event_id").all() as Array<{ type: string }>).map(({ type }) => type),
      ["dispatch.created", "dispatch.created", "dispatch.reissued", "dispatch.created", "dispatch.superseded", "dispatch.canceled"],
    );
  });
});

test("direct Git prepare phases require registered run-owned worktrees and defer the task until pre_write", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    dispatches.claim(runId, explorerId, "file-explorer");
    await dispatches.submitValue(runId, explorerId, "file-explorer", fileExplorerResult(runId, explorerId));

    const integrationPrepare = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { dispatch_id: string };
    dispatches.claim(runId, integrationPrepare.dispatch_id, "git-operator");
    const integrationResult = completedResult(runId, integrationPrepare.dispatch_id, "git-operator", {
      operations: [{ command: "reported both worktrees", outcome: "not authoritative" }],
    });
    await assert.rejects(dispatches.submitValue(runId, integrationPrepare.dispatch_id, "git-operator", integrationResult), /registered active integration worktree/);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_phase_integration", runId, "integration/phase/test", `/tmp/${runId}-integration`, REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, integrationPrepare.dispatch_id, "git-operator", integrationResult);

    const gate = new ScopeGate(store);
    gate.check(runId, "triage", ["src/dispatch.ts"]);
    gate.check(runId, "pre_write", ["src/dispatch.ts"]);
    gate.check(runId, "pre_write", ["src/dispatch.ts"]);
    const implementationRows = store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'`).all(runId) as Array<{ dispatch_id: string }>;
    assert.equal(implementationRows.length, 1);

    const implementationId = implementationRows[0]!.dispatch_id;
    dispatches.claim(runId, implementationId, "git-operator");
    const implementationResult = completedResult(runId, implementationId, "git-operator", {
      operations: [{ command: "reported task worktree", outcome: "not authoritative" }],
    });
    await assert.rejects(dispatches.submitValue(runId, implementationId, "git-operator", implementationResult), /registered active implementation task worktree/);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_phase_implementation", runId, "task/phase/test/implementation", `/tmp/${runId}-implementation`, REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, implementationId, "git-operator", implementationResult);
  });
});

test("planned Git prepare ignores arbitrary direct integration worktrees", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const runId = store.createRun({
      repoId,
      profile: "coding",
      mode: "planned",
      planId: "20260816-identity",
      revision: "001",
      baseCommit: REVIEW_HEAD,
      targetBranch: "main",
    });
    const dispatches = new DispatchService(store);
    const prepareId = dispatches.ensureGitPrepareDispatch(runId, "integration");
    dispatches.claim(runId, prepareId, "git-operator");
    const result = completedResult(runId, prepareId, "git-operator", { operations: [{ command: "prepare", outcome: "completed" }] });
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_wrong_planned_integration", runId, "integration/direct/wrong", `/tmp/${runId}-wrong`, REVIEW_HEAD, new Date().toISOString());

    await assert.rejects(dispatches.submitValue(runId, prepareId, "git-operator", result), /registered active integration worktree or plan worktree/);
    const planId = "20260816-identity";
    const planRevision = `${planId}-001`;
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_exact_planned", runId, `plan/${planId}/${planRevision}`, join(process.cwd(), ".worktrees", "plans", planId, planRevision), REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, prepareId, "git-operator", result);
  });
});

test("only File Explorer may receive broad read paths including ./**", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    for (const path of ["./**", "src/**", "**", "."]) {
      assert.throws(
        () => dispatches.create(runId, "coding", dispatchPacket([path])),
        /requires exact allowed_read_paths/,
        path,
      );
    }
    assert.doesNotThrow(() => dispatches.create(runId, "coding", dispatchPacket(["src/dispatch.ts"])));
    assert.doesNotThrow(() => dispatches.create(runId, "file-explorer", dispatchPacket(["./**"])));
  });
});

test("dispatch creation enforces actor command and delegation authorization", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    assert.throws(() => dispatches.create(runId, "backend-developer", dispatchPacket(), "test"), /test cannot act for coding run/);
    assert.throws(() => dispatches.create(runId, "file-explorer", dispatchPacket(), "planning"), /planning cannot act for coding run/);
    assert.throws(() => dispatches.create(runId, "environment-operator", dispatchPacket(), "coding"), /coding cannot delegate to environment-operator/);
    assert.throws(() => dispatches.create(runId, "backend-developer", dispatchPacket(), "coding"), /worktree_id/);
  });
});

test("failed and retryable results require failure metadata and never advance the run", async () => {
  await withStore(async (store, home) => {
    for (const status of ["failed", "retryable_failure"] as const) {
      const runId = createRun(store);
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, explorerId, "file-explorer");
      const invalidPath = join(home, `${status}-invalid.json`);
      const failed = {
        ...fileExplorerResult(runId, explorerId),
        status,
        verification: [],
        payload: {},
      };
      await writeFile(invalidPath, JSON.stringify(failed));
      await assert.rejects(dispatches.submit(runId, explorerId, "file-explorer", invalidPath), /result envelope is invalid/);
      assert.equal(store.getRun(runId).state, "active");
      assert.equal(store.getRun(runId).stage, "file-explorer");

      const validPath = join(home, `${status}-valid.json`);
      await writeFile(validPath, JSON.stringify({
        ...failed,
        failure_class: "temporary_tool_failure",
        side_effect_state: "none",
      }));
      const submitted = await dispatches.submit(runId, explorerId, "file-explorer", validPath);
      assert.equal(submitted.reused, false);
      assert.equal(store.getRun(runId).state, status === "failed" ? "failed" : "retryable_failure");
      assert.equal(store.getRun(runId).stage, "file-explorer");
      const advanced = store.db.prepare(
        "SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role IN ('planning','coding')",
      ).get(runId) as { count: number };
      assert.equal(advanced.count, 0);
    }
  });
});

test("completed results enforce the payload schema selected for every role", () => {
  const payloads = {
    planning: { actions: ["confirm requirements"], stage: "requirements", pending_questions: [], decision: null },
    coding: { actions: ["dispatch backend task"], triage: "feature" },
    "file-explorer": { allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/a.ts"], entry_points: ["src/a.ts"], test_commands: ["npm test"], project_context: projectContext(["src/a.ts"]) },
    "frontend-developer": { modified_paths: ["src/ui.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] },
    "backend-developer": { modified_paths: ["src/api.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] },
    test: { checks: [{ command: "npm test", outcome: "passed" }] },
    "git-operator": { operations: [{ command: "git status", outcome: "clean" }] },
    "code-reviewer": { axes: ["spec", "standards"] },
    "review-spec": { finding_ids: ["FIND-SPEC-001"] },
    "review-standards": { finding_ids: ["FIND-CODE-001"] },
    "environment-operator": { managed_paths: ["agents/coding.md"] },
    researcher: { report_path: "research/api.md", conclusion_count: 1 },
  } as const;
  const runId = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  for (const [role, payload] of Object.entries(payloads) as Array<[
    Parameters<typeof createResultTemplate>[2],
    Record<string, unknown>,
  ]>) {
    const result = completedResult(runId, dispatchId, role, payload);
    assert.equal(checkResultEnvelope(result).valid, true, role);
    assert.deepEqual(
      (resultSchemaForRole(role).properties as Record<string, unknown>).payload,
      ROLE_PAYLOAD_SCHEMAS[role],
      `${role} schema did not expose its role payload`,
    );
    assert.equal(
      checkResultEnvelope({ ...result, payload: { unexpected: true } }).valid,
      false,
      `${role} accepted a foreign payload`,
    );
  }

  const codingWithPlanningPayload = completedResult(runId, dispatchId, "coding", payloads.planning);
  assert.equal(checkResultEnvelope(codingWithPlanningPayload).valid, false);
  assert.equal(
    checkResultEnvelope({ ...codingWithPlanningPayload, payload: payloads["file-explorer"] }).valid,
    false,
  );

  const question = "Which compatibility target?";
  const needsDecision = {
    ...completedResult(runId, dispatchId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No migration" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
      },
    }),
    status: "needs_decision" as const,
    verification: [],
    decisions_needed: [{
      question,
      choices: [
        { id: "current", label: "Current", impact: "No migration" },
        { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
      ],
      recommendation: "current",
    }],
  };
  assert.equal(checkResultEnvelope(needsDecision).valid, true);
  assert.equal(checkResultEnvelope({ ...needsDecision, payload: {} }).valid, false);
});

test("project context and context command contracts reject unsafe paths and identities", () => {
  const valid = {
    project_shape: "CLI",
    memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
    navigation: [{ feature: "Readme", keywords: ["readme"], entry_paths: ["README.md"], module_boundary: "root" }],
    maintenance: { status: "current", paths: ["MEMORY.md"] },
  };
  assert.equal(checkProjectContext(valid).valid, true);
  for (const path of ["/etc/passwd", "../README.md", ".env/token", "src\\main.ts"]) {
    assert.equal(checkProjectContext({ ...valid, navigation: [{ ...valid.navigation[0], entry_paths: [path] }] }).valid, false, path);
  }
  assert.doesNotThrow(() => validateCommand("context.update", { project: "/tmp/project", contextFile: "/tmp/context.json" }));
  assert.throws(() => validateCommand("context.update", { project: "/tmp/project", contextFile: undefined }), /requires exactly one/);
  assert.doesNotThrow(() => validateCommand("context.validate", { project: "/tmp/project" }));
});

test("review findings without a concrete location or impact are rejected", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(`worktree_integration_${runId.slice(-8)}`, runId, `integration/review/${runId.slice(-8)}`, process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const testId = dispatches.create(runId, "test", {
      ...dispatchPacket(), context: { implementation_commit: REVIEW_HEAD, changed_paths: ["src/dispatch.ts"] },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, testId, "test", { checks: [{ command: "npm test", outcome: "passed" }] })), new Date().toISOString(), testId);
    const reviewPacket = dispatches.buildReviewPacket(runId);
    assert.ok(reviewPacket);
    dispatches.create(runId, "code-reviewer", reviewPacket);
    const reviews = new ReviewService(store);
    const barrier = reviews.create(runId, REVIEW_HEAD, false);
    const validFinding: ReviewResult["findings"][number] = {
      finding_id: "FIND-CODE-001",
      severity: "P1",
      title: "Concrete defect",
      source: "requirements",
      source_file: "docs/ai-team-v1.md",
      source_line: 264,
      evidence: "The accepted payload has no field validation.",
      impact: "Invalid results can advance a run.",
      recommendation: "Validate the role payload.",
    };
    for (const finding of [
      { ...validFinding, source_file: "" },
      { ...validFinding, source_line: 0 },
      { ...validFinding, impact: "" },
    ]) {
      assert.throws(
        () => reviews.submit(runId, barrier.barrier_id, {
          axis: "standards",
          summary: "reviewed",
          findings: [finding],
        }),
        /lacks source, location, impact, or recommendation/,
      );
    }
    const leaf = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { dispatch_id: string };
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify({ ...completedResult(runId, leaf.dispatch_id, "review-standards", { finding_ids: [validFinding.finding_id] }), summary: "reviewed", findings: [validFinding] }), new Date().toISOString(), leaf.dispatch_id);
    assert.equal(reviews.submit(runId, barrier.barrier_id, {
      axis: "standards",
      summary: "reviewed",
      findings: [validFinding],
    }).state, "blocked");
  });
});

test("SQLite foreign keys reject orphaned run and dispatch records", async () => {
  await withStore((store) => {
    assert.equal(store.db.pragma("foreign_keys", { simple: true }), 1);
    assert.throws(
      () => store.createRun({ repoId: "missing-repository", profile: "coding", mode: "feature" }),
      /FOREIGN KEY constraint failed/,
    );
    const runId = createRun(store);
    assert.throws(
      () => store.db.prepare(`INSERT INTO artifacts(
        artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        "artifact-orphan",
        runId,
        "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "result",
        "/tmp/result.json",
        "a".repeat(64),
        1,
        new Date().toISOString(),
      ),
      /FOREIGN KEY constraint failed/,
    );
  });
});

test("reconcileOperation persists completed and not-applied states while rejecting unknown", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const completed = store.beginOperation("git.worktree", `worktree:${runId}:completed`, {}, runId);
    store.reconcileOperation(completed.operationId, "completed", { fact: "owned worktree exists" });
    assert.deepEqual(
      store.db.prepare("SELECT state,evidence_json FROM operations WHERE operation_id=?").get(completed.operationId),
      {
        state: "completed",
        evidence_json: '{"evidence":{"fact":"owned worktree exists"},"reconciliation":"completed"}',
      },
    );

    const notApplied = store.beginOperation("git.worktree", `worktree:${runId}:absent`, {}, runId);
    store.reconcileOperation(notApplied.operationId, "not_applied", { fact: "owned worktree absent" });
    assert.deepEqual(
      store.db.prepare("SELECT state,evidence_json FROM operations WHERE operation_id=?").get(notApplied.operationId),
      {
        state: "failed",
        evidence_json: '{"evidence":{"fact":"owned worktree absent"},"reconciliation":"not_applied"}',
      },
    );

    const unresolved = store.beginOperation("git.commit", `commit:${runId}:unknown`, {}, runId);
    assert.throws(
      () => store.reconcileOperation(unresolved.operationId, "unknown", { fact: "manual evidence required" }),
      /unknown side effect cannot be marked reconciled/,
    );
    assert.equal(
      (store.db.prepare("SELECT state FROM operations WHERE operation_id=?").get(unresolved.operationId) as { state: string }).state,
      "pending",
    );
  });
});

test("planned research is archived with its revision while direct coding research stays in run artifacts", async () => {
  await withStore(async (store, home) => {
    const project = join(home, "project");
    const conclusion: ResearchConclusion = {
      kind: "fact",
      statement: "The documented API is available.",
      url: "https://example.com/api",
      accessed_at: "2026-08-13",
      applicable_version: "1.0.0",
      source_level: "official",
    };
    const research = new ResearchService(store);

    const unboundPlanning = createRun(store, "planning");
    await assert.rejects(
      research.archive(unboundPlanning, project, "API support", [conclusion]),
      /planned research requires the run to bind plan_id and revision/,
    );

    const planningRun = createRun(store, "planning", { planId: "20260813-api", revision: "001" });
    const planning = await research.archive(planningRun, project, "API support", [conclusion]);
    assert.equal(planning.path, join(
      project,
      ".ai-team",
      "plans",
      "20260813-api",
      "revisions",
      "001",
      "research",
      "api-support.md",
    ));
    assert.match(await readFile(planning.path, "utf8"), /Source level: official/);

    const codingRun = createRun(store, "coding", { planId: "20260813-api", revision: "001" });
    const coding = await research.archive(codingRun, project, "API support", [conclusion]);
    assert.equal(coding.path, join(project, ".ai-team", "plans", "20260813-api", "revisions", "001", "research", "api-support.md"));
    assert.equal(coding.path.startsWith(join(project, ".ai-team", "plans")), true);
    assert.match(await readFile(coding.path, "utf8"), /# Research: API support/);
  });
});

test("planning revision binding and Git Operator dispatch enforce run ownership", async () => {
  await withStore((store) => {
    const runId = createRun(store, "planning");
    assert.throws(
      () => store.bindPlanningRevision(runId, "another-repository", "20260814-plan", "001"),
      /does not belong/,
    );
    store.bindPlanningRevision(runId, "repo-review-fixture", "20260814-plan", "001");
    assert.equal(store.getRun(runId).plan_id, "20260814-plan");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-plan", "001", "repo-review-fixture", "plan_ready", "main", new Date().toISOString());
    const dispatches = new DispatchService(store);
    const packet = {
      objective: "Commit the immutable planning revision",
      allowed_read_paths: [".ai-team/plans/20260814-plan/revisions/001"],
      allowed_write_paths: [],
      acceptance_criteria: ["Only planning files are committed"],
      context: { plan_id: "20260814-plan", revision: "001" },
    };
    const unrelatedId = dispatches.createPlanningCommit(runId, packet);
    store.db.prepare("UPDATE dispatches SET packet_json=? WHERE dispatch_id=?").run(JSON.stringify({
      ...packet,
      context: { plan_id: "20260814-other", revision: "002" },
    }), unrelatedId);
    const dispatchId = dispatches.createPlanningCommit(runId, packet);
    assert.notEqual(dispatchId, unrelatedId);
    assert.equal(dispatches.createPlanningCommit(runId, packet), dispatchId);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count,
      2,
    );
    assert.throws(() => dispatches.assertClaimed(runId, dispatchId, "git-operator"), /must be claimed/);
    dispatches.claim(runId, dispatchId, "git-operator");
    assert.doesNotThrow(() => dispatches.assertClaimed(runId, dispatchId, "git-operator"));
  });
});

test("planning results advance one stage and create at most one matching decision", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const question = "Which compatibility target should the complete requirements use?";
    const resultPath = join(home, "planning-stage.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No migration" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
      },
    })));
    await dispatches.submit(runId, planningId, "planning", resultPath);
    assert.equal(store.getRun(runId).stage, "requirements");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { count: number }).count, 1);
    const firstDecision = store.db.prepare("SELECT decision_id,question,decision_type FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; question: string; decision_type: string };
    assert.equal(firstDecision.question, `问题 1、${question}`);
    assert.equal(firstDecision.decision_type, "requirement");
    const secondPlanningId = dispatches.resolveDecision(runId, firstDecision.decision_id, "current");
    dispatches.claim(runId, secondPlanningId, "planning");
    const secondQuestion = "Which supported runtime is required?";
    await dispatches.submitValue(runId, secondPlanningId, "planning", completedResult(runId, secondPlanningId, "planning", {
      actions: ["clarify runtime"],
      stage: "requirements",
      pending_questions: [secondQuestion],
      decision: {
        question: secondQuestion,
        choices: [
          { id: "current", label: "Current", impact: "No compatibility work" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
      },
    }));
    assert.equal((store.db.prepare("SELECT question FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { question: string }).question, `问题 2、${secondQuestion}`);

    const taskRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='plan_ready' WHERE run_id=?").run(taskRun);
    const taskPlanningId = dispatches.create(taskRun, "planning", dispatchPacket(), "planning");
    dispatches.claim(taskRun, taskPlanningId, "planning");
    const taskQuestion = "Should implementation be split into tasks?";
    await dispatches.submitValue(taskRun, taskPlanningId, "planning", completedResult(taskRun, taskPlanningId, "planning", {
      actions: ["confirm task split"],
      stage: "tasks_preview",
      pending_questions: [taskQuestion],
      decision: {
        question: taskQuestion,
        choices: [
          { id: "approve", label: "Approve", impact: "Creates the previewed task documents" },
          { id: "revise", label: "Revise", impact: "Requires another task preview" },
        ],
        recommendation: "approve",
      },
    }));
    const taskDecision = store.db.prepare("SELECT question,decision_type FROM decisions WHERE run_id=?").get(taskRun) as { question: string; decision_type: string };
    assert.equal(taskDecision.question, taskQuestion);
    assert.equal(taskDecision.decision_type, "task_preview");

    const invalidRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(invalidRun);
    const invalidId = dispatches.create(invalidRun, "planning", dispatchPacket(), "planning");
    dispatches.claim(invalidRun, invalidId, "planning");
    const invalidPath = join(home, "planning-skip.json");
    await writeFile(invalidPath, JSON.stringify(completedResult(invalidRun, invalidId, "planning", {
      actions: ["skip confirmation"], stage: "ready", pending_questions: [], decision: null,
    })));
    await assert.rejects(dispatches.submit(invalidRun, invalidId, "planning", invalidPath), /invalid planning stage transition/);
    assert.equal(
      (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(invalidId) as { state: string }).state,
      "claimed",
    );
    assert.equal(store.getRun(invalidRun).stage, "planning");
  });
});

test("planning question results normalize completed and needs_decision into one atomic lifecycle", async () => {
  await withStore(async (store, home) => {
    for (const status of ["completed", "needs_decision"] as const) {
      const runId = createRun(store, "planning");
      store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
      const dispatches = new DispatchService(store);
      const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
      dispatches.claim(runId, planningId, "planning");
      const question = `Which compatibility target should ${status} use?`;
      const resultPath = join(home, `${status}-question.json`);
      await writeFile(resultPath, JSON.stringify({
        ...completedResult(runId, planningId, "planning", {
          actions: ["clarify compatibility"],
          stage: "requirements",
          pending_questions: [question],
          decision: {
            question,
            choices: [
              { id: "current", label: "Current", impact: "No migration" },
              { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
            ],
            recommendation: "current",
          },
        }),
        status,
        decisions_needed: status === "needs_decision" ? [{
          question,
          choices: [
            { id: "current", label: "Current", impact: "No migration" },
            { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
          ],
          recommendation: "current",
        }] : [],
      }));

      const first = await dispatches.submit(runId, planningId, "planning", resultPath);
      assert.equal(first.reused, false);
      assert.deepEqual(
        store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId),
        { state: "needs_decision", stage: "requirements" },
      );
      assert.equal(
        (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(planningId) as { state: string }).state,
        "needs_decision",
      );
      assert.equal(
        (store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { count: number }).count,
        1,
      );
      assert.equal((await dispatches.submit(runId, planningId, "planning", resultPath)).reused, true);
      assert.equal(
        (store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count,
        1,
      );
    }
  });
});

test("resolving a planning decision restores the run and creates exactly one continuation", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const question = "Which compatibility target should be selected?";
    const resultPath = join(home, "decision-question.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No migration" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
      },
    })));
    await dispatches.submit(runId, planningId, "planning", resultPath);
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };

    const continuationId = dispatches.resolvePlanningDecision(runId, decision.decision_id, "current", "Keep scope small");
    assert.equal(store.getRun(runId).state, "active");
    assert.match(continuationId, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning' AND state='pending'").get(runId) as { count: number }).count,
      1,
    );
  });
});

test("planning stages without questions continue automatically exactly once", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const resultPath = join(home, "requirements-confirmed.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["confirm requirements"],
      stage: "requirements_confirmed",
      pending_questions: [],
      decision: null,
    })));

    const first = await dispatches.submit(runId, planningId, "planning", resultPath);
    assert.equal(first.reused, false);
    assert.deepEqual(
      store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId),
      { state: "active", stage: "requirements_confirmed" },
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning' AND state='pending'").get(runId) as { count: number }).count,
      1,
    );
    assert.equal((await dispatches.submit(runId, planningId, "planning", resultPath)).reused, true);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning'").get(runId) as { count: number }).count,
      2,
    );
  });
});

test("run resume recovers planning idempotently without crossing decisions or operations", async () => {
  await withStore((store) => {
    const recoverRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='requirements' WHERE run_id=?").run(recoverRun);
    const choices = [
      { id: "current", label: "Current", impact: "No migration" },
      { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
    ];
    const resolvedId = store.createDecision(recoverRun, "Which target?", choices, "current");
    store.decide(recoverRun, resolvedId, "current");
    const dispatches = new DispatchService(store);
    const first = dispatches.resume(recoverRun);
    const second = dispatches.resume(recoverRun);
    assert.equal((first.run as { state: string }).state, "active");
    assert.equal((second.run as { state: string }).state, "active");
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);

    const decisionRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='requirements' WHERE run_id=?").run(decisionRun);
    store.createDecision(decisionRun, "Which target?", choices, "current");
    const decisionBlocked = dispatches.resume(decisionRun);
    assert.equal(decisionBlocked.pending_decision?.status, "pending");
    assert.equal(decisionBlocked.pending_dispatches.length, 0);
    assert.equal(store.getRun(decisionRun).state, "needs_decision");

    const operationRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(operationRun);
    store.beginOperation("git.commit", `commit:${operationRun}`, {}, operationRun);
    const operationBlocked = dispatches.resume(operationRun);
    assert.equal(operationBlocked.pending_operations.length, 1);
    assert.equal(operationBlocked.pending_dispatches.length, 0);

    const explorerRun = createRun(store, "planning");
    const explorerBlocked = dispatches.resume(explorerRun);
    assert.equal((explorerBlocked.run as { stage: string }).stage, "file-explorer");
    assert.equal(explorerBlocked.pending_dispatches.length, 0);

    const failedRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='failed',stage='requirements' WHERE run_id=?").run(failedRun);
    const failedBefore = store.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE run_id=?").get(failedRun);
    const failedResult = dispatches.resume(failedRun);
    assert.equal((failedResult.run as { state: string }).state, "failed");
    assert.deepEqual(store.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE run_id=?").get(failedRun), failedBefore);
    assert.equal(failedResult.pending_dispatches.length, 0);
  });
});

test("run resume creates one claimed coding continuation before Git commit dispatch", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const coordinatorPacket = {
      ...dispatchPacket(["src/dispatch.ts", "test/review-fixes.test.ts"]),
      context: { explorer_dispatch_id: explorerId },
    };
    const codingId = dispatches.create(runId, "coding", coordinatorPacket);
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_resume_commit", runId, "task/resume/implementation", `/tmp/${runId}-resume`, REVIEW_HEAD, new Date().toISOString());
    const developerId = dispatches.create(runId, "backend-developer", {
      ...coordinatorPacket,
      allowed_write_paths: ["src/dispatch.ts"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_resume_commit" },
    }, "coding", codingId);
    dispatches.claim(runId, developerId, "backend-developer");
    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["dispatch implementation"] }));
    await dispatches.submitValue(runId, developerId, "backend-developer", completedResult(runId, developerId, "backend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    for (const stage of ["triage", "pre_write", "pre_commit"] as const) {
      store.event(runId, `scope.${stage}`, { stage, digest: "stable-scope", paths: ["src/dispatch.ts"] });
    }

    assert.throws(() => dispatches.create(runId, "git-operator", dispatchPacket(), "coding", codingId), /coding dispatch must be claimed/);
    const first = dispatches.resume(runId);
    const second = dispatches.resume(runId);
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    const continuationId = first.pending_dispatches[0]!.dispatch_id;
    const continuation = store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(continuationId) as { replacement_for: string; packet_json: string };
    assert.equal(continuation.replacement_for, codingId);
    assert.equal(JSON.parse(continuation.packet_json).context.phase, "continue_commit");

    dispatches.claim(runId, continuationId, "coding");
    const gitId = dispatches.create(runId, "git-operator", {
      objective: "Commit the resumed task worktree",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit the authorized task changes"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_resume_commit", phase: "commit_implementation" },
    }, "coding", continuationId);
    assert.match(gitId, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

test("run resume repairs a stale planning retryable failure without crossing blockers or profiles", async () => {
  await withStore(async (store, home) => {
    const dispatches = new DispatchService(store);
    const makeRetryable = async (profile: "planning" | "coding", sideEffectState: "none" | "completed" | "unknown" = "none") => {
      const runId = createRun(store, profile);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, explorerId, "file-explorer");
      const resultPath = join(home, `${runId}-retryable.json`);
      await writeFile(resultPath, JSON.stringify({
        ...fileExplorerResult(runId, explorerId),
        status: "retryable_failure",
        verification: [],
        payload: {},
        failure_class: "temporary_tool_failure",
        side_effect_state: sideEffectState,
      }));
      await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      return { runId, explorerId };
    };

    const recoverable = await makeRetryable("planning");
    const first = dispatches.resume(recoverable.runId);
    const second = dispatches.resume(recoverable.runId);
    assert.equal((first.run as { state: string }).state, "active");
    assert.equal((second.run as { state: string }).state, "active");
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    assert.equal(first.pending_dispatches[0]?.role, "file-explorer");
    assert.equal(
      (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(recoverable.explorerId) as { state: string }).state,
      "completed",
    );

    const decisionBlocked = await makeRetryable("planning");
    store.createDecision(decisionBlocked.runId, "Which target?", [
      { id: "current", label: "Current", impact: "No migration" },
      { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
    ], "current");
    const decisionResult = dispatches.resume(decisionBlocked.runId);
    assert.equal((decisionResult.run as { state: string }).state, "needs_decision");
    assert.equal(decisionResult.pending_dispatches.length, 0);
    assert.equal(
      (store.db.prepare("SELECT dispatch_id FROM decisions WHERE run_id=? AND status='pending'").get(decisionBlocked.runId) as { dispatch_id: string }).dispatch_id,
      decisionBlocked.explorerId,
    );

    const operationBlocked = await makeRetryable("planning");
    store.beginOperation("git.commit", `commit:${operationBlocked.runId}`, {}, operationBlocked.runId);
    const operationResult = dispatches.resume(operationBlocked.runId);
    assert.equal((operationResult.run as { state: string }).state, "retryable_failure");
    assert.equal(operationResult.pending_dispatches.length, 0);

    const coding = await makeRetryable("coding");
    const codingResult = dispatches.resume(coding.runId);
    assert.equal((codingResult.run as { state: string }).state, "active");
    assert.equal(codingResult.pending_dispatches.length, 1);
    assert.equal(codingResult.pending_dispatches[0]?.role, "file-explorer");

    for (const sideEffectState of ["completed", "unknown"] as const) {
      const blocked = await makeRetryable("planning", sideEffectState);
      const blockedResult = dispatches.resume(blocked.runId);
      assert.equal((blockedResult.run as { state: string }).state, "retryable_failure");
      assert.equal(blockedResult.pending_dispatches.length, 0);
      assert.equal(
        (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(blocked.explorerId) as { state: string }).state,
        "retryable_failure",
      );
    }

    for (const [name, resultJson] of [["missing", null], ["corrupt", "not-json"]] as const) {
      const blocked = await makeRetryable("planning");
      store.db.prepare("UPDATE dispatches SET result_json=? WHERE dispatch_id=?").run(resultJson, blocked.explorerId);
      const blockedResult = dispatches.resume(blocked.runId);
      assert.equal((blockedResult.run as { state: string }).state, "retryable_failure", name);
      assert.equal(blockedResult.pending_dispatches.length, 0, name);
    }
  });
});

test("confirmed retryable side effects reconcile through an idempotent replacement lineage", async () => {
  await withStore(async (store) => {
    const dispatches = new DispatchService(store);
    const makeRetryable = async (sideEffectState: "completed" | "unknown") => {
      const runId = createRun(store, "planning");
      const dispatchId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, dispatchId, "file-explorer");
      await dispatches.submitValue(runId, dispatchId, "file-explorer", {
        ...fileExplorerResult(runId, dispatchId),
        status: "retryable_failure",
        verification: [{ command: "git status", outcome: "side effect completed before timeout" }],
        payload: {},
        failure_class: "client_disconnect",
        side_effect_state: sideEffectState,
      });
      return { runId, dispatchId };
    };

    const confirmed = await makeRetryable("completed");
    const resumed = dispatches.resume(confirmed.runId);
    assert.deepEqual(resumed.recovery, {
      state: "action_required",
      dispatch_id: confirmed.dispatchId,
      side_effect_state: "completed",
      next_command: `ai-team dispatch reconcile --run-id ${confirmed.runId} --dispatch-id ${confirmed.dispatchId} --role file-explorer --actor-role planning --reason "reconcile confirmed completed side effect"`,
    });

    const reconciled = dispatches.reconcile(confirmed.runId, confirmed.dispatchId, "file-explorer", "planning", "confirmed side effect is durable");
    assert.deepEqual(reconciled, {
      action: "reconciled",
      dispatch_id: reconciled.dispatch_id,
      replacement_for: confirmed.dispatchId,
      reused: false,
    });
    assert.deepEqual(dispatches.reconcile(confirmed.runId, confirmed.dispatchId, "file-explorer", "planning", "confirmed side effect is durable"), { ...reconciled, reused: true });
    assert.equal(store.getRun(confirmed.runId).state, "active");
    assert.deepEqual(
      store.db.prepare("SELECT state,replacement_for FROM dispatches WHERE dispatch_id=?").get(reconciled.dispatch_id),
      { state: "pending", replacement_for: confirmed.dispatchId },
    );
    const recoveryPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(reconciled.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(recoveryPacket.context.recovery.replacement_for, confirmed.dispatchId);
    assert.deepEqual(recoveryPacket.context.recovery.completed_verification, [{ command: "git status", outcome: "side effect completed before timeout" }]);

    const unknown = await makeRetryable("unknown");
    assert.equal(dispatches.resume(unknown.runId).recovery?.next_command, null);
    assert.throws(
      () => dispatches.reconcile(unknown.runId, unknown.dispatchId, "file-explorer", "planning", "cannot confirm side effect"),
      /requires confirmed completed side effects/,
    );
    const reissued = dispatches.reissue(unknown.runId, unknown.dispatchId, "file-explorer", "planning", "replace after external investigation");
    assert.equal(reissued.replacement_for, unknown.dispatchId);
    assert.equal(store.getRun(unknown.runId).state, "active");

    const supersededSource = await makeRetryable("completed");
    const superseded = dispatches.supersede(
      supersededSource.runId,
      supersededSource.dispatchId,
      "file-explorer",
      "planning",
      "replace with corrected scope",
      dispatchPacket(["src/planning.ts"]),
    );
    assert.equal(superseded.replacement_for, supersededSource.dispatchId);
    assert.equal(store.getRun(supersededSource.runId).state, "active");
  });
});

test("retryable frontend recovery preserves the claimed coordinator and creates a linked replacement", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    store.db.prepare("INSERT INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
      .run("artifact_recovery_explorer", runId, explorerId, "/tmp/explorer-result.json", "a".repeat(64), new Date().toISOString());
    const codingId = dispatches.create(runId, "coding", dispatchPacket(["src/dispatch.ts"]));
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_recovered_owner", runId, "task/recovered/implementation", "/tmp/recovered-owner", REVIEW_HEAD, new Date().toISOString());
    const adoption = store.beginOperation("git.worktree.adopt", `adopt:${runId}`, {}, runId);
    store.finishOperation(adoption.operationId, { implementation_revision: REVIEW_HEAD, worktree_id: "worktree_recovered_owner" });
    const frontendId = dispatches.create(runId, "frontend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]),
      acceptance_criteria: ["Operate only in /tmp/old-owner on branch task/old/implementation."],
      context: {
        explorer_dispatch_id: explorerId,
        revision: "001",
        implementation_commit: REVIEW_HEAD,
        worktree_id: "worktree_old_owner",
        implementation_worktree_path: "/tmp/old-owner",
        implementation_branch: "task/old/implementation",
      },
    });
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", {
      ...createResultTemplate(runId, frontendId, "frontend-developer"),
      status: "retryable_failure",
      summary: "Context renderer is stale",
      verification: [{ command: "unit tests", outcome: "passed before context validation" }],
      payload: {},
      failure_class: "context_migration_required",
      side_effect_state: "none",
    });

    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.ok(resumed.pending_dispatches.some((item) => item.dispatch_id === codingId && item.state === "claimed"));
    const replacement = store.db.prepare("SELECT dispatch_id,replacement_for,packet_json FROM dispatches WHERE replacement_for=?").get(frontendId) as { dispatch_id: string; replacement_for: string; packet_json: string };
    assert.equal(replacement.replacement_for, frontendId);
    const packet = JSON.parse(replacement.packet_json);
    assert.equal(packet.context.revision, "001");
    assert.equal(packet.context.implementation_commit, REVIEW_HEAD);
    assert.equal(packet.context.implementation_revision, REVIEW_HEAD);
    assert.equal(packet.context.worktree_id, "worktree_recovered_owner");
    assert.deepEqual(packet.acceptance_criteria, ["Operate only in /tmp/recovered-owner on branch task/recovered/implementation."]);
    assert.equal(packet.context.explorer_dispatch_id, explorerId);
    assert.equal(packet.context.recovery.replacement_for, frontendId);
    assert.deepEqual(packet.context.recovery.completed_verification, [{ command: "unit tests", outcome: "passed before context validation" }]);

    dispatches.claim(runId, replacement.dispatch_id, "frontend-developer");
    await dispatches.submitValue(runId, replacement.dispatch_id, "frontend-developer", {
      ...createResultTemplate(runId, replacement.dispatch_id, "frontend-developer"),
      status: "retryable_failure",
      summary: "Frozen text still referenced the root worktree",
      verification: [],
      payload: {},
      failure_class: "stale_recovery_packet",
      side_effect_state: "none",
    });
    dispatches.resume(runId);
    const second = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE replacement_for=?").get(replacement.dispatch_id) as { dispatch_id: string; packet_json: string };
    const secondPacket = JSON.parse(second.packet_json);
    assert.deepEqual(secondPacket.acceptance_criteria, ["Operate only in /tmp/recovered-owner on branch task/recovered/implementation."]);
    assert.deepEqual(secondPacket.context.recovery.completed_verification, [{ command: "unit tests", outcome: "passed before context validation" }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_recovered_integration", runId, "integration/recovered", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const commit = store.beginOperation("git.commit", `commit:${runId}:recovered`, {}, runId);
    store.finishOperation(commit.operationId, { commit: REVIEW_HEAD, paths: ["src/dispatch.ts"], worktree_id: "worktree_recovered_owner" });
    dispatches.claim(runId, second.dispatch_id, "frontend-developer");
    await dispatches.submitValue(runId, second.dispatch_id, "frontend-developer", completedResult(runId, second.dispatch_id, "frontend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["resume replacement"] }));
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='integrate_implementation'").get(runId) as { count: number }).count,
      1,
    );
  });
});

test("retryable recovery decision is dispatch-bound and regenerate-context activates one replacement", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const frontendId = dispatches.create(runId, "frontend-developer", dispatchPacket(["src/context.ts"]));
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", {
      ...createResultTemplate(runId, frontendId, "frontend-developer"),
      status: "retryable_failure",
      summary: "Choose context recovery",
      verification: [],
      decisions_needed: [{
        question: "How should context recover?",
        choices: [
          { id: "regenerate-context", label: "Regenerate", impact: "Migrate managed context" },
          { id: "stop", label: "Stop", impact: "Leave the run blocked" },
        ],
        recommendation: "regenerate-context",
        type: "workflow_recovery",
      }],
      payload: {},
      failure_class: "context_migration_required",
      side_effect_state: "completed",
    });
    const decision = store.db.prepare("SELECT decision_id,dispatch_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; dispatch_id: string };
    assert.equal(decision.dispatch_id, frontendId);
    assert.equal(store.getRun(runId).state, "needs_decision");
    const replacementId = dispatches.resolveDecision(runId, decision.decision_id, "regenerate-context");
    assert.equal(store.getRun(runId).state, "active");
    assert.deepEqual(
      store.db.prepare("SELECT state,replacement_for FROM dispatches WHERE dispatch_id=?").get(replacementId),
      { state: "pending", replacement_for: frontendId },
    );
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE replacement_for=?").get(frontendId) as { count: number }).count, 1);
  });
});

test("validateCommand rejects malformed, unknown, and non-exclusive inputs", () => {
  const runId = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  assert.doesNotThrow(() => validateCommand("dispatch.identity", { runId, dispatchId, role: "test" }));
  assert.throws(() => validateCommand("dispatch.identity", {
    runId: "run-invalid",
    dispatchId,
    role: "test",
  }), /runId has invalid format/);
  assert.throws(() => validateCommand("review.create", {
    runId,
    revisionSha: "not-a-commit",
  }), /revisionSha has invalid format/);
  assert.throws(() => validateCommand("missing.command", {}), /unknown command contract/);
  assert.throws(() => validateCommand("run.identity", { runId, extra: true }), /unknown parameters/);
  assert.throws(() => validateCommand("planning.start", { project: "/tmp/project" }), /requires exactly one/);
  assert.throws(() => validateCommand("planning.start", {
    project: "/tmp/project",
    requestFile: "request.md",
    requestStdin: true,
  }), /requires exactly one/);
  assert.doesNotThrow(() => validateCommand("planning.start", {
    project: "/tmp/project",
    requestFile: "request.md",
  }));
});

test("coding decisions are created from results and resolution atomically resumes the blocked dispatch", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const reviewerId = dispatches.create(runId, "code-reviewer", dispatchPacket());
    dispatches.claim(runId, reviewerId, "code-reviewer");
    const decision = {
      question: "Which review baseline should be used?",
      choices: [
        { id: "implementation", label: "Implementation commit", impact: "Review the submitted task commit" },
        { id: "integration", label: "Integration HEAD", impact: "Prepare integration before review" },
      ],
      recommendation: "implementation",
      type: "review_baseline",
    };
    await dispatches.submitValue(runId, reviewerId, "code-reviewer", {
      ...createResultTemplate(runId, reviewerId, "code-reviewer"),
      status: "needs_decision",
      summary: "Review baseline is ambiguous",
      verification: [],
      decisions_needed: [decision],
      payload: {},
    });

    const pending = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    assert.equal(store.getRun(runId).state, "needs_decision");
    const continuationId = dispatches.resolveDecision(runId, pending.decision_id, "implementation");
    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.equal(resumed.pending_decision, null);
    assert.deepEqual(resumed.pending_dispatches, [{ dispatch_id: continuationId, role: "code-reviewer", state: "pending" }]);
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(reviewerId) as { state: string }).state, "completed");
  });
});

test("reissue rebuilds the review packet once and returns the same successor on retry", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_reissue_integration", runId, "integration/reissue", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const testId = dispatches.create(runId, "test", {
      ...dispatchPacket(), context: { implementation_commit: REVIEW_HEAD, changed_paths: ["src/dispatch.ts"] },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, testId, "test", { checks: [{ command: "npm test", outcome: "passed" }] })), new Date().toISOString(), testId);
    const frozen = dispatches.buildReviewPacket(runId);
    assert.ok(frozen);
    const reviewerId = dispatches.create(runId, "code-reviewer", frozen);
    dispatches.claim(runId, reviewerId, "code-reviewer");
    await dispatches.submitValue(runId, reviewerId, "code-reviewer", {
      ...createResultTemplate(runId, reviewerId, "code-reviewer"),
      status: "needs_decision",
      summary: "Review packet must be reissued",
      verification: [],
      decisions_needed: [{
        question: "How should the frozen review continue?",
        choices: [
          { id: "reissue", label: "Reissue", impact: "Rebuild from current frozen evidence" },
          { id: "abort", label: "Abort", impact: "Stop the review" },
        ],
        recommendation: "reissue",
        type: "review_reissue",
      }],
      payload: {},
    });
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    const oldDigest = (store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(reviewerId) as { packet_digest: string }).packet_digest;

    const successor = dispatches.resolveDecision(runId, decision.decision_id, "reissue");
    assert.equal(dispatches.resolveDecision(runId, decision.decision_id, "reissue"), successor);
    const newRow = store.db.prepare("SELECT packet_json,packet_digest FROM dispatches WHERE dispatch_id=?").get(successor) as { packet_json: string; packet_digest: string };
    const packet = JSON.parse(newRow.packet_json);
    assert.notEqual(newRow.packet_digest, oldDigest);
    assert.equal(packet.context.revision_sha, REVIEW_HEAD);
    assert.equal(packet.context.reissue.decision_id, decision.decision_id);
    assert.equal(packet.context.resolved_decision.choice, "reissue");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state='pending'").get(runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM review_barriers WHERE run_id=?").get(runId) as { count: number }).count, 0);
  });
});

test("implementation dependencies and commit gate test creation and freeze the complete review packet", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const codingId = dispatches.create(runId, "coding", dispatchPacket());
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_regression", runId, "task/regression", `${process.cwd()}/.worktrees/defect-regression`, REVIEW_HEAD, new Date().toISOString());
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_integration", runId, "integration/regression", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const changedPaths = ["src/dispatch.ts", "src/state.ts", "src/contracts.ts", "src/cli.ts", "src/review.ts", "test/review-fixes.test.ts"];
    const developerId = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(changedPaths), context: { worktree_id: "worktree_defect_regression" },
    }, "coding", codingId);
    const frontendId = dispatches.create(runId, "frontend-developer", {
      ...dispatchPacket(changedPaths), context: { worktree_id: "worktree_defect_regression" },
    }, "coding", codingId);
    const gitId = dispatches.create(runId, "git-operator", dispatchPacket(changedPaths), "coding", codingId);

    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["dispatch implementation"] }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    dispatches.claim(runId, developerId, "backend-developer");
    await dispatches.submitValue(runId, developerId, "backend-developer", completedResult(runId, developerId, "backend-developer", {
      modified_paths: changedPaths, self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", completedResult(runId, frontendId, "frontend-developer", {
      modified_paths: changedPaths, self_tests: [{ command: "npm test", outcome: "passed" }],
    }));

    const commit = store.beginOperation("git.commit", `commit:${runId}:regression`, { paths: changedPaths }, runId);
    store.finishOperation(commit.operationId, { commit: REVIEW_HEAD, paths: changedPaths, worktree_id: "worktree_defect_regression" });
    dispatches.claim(runId, gitId, "git-operator");
    await dispatches.submitValue(runId, gitId, "git-operator", completedResult(runId, gitId, "git-operator", {
      operations: [{ command: "git commit", outcome: REVIEW_HEAD }],
    }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    const integrationDispatch = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='integrate_implementation'").get(runId) as { dispatch_id: string };
    const merge = store.beginOperation("git.merge.task", `merge:${runId}:regression`, {}, runId);
    store.finishOperation(merge.operationId, {
      commit: REVIEW_HEAD,
      task_worktree_id: "worktree_defect_regression",
      integration_worktree_id: "worktree_defect_integration",
    });
    dispatches.claim(runId, integrationDispatch.dispatch_id, "git-operator");
    await dispatches.submitValue(runId, integrationDispatch.dispatch_id, "git-operator", completedResult(runId, integrationDispatch.dispatch_id, "git-operator", {
      operations: [{ command: "git merge", outcome: REVIEW_HEAD }],
    }));
    const testRow = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { dispatch_id: string; packet_json: string };
    assert.equal(JSON.parse(testRow.packet_json).context.implementation_commit, REVIEW_HEAD);

    dispatches.claim(runId, testRow.dispatch_id, "test");
    await dispatches.submitValue(runId, testRow.dispatch_id, "test", completedResult(runId, testRow.dispatch_id, "test", {
      checks: [{ command: "npm test", outcome: "passed" }],
    }));
    const storedTest = JSON.parse((store.db.prepare("SELECT result_json FROM dispatches WHERE dispatch_id=?").get(testRow.dispatch_id) as { result_json: string }).result_json);
    assert.equal(storedTest.payload.testedCommit, REVIEW_HEAD);
    const review = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='code-reviewer'").get(runId) as { packet_json: string };
    const packet = JSON.parse(review.packet_json);
    const committedPaths = execFileSync("git", ["diff", "--name-only", `${REVIEW_HEAD}^`, REVIEW_HEAD], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.equal(packet.context.implementation_commit, REVIEW_HEAD);
    assert.equal(packet.context.revision_sha, REVIEW_HEAD);
    assert.match(packet.context.base_commit, /^[a-f0-9]{40}$/);
    assert.match(packet.context.document_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(packet.context.changed_paths, committedPaths);
    assert.equal(packet.context.changed_paths.includes("package.json"), committedPaths.includes("package.json"));
    assert.match(packet.context.diff_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.test_evidence_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.revision_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.evidence_digest, /^[a-f0-9]{64}$/);
    assert.equal(packet.context.testedCommit, REVIEW_HEAD);
    assert.deepEqual(new Set(packet.context.artifacts.map((artifact: { role: string }) => artifact.role)), new Set(["coding", "frontend-developer", "backend-developer", "git-operator", "test"]));
    assert.ok(packet.context.artifacts.every((artifact: { artifact_id: string; sha256: string }) => /^artifact_/.test(artifact.artifact_id) && /^[a-f0-9]{64}$/.test(artifact.sha256)));
    assert.ok(committedPaths.every((path) => packet.allowed_read_paths.includes(path)));
  });
});

test("decision validation reports missing fields by JSON path", () => {
  const checked = checkDecisionInput({});
  assert.equal(checked.valid, false);
  if (!checked.valid) assert.deepEqual(checked.errors.map((error) => error.path).sort(), ["/choices", "/question"]);
});
