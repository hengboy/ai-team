
import { ValidationError } from "../errors.js";
import { join } from "node:path";
import { StateStore } from "../state.js";
import { sha256, stableJson } from "../utils.js";
import { resolveMergeIntegrationWorktree, resolveMergeTaskWorktree } from "../worktree-ownership.js";

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

export interface AuthorityApplyConflictEvidence {
  state: "conflicted";
  worktree_id: string;
  authority_commit: string;
  expected_head: string;
  dirty_paths: string[];
  authority_paths: string[];
  conflict_paths: string[];
  stash_commit: string;
}

export interface SyncConflictEvidence {
  integration_worktree_id: string;
  conflict_paths: string[];
  integration_head_before: string;
  target_head: string;
}

export interface TaskMergeRequest {
  integration: string;
  task: string;
  integration_worktree_id: string;
  task_id: string;
  task_worktree_id: string;
  task_commit: string;
  integration_head_before: string;
}

export const safeSegment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new ValidationError(`unsafe Git name segment: ${value}`);
  return value;
};

export const isPlannedRun = (run: any): boolean => run.mode === "planned" && typeof run.plan_id === "string" && typeof run.revision === "string";

export const worktreeNames = (root: string, run: any, runId: string, taskId?: string): { branch: string; path: string } => {
  const plan = safeSegment(run.plan_id ?? `direct-${runId.slice(-8).toLowerCase()}`);
  if (isPlannedRun(run)) {
    const planRevision = safeSegment(`${plan}-${run.revision}`);
    if (taskId === undefined) return { branch: `plan/${plan}/${planRevision}`, path: join(root, ".worktrees", "plans", plan, planRevision) };
    const task = safeSegment(taskId.toLowerCase());
    const taskRevision = safeSegment(`${planRevision}--${task}`);
    return { branch: `task/${plan}/${taskRevision}`, path: join(root, ".worktrees", "tasks", plan, taskRevision) };
  }
  const short = safeSegment(runId.slice(-8).toLowerCase());
  if (taskId === undefined) return { branch: `integration/${plan}/${short}`, path: join(root, ".worktrees", "integration", plan, short) };
  const task = safeSegment(taskId.toLowerCase());
  return { branch: `task/${plan}/${short}/${task}`, path: join(root, ".worktrees", "tasks", plan, short, task) };
};

export const legacyIntegrationNames = (root: string, run: any, runId: string): { branch: string; path: string } => {
  const plan = safeSegment(run.plan_id);
  const short = safeSegment(runId.slice(-8).toLowerCase());
  return { branch: `integration/${plan}/${short}`, path: join(root, ".worktrees", "integration", plan, short) };
};



import { dispatchOperations } from "../dispatch/coordinator.js";
import { assertClaimed, assertMergeWorktreeBindings, create as createDispatch, mergeWorktreeBindings } from "../dispatch/submission-lifecycle.js";
import { assertFinalizingCleanup, finalizationContext } from "../dispatch/recovery-lifecycle.js";
import { createAuthorityConflictContinuation } from "../dispatch/task-lifecycle.js";
import { assertPreCommitScope } from "../dispatch/store.js";

export { StateStore } from "../state.js";
export { dispatchOperations, assertClaimed, assertMergeWorktreeBindings, createAuthorityConflictContinuation, createDispatch, mergeWorktreeBindings, assertFinalizingCleanup, finalizationContext, assertPreCommitScope };

export const assertDirectScopePassed = (store: StateStore, runId: string, stage: "triage" | "pre_write"): void => {
  const event = store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type=?").get(runId, "scope." + stage);
  if (!event) throw new ValidationError("direct run has not passed " + stage + " scope gate");
};

export const checkDirectPreCommit = (store: StateStore, runId: string, _stage: "pre_commit", paths: string[]): { digest: string; complete: boolean } => {
  const normalized = [...new Set(paths)].sort();
  if (!normalized.length) throw new ValidationError("scope cannot be empty");
  const digest = sha256(stableJson(normalized));
  const previous = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type LIKE 'scope.%' ORDER BY event_id").all(runId) as Array<{ payload_json: string }>;
  const existing = previous.map((row) => JSON.parse(row.payload_json) as { stage: string; digest: string });
  if (existing.some((item) => item.digest !== digest)) {
    store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    throw new ValidationError("direct scope changed; run frozen and Planning handoff required");
  }
  if (existing.some((item) => item.stage === "pre_commit")) return { digest, complete: true };
  if (existing.length !== 2) throw new ValidationError("scope gate out of order: pre_commit");
  store.event(runId, "scope.pre_commit", { stage: "pre_commit", digest, paths: normalized });
  return { digest, complete: true };
};

export type GitOperations = Record<string, (store: StateStore, ops: GitOperations, ...args: any[]) => any>;

export function assertGitOperator(store: StateStore, ops: GitOperations, runId: string, dispatchId?: string, operation?: "apply-task-authority" | "reconcile-task-authority-conflict" | "continue-task-authority-conflict" | "cleanup-integrated-task"): void {
    if (!dispatchId) return;
    assertClaimed(store, dispatchOperations, runId, dispatchId, "git-operator");
    const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = row ? (JSON.parse(row.packet_json) as { context?: Record<string, unknown> }).context : undefined;
    if (context?.phase === "apply_task_authority" && operation !== "apply-task-authority" && operation !== "reconcile-task-authority-conflict") {
      throw new ValidationError("apply-task-authority dispatch only authorizes apply-task-authority operations");
    }
    if (context?.phase === "continue_task_authority_conflict" && operation !== "continue-task-authority-conflict"
      || context?.phase === "cleanup_integrated_task" && operation !== "cleanup-integrated-task") {
      throw new ValidationError("Git Operator dispatch does not authorize this operation");
    }
  }

export function repositoryForRun(store: StateStore, ops: GitOperations, runId: string): { root: string; run: any } {
    const run = store.getRun(runId) as any;
    const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    return { root: repository.project_path, run };
  }

export function activeIntegrationWorktree(store: StateStore, ops: GitOperations, runId: string, root: string, run: any): any | undefined {
    if (!isPlannedRun(run)) {
      return store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as any;
    }
    const expected = worktreeNames(root, run, runId);
    const exact = store.db.prepare("SELECT * FROM worktrees WHERE branch=? AND path=? AND state='active'")
      .get(expected.branch, expected.path) as any;
    if (exact) return exact;

    const legacy = legacyIntegrationNames(root, run, runId);
    const row = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND path=? AND state='active'")
      .get(runId, legacy.branch, legacy.path) as any;
    if (!row) return undefined;
    const created = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.created' ORDER BY event_id LIMIT 1")
      .get(runId) as { payload_json: string } | undefined;
    const operation = store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.integration.create' AND state='completed'
      AND json_extract(request_json,'$.branch')=? AND json_extract(request_json,'$.path')=?`).get(runId, legacy.branch, legacy.path);
    try {
      if (JSON.parse(created?.payload_json ?? "{}").mode === "planned" && operation) return row;
    } catch { /* malformed legacy provenance is not ownership evidence */ }
    return undefined;
  }

export function worktree(store: StateStore, ops: GitOperations, runId: string, worktreeId: string): any {
    return resolveMergeTaskWorktree(store, runId, worktreeId);
  }

export function plannedIntegrationWorktree(store: StateStore, ops: GitOperations, runId: string, worktreeId: string): any {
    return resolveMergeIntegrationWorktree(store, runId, worktreeId);
  }

export function worktreeForCommit(store: StateStore, ops: GitOperations, runId: string, worktreeId: string): any {
    try { return ops.worktree!(store, ops, runId, worktreeId); }
    catch (error) {
      const run = store.getRun(runId) as any;
      if (!isPlannedRun(run)) throw error;
      return ops.plannedIntegrationWorktree!(store, ops, runId, worktreeId);
    }
  }
