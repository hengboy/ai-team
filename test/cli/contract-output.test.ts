import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CLI, cli, execute, json, makeSandbox } from "../helpers/cli.js";


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
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };

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
