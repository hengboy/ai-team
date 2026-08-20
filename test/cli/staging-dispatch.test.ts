import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { createResultTemplate } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { stagingFilePath } from "../../src/security.js";
import { StateStore } from "../../src/state.js";

import { cli, cliWithInput, json, makeSandbox } from "../helpers/cli.js";

test("CLI advertises the explicit task worktree recovery identity and lineage flags", async (t) => {
  const sandbox = await makeSandbox(t);
  const help = await cli(sandbox, ["git", "recover-task-worktree", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const option of [
    "--project <path>", "--worktree-id <id>", "--from-plan-id <id>", "--from-revision <revision>",
    "--to-plan-id <id>", "--to-revision <revision>", "--to-run-id <id>", "--task-id <id>",
    "--expected-head <sha>", "--expected-source-artifact <id-or-digest>", "--dispatch-id <id>", "--replaces-staging-id <id>",
  ]) assert.match(help.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});


test("CLI manages cancel, reissue, and supersede for a claimed support dispatch", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "support-request.md");
  await writeFile(requestFile, "Repair a support dispatch.\n");
  const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));

  json(await cli(sandbox, ["dispatch", "claim", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"]));
  const reissued = json<{ action: string; dispatch_id: string; reused: boolean }>(await cli(sandbox, [
    "dispatch", "reissue", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id,
    "--role", "file-explorer", "--actor-role", "planning", "--reason", "repair claimed support dispatch",
  ]));
  assert.deepEqual({ action: reissued.action, reused: reissued.reused }, { action: "reissued", reused: false });

  const replacementPacket = JSON.stringify({
    objective: "Explore corrected support scope",
    allowed_read_paths: ["src/planning.ts"],
    allowed_write_paths: [],
    acceptance_criteria: ["Return corrected project context"],
    context: {},
  });
  const staging = json<{ stagingId: string }>(await cli(sandbox, [
    "staging", "create", "--run-id", started.run_id, "--role", "planning", "--kind", "dispatch-packet",
  ]));
  json(await cliWithInput(sandbox, [
    "staging", "write", "--run-id", started.run_id, "--role", "planning", "--staging-id", staging.stagingId, "--input-stdin",
  ], replacementPacket));
  const superseded = json<{ action: string; dispatch_id: string }>(await cli(sandbox, [
    "dispatch", "supersede", "--run-id", started.run_id, "--dispatch-id", reissued.dispatch_id,
    "--role", "file-explorer", "--actor-role", "planning", "--reason", "correct scope", "--staging-id", staging.stagingId,
  ]));
  assert.equal(superseded.action, "superseded");
  assert.deepEqual(json(await cli(sandbox, [
    "dispatch", "cancel", "--run-id", started.run_id, "--dispatch-id", superseded.dispatch_id,
    "--role", "file-explorer", "--actor-role", "planning", "--reason", "support no longer required",
  ])), { action: "canceled", reused: false });

  const store = await StateStore.open(sandbox.aiTeamHome, { readonly: true });
  assert.deepEqual(
    store.db.prepare("SELECT dispatch_id,replacement_for,state FROM dispatches WHERE run_id=? ORDER BY created_at").all(started.run_id),
    [
      { dispatch_id: started.dispatch_id, replacement_for: null, state: "failed" },
      { dispatch_id: reissued.dispatch_id, replacement_for: started.dispatch_id, state: "failed" },
      { dispatch_id: superseded.dispatch_id, replacement_for: reissued.dispatch_id, state: "failed" },
    ],
  );
  store.close();
});

test("CLI resume returns and executes managed reconciliation for confirmed side effects", async (t) => {
  const sandbox = await makeSandbox(t);
  json(await cli(sandbox, ["init", sandbox.repo, "--yes"]));
  const store = await StateStore.open(sandbox.aiTeamHome);
  store.registerRepository("repo-cli-reconcile", join(sandbox.repo, ".git"), sandbox.repo);
  const runId = store.createRun({ repoId: "repo-cli-reconcile", profile: "planning", mode: "planned", request: "reconcile retryable dispatch" });
  const dispatches = new DispatchService(store);
  const dispatchId = dispatches.create(runId, "file-explorer", {
    objective: "Inspect recovery state",
    allowed_read_paths: ["."],
    allowed_write_paths: [],
    acceptance_criteria: ["Return recovery evidence"],
    context: {},
  });
  dispatches.claim(runId, dispatchId, "file-explorer");
  await dispatches.submitValue(runId, dispatchId, "file-explorer", {
    ...createResultTemplate(runId, dispatchId, "file-explorer"),
    status: "retryable_failure",
    summary: "Client disconnected after completing the side effect",
    verification: [{ command: "git status", outcome: "completed side effect confirmed" }],
    payload: {},
    failure_class: "client_disconnect",
    side_effect_state: "completed",
  });
  store.close();

  const resumed = json<{ recovery: { next_command: string } }>(await cli(sandbox, ["run", "resume", runId]));
  assert.equal(
    resumed.recovery.next_command,
    `ai-team dispatch reconcile --run-id ${runId} --dispatch-id ${dispatchId} --role file-explorer --actor-role planning --reason "reconcile confirmed completed side effect"`,
  );
  const reconciled = json<{ action: string; dispatch_id: string; replacement_for: string; reused: boolean }>(await cli(sandbox, [
    "dispatch", "reconcile", "--run-id", runId, "--dispatch-id", dispatchId,
    "--role", "file-explorer", "--actor-role", "planning", "--reason", "confirmed completed side effect",
  ]));
  assert.deepEqual(
    { action: reconciled.action, replacement_for: reconciled.replacement_for, reused: reconciled.reused },
    { action: "reconciled", replacement_for: dispatchId, reused: false },
  );
});

test("Git Operator result validation reports pointer, field, and constraint", async (t) => {
  const sandbox = await makeSandbox(t);
  const store = await StateStore.open(sandbox.aiTeamHome);
  store.registerRepository("repo-cli-envelope", join(sandbox.repo, ".git"), sandbox.repo);
  const runId = store.createRun({ repoId: "repo-cli-envelope", profile: "coding", mode: "feature", request: "validate Git Operator result" });
  const dispatchId = new DispatchService(store).create(runId, "git-operator", {
    objective: "Prepare managed worktrees",
    allowed_read_paths: [],
    allowed_write_paths: [],
    acceptance_criteria: ["Return operation evidence"],
    context: {},
  });
  store.close();

  json(await cli(sandbox, ["dispatch", "claim", "--run-id", runId, "--dispatch-id", dispatchId, "--role", "git-operator"]));
  const resultFile = join(sandbox.root, "invalid-git-result.json");
  await writeFile(resultFile, JSON.stringify({
    ...createResultTemplate(runId, dispatchId, "git-operator"),
    summary: "Prepared worktrees",
    verification: [{ command: "git status", outcome: "passed" }],
    payload: {},
  }));
  const submitted = await cli(sandbox, [
    "dispatch", "submit", "--run-id", runId, "--dispatch-id", dispatchId,
    "--role", "git-operator", "--result-file", resultFile,
  ]);
  assert.equal(submitted.status, 2);
  const failure = JSON.parse(submitted.stderr) as { error: string; details: Array<Record<string, unknown>> };
  assert.equal(failure.error, "result envelope is invalid");
  assert.ok(failure.details.some((detail) => detail.pointer === "/payload/operations" && detail.field === "operations" && detail.constraint === "required"));
});

test("staging CLI initializes frozen dispatch results and consumes only after submit", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Exercise managed staging.\n");
  const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const identity = ["--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"];
  json(await cli(sandbox, ["dispatch", "claim", ...identity]));

  const created = json<{ stagingId: string; state: string; dispatchId: string }>(await cli(sandbox, [
    "staging", "create", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id,
    "--role", "file-explorer", "--kind", "dispatch-result",
  ]));
  assert.equal(created.state, "draft");
  assert.equal(created.dispatchId, started.dispatch_id);
  const stagingPath = join(sandbox.aiTeamHome, "state", "staging", started.run_id, "0001--dispatch-result--file-explorer.json");
  assert.equal((await stat(join(sandbox.aiTeamHome, "state", "staging"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(sandbox.aiTeamHome, "state", "staging", started.run_id))).mode & 0o777, 0o700);
  assert.equal((await stat(stagingPath)).mode & 0o777, 0o600);

  const shown = json<{ entry: { state: string }; content: Record<string, any> }>(await cli(sandbox, [
    "staging", "show", "--run-id", started.run_id, "--role", "file-explorer",
    "--staging-id", created.stagingId, "--content",
  ]));
  assert.equal(shown.content.run_id, started.run_id);
  assert.equal(shown.content.dispatch_id, started.dispatch_id);
  assert.equal(shown.content.role, "file-explorer");
  shown.content.summary = "Located the managed staging entry points.";
  shown.content.verification = [{ command: "staging smoke", outcome: "passed" }];
  shown.content.payload = {
    allowed_read_paths: ["README.md", "MEMORY.md", ".ai-team/index/feature-navigation.md"],
    entry_points: ["README.md"],
    test_commands: ["npm test"],
    project_context: {
      project_shape: "fixture",
      memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
      navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["README.md"], module_boundary: "root" }],
      maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
    },
  };
  const written = json<{ state: string }>(await cliWithInput(sandbox, [
    "staging", "write", "--run-id", started.run_id, "--role", "file-explorer",
    "--staging-id", created.stagingId, "--input-stdin",
  ], JSON.stringify(shown.content)));
  assert.equal(written.state, "ready");

  const validated = json<{ valid: boolean }>(await cli(sandbox, ["dispatch", "validate", ...identity, "--staging-id", created.stagingId]));
  assert.equal(validated.valid, true);
  const afterValidate = json<{ entry: { state: string } }>(await cli(sandbox, [
    "staging", "show", "--run-id", started.run_id, "--role", "file-explorer", "--staging-id", created.stagingId,
  ]));
  assert.equal(afterValidate.entry.state, "ready");

  const resultFile = join(sandbox.root, "result.json");
  await writeFile(resultFile, JSON.stringify(shown.content));
  const exclusive = await cli(sandbox, ["dispatch", "validate", ...identity, "--result-file", resultFile, "--staging-id", created.stagingId]);
  assert.notEqual(exclusive.status, 0);
  assert.match(exclusive.stderr, /exactly one/);

  const submitted = json<{ reused: boolean; artifact: string }>(await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", created.stagingId]));
  assert.equal(submitted.reused, false);
  await stat(submitted.artifact);
  const consumed = json<{ entry: { state: string } }>(await cli(sandbox, [
    "staging", "show", "--run-id", started.run_id, "--role", "file-explorer", "--staging-id", created.stagingId,
  ]));
  assert.equal(consumed.entry.state, "consumed");
  await assert.rejects(stat(stagingPath), { code: "ENOENT" });
});

test("all JSON consumer commands advertise staging-id while retaining file options", async (t) => {
  const sandbox = await makeSandbox(t);
  const consumers = [
    ["context", "update"],
    ["planning", "revision", "validate"],
    ["planning", "revision", "create"],
    ["planning", "tasks", "validate"],
    ["dispatch", "create"],
    ["dispatch", "supersede"],
    ["dispatch", "validate"],
    ["dispatch", "submit"],
    ["decision", "create"],
    ["git", "reconcile"],
    ["research", "archive"],
    ["review", "submit"],
    ["review", "resolve"],
  ];
  for (const command of consumers) {
    const help = await cli(sandbox, [...command, "--help"]);
    assert.equal(help.status, 0, `${command.join(" ")}: ${help.stderr}`);
    assert.match(help.stdout, /--staging-id <id>/, command.join(" "));
    assert.match(help.stdout, /--input-stdin/, command.join(" "));
    assert.match(help.stdout, /--(?:context|documents|result|evidence|report|resolution)?-?file <file>|--packet-file <file>/, command.join(" "));
  }
});

test("every managed JSON command creates retryable staging before parsing stdin", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Exercise every managed stdin entry point.\n");
  const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const store = await StateStore.open(sandbox.aiTeamHome);
  const gitDispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FB9";
  store.db.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at
  ) VALUES (?,?,'git-operator','pending','{}','','{}','{}',?)`).run(gitDispatchId, started.run_id, new Date().toISOString());
  store.close();

  const cases: Array<{ name: string; args: string[] }> = [
    { name: "context update", args: ["context", "update", "--project", sandbox.repo, "--run-id", started.run_id] },
    { name: "revision validate", args: ["planning", "revision", "validate", "--project", sandbox.repo, "--plan-id", "20260817-invalid", "--revision", "001", "--target-branch", "main", "--run-id", started.run_id] },
    { name: "revision create", args: ["planning", "revision", "create", "--project", sandbox.repo, "--plan-id", "20260817-invalid", "--revision", "001", "--target-branch", "main", "--run-id", started.run_id] },
    { name: "tasks validate", args: ["planning", "tasks", "validate", "--run-id", started.run_id] },
    { name: "dispatch create", args: ["dispatch", "create", "--run-id", started.run_id, "--role", "file-explorer", "--actor-role", "planning"] },
    { name: "dispatch supersede", args: ["dispatch", "supersede", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer", "--actor-role", "planning", "--reason", "test invalid input"] },
    { name: "dispatch validate", args: ["dispatch", "validate", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"] },
    { name: "dispatch submit", args: ["dispatch", "submit", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"] },
    { name: "decision create", args: ["decision", "create", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id] },
    { name: "git reconcile", args: ["git", "reconcile", "--run-id", started.run_id, "--dispatch-id", gitDispatchId, "--operation-id", "op_test", "--state", "completed"] },
    { name: "research archive", args: ["research", "archive", "--run-id", started.run_id, "--project", sandbox.repo, "--topic", "stdin"] },
    { name: "review submit", args: ["review", "submit", "--run-id", started.run_id, "--barrier-id", "barrier_test", "--role", "review-spec"] },
    { name: "review resolve", args: ["review", "resolve", "--run-id", started.run_id, "--barrier-id", "barrier_test"] },
  ];
  for (const item of cases) {
    const result = await cliWithInput(sandbox, [...item.args, "--input-stdin"], "{");
    assert.equal(result.status, 2, `${item.name}: ${result.stderr}`);
    const failure = JSON.parse(result.stderr) as { details: { staging_id?: string; state?: string } };
    assert.match(failure.details.staging_id ?? "", /^staging_/, item.name);
    assert.equal(failure.details.state, "draft", item.name);
  }

  const validPacket = JSON.stringify({
    objective: "Create a downstream dispatch",
    allowed_read_paths: ["README.md"],
    allowed_write_paths: [],
    acceptance_criteria: ["Preserve failed input"],
    context: {},
  });
  const dispatchPreflight = await cliWithInput(sandbox, [
    "dispatch", "create", "--run-id", started.run_id, "--role", "file-explorer", "--actor-role", "coding", "--input-stdin",
  ], validPacket);
  assert.equal(dispatchPreflight.status, 2);
  const dispatchFailure = JSON.parse(dispatchPreflight.stderr) as { details: { staging_id: string; state: string } };
  assert.match(dispatchFailure.details.staging_id, /^staging_/);
  assert.equal(dispatchFailure.details.state, "ready");
  assert.match(dispatchPreflight.stderr, /requires --actor-dispatch-id/);

  const gitPreflight = await cliWithInput(sandbox, [
    "git", "reconcile", "--run-id", started.run_id, "--dispatch-id", gitDispatchId,
    "--operation-id", "op_test", "--state", "completed", "--input-stdin",
  ], "{}");
  assert.equal(gitPreflight.status, 2);
  const gitFailure = JSON.parse(gitPreflight.stderr) as { details: { staging_id: string; state: string } };
  assert.match(gitFailure.details.staging_id, /^staging_/);
  assert.equal(gitFailure.details.state, "ready");
  assert.match(gitPreflight.stderr, /must be claimed/);

  const finalStore = await StateStore.open(sandbox.aiTeamHome);
  const run = finalStore.getRun(started.run_id) as { state: string; stage: string };
  assert.deepEqual({ state: run.state, stage: run.stage }, { state: "active", stage: "file-explorer" });
  assert.equal((finalStore.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(started.dispatch_id) as { state: string }).state, "pending");
  finalStore.close();
});

test("direct stdin submit is state-equivalent to explicit staging", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Compare dispatch input paths.\n");

  const executePath = async (direct: boolean) => {
    const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
      "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
    ]));
    const identity = ["--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"];
    const bundle = json<{ template: Record<string, unknown> }>(await cli(sandbox, ["dispatch", "claim", ...identity, "--bundle"]));
    const result = {
      ...bundle.template,
      summary: "Located equivalent input paths.",
      verification: [{ command: "equivalence smoke", outcome: "passed" }],
      payload: {
        allowed_read_paths: ["README.md", "MEMORY.md", ".ai-team/index/feature-navigation.md"],
        entry_points: ["README.md"],
        test_commands: ["npm test"],
        project_context: {
          project_shape: "fixture",
          memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
          navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["README.md"], module_boundary: "root" }],
          maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
        },
      },
    };
    const source = JSON.stringify(result);
    if (direct) {
      json(await cliWithInput(sandbox, ["dispatch", "submit", ...identity, "--input-stdin"], source));
    } else {
      const staging = json<{ stagingId: string }>(await cli(sandbox, [
        "staging", "create", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id,
        "--role", "file-explorer", "--kind", "dispatch-result",
      ]));
      json(await cliWithInput(sandbox, [
        "staging", "write", "--run-id", started.run_id, "--role", "file-explorer",
        "--staging-id", staging.stagingId, "--input-stdin",
      ], source));
      json(await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", staging.stagingId]));
    }
    const database = new Database(join(sandbox.aiTeamHome, "state", "state.sqlite"), { readonly: true });
    const run = database.prepare("SELECT profile,mode,state,stage FROM runs WHERE run_id=?").get(started.run_id);
    const dispatches = database.prepare("SELECT role,state FROM dispatches WHERE run_id=? ORDER BY created_at,dispatch_id").all(started.run_id);
    const events = (database.prepare("SELECT type FROM run_events WHERE run_id=? ORDER BY event_id").all(started.run_id) as Array<{ type: string }>).map(({ type }) => type);
    const staged = database.prepare("SELECT role,kind,state,content_sha256,content_bytes FROM staging_entries WHERE run_id=?").get(started.run_id) as { role: string; kind: string; state: string; content_sha256: string; content_bytes: number };
    const artifact = database.prepare("SELECT path FROM artifacts WHERE run_id=? AND dispatch_id=?").get(started.run_id, started.dispatch_id) as { path: string };
    database.close();
    const artifactValue = JSON.parse(await readFile(artifact.path, "utf8")) as Record<string, unknown>;
    artifactValue.run_id = "<run-id>";
    artifactValue.dispatch_id = "<dispatch-id>";
    assert.equal(staged.content_sha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(staged.content_bytes, Buffer.byteLength(source));
    return { run, dispatches, events, staged: { role: staged.role, kind: staged.kind, state: staged.state }, artifact: artifactValue };
  };

  assert.deepEqual(await executePath(true), await executePath(false));
});

test("dispatch bundle and stdin submit preserve frozen assets, retry state, and continuation", async (t) => {
  const sandbox = await makeSandbox(t);
  json(await cli(sandbox, ["init", sandbox.repo, "--yes"]));
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Exercise the simplified dispatch path.\n");
  const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const identity = ["--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--role", "file-explorer"];
  const bundle = json<{
    reused: boolean;
    packet: Record<string, unknown>;
    prompt: string;
    schema: Record<string, unknown>;
    template: Record<string, any>;
    packet_schema: Record<string, any>;
    packet_template: Record<string, any>;
    digests: Record<string, string>;
    renderer_version: string;
  }>(await cli(sandbox, ["dispatch", "claim", ...identity, "--bundle"]));
  assert.equal(bundle.reused, false);
  assert.deepEqual(bundle.packet, json<{ packet: Record<string, unknown> }>(await cli(sandbox, ["dispatch", "claim", ...identity])).packet);
  assert.equal(bundle.prompt, json(await cli(sandbox, ["dispatch", "prompt", ...identity])));
  assert.deepEqual(bundle.schema, json(await cli(sandbox, ["dispatch", "schema", ...identity])));
  assert.deepEqual(bundle.template, json(await cli(sandbox, ["dispatch", "template", ...identity])));
  assert.deepEqual(bundle.packet_schema, json(await cli(sandbox, ["dispatch", "packet-schema", ...identity])));
  assert.deepEqual(bundle.packet_template, json(await cli(sandbox, ["dispatch", "packet-template", ...identity])));
  assert.deepEqual(bundle.packet_schema.required, ["objective", "allowed_read_paths", "allowed_write_paths", "acceptance_criteria", "context"]);
  assert.equal(bundle.renderer_version, "dispatch-renderer-v5");
  for (const digest of Object.values(bundle.digests)) assert.match(digest, /^[a-f0-9]{64}$/);

  const result = {
    ...bundle.template,
    summary: "Located the simplified dispatch entry points.",
    verification: [{ command: "dispatch stdin smoke", outcome: "passed" }],
    payload: {
      allowed_read_paths: ["README.md", "MEMORY.md", ".ai-team/index/feature-navigation.md"],
      entry_points: ["README.md"],
      test_commands: ["npm test"],
      project_context: {
        project_shape: "fixture",
        memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
        navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["README.md"], module_boundary: "root" }],
        maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
      },
    },
  };

  const invalidJson = await cliWithInput(sandbox, ["dispatch", "submit", ...identity, "--input-stdin"], "{");
  assert.equal(invalidJson.status, 2);
  const invalidJsonError = JSON.parse(invalidJson.stderr) as { details: { staging_id: string; state: string } };
  assert.match(invalidJsonError.details.staging_id, /^staging_/);
  assert.equal(invalidJsonError.details.state, "draft");

  const oversized = await cliWithInput(sandbox, ["dispatch", "submit", ...identity, "--input-stdin"], "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 2);
  const oversizedError = JSON.parse(oversized.stderr) as { details: { staging_id: string; state: string } };
  assert.match(oversizedError.details.staging_id, /^staging_/);
  assert.equal(oversizedError.details.state, "draft");

  const schemaFailure = await cliWithInput(sandbox, ["dispatch", "submit", ...identity, "--input-stdin"], "{}");
  assert.equal(schemaFailure.status, 2);
  const schemaError = JSON.parse(schemaFailure.stderr) as { details: { staging_id: string; state: string; cause: unknown } };
  assert.match(schemaError.details.staging_id, /^staging_/);
  assert.equal(schemaError.details.state, "ready");
  assert.ok(schemaError.details.cause);
  const schemaCause = schemaError.details.cause as { issues: Array<{ pointer: string; constraint: string; suggestion: string }> };
  assert.ok(schemaCause.issues.some((issue) => issue.pointer.startsWith("/") && issue.constraint && issue.suggestion.includes("Correct")));
  const failureStore = await StateStore.open(sandbox.aiTeamHome);
  const failureEvent = failureStore.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='staging.validation_failed' ORDER BY event_id DESC LIMIT 1").get(started.run_id) as { payload_json: string };
  const eventCause = JSON.parse(failureEvent.payload_json).cause as { issues: Array<{ pointer: string; constraint: string; suggestion: string }> };
  assert.ok(eventCause.issues.some((issue) => issue.pointer.startsWith("/") && issue.constraint && issue.suggestion));

  const invalidReadyJson = "{";
  const stagingRow = failureStore.db.prepare("SELECT sequence_no,kind,role FROM staging_entries WHERE staging_id=?").get(schemaError.details.staging_id) as { sequence_no: number; kind: "dispatch-result"; role: "file-explorer" };
  await writeFile(stagingFilePath(failureStore.paths.staging, started.run_id, stagingRow.sequence_no, stagingRow.kind, stagingRow.role), invalidReadyJson);
  failureStore.db.prepare("UPDATE staging_entries SET content_sha256=?,content_bytes=? WHERE staging_id=?")
    .run(createHash("sha256").update(invalidReadyJson).digest("hex"), Buffer.byteLength(invalidReadyJson), schemaError.details.staging_id);
  const failureCount = (failureStore.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='staging.validation_failed'").get(started.run_id) as { count: number }).count;
  failureStore.close();
  const invalidReadyFailure = await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", schemaError.details.staging_id]);
  assert.notEqual(invalidReadyFailure.status, 0);
  const invalidReadyStore = await StateStore.open(sandbox.aiTeamHome, { readonly: true });
  assert.equal(invalidReadyStore.getStagingEntry(schemaError.details.staging_id).state, "ready");
  assert.equal((invalidReadyStore.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='staging.validation_failed'").get(started.run_id) as { count: number }).count, failureCount + 1);
  invalidReadyStore.close();

  const wrongIdentity = { ...result, run_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV" };
  const rewritten = json<{ state: string }>(await cliWithInput(sandbox, [
    "staging", "write", "--run-id", started.run_id, "--role", "file-explorer",
    "--staging-id", schemaError.details.staging_id, "--input-stdin",
  ], JSON.stringify(wrongIdentity)));
  assert.equal(rewritten.state, "ready");
  const identityFailure = await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", schemaError.details.staging_id]);
  assert.equal(identityFailure.status, 2);
  const identityError = JSON.parse(identityFailure.stderr) as { details: { staging_id: string; state: string } };
  assert.equal(identityError.details.staging_id, schemaError.details.staging_id);
  assert.equal(identityError.details.state, "ready");

  json(await cliWithInput(sandbox, [
    "staging", "write", "--run-id", started.run_id, "--role", "file-explorer",
    "--staging-id", schemaError.details.staging_id, "--input-stdin",
  ], JSON.stringify(result)));
  const submitted = json<{
    reused: boolean;
    staging: { staging_id: string; state: string; content_digest: string };
    continuation: { run_state: string; run_stage: string; pending_dispatches: Array<{ dispatch_id: string; role: string; state: string; depends_on: string[] }>; pending_decision: unknown };
  }>(await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", schemaError.details.staging_id]));
  assert.equal(submitted.reused, false);
  assert.deepEqual(submitted.staging, { staging_id: schemaError.details.staging_id, state: "consumed", content_digest: submitted.staging.content_digest });
  assert.match(submitted.staging.content_digest, /^[a-f0-9]{64}$/);

  const shown = json<{ run: { state: string; stage: string }; dispatches: Array<{ dispatch_id: string; role: string; state: string }>; decisions: Array<{ status: string }>; continuation: typeof submitted.continuation; pending_dependencies: Array<{ dispatch_id: string; depends_on: string[] }>; suggested_commands: string[] }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.equal(submitted.continuation.run_state, shown.run.state);
  assert.equal(submitted.continuation.run_stage, shown.run.stage);
  assert.deepEqual(submitted.continuation.pending_dispatches.map(({ dispatch_id, role, state }) => ({ dispatch_id, role, state })), shown.dispatches.filter(({ state }) => state === "pending" || state === "claimed").map(({ dispatch_id, role, state }) => ({ dispatch_id, role, state })));
  assert.deepEqual(submitted.continuation.pending_dispatches[0]?.depends_on, [started.dispatch_id]);
  assert.equal(submitted.continuation.pending_decision, shown.decisions.find(({ status }) => status === "pending") ?? null);
  assert.deepEqual(shown.continuation, submitted.continuation);
  assert.deepEqual(shown.pending_dependencies, submitted.continuation.pending_dispatches.map(({ dispatch_id, depends_on }) => ({ dispatch_id, depends_on })));
  assert.ok(shown.suggested_commands.some((command) => command.includes(`dispatch claim --run-id ${started.run_id}`)));

  const second = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const secondIdentity = ["--run-id", second.run_id, "--dispatch-id", second.dispatch_id, "--role", "file-explorer"];
  json<typeof bundle>(await cli(sandbox, ["dispatch", "claim", ...secondIdentity, "--bundle"]));
  const directResult = { ...result, run_id: second.run_id, dispatch_id: second.dispatch_id };
  const direct = json<{ staging: { state: string }; continuation: { pending_dispatches: unknown[] } }>(await cliWithInput(
    sandbox,
    ["dispatch", "submit", ...secondIdentity, "--input-stdin"],
    JSON.stringify(directResult),
  ));
  assert.equal(direct.staging.state, "consumed");
  assert.equal(direct.continuation.pending_dispatches.length, 1);
});
