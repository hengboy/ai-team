import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import YAML from "yaml";
import { ROLES, STAGING_KINDS, type Role, type StagingKind } from "./constants.js";
import { ValidationError } from "./errors.js";
import { sha256 } from "./utils.js";

export type AgentBuildPlatform = "codex" | "claude" | "opencode";
export type Enforcement = "mechanical" | "instruction" | "unsupported";
export type ExecutionTool = "filesystem.read" | "filesystem.write" | "process.exec" | "git.read" | "git.write" | "network";
export type ExecutionCwdKind = "project" | "worktree" | "ai_team_home";
export type ApprovalPolicy = "never" | "on_request" | "always";
export interface RoleExecutionPolicy {
  default: { cwd: ExecutionCwdKind; tools: ExecutionTool[]; approval_policy: ApprovalPolicy };
  ceiling: { cwd: ExecutionCwdKind[]; tools: ExecutionTool[]; approval_policies: ApprovalPolicy[] };
}
export interface AgentBuildManifest { schema_version: number; template_version: number; roles: string[]; platforms: AgentBuildPlatform[]; instructions: string; role_directory: string; environment_directory: string; template_directory: string; }
export interface AgentBuildRole { id: Role; purpose: string; writes: string[]; staging: { owned_entries: StagingKind[] }; delegates: Role[]; commands: string[]; discovery: boolean; enforcement: Record<string, Enforcement>; execution: RoleExecutionPolicy; body: string; }
export interface EnvironmentFile { name: string; platforms: AgentBuildPlatform[]; defaults: Record<string, Record<string, unknown>>; overrides?: Record<string, Record<string, Record<string, unknown>>>; }
export interface AgentBuild { root: string; manifest: AgentBuildManifest; roles: Record<Role, AgentBuildRole>; environments: Record<string, EnvironmentFile>; templates: Record<string, string>; instructions: string; digest: string; templateVersion: number; }
export interface RenderContext { role: Role; purpose: string; allowed_commands: string; delegates: string; discovery: string; stop_conditions: string; platform: AgentBuildPlatform; environment: string; contract_digest: string; role_manifest_digest: string; template_version: number; spec_template: string; plan_template: string; task_template: string; }

const supportedPlatforms: AgentBuildPlatform[] = ["codex", "claude", "opencode"];
const reasoningValues = new Set(["low", "medium", "high", "xhigh"]);
const effortValues = new Set(["low", "medium", "high"]);
const variantValues = new Set(["low", "medium", "high"]);
const supportedCommandPrefixes = ["planning start", "planning revision ", "planning tasks ", "coding start", "context ", "dispatch ", "decision create", "staging ", "scope check", "run ", "review ", "research ", "git ", "install", "env ", "backup restore", "uninstall"];
const allowedVariables = new Set(["role", "purpose", "allowed_commands", "delegates", "discovery", "stop_conditions", "platform", "environment", "contract_digest", "role_manifest_digest", "template_version", "spec_template", "plan_template", "task_template"]);
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const expectedSchemas = ["manifest-v1.json", "role-v1.json", "environment-v1.json"] as const;

interface AgentBuildValidators {
  manifest: ValidateFunction;
  role: ValidateFunction;
  environment: ValidateFunction;
}

const fail = (message: string, details?: unknown): never => { throw new ValidationError(message, details); };
const assertSafe = (root: string, value: string): string => {
  if (!value || value.startsWith("/") || value.split(/[\\/]/).includes("..")) fail(`agent-build path is unsafe: ${value}`);
  const target = resolve(root, value); const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) fail(`agent-build path escapes root: ${value}`);
  return target;
};
const readText = (root: string, path: string): string => {
  const target = assertSafe(root, path);
  if (!existsSync(target) || !lstatSync(target).isFile()) fail(`agent-build resource is missing: ${path}`);
  const canonicalRoot = realpathSync(root); const canonical = realpathSync(target); const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) fail(`agent-build resource escapes root: ${path}`);
  return readFileSync(target, "utf8").replaceAll("\r\n", "\n");
};
const compileSchema = (root: string, file: (typeof expectedSchemas)[number]): ValidateFunction => {
  const path = join("schemas", file);
  let schema: unknown;
  try {
    schema = JSON.parse(readText(root, path));
  } catch (error) {
    return fail(`invalid agent-build schema JSON: ${file}`, error instanceof Error ? error.message : error);
  }
  try {
    return new Ajv2020({ allErrors: true, strict: false }).compile(schema as Record<string, unknown>);
  } catch (error) {
    return fail(`invalid agent-build schema: ${file}`, error instanceof Error ? error.message : error);
  }
};
const loadValidators = (root: string): AgentBuildValidators => {
  const schemaDir = join(root, "schemas");
  if (!existsSync(schemaDir) || !lstatSync(schemaDir).isDirectory()) fail("agent-build schema directory is missing");
  const expected = new Set<string>(expectedSchemas);
  for (const file of readdirSync(schemaDir)) if (!expected.has(file)) fail(`unexpected schema resource: ${file}`);
  for (const file of expectedSchemas) if (!existsSync(join(schemaDir, file))) fail(`agent-build schema is missing: ${file}`);
  return {
    manifest: compileSchema(root, "manifest-v1.json"),
    role: compileSchema(root, "role-v1.json"),
    environment: compileSchema(root, "environment-v1.json"),
  };
};
const assertSchema = (validate: ValidateFunction, value: unknown, source: string): void => {
  if (validate(value)) return;
  fail(`${source} schema is invalid`, validate.errors?.map((error) => ({
    path: error.instancePath || "/",
    message: error.message,
  })));
};
const validateTemplateVariables = (body: string, source: string): void => {
  for (const match of body.matchAll(/{{\s*([^{}]+?)\s*}}/g)) if (!allowedVariables.has(match[1]!)) fail(`unknown template variable in ${source}: ${match[1]}`);
};
const validateModel = (value: unknown, platform: AgentBuildPlatform, source: string): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid model configuration: ${source}`);
  const config = value as Record<string, unknown>;
  const allowed = platform === "codex" ? new Set(["model", "reasoning"]) : platform === "claude" ? new Set(["model", "effort"]) : new Set(["model", "variant", "options"]);
  if (Object.keys(config).some((key) => !allowed.has(key))) fail(`unknown model field: ${source}`);
  if (typeof config.model !== "string" || !config.model.trim()) fail(`model is required: ${source}`);
  if (platform === "codex" && (typeof config.reasoning !== "string" || !reasoningValues.has(config.reasoning))) fail(`invalid Codex reasoning: ${source}`);
  if (platform === "claude" && (typeof config.effort !== "string" || !effortValues.has(config.effort))) fail(`invalid Claude effort: ${source}`);
  if (platform === "opencode" && (typeof config.variant !== "string" || !variantValues.has(config.variant) || !config.options || typeof config.options !== "object" || Array.isArray(config.options))) fail(`invalid OpenCode configuration: ${source}`);
};

const assertBlockYaml = (document: YAML.Document, source: string): void => {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { flow?: boolean; items?: unknown[] };
    if (value.flow === true) fail(`flow collection is not allowed in ${source}`);
    for (const item of value.items ?? []) {
      if (item && typeof item === "object" && "key" in item) visit((item as { key: unknown }).key);
      if (item && typeof item === "object" && "value" in item) visit((item as { value: unknown }).value);
      else visit(item);
    }
  };
  visit(document.contents);
};

const parseEnvironment = (root: string, path: string): EnvironmentFile => {
  const source = readText(root, path);
  const document = YAML.parseDocument(source);
  if (document.errors.length) fail(`invalid environment YAML: ${path}`, document.errors.map((error) => error.message));
  assertBlockYaml(document, path);
  const value = document.toJS() as EnvironmentFile;
  const normalizeOpenCode = (config: Record<string, unknown> | undefined): void => {
    if (config && !Object.hasOwn(config, "options")) config.options = {};
  };
  normalizeOpenCode(value.defaults?.opencode as Record<string, unknown> | undefined);
  for (const override of Object.values(value.overrides ?? {})) normalizeOpenCode(override?.opencode as Record<string, unknown> | undefined);
  return value;
};

function parseAndValidate(root: string): AgentBuild {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail(`agent-build directory does not exist: ${root}`);
  const rootEntries = new Set(["manifest.yaml", "instructions.md", "roles", "environments", "schemas", "templates"]);
  for (const entry of readdirSync(root)) if (!rootEntries.has(entry)) fail(`unexpected agent-build resource: ${entry}`);
  const validators = loadValidators(root);
  const manifest = YAML.parse(readText(root, "manifest.yaml")) as AgentBuildManifest;
  assertSchema(validators.manifest, manifest, "agent-build manifest");
  if (!manifest || manifest.schema_version !== 1 || !Number.isInteger(manifest.template_version) || manifest.template_version < 1) fail("invalid agent-build manifest version");
  if (!Array.isArray(manifest.roles) || manifest.roles.length !== ROLES.length || [...manifest.roles].sort().join("\0") !== [...ROLES].sort().join("\0")) fail("agent-build role set does not match runtime roles");
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length !== supportedPlatforms.length || [...manifest.platforms].sort().join("\0") !== [...supportedPlatforms].sort().join("\0")) fail("agent-build platform set does not match supported platforms");
  const instructions = readText(root, manifest.instructions);
  validateTemplateVariables(instructions, manifest.instructions);
  const roles: Partial<Record<Role, AgentBuildRole>> = {};
  const roleDir = assertSafe(root, manifest.role_directory);
  if (!existsSync(roleDir) || !lstatSync(roleDir).isDirectory()) fail("agent-build role directory is missing");
  const expectedRoleFiles = new Set(ROLES.flatMap((role) => [`${role}.yaml`, `${role}.md`]));
  for (const file of readdirSync(roleDir)) if (!expectedRoleFiles.has(file)) fail(`unexpected agent-build role resource: ${file}`);
  for (const role of ROLES) {
    const yamlPath = join(manifest.role_directory, `${role}.yaml`); const mdPath = join(manifest.role_directory, `${role}.md`);
    const value = YAML.parse(readText(root, yamlPath)) as AgentBuildRole;
    assertSchema(validators.role, value, yamlPath);
    if (!value || value.id !== role || typeof value.purpose !== "string" || !Array.isArray(value.writes) || !Array.isArray(value.staging?.owned_entries) || !Array.isArray(value.delegates) || !Array.isArray(value.commands) || typeof value.discovery !== "boolean" || !value.enforcement || !value.execution) fail(`invalid role configuration: ${role}`);
    if (value.staging.owned_entries.some((item) => !STAGING_KINDS.includes(item))) fail(`unknown staging kind in role: ${role}`);
    if (value.delegates.some((item) => !ROLES.includes(item as Role))) fail(`unknown delegate in role: ${role}`);
    if (value.commands.some((item) => typeof item !== "string" || !item.trim() || !supportedCommandPrefixes.some((prefix) => item === prefix || item.startsWith(prefix)))) fail(`unknown command in role: ${role}`);
    for (const level of Object.values(value.enforcement)) if (!["mechanical", "instruction", "unsupported"].includes(level)) fail(`invalid enforcement in role: ${role}`);
    const body = readText(root, mdPath); validateTemplateVariables(body, mdPath);
    roles[role] = { ...value, body };
  }
  const environments: Record<string, EnvironmentFile> = {};
  const envDir = assertSafe(root, manifest.environment_directory);
  if (!existsSync(envDir) || !lstatSync(envDir).isDirectory()) fail("agent-build environment directory is missing");
  for (const file of readdirSync(envDir).sort()) {
    if (!file.endsWith(".yaml")) fail(`unexpected agent-build environment resource: ${file}`);
    const value = parseEnvironment(root, join(manifest.environment_directory, file));
    assertSchema(validators.environment, value, join(manifest.environment_directory, file));
    if (!value?.name || value.name !== file.slice(0, -5) || !Array.isArray(value.platforms) || value.platforms.some((p) => !supportedPlatforms.includes(p as AgentBuildPlatform))) fail(`invalid environment configuration: ${file}`);
    if (!value.defaults || Object.keys(value.defaults).sort().join("\0") !== supportedPlatforms.slice().sort().join("\0")) fail(`environment defaults must cover all platforms: ${file}`);
    for (const platform of supportedPlatforms) {
      validateModel(value.defaults[platform], platform, `${file}.defaults.${platform}`);
    }
    if (!value.overrides || Object.keys(value.overrides).sort().join("\0") !== ROLES.slice().sort().join("\0")) fail(`environment must configure every role: ${file}`);
    for (const role of ROLES) {
      const override = value.overrides![role];
      if (!override || Object.keys(override).sort().join("\0") !== value.platforms.slice().sort().join("\0")) fail(`environment must configure every role platform: ${file}.${role}`);
      if (!ROLES.includes(role as Role) || !override || Object.keys(override).some((platform) => !supportedPlatforms.includes(platform as AgentBuildPlatform))) fail(`invalid environment override: ${file}.${role}`);
      for (const [platform, config] of Object.entries(override ?? {})) validateModel(config, platform as AgentBuildPlatform, `${file}.overrides.${role}.${platform}`);
    }
    environments[value.name] = value;
  }
  if (!Object.keys(environments).length) fail("agent-build has no environments");
  const templateDir = assertSafe(root, manifest.template_directory);
  if (!existsSync(templateDir) || !lstatSync(templateDir).isDirectory()) fail("agent-build template directory is missing");
  const expectedTemplates = new Set(["spec.md", "plan.md", "task.md"]);
  const templates: Record<string, string> = {};
  for (const file of readdirSync(templateDir)) { if (!expectedTemplates.has(file)) fail(`unexpected agent-build template resource: ${file}`); templates[file.slice(0, -3)] = readText(root, join(manifest.template_directory, file)); }
  for (const file of expectedTemplates) if (!existsSync(join(templateDir, file))) fail(`agent-build template is missing: ${file}`);
  const declaredFiles = new Set(["manifest.yaml", manifest.instructions]);
  for (const role of ROLES) { declaredFiles.add(join(manifest.role_directory, `${role}.yaml`)); declaredFiles.add(join(manifest.role_directory, `${role}.md`)); }
  for (const file of readdirSync(envDir)) declaredFiles.add(join(manifest.environment_directory, file));
  for (const file of expectedTemplates) declaredFiles.add(join(manifest.template_directory, file));
  for (const file of expectedSchemas) declaredFiles.add(join("schemas", file));
  const digestParts = [...declaredFiles].sort().map((path) => `${path}\n${readText(root, path)}`);
  return Object.freeze({ root, manifest, roles: roles as Record<Role, AgentBuildRole>, environments, templates, instructions, digest: sha256(digestParts.join("\n")), templateVersion: manifest.template_version });
}

export function loadAgentBuildSync(root?: string): AgentBuild {
  const selected = root ?? process.env.AI_TEAM_AGENT_BUILD ?? join(packageRoot, "agent-build");
  return parseAndValidate(resolve(selected));
}
export async function loadAgentBuild(root?: string): Promise<AgentBuild> { return loadAgentBuildSync(root); }
export function renderRoleBody(build: AgentBuild, role: Role, context: RenderContext): string {
  const body = build.roles[role]?.body; if (body === undefined) fail(`unknown role: ${role}`);
  return body.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, key: string) => { if (!allowedVariables.has(key)) fail(`unknown template variable: ${key}`); const value = context[key as keyof RenderContext]; if (value === undefined || value === null) fail(`missing template variable: ${key}`); return typeof value === "string" ? value : String(value); }).replaceAll("\r\n", "\n").trimEnd() + "\n";
}
