import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";
import { createResultTemplate } from "../src/contracts.js";
import { DispatchService } from "../src/dispatch.js";
import { StateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  root: string;
  repo: string;
  aiTeamHome: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
}

const execute = async (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(file, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      encoding: "utf8",
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { status: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const cli = async (sandbox: Sandbox, args: string[]): Promise<CommandResult> =>
  execute(process.execPath, [CLI, ...args], { cwd: sandbox.repo, env: sandbox.env });

const cliWithInput = async (sandbox: Sandbox, args: string[], input: string): Promise<CommandResult> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: sandbox.repo, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  child.stdin.end(input);
});

const git = async (sandbox: Sandbox, args: string[]): Promise<CommandResult> =>
  execute("git", args, { cwd: sandbox.repo, env: sandbox.env });

const json = <T>(result: CommandResult): T => {
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: T } & Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "ok"]);
  assert.equal(envelope.ok, true);
  return envelope.data;
};

const makeSandbox = async (t: test.TestContext): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-cli-e2e-"));
  const sandbox: Sandbox = {
    root,
    repo: join(root, "repo"),
    aiTeamHome: join(root, "ai-team-home"),
    userHome: join(root, "user-home"),
    env: {},
  };
  await Promise.all([mkdir(sandbox.repo), mkdir(sandbox.userHome)]);
  sandbox.env = {
    ...process.env,
    AI_TEAM_HOME: sandbox.aiTeamHome,
    HOME: sandbox.userHome,
    XDG_CONFIG_HOME: join(sandbox.userHome, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal((await git(sandbox, ["init", "-b", "main"])).status, 0);
  assert.equal((await git(sandbox, ["config", "user.name", "CLI E2E"])).status, 0);
  assert.equal((await git(sandbox, ["config", "user.email", "cli-e2e@example.invalid"])).status, 0);
  await writeFile(join(sandbox.repo, "README.md"), "# fixture\n");
  assert.equal((await git(sandbox, ["add", "README.md"])).status, 0);
  assert.equal((await git(sandbox, ["commit", "-m", "fixture"])).status, 0);
  return sandbox;
};

test("CLI help and contract expose the installed command contract", async (t) => {
  const sandbox = await makeSandbox(t);

  const help = await cli(sandbox, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Local AI coding team workflow orchestration/);
  for (const command of ["init", "planning", "coding", "run", "dispatch", "env", "contract"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }

  const contract = json<{ contract_digest: string; role_manifest_digest: string; roles: string[] }>(
    await cli(sandbox, ["contract"]),
  );
  assert.match(contract.contract_digest, /^[a-f0-9]{64}$/);
  assert.match(contract.role_manifest_digest, /^[a-f0-9]{64}$/);
  assert.ok(contract.roles.includes("file-explorer"));
  assert.ok(contract.roles.includes("test"));
});

test("CLI JSON output is stable by default and exposes top-level fields only in legacy mode", async (t) => {
  const sandbox = await makeSandbox(t);
  const current = JSON.parse((await cli(sandbox, ["contract"])).stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(current).sort(), ["data", "ok"]);

  const legacy = JSON.parse((await cli(sandbox, ["--legacy-output", "contract"])).stdout) as Record<string, unknown>;
  assert.equal(legacy.ok, true);
  assert.ok(legacy.data);
  assert.equal(typeof legacy.contract_digest, "string");

  const failure = await cli(sandbox, ["planning", "start", "--project", sandbox.repo]);
  assert.equal(failure.status, 2);
  const error = JSON.parse(failure.stderr.trim().split("\n").at(-1) ?? "null") as Record<string, unknown>;
  assert.deepEqual(Object.keys(error).sort(), ["code", "details", "error", "ok"]);
  assert.equal(error.ok, false);
});

test("planning revision creation enforces task preview approval and preserves retry state", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "planning-request.md");
  await writeFile(requestFile, "Plan revision approval recovery.\n");
  const first = json<{ run_id: string }>(await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]));

  const spec = [
    "# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景",
    "## 功能需求", "REQ-001", "## 验收标准", "AC-001", "## 数据与接口", "无", "## 兼容约束", "无",
    "## 安全约束", "无", "## 错误与边界", "无", "## 迁移发布回滚", "回滚", "## 已确认偏好", "无",
    "## 默认取舍", "无", "## 已关闭问题", "无", "## 未决问题", "无",
  ].join("\n");
  const plan = (coverage: string) => [
    "# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", coverage,
    "## 验证", "验证", "## 发布与回滚", "回滚",
  ].join("\n");
  const simpleDocuments = { spec, plan: plan("REQ-001 AC-001") };
  const taskDocuments = {
    spec,
    plan: plan("REQ-001"),
    tasks: "# Tasks\nAC-001\nTASK-001",
    taskFiles: { "TASK-001": "# TASK-001\nREQ-001\nAC-001" },
  };
  const approvalChoices = [
    { id: "approve", label: "Approve", impact: "Create task documents" },
    { id: "revise", label: "Revise", impact: "Require another preview" },
  ];

  const store = await StateStore.open(sandbox.aiTeamHome);
  const repository = store.db.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(first.run_id) as { repo_id: string };
  const makeRun = (): string => store.createRun({ repoId: repository.repo_id, profile: "planning", mode: "planned", request: "revision approval" });
  const prepare = async (runId: string, documents: unknown, stage: "plan_ready" | "tasks_preview", choice?: "approve" | "revise") => {
    store.db.prepare("UPDATE runs SET stage=?,state=? WHERE run_id=?").run(stage, stage === "tasks_preview" && !choice ? "needs_decision" : "active", runId);
    let decisionId: string | undefined;
    if (stage === "tasks_preview") {
      decisionId = store.createDecision(runId, "Approve this task preview?", approvalChoices, "approve", "task_preview");
      if (choice) store.decide(runId, decisionId, choice);
    }
    const staging = await store.createStagingEntry({ runId, role: "planning", kind: "planning-documents", initialJson: JSON.stringify(documents) });
    return { decisionId, stagingId: staging.stagingId };
  };
  const noTaskRun = makeRun();
  const noTask = await prepare(noTaskRun, simpleDocuments, "plan_ready");
  const pendingRun = makeRun();
  const pending = await prepare(pendingRun, taskDocuments, "tasks_preview");
  const reviseRun = makeRun();
  const revise = await prepare(reviseRun, taskDocuments, "tasks_preview", "revise");
  store.close();

  const args = (command: "validate" | "create", planId: string, runId: string, stagingId: string) => [
    "planning", "revision", command, "--project", sandbox.repo, "--plan-id", planId, "--revision", "001",
    "--target-branch", "main", "--run-id", runId, "--staging-id", stagingId,
  ];
  const noTaskResult = json<{ path: string }>(await cli(sandbox, args("create", "20260816-no-task", noTaskRun, noTask.stagingId)));
  assert.equal(noTaskResult.path, join(sandbox.repo, ".ai-team", "plans", "20260816-no-task", "revisions", "001"));

  const pendingPlanId = "20260816-pending-task";
  const pendingPath = join(sandbox.repo, ".ai-team", "plans", pendingPlanId, "revisions", "001");
  const pendingValidation = await cli(sandbox, args("validate", pendingPlanId, pendingRun, pending.stagingId));
  assert.notEqual(pendingValidation.status, 0);
  assert.match(pendingValidation.stderr, /task preview decision must be resolved/);
  const pendingCreate = await cli(sandbox, args("create", pendingPlanId, pendingRun, pending.stagingId));
  assert.notEqual(pendingCreate.status, 0);
  assert.match(pendingCreate.stderr, /task preview decision must be resolved/);
  await assert.rejects(stat(pendingPath), { code: "ENOENT" });

  const revisePlanId = "20260816-revise-task";
  const reviseCreate = await cli(sandbox, args("create", revisePlanId, reviseRun, revise.stagingId));
  assert.notEqual(reviseCreate.status, 0);
  assert.match(reviseCreate.stderr, /task preview must be approved/);
  await assert.rejects(stat(join(sandbox.repo, ".ai-team", "plans", revisePlanId, "revisions", "001")), { code: "ENOENT" });

  const retryStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal((retryStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id IN (?,?)").get(pendingPlanId, revisePlanId) as { count: number }).count, 0);
  assert.equal(retryStore.getStagingEntry(pending.stagingId).state, "draft");
  assert.equal(retryStore.getStagingEntry(revise.stagingId).state, "draft");
  retryStore.decide(pendingRun, pending.decisionId!, "approve");
  retryStore.db.prepare("UPDATE runs SET state='active' WHERE run_id=?").run(pendingRun);
  retryStore.close();

  const validation = json<{ path: string; digest: string; valid: boolean }>(await cli(sandbox, args("validate", pendingPlanId, pendingRun, pending.stagingId)));
  assert.equal(validation.valid, true);
  await assert.rejects(stat(pendingPath), { code: "ENOENT" });
  const validatedStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal(validatedStore.getStagingEntry(pending.stagingId).state, "draft");
  assert.equal((validatedStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id=?").get(pendingPlanId) as { count: number }).count, 0);
  validatedStore.close();

  json(await cli(sandbox, args("create", pendingPlanId, pendingRun, pending.stagingId)));
  assert.match(await readFile(join(pendingPath, "tasks.md"), "utf8"), /TASK-001/);
  assert.match(await readFile(join(pendingPath, "tasks", "TASK-001.md"), "utf8"), /AC-001/);
  const completedStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal(completedStore.getStagingEntry(pending.stagingId).state, "consumed");
  assert.equal((completedStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id=?").get(pendingPlanId) as { count: number }).count, 1);
  completedStore.close();

  const transitioned = json<{ state: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "revision", "transition", "--project", sandbox.repo, "--plan-id", pendingPlanId,
    "--revision", "001", "--to", "plan_ready",
  ]));
  assert.equal(transitioned.state, "plan_ready");
  const transitionStore = await StateStore.open(sandbox.aiTeamHome);
  assert.deepEqual(
    transitionStore.db.prepare("SELECT role,state FROM dispatches WHERE dispatch_id=?").get(transitioned.dispatch_id),
    { role: "git-operator", state: "pending" },
  );
  transitionStore.close();

  const documentsFile = join(sandbox.root, "task-documents.json");
  await writeFile(documentsFile, JSON.stringify(taskDocuments));
  const duplicate = await cli(sandbox, [
    "planning", "revision", "create", "--project", sandbox.repo, "--plan-id", pendingPlanId, "--revision", "001",
    "--target-branch", "main", "--run-id", pendingRun, "--documents-file", documentsFile,
  ]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /revisions are immutable/);
});

test("planning revision create stdin preserves failed preflight staging for retry", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "planning-request.md");
  await writeFile(requestFile, "Exercise direct revision input.\n");
  const started = json<{ run_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const documents = {
    spec: [
      "# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景",
      "## 功能需求", "REQ-001", "## 验收标准", "AC-001", "## 数据与接口", "无", "## 兼容约束", "无",
      "## 安全约束", "无", "## 错误与边界", "无", "## 迁移发布回滚", "回滚", "## 已确认偏好", "无",
      "## 默认取舍", "无", "## 已关闭问题", "无", "## 未决问题", "无",
    ].join("\n"),
    plan: ["# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", "REQ-001 AC-001", "## 验证", "验证", "## 发布与回滚", "回滚"].join("\n"),
  };
  const args = [
    "planning", "revision", "create", "--project", sandbox.repo,
    "--plan-id", "20260817-stdin-revision", "--revision", "001", "--target-branch", "main",
    "--run-id", started.run_id,
  ];
  const validateBlocked = await cliWithInput(sandbox, [
    ...args.slice(0, 2), "validate", ...args.slice(3), "--input-stdin",
  ], JSON.stringify(documents));
  assert.equal(validateBlocked.status, 2);
  const validateFailure = JSON.parse(validateBlocked.stderr) as { details: { staging_id: string; state: string } };
  assert.match(validateFailure.details.staging_id, /^staging_/);
  assert.equal(validateFailure.details.state, "ready");

  const blocked = await cliWithInput(sandbox, [...args, "--input-stdin"], JSON.stringify(documents));
  assert.equal(blocked.status, 2);
  const failure = JSON.parse(blocked.stderr) as { details: { staging_id: string; state: string } };
  assert.match(failure.details.staging_id, /^staging_/);
  assert.equal(failure.details.state, "ready");
  await assert.rejects(stat(join(sandbox.repo, ".ai-team", "plans", "20260817-stdin-revision", "revisions", "001")), { code: "ENOENT" });

  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM revisions WHERE plan_id=? AND revision=?").get("20260817-stdin-revision", "001") as { count: number }).count, 0);
  database.prepare("UPDATE runs SET stage='plan_ready' WHERE run_id=?").run(started.run_id);
  database.close();

  const created = json<{ staging: { staging_id: string; state: string }; digest: string }>(await cli(sandbox, [
    ...args, "--staging-id", failure.details.staging_id,
  ]));
  assert.equal(created.staging.staging_id, failure.details.staging_id);
  assert.equal(created.staging.state, "consumed");
  assert.match(created.digest, /^[a-f0-9]{64}$/);
  await stat(join(sandbox.repo, ".ai-team", "plans", "20260817-stdin-revision", "revisions", "001", "spec.md"));
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

test("CLI syntax errors use one JSON stderr object and exit code 5", async (t) => {
  const sandbox = await makeSandbox(t);
  const cases = [
    ["missing-command"],
    ["env", "validate"],
    ["env", "list", "--unknown"],
    ["env", "generate", "--platform", "missing"],
    ["env", "explain", "balanced", "--role", "missing", "--platform", "codex"],
  ];

  for (const args of cases) {
    const result = await cli(sandbox, args);
    assert.equal(result.status, 5, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1, `${args.join(" ")}: ${result.stderr}`);
    const failure = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(failure).sort(), ["code", "details", "error", "ok"]);
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 5);
    assert.equal(failure.details, null);
  }
});

test("CLI help and version preserve Commander success output", async (t) => {
  const sandbox = await makeSandbox(t);
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };

  const help = await cli(sandbox, ["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: ai-team/m);

  const version = await cli(sandbox, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout, `${manifest.version}\n`);
});

test("CLI human syntax errors remain human-readable", async (t) => {
  const sandbox = await makeSandbox(t);
  const result = await cli(sandbox, ["--human", "env", "explain", "balanced", "--role", "missing", "--platform", "codex"]);
  assert.equal(result.status, 5);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ok: false$/m);
  assert.doesNotMatch(result.stderr, /^\{/);
});

test("decision commands expose a template and return field-level errors for empty JSON", async (t) => {
  const sandbox = await makeSandbox(t);
  const schema = json<Record<string, any>>(await cli(sandbox, ["decision", "schema"]));
  const template = json<Record<string, any>>(await cli(sandbox, ["decision", "template"]));
  assert.deepEqual(schema.required, ["question", "choices"]);
  assert.equal(template.choices.length, 2);

  const requestFile = join(sandbox.root, "decision-request.md");
  await writeFile(requestFile, "Need a decision.\n");
  const started = json<{ run_id: string; dispatch_id: string }>(await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]));
  const empty = join(sandbox.root, "empty-decision.json");
  await writeFile(empty, "{}\n");
  const failed = await cli(sandbox, ["decision", "create", "--run-id", started.run_id, "--dispatch-id", started.dispatch_id, "--file", empty]);
  assert.equal(failed.status, 2);
  const error = JSON.parse(failed.stderr.trim().split("\n").at(-1) ?? "null") as { details: Array<{ path: string }> };
  assert.deepEqual(error.details.map((item) => item.path).sort(), ["/choices", "/question"]);
});

test("CLI entrypoint executes through a symlinked path", async (t) => {
  const sandbox = await makeSandbox(t);
  const linkedCli = join(sandbox.root, "linked cli.js");
  await symlink(CLI, linkedCli);
  const contract = json<{ contract_digest: string }>(
    await execute(process.execPath, [linkedCli, "contract"], { cwd: sandbox.repo, env: sandbox.env }),
  );
  assert.match(contract.contract_digest, /^[a-f0-9]{64}$/);
});

test("init creates project metadata, context skeletons, and documented ignore entries", async (t) => {
  const sandbox = await makeSandbox(t);

  const initialized = json<{
    project: string;
    additions: string[];
    gitignoreDirty: boolean;
    patch: string;
  }>(await cli(sandbox, ["init", sandbox.repo]));

  assert.equal(initialized.project, await realpath(sandbox.repo));
  assert.equal(initialized.gitignoreDirty, false);
  assert.deepEqual(initialized.additions, ["/.worktrees/", "/.ai-team/runtime/"]);
  assert.equal(initialized.patch, "+/.worktrees/\n+/.ai-team/runtime/");
  assert.equal(await readFile(join(sandbox.repo, ".gitignore"), "utf8"), "/.worktrees/\n/.ai-team/runtime/\n");
  const project = await readFile(join(sandbox.repo, ".ai-team", "project.yaml"), "utf8");
  assert.match(project, /schema_version: 1/);
  assert.match(project, /repo_id:/);
  assert.match(await readFile(join(sandbox.repo, "MEMORY.md"), "utf8"), /## 项目上下文/);
  assert.match(await readFile(join(sandbox.repo, ".ai-team", "index", "feature-navigation.md"), "utf8"), /# 功能导航/);
});

test("context update accepts File Explorer output and validate reports maintenance state", async (t) => {
  const sandbox = await makeSandbox(t);
  await cli(sandbox, ["init", sandbox.repo]);
  const explorerResult = join(sandbox.root, "explorer-result.json");
  await writeFile(explorerResult, JSON.stringify({
    payload: {
      project_context: {
        project_shape: "Node.js CLI",
        memory: {
          domain_terms: ["dispatch"],
          repository_constraints: ["Node.js 22+"],
          responsibilities: ["README documents the fixture"],
          module_boundaries: ["root documentation"],
        },
        navigation: [{ feature: "Fixture", keywords: ["readme"], entry_paths: ["README.md"], module_boundary: "root" }],
        maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
      },
    },
  }));
  const updated = json<{ updated_paths: string[] }>(await cli(sandbox, [
    "context", "update", "--project", sandbox.repo, "--context-file", explorerResult,
  ]));
  assert.deepEqual(updated.updated_paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md"]);
  const validation = json<{ valid: boolean; navigation: { entries: number }; maintenance: { status: string; paths: string[] } }>(
    await cli(sandbox, ["context", "validate", "--project", sandbox.repo]),
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.navigation.entries, 1);
  assert.deepEqual(validation.maintenance, { status: "current", paths: [] });

  const memoryPath = join(sandbox.repo, "MEMORY.md");
  const navigationPath = join(sandbox.repo, ".ai-team", "index", "feature-navigation.md");
  const formatLine = /^<!-- ai-team:context-format .* -->\n/gm;
  await writeFile(memoryPath, (await readFile(memoryPath, "utf8")).replace(formatLine, ""));
  await writeFile(navigationPath, (await readFile(navigationPath, "utf8")).replace(formatLine, "").replace("# 功能导航", "# Feature Navigation"));
  const legacy = json<{ valid: boolean; navigation: { issues: string[] }; maintenance: { status: string } }>(
    await cli(sandbox, ["context", "validate", "--project", sandbox.repo]),
  );
  assert.equal(legacy.valid, false);
  assert.equal(legacy.maintenance.status, "needs_update");
  assert.ok(legacy.navigation.issues.some((issue) => issue.includes("ai-team context update")));
  const businessBefore = await readFile(join(sandbox.repo, "README.md"), "utf8");
  json(await cli(sandbox, ["context", "update", "--project", sandbox.repo, "--context-file", explorerResult]));
  assert.equal((json<{ valid: boolean }>(await cli(sandbox, ["context", "validate", "--project", sandbox.repo]))).valid, true);
  assert.match(await readFile(navigationPath, "utf8"), /schema_version.*2/);
  assert.equal(await readFile(join(sandbox.repo, "README.md"), "utf8"), businessBefore);
});

test("context validate diagnoses and init migrates the legacy navigation path", async (t) => {
  const sandbox = await makeSandbox(t);
  json(await cli(sandbox, ["init", sandbox.repo]));
  const canonicalPath = join(sandbox.repo, ".ai-team", "index", "feature-navigation.md");
  const legacyPath = join(sandbox.repo, ".ai-work-flow", "index", "feature-navigation.md");
  await mkdir(join(sandbox.repo, ".ai-work-flow", "index"), { recursive: true });
  await rename(canonicalPath, legacyPath);
  await writeFile(join(sandbox.repo, "MEMORY.md"), `${await readFile(join(sandbox.repo, "MEMORY.md"), "utf8")}\nLegacy: .ai-work-flow/index/feature-navigation.md\n`);

  const diagnosed = json<{ valid: boolean; navigation: { issues: string[] } }>(await cli(sandbox, ["context", "validate", "--project", sandbox.repo]));
  assert.equal(diagnosed.valid, false);
  assert.ok(diagnosed.navigation.issues.some((issue) => issue.includes(".ai-work-flow/index/feature-navigation.md") && issue.includes("ai-team init")));

  json(await cli(sandbox, ["init", sandbox.repo, "--yes"]));
  await stat(canonicalPath);
  await assert.rejects(stat(legacyPath));
  assert.doesNotMatch(await readFile(join(sandbox.repo, "MEMORY.md"), "utf8"), /\.ai-work-flow\/index\/feature-navigation\.md/);
  assert.equal(json<{ valid: boolean }>(await cli(sandbox, ["context", "validate", "--project", sandbox.repo])).valid, true);
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
    digests: Record<string, string>;
    renderer_version: string;
  }>(await cli(sandbox, ["dispatch", "claim", ...identity, "--bundle"]));
  assert.equal(bundle.reused, false);
  assert.deepEqual(bundle.packet, json<{ packet: Record<string, unknown> }>(await cli(sandbox, ["dispatch", "claim", ...identity])).packet);
  assert.equal(bundle.prompt, json(await cli(sandbox, ["dispatch", "prompt", ...identity])));
  assert.deepEqual(bundle.schema, json(await cli(sandbox, ["dispatch", "schema", ...identity])));
  assert.deepEqual(bundle.template, json(await cli(sandbox, ["dispatch", "template", ...identity])));
  assert.equal(bundle.renderer_version, "dispatch-renderer-v3");
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
    continuation: { run_state: string; run_stage: string; pending_dispatches: Array<{ dispatch_id: string; role: string; state: string }>; pending_decision: unknown };
  }>(await cli(sandbox, ["dispatch", "submit", ...identity, "--staging-id", schemaError.details.staging_id]));
  assert.equal(submitted.reused, false);
  assert.deepEqual(submitted.staging, { staging_id: schemaError.details.staging_id, state: "consumed", content_digest: submitted.staging.content_digest });
  assert.match(submitted.staging.content_digest, /^[a-f0-9]{64}$/);

  const shown = json<{ run: { state: string; stage: string }; dispatches: Array<{ dispatch_id: string; role: string; state: string }>; decisions: Array<{ status: string }> }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.equal(submitted.continuation.run_state, shown.run.state);
  assert.equal(submitted.continuation.run_stage, shown.run.stage);
  assert.deepEqual(submitted.continuation.pending_dispatches, shown.dispatches.filter(({ state }) => state === "pending" || state === "claimed").map(({ dispatch_id, role, state }) => ({ dispatch_id, role, state })));
  assert.equal(submitted.continuation.pending_decision, shown.decisions.find(({ status }) => status === "pending") ?? null);

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

test("planning dispatch can be claimed, inspected, submitted, resumed, and decided", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Plan a documented CLI change.\n");

  const missingRequest = await cli(sandbox, ["planning", "start", "--project", sandbox.repo]);
  assert.equal(missingRequest.status, 2);
  assert.match(missingRequest.stderr, /requires exactly one of requestFile, requestStdin|provide exactly one/);

  const started = json<{ run_id: string; dispatch_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  assert.match(started.run_id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(started.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);

  const identity = [
    "--run-id", started.run_id,
    "--dispatch-id", started.dispatch_id,
    "--role", "file-explorer",
  ];
  const claim = json<{ reused: boolean; packet: { objective: string; allowed_write_paths: string[] } }>(
    await cli(sandbox, ["dispatch", "claim", ...identity]),
  );
  assert.equal(claim.reused, false);
  assert.deepEqual(claim.packet.allowed_write_paths, []);
  assert.match(claim.packet.objective, /Explore the repository/);

  const prompt = json<string>(await cli(sandbox, ["dispatch", "prompt", ...identity]));
  assert.match(prompt, new RegExp(`Dispatch: ${started.dispatch_id}`));
  assert.match(prompt, /Role: file-explorer/);
  const legacyPrompt = await cli(sandbox, ["--legacy-output", "dispatch", "prompt", ...identity]);
  assert.equal(legacyPrompt.status, 0, legacyPrompt.stderr);
  assert.equal(legacyPrompt.stdout, `${prompt}\n`);

  const schema = json<{ type: string; required: string[] }>(await cli(sandbox, ["dispatch", "schema", ...identity]));
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes("run_id"));
  assert.ok(schema.required.includes("verification"));

  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath, { readonly: true });
  const row = database.prepare("SELECT template_json FROM dispatches WHERE dispatch_id=?").get(started.dispatch_id) as {
    template_json: string;
  };
  database.close();
  const result = JSON.parse(row.template_json) as Record<string, unknown>;
  result.summary = "Repository entry points and tests were identified.";
  result.verification = [{ command: "git status --short", outcome: "passed" }];
  result.payload = {
    allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "README.md"],
    entry_points: ["README.md"],
    test_commands: ["npm test"],
    project_context: {
      project_shape: "documentation fixture",
      memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
      navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["README.md"], module_boundary: "root" }],
      maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
    },
  };
  const resultFile = join(sandbox.root, "result.json");
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);

  const submitted = json<{ reused: boolean; artifact: string }>(
    await cli(sandbox, ["dispatch", "submit", ...identity, "--result-file", resultFile]),
  );
  assert.equal(submitted.reused, false);
  await stat(submitted.artifact);

  const shown = json<{
    run: { run_id: string; profile: string };
    events: Array<{ type: string }>;
    dispatches: Array<{ dispatch_id: string; state: string }>;
  }>(await cli(sandbox, ["run", "show", started.run_id]));
  assert.equal(shown.run.profile, "planning");
  assert.ok(shown.events.some(({ type }) => type === "dispatch.completed"));
  assert.deepEqual(shown.dispatches.map(({ state }) => state), ["completed", "pending"]);

  const decisionFile = join(sandbox.root, "decision.json");
  await writeFile(decisionFile, JSON.stringify({
    question: "Which implementation path?",
    choices: [
      { id: "minimal", label: "Minimal", impact: "Smallest scope" },
      { id: "broad", label: "Broad", impact: "Larger scope" },
    ],
    recommendation: "minimal",
  }));
  const decision = json<{ decision_id: string }>(
    await cli(sandbox, ["decision", "create", "--run-id", started.run_id, "--dispatch-id", shown.dispatches.at(-1)!.dispatch_id, "--file", decisionFile]),
  );
  const resumed = json<{
    pending_dispatches: unknown[];
    pending_decision: { decision_id: string; status: string };
    pending_operations: unknown[];
    last_event: { type: string };
  }>(await cli(sandbox, ["run", "resume", started.run_id]));
  assert.equal(resumed.pending_dispatches.length, 1);
  assert.equal(resumed.pending_decision.decision_id, decision.decision_id);
  assert.equal(resumed.pending_decision.status, "pending");
  assert.deepEqual(resumed.pending_operations, []);
  assert.equal(resumed.last_event.type, "run.stage_changed");

  const noteFile = join(sandbox.root, "note.txt");
  await writeFile(noteFile, "Keep the change narrowly scoped.\n");
  const resolved = json<{ status: string; dispatch_id: string }>(await cli(sandbox, [
      "run", "decide",
      "--run-id", started.run_id,
      "--decision-id", decision.decision_id,
      "--choice", "minimal",
      "--note-file", noteFile,
    ]));
  assert.equal(resolved.status, "resolved");
  assert.match(resolved.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
  const finalState = json<{ decisions: Array<{ status: string; choice: string; note: string }> }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.deepEqual(finalState.decisions.map(({ status, choice, note }) => ({ status, choice, note })), [{
    status: "resolved",
    choice: "minimal",
    note: "Keep the change narrowly scoped.\n",
  }]);
});

test("planning no_change submit consumes one staging entry and leaves a terminal run", async (t) => {
  const sandbox = await makeSandbox(t);
  const store = await StateStore.open(sandbox.aiTeamHome);
  const repoId = "repo-cli-no-change";
  store.registerRepository(repoId, join(sandbox.repo, ".git"), sandbox.repo);
  const runId = store.createRun({ repoId, profile: "planning", mode: "planned", request: "Verify the implementation already at HEAD" });
  store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
  const dispatches = new DispatchService(store);
  const packet = {
    objective: "Confirm whether the existing implementation should close the run",
    allowed_read_paths: ["README.md"],
    allowed_write_paths: [],
    acceptance_criteria: ["Record the user choice"],
    context: {},
  };
  const questionDispatch = dispatches.create(runId, "planning", packet, "planning");
  dispatches.claim(runId, questionDispatch, "planning");
  const question = "The requested behavior exists at HEAD. How should this run finish?";
  const decision = {
    question,
    choices: [
      { id: "verify_existing", label: "Verify existing", impact: "Finish without changes" },
      { id: "plan_changes", label: "Plan changes", impact: "Continue planning" },
    ],
    recommendation: "verify_existing",
  };
  await dispatches.submitValue(runId, questionDispatch, "planning", {
    ...createResultTemplate(runId, questionDispatch, "planning"),
    summary: "HEAD behavior was presented for confirmation.",
    verification: [{ command: "git show HEAD", outcome: "Requested behavior is present" }],
    payload: { actions: ["confirm existing implementation"], stage: "requirements", pending_questions: [question], decision },
  });
  const decisionId = (store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=?").get(runId) as { decision_id: string }).decision_id;
  const continuationId = dispatches.resolvePlanningDecision(runId, decisionId, "verify_existing");
  const result = {
    ...dispatches.template(runId, continuationId, "planning"),
    summary: "The run completed without repository changes.",
    verification: [{ command: "npm test", outcome: "Existing implementation passed" }],
    payload: {
      actions: ["record no-change completion"],
      stage: "no_change",
      pending_questions: [],
      decision: null,
      no_change: {
        decision_id: decisionId,
        conclusion: "The requested behavior is already implemented at HEAD.",
        repository_evidence: [{ command: "git show HEAD", outcome: "Implementation and tests are present" }],
      },
    },
  };
  store.close();

  json(await cli(sandbox, ["dispatch", "claim", "--run-id", runId, "--dispatch-id", continuationId, "--role", "planning"]));
  const submitted = json<{
    reused: boolean;
    submission: { state: string; artifact_id: string; digest: string };
    staging: { staging_id: string; state: string };
    continuation: { run_state: string; run_stage: string; pending_dispatches: unknown[]; pending_decision: unknown };
  }>(await cliWithInput(sandbox, [
    "dispatch", "submit", "--run-id", runId, "--dispatch-id", continuationId, "--role", "planning", "--input-stdin",
  ], JSON.stringify(result)));
  assert.equal(submitted.reused, false);
  assert.equal(submitted.submission.state, "submitted");
  assert.match(submitted.submission.artifact_id, /^artifact_/);
  assert.match(submitted.submission.digest, /^[a-f0-9]{64}$/);
  assert.equal(submitted.staging.state, "consumed");
  assert.deepEqual(submitted.continuation, { run_state: "completed", run_stage: "no_change", pending_dispatches: [], pending_decision: null });

  const terminal = await StateStore.open(sandbox.aiTeamHome);
  assert.deepEqual(
    terminal.db.prepare("SELECT state,stage,plan_id,revision FROM runs WHERE run_id=?").get(runId),
    { state: "completed", stage: "no_change", plan_id: null, revision: null },
  );
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM staging_entries WHERE run_id=?").get(runId) as { count: number }).count, 1);
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM staging_entries WHERE run_id=? AND state!='consumed'").get(runId) as { count: number }).count, 0);
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId) as { count: number }).count, 0);
  terminal.close();
});

test("planning revision commit rejects a claimed Git Operator dispatch for another revision before mutation", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Plan a guarded revision commit.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-guarded";
  const revision = "001";
  const foreignDispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=? WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", "a".repeat(64), new Date().toISOString());
  database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`).run(
    foreignDispatchId,
    started.run_id,
    "git-operator",
    JSON.stringify({
      objective: "Commit another planning revision",
      allowed_read_paths: [".ai-team/plans/20260814-other/revisions/002"],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit the other revision"],
      context: { plan_id: "20260814-other", revision: "002" },
    }),
    "",
    "{}",
    "{}",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  database.close();

  const headBefore = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  const result = await cli(sandbox, [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", foreignDispatchId,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /planning commit dispatch does not match the requested revision/);
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headBefore);
  assert.equal((await git(sandbox, ["status", "--porcelain"])).stdout, "");
  const finalDatabase = new Database(databasePath, { readonly: true });
  assert.equal(
    (finalDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state,
    "plan_ready",
  );
  finalDatabase.close();
});

test("planning revision commit leaves a recoverable pending operation and blocks blind retry", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Commit an immutable planning revision safely.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-operation";
  const revision = "001";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const digest = "b".repeat(64);
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", digest, new Date().toISOString());
  database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`).run(
    dispatchId,
    started.run_id,
    "git-operator",
    JSON.stringify({
      objective: "Commit this planning revision",
      allowed_read_paths: [`.ai-team/plans/${planId}/revisions/${revision}`],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit this revision"],
      context: { plan_id: planId, revision },
    }),
    "",
    "{}",
    "{}",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  database.close();

  const args = [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", dispatchId,
  ];
  const headBefore = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  const first = await cli(sandbox, args);
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /reconcile pending operation before retry/);
  const pendingDatabase = new Database(databasePath, { readonly: true });
  const operation = pendingDatabase.prepare("SELECT operation_id,state,kind FROM operations WHERE run_id=?").get(started.run_id) as {
    operation_id: string;
    state: string;
    kind: string;
  };
  pendingDatabase.close();
  assert.equal(operation.state, "pending");
  assert.equal(operation.kind, "planning.revision.commit");

  const revisionRoot = join(sandbox.repo, ".ai-team", "plans", planId, "revisions", revision);
  await mkdir(revisionRoot, { recursive: true });
  await writeFile(join(sandbox.repo, ".ai-team", "plans", planId, "plan.yaml"), `plan_id: ${planId}\n`);
  await writeFile(join(revisionRoot, "spec.md"), "# Spec\n");
  const second = await cli(sandbox, args);
  assert.equal(second.status, 2);
  assert.match(second.stderr, new RegExp(operation.operation_id));
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headBefore);
  assert.match((await git(sandbox, ["status", "--porcelain"])).stdout, /\.ai-team/);
  const resumed = json<{ pending_operations: Array<{ operation_id: string; state: string }> }>(
    await cli(sandbox, ["run", "resume", started.run_id]),
  );
  assert.deepEqual(resumed.pending_operations, [{ operation_id: operation.operation_id, kind: "planning.revision.commit", state: "pending" }]);

  const notAppliedEvidence = join(sandbox.root, "not-applied.json");
  await writeFile(notAppliedEvidence, JSON.stringify({ outcome: "not_applied", reason: "repository HEAD did not change" }));
  const reconciled = json<{ operation_id: string; state: string; reused: boolean }>(await cli(sandbox, [
    "git", "reconcile",
    "--run-id", started.run_id,
    "--dispatch-id", dispatchId,
    "--operation-id", operation.operation_id,
    "--state", "not_applied",
    "--evidence-file", notAppliedEvidence,
  ]));
  assert.deepEqual(reconciled, { operation_id: operation.operation_id, state: "not_applied", reused: false });
  const retry = json<{ plan_commit: string; operation_id: string; reused: boolean }>(await cli(sandbox, args));
  assert.equal(retry.reused, false);
  assert.notEqual(retry.operation_id, operation.operation_id);
  assert.match(retry.plan_commit, /^[a-f0-9]{40}$/);
  const auditedDatabase = new Database(databasePath, { readonly: true });
  assert.deepEqual(
    auditedDatabase.prepare("SELECT state FROM operations WHERE run_id=? ORDER BY created_at,operation_id").all(started.run_id),
    [{ state: "failed" }, { state: "completed" }],
  );
  auditedDatabase.close();
});

test("completed planning commit reconciliation converges state, validates ownership, and reuses without Git", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Reconcile an externally confirmed planning commit.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const otherStarted = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-reconciled";
  const revision = "001";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const otherDispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const digest = "d".repeat(64);
  const confirmedCommit = "e".repeat(40);
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", digest, new Date().toISOString());
  const insertDispatch = database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`);
  const packet = JSON.stringify({
    objective: "Commit this planning revision",
    allowed_read_paths: [`.ai-team/plans/${planId}/revisions/${revision}`],
    allowed_write_paths: [],
    acceptance_criteria: ["Commit this revision"],
    context: { plan_id: planId, revision },
  });
  insertDispatch.run(dispatchId, started.run_id, "git-operator", packet, "", "{}", "{}", new Date().toISOString(), new Date().toISOString());
  insertDispatch.run(otherDispatchId, otherStarted.run_id, "git-operator", packet, "", "{}", "{}", new Date().toISOString(), new Date().toISOString());
  database.close();

  const commitArgs = [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", dispatchId,
  ];
  assert.notEqual((await cli(sandbox, commitArgs)).status, 0);
  const pendingDatabase = new Database(databasePath, { readonly: true });
  const operation = pendingDatabase.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending'").get(started.run_id) as { operation_id: string };
  pendingDatabase.close();

  const invalidEvidence = join(sandbox.root, "invalid-completed.json");
  await writeFile(invalidEvidence, JSON.stringify({ plan_commit: "not-a-commit" }));
  const invalid = await cli(sandbox, [
    "git", "reconcile", "--run-id", started.run_id, "--dispatch-id", dispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", invalidEvidence,
  ]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /plan_commit/);

  const completedEvidence = join(sandbox.root, "completed.json");
  await writeFile(completedEvidence, JSON.stringify({
    plan_commit: confirmedCommit,
    plan_id: planId,
    revision,
    digest,
  }));
  const wrongRun = await cli(sandbox, [
    "git", "reconcile", "--run-id", otherStarted.run_id, "--dispatch-id", otherDispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", completedEvidence,
  ]);
  assert.equal(wrongRun.status, 2);
  assert.match(wrongRun.stderr, /does not belong to run/);
  const unchangedDatabase = new Database(databasePath, { readonly: true });
  assert.equal((unchangedDatabase.prepare("SELECT state FROM operations WHERE operation_id=?").get(operation.operation_id) as { state: string }).state, "pending");
  assert.equal((unchangedDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state, "plan_ready");
  unchangedDatabase.close();

  const reconcileArgs = [
    "git", "reconcile", "--run-id", started.run_id, "--dispatch-id", dispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", completedEvidence,
  ];
  const reconciled = json<{ operation_id: string; state: string; plan_commit: string; reused: boolean }>(await cli(sandbox, reconcileArgs));
  assert.deepEqual(reconciled, { operation_id: operation.operation_id, state: "completed", plan_commit: confirmedCommit, reused: false });
  const repeated = json<{ operation_id: string; state: string; plan_commit: string; reused: boolean }>(await cli(sandbox, reconcileArgs));
  assert.deepEqual(repeated, { ...reconciled, reused: true });

  const convergedDatabase = new Database(databasePath, { readonly: true });
  assert.deepEqual(convergedDatabase.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(started.run_id), { state: "active", stage: "ready" });
  assert.deepEqual(
    convergedDatabase.prepare("SELECT state,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision),
    { state: "ready", plan_commit: confirmedCommit },
  );
  convergedDatabase.close();

  const revisionRoot = join(sandbox.repo, ".ai-team", "plans", planId, "revisions", revision);
  await mkdir(revisionRoot, { recursive: true });
  await writeFile(join(sandbox.repo, ".ai-team", "plans", planId, "plan.yaml"), `plan_id: ${planId}\n`);
  await writeFile(join(revisionRoot, "spec.md"), "# Spec\n");
  const headBeforeRetry = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  const retry = json<{ plan_commit: string; operation_id: string; reused: boolean }>(await cli(sandbox, commitArgs));
  assert.deepEqual(retry, { plan_commit: confirmedCommit, operation_id: operation.operation_id, reused: true, state: "ready" });
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headBeforeRetry);
  assert.match((await git(sandbox, ["status", "--porcelain"])).stdout, /\.ai-team/);
});

test("planning revision commit completes its operation atomically and reuses the recorded commit", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Commit a complete planning revision once.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-idempotent";
  const revision = "001";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAY";
  const digest = "c".repeat(64);
  const revisionRoot = join(sandbox.repo, ".ai-team", "plans", planId, "revisions", revision);
  await mkdir(revisionRoot, { recursive: true });
  await writeFile(join(sandbox.repo, ".ai-team", "plans", planId, "plan.yaml"), `plan_id: ${planId}\n`);
  await writeFile(join(revisionRoot, "spec.md"), "# Spec\n");

  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", digest, new Date().toISOString());
  database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`).run(
    dispatchId,
    started.run_id,
    "git-operator",
    JSON.stringify({
      objective: "Commit this planning revision",
      allowed_read_paths: [`.ai-team/plans/${planId}/revisions/${revision}`],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit this revision once"],
      context: { plan_id: planId, revision },
    }),
    "",
    "{}",
    "{}",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  database.close();

  const args = [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", dispatchId,
  ];
  const first = json<{ state: string; plan_commit: string; operation_id: string; reused: boolean }>(await cli(sandbox, args));
  assert.equal(first.state, "ready");
  assert.equal(first.reused, false);
  assert.match(first.plan_commit, /^[a-f0-9]{40}$/);
  const headAfterFirst = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(first.plan_commit, headAfterFirst);
  const completedDatabase = new Database(databasePath, { readonly: true });
  assert.deepEqual(completedDatabase.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(started.run_id), { state: "active", stage: "ready" });
  assert.deepEqual(
    completedDatabase.prepare("SELECT state,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision),
    { state: "ready", plan_commit: first.plan_commit },
  );
  const completedOperation = completedDatabase.prepare("SELECT state,evidence_json FROM operations WHERE operation_id=?").get(first.operation_id) as {
    state: string;
    evidence_json: string;
  };
  completedDatabase.close();
  assert.equal(completedOperation.state, "completed");
  assert.deepEqual(JSON.parse(completedOperation.evidence_json), { plan_commit: first.plan_commit, state: "ready" });

  const second = json<{ state: string; plan_commit: string; operation_id: string; reused: boolean }>(await cli(sandbox, args));
  assert.deepEqual(second, { ...first, reused: true });
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headAfterFirst);
});

test("planning revision transition recovers plan-ready run from spec-ready revision and rejects other drift", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Recover a partially advanced planning revision.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-recovery";
  const revision = "001";
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "spec_ready", "main", "a".repeat(64), new Date().toISOString());
  database.close();

  const recovered = json<{ state: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "revision", "transition",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--to", "plan_ready",
  ]));
  assert.equal(recovered.state, "plan_ready");
  assert.match(recovered.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);

  const driftedDatabase = new Database(databasePath);
  driftedDatabase.prepare("UPDATE revisions SET state='draft' WHERE repo_id=? AND plan_id=? AND revision=?")
    .run(run.repo_id, planId, revision);
  driftedDatabase.prepare("UPDATE runs SET stage='ready' WHERE run_id=?").run(started.run_id);
  driftedDatabase.close();
  const rejected = await cli(sandbox, [
    "planning", "revision", "transition",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--to", "requirements_confirmed",
  ]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /revision state draft is incompatible with planning run stage ready/);
  const finalDatabase = new Database(databasePath, { readonly: true });
  assert.equal(
    (finalDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state,
    "draft",
  );
  finalDatabase.close();
});

test("run show opens read-only while a writer lock is held and creates no backup", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Inspect a run without taking the write lock.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const writer = await StateStore.open(sandbox.aiTeamHome);
  try {
    const before = await readdir(join(sandbox.aiTeamHome, "backups"));
    const shown = json<{ run: { run_id: string } }>(await cli(sandbox, ["run", "show", started.run_id]));
    assert.equal(shown.run.run_id, started.run_id);
    assert.deepEqual(await readdir(join(sandbox.aiTeamHome, "backups")), before);
  } finally {
    writer.close();
  }
});

test("direct coding rejects a dirty repository before creating a run and starts when clean", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  const request = "actual: command fails\nexpected: command succeeds\nevidence: reproducible CLI test\n";
  await writeFile(requestFile, request);
  const dirtyFile = join(sandbox.repo, "dirty.txt");
  await writeFile(dirtyFile, "uncommitted\n");

  const blocked = await cli(sandbox, [
    "coding", "start",
    "--project", sandbox.repo,
    "--mode", "bug",
    "--request-file", requestFile,
  ]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /coding start requires a clean worktree/);
  const database = new Database(join(sandbox.aiTeamHome, "state", "state.sqlite"), { readonly: true });
  const runCount = database.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number };
  database.close();
  assert.equal(runCount.count, 0);

  await unlink(dirtyFile);
  await mkdir(join(sandbox.repo, ".worktrees", "runtime"), { recursive: true });
  await writeFile(join(sandbox.repo, ".worktrees", "runtime", "owned.txt"), "owned worktree state\n");
  const started = json<{ run_id: string; dispatch_id: string }>(
    await cli(sandbox, [
      "coding", "start",
      "--project", sandbox.repo,
      "--mode", "bug",
      "--request-file", requestFile,
    ]),
  );
  const shown = json<{ run: { profile: string; mode: string; request: string; base_commit: string } }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.equal(shown.run.profile, "coding");
  assert.equal(shown.run.mode, "bug");
  assert.equal(shown.run.request, request);
  assert.match(shown.run.base_commit, /^[a-f0-9]{40}$/);
});

test("environment commands isolate homes, dry-run generation, status, and non-probing doctor", async (t) => {
  const sandbox = await makeSandbox(t);

  assert.deepEqual(json(await cli(sandbox, ["env", "list"])), ["balanced", "economy", "quality"]);
  const validation = json<{ name: string; roles: number; platforms: number; digest: string }>(
    await cli(sandbox, ["env", "validate", "balanced"]),
  );
  assert.deepEqual({ name: validation.name, roles: validation.roles, platforms: validation.platforms }, {
    name: "balanced",
    roles: 12,
    platforms: 3,
  });
  assert.match(validation.digest, /^[a-f0-9]{64}$/);

  const explanation = json<{
    environment: string;
    role: string;
    platform: string;
    value: Record<string, unknown>;
    source: { kind: string; file: string; pointer: string };
  }>(await cli(sandbox, ["env", "explain", "balanced", "--role", "coding", "--platform", "codex"]));
  assert.deepEqual(explanation, {
    environment: "balanced",
    role: "coding",
    platform: "codex",
    value: { model: "gpt-5.2", reasoning: "medium" },
    source: {
      kind: "override",
      file: join(sandbox.aiTeamHome, "environments", "balanced.yaml"),
      pointer: "/overrides/coding/codex",
    },
  });

  const allChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality"]),
  );
  assert.ok(allChanges.changes.length > 0);
  const roleChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality", "--role", "coding"]),
  );
  assert.ok(roleChanges.changes.length > 0);
  assert.ok(roleChanges.changes.every(({ role }) => role === "coding"));
  const platformChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality", "--platform", "codex"]),
  );
  assert.ok(platformChanges.changes.length > 0);
  assert.ok(platformChanges.changes.every(({ platform }) => platform === "codex"));
  assert.deepEqual(json(await cli(sandbox, ["env", "diff", "balanced", "balanced"])), {
    from: "balanced",
    to: "balanced",
    changes: [],
  });

  const plan = json<{ writes: Array<{ path: string }>; backups: unknown[]; removals: unknown[] }>(
    await cli(sandbox, ["env", "generate", "--dry-run"]),
  );
  assert.equal(plan.writes.length, 39);
  assert.deepEqual(plan.backups, []);
  assert.deepEqual(plan.removals, []);
  assert.ok(plan.writes.every(({ path }) => path.startsWith(sandbox.userHome)));
  await assert.rejects(stat(join(sandbox.userHome, ".codex", "agents", "planning.toml")), { code: "ENOENT" });
  assert.deepEqual(json(await cli(sandbox, ["env", "status"])), []);

  const bin = join(sandbox.root, "bin");
  const probeLog = join(sandbox.root, "probe.log");
  await mkdir(bin);
  for (const executable of ["codex", "claude", "opencode"]) {
    const path = join(bin, executable);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' ${executable} >> "$AI_TEAM_PROBE_LOG"\n`);
    await chmod(path, 0o700);
  }
  sandbox.env.PATH = bin;
  sandbox.env.AI_TEAM_PROBE_LOG = probeLog;
  assert.deepEqual(json(await cli(sandbox, ["env", "doctor"])), [
    { platform: "codex", status: "not-probed" },
    { platform: "claude", status: "not-probed" },
    { platform: "opencode", status: "not-probed" },
  ]);
  await assert.rejects(stat(probeLog), { code: "ENOENT" });
});
