import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultTemplate } from "../../src/contracts.js";
import type { DispatchPacket } from "../../src/dispatch.js";
import { StateStore } from "../../src/state.js";
import { REVIEW_COMMON_DIR } from "./git.js";

export const dispatchPacket = (allowedReadPaths: string[] = ["src/dispatch.ts"]): DispatchPacket => ({
  objective: "Exercise the frozen dispatch contract",
  allowed_read_paths: allowedReadPaths,
  allowed_write_paths: [],
  acceptance_criteria: ["Structured result is accepted"],
  context: {},
});

export const completedResult = (
  runId: string,
  dispatchId: string,
  role: Parameters<typeof createResultTemplate>[2],
  payload: Record<string, unknown>,
) => ({
  ...createResultTemplate(runId, dispatchId, role),
  summary: `${role} completed`,
  verification: [{ command: "npm test", outcome: "passed" }],
  payload,
});

export const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "ai-team-review-fixes-"));

export const withStore = async (callback: (store: StateStore, home: string) => Promise<void> | void): Promise<void> => {
  const home = await temporaryDirectory();
  const store = await StateStore.open(home);
  try { await callback(store, home); }
  finally { store.close(); await rm(home, { recursive: true, force: true }); }
};

export const createRun = (
  store: StateStore,
  profile: "planning" | "coding" = "coding",
  extra: { planId?: string; revision?: string } = {},
): string => {
  const repoId = "repo-review-fixture";
  store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
  return store.createRun({ repoId, profile, mode: profile === "planning" ? "planned" : "feature", request: "review fixes", ...extra });
};

export const projectContext = (entryPaths: string[] = ["src/dispatch.ts"]) => ({
  project_shape: "TypeScript CLI",
  memory: {
    domain_terms: ["dispatch"], repository_constraints: ["Node.js 22+"],
    responsibilities: ["src/dispatch.ts coordinates role dispatches"], module_boundaries: ["src contains runtime services"],
  },
  navigation: [{ feature: "Dispatch", keywords: ["dispatch"], entry_paths: entryPaths, module_boundary: "runtime" }],
  maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
});

export const writeCurrentProjectContext = async (repository: string): Promise<void> => {
  await mkdir(join(repository, ".ai-team", "index"), { recursive: true });
  await writeFile(join(repository, "MEMORY.md"), `<!-- ai-team:project-context:start -->
<!-- ai-team:context-format {"renderer_version":"context-renderer-v2","schema_version":2} -->
## 项目上下文

### 项目形态
TypeScript CLI

### 领域术语
_待补充_

### 仓库约束
_待补充_

### 职责
_待补充_

### 模块边界
_待补充_
<!-- ai-team:project-context:end -->
`);
  await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), `<!-- ai-team:feature-navigation:start -->
<!-- ai-team:context-format {"renderer_version":"context-renderer-v2","schema_version":2} -->
# 功能导航

| 功能 | 关键词 | 入口路径 | 模块边界 |
| --- | --- | --- | --- |
<!-- ai-team:feature-navigation:end -->
`);
};
