import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Role } from "../constants.js";
import { type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { pathMatchesScope } from "../security.js";
import { assertExplicitTaskWritePaths } from "../state.js";
import { taskSourceDigest } from "../planning.js";
import { sha256, stableJson } from "../utils.js";
import { completedMergeOwnershipPartialEffect, type MergeOwnershipPartialEffect } from "../worktree-ownership.js";
import { livenessRecoveryIntent, reconciliationIntent, retryableResultHasNoSideEffects } from "./recovery.js";
import { recoveryProjection } from "../run-recovery.js";
import * as common from "./store.js";
export function recoveryReplacement(store: common.StateStore, ops: common.DispatchOperations, runId: string, failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string }, resolvedDecision?: Record<string, unknown>, replacementFor = failed.dispatch_id, additionalVerification: unknown[] = []): string {
    const previous = JSON.parse(failed.packet_json) as common.DispatchPacket;
    const result = failed.result_json ? JSON.parse(failed.result_json) as ResultEnvelope : undefined;
    let root = failed;
    const lineagePackets: common.DispatchPacket[] = [previous];
    while (root.replacement_for) {
      const parent = store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
        .get(runId, root.replacement_for) as typeof root | undefined;
      if (!parent) break;
      root = parent;
      lineagePackets.push(JSON.parse(parent.packet_json) as common.DispatchPacket);
    }
    const rootPacket = JSON.parse(root.packet_json) as common.DispatchPacket;
    const lineageRecovery = lineagePackets.map((packet) => (packet.context as { recovery?: { completed_verification?: unknown[]; source_artifact_id?: string | null; source_artifact_digest?: string | null; source_packet_digest?: string | null } }).recovery).filter(Boolean);
    const completedVerification = lineageRecovery.flatMap((recovery) => recovery?.completed_verification ?? []);
    const originalRecovery = [...lineageRecovery].reverse().find((recovery) => recovery?.source_packet_digest || recovery?.source_artifact_id);
    const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? ORDER BY created_at DESC LIMIT 1")
      .get(runId, failed.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const activeWorktree = store.db.prepare("SELECT worktree_id,path,branch FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { worktree_id: string; path: string; branch: string } | undefined;
    const adoption = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.worktree.adopt' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { evidence_json?: string } | undefined;
    const adoptionEvidence = adoption?.evidence_json ? JSON.parse(adoption.evidence_json) as { implementation_revision?: string } : undefined;
    const previousContext = previous.context as { worktree_id?: unknown; implementation_worktree_id?: unknown; recovery?: { completed_verification?: unknown[]; source_artifact_id?: string | null; source_artifact_digest?: string | null; source_packet_digest?: string | null } };
    const worktreeContext = activeWorktree && (typeof previousContext.worktree_id === "string" || typeof previousContext.implementation_worktree_id === "string") ? {
      worktree_id: activeWorktree.worktree_id,
      implementation_worktree_id: activeWorktree.worktree_id,
      implementation_worktree_path: activeWorktree.path,
      implementation_branch: activeWorktree.branch,
    } : {};
    const replaceOwnedLocation = (value: string): string => {
      if (!activeWorktree) return value;
      const previousPath = typeof (rootPacket.context as { implementation_worktree_path?: unknown }).implementation_worktree_path === "string"
        ? (rootPacket.context as { implementation_worktree_path: string }).implementation_worktree_path
        : undefined;
      const previousBranch = typeof (rootPacket.context as { implementation_branch?: unknown }).implementation_branch === "string"
        ? (rootPacket.context as { implementation_branch: string }).implementation_branch
        : undefined;
      return [[previousPath, activeWorktree.path], [previousBranch, activeWorktree.branch]].reduce(
        (text, [from, to]) => from && to ? text.replaceAll(from, to) : text,
        value,
      );
    };
    const packet = common.validatePacket({
      ...previous,
      objective: replaceOwnedLocation(previous.objective),
      acceptance_criteria: previous.acceptance_criteria.map(replaceOwnedLocation),
      context: {
        ...previous.context,
        ...worktreeContext,
        ...(adoptionEvidence?.implementation_revision ? { implementation_revision: adoptionEvidence.implementation_revision } : {}),
        ...(resolvedDecision ? { resolved_decision: resolvedDecision } : {}),
        recovery: {
          replacement_for: replacementFor,
          source_packet_digest: originalRecovery?.source_packet_digest ?? root.packet_digest ?? sha256(root.packet_json),
          source_artifact_id: originalRecovery?.source_artifact_id ?? artifact?.artifact_id ?? null,
          source_artifact_digest: originalRecovery?.source_artifact_digest ?? artifact?.sha256 ?? null,
          completed_verification: [...completedVerification, ...(result?.verification ?? []), ...additionalVerification],
        },
      },
    }, failed.role);
    return ops.insert!(store, ops, runId, failed.role, packet, replacementFor);
  }

export function plannedOwnershipRecovery(store: common.StateStore, ops: common.DispatchOperations, runId: string, failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string }): string | undefined {
    if (failed.role !== "git-operator") return undefined;
    const run = store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.mode !== "planned" || !run.plan_id || !run.revision) return undefined;
    const packet = JSON.parse(failed.packet_json) as common.DispatchPacket;
    const context = packet.context as {
      phase?: unknown;
      integration_worktree_id?: unknown;
      task_id?: unknown;
      task_worktree_id?: unknown;
      task_worktree_ids?: unknown;
      implementation_worktree_id?: unknown;
      worktree_id?: unknown;
    };
    if (context.phase !== "integrate_implementation"
      || typeof context.integration_worktree_id !== "string"
      || !Array.isArray(context.task_worktree_ids)
      || context.task_worktree_ids.some((id) => typeof id !== "string")) return undefined;
    const worktreeIds = [...new Set([context.integration_worktree_id, ...(context.task_worktree_ids as string[])])];
    const rows = worktreeIds.map((worktreeId) => store.db.prepare(`SELECT w.worktree_id,w.run_id,w.branch,w.path,w.base_commit,r.repo_id
      FROM worktrees w JOIN runs r ON r.run_id=w.run_id WHERE w.worktree_id=? AND w.state='active'`).get(worktreeId) as {
        worktree_id: string; run_id: string; branch: string; path: string; base_commit: string; repo_id: string;
      } | undefined);
    if (rows.some((row) => !row || row.repo_id !== run.repo_id)) return undefined;
    const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) return undefined;
    const planRevision = `${run.plan_id}-${run.revision}`;
    const integration = rows[0]!;
    const expectedPlanPath = join(repository.project_path, ".worktrees", "plans", run.plan_id, planRevision);
    if (integration.branch !== `plan/${run.plan_id}/${planRevision}` || integration.path !== expectedPlanPath) return undefined;
    const tasks = rows.slice(1).map((row) => row!);
    if (tasks.some((row) => !row.branch.startsWith(`task/${run.plan_id}/${planRevision}--`))) return undefined;
    const foreignTasks = tasks.filter((row) => row.run_id !== runId);
    if (!foreignTasks.length) return undefined;
    const adoptionTasks = foreignTasks.map((row) => {
      const commit = execFileSync("git", ["-C", row.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const parents = execFileSync("git", ["-C", row.path, "rev-list", "--parents", "-n", "1", commit], { encoding: "utf8" }).trim().split(" ");
      if (parents.length !== 2 || parents[1] !== row.base_commit) return undefined;
      return { worktree_id: row.worktree_id, path: row.path, branch: row.branch, base_commit: row.base_commit, commit };
    });
    if (adoptionTasks.some((task) => !task)) return undefined;
    const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, failed.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: "Restore this planned run's registered worktree ownership before retrying the frozen task merge.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Adopt only the listed clean task worktrees with their existing direct-child commits", "Do not adopt the plan worktree or perform the task merge in this dispatch"],
      context: {
        stage: "git-operator",
        phase: "reconcile_worktree_ownership",
        source_dispatch_id: failed.dispatch_id,
        integration_worktree_id: context.integration_worktree_id,
        ...(typeof context.task_id === "string" ? { task_id: context.task_id } : {}),
        ...(typeof context.task_worktree_id === "string" ? { task_worktree_id: context.task_worktree_id } : {}),
        task_worktree_ids: context.task_worktree_ids,
        ...(typeof context.implementation_worktree_id === "string" ? { implementation_worktree_id: context.implementation_worktree_id } : {}),
        ...(typeof context.worktree_id === "string" ? { worktree_id: context.worktree_id } : {}),
        worktree_ids: foreignTasks.map(({ worktree_id }) => worktree_id),
        task_worktrees: adoptionTasks,
        recovery: {
          replacement_for: failed.dispatch_id,
          source_packet_digest: failed.packet_digest ?? sha256(failed.packet_json),
        },
      },
    }, "git-operator"), failed.dispatch_id);
    store.event(runId, "worktree.ownership_reconcile_created", {
      dispatch_id: dispatchId,
      source_dispatch_id: failed.dispatch_id,
      worktree_ids: foreignTasks.map(({ worktree_id }) => worktree_id),
    });
    return dispatchId;
  }

export function plannedMergePartialEffect(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatch: { dispatch_id: string; role: Role; packet_json: string }): MergeOwnershipPartialEffect | undefined {
    if (dispatch.role !== "git-operator") return undefined;
    let context: Record<string, unknown>;
    try { context = (JSON.parse(dispatch.packet_json) as common.DispatchPacket).context; }
    catch { return undefined; }
    if (context.phase !== "integrate_implementation" && context.phase !== "reconcile_worktree_ownership") return undefined;
    const bindings = ops.mergeWorktreeBindings!(store, ops, runId, dispatch.dispatch_id);
    if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) return undefined;
    return completedMergeOwnershipPartialEffect(
      store,
      runId,
      bindings.integration_worktree_id,
      bindings.task_worktree_ids,
    );
  }

export function reconcile(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): common.ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } {
    const commandId = store.startCommand(runId, "dispatch reconcile", { dispatchId, correlationId: dispatchId });
    try {
      const result = ops.reconcileWithCommand!(store, ops, runId, dispatchId, role, actorRole, reason, commandId);
      const terminal = store.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(commandId);
      return terminal ? result : store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", retry_safe: true }, () => result);
    } catch (error) {
      store.terminalCommand(commandId, "failed", { command: "dispatch reconcile", cause: error instanceof Error ? error.message : String(error), retry_safe: true }, () => {});
      throw error;
    }
  }

export function reconcileWithCommand(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, commandId: string): common.ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } {
    ops.assertLifecycleActor!(store, ops, runId, actorRole, "dispatch reconcile");
    if (!reason.trim()) throw new ValidationError("dispatch reconciliation requires a reason");
    const row = ops.get!(store, ops, runId, dispatchId, role) as {
      state: string;
      role: Role;
      packet_json: string;
      packet_digest?: string;
      result_json?: string;
      replacement_for?: string;
    };
    const prior = store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (prior) {
      const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      const resumed = store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=? AND json_extract(payload_json,'$.resumed_finalization')=1")
        .get(runId, dispatchId);
      if (!existing && resumed) return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: true, resumed_finalization: true };
      if (!existing) throw new ValidationError("reconciled dispatch is missing its replacement");
      return { action: "reconciled", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    const run = store.getRun(runId) as { state: string };
    if (row.state === "claimed" && run.state === "completed") {
      ops.verifyFinalization!(store, ops, runId, dispatchId, true);
      store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", resumed_finalization: true, retry_safe: true }, () => {
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        store.event(runId, "dispatch.reconciled", { dispatchId, role, actor_role: actorRole, reason, verified_side_effects: true, resumed_finalization: true });
      });
      return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: false, resumed_finalization: true };
    }
    if (row.state !== "retryable_failure") throw new ValidationError(`dispatch cannot be reconciled from ${row.state}`);
    let result: { status?: string; side_effect_state?: string };
    try { result = JSON.parse(row.result_json ?? ""); }
    catch { throw new ValidationError("dispatch reconciliation requires a valid retryable result envelope"); }
    const partialEffect = ops.plannedMergePartialEffect!(store, ops, runId, { dispatch_id: dispatchId, ...row });
    const cleanup = ops.integratedTaskCleanupRecovery!(store, ops, runId, { dispatch_id: dispatchId, ...row });
    if (cleanup) {
      let cleanupDispatchId = "";
      store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", retry_safe: true, cleanup_only: true }, () => {
        cleanupDispatchId = ops.activateIntegratedTaskCleanup!(store, ops, runId, cleanup.merge_operation_id, cleanup.request, dispatchId);
        store.event(runId, "dispatch.reconciled", {
          dispatchId, replacement_dispatch_id: cleanupDispatchId, role, actor_role: actorRole, reason,
          side_effect_state: "completed", cleanup_only: true,
        });
      });
      return { action: "reconciled", dispatch_id: cleanupDispatchId, replacement_for: dispatchId, reused: false };
    }
    if (result.status !== "retryable_failure" || (result.side_effect_state !== "completed" && !partialEffect)) {
      throw new ValidationError("dispatch reconciliation requires confirmed completed side effects", [
        { path: "/side_effect_state", pointer: "/side_effect_state", field: "side_effect_state", constraint: "const", message: "must equal completed" },
      ]);
    }
    let replacementId = "";
    store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", retry_safe: true }, () => {
      store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
        .run(new Date().toISOString(), dispatchId);
      store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      replacementId = ops.recoveryReplacement!(store, ops, runId, { dispatch_id: dispatchId, ...row });
      store.event(runId, "dispatch.reconciled", {
        dispatchId,
        replacement_dispatch_id: replacementId,
        role,
        actor_role: actorRole,
        reason,
        side_effect_state: "completed",
        ...(partialEffect ? { ownership_operation_ids: partialEffect.operation_ids, merge_pending: true } : {}),
      });
    });
    return { action: "reconciled", dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
  }

export function finalizationContext(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, requiredState: "claimed" | "completed" = "claimed"): {
    barrier_id: string;
    revision_sha: string;
    integration_worktree_id: string;
  } {
    const row = store.db.prepare("SELECT role,state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?")
      .get(runId, dispatchId) as { role: string; state: string; packet_json: string } | undefined;
    if (!row || row.role !== "git-operator" || row.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = (JSON.parse(row.packet_json) as common.DispatchPacket).context as Record<string, unknown>;
    if (context.phase !== "finalize_integration"
      || typeof context.barrier_id !== "string"
      || typeof context.revision_sha !== "string"
      || typeof context.integration_worktree_id !== "string") {
      throw new ValidationError("Git Operator dispatch is not a bound finalize integration dispatch");
    }
    return {
      barrier_id: context.barrier_id,
      revision_sha: context.revision_sha,
      integration_worktree_id: context.integration_worktree_id,
    };
  }

export function assertFinalizingCleanup(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string): void {
    const context = ops.finalizationContext!(store, ops, runId, dispatchId);
    const barrier = store.db.prepare("SELECT state,revision_sha,repair_commit FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string; repair_commit?: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || (barrier.repair_commit ?? barrier.revision_sha) !== context.revision_sha) {
      throw new ValidationError("finalization review barrier is not passed for the requested revision");
    }
    const operation = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { evidence_json?: string } | undefined;
    const evidence = JSON.parse(operation?.evidence_json ?? "{}") as Record<string, unknown>;
    if (!operation || !/^[a-f0-9]{40}$/.test(String(evidence.commit ?? "")) || evidence.integration_head && evidence.integration_head !== context.revision_sha) {
      throw new ValidationError("finalization cleanup requires a completed integration side effect for the reviewed revision");
    }
  }

export function verifyFinalization(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, allowClaimed = false): Record<string, unknown> {
    const dispatch = store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { state: string } | undefined;
    const requiredState = allowClaimed ? "claimed" : "completed";
    if (!dispatch || dispatch.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = ops.finalizationContext!(store, ops, runId, dispatchId, requiredState);
    const run = store.getRun(runId) as { repo_id: string; target_branch: string };
    const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    const barrier = store.db.prepare("SELECT state,revision_sha,repair_commit FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string; repair_commit?: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || (barrier.repair_commit ?? barrier.revision_sha) !== context.revision_sha) {
      throw new ValidationError("finalization barrier and revision binding could not be verified");
    }
    const operation = store.db.prepare("SELECT operation_id,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { operation_id: string; request_json: string; evidence_json?: string } | undefined;
    if (!operation) throw new ValidationError("completed integration operation was not found");
    const request = JSON.parse(operation.request_json) as Record<string, unknown>;
    const evidence = JSON.parse(operation.evidence_json ?? "{}") as Record<string, unknown>;
    const targetHead = execFileSync("git", ["-C", repository.project_path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const targetBranch = execFileSync("git", ["-C", repository.project_path, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const parents = execFileSync("git", ["-C", repository.project_path, "rev-list", "--parents", "-n", "1", targetHead], { encoding: "utf8" }).trim().split(" ");
    if (targetBranch !== run.target_branch || evidence.commit !== targetHead || parents.length !== 3 || parents[2] !== context.revision_sha) {
      throw new ValidationError("target HEAD and merge parents do not match the finalized revision");
    }
    if (evidence.target_parent && evidence.target_parent !== parents[1]) throw new ValidationError("integration target parent does not match recorded evidence");
    if (evidence.integration_head && evidence.integration_head !== context.revision_sha) throw new ValidationError("integration revision does not match recorded evidence");
    if (evidence.barrier_id && evidence.barrier_id !== context.barrier_id) throw new ValidationError("integration barrier does not match recorded evidence");
    if (request.integration_worktree_id && request.integration_worktree_id !== context.integration_worktree_id) throw new ValidationError("integration worktree lineage does not match final dispatch");
    const worktrees = store.db.prepare("SELECT worktree_id,path,branch,state FROM worktrees WHERE run_id=?").all(runId) as Array<{ worktree_id: string; path: string; branch: string; state: string }>;
    const listed = execFileSync("git", ["-C", repository.project_path, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const worktree of worktrees) {
      const cleanup = store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
        AND json_extract(request_json,'$.worktreeId')=? ORDER BY created_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { state: string } | undefined;
      let branchExists = false;
      try {
        execFileSync("git", ["-C", repository.project_path, "show-ref", "--verify", `refs/heads/${worktree.branch}`], { stdio: "ignore" });
        branchExists = true;
      } catch { /* absent branch is required cleanup evidence */ }
      if (worktree.state !== "removed" || cleanup?.state !== "completed" || listed.includes(`worktree ${worktree.path}`) || branchExists) {
        throw new ValidationError("finalization worktree cleanup could not be verified", { worktree_id: worktree.worktree_id });
      }
    }
    return {
      operation_id: operation.operation_id,
      target_head: targetHead,
      merge_parents: parents.slice(1),
      barrier_id: context.barrier_id,
      revision_sha: context.revision_sha,
      integration_worktree_id: context.integration_worktree_id,
      worktree_cleanup: worktrees.map(({ worktree_id }) => worktree_id),
    };
  }

export function integratedTaskCleanupRecovery(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatch: { dispatch_id: string; role: Role; packet_json: string }): { merge_operation_id: string; request: Record<string, unknown> } | undefined {
    if (dispatch.role !== "git-operator") return undefined;
    let context: Record<string, unknown>;
    try { context = (JSON.parse(dispatch.packet_json) as common.DispatchPacket).context; }
    catch { return undefined; }
    if (context.phase !== "integrate_implementation") return undefined;
    const bindings = ops.mergeWorktreeBindings!(store, ops, runId, dispatch.dispatch_id);
    const integrationWorktreeId = typeof context.integration_worktree_id === "string"
      ? context.integration_worktree_id
      : bindings.integration_worktree_id;
    const taskWorktreeId = typeof context.task_worktree_id === "string"
      ? context.task_worktree_id
      : typeof context.implementation_worktree_id === "string"
        ? context.implementation_worktree_id
        : bindings.task_worktree_ids.length === 1 ? bindings.task_worktree_ids[0] : undefined;
    if (!integrationWorktreeId || !taskWorktreeId) return undefined;
    const merge = store.db.prepare(`SELECT operation_id,request_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
      AND json_extract(request_json,'$.integration_worktree_id')=? AND json_extract(request_json,'$.task_worktree_id')=?
      ORDER BY completed_at DESC LIMIT 1`).get(runId, integrationWorktreeId, taskWorktreeId) as { operation_id: string; request_json: string } | undefined;
    if (!merge) return undefined;
    const cleanup = store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
      AND json_extract(request_json,'$.merge_operation_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, merge.operation_id) as { state: string } | undefined;
    if (cleanup?.state === "completed") return undefined;
    return { merge_operation_id: merge.operation_id, request: JSON.parse(merge.request_json) as Record<string, unknown> };
  }

export function activateIntegratedTaskCleanup(store: common.StateStore, ops: common.DispatchOperations, runId: string, mergeOperationId: string, request: Record<string, unknown>, replacementFor?: string): string {
    const taskWorktreeId = request.task_worktree_id;
    const integrationWorktreeId = request.integration_worktree_id;
    store.db.prepare(`UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND role='git-operator'
      AND state IN ('pending','claimed','failed','retryable_failure')
      AND json_extract(packet_json,'$.context.phase')='integrate_implementation'
      AND json_extract(packet_json,'$.context.integration_worktree_id')=?
      AND (json_extract(packet_json,'$.context.task_worktree_id')=? OR json_extract(packet_json,'$.context.implementation_worktree_id')=?)`)
      .run(new Date().toISOString(), runId, integrationWorktreeId, taskWorktreeId, taskWorktreeId);
    if (replacementFor) {
      store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND dispatch_id=?")
        .run(new Date().toISOString(), runId, replacementFor);
    }
    store.db.prepare("UPDATE runs SET state='active',stage='git-operator',updated_at=? WHERE run_id=?")
      .run(new Date().toISOString(), runId);
    const dispatchId = ops.ensureIntegratedTaskCleanupDispatch!(store, ops, runId, mergeOperationId, request, replacementFor);
    if (!dispatchId) throw new ValidationError("completed task merge has no valid integrated-task cleanup dispatch");
    return dispatchId;
  }

export function ensureIntegratedTaskCleanupDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, mergeOperationId: string, request: Record<string, unknown>, replacementFor?: string): string | undefined {
    const taskWorktreeId = typeof request.task_worktree_id === "string" ? request.task_worktree_id : undefined;
    const integrationWorktreeId = typeof request.integration_worktree_id === "string" ? request.integration_worktree_id : undefined;
    const taskId = typeof request.task_id === "string" ? request.task_id : undefined;
    if (!taskWorktreeId || !integrationWorktreeId || !taskId) return undefined;
    const task = store.db.prepare("SELECT branch FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(runId, taskWorktreeId) as { branch: string } | undefined;
    if (!task?.branch.startsWith("task/")) return undefined;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'
      AND state IN ('pending','claimed') AND json_extract(packet_json,'$.context.phase')='cleanup_integrated_task'
      AND json_extract(packet_json,'$.context.merge_operation_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, mergeOperationId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: `Reconcile and remove the integrated ${taskId} task worktree and branch.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Reconcile only the bound cleanup operation", "Remove the task worktree before its merged branch", "Do not merge or prepare another task"],
      context: {
        stage: "git-operator", phase: "cleanup_integrated_task", task_id: taskId,
        task_worktree_id: taskWorktreeId, task_branch: task.branch,
        integration_worktree_id: integrationWorktreeId,
        merge_operation_id: mergeOperationId,
      },
    }, "git-operator"), replacementFor);
    ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
    return dispatchId;
  }

export function pendingPlannedTaskRecovery(store: common.StateStore, ops: common.DispatchOperations, runId: string, taskId: string): {
    project: string;
    plan_id: string;
    revision: string;
    target_revision: string;
    source_run_id: string;
    worktree_id: string;
    artifact_id: string;
    artifact_digest: string;
    expected_head: string;
  } | undefined {
    const run = store.getRun(runId) as { repo_id: string; profile: string; mode?: string; plan_id?: string; revision?: string };
    if (run.profile !== "coding" || run.mode !== "planned" || !run.plan_id || !run.revision) return undefined;
    const source = store.db.prepare(`SELECT source_run.run_id AS source_run_id,source_run.plan_id,source_run.revision,
        source_task.worktree_id,worktree.path,artifact.artifact_id,artifact.sha256 AS artifact_digest,repository.project_path
      FROM revisions target_revision
      JOIN runs source_run ON source_run.repo_id=target_revision.repo_id AND source_run.profile='coding' AND source_run.mode='planned'
        AND source_run.plan_id=target_revision.plan_id AND source_run.revision=target_revision.supersedes
      JOIN run_tasks source_task ON source_task.run_id=source_run.run_id AND source_task.task_id=?
      JOIN worktrees worktree ON worktree.worktree_id=source_task.worktree_id AND worktree.run_id=source_run.run_id AND worktree.state='active'
      JOIN repositories repository ON repository.repo_id=source_run.repo_id
      JOIN artifacts artifact ON artifact.run_id=source_run.run_id AND artifact.kind='result'
        AND artifact.dispatch_id IN (source_task.developer_dispatch_id,source_task.test_dispatch_id)
      WHERE target_revision.repo_id=? AND target_revision.plan_id=? AND target_revision.revision=?
      ORDER BY artifact.created_at DESC LIMIT 1`)
      .get(taskId, run.repo_id, run.plan_id, run.revision) as {
        source_run_id: string; plan_id: string; revision: string; worktree_id: string; path: string;
        artifact_id: string; artifact_digest: string; project_path: string;
      } | undefined;
    if (!source) return undefined;
    const expectedHead = execFileSync("git", ["-C", source.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw new ValidationError("planned task recovery source worktree has an invalid HEAD");
    return {
      project: source.project_path,
      plan_id: source.plan_id,
      revision: source.revision,
      target_revision: run.revision,
      source_run_id: source.source_run_id,
      worktree_id: source.worktree_id,
      artifact_id: source.artifact_id,
      artifact_digest: source.artifact_digest,
      expected_head: expectedHead,
    };
  }

export function prepareDispatchHasNoSideEffects(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string): boolean {
    const worktreeBinding = store.db.prepare("SELECT 1 FROM dispatch_worktree_bindings WHERE run_id=? AND dispatch_id=? LIMIT 1")
      .get(runId, dispatchId);
    const staging = store.db.prepare("SELECT 1 FROM staging_entries WHERE run_id=? AND dispatch_id=? LIMIT 1")
      .get(runId, dispatchId);
    return !worktreeBinding && !staging;
  }

export function ensureActiveLivenessDecision(store: common.StateStore, ops: common.DispatchOperations, runId: string): void {
    const run = store.getRun(runId) as { profile: Role; state: string; stage: string };
    const pendingDispatch = store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId);
    const pendingDecision = store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    const pendingOperation = store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='pending'").get(runId);
    const intent = livenessRecoveryIntent(run.profile, run.state, run.stage, Boolean(pendingDispatch || pendingDecision || pendingOperation));
    if (!intent) return;
    const dispatchId = ops.insert!(store, ops, runId, run.profile, common.validatePacket(intent.packet, run.profile));
    store.db.prepare("UPDATE dispatches SET state='needs_decision' WHERE dispatch_id=?").run(dispatchId);
    store.createDecision(runId, intent.decision.question, intent.decision.choices, intent.decision.recommendation, intent.decision.type, dispatchId);
    store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    store.event(runId, "run.recovery_decision_created", { dispatch_id: dispatchId, stage: run.stage });
  }

export function resume(store: common.StateStore, ops: common.DispatchOperations, runId: string): common.RunResumeResult {
    store.db.transaction(() => {
      let run = store.getRun(runId) as { profile: string; state: string; stage: string };
      const pendingDecision = store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; dispatch_id?: string; receipt_json?: string } | undefined;
      const pendingOperation = store.db.prepare("SELECT operation_id,kind,request_json,evidence_json FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1")
        .get(runId) as { operation_id: string; kind: string; request_json?: string; evidence_json?: string } | undefined;
      if (pendingOperation) {
        const cleanupRequest = JSON.parse(pendingOperation.request_json ?? "{}") as Record<string, unknown>;
        if (pendingOperation.kind === "git.cleanup" && typeof cleanupRequest.task_worktree_id === "string"
          && typeof cleanupRequest.integration_worktree_id === "string" && typeof cleanupRequest.merge_operation_id === "string") {
          ops.activateIntegratedTaskCleanup!(store, ops, runId, cleanupRequest.merge_operation_id, cleanupRequest);
          return;
        }
        const evidence = JSON.parse(pendingOperation.evidence_json ?? "{}") as { state?: string; conflict_paths?: unknown[] };
        const claimed = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        const recoverableConflict = run.state === "failed" && pendingOperation.kind === "git.sync"
          && evidence.state === "conflicted" && Boolean(evidence.conflict_paths?.length) && claimed;
        if (!recoverableConflict) return;
        store.db.prepare("UPDATE runs SET state='active',stage='git-operator',updated_at=? WHERE run_id=?")
          .run(new Date().toISOString(), runId);
        store.event(runId, "run.git_conflict_recovery_activated", {
          operation_id: pendingOperation.operation_id,
          dispatch_id: claimed.dispatch_id,
          conflict_paths: evidence.conflict_paths,
        });
        run = store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      if (run.profile === "coding" && run.state === "frozen" && run.stage === "test") {
        const driftRow = store.db.prepare("SELECT event_id,payload_json,created_at FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift' ORDER BY event_id DESC LIMIT 1")
          .get(runId) as { event_id: number; payload_json: string; created_at: string } | undefined;
        const eventsAfterDrift = driftRow ? store.db.prepare("SELECT type FROM run_events WHERE run_id=? AND event_id>? AND type NOT LIKE 'command.%' ORDER BY event_id")
          .all(runId, driftRow.event_id) as Array<{ type: string }> : [];
        const drift = driftRow && eventsAfterDrift.every(({ type }) => type === "staging.validation_failed") ? JSON.parse(driftRow.payload_json) as {
          offending_test_dispatch_id?: string;
          offending_worktree_id?: string;
          original_snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null;
          snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null;
        } : undefined;
        const pendingDispatches = store.db.prepare("SELECT dispatch_id,role FROM dispatches WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at")
          .all(runId) as Array<{ dispatch_id: string; role: string }>;
        const laterOperation = driftRow ? store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND created_at>? LIMIT 1").get(runId, driftRow.created_at) : undefined;
        const worktree = drift?.offending_worktree_id
          ? store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, drift.offending_worktree_id) as { path: string } | undefined
          : undefined;
        const currentSnapshot = worktree ? common.plannedWorktreeSnapshot(worktree.path) : null;
        const driftScopeRow = drift?.offending_worktree_id ? store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
          .get(runId, drift.offending_worktree_id) as { payload_json: string } | undefined : undefined;
        const driftScopeSnapshot = driftScopeRow
          ? (JSON.parse(driftScopeRow.payload_json) as { snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null }).snapshot
          : undefined;
        const driftExpectedSnapshot = driftScopeSnapshot ?? drift?.original_snapshot ?? null;
        const allTasks = store.runTasks(runId);
        const tasks = allTasks.filter((task) => task.developer_dispatch_id && task.worktree_id);
        const restoredScopes: Array<{ task_id: string; worktree_id: string; paths: string[]; digest: string; write_paths: string[] }> = [];
        const actualByTask = new Map<string, string[]>();
        const scopeCreatedByTask = new Map<string, string>();
        const scopeSnapshotByTask = new Map<string, { head: string; dirty_paths: string[]; diff_digest: string }>();
        let valid = Boolean(drift?.offending_test_dispatch_id && drift.offending_worktree_id && driftExpectedSnapshot && currentSnapshot
          && stableJson(driftExpectedSnapshot) === stableJson(currentSnapshot) && !laterOperation && tasks.length
          && pendingDispatches.length === 1 && pendingDispatches[0]!.role === "test"
          && pendingDispatches[0]!.dispatch_id === drift.offending_test_dispatch_id);
        let evidenceValid = Boolean(tasks.length);
        const recoveryRun = store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
        const recoveryRevision = recoveryRun.plan_id && recoveryRun.revision
          ? store.db.prepare("SELECT digest,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
            .get(recoveryRun.repo_id, recoveryRun.plan_id, recoveryRun.revision) as { digest?: string; plan_commit?: string } | undefined
          : undefined;
        const recoveryRepository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(recoveryRun.repo_id) as { project_path: string } | undefined;
        for (const task of tasks) {
          const developer = task.developer_dispatch_id ? store.db.prepare("SELECT packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'")
            .get(runId, task.developer_dispatch_id) as { packet_json: string; result_json?: string } | undefined : undefined;
          const packet = developer ? JSON.parse(developer.packet_json) as common.DispatchPacket : undefined;
          const actual = developer?.result_json
            ? [...new Set((((JSON.parse(developer.result_json) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []))].sort()
            : [];
          const scopeRow = task.worktree_id ? store.db.prepare("SELECT payload_json,created_at FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
            .get(runId, task.worktree_id) as { payload_json: string; created_at: string } | undefined : undefined;
          const scope = scopeRow ? JSON.parse(scopeRow.payload_json) as { paths?: string[]; digest?: string; snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null } : undefined;
          const scopePaths = [...new Set(scope?.paths ?? [])].sort();
          let developerAllowedPaths: string[] = [];
          let frozenPaths: string[] = [];
          let sourceValid = false;
          try {
            developerAllowedPaths = [...new Set(packet?.allowed_write_paths ?? [])].sort();
            if (!developerAllowedPaths.length || developerAllowedPaths.some((path) => typeof path !== "string" || !path)) throw new Error("missing developer ceiling");
            frozenPaths = task.write_paths_json
              ? assertExplicitTaskWritePaths(JSON.parse(task.write_paths_json) as string[], task.source_path)
              : scopePaths;
            const metadataPath = task.source_path.replace(/\.md$/, ".metadata.json");
            if (metadataPath === task.source_path) throw new Error("invalid task source path");
            const source = recoveryRevision?.plan_commit && recoveryRepository
              ? execFileSync("git", ["-C", recoveryRepository.project_path, "show", `${recoveryRevision.plan_commit}:${task.source_path}`], { encoding: "utf8" })
              : "";
            const metadata = recoveryRevision?.plan_commit && recoveryRepository
              ? execFileSync("git", ["-C", recoveryRepository.project_path, "show", `${recoveryRevision.plan_commit}:${metadataPath}`], { encoding: "utf8" })
              : "";
            sourceValid = Boolean(recoveryRevision?.digest && recoveryRevision.digest === recoveryRun.plan_digest
              && /^[a-f0-9]{40}$/.test(recoveryRevision.plan_commit ?? "")
              && taskSourceDigest(task.source_path, source, metadataPath, metadata) === task.source_digest);
          } catch { sourceValid = false; }
          const taskEvidenceValid = Boolean(task.developer_dispatch_id && task.worktree_id && packet
            && packet.context.task_id === task.task_id && packet.context.worktree_id === task.worktree_id
            && actual.length && stableJson(actual) === stableJson(scopePaths)
            && scope?.digest === sha256(stableJson(scopePaths))
            && sourceValid
            && actual.every((path) => pathMatchesScope(path, developerAllowedPaths) && pathMatchesScope(path, frozenPaths)));
          valid &&= taskEvidenceValid;
          evidenceValid &&= taskEvidenceValid;
          actualByTask.set(task.task_id, actual);
          if (scopeRow) scopeCreatedByTask.set(task.task_id, scopeRow.created_at);
          if (scope?.snapshot) scopeSnapshotByTask.set(task.task_id, scope.snapshot);
          if (task.worktree_id && scope?.digest) restoredScopes.push({
            task_id: task.task_id, worktree_id: task.worktree_id, paths: scopePaths, digest: scope.digest, write_paths: frozenPaths,
          });
        }
        const priorDrift = store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift' LIMIT 1").get(runId);
        const pendingTest = pendingDispatches.length === 1 && pendingDispatches[0]!.role === "test" ? pendingDispatches[0] : undefined;
        const pendingTestPacket = pendingTest ? store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, pendingTest.dispatch_id) as { packet_json: string } : undefined;
        const testContext = pendingTestPacket ? (JSON.parse(pendingTestPacket.packet_json) as common.DispatchPacket).context : {};
        const currentTask = allTasks.find((task) => task.state !== "integrated");
        const currentWorktree = currentTask?.worktree_id
          ? store.db.prepare("SELECT path,base_commit FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, currentTask.worktree_id) as { path: string; base_commit: string } | undefined
          : undefined;
        const legacySnapshot = currentWorktree ? common.plannedWorktreeSnapshot(currentWorktree.path) : null;
        let legacyValid = Boolean(!drift && !priorDrift && !pendingDecision && evidenceValid && pendingTest && allTasks.length && tasks.length === allTasks.length
          && allTasks.filter((task) => task.state !== "integrated").length === 1
          && allTasks.every((task) => task.state === "integrated" || task.state === "implemented" || task.state === "tested")
          && currentTask && currentWorktree && legacySnapshot
          && testContext.phase === "task_test" && testContext.task_id === currentTask.task_id && testContext.worktree_id === currentTask.worktree_id
          && legacySnapshot.head === currentWorktree.base_commit
          && stableJson(legacySnapshot.dirty_paths) === stableJson(actualByTask.get(currentTask.task_id) ?? []));
        const currentScopeSnapshot = currentTask ? scopeSnapshotByTask.get(currentTask.task_id) : undefined;
        if (currentScopeSnapshot) legacyValid &&= stableJson(currentScopeSnapshot) === stableJson(legacySnapshot);
        for (const task of allTasks.filter((candidate) => candidate.state === "integrated")) {
          const commit = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
            .get(runId, task.worktree_id) as { evidence_json?: string } | undefined;
          const merge = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' AND json_extract(evidence_json,'$.task_worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
            .get(runId, task.worktree_id) as { evidence_json?: string } | undefined;
          const commitEvidence = JSON.parse(commit?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
          const mergeEvidence = JSON.parse(merge?.evidence_json ?? "{}") as { commit?: string };
          legacyValid &&= Boolean(commitEvidence.commit && mergeEvidence.commit
            && stableJson([...(commitEvidence.paths ?? [])].sort()) === stableJson(actualByTask.get(task.task_id) ?? [])
            && (!task.implementation_commit || task.implementation_commit === commitEvidence.commit)
            && (!task.integration_commit || task.integration_commit === mergeEvidence.commit));
        }
        const currentScopeCreated = currentTask ? scopeCreatedByTask.get(currentTask.task_id) : undefined;
        const laterGitOperation = currentScopeCreated ? store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND kind LIKE 'git.%' AND created_at>? LIMIT 1").get(runId, currentScopeCreated) : undefined;
        legacyValid &&= Boolean(currentScopeCreated && !laterGitOperation);
        const recovered = valid || legacyValid;
        if (recovered) {
          const updateLegacy = store.db.prepare("UPDATE run_tasks SET write_paths_json=?,updated_at=? WHERE run_id=? AND task_id=? AND write_paths_json IS NULL");
          const now = new Date().toISOString();
          for (const scope of restoredScopes) updateLegacy.run(stableJson(scope.write_paths), now, runId, scope.task_id);
          if (legacyValid && currentTask && legacySnapshot) {
            const currentScope = restoredScopes.find(({ task_id }) => task_id === currentTask.task_id)!;
            store.event(runId, "scope.pre_commit_snapshot_recovered", {
              original_scope_digest: currentScope.digest,
              original_scope_paths: currentScope.paths,
              task_id: currentTask.task_id,
              developer_dispatch_id: currentTask.developer_dispatch_id,
              worktree_id: currentTask.worktree_id,
              snapshot: legacySnapshot,
            });
          }
          store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
          store.event(runId, valid ? "scope.pre_commit_restored" : "scope.pre_commit_legacy_restored", {
            test_dispatch_id: drift?.offending_test_dispatch_id ?? pendingTest!.dispatch_id,
            worktree_snapshot: valid ? currentSnapshot : legacySnapshot,
            scopes: restoredScopes,
            ...(legacyValid ? {
              evidence: "immutable scopes + developer results + integrated operation chains + current tested worktree snapshot",
              frozen_task_scope_status: "unavailable_or_ambiguous",
              recovery_authority: "existing immutable pre_commit actual paths",
            } : {}),
          });
          run = store.getRun(runId) as { profile: string; state: string; stage: string };
        }
      }
      if (run.state === "frozen") return;
      if (run.profile === "coding" && run.state === "failed" && !pendingDecision && ops.createBlockedTestRepairRecovery!(store, ops, runId)) return;
      if (run.profile === "coding" && run.state === "failed" && !pendingDecision && ops.resumeFailedTestRepair!(store, ops, runId)) {
        run = store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      if (run.profile === "coding") {
        ops.reconcileReview!(store, ops, runId);
        ops.reconcilePlannedTaskStates!(store, ops, runId);
        ops.handlePrematurePlannedTest!(store, ops, runId);
        run = store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      const retryableDispatch = run.state === "retryable_failure"
        ? store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined
        : undefined;
      const cleanupRecovery = retryableDispatch ? ops.integratedTaskCleanupRecovery!(store, ops, runId, retryableDispatch) : undefined;
      if (cleanupRecovery && retryableDispatch) {
        ops.activateIntegratedTaskCleanup!(store, ops, runId, cleanupRecovery.merge_operation_id, cleanupRecovery.request, retryableDispatch.dispatch_id);
        return;
      }
      const mergePartialEffect = retryableDispatch ? ops.plannedMergePartialEffect!(store, ops, runId, retryableDispatch) : undefined;
      if (pendingDecision) {
        if (retryableDispatch && !pendingDecision.dispatch_id) {
          const receipt = { ...JSON.parse(pendingDecision.receipt_json ?? "{}"), dispatch_id: retryableDispatch.dispatch_id };
          store.db.prepare("UPDATE decisions SET dispatch_id=?,receipt_json=? WHERE decision_id=?")
            .run(retryableDispatch.dispatch_id, stableJson(receipt), pendingDecision.decision_id);
          store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        }
        return;
      }
      if (!retryableDispatch) {
        const pendingTest = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        if (pendingTest && run.stage !== "test") ops.changeStage!(store, ops, runId, "test", pendingTest.dispatch_id);
        const pendingDispatch = store.db.prepare(`SELECT dispatch_id,role,packet_json FROM dispatches
          WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string; role: Role; packet_json: string } | undefined;
        if (pendingDispatch && run.profile === "coding") {
          const pendingPacket = JSON.parse(pendingDispatch.packet_json) as common.DispatchPacket;
          const recovery = pendingPacket.context.recovery as { completed_verification?: unknown } | undefined;
          const authorityApplyDispatchId = pendingDispatch.role === "git-operator"
            && pendingPacket.context.phase === "continue_task_authority_conflict"
            && pendingPacket.context.operation === "continue-task-authority-conflict"
            && typeof pendingPacket.context.authority_apply_dispatch_id === "string"
            && Array.isArray(recovery?.completed_verification)
            && recovery.completed_verification.length > 0
            ? pendingPacket.context.authority_apply_dispatch_id
            : undefined;
          if (authorityApplyDispatchId) {
            store.db.transaction(() => {
              store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=? AND state IN ('pending','claimed')")
                .run(new Date().toISOString(), pendingDispatch.dispatch_id);
              store.db.prepare("UPDATE runs SET state='active',stage='coding',updated_at=? WHERE run_id=?")
                .run(new Date().toISOString(), runId);
              if (!ops.ensureRecoveredTaskDeveloperDispatch!(store, ops, runId, authorityApplyDispatchId, true)) {
                throw new ValidationError("completed authority conflict receipt has no recoverable developer continuation");
              }
            })();
            return;
          }
          if (pendingDispatch.role === "git-operator" && pendingPacket.context.phase === "prepare_implementation_worktree"
            && typeof pendingPacket.context.task_id === "string" && ops.pendingPlannedTaskRecovery!(store, ops, runId, pendingPacket.context.task_id)) {
            ops.ensureNextPlannedTaskPrepare!(store, ops, runId);
            return;
          }
        }
        if (pendingDispatch) return;
        if (run.profile === "coding" && (ops.ensurePlannedTaskDeveloperDispatch!(store, ops, runId) || ops.ensurePlannedTaskContinuation!(store, ops, runId) || ops.ensureNextPlannedTaskPrepare!(store, ops, runId))) return;
      }
      const retryableHasNoSideEffects = retryableResultHasNoSideEffects(retryableDispatch?.result_json);
      if (retryableDispatch && retryableHasNoSideEffects && !mergePartialEffect) {
        store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), retryableDispatch.dispatch_id);
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        if (!ops.plannedOwnershipRecovery!(store, ops, runId, retryableDispatch)) ops.recoveryReplacement!(store, ops, runId, retryableDispatch);
        return;
      }
      if (run.state === "retryable_failure") return;
      if (run.state === "needs_decision") {
        const blocked = store.db.prepare("SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND state='needs_decision' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string } | undefined;
        if (blocked) {
          store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
          if (run.profile !== "planning") ops.insert!(store, ops, runId, blocked.role, JSON.parse(blocked.packet_json) as common.DispatchPacket);
        }
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      if (run.state !== "active" && run.state !== "needs_decision") return;
      if (run.profile === "planning" && run.stage !== "ready" && run.stage !== "file-explorer") ops.continuePlanning!(store, ops, runId);
      if (run.profile === "coding" && run.state === "active") {
        const commitContinuation = ops.ensurePreCommitDecisionContinuation!(store, ops, runId) ?? ops.ensureCodingCommitContinuation!(store, ops, runId);
        if (!commitContinuation) ops.ensureContinueTestingContinuation!(store, ops, runId);
      }
      ops.ensureActiveLivenessDecision!(store, ops, runId);
    })();
    const resumedRun = store.getRun(runId) as Record<string, unknown> & { profile: Role; state: string };
    const blockedRetryable = resumedRun.state === "retryable_failure"
      ? store.db.prepare("SELECT dispatch_id,role,packet_json,result_json FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string; role: Role; packet_json: string; result_json?: string } | undefined
      : undefined;
    let recovery: common.RunResumeResult["recovery"] = null;
    if (blockedRetryable?.result_json) {
      const intent = reconciliationIntent(blockedRetryable.result_json, Boolean(ops.plannedMergePartialEffect!(store, ops, runId, blockedRetryable)));
      if (intent) recovery = {
        state: "action_required", dispatch_id: blockedRetryable.dispatch_id, side_effect_state: intent.sideEffectState,
        next_command: intent.sideEffectState === "completed"
          ? `ai-team dispatch reconcile --run-id ${runId} --dispatch-id ${blockedRetryable.dispatch_id} --role ${blockedRetryable.role} --actor-role ${resumedRun.profile} --reason "reconcile confirmed completed side effect"`
          : null,
      };
    }
    if (!recovery) {
      const operation = store.db.prepare("SELECT operation_id,kind,request_json,evidence_json FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1")
        .get(runId) as { operation_id: string; kind: string; request_json: string; evidence_json?: string } | undefined;
      const claimed = operation ? store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string } | undefined : undefined;
      if (operation && claimed) {
        const request = JSON.parse(operation.request_json) as { integration_worktree_id?: string };
        const evidence = JSON.parse(operation.evidence_json ?? "{}") as {
          state?: string; conflict_paths?: string[]; integration_worktree_id?: string;
          integration_head_before?: string; target_head?: string;
          worktree_id?: string; authority_commit?: string; expected_head?: string; dirty_paths?: string[];
          authority_paths?: string[]; stash_commit?: string;
        };
        const integrationWorktreeId = request.integration_worktree_id ?? evidence.integration_worktree_id;
        if (operation.kind === "git.sync" && evidence.state === "conflicted" && integrationWorktreeId) {
          recovery = {
            state: "action_required", dispatch_id: claimed.dispatch_id, side_effect_state: "unknown",
            next_command: `ai-team git continue-conflict --run-id ${runId} --dispatch-id ${claimed.dispatch_id} --integration-id ${integrationWorktreeId} --scope ${(evidence.conflict_paths ?? []).join(",")}`,
          };
        } else if (operation.kind === "git.sync") {
          recovery = {
            state: "action_required", dispatch_id: claimed.dispatch_id, side_effect_state: "unknown",
            next_command: `ai-team git reconcile --run-id ${runId} --dispatch-id ${claimed.dispatch_id} --operation-id ${operation.operation_id} --state conflicted --input-stdin`,
            evidence_template: {
              integration_worktree_id: "<worktree-id>", conflict_paths: ["<repository-relative-conflict-path>"],
              integration_head_before: "<40-character-commit-sha>", target_head: "<40-character-commit-sha>",
            },
          };
        } else if (operation.kind === "git.task_authority.apply" && evidence.state === "conflicted") {
          recovery = {
            state: "action_required", dispatch_id: claimed.dispatch_id, side_effect_state: "unknown",
            next_command: `ai-team git continue-authority-conflict --run-id ${runId} --dispatch-id ${claimed.dispatch_id}`,
          };
        } else if (operation.kind === "git.task_authority.apply") {
          recovery = {
            state: "action_required", dispatch_id: claimed.dispatch_id, side_effect_state: "unknown",
            next_command: `ai-team git reconcile --run-id ${runId} --dispatch-id ${claimed.dispatch_id} --operation-id ${operation.operation_id} --state conflicted --input-stdin`,
            evidence_template: {
              worktree_id: "<worktree-id>", authority_commit: "<40-character-commit-sha>", expected_head: "<40-character-commit-sha>",
              dirty_paths: ["<repository-relative-dirty-path>"], authority_paths: ["<repository-relative-authority-path>"],
              conflict_paths: ["<repository-relative-conflict-path>"], stash_commit: "<40-character-commit-sha>",
            },
          };
        } else {
          recovery = { state: "action_required", dispatch_id: claimed.dispatch_id, side_effect_state: "unknown", next_command: `ai-team git reconcile --run-id ${runId} --dispatch-id ${claimed.dispatch_id}` };
        }
      }
    }
    return {
      run: resumedRun,
      pending_dispatches: store.db.prepare("SELECT dispatch_id,role,state FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").all(runId) as common.RunResumeResult["pending_dispatches"],
      pending_decision: (store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").get(runId) as Record<string, unknown> | undefined) ?? null,
      pending_operations: store.db.prepare("SELECT operation_id,kind,state FROM operations WHERE run_id=? AND state='pending'").all(runId) as common.RunResumeResult["pending_operations"],
      last_event: (store.db.prepare("SELECT type,payload_json,created_at FROM run_events WHERE run_id=? AND type NOT LIKE 'command.%' ORDER BY event_id DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined) ?? null,
      recovery,
      ...(() => {
        const projection = recoveryProjection(store, runId);
        return { timeline_tail: projection.timeline.slice(-20), next_actions: projection.next_actions, next_action: projection.next_action };
      })(),
    };
  }
