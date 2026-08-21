import { execFileSync } from "node:child_process";
import { type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { redact, sha256, stableJson } from "../utils.js";
import { ReviewFinding, ReviewResult } from "../review.js";
import { buildReviewPacket as assembleReviewPacket } from "./implementation.js";
import * as common from "./store.js";
export function advanceReview(store: common.StateStore, ops: common.DispatchOperations, runId: string, result: ResultEnvelope): void {
    const packet = ops.buildReviewPacket!(store, ops, runId, result);
    if (!packet) return;
    const revisionSha = packet.context.revision_sha;
    const existing = store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state!='failed'
      AND json_extract(packet_json,'$.context.revision_sha')=?`).get(runId, revisionSha);
    if (existing) return;
    const dispatchId = ops.insert!(store, ops, runId, "code-reviewer", packet);
    ops.changeStage!(store, ops, runId, "code-reviewer", dispatchId);
  }

export function reconcileReview(store: common.StateStore, ops: common.DispatchOperations, runId: string, barrierId?: string): Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> {
    store.getRun(runId);
    const barriers = store.db.prepare(`SELECT * FROM review_barriers WHERE run_id=?${barrierId ? " AND barrier_id=?" : ""} ORDER BY created_at`)
      .all(...(barrierId ? [runId, barrierId] : [runId])) as common.ReviewBarrierRow[];
    if (barrierId && barriers.length === 0) throw new ValidationError("review barrier does not belong to run");
    const outcomes: Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> = [];
    for (const barrier of barriers) {
      let outcome = { barrier_id: barrier.barrier_id, state: barrier.state, blocking: [] as ReviewFinding[] };
      store.db.transaction(() => {
        const axes: Array<"spec" | "standards"> = barrier.axes_json ? JSON.parse(barrier.axes_json) as Array<"spec" | "standards"> : barrier.formal ? ["spec", "standards"] : ["standards"];
        for (const axis of axes) {
          const role = axis === "spec" ? "review-spec" : "review-standards";
          const dispatchColumn = axis === "spec" ? "spec_dispatch_id" : "standards_dispatch_id";
          let dispatchId = axis === "spec" ? barrier.spec_dispatch_id : barrier.standards_dispatch_id;
          let leaf = dispatchId
            ? store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role)
            : undefined;
          if (!leaf) {
            leaf = (store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC").all(runId, role) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>)
              .find((row) => (JSON.parse(row.packet_json) as common.DispatchPacket).context.barrier_id === barrier.barrier_id);
            dispatchId = (leaf as { dispatch_id?: string } | undefined)?.dispatch_id;
            if (dispatchId) store.db.prepare(`UPDATE review_barriers SET ${dispatchColumn}=? WHERE barrier_id=?`).run(dispatchId, barrier.barrier_id);
          }
          const row = leaf as { dispatch_id: string; state: string; packet_json: string; result_json?: string } | undefined;
          if (row?.state !== "completed" || !row.result_json) continue;
          const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
          if (packet.context.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review packet is not bound to its barrier`);
          const envelope = JSON.parse(row.result_json) as ResultEnvelope;
          const payload = envelope.payload as { finding_ids?: unknown; barrier_id?: unknown };
          if (payload.barrier_id !== undefined && payload.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review result is not bound to its barrier`);
          const reviewResult: ReviewResult = { axis, summary: envelope.summary, findings: envelope.findings as ReviewFinding[] };
          common.validateReviewResult(reviewResult);
          const findingIds = reviewResult.findings.map((finding) => finding.finding_id);
          if (stableJson(payload.finding_ids ?? []) !== stableJson(findingIds)) throw new ValidationError(`${axis} review result finding ids do not match its findings`);
          const serialized = stableJson(reviewResult);
          const existing = store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? AND axis=?").get(barrier.barrier_id, axis) as { result_json: string } | undefined;
          if (existing && existing.result_json !== serialized) throw new ValidationError(`${axis} review was already submitted with a different result`);
          store.db.prepare("INSERT OR IGNORE INTO review_results(barrier_id,axis,result_json,created_at) VALUES (?,?,?,?)")
            .run(barrier.barrier_id, axis, serialized, new Date().toISOString());
          const artifact = store.db.prepare("SELECT sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
            .get(runId, row.dispatch_id) as { sha256: string } | undefined;
          const digestColumn = axis === "spec" ? "spec_result_digest" : "standards_result_digest";
          store.db.prepare(`UPDATE review_barriers SET ${digestColumn}=? WHERE barrier_id=?`).run(artifact?.sha256 ?? sha256(row.result_json), barrier.barrier_id);
          if (payload.barrier_id === undefined) {
            envelope.payload = { ...envelope.payload, barrier_id: barrier.barrier_id };
            store.db.prepare("UPDATE dispatches SET result_json=? WHERE dispatch_id=?").run(stableJson(envelope), row.dispatch_id);
          }
        }
        const results = (store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? ORDER BY axis").all(barrier.barrier_id) as Array<{ result_json: string }>)
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
        store.db.prepare("UPDATE review_barriers SET axes_json=?,state=?,aggregate_json=?,completed_at=CASE WHEN ?='pending' THEN completed_at ELSE COALESCE(completed_at,?) END WHERE barrier_id=?")
          .run(stableJson(axes), state, stableJson(aggregate), state, new Date().toISOString(), barrier.barrier_id);
        if (state === "blocked") ops.ensureReviewResolutionDispatch!(store, ops, runId, barrier, blocking);
        if (state === "passed" || state === "resolved") ops.ensureFinalGitDispatch!(store, ops, runId, barrier);
        outcome = { barrier_id: barrier.barrier_id, state, blocking };
      })();
      outcomes.push(outcome);
    }
    return outcomes;
  }

export function ensureReviewResolutionDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, barrier: common.ReviewBarrierRow, blocking: ReviewFinding[]): string {
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='review_resolution'
      AND json_extract(packet_json,'$.context.barrier_id')=? LIMIT 1`).get(runId, barrier.barrier_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const leafId = barrier.spec_dispatch_id ?? barrier.standards_dispatch_id;
    const leaf = leafId ? store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(leafId) as { packet_json: string } | undefined : undefined;
    const reviewPaths = leaf ? (JSON.parse(leaf.packet_json) as common.DispatchPacket).allowed_read_paths : [];
    const writablePaths = reviewPaths.filter((path) => !path.startsWith(".ai-team/plans/"));
    const dispatchId = ops.insert!(store, ops, runId, "coding", common.validatePacket({
      objective: `Resolve every blocking finding for review barrier ${barrier.barrier_id}.`,
      allowed_read_paths: reviewPaths,
      allowed_write_paths: writablePaths,
      acceptance_criteria: ["Map every P0/P1 finding to change evidence", "Provide verification evidence after the repair commit"],
      context: { stage: "coding", phase: "review_resolution", barrier_id: barrier.barrier_id, revision_sha: barrier.revision_sha, blocking_findings: blocking },
    }, "coding"));
    ops.changeStage!(store, ops, runId, "coding", dispatchId);
    return dispatchId;
  }

export function ensureFinalGitDispatch(store: common.StateStore, ops: common.DispatchOperations, runId: string, barrier: common.ReviewBarrierRow): string {
    const effectiveHead = barrier.repair_commit ?? barrier.revision_sha;
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'
      AND json_extract(packet_json,'$.context.phase')='finalize_integration'
      AND json_extract(packet_json,'$.context.barrier_id')=?
      AND json_extract(packet_json,'$.context.revision_sha')=? LIMIT 1`).get(runId, barrier.barrier_id, effectiveHead) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = store.getRun(runId) as { state: string };
    if (run.state !== "active") return "";
    const integration = ops.activeIntegrationWorktree!(store, ops, runId);
    if (!integration) throw new ValidationError("passed review requires an active integration worktree");
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (integrationHead !== effectiveHead) throw new ValidationError("finalize integration packet head does not match the plan worktree HEAD", {
      effective_reviewed_head: effectiveHead,
      integration_head: integrationHead,
    });
    const dispatchId = ops.insert!(store, ops, runId, "git-operator", common.validatePacket({
      objective: `Merge reviewed integration commit ${effectiveHead} into the target branch and clean up owned worktrees.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge the reviewed integration worktree into the target branch", "Clean up all run-owned worktrees after integration"],
      context: { stage: "git-operator", phase: "finalize_integration", barrier_id: barrier.barrier_id, revision_sha: effectiveHead, original_review_head: barrier.revision_sha, integration_worktree_id: integration.worktree_id, actions: ["integrate", "cleanup"] },
    }, "git-operator"));
    if (run.state === "active") ops.changeStage!(store, ops, runId, "git-operator", dispatchId);
    return dispatchId;
  }

export function buildReviewPacket(store: common.StateStore, ops: common.DispatchOperations, runId: string, testResult?: ResultEnvelope, reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> }): common.DispatchPacket | undefined {
    const test = store.db.prepare("SELECT dispatch_id,state,result_json,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; state: string; result_json?: string; packet_json: string } | undefined;
    if (!test || test.state !== "completed" || !test.result_json) return undefined;
    const testPacket = JSON.parse(test.packet_json) as common.DispatchPacket;
    const testContext = testPacket.context as { implementation_commit?: string; implementation_committed?: boolean; changed_paths?: string[] };
    if (testContext.implementation_committed !== true) return undefined;
    const revisionSha = testContext.implementation_commit;
    if (!revisionSha || !/^[a-f0-9]{40}$/.test(revisionSha)) return undefined;
    const run = store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string; base_commit?: string };
    const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    const integration = ops.activeIntegrationWorktree!(store, ops, runId);
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
    const planningPaths = run.plan_id && run.revision ? [
      "spec.md", "plan.md", "plan.metadata.json", "tasks.md", "tasks.metadata.json",
    ].map((name) => `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/${name}`) : [];
    if (run.plan_id && run.revision) {
      const taskRoot = `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/tasks`;
      const taskPaths = execFileSync("git", ["-C", repository.project_path, "ls-tree", "-r", "--name-only", revisionSha, "--", taskRoot], { encoding: "utf8" })
        .split("\n").filter((path) => /\/TASK-\d{3}(?:\.metadata)?\.(?:md|json)$/.test(path));
      planningPaths.push(...taskPaths);
    }
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
    const artifacts = store.db.prepare(`SELECT a.artifact_id,a.dispatch_id,a.kind,a.path,a.sha256,d.role
      FROM artifacts a JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND d.role IN ('coding','frontend-developer','backend-developer','git-operator','test')
      ORDER BY a.created_at,a.artifact_id`).all(runId) as Array<{ artifact_id: string; dispatch_id: string; kind: string; path: string; sha256: string; role: string }>;
    const evidenceDigest = sha256(stableJson({ test_dispatch_id: test.dispatch_id, test_evidence_digest: testEvidenceDigest, artifact_digests: artifacts.map((artifact) => artifact.sha256) }));
    const revisionDigest = sha256(stableJson({ plan_id: run.plan_id ?? null, revision: run.revision ?? null, base_commit: baseCommit, revision_sha: revisionSha, document_digest: documentDigest, diff_digest: diffDigest, evidence_digest: evidenceDigest }));
    return common.validatePacket(assembleReviewPacket({
      revisionSha, baseCommit, planId: run.plan_id ?? null, revision: run.revision ?? null, planDigest: run.plan_digest ?? null,
      changedPaths, planningPaths: existingPlanningPaths, documentDigest, committedDiff, diffDigest,
      testDispatchId: test.dispatch_id, testEvidence: frozenTestResult, testEvidenceDigest, testedCommit,
      artifacts, evidenceDigest, revisionDigest, ...(reissue ? { reissue } : {}),
    }), "code-reviewer");
  }
