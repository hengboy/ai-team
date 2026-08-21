import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ValidationError } from "./errors.js";
import { applyAuthorityCommitPreservingDirtyWork, applyAuthorityPaths, attachWorktree, AuthorityApplyConflictError, commitPaths, createWorktree, currentBranch, currentHead, git, mergeNoFastForward, worktreeStatus } from "./git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "./security.js";
import { StateStore } from "./state.js";
import { sha256, stableJson, toPosix } from "./utils.js";
import { ScopeGate } from "./gates.js";
import { DispatchService } from "./dispatch.js";
import {
  completedMergeOwnershipPartialEffect,
  resolveMergeIntegrationWorktree,
  resolveMergeTaskWorktree,
  resolveTransferredWorktree,
} from "./worktree-ownership.js";

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

interface AuthorityApplyConflictEvidence {
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

interface TaskMergeRequest {
  integration: string;
  task: string;
  integration_worktree_id: string;
  task_id: string;
  task_worktree_id: string;
  task_commit: string;
  integration_head_before: string;
}

const safeSegment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new ValidationError(`unsafe Git name segment: ${value}`);
  return value;
};

const isPlannedRun = (run: any): boolean => run.mode === "planned" && typeof run.plan_id === "string" && typeof run.revision === "string";

const worktreeNames = (root: string, run: any, runId: string, taskId?: string): { branch: string; path: string } => {
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

const legacyIntegrationNames = (root: string, run: any, runId: string): { branch: string; path: string } => {
  const plan = safeSegment(run.plan_id);
  const short = safeSegment(runId.slice(-8).toLowerCase());
  return { branch: `integration/${plan}/${short}`, path: join(root, ".worktrees", "integration", plan, short) };
};

export class GitOrchestrator {
  constructor(readonly store: StateStore) {}

  /** Every mutating operation can be tied to the claimed git-operator dispatch.
   * The optional argument preserves the programmatic API used by older
   * integrations; CLI callers should always provide it. */
  private assertGitOperator(runId: string, dispatchId?: string, operation?: "apply-task-authority" | "reconcile-task-authority-conflict" | "continue-task-authority-conflict" | "cleanup-integrated-task"): void {
    if (!dispatchId) return;
    new DispatchService(this.store).assertClaimed(runId, dispatchId, "git-operator");
    const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
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

  private repositoryForRun(runId: string): { root: string; run: any } {
    const run = this.store.getRun(runId) as any;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    return { root: repository.project_path, run };
  }

  private activeIntegrationWorktree(runId: string, root: string, run: any): any | undefined {
    if (!isPlannedRun(run)) {
      return this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as any;
    }
    const expected = worktreeNames(root, run, runId);
    const exact = this.store.db.prepare("SELECT * FROM worktrees WHERE branch=? AND path=? AND state='active'")
      .get(expected.branch, expected.path) as any;
    if (exact) return exact;

    const legacy = legacyIntegrationNames(root, run, runId);
    const row = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND path=? AND state='active'")
      .get(runId, legacy.branch, legacy.path) as any;
    if (!row) return undefined;
    const created = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.created' ORDER BY event_id LIMIT 1")
      .get(runId) as { payload_json: string } | undefined;
    const operation = this.store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.integration.create' AND state='completed'
      AND json_extract(request_json,'$.branch')=? AND json_extract(request_json,'$.path')=?`).get(runId, legacy.branch, legacy.path);
    try {
      if (JSON.parse(created?.payload_json ?? "{}").mode === "planned" && operation) return row;
    } catch { /* malformed legacy provenance is not ownership evidence */ }
    return undefined;
  }

  async prepareTask(runId: string, taskId?: string, baseCommit?: string, dependsOn?: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).assertPassed(runId, "pre_write");
    const worktreeTaskId = isPlannedRun(run) ? taskId : taskId ?? "implementation";
    const { branch, path } = worktreeNames(root, run, runId, worktreeTaskId);
    const integration = isPlannedRun(run) ? this.activeIntegrationWorktree(runId, root, run) : undefined;
    if (isPlannedRun(run) && !integration) throw new ValidationError("planned Task requires an active plan worktree");
    const integrationHead = integration ? await currentHead(integration.path) : undefined;
    if (integrationHead && baseCommit && baseCommit !== integrationHead) throw new ValidationError("planned Task base must equal the current plan worktree HEAD");
    if (isPlannedRun(run) && taskId === undefined) {
      return { worktree_id: integration!.worktree_id, branch: integration!.branch, path: integration!.path, base_commit: integration!.base_commit, reused: true };
    }
    if (isPlannedRun(run) && integration && taskId !== undefined) {
      const taskDirectory = join(integration.path, ".ai-team", "plans", run.plan_id, "revisions", run.revision, "tasks");
      let taskIds: string[] = [];
      try {
        taskIds = (await readdir(taskDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^TASK-\d{3}\.md$/.test(entry.name))
          .map((entry) => entry.name.slice(0, -3).toLowerCase())
          .sort();
      } catch { /* no explicit task split */ }
      if (taskIds.length <= 1) throw new ValidationError("planned revision with zero or one explicit TASK uses its plan worktree directly");
      if (!taskIds.includes(taskId.toLowerCase())) throw new ValidationError(`unknown explicit planned Task: ${taskId}`);
    }
    let base = integrationHead ?? baseCommit ?? run.base_commit;
    if (dependsOn) {
      const integrationWorktree = integration ?? this.activeIntegrationWorktree(runId, root, run);
      if (!integrationWorktree) throw new ValidationError("dependent Task requires an active integration worktree");
      const dependency = this.store.db.prepare("SELECT state FROM worktrees WHERE run_id=? AND worktree_id=?")
        .get(runId, dependsOn) as { state: string } | undefined;
      if (!dependency) throw new ValidationError("dependent Task worktree is not owned by this run");
      if (dependency.state === "active") this.worktree(runId, dependsOn);
      else {
        const merged = this.store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
          AND json_extract(evidence_json,'$.task_worktree_id')=? LIMIT 1`).get(runId, dependsOn);
        if (!merged) throw new ValidationError("dependent Task requires a completed predecessor merge");
      }
      base = await currentHead(integrationWorktree.path);
    }
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ValidationError("worktree base must be a 40-character commit SHA");
    const key = `worktree:create:${runId}:${branch}:${base}`;
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND state='active'").get(runId, branch) as any;
    if (existing) {
      if (existing.base_commit !== base || dispatchId) {
        if (!dispatchId) throw new ValidationError("stale planned Task worktree requires its managed replacement dispatch");
        const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
          .get(runId, dispatchId) as { packet_json: string };
        const context = (JSON.parse(dispatch.packet_json) as { context?: Record<string, unknown> }).context ?? {};
        const reuseTaskBranch = context.reuse_task_branch === true;
        if (!reuseTaskBranch && existing.base_commit === base) {
          const operation = this.store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
          if (operation.state !== "completed") throw new ValidationError("worktree operation has unknown side effect; reconcile required");
          return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
        }
        if (context.phase !== "prepare_implementation_worktree" || context.task_id !== taskId
          || context.replace_worktree_id !== existing.worktree_id || context.base_commit !== base) {
          throw new ValidationError("stale planned Task worktree replacement is not authorized by the frozen dispatch");
        }
        if (!(await worktreeStatus(existing.path)).clean) {
          throw new ValidationError("stale planned Task worktree has implementation changes and cannot be replaced");
        }
        if (!reuseTaskBranch) {
          if (await currentHead(existing.path) !== existing.base_commit) {
            throw new ValidationError("stale planned Task worktree has implementation changes and cannot be replaced");
          }
          const replacement = this.store.beginOperation("git.worktree.replace", `worktree:replace:${runId}:${branch}:${existing.base_commit}:${base}`, {
            worktree_id: existing.worktree_id, branch, path, stale_base: existing.base_commit, base, dispatch_id: dispatchId,
          }, runId);
          if (replacement.reused) {
            if (replacement.state !== "completed") throw new ValidationError("worktree replacement has unknown side effect; reconcile required");
            return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
          }
          await git(root, ["worktree", "remove", existing.path]);
          await git(root, ["branch", "-d", existing.branch]);
          await createWorktree(root, path, branch, base);
          this.store.db.prepare("UPDATE worktrees SET path=?,base_commit=?,state='active',created_at=? WHERE worktree_id=?")
            .run(path, base, new Date().toISOString(), existing.worktree_id);
          this.store.finishOperation(replacement.operationId, { worktree_id: existing.worktree_id, branch, path, base, replaced: true, head: await currentHead(path) });
          return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: false };
        }
        if (existing.base_commit !== base) throw new ValidationError("task retry requires the original integration base");
        const retry = (this.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as { count: number }).count;
        const retryPath = `${path}--retry-${retry}`;
        const replacementWorktreeId = `worktree_${sha256(`${runId}:${branch}:retry:${retry}`).slice(0, 24)}`;
        const replacement = this.store.beginOperation("git.worktree.replace", `worktree:replace:${runId}:${existing.worktree_id}:${base}:retry:${retry}`, {
          worktree_id: existing.worktree_id,
          replacement_worktree_id: replacementWorktreeId,
          branch,
          path: retryPath,
          stale_base: existing.base_commit,
          base,
          dispatch_id: dispatchId,
        }, runId);
        if (replacement.reused) {
          if (replacement.state !== "completed") throw new ValidationError("worktree replacement has unknown side effect; reconcile required");
          const replaced = this.worktree(runId, replacementWorktreeId);
          return { worktree_id: replaced.worktree_id, branch: replaced.branch, path: replaced.path, base_commit: replaced.base_commit, reused: true };
        }
        await git(root, ["worktree", "remove", existing.path]);
        await mkdir(dirname(retryPath), { recursive: true });
        await attachWorktree(root, retryPath, existing.branch);
        const head = await currentHead(retryPath);
        const now = new Date().toISOString();
        this.store.db.transaction(() => {
          this.store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(existing.worktree_id);
          this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
            .run(replacementWorktreeId, runId, existing.branch, retryPath, existing.base_commit, now);
          if (isPlannedRun(run)) {
            this.store.db.prepare("UPDATE run_tasks SET worktree_id=?,updated_at=? WHERE run_id=? AND worktree_id=? AND state!='integrated'")
              .run(replacementWorktreeId, now, runId, existing.worktree_id);
          }
          this.store.finishOperation(replacement.operationId, {
            worktree_id: existing.worktree_id,
            replacement_worktree_id: replacementWorktreeId,
            branch,
            path: retryPath,
            base: existing.base_commit,
            requested_base: base,
            replaced: true,
            head,
          });
        })();
        return { worktree_id: replacementWorktreeId, branch, path: retryPath, base_commit: existing.base_commit, reused: false };
      }
      const operation = this.store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
      if (operation.state !== "completed" || !existing) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE state='active' AND (branch=? OR path=?)").get(branch, path) as any;
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

  async adopt(runId: string, path: string, branch: string, baseCommit: string, commit?: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const canonical = await realpath(path);
    const relativePath = toPosix(relative(root, canonical));
    if (!relativePath.startsWith(".worktrees/")) throw new ValidationError(`refusing to adopt worktree outside managed root: ${canonical}`);
    if (!(await worktreeStatus(canonical)).clean) throw new ValidationError("only a clean worktree can be adopted");
    const actualBranch = await currentBranch(canonical);
    if (actualBranch !== branch) throw new ValidationError("adopted worktree branch does not match", { expected: branch, actual: actualBranch });
    const head = await currentHead(canonical);
    if (commit && head !== commit) throw new ValidationError("adopted commit must equal worktree HEAD", { expected: commit, actual: head });
    if (!/^[a-f0-9]{40}$/.test(baseCommit) || !/^[a-f0-9]{40}$/.test(head)) throw new ValidationError("adopt requires full base and HEAD commit SHAs");
    if (commit) {
      const revision = (await git(root, ["rev-list", "--parents", "-n", "1", head])).stdout.split(" ");
      if (revision.length !== 2 || revision[1] !== baseCommit) throw new ValidationError("managed adopt requires an existing direct-child commit of base-commit");
    } else if (head !== baseCommit) {
      throw new ValidationError("clean worktree adoption without --commit requires HEAD to equal base-commit");
    }
    if (isPlannedRun(run)) {
      const taskPrefix = `task/${run.plan_id}/${run.plan_id}-${run.revision}--`;
      if (!commit || !branch.startsWith(taskPrefix)) throw new ValidationError("planned adoption accepts only an existing task commit");
      const expected = worktreeNames(root, run, runId);
      const integration = this.store.db.prepare("SELECT * FROM worktrees WHERE branch=? AND path=? AND state='active'")
        .get(expected.branch, expected.path) as any;
      if (!integration || await currentHead(integration.path) !== baseCommit) {
        throw new ValidationError("adopted task base does not match the current plan worktree HEAD");
      }
    } else if (run.base_commit && run.base_commit !== baseCommit) {
      throw new ValidationError("adopted base commit does not match run base commit");
    }
    if (dispatchId) {
      const packetRow = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
        .get(runId, dispatchId) as { packet_json: string };
      const context = (JSON.parse(packetRow.packet_json) as { context?: Record<string, unknown> }).context ?? {};
      if (context.phase === "reconcile_worktree_ownership") {
        const tasks = Array.isArray(context.task_worktrees) ? context.task_worktrees as Array<Record<string, unknown>> : [];
        const authorized = tasks.some((task) => task.path === canonical && task.branch === branch && task.base_commit === baseCommit && task.commit === head);
        if (!authorized) throw new ValidationError("ownership reconciliation may adopt only its listed task worktree");
      }
    }
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE path=? OR branch=? ORDER BY created_at DESC LIMIT 1").get(canonical, branch) as any;
    if (existing?.state === "active") {
      if (existing.run_id === runId) {
        resolveMergeTaskWorktree(this.store, runId, existing.worktree_id);
        return { worktree_id: existing.worktree_id, branch, path: canonical, base_commit: baseCommit, reused: true };
      }
      const sourceRun = this.store.getRun(existing.run_id) as { repo_id: string };
      if (!isPlannedRun(run) || sourceRun.repo_id !== run.repo_id) throw new ValidationError(`worktree belongs to another run; use git transfer: ${existing.run_id}`);
      const key = `worktree:adopt:${runId}:${canonical}:${branch}:${head}`;
      const operation = this.store.beginOperation("git.worktree.adopt", key, { path: canonical, branch, base: baseCommit, commit: head }, runId);
      if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
      if (!operation.reused) {
        this.store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=?")
          .run(runId, existing.run_id, existing.worktree_id, existing.run_id);
        this.store.finishOperation(operation.operationId, { worktree_id: existing.worktree_id, head, adopted: true, implementation_revision: head, adopted_from_run_id: existing.run_id });
        this.store.event(runId, "worktree.adopted", { worktreeId: existing.worktree_id, path: canonical, branch, baseCommit, head, implementation_revision: head, adopted_from_run_id: existing.run_id });
      }
      resolveMergeTaskWorktree(this.store, runId, existing.worktree_id);
      return { worktree_id: existing.worktree_id, branch, path: canonical, base_commit: baseCommit, reused: operation.reused };
    }
    const key = `worktree:adopt:${runId}:${canonical}:${branch}:${head}`;
    const operation = this.store.beginOperation("git.worktree.adopt", key, { path: canonical, branch, base: baseCommit, commit: head }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
    const worktreeId = `worktree_${sha256(`${runId}:${branch}:${canonical}`).slice(0, 24)}`;
    if (!operation.reused) {
      this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, branch, canonical, baseCommit, new Date().toISOString());
      this.store.finishOperation(operation.operationId, { worktree_id: worktreeId, head, adopted: true, implementation_revision: commit ?? null });
      this.store.event(runId, "worktree.adopted", { worktreeId, path: canonical, branch, baseCommit, head, implementation_revision: commit ?? null });
    }
    resolveMergeTaskWorktree(this.store, runId, worktreeId);
    return { worktree_id: worktreeId, branch, path: canonical, base_commit: baseCommit, reused: operation.reused };
  }

  async adoptCommit(runId: string, commit: string, taskId = "implementation", dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const integration = isPlannedRun(run) ? this.activeIntegrationWorktree(runId, root, run) : undefined;
    if (isPlannedRun(run) && !integration) throw new ValidationError("planned Task requires an active plan worktree");
    const base = integration ? await currentHead(integration.path) : run.base_commit as string;
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(commit)) throw new ValidationError("managed commit adoption requires full base and commit SHAs");
    const revision = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).stdout.split(" ");
    if (revision.length !== 2 || revision[1] !== base) throw new ValidationError("managed adopt requires an existing direct-child commit of the task base");
    const { branch, path } = worktreeNames(root, run, runId, taskId);
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND state='active'").get(runId, branch) as any;
    if (existing) {
      if (await currentHead(existing.path) !== commit) throw new ValidationError("existing adopted worktree does not match requested commit");
      return { worktree_id: existing.worktree_id, branch, path: existing.path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE (branch=? OR path=?) AND state='active'").get(branch, path) as { run_id: string } | undefined;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    const key = `worktree:adopt-commit:${runId}:${branch}:${commit}`;
    const operation = this.store.beginOperation("git.worktree.adopt", key, { branch, path, base, commit }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
    if (!operation.reused) {
      await mkdir(dirname(path), { recursive: true });
      await createWorktree(root, path, branch, commit);
      const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
      this.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, branch, path, base, new Date().toISOString());
      this.store.finishOperation(operation.operationId, { worktree_id: worktreeId, head: commit, adopted: true, implementation_revision: commit });
      this.store.event(runId, "worktree.commit_adopted", { worktreeId, path, branch, baseCommit: base, implementation_revision: commit });
      return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
    }
    const adopted = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    return { worktree_id: adopted.worktree_id, branch, path: adopted.path, base_commit: base, reused: true };
  }

  async transfer(runId: string, worktreeId: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const row = this.store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND state='active'").get(worktreeId) as any;
    if (!row) throw new ValidationError("active worktree to transfer was not found");
    if (row.run_id === runId) {
      resolveTransferredWorktree(this.store, runId, worktreeId);
      return { worktree_id: row.worktree_id, branch: row.branch, path: row.path, base_commit: row.base_commit, reused: true };
    }
    const sourceRun = this.store.getRun(row.run_id) as { repo_id: string };
    if (sourceRun.repo_id !== run.repo_id) throw new ValidationError("worktree transfer requires runs from the same repository");
    const canonical = await realpath(row.path);
    const relativePath = toPosix(relative(root, canonical));
    if (!relativePath.startsWith(".worktrees/") || !(await worktreeStatus(canonical)).clean) throw new ValidationError("only a clean managed worktree can be transferred");
    const key = `worktree:transfer:${row.run_id}:${runId}:${worktreeId}`;
    const operation = this.store.beginOperation("git.worktree.transfer", key, { worktree_id: worktreeId, from_run_id: row.run_id, to_run_id: runId }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("transfer operation has unknown side effect; reconcile required");
    if (!operation.reused) {
      this.store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=?")
        .run(runId, row.run_id, worktreeId, row.run_id);
      this.store.finishOperation(operation.operationId, { worktree_id: worktreeId, path: canonical, branch: row.branch, from_run_id: row.run_id, to_run_id: runId });
      this.store.event(runId, "worktree.transferred", { worktreeId, fromRunId: row.run_id, path: canonical, branch: row.branch });
    }
    resolveTransferredWorktree(this.store, runId, worktreeId);
    return { worktree_id: worktreeId, branch: row.branch, path: canonical, base_commit: row.base_commit, reused: operation.reused };
  }

  async recoverTaskWorktree(request: TaskWorktreeRecoveryRequest): Promise<TaskWorktreeRecoveryReceipt> {
    const target = this.repositoryForRun(request.toRunId);
    if (!isPlannedRun(target.run) || target.run.plan_id !== request.toPlanId || target.run.revision !== request.toRevision) {
      throw new ValidationError("target run does not match the requested planned revision");
    }
    if (request.fromPlanId !== request.toPlanId) throw new ValidationError("task worktree recovery requires the same plan");
    if (!/^[a-f0-9]{40}$/.test(request.expectedHead)) throw new ValidationError("expected HEAD must be a full commit SHA");
    if (await realpath(request.project) !== await realpath(target.root)) throw new ValidationError("recovery project does not match the target run repository");

    const key = `worktree:recover:${request.fromPlanId}:${request.fromRevision}:${request.toRevision}:${request.toRunId}:${request.taskId}:${request.worktreeId}:${request.expectedHead}:${request.expectedSourceArtifact}:${request.replacesStagingId ?? "none"}`;
    const completed = this.store.db.prepare("SELECT operation_id,evidence_json FROM operations WHERE idempotency_key=? AND kind='git.worktree.recover' AND state='completed'")
      .get(key) as { operation_id: string; evidence_json: string } | undefined;
    if (completed) return { ...(JSON.parse(completed.evidence_json) as TaskWorktreeRecoveryReceipt), reused: true };

    const sourceRevision = this.store.db.prepare("SELECT state,digest,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(target.run.repo_id, request.fromPlanId, request.fromRevision) as { state: string; digest?: string; plan_commit?: string } | undefined;
    const targetRevision = this.store.db.prepare("SELECT state,digest,plan_commit,supersedes FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(target.run.repo_id, request.toPlanId, request.toRevision) as { state: string; digest?: string; plan_commit?: string; supersedes?: string } | undefined;
    if (!sourceRevision || !targetRevision || targetRevision.supersedes !== request.fromRevision) {
      throw new ValidationError("target revision must directly supersede the source revision in the same repository");
    }
    if (targetRevision.state !== "ready") throw new ValidationError("target superseding revision is not plan-ready");
    if (!targetRevision.digest || target.run.plan_digest !== targetRevision.digest) throw new ValidationError("target run plan digest does not match the superseding revision");

    const row = this.store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND state='active'").get(request.worktreeId) as any;
    if (!row) throw new ValidationError("active managed task worktree was not found");
    const sourceRun = this.store.getRun(row.run_id) as any;
    if (!isPlannedRun(sourceRun) || sourceRun.repo_id !== target.run.repo_id || sourceRun.plan_id !== request.fromPlanId || sourceRun.revision !== request.fromRevision) {
      throw new ValidationError("worktree owner does not match the requested source revision");
    }
    const sourceTask = this.store.db.prepare("SELECT * FROM run_tasks WHERE run_id=? AND task_id=?").get(row.run_id, request.taskId) as any;
    const targetTask = this.store.db.prepare("SELECT * FROM run_tasks WHERE run_id=? AND task_id=?").get(request.toRunId, request.taskId) as any;
    if (!sourceTask || !targetTask) throw new ValidationError("task ID must exist in both source and target revisions");
    const completedMerge = this.store.db.prepare(`SELECT 1 FROM operations WHERE kind='git.merge.task' AND state='completed'
      AND (run_id=? OR run_id=?) AND (json_extract(request_json,'$.task_worktree_id')=? OR json_extract(evidence_json,'$.task_worktree_id')=?) LIMIT 1`)
      .get(row.run_id, request.toRunId, request.worktreeId, request.worktreeId);
    if (completedMerge || sourceTask.state === "integrated" || targetTask.state === "integrated") {
      throw new ValidationError("integrated task worktree cannot be transferred across runs");
    }
    if (sourceTask.worktree_id !== request.worktreeId) throw new ValidationError("source task is not bound to the requested worktree");
    if (targetTask.worktree_id && targetTask.worktree_id !== request.worktreeId) throw new ValidationError("target task is already bound to another worktree");
    const sourceScopes = JSON.parse(sourceTask.write_paths_json ?? "[]") as string[];
    const targetScopes = JSON.parse(targetTask.write_paths_json ?? "[]") as string[];
    if (sourceScopes.some((scope) => !targetScopes.includes(scope))) throw new ValidationError("target task scope must equal or extend the source task scope");

    const canonical = await realpath(row.path);
    const relativePath = toPosix(relative(target.root, canonical));
    if (!relativePath.startsWith(".worktrees/")) throw new ValidationError("recovery requires an existing managed worktree path");
    const head = await currentHead(canonical);
    if (head !== request.expectedHead) throw new ValidationError("worktree HEAD does not match expected HEAD", { expected: request.expectedHead, actual: head });
    const branch = await currentBranch(canonical);
    if (branch !== row.branch) throw new ValidationError("worktree branch does not match its managed registration");
    const statusEntries = (await git(canonical, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean);
    const dirty = new Set<string>();
    for (let index = 0; index < statusEntries.length; index += 1) {
      const entry = statusEntries[index]!;
      const code = entry.slice(0, 2);
      dirty.add(entry.slice(3));
      if (/[RC]/.test(code)) dirty.add(statusEntries[++index]!);
    }
    const dirtyPaths = [...dirty].sort();
    for (const path of dirtyPaths) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, targetScopes)) throw new ValidationError(`dirty path is outside target task scope: ${path}`);
      await canonicalizeInside(canonical, path, true);
    }

    const replacementStaging = request.replacesStagingId
      ? this.store.db.prepare(`SELECT s.staging_id,s.run_id,s.dispatch_id,s.role,s.kind,s.state,s.content_sha256,d.role AS dispatch_role,d.state AS dispatch_state,d.packet_json
        FROM staging_entries s JOIN dispatches d ON d.dispatch_id=s.dispatch_id AND d.run_id=s.run_id WHERE s.staging_id=?`)
        .get(request.replacesStagingId) as any
      : undefined;
    let recoveryDispatchId = request.dispatchId;
    if (request.replacesStagingId) {
      if (!replacementStaging || replacementStaging.run_id !== request.toRunId || replacementStaging.role !== "git-operator"
        || replacementStaging.kind !== "dispatch-result" || replacementStaging.state !== "ready" || !replacementStaging.content_sha256
        || replacementStaging.dispatch_role !== "git-operator" || replacementStaging.dispatch_state !== "claimed") {
        throw new ValidationError("replacement staging is not a ready claimed Git Operator dispatch result for the target run");
      }
      const context = (JSON.parse(replacementStaging.packet_json) as { context?: Record<string, unknown> }).context ?? {};
      if (context.phase !== "recover_implementation_worktree" || context.task_id !== request.taskId
        || context.source_worktree_id !== request.worktreeId || context.source_run_id !== row.run_id) {
        throw new ValidationError("replacement staging does not match the legacy task worktree recovery lineage");
      }
      if (request.dispatchId && request.dispatchId !== replacementStaging.dispatch_id) {
        throw new ValidationError("replacement staging dispatch does not match --dispatch-id");
      }
      recoveryDispatchId = replacementStaging.dispatch_id;
    }
    if (recoveryDispatchId) {
      new DispatchService(this.store).assertClaimed(request.toRunId, recoveryDispatchId, "git-operator");
      const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=? AND run_id=?").get(recoveryDispatchId, request.toRunId) as { packet_json: string };
      const context = (JSON.parse(dispatch.packet_json) as { context?: Record<string, unknown> }).context ?? {};
      const legacyReplacement = Boolean(request.replacesStagingId) && context.phase === "recover_implementation_worktree"
        && context.source_worktree_id === request.worktreeId;
      if ((!legacyReplacement && !(["recover_task_worktree", "reconcile_worktree_ownership"] as unknown[]).includes(context.phase))
        || context.task_id !== request.taskId
        || (!legacyReplacement && ![context.worktree_id, context.task_worktree_id, context.implementation_worktree_id].includes(request.worktreeId))) {
        throw new ValidationError("Git Operator dispatch is not bound to this task worktree recovery");
      }
    }
    const activeHolder = this.store.db.prepare(`SELECT d.dispatch_id FROM dispatch_worktree_bindings b
      JOIN dispatches d ON d.dispatch_id=b.dispatch_id AND d.run_id=b.run_id
      WHERE b.worktree_id=? AND d.state='claimed' AND (? IS NULL OR d.dispatch_id!=?) LIMIT 1`)
      .get(request.worktreeId, recoveryDispatchId ?? null, recoveryDispatchId ?? null) as { dispatch_id: string } | undefined;
    if (activeHolder) throw new ValidationError("worktree is held by another active dispatch", { dispatch_id: activeHolder.dispatch_id });

    const artifacts = this.store.db.prepare(`SELECT a.artifact_id,a.sha256,a.dispatch_id,d.packet_json
      FROM artifacts a LEFT JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND a.kind='result' AND (a.artifact_id=? OR a.sha256=?)`).all(row.run_id, request.expectedSourceArtifact, request.expectedSourceArtifact) as Array<any>;
    const artifact = artifacts.find((candidate) => {
      const context = JSON.parse(candidate.packet_json ?? "{}").context ?? {};
      return context.task_id === request.taskId || candidate.dispatch_id === sourceTask.developer_dispatch_id || candidate.dispatch_id === sourceTask.test_dispatch_id;
    });
    if (!artifact) throw new ValidationError("expected source artifact does not match the source task lineage");

    const operationId = `op_${sha256(key).slice(0, 26)}`;
    const replacedStaging = replacementStaging ? {
      staging_id: replacementStaging.staging_id as string,
      dispatch_id: replacementStaging.dispatch_id as string,
      digest: replacementStaging.content_sha256 as string,
      before_state: "ready" as const,
      after_state: "canceled" as const,
      operation_id: operationId,
    } : undefined;
    const evidence: TaskWorktreeRecoveryReceipt = {
      recovery_id: operationId,
      worktree_id: request.worktreeId,
      path: canonical,
      branch,
      head,
      task_id: request.taskId,
      from_run_id: row.run_id,
      to_run_id: request.toRunId,
      source_artifact: { artifact_id: artifact.artifact_id, digest: artifact.sha256 },
      dirty_paths: dirtyPaths,
      ...(replacedStaging ? { replaced_staging: replacedStaging } : {}),
      reused: false,
    };
    const operationRequest = {
      ...request,
      source_run_id: row.run_id,
      source_plan_digest: sourceRevision.digest ?? null,
      target_plan_digest: targetRevision.digest,
      source_allowed_write_paths: sourceScopes,
      target_allowed_write_paths: targetScopes,
      dirty_paths: dirtyPaths,
      owner_before: row.run_id,
      owner_after: request.toRunId,
      source_artifact: evidence.source_artifact,
      ...(replacedStaging ? { replaced_staging: replacedStaging } : {}),
    };
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json,created_at,completed_at) VALUES (?,?,?,'git.worktree.recover','completed',?,?,?,?)")
        .run(operationId, request.toRunId, key, stableJson(operationRequest), stableJson(evidence), new Date().toISOString(), new Date().toISOString());
      const owner = this.store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=? AND state='active'")
        .run(request.toRunId, row.run_id, request.worktreeId, row.run_id);
      if (owner.changes !== 1) throw new ValidationError("worktree owner changed during recovery preflight");
      const task = this.store.db.prepare(`UPDATE run_tasks SET state=CASE state WHEN 'pending' THEN 'prepared' ELSE state END,worktree_id=?,updated_at=?
        WHERE run_id=? AND task_id=? AND (worktree_id IS NULL OR worktree_id=?)`)
        .run(request.worktreeId, new Date().toISOString(), request.toRunId, request.taskId, request.worktreeId);
      if (task.changes !== 1) throw new ValidationError("target task binding changed during recovery preflight");
      if (replacedStaging) {
        const staging = this.store.db.prepare(`UPDATE staging_entries SET state='canceled',replaced_by_operation_id=?,updated_at=?
          WHERE staging_id=? AND state='ready' AND dispatch_id=?`).run(operationId, new Date().toISOString(), replacedStaging.staging_id, replacedStaging.dispatch_id);
        if (staging.changes !== 1) throw new ValidationError("replacement staging changed during recovery preflight");
      }
      this.store.event(row.run_id, "worktree.recovery_released", { ...operationRequest, operation_id: operationId });
      this.store.event(request.toRunId, "worktree.recovered", { ...operationRequest, operation_id: operationId, receipt: evidence });
    })();
    return evidence;
  }

  async applyTaskAuthority(request: TaskAuthorityApplyRequest): Promise<TaskAuthorityApplyReceipt> {
    this.assertGitOperator(request.runId, request.dispatchId, "apply-task-authority");
    if (!/^[a-f0-9]{40}$/.test(request.authorityCommit) || !/^[a-f0-9]{40}$/.test(request.expectedHead)) {
      throw new ValidationError("task authority apply requires full authority and expected HEAD commit SHAs");
    }
    const { run } = this.repositoryForRun(request.runId);
    if (!isPlannedRun(run)) throw new ValidationError("task authority apply requires a planned Coding run");
    const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(request.runId, request.dispatchId) as { packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as { context: Record<string, unknown> }).context : undefined;
    if (!context || context.phase !== "apply_task_authority" || context.operation !== "apply-task-authority" || context.worktree_id !== request.worktreeId
      || context.authority_commit !== request.authorityCommit || context.expected_head !== request.expectedHead) {
      throw new ValidationError("Git Operator dispatch is not bound to this task authority recovery");
    }
    const row = this.store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(request.runId, request.worktreeId) as { path: string; state: string } | undefined;
    if (!row || row.state !== "active") throw new ValidationError("task authority apply requires its active frozen worktree");
    const key = `worktree:apply-authority:${request.runId}:${request.dispatchId}:${request.worktreeId}:${request.authorityCommit}:${request.expectedHead}`;
    const completed = this.store.db.prepare("SELECT evidence_json FROM operations WHERE idempotency_key=? AND kind='git.task_authority.apply' AND state='completed'")
      .get(key) as { evidence_json: string } | undefined;
    if (completed) return { ...(JSON.parse(completed.evidence_json) as TaskAuthorityApplyReceipt), reused: true };
    const head = await currentHead(row.path);
    if (head !== request.expectedHead) throw new ValidationError("task authority apply worktree HEAD does not match expected HEAD", { expected: request.expectedHead, actual: head });
    const status = await git(row.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirtyPaths = status.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
    if (!dirtyPaths.length) throw new ValidationError("task authority apply requires the recorded dirty task work");
    const allowed = Array.isArray(context.scope_recovery && (context.scope_recovery as Record<string, unknown>).allowed_write_paths)
      ? (context.scope_recovery as { allowed_write_paths: string[] }).allowed_write_paths
      : undefined;
    if (!allowed || dirtyPaths.some((path) => !pathMatchesScope(path, allowed))) {
      throw new ValidationError("task authority apply dirty work is outside the frozen replacement scope", { dirty_paths: dirtyPaths });
    }
    const authorityPaths = (await git(row.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", request.authorityCommit])).stdout.split("\n").filter(Boolean).sort();
    if (!authorityPaths.length || authorityPaths.some((path) => !pathMatchesScope(path, allowed))) {
      throw new ValidationError("task authority apply commit is outside the frozen replacement scope", { authority_paths: authorityPaths });
    }
    let operationKey = key;
    let operation: { operationId: string; reused: boolean; state: string };
    while (true) {
      operation = this.store.beginOperation("git.task_authority.apply", operationKey, { ...request, dirty_paths: dirtyPaths }, request.runId);
      if (!operation.reused) break;
      if (operation.state === "completed") {
        const completed = this.store.db.prepare("SELECT evidence_json FROM operations WHERE operation_id=?")
          .get(operation.operationId) as { evidence_json: string };
        return { ...(JSON.parse(completed.evidence_json) as TaskAuthorityApplyReceipt), reused: true };
      }
      const failed = operation.state === "failed"
        ? this.store.db.prepare("SELECT evidence_json FROM operations WHERE operation_id=?")
          .get(operation.operationId) as { evidence_json: string | null } | undefined
        : undefined;
      try {
        if (JSON.parse(failed?.evidence_json ?? "{}").reconciliation === "not_applied") {
          operationKey = `${operationKey}:retry:${operation.operationId}`;
          continue;
        }
      } catch { /* malformed reconciliation evidence is not retry authorization */ }
      throw new ValidationError("task authority apply has an unknown side effect; reconcile required");
    }
    let stashCommit: string;
    try {
      stashCommit = await applyAuthorityCommitPreservingDirtyWork(row.path, request.authorityCommit, `ai-team authority ${request.dispatchId}`);
    } catch (error) {
      if (error instanceof AuthorityApplyConflictError) {
        const evidence: AuthorityApplyConflictEvidence = {
          state: "conflicted",
          worktree_id: request.worktreeId,
          authority_commit: request.authorityCommit,
          expected_head: request.expectedHead,
          dirty_paths: dirtyPaths,
          authority_paths: authorityPaths,
          conflict_paths: error.conflictPaths,
          stash_commit: error.stashCommit,
        };
        this.store.recordPendingOperationEvidence(operation.operationId, evidence);
        this.store.event(request.runId, "worktree.task_authority_conflicted", { dispatch_id: request.dispatchId, operation_id: operation.operationId, ...evidence });
        new DispatchService(this.store).createAuthorityConflictContinuation({
          runId: request.runId,
          authorityDispatchId: request.dispatchId,
          operationId: operation.operationId,
          worktreeId: request.worktreeId,
          authorityCommit: request.authorityCommit,
          expectedHead: request.expectedHead,
          dirtyPaths,
          authorityPaths,
          conflictPaths: error.conflictPaths,
          stashCommit: error.stashCommit,
        });
      }
      throw error;
    }
    const receipt: TaskAuthorityApplyReceipt = {
      operation_id: operation.operationId,
      worktree_id: request.worktreeId,
      authority_commit: request.authorityCommit,
      head: await currentHead(row.path),
      dirty_paths: dirtyPaths,
      stash_commit: stashCommit,
      reused: false,
    };
    this.store.finishOperation(operation.operationId, receipt);
    this.store.event(request.runId, "worktree.task_authority_applied", receipt);
    return receipt;
  }

  async continueTaskAuthorityConflict(runId: string, dispatchId: string): Promise<TaskAuthorityApplyReceipt> {
    this.assertGitOperator(runId, dispatchId, "continue-task-authority-conflict");
    const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as { context: Record<string, unknown> }).context : undefined;
    const required = ["worktree_id", "authority_commit", "expected_head", "authority_apply_operation_id", "authority_apply_dispatch_id", "stash_commit"] as const;
    if (!context || context.phase !== "continue_task_authority_conflict" || context.operation !== "continue-task-authority-conflict"
      || required.some((key) => typeof context[key] !== "string" || !context[key])) {
      throw new ValidationError("Git Operator dispatch is not bound to an authority conflict continuation");
    }
    const worktreeId = context.worktree_id as string;
    const authorityCommit = context.authority_commit as string;
    const expectedHead = context.expected_head as string;
    const originalOperationId = context.authority_apply_operation_id as string;
    const originalDispatchId = context.authority_apply_dispatch_id as string;
    const stashCommit = context.stash_commit as string;
    const continuationKey = `authority-conflict-continue:${runId}:${originalOperationId}:${dispatchId}`;
    const existingContinuation = this.store.db.prepare("SELECT state,evidence_json FROM operations WHERE idempotency_key=? AND kind='git.task_authority.continue'")
      .get(continuationKey) as { state: string; evidence_json?: string } | undefined;
    if (existingContinuation) {
      if (existingContinuation.state !== "completed") throw new ValidationError("authority conflict continuation side effect is unknown; reconcile required");
      return { ...(JSON.parse(existingContinuation.evidence_json ?? "{}") as TaskAuthorityApplyReceipt), reused: true };
    }
    const operation = this.store.db.prepare("SELECT state,request_json,evidence_json FROM operations WHERE operation_id=? AND run_id=? AND kind='git.task_authority.apply'")
      .get(originalOperationId, runId) as { state: string; request_json: string; evidence_json?: string } | undefined;
    const evidence = JSON.parse(operation?.evidence_json ?? "{}") as Partial<AuthorityApplyConflictEvidence>;
    if (!operation || operation.state !== "pending" || evidence.state !== "conflicted" || evidence.worktree_id !== worktreeId
      || evidence.authority_commit !== authorityCommit || evidence.expected_head !== expectedHead || evidence.stash_commit !== stashCommit) {
      throw new ValidationError("authority conflict continuation evidence does not match its frozen packet");
    }
    const request = JSON.parse(operation.request_json) as TaskAuthorityApplyRequest & { dirty_paths?: unknown };
    const recordedDirtyPaths = Array.isArray(request.dirty_paths) && request.dirty_paths.every((path) => typeof path === "string") ? [...request.dirty_paths].sort() : [];
    const packetDirtyPaths = Array.isArray(context.dirty_paths) && context.dirty_paths.every((path) => typeof path === "string") ? [...context.dirty_paths].sort() : [];
    const authorityPaths = Array.isArray(context.authority_paths) && context.authority_paths.every((path) => typeof path === "string") ? [...context.authority_paths].sort() : [];
    if (request.dispatchId !== originalDispatchId || request.worktreeId !== worktreeId || request.authorityCommit !== authorityCommit || request.expectedHead !== expectedHead
      || stableJson(recordedDirtyPaths) !== stableJson(packetDirtyPaths) || stableJson(recordedDirtyPaths) !== stableJson([...(evidence.dirty_paths ?? [])].sort())
      || !authorityPaths.length || stableJson(authorityPaths) !== stableJson([...(evidence.authority_paths ?? [])].sort())) {
      throw new ValidationError("authority conflict continuation dirty-work lineage does not match its frozen packet");
    }
    const row = this.store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?").get(runId, worktreeId) as { path: string; state: string } | undefined;
    if (!row || row.state !== "active" || await currentHead(row.path) !== expectedHead) throw new ValidationError("authority conflict continuation worktree HEAD does not match expected HEAD");
    const unresolved = (await git(row.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    if (unresolved.length) throw new ValidationError("authority conflict continuation has unresolved paths", unresolved);
    await applyAuthorityPaths(row.path, authorityCommit, authorityPaths.filter((path) => !recordedDirtyPaths.includes(path)));
    const status = await git(row.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirtyPaths = status.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
    const requiredPaths = [...new Set([...recordedDirtyPaths, ...authorityPaths])].sort();
    if (requiredPaths.some((path) => !dirtyPaths.includes(path)) || dirtyPaths.some((path) => !requiredPaths.includes(path))) {
      throw new ValidationError("authority conflict continuation dirty work changed", { expected: requiredPaths, actual: dirtyPaths });
    }
    const allowed = Array.isArray(context.allowed_write_paths) && context.allowed_write_paths.every((path) => typeof path === "string") ? context.allowed_write_paths as string[] : [];
    if (!allowed.length || dirtyPaths.some((path) => !pathMatchesScope(path, allowed))) throw new ValidationError("authority conflict continuation dirty work is outside the frozen replacement scope", { dirty_paths: dirtyPaths });
    const continuation = this.store.beginOperation("git.task_authority.continue", continuationKey, {
      authority_apply_operation_id: originalOperationId, worktree_id: worktreeId, authority_commit: authorityCommit, expected_head: expectedHead, dirty_paths: dirtyPaths,
    }, runId);
    if (continuation.reused) {
      if (continuation.state !== "completed") throw new ValidationError("authority conflict continuation side effect is unknown; reconcile required");
      const completed = this.store.db.prepare("SELECT evidence_json FROM operations WHERE operation_id=?").get(continuation.operationId) as { evidence_json: string };
      return { ...(JSON.parse(completed.evidence_json) as TaskAuthorityApplyReceipt), reused: true };
    }
    const receipt: TaskAuthorityApplyReceipt = { operation_id: originalOperationId, worktree_id: worktreeId, authority_commit: authorityCommit, head: expectedHead, dirty_paths: dirtyPaths, stash_commit: stashCommit, reused: false };
    this.store.finishOperation(continuation.operationId, receipt);
    this.store.finishOperation(originalOperationId, { ...receipt, continued_by: continuation.operationId });
    this.store.event(runId, "worktree.task_authority_conflict_continued", { dispatch_id: dispatchId, ...receipt, continuation_operation_id: continuation.operationId });
    return receipt;
  }

  async prepareIntegration(runId: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const { branch, path } = worktreeNames(root, run, runId);
    const base = run.base_commit;
    const named = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    const existing = named ?? (isPlannedRun(run) ? this.activeIntegrationWorktree(runId, root, run) : undefined);
    const key = `integration:create:${runId}:${base}`;
    if (existing) {
      if (isPlannedRun(run) && existing.run_id !== runId) {
        if (existing.base_commit !== base) throw new ValidationError("planned plan worktree base does not match run base commit");
        return { worktree_id: existing.worktree_id, branch: existing.branch, path: existing.path, base_commit: base, reused: true };
      }
      const operation = this.store.beginOperation("git.integration.create", key, { branch: existing.branch, path: existing.path, base }, runId);
      if (operation.state !== "completed") throw new ValidationError("integration operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch: existing.branch, path: existing.path, base_commit: base, reused: true };
    }
    const collision = this.store.db.prepare("SELECT run_id FROM worktrees WHERE state='active' AND (branch=? OR path=?)").get(branch, path) as any;
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

  async status(runId: string): Promise<WorktreeStatus[]> {
    const rows = this.store.db.prepare("SELECT worktree_id,branch,path,base_commit,state FROM worktrees WHERE run_id=? ORDER BY created_at,worktree_id")
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

  private worktree(runId: string, worktreeId: string): any {
    return resolveMergeTaskWorktree(this.store, runId, worktreeId);
  }

  private plannedIntegrationWorktree(runId: string, worktreeId: string): any {
    return resolveMergeIntegrationWorktree(this.store, runId, worktreeId);
  }

  private worktreeForCommit(runId: string, worktreeId: string): any {
    try { return this.worktree(runId, worktreeId); }
    catch (error) {
      const run = this.store.getRun(runId) as any;
      if (!isPlannedRun(run)) throw error;
      return this.plannedIntegrationWorktree(runId, worktreeId);
    }
  }

  async commit(runId: string, worktreeId: string, message: string, allowedScopes: string[], dispatchId?: string): Promise<{ commit: string; paths: string[]; reused: boolean }> {
    this.assertGitOperator(runId, dispatchId);
    const worktree = this.worktreeForCommit(runId, worktreeId);
    const integratedTask = this.store.db.prepare("SELECT task_id FROM run_tasks WHERE run_id=? AND worktree_id=? AND state='integrated' ORDER BY ordinal LIMIT 1")
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
    if (dispatchId) {
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
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
    }
    for (const path of changed) {
      assertWritablePath(path);
      if (!pathMatchesScope(path, allowedScopes)) throw new ValidationError(`changed path is outside allowed scope: ${path}`);
      await canonicalizeInside(worktree.path, path, true);
    }
    const run = this.store.getRun(runId) as any;
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).check(runId, "pre_commit", allowedScopes);
    else if (run.mode === "planned") new ScopeGate(this.store).assertPreCommit(runId, changed, worktreeId);
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
    let taskWorktreeId = taskId;
    if (dispatchId) {
      taskWorktreeId = new DispatchService(this.store).assertMergeWorktreeBindings(runId, dispatchId, integrationId, taskId).task_worktree_id;
    }

    // A completed merge remains the durable fact after its task worktree is removed.
    const completed = this.store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
      AND json_extract(request_json,'$.integration_worktree_id')=? AND json_extract(request_json,'$.task_worktree_id')=?
      ORDER BY completed_at DESC LIMIT 1`).get(runId, integrationId, taskWorktreeId) as { evidence_json?: string } | undefined;
    if (completed) {
      const evidence = JSON.parse(completed.evidence_json ?? "{}") as { commit?: string };
      if (!evidence.commit) throw new ValidationError("completed task merge is missing its merge commit evidence");
      return evidence.commit;
    }
    const integration = this.plannedIntegrationWorktree(runId, integrationId);
    const task = this.worktree(runId, taskWorktreeId);
    const taskCommit = await currentHead(task.path);
    const integrationHeadBefore = await currentHead(integration.path);
    const run = this.store.getRun(runId) as any;
    const boundTask = run.mode === "planned"
      ? this.store.db.prepare("SELECT task_id FROM run_tasks WHERE run_id=? AND worktree_id=?").get(runId, taskWorktreeId) as { task_id: string } | undefined
      : undefined;
    const branchTaskId = task.branch.split("--").at(-1)?.toUpperCase();
    const logicalTaskId = run.mode === "planned" ? boundTask?.task_id ?? branchTaskId ?? taskId : "implementation";
    const request: TaskMergeRequest = {
      integration: integration.branch,
      task: task.branch,
      integration_worktree_id: integrationId,
      task_id: logicalTaskId,
      task_worktree_id: taskWorktreeId,
      task_commit: taskCommit,
      integration_head_before: integrationHeadBefore,
    };
    const operation = this.store.beginOperation("git.merge.task", `merge-task:${runId}:${integration.branch}:${task.branch}:${taskCommit}`, request, runId);
    if (operation.reused) {
      if (operation.state !== "pending") throw new ValidationError("merge side effect is unknown; reconcile required");
      const persisted = this.store.db.prepare("SELECT request_json FROM operations WHERE operation_id=? AND run_id=? AND kind='git.merge.task'")
        .get(operation.operationId, runId) as { request_json: string } | undefined;
      if (!persisted) throw new ValidationError("pending task merge is missing its recorded request");
      const recordedRequest = JSON.parse(persisted.request_json) as TaskMergeRequest;
      if (recordedRequest.integration_worktree_id !== integrationId || recordedRequest.task_worktree_id !== taskWorktreeId) {
        throw new ValidationError("pending task merge does not match the requested worktree bindings");
      }
      const recovered = await this.confirmTaskMerge(integration.path, recordedRequest);
      if (!recovered) throw new ValidationError("merge side effect is unknown; reconcile required");
      this.finishTaskMerge(runId, operation.operationId, recordedRequest, recovered);
      await this.cleanupIntegratedTask(runId, taskWorktreeId, integrationId, operation.operationId);
      return recovered;
    }
    const commit = await mergeNoFastForward(integration.path, task.branch, `Merge ${task.branch} into ${integration.branch}`);
    if (!(await this.confirmTaskMerge(integration.path, request, commit))) {
      throw new ValidationError("task merge did not produce the expected non-fast-forward merge commit");
    }
    this.finishTaskMerge(runId, operation.operationId, request, commit);
    await this.cleanupIntegratedTask(runId, taskWorktreeId, integrationId, operation.operationId);
    return commit;
  }

  private async confirmTaskMerge(integrationPath: string, request: TaskMergeRequest, expectedCommit?: string): Promise<string | undefined> {
    const head = await currentHead(integrationPath);
    if (expectedCommit && head !== expectedCommit) return undefined;
    const parents = (await git(integrationPath, ["rev-list", "--parents", "-n", "1", head])).stdout.split(" ");
    return parents.length === 3 && parents[1] === request.integration_head_before && parents[2] === request.task_commit ? head : undefined;
  }

  private finishTaskMerge(runId: string, operationId: string, request: TaskMergeRequest, commit: string): void {
    this.store.db.transaction(() => {
      this.store.finishOperation(operationId, {
        commit,
        task_commit: request.task_commit,
        task_id: request.task_id,
        task_worktree_id: request.task_worktree_id,
        integration_worktree_id: request.integration_worktree_id,
        integration_head_before: request.integration_head_before,
      });
      const run = this.store.getRun(runId) as any;
      if (isPlannedRun(run)) {
        const task = this.store.db.prepare("SELECT 1 FROM run_tasks WHERE run_id=? AND task_id=?")
          .get(runId, request.task_id);
        if (task) this.store.advanceRunTask(runId, request.task_id, "integrated", {
          worktree_id: request.task_worktree_id,
          integration_commit: commit,
          recovered: true,
        });
      }
    })();
  }

  /** Removes one merged, independently-owned task worktree. This is deliberately
   * separate from final cleanup so recovery can converge without touching the plan
   * or integration worktree. */
  async cleanupIntegratedTask(runId: string, taskWorktreeId: string, integrationId: string, mergeOperationId: string, dispatchId?: string): Promise<string | undefined> {
    this.assertGitOperator(runId, dispatchId, "cleanup-integrated-task");
    if (dispatchId) {
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
        .get(runId, dispatchId) as { packet_json: string } | undefined;
      const context = row ? (JSON.parse(row.packet_json) as { context?: Record<string, unknown> }).context : undefined;
      if (!context || context.phase !== "cleanup_integrated_task" || context.task_worktree_id !== taskWorktreeId
        || context.integration_worktree_id !== integrationId || context.merge_operation_id !== mergeOperationId) {
        throw new ValidationError("cleanup dispatch is not bound to the integrated task");
      }
    }
    const { root } = this.repositoryForRun(runId);
    const integration = this.plannedIntegrationWorktree(runId, integrationId);
    const merge = this.store.db.prepare("SELECT state,request_json,evidence_json FROM operations WHERE operation_id=? AND run_id=? AND kind='git.merge.task'")
      .get(mergeOperationId, runId) as { state: string; request_json: string; evidence_json?: string } | undefined;
    if (!merge || merge.state !== "completed") throw new ValidationError("integrated task cleanup requires its completed merge operation");
    const request = JSON.parse(merge.request_json) as TaskMergeRequest;
    if (request.task_worktree_id !== taskWorktreeId || request.integration_worktree_id !== integrationId) {
      throw new ValidationError("integrated task cleanup merge lineage does not match the requested worktree");
    }
    const task = this.store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND run_id=?")
      .get(taskWorktreeId, runId) as any;
    if (!task) throw new ValidationError("integrated task cleanup worktree is not owned by this run");
    if (task.state === "removed") return undefined;
    if (task.state !== "active" || !task.branch.startsWith("task/")) throw new ValidationError("integrated task cleanup requires an active independent task worktree");
    const relativePath = toPosix(relative(resolve(root), resolve(task.path)));
    if (!relativePath.startsWith(".worktrees/")) throw new ValidationError("refusing to remove task worktree outside managed root");
    const cleanup = this.store.beginOperation("git.cleanup", `cleanup:${runId}:${taskWorktreeId}`, {
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
      this.store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(taskWorktreeId);
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
      this.store.finishOperation(cleanup.operationId, {
        path: task.path,
        branch: task.branch,
        task_id: request.task_id,
        task_worktree_id: taskWorktreeId,
        integration_worktree_id: integrationId,
        merge_operation_id: mergeOperationId,
        removed: true,
      });
      this.store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(taskWorktreeId);
      return task.path;
    } catch (error) {
      this.store.recordPendingOperationEvidence(cleanup.operationId, {
        state: "cleanup_failed",
        task_worktree_id: taskWorktreeId,
        integration_worktree_id: integrationId,
        merge_operation_id: mergeOperationId,
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async integrateTarget(runId: string, integrationId: string, dispatchId?: string): Promise<string> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    const dispatchFinalContext = dispatchId ? new DispatchService(this.store).finalizationContext(runId, dispatchId) : undefined;
    if (dispatchFinalContext) {
      const completed = this.store.db.prepare("SELECT evidence_json FROM operations WHERE idempotency_key=? AND state='completed'")
        .get(`integrate:${runId}:${run.target_branch}:${dispatchFinalContext.revision_sha}`) as { evidence_json?: string } | undefined;
      if (completed) {
        const evidence = JSON.parse(completed.evidence_json ?? "{}") as { commit?: string };
        if (!evidence.commit || await currentHead(root) !== evidence.commit) throw new ValidationError("completed integration no longer matches target HEAD; reconcile required");
        return evidence.commit;
      }
    }
    const integration = this.plannedIntegrationWorktree(runId, integrationId);
    const targetStatus = await worktreeStatus(root);
    const unmanagedUntracked = targetStatus.untracked.filter((path) => path !== ".worktrees/" && !path.startsWith(".worktrees/"));
    if (targetStatus.staged.length || targetStatus.unstaged.length || unmanagedUntracked.length) {
      this.store.event(runId, "git.target_dirty_blocked", {
        target_branch: run.target_branch,
        snapshot: { ...targetStatus, untracked: unmanagedUntracked },
        protection: { strategy: "reject_without_mutation", stash_created: false, cleanup_performed: false },
      });
      throw new ValidationError("target worktree must be clean before integration", { ...targetStatus, untracked: unmanagedUntracked });
    }
    if (await currentBranch(root) !== run.target_branch) throw new ValidationError("target branch changed before integration");
    const current = await currentHead(root);
    if (current !== run.base_commit) {
      const count = this.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=? AND kind='git.sync' AND state='completed'").get(runId) as { count: number };
      if (count.count >= 3) throw new ValidationError("target branch drift exceeded 3 synchronization attempts");
      const integrationHeadBefore = await currentHead(integration.path);
      const sync = this.store.beginOperation("git.sync", `sync:${runId}:${integration.branch}:${current}`, {
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
          this.store.finishOperation(sync.operationId, {
            commit: synced,
            target_snapshot_before: targetStatus,
            target_snapshot_after: await worktreeStatus(root),
          });
          new DispatchService(this.store).create(runId, "test", {
            objective: "Run the complete final verification after synchronizing target branch changes.",
            allowed_read_paths: ["package.json", "test"],
            allowed_write_paths: [],
            acceptance_criteria: ["All final checks pass", "No review is restarted"],
            context: { synchronization_commit: synced, target_commit: current },
          });
        } catch (error) {
          const conflictPaths = await git(integration.path, ["diff", "--name-only", "--diff-filter=U"])
            .then(({ stdout }) => stdout.split("\n").filter(Boolean), () => [] as string[]);
          this.store.recordPendingOperationEvidence(sync.operationId, {
            state: "conflicted",
            conflict_paths: conflictPaths,
            integration_head_before: integrationHeadBefore,
            target_head: current,
          });
          this.store.event(runId, "git.sync_conflicted", { operation_id: sync.operationId, integration_worktree_id: integrationId, conflict_paths: conflictPaths });
          throw new ValidationError("target synchronization conflicted; developer resolution required", { cause: String(error) });
        }
      }
    }
    const integrationHead = await currentHead(integration.path);
    new (await import("./review.js")).ReviewService(this.store).assertGate(runId, integrationHead);
    const finalContext = dispatchFinalContext;
    if (finalContext && (finalContext.revision_sha !== integrationHead || finalContext.integration_worktree_id !== integrationId)) {
      throw new ValidationError("final Git Operator dispatch does not match the integration worktree HEAD");
    }
    const operation = this.store.beginOperation("git.integrate", `integrate:${runId}:${run.target_branch}:${integrationHead}`, {
      integration: integration.branch,
      integration_worktree_id: integrationId,
      revision_sha: integrationHead,
      barrier_id: finalContext?.barrier_id ?? null,
      target_parent: current,
    }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("integration side effect is unknown; reconcile required");
      const recorded = this.store.db.prepare("SELECT evidence_json FROM operations WHERE operation_id=?").get(operation.operationId) as { evidence_json?: string };
      const evidence = JSON.parse(recorded.evidence_json ?? "{}") as { commit?: string };
      if (!evidence.commit || await currentHead(root) !== evidence.commit) throw new ValidationError("completed integration no longer matches target HEAD; reconcile required");
      return evidence.commit;
    }
    const commit = await mergeNoFastForward(root, integration.branch, `Integrate AI Team run ${runId}`);
    this.store.finishOperation(operation.operationId, {
      commit,
      target_parent: current,
      integration_head: integrationHead,
      barrier_id: finalContext?.barrier_id ?? null,
      integration_worktree_id: integrationId,
    });
    return commit;
  }

  async continueConflict(runId: string, integrationId: string, allowedScopes: string[], dispatchId?: string): Promise<string> {
    this.assertGitOperator(runId, dispatchId);
    const integration = this.plannedIntegrationWorktree(runId, integrationId);
    try { await git(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); }
    catch { throw new ValidationError("worktree has no merge conflict in progress"); }
    const unresolved = (await git(integration.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    if (unresolved.length) throw new ValidationError("merge still has unresolved paths", unresolved);
    const changed = [...new Set((await git(integration.path, ["status", "--porcelain=v1", "-z"])).stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)))];
    if (!changed.length) throw new ValidationError("no conflict resolution changes are present");
    const sync = this.store.db.prepare("SELECT operation_id,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.sync' AND state='pending' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { operation_id: string; request_json: string; evidence_json?: string } | undefined;
    if (!sync) throw new ValidationError("conflict continuation requires its pending git.sync operation");
    const request = JSON.parse(sync.request_json) as { target?: string; integration_head_before?: string; integration_worktree_id?: string; target_snapshot_before?: unknown };
    const syncEvidence = JSON.parse(sync.evidence_json ?? "{}") as Partial<SyncConflictEvidence>;
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
    const operation = this.store.beginOperation("git.merge.continue", `merge-continue:${runId}:${integrationId}:${sha256(changed.sort().join("\n"))}`, {
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
    this.store.finishOperation(operation.operationId, { commit, changed });
    this.store.finishOperation(sync.operation_id, {
      commit,
      conflict_paths: conflictPaths,
      target_inherited_paths: inheritedPaths,
      continued_by: operation.operationId,
      target_snapshot_before: request.target_snapshot_before ?? null,
      target_snapshot_after: await worktreeStatus(this.repositoryForRun(runId).root),
    });
    new DispatchService(this.store).create(runId, "test", {
      objective: "Run the complete final verification after conflict resolution.",
      allowed_read_paths: ["package.json", "test"],
      allowed_write_paths: [],
      acceptance_criteria: ["All final checks pass", "No review is restarted"],
      context: { conflict_resolution_commit: commit },
    });
    return commit;
  }

  async reconcileSyncConflict(runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    this.assertGitOperator(runId, dispatchId);
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

    const normalized: SyncConflictEvidence = {
      integration_worktree_id: integrationId as string,
      conflict_paths: [...new Set(conflictPaths as string[])].sort(),
      integration_head_before: integrationHeadBefore as string,
      target_head: targetHead as string,
    };
    for (const path of normalized.conflict_paths) assertWritablePath(path);
    const operation = this.store.db.prepare("SELECT run_id,kind,state,request_json FROM operations WHERE operation_id=?").get(operationId) as { run_id: string; kind: string; state: string; request_json: string } | undefined;
    if (!operation || operation.run_id !== runId) throw new ValidationError("git reconciliation operation does not belong to run");
    if (operation.kind !== "git.sync" || operation.state !== "pending") throw new ValidationError("conflicted reconciliation requires a pending git.sync operation");
    const request = JSON.parse(operation.request_json) as { target?: string };
    if (request.target && request.target !== normalized.target_head) throw new ValidationError("conflicted reconciliation target_head does not match the sync request");
    const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, normalized.integration_worktree_id) as { path: string } | undefined;
    if (!worktree) throw new ValidationError("conflicted reconciliation integration worktree is not active for the run");
    if (await currentHead(worktree.path) !== normalized.integration_head_before) throw new ValidationError("integration worktree HEAD does not match integration_head_before");
    const mergeHead = await git(worktree.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(({ stdout }) => stdout, () => "");
    if (mergeHead !== normalized.target_head) throw new ValidationError("integration worktree MERGE_HEAD does not match target_head");

    this.store.db.transaction(() => {
      this.store.recordPendingOperationEvidence(operationId, { state: "conflicted", ...normalized });
      const run = this.store.getRun(runId) as { state: string };
      if (run.state === "failed" || run.state === "retryable_failure") {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      this.store.event(runId, "run.git_sync_conflict_reconciled", { dispatch_id: dispatchId ?? null, operation_id: operationId, ...normalized });
    })();
    return this.reconcile(runId);
  }

  async reconcileTaskAuthorityConflict(runId: string, operationId: string, evidence: unknown, dispatchId?: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    this.assertGitOperator(runId, dispatchId, "reconcile-task-authority-conflict");
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

    const normalized: Omit<AuthorityApplyConflictEvidence, "state"> = {
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
    const operation = this.store.db.prepare("SELECT run_id,kind,state,request_json FROM operations WHERE operation_id=?").get(operationId) as { run_id: string; kind: string; state: string; request_json: string } | undefined;
    if (!operation || operation.run_id !== runId) throw new ValidationError("git reconciliation operation does not belong to run");
    if (operation.kind !== "git.task_authority.apply" || operation.state !== "pending") throw new ValidationError("conflicted reconciliation requires a pending git.task_authority.apply operation");
    const request = JSON.parse(operation.request_json) as TaskAuthorityApplyRequest & { dirty_paths?: unknown };
    const recordedDirtyPaths = Array.isArray(request.dirty_paths) && request.dirty_paths.every((path) => typeof path === "string") ? [...request.dirty_paths].sort() : [];
    if (!request.dispatchId || request.worktreeId !== normalized.worktree_id || request.authorityCommit !== normalized.authority_commit || request.expectedHead !== normalized.expected_head
      || stableJson(recordedDirtyPaths) !== stableJson(normalized.dirty_paths)) {
      throw new ValidationError("authority conflict evidence does not match the authority apply request");
    }
    if (dispatchId !== request.dispatchId) throw new ValidationError("authority conflict reconciliation requires the original claimed authority dispatch");
    const dispatch = this.store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
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
    const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, normalized.worktree_id) as { path: string } | undefined;
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

    this.store.db.transaction(() => {
      this.store.recordPendingOperationEvidence(operationId, { state: "conflicted", ...normalized });
      const run = this.store.getRun(runId) as { state: string };
      if (run.state === "failed" || run.state === "retryable_failure") this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      this.store.event(runId, "worktree.task_authority_conflict_reconciled", { dispatch_id: dispatchId, operation_id: operationId, ...normalized });
    })();
    new DispatchService(this.store).createAuthorityConflictContinuation({
      runId, authorityDispatchId: request.dispatchId, operationId, worktreeId: normalized.worktree_id, authorityCommit: normalized.authority_commit,
      expectedHead: normalized.expected_head, dirtyPaths: normalized.dirty_paths, authorityPaths: normalized.authority_paths,
      conflictPaths: normalized.conflict_paths, stashCommit: normalized.stash_commit,
    });
    return this.reconcile(runId);
  }

  async cleanup(runId: string, dispatchId?: string): Promise<string[]> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    if (run.state === "active" && run.stage !== "canceling") {
      if (!dispatchId) throw new ValidationError("active run cleanup requires its final Git Operator dispatch");
      new DispatchService(this.store).assertFinalizingCleanup(runId, dispatchId);
    } else if (run.state !== "completed" && !(run.state === "active" && run.stage === "canceling")) {
      throw new ValidationError("worktrees are retained unless final integration completed or the run entered managed cancellation");
    }
    const rows = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND state='active' ORDER BY length(path) DESC").all(runId) as any[];
    const removed: string[] = [];
    for (const row of rows) {
      if (!(await worktreeStatus(row.path)).clean) throw new ValidationError(`worktree is dirty and cannot be removed: ${row.path}`);
      const canonical = await realpath(row.path);
      const relativePath = toPosix(relative(root, canonical));
      if (!relativePath.startsWith(".worktrees/")) throw new ValidationError(`refusing to remove worktree outside managed root: ${canonical}`);
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

  async reconcile(runId: string): Promise<Array<{ operation_id: string; state: string; fact: string; next_command?: string }>> {
    const { root } = this.repositoryForRun(runId);
    const pending = this.store.db.prepare("SELECT * FROM operations WHERE run_id=? AND state='pending'").all(runId) as any[];
    const result: Array<{ operation_id: string; state: string; fact: string; next_command?: string }> = [];
    for (const operation of pending) {
      const request = JSON.parse(operation.request_json);
      if (operation.kind === "git.merge.task") {
        const merge = request as TaskMergeRequest;
        const integration = typeof merge.integration_worktree_id === "string"
          ? this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
            .get(runId, merge.integration_worktree_id) as { path: string } | undefined
          : undefined;
        const commit = integration ? await this.confirmTaskMerge(integration.path, merge) : undefined;
        if (!commit) {
          result.push({ operation_id: operation.operation_id, state: "unknown", fact: "task merge cannot be proven from its recorded parents" });
          continue;
        }
        this.finishTaskMerge(runId, operation.operation_id, merge, commit);
        try {
          await this.cleanupIntegratedTask(runId, merge.task_worktree_id, merge.integration_worktree_id, operation.operation_id);
          result.push({ operation_id: operation.operation_id, state: "completed", fact: "recorded task merge parents match and task cleanup converged" });
        } catch (error) {
          result.push({ operation_id: operation.operation_id, state: "completed", fact: `recorded task merge parents match; task cleanup remains pending: ${error instanceof Error ? error.message : String(error)}` });
        }
      } else if (operation.kind === "git.cleanup" && typeof request.task_worktree_id === "string" && typeof request.integration_worktree_id === "string" && typeof request.merge_operation_id === "string") {
        try {
          await this.cleanupIntegratedTask(runId, request.task_worktree_id, request.integration_worktree_id, request.merge_operation_id);
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
        const evidence = JSON.parse(operation.evidence_json ?? "{}") as Partial<SyncConflictEvidence> & { state?: string };
        const integrationWorktreeId = request.integration_worktree_id ?? evidence.integration_worktree_id;
        const integrationHeadBefore = request.integration_head_before ?? evidence.integration_head_before;
        const integrationRow = typeof integrationWorktreeId === "string"
          ? this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, integrationWorktreeId) as { path: string } | undefined
          : undefined;
        const integration = integrationRow?.path ?? request.integration_path as string | undefined;
        const mergeHead = integration ? await git(integration, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false) : false;
        const dispatch = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1").get(runId) as { dispatch_id: string } | undefined;
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
        const evidence = JSON.parse(operation.evidence_json ?? "{}") as Partial<AuthorityApplyConflictEvidence>;
        const continuation = typeof request.dispatchId === "string"
          ? this.store.db.prepare("SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND replacement_for=? AND role='git-operator' ORDER BY created_at LIMIT 1").get(runId, request.dispatchId) as { dispatch_id: string; state: string } | undefined
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
    const retryable = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (retryable) {
      const bindings = new DispatchService(this.store).mergeWorktreeBindings(runId, retryable.dispatch_id);
      if (bindings.integration_worktree_id && bindings.task_worktree_ids.length) {
        const partial = completedMergeOwnershipPartialEffect(this.store, runId, bindings.integration_worktree_id, bindings.task_worktree_ids);
        if (partial) result.push({ operation_id: partial.operation_ids.at(-1) ?? `dispatch-binding:${retryable.dispatch_id}`, state: "completed", fact: partial.fact });
      }
    }
    return result;
  }
}
