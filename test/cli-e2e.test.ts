import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";

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

const git = async (sandbox: Sandbox, args: string[]): Promise<CommandResult> =>
  execute("git", args, { cwd: sandbox.repo, env: sandbox.env });

const json = <T>(result: CommandResult): T => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
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

test("CLI entrypoint executes through a symlinked path", async (t) => {
  const sandbox = await makeSandbox(t);
  const linkedCli = join(sandbox.root, "linked cli.js");
  await symlink(CLI, linkedCli);
  const contract = json<{ contract_digest: string }>(
    await execute(process.execPath, [linkedCli, "contract"], { cwd: sandbox.repo, env: sandbox.env }),
  );
  assert.match(contract.contract_digest, /^[a-f0-9]{64}$/);
});

test("init creates project metadata and applies the documented ignore entries", async (t) => {
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

  const prompt = await cli(sandbox, ["dispatch", "prompt", ...identity]);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, new RegExp(`Dispatch: ${started.dispatch_id}`));
  assert.match(prompt.stdout, /Role: file-explorer/);

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
  result.payload = { allowed_read_paths: ["README.md"], entry_points: ["README.md"], test_commands: ["npm test"] };
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
