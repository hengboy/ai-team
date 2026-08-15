import { execFileSync } from "node:child_process";
import { DispatchService } from "./dispatch.js";
import { ValidationError } from "./errors.js";
import { StateStore } from "./state.js";
import { redact, sha256, stableJson } from "./utils.js";

export type Severity = "P0" | "P1" | "P2" | "P3";
export interface ReviewFinding { finding_id: string; severity: Severity; title: string; source: string; source_file: string; source_line: number; evidence: string; impact: string; recommendation: string; }
export interface ReviewResult { axis: "spec" | "standards"; summary: string; findings: ReviewFinding[]; }
export interface FindingResolution { finding_id: string; change_evidence: string; verification_evidence: string; }

const validateFindings = (result: ReviewResult): void => {
  if (!result.summary || !Array.isArray(result.findings)) throw new ValidationError("review result requires summary and findings");
  const ids = new Set<string>();
  for (const finding of result.findings) {
    if (!/^FIND-[A-Z]+-\d{3}$/.test(finding.finding_id)) throw new ValidationError(`invalid finding id: ${finding.finding_id}`);
    if (!(["P0", "P1", "P2", "P3"] as string[]).includes(finding.severity)) throw new ValidationError(`invalid finding severity: ${finding.severity}`);
    if (!finding.title || !finding.source || !finding.source_file || !Number.isInteger(finding.source_line) || finding.source_line < 1 || !finding.evidence || !finding.impact || !finding.recommendation) throw new ValidationError(`finding lacks source, location, impact, or recommendation: ${finding.finding_id}`);
    if (ids.has(finding.finding_id)) throw new ValidationError(`duplicate finding id: ${finding.finding_id}`);
    ids.add(finding.finding_id);
  }
};

export class ReviewService {
  constructor(readonly store: StateStore) {}

  create(runId: string, revisionSha: string, formal: boolean): { barrier_id: string; axes: string[] } {
    const run = this.store.getRun(runId) as { mode: string; repo_id: string; plan_id?: string; revision?: string };
    const requiredFormal = run.mode === "planned";
    if (formal !== requiredFormal) throw new ValidationError(`${run.mode} runs require ${requiredFormal ? "formal" : "direct"} review axes`);
    if (!/^[a-f0-9]{40}$/.test(revisionSha)) throw new ValidationError("review revision must be a 40-character commit SHA");
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    try { execFileSync("git", ["-C", repository.project_path, "cat-file", "-e", `${revisionSha}^{commit}`], { stdio: "ignore" }); }
    catch { throw new ValidationError("review revision commit does not exist", { revisionSha }); }
    const integration = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as { path: string } | undefined;
    const test = this.store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; packet_json: string } | undefined;
    const testedCommit = test ? (JSON.parse(test.packet_json) as { context?: { implementation_commit?: string } }).context?.implementation_commit : undefined;
    if (test?.state !== "completed" || testedCommit !== revisionSha) {
      throw new ValidationError("review requires a completed independent test bound to the same integration commit", { revisionSha, testedCommit: testedCommit ?? null });
    }
    if (!integration) throw new ValidationError("review requires a prepared active integration worktree");
    const frozenHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (revisionSha !== frozenHead) {
      throw new ValidationError("review revision must equal the frozen integration HEAD", { revisionSha, integrationHead: frozenHead });
    }
    const coordinator = (this.store.db.prepare("SELECT dispatch_id,state,packet_json,packet_digest FROM dispatches WHERE run_id=? AND role='code-reviewer' ORDER BY created_at DESC").all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string; packet_digest?: string }>)
      .map((row) => ({ ...row, packet: JSON.parse(row.packet_json) as { allowed_read_paths: string[]; context: Record<string, unknown> } }))
      .find((row) => row.packet.context.revision_sha === revisionSha && row.state !== "failed");
    if (!coordinator) throw new ValidationError("review requires a frozen code-reviewer packet for the tested integration commit");
    const context = coordinator.packet.context;
    const bindingFields = ["plan_id", "revision", "base_commit", "revision_sha", "changed_paths", "document_digest", "diff_digest", "test_evidence_digest"] as const;
    const missing = bindingFields.filter((field) => context[field] === undefined);
    if (missing.length) throw new ValidationError("code-reviewer packet is missing frozen review bindings", missing.map((field) => `/context/${field}`));
    if (context.plan_id !== (run.plan_id ?? null) || context.revision !== (run.revision ?? null)) throw new ValidationError("code-reviewer packet does not match the run planning revision");
    const dispatches = new DispatchService(this.store);
    const canonicalPacket = dispatches.buildReviewPacket(runId);
    if (!canonicalPacket) throw new ValidationError("review evidence cannot be reconstructed for the frozen integration commit");
    for (const field of bindingFields) {
      if (stableJson(context[field]) !== stableJson(canonicalPacket.context[field])) {
        throw new ValidationError(`code-reviewer packet ${field} does not match current frozen evidence`);
      }
    }
    if (stableJson(coordinator.packet.allowed_read_paths) !== stableJson(canonicalPacket.allowed_read_paths)) {
      throw new ValidationError("code-reviewer packet changed paths do not match current frozen evidence");
    }
    const baseCommit = context.base_commit as string;
    const documentDigest = context.document_digest as string;
    const diffDigest = context.diff_digest as string;
    const testEvidenceDigest = context.test_evidence_digest as string;
    const committedDiff = context.committed_diff;
    const testEvidence = context.test_evidence;
    const barrierId = `review_${sha256(`${runId}:${baseCommit}:${revisionSha}:${run.plan_id ?? ""}:${run.revision ?? ""}:${documentDigest}:${diffDigest}:${testEvidenceDigest}`).slice(0, 24)}`;
    const axes = formal ? ["spec", "standards"] as const : ["standards"] as const;
    const create = this.store.db.transaction(() => {
      const columns = (this.store.db.prepare("PRAGMA table_info(review_barriers)").all() as Array<{ name: string }>).map((item) => item.name);
      const now = new Date().toISOString();
      const binding = { base_commit: baseCommit, head_commit: revisionSha, plan_id: run.plan_id ?? null, revision: run.revision ?? null, document_digest: documentDigest, diff_digest: diffDigest, test_evidence_digest: testEvidenceDigest };
      let inserted;
      if (["base_commit", "head_commit", "document_digest", "diff_digest", "test_evidence_digest"].every((column) => columns.includes(column))) {
        inserted = this.store.db.prepare(`INSERT OR IGNORE INTO review_barriers(barrier_id,run_id,revision_sha,formal,state,base_commit,head_commit,plan_id,revision,document_digest,diff_digest,test_evidence_digest,created_at)
          VALUES (?,?,?,?, 'pending',?,?,?,?,?,?,?,?)`).run(barrierId, runId, revisionSha, formal ? 1 : 0, binding.base_commit, binding.head_commit, binding.plan_id, binding.revision, binding.document_digest, binding.diff_digest, binding.test_evidence_digest, now);
      } else {
        inserted = this.store.db.prepare("INSERT OR IGNORE INTO review_barriers(barrier_id,run_id,revision_sha,formal,state,created_at) VALUES (?,?,?,?, 'pending', ?)")
          .run(barrierId, runId, revisionSha, formal ? 1 : 0, now);
      }
      if (!inserted.changes) throw new ValidationError("review already exists for this frozen revision; reviews run once");
      for (const axis of axes) {
        dispatches.create(runId, axis === "spec" ? "review-spec" : "review-standards", {
          objective: `Review frozen commit ${revisionSha} on the ${axis} axis.`,
          allowed_read_paths: coordinator.packet.allowed_read_paths,
          allowed_write_paths: [],
          acceptance_criteria: ["Every finding cites a concrete source and evidence", "Return all P0-P3 findings for this axis"],
          context: {
            barrier_id: barrierId,
            revision_sha: revisionSha,
            axis,
            base_commit: baseCommit,
            ...context,
            head_commit: revisionSha,
            parent_dispatch_id: coordinator.dispatch_id,
            parent_packet_digest: coordinator.packet_digest ?? null,
            review_strategy: "integration_head",
            committed_diff: committedDiff,
            test_evidence: testEvidence,
          },
        }, "code-reviewer");
      }
    });
    create();
    return { barrier_id: barrierId, axes: [...axes] };
  }

  submit(runId: string, barrierId: string, result: ReviewResult): { state: string; blocking: ReviewFinding[] } {
    validateFindings(result);
    const barrier = this.barrier(runId, barrierId);
    if (barrier.state !== "pending") throw new ValidationError("review barrier is already complete");
    const required = barrier.formal ? ["spec", "standards"] : ["standards"];
    if (!required.includes(result.axis)) throw new ValidationError(`${result.axis} review is not required for this run`);
    const role = result.axis === "spec" ? "review-spec" : "review-standards";
    const leaf = (this.store.db.prepare("SELECT state,packet_json,result_json FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC").all(runId, role) as Array<{ state: string; packet_json: string; result_json?: string }>)
      .find((item) => (JSON.parse(item.packet_json) as { context?: { barrier_id?: string } }).context?.barrier_id === barrierId);
    if (leaf?.state !== "completed" || !leaf.result_json) throw new ValidationError(`${result.axis} review leaf dispatch has not completed`);
    const packetContext = (JSON.parse(leaf.packet_json) as { context?: Record<string, unknown> }).context ?? {};
    for (const field of ["base_commit", "head_commit", "document_digest", "diff_digest", "test_evidence_digest"] as const) {
      if (barrier[field] && packetContext[field] !== barrier[field]) throw new ValidationError(`${result.axis} review packet is not bound to the frozen review barrier`);
    }
    const envelope = JSON.parse(leaf.result_json) as { summary?: string; findings?: ReviewFinding[]; payload?: { finding_ids?: string[] } };
    const findingIds = result.findings.map((finding) => finding.finding_id);
    if (envelope.summary !== result.summary || stableJson(envelope.findings ?? []) !== stableJson(result.findings) || stableJson(envelope.payload?.finding_ids ?? []) !== stableJson(findingIds)) {
      throw new ValidationError(`${result.axis} review result does not match its completed leaf dispatch`);
    }
    try { this.store.db.prepare("INSERT INTO review_results(barrier_id,axis,result_json,created_at) VALUES (?,?,?,?)").run(barrierId, result.axis, stableJson(result), new Date().toISOString()); }
    catch { throw new ValidationError(`${result.axis} review was already submitted`); }
    const results = this.results(barrierId);
    if (results.length === required.length) {
      const blocking = results.flatMap((item) => item.findings).filter((finding) => finding.severity === "P0" || finding.severity === "P1");
      this.store.db.prepare("UPDATE review_barriers SET state=?,completed_at=? WHERE barrier_id=?").run(blocking.length ? "blocked" : "passed", new Date().toISOString(), barrierId);
      return { state: blocking.length ? "blocked" : "passed", blocking };
    }
    return { state: "pending", blocking: [] };
  }

  resolve(runId: string, barrierId: string, resolutions: FindingResolution[]): { state: "resolved" } {
    const barrier = this.barrier(runId, barrierId);
    if (barrier.state !== "blocked") throw new ValidationError("only a blocked review can be resolved");
    const blocking = this.results(barrierId).flatMap((item) => item.findings).filter((finding) => finding.severity === "P0" || finding.severity === "P1");
    const byId = new Map(resolutions.map((item) => [item.finding_id, item]));
    const missing = blocking.filter((finding) => !byId.get(finding.finding_id)?.change_evidence || !byId.get(finding.finding_id)?.verification_evidence).map((finding) => finding.finding_id);
    const unknown = resolutions.filter((item) => !blocking.some((finding) => finding.finding_id === item.finding_id)).map((item) => item.finding_id);
    if (missing.length || unknown.length) throw new ValidationError("finding resolution mapping is incomplete", { missing, unknown });
    const insert = this.store.db.prepare("INSERT INTO finding_resolutions(barrier_id,finding_id,change_evidence,verification_evidence,created_at) VALUES (?,?,?,?,?)");
    const transaction = this.store.db.transaction(() => {
      for (const item of resolutions) insert.run(barrierId, item.finding_id, redact(item.change_evidence).slice(0, 16_384), redact(item.verification_evidence).slice(0, 16_384), new Date().toISOString());
      this.store.db.prepare("UPDATE review_barriers SET state='resolved' WHERE barrier_id=?").run(barrierId);
    });
    transaction();
    return { state: "resolved" };
  }

  status(runId: string, barrierId: string): Record<string, unknown> {
    const barrier = this.barrier(runId, barrierId);
    return { ...barrier, results: this.results(barrierId), resolutions: this.store.db.prepare("SELECT * FROM finding_resolutions WHERE barrier_id=? ORDER BY finding_id").all(barrierId) };
  }

  assertGate(runId: string, frozenHead?: string): void {
    const test = this.store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string } | undefined;
    const review = this.store.db.prepare("SELECT state,revision_sha,test_evidence_digest FROM review_barriers WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; revision_sha: string; test_evidence_digest?: string } | undefined;
    if (!test || test.state !== "completed") throw new ValidationError("latest independent test dispatch has not completed");
    if (!review || !["passed", "resolved"].includes(review.state)) throw new ValidationError("review gate has not passed");
    if (frozenHead && frozenHead !== review.revision_sha) {
      const operation = this.store.db.prepare("SELECT kind,evidence_json,completed_at FROM operations WHERE run_id=? AND kind IN ('git.sync','git.merge.continue') AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { kind: string; evidence_json: string; completed_at: string } | undefined;
      const evidence = operation ? JSON.parse(operation.evidence_json) as { commit?: string } : undefined;
      const latestTest = this.store.db.prepare("SELECT state,completed_at FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; completed_at?: string } | undefined;
      let equivalentIntegratedTree = false;
      try {
        const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=(SELECT repo_id FROM runs WHERE run_id=?)").get(runId) as { project_path: string };
        execFileSync("git", ["-C", repository.project_path, "merge-base", "--is-ancestor", review.revision_sha, frozenHead], { stdio: "ignore" });
        execFileSync("git", ["-C", repository.project_path, "diff", "--quiet", review.revision_sha, frozenHead], { stdio: "ignore" });
        equivalentIntegratedTree = true;
      } catch { /* a changed tree requires a new review */ }
      if (!equivalentIntegratedTree && (!operation || evidence?.commit !== frozenHead || latestTest?.state !== "completed" || !latestTest.completed_at || latestTest.completed_at < operation.completed_at)) {
        throw new ValidationError("review is stale for the current integration HEAD", { reviewed: review.revision_sha, current: frozenHead });
      }
    }
  }

  private barrier(runId: string, barrierId: string): any {
    const row = this.store.db.prepare("SELECT * FROM review_barriers WHERE barrier_id=? AND run_id=?").get(barrierId, runId);
    if (!row) throw new ValidationError("review barrier does not belong to run");
    return row;
  }

  private results(barrierId: string): ReviewResult[] {
    return (this.store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? ORDER BY axis").all(barrierId) as Array<{ result_json: string }>).map((row) => JSON.parse(row.result_json) as ReviewResult);
  }
}
