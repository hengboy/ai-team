import type { StateStore } from "./state.js";
import type { PreparedWorktree, TaskAuthorityApplyReceipt, TaskAuthorityApplyRequest, TaskWorktreeRecoveryReceipt, TaskWorktreeRecoveryRequest, WorktreeStatus } from "./git-orchestrator/runtime.js";
import * as runtime from "./git-orchestrator/runtime.js";
import * as taskWorktree from "./git-orchestrator/task-worktree.js";
import * as integration from "./git-orchestrator/integration.js";
import * as recovery from "./git-orchestrator/recovery.js";

export type { PreparedWorktree, SyncConflictEvidence, TaskAuthorityApplyReceipt, TaskAuthorityApplyRequest, TaskWorktreeRecoveryReceipt, TaskWorktreeRecoveryRequest, WorktreeStatus } from "./git-orchestrator/runtime.js";

const gitOperations: runtime.GitOperations = { assertGitOperator: runtime.assertGitOperator, repositoryForRun: runtime.repositoryForRun, activeIntegrationWorktree: runtime.activeIntegrationWorktree, worktree: runtime.worktree, plannedIntegrationWorktree: runtime.plannedIntegrationWorktree, worktreeForCommit: runtime.worktreeForCommit, prepareTask: taskWorktree.prepareTask, adopt: taskWorktree.adopt, adoptCommit: taskWorktree.adoptCommit, transfer: taskWorktree.transfer, recoverTaskWorktree: taskWorktree.recoverTaskWorktree, applyTaskAuthority: taskWorktree.applyTaskAuthority, continueTaskAuthorityConflict: taskWorktree.continueTaskAuthorityConflict, prepareIntegration: integration.prepareIntegration, status: integration.status, commit: integration.commit, mergeTask: integration.mergeTask, confirmTaskMerge: integration.confirmTaskMerge, finishTaskMerge: integration.finishTaskMerge, cleanupIntegratedTask: integration.cleanupIntegratedTask, integrateTarget: integration.integrateTarget, continueConflict: integration.continueConflict, reconcileSyncConflict: recovery.reconcileSyncConflict, reconcileTaskAuthorityConflict: recovery.reconcileTaskAuthorityConflict, cleanup: recovery.cleanup, reconcile: recovery.reconcile };

export class GitOrchestrator {
  constructor(readonly store: StateStore) {}

  async prepareTask(runId: string, taskId?: string, baseCommit?: string, dependsOn?: string, dispatchId?: string): Promise<PreparedWorktree> { return gitOperations.prepareTask!(this.store, gitOperations, runId, taskId, baseCommit, dependsOn, dispatchId); }

  async adopt(runId: string, path: string, branch: string, baseCommit: string, commit?: string, dispatchId?: string): Promise<PreparedWorktree> { return gitOperations.adopt!(this.store, gitOperations, runId, path, branch, baseCommit, commit, dispatchId); }

  async adoptCommit(runId: string, commit: string, taskId = "implementation", dispatchId?: string): Promise<PreparedWorktree> { return gitOperations.adoptCommit!(this.store, gitOperations, runId, commit, taskId, dispatchId); }

  async transfer(runId: string, worktreeId: string, dispatchId?: string): Promise<PreparedWorktree> { return gitOperations.transfer!(this.store, gitOperations, runId, worktreeId, dispatchId); }

  async recoverTaskWorktree(request: TaskWorktreeRecoveryRequest): Promise<TaskWorktreeRecoveryReceipt> { return gitOperations.recoverTaskWorktree!(this.store, gitOperations, request); }

  async applyTaskAuthority(request: TaskAuthorityApplyRequest): Promise<TaskAuthorityApplyReceipt> { return gitOperations.applyTaskAuthority!(this.store, gitOperations, request); }

  async continueTaskAuthorityConflict(runId: string, dispatchId: string): Promise<TaskAuthorityApplyReceipt> { return gitOperations.continueTaskAuthorityConflict!(this.store, gitOperations, runId, dispatchId); }

  async prepareIntegration(runId: string, dispatchId?: string): Promise<PreparedWorktree> { return gitOperations.prepareIntegration!(this.store, gitOperations, runId, dispatchId); }

  async status(runId: string): Promise<WorktreeStatus[]> { return gitOperations.status!(this.store, gitOperations, runId); }

  async commit(runId: string, worktreeId: string, message: string, allowedScopes: string[], dispatchId?: string): Promise<{ commit: string; paths: string[]; reused: boolean }> { return gitOperations.commit!(this.store, gitOperations, runId, worktreeId, message, allowedScopes, dispatchId); }

  async mergeTask(runId: string, integrationId: string, taskId: string, dispatchId?: string): Promise<string> { return gitOperations.mergeTask!(this.store, gitOperations, runId, integrationId, taskId, dispatchId); }

  async cleanupIntegratedTask(runId: string, taskWorktreeId: string, integrationId: string, mergeOperationId: string, dispatchId?: string): Promise<string | undefined> { return gitOperations.cleanupIntegratedTask!(this.store, gitOperations, runId, taskWorktreeId, integrationId, mergeOperationId, dispatchId); }

  async integrateTarget(runId: string, integrationId: string, dispatchId?: string): Promise<string> { return gitOperations.integrateTarget!(this.store, gitOperations, runId, integrationId, dispatchId); }

  async continueConflict(runId: string, integrationId: string, allowedScopes: string[], dispatchId?: string): Promise<string> { return gitOperations.continueConflict!(this.store, gitOperations, runId, integrationId, allowedScopes, dispatchId); }

  async reconcileSyncConflict(runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> { return gitOperations.reconcileSyncConflict!(this.store, gitOperations, runId, operationId, evidence, dispatchId); }

  async reconcileTaskAuthorityConflict(runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> { return gitOperations.reconcileTaskAuthorityConflict!(this.store, gitOperations, runId, operationId, evidence, dispatchId); }

  async cleanup(runId: string, dispatchId?: string): Promise<string[]> { return gitOperations.cleanup!(this.store, gitOperations, runId, dispatchId); }

  async reconcile(runId: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> { return gitOperations.reconcile!(this.store, gitOperations, runId); }
}
