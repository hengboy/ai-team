import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Role } from "../constants.js";
import { createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { pathMatchesScope } from "../security.js";
import { assertExplicitTaskWritePaths } from "../state.js";
import { redact, sha256, stableJson } from "../utils.js";
import { resolveReviewWorktree } from "../worktree-review.js";
import { isBroadReadPath } from "./packet.js";
import { buildTestPacket } from "./implementation.js";
import { freezeAuthorityConflictContinuationExecutionContract, freezeExecutionContract } from "../execution-contract.js";
import * as common from "./store.js";
export function recoverClaimedTaskScope(store: common.StateStore, ops: common.DispatchOperations, input: {
    runId: string;
    dispatchId: string;
    authorityCommit: string;
    expectedHead: string;
    addedWritePaths: string[];
  }): common.ReplacementResult<"superseded"> & { role: "git-operator"; claim_command: string; authority_commit: string; allowed_write_paths: string[]; dirty_paths: string[] } {
    const run = store.getRun(input.runId) as { profile: string; mode?: string; state: string; repo_id: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") throw new ValidationError("claimed task scope recovery requires an active planned Coding run");
    ops.assertCommandAllowed!(store, ops, "coding", "dispatch supersede");
    if (!/^[a-f0-9]{40}$/.test(input.authorityCommit) || !/^[a-f0-9]{40}$/.test(input.expectedHead)) throw new ValidationError("scope recovery requires full authority and expected HEAD commit SHAs");
    const row = ops.get!(store, ops, input.runId, input.dispatchId, "backend-developer") as { state: string; packet_json: string; result_json?: string };
    const sourcePacket = JSON.parse(row.packet_json) as common.DispatchPacket;
    const taskId = typeof sourcePacket.context.task_id === "string" ? sourcePacket.context.task_id : undefined;
    const worktreeId = typeof sourcePacket.context.worktree_id === "string" ? sourcePacket.context.worktree_id : undefined;
    const worktreePath = typeof sourcePacket.context.worktree_path === "string" ? sourcePacket.context.worktree_path : undefined;
    if (!taskId || !worktreeId || !worktreePath) throw new ValidationError("claimed developer dispatch lacks frozen task worktree identity");
    const normalizedAddedPaths = assertExplicitTaskWritePaths(input.addedWritePaths, `scope recovery ${taskId}`);
    const existing = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(input.runId, input.dispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      const packet = JSON.parse(existing.packet_json) as common.DispatchPacket;
      const recovery = packet.context.scope_recovery as { authority_commit?: string; dirty_paths?: string[] } | undefined;
      if (recovery?.authority_commit !== input.authorityCommit || !normalizedAddedPaths.every((path) => packet.allowed_write_paths.includes(path))) {
        throw new ValidationError("claimed developer dispatch already has a different scope recovery replacement");
      }
      return {
        action: "superseded", dispatch_id: existing.dispatch_id, replacement_for: input.dispatchId, reused: true,
        role: "git-operator", claim_command: ops.claimCommand!(store, ops, input.runId, existing.dispatch_id),
        authority_commit: input.authorityCommit, allowed_write_paths: packet.allowed_write_paths, dirty_paths: recovery.dirty_paths ?? [],
      };
    }
    const task = ops.plannedTaskRows!(store, ops, input.runId).find((candidate) => candidate.task_id === taskId);
    if (!task || task.state === "integrated" || task.developer_dispatch_id && task.developer_dispatch_id !== input.dispatchId) {
      throw new ValidationError("claimed developer dispatch is not the active unintegrated task owner");
    }
    const originalPaths = ops.frozenTaskWritePaths!(store, ops, input.runId, taskId);
    const allowedWritePaths = [...new Set([...originalPaths, ...normalizedAddedPaths])].sort();
    if (row.state !== "claimed" || row.result_json) throw new ValidationError("scope recovery requires a claimed developer dispatch with no result");
    const sideEffects = store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM artifacts WHERE run_id=? AND dispatch_id=?) AS artifacts,
      (SELECT COUNT(*) FROM staging_entries WHERE run_id=? AND dispatch_id=?) AS staging`).get(input.runId, input.dispatchId, input.runId, input.dispatchId) as { artifacts: number; staging: number };
    if (sideEffects.artifacts || sideEffects.staging) throw new ValidationError("scope recovery requires a developer dispatch with no side effects", sideEffects);
    const worktree = store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(input.runId, worktreeId) as { path: string; state: string } | undefined;
    if (!worktree || worktree.state !== "active" || worktree.path !== worktreePath) throw new ValidationError("scope recovery worktree does not match its frozen task identity");
    const head = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== input.expectedHead) throw new ValidationError("scope recovery worktree HEAD does not match --expected-head", { expected: input.expectedHead, actual: head });
    const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("scope recovery repository is missing");
    const authority = execFileSync("git", ["-C", repository.project_path, "rev-parse", `${input.authorityCommit}^{commit}`], { encoding: "utf8" }).trim();
    if (authority !== input.authorityCommit) throw new ValidationError("scope recovery authority commit does not resolve exactly");
    try { execFileSync("git", ["-C", repository.project_path, "merge-base", "--is-ancestor", authority, "HEAD"], { stdio: "ignore" }); }
    catch { throw new ValidationError("scope recovery authority commit is not reachable from the current main checkout"); }
    const authorityPaths = execFileSync("git", ["-C", repository.project_path, "diff-tree", "--no-commit-id", "--name-only", "-r", authority], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const unsupported = normalizedAddedPaths.filter((path) => !authorityPaths.includes(path));
    if (unsupported.length) throw new ValidationError("scope recovery authority commit does not contain every added write path", { authority_commit: authority, unsupported_paths: unsupported });
    const dirtyPaths = common.dirtyWorktreePaths(worktree.path);
    const outOfScope = dirtyPaths.filter((path) => !pathMatchesScope(path, allowedWritePaths));
    if (outOfScope.length) throw new ValidationError("scope recovery would not preserve dirty paths within the replacement scope", { dirty_paths: outOfScope });
    const packet = common.validatePacket({
      ...sourcePacket,
      objective: `Apply the recorded authority commit for ${taskId} without changing its task worktree HEAD or losing its dirty work.`,
      allowed_read_paths: [],
      allowed_write_paths: allowedWritePaths,
      acceptance_criteria: [
        "Apply only the recorded authority commit into the frozen task worktree",
        "Preserve the frozen task worktree identity, HEAD, and dirty work",
        "Record only the authority application receipt",
      ],
      context: {
        ...sourcePacket.context,
        stage: "git-operator",
        phase: "apply_task_authority",
        operation: "apply-task-authority",
        authority_commit: authority,
        expected_head: input.expectedHead,
        superseded_developer_dispatch_id: input.dispatchId,
        scope_recovery: {
          authority_commit: authority,
          expected_head: input.expectedHead,
          original_allowed_write_paths: originalPaths,
          added_write_paths: normalizedAddedPaths,
          allowed_write_paths: allowedWritePaths,
          dirty_paths: dirtyPaths,
        },
      },
    }, "git-operator");
    let replacementId = "";
    store.db.transaction(() => {
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=? AND state='claimed'").run(new Date().toISOString(), input.dispatchId);
      replacementId = ops.insert!(store, ops, input.runId, "git-operator", packet, input.dispatchId);
      const updated = store.db.prepare(`UPDATE run_tasks SET write_paths_json=?,developer_dispatch_id=?,updated_at=?
        WHERE run_id=? AND task_id=? AND (developer_dispatch_id=? OR developer_dispatch_id IS NULL) AND state!='integrated'`).run(stableJson(allowedWritePaths), null, new Date().toISOString(), input.runId, taskId, input.dispatchId);
      if (updated.changes !== 1) throw new ValidationError("task ownership changed during claimed scope recovery");
      store.event(input.runId, "dispatch.superseded", { dispatchId: input.dispatchId, replacement_dispatch_id: replacementId, role: "backend-developer", actor_role: "coding", reason: "frozen task scope expanded by explicit authority commit" });
      store.event(input.runId, "task.scope_recovered", { task_id: taskId, worktree_id: worktreeId, authority_commit: authority, expected_head: input.expectedHead, original_allowed_write_paths: originalPaths, allowed_write_paths: allowedWritePaths, dirty_paths: dirtyPaths, superseded_dispatch_id: input.dispatchId, replacement_dispatch_id: replacementId });
    })();
    return {
      action: "superseded", dispatch_id: replacementId, replacement_for: input.dispatchId, reused: false,
      role: "git-operator", claim_command: ops.claimCommand!(store, ops, input.runId, replacementId),
      authority_commit: authority, allowed_write_paths: allowedWritePaths, dirty_paths: dirtyPaths,
    };
  }

export function repairClaimedTaskScopeReplacement(store: common.StateStore, ops: common.DispatchOperations, input: { runId: string; dispatchId: string }): {
    action: "repaired";
    dispatch_id: string;
    role: "git-operator";
    claim_command: string;
    reused: boolean;
  } {
    const run = store.getRun(input.runId) as { profile: string; mode?: string; state: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") {
      throw new ValidationError("claimed task scope replacement repair requires an active planned Coding run");
    }
    const row = store.db.prepare(`SELECT role,state,packet_json,result_json,replacement_for FROM dispatches
      WHERE run_id=? AND dispatch_id=?`).get(input.runId, input.dispatchId) as {
      role: Role; state: string; packet_json: string; result_json?: string; replacement_for?: string;
    } | undefined;
    if (!row) throw new ValidationError("dispatch identity does not match run");
    const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
    const context = packet.context as Record<string, unknown>;
    const claimCommand = ops.claimCommand!(store, ops, input.runId, input.dispatchId);
    if (row.role === "git-operator" && context.operation === "apply-task-authority") {
      if (row.state !== "pending" || context.phase !== "apply_task_authority" || context.operation !== "apply-task-authority") {
        throw new ValidationError("dispatch is not a repaired task authority replacement");
      }
      return { action: "repaired", dispatch_id: input.dispatchId, role: "git-operator", claim_command: claimCommand, reused: true };
    }
    if ((row.role !== "backend-developer" && row.role !== "git-operator") || row.state !== "pending" || row.result_json || !row.replacement_for) {
      throw new ValidationError("dispatch is not an unclaimed legacy task authority replacement");
    }
    const source = store.db.prepare(`SELECT role,state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?`)
      .get(input.runId, row.replacement_for) as { role: Role; state: string; packet_json: string } | undefined;
    if (!source || source.role !== "backend-developer" || source.state !== "failed") {
      throw new ValidationError("legacy task authority replacement has invalid superseded developer lineage");
    }
    const sourceContext = (JSON.parse(source.packet_json) as common.DispatchPacket).context as Record<string, unknown>;
    const recovery = context.scope_recovery as Record<string, unknown> | undefined;
    const sourceFields = ["task_id", "worktree_id", "worktree_path", "explorer_dispatch_id", "coordinator_dispatch_id", "prepare_git_dispatch_id"];
    const scopeFields = ["authority_commit", "expected_head"];
    const originalPaths = recovery?.original_allowed_write_paths;
    const addedPaths = recovery?.added_write_paths;
    const recoveredPaths = Array.isArray(originalPaths) && Array.isArray(addedPaths)
      && [...originalPaths, ...addedPaths].every((path) => typeof path === "string")
      ? [...new Set([...originalPaths, ...addedPaths] as string[])].sort() : undefined;
    if (sourceFields.some((key) => typeof sourceContext[key] !== "string" || !sourceContext[key])
      || scopeFields.some((key) => typeof recovery?.[key] !== "string" || !recovery?.[key])
      || (context.task_id !== undefined && context.task_id !== sourceContext.task_id)
      || (context.worktree_id !== undefined && context.worktree_id !== sourceContext.worktree_id)
      || (context.worktree_path !== undefined && context.worktree_path !== sourceContext.worktree_path)
      || (context.superseded_developer_dispatch_id !== undefined && context.superseded_developer_dispatch_id !== row.replacement_for)
      || !recoveredPaths || stableJson(recoveredPaths) !== stableJson([...packet.allowed_write_paths].sort())) {
      throw new ValidationError("legacy task authority replacement is missing frozen recovery lineage");
    }
    const sideEffects = store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM artifacts WHERE run_id=? AND dispatch_id=?) AS artifacts,
      (SELECT COUNT(*) FROM staging_entries WHERE run_id=? AND dispatch_id=?) AS staging`).get(input.runId, input.dispatchId, input.runId, input.dispatchId) as { artifacts: number; staging: number };
    if (sideEffects.artifacts || sideEffects.staging) throw new ValidationError("legacy task authority replacement already has side effects");
    const unfrozen = { ...packet };
    delete unfrozen.execution_contract;
    delete unfrozen.execution_request;
    const lineageContext = { ...context };
    delete lineageContext.context_owner;
    delete lineageContext.context_maintenance;
    const corrected = freezeExecutionContract("git-operator", ops.freezeVerificationContext!(store, ops, input.runId, "git-operator", common.validatePacket({
      ...unfrozen,
      objective: `Apply the recorded authority commit for ${context.task_id} without changing its task worktree HEAD or losing its dirty work.`,
      allowed_read_paths: [],
      acceptance_criteria: [
        "Apply only the recorded authority commit into the frozen task worktree",
        "Preserve the frozen task worktree identity, HEAD, and dirty work",
        "Record only the authority application receipt",
      ],
      context: {
        ...lineageContext,
        stage: "git-operator",
        phase: "apply_task_authority",
        operation: "apply-task-authority",
        task_id: sourceContext.task_id,
        worktree_id: sourceContext.worktree_id,
        worktree_path: sourceContext.worktree_path,
        explorer_dispatch_id: sourceContext.explorer_dispatch_id,
        coordinator_dispatch_id: sourceContext.coordinator_dispatch_id,
        prepare_git_dispatch_id: sourceContext.prepare_git_dispatch_id,
        authority_commit: recovery!.authority_commit,
        expected_head: recovery!.expected_head,
        superseded_developer_dispatch_id: row.replacement_for,
        scope_recovery: { ...recovery, allowed_write_paths: [...packet.allowed_write_paths].sort() },
      },
    }, "git-operator"))) as common.DispatchPacket;
    const packetJson = redact(stableJson(corrected));
    const prompt = redact(common.promptFor(input.runId, input.dispatchId, "git-operator", corrected));
    const schemaJson = stableJson(resultSchemaForRole("git-operator"));
    const templateJson = stableJson(createResultTemplate(input.runId, input.dispatchId, "git-operator"));
    store.db.transaction(() => {
      store.db.prepare(`UPDATE dispatches SET role='git-operator',packet_json=?,prompt='',schema_json=?,template_json=?,
        packet_digest=?,prompt_digest=?,schema_digest=?,template_digest=?,renderer_version=? WHERE run_id=? AND dispatch_id=? AND role IN ('backend-developer','git-operator') AND state='pending'`)
      .run(packetJson, schemaJson, templateJson, sha256(packetJson), sha256(prompt), sha256(schemaJson), sha256(templateJson), common.RENDERER_VERSION, input.runId, input.dispatchId);
      store.event(input.runId, "dispatch.claimed_task_scope_replacement_repaired", {
        dispatch_id: input.dispatchId,
        replacement_for: row.replacement_for,
        from_role: row.role,
        role: "git-operator",
        operation: "apply-task-authority",
        authority_commit: context.authority_commit,
        expected_head: context.expected_head,
      });
    })();
    return { action: "repaired", dispatch_id: input.dispatchId, role: "git-operator", claim_command: claimCommand, reused: false };
  }

export function claimedRecoveryMayFinish(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, dispatch: { state: string; packet_json: string }, runState: string): boolean {
    if (role !== "git-operator" || dispatch.state !== "claimed" || runState !== "retryable_failure") return false;
    const packet = JSON.parse(dispatch.packet_json) as common.DispatchPacket;
    const batchId = packet.context.recovery_batch_id;
    if (packet.context.phase !== "recover_task_worktree" || typeof batchId !== "string" || !batchId) return false;
    const current = store.db.prepare("SELECT claimed_at FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId) as { claimed_at?: string } | undefined;
    if (!current?.claimed_at) return false;
    return Boolean(store.db.prepare(`SELECT 1 FROM dispatches
      WHERE run_id=? AND dispatch_id!=? AND state='retryable_failure' AND completed_at>=?
      AND json_extract(packet_json,'$.context.phase')='recover_task_worktree'
      AND json_extract(packet_json,'$.context.recovery_batch_id')=? LIMIT 1`)
      .get(runId, dispatchId, current.claimed_at, batchId));
  }

export function assertPlannedTaskTestScope(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, packet: common.DispatchPacket): void {
    const run = store.getRun(runId) as { mode?: string };
    if (run.mode !== "planned" || packet.context.phase !== "task_test") return;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : "";
    const worktreeId = typeof packet.context.worktree_id === "string" ? packet.context.worktree_id : "";
    const task = store.db.prepare("SELECT task_id,worktree_id,developer_dispatch_id,write_paths_json FROM run_tasks WHERE run_id=? AND task_id=?")
      .get(runId, taskId) as { task_id: string; worktree_id?: string; developer_dispatch_id?: string; write_paths_json?: string } | undefined;
    if (!task || !task.developer_dispatch_id || task.worktree_id !== worktreeId) {
      throw new ValidationError("planned Test task/worktree/developer binding does not match frozen run task", {
        offending_task_id: taskId, offending_test_dispatch_id: dispatchId, offending_worktree_id: worktreeId,
        frozen_worktree_id: task?.worktree_id ?? null, frozen_developer_dispatch_id: task?.developer_dispatch_id ?? null,
      });
    }
    const developer = store.db.prepare("SELECT packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'")
      .get(runId, task.developer_dispatch_id) as { packet_json: string; result_json?: string } | undefined;
    if (!developer?.result_json) throw new ValidationError("planned Test requires its completed frozen developer result");
    const developerPacket = JSON.parse(developer.packet_json) as common.DispatchPacket;
    if (developerPacket.context.task_id !== taskId || developerPacket.context.worktree_id !== worktreeId) {
      throw new ValidationError("planned developer packet does not match frozen run task identity", {
        offending_task_id: taskId, offending_dispatch_id: task.developer_dispatch_id, offending_worktree_id: worktreeId,
      });
    }
    if (!task.write_paths_json) throw new ValidationError(`legacy frozen Task paths require managed scope recovery: ${taskId}`);
    const actual = [...new Set((((JSON.parse(developer.result_json) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []))].sort();
    if (!actual.length) throw new ValidationError("planned Test requires non-empty developer modified_paths");
    const frozenPaths = JSON.parse(task.write_paths_json) as string[];
    const scopeRow = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
      .get(runId, worktreeId) as { payload_json: string } | undefined;
    if (!scopeRow) throw new ValidationError("planned Test requires an existing immutable pre_commit scope for its worktree", {
      offending_task_id: taskId, offending_dispatch_id: task.developer_dispatch_id, offending_test_dispatch_id: dispatchId, offending_worktree_id: worktreeId,
      actual_modified_paths: actual, frozen_task_paths: frozenPaths, developer_allowed_write_paths: developerPacket.allowed_write_paths,
      pre_commit_paths: [], pre_commit_digest: null, unauthorized_paths: actual,
    });
    const scope = JSON.parse(scopeRow.payload_json) as { paths?: string[]; digest?: string; snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null };
    const preCommitPaths = [...new Set(scope.paths ?? [])].sort();
    const recoveredSnapshotRow = !scope.snapshot ? store.db.prepare(`SELECT payload_json FROM run_events
      WHERE run_id=? AND type='scope.pre_commit_snapshot_recovered'
      AND json_extract(payload_json,'$.worktree_id')=? AND json_extract(payload_json,'$.original_scope_digest')=?
      AND json_extract(payload_json,'$.task_id')=? AND json_extract(payload_json,'$.developer_dispatch_id')=?
      ORDER BY event_id DESC LIMIT 1`).get(runId, worktreeId, scope.digest, taskId, task.developer_dispatch_id) as { payload_json: string } | undefined : undefined;
    const recoveredSnapshot = recoveredSnapshotRow
      ? (JSON.parse(recoveredSnapshotRow.payload_json) as { snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } }).snapshot
      : undefined;
    const expectedSnapshot = scope.snapshot ?? recoveredSnapshot ?? null;
    const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
    const snapshot = worktree ? common.plannedWorktreeSnapshot(worktree.path) : null;
    const unauthorized = [...new Set([
      ...actual.filter((path) => !pathMatchesScope(path, frozenPaths)
        || !pathMatchesScope(path, developerPacket.allowed_write_paths) || !preCommitPaths.includes(path)),
      ...preCommitPaths.filter((path) => !actual.includes(path)),
    ])].sort();
    const snapshotChanged = !expectedSnapshot || !snapshot || stableJson(expectedSnapshot) !== stableJson(snapshot);
    if (scope.digest !== sha256(stableJson(preCommitPaths)) || unauthorized.length || snapshotChanged) {
      const details = {
        offending_task_id: taskId,
        offending_dispatch_id: task.developer_dispatch_id,
        offending_test_dispatch_id: dispatchId,
        offending_worktree_id: worktreeId,
        actual_modified_paths: actual,
        frozen_task_paths: frozenPaths,
        developer_allowed_write_paths: developerPacket.allowed_write_paths,
        pre_commit_paths: preCommitPaths,
        pre_commit_digest: scope.digest ?? null,
        unauthorized_paths: unauthorized,
        original_snapshot: expectedSnapshot,
        snapshot,
        snapshot_changed: snapshotChanged,
      };
      store.db.transaction(() => {
        store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        store.event(runId, "scope.pre_commit_drift", details);
      })();
      throw new ValidationError("planned developer paths are not authorized by the frozen Task and immutable pre_commit scope; run frozen", details);
    }
  }

export function changeStage(store: common.StateStore, ops: common.DispatchOperations, runId: string, stage: string, dispatchId: string): void {
    store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(stage, new Date().toISOString(), runId);
    store.event(runId, "run.stage_changed", { stage, dispatchId });
  }

export function plannedTaskRows(store: common.StateStore, ops: common.DispatchOperations, runId: string): ReturnType<common.StateStore["runTasks"]> {
    const run = store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
    if (run.mode !== "planned") return [];
    const tasks = store.runTasks(runId);
    if (tasks.length && run.plan_id && run.revision) {
      const revision = store.db.prepare("SELECT digest FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { digest?: string } | undefined;
      if (revision?.digest && run.plan_digest !== revision.digest) throw new ValidationError("planned task manifest plan_digest does not match the frozen revision");
    }
    return tasks;
  }

export function frozenTaskWritePaths(store: common.StateStore, ops: common.DispatchOperations, runId: string, taskId: string): string[] {
    const task = ops.plannedTaskRows!(store, ops, runId).find((candidate) => candidate.task_id === taskId);
    if (!task) throw new ValidationError(`unknown frozen run task: ${taskId}`);
    if (!task.write_paths_json) throw new ValidationError(`legacy frozen Task paths require managed scope recovery: ${taskId}`);
    return JSON.parse(task.write_paths_json) as string[];
  }

export function testCommandSnapshot(store: common.StateStore, ops: common.DispatchOperations, runId: string, worktreePath: string, explorerDispatchId: string): {
    commands: string[];
    provenance: { explorer_dispatch_id: string; plan_id: string | null; revision: string | null; repo_id: string };
  } {
    const run = store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string };
    const packagePath = join(worktreePath, "package.json");
    let packageJson: { scripts?: Record<string, string> };
    try { packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> }; }
    catch { throw new ValidationError("Test packet requires a readable current-repository package.json"); }
    const scripts = packageJson.scripts ?? {};
    const commands: string[] = [];
    if (run.plan_id && run.revision) {
      let plan = "";
      const revision = store.db.prepare("SELECT plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { plan_commit?: string } | undefined;
      if (revision?.plan_commit) {
        if (!/^[a-f0-9]{40}$/.test(revision.plan_commit)) throw new ValidationError("Test packet requires a valid frozen plan commit");
        const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
        if (!repository) throw new ValidationError("Test packet repository is not registered");
        const planPath = `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/plan.md`;
        try { plan = execFileSync("git", ["-C", repository.project_path, "show", `${revision.plan_commit}:${planPath}`], { encoding: "utf8" }); }
        catch { throw new ValidationError("Test packet could not read plan.md from the frozen plan commit"); }
      }
      for (const match of plan.matchAll(/`(npm\s+(?:run\s+)?[A-Za-z0-9:_-]+(?:\s+--\s+[^`]+)?)`/g)) {
        const command = match[1]!.trim();
        const script = command.match(/^npm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/)?.[1];
        if (!script || typeof scripts[script] !== "string") throw new ValidationError(`frozen plan references an unknown package script: ${command}`);
        const pathText = command.match(/\s--\s+(.+)$/)?.[1];
        for (const raw of pathText?.split(/\s+/) ?? []) {
          const path = raw.replace(/^['"]|['"]$/g, "");
          if (!path || path.startsWith("-") || /[*?{}]/.test(path)) continue;
          const root = realpathSync(worktreePath);
          const candidate = resolve(root, path);
          const lexicalRelative = relative(root, candidate);
          if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative) || !existsSync(candidate)) {
            throw new ValidationError(`frozen test command path does not exist inside the current repository: ${path}`);
          }
          const canonicalRelative = relative(root, realpathSync(candidate));
          if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
            throw new ValidationError(`frozen test command path escapes the current repository: ${path}`);
          }
        }
        commands.push(command);
      }
    }
    for (const script of ["test", "typecheck", "lint", "build"]) {
      if (typeof scripts[script] === "string") commands.push(`npm run ${script}`);
    }
    const frozen = [...new Set(commands)];
    if (!frozen.length) throw new ValidationError("Test packet requires at least one command from the current repository package.json or frozen plan");
    return {
      commands: frozen,
      provenance: {
        explorer_dispatch_id: explorerDispatchId,
        plan_id: run.plan_id ?? null,
        revision: run.revision ?? null,
        repo_id: run.repo_id,
      },
    };
  }

export function reconcilePlannedTaskStates(store: common.StateStore, ops: common.DispatchOperations, runId: string): void {
    const tasks = ops.plannedTaskRows!(store, ops, runId);
    if (!tasks.length) return;
    for (const task of tasks) {
      const taskKey = task.task_id.toLowerCase();
      const worktree = (task.worktree_id
        ? store.db.prepare("SELECT worktree_id,branch,base_commit FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, task.worktree_id)
        : store.db.prepare(`SELECT worktree_id,branch,base_commit FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)
          ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`)) as { worktree_id: string; branch: string; base_commit: string } | undefined;
      const developer = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, task.task_id) as { dispatch_id: string } | undefined;
      const taskTest = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='completed'
        AND json_extract(packet_json,'$.context.phase')='task_test' AND json_extract(packet_json,'$.context.task_id')=? ORDER BY completed_at DESC LIMIT 1`)
        .get(runId, task.task_id) as { dispatch_id: string } | undefined;
      const commit = worktree ? (store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { evidence_json?: string } | undefined) : undefined;
      const merge = worktree ? (store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
        AND json_extract(evidence_json,'$.task_worktree_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { evidence_json?: string } | undefined) : undefined;
      const commitEvidence = JSON.parse(commit?.evidence_json ?? "{}") as { commit?: string };
      const mergeEvidence = JSON.parse(merge?.evidence_json ?? "{}") as { commit?: string };
      if (merge && mergeEvidence.commit) store.advanceRunTask(runId, task.task_id, "integrated", {
        recovered: task.state !== "committed",
        ...(worktree ? { worktree_id: worktree.worktree_id } : {}),
        ...(developer ? { developer_dispatch_id: developer.dispatch_id } : {}),
        ...(taskTest ? { test_dispatch_id: taskTest.dispatch_id } : {}),
        ...(commitEvidence.commit ? { implementation_commit: commitEvidence.commit } : {}),
        integration_commit: mergeEvidence.commit,
      });
      else if (commit && commitEvidence.commit) {
        const evidence = {
          ...(worktree ? { worktree_id: worktree.worktree_id } : {}),
          ...(developer ? { developer_dispatch_id: developer.dispatch_id } : {}),
          ...(taskTest ? { test_dispatch_id: taskTest.dispatch_id } : {}),
          implementation_commit: commitEvidence.commit,
        };
        store.advanceRunTask(runId, task.task_id, "committed", { recovered: task.state !== "tested", ...evidence });
        if (worktree?.branch.startsWith("plan/")) {
          store.advanceRunTask(runId, task.task_id, "integrated", { ...evidence, integration_commit: commitEvidence.commit });
        }
      }
      else if (taskTest) store.advanceRunTask(runId, task.task_id, "tested", { recovered: task.state !== "implemented", ...(worktree ? { worktree_id: worktree.worktree_id } : {}), ...(developer ? { developer_dispatch_id: developer.dispatch_id } : {}), test_dispatch_id: taskTest.dispatch_id });
      else if (developer) store.advanceRunTask(runId, task.task_id, "implemented", { recovered: task.state !== "prepared", ...(worktree ? { worktree_id: worktree.worktree_id } : {}), developer_dispatch_id: developer.dispatch_id });
      else if (worktree) {
        const integration = ops.activeIntegrationWorktree!(store, ops, runId);
        const currentPlanHead = integration ? execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : undefined;
        if (worktree.branch.startsWith("task/") && currentPlanHead && worktree.base_commit !== currentPlanHead) continue;
        store.advanceRunTask(runId, task.task_id, "prepared", { recovered: task.state !== "pending", worktree_id: worktree.worktree_id });
      }
    }
  }

export function handlePrematurePlannedTest(store: common.StateStore, ops: common.DispatchOperations, runId: string): void {
    const tasks = ops.plannedTaskRows!(store, ops, runId);
    if (!tasks.length || tasks.every(({ state }) => state === "integrated")) return;
    const tests = store.db.prepare(`SELECT dispatch_id,state,packet_json FROM dispatches WHERE run_id=? AND role='test' AND state IN ('pending','claimed','completed','failed','retryable_failure')
      ORDER BY created_at`).all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string }>;
    const handledIds = new Set((store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.premature_handled'").all(runId) as Array<{ payload_json: string }>)
      .map(({ payload_json }) => (JSON.parse(payload_json) as { dispatch_id: string }).dispatch_id));
    const premature = tests.filter(({ dispatch_id, packet_json }) => !handledIds.has(dispatch_id) && (JSON.parse(packet_json) as common.DispatchPacket).context.phase !== "task_test");
    if (!premature.length) return;
    store.db.transaction(() => {
      for (const test of premature) {
        store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), test.dispatch_id);
        store.event(runId, "test.premature_handled", { dispatch_id: test.dispatch_id, previous_state: test.state, incomplete_task_ids: tasks.filter(({ state }) => state !== "integrated").map(({ task_id }) => task_id) });
      }
      const commits = premature.map(({ packet_json }) => (JSON.parse(packet_json) as common.DispatchPacket).context.implementation_commit).filter((commit): commit is string => typeof commit === "string");
      for (const commit of commits) {
        const reviewers = store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state IN ('pending','claimed','completed')
          AND json_extract(packet_json,'$.context.revision_sha')=?`).all(runId, commit) as Array<{ dispatch_id: string; state: string }>;
        for (const reviewer of reviewers) {
          store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), reviewer.dispatch_id);
          store.event(runId, "review.premature_handled", { dispatch_id: reviewer.dispatch_id, previous_state: reviewer.state, revision_sha: commit });
        }
      }
      store.db.prepare("UPDATE runs SET stage='coding',state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    })();
  }

export function ensureNextPlannedTaskPrepare(store: common.StateStore, ops: common.DispatchOperations, runId: string): string | undefined {
    const tasks = ops.plannedTaskRows!(store, ops, runId);
    if (!tasks.length) return undefined;
    const next = tasks.find(({ state }) => state !== "integrated");
    if (!next || next.state !== "pending") return undefined;
    if (tasks.slice(0, next.ordinal).some(({ state }) => state !== "integrated")) return undefined;
    const predecessorCleanupPending = tasks.slice(0, next.ordinal).some((task) => {
      if (!task.worktree_id) return false;
      const worktree = store.db.prepare("SELECT branch,state FROM worktrees WHERE worktree_id=? AND run_id=?")
        .get(task.worktree_id, runId) as { branch: string; state: string } | undefined;
      if (!worktree || !worktree.branch.startsWith("task/")) return false;
      const cleanup = store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
        AND json_extract(request_json,'$.task_worktree_id')=? ORDER BY created_at DESC LIMIT 1`)
        .get(runId, task.worktree_id) as { state: string } | undefined;
      return worktree.state !== "removed" || cleanup?.state !== "completed";
    });
    if (predecessorCleanupPending) return undefined;
    const integration = ops.activeIntegrationWorktree!(store, ops, runId);
    if (!integration) throw new ValidationError("planned task prepare requires the active plan worktree");
    const baseCommit = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const recovery = ops.pendingPlannedTaskRecovery!(store, ops, runId, next.task_id);
    if (recovery) {
      const existingRecovery = store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
        AND json_extract(packet_json,'$.context.phase')='recover_task_worktree'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
      if (existingRecovery) return existingRecovery.dispatch_id;
      const existingPrepare = store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
        AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
      if (existingPrepare?.state === "completed") return existingPrepare.dispatch_id;
      if (existingPrepare && !ops.prepareDispatchHasNoSideEffects!(store, ops, runId, existingPrepare.dispatch_id)) {
        throw new ValidationError("claimed planned task prepare has recorded side effects and requires reconciliation before task worktree recovery");
      }
      const coordinator = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
      if (!coordinator) return undefined;
      const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
      const explorerDispatchId = typeof coordinatorPacket.context.explorer_dispatch_id === "string"
        ? coordinatorPacket.context.explorer_dispatch_id
        : (store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { dispatch_id?: string } | undefined)?.dispatch_id;
      if (!explorerDispatchId) throw new ValidationError("planned task recovery requires completed Explorer provenance");
      const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
        objective: `Recover ${next.task_id}'s existing managed worktree into this directly superseding planned revision.`,
        allowed_read_paths: [],
        allowed_write_paths: [],
        acceptance_criteria: [
          "Execute only the frozen recover-task-worktree operation",
          "Preserve the frozen source worktree owner, HEAD, source artifact lineage, and dirty paths",
          "Do not prepare, rebuild, adopt, transfer, or clean a task worktree",
        ],
        context: {
          stage: "git-operator",
          phase: "recover_task_worktree",
          operation: "recover-task-worktree",
          task_id: next.task_id,
          explorer_dispatch_id: explorerDispatchId,
          coordinator_dispatch_id: coordinator.dispatch_id,
          project: recovery.project,
          worktree_id: recovery.worktree_id,
          source_run_id: recovery.source_run_id,
          source_worktree_owner_run_id: recovery.source_run_id,
          from_plan_id: recovery.plan_id,
          from_revision: recovery.revision,
          to_plan_id: recovery.plan_id,
          to_revision: recovery.target_revision,
          to_run_id: runId,
          expected_head: recovery.expected_head,
          expected_source_artifact: recovery.artifact_id,
          expected_source_artifact_digest: recovery.artifact_digest,
        },
      }, "git-operator"), existingPrepare?.dispatch_id);
      if (existingPrepare) {
        store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), existingPrepare.dispatch_id);
        store.event(runId, "dispatch.prepare_superseded_for_task_recovery", {
          dispatch_id: existingPrepare.dispatch_id,
          replacement_dispatch_id: dispatchId,
          task_id: next.task_id,
          reason: "pending source-owned planned task worktree recovery lineage",
        });
      }
      ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
      return dispatchId;
    }
    const taskKey = next.task_id.toLowerCase();
    const taskWorktree = store.db.prepare(`SELECT worktree_id,base_commit FROM worktrees WHERE run_id=? AND state='active'
      AND (branch LIKE ? OR branch LIKE ?) ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string; base_commit: string } | undefined;
    const existing = store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'
      AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
    const staleWorktree = taskWorktree && taskWorktree.base_commit !== baseCommit ? taskWorktree : undefined;
    if (existing && !staleWorktree) return existing.dispatch_id;
    const coordinator = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) return undefined;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
    const explorerDispatchId = typeof coordinatorPacket.context.explorer_dispatch_id === "string"
      ? coordinatorPacket.context.explorer_dispatch_id
      : (store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { dispatch_id?: string } | undefined)?.dispatch_id;
    if (!explorerDispatchId) throw new ValidationError("planned task prepare requires completed Explorer provenance");
    const resolvedTests = new Set((store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.predecessor_repair_resolved' ORDER BY event_id")
      .all(runId) as Array<{ payload_json: string }>).flatMap(({ payload_json }) => {
        const ids = (JSON.parse(payload_json) as { handled_test_dispatch_ids?: unknown }).handled_test_dispatch_ids;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      }));
    const recoveredTests = (store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.premature_handled' ORDER BY event_id")
      .all(runId) as Array<{ payload_json: string }>).map(({ payload_json }) => (JSON.parse(payload_json) as { dispatch_id: string }).dispatch_id);
    const handledTests = recoveredTests.filter((dispatchId) => !resolvedTests.has(dispatchId)).map((dispatchId) => {
      const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, dispatchId) as { artifact_id: string; sha256: string } | undefined;
      const dispatch = store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId) as { result_json?: string } | undefined;
      const result = JSON.parse(dispatch?.result_json ?? "{}") as { payload?: { checks?: Array<{ command?: unknown; outcome?: unknown }> } };
      const failedChecks = (result.payload?.checks ?? []).filter(({ outcome }) => !common.successfulOutcome(outcome)).flatMap(({ command, outcome }) =>
        typeof command === "string" ? [{ command, outcome: String(outcome ?? "unknown") }] : []);
      return {
        dispatch_id: dispatchId,
        ...(artifact ? { artifact_id: artifact.artifact_id, digest: artifact.sha256 } : {}),
        failed_checks: failedChecks,
      };
    });
    const predecessorCommands = [...new Set(handledTests.flatMap(({ failed_checks }) => failed_checks.map(({ command }) => command)))];
    const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: `Prepare ${next.task_id} from the current plan HEAD after every earlier frozen Task is integrated.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Create exactly one task worktree from the frozen current plan HEAD", "Do not repeat an already integrated Task"],
      context: {
        stage: "git-operator",
        phase: "prepare_implementation_worktree",
        task_id: next.task_id,
        explorer_dispatch_id: explorerDispatchId,
        coordinator_dispatch_id: coordinator.dispatch_id,
        base_commit: baseCommit,
        previous_task_ids: tasks.slice(0, next.ordinal).map(({ task_id }) => task_id),
        ...(staleWorktree ? { replace_worktree_id: staleWorktree.worktree_id, replace_base_commit: staleWorktree.base_commit } : {}),
        ...(handledTests.length ? { predecessor_repair: { required: true, handled_tests: handledTests, required_commands: predecessorCommands } } : {}),
      },
    }, "git-operator"), existing?.dispatch_id);
    if (existing && existing.state !== "completed") {
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), existing.dispatch_id);
    }
    if (staleWorktree) store.event(runId, "worktree.stale_reprepare_created", {
      dispatch_id: dispatchId,
      replacement_for: existing?.dispatch_id ?? null,
      task_id: next.task_id,
      worktree_id: staleWorktree.worktree_id,
      stale_base_commit: staleWorktree.base_commit,
      required_base_commit: baseCommit,
    });
    ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
    return dispatchId;
  }

export function createPlannedTaskTest(store: common.StateStore, ops: common.DispatchOperations, runId: string, developerDispatchId: string): string | undefined {
    const developer = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND state='completed'")
      .get(runId, developerDispatchId) as { packet_json: string } | undefined;
    if (!developer) return undefined;
    const packet = JSON.parse(developer.packet_json) as common.DispatchPacket;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    if (!taskId || !ops.plannedTaskRows!(store, ops, runId).some((task) => task.task_id === taskId)) return undefined;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.phase')='task_test' AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, taskId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const worktreeId = String(packet.context.worktree_id);
    const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
    const explorerDispatchId = typeof packet.context.explorer_dispatch_id === "string" ? packet.context.explorer_dispatch_id : undefined;
    if (!worktree || !explorerDispatchId) throw new ValidationError("planned task Test requires its worktree and Explorer provenance");
    const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'").get(runId, developerDispatchId) as { artifact_id: string; sha256: string } | undefined;
    if (!artifact) throw new ValidationError("planned task Test requires the implementation artifact");
    const frozen = ops.testCommandSnapshot!(store, ops, runId, worktree.path, explorerDispatchId);
    const dispatchId = ops.insert!(store, ops, runId, "test", common.validatePacket({
      objective: `Independently verify ${taskId} in its prepared task worktree before commit.`,
      allowed_read_paths: packet.allowed_read_paths,
      allowed_write_paths: [],
      acceptance_criteria: ["Run every frozen task test command", "Do not commit or integrate the task"],
      context: {
        stage: "test",
        phase: "task_test",
        task_id: taskId,
        explorer_dispatch_id: explorerDispatchId,
        worktree_id: worktreeId,
        worktree_path: worktree.path,
        implementation_dispatch_id: developerDispatchId,
        implementation_artifact: { artifact_id: artifact.artifact_id, digest: artifact.sha256 },
        implementation_committed: false,
        test_commands: frozen.commands,
        test_command_provenance: frozen.provenance,
      },
    }, "test"));
    ops.changeStage!(store, ops, runId, "test", dispatchId);
    return dispatchId;
  }

export function completedImplementationOperation(store: common.StateStore, ops: common.DispatchOperations, runId: string): { commit: string; paths: string[]; kind: string } | undefined {
    const rows = store.db.prepare("SELECT kind,evidence_json FROM operations WHERE run_id=? AND kind IN ('git.merge.task','git.commit') AND state='completed' ORDER BY completed_at DESC, CASE kind WHEN 'git.merge.task' THEN 0 ELSE 1 END").all(runId) as Array<{ kind: string; evidence_json?: string }>;
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (/^[a-f0-9]{40}$/.test(evidence.commit ?? "")) return { commit: evidence.commit!, paths: evidence.paths ?? [], kind: row.kind };
      } catch { /* malformed legacy evidence is not implementation proof */ }
    }
    return undefined;
  }

export function activeIntegrationWorktree(store: common.StateStore, ops: common.DispatchOperations, runId: string): { worktree_id: string; path: string } | undefined {
    return resolveReviewWorktree(store, runId);
  }

export function createPlannedCodingDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, explorerDispatchId: string | undefined, gitDispatchId: string): string {
    const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const explorer = explorerDispatchId
      ? store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned Coding dispatch requires its completed Explorer dependency");
    const result = JSON.parse(explorer.result_json) as ResultEnvelope;
    const allowedReadPaths = ((result.payload.allowed_read_paths as string[] | undefined) ?? [])
      .filter((path) => !isBroadReadPath(path));
    const worktree = ops.activeIntegrationWorktree!(store, ops, runId);
    if (!worktree) throw new ValidationError("planned Coding dispatch requires the verified plan worktree");
    const tasks = ops.plannedTaskRows!(store, ops, runId);
    if (tasks.length === 1 && tasks[0]!.state === "pending") {
      store.advanceRunTask(runId, tasks[0]!.task_id, "prepared", { worktree_id: worktree.worktree_id });
    }
    const dispatchId = ops.create!(store, ops, runId, "coding", {
      objective: "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles.",
      allowed_read_paths: allowedReadPaths,
      allowed_write_paths: [],
      acceptance_criteria: ["Use the verified run-owned plan worktree", "Create Task worktrees only for a frozen plan with multiple explicit TASK files"],
      context: {
        stage: "coding",
        explorer_dispatch_id: explorerDispatchId,
        git_operator_dispatch_id: gitDispatchId,
        worktree_id: worktree.worktree_id,
        plan_worktree_path: worktree.path,
        ...(tasks.length === 1 ? { task_id: tasks[0]!.task_id } : {}),
      },
    }, "coding");
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function ensurePlannedTaskContinuation(store: common.StateStore, ops: common.DispatchOperations, runId: string, prepareDispatchId?: string): string | undefined {
    const run = store.getRun(runId) as { profile: string; mode?: string; state: string; plan_id?: string; revision?: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") return undefined;
    const prepare = (prepareDispatchId
      ? store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree')`).get(runId, prepareDispatchId)
      : store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree') ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!prepare) return undefined;
    const preparePacket = JSON.parse(prepare.packet_json) as common.DispatchPacket;
    const prepareContext = preparePacket.context as Record<string, unknown>;
    const taskId = typeof prepareContext.task_id === "string" ? prepareContext.task_id : "";
    if (!/^TASK-\d{3}$/.test(taskId)) return undefined;
    const existing = store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')='continue_implementation'
      AND json_extract(packet_json,'$.context.prepare_git_dispatch_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, prepare.dispatch_id) as { dispatch_id: string; state: string } | undefined;
    if (existing) return existing.state === "pending" || existing.state === "claimed" ? existing.dispatch_id : undefined;
    const taskKey = taskId.toLowerCase();
    const worktree = store.db.prepare(`SELECT worktree_id,path FROM worktrees WHERE run_id=? AND state='active'
      AND (branch LIKE ? OR branch LIKE ?) ORDER BY created_at DESC LIMIT 1`)
      .get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string; path: string } | undefined;
    if (!worktree) throw new ValidationError("planned task continuation requires the prepared task worktree");
    const developer = store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer') AND state!='failed'
      AND json_extract(packet_json,'$.context.worktree_id')=?`).get(runId, worktree.worktree_id);
    if (developer) return undefined;
    const requestedCoordinatorId = typeof prepareContext.coordinator_dispatch_id === "string" ? prepareContext.coordinator_dispatch_id : undefined;
    const coordinator = (requestedCoordinatorId
      ? store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'").get(runId, requestedCoordinatorId)
      : store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) throw new ValidationError("planned task continuation requires its completed Coding coordinator");
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
    const explorerDispatchId = typeof prepareContext.explorer_dispatch_id === "string"
      ? prepareContext.explorer_dispatch_id
      : typeof coordinatorPacket.context.explorer_dispatch_id === "string" ? coordinatorPacket.context.explorer_dispatch_id : undefined;
    const explorer = explorerDispatchId
      ? store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned task continuation requires its completed Explorer authorization");
    const explorerResult = JSON.parse(explorer.result_json) as ResultEnvelope;
    const authorizedPaths = explorerResult.payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) throw new ValidationError("planned task continuation requires valid Explorer paths");
    const allowedReadPaths = authorizedPaths.filter((path) => !isBroadReadPath(path));
    const packet = common.validatePacket({
      objective: `Continue ${taskId} by dispatching one developer role in its prepared task worktree${prepareContext.predecessor_repair ? ", including the recorded predecessor repair" : ""}.`,
      allowed_read_paths: allowedReadPaths,
      allowed_write_paths: [],
      acceptance_criteria: [
        "Dispatch a developer with the frozen task worktree identity",
        "Preserve the completed Explorer authorization and prepare lineage",
        ...(prepareContext.predecessor_repair ? ["Resolve the handled predecessor Test findings before implementing this Task"] : []),
      ],
      context: {
        stage: "coding",
        phase: "continue_implementation",
        explorer_dispatch_id: explorerDispatchId,
        coordinator_dispatch_id: coordinator.dispatch_id,
        prepare_git_dispatch_id: prepare.dispatch_id,
        task_id: taskId,
        worktree_id: worktree.worktree_id,
        worktree_path: worktree.path,
        plan_id: run.plan_id ?? null,
        revision: run.revision ?? null,
        ...(prepareContext.predecessor_repair ? { predecessor_repair: prepareContext.predecessor_repair } : {}),
      },
    }, "coding");
    common.assertExplorerAuthorization(store, runId, "coding", packet);
    const dispatchId = ops.insert!(store, ops, runId, "coding", packet, coordinator.dispatch_id);
    store.event(runId, "coding.continue_implementation_created", {
      dispatchId,
      task_id: taskId,
      worktree_id: worktree.worktree_id,
      prepare_git_dispatch_id: prepare.dispatch_id,
      replacement_for: coordinator.dispatch_id,
    });
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function ensureRecoveredTaskDeveloperDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, authorityDispatchId: string, allowReconciledTaskRecovery = false): string | undefined {
    const authority = store.db.prepare(`SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state IN ('completed','failed')
      AND json_extract(packet_json,'$.context.phase')='apply_task_authority'`).get(runId, authorityDispatchId) as { packet_json: string } | undefined;
    if (!authority) return undefined;
    const authorityPacket = JSON.parse(authority.packet_json) as common.DispatchPacket;
    const context = authorityPacket.context as Record<string, unknown>;
    const taskId = typeof context.task_id === "string" ? context.task_id : undefined;
    const sourceId = typeof context.superseded_developer_dispatch_id === "string" ? context.superseded_developer_dispatch_id : undefined;
    const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : undefined;
    const worktreePath = typeof context.worktree_path === "string" ? context.worktree_path : undefined;
    if (!taskId || !sourceId || !worktreeId || !worktreePath) throw new ValidationError("authority application continuation lacks frozen developer lineage");
    const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? AND role='backend-developer' ORDER BY created_at LIMIT 1")
      .get(runId, sourceId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const source = store.db.prepare("SELECT packet_json,state FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='backend-developer'")
      .get(runId, sourceId) as { packet_json: string; state: string } | undefined;
    if (!source || source.state !== "failed") throw new ValidationError("authority application source developer was not superseded");
    const task = ops.plannedTaskRows!(store, ops, runId).find((candidate) => candidate.task_id === taskId);
    const isReconciledTaskOwner = task?.developer_dispatch_id === sourceId
      || task?.developer_dispatch_id === authorityDispatchId;
    const recoveringReconciledTask = allowReconciledTaskRecovery
      && (task?.state === "prepared" || task?.state === "implemented")
      && isReconciledTaskOwner;
    const normallyReadyTask = task?.state === "prepared" && !task.developer_dispatch_id;
    if (!normallyReadyTask && !recoveringReconciledTask) {
      throw new ValidationError("authority application task is no longer ready for its replacement developer");
    }
    const worktree = store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(runId, worktreeId) as { path: string; state: string } | undefined;
    if (!worktree || worktree.state !== "active" || worktree.path !== worktreePath) throw new ValidationError("authority application worktree identity changed before developer replacement");
    const sourcePacket = JSON.parse(source.packet_json) as common.DispatchPacket;
    const unfrozenSource = { ...sourcePacket };
    delete unfrozenSource.execution_contract;
    const packet = common.validatePacket({
      ...unfrozenSource,
      allowed_write_paths: authorityPacket.allowed_write_paths,
      context: {
        ...sourcePacket.context,
        phase: "implementation",
        authority_apply_git_dispatch_id: authorityDispatchId,
        scope_recovery: {
          ...(context.scope_recovery as Record<string, unknown>),
          authority_apply_git_dispatch_id: authorityDispatchId,
        },
      },
    }, "backend-developer");
    let replacementId = "";
    store.db.transaction(() => {
      replacementId = ops.insert!(store, ops, runId, "backend-developer", packet, sourceId);
      const updated = recoveringReconciledTask
        ? store.db.prepare(`UPDATE run_tasks SET state='prepared',developer_dispatch_id=?,updated_at=?
          WHERE run_id=? AND task_id=? AND developer_dispatch_id IN (?,?) AND state IN ('prepared','implemented')`)
          .run(replacementId, new Date().toISOString(), runId, taskId, sourceId, authorityDispatchId)
        : store.db.prepare(`UPDATE run_tasks SET developer_dispatch_id=?,updated_at=?
          WHERE run_id=? AND task_id=? AND developer_dispatch_id IS NULL AND state='prepared'`)
          .run(replacementId, new Date().toISOString(), runId, taskId);
      if (updated.changes !== 1) throw new ValidationError("authority application task ownership changed during developer replacement");
      store.event(runId, "coding.developer_dispatch_created", {
        dispatch_id: replacementId,
        source: "scope_recovery",
        task_id: taskId,
        worktree_id: worktreeId,
        superseded_developer_dispatch_id: sourceId,
        authority_apply_git_dispatch_id: authorityDispatchId,
      });
    })();
    ops.changeStage!(store, ops, runId, "coding", replacementId);
    return replacementId;
  }

export function ensurePlannedTaskDeveloperDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, continuationDispatchId?: string, source: "completion" | "resume" = "resume"): string | undefined {
    const run = store.getRun(runId) as { profile: string; mode?: string; state: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") return undefined;
    const continuation = (continuationDispatchId
      ? store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='continue_implementation'`).get(runId, continuationDispatchId)
      : store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='continue_implementation' ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!continuation) return undefined;
    const coordinator = JSON.parse(continuation.packet_json) as common.DispatchPacket;
    const context = coordinator.context as Record<string, unknown>;
    const taskId = typeof context.task_id === "string" ? context.task_id : undefined;
    const explorerDispatchId = typeof context.explorer_dispatch_id === "string" ? context.explorer_dispatch_id : undefined;
    const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : undefined;
    const worktreePath = typeof context.worktree_path === "string" ? context.worktree_path : undefined;
    const prepareDispatchId = typeof context.prepare_git_dispatch_id === "string" ? context.prepare_git_dispatch_id : undefined;
    if (!taskId || !explorerDispatchId || !worktreeId || !worktreePath || !prepareDispatchId) return undefined;
    const task = ops.plannedTaskRows!(store, ops, runId).find((candidate) => candidate.task_id === taskId);
    if (!task || task.state !== "prepared" || task.developer_dispatch_id) return undefined;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')
      AND state IN ('pending','claimed','completed') AND json_extract(packet_json,'$.context.coordinator_dispatch_id')=? LIMIT 1`)
      .get(runId, continuation.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return undefined;
    const prepare = store.db.prepare(`SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state='completed'
      AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree')`)
      .get(runId, prepareDispatchId) as { packet_json: string } | undefined;
    const prepareTaskId = prepare ? (JSON.parse(prepare.packet_json) as common.DispatchPacket).context.task_id : undefined;
    if (prepareTaskId !== taskId) throw new ValidationError("planned task developer requires its frozen prepare lineage");
    const worktree = store.db.prepare("SELECT path,branch FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
      .get(runId, worktreeId) as { path: string; branch: string } | undefined;
    if (!worktree || worktree.path !== worktreePath || !worktree.branch.startsWith("task/")) {
      throw new ValidationError("planned task developer requires its prepared active task worktree");
    }
    const developer = common.validatePacket({
      objective: `Implement ${taskId} in its frozen prepared task worktree.`,
      allowed_read_paths: coordinator.allowed_read_paths,
      allowed_write_paths: ops.frozenTaskWritePaths!(store, ops, runId, taskId),
      acceptance_criteria: [
        "Implement only the frozen Task scope",
        "Preserve the frozen Explorer, coordinator, prepare, and worktree lineage",
      ],
      context: {
        stage: "coding",
        phase: "implementation",
        explorer_dispatch_id: explorerDispatchId,
        coordinator_dispatch_id: continuation.dispatch_id,
        prepare_git_dispatch_id: prepareDispatchId,
        task_id: taskId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        ...(context.predecessor_repair !== undefined ? { predecessor_repair: context.predecessor_repair } : {}),
      },
    }, "backend-developer");
    ops.assertCommandAllowed!(store, ops, "coding", "dispatch create");
    ops.assertContinueImplementationDelegation!(store, ops, runId, continuation.dispatch_id, "backend-developer", coordinator, developer);
    const frozenDeveloper = freezeExecutionContract("backend-developer", ops.freezeVerificationContext!(store, ops, runId, "backend-developer", developer)) as common.DispatchPacket;
    common.assertExplorerAuthorization(store, runId, "backend-developer", frozenDeveloper);
    const dispatchId = ops.insert!(store, ops, runId, "backend-developer", frozenDeveloper);
    store.event(runId, "coding.developer_dispatch_created", {
      dispatch_id: dispatchId,
      source,
      coordinator_dispatch_id: continuation.dispatch_id,
      prepare_git_dispatch_id: prepareDispatchId,
      task_id: taskId,
      worktree_id: worktreeId,
      explorer_dispatch_id: explorerDispatchId,
    });
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function ensureGitPrepareDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, target: "integration" | "implementation", explorerDispatchId?: string): string {
    const phase = target === "integration" ? "prepare_worktrees" : "prepare_implementation_worktree";
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')=?
      ORDER BY created_at DESC LIMIT 1`).get(runId, phase) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = store.getRun(runId) as { base_commit?: string; mode?: string };
    return ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: target === "integration"
        ? run.mode === "planned" ? "Verify the plan worktree prepared for this planned run." : "Prepare the integration worktree for this run."
        : "Prepare the implementation task worktree after the direct pre_write scope gate.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: target === "integration"
        ? [run.mode === "planned" ? "Verify the active plan worktree already owned by this run" : "Register one active integration worktree owned by this run"]
        : ["Register the active implementation task worktree owned by this run from the run base commit"],
      context: {
        stage: "git-operator",
        phase,
        ...(target === "implementation" ? { task_id: "implementation" } : {}),
        ...(explorerDispatchId ? { explorer_dispatch_id: explorerDispatchId } : {}),
        base_commit: run.base_commit ?? null,
      },
    }, "git-operator"));
  }

export function assertGitPrepareResult(store: common.StateStore, ops: common.DispatchOperations, runId: string, packet: common.DispatchPacket): void {
    const context = packet.context as { phase?: unknown; task_id?: unknown; worktree_id?: unknown; worktree_ids?: unknown; operation?: unknown; authority_commit?: unknown; expected_head?: unknown; task_worktree_id?: unknown; integration_worktree_id?: unknown; merge_operation_id?: unknown };
    if (context.phase === "prepare_worktrees") {
      const worktree = ops.activeIntegrationWorktree!(store, ops, runId);
      if (!worktree) throw new ValidationError("prepare_worktrees requires a registered active integration worktree or plan worktree owned by this run");
    }
    if (context.phase === "prepare_implementation_worktree") {
      const taskId = typeof context.task_id === "string" ? context.task_id.toLowerCase() : "implementation";
      const worktree = store.db.prepare("SELECT 1 FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)")
        .get(runId, `task/%/${taskId}`, `task/%--${taskId}`);
      if (!worktree) throw new ValidationError("prepare_implementation_worktree requires a registered active implementation task worktree owned by this run");
    }
    if (context.phase === "recover_task_worktree") {
      const taskId = typeof context.task_id === "string" ? context.task_id : "";
      const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : "";
      if (!/^TASK-\d{3}$/.test(taskId) || !worktreeId) {
        throw new ValidationError("recover_task_worktree requires its frozen recovery operation and task worktree identity");
      }
      if (context.operation === undefined) return;
      if (context.operation !== "recover-task-worktree") {
        throw new ValidationError("recover_task_worktree requires its frozen recovery operation and task worktree identity");
      }
      const recovered = store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.worktree.recover' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? AND json_extract(evidence_json,'$.task_id')=? LIMIT 1`).get(runId, worktreeId, taskId);
      if (!recovered) throw new ValidationError("recover_task_worktree requires its completed recovery receipt");
    }
    if (context.phase === "cleanup_integrated_task") {
      const taskWorktreeId = typeof context.task_worktree_id === "string" ? context.task_worktree_id : "";
      const integrationWorktreeId = typeof context.integration_worktree_id === "string" ? context.integration_worktree_id : "";
      const mergeOperationId = typeof context.merge_operation_id === "string" ? context.merge_operation_id : "";
      const cleanup = store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
        AND json_extract(request_json,'$.task_worktree_id')=? AND json_extract(request_json,'$.integration_worktree_id')=?
        AND json_extract(request_json,'$.merge_operation_id')=? ORDER BY completed_at DESC LIMIT 1`)
        .get(runId, taskWorktreeId, integrationWorktreeId, mergeOperationId) as { state: string } | undefined;
      if (!cleanup || cleanup.state !== "completed") throw new ValidationError("cleanup_integrated_task requires its completed cleanup operation");
    }
    if (context.phase === "apply_task_authority") {
      const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : "";
      const authorityCommit = typeof context.authority_commit === "string" ? context.authority_commit : "";
      const expectedHead = typeof context.expected_head === "string" ? context.expected_head : "";
      const applied = store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.task_authority.apply' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? AND json_extract(evidence_json,'$.authority_commit')=?
        AND json_extract(evidence_json,'$.head')=? LIMIT 1`).get(runId, worktreeId, authorityCommit, expectedHead);
      if (!applied) throw new ValidationError("apply_task_authority requires its completed authority application receipt");
    }
    if (context.phase === "reconcile_worktree_ownership") {
      if (!Array.isArray(context.worktree_ids) || !context.worktree_ids.length || context.worktree_ids.some((id) => typeof id !== "string")) {
        throw new ValidationError("ownership reconciliation requires registered worktree ids");
      }
      const owned = context.worktree_ids.every((worktreeId) => store.db.prepare("SELECT 1 FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId));
      if (!owned) throw new ValidationError("ownership reconciliation did not transfer every worktree to this run");
    }
  }

export function ensureIntegrationDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, taskWorktreeIds: string[], integrationWorktreeId: string, taskBindings: Array<{ task_id: string | null; worktree_id: string }>): string {
    const existing = (store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed')
      AND json_extract(packet_json,'$.context.phase')='integrate_implementation'
      ORDER BY created_at DESC`).all(runId) as Array<{ dispatch_id: string; packet_json: string }>).find(({ packet_json }) => {
        const ids = (JSON.parse(packet_json) as common.DispatchPacket).context.task_worktree_ids;
        return stableJson(Array.isArray(ids) ? [...ids].sort() : []) === stableJson([...taskWorktreeIds].sort());
      });
    if (existing) return existing.dispatch_id;
    const onlyTaskBinding = taskBindings[0];
    const taskBinding = taskBindings.length === 1 && onlyTaskBinding?.task_id ? onlyTaskBinding : undefined;
    return ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: "Merge the next completed frozen Task into the current plan worktree before preparing its successor.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge every listed task worktree exactly once", "Return the frozen integration HEAD"],
      context: {
        stage: "git-operator",
        phase: "integrate_implementation",
        integration_worktree_id: integrationWorktreeId,
        task_worktree_ids: taskWorktreeIds,
        ...(taskBinding ? {
          task_id: taskBinding.task_id,
          task_worktree_id: taskBinding.worktree_id,
          implementation_worktree_id: taskBinding.worktree_id,
          worktree_id: taskBinding.worktree_id,
        } : {}),
      },
    }, "git-operator"));
  }

export function implementationSnapshot(store: common.StateStore, ops: common.DispatchOperations, runId: string): common.ImplementationSnapshot | undefined {
    const run = store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
    const frozenTasks = ops.plannedTaskRows!(store, ops, runId);
    const coordinator = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    const developers = store.db.prepare(`SELECT d.dispatch_id,d.state,d.result_json,d.packet_json,d.completed_at FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer')
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)`).all(runId) as Array<{ dispatch_id: string; state: string; result_json?: string; packet_json: string; completed_at?: string }>;
    if (!coordinator || !developers.length || developers.some((item) => item.state !== "completed")) return undefined;
    const developerBindings = developers.map((item) => {
      try {
        const context = (JSON.parse(item.packet_json) as { context?: { task_id?: string; worktree_id?: string } }).context;
        return context?.worktree_id ? { task_id: context.task_id ?? null, worktree_id: context.worktree_id } : undefined;
      } catch { return undefined; }
    });
    if (developerBindings.some((value) => !value)) return undefined;
    const taskBindings = developerBindings as Array<{ task_id: string | null; worktree_id: string }>;
    const taskWorktreeIds = [...new Set(taskBindings.map(({ worktree_id }) => worktree_id))];
    const integration = ops.activeIntegrationWorktree!(store, ops, runId);
    if (!integration) return undefined;
    const usesPlanWorktreeDirectly = run.mode === "planned" && taskWorktreeIds.length === 1 && taskWorktreeIds[0] === integration.worktree_id;
    const commitOperations = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>;
    const committedWorktrees = new Set(commitOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.worktree_id === "string" ? [evidence.worktree_id] : []; }
      catch { return []; }
    }));
    if (!usesPlanWorktreeDirectly && taskWorktreeIds.some((worktreeId) => !committedWorktrees.has(worktreeId))) return undefined;
    const mergeOperations = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' ORDER BY completed_at").all(runId) as Array<{ evidence_json?: string }>;
    const mergedWorktrees = new Set(mergeOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.task_worktree_id === "string" ? [evidence.task_worktree_id] : []; }
      catch { return []; }
    }));
    const unmergedWorktreeIds = taskWorktreeIds.filter((worktreeId) => !mergedWorktrees.has(worktreeId));
    if (!usesPlanWorktreeDirectly && unmergedWorktreeIds.length) {
      ops.ensureIntegrationDispatch!(store, ops, 
        runId,
        unmergedWorktreeIds,
        integration.worktree_id,
        taskBindings.filter(({ worktree_id }) => unmergedWorktreeIds.includes(worktree_id)),
      );
      return undefined;
    }
    if (frozenTasks.length && frozenTasks.some(({ state }) => state !== "integrated")) return undefined;
    const implementation = ops.completedImplementationOperation!(store, ops, runId);
    if (usesPlanWorktreeDirectly && implementation && implementation.kind !== "git.commit" || !usesPlanWorktreeDirectly && implementation?.kind !== "git.merge.task") return undefined;
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (implementation && implementation.commit !== integrationHead) return undefined;
    if (!implementation) return undefined;
    const integrationRow = store.db.prepare("SELECT base_commit FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(runId, integration.worktree_id) as { base_commit: string } | undefined;
    if (!integrationRow?.base_commit) return undefined;
    const changedPaths = execFileSync("git", ["-C", integration.path, "diff", "--name-only", `${integrationRow.base_commit}..${implementation.commit}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    if (!changedPaths.length) return undefined;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
    const authorizedPaths = explorer?.result_json
      ? (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths
      : [...new Set([...developers.flatMap((developer) => (JSON.parse(developer.packet_json) as common.DispatchPacket).allowed_read_paths), "package.json"])];
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    if (!explorer && (store.getRun(runId) as { mode?: string }).mode === "planned") return undefined;
    if (run.mode === "planned" && frozenTasks.length) {
      const developerWritePaths = developers.flatMap((developer) => (JSON.parse(developer.packet_json) as common.DispatchPacket).allowed_write_paths);
      const frozenTaskWritePaths = frozenTasks.flatMap((task) => ops.frozenTaskWritePaths!(store, ops, runId, task.task_id));
      const unauthorizedPaths = changedPaths.filter((path) =>
        !pathMatchesScope(path, developerWritePaths) || !pathMatchesScope(path, frozenTaskWritePaths));
      if (unauthorizedPaths.length) throw new ValidationError("planned implementation paths are not authorized by frozen Task write paths", {
        offending_dispatch_id: developers.find((developer) => {
          try {
            const modifiedPaths = ((JSON.parse(developer.result_json ?? "{}") as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? [];
            return modifiedPaths.some((path) => unauthorizedPaths.includes(path));
          } catch { return false; }
        })?.dispatch_id ?? coordinator.dispatch_id,
        unauthorized_paths: unauthorizedPaths,
        authorization_source_expected: "frozen Task write paths + developer packet allowed_write_paths + planned pre_commit scope",
        explorer_paths: authorizedPaths,
        frozen_task_write_paths: [...new Set(frozenTaskWritePaths)],
        pre_commit_scope_digest: sha256(stableJson([...new Set(developerWritePaths)].sort())),
      });
    } else if (changedPaths.some((path) => !pathMatchesScope(path, authorizedPaths as string[]))) {
      throw new ValidationError("implementation paths are not authorized by Explorer evidence");
    }
    const implementationArtifacts = developers.map((developer) => {
      const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, developer.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      const taskId = (JSON.parse(developer.packet_json) as common.DispatchPacket).context.task_id;
      return artifact ? { ...(typeof taskId === "string" ? { task_id: taskId } : {}), dispatch_id: developer.dispatch_id, artifact_id: artifact.artifact_id, digest: artifact.sha256 } : undefined;
    });
    if (implementationArtifacts.some((artifact) => !artifact)) return undefined;
    if (frozenTasks.length) {
      const artifactTaskIds = new Set(implementationArtifacts.map((artifact) => artifact?.task_id).filter((taskId): taskId is string => typeof taskId === "string"));
      if (frozenTasks.some(({ task_id }) => !artifactTaskIds.has(task_id))) return undefined;
    }
    const primary = [...developers].sort((left, right) => (right.completed_at ?? "").localeCompare(left.completed_at ?? ""))[0]!;
    const primaryArtifact = implementationArtifacts[developers.indexOf(primary)]!;
    if (!explorer?.dispatch_id) return undefined;
    const frozenCommands = ops.testCommandSnapshot!(store, ops, runId, integration.path, explorer.dispatch_id);
    return {
      coordinatorDispatchId: coordinator.dispatch_id,
      explorerDispatchId: explorer?.dispatch_id ?? null,
      authorizedPaths: authorizedPaths as string[],
      developerDispatchIds: developers.map(({ dispatch_id }) => dispatch_id),
      implementationDispatchId: primary.dispatch_id,
      implementationArtifact: { artifact_id: primaryArtifact!.artifact_id, digest: primaryArtifact!.digest },
      implementationArtifacts: implementationArtifacts as common.ImplementationSnapshot["implementationArtifacts"],
      implementationCommit: implementation.commit,
      implementationCommitted: true,
      changedPaths,
      worktreeId: integration.worktree_id,
      worktreePath: integration.path,
      planId: run.plan_id ?? null,
      revision: run.revision ?? null,
      planDigest: run.plan_digest ?? null,
      frozenTaskIds: frozenTasks.map(({ task_id }) => task_id),
      testCommands: frozenCommands.commands,
      testCommandProvenance: frozenCommands.provenance,
    };
  }

export function testPacket(store: common.StateStore, ops: common.DispatchOperations, snapshot: common.ImplementationSnapshot, coordinatorDispatchId?: string): common.DispatchPacket {
    return common.validatePacket(buildTestPacket(snapshot, coordinatorDispatchId), "test");
  }

export function createTestDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, snapshot: common.ImplementationSnapshot, coordinatorDispatchId?: string): string {
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, snapshot.implementationCommit) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = ops.insert!(store, ops, runId, "test", ops.testPacket!(store, ops, snapshot, coordinatorDispatchId));
    ops.changeStage!(store, ops, runId, "test", dispatchId);
    return dispatchId;
  }

export function advanceImplementation(store: common.StateStore, ops: common.DispatchOperations, runId: string): void {
    const snapshot = ops.implementationSnapshot!(store, ops, runId);
    if (!snapshot) return;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=?`).get(runId, snapshot.implementationCommit);
    if (existing) return;
    const dispatchId = ops.createTestDispatch!(store, ops, runId, snapshot);
    store.event(runId, "test.dispatch_created", { dispatchId, implementation_dispatch_id: snapshot.implementationDispatchId, implementation_artifact_id: snapshot.implementationArtifact.artifact_id });
  }

export function createAuthorityConflictContinuation(store: common.StateStore, ops: common.DispatchOperations, input: {
    runId: string;
    authorityDispatchId: string;
    operationId: string;
    worktreeId: string;
    authorityCommit: string;
    expectedHead: string;
    dirtyPaths: string[];
    authorityPaths: string[];
    conflictPaths: string[];
    stashCommit: string;
  }): { dispatch_id: string; reused: boolean } {
    const source = store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(input.runId, input.authorityDispatchId) as { state: string; packet_json: string } | undefined;
    const sourcePacket = source ? JSON.parse(source.packet_json) as common.DispatchPacket : undefined;
    const context = sourcePacket?.context;
    const dirtyPaths = [...new Set(input.dirtyPaths)].sort();
    const authorityPaths = [...new Set(input.authorityPaths)].sort();
    const conflictPaths = [...new Set(input.conflictPaths)].sort();
    if (!source || !sourcePacket || source.state !== "claimed" || context?.phase !== "apply_task_authority" || context.operation !== "apply-task-authority"
      || context.worktree_id !== input.worktreeId || context.authority_commit !== input.authorityCommit || context.expected_head !== input.expectedHead
      || !Array.isArray(context.scope_recovery && (context.scope_recovery as Record<string, unknown>).allowed_write_paths)
      || [...dirtyPaths, ...authorityPaths].some((path) => !pathMatchesScope(path, sourcePacket.allowed_write_paths))) {
      throw new ValidationError("authority conflict continuation does not match the claimed frozen authority packet");
    }
    const continuationContext = {
      ...context,
      stage: "git-operator",
      phase: "continue_task_authority_conflict",
      operation: "continue-task-authority-conflict",
      authority_apply_operation_id: input.operationId,
      authority_apply_dispatch_id: input.authorityDispatchId,
      dirty_paths: dirtyPaths,
      authority_paths: authorityPaths,
      conflict_paths: conflictPaths,
      stash_commit: input.stashCommit,
      allowed_write_paths: [...sourcePacket.allowed_write_paths].sort(),
    };
    const packet = freezeAuthorityConflictContinuationExecutionContract(common.validatePacket({
      objective: `Resolve the recorded authority content conflict for ${String(context.task_id)} without changing its frozen task worktree HEAD or losing its dirty work.`,
      allowed_read_paths: [],
      allowed_write_paths: [...sourcePacket.allowed_write_paths],
      acceptance_criteria: [
        "Resolve only the recorded authority content conflict within the frozen task write paths",
        "Preserve the frozen task worktree HEAD and recorded dirty paths",
        "Record only the authority application receipt",
      ],
      context: continuationContext,
    }, "git-operator"), sourcePacket);
    const packetJson = redact(stableJson(packet));
    const existing = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(input.runId, input.authorityDispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      if (existing.packet_json !== packetJson) throw new ValidationError("authority conflict already has a different continuation");
      return { dispatch_id: existing.dispatch_id, reused: true };
    }
    let dispatchId = "";
    store.db.transaction(() => {
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE run_id=? AND dispatch_id=? AND state='claimed'")
        .run(new Date().toISOString(), input.runId, input.authorityDispatchId);
      dispatchId = ops.insert!(store, ops, input.runId, "git-operator", packet, input.authorityDispatchId);
      store.event(input.runId, "worktree.task_authority_conflict_continuation_created", {
        authority_apply_dispatch_id: input.authorityDispatchId,
        continuation_dispatch_id: dispatchId,
        operation_id: input.operationId,
        worktree_id: input.worktreeId,
        authority_commit: input.authorityCommit,
        expected_head: input.expectedHead,
        dirty_paths: dirtyPaths,
        authority_paths: authorityPaths,
        conflict_paths: conflictPaths,
        stash_commit: input.stashCommit,
      });
    })();
    return { dispatch_id: dispatchId, reused: false };
  }
