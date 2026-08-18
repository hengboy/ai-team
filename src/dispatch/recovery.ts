export const retryableResultHasNoSideEffects = (resultJson: string | undefined): boolean => {
  if (!resultJson) return false;
  try {
    const result = JSON.parse(resultJson) as { status?: string; side_effect_state?: string };
    return result.status === "retryable_failure" && result.side_effect_state === "none";
  } catch {
    return false;
  }
};

export const livenessRecoveryIntent = (profile: string, state: string, stage: string, hasDurableContinuation: boolean) => {
  if (state !== "active" || hasDurableContinuation) return undefined;
  return {
    packet: {
      objective: `Recover the active ${stage} stage that has no durable continuation.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Choose whether to retry the frozen stage or stop the run"],
      context: { stage, phase: "resume_recovery" },
    },
    decision: {
      question: "The active run has no pending continuation. How should it recover?",
      choices: [
        { id: "retry", label: "Retry stage", impact: "Reissue the frozen stage from its current evidence" },
        { id: "abort", label: "Abort run", impact: "Stop this run without creating more work" },
      ],
      recommendation: "retry",
      type: "active_run_recovery",
    },
    profile,
  };
};

export const isManagedPlannedRecovery = (mode: string | undefined, decisionType: string | undefined, choice: string): boolean =>
  mode === "planned" && (decisionType === "planned_run_binding" && choice === "repair-recreate"
    || decisionType === "planned_run_recovery_gap" && choice === "managed-reconcile");

export const managedCleanupPacket = (input: {
  worktreeIds: string[];
  decisionId: string;
  choice: string;
  conflictingRunIds: string[];
  planId: string;
  revision: string;
}) => ({
  objective: "Clean every obsolete worktree owned by the anomalous planned run before recreating it.",
  allowed_read_paths: [],
  allowed_write_paths: [],
  acceptance_criteria: ["Remove only clean worktrees owned by the source run", "Release plan and obsolete task branches", "Preserve reconciliation events for every failed replacement run"],
  context: {
    stage: "git-operator", phase: "cancel_cleanup", worktree_ids: input.worktreeIds,
    reconciliation: {
      decision_id: input.decisionId, choice: input.choice, conflicting_run_ids: input.conflictingRunIds,
      restart: { plan_id: input.planId, revision: input.revision },
    },
  },
});

export const reissuePacket = (role: string, decisionId: string, dispatchId: string, resolvedDecision: Record<string, unknown>) => ({
  objective: `Reissue the ${role} stage after resolving decision ${decisionId}.`,
  allowed_read_paths: [],
  allowed_write_paths: [],
  acceptance_criteria: ["Use the resolved decision", "Return fresh evidence for the current run state"],
  context: { stage: role, resolved_decision: resolvedDecision, reissue: { decision_id: decisionId, dispatch_id: dispatchId } },
});

export const reconciliationIntent = (resultJson: string | undefined, hasCompletedPartialEffect: boolean) => {
  if (!resultJson) return undefined;
  try {
    const result = JSON.parse(resultJson) as { side_effect_state?: "completed" | "unknown" };
    const sideEffectState = hasCompletedPartialEffect ? "completed" : result.side_effect_state;
    return sideEffectState === "completed" || sideEffectState === "unknown" ? { sideEffectState } : undefined;
  } catch {
    return undefined;
  }
};
