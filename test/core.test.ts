import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkResultEnvelope, createResultTemplate } from "../src/contracts.js";
import { COMMAND_CONTRACT_BASE, COMMAND_PARAMETER_TYPES, COMMAND_SYNTAX, commandContractFor } from "../src/command-contract.js";
import { DispatchService, type DispatchPacket } from "../src/dispatch.js";
import { ValidationError } from "../src/errors.js";
import { assertCoverage, assertRevisionDocuments, assertRevisionRunStage, extractRequirementIds, nextPlanState, triage, validateCoverage } from "../src/planning.js";
import { StateStore } from "../src/state.js";
import { legacyStagingFilePath, stagingFilePath } from "../src/security.js";
import { makePlanId, sha256 } from "../src/utils.js";

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
    errors: [{ path: "/summary", pointer: "/summary", field: "summary", constraint: "minLength", message: "must NOT have fewer than 1 characters" }],
  });

  assert.deepEqual(checkResultEnvelope(validResult()), { valid: true, value: validResult() });
});

test("result contract rejects completed results without evidence and failed results without failure metadata", () => {
  const completed = validResult();
  completed.verification = [];
  assert.deepEqual(checkResultEnvelope(completed), {
    valid: false,
    errors: [{ path: "/verification", pointer: "/verification", field: "verification", constraint: "minItems", message: "completed results require verification evidence" }],
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
    assert.ok(result.errors.some(({ path, field, constraint, message }) => path === "/unexpected" && field === "unexpected" && constraint === "additionalProperties" && message === "must NOT have additional properties"));
    assert.ok(result.errors.some(({ path }) => path === "/run_id"));
    assert.ok(result.errors.some(({ path }) => path === "/role"));
  }
});

test("result contract rejects role payload fields outside the role schema", () => {
  const result = checkResultEnvelope({ ...validResult(), payload: { modified_paths: [], self_tests: [], arbitrary: true } });
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some(({ path, field, constraint, message }) => path === "/payload/arbitrary" && field === "arbitrary" && constraint === "additionalProperties" && message === "must NOT have additional properties"));
});

test("task revisions can take the managed draft to plan_ready transition", () => {
  assert.equal(nextPlanState("draft", "plan_ready"), "plan_ready");
  assert.doesNotThrow(() => assertRevisionRunStage("draft", "tasks_preview", "plan_ready"));
});

test("state migration is recorded once and survives reopening", async () => {
  const home = await temporaryHome();
  let store = await StateStore.open(home);
  try {
    assert.deepEqual(
      store.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all(),
      [{ name: "001-initial" }, { name: "002-review-barriers" }, { name: "003-run-stages-and-reconcile" }, { name: "004-repository-scoped-revisions" }, { name: "005-staging-entries" }, { name: "006-recovery-provenance" }, { name: "007-review-barrier-reconciliation" }, { name: "008-run-planning-handoff" }, { name: "009-readable-staging-filenames" }],
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count > 0,
      true,
    );
    store.close();

    store = await StateStore.open(home);
    assert.deepEqual(
      store.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all(),
      [{ name: "001-initial" }, { name: "002-review-barriers" }, { name: "003-run-stages-and-reconcile" }, { name: "004-repository-scoped-revisions" }, { name: "005-staging-entries" }, { name: "006-recovery-provenance" }, { name: "007-review-barrier-reconciliation" }, { name: "008-run-planning-handoff" }, { name: "009-readable-staging-filenames" }],
    );
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("readonly state opens alongside a writer without locks, backups, or migrations", async () => {
  const home = await temporaryHome();
  const writer = await StateStore.open(home);
  try {
    const backupsBefore = await readdir(join(home, "backups"));
    const reader = await StateStore.open(home, { readonly: true });
    try {
      assert.equal(
        (reader.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
        9,
      );
      assert.throws(() => reader.db.prepare("UPDATE runs SET state='failed'").run(), /readonly|read-only/i);
    } finally {
      reader.close();
    }
    assert.deepEqual(await readdir(join(home, "backups")), backupsBefore);
  } finally {
    writer.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed staging persists metadata without JSON content and consumes files", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    await assert.rejects(
      store.createStagingEntry({ runId, role: "environment-operator", kind: "decision" }),
      /does not own staging kind/,
    );
    const entry = await store.createStagingEntry({ runId, role: "backend-developer", kind: "dispatch-result" });
    const directory = join(home, "state", "staging", runId);
    const path = join(directory, "0001--dispatch-result--backend-developer.json");

    assert.equal((await stat(join(home, "state", "staging"))).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(entry.state, "draft");

    const secret = { token: "staging-raw-secret", nested: [1, 2, 3] };
    const ready = await store.writeStagingEntry(entry.stagingId, JSON.stringify(secret), { runId, role: "backend-developer", kind: "dispatch-result" });
    assert.equal(ready.state, "ready");
    assert.deepEqual((await store.readStagingEntry(entry.stagingId, { runId, role: "backend-developer", kind: "dispatch-result" })).value, secret);
    assert.throws(() => store.getStagingEntry("staging_01ARZ3NDEKTSV4RRFFQ69G5FAV"), /unknown staging entry/);
    await assert.rejects(store.readStagingEntry(entry.stagingId, { runId, role: "test" }), /role binding/);
    await assert.rejects(store.readStagingEntry(entry.stagingId, { runId, kind: "decision" }), /kind binding/);

    const persisted = JSON.stringify({
      entries: store.db.prepare("SELECT * FROM staging_entries").all(),
      events: store.db.prepare("SELECT type,payload_json FROM run_events WHERE type LIKE 'staging.%'").all(),
    });
    assert.doesNotMatch(persisted, /staging-raw-secret/);

    const consumed = await store.consumeStagingEntry(entry.stagingId, { runId, role: "backend-developer", kind: "dispatch-result" });
    assert.equal(consumed.state, "consumed");
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(store.writeStagingEntry(entry.stagingId, "{}", { runId }), /not readable/);
  });
});

test("managed staging filenames expose run-local creation order without reusing consumed sequences", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    const first = await store.createStagingEntry({ runId, role: "test", kind: "dispatch-result" });
    await store.createStagingEntry({ runId, role: "planning", kind: "planning-tasks" });
    const directory = join(home, "state", "staging", runId);

    assert.deepEqual(await readdir(directory), [
      "0001--dispatch-result--test.json",
      "0002--planning-tasks--planning.json",
    ]);
    assert.deepEqual(
      store.db.prepare("SELECT sequence_no,role,kind FROM staging_entries WHERE run_id=? ORDER BY sequence_no").all(runId),
      [
        { sequence_no: 1, role: "test", kind: "dispatch-result" },
        { sequence_no: 2, role: "planning", kind: "planning-tasks" },
      ],
    );

    await store.consumeStagingEntry(first.stagingId, { runId, role: "test", kind: "dispatch-result" });
    await store.createStagingEntry({ runId, role: "code-reviewer", kind: "review-result" });
    assert.deepEqual(await readdir(directory), [
      "0002--planning-tasks--planning.json",
      "0003--review-result--code-reviewer.json",
    ]);
  });
});

test("concurrent staging creation allocates distinct filenames", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    await Promise.all([
      store.createStagingEntry({ runId, role: "test", kind: "dispatch-result" }),
      store.createStagingEntry({ runId, role: "test", kind: "dispatch-result" }),
    ]);
    assert.deepEqual(await readdir(join(home, "state", "staging", runId)), [
      "0001--dispatch-result--test.json",
      "0002--dispatch-result--test.json",
    ]);
  });
});

test("migration 009 renames legacy staging files and continues their run sequence", async () => {
  const home = await temporaryHome();
  let store: StateStore | undefined = await StateStore.open(home);
  try {
    const runId = createRun(store);
    const entry = await store.createStagingEntry({ runId, role: "file-explorer", kind: "dispatch-result" });
    const current = stagingFilePath(store.paths.staging, runId, 1, "dispatch-result", "file-explorer");
    const legacy = legacyStagingFilePath(store.paths.staging, runId, entry.stagingId);
    store.close();
    store = undefined;
    await rename(current, legacy);

    const database = new Database(join(home, "state", "state.sqlite"));
    database.prepare("UPDATE staging_entries SET sequence_no=NULL,file_dev='0',file_ino='0' WHERE staging_id=?").run(entry.stagingId);
    database.prepare("UPDATE runs SET next_staging_sequence=1 WHERE run_id=?").run(runId);
    database.prepare("DELETE FROM state_meta WHERE key='staging_filename_migration'").run();
    database.prepare("DELETE FROM schema_migrations WHERE name='009-readable-staging-filenames'").run();
    database.close();

    store = await StateStore.open(home);
    const migrated = store.db.prepare("SELECT sequence_no,file_dev,file_ino FROM staging_entries WHERE staging_id=?").get(entry.stagingId) as {
      sequence_no: number;
      file_dev: string;
      file_ino: string;
    };
    const migratedInfo = await stat(current, { bigint: true });
    assert.deepEqual(migrated, { sequence_no: 1, file_dev: String(migratedInfo.dev), file_ino: String(migratedInfo.ino) });
    assert.equal((await stat(current)).mode & 0o777, 0o600);
    await assert.rejects(stat(legacy), { code: "ENOENT" });

    await store.createStagingEntry({ runId, role: "planning", kind: "planning-documents" });
    assert.equal((await stat(stagingFilePath(store.paths.staging, runId, 2, "planning-documents", "planning"))).mode & 0o777, 0o600);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("migration 009 rejects legacy staging content that does not match persisted metadata", async () => {
  const home = await temporaryHome();
  let store: StateStore | undefined = await StateStore.open(home);
  try {
    const runId = createRun(store);
    const entry = await store.createStagingEntry({ runId, role: "test", kind: "dispatch-result" });
    const current = stagingFilePath(store.paths.staging, runId, 1, "dispatch-result", "test");
    const legacy = legacyStagingFilePath(store.paths.staging, runId, entry.stagingId);
    store.close();
    store = undefined;
    await rename(current, legacy);
    await writeFile(legacy, "{\"tampered\":true}", { mode: 0o600 });

    const database = new Database(join(home, "state", "state.sqlite"));
    database.prepare("DELETE FROM state_meta WHERE key='staging_filename_migration'").run();
    database.prepare("DELETE FROM schema_migrations WHERE name='009-readable-staging-filenames'").run();
    database.close();

    await assert.rejects(StateStore.open(home), /legacy staging content does not match persisted metadata/);
  } finally {
    store?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed staging rejects invalid JSON, oversized writes, links, modes, and path replacement", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    const entry = await store.createStagingEntry({ runId, role: "test", kind: "dispatch-result" });
    const path = join(home, "state", "staging", runId, "0001--dispatch-result--test.json");
    await store.writeStagingEntry(entry.stagingId, "{\"valid\":true}", { runId, role: "test" });

    await assert.rejects(store.writeStagingEntry(entry.stagingId, "{", { runId, role: "test" }), /not valid JSON/);
    assert.deepEqual((await store.readStagingEntry(entry.stagingId, { runId, role: "test" })).value, { valid: true });
    await assert.rejects(store.writeStagingEntry(entry.stagingId, Buffer.alloc(2 * 1024 * 1024 + 1), { runId, role: "test" }), /exceeds/);

    const hardlink = join(home, "staging-hardlink.json");
    await link(path, hardlink);
    await assert.rejects(store.readStagingEntry(entry.stagingId, { runId, role: "test" }), /exactly one hard link/);
    await unlink(hardlink);
    await chmod(path, 0o644);
    await assert.rejects(store.readStagingEntry(entry.stagingId, { runId, role: "test" }), /mode 0600/);
    await chmod(path, 0o600);

    const outside = join(home, "outside.json");
    await writeFile(outside, "{\"outside\":true}", { mode: 0o600 });
    await assert.rejects(store.writeStagingEntry(entry.stagingId, "{\"replacement\":true}", { runId, role: "test" }, async () => {
      await unlink(path);
      await symlink(outside, path);
    }), /regular file|identity changed/);
    assert.equal(await readFile(outside, "utf8"), "{\"outside\":true}");
  });
});

test("managed staging expires and cleans only selected entries", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    const old = new Date("2026-08-01T00:00:00.000Z");
    const entry = await store.createStagingEntry({ runId, role: "planning", kind: "planning-tasks", retentionHours: 1, now: old });
    assert.equal(store.expireStagingEntries(new Date("2026-08-01T02:00:00.000Z")), 1);
    assert.equal(store.getStagingEntry(entry.stagingId).state, "expired");
    const path = join(home, "state", "staging", runId, "0001--planning-tasks--planning.json");
    await chmod(path, 0o644);
    const failed = await store.cleanupStagingEntries({ expired: true, now: new Date("2026-08-01T02:00:00.000Z") });
    assert.deepEqual(failed, { matched: 1, removed: 0, pending: 1 });
    assert.equal(store.getStagingEntry(entry.stagingId).state, "cleanup_pending");

    store.registerRepository("repo-2", "/tmp/repo-2/.git", "/tmp/repo-2");
    const otherRun = store.createRun({ repoId: "repo-2", profile: "coding", mode: "feature", request: "other" });
    assert.deepEqual(await store.cleanupStagingEntries({ runId: otherRun, stagingId: entry.stagingId, all: true }), { matched: 0, removed: 0, pending: 0 });
    await chmod(path, 0o600);
    const cleaned = await store.cleanupStagingEntries({ runId, stagingId: entry.stagingId, all: true });
    assert.deepEqual(cleaned, { matched: 1, removed: 1, pending: 0 });
    assert.throws(() => store.getStagingEntry(entry.stagingId), /unknown staging entry/);
  });
});

test("migration 004 preserves legacy revisions and scopes identical revisions by repository", async () => {
  const home = await temporaryHome();
  let store = await StateStore.open(home);
  try {
    store.registerRepository("repo-a", "/tmp/repo-a.git", "/tmp/repo-a");
    store.registerRepository("repo-b", "/tmp/repo-b.git", "/tmp/repo-b");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-shared", "001", "repo-a", "ready", "main", "2026-08-14T00:00:00.000Z");
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
      .run("20260814-shared", "001", "repo-b", "draft", "develop", "2026-08-14T00:01:00.000Z");
    const rows = store.db.prepare("SELECT repo_id,state,target_branch FROM revisions WHERE plan_id=? AND revision=? ORDER BY repo_id")
      .all("20260814-shared", "001");
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

test("dispatch claim bundle returns the same frozen assets and digests idempotently", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet: DispatchPacket = {
      objective: "Inspect frozen assets",
      allowed_read_paths: ["src/a.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Assets match"],
      context: { task: "TASK-001" },
    };
    const dispatchId = dispatches.create(runId, "backend-developer", packet);

    const first = dispatches.claimBundle(runId, dispatchId, "backend-developer");
    assert.equal(first.reused, false);
    assert.deepEqual(first.packet, packet);
    assert.equal(first.prompt, dispatches.prompt(runId, dispatchId, "backend-developer"));
    assert.deepEqual(first.schema, dispatches.schema(runId, dispatchId, "backend-developer"));
    assert.deepEqual(first.template, dispatches.template(runId, dispatchId, "backend-developer"));
    assert.deepEqual(Object.keys(first.digests).sort(), ["packet", "prompt", "schema", "template"]);
    for (const digest of Object.values(first.digests)) assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(first.renderer_version, "dispatch-renderer-v3");

    const second = dispatches.claimBundle(runId, dispatchId, "backend-developer");
    assert.deepEqual(second, { ...first, reused: true });
  });
});

test("dispatch prompt preserves the frozen v2 renderer for existing dispatches", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet: DispatchPacket = {
      objective: "Inspect a frozen legacy prompt",
      allowed_read_paths: ["src/a.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Prompt remains byte-stable"],
      context: {},
    };
    const dispatchId = dispatches.create(runId, "backend-developer", packet);
    const legacyPrompt = [
      "Role: backend-developer",
      `Run: ${runId}`,
      `Dispatch: ${dispatchId}`,
      "Objective: Inspect a frozen legacy prompt",
      "Allowed read paths: src/a.ts",
      "Allowed write paths: none",
      "Acceptance criteria: Prompt remains byte-stable",
      "Context: {}",
      "Return only the frozen result envelope and role payload schema.",
    ].join("\n");
    store.db.prepare("UPDATE dispatches SET renderer_version='dispatch-renderer-v2',prompt_digest=? WHERE dispatch_id=?")
      .run(sha256(legacyPrompt), dispatchId);
    assert.equal(dispatches.prompt(runId, dispatchId, "backend-developer"), legacyPrompt);
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
    const reused = await dispatches.submit(runId, dispatchId, "backend-developer", resultPath);
    assert.equal(reused.reused, true);
    assert.equal(reused.artifact, first.artifact);
    assert.deepEqual(reused.submission, first.submission);
    assert.deepEqual(reused.continuation, first.continuation);

    await writeFile(resultPath, JSON.stringify({ ...result, summary: "A different valid result" }));
    await assert.rejects(
      dispatches.submit(runId, dispatchId, "backend-developer", resultPath),
      (error: unknown) => error instanceof ValidationError && error.message.includes("different result"),
    );
  });
});

test("dispatch validation is a claimed active-run preflight with no state changes", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet: DispatchPacket = {
      objective: "Validate without submitting",
      allowed_read_paths: [],
      allowed_write_paths: ["test/core.test.ts"],
      acceptance_criteria: ["Validation is side-effect free"],
      context: {},
    };
    const dispatchId = dispatches.create(runId, "backend-developer", packet);
    const resultPath = join(home, "preflight.json");
    await writeFile(resultPath, JSON.stringify(validResult(runId, dispatchId)));

    await assert.rejects(
      dispatches.validateFile(runId, dispatchId, "backend-developer", resultPath),
      /must be claimed before validate/,
    );
    dispatches.claim(runId, dispatchId, "backend-developer");
    const before = {
      run: store.db.prepare("SELECT state,stage,updated_at FROM runs WHERE run_id=?").get(runId),
      dispatch: store.db.prepare("SELECT state,claimed_at,completed_at,result_json FROM dispatches WHERE dispatch_id=?").get(dispatchId),
      events: store.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id=?").get(runId),
    };
    assert.deepEqual(await dispatches.validateFile(runId, dispatchId, "backend-developer", resultPath), validResult(runId, dispatchId));
    assert.deepEqual({
      run: store.db.prepare("SELECT state,stage,updated_at FROM runs WHERE run_id=?").get(runId),
      dispatch: store.db.prepare("SELECT state,claimed_at,completed_at,result_json FROM dispatches WHERE dispatch_id=?").get(dispatchId),
      events: store.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id=?").get(runId),
    }, before);

    store.db.prepare("UPDATE runs SET state='failed' WHERE run_id=?").run(runId);
    await assert.rejects(
      dispatches.validateFile(runId, dispatchId, "backend-developer", resultPath),
      /run must be active before validate/,
    );
  });
});

test("revision documents reject missing, unknown, and non-string fields with JSON paths", () => {
  assert.throws(
    () => assertRevisionDocuments({}),
    (error: unknown) => error instanceof ValidationError
      && assert.deepEqual(error.details, [
        { path: "/spec", message: "must be a string" },
        { path: "/plan", message: "must be a string" },
      ]) === undefined,
  );
  assert.throws(
    () => assertRevisionDocuments({ spec: "spec", plan: "plan", extra: true, taskFiles: { "TASK-001.md": 1 } }),
    (error: unknown) => error instanceof ValidationError
      && assert.deepEqual(error.details, [
        { path: "/extra", message: "unknown field" },
        { path: "/taskFiles/TASK-001.md", message: "must be a string" },
      ]) === undefined,
  );
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

test("planning revision commit has one exact generated command contract", () => {
  assert.deepEqual(COMMAND_SYNTAX["planning revision validate"], [
    "ai-team planning revision validate --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> (--documents-file <file> | --run-id <run-id> (--staging-id <staging-id> | --input-stdin)) [--supersedes <revision>]",
  ]);
  assert.deepEqual(COMMAND_SYNTAX["planning revision commit"], [
    "ai-team planning revision commit --project <path> --plan-id <plan-id> --revision <revision> --run-id <run-id> --dispatch-id <dispatch-id>",
  ]);
  assert.deepEqual(commandContractFor(["planning revision commit"]).syntax, COMMAND_SYNTAX["planning revision commit"]);
});

test("dispatch reconciliation has one exact generated command contract", () => {
  assert.deepEqual(COMMAND_SYNTAX["dispatch reconcile"], [
    "ai-team dispatch reconcile --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text>",
  ]);
  assert.deepEqual(commandContractFor(["dispatch reconcile"]).syntax, COMMAND_SYNTAX["dispatch reconcile"]);
});

test("environment explanation and diff commands have exact public contracts", () => {
  assert.deepEqual(COMMAND_SYNTAX["env explain"], [
    "ai-team env explain <name> --role <role> --platform <platform>",
  ]);
  assert.deepEqual(COMMAND_SYNTAX["env diff"], [
    "ai-team env diff <from> <to> [--role <role>] [--platform <platform>]",
  ]);
  assert.ok(COMMAND_CONTRACT_BASE.commands.public.includes("env explain"));
  assert.ok(COMMAND_CONTRACT_BASE.commands.public.includes("env diff"));
  assert.equal(COMMAND_PARAMETER_TYPES.platform, "enum; codex, claude, or opencode");
});

test("plan identifiers omit the random hex suffix", () => {
  assert.equal(makePlanId("Plan Identifier", new Date("2026-08-16T04:00:00.000Z")), "20260816-plan-identifier");
  assert.throws(() => makePlanId("Plan abcd"), /must not end with four hexadecimal digits/);
  assert.equal(COMMAND_PARAMETER_TYPES["plan-id"], "string; eight decimal digits followed by a lowercase slug that does not end with four hexadecimal digits");
  assert.equal(COMMAND_CONTRACT_BASE.identifiers.plan_id, "^(?!.*-[a-f0-9]{4}$)[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$");
});

test("revision state permits only compatible planning run stages, including plan-ready recovery", () => {
  assert.doesNotThrow(() => assertRevisionRunStage("draft", "tasks_preview"));
  assert.doesNotThrow(() => assertRevisionRunStage("spec_ready", "plan_ready", "plan_ready"));
  assert.doesNotThrow(() => assertRevisionRunStage("plan_ready", "tasks_preview", "tasks_preview"));
  assert.throws(
    () => assertRevisionRunStage("draft", "ready", "requirements_confirmed"),
    /revision state draft is incompatible with planning run stage ready/,
  );
  assert.throws(
    () => assertRevisionRunStage("ready", "plan_ready", "implemented"),
    /revision state implemented is incompatible with planning run stage plan_ready/,
  );
});

test("triage prioritizes an existing plan, recognizes evidenced bugs, and gates fast-path features", () => {
  assert.equal(triage({ planId: "20260813-core", actual: "broken", expected: "works", evidence: "trace" }), "planned");
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
