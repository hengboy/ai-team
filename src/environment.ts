import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import lockfile from "proper-lockfile";
import YAML from "yaml";
import { COMMAND_CONTRACT, CONTRACT_DIGEST } from "./contracts.js";
import { resultEnvelopeSchema } from "./contracts.js";
import { Ajv } from "ajv";
import { IncompatibleError, ValidationError } from "./errors.js";
import { getHomePaths } from "./home.js";
import { AGENT_BUILD, ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "./roles.js";
import { renderRoleBody } from "./agent-build.js";
import { ROLES, STAGING_DEFAULT_RETENTION_HOURS, type Role } from "./constants.js";
import { sha256, stableJson } from "./utils.js";
import { commandContractFor } from "./command-contract.js";
import { assertReadablePath, assertWritablePath } from "./security.js";

const execFileAsync = promisify(execFile);
export type Platform = "codex" | "claude" | "opencode";
export const PLATFORMS: Platform[] = ["codex", "claude", "opencode"];
const REASONING = ["low", "medium", "high", "xhigh"] as const;
const EFFORT = ["low", "medium", "high"] as const;
const VARIANTS = ["low", "medium", "high"] as const;

export interface ModelConfig {
  model: string;
  reasoning?: string;
  effort?: string;
  variant?: string;
  options?: Record<string, unknown>;
}

export interface EnvironmentFile {
  name: string;
  platforms: Platform[];
  defaults: Record<Platform, ModelConfig>;
  overrides?: Partial<Record<Role, Partial<Record<Platform, ModelConfig>>>>;
}

export interface EnvironmentSource {
  kind: "default" | "override";
  file: string;
  pointer: string;
}

export interface EnvironmentExplanation {
  environment: string;
  role: Role;
  platform: Platform;
  value: ModelConfig;
  source: EnvironmentSource;
}

export interface EnvironmentDiffValue {
  value: ModelConfig;
  source: EnvironmentSource;
}

export interface EnvironmentDiffChange {
  role: Role;
  platform: Platform;
  before: EnvironmentDiffValue | null;
  after: EnvironmentDiffValue | null;
}

export interface EnvironmentDiff {
  from: string;
  to: string;
  changes: EnvironmentDiffChange[];
}

export const environmentSchema = {
  $id: "https://ai-team.local/schemas/environment-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["name", "platforms", "defaults"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    platforms: { type: "array", uniqueItems: true, minItems: 1, items: { enum: PLATFORMS } },
    defaults: { type: "object", additionalProperties: false, required: PLATFORMS, properties: {
      codex: { type: "object", additionalProperties: false, required: ["model", "reasoning"], properties: { model: { type: "string", minLength: 1 }, reasoning: { enum: REASONING } } },
      claude: { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string", minLength: 1 }, effort: { enum: EFFORT } } },
      opencode: { type: "object", additionalProperties: false, required: ["model", "variant", "options"], properties: { model: { type: "string", minLength: 1 }, variant: { enum: VARIANTS }, options: { type: "object" } } },
    } },
    overrides: { type: "object", additionalProperties: false, properties: Object.fromEntries(ROLES.map((role) => [role, { type: "object", additionalProperties: false, properties: {
      codex: { type: "object", additionalProperties: false, required: ["model", "reasoning"], properties: { model: { type: "string", minLength: 1 }, reasoning: { enum: REASONING } } },
      claude: { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string", minLength: 1 }, effort: { enum: EFFORT } } },
      opencode: { type: "object", additionalProperties: false, required: ["model", "variant", "options"], properties: { model: { type: "string", minLength: 1 }, variant: { enum: VARIANTS }, options: { type: "object" } } },
    } }])),
    },
  },
} as const;
const validateEnvironmentSchema = new Ajv({ allErrors: true, strict: false }).compile(environmentSchema);

export const environmentConfigSchema = {
  $id: "https://ai-team.local/schemas/config-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["active_environment", "enabled_platforms", "client_versions", "state_schema_epoch", "staging"],
  properties: {
    active_environment: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    state_schema_epoch: { type: "integer", minimum: 1 },
    enabled_platforms: { type: "array", uniqueItems: true, minItems: 1, items: { enum: PLATFORMS } },
    client_versions: {
      type: "object", additionalProperties: false, required: PLATFORMS,
      properties: Object.fromEntries(PLATFORMS.map((platform) => [platform, {
        type: "object", additionalProperties: false, required: ["command", "minimum", "verified"],
        properties: { command: { type: "string", minLength: 1 }, minimum: { type: "string", minLength: 1 }, verified: { type: "string", minLength: 1 }, detected_version: { type: "string", minLength: 1 } },
      }])),
    },
    staging: {
      type: "object", additionalProperties: false, required: ["retention_hours"],
      properties: { retention_hours: { type: "integer", minimum: 1 } },
    },
  },
} as const;
const validateEnvironmentConfig = new Ajv({ allErrors: true, strict: false }).compile(environmentConfigSchema);

export const CLIENT_VERSIONS: Record<Platform, { command: string; minimum: string; verified: string; detected_version?: string }> = {
  codex: { command: "codex", minimum: "0.145.0", verified: "0.145.0" },
  claude: { command: "claude", minimum: "2.1.229", verified: "2.1.229" },
  opencode: { command: "opencode", minimum: "1.18.18", verified: "1.18.18" },
};

export const PLATFORM_CAPABILITIES: Record<Platform, Record<string, "mechanical" | "instruction" | "unsupported">> = {
  codex: { model: "mechanical", reasoning: "mechanical", command_scope: "instruction", read_scope: "instruction", write_scope: "instruction" },
  claude: { model: "mechanical", reasoning: "mechanical", command_scope: "instruction", read_scope: "instruction", write_scope: "instruction" },
  opencode: { model: "mechanical", reasoning: "mechanical", command_scope: "instruction", read_scope: "instruction", write_scope: "instruction" },
};

export const DEFAULT_ENVIRONMENTS: EnvironmentFile[] = Object.values(AGENT_BUILD.environments) as unknown as EnvironmentFile[];

const MANAGED_START = "<!-- ai-team:managed:start -->";
const MANAGED_END = "<!-- ai-team:managed:end -->";
const FILE_MARKER = "由 ai-team 生成。此文件受管理；本地编辑将阻止替换。";
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/;

const assertEnvironmentName = (name: string): string => {
  if (!ENVIRONMENT_NAME.test(name)) throw new ValidationError(`invalid environment name: ${name}`);
  return name;
};

const assertManagedTarget = async (userHome: string, target: string): Promise<void> => {
  const canonicalHome = await realpath(userHome);
  const targetRelative = relative(resolve(userHome), resolve(target));
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || targetRelative === "") throw new ValidationError(`managed target escapes user home: ${target}`);
  let ancestor = target;
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) {
        const canonical = await realpath(ancestor);
        const rel = relative(canonicalHome, canonical);
        if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ValidationError(`managed target escapes user home through symlink: ${target}`);
      }
      break;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const canonicalAncestor = await realpath(ancestor);
  const rel = relative(canonicalHome, canonicalAncestor);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ValidationError(`managed target escapes user home through symlink: ${target}`);
};

export const resolveEnvironment = (environment: EnvironmentFile): Record<Role, Record<Platform, ModelConfig>> => {
  if (!validateEnvironmentSchema(environment)) throw new ValidationError("environment schema is invalid", validateEnvironmentSchema.errors?.map((error) => ({ path: error.instancePath || "/", message: error.message })));
  if (!environment.name || !Array.isArray(environment.platforms) || environment.platforms.some((item) => !PLATFORMS.includes(item))) throw new ValidationError("invalid environment platforms");
  const result = {} as Record<Role, Record<Platform, ModelConfig>>;
  for (const role of ROLES) {
    result[role] = {} as Record<Platform, ModelConfig>;
    for (const platform of environment.platforms) {
      const model = environment.overrides?.[role]?.[platform] ?? environment.defaults[platform];
      if (!model?.model) throw new ValidationError(`${environment.name}.${role}.${platform} has no model`);
      if (platform === "codex" && !model.reasoning) throw new ValidationError(`${role}.codex.reasoning is required`);
      if (platform === "claude" && !model.effort) throw new ValidationError(`${role}.claude.effort is required`);
      if (platform === "opencode" && (!model.variant || model.options === undefined)) throw new ValidationError(`${role}.opencode variant and options are required`);
      result[role][platform] = structuredClone(model);
    }
  }
  return result;
};

const explainEnvironment = (environment: EnvironmentFile, file: string, role: Role, platform: Platform): EnvironmentExplanation => {
  if (!ROLES.includes(role)) throw new ValidationError(`invalid environment role: ${role}`);
  if (!PLATFORMS.includes(platform)) throw new ValidationError(`invalid environment platform: ${platform}`);
  if (!environment.platforms.includes(platform)) throw new ValidationError(`${environment.name}.${platform} platform is not enabled`);
  const roleOverrides = environment.overrides?.[role];
  const override = roleOverrides && Object.hasOwn(roleOverrides, platform);
  const value = override ? roleOverrides[platform] : environment.defaults[platform];
  if (!value) throw new ValidationError(`${environment.name}.${role}.${platform} has no model`);
  return {
    environment: environment.name,
    role,
    platform,
    value: structuredClone(value),
    source: {
      kind: override ? "override" : "default",
      file: resolve(file),
      pointer: override ? `/overrides/${role}/${platform}` : `/defaults/${platform}`,
    },
  };
};

export interface AgentRenderInput { role: Role; model: ModelConfig; environment: string; }
/* command syntax and parameter types are sourced from command-contract.ts */
/*
  path: "string; canonical local filesystem path",
  file: "string; readable file path",
  json: "string; readable JSON file path",
  name: "string; lowercase environment name matching ^[a-z][a-z0-9-]*$",
  role: "enum; one of the 12 manifest role IDs",
  mode: "enum; planned, bug, or feature",
  "platform-list": "comma-separated enum; codex, claude, or opencode",
  "plan-id": "string; eight decimal digits followed by a lowercase slug that does not end with four hexadecimal digits",
  revision: "string; exactly three decimal digits",
  "task-id": "string; TASK- followed by three decimal digits",
  "run-id": "string; run_ followed by a 26-character Crockford ULID",
  "dispatch-id": "string; dispatch_ followed by a 26-character Crockford ULID",
  commit: "string; exactly 40 lowercase hexadecimal characters",
  "opaque-id": "string; CLI-issued identifier",
  branch: "string; Git branch name",
  state: "enum; planning state draft|requirements_confirmed|spec_ready|plan_ready|tasks_preview|ready|implemented|superseded|abandoned, or reconciliation state completed|not_applied|unknown",
  stage: "enum; triage, pre_write, or pre_commit",
  paths: "comma-separated repository-relative POSIX paths",
  boolean: "boolean; presence of the flag means true",
  text: "non-empty string",
});

const LEGACY_RENDERER_NOT_USED: Record<string, string[]> = {
  "planning start": ["ai-team planning start --project <path> (--request-file <file> | --request-stdin)"],
  "planning revision create": ["ai-team planning revision create --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> --documents-file <file> [--supersedes <revision>] [--run-id <run-id>]"],
  "planning revision transition": ["ai-team planning revision transition --project <path> --plan-id <plan-id> --revision <revision> --to <state> [--plan-commit <commit>]"],
  "coding start": [
    "ai-team coding start --project <path> --mode planned --plan-id <plan-id> [--revision <revision>]",
    "ai-team coding start --project <path> --mode bug (--request-file <file> | --request-stdin)",
    "ai-team coding start --project <path> --mode feature (--request-file <file> | --request-stdin)",
  ],
  "dispatch create": ["ai-team dispatch create --run-id <run-id> --role <role> --actor-role <role> --packet-file <json>"],
  "dispatch claim": ["ai-team dispatch claim --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch prompt": ["ai-team dispatch prompt --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch schema": ["ai-team dispatch schema --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch validate": ["ai-team dispatch validate --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --result-file <json>"],
  "dispatch submit": ["ai-team dispatch submit --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --result-file <json>"],
  "decision create": ["ai-team decision create --run-id <run-id> --file <json>"],
  "run show": ["ai-team run show <run-id>"],
  "run resume": ["ai-team run resume <run-id>"],
  "run decide": ["ai-team run decide --run-id <run-id> --decision-id <opaque-id> --choice <text> [--note-file <file>]"],
  "scope check": ["ai-team scope check --run-id <run-id> --stage <stage> --paths <paths>"],
  "review create": ["ai-team review create --run-id <run-id> --revision-sha <commit> [--formal]"],
  "review submit": ["ai-team review submit --run-id <run-id> --barrier-id <opaque-id> --result-file <json>"],
  "review resolve": ["ai-team review resolve --run-id <run-id> --barrier-id <opaque-id> --resolution-file <json>"],
  "review status": ["ai-team review status --run-id <run-id> (--barrier-id <opaque-id> | --revision-sha <commit>)"],
  "git status": ["ai-team git status --run-id <run-id>"],
  "git prepare": ["ai-team git prepare --run-id <run-id> [--task-id <task-id>] [--integration] [--base-commit <commit>] [--depends-on <opaque-id>]"],
  "git commit": ["ai-team git commit --run-id <run-id> --worktree-id <opaque-id> --message <text> --scope <paths>"],
  "git merge-task": ["ai-team git merge-task --run-id <run-id> --integration-id <opaque-id> --task-id <task-id>"],
  "git continue-conflict": ["ai-team git continue-conflict --run-id <run-id> --integration-id <opaque-id> --scope <paths>"],
  "git integrate": ["ai-team git integrate --run-id <run-id> --integration-id <opaque-id>"],
  "git reconcile": ["ai-team git reconcile --run-id <run-id> [--operation-id <opaque-id> --state <state> --evidence-file <json>]"],
  "git cleanup": ["ai-team git cleanup --run-id <run-id>"],
  "install": ["ai-team install [--platform <platform-list>] [--dry-run]"],
  "env list": ["ai-team env list"],
  "env show": ["ai-team env show <name> [--resolved]"],
  "env validate": ["ai-team env validate <name>"],
  "env edit": ["ai-team env edit <name>"],
  "env generate": ["ai-team env generate [--platform <platform-list>] [--dry-run]"],
  "env switch": ["ai-team env switch <name> [--dry-run]"],
  "env status": ["ai-team env status"],
  "env doctor": ["ai-team env doctor [--probe]"],
  "backup restore": ["ai-team backup restore <path> [--dry-run]"],
  "uninstall": ["ai-team uninstall [--dry-run]"],
};

const legacyRendererNotUsed = (commands: string[]): { allowed_commands: string[]; syntax: string[]; parameter_types: Record<string, string> } => ({
  allowed_commands: commands,
  syntax: [...new Set(commands.flatMap((command) => {
    return LEGACY_RENDERER_NOT_USED[command] ?? [];
  }))],
  parameter_types: {},
}); */
const renderBody = (role: Role, platform: Platform, model: ModelConfig, environment: string): string => {
  const definition = ROLE_MANIFEST[role];
  const commandContract = commandContractFor(definition.commands);
  const metadata = { role, platform, environment, model, writes: definition.writes, staging: definition.staging, contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST, agent_build_digest: AGENT_BUILD.digest, template_version: AGENT_BUILD.templateVersion, command_contract: commandContract };
  const body = renderRoleBody(AGENT_BUILD, role, { role, purpose: definition.purpose, allowed_commands: definition.commands.join(", "), delegates: definition.delegates.join(", ") || "无", discovery: definition.discovery ? "允许" : "禁止；请请求文件探索代理支持", stop_conditions: "遇到运行数据包之外的工作时返回 requested_support", platform, environment, contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST, template_version: AGENT_BUILD.templateVersion, spec_template: AGENT_BUILD.templates.spec!, plan_template: AGENT_BUILD.templates.plan!, task_template: AGENT_BUILD.templates.task! });
  const instructions = `Role: ${role}\n\n${body}\n\n## 写入边界\n\n项目 writes：${definition.writes.length ? definition.writes.map((item) => `\`${item}\``).join(", ") : "无"}\n\nstaging.owned_entries：${definition.staging.owned_entries.length ? definition.staging.owned_entries.map((item) => `\`${item}\``).join(", ") : "无"}\n\n代理生成的每个临时 JSON 必须依次执行：\`staging create\` 获取当前 \`runId\` 下的条目、通过 stdin 执行 \`staging write --input-stdin\`、仅把 \`--staging-id\` 交给消费命令。消费成功后由 CLI 标记并清理该条目。不得为代理生成的 JSON 使用 \`--context-file\`、\`--documents-file\`、\`--file\`、\`--packet-file\`、\`--result-file\`、\`--evidence-file\`、\`--report-file\` 或 \`--resolution-file\`，也不得直接写入 \`$TMPDIR\`、项目目录或任意 \`AI_TEAM_HOME\` 路径。staging 所有权不扩大项目 writes。\n\n## CLI 命令契约\n\n允许命令：\n${commandContract.allowed_commands.map((command) => `- \`${command}\``).join("\n")}\n\n精确语法：\n${commandContract.syntax.map((syntax) => `- \`${syntax}\``).join("\n")}\n\n参数类型：\n${Object.entries(commandContract.parameter_types).map(([name, description]) => `- \`<${name}>\`: ${description}`).join("\n")}`;
  if (platform === "codex") {
    return `# ${FILE_MARKER}\n# ai_team.metadata = ${stableJson(metadata)}\nname = ${JSON.stringify(role)}\ndescription = ${JSON.stringify(definition.purpose)}\nmodel = ${JSON.stringify(model.model)}\nmodel_reasoning_effort = ${JSON.stringify(model.reasoning)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
  }
  const isPrimary = role === "planning" || role === "coding";
  const frontmatter = YAML.stringify({
    ...(platform === "opencode" ? { mode: isPrimary ? "primary" : "subagent", ...(!isPrimary ? { hidden: true } : {}) } : {}),
    model: model.model,
    effort: model.effort,
    variant: model.variant,
    options: model.options,
    ai_team: metadata,
  });
  const marker = `<!-- ${FILE_MARKER} -->`;
  return platform === "opencode"
    ? `---\n${frontmatter}---\n${marker}\n\n# ${role}\n\n${instructions}\n`
    : `${marker}\n---\n${frontmatter}---\n\n# ${role}\n\n${instructions}\n`;
};

export const renderCodexAgent = (input: AgentRenderInput): string => renderBody(input.role, "codex", input.model, input.environment);
export const renderClaudeAgent = (input: AgentRenderInput): string => renderBody(input.role, "claude", input.model, input.environment);
export const renderOpenCodeAgent = (input: AgentRenderInput): string => renderBody(input.role, "opencode", input.model, input.environment);

export const renderAgents = (environment: EnvironmentFile): Map<string, string> => {
  const resolved = resolveEnvironment(environment);
  const files = new Map<string, string>();
  for (const role of ROLES) {
    for (const platform of environment.platforms) {
      const unsupported = Object.entries(PLATFORM_CAPABILITIES[platform]).filter(([, level]) => level === "unsupported").map(([capability]) => capability);
      if (unsupported.length) throw new ValidationError(`${platform} has unsupported hard capabilities`, unsupported);
      const ext = platform === "codex" ? "toml" : "md";
      const input = { role, model: resolved[role][platform], environment: environment.name };
      const content = platform === "codex" ? renderCodexAgent(input) : platform === "claude" ? renderClaudeAgent(input) : renderOpenCodeAgent(input);
      files.set(`${platform}/agents/${role}.${ext}`, content);
    }
  }
  return files;
};

const platformTargets = (home: string): Record<Platform, { agents: string; instructions: string }> => ({
  codex: { agents: join(home, ".codex", "agents"), instructions: join(home, ".codex", "AGENTS.md") },
  claude: { agents: join(home, ".claude", "agents"), instructions: join(home, ".claude", "CLAUDE.md") },
  opencode: { agents: join(home, ".config", "opencode", "agents"), instructions: join(home, ".config", "opencode", "AGENTS.md") },
});

const managedBlock = (environment: string): string => {
  const instructions = AGENT_BUILD.instructions.replace(/{{\s*environment\s*}}/g, environment);
  if (/{{[^}]+}}/.test(instructions)) throw new ValidationError("unknown or unresolved instructions template variable");
  return `${MANAGED_START}\n${instructions.trim()}\n${MANAGED_END}`;
};

const replaceManagedBlock = (source: string, block: string | null): string => {
  const start = source.indexOf(MANAGED_START);
  const end = source.indexOf(MANAGED_END);
  if ((start >= 0) !== (end >= 0) || end < start) throw new ValidationError("invalid ai-team managed block");
  if (start >= 0) {
    const after = end + MANAGED_END.length;
    return `${source.slice(0, start).trimEnd()}${block ? `\n\n${block}` : ""}${source.slice(after)}`.trimStart();
  }
  return block ? `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${block}\n` : source;
};

interface ManifestFile { path: string; digest: string; kind: "agent" | "instructions"; }
interface EnvironmentManifest { environment: string; agent_build_digest?: string; role_manifest_digest?: string; contract_digest?: string; template_version?: number; files: ManifestFile[]; changes?: Array<{ type: "deleted" | "renamed"; from: string; to?: string }>; }
export interface GenerationPlan { writes: Array<{ path: string; content: string; kind: "agent" | "instructions" }>; backups: Array<{ source: string; destination: string }>; removals: string[]; blocked: string[]; }
interface EnvironmentConfig { state_schema_epoch: number; active_environment: string; enabled_platforms: Platform[]; client_versions: Record<Platform, { command: string; minimum: string; verified: string; detected_version?: string }>; staging: { retention_hours: number }; }

export class EnvironmentService {
  readonly paths;
  constructor(readonly aiTeamHome?: string, readonly userHome = homedir()) { this.paths = getHomePaths(aiTeamHome); }

  async bootstrap(): Promise<void> {
    await Promise.all([this.paths.environments, this.paths.schemas, this.paths.templates].map((path) => mkdir(path, { recursive: true })));
    for (const environment of DEFAULT_ENVIRONMENTS) {
      const path = join(this.paths.environments, `${environment.name}.yaml`);
      try { await stat(path); } catch { await writeFile(path, YAML.stringify(environment), { mode: 0o600 }); }
    }
    const config = join(this.paths.root, "config.yaml");
    try { await stat(config); } catch { await writeFile(config, YAML.stringify({ state_schema_epoch: 2, active_environment: "balanced", enabled_platforms: PLATFORMS, client_versions: CLIENT_VERSIONS, staging: { retention_hours: STAGING_DEFAULT_RETENTION_HOURS } }), { mode: 0o600 }); }
    await writeFile(join(this.paths.schemas, "result-envelope-v1.json"), `${JSON.stringify(resultEnvelopeSchema, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(this.paths.schemas, "environment-v1.json"), `${JSON.stringify(environmentSchema, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(this.paths.schemas, "config-v1.json"), `${JSON.stringify(environmentConfigSchema, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(this.paths.schemas, "command-contract-v1.json"), `${JSON.stringify(COMMAND_CONTRACT, null, 2)}\n`, { mode: 0o600 });
  }

  private async config(): Promise<EnvironmentConfig> {
    await this.bootstrap();
    const value = YAML.parse(await readFile(join(this.paths.root, "config.yaml"), "utf8")) as Partial<EnvironmentConfig>;
    value.staging ??= { retention_hours: STAGING_DEFAULT_RETENTION_HOURS };
    if (!validateEnvironmentConfig(value)) throw new ValidationError("environment config schema is invalid", validateEnvironmentConfig.errors);
    const normalized = value as EnvironmentConfig;
    return { state_schema_epoch: normalized.state_schema_epoch, active_environment: normalized.active_environment, enabled_platforms: [...new Set(normalized.enabled_platforms)], client_versions: normalized.client_versions, staging: { retention_hours: normalized.staging.retention_hours } };
  }

  async stagingRetentionHours(): Promise<number> { return (await this.config()).staging.retention_hours; }

  private async enabledPlatforms(): Promise<Platform[]> { return (await this.config()).enabled_platforms; }

  private assertEnabled(platforms: Platform[], enabled: Platform[]): void {
    const disabled = platforms.filter((platform) => !enabled.includes(platform));
    if (disabled.length) throw new ValidationError("platform is disabled", disabled);
  }

  async list(): Promise<string[]> { await this.bootstrap(); return (await readdir(this.paths.environments)).filter((file) => file.endsWith(".yaml")).map((file) => basename(file, ".yaml")).sort(); }

  async load(name: string): Promise<EnvironmentFile> {
    await this.bootstrap();
    const parsed = YAML.parse(await readFile(join(this.paths.environments, `${assertEnvironmentName(name)}.yaml`), "utf8")) as EnvironmentFile;
    resolveEnvironment(parsed);
    return parsed;
  }

  async active(): Promise<string> { return (await this.config()).active_environment; }

  async validate(name: string): Promise<{ name: string; roles: number; platforms: number; digest: string }> {
    const environment = await this.load(name);
    return { name, roles: ROLES.length, platforms: environment.platforms.length, digest: sha256(stableJson(resolveEnvironment(environment))) };
  }

  async explain(name: string, role: Role, platform: Platform): Promise<EnvironmentExplanation> {
    const environment = await this.load(name);
    return explainEnvironment(environment, join(this.paths.environments, `${name}.yaml`), role, platform);
  }

  async diff(from: string, to: string, role?: Role, platform?: Platform): Promise<EnvironmentDiff> {
    if (role !== undefined && !ROLES.includes(role)) throw new ValidationError(`invalid environment role: ${role}`);
    if (platform !== undefined && !PLATFORMS.includes(platform)) throw new ValidationError(`invalid environment platform: ${platform}`);
    const [beforeEnvironment, afterEnvironment] = await Promise.all([this.load(from), this.load(to)]);
    if (platform !== undefined && !beforeEnvironment.platforms.includes(platform) && !afterEnvironment.platforms.includes(platform)) {
      throw new ValidationError(`${platform} platform is not enabled in either environment`);
    }
    const roles = role === undefined ? ROLES : [role];
    const platforms = platform === undefined
      ? PLATFORMS.filter((candidate) => beforeEnvironment.platforms.includes(candidate) || afterEnvironment.platforms.includes(candidate))
      : [platform];
    const changes: EnvironmentDiffChange[] = [];
    for (const selectedRole of roles) {
      for (const selectedPlatform of platforms) {
        const beforeExplanation = beforeEnvironment.platforms.includes(selectedPlatform)
          ? explainEnvironment(beforeEnvironment, join(this.paths.environments, `${from}.yaml`), selectedRole, selectedPlatform)
          : null;
        const afterExplanation = afterEnvironment.platforms.includes(selectedPlatform)
          ? explainEnvironment(afterEnvironment, join(this.paths.environments, `${to}.yaml`), selectedRole, selectedPlatform)
          : null;
        if (stableJson(beforeExplanation?.value ?? null) === stableJson(afterExplanation?.value ?? null)) continue;
        changes.push({
          role: selectedRole,
          platform: selectedPlatform,
          before: beforeExplanation ? { value: beforeExplanation.value, source: beforeExplanation.source } : null,
          after: afterExplanation ? { value: afterExplanation.value, source: afterExplanation.source } : null,
        });
      }
    }
    return { from, to, changes };
  }

  async validateClientVersions(platforms: Platform[]): Promise<Array<{ platform: Platform; status: string; version?: string }>> {
    const config = await this.config();
    const selected = platforms.map((platform) => {
      if (!config.enabled_platforms.includes(platform)) return { platform, status: "disabled" };
      const value = config.client_versions[platform]; const version = value.detected_version;
      if (!version) return { platform, status: "missing" };
      if (semver.lt(version, value.minimum)) return { platform, status: "blocked", version };
      return { platform, status: semver.gt(version, value.verified) ? "warning-unverified" : "supported", version };
    });
    const blocked = selected.filter((item) => item.status === "blocked" || item.status === "missing" || item.status === "unknown-version");
    if (blocked.length) throw new IncompatibleError("client version gate blocked generation", blocked);
    return selected;
  }

  async plan(name: string, selected?: Platform[]): Promise<GenerationPlan> {
    const environment = await this.load(name);
    const enabled = await this.enabledPlatforms();
    if (selected) this.assertEnabled(selected, enabled);
    environment.platforms = (selected ?? environment.platforms).filter((platform) => enabled.includes(platform));
    const rendered = renderAgents(environment);
    const targets = platformTargets(this.userHome);
    const writes: GenerationPlan["writes"] = [];
    const backups: GenerationPlan["backups"] = [];
    const blocked: string[] = [];
    let previous: EnvironmentManifest | undefined;
    try { previous = JSON.parse(await readFile(join(this.paths.root, "manifest.json"), "utf8")) as EnvironmentManifest; } catch { /* first generation */ }
    const backupPath = (path: string): string => join(this.paths.backups, "latest", sha256(path).slice(0, 16), basename(path));
    for (const [key, content] of rendered) {
      const [platform, , filename] = key.split("/") as [Platform, string, string];
      const path = join(targets[platform].agents, filename);
      await assertManagedTarget(this.userHome, path);
      try {
        const current = await readFile(path, "utf8");
        const owned = previous?.files.find((file) => file.path === path);
        if (owned && sha256(current) !== owned.digest) blocked.push(path);
        else if (current !== content) backups.push({ source: path, destination: backupPath(path) });
      } catch { /* new file */ }
      writes.push({ path, content, kind: "agent" });
    }
    for (const platform of environment.platforms) {
      const path = targets[platform].instructions;
      await assertManagedTarget(this.userHome, path);
      let current = "";
      try {
        current = await readFile(path, "utf8");
        const owned = previous?.files.find((file) => file.path === path);
        if (owned && sha256(current) !== owned.digest) blocked.push(path);
        else backups.push({ source: path, destination: backupPath(path) });
      } catch { /* new file */ }
      writes.push({ path, content: replaceManagedBlock(current, managedBlock(name)), kind: "instructions" });
    }
    const nextPaths = new Set(writes.map((item) => item.path));
    const obsolete = (previous?.files ?? []).filter((file) => {
      if (nextPaths.has(file.path)) return false;
      const platform = PLATFORMS.find((candidate) => file.path === targets[candidate].instructions || file.path.startsWith(`${targets[candidate].agents}${sep}`));
      return !platform || enabled.includes(platform);
    });
    const removals: string[] = [];
    const disabledTargets = new Set<Platform>(PLATFORMS.filter((platform) => !enabled.includes(platform)));
    for (const file of obsolete) {
      const disabled = [...disabledTargets].some((platform) => file.path === targets[platform].instructions || file.path.startsWith(`${targets[platform].agents}${sep}`));
      if (disabled) continue;
      try {
        const current = await readFile(file.path, "utf8");
        if (sha256(current) !== file.digest) blocked.push(file.path);
        else { removals.push(file.path); backups.push({ source: file.path, destination: backupPath(file.path) }); }
      } catch { /* already absent */ }
    }
    return { writes, backups, removals, blocked };
  }

  async generate(name: string, selected?: Platform[], dryRun = false): Promise<GenerationPlan> {
    await mkdir(this.paths.root, { recursive: true });
    const release = await lockfile.lock(this.paths.root, { realpath: false, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 } });
    try { return await this.generateLocked(name, selected, dryRun); }
    finally { await release(); }
  }

  private async generateLocked(name: string, selected?: Platform[], dryRun = false): Promise<GenerationPlan> {
    const plan = await this.plan(name, selected);
    if (dryRun) return plan;
    const environment = await this.load(name);
    await this.validateClientVersions(selected ?? environment.platforms);
    if (plan.blocked.length) throw new ValidationError("managed role deletion or rename is blocked by drift", plan.blocked);
    const stage = await mkdtemp(join(tmpdir(), "ai-team-stage-"));
    const completed: Array<{ path: string; backup?: string }> = [];
    const controlBackups = new Map<string, string | null>();
    try {
      for (let index = 0; index < plan.writes.length; index += 1) {
        const item = plan.writes[index]!;
        const staged = join(stage, String(index));
        await writeFile(staged, item.content, { mode: 0o600 });
        const reread = await readFile(staged, "utf8");
        if (reread !== item.content) throw new Error("staging verification failed");
      }
      for (const item of plan.backups) { await mkdir(dirname(item.destination), { recursive: true }); await cp(item.source, item.destination); }
      let backupIndex: Record<string, string> = {};
      const backupIndexPath = join(this.paths.root, "backup-index.json");
      try { backupIndex = JSON.parse(await readFile(backupIndexPath, "utf8")) as Record<string, string>; } catch { /* first backup */ }
      for (const item of plan.backups) backupIndex[item.destination] = item.source;
      if (plan.backups.length) await writeFile(backupIndexPath, `${JSON.stringify(backupIndex, null, 2)}\n`, { mode: 0o600 });
      for (const path of plan.removals) {
        const backup = plan.backups.find((candidate) => candidate.source === path)?.destination;
        await rm(path, { force: true });
        completed.push({ path, ...(backup ? { backup } : {}) });
      }
      for (let index = 0; index < plan.writes.length; index += 1) {
        const item = plan.writes[index]!;
        await mkdir(dirname(item.path), { recursive: true });
        const backup = plan.backups.find((candidate) => candidate.source === item.path)?.destination;
        await rename(join(stage, String(index)), item.path);
        completed.push({ path: item.path, ...(backup ? { backup } : {}) });
      }
      const manifestPath = join(this.paths.root, "manifest.json");
      const configPath = join(this.paths.root, "config.yaml");
      for (const path of [manifestPath, configPath]) { try { controlBackups.set(path, await readFile(path, "utf8")); } catch { controlBackups.set(path, null); } }
      const config = YAML.parse(await readFile(configPath, "utf8")); config.active_environment = name;
      const stagedManifest = join(stage, "manifest");
      const stagedConfig = join(stage, "config");
      const previousManifest = controlBackups.get(manifestPath) ? JSON.parse(controlBackups.get(manifestPath)!) as EnvironmentManifest : undefined;
      const previousPaths = new Set(previousManifest?.files.map((file) => file.path) ?? []);
      const nextPaths = new Set(plan.writes.map((item) => item.path));
      const changes = [...previousPaths].filter((path) => !nextPaths.has(path)).map((path) => ({ type: "deleted" as const, from: path }));
      await writeFile(stagedManifest, `${JSON.stringify({ environment: name, agent_build_digest: AGENT_BUILD.digest, role_manifest_digest: ROLE_MANIFEST_DIGEST, contract_digest: CONTRACT_DIGEST, template_version: AGENT_BUILD.templateVersion, files: plan.writes.map((item) => ({ path: item.path, digest: sha256(item.content), kind: item.kind })), changes }, null, 2)}\n`, { mode: 0o600 });
      await writeFile(stagedConfig, YAML.stringify(config), { mode: 0o600 });
      await rename(stagedManifest, manifestPath);
      await rename(stagedConfig, configPath);
      return plan;
    } catch (error) {
      for (const item of completed.reverse()) { if (item.backup) await cp(item.backup, item.path); else await rm(item.path, { force: true }); }
      for (const [path, content] of controlBackups) { if (content === null) await rm(path, { force: true }); else await writeFile(path, content, { mode: 0o600 }); }
      throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async status(): Promise<Array<{ path: string; state: "in-sync" | "missing" | "drifted" | "disabled" }>> {
    const manifestPath = join(this.paths.root, "manifest.json");
    let manifest: any; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { return []; }
    const enabled = await this.enabledPlatforms();
    const targets = platformTargets(this.userHome);
    return Promise.all(manifest.files.map(async (file: any) => {
      const platform = PLATFORMS.find((candidate) => file.path === targets[candidate].instructions || file.path.startsWith(`${targets[candidate].agents}${sep}`));
      if (platform && !enabled.includes(platform)) return { path: file.path, state: "disabled" as const };
      try { return { path: file.path, state: sha256(await readFile(file.path, "utf8")) === file.digest ? "in-sync" : "drifted" }; }
      catch { return { path: file.path, state: "missing" }; }
    }));
  }

  async uninstall(dryRun = false): Promise<{ removals: string[]; blocked: string[] }> {
    const manifestPath = join(this.paths.root, "manifest.json");
    let manifest: EnvironmentManifest; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EnvironmentManifest; } catch { return { removals: [], blocked: [] }; }
    const status = await this.status();
    const blocked = status.filter((item) => item.state === "drifted").map((item) => item.path);
    const removals = status.filter((item) => item.state === "in-sync").map((item) => item.path);
    if (!dryRun && blocked.length) throw new ValidationError("managed files drifted; uninstall blocked", blocked);
    if (!dryRun) {
      for (const path of removals) {
        const file = manifest.files.find((item) => item.path === path);
        if (file?.kind === "instructions") {
          const updated = replaceManagedBlock(await readFile(path, "utf8"), null);
          if (updated.trim()) await writeFile(path, updated); else await rm(path, { force: true });
        } else await rm(path, { force: true });
      }
      await rm(manifestPath, { force: true });
    }
    return { removals, blocked };
  }

  async restore(path: string, dryRun = false): Promise<{ source: string; destination: string }> {
    assertReadablePath(path);
    const absolute = resolve(path);
    const backupRoot = resolve(this.paths.backups);
    const backupRel = relative(backupRoot, absolute);
    if (backupRel === ".." || backupRel.startsWith(`..${sep}`) || backupRel === "") throw new ValidationError("restore source must be inside ai-team backups");
    const canonicalBackupRoot = await realpath(backupRoot);
    const canonicalSource = await realpath(absolute);
    const sourceRel = relative(canonicalBackupRoot, canonicalSource);
    if (sourceRel === ".." || sourceRel.startsWith(`..${sep}`)) throw new ValidationError("restore source escapes backups through symlink");
    const indexed = await this.findBackupDestination(absolute);
    const backupRelative = absolute.slice(resolve(this.paths.backups).length + 1).split("/");
    const legacyRelative = backupRelative.length > 2 ? backupRelative.slice(1).join("/") : undefined;
    const destination = indexed ?? (legacyRelative ? join(this.userHome, legacyRelative) : join(this.userHome, basename(absolute)));
    assertWritablePath(destination);
    const destinationParent = dirname(destination);
    let existingParent = destinationParent;
    while (true) {
      try { await stat(existingParent); break; } catch { const next = dirname(existingParent); if (next === existingParent) break; existingParent = next; }
    }
    const canonicalHome = await realpath(this.userHome);
    const canonicalParent = await realpath(existingParent);
    const parentRel = relative(canonicalHome, canonicalParent);
    if (parentRel === ".." || parentRel.startsWith(`..${sep}`)) throw new ValidationError("restore destination escapes user home through symlink");
    try { await stat(destination); throw new ValidationError(`restore destination exists: ${destination}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    if (!dryRun) { await mkdir(dirname(destination), { recursive: true }); await cp(absolute, destination); }
    return { source: absolute, destination };
  }

  private async findBackupDestination(source: string): Promise<string | undefined> {
    try {
      const manifest = JSON.parse(await readFile(join(this.paths.root, "backup-index.json"), "utf8")) as Record<string, string>;
      return manifest[source];
    } catch { return undefined; }
  }

  async doctor(probe = false): Promise<Array<{ platform: Platform; status: string; version?: string }>> {
    const config = await this.config();
    const disabled = PLATFORMS.filter((platform) => !config.enabled_platforms.includes(platform));
    const results = await Promise.all(PLATFORMS.filter((platform) => config.enabled_platforms.includes(platform)).map(async (platform) => {
      if (!probe) return { platform, status: "not-probed" };
      try {
        const { stdout } = await execFileAsync(CLIENT_VERSIONS[platform].command, ["--version"]);
        const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
        if (!version) return { platform, status: "unknown-version" };
        if (semver.lt(version, CLIENT_VERSIONS[platform].minimum)) return { platform, status: "blocked", version };
        return { platform, status: semver.gt(version, CLIENT_VERSIONS[platform].verified) ? "warning-unverified" : "supported", version };
      } catch { return { platform, status: "missing" }; }
    }));
    if (probe) {
      const configPath = join(this.paths.root, "config.yaml");
      const stored = YAML.parse(await readFile(configPath, "utf8")) as EnvironmentConfig;
      for (const result of results) if (result.version) stored.client_versions[result.platform].detected_version = result.version;
      await writeFile(configPath, YAML.stringify(stored), { mode: 0o600 });
    }
    return [...results, ...disabled.map((platform) => ({ platform, status: "disabled" }))].sort((left, right) => PLATFORMS.indexOf(left.platform) - PLATFORMS.indexOf(right.platform));
  }
}
