import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Role } from "./constants.js";
import { checkDecisionInput, checkResultEnvelope, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "./contracts.js";
import { IncompatibleError, ValidationError, validationCause } from "./errors.js";
import { ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "./roles.js";
import { assertReadablePath, pathMatchesScope } from "./security.js";
import { assertExplicitTaskWritePaths, StateStore } from "./state.js";
import { assertRevisionRunStage, verificationDigest, type PlanVerification, type TaskVerification } from "./planning.js";
import { makeId, readJson, redact, sha256, stableJson, writeJson } from "./utils.js";
import type { ReviewFinding, ReviewResult } from "./review.js";
import { plannedWorktreeSnapshot, ScopeGate } from "./gates.js";
import { completedMergeOwnershipPartialEffect, resolveTaskIdentityWorktree, type MergeOwnershipPartialEffect } from "./worktree-ownership.js";
import { resolveReviewWorktree } from "./worktree-review.js";
import {
  dispatchPacketSchema as packetSchema,
  dispatchPacketTemplate as packetTemplate,
  EXPLORER_CONTEXT_PATHS as PACKET_EXPLORER_CONTEXT_PATHS,
  isBroadReadPath,
  mergeBindingsFromPacket as packetMergeBindings,
  promptFor as renderPrompt,
  promptForV2 as renderPromptV2,
  promptForV3 as renderPromptV3,
  RENDERER_VERSION as PACKET_RENDERER_VERSION,
  validatePacket as validateDispatchPacket,
} from "./dispatch/packet.js";
import { buildContinueTestingPacket, buildReviewPacket as assembleReviewPacket, buildTestPacket } from "./dispatch/implementation.js";
import { assertPlanningSubmissionTransition, planningContinuationPacket, planningSubmissionIntent, requirementClarificationMappings } from "./dispatch/planning.js";
import { isManagedPlannedRecovery, livenessRecoveryIntent, managedCleanupPacket, reconciliationIntent, reissuePacket, retryableResultHasNoSideEffects } from "./dispatch/recovery.js";
import { executionEnforcement, freezeAuthorityConflictContinuationExecutionContract, freezeExecutionContract, type ExecutionContract, type ExecutionRequest } from "./execution-contract.js";
import { recoveryProjection, type NextAction, type TimelineEntry } from "./run-recovery.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
  execution_request?: ExecutionRequest;
  execution_contract?: ExecutionContract;
}

export interface MergeWorktreeBindings {
  integration_worktree_id: string | null;
  task_worktree_ids: string[];
}

const mergeBindingsFromPacket = (role: Role, packet: DispatchPacket): MergeWorktreeBindings | undefined => {
  return packetMergeBindings(role, packet);
};

export interface RunResumeResult {
  run: Record<string, unknown>;
  pending_dispatches: Array<{ dispatch_id: string; role: string; state: string }>;
  pending_decision: Record<string, unknown> | null;
  pending_operations: Array<{ operation_id: string; kind: string; state: string }>;
  last_event: Record<string, unknown> | null;
  recovery: {
    state: "action_required";
    dispatch_id: string;
    side_effect_state: "completed" | "unknown";
    next_command: string | null;
    evidence_template?: Record<string, unknown>;
  } | null;
  timeline_tail: TimelineEntry[];
  next_actions: NextAction[];
  next_action: NextAction | null;
}

export interface DispatchContinuation {
  run_state: string;
  run_stage: string;
  pending_dispatches: Array<{ dispatch_id: string; role: string; state: string; depends_on: string[] }>;
  pending_decision: Record<string, unknown> | null;
}

export interface DispatchSubmission {
  reused: boolean;
  artifact: string;
  submission: {
    state: "submitted";
    dispatch_state: string;
    artifact_id: string;
    artifact: string;
    digest: string;
  };
  continuation: DispatchContinuation;
}

export interface DispatchBundle {
  reused: boolean;
  packet: DispatchPacket;
  prompt: string;
  schema: unknown;
  template: ResultEnvelope;
  packet_schema: unknown;
  packet_template: DispatchPacket;
  digests: { packet: string; prompt: string; schema: string; template: string };
  renderer_version: string;
  execution_enforcement: Record<string, unknown>;
}

type ReplacementAction = "reissued" | "superseded" | "reconciled";
type ReplacementResult<Action extends ReplacementAction> = {
  action: Action;
  dispatch_id: string;
  replacement_for: string;
  reused: boolean;
};

interface ReviewBarrierRow {
  barrier_id: string;
  run_id: string;
  revision_sha: string;
  formal: number;
  state: string;
  repair_commit?: string;
  verification_evidence?: string;
  axes_json?: string;
  spec_dispatch_id?: string;
  standards_dispatch_id?: string;
}

const RENDERER_VERSION = PACKET_RENDERER_VERSION;
const EXPLORER_CONTEXT_PATHS = PACKET_EXPLORER_CONTEXT_PATHS;
export const dispatchPacketSchema = (role: Role, phase?: unknown, taskId?: unknown): Record<string, unknown> => {
  return packetSchema(role, phase, taskId);
};

export const dispatchPacketTemplate = (role: Role, packet: DispatchPacket): DispatchPacket => {
  return packetTemplate(role, packet);
};

interface ImplementationSnapshot {
  coordinatorDispatchId: string;
  explorerDispatchId: string | null;
  authorizedPaths: string[];
  developerDispatchIds: string[];
  implementationDispatchId: string;
  implementationArtifact: { artifact_id: string; digest: string };
  implementationArtifacts: Array<{ task_id?: string; dispatch_id: string; artifact_id: string; digest: string }>;
  implementationCommit: string;
  implementationCommitted: boolean;
  changedPaths: string[];
  worktreeId: string;
  worktreePath: string;
  planId: string | null;
  revision: string | null;
  planDigest: string | null;
  frozenTaskIds: string[];
  testCommands: string[];
  testCommandProvenance: { explorer_dispatch_id: string; plan_id: string | null; revision: string | null; repo_id: string };
}

const dirtyWorktreePaths = (worktreePath: string): string[] => {
  const tracked = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
};

const successfulOutcome = (value: unknown): boolean => typeof value === "string"
  && ["passed", "success", "succeeded", "completed", "ok"].includes(value.trim().toLowerCase());

const promptForV2 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV2(runId, dispatchId, role, packet),
].join("");
const promptForV3 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV3(runId, dispatchId, role, packet),
].join("");
const promptFor = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPrompt(runId, dispatchId, role, packet),
].join("");

const validatePacket = (packet: unknown, role: Role): DispatchPacket => {
  return validateDispatchPacket(packet, role);
};

const validateReviewResult = (result: ReviewResult): void => {
  if (!result.summary || !Array.isArray(result.findings)) throw new ValidationError("review result requires summary and findings");
  const ids = new Set<string>();
  for (const finding of result.findings) {
    if (!/^FIND-[A-Z]+-\d{3}$/.test(finding.finding_id)) throw new ValidationError(`invalid finding id: ${finding.finding_id}`);
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new ValidationError(`invalid finding severity: ${finding.finding_id}`);
    if (!finding.title || !finding.source || !finding.source_file || !Number.isInteger(finding.source_line) || finding.source_line < 1 || !finding.evidence || !finding.impact || !finding.recommendation) {
      throw new ValidationError(`finding lacks source, location, impact, or recommendation: ${finding.finding_id}`);
    }
    if (ids.has(finding.finding_id)) throw new ValidationError(`duplicate finding id: ${finding.finding_id}`);
    ids.add(finding.finding_id);
  }
};

const assertExplorerAuthorization = (store: StateStore, runId: string, role: Role, packet: DispatchPacket): void => {
  if (role === "file-explorer") return;
  const context = packet.context as { explorer_dispatch_id?: string; path_authorization?: string[] };
  if (!context.explorer_dispatch_id) return;
  const explorer = store.db.prepare("SELECT state,role,result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, context.explorer_dispatch_id) as { state: string; role: string; result_json?: string } | undefined;
  if (!explorer || explorer.role !== "file-explorer" || explorer.state !== "completed" || !explorer.result_json) throw new ValidationError("downstream dispatch requires a completed Explorer dispatch");
  const payload = JSON.parse(explorer.result_json) as { payload?: { allowed_read_paths?: string[] } };
  const plannedPaths = (store.db.prepare("SELECT write_paths_json FROM run_tasks WHERE run_id=? AND write_paths_json IS NOT NULL").all(runId) as Array<{ write_paths_json: string }>)
    .flatMap(({ write_paths_json }) => JSON.parse(write_paths_json) as string[]);
  const authorized = [...(payload.payload?.allowed_read_paths ?? []), ...(context.path_authorization ?? []), ...plannedPaths];
  const unauthorized = packet.allowed_read_paths.filter((path) => !pathMatchesScope(path, authorized));
  if (unauthorized.length) throw new ValidationError("downstream read paths are not authorized by Explorer evidence", unauthorized.map((path) => ({
    path: "/allowed_read_paths",
    pointer: "/allowed_read_paths",
    field: "allowed_read_paths",
    constraint: "authorization",
    message: `unauthorized path: ${path}`,
  })));
};

export class DispatchService {
  constructor(readonly store: StateStore) {}

  private freezeVerificationContext(runId: string, role: Role, packet: DispatchPacket): DispatchPacket {
    if (role !== "frontend-developer" && role !== "backend-developer" && role !== "test") return packet;
    const run = this.store.getRun(runId) as { plan_verification_json?: string };
    if (!run.plan_verification_json) return packet;
    const planVerification = JSON.parse(run.plan_verification_json) as PlanVerification;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    const taskRow = taskId ? this.store.db.prepare("SELECT verification_json FROM run_tasks WHERE run_id=? AND task_id=?")
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
      const existingOwners = (this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')").all(runId) as Array<{ packet_json: string }>)
        .map(({ packet_json }) => (JSON.parse(packet_json) as DispatchPacket).context.context_owner)
        .filter((owner): owner is string => typeof owner === "string");
      const contextOwner = existingOwners[0] ?? role;
      const explorerId = typeof context.explorer_dispatch_id === "string" ? context.explorer_dispatch_id : undefined;
      const explorer = explorerId ? this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'")
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

  private assertVerificationEvidence(role: Role, packet: DispatchPacket, result: ResultEnvelope): void {
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

  private createTestRepair(runId: string, sourceTestDispatchId: string, packet: DispatchPacket, result: ResultEnvelope): string | undefined {
    const phase = typeof packet.context.phase === "string" ? packet.context.phase : undefined;
    const testScope = phase === "task_test" ? "task" : phase === "review_repair_test" ? "review_repair" : "final";
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    const barrierId = typeof packet.context.barrier_id === "string" ? packet.context.barrier_id : undefined;
    const worktreeId = typeof packet.context.worktree_id === "string" ? packet.context.worktree_id : undefined;
    const implementationDispatchId = typeof packet.context.implementation_dispatch_id === "string" ? packet.context.implementation_dispatch_id : undefined;
    const developer = implementationDispatchId
      ? this.store.db.prepare("SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer')")
        .get(runId, implementationDispatchId) as { dispatch_id: string; role: Role; packet_json: string } | undefined
      : worktreeId ? this.store.db.prepare(`SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')
          AND json_extract(packet_json,'$.context.worktree_id')=? ORDER BY completed_at DESC,created_at DESC LIMIT 1`)
        .get(runId, worktreeId) as { dispatch_id: string; role: Role; packet_json: string } | undefined : undefined;
    if (!developer || !worktreeId) return undefined;
    const developerPacket = JSON.parse(developer.packet_json) as DispatchPacket;
    const attemptRow = this.store.db.prepare(`SELECT COALESCE(MAX(attempt),0) AS attempt FROM test_repair_lineage
      WHERE run_id=? AND test_scope=? AND COALESCE(task_id,'')=COALESCE(?,'') AND COALESCE(barrier_id,'')=COALESCE(?,'')`)
      .get(runId, testScope, taskId ?? null, barrierId ?? null) as { attempt: number };
    const failedChecks = Array.isArray((result.payload as { checks?: unknown }).checks)
      ? (result.payload as { checks: unknown[] }).checks : [];
    const codingId = this.insert(runId, "coding", validatePacket({
      objective: `Coordinate ${testScope} Test repair attempt ${attemptRow.attempt + 1} with the original ${developer.role}.`,
      allowed_read_paths: developerPacket.allowed_read_paths,
      allowed_write_paths: [],
      acceptance_criteria: ["Delegate exactly once to the original Developer role and worktree", "Preserve the failed Test scope and evidence"],
      context: {
        stage: "coding", phase: "test_repair", test_scope: testScope, attempt: attemptRow.attempt + 1,
        source_test_dispatch_id: sourceTestDispatchId, original_developer_dispatch_id: developer.dispatch_id,
        developer_role: developer.role, worktree_id: worktreeId,
        ...(typeof packet.context.worktree_path === "string" ? { worktree_path: packet.context.worktree_path } : {}),
        ...(typeof packet.context.explorer_dispatch_id === "string" ? { explorer_dispatch_id: packet.context.explorer_dispatch_id } : {}),
        ...(taskId ? { task_id: taskId } : {}), ...(barrierId ? { barrier_id: barrierId } : {}),
        failed_checks: failedChecks,
      },
    }, "coding"), sourceTestDispatchId);
    this.store.db.prepare(`INSERT INTO test_repair_lineage(source_test_dispatch_id,run_id,test_scope,attempt,task_id,barrier_id,
      original_developer_dispatch_id,developer_role,worktree_id,coding_dispatch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sourceTestDispatchId, runId, testScope, attemptRow.attempt + 1, taskId ?? null, barrierId ?? null,
        developer.dispatch_id, developer.role, worktreeId, codingId, new Date().toISOString());
    this.store.db.prepare("UPDATE runs SET state='active',stage='coding',updated_at=? WHERE run_id=?")
      .run(new Date().toISOString(), runId);
    this.store.event(runId, "test.repair_created", { source_test_dispatch_id: sourceTestDispatchId, coding_dispatch_id: codingId, test_scope: testScope, attempt: attemptRow.attempt + 1, task_id: taskId ?? null, barrier_id: barrierId ?? null, developer_role: developer.role, worktree_id: worktreeId });
    return codingId;
  }

  private resumeFailedTestRepair(runId: string): boolean {
    const failed = this.store.db.prepare(`SELECT dispatch_id,packet_json,result_json FROM dispatches
      WHERE run_id=? AND role='test' AND state='failed' ORDER BY completed_at DESC,created_at DESC LIMIT 1`)
      .get(runId) as { dispatch_id: string; packet_json: string; result_json?: string } | undefined;
    if (!failed?.result_json) return false;
    const existing = this.store.db.prepare("SELECT 1 FROM test_repair_lineage WHERE source_test_dispatch_id=?").get(failed.dispatch_id);
    if (existing) return false;
    let result: ResultEnvelope;
    try { result = JSON.parse(failed.result_json) as ResultEnvelope; }
    catch { return false; }
    if (!["failed", "retryable_failure"].includes(result.status) || result.side_effect_state !== "none" || result.decisions_needed.length) return false;
    const packet = JSON.parse(failed.packet_json) as DispatchPacket;
    this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=? AND state='failed'")
      .run(new Date().toISOString(), runId);
    const repairDispatchId = this.createTestRepair(runId, failed.dispatch_id, packet, result);
    if (!repairDispatchId) {
      this.store.db.prepare("UPDATE runs SET state='failed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      return false;
    }
    this.store.event(runId, "test.repair_resumed", { source_test_dispatch_id: failed.dispatch_id, coding_dispatch_id: repairDispatchId });
    return true;
  }

  private ensureTestRepairDeveloperDispatch(runId: string, codingDispatchId: string): string {
    const lineage = this.store.db.prepare(`WITH RECURSIVE coding_ancestors(dispatch_id,replacement_for) AS (
      SELECT dispatch_id,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding'
      UNION ALL
      SELECT dispatches.dispatch_id,dispatches.replacement_for FROM dispatches
        JOIN coding_ancestors ON coding_ancestors.replacement_for=dispatches.dispatch_id
        WHERE dispatches.run_id=? AND dispatches.role='coding'
    )
    SELECT source_test_dispatch_id,test_scope,task_id,barrier_id,original_developer_dispatch_id,
      developer_role,worktree_id,repair_developer_dispatch_id FROM test_repair_lineage
      WHERE run_id=? AND coding_dispatch_id IN (SELECT dispatch_id FROM coding_ancestors)`)
      .get(runId, codingDispatchId, runId, runId) as {
        source_test_dispatch_id: string;
        test_scope: string;
        task_id?: string;
        barrier_id?: string;
        original_developer_dispatch_id: string;
        developer_role: Role;
        worktree_id: string;
        repair_developer_dispatch_id?: string;
      } | undefined;
    if (!lineage) throw new ValidationError("completed Test repair is missing its frozen lineage");
    if (lineage.repair_developer_dispatch_id) return lineage.repair_developer_dispatch_id;

    const coordinator = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'")
      .get(runId, codingDispatchId) as { packet_json: string } | undefined;
    const developer = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=? AND state='completed'")
      .get(runId, lineage.original_developer_dispatch_id, lineage.developer_role) as { packet_json: string } | undefined;
    const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
      .get(runId, lineage.worktree_id) as { path: string } | undefined;
    const testArtifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
      .get(runId, lineage.source_test_dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    if (!coordinator || !developer || !worktree || !testArtifact) {
      throw new ValidationError("completed Test repair cannot create its original Developer continuation");
    }

    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const originalDeveloperPacket = JSON.parse(developer.packet_json) as DispatchPacket;
    const failedChecks = Array.isArray(coordinatorPacket.context.failed_checks) ? coordinatorPacket.context.failed_checks : undefined;
    if (!failedChecks) throw new ValidationError("completed Test repair is missing frozen failed checks");
    if (originalDeveloperPacket.context.worktree_id !== lineage.worktree_id) {
      throw new ValidationError("Test repair original Developer worktree does not match its frozen lineage");
    }
    const requiredCommands = [...new Set(failedChecks.flatMap((check) => check && typeof check === "object" && typeof (check as { command?: unknown }).command === "string"
      ? [(check as { command: string }).command] : []))];
    const packet = validatePacket({
      objective: `Repair frozen ${lineage.test_scope} Test failures in the original ${lineage.developer_role} worktree.`,
      allowed_read_paths: originalDeveloperPacket.allowed_read_paths,
      allowed_write_paths: originalDeveloperPacket.allowed_write_paths,
      acceptance_criteria: ["Resolve the frozen failed Test checks", "Preserve the original Developer worktree and repair evidence"],
      context: {
        stage: "coding",
        phase: "test_repair",
        test_scope: lineage.test_scope,
        source_test_dispatch_id: lineage.source_test_dispatch_id,
        original_developer_dispatch_id: lineage.original_developer_dispatch_id,
        coordinator_dispatch_id: codingDispatchId,
        worktree_id: lineage.worktree_id,
        worktree_path: worktree.path,
        ...(typeof originalDeveloperPacket.context.explorer_dispatch_id === "string" ? { explorer_dispatch_id: originalDeveloperPacket.context.explorer_dispatch_id } : {}),
        ...(lineage.task_id ? { task_id: lineage.task_id } : {}),
        ...(lineage.barrier_id ? { barrier_id: lineage.barrier_id } : {}),
        predecessor_repair: {
          required: true,
          handled_tests: [{
            dispatch_id: lineage.source_test_dispatch_id,
            artifact_id: testArtifact.artifact_id,
            digest: testArtifact.sha256,
            failed_checks: failedChecks,
          }],
          required_commands: requiredCommands,
        },
      },
    }, lineage.developer_role);
    const frozen = freezeExecutionContract(lineage.developer_role, this.freezeVerificationContext(runId, lineage.developer_role, packet));
    assertExplorerAuthorization(this.store, runId, lineage.developer_role, frozen);
    const dispatchId = this.insert(runId, lineage.developer_role, frozen, lineage.original_developer_dispatch_id);
    const updated = this.store.db.prepare("UPDATE test_repair_lineage SET repair_developer_dispatch_id=? WHERE run_id=? AND source_test_dispatch_id=? AND repair_developer_dispatch_id IS NULL")
      .run(dispatchId, runId, lineage.source_test_dispatch_id);
    if (updated.changes !== 1) throw new ValidationError("Test repair Developer continuation was created concurrently");
    this.store.event(runId, "test.repair_developer_dispatch_created", {
      coding_dispatch_id: codingDispatchId,
      repair_developer_dispatch_id: dispatchId,
      source_test_dispatch_id: lineage.source_test_dispatch_id,
      original_developer_dispatch_id: lineage.original_developer_dispatch_id,
      developer_role: lineage.developer_role,
      worktree_id: lineage.worktree_id,
    });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private createRepairRetest(runId: string, sourceTestDispatchId: string, developerDispatchId: string, commit?: string, changedPaths?: string[]): string {
    const lineage = this.store.db.prepare("SELECT * FROM test_repair_lineage WHERE run_id=? AND source_test_dispatch_id=?")
      .get(runId, sourceTestDispatchId) as { test_scope: string; attempt: number; worktree_id: string; task_id?: string; barrier_id?: string } | undefined;
    const source = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='test'")
      .get(runId, sourceTestDispatchId) as { packet_json: string } | undefined;
    const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, developerDispatchId) as { artifact_id: string; sha256: string } | undefined;
    if (!lineage || !source || !artifact) throw new ValidationError("repair retest cannot freeze its lineage and Developer artifact");
    const original = JSON.parse(source.packet_json) as DispatchPacket;
    const context = {
      ...original.context,
      stage: "test",
      repair_attempt: lineage.attempt,
      repaired_from_test_dispatch_id: sourceTestDispatchId,
      implementation_dispatch_id: developerDispatchId,
      implementation_artifact: { artifact_id: artifact.artifact_id, digest: artifact.sha256 },
      ...(commit ? { implementation_commit: commit, implementation_committed: true } : { implementation_committed: false }),
      ...(changedPaths ? { changed_paths: changedPaths } : {}),
    };
    const retestId = this.insert(runId, "test", validatePacket({
      objective: `Re-run the frozen ${lineage.test_scope} Test after repair attempt ${lineage.attempt}.`,
      allowed_read_paths: original.allowed_read_paths,
      allowed_write_paths: [],
      acceptance_criteria: original.acceptance_criteria,
      context,
    }, "test"), sourceTestDispatchId);
    this.store.db.prepare("UPDATE test_repair_lineage SET retest_dispatch_id=? WHERE source_test_dispatch_id=?")
      .run(retestId, sourceTestDispatchId);
    this.changeStage(runId, "test", retestId);
    this.store.event(runId, "test.retest_created", { source_test_dispatch_id: sourceTestDispatchId, retest_dispatch_id: retestId, developer_dispatch_id: developerDispatchId, attempt: lineage.attempt });
    return retestId;
  }

  create(runId: string, role: Role, packet: DispatchPacket, actorRole?: Role, actorDispatchId?: string): string {
    const run = this.store.getRun(runId) as { profile: Role; state: string };
    if (run.state !== "active") throw new ValidationError(`run must be active before dispatch creation: ${run.state}`);
    const actor = actorRole ?? run.profile;
    const reviewerActor = run.profile === "coding" && actor === "code-reviewer" && (role === "code-reviewer" || role === "review-spec" || role === "review-standards");
    if (actorRole && actorRole !== run.profile && !reviewerActor) throw new ValidationError(`${actorRole} cannot act for ${run.profile} run`);
    let actorPacket: DispatchPacket | undefined;
    if (actorDispatchId) {
      this.assertClaimed(runId, actorDispatchId, actor);
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?")
        .get(runId, actorDispatchId, actor) as { packet_json: string };
      actorPacket = JSON.parse(row.packet_json) as DispatchPacket;
    }
    this.assertCommandAllowed(actor, "dispatch create");
    const definition = ROLE_MANIFEST[actor];
    if (role !== actor && !definition.delegates.includes(role)) {
      throw new ValidationError(`${actor} cannot delegate to ${role}`);
    }
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    let validated = validatePacket(packet, role);
    if (actorRole === "coding" && role === "git-operator" && validated.context.phase === "prepare_implementation_worktree" && /^TASK-\d{3}$/.test(String(validated.context.task_id ?? ""))) {
      if (validated.context.coordinator_dispatch_id !== actorDispatchId) {
        throw new ValidationError("planned task prepare packet must preserve its Coding coordinator identity", ["/context/coordinator_dispatch_id"]);
      }
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") {
      this.assertContinueTestingDelegation(actorDispatchId!, role, actorPacket, validated);
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_implementation") {
      this.assertContinueImplementationDelegation(runId, actorDispatchId!, role, actorPacket, validated);
    }
    let replacementFor: string | undefined;
    if (actorPacket && actorPacket.context.phase === "test_repair") {
      if (role !== "frontend-developer" && role !== "backend-developer") throw new ValidationError("test repair Coding dispatch can only delegate to its original Developer role");
      const lineage = this.store.db.prepare("SELECT * FROM test_repair_lineage WHERE run_id=? AND coding_dispatch_id=?")
        .get(runId, actorDispatchId) as { source_test_dispatch_id: string; original_developer_dispatch_id: string; developer_role: string; worktree_id: string; task_id?: string; barrier_id?: string } | undefined;
      if (!lineage || role !== lineage.developer_role || validated.context.worktree_id !== lineage.worktree_id
        || validated.context.source_test_dispatch_id !== lineage.source_test_dispatch_id
        || validated.context.coordinator_dispatch_id !== actorDispatchId
        || (lineage.task_id && validated.context.task_id !== lineage.task_id)
        || (lineage.barrier_id && validated.context.barrier_id !== lineage.barrier_id)) {
        throw new ValidationError("test repair Developer packet must preserve the original role, worktree, and Test scope");
      }
      validated.context.phase = "test_repair";
      replacementFor = lineage.original_developer_dispatch_id;
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "review_resolution"
      && (role === "frontend-developer" || role === "backend-developer")) {
      const barrierId = (actorPacket.context as { barrier_id?: unknown }).barrier_id;
      const integration = this.activeIntegrationWorktree(runId);
      if (typeof barrierId !== "string" || validated.context.barrier_id !== barrierId
        || !integration || validated.context.worktree_id !== integration.worktree_id) {
        throw new ValidationError("review repair developer packet must preserve the barrier and plan worktree identity", [
          "/context/barrier_id", "/context/worktree_id",
        ]);
      }
      validated.context.phase = "review_repair";
    }
    validated = freezeExecutionContract(role, this.freezeVerificationContext(runId, role, validated));
    if (role === "file-explorer") {
      const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get((this.store.getRun(runId) as { repo_id: string }).repo_id) as { project_path: string } | undefined;
      const missing = repository ? EXPLORER_CONTEXT_PATHS.filter((path) => !existsSync(join(repository.project_path, path))) : [...EXPLORER_CONTEXT_PATHS];
      if (missing.length) throw new ValidationError("File Explorer packet requires initialized project context", missing.map((path) => ({
        path: `/${path}`, pointer: `/${path}`, constraint: "exists", message: `${path} does not exist`, suggestion: `Run ai-team init ${repository?.project_path ?? "<project>"} --yes, then retry the run start.`,
      })));
    }
    assertExplorerAuthorization(this.store, runId, role, validated);
    if (actorRole === "coding" && (role === "frontend-developer" || role === "backend-developer")) {
      const tasks = this.plannedTaskRows(runId);
      if (tasks.length === 1 && validated.context.task_id !== tasks[0]!.task_id) {
        throw new ValidationError("single explicit planned Task developer packet must preserve its frozen task identity", ["/context/task_id"]);
      }
      const worktreeId = (validated.context as { worktree_id?: unknown }).worktree_id;
      if (typeof worktreeId !== "string" || !worktreeId) throw new ValidationError(`${role} dispatch requires context.worktree_id`, ["/context/worktree_id"]);
      const worktree = this.store.db.prepare("SELECT branch FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId) as { branch: string } | undefined;
      const plannedPlanWorktree = (this.store.getRun(runId) as { mode?: string }).mode === "planned" && worktree?.branch.startsWith("plan/");
      if (!worktree?.branch.startsWith("task/") && !plannedPlanWorktree) throw new ValidationError(`${role} dispatch requires a prepared active implementation worktree`, ["/context/worktree_id"]);
    }
    const dispatchId = this.insert(runId, role, validated, replacementFor);
    if (replacementFor && actorPacket?.context.phase === "test_repair") {
      this.store.db.prepare("UPDATE test_repair_lineage SET repair_developer_dispatch_id=? WHERE coding_dispatch_id=?").run(dispatchId, actorDispatchId);
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") this.changeStage(runId, "test", dispatchId);
    return dispatchId;
  }

  private assertContinueImplementationDelegation(runId: string, actorDispatchId: string, role: Role, coordinator: DispatchPacket, packet: DispatchPacket): void {
    if (role !== "frontend-developer" && role !== "backend-developer") {
      throw new ValidationError("continue_implementation Coding dispatch can only delegate to a developer role");
    }
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = ["explorer_dispatch_id", "task_id", "worktree_id", "worktree_path"];
    if (expected.predecessor_repair !== undefined) inherited.push("predecessor_repair");
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_implementation developer packet must preserve its frozen task identity", mismatch.map((key) => `/context/${key}`));
    if (this.plannedTaskRows(runId).some((task) => task.task_id === expected.task_id)) {
      const frozenTaskWritePaths = this.frozenTaskWritePaths(runId, String(expected.task_id));
      const unauthorized = packet.allowed_write_paths.filter((path) => !pathMatchesScope(path, frozenTaskWritePaths));
      if (unauthorized.length) throw new ValidationError("continue_implementation developer write paths exceed the frozen Task authorization", {
        offending_dispatch_id: actorDispatchId,
        unauthorized_paths: unauthorized,
        authorization_source_expected: "frozen Task allowed write paths",
        frozen_task_write_paths: frozenTaskWritePaths,
      });
    }
  }

  private assertContinueTestingDelegation(actorDispatchId: string, role: Role, coordinator: DispatchPacket, packet: DispatchPacket): void {
    if (role !== "test") throw new ValidationError("continue_testing Coding dispatch can only delegate to Test");
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = [
      "explorer_dispatch_id", "plan_id", "revision", "plan_digest", "worktree_id", "worktree_path",
      "implementation_dispatch_id", "implementation_artifact", "implementation_artifacts", "implementation_commit", "implementation_committed",
      "changed_paths", "frozen_task_ids", "test_commands", "test_command_provenance",
    ];
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_testing Test packet must preserve its frozen implementation evidence", mismatch.map((key) => `/context/${key}`));
  }

  createPlanningCommit(runId: string, packet: DispatchPacket): string {
    const run = this.store.getRun(runId) as { profile: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.profile !== "planning" || !run.plan_id || !run.revision) throw new ValidationError("planning commit requires a bound planning revision");
    this.store.assertPlanningClarificationsResolved(runId);
    const revision = this.store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
    if (revision?.state !== "plan_ready") throw new ValidationError("planning commit dispatch requires a plan_ready revision");
    const context = packet.context as { plan_id?: string; revision?: string };
    if (context.plan_id !== run.plan_id || context.revision !== run.revision) {
      throw new ValidationError("planning commit packet does not match the bound planning revision");
    }
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state!='failed'
      AND json_extract(packet_json,'$.context.plan_id')=? AND json_extract(packet_json,'$.context.revision')=?`)
      .get(runId, run.plan_id, run.revision) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    return this.insert(runId, "git-operator", freezeExecutionContract("git-operator", validatePacket(packet, "git-operator")));
  }

  private insert(runId: string, role: Role, packet: DispatchPacket, replacementFor?: string): string {
    packet = this.freezeVerificationContext(runId, role, packet);
    packet = packet.execution_contract ? packet : freezeExecutionContract(role, packet);
    const dispatchId = makeId("dispatch");
    const packetJson = redact(stableJson(packet));
    const frozenPacket = JSON.parse(packetJson) as DispatchPacket;
    const prompt = redact(promptFor(runId, dispatchId, role, frozenPacket));
    const template = createResultTemplate(runId, dispatchId, role);
    if (role === "planning" && typeof frozenPacket.context.target_stage === "string") {
      template.payload = { ...template.payload, stage: frozenPacket.context.target_stage };
    }
    if (role === "review-spec" || role === "review-standards") {
      const barrierId = (frozenPacket.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId === "string") template.payload = { barrier_id: barrierId, finding_ids: [] };
    }
    const schemaJson = stableJson(resultSchemaForRole(role));
    const templateJson = stableJson(template);
    const digests = { packet: sha256(packetJson), schema: sha256(schemaJson), template: sha256(templateJson), prompt: sha256(prompt) };
    const columns = new Set((this.store.db.prepare("PRAGMA table_info(dispatches)").all() as Array<{ name: string }>).map((item) => item.name));
    this.store.db.transaction(() => {
      if (["packet_digest", "prompt_digest", "schema_digest", "template_digest", "renderer_version"].every((column) => columns.has(column))) {
        this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,packet_digest,prompt_digest,schema_digest,template_digest,renderer_version,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, digests.packet, digests.prompt, digests.schema, digests.template, RENDERER_VERSION, new Date().toISOString());
      } else {
        this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, new Date().toISOString());
      }
      if (replacementFor) this.store.db.prepare("UPDATE dispatches SET replacement_for=? WHERE dispatch_id=?").run(replacementFor, dispatchId);
      const bindings = mergeBindingsFromPacket(role, frozenPacket);
      if (bindings) {
        if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) {
          throw new ValidationError("merge dispatch requires persisted integration and task worktree bindings");
        }
        const insertBinding = this.store.db.prepare(`INSERT INTO dispatch_worktree_bindings(dispatch_id,run_id,binding_kind,worktree_id,created_at)
          VALUES (?,?,?,?,?)`);
        const createdAt = new Date().toISOString();
        insertBinding.run(dispatchId, runId, "integration", bindings.integration_worktree_id, createdAt);
        for (const worktreeId of bindings.task_worktree_ids) insertBinding.run(dispatchId, runId, "task", worktreeId, createdAt);
        this.assertStoredMergeWorktreeBindings(runId, dispatchId, bindings.integration_worktree_id, bindings.task_worktree_ids, true);
      }
      this.store.event(runId, "dispatch.created", { dispatchId, role, replacement_for: replacementFor ?? null, packet_digest: digests.packet, schema_digest: digests.schema, template_digest: digests.template, prompt_digest: digests.prompt, renderer_version: RENDERER_VERSION });
    })();
    return dispatchId;
  }

  private recoveryReplacement(
    runId: string,
    failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string },
    resolvedDecision?: Record<string, unknown>,
    replacementFor = failed.dispatch_id,
    additionalVerification: unknown[] = [],
  ): string {
    const previous = JSON.parse(failed.packet_json) as DispatchPacket;
    const result = failed.result_json ? JSON.parse(failed.result_json) as ResultEnvelope : undefined;
    let root = failed;
    const lineagePackets: DispatchPacket[] = [previous];
    while (root.replacement_for) {
      const parent = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
        .get(runId, root.replacement_for) as typeof root | undefined;
      if (!parent) break;
      root = parent;
      lineagePackets.push(JSON.parse(parent.packet_json) as DispatchPacket);
    }
    const rootPacket = JSON.parse(root.packet_json) as DispatchPacket;
    const lineageRecovery = lineagePackets.map((packet) => (packet.context as { recovery?: { completed_verification?: unknown[]; source_artifact_id?: string | null; source_artifact_digest?: string | null; source_packet_digest?: string | null } }).recovery).filter(Boolean);
    const completedVerification = lineageRecovery.flatMap((recovery) => recovery?.completed_verification ?? []);
    const originalRecovery = [...lineageRecovery].reverse().find((recovery) => recovery?.source_packet_digest || recovery?.source_artifact_id);
    const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? ORDER BY created_at DESC LIMIT 1")
      .get(runId, failed.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const activeWorktree = this.store.db.prepare("SELECT worktree_id,path,branch FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { worktree_id: string; path: string; branch: string } | undefined;
    const adoption = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.worktree.adopt' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
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
    const packet = validatePacket({
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
    return this.insert(runId, failed.role, packet, replacementFor);
  }

  private plannedOwnershipRecovery(
    runId: string,
    failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string },
  ): string | undefined {
    if (failed.role !== "git-operator") return undefined;
    const run = this.store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.mode !== "planned" || !run.plan_id || !run.revision) return undefined;
    const packet = JSON.parse(failed.packet_json) as DispatchPacket;
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
    const rows = worktreeIds.map((worktreeId) => this.store.db.prepare(`SELECT w.worktree_id,w.run_id,w.branch,w.path,w.base_commit,r.repo_id
      FROM worktrees w JOIN runs r ON r.run_id=w.run_id WHERE w.worktree_id=? AND w.state='active'`).get(worktreeId) as {
        worktree_id: string; run_id: string; branch: string; path: string; base_commit: string; repo_id: string;
      } | undefined);
    if (rows.some((row) => !row || row.repo_id !== run.repo_id)) return undefined;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
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
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, failed.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = this.insert(runId, "git-operator", validatePacket({
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
    this.store.event(runId, "worktree.ownership_reconcile_created", {
      dispatch_id: dispatchId,
      source_dispatch_id: failed.dispatch_id,
      worktree_ids: foreignTasks.map(({ worktree_id }) => worktree_id),
    });
    return dispatchId;
  }

  private plannedMergePartialEffect(
    runId: string,
    dispatch: { dispatch_id: string; role: Role; packet_json: string },
  ): MergeOwnershipPartialEffect | undefined {
    if (dispatch.role !== "git-operator") return undefined;
    let context: Record<string, unknown>;
    try { context = (JSON.parse(dispatch.packet_json) as DispatchPacket).context; }
    catch { return undefined; }
    if (context.phase !== "integrate_implementation" && context.phase !== "reconcile_worktree_ownership") return undefined;
    const bindings = this.mergeWorktreeBindings(runId, dispatch.dispatch_id);
    if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) return undefined;
    return completedMergeOwnershipPartialEffect(
      this.store,
      runId,
      bindings.integration_worktree_id,
      bindings.task_worktree_ids,
    );
  }

  mergeWorktreeBindings(runId: string, dispatchId?: string): MergeWorktreeBindings {
    if (!dispatchId) return { integration_worktree_id: null, task_worktree_ids: [] };
    const rows = this.store.db.prepare(`SELECT binding_kind,worktree_id FROM dispatch_worktree_bindings
      WHERE run_id=? AND dispatch_id=? ORDER BY binding_kind,worktree_id`).all(runId, dispatchId) as Array<{ binding_kind: "integration" | "task"; worktree_id: string }>;
    return {
      integration_worktree_id: rows.find(({ binding_kind }) => binding_kind === "integration")?.worktree_id ?? null,
      task_worktree_ids: rows.filter(({ binding_kind }) => binding_kind === "task").map(({ worktree_id }) => worktree_id),
    };
  }

  private assertStoredMergeWorktreeBindings(runId: string, dispatchId: string, integrationId: string, taskWorktreeIds: string[], exact = false): MergeWorktreeBindings {
    const actual = this.mergeWorktreeBindings(runId, dispatchId);
    const expected = [integrationId, ...taskWorktreeIds];
    const actualIds = [actual.integration_worktree_id, ...actual.task_worktree_ids].filter((id): id is string => Boolean(id));
    const missing = expected.filter((id) => !actualIds.includes(id));
    const unexpected = exact ? actualIds.filter((id) => !expected.includes(id)) : [];
    if (actual.integration_worktree_id !== integrationId || missing.length || unexpected.length) {
      throw new ValidationError(`merge-task dispatch ${dispatchId} has invalid managed worktree bindings: constraint=packet_worktree_binding; expected_worktree_ids=${JSON.stringify(expected)}; actual_bound_ids=${JSON.stringify(actualIds)}; missing_bindings=${JSON.stringify(missing)}; unexpected_bindings=${JSON.stringify(unexpected)}`);
    }
    return actual;
  }

  assertMergeWorktreeBindings(runId: string, dispatchId: string, integrationId: string, taskId: string): MergeWorktreeBindings & { task_id: string; task_worktree_id: string } {
    const actual = this.mergeWorktreeBindings(runId, dispatchId);
    const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as DispatchPacket).context : {};
    const actualTaskId = typeof context.task_id === "string" ? context.task_id : null;
    const resolvedTask = resolveTaskIdentityWorktree(this.store, runId, taskId);
    const expectedTaskWorktreeId = resolvedTask.worktree_id;
    const packetTaskWorktreeId = typeof context.task_worktree_id === "string" ? context.task_worktree_id : null;
    const implementationWorktreeId = typeof context.implementation_worktree_id === "string" ? context.implementation_worktree_id : null;
    const actualTaskWorktreeId = packetTaskWorktreeId ?? implementationWorktreeId
      ?? (actual.task_worktree_ids.length === 1 ? actual.task_worktree_ids[0] : null);
    const packetIntegrationWorktreeId = typeof context.integration_worktree_id === "string" ? context.integration_worktree_id : null;
    const phase = context.phase ?? null;
    const valid = actualTaskId === taskId
      && actual.integration_worktree_id === integrationId
      && packetIntegrationWorktreeId === integrationId
      && actual.task_worktree_ids.includes(expectedTaskWorktreeId)
      && actualTaskWorktreeId === expectedTaskWorktreeId
      && (packetTaskWorktreeId === null || packetTaskWorktreeId === expectedTaskWorktreeId)
      && (implementationWorktreeId === null || implementationWorktreeId === expectedTaskWorktreeId)
      && phase === "integrate_implementation";
    if (!valid) {
      throw new ValidationError(`merge-task dispatch ${dispatchId} has invalid managed worktree bindings: constraint=packet_worktree_binding; expected_task_id=${taskId}; actual_task_id=${String(actualTaskId)}; expected_task_worktree_id=${expectedTaskWorktreeId}; actual_task_worktree_id=${String(actualTaskWorktreeId)}; expected_integration_worktree_id=${integrationId}; actual_integration_worktree_id=${String(actual.integration_worktree_id)}; actual_phase=${String(phase)}`);
    }
    return { ...actual, task_id: taskId, task_worktree_id: expectedTaskWorktreeId };
  }

  private get(runId: string, dispatchId: string, role: Role): any {
    const row = this.store.db.prepare("SELECT * FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role);
    if (!row) throw new ValidationError("dispatch identity does not match run and role");
    const platform = process.env.AI_TEAM_CLIENT_PLATFORM ?? process.env.AI_TEAM_PLATFORM;
    if (platform) {
      const run = this.store.getRun(runId) as { client_platform?: string };
      if (run.client_platform && run.client_platform !== platform) throw new ValidationError("client platform is locked to this run", { expected: run.client_platform, actual: platform });
    }
    return row;
  }

  claim(runId: string, dispatchId: string, role: Role): { reused: boolean; packet: DispatchPacket } {
    const row = this.get(runId, dispatchId, role);
    const run = this.store.getRun(runId) as { state: string };
    if (run.state !== "active") throw new ValidationError(`run must be active before dispatch claim: ${run.state}`);
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be claimed from ${row.state}`);
    const reused = row.state === "claimed";
    if (!reused) this.store.db.prepare("UPDATE dispatches SET state='claimed',claimed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
    return { reused, packet: JSON.parse(row.packet_json) as DispatchPacket };
  }

  claimBundle(runId: string, dispatchId: string, role: Role): DispatchBundle {
    const claimed = this.claim(runId, dispatchId, role);
    const row = this.get(runId, dispatchId, role) as {
      packet_json: string;
      schema_json: string;
      template_json: string;
      packet_digest?: string;
      prompt_digest?: string;
      schema_digest?: string;
      template_digest?: string;
      renderer_version?: string;
    };
    const prompt = this.prompt(runId, dispatchId, role);
    return {
      ...claimed,
      prompt,
      schema: JSON.parse(row.schema_json),
      template: JSON.parse(row.template_json) as ResultEnvelope,
      packet_schema: this.packetSchema(runId, dispatchId, role),
      packet_template: this.packetTemplate(runId, dispatchId, role),
      digests: {
        packet: row.packet_digest ?? sha256(row.packet_json),
        prompt: row.prompt_digest ?? sha256(prompt),
        schema: row.schema_digest ?? sha256(row.schema_json),
        template: row.template_digest ?? sha256(row.template_json),
      },
      renderer_version: row.renderer_version ?? "dispatch-renderer-v2",
      execution_enforcement: executionEnforcement(claimed.packet.execution_contract),
    };
  }

  cancel(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): { action: "canceled"; reused: boolean } {
    this.assertLifecycleActor(runId, actorRole, "dispatch cancel");
    if (!reason.trim()) throw new ValidationError("dispatch cancellation requires a reason");
    const row = this.get(runId, dispatchId, role) as { state: string };
    const prior = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.canceled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (row.state === "failed" && prior) return { action: "canceled", reused: true };
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be canceled from ${row.state}`);
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      this.store.event(runId, "dispatch.canceled", { dispatchId, role, actor_role: actorRole, reason });
    })();
    return { action: "canceled", reused: false };
  }

  reissue(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reissued"> {
    const row = this.get(runId, dispatchId, role) as {
      state: string; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string;
    };
    const run = this.store.getRun(runId) as { state: string };
    if (row.state === "failed" && run.state === "failed") {
      this.assertLifecycleActor(runId, actorRole, "dispatch reissue");
      if (!reason.trim()) throw new ValidationError("dispatch reissue requires a reason");
      let result: { side_effect_state?: string };
      try { result = JSON.parse(row.result_json ?? ""); }
      catch { throw new ValidationError("failed dispatch reissue requires a valid result envelope"); }
      if (result.side_effect_state !== "none") throw new ValidationError("failed dispatch can be revived only when no side effect occurred");
      const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      if (existing) return { action: "reissued", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
      let replacementId = "";
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        replacementId = this.plannedOwnershipRecovery(runId, { dispatch_id: dispatchId, role, ...row })
          ?? this.recoveryReplacement(runId, { dispatch_id: dispatchId, role, ...row });
        this.store.event(runId, "dispatch.reissued", { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason, revived_run: true });
      })();
      return { action: "reissued", dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
    }
    return this.replaceDispatch(runId, dispatchId, role, actorRole, reason, "reissued", JSON.parse(row.packet_json) as DispatchPacket);
  }

  supersede(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, packet: DispatchPacket): ReplacementResult<"superseded"> {
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    return this.replaceDispatch(runId, dispatchId, role, actorRole, reason, "superseded", validatePacket(packet, role));
  }

  recoverClaimedTaskScope(input: {
    runId: string;
    dispatchId: string;
    authorityCommit: string;
    expectedHead: string;
    addedWritePaths: string[];
  }): ReplacementResult<"superseded"> & { role: "git-operator"; claim_command: string; authority_commit: string; allowed_write_paths: string[]; dirty_paths: string[] } {
    const run = this.store.getRun(input.runId) as { profile: string; mode?: string; state: string; repo_id: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") throw new ValidationError("claimed task scope recovery requires an active planned Coding run");
    this.assertCommandAllowed("coding", "dispatch supersede");
    if (!/^[a-f0-9]{40}$/.test(input.authorityCommit) || !/^[a-f0-9]{40}$/.test(input.expectedHead)) throw new ValidationError("scope recovery requires full authority and expected HEAD commit SHAs");
    const row = this.get(input.runId, input.dispatchId, "backend-developer") as { state: string; packet_json: string; result_json?: string };
    const sourcePacket = JSON.parse(row.packet_json) as DispatchPacket;
    const taskId = typeof sourcePacket.context.task_id === "string" ? sourcePacket.context.task_id : undefined;
    const worktreeId = typeof sourcePacket.context.worktree_id === "string" ? sourcePacket.context.worktree_id : undefined;
    const worktreePath = typeof sourcePacket.context.worktree_path === "string" ? sourcePacket.context.worktree_path : undefined;
    if (!taskId || !worktreeId || !worktreePath) throw new ValidationError("claimed developer dispatch lacks frozen task worktree identity");
    const normalizedAddedPaths = assertExplicitTaskWritePaths(input.addedWritePaths, `scope recovery ${taskId}`);
    const existing = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(input.runId, input.dispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      const packet = JSON.parse(existing.packet_json) as DispatchPacket;
      const recovery = packet.context.scope_recovery as { authority_commit?: string; dirty_paths?: string[] } | undefined;
      if (recovery?.authority_commit !== input.authorityCommit || !normalizedAddedPaths.every((path) => packet.allowed_write_paths.includes(path))) {
        throw new ValidationError("claimed developer dispatch already has a different scope recovery replacement");
      }
      return {
        action: "superseded", dispatch_id: existing.dispatch_id, replacement_for: input.dispatchId, reused: true,
        role: "git-operator", claim_command: this.claimCommand(input.runId, existing.dispatch_id),
        authority_commit: input.authorityCommit, allowed_write_paths: packet.allowed_write_paths, dirty_paths: recovery.dirty_paths ?? [],
      };
    }
    const task = this.plannedTaskRows(input.runId).find((candidate) => candidate.task_id === taskId);
    if (!task || task.state === "integrated" || task.developer_dispatch_id && task.developer_dispatch_id !== input.dispatchId) {
      throw new ValidationError("claimed developer dispatch is not the active unintegrated task owner");
    }
    const originalPaths = this.frozenTaskWritePaths(input.runId, taskId);
    const allowedWritePaths = [...new Set([...originalPaths, ...normalizedAddedPaths])].sort();
    if (row.state !== "claimed" || row.result_json) throw new ValidationError("scope recovery requires a claimed developer dispatch with no result");
    const sideEffects = this.store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM artifacts WHERE run_id=? AND dispatch_id=?) AS artifacts,
      (SELECT COUNT(*) FROM staging_entries WHERE run_id=? AND dispatch_id=?) AS staging`).get(input.runId, input.dispatchId, input.runId, input.dispatchId) as { artifacts: number; staging: number };
    if (sideEffects.artifacts || sideEffects.staging) throw new ValidationError("scope recovery requires a developer dispatch with no side effects", sideEffects);
    const worktree = this.store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(input.runId, worktreeId) as { path: string; state: string } | undefined;
    if (!worktree || worktree.state !== "active" || worktree.path !== worktreePath) throw new ValidationError("scope recovery worktree does not match its frozen task identity");
    const head = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== input.expectedHead) throw new ValidationError("scope recovery worktree HEAD does not match --expected-head", { expected: input.expectedHead, actual: head });
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("scope recovery repository is missing");
    const authority = execFileSync("git", ["-C", repository.project_path, "rev-parse", `${input.authorityCommit}^{commit}`], { encoding: "utf8" }).trim();
    if (authority !== input.authorityCommit) throw new ValidationError("scope recovery authority commit does not resolve exactly");
    try { execFileSync("git", ["-C", repository.project_path, "merge-base", "--is-ancestor", authority, "HEAD"], { stdio: "ignore" }); }
    catch { throw new ValidationError("scope recovery authority commit is not reachable from the current main checkout"); }
    const authorityPaths = execFileSync("git", ["-C", repository.project_path, "diff-tree", "--no-commit-id", "--name-only", "-r", authority], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const unsupported = normalizedAddedPaths.filter((path) => !authorityPaths.includes(path));
    if (unsupported.length) throw new ValidationError("scope recovery authority commit does not contain every added write path", { authority_commit: authority, unsupported_paths: unsupported });
    const dirtyPaths = dirtyWorktreePaths(worktree.path);
    const outOfScope = dirtyPaths.filter((path) => !pathMatchesScope(path, allowedWritePaths));
    if (outOfScope.length) throw new ValidationError("scope recovery would not preserve dirty paths within the replacement scope", { dirty_paths: outOfScope });
    const packet = validatePacket({
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
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=? AND state='claimed'").run(new Date().toISOString(), input.dispatchId);
      replacementId = this.insert(input.runId, "git-operator", packet, input.dispatchId);
      const updated = this.store.db.prepare(`UPDATE run_tasks SET write_paths_json=?,developer_dispatch_id=?,updated_at=?
        WHERE run_id=? AND task_id=? AND (developer_dispatch_id=? OR developer_dispatch_id IS NULL) AND state!='integrated'`).run(stableJson(allowedWritePaths), null, new Date().toISOString(), input.runId, taskId, input.dispatchId);
      if (updated.changes !== 1) throw new ValidationError("task ownership changed during claimed scope recovery");
      this.store.event(input.runId, "dispatch.superseded", { dispatchId: input.dispatchId, replacement_dispatch_id: replacementId, role: "backend-developer", actor_role: "coding", reason: "frozen task scope expanded by explicit authority commit" });
      this.store.event(input.runId, "task.scope_recovered", { task_id: taskId, worktree_id: worktreeId, authority_commit: authority, expected_head: input.expectedHead, original_allowed_write_paths: originalPaths, allowed_write_paths: allowedWritePaths, dirty_paths: dirtyPaths, superseded_dispatch_id: input.dispatchId, replacement_dispatch_id: replacementId });
    })();
    return {
      action: "superseded", dispatch_id: replacementId, replacement_for: input.dispatchId, reused: false,
      role: "git-operator", claim_command: this.claimCommand(input.runId, replacementId),
      authority_commit: authority, allowed_write_paths: allowedWritePaths, dirty_paths: dirtyPaths,
    };
  }

  repairClaimedTaskScopeReplacement(input: { runId: string; dispatchId: string }): {
    action: "repaired";
    dispatch_id: string;
    role: "git-operator";
    claim_command: string;
    reused: boolean;
  } {
    const run = this.store.getRun(input.runId) as { profile: string; mode?: string; state: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") {
      throw new ValidationError("claimed task scope replacement repair requires an active planned Coding run");
    }
    const row = this.store.db.prepare(`SELECT role,state,packet_json,result_json,replacement_for FROM dispatches
      WHERE run_id=? AND dispatch_id=?`).get(input.runId, input.dispatchId) as {
      role: Role; state: string; packet_json: string; result_json?: string; replacement_for?: string;
    } | undefined;
    if (!row) throw new ValidationError("dispatch identity does not match run");
    const packet = JSON.parse(row.packet_json) as DispatchPacket;
    const context = packet.context as Record<string, unknown>;
    const claimCommand = this.claimCommand(input.runId, input.dispatchId);
    if (row.role === "git-operator" && context.operation === "apply-task-authority") {
      if (row.state !== "pending" || context.phase !== "apply_task_authority" || context.operation !== "apply-task-authority") {
        throw new ValidationError("dispatch is not a repaired task authority replacement");
      }
      return { action: "repaired", dispatch_id: input.dispatchId, role: "git-operator", claim_command: claimCommand, reused: true };
    }
    if ((row.role !== "backend-developer" && row.role !== "git-operator") || row.state !== "pending" || row.result_json || !row.replacement_for) {
      throw new ValidationError("dispatch is not an unclaimed legacy task authority replacement");
    }
    const source = this.store.db.prepare(`SELECT role,state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?`)
      .get(input.runId, row.replacement_for) as { role: Role; state: string; packet_json: string } | undefined;
    if (!source || source.role !== "backend-developer" || source.state !== "failed") {
      throw new ValidationError("legacy task authority replacement has invalid superseded developer lineage");
    }
    const sourceContext = (JSON.parse(source.packet_json) as DispatchPacket).context as Record<string, unknown>;
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
    const sideEffects = this.store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM artifacts WHERE run_id=? AND dispatch_id=?) AS artifacts,
      (SELECT COUNT(*) FROM staging_entries WHERE run_id=? AND dispatch_id=?) AS staging`).get(input.runId, input.dispatchId, input.runId, input.dispatchId) as { artifacts: number; staging: number };
    if (sideEffects.artifacts || sideEffects.staging) throw new ValidationError("legacy task authority replacement already has side effects");
    const unfrozen = { ...packet };
    delete unfrozen.execution_contract;
    delete unfrozen.execution_request;
    const lineageContext = { ...context };
    delete lineageContext.context_owner;
    delete lineageContext.context_maintenance;
    const corrected = freezeExecutionContract("git-operator", this.freezeVerificationContext(input.runId, "git-operator", validatePacket({
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
    }, "git-operator")));
    const packetJson = redact(stableJson(corrected));
    const prompt = redact(promptFor(input.runId, input.dispatchId, "git-operator", corrected));
    const schemaJson = stableJson(resultSchemaForRole("git-operator"));
    const templateJson = stableJson(createResultTemplate(input.runId, input.dispatchId, "git-operator"));
    this.store.db.transaction(() => {
      this.store.db.prepare(`UPDATE dispatches SET role='git-operator',packet_json=?,prompt='',schema_json=?,template_json=?,
        packet_digest=?,prompt_digest=?,schema_digest=?,template_digest=?,renderer_version=? WHERE run_id=? AND dispatch_id=? AND role IN ('backend-developer','git-operator') AND state='pending'`)
      .run(packetJson, schemaJson, templateJson, sha256(packetJson), sha256(prompt), sha256(schemaJson), sha256(templateJson), RENDERER_VERSION, input.runId, input.dispatchId);
      this.store.event(input.runId, "dispatch.claimed_task_scope_replacement_repaired", {
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

  reconcile(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } {
    const commandId = this.store.startCommand(runId, "dispatch reconcile", { dispatchId, correlationId: dispatchId });
    try {
      const result = this.reconcileWithCommand(runId, dispatchId, role, actorRole, reason, commandId);
      const terminal = this.store.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(commandId);
      return terminal ? result : this.store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", retry_safe: true }, () => result);
    } catch (error) {
      this.store.terminalCommand(commandId, "failed", { command: "dispatch reconcile", cause: error instanceof Error ? error.message : String(error), retry_safe: true }, () => {});
      throw error;
    }
  }

  private reconcileWithCommand(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, commandId: string): ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } {
    this.assertLifecycleActor(runId, actorRole, "dispatch reconcile");
    if (!reason.trim()) throw new ValidationError("dispatch reconciliation requires a reason");
    const row = this.get(runId, dispatchId, role) as {
      state: string;
      role: Role;
      packet_json: string;
      packet_digest?: string;
      result_json?: string;
      replacement_for?: string;
    };
    const prior = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (prior) {
      const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      const resumed = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=? AND json_extract(payload_json,'$.resumed_finalization')=1")
        .get(runId, dispatchId);
      if (!existing && resumed) return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: true, resumed_finalization: true };
      if (!existing) throw new ValidationError("reconciled dispatch is missing its replacement");
      return { action: "reconciled", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    const run = this.store.getRun(runId) as { state: string };
    if (row.state === "claimed" && run.state === "completed") {
      this.verifyFinalization(runId, dispatchId, true);
      this.store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", resumed_finalization: true, retry_safe: true }, () => {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "dispatch.reconciled", { dispatchId, role, actor_role: actorRole, reason, verified_side_effects: true, resumed_finalization: true });
      });
      return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: false, resumed_finalization: true };
    }
    if (row.state !== "retryable_failure") throw new ValidationError(`dispatch cannot be reconciled from ${row.state}`);
    let result: { status?: string; side_effect_state?: string };
    try { result = JSON.parse(row.result_json ?? ""); }
    catch { throw new ValidationError("dispatch reconciliation requires a valid retryable result envelope"); }
    const partialEffect = this.plannedMergePartialEffect(runId, { dispatch_id: dispatchId, ...row });
    if (result.status !== "retryable_failure" || (result.side_effect_state !== "completed" && !partialEffect)) {
      throw new ValidationError("dispatch reconciliation requires confirmed completed side effects", [
        { path: "/side_effect_state", pointer: "/side_effect_state", field: "side_effect_state", constraint: "const", message: "must equal completed" },
      ]);
    }
    let replacementId = "";
    this.store.terminalCommand(commandId, "completed", { command: "dispatch reconcile", retry_safe: true }, () => {
      this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
        .run(new Date().toISOString(), dispatchId);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      replacementId = this.recoveryReplacement(runId, { dispatch_id: dispatchId, ...row });
      this.store.event(runId, "dispatch.reconciled", {
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

  finalizationContext(runId: string, dispatchId: string, requiredState: "claimed" | "completed" = "claimed"): {
    barrier_id: string;
    revision_sha: string;
    integration_worktree_id: string;
  } {
    const row = this.store.db.prepare("SELECT role,state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?")
      .get(runId, dispatchId) as { role: string; state: string; packet_json: string } | undefined;
    if (!row || row.role !== "git-operator" || row.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = (JSON.parse(row.packet_json) as DispatchPacket).context as Record<string, unknown>;
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

  assertFinalizingCleanup(runId: string, dispatchId: string): void {
    const context = this.finalizationContext(runId, dispatchId);
    const barrier = this.store.db.prepare("SELECT state,revision_sha,repair_commit FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string; repair_commit?: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || (barrier.repair_commit ?? barrier.revision_sha) !== context.revision_sha) {
      throw new ValidationError("finalization review barrier is not passed for the requested revision");
    }
    const operation = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { evidence_json?: string } | undefined;
    const evidence = JSON.parse(operation?.evidence_json ?? "{}") as Record<string, unknown>;
    if (!operation || !/^[a-f0-9]{40}$/.test(String(evidence.commit ?? "")) || evidence.integration_head && evidence.integration_head !== context.revision_sha) {
      throw new ValidationError("finalization cleanup requires a completed integration side effect for the reviewed revision");
    }
  }

  verifyFinalization(runId: string, dispatchId: string, allowClaimed = false): Record<string, unknown> {
    const dispatch = this.store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { state: string } | undefined;
    const requiredState = allowClaimed ? "claimed" : "completed";
    if (!dispatch || dispatch.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = this.finalizationContext(runId, dispatchId, requiredState);
    const run = this.store.getRun(runId) as { repo_id: string; target_branch: string };
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    const barrier = this.store.db.prepare("SELECT state,revision_sha,repair_commit FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string; repair_commit?: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || (barrier.repair_commit ?? barrier.revision_sha) !== context.revision_sha) {
      throw new ValidationError("finalization barrier and revision binding could not be verified");
    }
    const operation = this.store.db.prepare("SELECT operation_id,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
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
    const worktrees = this.store.db.prepare("SELECT worktree_id,path,branch,state FROM worktrees WHERE run_id=?").all(runId) as Array<{ worktree_id: string; path: string; branch: string; state: string }>;
    const listed = execFileSync("git", ["-C", repository.project_path, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const worktree of worktrees) {
      const cleanup = this.store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
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

  private assertLifecycleActor(runId: string, actorRole: Role, command: string): void {
    const run = this.store.getRun(runId) as { profile: Role };
    if (run.profile !== actorRole) throw new ValidationError(`${actorRole} cannot manage a ${run.profile} run dispatch`);
    this.assertCommandAllowed(actorRole, command);
  }

  private replaceDispatch<Action extends "reissued" | "superseded">(
    runId: string,
    dispatchId: string,
    role: Role,
    actorRole: Role,
    reason: string,
    action: Action,
    packet: DispatchPacket,
  ): ReplacementResult<Action> {
    this.assertLifecycleActor(runId, actorRole, `dispatch ${action === "reissued" ? "reissue" : "supersede"}`);
    const run = this.store.getRun(runId) as { state: string };
    if (!reason.trim()) throw new ValidationError(`dispatch ${action} requires a reason`);
    const row = this.get(runId, dispatchId, role) as { state: string; packet_json: string };
    if (run.state !== "active" && !(run.state === "retryable_failure" && row.state === "retryable_failure")) {
      throw new ValidationError(`run must be active before dispatch ${action}: ${run.state}`);
    }
    if (!["pending", "claimed", "failed", "retryable_failure"].includes(row.state)) throw new ValidationError(`dispatch cannot be ${action} from ${row.state}`);
    assertExplorerAuthorization(this.store, runId, role, packet);
    const sourceBindings = this.mergeWorktreeBindings(runId, dispatchId);
    const replacementBindings = mergeBindingsFromPacket(role, packet);
    const sourcePacket = JSON.parse(row.packet_json) as DispatchPacket;
    const sourceTaskId = typeof sourcePacket.context.task_id === "string" ? sourcePacket.context.task_id : null;
    const replacementTaskId = typeof packet.context.task_id === "string" ? packet.context.task_id : null;
    if (sourceTaskId !== replacementTaskId) {
      throw new ValidationError(`replacement dispatch must preserve task identity: expected_task_id=${String(sourceTaskId)}; actual_task_id=${String(replacementTaskId)}`);
    }
    if ((role === "frontend-developer" || role === "backend-developer")
      && stableJson(sourcePacket.context.predecessor_repair) !== stableJson(packet.context.predecessor_repair)) {
      throw new ValidationError("replacement developer dispatch must preserve predecessor repair evidence");
    }
    for (const key of ["task_worktree_id", "implementation_worktree_id"] as const) {
      const expected = typeof sourcePacket.context[key] === "string" ? sourcePacket.context[key] : null;
      const actual = typeof packet.context[key] === "string" ? packet.context[key] : null;
      if (expected !== actual) {
        throw new ValidationError(`replacement dispatch must preserve task worktree mapping: field=${key}; expected_task_worktree_id=${String(expected)}; actual_task_worktree_id=${String(actual)}`);
      }
    }
    if (sourceBindings.integration_worktree_id) {
      const sourceIds = [sourceBindings.integration_worktree_id, ...sourceBindings.task_worktree_ids].sort();
      const replacementIds = replacementBindings
        ? [replacementBindings.integration_worktree_id, ...replacementBindings.task_worktree_ids].filter((id): id is string => Boolean(id)).sort()
        : [];
      if (stableJson(sourceIds) !== stableJson(replacementIds)) {
        throw new ValidationError(`replacement dispatch must preserve managed worktree bindings: expected_worktree_ids=${JSON.stringify(sourceIds)}; actual_bound_ids=${JSON.stringify(replacementIds)}`);
      }
    }
    const sourceContract = sourcePacket.execution_contract;
    if (!sourceContract) {
      const frozen = this.store.getRun(runId) as { role_manifest_digest?: string };
      if (frozen.role_manifest_digest !== ROLE_MANIFEST_DIGEST) throw new IncompatibleError("legacy dispatch role manifest does not match the current role manifest", {
        reason_code: "role_manifest_mismatch",
        next_action: "start_new_run",
      });
    }
    const requestedPacket = { ...packet };
    delete requestedPacket.execution_contract;
    packet = freezeExecutionContract(role, requestedPacket, sourceContract);
    const packetJson = redact(stableJson(packet));
    const existing = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, dispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      if (existing.packet_json !== packetJson) throw new ValidationError("dispatch already has a different replacement");
      return { action, dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    let replacementId = "";
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      if (row.state === "retryable_failure") {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      replacementId = this.insert(runId, role, packet, dispatchId);
      this.store.event(runId, `dispatch.${action}`, { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason });
    })();
    return { action, dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
  }

  prompt(runId: string, dispatchId: string, role: Role): string {
    const row = this.get(runId, dispatchId, role);
    const renderer = row.renderer_version === RENDERER_VERSION ? promptFor : row.renderer_version === "dispatch-renderer-v3" ? promptForV3 : promptForV2;
    const rendered = renderer(runId, dispatchId, role, JSON.parse(row.packet_json) as DispatchPacket);
    if (row.prompt_digest && row.prompt_digest !== sha256(rendered)) throw new ValidationError("dispatch prompt digest mismatch; frozen asset is corrupted");
    return rendered;
  }
  private claimCommand(runId: string, dispatchId: string): string {
    return `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatchId} --role git-operator --bundle`;
  }

  createAuthorityConflictContinuation(input: {
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
    const source = this.store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(input.runId, input.authorityDispatchId) as { state: string; packet_json: string } | undefined;
    const sourcePacket = source ? JSON.parse(source.packet_json) as DispatchPacket : undefined;
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
    const packet = freezeAuthorityConflictContinuationExecutionContract(validatePacket({
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
    const existing = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(input.runId, input.authorityDispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      if (existing.packet_json !== packetJson) throw new ValidationError("authority conflict already has a different continuation");
      return { dispatch_id: existing.dispatch_id, reused: true };
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE run_id=? AND dispatch_id=? AND state='claimed'")
        .run(new Date().toISOString(), input.runId, input.authorityDispatchId);
      dispatchId = this.insert(input.runId, "git-operator", packet, input.authorityDispatchId);
      this.store.event(input.runId, "worktree.task_authority_conflict_continuation_created", {
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
  schema(runId: string, dispatchId: string, role: Role): unknown { return JSON.parse(this.get(runId, dispatchId, role).schema_json); }
  template(runId: string, dispatchId: string, role: Role): ResultEnvelope { return JSON.parse(this.get(runId, dispatchId, role).template_json) as ResultEnvelope; }
  packetSchema(runId: string, dispatchId: string, role: Role): unknown {
    const packet = JSON.parse(this.get(runId, dispatchId, role).packet_json) as DispatchPacket;
    return dispatchPacketSchema(role, packet.context.phase, packet.context.task_id);
  }
  packetTemplate(runId: string, dispatchId: string, role: Role): DispatchPacket {
    const packet = JSON.parse(this.get(runId, dispatchId, role).packet_json) as DispatchPacket;
    return dispatchPacketTemplate(role, packet);
  }

  assertClaimed(runId: string, dispatchId: string, role: Role): void {
    const row = this.get(runId, dispatchId, role);
    if (row.state !== "claimed") throw new ValidationError(`${role} dispatch must be claimed before this operation`);
  }

  assertPlanningCommitClaimed(runId: string, dispatchId: string, planId: string, revision: string): void {
    this.assertClaimed(runId, dispatchId, "git-operator");
    const run = this.store.getRun(runId) as { profile: string; plan_id?: string; revision?: string };
    let packet: DispatchPacket;
    try {
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
        .get(runId, dispatchId) as { packet_json: string };
      packet = JSON.parse(row.packet_json) as DispatchPacket;
    } catch {
      throw new ValidationError("planning commit dispatch does not match the requested revision");
    }
    const context = packet.context as unknown;
    const contextMatches = Boolean(context && typeof context === "object" && !Array.isArray(context)
      && (context as { plan_id?: string }).plan_id === planId
      && (context as { revision?: string }).revision === revision);
    if (run.profile !== "planning" || run.plan_id !== planId || run.revision !== revision || !contextMatches) {
      throw new ValidationError("planning commit dispatch does not match the requested revision");
    }
  }

  async validateFile(runId: string, dispatchId: string, role: Role, path: string): Promise<ResultEnvelope> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    return this.validateValue(runId, dispatchId, role, await readJson(path));
  }

  validateValue(runId: string, dispatchId: string, role: Role, value: unknown): ResultEnvelope {
    const dispatch = this.get(runId, dispatchId, role) as { state: string; packet_json: string };
    if (!["claimed", "completed", "needs_decision"].includes(dispatch.state)) {
      throw new ValidationError("dispatch must be claimed before validate");
    }
    const run = this.store.getRun(runId) as { state: string; stage: string };
    const validRunState = dispatch.state === "needs_decision"
      ? run.state === "needs_decision"
      : dispatch.state === "completed" ? run.state === "active" || run.state === "completed" || role === "planning" && run.state === "needs_decision" : run.state === "active";
    if (!validRunState && !this.claimedRecoveryMayFinish(runId, dispatchId, role, dispatch, run.state)) {
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
      const packet = JSON.parse(dispatch.packet_json) as DispatchPacket;
      assertPlanningSubmissionTransition(run.stage, payload.stage, packet.context, payload.decision, payload.pending_questions);
    }
    this.assertVerificationEvidence(role, JSON.parse(dispatch.packet_json) as DispatchPacket, result.value);
    return result.value;
  }

  private claimedRecoveryMayFinish(
    runId: string,
    dispatchId: string,
    role: Role,
    dispatch: { state: string; packet_json: string },
    runState: string,
  ): boolean {
    if (role !== "git-operator" || dispatch.state !== "claimed" || runState !== "retryable_failure") return false;
    const packet = JSON.parse(dispatch.packet_json) as DispatchPacket;
    const batchId = packet.context.recovery_batch_id;
    if (packet.context.phase !== "recover_task_worktree" || typeof batchId !== "string" || !batchId) return false;
    const current = this.store.db.prepare("SELECT claimed_at FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId) as { claimed_at?: string } | undefined;
    if (!current?.claimed_at) return false;
    return Boolean(this.store.db.prepare(`SELECT 1 FROM dispatches
      WHERE run_id=? AND dispatch_id!=? AND state='retryable_failure' AND completed_at>=?
      AND json_extract(packet_json,'$.context.phase')='recover_task_worktree'
      AND json_extract(packet_json,'$.context.recovery_batch_id')=? LIMIT 1`)
      .get(runId, dispatchId, current.claimed_at, batchId));
  }

  private assertPlannedTaskTestScope(runId: string, dispatchId: string, packet: DispatchPacket): void {
    const run = this.store.getRun(runId) as { mode?: string };
    if (run.mode !== "planned" || packet.context.phase !== "task_test") return;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : "";
    const worktreeId = typeof packet.context.worktree_id === "string" ? packet.context.worktree_id : "";
    const task = this.store.db.prepare("SELECT task_id,worktree_id,developer_dispatch_id,write_paths_json FROM run_tasks WHERE run_id=? AND task_id=?")
      .get(runId, taskId) as { task_id: string; worktree_id?: string; developer_dispatch_id?: string; write_paths_json?: string } | undefined;
    if (!task || !task.developer_dispatch_id || task.worktree_id !== worktreeId) {
      throw new ValidationError("planned Test task/worktree/developer binding does not match frozen run task", {
        offending_task_id: taskId, offending_test_dispatch_id: dispatchId, offending_worktree_id: worktreeId,
        frozen_worktree_id: task?.worktree_id ?? null, frozen_developer_dispatch_id: task?.developer_dispatch_id ?? null,
      });
    }
    const developer = this.store.db.prepare("SELECT packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'")
      .get(runId, task.developer_dispatch_id) as { packet_json: string; result_json?: string } | undefined;
    if (!developer?.result_json) throw new ValidationError("planned Test requires its completed frozen developer result");
    const developerPacket = JSON.parse(developer.packet_json) as DispatchPacket;
    if (developerPacket.context.task_id !== taskId || developerPacket.context.worktree_id !== worktreeId) {
      throw new ValidationError("planned developer packet does not match frozen run task identity", {
        offending_task_id: taskId, offending_dispatch_id: task.developer_dispatch_id, offending_worktree_id: worktreeId,
      });
    }
    if (!task.write_paths_json) throw new ValidationError(`legacy frozen Task paths require managed scope recovery: ${taskId}`);
    const actual = [...new Set((((JSON.parse(developer.result_json) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []))].sort();
    if (!actual.length) throw new ValidationError("planned Test requires non-empty developer modified_paths");
    const frozenPaths = JSON.parse(task.write_paths_json) as string[];
    const scopeRow = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
      .get(runId, worktreeId) as { payload_json: string } | undefined;
    if (!scopeRow) throw new ValidationError("planned Test requires an existing immutable pre_commit scope for its worktree", {
      offending_task_id: taskId, offending_dispatch_id: task.developer_dispatch_id, offending_test_dispatch_id: dispatchId, offending_worktree_id: worktreeId,
      actual_modified_paths: actual, frozen_task_paths: frozenPaths, developer_allowed_write_paths: developerPacket.allowed_write_paths,
      pre_commit_paths: [], pre_commit_digest: null, unauthorized_paths: actual,
    });
    const scope = JSON.parse(scopeRow.payload_json) as { paths?: string[]; digest?: string; snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null };
    const preCommitPaths = [...new Set(scope.paths ?? [])].sort();
    const recoveredSnapshotRow = !scope.snapshot ? this.store.db.prepare(`SELECT payload_json FROM run_events
      WHERE run_id=? AND type='scope.pre_commit_snapshot_recovered'
      AND json_extract(payload_json,'$.worktree_id')=? AND json_extract(payload_json,'$.original_scope_digest')=?
      AND json_extract(payload_json,'$.task_id')=? AND json_extract(payload_json,'$.developer_dispatch_id')=?
      ORDER BY event_id DESC LIMIT 1`).get(runId, worktreeId, scope.digest, taskId, task.developer_dispatch_id) as { payload_json: string } | undefined : undefined;
    const recoveredSnapshot = recoveredSnapshotRow
      ? (JSON.parse(recoveredSnapshotRow.payload_json) as { snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } }).snapshot
      : undefined;
    const expectedSnapshot = scope.snapshot ?? recoveredSnapshot ?? null;
    const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
    const snapshot = worktree ? plannedWorktreeSnapshot(worktree.path) : null;
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
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "scope.pre_commit_drift", details);
      })();
      throw new ValidationError("planned developer paths are not authorized by the frozen Task and immutable pre_commit scope; run frozen", details);
    }
  }

  async submit(runId: string, dispatchId: string, role: Role, path: string): Promise<DispatchSubmission> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    const source = await readFile(path, "utf8");
    return this.submitValue(runId, dispatchId, role, JSON.parse(source), source);
  }

  async submitStaging(runId: string, dispatchId: string, role: Role, stagingId: string): Promise<DispatchSubmission & {
    staging: { staging_id: string; state: string; content_digest: string | null };
  }> {
    const binding = { runId, dispatchId, role, kind: "dispatch-result" as const };
    try {
      const input = await this.store.readStagingEntry(stagingId, binding);
      const digest = (this.store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(stagingId) as { content_sha256?: string }).content_sha256 ?? null;
      const submission = await this.submitValue(runId, dispatchId, role, input.value);
      const consumed = await this.store.consumeStagingEntry(stagingId, binding);
      return {
        ...submission,
        staging: { staging_id: consumed.stagingId, state: consumed.state, content_digest: digest },
      };
    } catch (error) {
      try { this.store.recordStagingValidationFailure(stagingId, binding, error); } catch { /* preserve the original staging failure */ }
      const entry = this.store.getStagingEntry(stagingId);
      throw new ValidationError(error instanceof Error ? error.message : String(error), {
        staging_id: stagingId,
        state: entry.state,
        cause: validationCause(error),
      });
    }
  }

  async submitValue(runId: string, dispatchId: string, role: Role, value: unknown, source?: string): Promise<DispatchSubmission> {
    const commandId = this.store.startCommand(runId, "dispatch submit", { dispatchId, correlationId: dispatchId });
    try {
      return await this.submitValueWithCommand(runId, dispatchId, role, value, commandId, source);
    } catch (error) {
      const terminal = this.store.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(commandId);
      if (!terminal) this.store.terminalCommand(commandId, "failed", { command: "dispatch submit", cause: error instanceof Error ? error.message : String(error), retry_safe: false }, () => {});
      throw error;
    }
  }

  private async submitValueWithCommand(runId: string, dispatchId: string, role: Role, value: unknown, commandId: string, source?: string): Promise<DispatchSubmission> {
    const row = this.get(runId, dispatchId, role);
    const bindReviewBarrier = (result: ResultEnvelope): void => {
      if ((role !== "review-spec" && role !== "review-standards") || result.status !== "completed") return;
      const packet = JSON.parse(row.packet_json) as DispatchPacket;
      const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
      result.payload = { ...result.payload, barrier_id: barrierId };
    };
    if (["completed", "needs_decision"].includes(row.state) && row.result_json) {
      const result = JSON.parse(row.result_json) as ResultEnvelope;
      const incoming = this.validateValue(runId, dispatchId, role, value);
      bindReviewBarrier(incoming);
      if (stableJson(result) !== stableJson(incoming)) throw new ValidationError("dispatch was already submitted with a different result");
      const artifact = this.store.db.prepare("SELECT artifact_id,path,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, dispatchId) as { artifact_id: string; path: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("submitted dispatch result artifact is missing");
      return this.store.terminalCommand(commandId, "completed", { command: "dispatch submit", reused: true, retry_safe: true }, () => ({
        reused: true,
        artifact: artifact.path,
        submission: { state: "submitted", dispatch_state: row.state, artifact_id: artifact.artifact_id, artifact: artifact.path, digest: artifact.sha256 },
        continuation: this.continuation(runId),
      }));
    }
    if (row.state !== "claimed") throw new ValidationError("dispatch must be claimed before submit");
    const result = this.validateValue(runId, dispatchId, role, value);
    if (role === "git-operator" && result.status === "failed" && result.side_effect_state === "none") {
      const phase = ((JSON.parse(row.packet_json) as DispatchPacket).context as { phase?: unknown }).phase;
      if (phase === "integrate_implementation" || phase === "reconcile_worktree_ownership" || phase === "recover_task_worktree" || phase === "finalize_integration") {
        result.status = "retryable_failure";
      }
    }
    if (role === "git-operator" && result.status === "completed") {
      this.assertGitPrepareResult(runId, JSON.parse(row.packet_json) as DispatchPacket);
      const context = (JSON.parse(row.packet_json) as DispatchPacket).context;
      if (context.phase === "finalize_integration") this.verifyFinalization(runId, dispatchId, true);
    }
    let resolvedPredecessorRepair: { handled_test_dispatch_ids: string[]; required_commands: string[] } | undefined;
    if ((role === "frontend-developer" || role === "backend-developer") && result.status === "completed") {
      const packet = JSON.parse(row.packet_json) as DispatchPacket;
      const predecessor = packet.context.predecessor_repair as { required_commands?: unknown; handled_tests?: unknown } | undefined;
      const requiredCommands = Array.isArray(predecessor?.required_commands)
        ? predecessor.required_commands.filter((command): command is string => typeof command === "string")
        : [];
      if (requiredCommands.length) {
        const selfTests = Array.isArray((result.payload as { self_tests?: unknown }).self_tests)
          ? (result.payload as { self_tests: Array<{ command?: unknown; outcome?: unknown }> }).self_tests
          : [];
        const byCommand = new Map(selfTests.flatMap(({ command, outcome }) => typeof command === "string" ? [[command, outcome] as const] : []));
        const failed = requiredCommands.filter((command) => !successfulOutcome(byCommand.get(command)));
        if (failed.length) throw new ValidationError("developer predecessor repair is missing successful frozen checks", failed);
        const handledTestDispatchIds = Array.isArray(predecessor?.handled_tests)
          ? predecessor.handled_tests.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as { dispatch_id?: unknown }).dispatch_id === "string"
            ? [(entry as { dispatch_id: string }).dispatch_id]
            : [])
          : [];
        resolvedPredecessorRepair = { handled_test_dispatch_ids: handledTestDispatchIds, required_commands: requiredCommands };
      }
    }
    if (role === "test" && result.status === "completed") {
      const packet = JSON.parse(row.packet_json) as DispatchPacket;
      const expectedCommands = Array.isArray(packet.context.test_commands)
        ? packet.context.test_commands.filter((command): command is string => typeof command === "string")
        : [];
      const checks = Array.isArray((result.payload as { checks?: unknown }).checks)
        ? (result.payload as { checks: Array<{ command?: unknown; outcome?: unknown }> }).checks
        : [];
      const checkedCommands = new Map(checks.flatMap(({ command, outcome }) => typeof command === "string" ? [[command, outcome] as const] : []));
      const failedCommands = expectedCommands.filter((command) => !successfulOutcome(checkedCommands.get(command)));
      if (failedCommands.length) throw new ValidationError("completed Test result is missing successful frozen test commands", failedCommands);
      const testedCommit = (packet.context as { implementation_commit?: unknown }).implementation_commit;
      if (typeof testedCommit === "string" && /^[a-f0-9]{40}$/.test(testedCommit)) {
        result.payload = { ...result.payload, testedCommit };
      }
      this.assertPlannedTaskTestScope(runId, dispatchId, packet);
    }
    bindReviewBarrier(result);
    const artifactDirectory = join(this.store.paths.artifacts, runId, dispatchId);
    await mkdir(artifactDirectory, { recursive: true });
    const artifact = this.artifactPath(runId, dispatchId);
    const redacted = redact(role === "test" || role === "review-spec" || role === "review-standards" ? `${JSON.stringify(result, null, 2)}\n` : source ?? `${JSON.stringify(value, null, 2)}\n`);
    await writeFile(artifact, redacted, { mode: 0o600 });
    const digest = sha256(redacted);
    const artifactId = `artifact_${digest.slice(0, 24)}`;
    const planningPayload = role === "planning" ? result.payload as { pending_questions?: string[] } : undefined;
    const planningQuestion = role === "planning" && (result.status === "needs_decision" || result.status === "completed" && planningPayload?.pending_questions?.length === 1);
    const dispatchState = planningQuestion ? "needs_decision" : result.status === "completed" ? "completed" : result.status;
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state=?,result_json=?,completed_at=? WHERE dispatch_id=?").run(dispatchState, stableJson(result), new Date().toISOString(), dispatchId);
      this.store.db.prepare("INSERT OR IGNORE INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
        .run(artifactId, runId, dispatchId, artifact, digest, new Date().toISOString());
      this.store.event(runId, "dispatch.completed", { dispatchId, status: result.status, artifactId, digest });
      if (resolvedPredecessorRepair) this.store.event(runId, "test.predecessor_repair_resolved", {
        developer_dispatch_id: dispatchId,
        ...resolvedPredecessorRepair,
      });
      if (result.status === "completed" || planningQuestion) {
        if (role === "planning") this.advancePlanning(runId, result);
        else if (role === "review-spec" || role === "review-standards") {
          const packet = JSON.parse(row.packet_json) as DispatchPacket;
          const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
          if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
          this.reconcileReview(runId, barrierId);
        }
        else this.advanceRun(runId, role, result);
      } else {
        if (result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1) {
          const checked = checkDecisionInput(result.decisions_needed[0]);
          if (!checked.valid) throw new ValidationError("needs_decision result requires one typed decision", checked.errors);
          this.store.createDecision(runId, checked.value.question, checked.value.choices, checked.value.recommendation, checked.value.type ?? "workflow", dispatchId);
        }
        const repairableTest = role === "test" && (result.status === "failed" || result.status === "retryable_failure") && result.decisions_needed.length === 0;
        const repairDispatchId = repairableTest
          ? this.createTestRepair(runId, dispatchId, JSON.parse(row.packet_json) as DispatchPacket, result)
          : undefined;
        const packet = JSON.parse(row.packet_json) as DispatchPacket;
        const blockedTestRepair = (role === "frontend-developer" || role === "backend-developer")
          && packet.context.phase === "test_repair"
          && result.status === "failed"
          && result.failure_class === "allowed_path_blocked"
          && result.side_effect_state === "completed";
        if (blockedTestRepair) {
          const decisionId = this.store.createDecision(
            runId,
            "Frozen Test repair is blocked by a path outside the Developer packet scope.",
            [
              { id: "retry", label: "Retry recovery", impact: "Preserve the frozen scope and retry through the supported recovery path." },
              { id: "abort", label: "Abort run", impact: "Stop this run while preserving its recorded repair evidence." },
            ],
            "retry",
            "active_run_recovery",
            dispatchId,
          );
          this.store.db.prepare("UPDATE runs SET state='needs_decision',stage='coding',updated_at=? WHERE run_id=?")
            .run(new Date().toISOString(), runId);
          this.store.event(runId, "test.repair_scope_blocked", { dispatch_id: dispatchId, decision_id: decisionId, failure_class: result.failure_class });
        } else if (!repairDispatchId) this.store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
          .run(result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1 ? "needs_decision" : result.status === "retryable_failure" ? "retryable_failure" : "failed", new Date().toISOString(), runId);
      }
    });
    this.store.terminalCommand(commandId, "completed", { command: "dispatch submit", dispatch_state: dispatchState, retry_safe: true }, () => transaction());
    return {
      reused: false,
      artifact,
      submission: { state: "submitted", dispatch_state: dispatchState, artifact_id: artifactId, artifact, digest },
      continuation: this.continuation(runId),
    };
  }

  continuation(runId: string): DispatchContinuation {
    const run = this.store.getRun(runId) as { state: string; stage: string };
    const pending = this.store.db.prepare("SELECT dispatch_id,role,state,packet_json,replacement_for FROM dispatches WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at,dispatch_id")
      .all(runId) as Array<{ dispatch_id: string; role: string; state: string; packet_json: string; replacement_for?: string }>;
    return {
      run_state: run.state,
      run_stage: run.stage,
      pending_dispatches: pending.map(({ packet_json, replacement_for, ...dispatch }) => {
        const context = (JSON.parse(packet_json) as DispatchPacket).context;
        const dependencies = Object.entries(context)
          .filter(([key, value]) => key.endsWith("_dispatch_id") && typeof value === "string")
          .map(([, value]) => value as string);
        if (replacement_for) dependencies.push(replacement_for);
        return { ...dispatch, depends_on: [...new Set(dependencies)] };
      }),
      pending_decision: (this.store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending' ORDER BY created_at,decision_id LIMIT 1")
        .get(runId) as Record<string, unknown> | undefined) ?? null,
    };
  }

  runShowProjection(runId: string): {
    continuation: DispatchContinuation;
    planning_clarifications: Array<Record<string, unknown>>;
    pending_dependencies: Array<{ dispatch_id: string; depends_on: string[] }>;
    suggested_commands: string[];
  } {
    const continuation = this.continuation(runId);
    const suggestedCommands = continuation.pending_dispatches.map((dispatch) => dispatch.state === "pending"
      ? `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --bundle`
      : `ai-team staging create --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --kind dispatch-result`);
    const decision = continuation.pending_decision as { decision_id?: unknown } | null;
    if (typeof decision?.decision_id === "string") {
      suggestedCommands.push(`ai-team run decide --run-id ${runId} --decision-id ${decision.decision_id} --choice <choice>`);
    }
    const run = this.store.getRun(runId) as { state: string };
    if (!suggestedCommands.length && run.state === "active") suggestedCommands.push(`ai-team run resume ${runId}`);
    return {
      continuation,
      planning_clarifications: this.store.planningClarifications(runId),
      pending_dependencies: continuation.pending_dispatches.map(({ dispatch_id, depends_on }) => ({ dispatch_id, depends_on })),
      suggested_commands: suggestedCommands,
    };
  }

  private advanceRun(runId: string, role: Role, result: ResultEnvelope): void {
    const run = this.store.getRun(runId) as { profile: string; mode?: string };
    if (role === "coding") {
      const packetRow = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string } | undefined;
      const packet = packetRow ? JSON.parse(packetRow.packet_json) as DispatchPacket : undefined;
      if (packet?.context.phase === "test_repair") {
        this.ensureTestRepairDeveloperDispatch(runId, result.dispatch_id);
        return;
      }
    }
    if (role === "file-explorer") {
      const next = run.profile === "planning" ? "planning" : "coding";
      const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role=? AND state IN ('pending','claimed')").get(runId, next);
      if (existing) return;
      if (next === "coding" && run.mode === "planned") {
        const dispatchId = this.ensureGitPrepareDispatch(runId, "integration", result.dispatch_id);
        this.changeStage(runId, "git-operator", dispatchId);
        return;
      }
      const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, result.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("completed File Explorer result artifact is missing");
      const dispatchId = this.create(runId, next, {
        objective: next === "planning" ? "Produce the complete requirements checklist and identify one highest-priority pending question." : "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles.",
        allowed_read_paths: (result.payload.allowed_read_paths as string[] | undefined) ?? [],
        allowed_write_paths: [],
        acceptance_criteria: ["Return structured evidence", "Request support for unknown paths"],
        context: {
          stage: next,
          explorer_dispatch_id: result.dispatch_id,
          explorer_result: {
            findings: result.findings,
            payload: result.payload,
            artifact_id: artifact.artifact_id,
            digest: artifact.sha256,
            project_context: result.payload.project_context,
          },
        },
      }, run.profile as Role);
      if (next === "coding") this.ensureGitPrepareDispatch(runId, "integration", result.dispatch_id);
      this.changeStage(runId, next, dispatchId);
      return;
    }
    if (role === "git-operator") {
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string } | undefined;
      const context = row ? (JSON.parse(row.packet_json) as DispatchPacket).context as { phase?: unknown; explorer_dispatch_id?: unknown; reconciliation?: unknown; source_dispatch_id?: unknown } : {};
      if (run.mode === "planned" && context.phase === "prepare_worktrees") {
        if (typeof context.explorer_dispatch_id === "string") this.createPlannedCodingDispatch(runId, context.explorer_dispatch_id, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && (context.phase === "prepare_implementation_worktree" || context.phase === "recover_task_worktree")) {
        const taskId = typeof (context as { task_id?: unknown }).task_id === "string" ? (context as { task_id: string }).task_id : undefined;
        if (taskId && this.plannedTaskRows(runId).some((task) => task.task_id === taskId)) {
          const recoveryWorktreeId = context.phase === "recover_task_worktree" && typeof (context as { worktree_id?: unknown }).worktree_id === "string"
            ? (context as { worktree_id: string }).worktree_id
            : undefined;
          const taskKey = taskId.toLowerCase();
          const worktree = recoveryWorktreeId
            ? this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, recoveryWorktreeId) as { worktree_id: string } | undefined
            : this.store.db.prepare(`SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)
              ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string } | undefined;
          if (!worktree) throw new ValidationError("completed planned task prepare is missing its registered worktree");
          this.store.advanceRunTask(runId, taskId, "prepared", { worktree_id: worktree.worktree_id });
        }
        this.ensurePlannedTaskContinuation(runId, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && context.phase === "apply_task_authority") {
        this.ensureRecoveredTaskDeveloperDispatch(runId, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && context.phase === "continue_task_authority_conflict") {
        const authorityDispatchId = typeof (context as { authority_apply_dispatch_id?: unknown }).authority_apply_dispatch_id === "string"
          ? (context as { authority_apply_dispatch_id: string }).authority_apply_dispatch_id
          : undefined;
        if (!authorityDispatchId) throw new ValidationError("authority conflict continuation is missing its authority dispatch");
        this.ensureRecoveredTaskDeveloperDispatch(runId, authorityDispatchId, true);
        return;
      }
      if (run.mode === "planned" && context.phase === "reconcile_worktree_ownership") {
        if (typeof context.source_dispatch_id !== "string") throw new ValidationError("ownership reconciliation is missing its source merge dispatch");
        const failed = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
          .get(runId, context.source_dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined;
        if (!failed) throw new ValidationError("ownership reconciliation source merge dispatch was not found");
        this.recoveryReplacement(runId, failed, undefined, result.dispatch_id, result.verification);
        return;
      }
      if (context.phase === "review_repair_commit") {
        const worktreeId = (context as { worktree_id?: unknown }).worktree_id;
        const barrierId = (context as { barrier_id?: unknown }).barrier_id;
        if (typeof worktreeId !== "string" || typeof barrierId !== "string") throw new ValidationError("review repair commit is missing its barrier or worktree identity");
        const operation = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
          .get(runId, worktreeId) as { evidence_json?: string } | undefined;
        const evidence = JSON.parse(operation?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (!evidence.commit) throw new ValidationError("completed review repair Git Operator result has no bound commit operation");
        const developerId = (context as { developer_dispatch_id?: unknown }).developer_dispatch_id;
        const developer = typeof developerId === "string" ? this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, developerId) as { packet_json: string } | undefined : undefined;
        const developerPacket = developer ? JSON.parse(developer.packet_json) as DispatchPacket : undefined;
        const explorer = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
        if (!developerPacket || !explorer || !worktree) throw new ValidationError("review repair Test evidence could not be frozen");
        const frozen = this.testCommandSnapshot(runId, worktree.path, explorer.dispatch_id);
        const testId = this.insert(runId, "test", validatePacket({
          objective: `Independently verify review repair commit ${evidence.commit}.`,
          allowed_read_paths: developerPacket.allowed_read_paths,
          allowed_write_paths: [],
          acceptance_criteria: ["Run every frozen test command", "Bind the Test artifact to the repair commit"],
          context: {
            stage: "test", phase: "review_repair_test", barrier_id: barrierId, worktree_id: worktreeId,
            implementation_dispatch_id: developerId,
            implementation_commit: evidence.commit, implementation_committed: true, changed_paths: evidence.paths ?? [],
            test_commands: frozen.commands, test_command_provenance: frozen.provenance,
          },
        }, "test"), result.dispatch_id);
        this.changeStage(runId, "test", testId);
        return;
      }
      if (context.phase === "test_repair_commit") {
        const sourceTestDispatchId = typeof (context as { source_test_dispatch_id?: unknown }).source_test_dispatch_id === "string"
          ? (context as { source_test_dispatch_id: string }).source_test_dispatch_id : undefined;
        const worktreeId = typeof (context as { worktree_id?: unknown }).worktree_id === "string"
          ? (context as { worktree_id: string }).worktree_id : undefined;
        const developerId = typeof (context as { developer_dispatch_id?: unknown }).developer_dispatch_id === "string"
          ? (context as { developer_dispatch_id: string }).developer_dispatch_id : undefined;
        if (!sourceTestDispatchId || !worktreeId || !developerId) throw new ValidationError("Test repair commit is missing its lineage identity");
        const operation = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
          .get(runId, worktreeId) as { evidence_json?: string } | undefined;
        const evidence = JSON.parse(operation?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (!evidence.commit) throw new ValidationError("completed Test repair Git Operator result has no bound commit operation");
        this.createRepairRetest(runId, sourceTestDispatchId, developerId, evidence.commit, evidence.paths ?? []);
        return;
      }
      if (context.phase === "cancel_cleanup") {
        this.store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.canceled", { cleanup_dispatch_id: result.dispatch_id, reconciliation: context.reconciliation ?? null });
        return;
      }
      if (context.phase === "finalize_integration") {
        const unfinished = this.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')")
          .get(runId) as { count: number };
        if (unfinished.count) throw new ValidationError("run cannot complete while dispatches remain pending or claimed");
        this.store.db.prepare("UPDATE runs SET state='completed',stage='completed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.completed", { final_dispatch_id: result.dispatch_id });
        return;
      }
    }
    if (role === "frontend-developer" || role === "backend-developer") {
      const packetRow = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string };
      const packet = JSON.parse(packetRow.packet_json) as DispatchPacket;
      if (packet.context.phase === "test_repair" && typeof packet.context.source_test_dispatch_id === "string" && typeof packet.context.worktree_id === "string") {
        const lineage = this.store.db.prepare("SELECT test_scope FROM test_repair_lineage WHERE run_id=? AND source_test_dispatch_id=? AND repair_developer_dispatch_id=?")
          .get(runId, packet.context.source_test_dispatch_id, result.dispatch_id) as { test_scope: string } | undefined;
        if (!lineage) throw new ValidationError("completed Test repair Developer is not bound to its lineage");
        if (lineage.test_scope === "task") {
          this.createRepairRetest(runId, packet.context.source_test_dispatch_id, result.dispatch_id);
          return;
        }
        const modifiedPaths = Array.isArray((result.payload as { modified_paths?: unknown }).modified_paths)
          ? (result.payload as { modified_paths: string[] }).modified_paths : [];
        const commitId = this.insert(runId, "git-operator", validatePacket({
          objective: `Commit ${lineage.test_scope} Test repair before independent retest.`,
          allowed_read_paths: [], allowed_write_paths: [],
          acceptance_criteria: ["Commit only the repair Developer paths", "Preserve the Test repair lineage"],
          context: {
            stage: "git-operator", phase: "test_repair_commit", test_scope: lineage.test_scope,
            source_test_dispatch_id: packet.context.source_test_dispatch_id,
            worktree_id: packet.context.worktree_id, developer_dispatch_id: result.dispatch_id, changed_paths: modifiedPaths,
          },
        }, "git-operator"), result.dispatch_id);
        this.store.db.prepare("UPDATE test_repair_lineage SET repair_commit_dispatch_id=? WHERE source_test_dispatch_id=?")
          .run(commitId, packet.context.source_test_dispatch_id);
        this.changeStage(runId, "git-operator", commitId);
        return;
      }
      if (packet.context.phase === "review_repair" && typeof packet.context.barrier_id === "string" && typeof packet.context.worktree_id === "string") {
        const modifiedPaths = Array.isArray((result.payload as { modified_paths?: unknown }).modified_paths)
          ? (result.payload as { modified_paths: string[] }).modified_paths : [];
        const dispatchId = this.insert(runId, "git-operator", validatePacket({
          objective: `Commit the repair for review barrier ${packet.context.barrier_id} in its existing plan worktree.`,
          allowed_read_paths: [],
          allowed_write_paths: [],
          acceptance_criteria: ["Commit only the Developer-authored repair paths", "Do not create Task integration for the plan worktree"],
          context: {
            stage: "git-operator", phase: "review_repair_commit", barrier_id: packet.context.barrier_id,
            worktree_id: packet.context.worktree_id, developer_dispatch_id: result.dispatch_id, changed_paths: modifiedPaths,
          },
        }, "git-operator"), result.dispatch_id);
        this.changeStage(runId, "git-operator", dispatchId);
        return;
      }
      const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
      if (taskId && this.plannedTaskRows(runId).some((task) => task.task_id === taskId)) {
        this.store.advanceRunTask(runId, taskId, "implemented", { worktree_id: String(packet.context.worktree_id), developer_dispatch_id: result.dispatch_id });
        this.createPlannedTaskTest(runId, result.dispatch_id);
        return;
      }
    }
    if (role === "test") {
      const packetRow = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string };
      const packet = JSON.parse(packetRow.packet_json) as DispatchPacket;
      if (packet.context.phase === "review_repair_test") {
        this.changeStage(runId, "coding", result.dispatch_id);
        this.store.event(runId, "review.repair_verified", {
          barrier_id: packet.context.barrier_id,
          repair_commit: packet.context.implementation_commit,
          test_dispatch_id: result.dispatch_id,
        });
        return;
      }
      if (packet.context.phase === "task_test" && typeof packet.context.task_id === "string") {
        this.store.advanceRunTask(runId, packet.context.task_id, "tested", { worktree_id: String(packet.context.worktree_id), test_dispatch_id: result.dispatch_id });
        this.changeStage(runId, "coding", result.dispatch_id);
        this.ensureCodingCommitContinuation(runId);
        return;
      }
    }
    if (["coding", "frontend-developer", "backend-developer", "git-operator"].includes(role)) {
      if (run.mode === "planned") {
        if (role === "coding" && this.ensurePlannedTaskDeveloperDispatch(runId, result.dispatch_id, "completion")) return;
        this.reconcilePlannedTaskStates(runId);
        if (this.ensureNextPlannedTaskPrepare(runId)) return;
      }
      this.advanceImplementation(runId);
      return;
    }
    if (role === "test") this.advanceReview(runId, result);
  }

  private changeStage(runId: string, stage: string, dispatchId: string): void {
    this.store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(stage, new Date().toISOString(), runId);
    this.store.event(runId, "run.stage_changed", { stage, dispatchId });
  }

  private plannedTaskRows(runId: string): ReturnType<StateStore["runTasks"]> {
    const run = this.store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
    if (run.mode !== "planned") return [];
    const tasks = this.store.runTasks(runId);
    if (tasks.length && run.plan_id && run.revision) {
      const revision = this.store.db.prepare("SELECT digest FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { digest?: string } | undefined;
      if (revision?.digest && run.plan_digest !== revision.digest) throw new ValidationError("planned task manifest plan_digest does not match the frozen revision");
    }
    return tasks;
  }

  private frozenTaskWritePaths(runId: string, taskId: string): string[] {
    const task = this.plannedTaskRows(runId).find((candidate) => candidate.task_id === taskId);
    if (!task) throw new ValidationError(`unknown frozen run task: ${taskId}`);
    if (!task.write_paths_json) throw new ValidationError(`legacy frozen Task paths require managed scope recovery: ${taskId}`);
    return JSON.parse(task.write_paths_json) as string[];
  }

  private testCommandSnapshot(runId: string, worktreePath: string, explorerDispatchId: string): {
    commands: string[];
    provenance: { explorer_dispatch_id: string; plan_id: string | null; revision: string | null; repo_id: string };
  } {
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string };
    const packagePath = join(worktreePath, "package.json");
    let packageJson: { scripts?: Record<string, string> };
    try { packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> }; }
    catch { throw new ValidationError("Test packet requires a readable current-repository package.json"); }
    const scripts = packageJson.scripts ?? {};
    const commands: string[] = [];
    if (run.plan_id && run.revision) {
      let plan = "";
      const revision = this.store.db.prepare("SELECT plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { plan_commit?: string } | undefined;
      if (revision?.plan_commit) {
        if (!/^[a-f0-9]{40}$/.test(revision.plan_commit)) throw new ValidationError("Test packet requires a valid frozen plan commit");
        const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
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

  private reconcilePlannedTaskStates(runId: string): void {
    const tasks = this.plannedTaskRows(runId);
    if (!tasks.length) return;
    for (const task of tasks) {
      const taskKey = task.task_id.toLowerCase();
      const worktree = (task.worktree_id
        ? this.store.db.prepare("SELECT worktree_id,branch,base_commit FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, task.worktree_id)
        : this.store.db.prepare(`SELECT worktree_id,branch,base_commit FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)
          ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`)) as { worktree_id: string; branch: string; base_commit: string } | undefined;
      const developer = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, task.task_id) as { dispatch_id: string } | undefined;
      const taskTest = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='completed'
        AND json_extract(packet_json,'$.context.phase')='task_test' AND json_extract(packet_json,'$.context.task_id')=? ORDER BY completed_at DESC LIMIT 1`)
        .get(runId, task.task_id) as { dispatch_id: string } | undefined;
      const commit = worktree ? (this.store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { evidence_json?: string } | undefined) : undefined;
      const merge = worktree ? (this.store.db.prepare(`SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed'
        AND json_extract(evidence_json,'$.task_worktree_id')=? ORDER BY completed_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { evidence_json?: string } | undefined) : undefined;
      const commitEvidence = JSON.parse(commit?.evidence_json ?? "{}") as { commit?: string };
      const mergeEvidence = JSON.parse(merge?.evidence_json ?? "{}") as { commit?: string };
      if (merge && mergeEvidence.commit) this.store.advanceRunTask(runId, task.task_id, "integrated", {
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
        this.store.advanceRunTask(runId, task.task_id, "committed", { recovered: task.state !== "tested", ...evidence });
        if (worktree?.branch.startsWith("plan/")) {
          this.store.advanceRunTask(runId, task.task_id, "integrated", { ...evidence, integration_commit: commitEvidence.commit });
        }
      }
      else if (taskTest) this.store.advanceRunTask(runId, task.task_id, "tested", { recovered: task.state !== "implemented", ...(worktree ? { worktree_id: worktree.worktree_id } : {}), ...(developer ? { developer_dispatch_id: developer.dispatch_id } : {}), test_dispatch_id: taskTest.dispatch_id });
      else if (developer) this.store.advanceRunTask(runId, task.task_id, "implemented", { recovered: task.state !== "prepared", ...(worktree ? { worktree_id: worktree.worktree_id } : {}), developer_dispatch_id: developer.dispatch_id });
      else if (worktree) {
        const integration = this.activeIntegrationWorktree(runId);
        const currentPlanHead = integration ? execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : undefined;
        if (worktree.branch.startsWith("task/") && currentPlanHead && worktree.base_commit !== currentPlanHead) continue;
        this.store.advanceRunTask(runId, task.task_id, "prepared", { recovered: task.state !== "pending", worktree_id: worktree.worktree_id });
      }
    }
  }

  private handlePrematurePlannedTest(runId: string): void {
    const tasks = this.plannedTaskRows(runId);
    if (!tasks.length || tasks.every(({ state }) => state === "integrated")) return;
    const tests = this.store.db.prepare(`SELECT dispatch_id,state,packet_json FROM dispatches WHERE run_id=? AND role='test' AND state IN ('pending','claimed','completed','failed','retryable_failure')
      ORDER BY created_at`).all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string }>;
    const handledIds = new Set((this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.premature_handled'").all(runId) as Array<{ payload_json: string }>)
      .map(({ payload_json }) => (JSON.parse(payload_json) as { dispatch_id: string }).dispatch_id));
    const premature = tests.filter(({ dispatch_id, packet_json }) => !handledIds.has(dispatch_id) && (JSON.parse(packet_json) as DispatchPacket).context.phase !== "task_test");
    if (!premature.length) return;
    this.store.db.transaction(() => {
      for (const test of premature) {
        this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), test.dispatch_id);
        this.store.event(runId, "test.premature_handled", { dispatch_id: test.dispatch_id, previous_state: test.state, incomplete_task_ids: tasks.filter(({ state }) => state !== "integrated").map(({ task_id }) => task_id) });
      }
      const commits = premature.map(({ packet_json }) => (JSON.parse(packet_json) as DispatchPacket).context.implementation_commit).filter((commit): commit is string => typeof commit === "string");
      for (const commit of commits) {
        const reviewers = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state IN ('pending','claimed','completed')
          AND json_extract(packet_json,'$.context.revision_sha')=?`).all(runId, commit) as Array<{ dispatch_id: string; state: string }>;
        for (const reviewer of reviewers) {
          this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), reviewer.dispatch_id);
          this.store.event(runId, "review.premature_handled", { dispatch_id: reviewer.dispatch_id, previous_state: reviewer.state, revision_sha: commit });
        }
      }
      this.store.db.prepare("UPDATE runs SET stage='coding',state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    })();
  }

  private ensureNextPlannedTaskPrepare(runId: string): string | undefined {
    const tasks = this.plannedTaskRows(runId);
    if (!tasks.length) return undefined;
    const next = tasks.find(({ state }) => state !== "integrated");
    if (!next || next.state !== "pending") return undefined;
    if (tasks.slice(0, next.ordinal).some(({ state }) => state !== "integrated")) return undefined;
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) throw new ValidationError("planned task prepare requires the active plan worktree");
    const baseCommit = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const recovery = this.pendingPlannedTaskRecovery(runId, next.task_id);
    if (recovery) {
      const existingRecovery = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
        AND json_extract(packet_json,'$.context.phase')='recover_task_worktree'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
      if (existingRecovery) return existingRecovery.dispatch_id;
      const existingPrepare = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
        AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'
        AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
      if (existingPrepare?.state === "completed") return existingPrepare.dispatch_id;
      if (existingPrepare && !this.prepareDispatchHasNoSideEffects(runId, existingPrepare.dispatch_id)) {
        throw new ValidationError("claimed planned task prepare has recorded side effects and requires reconciliation before task worktree recovery");
      }
      const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
      if (!coordinator) return undefined;
      const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
      const explorerDispatchId = typeof coordinatorPacket.context.explorer_dispatch_id === "string"
        ? coordinatorPacket.context.explorer_dispatch_id
        : (this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { dispatch_id?: string } | undefined)?.dispatch_id;
      if (!explorerDispatchId) throw new ValidationError("planned task recovery requires completed Explorer provenance");
      const dispatchId = this.insert(runId, "git-operator", validatePacket({
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
        this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), existingPrepare.dispatch_id);
        this.store.event(runId, "dispatch.prepare_superseded_for_task_recovery", {
          dispatch_id: existingPrepare.dispatch_id,
          replacement_dispatch_id: dispatchId,
          task_id: next.task_id,
          reason: "pending source-owned planned task worktree recovery lineage",
        });
      }
      this.changeStage(runId, "git-operator", dispatchId);
      return dispatchId;
    }
    const taskKey = next.task_id.toLowerCase();
    const taskWorktree = this.store.db.prepare(`SELECT worktree_id,base_commit FROM worktrees WHERE run_id=? AND state='active'
      AND (branch LIKE ? OR branch LIKE ?) ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string; base_commit: string } | undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'
      AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`).get(runId, next.task_id) as { dispatch_id: string; state: string } | undefined;
    const staleWorktree = taskWorktree && taskWorktree.base_commit !== baseCommit ? taskWorktree : undefined;
    if (existing && !staleWorktree) return existing.dispatch_id;
    const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) return undefined;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const explorerDispatchId = typeof coordinatorPacket.context.explorer_dispatch_id === "string"
      ? coordinatorPacket.context.explorer_dispatch_id
      : (this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { dispatch_id?: string } | undefined)?.dispatch_id;
    if (!explorerDispatchId) throw new ValidationError("planned task prepare requires completed Explorer provenance");
    const resolvedTests = new Set((this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.predecessor_repair_resolved' ORDER BY event_id")
      .all(runId) as Array<{ payload_json: string }>).flatMap(({ payload_json }) => {
        const ids = (JSON.parse(payload_json) as { handled_test_dispatch_ids?: unknown }).handled_test_dispatch_ids;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      }));
    const recoveredTests = (this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='test.premature_handled' ORDER BY event_id")
      .all(runId) as Array<{ payload_json: string }>).map(({ payload_json }) => (JSON.parse(payload_json) as { dispatch_id: string }).dispatch_id);
    const handledTests = recoveredTests.filter((dispatchId) => !resolvedTests.has(dispatchId)).map((dispatchId) => {
      const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, dispatchId) as { artifact_id: string; sha256: string } | undefined;
      const dispatch = this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId) as { result_json?: string } | undefined;
      const result = JSON.parse(dispatch?.result_json ?? "{}") as { payload?: { checks?: Array<{ command?: unknown; outcome?: unknown }> } };
      const failedChecks = (result.payload?.checks ?? []).filter(({ outcome }) => !successfulOutcome(outcome)).flatMap(({ command, outcome }) =>
        typeof command === "string" ? [{ command, outcome: String(outcome ?? "unknown") }] : []);
      return {
        dispatch_id: dispatchId,
        ...(artifact ? { artifact_id: artifact.artifact_id, digest: artifact.sha256 } : {}),
        failed_checks: failedChecks,
      };
    });
    const predecessorCommands = [...new Set(handledTests.flatMap(({ failed_checks }) => failed_checks.map(({ command }) => command)))];
    const dispatchId = this.insert(runId, "git-operator", validatePacket({
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
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), existing.dispatch_id);
    }
    if (staleWorktree) this.store.event(runId, "worktree.stale_reprepare_created", {
      dispatch_id: dispatchId,
      replacement_for: existing?.dispatch_id ?? null,
      task_id: next.task_id,
      worktree_id: staleWorktree.worktree_id,
      stale_base_commit: staleWorktree.base_commit,
      required_base_commit: baseCommit,
    });
    this.changeStage(runId, "git-operator", dispatchId);
    return dispatchId;
  }

  private pendingPlannedTaskRecovery(runId: string, taskId: string): {
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
    const run = this.store.getRun(runId) as { repo_id: string; profile: string; mode?: string; plan_id?: string; revision?: string };
    if (run.profile !== "coding" || run.mode !== "planned" || !run.plan_id || !run.revision) return undefined;
    const source = this.store.db.prepare(`SELECT source_run.run_id AS source_run_id,source_run.plan_id,source_run.revision,
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

  private prepareDispatchHasNoSideEffects(runId: string, dispatchId: string): boolean {
    const worktreeBinding = this.store.db.prepare("SELECT 1 FROM dispatch_worktree_bindings WHERE run_id=? AND dispatch_id=? LIMIT 1")
      .get(runId, dispatchId);
    const staging = this.store.db.prepare("SELECT 1 FROM staging_entries WHERE run_id=? AND dispatch_id=? LIMIT 1")
      .get(runId, dispatchId);
    return !worktreeBinding && !staging;
  }

  private createPlannedTaskTest(runId: string, developerDispatchId: string): string | undefined {
    const developer = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND state='completed'")
      .get(runId, developerDispatchId) as { packet_json: string } | undefined;
    if (!developer) return undefined;
    const packet = JSON.parse(developer.packet_json) as DispatchPacket;
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    if (!taskId || !this.plannedTaskRows(runId).some((task) => task.task_id === taskId)) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.phase')='task_test' AND json_extract(packet_json,'$.context.task_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, taskId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const worktreeId = String(packet.context.worktree_id);
    const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
    const explorerDispatchId = typeof packet.context.explorer_dispatch_id === "string" ? packet.context.explorer_dispatch_id : undefined;
    if (!worktree || !explorerDispatchId) throw new ValidationError("planned task Test requires its worktree and Explorer provenance");
    const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'").get(runId, developerDispatchId) as { artifact_id: string; sha256: string } | undefined;
    if (!artifact) throw new ValidationError("planned task Test requires the implementation artifact");
    const frozen = this.testCommandSnapshot(runId, worktree.path, explorerDispatchId);
    const dispatchId = this.insert(runId, "test", validatePacket({
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
    this.changeStage(runId, "test", dispatchId);
    return dispatchId;
  }

  private completedImplementationOperation(runId: string): { commit: string; paths: string[]; kind: string } | undefined {
    const rows = this.store.db.prepare("SELECT kind,evidence_json FROM operations WHERE run_id=? AND kind IN ('git.merge.task','git.commit') AND state='completed' ORDER BY completed_at DESC, CASE kind WHEN 'git.merge.task' THEN 0 ELSE 1 END").all(runId) as Array<{ kind: string; evidence_json?: string }>;
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (/^[a-f0-9]{40}$/.test(evidence.commit ?? "")) return { commit: evidence.commit!, paths: evidence.paths ?? [], kind: row.kind };
      } catch { /* malformed legacy evidence is not implementation proof */ }
    }
    return undefined;
  }

  private activeIntegrationWorktree(runId: string): { worktree_id: string; path: string } | undefined {
    return resolveReviewWorktree(this.store, runId);
  }

  private createPlannedCodingDispatch(runId: string, explorerDispatchId: string | undefined, gitDispatchId: string): string {
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const explorer = explorerDispatchId
      ? this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned Coding dispatch requires its completed Explorer dependency");
    const result = JSON.parse(explorer.result_json) as ResultEnvelope;
    const allowedReadPaths = ((result.payload.allowed_read_paths as string[] | undefined) ?? [])
      .filter((path) => !isBroadReadPath(path));
    const worktree = this.activeIntegrationWorktree(runId);
    if (!worktree) throw new ValidationError("planned Coding dispatch requires the verified plan worktree");
    const tasks = this.plannedTaskRows(runId);
    if (tasks.length === 1 && tasks[0]!.state === "pending") {
      this.store.advanceRunTask(runId, tasks[0]!.task_id, "prepared", { worktree_id: worktree.worktree_id });
    }
    const dispatchId = this.create(runId, "coding", {
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
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensurePlannedTaskContinuation(runId: string, prepareDispatchId?: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; mode?: string; state: string; plan_id?: string; revision?: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") return undefined;
    const prepare = (prepareDispatchId
      ? this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree')`).get(runId, prepareDispatchId)
      : this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree') ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!prepare) return undefined;
    const preparePacket = JSON.parse(prepare.packet_json) as DispatchPacket;
    const prepareContext = preparePacket.context as Record<string, unknown>;
    const taskId = typeof prepareContext.task_id === "string" ? prepareContext.task_id : "";
    if (!/^TASK-\d{3}$/.test(taskId)) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')='continue_implementation'
      AND json_extract(packet_json,'$.context.prepare_git_dispatch_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, prepare.dispatch_id) as { dispatch_id: string; state: string } | undefined;
    if (existing) return existing.state === "pending" || existing.state === "claimed" ? existing.dispatch_id : undefined;
    const taskKey = taskId.toLowerCase();
    const worktree = this.store.db.prepare(`SELECT worktree_id,path FROM worktrees WHERE run_id=? AND state='active'
      AND (branch LIKE ? OR branch LIKE ?) ORDER BY created_at DESC LIMIT 1`)
      .get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string; path: string } | undefined;
    if (!worktree) throw new ValidationError("planned task continuation requires the prepared task worktree");
    const developer = this.store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer') AND state!='failed'
      AND json_extract(packet_json,'$.context.worktree_id')=?`).get(runId, worktree.worktree_id);
    if (developer) return undefined;
    const requestedCoordinatorId = typeof prepareContext.coordinator_dispatch_id === "string" ? prepareContext.coordinator_dispatch_id : undefined;
    const coordinator = (requestedCoordinatorId
      ? this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'").get(runId, requestedCoordinatorId)
      : this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) throw new ValidationError("planned task continuation requires its completed Coding coordinator");
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const explorerDispatchId = typeof prepareContext.explorer_dispatch_id === "string"
      ? prepareContext.explorer_dispatch_id
      : typeof coordinatorPacket.context.explorer_dispatch_id === "string" ? coordinatorPacket.context.explorer_dispatch_id : undefined;
    const explorer = explorerDispatchId
      ? this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned task continuation requires its completed Explorer authorization");
    const explorerResult = JSON.parse(explorer.result_json) as ResultEnvelope;
    const authorizedPaths = explorerResult.payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) throw new ValidationError("planned task continuation requires valid Explorer paths");
    const allowedReadPaths = authorizedPaths.filter((path) => !isBroadReadPath(path));
    const packet = validatePacket({
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
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, coordinator.dispatch_id);
    this.store.event(runId, "coding.continue_implementation_created", {
      dispatchId,
      task_id: taskId,
      worktree_id: worktree.worktree_id,
      prepare_git_dispatch_id: prepare.dispatch_id,
      replacement_for: coordinator.dispatch_id,
    });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureRecoveredTaskDeveloperDispatch(
    runId: string,
    authorityDispatchId: string,
    allowReconciledTaskRecovery = false,
  ): string | undefined {
    const authority = this.store.db.prepare(`SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state IN ('completed','failed')
      AND json_extract(packet_json,'$.context.phase')='apply_task_authority'`).get(runId, authorityDispatchId) as { packet_json: string } | undefined;
    if (!authority) return undefined;
    const authorityPacket = JSON.parse(authority.packet_json) as DispatchPacket;
    const context = authorityPacket.context as Record<string, unknown>;
    const taskId = typeof context.task_id === "string" ? context.task_id : undefined;
    const sourceId = typeof context.superseded_developer_dispatch_id === "string" ? context.superseded_developer_dispatch_id : undefined;
    const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : undefined;
    const worktreePath = typeof context.worktree_path === "string" ? context.worktree_path : undefined;
    if (!taskId || !sourceId || !worktreeId || !worktreePath) throw new ValidationError("authority application continuation lacks frozen developer lineage");
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? AND role='backend-developer' ORDER BY created_at LIMIT 1")
      .get(runId, sourceId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const source = this.store.db.prepare("SELECT packet_json,state FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='backend-developer'")
      .get(runId, sourceId) as { packet_json: string; state: string } | undefined;
    if (!source || source.state !== "failed") throw new ValidationError("authority application source developer was not superseded");
    const task = this.plannedTaskRows(runId).find((candidate) => candidate.task_id === taskId);
    const isReconciledTaskOwner = task?.developer_dispatch_id === sourceId
      || task?.developer_dispatch_id === authorityDispatchId;
    const recoveringReconciledTask = allowReconciledTaskRecovery
      && (task?.state === "prepared" || task?.state === "implemented")
      && isReconciledTaskOwner;
    const normallyReadyTask = task?.state === "prepared" && !task.developer_dispatch_id;
    if (!normallyReadyTask && !recoveringReconciledTask) {
      throw new ValidationError("authority application task is no longer ready for its replacement developer");
    }
    const worktree = this.store.db.prepare("SELECT path,state FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(runId, worktreeId) as { path: string; state: string } | undefined;
    if (!worktree || worktree.state !== "active" || worktree.path !== worktreePath) throw new ValidationError("authority application worktree identity changed before developer replacement");
    const sourcePacket = JSON.parse(source.packet_json) as DispatchPacket;
    const unfrozenSource = { ...sourcePacket };
    delete unfrozenSource.execution_contract;
    const packet = validatePacket({
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
    this.store.db.transaction(() => {
      replacementId = this.insert(runId, "backend-developer", packet, sourceId);
      const updated = recoveringReconciledTask
        ? this.store.db.prepare(`UPDATE run_tasks SET state='prepared',developer_dispatch_id=?,updated_at=?
          WHERE run_id=? AND task_id=? AND developer_dispatch_id IN (?,?) AND state IN ('prepared','implemented')`)
          .run(replacementId, new Date().toISOString(), runId, taskId, sourceId, authorityDispatchId)
        : this.store.db.prepare(`UPDATE run_tasks SET developer_dispatch_id=?,updated_at=?
          WHERE run_id=? AND task_id=? AND developer_dispatch_id IS NULL AND state='prepared'`)
          .run(replacementId, new Date().toISOString(), runId, taskId);
      if (updated.changes !== 1) throw new ValidationError("authority application task ownership changed during developer replacement");
      this.store.event(runId, "coding.developer_dispatch_created", {
        dispatch_id: replacementId,
        source: "scope_recovery",
        task_id: taskId,
        worktree_id: worktreeId,
        superseded_developer_dispatch_id: sourceId,
        authority_apply_git_dispatch_id: authorityDispatchId,
      });
    })();
    this.changeStage(runId, "coding", replacementId);
    return replacementId;
  }

  private ensurePlannedTaskDeveloperDispatch(
    runId: string,
    continuationDispatchId?: string,
    source: "completion" | "resume" = "resume",
  ): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; mode?: string; state: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") return undefined;
    const continuation = (continuationDispatchId
      ? this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='continue_implementation'`).get(runId, continuationDispatchId)
      : this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='continue_implementation' ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!continuation) return undefined;
    const coordinator = JSON.parse(continuation.packet_json) as DispatchPacket;
    const context = coordinator.context as Record<string, unknown>;
    const taskId = typeof context.task_id === "string" ? context.task_id : undefined;
    const explorerDispatchId = typeof context.explorer_dispatch_id === "string" ? context.explorer_dispatch_id : undefined;
    const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : undefined;
    const worktreePath = typeof context.worktree_path === "string" ? context.worktree_path : undefined;
    const prepareDispatchId = typeof context.prepare_git_dispatch_id === "string" ? context.prepare_git_dispatch_id : undefined;
    if (!taskId || !explorerDispatchId || !worktreeId || !worktreePath || !prepareDispatchId) return undefined;
    const task = this.plannedTaskRows(runId).find((candidate) => candidate.task_id === taskId);
    if (!task || task.state !== "prepared" || task.developer_dispatch_id) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')
      AND state IN ('pending','claimed','completed') AND json_extract(packet_json,'$.context.coordinator_dispatch_id')=? LIMIT 1`)
      .get(runId, continuation.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return undefined;
    const prepare = this.store.db.prepare(`SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state='completed'
      AND json_extract(packet_json,'$.context.phase') IN ('prepare_implementation_worktree','recover_task_worktree')`)
      .get(runId, prepareDispatchId) as { packet_json: string } | undefined;
    const prepareTaskId = prepare ? (JSON.parse(prepare.packet_json) as DispatchPacket).context.task_id : undefined;
    if (prepareTaskId !== taskId) throw new ValidationError("planned task developer requires its frozen prepare lineage");
    const worktree = this.store.db.prepare("SELECT path,branch FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
      .get(runId, worktreeId) as { path: string; branch: string } | undefined;
    if (!worktree || worktree.path !== worktreePath || !worktree.branch.startsWith("task/")) {
      throw new ValidationError("planned task developer requires its prepared active task worktree");
    }
    const developer = validatePacket({
      objective: `Implement ${taskId} in its frozen prepared task worktree.`,
      allowed_read_paths: coordinator.allowed_read_paths,
      allowed_write_paths: this.frozenTaskWritePaths(runId, taskId),
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
    this.assertCommandAllowed("coding", "dispatch create");
    this.assertContinueImplementationDelegation(runId, continuation.dispatch_id, "backend-developer", coordinator, developer);
    const frozenDeveloper = freezeExecutionContract("backend-developer", this.freezeVerificationContext(runId, "backend-developer", developer));
    assertExplorerAuthorization(this.store, runId, "backend-developer", frozenDeveloper);
    const dispatchId = this.insert(runId, "backend-developer", frozenDeveloper);
    this.store.event(runId, "coding.developer_dispatch_created", {
      dispatch_id: dispatchId,
      source,
      coordinator_dispatch_id: continuation.dispatch_id,
      prepare_git_dispatch_id: prepareDispatchId,
      task_id: taskId,
      worktree_id: worktreeId,
      explorer_dispatch_id: explorerDispatchId,
    });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  ensureGitPrepareDispatch(runId: string, target: "integration" | "implementation", explorerDispatchId?: string): string {
    const phase = target === "integration" ? "prepare_worktrees" : "prepare_implementation_worktree";
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')=?
      ORDER BY created_at DESC LIMIT 1`).get(runId, phase) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = this.store.getRun(runId) as { base_commit?: string; mode?: string };
    return this.insert(runId, "git-operator", validatePacket({
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

  private assertGitPrepareResult(runId: string, packet: DispatchPacket): void {
    const context = packet.context as { phase?: unknown; task_id?: unknown; worktree_id?: unknown; worktree_ids?: unknown; operation?: unknown; authority_commit?: unknown; expected_head?: unknown };
    if (context.phase === "prepare_worktrees") {
      const worktree = this.activeIntegrationWorktree(runId);
      if (!worktree) throw new ValidationError("prepare_worktrees requires a registered active integration worktree or plan worktree owned by this run");
    }
    if (context.phase === "prepare_implementation_worktree") {
      const taskId = typeof context.task_id === "string" ? context.task_id.toLowerCase() : "implementation";
      const worktree = this.store.db.prepare("SELECT 1 FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)")
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
      const recovered = this.store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.worktree.recover' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? AND json_extract(evidence_json,'$.task_id')=? LIMIT 1`).get(runId, worktreeId, taskId);
      if (!recovered) throw new ValidationError("recover_task_worktree requires its completed recovery receipt");
    }
    if (context.phase === "apply_task_authority") {
      const worktreeId = typeof context.worktree_id === "string" ? context.worktree_id : "";
      const authorityCommit = typeof context.authority_commit === "string" ? context.authority_commit : "";
      const expectedHead = typeof context.expected_head === "string" ? context.expected_head : "";
      const applied = this.store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.task_authority.apply' AND state='completed'
        AND json_extract(evidence_json,'$.worktree_id')=? AND json_extract(evidence_json,'$.authority_commit')=?
        AND json_extract(evidence_json,'$.head')=? LIMIT 1`).get(runId, worktreeId, authorityCommit, expectedHead);
      if (!applied) throw new ValidationError("apply_task_authority requires its completed authority application receipt");
    }
    if (context.phase === "reconcile_worktree_ownership") {
      if (!Array.isArray(context.worktree_ids) || !context.worktree_ids.length || context.worktree_ids.some((id) => typeof id !== "string")) {
        throw new ValidationError("ownership reconciliation requires registered worktree ids");
      }
      const owned = context.worktree_ids.every((worktreeId) => this.store.db.prepare("SELECT 1 FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId));
      if (!owned) throw new ValidationError("ownership reconciliation did not transfer every worktree to this run");
    }
  }

  private ensureIntegrationDispatch(
    runId: string,
    taskWorktreeIds: string[],
    integrationWorktreeId: string,
    taskBindings: Array<{ task_id: string | null; worktree_id: string }>,
  ): string {
    const existing = (this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed')
      AND json_extract(packet_json,'$.context.phase')='integrate_implementation'
      ORDER BY created_at DESC`).all(runId) as Array<{ dispatch_id: string; packet_json: string }>).find(({ packet_json }) => {
        const ids = (JSON.parse(packet_json) as DispatchPacket).context.task_worktree_ids;
        return stableJson(Array.isArray(ids) ? [...ids].sort() : []) === stableJson([...taskWorktreeIds].sort());
      });
    if (existing) return existing.dispatch_id;
    const onlyTaskBinding = taskBindings[0];
    const taskBinding = taskBindings.length === 1 && onlyTaskBinding?.task_id ? onlyTaskBinding : undefined;
    return this.insert(runId, "git-operator", validatePacket({
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

  private implementationSnapshot(runId: string): ImplementationSnapshot | undefined {
    const run = this.store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
    const frozenTasks = this.plannedTaskRows(runId);
    const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.state,d.result_json,d.packet_json,d.completed_at FROM dispatches d
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
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) return undefined;
    const usesPlanWorktreeDirectly = run.mode === "planned" && taskWorktreeIds.length === 1 && taskWorktreeIds[0] === integration.worktree_id;
    const commitOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>;
    const committedWorktrees = new Set(commitOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.worktree_id === "string" ? [evidence.worktree_id] : []; }
      catch { return []; }
    }));
    if (!usesPlanWorktreeDirectly && taskWorktreeIds.some((worktreeId) => !committedWorktrees.has(worktreeId))) return undefined;
    const mergeOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' ORDER BY completed_at").all(runId) as Array<{ evidence_json?: string }>;
    const mergedWorktrees = new Set(mergeOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.task_worktree_id === "string" ? [evidence.task_worktree_id] : []; }
      catch { return []; }
    }));
    const unmergedWorktreeIds = taskWorktreeIds.filter((worktreeId) => !mergedWorktrees.has(worktreeId));
    if (!usesPlanWorktreeDirectly && unmergedWorktreeIds.length) {
      this.ensureIntegrationDispatch(
        runId,
        unmergedWorktreeIds,
        integration.worktree_id,
        taskBindings.filter(({ worktree_id }) => unmergedWorktreeIds.includes(worktree_id)),
      );
      return undefined;
    }
    if (frozenTasks.length && frozenTasks.some(({ state }) => state !== "integrated")) return undefined;
    const implementation = this.completedImplementationOperation(runId);
    if (usesPlanWorktreeDirectly && implementation && implementation.kind !== "git.commit" || !usesPlanWorktreeDirectly && implementation?.kind !== "git.merge.task") return undefined;
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (implementation && implementation.commit !== integrationHead) return undefined;
    if (!implementation) return undefined;
    const integrationRow = this.store.db.prepare("SELECT base_commit FROM worktrees WHERE run_id=? AND worktree_id=?")
      .get(runId, integration.worktree_id) as { base_commit: string } | undefined;
    if (!integrationRow?.base_commit) return undefined;
    const changedPaths = execFileSync("git", ["-C", integration.path, "diff", "--name-only", `${integrationRow.base_commit}..${implementation.commit}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    if (!changedPaths.length) return undefined;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
    const authorizedPaths = explorer?.result_json
      ? (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths
      : [...new Set([...developers.flatMap((developer) => (JSON.parse(developer.packet_json) as DispatchPacket).allowed_read_paths), "package.json"])];
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    if (!explorer && (this.store.getRun(runId) as { mode?: string }).mode === "planned") return undefined;
    if (run.mode === "planned" && frozenTasks.length) {
      const developerWritePaths = developers.flatMap((developer) => (JSON.parse(developer.packet_json) as DispatchPacket).allowed_write_paths);
      const frozenTaskWritePaths = frozenTasks.flatMap((task) => this.frozenTaskWritePaths(runId, task.task_id));
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
      const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, developer.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      const taskId = (JSON.parse(developer.packet_json) as DispatchPacket).context.task_id;
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
    const frozenCommands = this.testCommandSnapshot(runId, integration.path, explorer.dispatch_id);
    return {
      coordinatorDispatchId: coordinator.dispatch_id,
      explorerDispatchId: explorer?.dispatch_id ?? null,
      authorizedPaths: authorizedPaths as string[],
      developerDispatchIds: developers.map(({ dispatch_id }) => dispatch_id),
      implementationDispatchId: primary.dispatch_id,
      implementationArtifact: { artifact_id: primaryArtifact!.artifact_id, digest: primaryArtifact!.digest },
      implementationArtifacts: implementationArtifacts as ImplementationSnapshot["implementationArtifacts"],
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

  private testPacket(snapshot: ImplementationSnapshot, coordinatorDispatchId?: string): DispatchPacket {
    return validatePacket(buildTestPacket(snapshot, coordinatorDispatchId), "test");
  }

  private createTestDispatch(runId: string, snapshot: ImplementationSnapshot, coordinatorDispatchId?: string): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, snapshot.implementationCommit) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = this.insert(runId, "test", this.testPacket(snapshot, coordinatorDispatchId));
    this.changeStage(runId, "test", dispatchId);
    return dispatchId;
  }

  private advanceImplementation(runId: string): void {
    const snapshot = this.implementationSnapshot(runId);
    if (!snapshot) return;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=?`).get(runId, snapshot.implementationCommit);
    if (existing) return;
    const dispatchId = this.createTestDispatch(runId, snapshot);
    this.store.event(runId, "test.dispatch_created", { dispatchId, implementation_dispatch_id: snapshot.implementationDispatchId, implementation_artifact_id: snapshot.implementationArtifact.artifact_id });
  }

  private advanceReview(runId: string, result: ResultEnvelope): void {
    const packet = this.buildReviewPacket(runId, result);
    if (!packet) return;
    const revisionSha = packet.context.revision_sha;
    const existing = this.store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state!='failed'
      AND json_extract(packet_json,'$.context.revision_sha')=?`).get(runId, revisionSha);
    if (existing) return;
    const dispatchId = this.insert(runId, "code-reviewer", packet);
    this.changeStage(runId, "code-reviewer", dispatchId);
  }

  reconcileReview(runId: string, barrierId?: string): Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> {
    this.store.getRun(runId);
    const barriers = this.store.db.prepare(`SELECT * FROM review_barriers WHERE run_id=?${barrierId ? " AND barrier_id=?" : ""} ORDER BY created_at`)
      .all(...(barrierId ? [runId, barrierId] : [runId])) as ReviewBarrierRow[];
    if (barrierId && barriers.length === 0) throw new ValidationError("review barrier does not belong to run");
    const outcomes: Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> = [];
    for (const barrier of barriers) {
      let outcome = { barrier_id: barrier.barrier_id, state: barrier.state, blocking: [] as ReviewFinding[] };
      this.store.db.transaction(() => {
        const axes: Array<"spec" | "standards"> = barrier.axes_json ? JSON.parse(barrier.axes_json) as Array<"spec" | "standards"> : barrier.formal ? ["spec", "standards"] : ["standards"];
        for (const axis of axes) {
          const role = axis === "spec" ? "review-spec" : "review-standards";
          const dispatchColumn = axis === "spec" ? "spec_dispatch_id" : "standards_dispatch_id";
          let dispatchId = axis === "spec" ? barrier.spec_dispatch_id : barrier.standards_dispatch_id;
          let leaf = dispatchId
            ? this.store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role)
            : undefined;
          if (!leaf) {
            leaf = (this.store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC").all(runId, role) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>)
              .find((row) => (JSON.parse(row.packet_json) as DispatchPacket).context.barrier_id === barrier.barrier_id);
            dispatchId = (leaf as { dispatch_id?: string } | undefined)?.dispatch_id;
            if (dispatchId) this.store.db.prepare(`UPDATE review_barriers SET ${dispatchColumn}=? WHERE barrier_id=?`).run(dispatchId, barrier.barrier_id);
          }
          const row = leaf as { dispatch_id: string; state: string; packet_json: string; result_json?: string } | undefined;
          if (row?.state !== "completed" || !row.result_json) continue;
          const packet = JSON.parse(row.packet_json) as DispatchPacket;
          if (packet.context.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review packet is not bound to its barrier`);
          const envelope = JSON.parse(row.result_json) as ResultEnvelope;
          const payload = envelope.payload as { finding_ids?: unknown; barrier_id?: unknown };
          if (payload.barrier_id !== undefined && payload.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review result is not bound to its barrier`);
          const reviewResult: ReviewResult = { axis, summary: envelope.summary, findings: envelope.findings as ReviewFinding[] };
          validateReviewResult(reviewResult);
          const findingIds = reviewResult.findings.map((finding) => finding.finding_id);
          if (stableJson(payload.finding_ids ?? []) !== stableJson(findingIds)) throw new ValidationError(`${axis} review result finding ids do not match its findings`);
          const serialized = stableJson(reviewResult);
          const existing = this.store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? AND axis=?").get(barrier.barrier_id, axis) as { result_json: string } | undefined;
          if (existing && existing.result_json !== serialized) throw new ValidationError(`${axis} review was already submitted with a different result`);
          this.store.db.prepare("INSERT OR IGNORE INTO review_results(barrier_id,axis,result_json,created_at) VALUES (?,?,?,?)")
            .run(barrier.barrier_id, axis, serialized, new Date().toISOString());
          const artifact = this.store.db.prepare("SELECT sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
            .get(runId, row.dispatch_id) as { sha256: string } | undefined;
          const digestColumn = axis === "spec" ? "spec_result_digest" : "standards_result_digest";
          this.store.db.prepare(`UPDATE review_barriers SET ${digestColumn}=? WHERE barrier_id=?`).run(artifact?.sha256 ?? sha256(row.result_json), barrier.barrier_id);
          if (payload.barrier_id === undefined) {
            envelope.payload = { ...envelope.payload, barrier_id: barrier.barrier_id };
            this.store.db.prepare("UPDATE dispatches SET result_json=? WHERE dispatch_id=?").run(stableJson(envelope), row.dispatch_id);
          }
        }
        const results = (this.store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? ORDER BY axis").all(barrier.barrier_id) as Array<{ result_json: string }>)
          .map((row) => JSON.parse(row.result_json) as ReviewResult);
        const blocking = results.flatMap((result) => result.findings).filter((finding) => finding.severity === "P0" || finding.severity === "P1");
        let state = barrier.state;
        if (results.length === axes.length && !["resolved"].includes(state)) state = blocking.length ? "blocked" : "passed";
        const aggregate = {
          status: state,
          axes,
          completed_axes: results.map((result) => result.axis),
          finding_ids: results.flatMap((result) => result.findings.map((finding) => finding.finding_id)),
          blocking_finding_ids: blocking.map((finding) => finding.finding_id),
        };
        this.store.db.prepare("UPDATE review_barriers SET axes_json=?,state=?,aggregate_json=?,completed_at=CASE WHEN ?='pending' THEN completed_at ELSE COALESCE(completed_at,?) END WHERE barrier_id=?")
          .run(stableJson(axes), state, stableJson(aggregate), state, new Date().toISOString(), barrier.barrier_id);
        if (state === "blocked") this.ensureReviewResolutionDispatch(runId, barrier, blocking);
        if (state === "passed" || state === "resolved") this.ensureFinalGitDispatch(runId, barrier);
        outcome = { barrier_id: barrier.barrier_id, state, blocking };
      })();
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private ensureReviewResolutionDispatch(runId: string, barrier: ReviewBarrierRow, blocking: ReviewFinding[]): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='review_resolution'
      AND json_extract(packet_json,'$.context.barrier_id')=? LIMIT 1`).get(runId, barrier.barrier_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const leafId = barrier.spec_dispatch_id ?? barrier.standards_dispatch_id;
    const leaf = leafId ? this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(leafId) as { packet_json: string } | undefined : undefined;
    const reviewPaths = leaf ? (JSON.parse(leaf.packet_json) as DispatchPacket).allowed_read_paths : [];
    const writablePaths = reviewPaths.filter((path) => !path.startsWith(".ai-team/plans/"));
    const dispatchId = this.insert(runId, "coding", validatePacket({
      objective: `Resolve every blocking finding for review barrier ${barrier.barrier_id}.`,
      allowed_read_paths: reviewPaths,
      allowed_write_paths: writablePaths,
      acceptance_criteria: ["Map every P0/P1 finding to change evidence", "Provide verification evidence after the repair commit"],
      context: { stage: "coding", phase: "review_resolution", barrier_id: barrier.barrier_id, revision_sha: barrier.revision_sha, blocking_findings: blocking },
    }, "coding"));
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureFinalGitDispatch(runId: string, barrier: ReviewBarrierRow): string {
    const effectiveHead = barrier.repair_commit ?? barrier.revision_sha;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'
      AND json_extract(packet_json,'$.context.phase')='finalize_integration'
      AND json_extract(packet_json,'$.context.barrier_id')=?
      AND json_extract(packet_json,'$.context.revision_sha')=? LIMIT 1`).get(runId, barrier.barrier_id, effectiveHead) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = this.store.getRun(runId) as { state: string };
    if (run.state !== "active") return "";
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) throw new ValidationError("passed review requires an active integration worktree");
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (integrationHead !== effectiveHead) throw new ValidationError("finalize integration packet head does not match the plan worktree HEAD", {
      effective_reviewed_head: effectiveHead,
      integration_head: integrationHead,
    });
    const dispatchId = this.insert(runId, "git-operator", validatePacket({
      objective: `Merge reviewed integration commit ${effectiveHead} into the target branch and clean up owned worktrees.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge the reviewed integration worktree into the target branch", "Clean up all run-owned worktrees after integration"],
      context: { stage: "git-operator", phase: "finalize_integration", barrier_id: barrier.barrier_id, revision_sha: effectiveHead, original_review_head: barrier.revision_sha, integration_worktree_id: integration.worktree_id, actions: ["integrate", "cleanup"] },
    }, "git-operator"));
    if (run.state === "active") this.changeStage(runId, "git-operator", dispatchId);
    return dispatchId;
  }

  buildReviewPacket(runId: string, testResult?: ResultEnvelope, reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> }): DispatchPacket | undefined {
    const test = this.store.db.prepare("SELECT dispatch_id,state,result_json,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; state: string; result_json?: string; packet_json: string } | undefined;
    if (!test || test.state !== "completed" || !test.result_json) return undefined;
    const testPacket = JSON.parse(test.packet_json) as DispatchPacket;
    const testContext = testPacket.context as { implementation_commit?: string; implementation_committed?: boolean; changed_paths?: string[] };
    if (testContext.implementation_committed !== true) return undefined;
    const revisionSha = testContext.implementation_commit;
    if (!revisionSha || !/^[a-f0-9]{40}$/.test(revisionSha)) return undefined;
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string; base_commit?: string };
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) return undefined;
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (integrationHead !== revisionSha) return undefined;
    const revisionLine = execFileSync("git", ["-C", repository.project_path, "rev-list", "--parents", "-n", "1", revisionSha], { encoding: "utf8" }).trim().split(" ");
    const parent = revisionLine[1];
    const baseCommit = /^[a-f0-9]{40}$/.test(run.base_commit ?? "") ? run.base_commit! : parent ?? "0".repeat(40);
    const diffArgs = baseCommit === "0".repeat(40) ? ["-C", repository.project_path, "diff-tree", "--root", "--no-commit-id", "-p", revisionSha] : ["-C", repository.project_path, "diff", baseCommit, revisionSha];
    const committedDiff = redact(execFileSync("git", diffArgs, { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }));
    const gitChangedPaths = baseCommit === "0".repeat(40)
      ? execFileSync("git", ["-C", repository.project_path, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revisionSha], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
      : execFileSync("git", ["-C", repository.project_path, "diff", "--name-only", baseCommit, revisionSha], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const changedPaths = [...new Set(gitChangedPaths)];
    if (!changedPaths.length || !committedDiff.trim()) return undefined;
    const planningPaths = run.plan_id && run.revision ? ["spec.md", "plan.md", "tasks.md"].map((name) => `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/${name}`) : [];
    const existingPlanningPaths = planningPaths.filter((path) => {
      try { execFileSync("git", ["-C", repository.project_path, "cat-file", "-e", `${revisionSha}:${path}`], { stdio: "ignore" }); return true; }
      catch { return false; }
    });
    const documentDigest = sha256(existingPlanningPaths.map((path) => `${path}\0${execFileSync("git", ["-C", repository.project_path, "show", `${revisionSha}:${path}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })}`).join("\n"));
    const frozenTestResult = testResult ?? JSON.parse(test.result_json) as ResultEnvelope;
    const testedCommit = (frozenTestResult.payload as { testedCommit?: unknown }).testedCommit ?? testContext.implementation_commit;
    if (testedCommit !== revisionSha) return undefined;
    const testEvidenceDigest = sha256(stableJson(frozenTestResult));
    const diffDigest = sha256(committedDiff);
    const artifacts = this.store.db.prepare(`SELECT a.artifact_id,a.dispatch_id,a.kind,a.path,a.sha256,d.role
      FROM artifacts a JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND d.role IN ('coding','frontend-developer','backend-developer','git-operator','test')
      ORDER BY a.created_at,a.artifact_id`).all(runId) as Array<{ artifact_id: string; dispatch_id: string; kind: string; path: string; sha256: string; role: string }>;
    const evidenceDigest = sha256(stableJson({ test_dispatch_id: test.dispatch_id, test_evidence_digest: testEvidenceDigest, artifact_digests: artifacts.map((artifact) => artifact.sha256) }));
    const revisionDigest = sha256(stableJson({ plan_id: run.plan_id ?? null, revision: run.revision ?? null, base_commit: baseCommit, revision_sha: revisionSha, document_digest: documentDigest, diff_digest: diffDigest, evidence_digest: evidenceDigest }));
    return validatePacket(assembleReviewPacket({
      revisionSha, baseCommit, planId: run.plan_id ?? null, revision: run.revision ?? null, planDigest: run.plan_digest ?? null,
      changedPaths, planningPaths: existingPlanningPaths, documentDigest, committedDiff, diffDigest,
      testDispatchId: test.dispatch_id, testEvidence: frozenTestResult, testEvidenceDigest, testedCommit,
      artifacts, evidenceDigest, revisionDigest, ...(reissue ? { reissue } : {}),
    }), "code-reviewer");
  }

  private advancePlanning(runId: string, result: ResultEnvelope): void {
    const payload = result.payload as {
      stage: string;
      pending_questions: string[];
      decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string; requirement_ids?: string[]; acceptance_criteria?: string[] } | null;
      no_change?: { decision_id: string; conclusion: string; repository_evidence: Array<{ command: string; outcome: string }> };
    };
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; stage: string };
    const packet = JSON.parse(this.get(runId, result.dispatch_id, "planning").packet_json) as DispatchPacket;
    assertPlanningSubmissionTransition(run.stage, payload.stage, packet.context, payload.decision, payload.pending_questions);
    if (payload.stage === "no_change") {
      if (!payload.no_change) throw new ValidationError("planning no_change requires repository evidence and a decision receipt");
      const decision = this.store.db.prepare("SELECT status,choice,receipt_json FROM decisions WHERE run_id=? AND decision_id=?")
        .get(runId, payload.no_change.decision_id) as { status: string; choice?: string; receipt_json?: string } | undefined;
      if (!decision || decision.status !== "resolved" || decision.choice !== "verify_existing") {
        throw new ValidationError("planning no_change requires a resolved verify_existing decision receipt");
      }
      if (run.plan_id || run.revision) throw new ValidationError("planning no_change cannot complete a run with a bound revision");
      const sideEffects = {
        worktrees: (this.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count,
        operations: (this.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=?").get(runId) as { count: number }).count,
        git_dispatches: (this.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count,
      };
      if (sideEffects.worktrees || sideEffects.operations || sideEffects.git_dispatches) {
        throw new ValidationError("planning no_change cannot complete after implementation or Git side effects", sideEffects);
      }
      const decisionReceipt = JSON.parse(decision.receipt_json ?? "{}") as Record<string, unknown>;
      this.store.db.prepare("UPDATE runs SET stage='no_change',state='completed',updated_at=? WHERE run_id=?")
        .run(new Date().toISOString(), runId);
      this.store.event(runId, "planning.no_change_completed", {
        conclusion: payload.no_change.conclusion,
        repository_evidence: payload.no_change.repository_evidence,
        decision_receipt: decisionReceipt,
      });
      return;
    }
    if (run.plan_id && run.revision) {
      const revision = this.store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
      if (!revision) throw new ValidationError("bound planning revision not found");
      assertRevisionRunStage(revision.state, payload.stage);
    }
    const requirementDecisionCount = (this.store.db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE run_id=? AND decision_type='requirement'").get(runId) as { count: number }).count;
    const intent = planningSubmissionIntent(payload.stage, payload.pending_questions, payload.decision, requirementDecisionCount);
    const needsDecision = intent.needsDecision;
    this.store.db.prepare("UPDATE runs SET stage=?,state=?,updated_at=? WHERE run_id=?")
      .run(payload.stage, needsDecision ? "needs_decision" : "active", new Date().toISOString(), runId);
    this.store.event(runId, "planning.stage_changed", { stage: payload.stage });
    if (needsDecision) {
      if (!payload.decision) throw new ValidationError("planning pending question requires one matching decision");
      const mappings = intent.decisionType === "requirement" ? requirementClarificationMappings(payload.decision) : undefined;
      const decisionId = this.store.createDecision(runId, intent.question!, payload.decision.choices, payload.decision.recommendation, intent.decisionType!, result.dispatch_id, mappings);
      if (intent.decisionType === "requirement") {
        this.store.createPlanningClarification({
          runId,
          decisionId,
          source: "planning_dispatch",
          impact: payload.decision.choices,
          ...mappings!,
        });
      }
    } else if (payload.stage !== "ready") {
      this.continuePlanning(runId);
    }
  }

  continuePlanning(runId: string): string {
    const run = this.store.getRun(runId) as { profile: string; stage: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can continue planning");
    this.store.assertPlanningClarificationsResolved(runId);
    const pending = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (pending) throw new ValidationError("planning cannot continue with a pending decision");
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    return this.create(runId, "planning", planningContinuationPacket(run.stage), "planning");
  }

  resolvePlanningDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can resolve planning decisions");
    const existing = this.store.db.prepare("SELECT status,choice,receipt_json,decision_type,dispatch_id FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; decision_type: string; dispatch_id?: string } | undefined;
    if (existing?.status === "resolved") {
      const receipt = JSON.parse(existing.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (existing.choice === choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      if (existing.choice === choice && ((existing.decision_type === "task_split" && choice === "no_split") || (existing.decision_type === "task_preview" && choice === "approve"))) {
        return existing.dispatch_id ?? "";
      }
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      this.store.decide(runId, decisionId, choice, note);
      this.store.db.prepare(`UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=(
        SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state='needs_decision' ORDER BY created_at DESC LIMIT 1
      )`)
        .run(new Date().toISOString(), runId);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      const terminalDecision = existing?.decision_type === "task_split" && choice === "no_split"
        || existing?.decision_type === "task_preview" && choice === "approve";
      dispatchId = terminalDecision
        ? existing?.dispatch_id ?? ""
        : this.continuePlanning(runId);
      const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: terminalDecision ? null : dispatchId, successor_packet_digest: terminalDecision ? null : successor?.packet_digest ?? null }), decisionId);
    })();
    return dispatchId;
  }

  resolveDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string; state: string; stage: string; mode?: string; repo_id?: string; plan_id?: string; revision?: string };
    if (run.profile === "planning") return this.resolvePlanningDecision(runId, decisionId, choice, note);
    const existingDecision = this.store.db.prepare("SELECT status,choice,receipt_json,dispatch_id,decision_type FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; dispatch_id?: string; decision_type: string } | undefined;
    if (existingDecision?.status === "resolved") {
      const receipt = JSON.parse(existingDecision.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (choice === existingDecision.choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    const managedPlannedRecovery = isManagedPlannedRecovery(run.mode, existingDecision?.decision_type, choice);
    if (managedPlannedRecovery) {
      if (!run.repo_id || !run.plan_id || !run.revision || !existingDecision?.dispatch_id) throw new ValidationError("managed planned recovery requires a bound planned run and dispatch");
      const pendingOperation = this.store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1").get(runId) as { operation_id: string } | undefined;
      if (pendingOperation) throw new ValidationError(`managed planned recovery requires operation reconciliation: ${pendingOperation.operation_id}`);
      const worktrees = this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' ORDER BY created_at,worktree_id").all(runId) as Array<{ worktree_id: string }>;
      if (!worktrees.length) throw new ValidationError("managed planned recovery requires at least one active run-owned worktree");
      const conflicts = this.store.db.prepare(`SELECT run_id FROM runs WHERE repo_id=? AND plan_id=? AND revision=? AND run_id<>? AND state='failed'
        ORDER BY created_at,run_id`).all(run.repo_id, run.plan_id, run.revision, runId) as Array<{ run_id: string }>;
      let dispatchId = "";
      this.store.db.transaction(() => {
        const blocked = this.store.db.prepare("SELECT dispatch_id,role FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
          .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role } | undefined;
        if (!blocked || blocked.role !== "coding") throw new ValidationError("managed planned recovery requires a blocked Coding dispatch");
        this.store.decide(runId, decisionId, choice, note);
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
        dispatchId = this.insert(runId, "git-operator", validatePacket(managedCleanupPacket({
          worktreeIds: worktrees.map(({ worktree_id }) => worktree_id), decisionId, choice,
          conflictingRunIds: conflicts.map(({ run_id }) => run_id), planId: run.plan_id!, revision: run.revision!,
        }), "git-operator"), blocked.dispatch_id);
        this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND dispatch_id<>? AND state IN ('pending','claimed')")
          .run(new Date().toISOString(), runId, dispatchId);
        this.store.db.prepare("UPDATE runs SET state='active',stage='canceling',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        for (const conflict of conflicts) {
          this.store.db.prepare("UPDATE runs SET state='canceled',stage='reconciled',source_run_id=?,updated_at=? WHERE run_id=? AND state='failed'")
            .run(runId, new Date().toISOString(), conflict.run_id);
          this.store.event(conflict.run_id, "run.failed_start_reconciled", { source_run_id: runId, decision_id: decisionId, cleanup_dispatch_id: dispatchId });
        }
        this.store.event(runId, "run.reconciliation_requested", { decision_id: decisionId, cleanup_dispatch_id: dispatchId, conflicting_run_ids: conflicts.map(({ run_id }) => run_id), worktree_ids: worktrees.map(({ worktree_id }) => worktree_id) });
        const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
        const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
        this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
          .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null, conflicting_run_ids: conflicts.map(({ run_id }) => run_id) }), decisionId);
        this.changeStage(runId, "canceling", dispatchId);
      })();
      return dispatchId;
    }
    if (existingDecision?.decision_type === "active_run_recovery") {
      if (!existingDecision.dispatch_id) throw new ValidationError("active run recovery decision is not bound to its recovery dispatch");
      if (choice === "abort") {
        this.store.db.transaction(() => {
          this.store.decide(runId, decisionId, choice, note);
          this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
            .run(new Date().toISOString(), existingDecision.dispatch_id);
          this.store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?")
            .run(new Date().toISOString(), runId);
        })();
        return existingDecision.dispatch_id;
      }
      if (choice !== "retry") throw new ValidationError(`unsupported active run recovery choice: ${choice}`);
      const source = this.store.db.prepare(`SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for
        FROM dispatches WHERE run_id=? AND dispatch_id<>? AND state='completed'
        AND json_extract(packet_json,'$.context.phase') IS NOT 'resume_recovery'
        ORDER BY COALESCE(completed_at,created_at) DESC,created_at DESC LIMIT 1`)
        .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined;
      if (!source) throw new ValidationError("active run recovery has no durable stage dispatch to retry");
      const sourcePacket = JSON.parse(source.packet_json) as DispatchPacket;
      const authorityApplyDispatchId = source.role === "git-operator"
        && sourcePacket.context.phase === "continue_task_authority_conflict"
        && typeof sourcePacket.context.authority_apply_dispatch_id === "string"
        ? sourcePacket.context.authority_apply_dispatch_id
        : undefined;
      let replacementId = "";
      this.store.db.transaction(() => {
        this.store.decide(runId, decisionId, choice, note);
        const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
        const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), existingDecision.dispatch_id);
        this.store.db.prepare("UPDATE runs SET state='active',stage=?,updated_at=? WHERE run_id=?")
          .run(authorityApplyDispatchId ? "coding" : source.role, new Date().toISOString(), runId);
        replacementId = authorityApplyDispatchId
          ? this.ensureRecoveredTaskDeveloperDispatch(runId, authorityApplyDispatchId, true) ?? ""
          : this.recoveryReplacement(runId, source, resolvedDecision);
        if (!replacementId) throw new ValidationError("completed authority conflict receipt has no recoverable developer continuation");
        const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(replacementId) as { packet_digest?: string };
        this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
          .run(stableJson({ ...resolvedDecision, successor_dispatch_id: replacementId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
        this.store.event(runId, "run.recovery_stage_reissued", { decision_id: decisionId, source_dispatch_id: source.dispatch_id, successor_dispatch_id: replacementId });
      })();
      return replacementId;
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      if (!existingDecision?.dispatch_id) throw new ValidationError("decision is not bound to a dispatch");
      const blocked = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for,state FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
        .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string; state: string } | undefined;
      if (!blocked) throw new ValidationError("run has no dispatch waiting on this decision");
      this.store.decide(runId, decisionId, choice, note);
      const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
      this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      if (blocked.role === "code-reviewer" && choice === "pre_commit_then_refreeze") {
        dispatchId = this.ensurePreCommitDecisionContinuation(runId, decisionId, blocked.dispatch_id) ?? "";
        if (!dispatchId) throw new ValidationError("pre_commit_then_refreeze could not create a continuation");
        return;
      }
      let packet: DispatchPacket;
      if (choice === "reissue") {
        const reviewPacket = blocked.role === "code-reviewer"
          ? this.buildReviewPacket(runId, undefined, { decision_id: decisionId, dispatch_id: blocked.dispatch_id, resolved_decision: resolvedDecision })
          : undefined;
        if (blocked.role === "code-reviewer" && !reviewPacket) {
          throw new ValidationError("review reissue requires complete current integration and test evidence");
        }
        packet = reviewPacket ?? validatePacket(reissuePacket(blocked.role, decisionId, blocked.dispatch_id, resolvedDecision), blocked.role);
      } else {
        dispatchId = this.recoveryReplacement(runId, blocked, resolvedDecision);
        packet = JSON.parse((this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_json: string }).packet_json) as DispatchPacket;
      }
      if (choice === "reissue") dispatchId = this.insert(runId, blocked.role, packet, blocked.dispatch_id);
      const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...resolvedDecision, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
      this.changeStage(runId, blocked.role, dispatchId);
    })();
    return dispatchId;
  }

  private ensurePreCommitDecisionContinuation(runId: string, decisionId?: string, reviewDispatchId?: string): string | undefined {
    const decision = (decisionId
      ? this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND decision_id=? AND status='resolved' AND choice='pre_commit_then_refreeze'")
        .get(runId, decisionId)
      : this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='resolved' AND choice='pre_commit_then_refreeze' ORDER BY resolved_at DESC LIMIT 1")
        .get(runId)) as { decision_id: string; dispatch_id?: string; receipt_json: string } | undefined;
    if (!decision) return undefined;
    const sourceReviewId = reviewDispatchId ?? decision.dispatch_id;
    if (!sourceReviewId) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')
      AND json_extract(packet_json,'$.context.decision_id')=?
      AND json_extract(packet_json,'$.context.phase') IN ('pre_commit_implementation','pre_commit_scope_remediation')
      ORDER BY created_at DESC LIMIT 1`).get(runId, decision.decision_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;

    const run = this.store.getRun(runId) as { mode?: string; plan_id?: string; revision?: string; plan_digest?: string };
    const worktree = this.activeIntegrationWorktree(runId);
    if (!worktree) return undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.role,d.packet_json,d.completed_at FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer') AND d.state='completed'
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)
      ORDER BY d.completed_at DESC,d.created_at DESC`).all(runId) as Array<{ dispatch_id: string; role: Role; packet_json: string; completed_at?: string }>;
    if (!developers.length) return undefined;
    const relevantDevelopers = developers.filter((developer) => {
      try { return (JSON.parse(developer.packet_json) as DispatchPacket).context.worktree_id === worktree.worktree_id; }
      catch { return false; }
    });
    if (!relevantDevelopers.length) return undefined;
    const developerAllowedWritePaths = [...new Set(relevantDevelopers.flatMap((developer) => (JSON.parse(developer.packet_json) as DispatchPacket).allowed_write_paths))];
    const primaryDeveloper = relevantDevelopers[0]!;
    const primaryPacket = JSON.parse(primaryDeveloper.packet_json) as DispatchPacket;
    const explorerDispatchId = typeof primaryPacket.context.explorer_dispatch_id === "string"
      ? primaryPacket.context.explorer_dispatch_id
      : undefined;
    if (!explorerDispatchId) return undefined;
    const explorer = this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'")
      .get(runId, explorerDispatchId) as { result_json?: string } | undefined;
    if (!explorer?.result_json) return undefined;
    const authorizedPaths = (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    const implementationArtifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, primaryDeveloper.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const test = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    const testArtifact = test ? this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, test.dispatch_id) as { artifact_id: string; sha256: string } | undefined : undefined;
    if (!implementationArtifact || !test || !testArtifact) return undefined;

    const changedPaths = dirtyWorktreePaths(worktree.path);
    const blockedPaths = changedPaths.filter((path) => !pathMatchesScope(path, developerAllowedWritePaths));
    if (run.mode === "planned" && changedPaths.length && !blockedPaths.length) {
      new ScopeGate(this.store).check(runId, "pre_commit", changedPaths, worktree.worktree_id, {
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
      dispatchId = this.insert(runId, primaryDeveloper.role, validatePacket({
        objective: blockedPaths.length
          ? "Remediate the real dirty diff that falls outside the frozen developer write scope before commit."
          : "Restore the missing implementation dirty diff before pre-commit can continue.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Leave only implementation paths authorized by the frozen developer packet", "Return fresh implementation evidence before commit"],
        context: { ...commonContext, stage: primaryDeveloper.role, phase: "pre_commit_scope_remediation", blocked_changed_paths: blockedPaths },
      }, primaryDeveloper.role), sourceReviewId);
      this.changeStage(runId, primaryDeveloper.role, dispatchId);
    } else {
      const packet = validatePacket({
        objective: "Commit the real dirty implementation diff, then refreeze tests and formal review on the new commit.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Commit only the real dirty paths within the frozen developer write scope", "Return the new implementation commit and committed paths"],
        context: { ...commonContext, stage: "git-operator", phase: "pre_commit_implementation", scope_digest: sha256(changedPaths.join("\n")) },
      }, "git-operator");
      assertExplorerAuthorization(this.store, runId, "git-operator", packet);
      dispatchId = this.insert(runId, "git-operator", packet, sourceReviewId);
      this.changeStage(runId, "git-operator", dispatchId);
    }
    const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
    const receipt = JSON.parse(decision.receipt_json) as Record<string, unknown>;
    this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
      .run(stableJson({ ...receipt, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decision.decision_id);
    return dispatchId;
  }

  private ensureCodingCommitContinuation(runId: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; state: string; mode?: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const preCommit = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' ORDER BY event_id DESC LIMIT 1")
      .get(runId) as { payload_json: string } | undefined;
    if (!preCommit && run.mode !== "planned") return undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.state,d.packet_json,d.result_json FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer')
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)`).all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>;
    if (!developers.length || developers.some((developer) => developer.state !== "completed" || !developer.result_json)) return undefined;
    const developerWorktreeIds = developers.map((developer) => {
      try { return (JSON.parse(developer.packet_json) as DispatchPacket).context.worktree_id; }
      catch { return undefined; }
    });
    if (developerWorktreeIds.some((value) => typeof value !== "string" || !value)) return undefined;
    const worktreeIds = [...new Set(developerWorktreeIds as string[])];
    const activeTaskWorktrees = new Set((this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%'").all(runId) as Array<{ worktree_id: string }>).map((worktree) => worktree.worktree_id));
    if (run.mode === "planned") {
      const tasks = this.plannedTaskRows(runId);
      if (tasks.length === 1 && tasks[0]!.worktree_id) activeTaskWorktrees.add(tasks[0]!.worktree_id);
    }
    if (worktreeIds.some((worktreeId) => !activeTaskWorktrees.has(worktreeId))) return undefined;
    const committed = new Set((this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>).flatMap((operation) => {
      try {
        const worktreeId = (JSON.parse(operation.evidence_json ?? "{}") as { worktree_id?: unknown }).worktree_id;
        return typeof worktreeId === "string" ? [worktreeId] : [];
      } catch { return []; }
    }));
    const uncommittedWorktreeIds = worktreeIds.filter((worktreeId) => !committed.has(worktreeId));
    if (!uncommittedWorktreeIds.length) return undefined;
    if (run.mode === "planned") {
      const tasks = this.plannedTaskRows(runId);
      const untested = tasks.filter((task) => task.worktree_id && uncommittedWorktreeIds.includes(task.worktree_id) && task.state !== "tested");
      if (untested.length) return undefined;
    }
    const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) return undefined;
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND replacement_for=? AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1")
      .get(runId, coordinator.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
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
        const developerPacket = JSON.parse(developer.packet_json) as DispatchPacket;
        const developerResult = JSON.parse(developer.result_json!) as ResultEnvelope;
        const modifiedPaths = [...new Set((developerResult.payload as { modified_paths?: string[] }).modified_paths ?? [])].sort();
        const taskId = String(developerPacket.context.task_id);
        const worktreeId = String(developerPacket.context.worktree_id);
        const frozenTask = this.plannedTaskRows(runId).find((task) => task.task_id === taskId);
        if (!frozenTask || frozenTask.developer_dispatch_id !== developer.dispatch_id || frozenTask.worktree_id !== worktreeId) {
          throw new ValidationError("planned developer result does not match frozen task/dispatch/worktree identity", {
            offending_task_id: taskId,
            offending_dispatch_id: developer.dispatch_id,
            offending_worktree_id: worktreeId,
            frozen_developer_dispatch_id: frozenTask?.developer_dispatch_id ?? null,
            frozen_worktree_id: frozenTask?.worktree_id ?? null,
          });
        }
        const frozenTaskWritePaths = this.frozenTaskWritePaths(runId, taskId);
        const preCommitRow = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
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
            const packet = JSON.parse(developer.packet_json) as DispatchPacket;
            return packet.context.worktree_id === worktreeId;
          } catch { return false; }
        });
        const scopes = [...new Set(worktreeDevelopers.flatMap((developer) => {
          try { return ((JSON.parse(developer.result_json!) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []; }
          catch { return []; }
        }))].sort();
        if (!scopes.length) throw new ValidationError("planned pre_commit scope requires actual developer modified_paths");
        new ScopeGate(this.store).assertPreCommit(runId, scopes, worktreeId);
        const scopeRow = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
          .get(runId, worktreeId) as { payload_json: string };
        plannedScopeDigests.push({ worktree_id: worktreeId, digest: (JSON.parse(scopeRow.payload_json) as { digest: string }).digest });
      }
    }
    const scope = preCommit ? JSON.parse(preCommit.payload_json) as { digest?: unknown } : undefined;
    const packet = validatePacket({
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
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, coordinator.dispatch_id);
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureContinueTestingContinuation(runId: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; state: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const test = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (test) return test.dispatch_id;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='continue_testing' AND state IN ('pending','claimed','completed')
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const snapshot = this.implementationSnapshot(runId);
    if (!snapshot) return undefined;
    const packet = validatePacket(buildContinueTestingPacket(snapshot), "coding");
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, snapshot.coordinatorDispatchId);
    const orphanedStaging = this.store.db.prepare(`SELECT staging_id FROM staging_entries
      WHERE run_id=? AND dispatch_id=? AND kind='dispatch-packet' AND state IN ('draft','ready')`).all(runId, snapshot.coordinatorDispatchId) as Array<{ staging_id: string }>;
    for (const entry of orphanedStaging) {
      this.store.cancelStagingEntry(entry.staging_id, { runId, dispatchId: snapshot.coordinatorDispatchId, role: "coding", kind: "dispatch-packet" }, `superseded by ${dispatchId}`);
    }
    this.store.event(runId, "coding.continue_testing_created", { dispatchId, replacement_for: snapshot.coordinatorDispatchId, canceled_staging_ids: orphanedStaging.map(({ staging_id }) => staging_id) });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureActiveLivenessDecision(runId: string): void {
    const run = this.store.getRun(runId) as { profile: Role; state: string; stage: string };
    const pendingDispatch = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId);
    const pendingDecision = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    const pendingOperation = this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='pending'").get(runId);
    const intent = livenessRecoveryIntent(run.profile, run.state, run.stage, Boolean(pendingDispatch || pendingDecision || pendingOperation));
    if (!intent) return;
    const dispatchId = this.insert(runId, run.profile, validatePacket(intent.packet, run.profile));
    this.store.db.prepare("UPDATE dispatches SET state='needs_decision' WHERE dispatch_id=?").run(dispatchId);
    this.store.createDecision(runId, intent.decision.question, intent.decision.choices, intent.decision.recommendation, intent.decision.type, dispatchId);
    this.store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    this.store.event(runId, "run.recovery_decision_created", { dispatch_id: dispatchId, stage: run.stage });
  }

  resume(runId: string): RunResumeResult {
    this.store.db.transaction(() => {
      let run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      const pendingDecision = this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; dispatch_id?: string; receipt_json?: string } | undefined;
      const pendingOperation = this.store.db.prepare("SELECT operation_id,kind,evidence_json FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1")
        .get(runId) as { operation_id: string; kind: string; evidence_json?: string } | undefined;
      if (pendingOperation) {
        const evidence = JSON.parse(pendingOperation.evidence_json ?? "{}") as { state?: string; conflict_paths?: unknown[] };
        const claimed = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        const recoverableConflict = run.state === "failed" && pendingOperation.kind === "git.sync"
          && evidence.state === "conflicted" && Boolean(evidence.conflict_paths?.length) && claimed;
        if (!recoverableConflict) return;
        this.store.db.prepare("UPDATE runs SET state='active',stage='git-operator',updated_at=? WHERE run_id=?")
          .run(new Date().toISOString(), runId);
        this.store.event(runId, "run.git_conflict_recovery_activated", {
          operation_id: pendingOperation.operation_id,
          dispatch_id: claimed.dispatch_id,
          conflict_paths: evidence.conflict_paths,
        });
        run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      if (run.profile === "coding" && run.state === "frozen" && run.stage === "test") {
        const driftRow = this.store.db.prepare("SELECT event_id,payload_json,created_at FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift' ORDER BY event_id DESC LIMIT 1")
          .get(runId) as { event_id: number; payload_json: string; created_at: string } | undefined;
        const eventsAfterDrift = driftRow ? this.store.db.prepare("SELECT type FROM run_events WHERE run_id=? AND event_id>? AND type NOT LIKE 'command.%' ORDER BY event_id")
          .all(runId, driftRow.event_id) as Array<{ type: string }> : [];
        const drift = driftRow && eventsAfterDrift.every(({ type }) => type === "staging.validation_failed") ? JSON.parse(driftRow.payload_json) as {
          offending_test_dispatch_id?: string;
          offending_worktree_id?: string;
          original_snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null;
          snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null;
        } : undefined;
        const pendingDispatches = this.store.db.prepare("SELECT dispatch_id,role FROM dispatches WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at")
          .all(runId) as Array<{ dispatch_id: string; role: string }>;
        const laterOperation = driftRow ? this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND created_at>? LIMIT 1").get(runId, driftRow.created_at) : undefined;
        const worktree = drift?.offending_worktree_id
          ? this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, drift.offending_worktree_id) as { path: string } | undefined
          : undefined;
        const currentSnapshot = worktree ? plannedWorktreeSnapshot(worktree.path) : null;
        const driftScopeRow = drift?.offending_worktree_id ? this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
          .get(runId, drift.offending_worktree_id) as { payload_json: string } | undefined : undefined;
        const driftScopeSnapshot = driftScopeRow
          ? (JSON.parse(driftScopeRow.payload_json) as { snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null }).snapshot
          : undefined;
        const driftExpectedSnapshot = driftScopeSnapshot ?? drift?.original_snapshot ?? null;
        const allTasks = this.store.runTasks(runId);
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
        const recoveryRun = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string };
        const recoveryRevision = recoveryRun.plan_id && recoveryRun.revision
          ? this.store.db.prepare("SELECT digest,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
            .get(recoveryRun.repo_id, recoveryRun.plan_id, recoveryRun.revision) as { digest?: string; plan_commit?: string } | undefined
          : undefined;
        const recoveryRepository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(recoveryRun.repo_id) as { project_path: string } | undefined;
        for (const task of tasks) {
          const developer = task.developer_dispatch_id ? this.store.db.prepare("SELECT packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer') AND state='completed'")
            .get(runId, task.developer_dispatch_id) as { packet_json: string; result_json?: string } | undefined : undefined;
          const packet = developer ? JSON.parse(developer.packet_json) as DispatchPacket : undefined;
          const actual = developer?.result_json
            ? [...new Set((((JSON.parse(developer.result_json) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []))].sort()
            : [];
          const scopeRow = task.worktree_id ? this.store.db.prepare("SELECT payload_json,created_at FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
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
            if (task.write_paths_json) sourceValid = true;
            else {
              const source = recoveryRevision?.plan_commit && recoveryRepository
                ? execFileSync("git", ["-C", recoveryRepository.project_path, "show", `${recoveryRevision.plan_commit}:${task.source_path}`], { encoding: "utf8" })
                : "";
              sourceValid = Boolean(recoveryRevision?.digest && recoveryRevision.digest === recoveryRun.plan_digest
                && /^[a-f0-9]{40}$/.test(recoveryRevision.plan_commit ?? "") && sha256(source) === task.source_digest);
            }
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
        const priorDrift = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift' LIMIT 1").get(runId);
        const pendingTest = pendingDispatches.length === 1 && pendingDispatches[0]!.role === "test" ? pendingDispatches[0] : undefined;
        const pendingTestPacket = pendingTest ? this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, pendingTest.dispatch_id) as { packet_json: string } : undefined;
        const testContext = pendingTestPacket ? (JSON.parse(pendingTestPacket.packet_json) as DispatchPacket).context : {};
        const currentTask = allTasks.find((task) => task.state !== "integrated");
        const currentWorktree = currentTask?.worktree_id
          ? this.store.db.prepare("SELECT path,base_commit FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, currentTask.worktree_id) as { path: string; base_commit: string } | undefined
          : undefined;
        const legacySnapshot = currentWorktree ? plannedWorktreeSnapshot(currentWorktree.path) : null;
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
          const commit = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
            .get(runId, task.worktree_id) as { evidence_json?: string } | undefined;
          const merge = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' AND json_extract(evidence_json,'$.task_worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
            .get(runId, task.worktree_id) as { evidence_json?: string } | undefined;
          const commitEvidence = JSON.parse(commit?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
          const mergeEvidence = JSON.parse(merge?.evidence_json ?? "{}") as { commit?: string };
          legacyValid &&= Boolean(commitEvidence.commit && mergeEvidence.commit
            && stableJson([...(commitEvidence.paths ?? [])].sort()) === stableJson(actualByTask.get(task.task_id) ?? [])
            && (!task.implementation_commit || task.implementation_commit === commitEvidence.commit)
            && (!task.integration_commit || task.integration_commit === mergeEvidence.commit));
        }
        const currentScopeCreated = currentTask ? scopeCreatedByTask.get(currentTask.task_id) : undefined;
        const laterGitOperation = currentScopeCreated ? this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND kind LIKE 'git.%' AND created_at>? LIMIT 1").get(runId, currentScopeCreated) : undefined;
        legacyValid &&= Boolean(currentScopeCreated && !laterGitOperation);
        const recovered = valid || legacyValid;
        if (recovered) {
          const updateLegacy = this.store.db.prepare("UPDATE run_tasks SET write_paths_json=?,updated_at=? WHERE run_id=? AND task_id=? AND write_paths_json IS NULL");
          const now = new Date().toISOString();
          for (const scope of restoredScopes) updateLegacy.run(stableJson(scope.write_paths), now, runId, scope.task_id);
          if (legacyValid && currentTask && legacySnapshot) {
            const currentScope = restoredScopes.find(({ task_id }) => task_id === currentTask.task_id)!;
            this.store.event(runId, "scope.pre_commit_snapshot_recovered", {
              original_scope_digest: currentScope.digest,
              original_scope_paths: currentScope.paths,
              task_id: currentTask.task_id,
              developer_dispatch_id: currentTask.developer_dispatch_id,
              worktree_id: currentTask.worktree_id,
              snapshot: legacySnapshot,
            });
          }
          this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
          this.store.event(runId, valid ? "scope.pre_commit_restored" : "scope.pre_commit_legacy_restored", {
            test_dispatch_id: drift?.offending_test_dispatch_id ?? pendingTest!.dispatch_id,
            worktree_snapshot: valid ? currentSnapshot : legacySnapshot,
            scopes: restoredScopes,
            ...(legacyValid ? {
              evidence: "immutable scopes + developer results + integrated operation chains + current tested worktree snapshot",
              frozen_task_scope_status: "unavailable_or_ambiguous",
              recovery_authority: "existing immutable pre_commit actual paths",
            } : {}),
          });
          run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
        }
      }
      if (run.state === "frozen") return;
      if (run.profile === "coding" && run.state === "failed" && !pendingDecision && this.resumeFailedTestRepair(runId)) {
        run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      if (run.profile === "coding") {
        this.reconcileReview(runId);
        this.reconcilePlannedTaskStates(runId);
        this.handlePrematurePlannedTest(runId);
        run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      const retryableDispatch = run.state === "retryable_failure"
        ? this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined
        : undefined;
      const mergePartialEffect = retryableDispatch ? this.plannedMergePartialEffect(runId, retryableDispatch) : undefined;
      if (pendingDecision) {
        if (retryableDispatch && !pendingDecision.dispatch_id) {
          const receipt = { ...JSON.parse(pendingDecision.receipt_json ?? "{}"), dispatch_id: retryableDispatch.dispatch_id };
          this.store.db.prepare("UPDATE decisions SET dispatch_id=?,receipt_json=? WHERE decision_id=?")
            .run(retryableDispatch.dispatch_id, stableJson(receipt), pendingDecision.decision_id);
          this.store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        }
        return;
      }
      if (!retryableDispatch) {
        const pendingTest = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        if (pendingTest && run.stage !== "test") this.changeStage(runId, "test", pendingTest.dispatch_id);
        const pendingDispatch = this.store.db.prepare(`SELECT dispatch_id,role,packet_json FROM dispatches
          WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string; role: Role; packet_json: string } | undefined;
        if (pendingDispatch && run.profile === "coding") {
          const pendingPacket = JSON.parse(pendingDispatch.packet_json) as DispatchPacket;
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
            this.store.db.transaction(() => {
              this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=? AND state IN ('pending','claimed')")
                .run(new Date().toISOString(), pendingDispatch.dispatch_id);
              this.store.db.prepare("UPDATE runs SET state='active',stage='coding',updated_at=? WHERE run_id=?")
                .run(new Date().toISOString(), runId);
              if (!this.ensureRecoveredTaskDeveloperDispatch(runId, authorityApplyDispatchId, true)) {
                throw new ValidationError("completed authority conflict receipt has no recoverable developer continuation");
              }
            })();
            return;
          }
          if (pendingDispatch.role === "git-operator" && pendingPacket.context.phase === "prepare_implementation_worktree"
            && typeof pendingPacket.context.task_id === "string" && this.pendingPlannedTaskRecovery(runId, pendingPacket.context.task_id)) {
            this.ensureNextPlannedTaskPrepare(runId);
            return;
          }
        }
        if (pendingDispatch) return;
        if (run.profile === "coding" && (this.ensurePlannedTaskDeveloperDispatch(runId) || this.ensurePlannedTaskContinuation(runId) || this.ensureNextPlannedTaskPrepare(runId))) return;
      }
      const retryableHasNoSideEffects = retryableResultHasNoSideEffects(retryableDispatch?.result_json);
      if (retryableDispatch && retryableHasNoSideEffects && !mergePartialEffect) {
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), retryableDispatch.dispatch_id);
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        if (!this.plannedOwnershipRecovery(runId, retryableDispatch)) this.recoveryReplacement(runId, retryableDispatch);
        return;
      }
      if (run.state === "retryable_failure") return;
      if (run.state === "needs_decision") {
        const blocked = this.store.db.prepare("SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND state='needs_decision' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string } | undefined;
        if (blocked) {
          this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
          if (run.profile !== "planning") this.insert(runId, blocked.role, JSON.parse(blocked.packet_json) as DispatchPacket);
        }
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      if (run.state !== "active" && run.state !== "needs_decision") return;
      if (run.profile === "planning" && run.stage !== "ready" && run.stage !== "file-explorer") this.continuePlanning(runId);
      if (run.profile === "coding" && run.state === "active") {
        const commitContinuation = this.ensurePreCommitDecisionContinuation(runId) ?? this.ensureCodingCommitContinuation(runId);
        if (!commitContinuation) this.ensureContinueTestingContinuation(runId);
      }
      this.ensureActiveLivenessDecision(runId);
    })();
    const resumedRun = this.store.getRun(runId) as Record<string, unknown> & { profile: Role; state: string };
    const blockedRetryable = resumedRun.state === "retryable_failure"
      ? this.store.db.prepare("SELECT dispatch_id,role,packet_json,result_json FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string; role: Role; packet_json: string; result_json?: string } | undefined
      : undefined;
    let recovery: RunResumeResult["recovery"] = null;
    if (blockedRetryable?.result_json) {
      const intent = reconciliationIntent(blockedRetryable.result_json, Boolean(this.plannedMergePartialEffect(runId, blockedRetryable)));
      if (intent) recovery = {
        state: "action_required", dispatch_id: blockedRetryable.dispatch_id, side_effect_state: intent.sideEffectState,
        next_command: intent.sideEffectState === "completed"
          ? `ai-team dispatch reconcile --run-id ${runId} --dispatch-id ${blockedRetryable.dispatch_id} --role ${blockedRetryable.role} --actor-role ${resumedRun.profile} --reason "reconcile confirmed completed side effect"`
          : null,
      };
    }
    if (!recovery) {
      const operation = this.store.db.prepare("SELECT operation_id,kind,request_json,evidence_json FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1")
        .get(runId) as { operation_id: string; kind: string; request_json: string; evidence_json?: string } | undefined;
      const claimed = operation ? this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state='claimed' ORDER BY claimed_at DESC LIMIT 1")
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
      pending_dispatches: this.store.db.prepare("SELECT dispatch_id,role,state FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").all(runId) as RunResumeResult["pending_dispatches"],
      pending_decision: (this.store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").get(runId) as Record<string, unknown> | undefined) ?? null,
      pending_operations: this.store.db.prepare("SELECT operation_id,kind,state FROM operations WHERE run_id=? AND state='pending'").all(runId) as RunResumeResult["pending_operations"],
      last_event: (this.store.db.prepare("SELECT type,payload_json,created_at FROM run_events WHERE run_id=? AND type NOT LIKE 'command.%' ORDER BY event_id DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined) ?? null,
      recovery,
      ...(() => {
        const projection = recoveryProjection(this.store, runId);
        return { timeline_tail: projection.timeline.slice(-20), next_actions: projection.next_actions, next_action: projection.next_action };
      })(),
    };
  }

  private artifactPath(runId: string, dispatchId: string): string { return join(this.store.paths.artifacts, runId, dispatchId, "result.json"); }

  async exportTemplate(runId: string, dispatchId: string, role: Role, path: string): Promise<void> {
    await writeJson(path, this.template(runId, dispatchId, role));
  }

  assertCommandAllowed(role: Role, command: string): void {
    if (!ROLE_MANIFEST[role].commands.some((allowed) => allowed === command || allowed.endsWith("*") && command.startsWith(allowed.slice(0, -1)))) {
      throw new ValidationError(`${role} is not allowed to run ${command}`);
    }
  }
}
