import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { validateCommand } from "../../src/command-contract.js";
import { checkDecisionInput, checkProjectContext, checkResultEnvelope, createResultTemplate, resultSchemaForRole, ROLE_PAYLOAD_SCHEMAS } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { completedResult, createRun, dispatchPacket, projectContext, withStore } from "../helpers/dispatch.js";

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/dispatch/contracts.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
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
    assert.doesNotThrow(() => dispatches.create(runId, "coding", dispatchPacket([])));
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

test("planning needs_decision distinguishes task preview confirmation from functional clarification", () => {
  const runId = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const taskPreviewQuestion = "Approve the task preview?";
  const taskPreviewDecision = {
    question: taskPreviewQuestion,
    choices: [
      { id: "approve", label: "Approve", impact: "Accept the proposed tasks" },
      { id: "revise", label: "Revise", impact: "Request changes to the proposed tasks" },
    ],
    recommendation: "approve",
  };
  const taskPreview = {
    ...completedResult(runId, dispatchId, "planning", {
      actions: ["preview tasks"],
      stage: "tasks_preview",
      pending_questions: [],
      decision: taskPreviewDecision,
    }),
    status: "needs_decision" as const,
    verification: [],
    decisions_needed: [taskPreviewDecision],
  };
  assert.equal(checkResultEnvelope(taskPreview).valid, true);

  const functionalQuestion = "Which compatibility target?";
  const functionalDecision = {
    question: functionalQuestion,
    choices: [
      { id: "current", label: "Current", impact: "No migration" },
      { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
    ],
    recommendation: "current",
  };
  const functionalClarification = {
    ...completedResult(runId, dispatchId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [],
      decision: functionalDecision,
    }),
    status: "needs_decision" as const,
    verification: [],
    decisions_needed: [functionalDecision],
  };
  const functionalWithoutQuestion = checkResultEnvelope(functionalClarification);
  assert.equal(functionalWithoutQuestion.valid, false);
  if (!functionalWithoutQuestion.valid) {
    assert.equal(functionalWithoutQuestion.errors[0]?.path, "/payload/pending_questions");
    assert.equal(functionalWithoutQuestion.errors[0]?.constraint, "minItems");
  }
  assert.equal(checkResultEnvelope({
    ...functionalClarification,
    payload: {
      ...functionalClarification.payload,
      pending_questions: [functionalQuestion],
    },
  }).valid, true);
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

test("decision validation reports missing fields by JSON path", () => {
  const checked = checkDecisionInput({});
  assert.equal(checked.valid, false);
  if (!checked.valid) assert.deepEqual(checked.errors.map((error) => error.path).sort(), ["/choices", "/question"]);
});
