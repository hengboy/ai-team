import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ValidationError } from "./errors.js";
import { commitPaths, createWorktree, currentBranch, currentHead, git, mergeNoFastForward, worktreeStatus } from "./git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "./security.js";
import { StateStore } from "./state.js";
import { sha256, toPosix } from "./utils.js";
import { ScopeGate } from "./gates.js";

export interface PreparedWorktree { worktree_id: string; branch: string; path: string; base_commit: string; reused: boolean; }

const safeSegment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new ValidationError(`unsafe Git name segment: ${value}`);
  return value;
};

export class GitOrchestrator {
  constructor(readonly store: StateStore) {}

  private repositoryForRun(runId: string): { root: string; run: any } {
    const run = this.store.getRun(runId) as any;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    return { root: repository.project_path, run };
  }

  async prepareTask(runId: string, taskId = "implementation", baseCommit?: string): Promise<PreparedWorktree> {
    const { root, run } = this.repositoryForRun(runId);
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).assertPassed(runId, "pre_write");
    const plan = safeSegment(run.plan_id ?? `direct-${runId.slice(-8).toLowerCase()}`);
    const task = safeSegment(taskId.toLowerCase());
    const branch = `task/${plan}/${task}`;
    const path = join(root, ".worktree", "tasks", plan, task);
    const base = baseCommit ?? run.base_commit;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ValidationError("worktree base must be a 40-character commit SHA");
    const key = `worktree:create:${runId}:${branch}:${base}`;
    const operation = this.store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    if (operation.reused) {
      if (operation.state !== "completed" || !existing) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE branch=? OR path=?").get(branch, path) as any;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    try { await stat(path); throw new ValidationError(`unowned worktree path already exists: ${path}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    try { await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]); throw new ValidationError(`unowned branch already exists: ${branch}`); } catch (error) { if (error instanceof ValidationError && error.message.startsWith("unowned")) throw error; }
    await mkdir(dirname(path), { recursive: true });
    await createWorktree(root, path, branch, base);
    const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
    this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, branch, path, base, new Date().toISOString());
    this.store.finishOperation(operation.operationId, { worktreeId, head: await currentHead(path) });
    return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
  }

  async prepareIntegration(runId: string): Promise<PreparedWorktree> {
    const { root, run } = this.repositoryForRun(runId);
    const plan = safeSegment(run.plan_id ?? `direct-${runId.slice(-8).toLowerCase()}`);
    const short = runId.slice(-8).toLowerCase();
    const branch = `integration/${plan}/${short}`;
    const path = join(root, ".worktree", "integration", plan, short);
    const base = run.base_commit;
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    if (existing) return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    const operation = this.store.beginOperation("git.integration.create", `integration:create:${runId}:${base}`, { branch, path, base }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("integration operation has unknown side effect; reconcile required");
    await mkdir(dirname(path), { recursive: true });
    await createWorktree(root, path, branch, base);
    const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
    this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, branch, path, base, new Date().toISOString());
    this.store.finishOperation(operation.operationId, { worktreeId, head: await currentHead(path) });
    return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
  }

  private worktree(runId: string, worktreeId: string): any {
    const row = this.store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND run_id=?").get(worktreeId, runId);
    if (!row) throw new ValidationError("worktree does not belong to run");
    return row;
  }

  async commit(runId: string, worktreeId: string, message: string, allowedScopes: string[]): Promise<{ commit: string; paths: string[]; reused: boolean }> {
    const worktree = this.worktree(runId, worktreeId);
    const changed = (await git(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    if (!changed.length) throw new ValidationError("implementation has no changes to commit");
    for (const path of changed) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, allowedScopes)) throw new ValidationError(`changed path is outside allowed scope: ${path}`);
      await canonicalizeInside(worktree.path, path, true);
    }
    const run = this.store.getRun(runId) as any;
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).check(runId, "pre_commit", allowedScopes);
    const digest = sha256(changed.sort().join("\n"));
    const operation = this.store.beginOperation("git.commit", `commit:${runId}:${worktreeId}:${digest}:${message}`, { message, changed }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("commit side effect is unknown; reconcile required");
      return { commit: await currentHead(worktree.path), paths: changed, reused: true };
    }
    const commit = await commitPaths(worktree.path, changed, message);
    this.store.finishOperation(operation.operationId, { commit, paths: changed });
    return { commit, paths: changed, reused: false };
  }

  async mergeTask(runId: string, integrationId: string, taskId: string): Promise<string> {
    const integration = this.worktree(runId, integrationId);
    const task = this.worktree(runId, taskId);
    const operation = this.store.beginOperation("git.merge.task", `merge-task:${runId}:${integration.branch}:${task.branch}:${await currentHead(task.path)}`, { integration: integration.branch, task: task.branch }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("merge side effect is unknown; reconcile required");
      return currentHead(integration.path);
    }
    const commit = await mergeNoFastForward(integration.path, task.branch, `Merge ${task.branch} into ${integration.branch}`);
    this.store.finishOperation(operation.operationId, { commit });
    return commit;
  }

  async integrateTarget(runId: string, integrationId: string): Promise<string> {
    const { root, run } = this.repositoryForRun(runId);
    const integration = this.worktree(runId, integrationId);
    const targetStatus = await worktreeStatus(root);
    const unmanagedUntracked = targetStatus.untracked.filter((path) => path !== ".worktree/" && !path.startsWith(".worktree/"));
    if (targetStatus.staged.length || targetStatus.unstaged.length || unmanagedUntracked.length) {
      throw new ValidationError("target worktree must be clean before integration", { ...targetStatus, untracked: unmanagedUntracked });
    }
    if (await currentBranch(root) !== run.target_branch) throw new ValidationError("target branch changed before integration");
    const current = await currentHead(root);
    if (current !== run.base_commit) {
      const count = this.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.sync' AND state='completed'").get(runId) as { count: number };
      if (count.count >= 3) throw new ValidationError("target branch drift exceeded 3 synchronization attempts");
      const sync = this.store.beginOperation("git.sync", `sync:${runId}:${integration.branch}:${current}`, { target: current }, runId);
      try {
        const synced = await mergeNoFastForward(integration.path, run.target_branch, `Sync ${run.target_branch} into ${integration.branch}`);
        this.store.finishOperation(sync.operationId, { commit: synced });
      } catch (error) {
        throw new ValidationError("target synchronization conflicted; developer resolution required", { cause: String(error) });
      }
    }
    const integrationHead = await currentHead(integration.path);
    const operation = this.store.beginOperation("git.integrate", `integrate:${runId}:${run.target_branch}:${integrationHead}`, { integration: integration.branch }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("integration side effect is unknown; reconcile required");
      return currentHead(root);
    }
    const commit = await mergeNoFastForward(root, integration.branch, `Integrate AI Team run ${runId}`);
    this.store.finishOperation(operation.operationId, { commit });
    this.store.db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    return commit;
  }

  async cleanup(runId: string): Promise<string[]> {
    const { root, run } = this.repositoryForRun(runId);
    if (run.state !== "completed") throw new ValidationError("worktrees are retained unless the run completed");
    const rows = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND state='active' ORDER BY length(path) DESC").all(runId) as any[];
    const removed: string[] = [];
    for (const row of rows) {
      if (!(await worktreeStatus(row.path)).clean) throw new ValidationError(`worktree is dirty and cannot be removed: ${row.path}`);
      const canonical = await realpath(row.path);
      const relativePath = toPosix(relative(root, canonical));
      if (!relativePath.startsWith(".worktree/")) throw new ValidationError(`refusing to remove worktree outside managed root: ${canonical}`);
      await git(root, ["worktree", "remove", canonical]);
      await git(root, ["branch", "-d", row.branch]);
      this.store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(row.worktree_id);
      removed.push(canonical);
    }
    return removed;
  }

  async reconcile(runId: string): Promise<Array<{ operation_id: string; state: string; fact: string }>> {
    const { root } = this.repositoryForRun(runId);
    const pending = this.store.db.prepare("SELECT * FROM operations WHERE run_id=? AND state='pending'").all(runId) as any[];
    const result: Array<{ operation_id: string; state: string; fact: string }> = [];
    for (const operation of pending) {
      const request = JSON.parse(operation.request_json);
      if (operation.kind.includes("worktree") || operation.kind.includes("integration.create")) {
        const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
        const exists = listed.includes(`worktree ${request.path}`) && listed.includes(`branch refs/heads/${request.branch}`);
        result.push({ operation_id: operation.operation_id, state: exists ? "completed" : "not_applied", fact: exists ? "owned worktree exists" : "owned worktree absent" });
      } else result.push({ operation_id: operation.operation_id, state: "unknown", fact: "manual evidence required" });
    }
    return result;
  }
}
