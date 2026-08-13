import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { ValidationError } from "./errors.js";
import { sha256 } from "./utils.js";

const execFileAsync = promisify(execFile);

const FORBIDDEN = new Set(["push", "tag", "rebase", "reset", "clean", "stash", "cherry-pick", "am"]);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export const git = async (cwd: string, args: readonly string[]): Promise<GitResult> => {
  if (!args[0] || FORBIDDEN.has(args[0]) || args.includes("--amend") || args.includes("--squash")) {
    throw new ValidationError(`forbidden Git operation: ${args.join(" ")}`);
  }
  try {
    const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout.replace(/[\r\n]+$/, ""), stderr: result.stderr.replace(/[\r\n]+$/, "") };
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new ValidationError(`Git command failed: ${detail.stderr?.trim() || detail.message}`);
  }
};

export const repositoryIdentity = async (project: string): Promise<{ root: string; commonDir: string; repoId: string }> => {
  const root = await realpath((await git(project, ["rev-parse", "--show-toplevel"])).stdout);
  const common = (await git(root, ["rev-parse", "--git-common-dir"])).stdout;
  const commonDir = await realpath(common.startsWith("/") ? common : `${root}/${common}`);
  return { root, commonDir, repoId: sha256(commonDir) };
};

export interface WorktreeStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export const worktreeStatus = async (project: string): Promise<WorktreeStatus> => {
  const output = (await git(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "??") untracked.push(path);
    else {
      if (code[0] !== " ") staged.push(path);
      if (code[1] !== " ") unstaged.push(path);
    }
  }
  return { staged, unstaged, untracked, clean: staged.length + unstaged.length + untracked.length === 0 };
};

export const currentHead = async (project: string): Promise<string> =>
  (await git(project, ["rev-parse", "HEAD"])).stdout;

export const currentBranch = async (project: string): Promise<string> =>
  (await git(project, ["branch", "--show-current"])).stdout;

export const createWorktree = async (project: string, path: string, branch: string, base: string): Promise<void> => {
  await git(project, ["worktree", "add", "-b", branch, path, base]);
};

export const commitPaths = async (project: string, paths: string[], message: string): Promise<string> => {
  await git(project, ["add", "--", ...paths]);
  await git(project, ["commit", "-m", message, "--", ...paths]);
  return currentHead(project);
};

export const commitPlanningRevision = async (project: string, planId: string, revision: string, digest: string): Promise<string> => {
  const path = `.ai-team/plans/${planId}/revisions/${revision}`;
  const message = `Plan ${planId} revision ${revision}\n\nAI-Team-Plan: ${planId}\nAI-Team-Revision: ${revision}\nAI-Team-Digest: ${digest}`;
  return commitPaths(project, [path], message);
};

export const mergeNoFastForward = async (project: string, branch: string, message: string): Promise<string> => {
  await git(project, ["merge", "--no-ff", branch, "-m", message]);
  return currentHead(project);
};
