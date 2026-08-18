import { mkdtemp, rm } from "node:fs/promises";
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
