import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadAgentBuildSync } from "../src/agent-build.js";
import { ValidationError } from "../src/errors.js";
import { PLAN_SECTIONS, SPEC_SECTIONS } from "../src/planning.js";

const sourceRoot = fileURLToPath(new URL("../agent-build", import.meta.url));

test("agent-build schemas describe strict manifest, role, and environment contracts", async () => {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "schemas", "manifest-v1.json"), "utf8")) as {
    additionalProperties: boolean;
    properties: Record<string, { type?: string; const?: number }>;
  };
  const role = JSON.parse(await readFile(join(sourceRoot, "schemas", "role-v1.json"), "utf8")) as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  const environment = JSON.parse(await readFile(join(sourceRoot, "schemas", "environment-v1.json"), "utf8")) as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };

  assert.equal(manifest.additionalProperties, false);
  assert.equal(manifest.properties.schema_version?.const, 1);
  assert.equal(manifest.properties.template_version?.type, "integer");
  assert.equal(role.additionalProperties, false);
  assert.ok(role.properties.enforcement);
  assert.equal(environment.additionalProperties, false);
  assert.ok(environment.properties.defaults);
  assert.ok(environment.properties.overrides);
});

test("agent-build loading applies the role schema instead of only checking schema files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-agent-build-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(sourceRoot, root, { recursive: true });

  const rolePath = join(root, "roles", "test.yaml");
  const role = await readFile(rolePath, "utf8");
  await writeFile(rolePath, `${role}unexpected: true\n`);

  assert.throws(
    () => loadAgentBuildSync(root),
    (error: unknown) => error instanceof ValidationError && error.message === "roles/test.yaml schema is invalid",
  );
});

test("role manifests reserve revision creation for planning and revision commit for Git Operator", () => {
  const build = loadAgentBuildSync(sourceRoot);
  assert.ok(build.roles.planning.commands.includes("planning revision validate"));
  assert.ok(build.roles.planning.commands.includes("planning revision create"));
  assert.ok(!build.roles.planning.commands.includes("planning revision commit"));
  assert.ok(build.roles["git-operator"].commands.includes("planning revision commit"));
  assert.ok(build.roles.planning.commands.includes("dispatch reconcile"));
  assert.ok(build.roles.coding.commands.includes("dispatch reconcile"));
});

test("role manifests declare staging ownership separately from project writes", () => {
  const build = loadAgentBuildSync(sourceRoot);
  assert.equal(build.templateVersion, 6);
  assert.deepEqual(build.roles["file-explorer"].staging.owned_entries, ["project-context", "dispatch-result"]);
  assert.deepEqual(build.roles["environment-operator"].staging.owned_entries, []);
  assert.ok(build.roles.planning.commands.includes("staging create"));
  assert.ok(build.roles.coding.commands.includes("staging cleanup"));
  assert.ok(build.roles.researcher.commands.includes("research archive"));
  assert.ok(!build.roles["environment-operator"].commands.includes("staging create"));
  assert.ok(build.roles["environment-operator"].commands.includes("env explain"));
  assert.ok(build.roles["environment-operator"].commands.includes("env diff"));
});

test("planning templates match the workflow structure contract", async () => {
  const spec = await readFile(join(sourceRoot, "templates", "spec.md"), "utf8");
  const plan = await readFile(join(sourceRoot, "templates", "plan.md"), "utf8");
  const task = await readFile(join(sourceRoot, "templates", "task.md"), "utf8");
  const sectionHeadings = (document: string): string[] =>
    [...document.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? "");
  const goalSection = spec.match(/## 目标\n\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";

  assert.match(spec, /^# 规格说明$/m);
  assert.deepEqual(sectionHeadings(spec), [...SPEC_SECTIONS]);
  assert.match(spec, /^### 场景 1：<场景标题>$/m);
  assert.match(spec, /^### REQ-001：<需求标题>$/m);
  assert.match(spec, /^### AC-001：<验收标题>$/m);
  assert.match(spec, /^- RED 判定：$/m);
  assert.match(spec, /^- 可观察结果：$/m);
  assert.match(spec, /^- 边界反例：$/m);
  assert.match(spec, /^- 建议测试层级：$/m);
  assert.doesNotMatch(goalSection, /^\s*- \[[ xX]\]/m);
  assert.match(spec, /写入 revision 后即冻结，不得修改/);

  assert.match(plan, /^# 实施计划$/m);
  assert.deepEqual(sectionHeadings(plan), [...PLAN_SECTIONS]);
  assert.match(plan, /^### STEP-001：<步骤标题>$/m);
  assert.equal((plan.match(/^## 方案验收契约$/gm) ?? []).length, 1);
  assert.match(plan, /"acceptance_criteria"/);
  assert.match(plan, /"acceptance_steps"/);
  assert.match(plan, /"task_mapping"/);
  assert.match(plan, /"test_commands"/);

  assert.match(task, /^# 任务拆分$/m);
  assert.deepEqual(sectionHeadings(task), ["任务清单", "依赖关系", "并行批次", "任务验收契约", "风险与阻塞"]);
  assert.match(task, /^### TASK-001：<任务标题>$/m);
  assert.doesNotMatch(task, /^### \[[ xX]\] TASK-/m);
  assert.match(task, /^- 允许写入路径：$/m);
  assert.match(task, /revision 冻结后不得修改任务文档/);
  assert.match(task, /完成状态以 AI Team 运行状态和审计证据为准/);
  assert.equal((task.match(/^## 任务验收契约$/gm) ?? []).length, 1);
  assert.match(task, /"tdd_cycles"/);
});
