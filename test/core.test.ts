import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkResultEnvelope, createResultTemplate } from "../src/contracts.js";
import { DispatchService, type DispatchPacket } from "../src/dispatch.js";
import { ValidationError } from "../src/errors.js";
import { assertCoverage, extractRequirementIds, nextPlanState, triage, validateCoverage } from "../src/planning.js";
import { StateStore } from "../src/state.js";

const RUN_ID = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DISPATCH_ID = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const temporaryHome = async (): Promise<string> => mkdtemp(join(tmpdir(), "ai-team-core-"));

const withStore = async (callback: (store: StateStore, home: string) => Promise<void> | void): Promise<void> => {
  const home = await temporaryHome();
  const store = await StateStore.open(home);
  try {
    await callback(store, home);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
};

const createRun = (store: StateStore): string => {
  store.registerRepository("repo-1", "/tmp/repo-1/.git", "/tmp/repo-1");
  return store.createRun({ repoId: "repo-1", profile: "coding", mode: "feature", request: "test request" });
};

const validResult = (runId = RUN_ID, dispatchId = DISPATCH_ID) => ({
  ...createResultTemplate(runId, dispatchId, "backend-developer"),
  summary: "Implemented and verified",
  verification: [{ command: "npm test", outcome: "passed" }],
  payload: { modified_paths: ["src/example.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] },
});

test("result templates carry dispatch identity and become valid with completion evidence", () => {
  const template = createResultTemplate(RUN_ID, DISPATCH_ID, "backend-developer");

  assert.equal(template.run_id, RUN_ID);
  assert.equal(template.dispatch_id, DISPATCH_ID);
  assert.equal(template.role, "backend-developer");
  assert.equal(template.status, "completed");
  assert.deepEqual(checkResultEnvelope(template), {
    valid: false,
    errors: [{ path: "/summary", message: "must NOT have fewer than 1 characters" }],
  });

  assert.deepEqual(checkResultEnvelope(validResult()), { valid: true, value: validResult() });
});

test("result contract rejects completed results without evidence and failed results without failure metadata", () => {
  const completed = validResult();
  completed.verification = [];
  assert.deepEqual(checkResultEnvelope(completed), {
    valid: false,
    errors: [{ path: "/verification", message: "completed results require verification evidence" }],
  });

  const failed = { ...validResult(), status: "failed", verification: [] };
  const invalidFailure = checkResultEnvelope(failed);
  assert.equal(invalidFailure.valid, false);
  if (!invalidFailure.valid) {
    assert.equal(invalidFailure.errors.filter(({ message }) => message === "must have required property 'failure_class'").length, 1);
    assert.equal(invalidFailure.errors.filter(({ message }) => message === "must have required property 'side_effect_state'").length, 1);
  }

  assert.equal(
    checkResultEnvelope({ ...failed, failure_class: "test_failure", side_effect_state: "none" }).valid,
    true,
  );
});

test("result contract rejects unknown fields, malformed identifiers, and unsupported roles", () => {
  const result = checkResultEnvelope({
    ...validResult(),
    run_id: "run_invalid",
    role: "administrator",
    unexpected: true,
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some(({ path, message }) => path === "/" && message === "must NOT have additional properties"));
    assert.ok(result.errors.some(({ path }) => path === "/run_id"));
    assert.ok(result.errors.some(({ path }) => path === "/role"));
  }
});

test("result contract rejects role payload fields outside the role schema", () => {
  const result = checkResultEnvelope({ ...validResult(), payload: { modified_paths: [], self_tests: [], arbitrary: true } });
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some(({ path, message }) => path === "/payload" && message === "must NOT have additional properties"));
});

test("state migration is recorded once and survives reopening", async () => {
  const home = await temporaryHome();
  let store = await StateStore.open(home);
  try {
    assert.deepEqual(
      store.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all(),
      [{ name: "001-initial" }, { name: "002-review-barriers" }, { name: "003-run-stages-and-reconcile" }, { name: "004-repository-scoped-revisions" }],
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count > 0,
      true,
    );
    store.close();

    store = await StateStore.open(home);
    assert.deepEqual(
      store.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all(),
      [{ name: "001-initial" }, { name: "002-review-barriers" }, { name: "003-run-stages-and-reconcile" }, { name: "004-repository-scoped-revisions" }],
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("migration 004 preserves legacy revisions and scopes identical revisions by repository", async () => {
  const home = await temporaryHome();
  let store = await StateStore.open(home);
  try {
    store.registerRepository("repo-a", "/tmp/repo-a.git", "/tmp/repo-a");
    store.registerRepository("repo-b", "/tmp/repo-b.git", "/tmp/repo-b");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-shared-abcd", "001", "repo-a", "ready", "main", "2026-08-14T00:00:00.000Z");
    store.close();

    const database = new Database(join(home, "state", "state.sqlite"));
    database.pragma("foreign_keys = OFF");
    database.exec(`
      ALTER TABLE revisions RENAME TO revisions_v4;
      CREATE TABLE revisions (
        plan_id TEXT NOT NULL, revision TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
        state TEXT NOT NULL, target_branch TEXT NOT NULL, digest TEXT, plan_commit TEXT, supersedes TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(plan_id, revision)
      );
      INSERT INTO revisions SELECT plan_id,revision,repo_id,state,target_branch,digest,plan_commit,supersedes,created_at FROM revisions_v4;
      DROP TABLE revisions_v4;
      DELETE FROM schema_migrations WHERE name='004-repository-scoped-revisions';
    `);
    database.close();

    store = await StateStore.open(home);
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-shared-abcd", "001", "repo-b", "draft", "develop", "2026-08-14T00:01:00.000Z");
    const rows = store.db.prepare("SELECT repo_id,state,target_branch FROM revisions WHERE plan_id=? AND revision=? ORDER BY repo_id")
      .all("20260814-shared-abcd", "001");
    assert.deepEqual(rows, [
      { repo_id: "repo-a", state: "ready", target_branch: "main" },
      { repo_id: "repo-b", state: "draft", target_branch: "develop" },
    ]);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("operations reuse an idempotency key and expose completed state", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const first = store.beginOperation("install", "install:default", { version: 1 }, runId);
    const duplicate = store.beginOperation("install", "install:default", { version: 2 }, runId);

    assert.equal(first.reused, false);
    assert.equal(first.state, "pending");
    assert.deepEqual(duplicate, { operationId: first.operationId, reused: true, state: "pending" });

    store.finishOperation(first.operationId, { files: ["agents.md"], ok: true });
    assert.deepEqual(store.beginOperation("install", "install:default", { version: 3 }, runId), {
      operationId: first.operationId,
      reused: true,
      state: "completed",
    });

    const row = store.db.prepare("SELECT request_json, evidence_json FROM operations WHERE operation_id=?").get(first.operationId) as {
      request_json: string;
      evidence_json: string;
    };
    assert.equal(row.request_json, '{"version":1}');
    assert.equal(row.evidence_json, '{"files":["agents.md"],"ok":true}');
  });
});

test("decisions allow one pending question, validate choices, and record resolution", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const choices = [
      { id: "keep", label: "Keep", impact: "No migration" },
      { id: "move", label: "Move", impact: "Migrate branch" },
    ];
    const decisionId = store.createDecision(runId, "Which branch?", choices, "keep");

    assert.throws(
      () => store.createDecision(runId, "Another question", choices),
      (error: unknown) => error instanceof ValidationError && error.message.includes("already has a pending decision"),
    );
    assert.throws(
      () => store.decide(runId, decisionId, "missing"),
      (error: unknown) => error instanceof ValidationError && error.message === "unknown decision choice: missing",
    );

    store.decide(runId, decisionId, "keep", "Matches current work");
    assert.throws(
      () => store.decide(runId, decisionId, "keep"),
      (error: unknown) => error instanceof ValidationError && error.message.includes("already resolved"),
    );
    assert.doesNotThrow(() => store.createDecision(runId, "Next question", choices));

    const resolution = store.db.prepare("SELECT status, choice, note FROM decisions WHERE decision_id=?").get(decisionId);
    assert.deepEqual(resolution, { status: "resolved", choice: "keep", note: "Matches current work" });
    const event = store.db.prepare("SELECT type, payload_json FROM run_events WHERE run_id=? ORDER BY event_id DESC").get(runId) as {
      type: string;
      payload_json: string;
    };
    assert.equal(event.type, "decision.resolved");
    assert.equal(event.payload_json, `{"choice":"keep","decisionId":"${decisionId}"}`);
  });
});

test("dispatch claim is idempotent and enforces run and role identity", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet: DispatchPacket = {
      objective: "Implement the core",
      allowed_read_paths: ["src/a.ts"],
      allowed_write_paths: ["src/core.ts"],
      acceptance_criteria: ["Tests pass"],
      context: { task: "TASK-001" },
    };
    const dispatchId = dispatches.create(runId, "backend-developer", packet);

    assert.deepEqual(dispatches.claim(runId, dispatchId, "backend-developer"), { reused: false, packet });
    assert.deepEqual(dispatches.claim(runId, dispatchId, "backend-developer"), { reused: true, packet });
    assert.throws(
      () => dispatches.claim(runId, dispatchId, "test"),
      (error: unknown) => error instanceof ValidationError && error.message.includes("identity does not match"),
    );
  });
});

test("dispatch validates identity, requires claim, redacts artifacts, and reuses identical submissions", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet: DispatchPacket = {
      objective: "Submit a result",
      allowed_read_paths: [],
      allowed_write_paths: ["test/core.test.ts"],
      acceptance_criteria: ["Result is valid"],
      context: {},
    };
    const unclaimedId = dispatches.create(runId, "backend-developer", packet);
    const unclaimedPath = join(home, "unclaimed.json");
    await writeFile(unclaimedPath, JSON.stringify(validResult(runId, unclaimedId)));
    await assert.rejects(
      dispatches.submit(runId, unclaimedId, "backend-developer", unclaimedPath),
      (error: unknown) => error instanceof ValidationError && error.message === "dispatch must be claimed before submit",
    );

    const dispatchId = dispatches.create(runId, "backend-developer", packet);
    dispatches.claim(runId, dispatchId, "backend-developer");
    const resultPath = join(home, "result.json");
    const result = { ...validResult(runId, dispatchId), summary: "Used sk-1234567890abcdef safely" };
    await writeFile(resultPath, JSON.stringify(result));

    assert.deepEqual(await dispatches.validateFile(runId, dispatchId, "backend-developer", resultPath), result);
    await assert.rejects(
      dispatches.validateFile(runId, dispatchId, "test", resultPath),
      (error: unknown) => error instanceof ValidationError && error.message.includes("identity does not match"),
    );

    const first = await dispatches.submit(runId, dispatchId, "backend-developer", resultPath);
    assert.equal(first.reused, false);
    assert.match(await readFile(first.artifact, "utf8"), /\[REDACTED\]/);
    assert.doesNotMatch(await readFile(first.artifact, "utf8"), /sk-1234567890abcdef/);
    assert.deepEqual(await dispatches.submit(runId, dispatchId, "backend-developer", resultPath), {
      reused: true,
      artifact: first.artifact,
    });

    await writeFile(resultPath, JSON.stringify({ ...result, summary: "A different valid result" }));
    await assert.rejects(
      dispatches.submit(runId, dispatchId, "backend-developer", resultPath),
      (error: unknown) => error instanceof ValidationError && error.message.includes("different result"),
    );
  });
});

test("planning coverage reports sorted missing and unknown identifiers", () => {
  const spec = "REQ-002 must follow AC-001. REQ-001 is repeated by REQ-001.";
  const documents = ["Implement REQ-002 and AC-999.", "Verify REQ-003."];

  assert.deepEqual([...extractRequirementIds(spec)], ["REQ-002", "AC-001", "REQ-001"]);
  assert.deepEqual(validateCoverage(spec, documents), {
    requirements: ["AC-001", "REQ-001", "REQ-002"],
    missing: ["AC-001", "REQ-001"],
    unknown: ["AC-999", "REQ-003"],
  });
  assert.throws(
    () => assertCoverage(spec, documents),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.message === "planning coverage is incomplete" &&
      assert.deepEqual(error.details, validateCoverage(spec, documents)) === undefined,
  );
  assert.doesNotThrow(() => assertCoverage(spec, ["REQ-001 REQ-002 AC-001"]));
});

test("planning states allow only declared forward transitions", () => {
  assert.equal(nextPlanState("draft", "requirements_confirmed"), "requirements_confirmed");
  assert.equal(nextPlanState("plan_ready", "ready"), "ready");
  assert.equal(nextPlanState("tasks_preview", "tasks_preview"), "tasks_preview");
  assert.equal(nextPlanState("ready", "implemented"), "implemented");

  assert.throws(() => nextPlanState("draft", "ready"), /invalid planning transition/);
  assert.throws(() => nextPlanState("implemented", "abandoned"), /terminal revision cannot transition/);
  assert.throws(() => nextPlanState("missing", "draft"), /unknown planning state/);
});

test("triage prioritizes an existing plan, recognizes evidenced bugs, and gates fast-path features", () => {
  assert.equal(triage({ planId: "20260813-core-abcd", actual: "broken", expected: "works", evidence: "trace" }), "planned");
  assert.equal(triage({ actual: "broken", expected: "works", evidence: "trace" }), "bug");
  assert.equal(
    triage({ singleGoal: true, closedAcceptance: true, exhaustiveScope: true, singleModule: true, sensitive: false }),
    "feature",
  );
  assert.equal(
    triage({ singleGoal: true, closedAcceptance: true, exhaustiveScope: true, singleModule: true, sensitive: true }),
    "planning",
  );
  assert.equal(triage({ actual: "broken", expected: "works" }), "planning");
});
