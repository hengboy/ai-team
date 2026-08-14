import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ENVIRONMENTS,
  EnvironmentService,
  PLATFORMS,
  renderAgents,
  resolveEnvironment,
  type EnvironmentFile,
  type Platform,
} from "../src/environment.js";
import { ROLES } from "../src/constants.js";
import { ROLE_MANIFEST } from "../src/roles.js";
import YAML from "yaml";

const makeHomes = async (t: test.TestContext): Promise<{ aiTeamHome: string; userHome: string }> => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-environment-test-"));
  const aiTeamHome = join(root, "ai-team-home");
  const userHome = join(root, "user-home");
  await mkdir(userHome, { recursive: true });
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return { aiTeamHome, userHome };
};

const balancedEnvironment = (): EnvironmentFile => {
  const environment = DEFAULT_ENVIRONMENTS.find(({ name }) => name === "balanced");
  assert.ok(environment);
  return structuredClone(environment);
};

const recordSupportedVersions = async (service: EnvironmentService, platforms: Platform[] = PLATFORMS): Promise<void> => {
  await service.bootstrap();
  const configPath = join(service.paths.root, "config.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  for (const platform of platforms) config.client_versions[platform].detected_version = config.client_versions[platform].minimum;
  await writeFile(configPath, YAML.stringify(config));
};

test("resolveEnvironment applies platform defaults and role overrides", () => {
  const environment = balancedEnvironment();
  environment.overrides = {
    coding: {
      codex: { model: "gpt-5.5", reasoning: "high" },
      opencode: { model: "openai/gpt-5.4", variant: "high", options: { temperature: 0 } },
    },
  };

  const resolved = resolveEnvironment(environment);

  assert.deepEqual(resolved.planning.codex, { model: "gpt-5.2", reasoning: "medium" });
  assert.deepEqual(resolved.coding.codex, { model: "gpt-5.5", reasoning: "high" });
  assert.deepEqual(resolved.coding.claude, { model: "claude-sonnet-4-6", effort: "medium" });
  assert.deepEqual(resolved.coding.opencode, {
    model: "openai/gpt-5.4",
    variant: "high",
    options: { temperature: 0 },
  });
  assert.equal(Object.keys(resolved).length, ROLES.length);
});

test("environment overrides configure each role independently", () => {
  const environment = balancedEnvironment();
  environment.overrides = {
    planning: { codex: { model: "gpt-planning", reasoning: "high" } },
    coding: { codex: { model: "gpt-coding", reasoning: "xhigh" } },
  };
  const resolved = resolveEnvironment(environment);
  assert.deepEqual(resolved.planning.codex, { model: "gpt-planning", reasoning: "high" });
  assert.deepEqual(resolved.coding.codex, { model: "gpt-coding", reasoning: "xhigh" });
  assert.deepEqual(resolved.test.codex, { model: "gpt-5.2", reasoning: "medium" });
});

test("environment validation rejects unknown override roles and unsafe names", async (t) => {
  const environment = balancedEnvironment() as EnvironmentFile & { overrides: Record<string, unknown> };
  environment.overrides = { unknown: { codex: { model: "gpt", reasoning: "high" } } };
  assert.throws(() => resolveEnvironment(environment), /environment schema is invalid/);

  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await assert.rejects(service.load("../balanced"), /invalid environment name/);
});

test("renderAgents renders all twelve roles for all three platforms", () => {
  const files = renderAgents(balancedEnvironment());

  assert.equal(files.size, ROLES.length * PLATFORMS.length);
  for (const role of ROLES) {
    for (const platform of PLATFORMS) {
      const extension = platform === "codex" ? "toml" : "md";
      const content = files.get(`${platform}/agents/${role}.${extension}`);
      assert.ok(content, `missing ${platform} output for ${role}`);
      assert.match(content, new RegExp(`Role: ${role}`));
      assert.match(content, /CLI 命令契约/);
      for (const command of ROLE_MANIFEST[role].commands) assert.ok(content.includes(`\`${command}\``), `missing command ${command} for ${role}`);
      const metadata = platform === "codex"
        ? JSON.parse(content.match(/^# ai_team\.metadata = (.+)$/m)?.[1] ?? "null")
        : YAML.parse(content.slice(content.indexOf("---") + 4, content.indexOf("---", content.indexOf("---") + 3))).ai_team;
      assert.deepEqual(metadata.command_contract.allowed_commands, ROLE_MANIFEST[role].commands);
      assert.ok(metadata.command_contract.syntax.length > 0);
      assert.ok(Object.keys(metadata.command_contract.parameter_types).length > 0);
      if (platform === "codex") {
        assert.doesNotMatch(content, /^\[ai_team\]$/m);
        assert.match(content, new RegExp(`^name = "${role}"$`, "m"));
        assert.match(content, /^description = ".+"$/m);
        assert.match(content, /^developer_instructions = "Role:/m);
        assert.ok(content.includes(`"platform":"${platform}"`));
        assert.match(content, /model_reasoning_effort = "medium"/);
      } else {
        assert.match(content, new RegExp(`^  platform: ${platform}$`, "m"));
      }
      if (platform === "claude") assert.match(content, /^effort: medium$/m);
      if (platform === "opencode") {
        assert.ok(content.startsWith("---\n"), `${role} OpenCode frontmatter must be the first block`);
        assert.match(content, new RegExp(`^mode: ${role === "planning" || role === "coding" ? "primary" : "subagent"}$`, "m"));
        if (role === "planning" || role === "coding") assert.doesNotMatch(content, /^hidden:/m);
        else assert.match(content, /^hidden: true$/m);
        assert.match(content, /^variant: medium$/m);
        assert.match(content, /^options: (?:&\w+ )?\{\}$/m);
      }
    }
  }
});

test("generate dry-run returns a plan without writing managed user files", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);

  const plan = await service.generate("balanced", undefined, true);

  assert.equal(plan.writes.length, ROLES.length * PLATFORMS.length + PLATFORMS.length);
  assert.deepEqual(plan.backups, []);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.blocked, []);
  await assert.rejects(stat(join(userHome, ".codex", "agents", "planning.toml")), { code: "ENOENT" });
  await assert.rejects(stat(join(aiTeamHome, "manifest.json")), { code: "ENOENT" });
});

test("generate records status and drift blocks uninstall", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  const driftedPath = join(userHome, ".codex", "agents", "planning.toml");
  await recordSupportedVersions(service);

  const plan = await service.generate("balanced");
  assert.equal(plan.writes.length, ROLES.length * PLATFORMS.length + PLATFORMS.length);

  const initialStatus = await service.status();
  assert.equal(initialStatus.length, plan.writes.length);
  assert.ok(initialStatus.every(({ state }) => state === "in-sync"));

  await writeFile(driftedPath, "locally edited\n");
  const driftStatus = await service.status();
  assert.deepEqual(driftStatus.find(({ path }) => path === driftedPath), {
    path: driftedPath,
    state: "drifted",
  });
  await assert.rejects(service.generate("balanced"), /blocked by drift/);

  const preview = await service.uninstall(true);
  assert.deepEqual(preview.blocked, [driftedPath]);
  assert.equal(preview.removals.length, plan.writes.length - 1);
  await assert.rejects(service.uninstall(), /managed files drifted; uninstall blocked/);
  assert.equal(await readFile(driftedPath, "utf8"), "locally edited\n");
  await stat(join(aiTeamHome, "manifest.json"));
});

test("generation rejects managed targets that escape user home through symlinks", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const outside = await mkdtemp(join(tmpdir(), "ai-team-environment-outside-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(userHome, ".codex"));
  const service = new EnvironmentService(aiTeamHome, userHome);
  await assert.rejects(service.generate("balanced", ["codex"], true), /escapes user home through symlink/);
});

test("restore refuses to overwrite an existing destination", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  const source = join(service.paths.backups, "2026-08-13T00-00-00-000Z", ".codex", "agents", "planning.toml");
  const destination = join(userHome, ".codex", "agents", "planning.toml");
  await mkdir(join(source, ".."), { recursive: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(source, "backup\n");
  await writeFile(destination, "current\n");

  await assert.rejects(service.restore(source), /restore destination exists/);
  assert.equal(await readFile(destination, "utf8"), "current\n");
});

test("uninstall removes only managed blocks and preserves user instructions", async (t) => {
  const fixture = await makeHomes(t);
  const service = new EnvironmentService(fixture.aiTeamHome, fixture.userHome);
  const instructions = join(fixture.userHome, ".codex", "AGENTS.md");
  await mkdir(join(fixture.userHome, ".codex"), { recursive: true });
  await writeFile(instructions, "# User instructions\n\nKeep this content.\n");
  await recordSupportedVersions(service, ["codex"]);
  await service.generate("balanced", ["codex"]);
  assert.match(await readFile(instructions, "utf8"), /Keep this content/);
  await service.uninstall();
  const remaining = await readFile(instructions, "utf8");
  assert.match(remaining, /Keep this content/);
  assert.doesNotMatch(remaining, /ai-team:managed/);
});

test("doctor without probe does not invoke platform clients", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  const bin = join(userHome, "bin");
  const probeLog = join(userHome, "probe.log");
  await mkdir(bin, { recursive: true });
  for (const platform of PLATFORMS) {
    const executable = join(bin, platform);
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' ${platform} >> "$AI_TEAM_PROBE_LOG"\n`);
    await chmod(executable, 0o700);
  }

  const originalPath = process.env.PATH;
  const originalProbeLog = process.env.AI_TEAM_PROBE_LOG;
  process.env.PATH = bin;
  process.env.AI_TEAM_PROBE_LOG = probeLog;
  try {
    assert.deepEqual(await service.doctor(false), PLATFORMS.map((platform: Platform) => ({
      platform,
      status: "not-probed",
    })));
    await assert.rejects(stat(probeLog), { code: "ENOENT" });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalProbeLog === undefined) delete process.env.AI_TEAM_PROBE_LOG;
    else process.env.AI_TEAM_PROBE_LOG = originalProbeLog;
  }
});

test("doctor probe bootstraps a fresh installation before persisting versions", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  const results = await service.doctor(true);
  assert.equal(results.length, PLATFORMS.length);
  const config = YAML.parse(await readFile(join(aiTeamHome, "config.yaml"), "utf8"));
  assert.equal(config.active_environment, "balanced");
  assert.ok(config.client_versions.codex);
});
