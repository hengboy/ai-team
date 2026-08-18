export interface ImplementationSnapshot {
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
  testCommandProvenance: {
    explorer_dispatch_id: string;
    plan_id: string | null;
    revision: string | null;
    repo_id: string;
  };
}

export const buildTestPacket = (snapshot: ImplementationSnapshot, coordinatorDispatchId?: string) => ({
  objective: `Independently verify implementation commit ${snapshot.implementationCommit}.`,
  allowed_read_paths: snapshot.authorizedPaths,
  allowed_write_paths: [],
  acceptance_criteria: ["Run every frozen test command", "Bind evidence to the implementation commit"],
  context: {
    stage: "test",
    ...(snapshot.explorerDispatchId ? { explorer_dispatch_id: snapshot.explorerDispatchId } : {}),
    plan_id: snapshot.planId, revision: snapshot.revision, plan_digest: snapshot.planDigest,
    worktree_id: snapshot.worktreeId, worktree_path: snapshot.worktreePath, integration_worktree_id: snapshot.worktreeId,
    implementation_dispatch_id: snapshot.implementationDispatchId, implementation_artifact: snapshot.implementationArtifact,
    implementation_artifacts: snapshot.implementationArtifacts, implementation_commit: snapshot.implementationCommit,
    implementation_committed: snapshot.implementationCommitted, changed_paths: snapshot.changedPaths,
    frozen_task_ids: snapshot.frozenTaskIds,
    test_commands: snapshot.testCommands,
    test_command_provenance: snapshot.testCommandProvenance,
    ...(coordinatorDispatchId ? { coordinator_dispatch_id: coordinatorDispatchId } : {}),
  },
});

export const buildContinueTestingPacket = (snapshot: ImplementationSnapshot) => ({
  objective: "Continue the completed implementation by dispatching its frozen independent Test packet. Do not repeat implementation work.",
  allowed_read_paths: snapshot.authorizedPaths,
  allowed_write_paths: [],
  acceptance_criteria: ["Dispatch exactly one Test role", "Do not modify implementation", "Preserve the frozen plan, worktree, implementation artifact, and test commands"],
  context: {
    stage: "coding", phase: "continue_testing",
    ...(snapshot.explorerDispatchId ? { explorer_dispatch_id: snapshot.explorerDispatchId } : {}),
    coordinator_dispatch_id: snapshot.coordinatorDispatchId,
    developer_dispatch_ids: snapshot.developerDispatchIds,
    plan_id: snapshot.planId, revision: snapshot.revision, plan_digest: snapshot.planDigest,
    worktree_id: snapshot.worktreeId, worktree_path: snapshot.worktreePath,
    implementation_dispatch_id: snapshot.implementationDispatchId,
    implementation_artifact: snapshot.implementationArtifact,
    implementation_artifacts: snapshot.implementationArtifacts,
    implementation_commit: snapshot.implementationCommit,
    implementation_committed: snapshot.implementationCommitted,
    changed_paths: snapshot.changedPaths,
    frozen_task_ids: snapshot.frozenTaskIds,
    test_commands: snapshot.testCommands,
    test_command_provenance: snapshot.testCommandProvenance,
    permitted_delegate_role: "test",
  },
});

export interface ReviewPacketEvidence {
  revisionSha: string;
  baseCommit: string;
  planId: string | null;
  revision: string | null;
  planDigest: string | null;
  changedPaths: string[];
  planningPaths: string[];
  documentDigest: string;
  committedDiff: string;
  diffDigest: string;
  testDispatchId: string;
  testEvidence: unknown;
  testEvidenceDigest: string;
  testedCommit: unknown;
  artifacts: unknown[];
  evidenceDigest: string;
  revisionDigest: string;
  reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> };
}

export const buildReviewPacket = (evidence: ReviewPacketEvidence) => ({
  objective: `Create the review barrier for frozen integration commit ${evidence.revisionSha}.`,
  allowed_read_paths: [...new Set([...evidence.changedPaths, ...evidence.planningPaths])],
  allowed_write_paths: [],
  acceptance_criteria: ["Review the frozen integration commit", "Preserve all revision, document, diff, and test bindings"],
  context: {
    stage: "code-reviewer", implementation_commit: evidence.revisionSha, revision_sha: evidence.revisionSha, base_commit: evidence.baseCommit,
    plan_id: evidence.planId, revision: evidence.revision, plan_digest: evidence.planDigest,
    changed_paths: evidence.changedPaths, document_digest: evidence.documentDigest,
    committed_diff: evidence.committedDiff, diff_digest: evidence.diffDigest, test_dispatch_id: evidence.testDispatchId,
    test_evidence: evidence.testEvidence, test_evidence_digest: evidence.testEvidenceDigest, testedCommit: evidence.testedCommit,
    artifacts: evidence.artifacts, evidence_digest: evidence.evidenceDigest, revision_digest: evidence.revisionDigest,
    ...(evidence.reissue ? { reissue: { decision_id: evidence.reissue.decision_id, dispatch_id: evidence.reissue.dispatch_id }, resolved_decision: evidence.reissue.resolved_decision ?? null } : {}),
  },
});
