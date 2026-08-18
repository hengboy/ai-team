import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type test from "node:test";

export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CommandResult { status: number; stdout: string; stderr: string }
export interface Sandbox { root: string; repo: string; aiTeamHome: string; userHome: string; env: NodeJS.ProcessEnv }

const execFileAsync = promisify(execFile);

export const execute = async (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(file, args, { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}), encoding: "utf8" });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { status: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

export const cli = async (sandbox: Sandbox, args: string[]): Promise<CommandResult> => execute(process.execPath, [CLI, ...args], { cwd: sandbox.repo, env: sandbox.env });

export const cliWithInput = async (sandbox: Sandbox, args: string[], input: string): Promise<CommandResult> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: sandbox.repo, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  child.stdin.end(input);
});

export const git = async (sandbox: Sandbox, args: string[]): Promise<CommandResult> => execute("git", args, { cwd: sandbox.repo, env: sandbox.env });

export const json = <T>(result: CommandResult): T => {
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: T } & Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "ok"]);
  assert.equal(envelope.ok, true);
  return envelope.data;
};

export const makeSandbox = async (t: test.TestContext, initialize = true): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-cli-e2e-"));
  const sandbox: Sandbox = { root, repo: join(root, "repo"), aiTeamHome: join(root, "ai-team-home"), userHome: join(root, "user-home"), env: {} };
  await Promise.all([mkdir(sandbox.repo), mkdir(sandbox.userHome)]);
  sandbox.env = { ...process.env, AI_TEAM_HOME: sandbox.aiTeamHome, HOME: sandbox.userHome, XDG_CONFIG_HOME: join(sandbox.userHome, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await git(sandbox, ["init", "-b", "main"])).status, 0);
  assert.equal((await git(sandbox, ["config", "user.name", "CLI E2E"])).status, 0);
  assert.equal((await git(sandbox, ["config", "user.email", "cli-e2e@example.invalid"])).status, 0);
  await writeFile(join(sandbox.repo, "README.md"), "# fixture\n");
  assert.equal((await git(sandbox, ["add", "README.md"])).status, 0);
  assert.equal((await git(sandbox, ["commit", "-m", "fixture"])).status, 0);
  if (initialize) {
    json(await cli(sandbox, ["init", sandbox.repo, "--yes"]));
    assert.equal((await git(sandbox, ["add", "--", ".gitignore", ".ai-team", "MEMORY.md"])).status, 0);
    assert.equal((await git(sandbox, ["commit", "-m", "initialize project context"])).status, 0);
  }
  return sandbox;
};
