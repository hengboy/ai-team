export interface PreparedWorktree { worktree_id: string; branch: string; path: string; base_commit: string; reused: boolean; }
export interface WorktreeStatus {
  worktree_id: string;
  type: "plan" | "integration" | "task";
  owner: string;
  branch: string;
  path: string;
  base_commit: string;
  head: string | null;
  state: string;
  clean: boolean | null;
}

export interface TaskWorktreeRecoveryRequest {
  project: string;
  worktreeId: string;
  fromPlanId: string;
  fromRevision: string;
  toPlanId: string;
  toRevision: string;
  toRunId: string;
  taskId: string;
  expectedHead: string;
  expectedSourceArtifact: string;
  dispatchId?: string;
  replacesStagingId?: string;
}

export interface TaskWorktreeRecoveryReceipt {
  recovery_id: string;
  worktree_id: string;
  path: string;
  branch: string;
  head: string;
  task_id: string;
  from_run_id: string;
  to_run_id: string;
  source_artifact: { artifact_id: string; digest: string };
  dirty_paths: string[];
  replaced_staging?: {
    staging_id: string;
    dispatch_id: string;
    digest: string;
    before_state: "ready";
    after_state: "canceled";
    operation_id: string;
  };
  reused: boolean;
}

export interface TaskAuthorityApplyRequest {
  runId: string;
  dispatchId: string;
  worktreeId: string;
  authorityCommit: string;
  expectedHead: string;
}

export interface TaskAuthorityApplyReceipt {
  operation_id: string;
  worktree_id: string;
  authority_commit: string;
  head: string;
  dirty_paths: string[];
  stash_commit: string;
  reused: boolean;
}

export interface SyncConflictEvidence {
  integration_worktree_id: string;
  conflict_paths: string[];
  integration_head_before: string;
  target_head: string;
}
