import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ValidationError } from "./errors.js";
import { commitPaths, createWorktree, currentBranch, currentHead, git, mergeNoFastForward, worktreeStatus } from "./git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "./security.js";
import { StateStore } from "./state.js";
import { sha256, toPosix } from "./utils.js";
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

  async prepareTask(runId: string, taskId = "implementation", baseCommit?: string, dependsOn?: string, dispatchId?: string): Promise<PreparedWorktree> {
    this.assertGitOperator(runId, dispatchId);
    const { root, run } = this.repositoryForRun(runId);
    if ((["bug", "feature"] as string[]).includes(run.mode)) new ScopeGate(this.store).assertPassed(runId, "pre_write");
    const { branch, path } = worktreeNames(root, run, runId, taskId);
    const integration = isPlannedRun(run) ? this.activeIntegrationWorktree(runId, root, run) : undefined;
    if (isPlannedRun(run) && !integration) throw new ValidationError("planned Task requires an active plan worktree");
    if (isPlannedRun(run) && integration) {
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
    const integrationHead = integration ? await currentHead(integration.path) : undefined;
    if (integrationHead && baseCommit && baseCommit !== integrationHead) throw new ValidationError("planned Task base must equal the current plan worktree HEAD");
    let base = integrationHead ?? baseCommit ?? run.base_commit;
    if (dependsOn) {
      const dependency = this.worktree(runId, dependsOn);
      if (dependency.state !== "active") throw new ValidationError("dependent Task worktree is not active");
      const integrationWorktree = integration ?? this.activeIntegrationWorktree(runId, root, run);
      if (!integrationWorktree) throw new ValidationError("dependent Task requires an active integration worktree");
      base = await currentHead(integrationWorktree.path);
    }
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ValidationError("worktree base must be a 40-character commit SHA");
    const key = `worktree:create:${runId}:${branch}:${base}`;
    const existing = this.store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    if (existing) {
      if (existing.base_commit !== base) {
        if (!dispatchId) throw new ValidationError("stale planned Task worktree requires its managed replacement dispatch");
        const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
          .get(runId, dispatchId) as { packet_json: string };
        const context = (JSON.parse(dispatch.packet_json) as { context?: Record<string, unknown> }).context ?? {};
        if (context.phase !== "prepare_implementation_worktree" || context.task_id !== taskId
          || context.replace_worktree_id !== existing.worktree_id || context.base_commit !== base) {
          throw new ValidationError("stale planned Task worktree replacement is not authorized by the frozen dispatch");
        }
        if (!(await worktreeStatus(existing.path)).clean || await currentHead(existing.path) !== existing.base_commit) {
          throw new ValidationError("stale planned Task worktree has implementation changes and cannot be replaced");
        }
        const replacement = this.store.beginOperation("git.worktree.replace", `worktree:replace:${runId}:${branch}:${existing.base_commit}:${base}`, {
          worktree_id: existing.worktree_id,
          branch,
          path,
          stale_base: existing.base_commit,
          base,
          dispatch_id: dispatchId,
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
    else if (run.mode === "planned") new ScopeGate(this.store).assertPreCommit(runId, allowedScopes, worktreeId);
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
    const integration = this.plannedIntegrationWorktree(runId, integrationId);
    const task = this.worktree(runId, taskWorktreeId);
    const taskCommit = await currentHead(task.path);
    const operation = this.store.beginOperation("git.merge.task", `merge-task:${runId}:${integration.branch}:${task.branch}:${taskCommit}`, {
      integration: integration.branch,
      task: task.branch,
      integration_worktree_id: integrationId,
      task_id: taskId,
      task_worktree_id: taskWorktreeId,
    }, runId);
    if (operation.reused) {
      if (operation.state !== "completed") throw new ValidationError("merge side effect is unknown; reconcile required");
      return currentHead(integration.path);
    }
    const commit = await mergeNoFastForward(integration.path, task.branch, `Merge ${task.branch} into ${integration.branch}`);
    this.store.finishOperation(operation.operationId, {
      commit,
      task_commit: taskCommit,
      task_id: taskId,
      task_worktree_id: taskWorktreeId,
      integration_worktree_id: integrationId,
    });
    return commit;
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
