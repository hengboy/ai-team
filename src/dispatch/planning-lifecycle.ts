import { Role } from "../constants.js";
import { type ResultEnvelope } from "../contracts.js";
import { IncompatibleError, ValidationError } from "../errors.js";
import { pathMatchesScope } from "../security.js";
import { assertRevisionRunStage } from "../planning.js";
import { sha256, stableJson } from "../utils.js";
import { assertPlanningSubmissionTransition, planningContinuationPacket, planningSubmissionIntent, requirementClarificationMappings } from "./planning.js";
import { isManagedPlannedRecovery, managedCleanupPacket, reissuePacket } from "./recovery.js";
import * as common from "./store.js";
export function advancePlanning(store: common.StateStore, ops: common.DispatchOperations, runId: string, result: ResultEnvelope): void {
    const payload = result.payload as {
      stage: string;
      pending_questions: string[];
      decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string; requirement_ids?: string[]; acceptance_criteria?: string[] } | null;
      no_change?: { decision_id: string; conclusion: string; repository_evidence: Array<{ command: string; outcome: string }> };
    };
    const run = store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; stage: string };
    const packet = JSON.parse(ops.get!(store, ops, runId, result.dispatch_id, "planning").packet_json) as common.DispatchPacket;
    assertPlanningSubmissionTransition(run.stage, payload.stage, packet.context, payload.decision, payload.pending_questions);
    if (payload.stage === "no_change") {
      if (!payload.no_change) throw new ValidationError("planning no_change requires repository evidence and a decision receipt");
      const decision = store.db.prepare("SELECT status,choice,receipt_json FROM decisions WHERE run_id=? AND decision_id=?")
        .get(runId, payload.no_change.decision_id) as { status: string; choice?: string; receipt_json?: string } | undefined;
      if (!decision || decision.status !== "resolved" || decision.choice !== "verify_existing") {
        throw new ValidationError("planning no_change requires a resolved verify_existing decision receipt");
      }
      if (run.plan_id || run.revision) throw new ValidationError("planning no_change cannot complete a run with a bound revision");
      const sideEffects = {
        worktrees: (store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count,
        operations: (store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=?").get(runId) as { count: number }).count,
        git_dispatches: (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count,
      };
      if (sideEffects.worktrees || sideEffects.operations || sideEffects.git_dispatches) {
        throw new ValidationError("planning no_change cannot complete after implementation or Git side effects", sideEffects);
      }
      const decisionReceipt = JSON.parse(decision.receipt_json ?? "{}") as Record<string, unknown>;
      store.db.prepare("UPDATE runs SET stage='no_change',state='completed',updated_at=? WHERE run_id=?")
        .run(new Date().toISOString(), runId);
      store.event(runId, "planning.no_change_completed", {
        conclusion: payload.no_change.conclusion,
        repository_evidence: payload.no_change.repository_evidence,
        decision_receipt: decisionReceipt,
      });
      return;
    }
    if (run.plan_id && run.revision) {
      const revision = store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
      if (!revision) throw new ValidationError("bound planning revision not found");
      assertRevisionRunStage(revision.state, payload.stage);
    }
    const requirementDecisionCount = (store.db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE run_id=? AND decision_type='requirement'").get(runId) as { count: number }).count;
    const intent = planningSubmissionIntent(payload.stage, payload.pending_questions, payload.decision, requirementDecisionCount);
    const needsDecision = intent.needsDecision;
    store.db.prepare("UPDATE runs SET stage=?,state=?,updated_at=? WHERE run_id=?")
      .run(payload.stage, needsDecision ? "needs_decision" : "active", new Date().toISOString(), runId);
    store.event(runId, "planning.stage_changed", { stage: payload.stage });
    if (needsDecision) {
      if (!payload.decision) throw new ValidationError("planning pending question requires one matching decision");
      const mappings = intent.decisionType === "requirement" ? requirementClarificationMappings(payload.decision) : undefined;
      const decisionId = store.createDecision(runId, intent.question!, payload.decision.choices, payload.decision.recommendation, intent.decisionType!, result.dispatch_id, mappings);
      if (intent.decisionType === "requirement") {
        store.createPlanningClarification({
          runId,
          decisionId,
          source: "planning_dispatch",
          impact: payload.decision.choices,
          ...mappings!,
        });
      }
    } else if (payload.stage !== "ready") {
      ops.continuePlanning!(store, ops, runId);
    }
  }

export function continuePlanning(store: common.StateStore, ops: common.DispatchOperations, runId: string): string {
    const run = store.getRun(runId) as { profile: string; stage: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can continue planning");
    store.assertPlanningClarificationsResolved(runId);
    const pending = store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (pending) throw new ValidationError("planning cannot continue with a pending decision");
    const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    return ops.create!(store, ops, runId, "planning", planningContinuationPacket(run.stage), "planning");
  }

export function resolvePlanningDecision(store: common.StateStore, ops: common.DispatchOperations, runId: string, decisionId: string, choice: string, note?: string): string {
    const run = store.getRun(runId) as { profile: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can resolve planning decisions");
    const existing = store.db.prepare("SELECT status,choice,receipt_json,decision_type,dispatch_id FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; decision_type: string; dispatch_id?: string } | undefined;
    if (existing?.status === "resolved") {
      const receipt = JSON.parse(existing.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (existing.choice === choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      if (existing.choice === choice && ((existing.decision_type === "task_split" && choice === "no_split") || (existing.decision_type === "task_preview" && choice === "approve"))) {
        return existing.dispatch_id ?? "";
      }
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    let dispatchId = "";
    store.db.transaction(() => {
      store.decide(runId, decisionId, choice, note);
      store.db.prepare(`UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=(
        SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state='needs_decision' ORDER BY created_at DESC LIMIT 1
      )`)
        .run(new Date().toISOString(), runId);
      store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      const terminalDecision = existing?.decision_type === "task_split" && choice === "no_split"
        || existing?.decision_type === "task_preview" && choice === "approve";
      dispatchId = terminalDecision
        ? existing?.dispatch_id ?? ""
        : ops.continuePlanning!(store, ops, runId);
      const successor = store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      const receipt = store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: terminalDecision ? null : dispatchId, successor_packet_digest: terminalDecision ? null : successor?.packet_digest ?? null }), decisionId);
    })();
    return dispatchId;
  }

export function resolveDecision(store: common.StateStore, ops: common.DispatchOperations, runId: string, decisionId: string, choice: string, note?: string): string {
    const run = store.getRun(runId) as { profile: string; state: string; stage: string; mode?: string; repo_id?: string; plan_id?: string; revision?: string };
    if (run.profile === "planning") return ops.resolvePlanningDecision!(store, ops, runId, decisionId, choice, note);
    const existingDecision = store.db.prepare("SELECT status,choice,receipt_json,dispatch_id,decision_type FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; dispatch_id?: string; decision_type: string } | undefined;
    if (existingDecision?.status === "resolved") {
      const receipt = JSON.parse(existingDecision.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (choice === existingDecision.choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    const managedPlannedRecovery = isManagedPlannedRecovery(run.mode, existingDecision?.decision_type, choice);
    if (managedPlannedRecovery) {
      if (!run.repo_id || !run.plan_id || !run.revision || !existingDecision?.dispatch_id) throw new ValidationError("managed planned recovery requires a bound planned run and dispatch");
      const pendingOperation = store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1").get(runId) as { operation_id: string } | undefined;
      if (pendingOperation) throw new ValidationError(`managed planned recovery requires operation reconciliation: ${pendingOperation.operation_id}`);
      const worktrees = store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' ORDER BY created_at,worktree_id").all(runId) as Array<{ worktree_id: string }>;
      if (!worktrees.length) throw new ValidationError("managed planned recovery requires at least one active run-owned worktree");
      const conflicts = store.db.prepare(`SELECT run_id FROM runs WHERE repo_id=? AND plan_id=? AND revision=? AND run_id<>? AND state='failed'
        ORDER BY created_at,run_id`).all(run.repo_id, run.plan_id, run.revision, runId) as Array<{ run_id: string }>;
      let dispatchId = "";
      store.db.transaction(() => {
        const blocked = store.db.prepare("SELECT dispatch_id,role FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
          .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role } | undefined;
        if (!blocked || blocked.role !== "coding") throw new ValidationError("managed planned recovery requires a blocked Coding dispatch");
        store.decide(runId, decisionId, choice, note);
        store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
        dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket(managedCleanupPacket({
          worktreeIds: worktrees.map(({ worktree_id }) => worktree_id), decisionId, choice,
          conflictingRunIds: conflicts.map(({ run_id }) => run_id), planId: run.plan_id!, revision: run.revision!,
        }), "git-operator"), blocked.dispatch_id);
        store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND dispatch_id<>? AND state IN ('pending','claimed')")
          .run(new Date().toISOString(), runId, dispatchId);
        store.db.prepare("UPDATE runs SET state='active',stage='canceling',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        for (const conflict of conflicts) {
          store.db.prepare("UPDATE runs SET state='canceled',stage='reconciled',source_run_id=?,updated_at=? WHERE run_id=? AND state='failed'")
            .run(runId, new Date().toISOString(), conflict.run_id);
          store.event(conflict.run_id, "run.failed_start_reconciled", { source_run_id: runId, decision_id: decisionId, cleanup_dispatch_id: dispatchId });
        }
        store.event(runId, "run.reconciliation_requested", { decision_id: decisionId, cleanup_dispatch_id: dispatchId, conflicting_run_ids: conflicts.map(({ run_id }) => run_id), worktree_ids: worktrees.map(({ worktree_id }) => worktree_id) });
        const successor = store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
        const receipt = store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
        store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
          .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null, conflicting_run_ids: conflicts.map(({ run_id }) => run_id) }), decisionId);
        ops.changeStage!(store, ops, runId, "canceling", dispatchId);
      })();
      return dispatchId;
    }
    if (existingDecision?.decision_type === "active_run_recovery") {
      if (!existingDecision.dispatch_id) throw new ValidationError("active run recovery decision is not bound to its recovery dispatch");
      const scopeBlockedTestRepair = store.db.prepare(`SELECT 1 FROM dispatches
        WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer')
          AND json_extract(packet_json,'$.context.phase')='test_repair'
          AND json_extract(result_json,'$.status')='failed'
          AND json_extract(result_json,'$.failure_class')='allowed_path_blocked'`)
        .get(runId, existingDecision.dispatch_id);
      if (scopeBlockedTestRepair && choice !== "abort" && choice !== "new_plan_required") {
        throw new ValidationError("frozen Test repair requires a new plan or authorization; retry is unavailable");
      }
      if (choice === "abort" || scopeBlockedTestRepair && choice === "new_plan_required") {
        store.db.transaction(() => {
          store.decide(runId, decisionId, choice, note);
          store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
            .run(new Date().toISOString(), existingDecision.dispatch_id);
          store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?")
            .run(new Date().toISOString(), runId);
        })();
        return existingDecision.dispatch_id;
      }
      if (choice !== "retry") throw new ValidationError(`unsupported active run recovery choice: ${choice}`);
      const source = store.db.prepare(`SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for
        FROM dispatches WHERE run_id=? AND dispatch_id<>? AND state='completed'
        AND json_extract(packet_json,'$.context.phase') IS NOT 'resume_recovery'
        ORDER BY COALESCE(completed_at,created_at) DESC,created_at DESC LIMIT 1`)
        .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined;
      if (!source) throw new ValidationError("active run recovery has no durable stage dispatch to retry");
      const sourcePacket = JSON.parse(source.packet_json) as common.DispatchPacket;
      const authorityApplyDispatchId = source.role === "git-operator"
        && sourcePacket.context.phase === "continue_task_authority_conflict"
        && typeof sourcePacket.context.authority_apply_dispatch_id === "string"
        ? sourcePacket.context.authority_apply_dispatch_id
        : undefined;
      if (authorityApplyDispatchId) {
        throw new IncompatibleError("legacy task authority conflict receipt cannot be resumed", {
          reason_code: "legacy_task_authority_conflict_receipt",
          next_action: "start_new_run",
        });
      }
      let replacementId = "";
      store.db.transaction(() => {
        store.decide(runId, decisionId, choice, note);
        const receipt = store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
        const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
        store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), existingDecision.dispatch_id);
        store.db.prepare("UPDATE runs SET state='active',stage=?,updated_at=? WHERE run_id=?")
          .run(authorityApplyDispatchId ? "coding" : source.role, new Date().toISOString(), runId);
        replacementId = ops.recoveryReplacement!(store, ops, runId, source, resolvedDecision);
        const successor = store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(replacementId) as { packet_digest?: string };
        store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
          .run(stableJson({ ...resolvedDecision, successor_dispatch_id: replacementId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
        store.event(runId, "run.recovery_stage_reissued", { decision_id: decisionId, source_dispatch_id: source.dispatch_id, successor_dispatch_id: replacementId });
      })();
      return replacementId;
    }
    let dispatchId = "";
    store.db.transaction(() => {
      if (!existingDecision?.dispatch_id) throw new ValidationError("decision is not bound to a dispatch");
      const blocked = store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for,state FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
        .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string; state: string } | undefined;
      if (!blocked) throw new ValidationError("run has no dispatch waiting on this decision");
      store.decide(runId, decisionId, choice, note);
      const receipt = store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
      store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
      store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      if (blocked.role === "code-reviewer" && choice === "pre_commit_then_refreeze") {
        dispatchId = ops.ensurePreCommitDecisionContinuation!(store, ops, runId, decisionId, blocked.dispatch_id) ?? "";
        if (!dispatchId) throw new ValidationError("pre_commit_then_refreeze could not create a continuation");
        return;
      }
      let packet: common.DispatchPacket;
      if (choice === "reissue") {
        const reviewPacket = blocked.role === "code-reviewer"
          ? ops.buildReviewPacket!(store, ops, runId, undefined, { decision_id: decisionId, dispatch_id: blocked.dispatch_id, resolved_decision: resolvedDecision })
          : undefined;
        if (blocked.role === "code-reviewer" && !reviewPacket) {
          throw new ValidationError("review reissue requires complete current integration and test evidence");
        }
        packet = reviewPacket ?? common.validatePacket(reissuePacket(blocked.role, decisionId, blocked.dispatch_id, resolvedDecision), blocked.role);
      } else {
        dispatchId = ops.recoveryReplacement!(store, ops, runId, blocked, resolvedDecision);
        packet = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_json: string }).packet_json) as common.DispatchPacket;
      }
      if (choice === "reissue") dispatchId = ops.insert!(store, ops, runId, blocked.role, packet, blocked.dispatch_id);
      const successor = store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...resolvedDecision, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
      ops.changeStage!(store, ops, runId, blocked.role, dispatchId);
    })();
    return dispatchId;
  }

export function ensurePreCommitDecisionContinuation(store: common.StateStore, ops: common.DispatchOperations, runId: string, decisionId?: string, reviewDispatchId?: string): string | undefined {
    const decision = (decisionId
      ? store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND decision_id=? AND status='resolved' AND choice='pre_commit_then_refreeze'")
        .get(runId, decisionId)
      : store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='resolved' AND choice='pre_commit_then_refreeze' ORDER BY resolved_at DESC LIMIT 1")
        .get(runId)) as { decision_id: string; dispatch_id?: string; receipt_json: string } | undefined;
    if (!decision) return undefined;
    const sourceReviewId = reviewDispatchId ?? decision.dispatch_id;
    if (!sourceReviewId) return undefined;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')
      AND json_extract(packet_json,'$.context.decision_id')=?
      AND json_extract(packet_json,'$.context.phase') IN ('pre_commit_implementation','pre_commit_scope_remediation')
      ORDER BY created_at DESC LIMIT 1`).get(runId, decision.decision_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;

    const run = store.getRun(runId) as { mode?: string; plan_id?: string; revision?: string; plan_digest?: string };
    const worktree = ops.activeIntegrationWorktree!(store, ops, runId);
    if (!worktree) return undefined;
    const developers = store.db.prepare(`SELECT d.dispatch_id,d.role,d.packet_json,d.completed_at FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer') AND d.state='completed'
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)
      ORDER BY d.completed_at DESC,d.created_at DESC`).all(runId) as Array<{ dispatch_id: string; role: Role; packet_json: string; completed_at?: string }>;
    if (!developers.length) return undefined;
    const relevantDevelopers = developers.filter((developer) => {
      try { return (JSON.parse(developer.packet_json) as common.DispatchPacket).context.worktree_id === worktree.worktree_id; }
      catch { return false; }
    });
    if (!relevantDevelopers.length) return undefined;
    const developerAllowedWritePaths = [...new Set(relevantDevelopers.flatMap((developer) => (JSON.parse(developer.packet_json) as common.DispatchPacket).allowed_write_paths))];
    const primaryDeveloper = relevantDevelopers[0]!;
    const primaryPacket = JSON.parse(primaryDeveloper.packet_json) as common.DispatchPacket;
    const explorerDispatchId = typeof primaryPacket.context.explorer_dispatch_id === "string"
      ? primaryPacket.context.explorer_dispatch_id
      : undefined;
    if (!explorerDispatchId) return undefined;
    const explorer = store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'")
      .get(runId, explorerDispatchId) as { result_json?: string } | undefined;
    if (!explorer?.result_json) return undefined;
    const authorizedPaths = (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    const implementationArtifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, primaryDeveloper.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const test = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    const testArtifact = test ? store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, test.dispatch_id) as { artifact_id: string; sha256: string } | undefined : undefined;
    if (!implementationArtifact || !test || !testArtifact) return undefined;

    const changedPaths = common.dirtyWorktreePaths(worktree.path);
    const blockedPaths = changedPaths.filter((path) => !pathMatchesScope(path, developerAllowedWritePaths));
    if (run.mode === "planned" && changedPaths.length && !blockedPaths.length) {
      common.checkScope(store, runId, "pre_commit", changedPaths, worktree.worktree_id, {
        offending_dispatch_id: primaryDeveloper.dispatch_id,
        offending_worktree_id: worktree.worktree_id,
        actual_modified_paths: changedPaths,
        developer_allowed_write_paths: developerAllowedWritePaths,
      });
    }
    const commonContext = {
      decision_id: decision.decision_id,
      review_dispatch_id: sourceReviewId,
      plan_id: run.plan_id ?? null,
      revision: run.revision ?? null,
      plan_digest: run.plan_digest ?? null,
      explorer_dispatch_id: explorerDispatchId,
      worktree_id: worktree.worktree_id,
      worktree_path: worktree.path,
      implementation_dispatch_id: primaryDeveloper.dispatch_id,
      implementation_artifact: { artifact_id: implementationArtifact.artifact_id, digest: implementationArtifact.sha256 },
      test_dispatch_id: test.dispatch_id,
      test_artifact: { artifact_id: testArtifact.artifact_id, digest: testArtifact.sha256 },
      developer_dispatch_ids: relevantDevelopers.map(({ dispatch_id }) => dispatch_id),
      developer_allowed_write_paths: developerAllowedWritePaths,
      changed_paths: changedPaths,
    };
    let dispatchId: string;
    if (!changedPaths.length || blockedPaths.length) {
      dispatchId = ops.insert!(store, ops, runId, primaryDeveloper.role, common.validatePacket({
        objective: blockedPaths.length
          ? "Remediate the real dirty diff that falls outside the frozen developer write scope before commit."
          : "Restore the missing implementation dirty diff before pre-commit can continue.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Leave only implementation paths authorized by the frozen developer packet", "Return fresh implementation evidence before commit"],
        context: { ...commonContext, stage: primaryDeveloper.role, phase: "pre_commit_scope_remediation", blocked_changed_paths: blockedPaths },
      }, primaryDeveloper.role), sourceReviewId);
      ops.changeStage!(store, ops, runId, primaryDeveloper.role, dispatchId);
    } else {
      const packet = common.validatePacket({
        objective: "Commit the real dirty implementation diff, then refreeze tests and formal review on the new commit.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Commit only the real dirty paths within the frozen developer write scope", "Return the new implementation commit and committed paths"],
        context: { ...commonContext, stage: "git-operator", phase: "pre_commit_implementation", scope_digest: sha256(changedPaths.join("\n")) },
      }, "git-operator");
      common.assertExplorerAuthorization(store, runId, "git-operator", packet);
      dispatchId = ops.insert!(store, ops, runId, "git-operator", packet, sourceReviewId);
      ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
    }
    const successor = store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
    const receipt = JSON.parse(decision.receipt_json) as Record<string, unknown>;
    store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
      .run(stableJson({ ...receipt, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decision.decision_id);
    return dispatchId;
  }

export function ensureCodingCommitContinuation(store: common.StateStore, ops: common.DispatchOperations, runId: string): string | undefined {
    const run = store.getRun(runId) as { profile: string; state: string; mode?: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const preCommit = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' ORDER BY event_id DESC LIMIT 1")
      .get(runId) as { payload_json: string } | undefined;
    if (!preCommit && run.mode !== "planned") return undefined;
    const developers = store.db.prepare(`SELECT d.dispatch_id,d.state,d.packet_json,d.result_json FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer')
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)`).all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>;
    if (!developers.length || developers.some((developer) => developer.state !== "completed" || !developer.result_json)) return undefined;
    const developerWorktreeIds = developers.map((developer) => {
      try { return (JSON.parse(developer.packet_json) as common.DispatchPacket).context.worktree_id; }
      catch { return undefined; }
    });
    if (developerWorktreeIds.some((value) => typeof value !== "string" || !value)) return undefined;
    const worktreeIds = [...new Set(developerWorktreeIds as string[])];
    const activeTaskWorktrees = new Set((store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%'").all(runId) as Array<{ worktree_id: string }>).map((worktree) => worktree.worktree_id));
    if (run.mode === "planned") {
      const tasks = ops.plannedTaskRows!(store, ops, runId);
      if (tasks.length === 1 && tasks[0]!.worktree_id) activeTaskWorktrees.add(tasks[0]!.worktree_id);
    }
    if (worktreeIds.some((worktreeId) => !activeTaskWorktrees.has(worktreeId))) return undefined;
    const committed = new Set((store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>).flatMap((operation) => {
      try {
        const worktreeId = (JSON.parse(operation.evidence_json ?? "{}") as { worktree_id?: unknown }).worktree_id;
        return typeof worktreeId === "string" ? [worktreeId] : [];
      } catch { return []; }
    }));
    const uncommittedWorktreeIds = worktreeIds.filter((worktreeId) => !committed.has(worktreeId));
    if (!uncommittedWorktreeIds.length) return undefined;
    if (run.mode === "planned") {
      const tasks = ops.plannedTaskRows!(store, ops, runId);
      const untested = tasks.filter((task) => task.worktree_id && uncommittedWorktreeIds.includes(task.worktree_id) && task.state !== "tested");
      if (untested.length) return undefined;
    }
    const coordinator = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) return undefined;
    const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND replacement_for=? AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1")
      .get(runId, coordinator.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
    if (!explorer?.result_json) return undefined;
    const explorerResult = JSON.parse(explorer.result_json) as ResultEnvelope;
    const authorizedPaths = (explorerResult.payload as { allowed_read_paths?: unknown }).allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    const changedPaths = [...new Set(developers.flatMap((developer) => {
      try { return ((JSON.parse(developer.result_json!) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []; }
      catch { return []; }
    }))];
    if (run.mode === "planned") {
      for (const developer of developers) {
        const developerPacket = JSON.parse(developer.packet_json) as common.DispatchPacket;
        const developerResult = JSON.parse(developer.result_json!) as ResultEnvelope;
        const modifiedPaths = [...new Set((developerResult.payload as { modified_paths?: string[] }).modified_paths ?? [])].sort();
        const taskId = String(developerPacket.context.task_id);
        const worktreeId = String(developerPacket.context.worktree_id);
        const frozenTask = ops.plannedTaskRows!(store, ops, runId).find((task) => task.task_id === taskId);
        if (!frozenTask || frozenTask.developer_dispatch_id !== developer.dispatch_id || frozenTask.worktree_id !== worktreeId) {
          throw new ValidationError("planned developer result does not match frozen task/dispatch/worktree identity", {
            offending_task_id: taskId,
            offending_dispatch_id: developer.dispatch_id,
            offending_worktree_id: worktreeId,
            frozen_developer_dispatch_id: frozenTask?.developer_dispatch_id ?? null,
            frozen_worktree_id: frozenTask?.worktree_id ?? null,
          });
        }
        const frozenTaskWritePaths = ops.frozenTaskWritePaths!(store, ops, runId, taskId);
        const preCommitRow = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
          .get(runId, worktreeId) as { payload_json: string } | undefined;
        const preCommit = preCommitRow ? JSON.parse(preCommitRow.payload_json) as { paths?: string[]; digest?: string } : undefined;
        const preCommitPaths = preCommit?.paths ?? [];
        const unauthorizedPaths = [...new Set([
          ...modifiedPaths.filter((path) => !pathMatchesScope(path, frozenTaskWritePaths)
            || !pathMatchesScope(path, developerPacket.allowed_write_paths) || !preCommitPaths.includes(path)),
          ...preCommitPaths.filter((path) => !modifiedPaths.includes(path)),
        ])].sort();
        if (!preCommit || unauthorizedPaths.length) throw new ValidationError("planned developer paths are not authorized by the frozen Task and immutable pre_commit scope", {
          offending_task_id: taskId,
          offending_dispatch_id: developer.dispatch_id,
          offending_worktree_id: worktreeId,
          actual_modified_paths: modifiedPaths,
          unauthorized_paths: unauthorizedPaths,
          authorization_source_expected: "frozen Task write paths + developer packet allowed_write_paths + planned pre_commit scope",
          explorer_paths: authorizedPaths,
          frozen_task_paths: frozenTaskWritePaths,
          developer_allowed_write_paths: developerPacket.allowed_write_paths,
          pre_commit_paths: preCommitPaths,
          pre_commit_digest: preCommit?.digest ?? null,
        });
      }
    } else if (changedPaths.some((path) => !pathMatchesScope(path, authorizedPaths as string[]))) {
      throw new ValidationError("coding continuation developer paths are not authorized by Explorer evidence");
    }
    const plannedScopeDigests: Array<{ worktree_id: string; digest: string }> = [];
    if (run.mode === "planned") {
      for (const worktreeId of uncommittedWorktreeIds) {
        const worktreeDevelopers = developers.filter((developer) => {
          try {
            const packet = JSON.parse(developer.packet_json) as common.DispatchPacket;
            return packet.context.worktree_id === worktreeId;
          } catch { return false; }
        });
        const scopes = [...new Set(worktreeDevelopers.flatMap((developer) => {
          try { return ((JSON.parse(developer.result_json!) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []; }
          catch { return []; }
        }))].sort();
        if (!scopes.length) throw new ValidationError("planned pre_commit scope requires actual developer modified_paths");
        common.assertPreCommitScope(store, runId, scopes, worktreeId);
        const scopeRow = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
          .get(runId, worktreeId) as { payload_json: string };
        plannedScopeDigests.push({ worktree_id: worktreeId, digest: (JSON.parse(scopeRow.payload_json) as { digest: string }).digest });
      }
    }
    const scope = preCommit ? JSON.parse(preCommit.payload_json) as { digest?: unknown } : undefined;
    const packet = common.validatePacket({
      objective: "Continue the completed implementation by dispatching Git Operator to commit every uncommitted task worktree.",
      allowed_read_paths: authorizedPaths as string[],
      allowed_write_paths: [],
      acceptance_criteria: ["Create the Git Operator commit dispatch for every listed task worktree", "Preserve the completed pre_commit scope and Explorer authorization"],
      context: {
        stage: "coding",
        phase: "continue_commit",
        explorer_dispatch_id: explorer.dispatch_id,
        coordinator_dispatch_id: coordinator.dispatch_id,
        developer_dispatch_ids: developers.map((developer) => developer.dispatch_id),
        task_worktree_ids: uncommittedWorktreeIds,
        changed_paths: changedPaths,
        scope_digest: plannedScopeDigests.length
          ? sha256(stableJson(plannedScopeDigests))
          : typeof scope?.digest === "string" ? scope.digest : sha256(stableJson(changedPaths.sort())),
      },
    }, "coding");
    common.assertExplorerAuthorization(store, runId, "coding", packet);
    const dispatchId = ops.insert!(store, ops, runId, "coding", packet, coordinator.dispatch_id);
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }
