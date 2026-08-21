import { mkdir, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { IncompatibleError, ValidationError } from "../errors.js";
import { commitPaths, createWorktree, currentBranch, currentHead, git, mergeNoFastForward, worktreeStatus } from "../git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "../security.js";
import { sha256, toPosix } from "../utils.js";
import * as common from "./runtime.js";
export async function prepareIntegration(store: common.StateStore, ops: common.GitOperations, runId: string, dispatchId: string): Promise<common.PreparedWorktree> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    const { branch, path } = common.worktreeNames(root, run, runId);
    const base = run.base_commit;
    const named = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    if (named && common.isPlannedRun(run) && named.path !== path) {
      throw new IncompatibleError("planned run has a non-canonical plan worktree layout", {
        reason_code: "legacy_plan_worktree_layout",
        next_action: "recreate_worktree",
        branch: named.branch,
        path: named.path,
      });
    }
    const existing = named ?? (common.isPlannedRun(run) ? ops.activeIntegrationWorktree!(store, ops, runId, root, run) : undefined);
    const key = `integration:create:${runId}:${base}`;
    if (existing) {
      if (common.isPlannedRun(run) && existing.run_id !== runId) {
        if (existing.base_commit !== base) throw new ValidationError("planned plan worktree base does not match run base commit");
        return { worktree_id: existing.worktree_id, branch: existing.branch, path: existing.path, base_commit: base, reused: true };
      }
      const operation = store.beginOperation("git.integration.create", key, { branch: existing.branch, path: existing.path, base }, runId);
      if (operation.state !== "completed") throw new ValidationError("integration operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch: existing.branch, path: existing.path, base_commit: base, reused: true };
    }
    const collision = store.db.prepare("SELECT run_id FROM worktrees WHERE state='active' AND (branch=? OR path=?)").get(branch, path) as any;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    try { await stat(path); throw new ValidationError(`unowned worktree path already exists: ${path}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    try { await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]); throw new ValidationError(`unowned branch already exists: ${branch}`); } catch (error) { if (error instanceof ValidationError && error.message.startsWith("unowned")) throw error; }
    const operation = store.beginOperation("git.integration.create", key, { branch, path, base }, runId);
    if (operation.reused) throw new ValidationError("integration operation has unknown side effect; reconcile required");
    await mkdir(dirname(path), { recursive: true });
    await createWorktree(root, path, branch, base);
    const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, branch, path, base, new Date().toISOString());
    store.finishOperation(operation.operationId, { worktreeId, head: await currentHead(path) });
    return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
  }

export async function status(store: common.StateStore, ops: common.GitOperations, runId: string): Promise<common.WorktreeStatus[]> {
    const rows = store.db.prepare("SELECT worktree_id,branch,path,base_commit,state FROM worktrees WHERE run_id=? ORDER BY created_at,worktree_id")
      .all(runId) as Array<{ worktree_id: string; branch: string; path: string; base_commit: string; state: string }>;
    return Promise.all(rows.map(async (row) => {
      const type = row.branch.startsWith("plan/") ? "plan" : row.branch.startsWith("integration/") ? "integration" : "task";
      const owner = type === "task" ? row.branch.split("/").at(-1)!.split("--").at(-1)! : row.branch.split("/")[1] ?? row.branch;
      try {
        return { ...row, type, owner, head: await currentHead(row.path), clean: (await worktreeStatus(row.path)).clean };
      } catch {
        return { ...row, type, owner, head: null, clean: null };
      }
    }));
  }

export async function commit(store: common.StateStore, ops: common.GitOperations, runId: string, worktreeId: string, message: string, allowedScopes: string[], dispatchId: string): Promise<{ commit: string; paths: string[]; reused: boolean }> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const worktree = ops.worktreeForCommit!(store, ops, runId, worktreeId);
    const integratedTask = store.db.prepare("SELECT task_id FROM run_tasks WHERE run_id=? AND worktree_id=? AND state='integrated' ORDER BY ordinal LIMIT 1")
      .get(runId, worktreeId) as { task_id: string } | undefined;
    if (integratedTask) {
      throw new ValidationError(`integrated task worktree is read-only: task_id=${integratedTask.task_id}; worktree_id=${worktreeId}`, {
        reason: "integrated_task_worktree_read_only",
        task_id: integratedTask.task_id,
        worktree_id: worktreeId,
      });
    }
    const changed = (await git(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    if (!changed.length) throw new ValidationError("implementation has no changes to commit");
    const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string };
    const packet = JSON.parse(row.packet_json) as { allowed_write_paths?: string[]; context?: { phase?: string; worktree_id?: string; changed_paths?: string[] } };
    if (packet.context?.phase === "pre_commit_implementation") {
      if (packet.context.worktree_id !== worktreeId) throw new ValidationError("pre-commit dispatch does not match the requested worktree");
      const frozenScopes = [...new Set(packet.allowed_write_paths ?? [])].sort();
      if (JSON.stringify([...new Set(allowedScopes)].sort()) !== JSON.stringify(frozenScopes)) {
        throw new ValidationError("pre-commit scopes do not match the frozen developer write paths");
      }
      if (JSON.stringify([...new Set(changed)].sort()) !== JSON.stringify([...(packet.context.changed_paths ?? [])].sort())) {
        throw new ValidationError("real dirty diff changed after the pre-commit dispatch was frozen");
      }
    }
    for (const path of changed) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, allowedScopes)) throw new ValidationError(`changed path is outside allowed scope: ${path}`);
      await canonicalizeInside(worktree.path, path, true);
    }
    const run = store.getRun(runId) as any;
    if ((["bug", "feature"] as string[]).includes(run.mode)) common.checkDirectPreCommit(store, runId, "pre_commit", allowedScopes);
    else if (run.mode === "planned") common.assertPreCommitScope(store, runId, changed, worktreeId);
    const digest = sha256(changed.sort().join("\n"));
    const operation = store.beginOperation("git.commit", `commit:${runId}:${worktreeId}:${digest}:${message}`, { message, changed }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("commit side effect is unknown; reconcile required");
      return { commit: await currentHead(worktree.path), paths: changed, reused: true };
    }
    const commit = await commitPaths(worktree.path, changed, message);
    store.finishOperation(operation.operationId, { commit, paths: changed, worktree_id: worktreeId });
    return { commit, paths: changed, reused: false };
  }

export async function mergeTask(store: common.StateStore, ops: common.GitOperations, runId: string, integrationId: string, taskId: string, dispatchId: string): Promise<string> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const taskWorktreeId = common.assertMergeWorktreeBindings(store, common.dispatchOperations, runId, dispatchId, integrationId, taskId).task_worktree_id;

    // A completed merge remains the durable fact after its task worktree is removed.
    const completed = store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
      AND json_extract(request_json,'$.integration_worktree_id')=? AND json_extract(request_json,'$.task_worktree_id')=?
      ORDER BY completed_at DESC LIMIT 1`).get(runId, integrationId, taskWorktreeId) as { evidence_json?: string } | undefined;
    if (completed) {
      const evidence = JSON.parse(completed.evidence_json ?? "{}") as { commit?: string };
      if (!evidence.commit) throw new ValidationError("completed task merge is missing its merge commit evidence");
      return evidence.commit;
    }
    const integration = ops.plannedIntegrationWorktree!(store, ops, runId, integrationId);
    const task = ops.worktree!(store, ops, runId, taskWorktreeId);
    const taskCommit = await currentHead(task.path);
    const integrationHeadBefore = await currentHead(integration.path);
    const run = store.getRun(runId) as any;
    const boundTask = run.mode === "planned"
      ? store.db.prepare("SELECT task_id FROM run_tasks WHERE run_id=? AND worktree_id=?").get(runId, taskWorktreeId) as { task_id: string } | undefined
      : undefined;
    const branchTaskId = task.branch.split("--").at(-1)?.toUpperCase();
    const logicalTaskId = run.mode === "planned" ? boundTask?.task_id ?? branchTaskId ?? taskId : "implementation";
    const request: common.TaskMergeRequest = {
      dispatch_id: dispatchId,
      integration: integration.branch,
      task: task.branch,
      integration_worktree_id: integrationId,
      task_id: logicalTaskId,
      task_worktree_id: taskWorktreeId,
      task_commit: taskCommit,
      integration_head_before: integrationHeadBefore,
    };
    const operation = store.beginOperation("git.merge.task", `merge-task:${runId}:${integration.branch}:${task.branch}:${taskCommit}`, request, runId);
    if (operation.reused) {
      if (operation.state !== "pending") throw new ValidationError("merge side effect is unknown; reconcile required");
      const persisted = store.db.prepare("SELECT request_json FROM operations WHERE operation_id=? AND run_id=? AND kind='git.merge.task'")
        .get(operation.operationId, runId) as { request_json: string } | undefined;
      if (!persisted) throw new ValidationError("pending task merge is missing its recorded request");
      const recordedRequest = JSON.parse(persisted.request_json) as common.TaskMergeRequest;
      if (recordedRequest.integration_worktree_id !== integrationId || recordedRequest.task_worktree_id !== taskWorktreeId) {
        throw new ValidationError("pending task merge does not match the requested worktree bindings");
      }
      const recovered = await ops.confirmTaskMerge!(store, ops, integration.path, recordedRequest);
      if (!recovered) throw new ValidationError("merge side effect is unknown; reconcile required");
      ops.finishTaskMerge!(store, ops, runId, operation.operationId, recordedRequest, recovered);
      await ops.cleanupIntegratedTask!(store, ops, runId, taskWorktreeId, integrationId, operation.operationId, dispatchId);
      return recovered;
    }
    const commit = await mergeNoFastForward(integration.path, task.branch, `Merge ${task.branch} into ${integration.branch}`);
    if (!(await ops.confirmTaskMerge!(store, ops, integration.path, request, commit))) {
      throw new ValidationError("task merge did not produce the expected non-fast-forward merge commit");
    }
    ops.finishTaskMerge!(store, ops, runId, operation.operationId, request, commit);
    await ops.cleanupIntegratedTask!(store, ops, runId, taskWorktreeId, integrationId, operation.operationId, dispatchId);
    return commit;
  }

export async function confirmTaskMerge(store: common.StateStore, ops: common.GitOperations, integrationPath: string, request: common.TaskMergeRequest, expectedCommit?: string): Promise<string | undefined> {
    const head = await currentHead(integrationPath);
    if (expectedCommit && head !== expectedCommit) return undefined;
    const parents = (await git(integrationPath, ["rev-list", "--parents", "-n", "1", head])).stdout.split(" ");
    return parents.length === 3 && parents[1] === request.integration_head_before && parents[2] === request.task_commit ? head : undefined;
  }

export function finishTaskMerge(store: common.StateStore, ops: common.GitOperations, runId: string, operationId: string, request: common.TaskMergeRequest, commit: string): void {
    store.db.transaction(() => {
      store.finishOperation(operationId, {
        commit,
        task_commit: request.task_commit,
        task_id: request.task_id,
        task_worktree_id: request.task_worktree_id,
        integration_worktree_id: request.integration_worktree_id,
        integration_head_before: request.integration_head_before,
      });
      const run = store.getRun(runId) as any;
      if (common.isPlannedRun(run)) {
        const task = store.db.prepare("SELECT 1 FROM run_tasks WHERE run_id=? AND task_id=?")
          .get(runId, request.task_id);
        if (task) store.advanceRunTask(runId, request.task_id, "integrated", {
          worktree_id: request.task_worktree_id,
          integration_commit: commit,
          recovered: true,
        });
      }
    })();
  }

export async function cleanupIntegratedTask(store: common.StateStore, ops: common.GitOperations, runId: string, taskWorktreeId: string, integrationId: string, mergeOperationId: string, dispatchId: string): Promise<string | undefined> {
    ops.assertGitOperator!(store, ops, runId, dispatchId, "cleanup-integrated-task");
    const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = row ? (JSON.parse(row.packet_json) as { context?: Record<string, unknown> }).context : undefined;
    if (context?.phase === "cleanup_integrated_task" && (context.task_worktree_id !== taskWorktreeId
      || context.integration_worktree_id !== integrationId || context.merge_operation_id !== mergeOperationId)) {
      throw new ValidationError("cleanup dispatch is not bound to the integrated task");
    }
    const { root } = ops.repositoryForRun!(store, ops, runId);
    const integration = ops.plannedIntegrationWorktree!(store, ops, runId, integrationId);
    const merge = store.db.prepare("SELECT state,request_json,evidence_json FROM operations WHERE operation_id=? AND run_id=? AND kind='git.merge.task'")
      .get(mergeOperationId, runId) as { state: string; request_json: string; evidence_json?: string } | undefined;
    if (!merge || merge.state !== "completed") throw new ValidationError("integrated task cleanup requires its completed merge operation");
    const request = JSON.parse(merge.request_json) as common.TaskMergeRequest;
    if (request.task_worktree_id !== taskWorktreeId || request.integration_worktree_id !== integrationId) {
      throw new ValidationError("integrated task cleanup merge lineage does not match the requested worktree");
    }
    const task = store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND run_id=?")
      .get(taskWorktreeId, runId) as any;
    if (!task) throw new ValidationError("integrated task cleanup worktree is not owned by this run");
    if (task.state === "removed") return undefined;
    if (task.state !== "active" || !task.branch.startsWith("task/")) throw new ValidationError("integrated task cleanup requires an active independent task worktree");
    const relativePath = toPosix(relative(resolve(root), resolve(task.path)));
    if (!relativePath.startsWith(".worktrees/")) throw new ValidationError("refusing to remove task worktree outside managed root");
    const cleanup = store.beginOperation("git.cleanup", `cleanup:${runId}:${taskWorktreeId}`, {
      worktreeId: taskWorktreeId,
      path: task.path,
      branch: task.branch,
      task_id: request.task_id,
      task_worktree_id: taskWorktreeId,
      integration_worktree_id: integrationId,
      merge_operation_id: mergeOperationId,
      task_commit: request.task_commit,
    }, runId);
    if (cleanup.reused && cleanup.state === "completed") {
      store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(taskWorktreeId);
      return task.path;
    }
    try {
      const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
      const worktreeExists = listed.includes(`worktree ${task.path}`);
      const branchExists = await git(root, ["show-ref", "--verify", `refs/heads/${task.branch}`]).then(() => true, () => false);
      if (worktreeExists) {
        if (!(await worktreeStatus(task.path)).clean) throw new ValidationError(`worktree is dirty and cannot be removed: ${task.path}`);
        if (await currentBranch(task.path) !== task.branch) throw new ValidationError("task worktree branch no longer matches its managed record");
        await git(root, ["worktree", "remove", task.path]);
      }
      if (branchExists) {
        const contains = await git(integration.path, ["merge-base", "--is-ancestor", request.task_commit, "HEAD"]).then(() => true, () => false);
        if (!contains) throw new ValidationError("integration HEAD does not contain the task commit required for branch cleanup");
        await git(integration.path, ["branch", "-d", task.branch]);
      }
      store.finishOperation(cleanup.operationId, {
        path: task.path,
        branch: task.branch,
        task_id: request.task_id,
        task_worktree_id: taskWorktreeId,
        integration_worktree_id: integrationId,
        merge_operation_id: mergeOperationId,
        removed: true,
      });
      store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(taskWorktreeId);
      return task.path;
    } catch (error) {
      store.recordPendingOperationEvidence(cleanup.operationId, {
        state: "cleanup_failed",
        task_worktree_id: taskWorktreeId,
        integration_worktree_id: integrationId,
        merge_operation_id: mergeOperationId,
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

export async function integrateTarget(store: common.StateStore, ops: common.GitOperations, runId: string, integrationId: string, dispatchId: string): Promise<string> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    const dispatchFinalContext = common.finalizationContext(store, common.dispatchOperations, runId, dispatchId);
    if (dispatchFinalContext) {
      const completed = store.db.prepare("SELECT evidence_json FROM operations WHERE idempotency_key=? AND state='completed'")
        .get(`integrate:${runId}:${run.target_branch}:${dispatchFinalContext.revision_sha}`) as { evidence_json?: string } | undefined;
      if (completed) {
        const evidence = JSON.parse(completed.evidence_json ?? "{}") as { commit?: string };
        if (!evidence.commit || await currentHead(root) !== evidence.commit) throw new ValidationError("completed integration no longer matches target HEAD; reconcile required");
        return evidence.commit;
      }
    }
    const integration = ops.plannedIntegrationWorktree!(store, ops, runId, integrationId);
    const targetStatus = await worktreeStatus(root);
    const unmanagedUntracked = targetStatus.untracked.filter((path) => path !== ".worktrees/" && !path.startsWith(".worktrees/"));
    if (targetStatus.staged.length || targetStatus.unstaged.length || unmanagedUntracked.length) {
      store.event(runId, "git.target_dirty_blocked", {
        target_branch: run.target_branch,
        snapshot: { ...targetStatus, untracked: unmanagedUntracked },
        protection: { strategy: "reject_without_mutation", stash_created: false, cleanup_performed: false },
      });
      throw new ValidationError("target worktree must be clean before integration", { ...targetStatus, untracked: unmanagedUntracked });
    }
    if (await currentBranch(root) !== run.target_branch) throw new ValidationError("target branch changed before integration");
    const current = await currentHead(root);
    if (current !== run.base_commit) {
      const count = store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.sync' AND state='completed'").get(runId) as { count: number };
      if (count.count >= 3) throw new ValidationError("target branch drift exceeded 3 synchronization attempts");
      const integrationHeadBefore = await currentHead(integration.path);
      const sync = store.beginOperation("git.sync", `sync:${runId}:${integration.branch}:${current}`, {
        target: current,
        target_branch: run.target_branch,
        target_snapshot_before: targetStatus,
        integration_worktree_id: integrationId,
        integration_path: integration.path,
        integration_head_before: integrationHeadBefore,
      }, runId);
      if (sync.reused) {
        if (sync.state !== "completed") throw new ValidationError("target synchronization has unknown side effect; reconcile required");
      } else {
        try {
          const synced = await mergeNoFastForward(integration.path, run.target_branch, `Sync ${run.target_branch} into ${integration.branch}`);
          store.finishOperation(sync.operationId, {
            commit: synced,
            target_snapshot_before: targetStatus,
            target_snapshot_after: await worktreeStatus(root),
          });
          common.createDispatch(store, common.dispatchOperations, runId, "test", {
            objective: "Run the complete final verification after synchronizing target branch changes.",
            allowed_read_paths: ["package.json", "test"],
            allowed_write_paths: [],
            acceptance_criteria: ["All final checks pass", "No review is restarted"],
            context: { synchronization_commit: synced, target_commit: current },
          });
        } catch (error) {
          const conflictPaths = await git(integration.path, ["diff", "--name-only", "--diff-filter=U"])
            .then(({ stdout }) => stdout.split("\n").filter(Boolean), () => [] as string[]);
          store.recordPendingOperationEvidence(sync.operationId, {
            state: "conflicted",
            conflict_paths: conflictPaths,
            integration_head_before: integrationHeadBefore,
            target_head: current,
          });
          store.event(runId, "git.sync_conflicted", { operation_id: sync.operationId, integration_worktree_id: integrationId, conflict_paths: conflictPaths });
          throw new ValidationError("target synchronization conflicted; developer resolution required", { cause: String(error) });
        }
      }
    }
    const integrationHead = await currentHead(integration.path);
    new (await import("../review.js")).ReviewService(store).assertGate(runId, integrationHead);
    const finalContext = dispatchFinalContext;
    if (finalContext && (finalContext.revision_sha !== integrationHead || finalContext.integration_worktree_id !== integrationId)) {
      throw new ValidationError("final Git Operator dispatch does not match the integration worktree HEAD");
    }
    const operation = store.beginOperation("git.integrate", `integrate:${runId}:${run.target_branch}:${integrationHead}`, {
      integration: integration.branch,
      integration_worktree_id: integrationId,
      revision_sha: integrationHead,
      barrier_id: finalContext?.barrier_id ?? null,
      target_parent: current,
    }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("integration side effect is unknown; reconcile required");
      const recorded = store.db.prepare("SELECT evidence_json FROM operations WHERE operation_id=?").get(operation.operationId) as { evidence_json?: string };
      const evidence = JSON.parse(recorded.evidence_json ?? "{}") as { commit?: string };
      if (!evidence.commit || await currentHead(root) !== evidence.commit) throw new ValidationError("completed integration no longer matches target HEAD; reconcile required");
      return evidence.commit;
    }
    const commit = await mergeNoFastForward(root, integration.branch, `Integrate AI Team run ${runId}`);
    store.finishOperation(operation.operationId, {
      commit,
      target_parent: current,
      integration_head: integrationHead,
      barrier_id: finalContext?.barrier_id ?? null,
      integration_worktree_id: integrationId,
    });
    return commit;
  }

export async function continueConflict(store: common.StateStore, ops: common.GitOperations, runId: string, integrationId: string, allowedScopes: string[], dispatchId: string): Promise<string> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const integration = ops.plannedIntegrationWorktree!(store, ops, runId, integrationId);
    try { await git(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); }
    catch { throw new ValidationError("worktree has no merge conflict in progress"); }
    const unresolved = (await git(integration.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    if (unresolved.length) throw new ValidationError("merge still has unresolved paths", unresolved);
    const changed = [...new Set((await git(integration.path, ["status", "--porcelain=v1", "-z"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)))];
    if (!changed.length) throw new ValidationError("no conflict resolution changes are present");
    const sync = store.db.prepare("SELECT operation_id,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.sync' AND state='pending' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { operation_id: string; request_json: string; evidence_json?: string } | undefined;
    if (!sync) throw new ValidationError("conflict continuation requires its pending git.sync operation");
    const request = JSON.parse(sync.request_json) as { target?: string; integration_head_before?: string; integration_worktree_id?: string; target_snapshot_before?: unknown };
    const syncEvidence = JSON.parse(sync.evidence_json ?? "{}") as Partial<common.SyncConflictEvidence>;
    const syncIntegrationId = request.integration_worktree_id ?? syncEvidence.integration_worktree_id;
    const integrationHeadBefore = request.integration_head_before ?? syncEvidence.integration_head_before;
    const targetHead = request.target ?? syncEvidence.target_head;
    if (syncIntegrationId !== integrationId || !targetHead || !integrationHeadBefore) {
      throw new ValidationError("pending git.sync operation is missing conflict lineage");
    }
    const conflictPaths = [...new Set(syncEvidence.conflict_paths ?? [])].sort();
    if (!conflictPaths.length) throw new ValidationError("pending git.sync operation has no recorded conflict paths");
    for (const path of conflictPaths) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, allowedScopes)) throw new ValidationError(`conflict resolution changed path outside allowed scope: ${path}`);
      await canonicalizeInside(integration.path, path, true);
    }
    const mergeBase = (await git(integration.path, ["merge-base", integrationHeadBefore, targetHead])).stdout;
    const targetChanged = new Set((await git(integration.path, ["diff", "--name-only", mergeBase, targetHead, "--"])).stdout.split("\n").filter(Boolean));
    const integrationChanged = new Set((await git(integration.path, ["diff", "--name-only", mergeBase, integrationHeadBefore, "--"])).stdout.split("\n").filter(Boolean));
    const inheritedPaths = changed.filter((path) => !conflictPaths.includes(path));
    const unauthorizedInherited: string[] = [];
    for (const path of inheritedPaths) {
      if (!targetChanged.has(path) || integrationChanged.has(path)) { unauthorizedInherited.push(path); continue; }
      const matchesTarget = await git(integration.path, ["diff", "--quiet", "--cached", targetHead, "--", path]).then(() => true, () => false);
      if (!matchesTarget) unauthorizedInherited.push(path);
    }
    if (unauthorizedInherited.length) throw new ValidationError("merge contains paths without conflict or target-sync lineage", {
      unauthorized_paths: unauthorizedInherited,
      conflict_paths: conflictPaths,
      target_inherited_paths: inheritedPaths.filter((path) => !unauthorizedInherited.includes(path)),
    });
    const operation = store.beginOperation("git.merge.continue", `merge-continue:${runId}:${integrationId}:${sha256(changed.sort().join("\n"))}`, {
      changed,
      conflict_paths: conflictPaths,
      target_inherited_paths: inheritedPaths,
      sync_operation_id: sync.operation_id,
    }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("merge continuation side effect is unknown; reconcile required");
      return currentHead(integration.path);
    }
    await git(integration.path, ["add", "--", ...conflictPaths]);
    await git(integration.path, ["commit", "--no-edit"]);
    const commit = await currentHead(integration.path);
    store.finishOperation(operation.operationId, { commit, changed });
    store.finishOperation(sync.operation_id, {
      commit,
      conflict_paths: conflictPaths,
      target_inherited_paths: inheritedPaths,
      continued_by: operation.operationId,
      target_snapshot_before: request.target_snapshot_before ?? null,
      target_snapshot_after: await worktreeStatus(ops.repositoryForRun!(store, ops, runId).root),
    });
    common.createDispatch(store, common.dispatchOperations, runId, "test", {
      objective: "Run the complete final verification after conflict resolution.",
      allowed_read_paths: ["package.json", "test"],
      allowed_write_paths: [],
      acceptance_criteria: ["All final checks pass", "No review is restarted"],
      context: { conflict_resolution_commit: commit },
    });
    return commit;
  }
