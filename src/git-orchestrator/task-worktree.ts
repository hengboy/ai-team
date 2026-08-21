import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { IncompatibleError, ValidationError } from "../errors.js";
import { attachWorktree, createWorktree, currentBranch, currentHead, git, worktreeStatus } from "../git.js";
import { assertWritablePath, canonicalizeInside, pathMatchesScope } from "../security.js";
import { sha256, stableJson, toPosix } from "../utils.js";
import { taskSourceDigest } from "../planning.js";
import { resolveMergeTaskWorktree, resolveTransferredWorktree } from "../worktree-ownership.js";
import * as common from "./runtime.js";
export async function prepareTask(store: common.StateStore, ops: common.GitOperations, runId: string, taskId: string | undefined, baseCommit: string | undefined, dependsOn: string | undefined, dispatchId: string): Promise<common.PreparedWorktree> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    if ((["bug", "feature"] as string[]).includes(run.mode)) common.assertDirectScopePassed(store, runId, "pre_write");
    const worktreeTaskId = common.isPlannedRun(run) ? taskId : taskId ?? "implementation";
    const { branch, path } = common.worktreeNames(root, run, runId, worktreeTaskId);
    const integration = common.isPlannedRun(run) ? ops.activeIntegrationWorktree!(store, ops, runId, root, run) : undefined;
    if (common.isPlannedRun(run) && !integration) throw new ValidationError("planned Task requires an active plan worktree");
    const integrationHead = integration ? await currentHead(integration.path) : undefined;
    if (integrationHead && baseCommit && baseCommit !== integrationHead) throw new ValidationError("planned Task base must equal the current plan worktree HEAD");
    if (common.isPlannedRun(run) && taskId === undefined) {
      return { worktree_id: integration!.worktree_id, branch: integration!.branch, path: integration!.path, base_commit: integration!.base_commit, reused: true };
    }
    if (common.isPlannedRun(run) && integration && taskId !== undefined) {
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
      const integrationWorktree = integration ?? ops.activeIntegrationWorktree!(store, ops, runId, root, run);
      if (!integrationWorktree) throw new ValidationError("dependent Task requires an active integration worktree");
      const dependency = store.db.prepare("SELECT state FROM worktrees WHERE run_id=? AND worktree_id=?")
        .get(runId, dependsOn) as { state: string } | undefined;
      if (!dependency) throw new ValidationError("dependent Task worktree is not owned by this run");
      if (dependency.state === "active") ops.worktree!(store, ops, runId, dependsOn);
      else {
        const merged = store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
          AND json_extract(evidence_json,'$.task_worktree_id')=? LIMIT 1`).get(runId, dependsOn);
        if (!merged) throw new ValidationError("dependent Task requires a completed predecessor merge");
      }
      base = await currentHead(integrationWorktree.path);
    }
    if (!/^[a-f0-9]{40}$/.test(base)) throw new ValidationError("worktree base must be a 40-character commit SHA");
    const key = `worktree:create:${runId}:${branch}:${base}`;
    const existing = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND state='active'").get(runId, branch) as any;
    if (existing) {
      if (existing.base_commit !== base || dispatchId) {
        if (!dispatchId) throw new ValidationError("stale planned Task worktree requires its managed replacement dispatch");
        const dispatch = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
          .get(runId, dispatchId) as { packet_json: string };
        const context = (JSON.parse(dispatch.packet_json) as { context?: Record<string, unknown> }).context ?? {};
        const reuseTaskBranch = context.reuse_task_branch === true;
        if (!reuseTaskBranch && existing.base_commit === base) {
          const operation = store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
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
          const replacement = store.beginOperation("git.worktree.replace", `worktree:replace:${runId}:${branch}:${existing.base_commit}:${base}`, {
            worktree_id: existing.worktree_id, branch, path, stale_base: existing.base_commit, base, dispatch_id: dispatchId,
          }, runId);
          if (replacement.reused) {
            if (replacement.state !== "completed") throw new ValidationError("worktree replacement has unknown side effect; reconcile required");
            return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
          }
          await git(root, ["worktree", "remove", existing.path]);
          await git(root, ["branch", "-d", existing.branch]);
          await createWorktree(root, path, branch, base);
          store.db.prepare("UPDATE worktrees SET path=?,base_commit=?,state='active',created_at=? WHERE worktree_id=?")
            .run(path, base, new Date().toISOString(), existing.worktree_id);
          store.finishOperation(replacement.operationId, { worktree_id: existing.worktree_id, branch, path, base, replaced: true, head: await currentHead(path) });
          return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: false };
        }
        if (existing.base_commit !== base) throw new ValidationError("task retry requires the original integration base");
        const retry = (store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as { count: number }).count;
        const retryPath = `${path}--retry-${retry}`;
        const replacementWorktreeId = `worktree_${sha256(`${runId}:${branch}:retry:${retry}`).slice(0, 24)}`;
        const replacement = store.beginOperation("git.worktree.replace", `worktree:replace:${runId}:${existing.worktree_id}:${base}:retry:${retry}`, {
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
          const replaced = ops.worktree!(store, ops, runId, replacementWorktreeId);
          return { worktree_id: replaced.worktree_id, branch: replaced.branch, path: replaced.path, base_commit: replaced.base_commit, reused: true };
        }
        await git(root, ["worktree", "remove", existing.path]);
        await mkdir(dirname(retryPath), { recursive: true });
        await attachWorktree(root, retryPath, existing.branch);
        const head = await currentHead(retryPath);
        const now = new Date().toISOString();
        store.db.transaction(() => {
          store.db.prepare("UPDATE worktrees SET state='removed' WHERE worktree_id=?").run(existing.worktree_id);
          store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
            .run(replacementWorktreeId, runId, existing.branch, retryPath, existing.base_commit, now);
          if (common.isPlannedRun(run)) {
            store.db.prepare("UPDATE run_tasks SET worktree_id=?,updated_at=? WHERE run_id=? AND worktree_id=? AND state!='integrated'")
              .run(replacementWorktreeId, now, runId, existing.worktree_id);
          }
          store.finishOperation(replacement.operationId, {
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
      const operation = store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
      if (operation.state !== "completed" || !existing) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
      return { worktree_id: existing.worktree_id, branch, path, base_commit: base, reused: true };
    }
    const collision = store.db.prepare("SELECT run_id FROM worktrees WHERE state='active' AND (branch=? OR path=?)").get(branch, path) as any;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    try { await stat(path); throw new ValidationError(`unowned worktree path already exists: ${path}`); } catch (error) { if (error instanceof ValidationError) throw error; }
    try { await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]); throw new ValidationError(`unowned branch already exists: ${branch}`); } catch (error) { if (error instanceof ValidationError && error.message.startsWith("unowned")) throw error; }
    const operation = store.beginOperation("git.worktree.create", key, { branch, path, base }, runId);
    if (operation.reused) throw new ValidationError("worktree operation has unknown side effect; reconcile required");
    await mkdir(dirname(path), { recursive: true });
    await createWorktree(root, path, branch, base);
    const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, branch, path, base, new Date().toISOString());
    store.finishOperation(operation.operationId, { worktreeId, head: await currentHead(path) });
    return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
  }

export async function adopt(store: common.StateStore, ops: common.GitOperations, runId: string, path: string, branch: string, baseCommit: string, commit: string | undefined, dispatchId: string): Promise<common.PreparedWorktree> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
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
    if (common.isPlannedRun(run)) {
      const taskPrefix = `task/${run.plan_id}/${run.plan_id}-${run.revision}--`;
      if (!commit || !branch.startsWith(taskPrefix)) throw new ValidationError("planned adoption accepts only an existing task commit");
      const expected = common.worktreeNames(root, run, runId);
      const integration = store.db.prepare("SELECT * FROM worktrees WHERE branch=? AND path=? AND state='active'")
        .get(expected.branch, expected.path) as any;
      if (!integration || await currentHead(integration.path) !== baseCommit) {
        throw new ValidationError("adopted task base does not match the current plan worktree HEAD");
      }
    } else if (run.base_commit && run.base_commit !== baseCommit) {
      throw new ValidationError("adopted base commit does not match run base commit");
    }
    const packetRow = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string };
    const context = (JSON.parse(packetRow.packet_json) as { context?: Record<string, unknown> }).context ?? {};
    if (context.phase === "reconcile_worktree_ownership") {
      const tasks = Array.isArray(context.task_worktrees) ? context.task_worktrees as Array<Record<string, unknown>> : [];
      const authorized = tasks.some((task) => task.path === canonical && task.branch === branch && task.base_commit === baseCommit && task.commit === head);
      if (!authorized) throw new ValidationError("ownership reconciliation may adopt only its listed task worktree");
    }
    const existing = store.db.prepare("SELECT * FROM worktrees WHERE path=? OR branch=? ORDER BY created_at DESC LIMIT 1").get(canonical, branch) as any;
    if (existing?.state === "active") {
      if (existing.run_id === runId) {
        resolveMergeTaskWorktree(store, runId, existing.worktree_id);
        return { worktree_id: existing.worktree_id, branch, path: canonical, base_commit: baseCommit, reused: true };
      }
      const sourceRun = store.getRun(existing.run_id) as { repo_id: string };
      if (!common.isPlannedRun(run) || sourceRun.repo_id !== run.repo_id) throw new ValidationError(`worktree belongs to another run; use git transfer: ${existing.run_id}`);
      const key = `worktree:adopt:${runId}:${canonical}:${branch}:${head}`;
      const operation = store.beginOperation("git.worktree.adopt", key, { path: canonical, branch, base: baseCommit, commit: head }, runId);
      if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
      if (!operation.reused) {
        store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=?")
          .run(runId, existing.run_id, existing.worktree_id, existing.run_id);
        store.finishOperation(operation.operationId, { worktree_id: existing.worktree_id, head, adopted: true, implementation_revision: head, adopted_from_run_id: existing.run_id });
        store.event(runId, "worktree.adopted", { worktreeId: existing.worktree_id, path: canonical, branch, baseCommit, head, implementation_revision: head, adopted_from_run_id: existing.run_id });
      }
      resolveMergeTaskWorktree(store, runId, existing.worktree_id);
      return { worktree_id: existing.worktree_id, branch, path: canonical, base_commit: baseCommit, reused: operation.reused };
    }
    const key = `worktree:adopt:${runId}:${canonical}:${branch}:${head}`;
    const operation = store.beginOperation("git.worktree.adopt", key, { path: canonical, branch, base: baseCommit, commit: head }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
    const worktreeId = `worktree_${sha256(`${runId}:${branch}:${canonical}`).slice(0, 24)}`;
    if (!operation.reused) {
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, branch, canonical, baseCommit, new Date().toISOString());
      store.finishOperation(operation.operationId, { worktree_id: worktreeId, head, adopted: true, implementation_revision: commit ?? null });
      store.event(runId, "worktree.adopted", { worktreeId, path: canonical, branch, baseCommit, head, implementation_revision: commit ?? null });
    }
    resolveMergeTaskWorktree(store, runId, worktreeId);
    return { worktree_id: worktreeId, branch, path: canonical, base_commit: baseCommit, reused: operation.reused };
  }

export async function adoptCommit(store: common.StateStore, ops: common.GitOperations, runId: string, commit: string, taskId: string, dispatchId: string): Promise<common.PreparedWorktree> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    const integration = common.isPlannedRun(run) ? ops.activeIntegrationWorktree!(store, ops, runId, root, run) : undefined;
    if (common.isPlannedRun(run) && !integration) throw new ValidationError("planned Task requires an active plan worktree");
    const base = integration ? await currentHead(integration.path) : run.base_commit as string;
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(commit)) throw new ValidationError("managed commit adoption requires full base and commit SHAs");
    const revision = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).stdout.split(" ");
    if (revision.length !== 2 || revision[1] !== base) throw new ValidationError("managed adopt requires an existing direct-child commit of the task base");
    const { branch, path } = common.worktreeNames(root, run, runId, taskId);
    const existing = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=? AND state='active'").get(runId, branch) as any;
    if (existing) {
      if (await currentHead(existing.path) !== commit) throw new ValidationError("existing adopted worktree does not match requested commit");
      return { worktree_id: existing.worktree_id, branch, path: existing.path, base_commit: base, reused: true };
    }
    const collision = store.db.prepare("SELECT run_id FROM worktrees WHERE (branch=? OR path=?) AND state='active'").get(branch, path) as { run_id: string } | undefined;
    if (collision) throw new ValidationError(`branch or worktree belongs to another run: ${collision.run_id}`);
    const key = `worktree:adopt-commit:${runId}:${branch}:${commit}`;
    const operation = store.beginOperation("git.worktree.adopt", key, { branch, path, base, commit }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("adopt operation has unknown side effect; reconcile required");
    if (!operation.reused) {
      await mkdir(dirname(path), { recursive: true });
      await createWorktree(root, path, branch, commit);
      const worktreeId = `worktree_${sha256(`${runId}:${branch}`).slice(0, 24)}`;
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, branch, path, base, new Date().toISOString());
      store.finishOperation(operation.operationId, { worktree_id: worktreeId, head: commit, adopted: true, implementation_revision: commit });
      store.event(runId, "worktree.commit_adopted", { worktreeId, path, branch, baseCommit: base, implementation_revision: commit });
      return { worktree_id: worktreeId, branch, path, base_commit: base, reused: false };
    }
    const adopted = store.db.prepare("SELECT * FROM worktrees WHERE run_id=? AND branch=?").get(runId, branch) as any;
    return { worktree_id: adopted.worktree_id, branch, path: adopted.path, base_commit: base, reused: true };
  }

export async function transfer(store: common.StateStore, ops: common.GitOperations, runId: string, worktreeId: string, dispatchId: string): Promise<common.PreparedWorktree> {
    ops.assertGitOperator!(store, ops, runId, dispatchId);
    const { root, run } = ops.repositoryForRun!(store, ops, runId);
    const row = store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND state='active'").get(worktreeId) as any;
    if (!row) throw new ValidationError("active worktree to transfer was not found");
    if (row.run_id === runId) {
      resolveTransferredWorktree(store, runId, worktreeId);
      return { worktree_id: row.worktree_id, branch: row.branch, path: row.path, base_commit: row.base_commit, reused: true };
    }
    const sourceRun = store.getRun(row.run_id) as { repo_id: string };
    if (sourceRun.repo_id !== run.repo_id) throw new ValidationError("worktree transfer requires runs from the same repository");
    const canonical = await realpath(row.path);
    const relativePath = toPosix(relative(root, canonical));
    if (!relativePath.startsWith(".worktrees/") || !(await worktreeStatus(canonical)).clean) throw new ValidationError("only a clean managed worktree can be transferred");
    const key = `worktree:transfer:${row.run_id}:${runId}:${worktreeId}`;
    const operation = store.beginOperation("git.worktree.transfer", key, { worktree_id: worktreeId, from_run_id: row.run_id, to_run_id: runId }, runId);
    if (operation.reused && operation.state !== "completed") throw new ValidationError("transfer operation has unknown side effect; reconcile required");
    if (!operation.reused) {
      store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=?")
        .run(runId, row.run_id, worktreeId, row.run_id);
      store.finishOperation(operation.operationId, { worktree_id: worktreeId, path: canonical, branch: row.branch, from_run_id: row.run_id, to_run_id: runId });
      store.event(runId, "worktree.transferred", { worktreeId, fromRunId: row.run_id, path: canonical, branch: row.branch });
    }
    resolveTransferredWorktree(store, runId, worktreeId);
    return { worktree_id: worktreeId, branch: row.branch, path: canonical, base_commit: row.base_commit, reused: operation.reused };
  }

export async function recoverTaskWorktree(store: common.StateStore, ops: common.GitOperations, request: common.TaskWorktreeRecoveryRequest): Promise<common.TaskWorktreeRecoveryReceipt> {
    ops.assertGitOperator!(store, ops, request.toRunId, request.dispatchId);
    const target = ops.repositoryForRun!(store, ops, request.toRunId);
    if (!common.isPlannedRun(target.run) || target.run.plan_id !== request.toPlanId || target.run.revision !== request.toRevision) {
      throw new ValidationError("target run does not match the requested planned revision");
    }
    if (request.fromPlanId !== request.toPlanId) throw new ValidationError("task worktree recovery requires the same plan");
    if (!/^[a-f0-9]{40}$/.test(request.expectedHead)) throw new ValidationError("expected HEAD must be a full commit SHA");
    if (await realpath(request.project) !== await realpath(target.root)) throw new ValidationError("recovery project does not match the target run repository");

    const key = `worktree:recover:${request.fromPlanId}:${request.fromRevision}:${request.toRevision}:${request.toRunId}:${request.taskId}:${request.worktreeId}:${request.expectedHead}:${request.expectedSourceArtifact}`;
    const completed = store.db.prepare("SELECT operation_id,evidence_json FROM operations WHERE idempotency_key=? AND kind='git.worktree.recover' AND state='completed'")
      .get(key) as { operation_id: string; evidence_json: string } | undefined;
    if (completed) return { ...(JSON.parse(completed.evidence_json) as common.TaskWorktreeRecoveryReceipt), reused: true };

    const sourceRevision = store.db.prepare("SELECT state,digest,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(target.run.repo_id, request.fromPlanId, request.fromRevision) as { state: string; digest?: string; plan_commit?: string } | undefined;
    const targetRevision = store.db.prepare("SELECT state,digest,plan_commit,supersedes FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(target.run.repo_id, request.toPlanId, request.toRevision) as { state: string; digest?: string; plan_commit?: string; supersedes?: string } | undefined;
    if (!sourceRevision || !targetRevision || targetRevision.supersedes !== request.fromRevision) {
      throw new ValidationError("target revision must directly supersede the source revision in the same repository");
    }
    if (targetRevision.state !== "ready") throw new ValidationError("target superseding revision is not plan-ready");
    if (!targetRevision.digest || target.run.plan_digest !== targetRevision.digest) throw new ValidationError("target run plan digest does not match the superseding revision");

    const row = store.db.prepare("SELECT * FROM worktrees WHERE worktree_id=? AND state='active'").get(request.worktreeId) as any;
    if (!row) throw new ValidationError("active managed task worktree was not found");
    const sourceRun = store.getRun(row.run_id) as any;
    if (!common.isPlannedRun(sourceRun) || sourceRun.repo_id !== target.run.repo_id || sourceRun.plan_id !== request.fromPlanId || sourceRun.revision !== request.fromRevision) {
      throw new ValidationError("worktree owner does not match the requested source revision");
    }
    const sourceTask = store.db.prepare("SELECT * FROM run_tasks WHERE run_id=? AND task_id=?").get(row.run_id, request.taskId) as any;
    const targetTask = store.db.prepare("SELECT * FROM run_tasks WHERE run_id=? AND task_id=?").get(request.toRunId, request.taskId) as any;
    if (!sourceTask || !targetTask) throw new ValidationError("task ID must exist in both source and target revisions");
    const completedMerge = store.db.prepare(`SELECT 1 FROM operations WHERE kind='git.merge.task' AND state='completed'
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
    const metadataPath = String(sourceTask.source_path).replace(/\.md$/, ".metadata.json");
    if (metadataPath === sourceTask.source_path || !/^[a-f0-9]{40}$/.test(sourceRevision.plan_commit ?? "")) {
      throw new ValidationError("source task has no valid frozen sidecar metadata");
    }
    try {
      const source = execFileSync("git", ["-C", target.root, "show", `${sourceRevision.plan_commit}:${sourceTask.source_path}`], { encoding: "utf8" });
      const metadata = execFileSync("git", ["-C", target.root, "show", `${sourceRevision.plan_commit}:${metadataPath}`], { encoding: "utf8" });
      if (taskSourceDigest(sourceTask.source_path, source, metadataPath, metadata) !== sourceTask.source_digest) {
        throw new ValidationError("source task digest does not match frozen Markdown and sidecar metadata");
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError("source task sidecar metadata could not be read from the frozen plan commit");
    }
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

    const recoveryDispatchId = request.dispatchId;
    common.assertClaimed(store, common.dispatchOperations, request.toRunId, recoveryDispatchId, "git-operator");
    const dispatch = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=? AND run_id=?").get(recoveryDispatchId, request.toRunId) as { packet_json: string };
    const context = (JSON.parse(dispatch.packet_json) as { context?: Record<string, unknown> }).context ?? {};
    if (!(["recover_task_worktree", "reconcile_worktree_ownership"] as unknown[]).includes(context.phase)
      || context.task_id !== request.taskId
      || ![context.worktree_id, context.task_worktree_id, context.implementation_worktree_id].includes(request.worktreeId)) {
      throw new ValidationError("Git Operator dispatch is not bound to this task worktree recovery");
    }
    const activeHolder = store.db.prepare(`SELECT d.dispatch_id FROM dispatch_worktree_bindings b
      JOIN dispatches d ON d.dispatch_id=b.dispatch_id AND d.run_id=b.run_id
      WHERE b.worktree_id=? AND d.state='claimed' AND (? IS NULL OR d.dispatch_id!=?) LIMIT 1`)
      .get(request.worktreeId, recoveryDispatchId, recoveryDispatchId) as { dispatch_id: string } | undefined;
    if (activeHolder) throw new ValidationError("worktree is held by another active dispatch", { dispatch_id: activeHolder.dispatch_id });

    const artifacts = store.db.prepare(`SELECT a.artifact_id,a.sha256,a.dispatch_id,d.packet_json
      FROM artifacts a LEFT JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND a.kind='result' AND (a.artifact_id=? OR a.sha256=?)`).all(row.run_id, request.expectedSourceArtifact, request.expectedSourceArtifact) as Array<any>;
    const artifact = artifacts.find((candidate) => {
      const context = JSON.parse(candidate.packet_json ?? "{}").context ?? {};
      return context.task_id === request.taskId || candidate.dispatch_id === sourceTask.developer_dispatch_id || candidate.dispatch_id === sourceTask.test_dispatch_id;
    });
    if (!artifact) throw new ValidationError("expected source artifact does not match the source task lineage");

    const operationId = `op_${sha256(key).slice(0, 26)}`;
    const evidence: common.TaskWorktreeRecoveryReceipt = {
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
    };
    store.db.transaction(() => {
      store.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json,created_at,completed_at) VALUES (?,?,?,'git.worktree.recover','completed',?,?,?,?)")
        .run(operationId, request.toRunId, key, stableJson(operationRequest), stableJson(evidence), new Date().toISOString(), new Date().toISOString());
      const owner = store.db.prepare("UPDATE worktrees SET run_id=?,adopted_from_run_id=? WHERE worktree_id=? AND run_id=? AND state='active'")
        .run(request.toRunId, row.run_id, request.worktreeId, row.run_id);
      if (owner.changes !== 1) throw new ValidationError("worktree owner changed during recovery preflight");
      const task = store.db.prepare(`UPDATE run_tasks SET state=CASE state WHEN 'pending' THEN 'prepared' ELSE state END,worktree_id=?,updated_at=?
        WHERE run_id=? AND task_id=? AND (worktree_id IS NULL OR worktree_id=?)`)
        .run(request.worktreeId, new Date().toISOString(), request.toRunId, request.taskId, request.worktreeId);
      if (task.changes !== 1) throw new ValidationError("target task binding changed during recovery preflight");
      store.event(row.run_id, "worktree.recovery_released", { ...operationRequest, operation_id: operationId });
      store.event(request.toRunId, "worktree.recovered", { ...operationRequest, operation_id: operationId, receipt: evidence });
    })();
    return evidence;
  }

export async function applyTaskAuthority(store: common.StateStore, ops: common.GitOperations, request: common.TaskAuthorityApplyRequest): Promise<common.TaskAuthorityApplyReceipt> {
  ops.assertGitOperator!(store, ops, request.runId, request.dispatchId, "apply-task-authority");
  throw new IncompatibleError("task authority replacement is unsupported", {
    reason_code: "legacy_task_authority_replacement",
    next_action: "start_new_run",
  });
}

export async function continueTaskAuthorityConflict(store: common.StateStore, ops: common.GitOperations, runId: string, dispatchId: string): Promise<common.TaskAuthorityApplyReceipt> {
  ops.assertGitOperator!(store, ops, runId, dispatchId, "continue-task-authority-conflict");
  throw new IncompatibleError("task authority conflict continuation is unsupported", {
    reason_code: "legacy_task_authority_continuation",
    next_action: "start_new_run",
  });
}
