import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { GitGateError } from "./errors.js";
import { sha256 } from "./utils.js";

const execFileAsync = promisify(execFile);

/** Commands used by the orchestrator. Keep this allowlist intentionally small:
 * callers cannot turn the low-level wrapper into an arbitrary git shell. */
const ALLOWED = new Set([
  "add", "branch", "cat-file", "commit", "diff", "diff-tree", "log", "merge", "merge-base", "rev-list", "rev-parse",
  "show", "show-ref", "status", "worktree",
]);
const FORBIDDEN = new Set(["push", "remote", "tag", "fetch", "pull", "rebase", "reset", "clean", "stash", "cherry-pick", "am", "amend", "squash"]);
const FORBIDDEN_FLAGS = new Set(["--amend", "--squash", "--no-verify", "--allow-empty", "--exec", "--upload-pack", "--receive-pack"]);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export const git = async (cwd: string, args: readonly string[]): Promise<GitResult> => {
  const command = args[0];
  // Reject option injection before command parsing as well as known dangerous verbs.
  const subcommand = args[1];
  const invalidSubcommand = command === "worktree" && !new Set(["add", "list", "remove"]).has(subcommand ?? "")
    || command === "branch" && ["-D", "-f", "--force"].includes(subcommand ?? "");
  const forbiddenArgument = args.some((arg) => FORBIDDEN_FLAGS.has(arg) || ["--force", "-f", "-D", "--hard", "-C", "-A", "--all"].includes(arg));
  const malformedTemplate = command === "add" && !args.includes("--")
    || command === "commit" && !(args.includes("--no-edit") || args.includes("-m"))
    || command === "merge" && !args.includes("--no-ff")
    || command === "worktree" && subcommand === "add" && !args.includes("-b");
  if (!command || command.startsWith("-") || FORBIDDEN.has(command) || !ALLOWED.has(command) || invalidSubcommand || forbiddenArgument || malformedTemplate) {
    throw new GitGateError(`forbidden Git operation: ${args.join(" ")}`);
  }
  try {
    const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout.replace(/[\r\n]+$/, ""), stderr: result.stderr.replace(/[\r\n]+$/, "") };
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new GitGateError(`Git command failed: ${detail.stderr?.trim() || detail.message}`);
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
    if (path === ".worktrees/" || path.startsWith(".worktrees/")) continue;
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
  const paths = [`.ai-team/plans/${planId}/plan.yaml`, `.ai-team/plans/${planId}/revisions/${revision}`];
  const message = `Plan ${planId} revision ${revision}\n\nAI-Team-Plan: ${planId}\nAI-Team-Revision: ${revision}\nAI-Team-Digest: ${digest}`;
  const existing: string[] = [];
  for (const path of paths) { try { await stat(`${project}/${path}`); existing.push(path); } catch { /* optional plan metadata */ } }
  return commitPaths(project, existing, message);
};

export const mergeNoFastForward = async (project: string, branch: string, message: string): Promise<string> => {
  await git(project, ["merge", "--no-ff", branch, "-m", message]);
  return currentHead(project);
};
