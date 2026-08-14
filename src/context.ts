import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { checkProjectContext, type ProjectContext } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { git, repositoryIdentity } from "./git.js";
import { canonicalizeInside, isSensitivePath } from "./security.js";
import { assertRelativePosixPath, stableJson } from "./utils.js";

export const MEMORY_PATH = "MEMORY.md";
export const NAVIGATION_PATH = ".ai-work-flow/index/feature-navigation.md";
export const INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;
export const CONTEXT_RULE = "所有`仓库文件检索`、`目录遍历`、`文件名/全文搜索`、`入口定位`、`调用链`和`未知依赖探索`必须委派给 **File Explorer**；其他代理只能读取 `packet` 明确授权或 **File Explorer** 返回的精确路径，遇到未知路径时请求支持，不得自行使用 `rg`、`find`、`glob` 或`全仓扫描`。入口、职责或模块边界变化时，同轮更新根 `MEMORY.md` 与 `.ai-work-flow/index/feature-navigation.md`；评审以已提交 `MEMORY.md` 为 standards source。";

const MEMORY_START = "<!-- ai-team:project-context:start -->";
const MEMORY_END = "<!-- ai-team:project-context:end -->";
const MEMORY_HEADING = "## 项目上下文";
const NAVIGATION_START = "<!-- ai-team:feature-navigation:start -->";
const NAVIGATION_END = "<!-- ai-team:feature-navigation:end -->";
const NAVIGATION_HEADING = "# Feature Navigation";
const NAVIGATION_ENTRY = "<!-- ai-team:feature-navigation-entry ";
const EMPTY = "_待补充_";

interface MemoryData {
  projectShape: string;
  domainTerms: string[];
  repositoryConstraints: string[];
  responsibilities: string[];
  moduleBoundaries: string[];
}

export interface PendingWrite {
  path: string;
  content: string;
  existed: boolean;
}

export interface ContextInitPlan {
  memory_path: string;
  navigation_path: string;
  memory_status: "created" | "updated" | "unchanged";
  navigation_status: "created" | "updated" | "unchanged";
  instruction_statuses: Array<{ path: string; status: "updated" | "unchanged" | "absent" }>;
  dirty_paths: string[];
}

export interface ContextValidation {
  valid: boolean;
  memory: { path: string; exists: boolean; section_count: number; valid: boolean; issues: string[] };
  navigation: { path: string; exists: boolean; section_count: number; valid: boolean; entries: number; invalid_paths: string[]; issues: string[] };
  instructions: Array<{ path: string; exists: boolean; rule_present: boolean }>;
  maintenance: { status: "current" | "needs_update"; paths: string[] };
}

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const occurrences = (source: string, value: string): number => source.split(value).length - 1;
const unique = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const bulletBlock = (values: string[]): string => values.length ? values.map((value) => `- ${value}`).join("\n") : EMPTY;

const renderMemorySection = (data: MemoryData): string => [
  MEMORY_START,
  MEMORY_HEADING,
  "",
  "### 项目形态",
  data.projectShape || EMPTY,
  "",
  "### 领域术语",
  bulletBlock(data.domainTerms),
  "",
  "### 仓库约束",
  bulletBlock(data.repositoryConstraints),
  "",
  "### 职责",
  bulletBlock(data.responsibilities),
  "",
  "### 模块边界",
  bulletBlock(data.moduleBoundaries),
  MEMORY_END,
].join("\n");

const emptyMemory = (): MemoryData => ({
  projectShape: "",
  domainTerms: [],
  repositoryConstraints: [],
  responsibilities: [],
  moduleBoundaries: [],
});

const parseList = (source: string, heading: string, next: string): string[] => {
  const pattern = new RegExp(`^### ${heading}\\n([\\s\\S]*?)(?=\\n(?:### ${next}|${MEMORY_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$)`, "m");
  const match = pattern.exec(source);
  if (!match) throw new ValidationError(`MEMORY.md project context is missing ${heading}`);
  const body = match[1]!.trim();
  if (!body || body === EMPTY) return [];
  const lines = body.split("\n");
  if (lines.some((line) => !line.startsWith("- ") || !line.slice(2).trim())) throw new ValidationError(`MEMORY.md ${heading} must contain only bullet entries`);
  return unique(lines.map((line) => line.slice(2)));
};

const parseMemory = (source: string): { data: MemoryData; start: number; end: number } => {
  if (occurrences(source, MEMORY_START) !== 1 || occurrences(source, MEMORY_END) !== 1 || occurrences(source, MEMORY_HEADING) !== 1) {
    throw new ValidationError("MEMORY.md must contain exactly one well-formed project context section");
  }
  const start = source.indexOf(MEMORY_START);
  const endMarker = source.indexOf(MEMORY_END);
  if (start < 0 || endMarker < start) throw new ValidationError("MEMORY.md project context markers are malformed");
  const end = endMarker + MEMORY_END.length;
  const managed = source.slice(start, end);
  const shape = /^### 项目形态\n([^\n]+)$/m.exec(managed)?.[1]?.trim();
  if (shape === undefined) throw new ValidationError("MEMORY.md project context is missing 项目形态");
  for (const heading of ["项目形态", "领域术语", "仓库约束", "职责", "模块边界"]) {
    if (occurrences(managed, `### ${heading}`) !== 1) throw new ValidationError(`MEMORY.md project context has duplicate or missing ${heading}`);
  }
  return {
    start,
    end,
    data: {
      projectShape: shape === EMPTY ? "" : shape,
      domainTerms: parseList(managed, "领域术语", "仓库约束"),
      repositoryConstraints: parseList(managed, "仓库约束", "职责"),
      responsibilities: parseList(managed, "职责", "模块边界"),
      moduleBoundaries: parseList(managed, "模块边界", "never"),
    },
  };
};

const ensureSingleManagedSection = (source: string | undefined, kind: "memory" | "navigation"): void => {
  if (source === undefined) return;
  const [start, end, heading] = kind === "memory"
    ? [MEMORY_START, MEMORY_END, MEMORY_HEADING]
    : [NAVIGATION_START, NAVIGATION_END, NAVIGATION_HEADING];
  const starts = occurrences(source, start);
  const ends = occurrences(source, end);
  const headings = occurrences(source, heading);
  if (starts === 0 && ends === 0 && headings === 0) return;
  if (starts !== 1 || ends !== 1 || headings !== 1 || source.indexOf(start) > source.indexOf(end)) {
    throw new ValidationError(`${kind === "memory" ? "MEMORY.md" : NAVIGATION_PATH} has duplicate or malformed managed sections`);
  }
};

const appendSection = (source: string, section: string): string => `${source}${source && !source.endsWith("\n") ? "\n" : ""}${source ? "\n" : ""}${section}\n`;
const replaceSection = (source: string, start: number, end: number, section: string): string => `${source.slice(0, start)}${section}${source.slice(end)}`;

const escapeTable = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const renderNavigationSection = (entries: ProjectContext["navigation"]): string => {
  const rows = entries.map((entry) => `| ${escapeTable(entry.feature)} | ${entry.keywords.map(escapeTable).join(", ")} | ${entry.entry_paths.map((path) => `\`${path}\``).join("<br>")} | ${escapeTable(entry.module_boundary)} |`);
  const metadata = entries.map((entry) => `${NAVIGATION_ENTRY}${stableJson(entry)} -->`);
  return [
    NAVIGATION_START,
    NAVIGATION_HEADING,
    "",
    "| 功能 | 关键词 | 入口路径 | 模块边界 |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(metadata.length ? ["", ...metadata] : []),
    NAVIGATION_END,
  ].join("\n");
};

const parseNavigation = (source: string): { entries: ProjectContext["navigation"]; start: number; end: number } => {
  ensureSingleManagedSection(source, "navigation");
  const start = source.indexOf(NAVIGATION_START);
  const endMarker = source.indexOf(NAVIGATION_END);
  if (start < 0 || endMarker < start) throw new ValidationError(`${NAVIGATION_PATH} managed section is missing`);
  const end = endMarker + NAVIGATION_END.length;
  const managed = source.slice(start, end);
  if (occurrences(managed, NAVIGATION_HEADING) !== 1) throw new ValidationError(`${NAVIGATION_PATH} must contain exactly one heading`);
  const lines = managed.split("\n");
  const headerIndex = lines.indexOf("| 功能 | 关键词 | 入口路径 | 模块边界 |");
  const separatorIndex = lines.indexOf("| --- | --- | --- | --- |");
  if (headerIndex < 0 || separatorIndex !== headerIndex + 1) throw new ValidationError(`${NAVIGATION_PATH} has a malformed navigation table`);
  const entries: ProjectContext["navigation"] = [];
  let tableRows = 0;
  for (const [index, line] of lines.entries()) {
    if (index > separatorIndex && line.startsWith("|")) {
      if (line.split("|").length < 6) throw new ValidationError(`${NAVIGATION_PATH} has a malformed table row`);
      tableRows += 1;
    }
    if (!line.startsWith(NAVIGATION_ENTRY)) continue;
    if (!line.endsWith(" -->")) throw new ValidationError(`${NAVIGATION_PATH} has malformed entry metadata`);
    let value: unknown;
    try { value = JSON.parse(line.slice(NAVIGATION_ENTRY.length, -4)); } catch { throw new ValidationError(`${NAVIGATION_PATH} has invalid entry metadata`); }
    const checked = checkProjectContext({ project_shape: "navigation", memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] }, navigation: [value], maintenance: { status: "current", paths: [] } });
    if (!checked.valid) throw new ValidationError(`${NAVIGATION_PATH} has invalid entry metadata`, checked.errors);
    entries.push(checked.value.navigation[0]!);
  }
  if (tableRows !== entries.length) throw new ValidationError(`${NAVIGATION_PATH} table rows do not match entry metadata`);
  return { entries, start, end };
};

const navigationKey = (entry: ProjectContext["navigation"][number]): string => `${entry.feature.trim().toLocaleLowerCase()}\0${entry.module_boundary.trim().toLocaleLowerCase()}`;

const assertNavigationPath = async (root: string, path: string): Promise<void> => {
  assertRelativePosixPath(path);
  if (posix.normalize(path) !== path || path === ".") throw new ValidationError(`navigation path must be normalized: ${path}`);
  if (isSensitivePath(path)) throw new ValidationError(`navigation path is sensitive: ${path}`);
  const local = join(root, path);
  const info = await lstat(local).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new ValidationError(`navigation path does not exist: ${path}`);
    throw error;
  });
  if (info.isSymbolicLink()) throw new ValidationError(`navigation path must not be a symbolic link: ${path}`);
  await canonicalizeInside(root, path);
  const canonicalInfo = await stat(local);
  if (!canonicalInfo.isFile() && !canonicalInfo.isDirectory()) throw new ValidationError(`navigation path is not a file or directory: ${path}`);
};

const validateNavigationEntries = async (root: string, entries: ProjectContext["navigation"]): Promise<void> => {
  for (const entry of entries) for (const path of entry.entry_paths) await assertNavigationPath(root, path);
};

const pathDirty = async (root: string, path: string): Promise<boolean> => {
  const result = await git(root, ["status", "--porcelain=v1", "--", path]);
  return Boolean(result.stdout);
};

const makeInstructionContent = (source: string): string => source.includes(CONTEXT_RULE)
  ? source
  : `${source}${source && !source.endsWith("\n") ? "\n" : ""}${source ? "\n" : ""}${CONTEXT_RULE}\n`;

const prepareInitialization = async (root: string): Promise<{ plan: ContextInitPlan; writes: PendingWrite[] }> => {
  const memoryFile = join(root, MEMORY_PATH);
  const navigationFile = join(root, NAVIGATION_PATH);
  const memory = await readOptional(memoryFile);
  const navigation = await readOptional(navigationFile);
  ensureSingleManagedSection(memory, "memory");
  ensureSingleManagedSection(navigation, "navigation");

  const memoryContent = memory === undefined
    ? `${renderMemorySection(emptyMemory())}\n`
    : memory.includes(MEMORY_START) ? (parseMemory(memory), memory) : appendSection(memory, renderMemorySection(emptyMemory()));
  const navigationContent = navigation === undefined
    ? `${renderNavigationSection([])}\n`
    : navigation.includes(NAVIGATION_START) ? (parseNavigation(navigation), navigation) : appendSection(navigation, renderNavigationSection([]));
  const writes: PendingWrite[] = [];
  if (memoryContent !== memory) writes.push({ path: memoryFile, content: memoryContent, existed: memory !== undefined });
  if (navigationContent !== navigation) writes.push({ path: navigationFile, content: navigationContent, existed: navigation !== undefined });

  const instructionStatuses: ContextInitPlan["instruction_statuses"] = [];
  for (const relativePath of INSTRUCTION_PATHS) {
    const absolute = join(root, relativePath);
    const source = await readOptional(absolute);
    if (source === undefined) {
      instructionStatuses.push({ path: relativePath, status: "absent" });
      continue;
    }
    const content = makeInstructionContent(source);
    const status = content === source ? "unchanged" : "updated";
    instructionStatuses.push({ path: relativePath, status });
    if (status === "updated") writes.push({ path: absolute, content, existed: true });
  }
  const dirtyPaths: string[] = [];
  for (const write of writes) {
    if (write.existed) {
      const relativePath = write.path.slice(root.length + 1);
      if (await pathDirty(root, relativePath)) dirtyPaths.push(relativePath);
    }
  }
  return {
    writes,
    plan: {
      memory_path: MEMORY_PATH,
      navigation_path: NAVIGATION_PATH,
      memory_status: memory === undefined ? "created" : memoryContent === memory ? "unchanged" : "updated",
      navigation_status: navigation === undefined ? "created" : navigationContent === navigation ? "unchanged" : "updated",
      instruction_statuses: instructionStatuses,
      dirty_paths: dirtyPaths,
    },
  };
};

export const atomicReplaceFiles = async (writes: PendingWrite[], afterReplace?: (count: number) => void | Promise<void>): Promise<void> => {
  if (!writes.length) return;
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const staged = await Promise.all(writes.map(async (write) => ({
    ...write,
    temp: `${write.path}.tmp-${token}`,
    backup: `${write.path}.bak-${token}`,
    mode: write.existed ? (await stat(write.path)).mode & 0o777 : 0o644,
  })));
  try {
    for (const item of staged) {
      await mkdir(dirname(item.path), { recursive: true });
      await writeFile(item.temp, item.content, { mode: item.mode, flag: "wx" });
    }
  } catch (error) {
    await Promise.all(staged.map((item) => rm(item.temp, { force: true })));
    throw error;
  }
  const committed: typeof staged = [];
  try {
    for (const item of staged) {
      if (item.existed) await rename(item.path, item.backup);
      try {
        await rename(item.temp, item.path);
      } catch (error) {
        if (item.existed) await rename(item.backup, item.path);
        throw error;
      }
      committed.push(item);
      await afterReplace?.(committed.length);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      await rm(item.path, { force: true });
      if (item.existed) await rename(item.backup, item.path);
    }
    throw error;
  } finally {
    for (const item of staged) await Promise.all([rm(item.temp, { force: true }), rm(item.backup, { force: true })]);
  }
};

export const planProjectContextInitialization = async (project: string): Promise<ContextInitPlan> => {
  const identity = await repositoryIdentity(project);
  return (await prepareInitialization(identity.root)).plan;
};

export const initializeProjectContext = async (project: string, confirmDirty = false): Promise<ContextInitPlan> => {
  const identity = await repositoryIdentity(project);
  const prepared = await prepareInitialization(identity.root);
  if (prepared.plan.dirty_paths.length && !confirmDirty) {
    throw new ValidationError("project context or instruction files have uncommitted changes; confirmation required", { paths: prepared.plan.dirty_paths });
  }
  await atomicReplaceFiles(prepared.writes);
  return prepared.plan;
};

export const updateProjectContext = async (project: string, value: unknown): Promise<{ project: string; updated_paths: string[]; context: ProjectContext }> => {
  const checked = checkProjectContext(value);
  if (!checked.valid) throw new ValidationError("project context input is invalid", checked.errors);
  const context = checked.value;
  const identity = await repositoryIdentity(project);
  const root = identity.root;

  const memoryPath = join(root, MEMORY_PATH);
  const navigationPath = join(root, NAVIGATION_PATH);
  const memorySource = await readOptional(memoryPath);
  const navigationSource = await readOptional(navigationPath);
  ensureSingleManagedSection(memorySource, "memory");
  ensureSingleManagedSection(navigationSource, "navigation");

  const baseMemory = memorySource === undefined
    ? `${renderMemorySection(emptyMemory())}\n`
    : memorySource.includes(MEMORY_START) ? memorySource : appendSection(memorySource, renderMemorySection(emptyMemory()));
  const parsedMemory = parseMemory(baseMemory);
  const mergedMemory: MemoryData = {
    projectShape: parsedMemory.data.projectShape || context.project_shape.trim(),
    domainTerms: unique([...parsedMemory.data.domainTerms, ...context.memory.domain_terms]),
    repositoryConstraints: unique([...parsedMemory.data.repositoryConstraints, ...context.memory.repository_constraints]),
    responsibilities: unique([...parsedMemory.data.responsibilities, ...context.memory.responsibilities]),
    moduleBoundaries: unique([...parsedMemory.data.moduleBoundaries, ...context.memory.module_boundaries]),
  };
  const memoryContent = replaceSection(baseMemory, parsedMemory.start, parsedMemory.end, renderMemorySection(mergedMemory));

  const baseNavigation = navigationSource === undefined
    ? `${renderNavigationSection([])}\n`
    : navigationSource.includes(NAVIGATION_START) ? navigationSource : appendSection(navigationSource, renderNavigationSection([]));
  const parsedNavigation = parseNavigation(baseNavigation);
  const entries: ProjectContext["navigation"] = [];
  const positions = new Map<string, number>();
  for (const entry of [...parsedNavigation.entries, ...context.navigation]) {
    const key = navigationKey(entry);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, entries.length);
      entries.push({ ...entry, keywords: unique(entry.keywords), entry_paths: unique(entry.entry_paths) });
      continue;
    }
    const existing = entries[position]!;
    entries[position] = { ...existing, keywords: unique([...existing.keywords, ...entry.keywords]), entry_paths: unique([...existing.entry_paths, ...entry.entry_paths]) };
  }
  await validateNavigationEntries(root, entries);
  const navigationContent = replaceSection(baseNavigation, parsedNavigation.start, parsedNavigation.end, renderNavigationSection(entries));
  const writes: PendingWrite[] = [];
  if (memoryContent !== memorySource) writes.push({ path: memoryPath, content: memoryContent, existed: memorySource !== undefined });
  if (navigationContent !== navigationSource) writes.push({ path: navigationPath, content: navigationContent, existed: navigationSource !== undefined });
  await atomicReplaceFiles(writes);
  return { project: root, updated_paths: writes.map((write) => write.path.slice(root.length + 1)), context };
};

export const validateProjectContext = async (project: string): Promise<ContextValidation> => {
  const identity = await repositoryIdentity(project);
  const root = identity.root;
  const memorySource = await readOptional(join(root, MEMORY_PATH));
  const navigationSource = await readOptional(join(root, NAVIGATION_PATH));
  const memoryIssues: string[] = [];
  const navigationIssues: string[] = [];
  let memorySections = 0;
  let navigationSections = 0;
  let navigationEntries: ProjectContext["navigation"] = [];
  if (memorySource !== undefined) {
    memorySections = occurrences(memorySource, MEMORY_START);
    try { parseMemory(memorySource); } catch (error) { memoryIssues.push((error as Error).message); }
  } else memoryIssues.push("MEMORY.md is missing");
  if (navigationSource !== undefined) {
    navigationSections = occurrences(navigationSource, NAVIGATION_START);
    try { navigationEntries = parseNavigation(navigationSource).entries; } catch (error) { navigationIssues.push((error as Error).message); }
  } else navigationIssues.push(`${NAVIGATION_PATH} is missing`);
  const invalidPaths: string[] = [];
  for (const entry of navigationEntries) for (const path of entry.entry_paths) {
    try { await assertNavigationPath(root, path); } catch { invalidPaths.push(path); }
  }
  if (invalidPaths.length) navigationIssues.push("navigation contains invalid paths");
  const instructions: ContextValidation["instructions"] = [];
  for (const path of INSTRUCTION_PATHS) {
    const source = await readOptional(join(root, path));
    instructions.push({ path, exists: source !== undefined, rule_present: source === undefined || source.includes(CONTEXT_RULE) });
  }
  const pending = [
    ...(memoryIssues.length ? [MEMORY_PATH] : []),
    ...(navigationIssues.length ? [NAVIGATION_PATH] : []),
    ...instructions.filter((item) => item.exists && !item.rule_present).map((item) => item.path),
  ];
  return {
    valid: pending.length === 0,
    memory: { path: MEMORY_PATH, exists: memorySource !== undefined, section_count: memorySections, valid: memoryIssues.length === 0, issues: memoryIssues },
    navigation: { path: NAVIGATION_PATH, exists: navigationSource !== undefined, section_count: navigationSections, valid: navigationIssues.length === 0, entries: navigationEntries.length, invalid_paths: unique(invalidPaths), issues: navigationIssues },
    instructions,
    maintenance: { status: pending.length ? "needs_update" : "current", paths: unique(pending) },
  };
};

export class ProjectContextService {
  planInitialization(project: string): Promise<ContextInitPlan> { return planProjectContextInitialization(project); }
  initialize(project: string, confirmDirty = false): Promise<ContextInitPlan> { return initializeProjectContext(project, confirmDirty); }
  update(project: string, value: unknown): Promise<{ project: string; updated_paths: string[]; context: ProjectContext }> { return updateProjectContext(project, value); }
  validate(project: string): Promise<ContextValidation> { return validateProjectContext(project); }
}
