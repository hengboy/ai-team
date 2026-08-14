import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import lockfile from "proper-lockfile";
import YAML from "yaml";
import { CONTRACT_DIGEST } from "./contracts.js";
import { resultEnvelopeSchema } from "./contracts.js";
import { Ajv } from "ajv";
import { ValidationError } from "./errors.js";
import { getHomePaths } from "./home.js";
import { AGENT_BUILD, ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "./roles.js";
import { renderRoleBody } from "./agent-build.js";
import { ROLES, type Role } from "./constants.js";
import { sha256, stableJson } from "./utils.js";

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
    overrides: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: {
      codex: { type: "object", additionalProperties: false, required: ["model", "reasoning"], properties: { model: { type: "string", minLength: 1 }, reasoning: { enum: REASONING } } },
      claude: { type: "object", additionalProperties: false, required: ["model", "effort"], properties: { model: { type: "string", minLength: 1 }, effort: { enum: EFFORT } } },
      opencode: { type: "object", additionalProperties: false, required: ["model", "variant", "options"], properties: { model: { type: "string", minLength: 1 }, variant: { enum: VARIANTS }, options: { type: "object" } } },
    } } },
  },
} as const;
const validateEnvironmentSchema = new Ajv({ allErrors: true, strict: false }).compile(environmentSchema);

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

export interface AgentRenderInput { role: Role; model: ModelConfig; environment: string; }
const renderBody = (role: Role, platform: Platform, model: ModelConfig, environment: string): string => {
  const definition = ROLE_MANIFEST[role];
  const metadata = { role, platform, environment, model, contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST, agent_build_digest: AGENT_BUILD.digest, template_version: AGENT_BUILD.templateVersion };
  const instructions = `Role: ${role}\n\n${renderRoleBody(AGENT_BUILD, role, { role, purpose: definition.purpose, allowed_commands: definition.commands.join(", "), delegates: definition.delegates.join(", ") || "无", discovery: definition.discovery ? "允许" : "禁止；请请求文件探索代理支持", stop_conditions: "遇到运行数据包之外的工作时返回 requested_support", platform, environment, contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST, template_version: AGENT_BUILD.templateVersion, spec_template: AGENT_BUILD.templates.spec!, plan_template: AGENT_BUILD.templates.plan!, task_template: AGENT_BUILD.templates.task! })}`;
  if (platform === "codex") {
    return `# ${FILE_MARKER}\nmodel = ${JSON.stringify(model.model)}\nmodel_reasoning_effort = ${JSON.stringify(model.reasoning)}\n\n[ai_team]\nmetadata = ${JSON.stringify(stableJson(metadata))}\ninstructions = ${JSON.stringify(instructions)}\n`;
  }
  const frontmatter = YAML.stringify({ model: model.model, effort: model.effort, variant: model.variant, options: model.options, ai_team: metadata });
  return `<!-- ${FILE_MARKER} -->\n---\n${frontmatter}---\n\n# ${role}\n\n${instructions}\n`;
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
interface EnvironmentManifest { environment: string; agent_build_digest?: string; template_version?: number; files: ManifestFile[]; changes?: Array<{ type: "deleted" | "renamed"; from: string; to?: string }>; }
export interface GenerationPlan { writes: Array<{ path: string; content: string; kind: "agent" | "instructions" }>; backups: Array<{ source: string; destination: string }>; removals: string[]; blocked: string[]; }

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
    try { await stat(config); } catch { await writeFile(config, YAML.stringify({ active_environment: "balanced", enabled_platforms: PLATFORMS, client_versions: CLIENT_VERSIONS }), { mode: 0o600 }); }
    await writeFile(join(this.paths.schemas, "result-envelope-v1.json"), `${JSON.stringify(resultEnvelopeSchema, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(this.paths.schemas, "environment-v1.json"), `${JSON.stringify(environmentSchema, null, 2)}\n`, { mode: 0o600 });
  }

  async list(): Promise<string[]> { await this.bootstrap(); return (await readdir(this.paths.environments)).filter((file) => file.endsWith(".yaml")).map((file) => basename(file, ".yaml")).sort(); }

  async load(name: string): Promise<EnvironmentFile> {
    await this.bootstrap();
    const parsed = YAML.parse(await readFile(join(this.paths.environments, `${name}.yaml`), "utf8")) as EnvironmentFile;
    resolveEnvironment(parsed);
    return parsed;
  }

  async active(): Promise<string> { await this.bootstrap(); return (YAML.parse(await readFile(join(this.paths.root, "config.yaml"), "utf8")) as any).active_environment; }

  async validate(name: string): Promise<{ name: string; roles: number; platforms: number; digest: string }> {
    const environment = await this.load(name);
    return { name, roles: ROLES.length, platforms: environment.platforms.length, digest: sha256(stableJson(resolveEnvironment(environment))) };
  }

  async validateClientVersions(platforms: Platform[]): Promise<Array<{ platform: Platform; status: string; version?: string }>> {
    await this.bootstrap();
    const config = YAML.parse(await readFile(join(this.paths.root, "config.yaml"), "utf8")) as { client_versions: Record<Platform, { minimum: string; verified: string; detected_version?: string }> };
    const selected = platforms.map((platform) => {
      const value = config.client_versions[platform]; const version = value.detected_version;
      if (!version) return { platform, status: "missing" };
      if (semver.lt(version, value.minimum)) return { platform, status: "blocked", version };
      return { platform, status: semver.gt(version, value.verified) ? "warning-unverified" : "supported", version };
    });
    const blocked = selected.filter((item) => item.status === "blocked" || item.status === "missing" || item.status === "unknown-version");
    if (blocked.length) throw new ValidationError("client version gate blocked generation", blocked);
    return selected;
  }

  async plan(name: string, selected?: Platform[]): Promise<GenerationPlan> {
    const environment = await this.load(name);
    if (selected) environment.platforms = selected;
    const rendered = renderAgents(environment);
    const targets = platformTargets(this.userHome);
    const writes: GenerationPlan["writes"] = [];
    const backups: GenerationPlan["backups"] = [];
    let previous: EnvironmentManifest | undefined;
    try { previous = JSON.parse(await readFile(join(this.paths.root, "manifest.json"), "utf8")) as EnvironmentManifest; } catch { /* first generation */ }
    const backupPath = (path: string): string => join(this.paths.backups, "latest", sha256(path).slice(0, 16), basename(path));
    for (const [key, content] of rendered) {
      const [platform, , filename] = key.split("/") as [Platform, string, string];
      const path = join(targets[platform].agents, filename);
      try {
        const current = await readFile(path, "utf8");
        if (current !== content) backups.push({ source: path, destination: backupPath(path) });
      } catch { /* new file */ }
      writes.push({ path, content, kind: "agent" });
    }
    for (const platform of environment.platforms) {
      const path = targets[platform].instructions;
      let current = "";
      try { current = await readFile(path, "utf8"); backups.push({ source: path, destination: backupPath(path) }); } catch { /* new file */ }
      writes.push({ path, content: replaceManagedBlock(current, managedBlock(name)), kind: "instructions" });
    }
    const nextPaths = new Set(writes.map((item) => item.path));
    const obsolete = (previous?.files ?? []).filter((file) => !nextPaths.has(file.path));
    const removals: string[] = [];
    const blocked: string[] = [];
    for (const file of obsolete) {
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
      await writeFile(stagedManifest, `${JSON.stringify({ environment: name, agent_build_digest: AGENT_BUILD.digest, template_version: AGENT_BUILD.templateVersion, files: plan.writes.map((item) => ({ path: item.path, digest: sha256(item.content), kind: item.kind })), changes }, null, 2)}\n`, { mode: 0o600 });
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

  async status(): Promise<Array<{ path: string; state: "in-sync" | "missing" | "drifted" }>> {
    const manifestPath = join(this.paths.root, "manifest.json");
    let manifest: any; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { return []; }
    return Promise.all(manifest.files.map(async (file: any) => {
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
    if (!probe) return PLATFORMS.map((platform) => ({ platform, status: "not-probed" }));
    const results = await Promise.all(PLATFORMS.map(async (platform) => {
      try {
        const { stdout } = await execFileAsync(CLIENT_VERSIONS[platform].command, ["--version"]);
        const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
        if (!version) return { platform, status: "unknown-version" };
        if (semver.lt(version, CLIENT_VERSIONS[platform].minimum)) return { platform, status: "blocked", version };
        return { platform, status: semver.gt(version, CLIENT_VERSIONS[platform].verified) ? "warning-unverified" : "supported", version };
      } catch { return { platform, status: "missing" }; }
    }));
    const configPath = join(this.paths.root, "config.yaml");
    const config = YAML.parse(await readFile(configPath, "utf8"));
    for (const result of results) if (result.version) config.client_versions[result.platform].detected_version = result.version;
    await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
    return results;
  }
}
