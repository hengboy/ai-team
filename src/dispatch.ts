import type { Role } from "./constants.js";
import type { ResultEnvelope } from "./contracts.js";
import type { ReviewFinding } from "./review.js";
import type { StateStore } from "./state.js";
import { dispatchOperations } from "./dispatch/coordinator.js";
import type { DispatchBundle, DispatchContinuation, DispatchPacket, DispatchSubmission, MergeWorktreeBindings, ReplacementResult, RunResumeResult } from "./dispatch/store.js";
export { dispatchPacketSchema, dispatchPacketTemplate } from "./dispatch/store.js";
export type { DispatchBundle, DispatchContinuation, DispatchPacket, DispatchSubmission, MergeWorktreeBindings, RunResumeResult } from "./dispatch/store.js";
export class DispatchService {
  constructor(readonly store: StateStore) {}
  create(runId: string, role: Role, packet: DispatchPacket, actorRole?: Role, actorDispatchId?: string): string { return dispatchOperations.create!(this.store, dispatchOperations, runId, role, packet, actorRole, actorDispatchId); }

  createPlanningCommit(runId: string, packet: DispatchPacket): string { return dispatchOperations.createPlanningCommit!(this.store, dispatchOperations, runId, packet); }

  mergeWorktreeBindings(runId: string, dispatchId?: string): MergeWorktreeBindings { return dispatchOperations.mergeWorktreeBindings!(this.store, dispatchOperations, runId, dispatchId); }

  assertMergeWorktreeBindings(runId: string, dispatchId: string, integrationId: string, taskId: string): MergeWorktreeBindings & { task_id: string; task_worktree_id: string } { return dispatchOperations.assertMergeWorktreeBindings!(this.store, dispatchOperations, runId, dispatchId, integrationId, taskId); }

  claim(runId: string, dispatchId: string, role: Role): { reused: boolean; packet: DispatchPacket } { return dispatchOperations.claim!(this.store, dispatchOperations, runId, dispatchId, role); }

  claimBundle(runId: string, dispatchId: string, role: Role): DispatchBundle { return dispatchOperations.claimBundle!(this.store, dispatchOperations, runId, dispatchId, role); }

  cancel(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): { action: "canceled"; reused: boolean } { return dispatchOperations.cancel!(this.store, dispatchOperations, runId, dispatchId, role, actorRole, reason); }

  reissue(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reissued"> { return dispatchOperations.reissue!(this.store, dispatchOperations, runId, dispatchId, role, actorRole, reason); }

  supersede(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, packet: DispatchPacket): ReplacementResult<"superseded"> { return dispatchOperations.supersede!(this.store, dispatchOperations, runId, dispatchId, role, actorRole, reason, packet); }

  reconcile(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } { return dispatchOperations.reconcile!(this.store, dispatchOperations, runId, dispatchId, role, actorRole, reason); }

  finalizationContext(runId: string, dispatchId: string, requiredState: "claimed" | "completed" = "claimed"): {
    barrier_id: string;
    revision_sha: string;
    integration_worktree_id: string;
  } { return dispatchOperations.finalizationContext!(this.store, dispatchOperations, runId, dispatchId, requiredState); }

  assertFinalizingCleanup(runId: string, dispatchId: string): void { return dispatchOperations.assertFinalizingCleanup!(this.store, dispatchOperations, runId, dispatchId); }

  verifyFinalization(runId: string, dispatchId: string, allowClaimed = false): Record<string, unknown> { return dispatchOperations.verifyFinalization!(this.store, dispatchOperations, runId, dispatchId, allowClaimed); }

  prompt(runId: string, dispatchId: string, role: Role): string { return dispatchOperations.prompt!(this.store, dispatchOperations, runId, dispatchId, role); }

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
  }): { dispatch_id: string; reused: boolean } { return dispatchOperations.createAuthorityConflictContinuation!(this.store, dispatchOperations, input); }

  schema(runId: string, dispatchId: string, role: Role): unknown { return dispatchOperations.schema!(this.store, dispatchOperations, runId, dispatchId, role); }

  template(runId: string, dispatchId: string, role: Role): ResultEnvelope { return dispatchOperations.template!(this.store, dispatchOperations, runId, dispatchId, role); }

  packetSchema(runId: string, dispatchId: string, role: Role): unknown { return dispatchOperations.packetSchema!(this.store, dispatchOperations, runId, dispatchId, role); }

  packetTemplate(runId: string, dispatchId: string, role: Role): DispatchPacket { return dispatchOperations.packetTemplate!(this.store, dispatchOperations, runId, dispatchId, role); }

  assertClaimed(runId: string, dispatchId: string, role: Role): void { return dispatchOperations.assertClaimed!(this.store, dispatchOperations, runId, dispatchId, role); }

  assertPlanningCommitClaimed(runId: string, dispatchId: string, planId: string, revision: string): void { return dispatchOperations.assertPlanningCommitClaimed!(this.store, dispatchOperations, runId, dispatchId, planId, revision); }

  async validateFile(runId: string, dispatchId: string, role: Role, path: string): Promise<ResultEnvelope> { return dispatchOperations.validateFile!(this.store, dispatchOperations, runId, dispatchId, role, path); }

  validateValue(runId: string, dispatchId: string, role: Role, value: unknown): ResultEnvelope { return dispatchOperations.validateValue!(this.store, dispatchOperations, runId, dispatchId, role, value); }

  async submit(runId: string, dispatchId: string, role: Role, path: string): Promise<DispatchSubmission> { return dispatchOperations.submit!(this.store, dispatchOperations, runId, dispatchId, role, path); }

  async submitStaging(runId: string, dispatchId: string, role: Role, stagingId: string): Promise<DispatchSubmission & {
    staging: { staging_id: string; state: string; content_digest: string | null };
  }> { return dispatchOperations.submitStaging!(this.store, dispatchOperations, runId, dispatchId, role, stagingId); }

  async submitValue(runId: string, dispatchId: string, role: Role, value: unknown, source?: string): Promise<DispatchSubmission> { return dispatchOperations.submitValue!(this.store, dispatchOperations, runId, dispatchId, role, value, source); }

  continuation(runId: string): DispatchContinuation { return dispatchOperations.continuation!(this.store, dispatchOperations, runId); }

  plannedTaskRows(runId: string): ReturnType<StateStore["runTasks"]> { return dispatchOperations.plannedTaskRows!(this.store, dispatchOperations, runId); }

  testCommandSnapshot(runId: string, worktreePath: string, explorerDispatchId: string): {
    commands: string[];
    provenance: { explorer_dispatch_id: string; plan_id: string | null; revision: string | null; repo_id: string };
  } { return dispatchOperations.testCommandSnapshot!(this.store, dispatchOperations, runId, worktreePath, explorerDispatchId); }

  runShowProjection(runId: string): {
    continuation: DispatchContinuation;
    planning_clarifications: Array<Record<string, unknown>>;
    pending_dependencies: Array<{ dispatch_id: string; depends_on: string[] }>;
    suggested_commands: string[];
  } { return dispatchOperations.runShowProjection!(this.store, dispatchOperations, runId); }

  ensureGitPrepareDispatch(runId: string, target: "integration" | "implementation", explorerDispatchId?: string): string { return dispatchOperations.ensureGitPrepareDispatch!(this.store, dispatchOperations, runId, target, explorerDispatchId); }

  reconcileReview(runId: string, barrierId?: string): Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> { return dispatchOperations.reconcileReview!(this.store, dispatchOperations, runId, barrierId); }

  buildReviewPacket(runId: string, testResult?: ResultEnvelope, reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> }): DispatchPacket | undefined { return dispatchOperations.buildReviewPacket!(this.store, dispatchOperations, runId, testResult, reissue); }

  continuePlanning(runId: string): string { return dispatchOperations.continuePlanning!(this.store, dispatchOperations, runId); }

  resolvePlanningDecision(runId: string, decisionId: string, choice: string, note?: string): string { return dispatchOperations.resolvePlanningDecision!(this.store, dispatchOperations, runId, decisionId, choice, note); }

  resolveDecision(runId: string, decisionId: string, choice: string, note?: string): string { return dispatchOperations.resolveDecision!(this.store, dispatchOperations, runId, decisionId, choice, note); }

  resume(runId: string): RunResumeResult { return dispatchOperations.resume!(this.store, dispatchOperations, runId); }

  async exportTemplate(runId: string, dispatchId: string, role: Role, path: string): Promise<void> { return dispatchOperations.exportTemplate!(this.store, dispatchOperations, runId, dispatchId, role, path); }

  assertCommandAllowed(role: Role, command: string): void { return dispatchOperations.assertCommandAllowed!(this.store, dispatchOperations, role, command); }
}
