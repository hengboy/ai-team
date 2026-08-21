import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { ValidationError } from "../errors.js";
import { currentHead, git, worktreeStatus } from "../git.js";
import { assertWritablePath, pathMatchesScope } from "../security.js";
import { stableJson, toPosix } from "../utils.js";
import { completedMergeOwnershipPartialEffect } from "../worktree-ownership.js";
import * as common from "./runtime.js";
export async function reconcileSyncConflict(store: common.StateStore, ops: common.GitOperations, runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const value = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {};
    const issues: Array<{ pointer: string; constraint: string; message: string }> = [];
    const integrationId = value.integration_worktree_id;
    const conflictPaths = value.conflict_paths;
    const integrationHeadBefore = value.integration_head_before;
    const targetHead = value.target_head;
    if (typeof integrationId !== "string" || !integrationId) issues.push({ pointer: "/integration_worktree_id", constraint: "non-empty string", message: "integration_worktree_id is required" });
    if (!Array.isArray(conflictPaths) || !conflictPaths.length || conflictPaths.some((path) => typeof path !== "string" || !path)) {
      issues.push({ pointer: "/conflict_paths", constraint: "non-empty string array", message: "conflict_paths must list the explicitly authorized conflict paths" });
    }
    if (typeof integrationHeadBefore !== "string" || !/^[a-f0-9]{40}$/.test(integrationHeadBefore)) issues.push({ pointer: "/integration_head_before", constraint: "40-character commit SHA", message: "integration_head_before must identify the pre-sync integration HEAD" });
    if (typeof targetHead !== "string" || !/^[a-f0-9]{40}$/.test(targetHead)) issues.push({ pointer: "/target_head", constraint: "40-character commit SHA", message: "target_head must identify the synchronized target HEAD" });
    if (issues.length) throw new ValidationError("conflicted git.sync reconciliation evidence is invalid", issues);

    const normalized: common.SyncConflictEvidence = {
      integration_worktree_id: integrationId as string,
      conflict_paths: [...new Set(conflictPaths as string[])].sort(),
      integration_head_before: integrationHeadBefore as string,
      target_head: targetHead as string,
    };
    for (const path of normalized.conflict_paths) assertWritablePath(path);
    const operation = store.db.prepare("SELECT run_id,kind,state,request_json FROM operations WHERE operation_id=?").get(operationId) as { run_id: string; kind: string; state: string; request_json: string } | undefined;
    if (!operation || operation.run_id !== runId) throw new ValidationError("git reconciliation operation does not belong to run");
    if (operation.kind !== "git.sync" || operation.state !== "pending") throw new ValidationError("conflicted reconciliation requires a pending git.sync operation");
    const request = JSON.parse(operation.request_json) as { target?: string };
    if (request.target && request.target !== normalized.target_head) throw new ValidationError("conflicted reconciliation target_head does not match the sync request");
    const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, normalized.integration_worktree_id) as { path: string } | undefined;
    if (!worktree) throw new ValidationError("conflicted reconciliation integration worktree is not active for the run");
    if (await currentHead(worktree.path) !== normalized.integration_head_before) throw new ValidationError("integration worktree HEAD does not match integration_head_before");
    const mergeHead = await git(worktree.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(({ stdout }) => stdout, () => "");
    if (mergeHead !== normalized.target_head) throw new ValidationError("integration worktree MERGE_HEAD does not match target_head");

    store.db.transaction(() => {
      store.recordPendingOperationEvidence(operationId, { state: "conflicted", ...normalized });
      const run = store.getRun(runId) as { state: string };
      if (run.state === "failed" || run.state === "retryable_failure") {
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      store.event(runId, "run.git_sync_conflict_reconciled", { dispatch_id: dispatchId ?? null, operation_id: operationId, ...normalized });
    })();
    return ops.reconcile!(store, ops, runId);
  }

export async function reconcileTaskAuthorityConflict(store: common.StateStore, ops: common.GitOperations, runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    ops.assertGitOperator!(store, ops, runId, dispatchId, "reconcile-task-authority-conflict");
    const value = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {};
    const requiredKeys = ["worktree_id", "authority_commit", "expected_head", "dirty_paths", "authority_paths", "conflict_paths", "stash_commit"];
    const issues: Array<{ pointer: string; constraint: string; message: string }> = [];
    if (Object.keys(value).some((key) => !requiredKeys.includes(key))) issues.push({ pointer: "/", constraint: "authority conflict evidence fields only", message: "unexpected authority conflict evidence field" });
    for (const key of ["worktree_id", "authority_commit", "expected_head", "stash_commit"] as const) {
      if (typeof value[key] !== "string" || !value[key]) issues.push({ pointer: `/${key}`, constraint: "non-empty string", message: `${key} is required` });
    }
    for (const key of ["dirty_paths", "authority_paths", "conflict_paths"] as const) {
      if (!Array.isArray(value[key]) || !value[key].length || value[key].some((path) => typeof path !== "string" || !path)) {
        issues.push({ pointer: `/${key}`, constraint: "non-empty string array", message: `${key} is required` });
      }
    }
    for (const key of ["authority_commit", "expected_head", "stash_commit"] as const) {
      if (typeof value[key] === "string" && !/^[a-f0-9]{40}$/.test(value[key])) issues.push({ pointer: `/${key}`, constraint: "40-character commit SHA", message: `${key} must be a commit SHA` });
    }
    if (issues.length) throw new ValidationError("conflicted git.task_authority.apply reconciliation evidence is invalid", issues);

    const normalized: Omit<common.AuthorityApplyConflictEvidence, "state"> = {
      worktree_id: value.worktree_id as string,
      authority_commit: value.authority_commit as string,
      expected_head: value.expected_head as string,
      dirty_paths: [...new Set(value.dirty_paths as string[])].sort(),
      authority_paths: [...new Set(value.authority_paths as string[])].sort(),
      conflict_paths: [...new Set(value.conflict_paths as string[])].sort(),
      stash_commit: value.stash_commit as string,
    };
    for (const path of [...normalized.dirty_paths, ...normalized.authority_paths, ...normalized.conflict_paths]) assertWritablePath(path);
    if (normalized.conflict_paths.some((path) => !normalized.dirty_paths.includes(path) || !normalized.authority_paths.includes(path))) {
      throw new ValidationError("authority conflict paths must be shared dirty authority paths");
    }
    const operation = store.db.prepare("SELECT run_id,kind,state,request_json FROM operations WHERE operation_id=?").get(operationId) as { run_id: string; kind: string; state: string; request_json: string } | undefined;
    if (!operation || operation.run_id !== runId) throw new ValidationError("git reconciliation operation does not belong to run");
    if (operation.kind !== "git.task_authority.apply" || operation.state !== "pending") throw new ValidationError("conflicted reconciliation requires a pending git.task_authority.apply operation");
    const request = JSON.parse(operation.request_json) as common.TaskAuthorityApplyRequest & { dirty_paths?: unknown };
    const recordedDirtyPaths = Array.isArray(request.dirty_paths) && request.dirty_paths.every((path) => typeof path === "string") ? [...request.dirty_paths].sort() : [];
    if (!request.dispatchId || request.worktreeId !== normalized.worktree_id || request.authorityCommit !== normalized.authority_commit || request.expectedHead !== normalized.expected_head
      || stableJson(recordedDirtyPaths) !== stableJson(normalized.dirty_paths)) {
      throw new ValidationError("authority conflict evidence does not match the authority apply request");
    }
    if (dispatchId !== request.dispatchId) throw new ValidationError("authority conflict reconciliation requires the original claimed authority dispatch");
    const dispatch = store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, request.dispatchId) as { state: string; packet_json: string } | undefined;
    const packet = dispatch ? JSON.parse(dispatch.packet_json) as { allowed_write_paths: string[]; context: Record<string, unknown> } : undefined;
    const context = packet?.context;
    const scopeRecovery = context?.scope_recovery as Record<string, unknown> | undefined;
    const packetDirtyPaths = Array.isArray(scopeRecovery?.dirty_paths) && scopeRecovery.dirty_paths.every((path) => typeof path === "string") ? [...scopeRecovery.dirty_paths as string[]].sort() : [];
    const scopePaths = Array.isArray(scopeRecovery?.allowed_write_paths) && scopeRecovery.allowed_write_paths.every((path) => typeof path === "string") ? scopeRecovery.allowed_write_paths as string[] : [];
    if (!dispatch || dispatch.state !== "claimed" || !packet || context?.phase !== "apply_task_authority" || context.operation !== "apply-task-authority"
      || context.worktree_id !== normalized.worktree_id || context.authority_commit !== normalized.authority_commit || context.expected_head !== normalized.expected_head
      || stableJson(packetDirtyPaths) !== stableJson(normalized.dirty_paths) || !scopePaths.length
      || [...normalized.dirty_paths, ...normalized.authority_paths, ...normalized.conflict_paths].some((path) => !pathMatchesScope(path, packet.allowed_write_paths) || !pathMatchesScope(path, scopePaths))) {
      throw new ValidationError("authority conflict evidence does not match the claimed frozen authority packet");
    }
    const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, normalized.worktree_id) as { path: string } | undefined;
    if (!worktree) throw new ValidationError("authority conflict reconciliation worktree is not active for the run");
    if (await currentHead(worktree.path) !== normalized.expected_head) throw new ValidationError("authority conflict reconciliation worktree HEAD does not match expected_head");
    const mergeHead = await git(worktree.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
    const unmerged = (await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    if (mergeHead || unmerged.length) throw new ValidationError("authority conflict reconciliation worktree must have no active merge or unmerged paths");
    const actualDirtyPaths = (await git(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
    if (stableJson(actualDirtyPaths) !== stableJson(normalized.dirty_paths)) throw new ValidationError("authority conflict reconciliation dirty paths do not match the worktree", { expected: normalized.dirty_paths, actual: actualDirtyPaths });
    const actualAuthorityPaths = (await git(worktree.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", normalized.authority_commit])).stdout.split("\n").filter(Boolean).sort();
    if (stableJson(actualAuthorityPaths) !== stableJson(normalized.authority_paths)) throw new ValidationError("authority conflict reconciliation authority paths do not match the authority commit");
    await git(worktree.path, ["cat-file", "-e", `${normalized.stash_commit}^{commit}`]).catch(() => { throw new ValidationError("authority conflict reconciliation stash_commit is not available"); });

    store.db.transaction(() => {
      store.recordPendingOperationEvidence(operationId, { state: "conflicted", ...normalized });
      const run = store.getRun(runId) as { state: string };
      if (run.state === "failed" || run.state === "retryable_failure") store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      store.event(runId, "worktree.task_authority_conflict_reconciled", { dispatch_id: dispatchId, operation_id: operationId, ...normalized });
    })();
    common.createAuthorityConflictContinuation(store, common.dispatchOperations, {
      runId, authorityDispatchId: request.dispatchId, operationId, worktreeId: normalized.worktree_id, authorityCommit: normalized.authority_commit,
      expectedHead: normalized.expected_head, dirtyPaths: normalized.dirty_paths, authorityPaths: normalized.authority_paths,
      conflictPaths: normalized.conflict_paths, stashCommit: normalized.stash_commit,
    });
    return ops.reconcile!(store, ops, runId);
  }

export async function cleanup(store: common.StateStore, ops: common.GitOperations, runId: string, dispatchId?: string): Promise<string[]> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    if (run.state === "active" && run.stage !== "canceling") {
      if (!dispatchId) throw new ValidationError("active run cleanup requires its final Git Operator dispatch");
      common.assertFinalizingCleanup(store, common.dispatchOperations, runId, dispatchId);
    } else if (run.state !== "completed" && !(run.state === "active" && run.stage === "canceling")) {
      throw new ValidationError("worktrees are retained unless final integration completed or the run entered managed cancellation");
    }
    const rows = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND state='active' ORDER BY length(path) DESC").all(runId) as any[];
    const removed: string[] = [];
    for (const row of rows) {
      if (!(await worktreeStatus(row.path)).clean) throw new ValidationError(`worktree is dirty and cannot be removed: ${row.path}`);
      const canonical = await realpath(row.path);
      const relativePath = toPosix(relative(root, canonical));
      if (!relativePath.startsWith(".worktrees/")) throw new ValidationError(`refusing to remove worktree outside managed root: ${canonical}`);
      const operation = store.beginOperation("git.cleanup", `cleanup:${runId}:${row.worktree_id}`, { worktreeId: row.worktree_id, path: canonical, branch: row.branch }, runId);
      if (operation.reused && operation.state !== "completed") throw new ValidationError("cleanup side effect is unknown; reconcile required");
      if (operation.reused) { store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(row.worktree_id); removed.push(canonical); continue; }
      await git(root, ["worktree", "remove", canonical]);
      await git(root, ["branch", "-d", row.branch]);
      store.finishOperation(operation.operationId, { path: canonical, branch: row.branch, removed: true });
      store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(row.worktree_id);
      removed.push(canonical);
    }
    return removed;
  }

export async function reconcile(store: common.StateStore, ops: common.GitOperations, runId: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    const { root } = ops.repositoryForRun!(store, ops, runId);
    const pending = store.db.prepare("SELECT * FROM operations WHERE run_id=? AND state='pending'").all(runId) as any[];
    const result: Array<{ operation_id: string; state: string; fact: string; next_command?: string }> = [];
    for (const operation of pending) {
      const request = JSON.parse(operation.request_json);
      if (operation.kind === "git.merge.task") {
        const merge = request as common.TaskMergeRequest;
        const integration = typeof merge.integration_worktree_id === "string"
          ? store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
            .get(runId, merge.integration_worktree_id) as { path: string } | undefined
          : undefined;
        const commit = integration ? await ops.confirmTaskMerge!(store, ops, integration.path, merge) : undefined;
        if (!commit) {
          result.push({ operation_id: operation.operation_id, state: "unknown", fact: "task merge cannot be proven from its recorded parents" });
          continue;
        }
        ops.finishTaskMerge!(store, ops, runId, operation.operation_id, merge, commit);
        try {
          await ops.cleanupIntegratedTask!(store, ops, runId, merge.task_worktree_id, merge.integration_worktree_id, operation.operation_id);
          result.push({ operation_id: operation.operation_id, state: "completed", fact: "recorded task merge parents match and task cleanup converged" });
        } catch (error) {
          result.push({ operation_id: operation.operation_id, state: "completed", fact: `recorded task merge parents match; task cleanup remains pending: ${error instanceof Error ? error.message : String(error)}` });
        }
      } else if (operation.kind === "git.cleanup" && typeof request.task_worktree_id === "string" && typeof request.integration_worktree_id === "string" && typeof request.merge_operation_id === "string") {
        try {
          await ops.cleanupIntegratedTask!(store, ops, runId, request.task_worktree_id, request.integration_worktree_id, request.merge_operation_id);
          result.push({ operation_id: operation.operation_id, state: "completed", fact: "integrated task worktree and branch cleanup converged" });
        } catch (error) {
          result.push({ operation_id: operation.operation_id, state: "unknown", fact: `integrated task cleanup remains blocked: ${error instanceof Error ? error.message : String(error)}` });
        }
      } else if (operation.kind === "git.cleanup") {
        const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
        const branchExists = await git(root, ["show-ref", "--verify", `refs/heads/${request.branch}`]).then(() => true, () => false);
        const exists = listed.includes(`worktree ${request.path}`) || branchExists;
        result.push({ operation_id: operation.operation_id, state: exists ? "unknown" : "completed", fact: exists ? "cleanup is partially applied" : "owned worktree and branch are absent" });
      } else if (operation.kind === "git.sync") {
        const evidence = JSON.parse(operation.evidence_json ?? "{}") as Partial<common.SyncConflictEvidence> & { state?: string };
        const integrationWorktreeId = request.integration_worktree_id ?? evidence.integration_worktree_id;
        const integrationHeadBefore = request.integration_head_before ?? evidence.integration_head_before;
        const integrationRow = typeof integrationWorktreeId === "string"
          ? store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, integrationWorktreeId) as { path: string } | undefined
          : undefined;
        const integration = integrationRow?.path ?? request.integration_path as string | undefined;
        const mergeHead = integration ? await git(integration, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false) : false;
        const dispatch = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1").get(runId) as { dispatch_id: string } | undefined;
        const recordedConflict = evidence.state === "conflicted" && Boolean(evidence.conflict_paths?.length);
        if ((mergeHead || recordedConflict) && integrationWorktreeId) {
          const scope = (evidence.conflict_paths ?? []).join(",");
          result.push({ operation_id: operation.operation_id, state: "conflicted", fact: "target synchronization has an unresolved merge continuation", ...(dispatch ? { next_command: `ai-team git continue-conflict --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --integration-id ${integrationWorktreeId} --scope ${scope}` } : {}) });
        } else if (integration && integrationHeadBefore && await currentHead(integration).then((head) => head === integrationHeadBefore, () => false)) {
          result.push({ operation_id: operation.operation_id, state: "not_applied", fact: "target synchronization did not change the integration worktree", ...(dispatch ? { next_command: `ai-team git reconcile --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --operation-id ${operation.operation_id} --state not_applied --evidence-file <json>` } : {}) });
        } else {
          result.push({ operation_id: operation.operation_id, state: "unknown", fact: "target synchronization state requires explicit evidence" });
        }
      } else if (operation.kind === "git.task_authority.apply") {
        const evidence = JSON.parse(operation.evidence_json ?? "{}") as Partial<common.AuthorityApplyConflictEvidence>;
        const continuation = typeof request.dispatchId === "string"
          ? store.db.prepare("SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND replacement_for=? AND role='git-operator' ORDER BY created_at LIMIT 1").get(runId, request.dispatchId) as { dispatch_id: string; state: string } | undefined
          : undefined;
        if (evidence.state === "conflicted" && continuation?.state === "claimed") {
          result.push({ operation_id: operation.operation_id, state: "conflicted", fact: "authority application has a claimed conflict continuation", next_command: `ai-team git continue-authority-conflict --run-id ${runId} --dispatch-id ${continuation.dispatch_id}` });
        } else if (evidence.state === "conflicted" && continuation) {
          result.push({ operation_id: operation.operation_id, state: "conflicted", fact: "authority application conflict continuation is ready to claim" });
        } else {
          result.push({ operation_id: operation.operation_id, state: "unknown", fact: "authority application state requires explicit conflict evidence" });
        }
      } else if (operation.kind.includes("worktree") || operation.kind.includes("integration.create")) {
        const listed = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
        const exists = listed.includes(`worktree ${request.path}`) && listed.includes(`branch refs/heads/${request.branch}`);
        result.push({ operation_id: operation.operation_id, state: exists ? "completed" : "not_applied", fact: exists ? "owned worktree exists" : "owned worktree absent" });
      } else result.push({ operation_id: operation.operation_id, state: "unknown", fact: "manual evidence required" });
    }
    const retryable = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (retryable) {
      const bindings = common.mergeWorktreeBindings(store, common.dispatchOperations, runId, retryable.dispatch_id);
      if (bindings.integration_worktree_id && bindings.task_worktree_ids.length) {
        const partial = completedMergeOwnershipPartialEffect(store, runId, bindings.integration_worktree_id, bindings.task_worktree_ids);
        if (partial) result.push({ operation_id: partial.operation_ids.at(-1) ?? `dispatch-binding:${retryable.dispatch_id}`, state: "completed", fact: partial.fact });
      }
    }
    return result;
  }
