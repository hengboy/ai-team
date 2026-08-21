import { Role } from "../constants.js";
import { type ResultEnvelope } from "../contracts.js";
import { IncompatibleError, ValidationError } from "../errors.js";
import * as common from "./store.js";
import * as verification from "./verification.js";
import * as submission from "./submission-lifecycle.js";
import * as planning from "./planning-lifecycle.js";
import * as task from "./task-lifecycle.js";
import * as testRepair from "./test-repair-lifecycle.js";
import * as review from "./review-lifecycle.js";
import * as recovery from "./recovery-lifecycle.js";
export function advanceRun(store: common.StateStore, ops: common.DispatchOperations, runId: string, role: Role, result: ResultEnvelope): void {
    const run = store.getRun(runId) as { profile: string; mode?: string };
    if (role === "coding") {
      const packetRow = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string } | undefined;
      const packet = packetRow ? JSON.parse(packetRow.packet_json) as common.DispatchPacket : undefined;
      if (packet?.context.phase === "test_repair") {
        if (ops.createBlockedTestRepairRecovery!(store, ops, runId)) return;
        ops.ensureTestRepairDeveloperDispatch!(store, ops, runId, result.dispatch_id);
        return;
      }
    }
    if (role === "file-explorer") {
      const next = run.profile === "planning" ? "planning" : "coding";
      const existing = store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role=? AND state IN ('pending','claimed')").get(runId, next);
      if (existing) return;
      if (next === "coding" && run.mode === "planned") {
        const dispatchId = ops.ensureGitPrepareDispatch!(store, ops, runId, "integration", result.dispatch_id);
        ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
        return;
      }
      const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, result.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("completed File Explorer result artifact is missing");
      const dispatchId = ops.create!(store, ops, runId, next, {
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
      if (next === "coding") ops.ensureGitPrepareDispatch!(store, ops, runId, "integration", result.dispatch_id);
      ops.changeStage!(store, ops, runId, next, dispatchId);
      return;
    }
    if (role === "git-operator") {
      const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string } | undefined;
      const context = row ? (JSON.parse(row.packet_json) as common.DispatchPacket).context as { phase?: unknown; explorer_dispatch_id?: unknown; reconciliation?: unknown; source_dispatch_id?: unknown } : {};
      if (run.mode === "planned" && context.phase === "prepare_worktrees") {
        if (typeof context.explorer_dispatch_id === "string") ops.createPlannedCodingDispatch!(store, ops, runId, context.explorer_dispatch_id, result.dispatch_id);
        return;
      }
      if (context.phase === "cleanup_integrated_task") {
        ops.ensureNextPlannedTaskPrepare!(store, ops, runId);
        return;
      }
      if (run.mode === "planned" && (context.phase === "prepare_implementation_worktree" || context.phase === "recover_task_worktree")) {
        const taskId = typeof (context as { task_id?: unknown }).task_id === "string" ? (context as { task_id: string }).task_id : undefined;
        if (taskId && ops.plannedTaskRows!(store, ops, runId).some((task) => task.task_id === taskId)) {
          const recoveryWorktreeId = context.phase === "recover_task_worktree" && typeof (context as { worktree_id?: unknown }).worktree_id === "string"
            ? (context as { worktree_id: string }).worktree_id
            : undefined;
          const taskKey = taskId.toLowerCase();
          const worktree = recoveryWorktreeId
            ? store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, recoveryWorktreeId) as { worktree_id: string } | undefined
            : store.db.prepare(`SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)
              ORDER BY created_at DESC LIMIT 1`).get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string } | undefined;
          if (!worktree) throw new ValidationError("completed planned task prepare is missing its registered worktree");
          store.advanceRunTask(runId, taskId, "prepared", { worktree_id: worktree.worktree_id });
        }
        ops.ensurePlannedTaskContinuation!(store, ops, runId, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && context.phase === "apply_task_authority") {
        throw new IncompatibleError("legacy task authority dispatch cannot continue", {
          reason_code: "legacy_task_authority_dispatch",
          next_action: "start_new_run",
        });
      }
      if (run.mode === "planned" && context.phase === "continue_task_authority_conflict") {
        throw new IncompatibleError("legacy task authority conflict continuation cannot continue", {
          reason_code: "legacy_task_authority_conflict_continuation",
          next_action: "start_new_run",
        });
      }
      if (run.mode === "planned" && context.phase === "reconcile_worktree_ownership") {
        if (typeof context.source_dispatch_id !== "string") throw new ValidationError("ownership reconciliation is missing its source merge dispatch");
        const failed = store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
          .get(runId, context.source_dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined;
        if (!failed) throw new ValidationError("ownership reconciliation source merge dispatch was not found");
        ops.recoveryReplacement!(store, ops, runId, failed, undefined, result.dispatch_id, result.verification);
        return;
      }
      if (context.phase === "review_repair_commit") {
        const worktreeId = (context as { worktree_id?: unknown }).worktree_id;
        const barrierId = (context as { barrier_id?: unknown }).barrier_id;
        if (typeof worktreeId !== "string" || typeof barrierId !== "string") throw new ValidationError("review repair commit is missing its barrier or worktree identity");
        const operation = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
          .get(runId, worktreeId) as { evidence_json?: string } | undefined;
        const evidence = JSON.parse(operation?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (!evidence.commit) throw new ValidationError("completed review repair Git Operator result has no bound commit operation");
        const developerId = (context as { developer_dispatch_id?: unknown }).developer_dispatch_id;
        const developer = typeof developerId === "string" ? store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, developerId) as { packet_json: string } | undefined : undefined;
        const developerPacket = developer ? JSON.parse(developer.packet_json) as common.DispatchPacket : undefined;
        const explorer = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'").get(runId, worktreeId) as { path: string } | undefined;
        if (!developerPacket || !explorer || !worktree) throw new ValidationError("review repair Test evidence could not be frozen");
        const frozen = ops.testCommandSnapshot!(store, ops, runId, worktree.path, explorer.dispatch_id);
        const testId = ops.insert!(store, ops, runId, "test", common.validatePacket({
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
        ops.changeStage!(store, ops, runId, "test", testId);
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
        const operation = store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed' AND json_extract(evidence_json,'$.worktree_id')=? ORDER BY completed_at DESC LIMIT 1")
          .get(runId, worktreeId) as { evidence_json?: string } | undefined;
        const evidence = JSON.parse(operation?.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (!evidence.commit) throw new ValidationError("completed Test repair Git Operator result has no bound commit operation");
        ops.createRepairRetest!(store, ops, runId, sourceTestDispatchId, developerId, evidence.commit, evidence.paths ?? []);
        return;
      }
      if (context.phase === "cancel_cleanup") {
        store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        store.event(runId, "run.canceled", { cleanup_dispatch_id: result.dispatch_id, reconciliation: context.reconciliation ?? null });
        return;
      }
      if (context.phase === "finalize_integration") {
        const unfinished = store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')")
          .get(runId) as { count: number };
        if (unfinished.count) throw new ValidationError("run cannot complete while dispatches remain pending or claimed");
        store.db.prepare("UPDATE runs SET state='completed',stage='completed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        store.event(runId, "run.completed", { final_dispatch_id: result.dispatch_id });
        return;
      }
    }
    if (role === "frontend-developer" || role === "backend-developer") {
      const packetRow = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string };
      const packet = JSON.parse(packetRow.packet_json) as common.DispatchPacket;
      if (packet.context.phase === "test_repair" && typeof packet.context.source_test_dispatch_id === "string" && typeof packet.context.worktree_id === "string") {
        const lineage = store.db.prepare("SELECT test_scope FROM test_repair_lineage WHERE run_id=? AND source_test_dispatch_id=? AND repair_developer_dispatch_id=?")
          .get(runId, packet.context.source_test_dispatch_id, result.dispatch_id) as { test_scope: string } | undefined;
        if (!lineage) throw new ValidationError("completed Test repair Developer is not bound to its lineage");
        if (lineage.test_scope === "task") {
          ops.createRepairRetest!(store, ops, runId, packet.context.source_test_dispatch_id, result.dispatch_id);
          return;
        }
        const modifiedPaths = Array.isArray((result.payload as { modified_paths?: unknown }).modified_paths)
          ? (result.payload as { modified_paths: string[] }).modified_paths : [];
        const commitId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
          objective: `Commit ${lineage.test_scope} Test repair before independent retest.`,
          allowed_read_paths: [], allowed_write_paths: [],
          acceptance_criteria: ["Commit only the repair Developer paths", "Preserve the Test repair lineage"],
          context: {
            stage: "git-operator", phase: "test_repair_commit", test_scope: lineage.test_scope,
            source_test_dispatch_id: packet.context.source_test_dispatch_id,
            worktree_id: packet.context.worktree_id, developer_dispatch_id: result.dispatch_id, changed_paths: modifiedPaths,
          },
        }, "git-operator"), result.dispatch_id);
        store.db.prepare("UPDATE test_repair_lineage SET repair_commit_dispatch_id=? WHERE source_test_dispatch_id=?")
          .run(commitId, packet.context.source_test_dispatch_id);
        ops.changeStage!(store, ops, runId, "git-operator", commitId);
        return;
      }
      if (packet.context.phase === "review_repair" && typeof packet.context.barrier_id === "string" && typeof packet.context.worktree_id === "string") {
        const modifiedPaths = Array.isArray((result.payload as { modified_paths?: unknown }).modified_paths)
          ? (result.payload as { modified_paths: string[] }).modified_paths : [];
        const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
          objective: `Commit the repair for review barrier ${packet.context.barrier_id} in its existing plan worktree.`,
          allowed_read_paths: [],
          allowed_write_paths: [],
          acceptance_criteria: ["Commit only the Developer-authored repair paths", "Do not create Task integration for the plan worktree"],
          context: {
            stage: "git-operator", phase: "review_repair_commit", barrier_id: packet.context.barrier_id,
            worktree_id: packet.context.worktree_id, developer_dispatch_id: result.dispatch_id, changed_paths: modifiedPaths,
          },
        }, "git-operator"), result.dispatch_id);
        ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
        return;
      }
      const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
      if (taskId && ops.plannedTaskRows!(store, ops, runId).some((task) => task.task_id === taskId)) {
        store.advanceRunTask(runId, taskId, "implemented", { worktree_id: String(packet.context.worktree_id), developer_dispatch_id: result.dispatch_id });
        ops.createPlannedTaskTest!(store, ops, runId, result.dispatch_id);
        return;
      }
    }
    if (role === "test") {
      const packetRow = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string };
      const packet = JSON.parse(packetRow.packet_json) as common.DispatchPacket;
      if (packet.context.phase === "review_repair_test") {
        ops.changeStage!(store, ops, runId, "coding", result.dispatch_id);
        store.event(runId, "review.repair_verified", {
          barrier_id: packet.context.barrier_id,
          repair_commit: packet.context.implementation_commit,
          test_dispatch_id: result.dispatch_id,
        });
        return;
      }
      if (packet.context.phase === "task_test" && typeof packet.context.task_id === "string") {
        store.advanceRunTask(runId, packet.context.task_id, "tested", { worktree_id: String(packet.context.worktree_id), test_dispatch_id: result.dispatch_id });
        ops.changeStage!(store, ops, runId, "coding", result.dispatch_id);
        ops.ensureCodingCommitContinuation!(store, ops, runId);
        return;
      }
    }
    if (["coding", "frontend-developer", "backend-developer", "git-operator"].includes(role)) {
      if (run.mode === "planned") {
        if (role === "coding" && ops.ensurePlannedTaskDeveloperDispatch!(store, ops, runId, result.dispatch_id, "completion")) return;
        ops.reconcilePlannedTaskStates!(store, ops, runId);
        if (ops.ensureNextPlannedTaskPrepare!(store, ops, runId)) return;
      }
      ops.advanceImplementation!(store, ops, runId);
      return;
    }
    if (role === "test") ops.advanceReview!(store, ops, runId, result);
  }
export const dispatchOperations: common.DispatchOperations = {
  ...verification, ...submission, ...planning, ...task, ...testRepair, ...review, ...recovery, advanceRun,
};
