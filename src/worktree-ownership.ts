import { join } from "node:path";
import { ValidationError } from "./errors.js";
import { StateStore } from "./state.js";

export interface OwnedWorktree {
  worktree_id: string;
  run_id: string;
  branch: string;
  path: string;
  base_commit: string;
  state: string;
}

const context = (store: StateStore, runId: string): { run: any; root: string } => {
  const run = store.getRun(runId) as any;
  const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
  if (!repository) throw new ValidationError("run repository is not registered");
  return { run, root: repository.project_path };
};

const rowFor = (store: StateStore, worktreeId: string): OwnedWorktree | undefined =>
  store.db.prepare("SELECT worktree_id,run_id,branch,path,base_commit,state FROM worktrees WHERE worktree_id=?")
    .get(worktreeId) as OwnedWorktree | undefined;

export const resolveTaskIdentityWorktree = (store: StateStore, runId: string, taskId: string): OwnedWorktree => {
  const { run } = context(store, runId);
  if (run.mode !== "planned" || !run.plan_id || !run.revision || !/^TASK-\d{3}$/.test(taskId)) {
    throw new ValidationError(`task identity ${taskId} cannot be resolved for run ${runId}`);
  }
  const branch = `task/${run.plan_id}/${run.plan_id}-${run.revision}--${taskId.toLowerCase()}`;
  const row = store.db.prepare(`SELECT w.worktree_id,w.run_id,w.branch,w.path,w.base_commit,w.state
    FROM worktrees w JOIN runs r ON r.run_id=w.run_id
    WHERE w.branch=? AND w.state='active' AND r.repo_id=?`)
    .get(branch, run.repo_id) as OwnedWorktree | undefined;
  if (!row) throw new ValidationError(`task identity ${taskId} has no active worktree record for run ${runId}`);
  return row;
};

const ownershipError = (worktreeId: string, runId: string, row: OwnedWorktree | undefined, constraint: string): ValidationError =>
  new ValidationError(
    `worktree ${worktreeId} is not consumable by run ${runId}: constraint=${constraint}; expected_run_id=${runId}; actual_run_id=${row?.run_id ?? "not_found"}`,
  );

export const resolveMergeTaskWorktree = (store: StateStore, runId: string, worktreeId: string): OwnedWorktree => {
  const { run } = context(store, runId);
  const row = rowFor(store, worktreeId);
  if (!row) throw ownershipError(worktreeId, runId, row, "worktree_exists");
  if (row.state !== "active") throw ownershipError(worktreeId, runId, row, "state=active");
  if (row.run_id !== runId) throw ownershipError(worktreeId, runId, row, "run_id=expected_run_id");
  if (run.mode === "planned" && run.plan_id && run.revision) {
    const prefix = `task/${run.plan_id}/${run.plan_id}-${run.revision}--`;
    if (!row.branch.startsWith(prefix)) throw ownershipError(worktreeId, runId, row, `branch_starts_with=${prefix}`);
  }
  return row;
};

export const resolveMergeIntegrationWorktree = (store: StateStore, runId: string, worktreeId: string): OwnedWorktree => {
  const { run, root } = context(store, runId);
  if (run.mode !== "planned" || !run.plan_id || !run.revision) return resolveMergeTaskWorktree(store, runId, worktreeId);
  const row = rowFor(store, worktreeId);
  if (!row) throw ownershipError(worktreeId, runId, row, "worktree_exists");
  if (row.state !== "active") throw ownershipError(worktreeId, runId, row, "state=active");
  const planRevision = `${run.plan_id}-${run.revision}`;
  const expectedBranch = `plan/${run.plan_id}/${planRevision}`;
  const expectedPath = join(root, ".worktrees", "plans", run.plan_id, planRevision);
  if (row.branch !== expectedBranch) throw ownershipError(worktreeId, runId, row, `branch=${expectedBranch}`);
  if (row.path !== expectedPath) throw ownershipError(worktreeId, runId, row, `path=${expectedPath}`);
  return row;
};

export const resolveTransferredWorktree = (store: StateStore, runId: string, worktreeId: string): OwnedWorktree => {
  const { run, root } = context(store, runId);
  const row = rowFor(store, worktreeId);
  if (run.mode === "planned" && run.plan_id && run.revision && row) {
    const planRevision = `${run.plan_id}-${run.revision}`;
    if (row.branch === `plan/${run.plan_id}/${planRevision}`
      && row.path === join(root, ".worktrees", "plans", run.plan_id, planRevision)) {
      return resolveMergeIntegrationWorktree(store, runId, worktreeId);
    }
  }
  return resolveMergeTaskWorktree(store, runId, worktreeId);
};

export interface MergeOwnershipPartialEffect {
  operation_ids: string[];
  fact: string;
}

export const completedMergeOwnershipPartialEffect = (
  store: StateStore,
  runId: string,
  integrationWorktreeId: string,
  taskWorktreeIds: string[],
): MergeOwnershipPartialEffect | undefined => {
  let integration: OwnedWorktree;
  let tasks: OwnedWorktree[];
  try {
    integration = resolveMergeIntegrationWorktree(store, runId, integrationWorktreeId);
    tasks = taskWorktreeIds.map((id) => resolveMergeTaskWorktree(store, runId, id));
  } catch {
    return undefined;
  }
  const mergeRows = store.db.prepare("SELECT state,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task'")
    .all(runId) as Array<{ state: string; request_json: string; evidence_json?: string }>;
  const mergeExists = mergeRows.some((operation) => {
    const request = JSON.parse(operation.request_json ?? "{}");
    const evidence = JSON.parse(operation.evidence_json ?? "{}");
    return (request.integration_worktree_id === integrationWorktreeId && taskWorktreeIds.includes(request.task_worktree_id))
      || (evidence.integration_worktree_id === integrationWorktreeId && taskWorktreeIds.includes(evidence.task_worktree_id))
      || (request.integration === integration.branch && tasks.some((task) => task.branch === request.task));
  });
  if (mergeExists) return undefined;
  const ownershipRows = store.db.prepare(`SELECT operation_id,request_json,evidence_json FROM operations
    WHERE run_id=? AND state='completed' AND kind IN ('git.worktree.transfer','git.worktree.adopt') ORDER BY created_at`)
    .all(runId) as Array<{ operation_id: string; request_json: string; evidence_json?: string }>;
  const expectedIds = new Set([integrationWorktreeId, ...taskWorktreeIds]);
  const matched = ownershipRows.filter((operation) => {
    const request = JSON.parse(operation.request_json ?? "{}");
    const evidence = JSON.parse(operation.evidence_json ?? "{}");
    return expectedIds.has(request.worktree_id) || expectedIds.has(evidence.worktree_id);
  });
  return {
    operation_ids: matched.map(({ operation_id }) => operation_id),
    fact: `managed worktree bindings and ownership are ready for run ${runId}; merge not started for integration ${integrationWorktreeId} and tasks ${taskWorktreeIds.join(",")}`,
  };
};
