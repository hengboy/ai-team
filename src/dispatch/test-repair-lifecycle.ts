import { Role } from "../constants.js";
import { type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { buildContinueTestingPacket } from "./implementation.js";
import { freezeExecutionContract } from "../execution-contract.js";
import * as common from "./store.js";
export function createTestRepair(store: common.StateStore, ops: common.DispatchOperations, runId: string, sourceTestDispatchId: string, packet: common.DispatchPacket, result: ResultEnvelope): string | undefined {
    const phase = typeof packet.context.phase === "string" ? packet.context.phase : undefined;
    const testScope = phase === "task_test" ? "task" : phase === "review_repair_test" ? "review_repair" : "final";
    const taskId = typeof packet.context.task_id === "string" ? packet.context.task_id : undefined;
    const barrierId = typeof packet.context.barrier_id === "string" ? packet.context.barrier_id : undefined;
    const worktreeId = typeof packet.context.worktree_id === "string" ? packet.context.worktree_id : undefined;
    const implementationDispatchId = typeof packet.context.implementation_dispatch_id === "string" ? packet.context.implementation_dispatch_id : undefined;
    const developer = implementationDispatchId
      ? store.db.prepare("SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role IN ('frontend-developer','backend-developer')")
        .get(runId, implementationDispatchId) as { dispatch_id: string; role: Role; packet_json: string } | undefined
      : worktreeId ? store.db.prepare(`SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')
          AND json_extract(packet_json,'$.context.worktree_id')=? ORDER BY completed_at DESC,created_at DESC LIMIT 1`)
        .get(runId, worktreeId) as { dispatch_id: string; role: Role; packet_json: string } | undefined : undefined;
    if (!developer || !worktreeId) return undefined;
    const developerPacket = JSON.parse(developer.packet_json) as common.DispatchPacket;
    const attemptRow = store.db.prepare(`SELECT COALESCE(MAX(attempt),0) AS attempt FROM test_repair_lineage
      WHERE run_id=? AND test_scope=? AND COALESCE(task_id,'')=COALESCE(?,'') AND COALESCE(barrier_id,'')=COALESCE(?,'')`)
      .get(runId, testScope, taskId ?? null, barrierId ?? null) as { attempt: number };
    const failedChecks = Array.isArray((result.payload as { checks?: unknown }).checks)
      ? (result.payload as { checks: unknown[] }).checks : [];
    const codingId = ops.insert!(store, ops, runId, "coding", common.validatePacket({
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
    store.db.prepare(`INSERT INTO test_repair_lineage(source_test_dispatch_id,run_id,test_scope,attempt,task_id,barrier_id,
      original_developer_dispatch_id,developer_role,worktree_id,coding_dispatch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sourceTestDispatchId, runId, testScope, attemptRow.attempt + 1, taskId ?? null, barrierId ?? null,
        developer.dispatch_id, developer.role, worktreeId, codingId, new Date().toISOString());
    store.db.prepare("UPDATE runs SET state='active',stage='coding',updated_at=? WHERE run_id=?")
      .run(new Date().toISOString(), runId);
    store.event(runId, "test.repair_created", { source_test_dispatch_id: sourceTestDispatchId, coding_dispatch_id: codingId, test_scope: testScope, attempt: attemptRow.attempt + 1, task_id: taskId ?? null, barrier_id: barrierId ?? null, developer_role: developer.role, worktree_id: worktreeId });
    return codingId;
  }

export function resumeFailedTestRepair(store: common.StateStore, ops: common.DispatchOperations, runId: string): boolean {
    const failed = store.db.prepare(`SELECT dispatch_id,packet_json,result_json FROM dispatches
      WHERE run_id=? AND role='test' AND state='failed' ORDER BY completed_at DESC,created_at DESC LIMIT 1`)
      .get(runId) as { dispatch_id: string; packet_json: string; result_json?: string } | undefined;
    if (!failed?.result_json) return false;
    const existing = store.db.prepare("SELECT 1 FROM test_repair_lineage WHERE source_test_dispatch_id=?").get(failed.dispatch_id);
    if (existing) return false;
    let result: ResultEnvelope;
    try { result = JSON.parse(failed.result_json) as ResultEnvelope; }
    catch { return false; }
    if (!["failed", "retryable_failure"].includes(result.status) || result.side_effect_state !== "none" || result.decisions_needed.length) return false;
    const packet = JSON.parse(failed.packet_json) as common.DispatchPacket;
    store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=? AND state='failed'")
      .run(new Date().toISOString(), runId);
    const repairDispatchId = ops.createTestRepair!(store, ops, runId, failed.dispatch_id, packet, result);
    if (!repairDispatchId) {
      store.db.prepare("UPDATE runs SET state='failed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      return false;
    }
    store.event(runId, "test.repair_resumed", { source_test_dispatch_id: failed.dispatch_id, coding_dispatch_id: repairDispatchId });
    return true;
  }

export function ensureTestRepairDeveloperDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, codingDispatchId: string): string {
    const lineage = store.db.prepare(`WITH RECURSIVE coding_ancestors(dispatch_id,replacement_for) AS (
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
    const previousRepairDispatchId = lineage.repair_developer_dispatch_id;
    if (previousRepairDispatchId) {
      const previousRepair = store.db.prepare("SELECT state,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?")
        .get(runId, previousRepairDispatchId, lineage.developer_role) as { state: string; result_json?: string } | undefined;
      if (previousRepair && ["pending", "claimed"].includes(previousRepair.state)) return previousRepairDispatchId;
      const previousResult = previousRepair?.result_json ? JSON.parse(previousRepair.result_json) as ResultEnvelope : undefined;
      if (previousRepair?.state !== "failed" && previousResult?.status !== "failed") {
        throw new ValidationError("Test repair Developer continuation is not recoverable");
      }
    }

    const coordinator = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'")
      .get(runId, codingDispatchId) as { packet_json: string } | undefined;
    const developer = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=? AND state='completed'")
      .get(runId, lineage.original_developer_dispatch_id, lineage.developer_role) as { packet_json: string } | undefined;
    const worktree = store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND worktree_id=? AND state='active'")
      .get(runId, lineage.worktree_id) as { path: string } | undefined;
    const testArtifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
      .get(runId, lineage.source_test_dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    if (!coordinator || !developer || !worktree || !testArtifact) {
      throw new ValidationError("completed Test repair cannot create its original Developer continuation");
    }

    const coordinatorPacket = JSON.parse(coordinator.packet_json) as common.DispatchPacket;
    const originalDeveloperPacket = JSON.parse(developer.packet_json) as common.DispatchPacket;
    const failedChecks = Array.isArray(coordinatorPacket.context.failed_checks) ? coordinatorPacket.context.failed_checks : undefined;
    if (!failedChecks) throw new ValidationError("completed Test repair is missing frozen failed checks");
    if (originalDeveloperPacket.context.worktree_id !== lineage.worktree_id) {
      throw new ValidationError("Test repair original Developer worktree does not match its frozen lineage");
    }
    const requiredCommands = [...new Set(failedChecks.flatMap((check) => check && typeof check === "object" && typeof (check as { command?: unknown }).command === "string"
      ? [(check as { command: string }).command] : []))];
    const packet = common.validatePacket({
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
    const frozen = freezeExecutionContract(lineage.developer_role, ops.freezeVerificationContext!(store, ops, runId, lineage.developer_role, packet)) as common.DispatchPacket;
    common.assertExplorerAuthorization(store, runId, lineage.developer_role, frozen);
    const dispatchId = ops.insert!(store, ops, runId, lineage.developer_role, frozen, lineage.original_developer_dispatch_id);
    const updated = store.db.prepare(`UPDATE test_repair_lineage SET repair_developer_dispatch_id=?
      WHERE run_id=? AND source_test_dispatch_id=? AND (repair_developer_dispatch_id IS NULL OR repair_developer_dispatch_id=?)`)
      .run(dispatchId, runId, lineage.source_test_dispatch_id, previousRepairDispatchId ?? null);
    if (updated.changes !== 1) throw new ValidationError("Test repair Developer continuation was created concurrently");
    store.event(runId, "test.repair_developer_dispatch_created", {
      coding_dispatch_id: codingDispatchId,
      repair_developer_dispatch_id: dispatchId,
      source_test_dispatch_id: lineage.source_test_dispatch_id,
      original_developer_dispatch_id: lineage.original_developer_dispatch_id,
      developer_role: lineage.developer_role,
      worktree_id: lineage.worktree_id,
    });
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function createRepairRetest(store: common.StateStore, ops: common.DispatchOperations, runId: string, sourceTestDispatchId: string, developerDispatchId: string, commit?: string, changedPaths?: string[]): string {
    const lineage = store.db.prepare("SELECT * FROM test_repair_lineage WHERE run_id=? AND source_test_dispatch_id=?")
      .get(runId, sourceTestDispatchId) as { test_scope: string; attempt: number; worktree_id: string; task_id?: string; barrier_id?: string } | undefined;
    const source = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='test'")
      .get(runId, sourceTestDispatchId) as { packet_json: string } | undefined;
    const artifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, developerDispatchId) as { artifact_id: string; sha256: string } | undefined;
    if (!lineage || !source || !artifact) throw new ValidationError("repair retest cannot freeze its lineage and Developer artifact");
    const original = JSON.parse(source.packet_json) as common.DispatchPacket;
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
    const retestId = ops.insert!(store, ops, runId, "test", common.validatePacket({
      objective: `Re-run the frozen ${lineage.test_scope} Test after repair attempt ${lineage.attempt}.`,
      allowed_read_paths: original.allowed_read_paths,
      allowed_write_paths: [],
      acceptance_criteria: original.acceptance_criteria,
      context,
    }, "test"), sourceTestDispatchId);
    store.db.prepare("UPDATE test_repair_lineage SET retest_dispatch_id=? WHERE source_test_dispatch_id=?")
      .run(retestId, sourceTestDispatchId);
    ops.changeStage!(store, ops, runId, "test", retestId);
    store.event(runId, "test.retest_created", { source_test_dispatch_id: sourceTestDispatchId, retest_dispatch_id: retestId, developer_dispatch_id: developerDispatchId, attempt: lineage.attempt });
    return retestId;
  }

export function ensureContinueTestingContinuation(store: common.StateStore, ops: common.DispatchOperations, runId: string): string | undefined {
    const run = store.getRun(runId) as { profile: string; state: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const test = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (test) return test.dispatch_id;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='continue_testing' AND state IN ('pending','claimed','completed')
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const snapshot = ops.implementationSnapshot!(store, ops, runId);
    if (!snapshot) return undefined;
    const packet = common.validatePacket(buildContinueTestingPacket(snapshot), "coding");
    common.assertExplorerAuthorization(store, runId, "coding", packet);
    const dispatchId = ops.insert!(store, ops, runId, "coding", packet, snapshot.coordinatorDispatchId);
    const orphanedStaging = store.db.prepare(`SELECT staging_id FROM staging_entries
      WHERE run_id=? AND dispatch_id=? AND kind='dispatch-packet' AND state IN ('draft','ready')`).all(runId, snapshot.coordinatorDispatchId) as Array<{ staging_id: string }>;
    for (const entry of orphanedStaging) {
      store.cancelStagingEntry(entry.staging_id, { runId, dispatchId: snapshot.coordinatorDispatchId, role: "coding", kind: "dispatch-packet" }, `superseded by ${dispatchId}`);
    }
    store.event(runId, "coding.continue_testing_created", { dispatchId, replacement_for: snapshot.coordinatorDispatchId, canceled_staging_ids: orphanedStaging.map(({ staging_id }) => staging_id) });
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function createBlockedTestRepairRecovery(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId?: string): boolean {
    const pendingDecision = store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (pendingDecision) return false;
    const query = dispatchId
      ? `SELECT d.dispatch_id,d.packet_json,d.result_json FROM dispatches d
          WHERE d.run_id=? AND d.dispatch_id=?
            AND d.role IN ('frontend-developer','backend-developer')
            AND json_extract(d.packet_json,'$.context.phase')='test_repair'
            AND json_extract(d.result_json,'$.status')='failed'
            AND json_extract(d.result_json,'$.failure_class')='allowed_path_blocked'
            AND EXISTS (SELECT 1 FROM artifacts a WHERE a.run_id=d.run_id AND a.dispatch_id=d.dispatch_id AND a.kind='result')`
      : `SELECT d.dispatch_id,d.packet_json,d.result_json FROM dispatches d
          WHERE d.run_id=?
            AND d.role IN ('frontend-developer','backend-developer')
            AND json_extract(d.packet_json,'$.context.phase')='test_repair'
            AND json_extract(d.result_json,'$.status')='failed'
            AND json_extract(d.result_json,'$.failure_class')='allowed_path_blocked'
            AND EXISTS (SELECT 1 FROM artifacts a WHERE a.run_id=d.run_id AND a.dispatch_id=d.dispatch_id AND a.kind='result')
          ORDER BY COALESCE(d.completed_at,d.created_at) DESC,d.created_at DESC LIMIT 1`;
    const blocked = (dispatchId
      ? store.db.prepare(query).get(runId, dispatchId)
      : store.db.prepare(query).get(runId)) as { dispatch_id: string; packet_json: string; result_json?: string } | undefined;
    if (!blocked?.result_json) return false;
    let packet: common.DispatchPacket;
    let result: ResultEnvelope;
    try {
      packet = JSON.parse(blocked.packet_json) as common.DispatchPacket;
      result = JSON.parse(blocked.result_json) as ResultEnvelope;
    } catch {
      return false;
    }
    if (packet.context.phase !== "test_repair"
      || result.status !== "failed"
      || result.failure_class !== "allowed_path_blocked") return false;
    const decisionId = store.createDecision(
      runId,
      "Frozen Test repair is blocked by a path outside the Developer packet scope.",
      [
        { id: "abort", label: "Abort run", impact: "Stop this run while preserving repair evidence; a new plan or authorization is required to change the blocked path." },
        { id: "new_plan_required", label: "New plan required", impact: "Record that frozen scope cannot repair the blocked path and stop this run without creating a replacement." },
      ],
      "new_plan_required",
      "active_run_recovery",
      blocked.dispatch_id,
    );
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='coding',updated_at=? WHERE run_id=?")
      .run(new Date().toISOString(), runId);
    store.event(runId, "test.repair_scope_blocked", {
      dispatch_id: blocked.dispatch_id,
      decision_id: decisionId,
      failure_class: result.failure_class,
    });
    return true;
  }
