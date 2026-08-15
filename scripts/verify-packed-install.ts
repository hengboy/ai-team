import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const digestPattern = /^[a-f0-9]{64}$/;

const run = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number },
): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`, { cause: error }));
      return;
    }
    resolve(stdout);
  });
});

const readEnvelope = <T>(value: string): T => {
  const envelope = JSON.parse(value) as { ok?: unknown; data?: T };
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data);
  return envelope.data;
};

const root = await mkdtemp(join(tmpdir(), "ai-team-packed-install-"));
try {
  const packDirectory = join(root, "pack");
  const consumer = join(root, "consumer");
  const isolatedHome = join(root, "home");
  const xdgConfigHome = join(root, "xdg");
  const aiTeamHome = join(root, "ai-team-home");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(consumer),
    mkdir(isolatedHome),
    mkdir(xdgConfigHome),
    mkdir(aiTeamHome),
  ]);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "ai-team-packed-consumer", private: true }, null, 2)}\n`);

  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
  const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], {
    cwd: packageRoot,
    timeout: 120_000,
  })) as Array<{ filename: string }>;
  assert.equal(packed.length, 1);
  const tarball = join(packDirectory, packed[0]!.filename);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    AI_TEAM_HOME: aiTeamHome,
  };
  delete env.AI_TEAM_AGENT_BUILD;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;

  await run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false", tarball], {
    cwd: consumer,
    env,
    timeout: 180_000,
  });

  const cli = join(consumer, "node_modules", ".bin", "ai-team");
  const version = (await run(cli, ["--version"], { cwd: consumer, env, timeout: 30_000 })).trim();
  assert.equal(version, manifest.version);

  const contract = readEnvelope<{
    contract_digest: string;
    role_manifest_digest: string;
    agent_build_digest: string;
    roles: string[];
  }>(await run(cli, ["contract"], { cwd: consumer, env, timeout: 30_000 }));
  assert.match(contract.contract_digest, digestPattern);
  assert.match(contract.role_manifest_digest, digestPattern);
  assert.match(contract.agent_build_digest, digestPattern);
  assert.equal(contract.roles.length, 12);

  const environment = readEnvelope<{ name: string; roles: number; platforms: number; digest: string }>(
    await run(cli, ["env", "validate", "balanced"], { cwd: consumer, env, timeout: 30_000 }),
  );
  assert.equal(environment.name, "balanced");
  assert.equal(environment.roles, 12);
  assert.equal(environment.platforms, 3);
  assert.match(environment.digest, digestPattern);

  process.stdout.write(`verified packed install ${manifest.name}@${manifest.version}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
