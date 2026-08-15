import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ValidationError } from "./errors.js";
import { commitPaths, createWorktree, currentBranch, currentHead, git, mergeNoFastForward, worktreeStatus } from "./git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "./security.js";
import { StateStore } from "./state.js";
import { sha256, toPosix } from "./utils.js";
import { ScopeGate } from "./gates.js";
import { DispatchService } from "./dispatch.js";

export interface PreparedWorktree { worktree_id: string; branch: string; path: string; base_commit: string; reused: boolean; }

const safeSegment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new ValidationError(`unsafe Git name segment: ${value}`);
  return value;
};

export class GitOrchestrator {
  constructor(readonly store: StateStore) {}

  /** Every mutating operation can be tied to the claimed git-operator dispatch.
   * The optional argument preserves the programmatic API used by older
   * integrations; CLI callers should always provide it. */
  private assertGitOperator(runId: string, dispatchId?: string): void {
    if (!dispatchId) return;
    new DispatchService(this.store).assertClaimed(runId, dispatchId, "git-operator");
  }

  private repositoryForRun(runId: string): { root: string; run: any } {
    const run = this.store.getRun(runId) as any;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    return { root: repository.project_path, run };
  }

  async prepareTask(runId: string, taskId = "implementation", baseCommit?: string, dependsOn?: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).assertPassed(runId, "pre_write");
    const plan = safeSegment(run.plan_id ?? `direct-${runId.slice(-8).toLowerCase()}`);
    const task = safeSegment(taskId.toLowerCase());
    const branch = `task/${plan}/${task}`;
    const path = join(root, ".worktree", "tasks", plan, task);
    let base = baseCommit ?? run.base_commit;
    if (dependsOn) {
      const dependency = this.worktree(runId, dependsOn);
      if (dependency.state !== "active") throw new ValidationError("dependent Task worktree is not active");
      const integration = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as any;
      if (!integration) throw new ValidationError("dependent Task requires an active integration worktree");
      base = await currentHead(integration.path);
    }
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ValidationError("worktree base must be a 40-character commit SHA");
    const key = `worktree:create:${runId}:${branch}:${base}`;
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    if (existing) {
      const operation = this.store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
      if (operation.state !== "completed" || !existing) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE branch=? OR path=?").get(branch, path) as any;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    try { await stat(path); throw new ValidationError(`unowned worktree path already exists: ${path}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    try { await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]); throw new ValidationError(`unowned branch already exists: ${branch}`); } catch (error) { if (error instanceof ValidationError && error.message.startsWith("unowned")) throw error; }
    const operation = this.store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
    if (operation.reused) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
    await mkdir(dirname(path), { recursive: true });
    await createWorktree(root, path, branch, base);
    const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
    this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, branch, path, base, new Date().toISOString());
    this.store.finishOperation(operation.operationId, { worktreeId, head: await currentHead(path) });
    return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
  }

  async prepareIntegration(runId: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const plan = safeSegment(run.plan_id ?? `direct-${runId.slice(-8).toLowerCase()}`);
    const short = runId.slice(-8).toLowerCase();
    const branch = `integration/${plan}/${short}`;
    const path = join(root, ".worktree", "integration", plan, short);
    const base = run.base_commit;
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    const key = `integration:create:${runId}:${base}`;
    if (existing) {
      const operation = this.store.beginOperation("git.integration.create", key, { branch, path, base }, runId);
      if (operation.state !== "completed") throw new ValidationError("integration operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE branch=? OR path=?").get(branch, path) as any;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    try { await stat(path); throw new ValidationError(`unowned worktree path already exists: ${path}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    try { await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]); throw new ValidationError(`unowned branch already exists: ${branch}`); } catch (error) { if (error instanceof ValidationError && error.message.startsWith("unowned")) throw error; }
    const operation = this.store.beginOperation("git.integration.create", key, { branch, path, base }, runId);
    if (operation.reused) throw new ValidationError("integration operation has unknown side effect; reconcile required");
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

  async commit(runId: string, worktreeId: string, message: string, allowedScopes: string[], dispatchId?: string): Promise<{ commit: string; paths: string[]; reused: boolean }> {
    this.assertGitOperator(runId, dispatchId);
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
    this.store.finishOperation(operation.operationId, { commit, paths: changed, worktree_id: worktreeId });
    return { commit, paths: changed, reused: false };
  }

  async mergeTask(runId: string, integrationId: string, taskId: string, dispatchId?: string): Promise<string> {
    this.assertGitOperator(runId, dispatchId);
    const integration = this.worktree(runId, integrationId);
    const task = this.worktree(runId, taskId);
    const taskCommit = await currentHead(task.path);
    const operation = this.store.beginOperation("git.merge.task", `merge-task:${runId}:${integration.branch}:${task.branch}:${taskCommit}`, { integration: integration.branch, task: task.branch }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("merge side effect is unknown; reconcile required");
      return currentHead(integration.path);
    }
    const commit = await mergeNoFastForward(integration.path, task.branch, `Merge ${task.branch} into ${integration.branch}`);
    this.store.finishOperation(operation.operationId, {
      commit,
      task_commit: taskCommit,
      task_worktree_id: taskId,
      integration_worktree_id: integrationId,
    });
    return commit;
  }

  async integrateTarget(runId: string, integrationId: string, dispatchId?: string): Promise<string> {
    this.assertGitOperator(runId, dispatchId);
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
      if (sync.reused) {
        if (sync.state !== "completed") throw new ValidationError("target synchronization has unknown side effect; reconcile required");
      } else {
        try {
          const synced = await mergeNoFastForward(integration.path, run.target_branch, `Sync ${run.target_branch} into ${integration.branch}`);
          this.store.finishOperation(sync.operationId, { commit: synced });
          new DispatchService(this.store).create(runId, "test", {
            objective: "Run the complete final verification after synchronizing target branch changes.",
            allowed_read_paths: ["package.json", "test"],
            allowed_write_paths: [],
            acceptance_criteria: ["All final checks pass", "No review is restarted"],
            context: { synchronization_commit: synced, target_commit: current },
          });
        } catch (error) {
          throw new ValidationError("target synchronization conflicted; developer resolution required", { cause: String(error) });
        }
      }
    }
    const integrationHead = await currentHead(integration.path);
    new (await import("./review.js")).ReviewService(this.store).assertGate(runId, integrationHead);
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

  async continueConflict(runId: string, integrationId: string, allowedScopes: string[], dispatchId?: string): Promise<string> {
    this.assertGitOperator(runId, dispatchId);
    const integration = this.worktree(runId, integrationId);
    try { await git(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); }
    catch { throw new ValidationError("worktree has no merge conflict in progress"); }
    const unresolved = (await git(integration.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    if (unresolved.length) throw new ValidationError("merge still has unresolved paths", unresolved);
    const changed = (await git(integration.path, ["status", "--porcelain=v1", "-z"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    if (!changed.length) throw new ValidationError("no conflict resolution changes are present");
    for (const path of changed) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, allowedScopes)) throw new ValidationError(`conflict resolution changed path outside allowed scope: ${path}`);
      await canonicalizeInside(integration.path, path, true);
    }
    const operation = this.store.beginOperation("git.merge.continue", `merge-continue:${runId}:${integrationId}:${sha256(changed.sort().join("\n"))}`, { changed }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("merge continuation side effect is unknown; reconcile required");
      return currentHead(integration.path);
    }
    await git(integration.path, ["add", "--", ...changed]);
    await git(integration.path, ["commit", "--no-edit"]);
    const commit = await currentHead(integration.path);
    this.store.finishOperation(operation.operationId, { commit, changed });
    new DispatchService(this.store).create(runId, "test", {
      objective: "Run the complete final verification after conflict resolution.",
      allowed_read_paths: ["package.json", "test"],
      allowed_write_paths: [],
      acceptance_criteria: ["All final checks pass", "No review is restarted"],
      context: { conflict_resolution_commit: commit },
    });
    return commit;
  }

  async cleanup(runId: string, dispatchId?: string): Promise<string[]> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    if (run.state !== "completed") throw new ValidationError("worktrees are retained unless the run completed");
    const rows = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND state='active' ORDER BY length(path) DESC").all(runId) as any[];
    const removed: string[] = [];
    for (const row of rows) {
      if (!(await worktreeStatus(row.path)).clean) throw new ValidationError(`worktree is dirty and cannot be removed: ${row.path}`);
      const canonical = await realpath(row.path);
      const relativePath = toPosix(relative(root, canonical));
      if (!relativePath.startsWith(".worktree/")) throw new ValidationError(`refusing to remove worktree outside managed root: ${canonical}`);
      const operation = this.store.beginOperation("git.cleanup", `cleanup:${runId}:${row.worktree_id}`, { worktreeId: row.worktree_id, path: canonical, branch: row.branch }, runId);
      if (operation.reused && operation.state !== "completed") throw new ValidationError("cleanup side effect is unknown; reconcile required");
      if (operation.reused) { this.store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(row.worktree_id); removed.push(canonical); continue; }
      await git(root, ["worktree", "remove", canonical]);
      await git(root, ["branch", "-d", row.branch]);
      this.store.finishOperation(operation.operationId, { path: canonical, branch: row.branch, removed: true });
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
      if (operation.kind === "git.cleanup") {
        const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
        const branchExists = await git(root, ["show-ref", "--verify", `refs/heads/${request.branch}`]).then(() => true, () => false);
        const exists = listed.includes(`worktree ${request.path}`) || branchExists;
        result.push({ operation_id: operation.operation_id, state: exists ? "unknown" : "completed", fact: exists ? "cleanup is partially applied" : "owned worktree and branch are absent" });
      } else if (operation.kind.includes("worktree") || operation.kind.includes("integration.create")) {
        const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
        const exists = listed.includes(`worktree ${request.path}`) && listed.includes(`branch refs/heads/${request.branch}`);
        result.push({ operation_id: operation.operation_id, state: exists ? "completed" : "not_applied", fact: exists ? "owned worktree exists" : "owned worktree absent" });
      } else result.push({ operation_id: operation.operation_id, state: "unknown", fact: "manual evidence required" });
    }
    return result;
  }
}
