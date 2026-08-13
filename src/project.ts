import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { ValidationError } from "./errors.js";
import { git, repositoryIdentity } from "./git.js";

const IGNORE_ENTRIES = ["/.worktree/", "/.ai-team/runtime/"] as const;

export interface InitPlan {
  project: string;
  gitignorePath: string;
  additions: string[];
  gitignoreDirty: boolean;
  patch: string;
}

export const planProjectInit = async (project: string): Promise<InitPlan> => {
  const identity = await repositoryIdentity(project);
  const gitignorePath = join(identity.root, ".gitignore");
  let source = "";
  try { source = await readFile(gitignorePath, "utf8"); } catch { /* new file */ }
  const lines = new Set(source.split(/\r?\n/));
  const additions = IGNORE_ENTRIES.filter((line) => !lines.has(line));
  let gitignoreDirty = false;
  try {
    const status = await git(identity.root, ["status", "--porcelain=v1", "--", ".gitignore"]);
    gitignoreDirty = status.stdout.length > 0;
  } catch { /* unborn repository */ }
  const patch = additions.length ? additions.map((line) => `+${line}`).join("\n") : "";
  return { project: identity.root, gitignorePath, additions: [...additions], gitignoreDirty, patch };
};

export const initializeProject = async (project: string, confirmDirty = false): Promise<InitPlan> => {
  const plan = await planProjectInit(project);
  if (plan.gitignoreDirty && plan.additions.length && !confirmDirty) {
    throw new ValidationError(".gitignore has uncommitted changes; confirmation required", { patch: plan.patch });
  }
  const aiTeam = join(plan.project, ".ai-team");
  await mkdir(join(aiTeam, "standards"), { recursive: true });
  await mkdir(join(aiTeam, "plans"), { recursive: true });
  await mkdir(join(aiTeam, "runtime"), { recursive: true });
  const projectFile = join(aiTeam, "project.yaml");
  try { await stat(projectFile); } catch {
    const identity = await repositoryIdentity(plan.project);
    await writeFile(projectFile, YAML.stringify({ schema_version: 1, repo_id: identity.repoId, project_path: identity.root }));
  }
  if (plan.additions.length) {
    let source = ""; try { source = await readFile(plan.gitignorePath, "utf8"); } catch { /* new */ }
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    await writeFile(plan.gitignorePath, `${source}${separator}${plan.additions.join("\n")}\n`);
  }
  return plan;
};
