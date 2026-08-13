import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCommand } from "../src/command-contract.js";
import { checkResultEnvelope, createResultTemplate, resultSchemaForRole, ROLE_PAYLOAD_SCHEMAS } from "../src/contracts.js";
import { DispatchService, type DispatchPacket } from "../src/dispatch.js";
import { ResearchService } from "../src/research-service.js";
import type { ResearchConclusion } from "../src/research.js";
import { ReviewService, type ReviewResult } from "../src/review.js";
import { StateStore } from "../src/state.js";

const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "ai-team-review-fixes-"));

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
  const repoId = `repo-${profile}-${Math.random()}`;
  store.registerRepository(repoId, `/tmp/${repoId}/.git`, `/tmp/${repoId}`);
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

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["src/dispatch.ts", "test/review-fixes.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
});

test("an exact File Explorer result creates one planning or coding dispatch and duplicate submit reuses it", async () => {
  await withStore(async (store, home) => {
    for (const [profile, nextRole] of [["planning", "planning"], ["coding", "coding"]] as const) {
      const runId = createRun(store, profile);
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, explorerId, "file-explorer");
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
        "src/dispatch.ts",
        "test/review-fixes.test.ts",
      ]);

      const duplicate = await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      assert.deepEqual(duplicate, { reused: true, artifact: first.artifact });
      const count = store.db.prepare(
        "SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role=?",
      ).get(runId, nextRole) as { count: number };
      assert.equal(count.count, 1);
    }
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
    assert.doesNotThrow(() => dispatches.create(runId, "backend-developer", dispatchPacket(), "coding"));
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
    planning: { actions: ["confirm requirements"] },
    coding: { actions: ["dispatch backend task"] },
    "file-explorer": { allowed_read_paths: ["src/a.ts"], entry_points: ["src/a.ts"], test_commands: ["npm test"] },
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
  assert.equal(checkResultEnvelope(codingWithPlanningPayload).valid, true);
  assert.equal(
    checkResultEnvelope({ ...codingWithPlanningPayload, payload: payloads["file-explorer"] }).valid,
    false,
  );
});

test("review findings without a concrete location or impact are rejected", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const reviews = new ReviewService(store);
    const barrier = reviews.create(runId, "a".repeat(40), false);
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

test("planning research is archived with its revision while coding research stays in run artifacts", async () => {
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
      /planning research requires the run to bind plan_id and revision/,
    );

    const planningRun = createRun(store, "planning", { planId: "20260813-api-abcd", revision: "001" });
    const planning = await research.archive(planningRun, project, "API support", [conclusion]);
    assert.equal(planning.path, join(
      project,
      ".ai-team",
      "plans",
      "20260813-api-abcd",
      "revisions",
      "001",
      "research",
      "api-support.md",
    ));
    assert.match(await readFile(planning.path, "utf8"), /Source level: official/);

    const codingRun = createRun(store, "coding", { planId: "20260813-api-abcd", revision: "001" });
    const coding = await research.archive(codingRun, project, "API support", [conclusion]);
    assert.equal(coding.path, join(store.paths.artifacts, codingRun, "research", "api-support.md"));
    assert.equal(coding.path.startsWith(join(project, ".ai-team", "plans")), false);
    assert.match(await readFile(coding.path, "utf8"), /# Research: API support/);
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
