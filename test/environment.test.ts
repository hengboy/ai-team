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

test("environment explanations report whole-object default and override sources", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  const environment = balancedEnvironment();
  environment.name = "provenance";
  environment.overrides = {
    coding: { codex: { model: "gpt-source", reasoning: "high" } },
  };
  const file = join(service.paths.environments, "provenance.yaml");
  await writeFile(file, YAML.stringify(environment));

  assert.deepEqual(await service.explain("provenance", "planning", "codex"), {
    environment: "provenance",
    role: "planning",
    platform: "codex",
    value: { model: "gpt-5.2", reasoning: "medium" },
    source: { kind: "default", file, pointer: "/defaults/codex" },
  });
  assert.deepEqual(await service.explain("provenance", "coding", "codex"), {
    environment: "provenance",
    role: "coding",
    platform: "codex",
    value: { model: "gpt-source", reasoning: "high" },
    source: { kind: "override", file, pointer: "/overrides/coding/codex" },
  });

  environment.name = "codex-only";
  environment.platforms = ["codex"];
  await writeFile(join(service.paths.environments, "codex-only.yaml"), YAML.stringify(environment));
  await assert.rejects(service.explain("codex-only", "coding", "claude"), /platform is not enabled/);
});

test("environment diffs compare resolved values with stable ordering and null single-sided platforms", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  const from = balancedEnvironment();
  from.name = "diff-from";
  from.platforms = ["codex", "opencode"];
  delete from.overrides;
  from.defaults.opencode = { model: "openai/source", variant: "medium", options: { nested: { enabled: false }, temperature: 0 } };
  const to = structuredClone(from);
  to.name = "diff-to";
  to.platforms = ["claude", "opencode"];
  to.defaults.opencode = { model: "openai/source", variant: "medium", options: { temperature: 0, nested: { enabled: true } } };
  await writeFile(join(service.paths.environments, "diff-from.yaml"), YAML.stringify(from));
  await writeFile(join(service.paths.environments, "diff-to.yaml"), YAML.stringify(to));

  const result = await service.diff("diff-from", "diff-to");
  assert.deepEqual({ from: result.from, to: result.to }, { from: "diff-from", to: "diff-to" });
  assert.deepEqual(result.changes.slice(0, 3).map(({ role, platform }) => [role, platform]), [
    ["planning", "codex"],
    ["planning", "claude"],
    ["planning", "opencode"],
  ]);
  assert.equal(result.changes[0]?.after, null);
  assert.equal(result.changes[1]?.before, null);
  assert.deepEqual(result.changes[2]?.after?.value.options, { temperature: 0, nested: { enabled: true } });
  assert.equal(result.changes.length, ROLES.length * 3);

  const filtered = await service.diff("diff-from", "diff-to", "coding", "opencode");
  assert.deepEqual(filtered.changes.map(({ role, platform }) => [role, platform]), [["coding", "opencode"]]);
  const codexOnly = structuredClone(from);
  codexOnly.name = "diff-codex-only";
  codexOnly.platforms = ["codex"];
  const claudeOnly = structuredClone(to);
  claudeOnly.name = "diff-claude-only";
  claudeOnly.platforms = ["claude"];
  await writeFile(join(service.paths.environments, "diff-codex-only.yaml"), YAML.stringify(codexOnly));
  await writeFile(join(service.paths.environments, "diff-claude-only.yaml"), YAML.stringify(claudeOnly));
  await assert.rejects(service.diff("diff-codex-only", "diff-claude-only", undefined, "opencode"), /platform is not enabled/);
});

test("environment diffs ignore source-only changes", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  const from = balancedEnvironment();
  from.name = "source-from";
  delete from.overrides;
  const to = structuredClone(from);
  to.name = "source-to";
  to.overrides = { coding: { codex: structuredClone(to.defaults.codex) } };
  await writeFile(join(service.paths.environments, "source-from.yaml"), YAML.stringify(from));
  await writeFile(join(service.paths.environments, "source-to.yaml"), YAML.stringify(to));

  assert.deepEqual(await service.diff("source-from", "source-to", "coding", "codex"), {
    from: "source-from",
    to: "source-to",
    changes: [],
  });
});

test("environment validation rejects unknown override roles and unsafe names", async (t) => {
  const environment = balancedEnvironment() as EnvironmentFile & { overrides: Record<string, unknown> };
  environment.overrides = { unknown: { codex: { model: "gpt", reasoning: "high" } } };
  assert.throws(() => resolveEnvironment(environment), /environment schema is invalid/);

  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await assert.rejects(service.load("../balanced"), /invalid environment name/);
});

test("staging retention defaults for new and legacy configs and rejects invalid values", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  const configPath = join(service.paths.root, "config.yaml");
  const current = YAML.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(current.staging, { retention_hours: 168 });
  assert.equal(await service.stagingRetentionHours(), 168);

  delete current.staging;
  await writeFile(configPath, YAML.stringify(current));
  assert.equal(await service.stagingRetentionHours(), 168);

  current.staging = { retention_hours: 0 };
  await writeFile(configPath, YAML.stringify(current));
  await assert.rejects(service.stagingRetentionHours(), /config schema is invalid/);
});

test("renderAgents renders all twelve roles for all three platforms", () => {
  const files = renderAgents(balancedEnvironment());
  let codexInstructionCharacters = 0;

  assert.equal(files.size, ROLES.length * PLATFORMS.length);
  for (const role of ROLES) {
    for (const platform of PLATFORMS) {
      const extension = platform === "codex" ? "toml" : "md";
      const content = files.get(`${platform}/agents/${role}.${extension}`);
      assert.ok(content, `missing ${platform} output for ${role}`);
      const instructionStart = content.indexOf(`Role: ${role}`);
      assert.notEqual(instructionStart, -1);
      const visibleInstructions = content.slice(instructionStart);
      assert.match(visibleInstructions, /推荐命令语法/);
      const metadata = platform === "codex"
        ? JSON.parse(content.match(/^# ai_team\.metadata = (.+)$/m)?.[1] ?? "null")
        : YAML.parse(content.slice(content.indexOf("---") + 4, content.indexOf("---", content.indexOf("---") + 3))).ai_team;
      assert.deepEqual(metadata.command_contract.allowed_commands, ROLE_MANIFEST[role].commands);
      assert.ok(metadata.command_contract.syntax.length > 0);
      assert.ok(Object.keys(metadata.command_contract.parameter_types).length > 0);
      assert.deepEqual(metadata.writes, ROLE_MANIFEST[role].writes);
      assert.deepEqual(metadata.staging, ROLE_MANIFEST[role].staging);
      assert.match(visibleInstructions, /staging\.owned_entries/);
      assert.match(visibleInstructions, /--input-stdin.*staging_id.*--staging-id/s);
      assert.match(visibleInstructions, /不得直接写入.*\$TMPDIR.*项目目录.*AI_TEAM_HOME/);
      assert.doesNotMatch(visibleInstructions, /--(?:context-file|documents-file|file|packet-file|result-file|evidence-file|report-file|resolution-file) <(?:json|file)>/);
      assert.doesNotMatch(visibleInstructions, /undefined/);
      if (platform === "codex") {
        assert.doesNotMatch(content, /^\[ai_team\]$/m);
        assert.match(content, new RegExp(`^name = "${role}"$`, "m"));
        assert.match(content, /^description = ".+"$/m);
        assert.match(content, /^developer_instructions = "Role:/m);
        assert.ok(content.includes(`"platform":"${platform}"`));
        assert.match(content, /model_reasoning_effort = "medium"/);
        const encoded = content.match(/^developer_instructions = (.+)$/m)?.[1];
        assert.ok(encoded);
        codexInstructionCharacters += (JSON.parse(encoded) as string).length;
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
  assert.ok(codexInstructionCharacters <= 35_000, `Codex instructions total ${codexInstructionCharacters} characters`);
  const reviewer = files.get("codex/agents/code-reviewer.toml") ?? "";
  assert.match(reviewer, /<opaque-id>`=CLI ID/);
  const environmentOperator = files.get("codex/agents/environment-operator.toml") ?? "";
  assert.match(environmentOperator, /<name>`=小写环境名/);
  assert.match(environmentOperator, /<from>`=小写环境名/);
  assert.match(environmentOperator, /<to>`=小写环境名/);
});

test("planning and coding coordinate managed staging for every generated JSON", () => {
  const files = renderAgents(balancedEnvironment());
  const planning = files.get("claude/agents/planning.md") ?? "";
  const coding = files.get("claude/agents/coding.md") ?? "";

  assert.match(planning, /每个规划 JSON.*--input-stdin.*自动创建、写入、校验.*--staging-id/s);
  assert.match(planning, /planning revision create --input-stdin.*完整 preflight/s);
  assert.match(planning, /planning revision validate.*诊断.*失败重试/s);
  assert.match(planning, /已确认的完整需求列表.*`confirm`.*`revise`.*choice 为 `confirm`.*才可开始写入 `spec\.md`/s);
  assert.match(planning, /「拆分任务」.*「不拆分任务」.*推荐及理由.*`split`.*`no_split`/s);
  assert.match(planning, /`taskId`、标题和摘要.*`approve`.*`revise`.*调整 task 列表.*再次请求确认/s);
  assert.match(planning, /`approve`.*`revise`.*resolved.*`approve`/s);
  assert.match(planning, /问题 1、.*问题 2、.*从 1 递增/s);
  assert.match(planning, /transition 到 `plan_ready`.*自动创建 \*\*Git Operator\*\* `dispatch`/s);
  assert.match(planning, /归档调研报告/);
  assert.match(coding, /每个调度、结果、决策和评审 JSON.*--input-stdin.*自动管理 staging.*staging_id/s);
  assert.match(coding, /要求下游角色遵循同一流程/);
});

test("planning remains coordinator while delegating claimed File Explorer dispatches", () => {
  const files = renderAgents(balancedEnvironment());

  for (const platform of PLATFORMS) {
    const extension = platform === "codex" ? "toml" : "md";
    const planning = files.get(`${platform}/agents/planning.${extension}`) ?? "";
    assert.match(planning, /协调动作.*不会把规划主代理切换成 `file-explorer`/s);
    assert.match(planning, /所有 `dispatch` 命令.*`--role`.*目标角色 `file-explorer`.*不得使用.*`planning`/s);
    assert.match(planning, /ai-team dispatch claim --run-id <run-id> --dispatch-id <dispatch-id> --role file-explorer --bundle/);
    assert.match(planning, /一次取得冻结 packet、prompt、schema、template、digest 与 renderer version/s);
    assert.match(planning, /不得只汇报.*将要取得或委派.*便停止并等待用户推动/s);
  }
});

test("planning and Git Operator agents expose the immutable revision handoff contract", () => {
  const files = renderAgents(balancedEnvironment());
  const planning = files.get("codex/agents/planning.toml") ?? "";
  const gitOperator = files.get("codex/agents/git-operator.toml") ?? "";

  assert.match(planning, /完整.*spec.*plan/);
  assert.match(planning, /先.*planning revision validate.*再.*planning revision create/s);
  assert.match(planning, /规划代理自身不得执行 `planning revision commit`/);
  assert.match(gitOperator, /`planning revision commit`/);
  assert.match(gitOperator, /ai-team planning revision commit --project <path> --plan-id <plan-id> --revision <revision> --run-id <run-id> --dispatch-id <dispatch-id>/);
  assert.match(gitOperator, /生成 `git commit --message` 的提交消息时使用 `\$git-commit` 技能/);
  assert.match(gitOperator, /不得自行发明其他格式或绕过 CLI 执行提交/);
});

test("generated agents keep screenshots in the owning plan directory", () => {
  const files = renderAgents(balancedEnvironment());

  for (const role of ["coding", "test", "frontend-developer"]) {
    const content = files.get(`codex/agents/${role}.toml`) ?? "";
    assert.match(content, /\.ai-team\/plans\/<planId>\/screenshot\//);
    assert.match(content, /`plan_id`/);
  }
});

test("generate dry-run returns a plan without writing managed user files", async (t) => {
  const { aiTeamHome, userHome } = await makeHomes(t);
  const service = new EnvironmentService(aiTeamHome, userHome);

  const plan = await service.generate("balanced", undefined, true);

  assert.equal(plan.writes.length, ROLES.length * PLATFORMS.length + PLATFORMS.length);
  const instructionWrites = plan.writes.filter((item) => item.kind === "instructions");
  assert.equal(instructionWrites.length, PLATFORMS.length);
  for (const write of instructionWrites) {
    assert.match(write.content, /\*\*File Explorer\*\*/);
    assert.match(write.content, /`仓库文件检索`/);
    assert.match(write.content, /不得自行使用 `rg`、`find`、`glob`/);
    assert.match(write.content, /\.ai-team\/plans\/<planId>\/screenshot\//);
    assert.match(write.content, /`plan_id`/);
    assert.match(write.content, /ai-team:managed:start/);
    assert.match(write.content, /ai-team:managed:end/);
  }
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
