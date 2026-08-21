import { stat } from "node:fs/promises";
import { Role } from "../constants.js";
import { checkResultEnvelope, type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { assertReadablePath } from "../security.js";
import { verificationDigest, type PlanVerification, type TaskVerification } from "../planning.js";
import { readJson, stableJson } from "../utils.js";
import { assertPlanningSubmissionTransition } from "./planning.js";
import * as common from "./store.js";
export function freezeVerificationContext(store: common.StateStore, ops: common.DispatchOperations, runId: string, role: Role, packet: common.DispatchPacket): common.DispatchPacket {
    if (role !== "frontend-developer" && role !== "backend-developer" && role !== "test") return packet;
    const run = store.getRun(runId) as { plan_verification_json?: string };
    if (!run.plan_verification_json) return packet;
    const planVerification = JSON.parse(run.plan_verification_json) as PlanVerification;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    const taskRow = taskId ? store.db.prepare("SELECT verification_json FROM run_tasks WHERE run_id=? AND task_id=?")
      .get(runId, taskId) as { verification_json?: string } | undefined : undefined;
    if (taskId && !taskRow?.verification_json) throw new ValidationError(`frozen task verification is missing: ${taskId}`);
    const taskVerification = taskRow?.verification_json ? JSON.parse(taskRow.verification_json) as TaskVerification : undefined;
    const effectiveVerification = taskVerification ?? planVerification;
    const context = { ...packet.context } as Record<string, unknown>;
    const frozen: Record<string, unknown> = {
      plan_verification: planVerification,
      plan_verification_digest: verificationDigest(planVerification),
      ...(taskVerification ? {
        task_verification: taskVerification,
        task_verification_digest: verificationDigest(taskVerification),
      } : {}),
      verification_contract: effectiveVerification,
      verification_digest: verificationDigest(effectiveVerification),
    };
    if (role === "frontend-developer" || role === "backend-developer") {
      const existingOwners = (store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')").all(runId) as Array<{ packet_json: string }>)
        .map(({ packet_json }) => (JSON.parse(packet_json) as common.DispatchPacket).context.context_owner)
        .filter((owner): owner is string => typeof owner === "string");
      const contextOwner = existingOwners[0] ?? role;
      const explorerId = typeof context.explorer_dispatch_id === "string" ? context.explorer_dispatch_id : undefined;
      const explorer = explorerId ? store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'")
        .get(runId, explorerId) as { result_json?: string } | undefined : undefined;
      const maintenance = explorer?.result_json
        ? ((JSON.parse(explorer.result_json) as ResultEnvelope).payload.project_context as { maintenance?: { status?: string; paths?: string[] } } | undefined)?.maintenance
        : undefined;
      frozen.context_owner = contextOwner;
      frozen.context_maintenance = {
        owner: contextOwner,
        status: maintenance?.status ?? "verify and update when module responsibilities or entry points change",
        paths: maintenance?.paths ?? ["MEMORY.md", ".ai-team/index/feature-navigation.md"],
      };
    }
    for (const [key, value] of Object.entries(frozen)) {
      if (context[key] !== undefined && stableJson(context[key]) !== stableJson(value)) {
        throw new ValidationError(`dispatch packet ${key} does not match frozen verification context`, [`/context/${key}`]);
      }
      context[key] = value;
    }
    return { ...packet, context };
  }

export function assertVerificationEvidence(store: common.StateStore, ops: common.DispatchOperations, role: Role, packet: common.DispatchPacket, result: ResultEnvelope): void {
    if (result.status !== "completed") return;
    const context = packet.context as {
      phase?: string;
      operation?: string;
      verification_contract?: PlanVerification | TaskVerification;
      verification_digest?: string;
    };
    const authorityReceipt = role === "git-operator" && (
      (context.phase === "apply_task_authority" && context.operation === "apply-task-authority")
      || (context.phase === "continue_task_authority_conflict" && context.operation === "continue-task-authority-conflict")
    );
    if (authorityReceipt) return;
    if (!context.verification_contract || !context.verification_digest) return;
    const payload = result.payload as Record<string, unknown>;
    if (payload.verification_digest !== context.verification_digest) throw new ValidationError(`${role} TDD evidence digest does not match the frozen contract`);
    const criteria = context.verification_contract.acceptance_criteria;
    if (role === "frontend-developer" || role === "backend-developer") {
      const evidence = payload.tdd_evidence as Array<{ acceptance_criterion: string; test_path: string }> | undefined;
      if (!Array.isArray(evidence)) throw new ValidationError(`${role} completed result requires TDD evidence`);
      const evidenceIds = evidence.map(({ acceptance_criterion }) => acceptance_criterion);
      const missing = criteria.filter((id) => !evidenceIds.includes(id));
      const unknown = evidenceIds.filter((id) => !criteria.includes(id));
      if (missing.length || unknown.length || new Set(evidenceIds).size !== evidenceIds.length) {
        throw new ValidationError(`${role} TDD evidence does not cover the frozen acceptance criteria`, { missing, unknown });
      }
      if ("tdd_cycles" in context.verification_contract) {
        const invalidPaths = evidence.filter((item) => context.verification_contract && "tdd_cycles" in context.verification_contract
          && context.verification_contract.tdd_cycles.find(({ acceptance_criterion }) => acceptance_criterion === item.acceptance_criterion)?.test_path !== item.test_path);
        if (invalidPaths.length) throw new ValidationError(`${role} TDD evidence test paths do not match the frozen task contract`);
      }
    }
    if (role === "test") {
      const checks = payload.acceptance_checks as Array<{ acceptance_criterion: string }> | undefined;
      if (!Array.isArray(checks)) throw new ValidationError("Test completed result requires acceptance checks");
      const checkIds = checks.map(({ acceptance_criterion }) => acceptance_criterion);
      const missing = criteria.filter((id) => !checkIds.includes(id));
      const unknown = checkIds.filter((id) => !criteria.includes(id));
      if (missing.length || unknown.length || new Set(checkIds).size !== checkIds.length) {
        throw new ValidationError("Test acceptance checks do not cover the frozen acceptance criteria", { missing, unknown });
      }
    }
  }

export async function validateFile(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, path: string): Promise<ResultEnvelope> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    return ops.validateValue!(store, ops, runId, dispatchId, role, await readJson(path));
  }

export function validateValue(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, value: unknown): ResultEnvelope {
    const dispatch = ops.get!(store, ops, runId, dispatchId, role) as { state: string; packet_json: string };
    if (!["claimed", "completed", "needs_decision"].includes(dispatch.state)) {
      throw new ValidationError("dispatch must be claimed before validate");
    }
    const run = store.getRun(runId) as { state: string; stage: string };
    const validRunState = dispatch.state === "needs_decision"
      ? run.state === "needs_decision"
      : dispatch.state === "completed" ? run.state === "active" || run.state === "completed" || role === "planning" && run.state === "needs_decision" : run.state === "active";
    if (!validRunState && !ops.claimedRecoveryMayFinish!(store, ops, runId, dispatchId, role, dispatch, run.state)) {
      throw new ValidationError("run must be active before validate");
    }
    const result = checkResultEnvelope(value);
    if (!result.valid) throw new ValidationError("result envelope is invalid", result.errors);
    if (result.value.run_id !== runId || result.value.dispatch_id !== dispatchId || result.value.role !== role) {
      throw new ValidationError("result envelope identity does not match dispatch");
    }
    if (role === "planning" && dispatch.state === "claimed" && (result.value.status === "completed" || result.value.status === "needs_decision")) {
      const payload = result.value.payload as {
        stage: string;
        pending_questions: string[];
        decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string } | null;
      };
      const packet = JSON.parse(dispatch.packet_json) as common.DispatchPacket;
      assertPlanningSubmissionTransition(run.stage, payload.stage, packet.context, payload.decision, payload.pending_questions);
    }
    ops.assertVerificationEvidence!(store, ops, role, JSON.parse(dispatch.packet_json) as common.DispatchPacket, result.value);
    return result.value;
  }