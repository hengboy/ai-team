import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";
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

test("decision commands expose a template and return field-level errors for empty JSON", async (t) => {
  const sandbox = await makeSandbox(t);
  const schema = json<Record<string, any>>(await cli(sandbox, ["decision", "schema"]));
  const template = json<Record<string, any>>(await cli(sandbox, ["decision", "template"]));
  assert.deepEqual(schema.required, ["question", "choices"]);
  assert.equal(template.choices.length, 2);

  const requestFile = join(sandbox.root, "decision-request.md");
  await writeFile(requestFile, "Need a decision.\n");
  const started = json<{ run_id: string }>(await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]));
  const empty = join(sandbox.root, "empty-decision.json");
  await writeFile(empty, "{}\n");
  const failed = await cli(sandbox, ["decision", "create", "--run-id", started.run_id, "--file", empty]);
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
  assert.deepEqual(initialized.additions, ["/.worktree/", "/.ai-team/runtime/"]);
  assert.equal(initialized.patch, "+/.worktree/\n+/.ai-team/runtime/");
  assert.equal(await readFile(join(sandbox.repo, ".gitignore"), "utf8"), "/.worktree/\n/.ai-team/runtime/\n");
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
  const stagingPath = join(sandbox.aiTeamHome, "state", "staging", started.run_id, `${created.stagingId}.json`);
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
    ["planning", "revision", "create"],
    ["planning", "tasks", "validate"],
    ["dispatch", "create"],
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
    assert.match(help.stdout, /--(?:context|documents|result|evidence|report|resolution)?-?file <file>|--packet-file <file>/, command.join(" "));
  }
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
    dispatches: Array<{ state: string }>;
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
    await cli(sandbox, ["decision", "create", "--run-id", started.run_id, "--file", decisionFile]),
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

test("planning revision commit rejects a claimed Git Operator dispatch for another revision before mutation", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Plan a guarded revision commit.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-guarded-abcd";
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
      allowed_read_paths: [".ai-team/plans/20260814-other-abcd/revisions/002"],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit the other revision"],
      context: { plan_id: "20260814-other-abcd", revision: "002" },
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
  const planId = "20260814-operation-abcd";
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
  const planId = "20260814-reconciled-abcd";
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
  const planId = "20260814-idempotent-abcd";
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
  const planId = "20260814-recovery-abcd";
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
  await writeFile(requestFile, "Fix the reproducible CLI issue.\n");
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
  assert.equal(shown.run.request, "Fix the reproducible CLI issue.\n");
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
