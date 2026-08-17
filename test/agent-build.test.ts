import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadAgentBuildSync } from "../src/agent-build.js";
import { ValidationError } from "../src/errors.js";

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
  assert.equal(build.templateVersion, 3);
  assert.deepEqual(build.roles["file-explorer"].staging.owned_entries, ["project-context", "dispatch-result"]);
  assert.deepEqual(build.roles["environment-operator"].staging.owned_entries, []);
  assert.ok(build.roles.planning.commands.includes("staging create"));
  assert.ok(build.roles.coding.commands.includes("staging cleanup"));
  assert.ok(build.roles.researcher.commands.includes("research archive"));
  assert.ok(!build.roles["environment-operator"].commands.includes("staging create"));
  assert.ok(build.roles["environment-operator"].commands.includes("env explain"));
  assert.ok(build.roles["environment-operator"].commands.includes("env diff"));
});
