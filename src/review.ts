import { ValidationError } from "./errors.js";
import { StateStore } from "./state.js";
import { sha256, stableJson } from "./utils.js";

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
    this.store.getRun(runId);
    if (!/^[a-f0-9]{40}$/.test(revisionSha)) throw new ValidationError("review revision must be a 40-character commit SHA");
    const barrierId = `review_${sha256(`${runId}:${revisionSha}`).slice(0, 24)}`;
    try {
      this.store.db.prepare("INSERT INTO review_barriers(barrier_id,run_id,revision_sha,formal,state,created_at) VALUES (?,?,?,?, 'pending', ?)")
        .run(barrierId, runId, revisionSha, formal ? 1 : 0, new Date().toISOString());
    } catch {
      throw new ValidationError("review already exists for this frozen revision; reviews run once");
    }
    return { barrier_id: barrierId, axes: formal ? ["spec", "standards"] : ["standards"] };
  }

  submit(runId: string, barrierId: string, result: ReviewResult): { state: string; blocking: ReviewFinding[] } {
    validateFindings(result);
    const barrier = this.barrier(runId, barrierId);
    if (barrier.state !== "pending") throw new ValidationError("review barrier is already complete");
    const required = barrier.formal ? ["spec", "standards"] : ["standards"];
    if (!required.includes(result.axis)) throw new ValidationError(`${result.axis} review is not required for this run`);
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
      for (const item of resolutions) insert.run(barrierId, item.finding_id, item.change_evidence, item.verification_evidence, new Date().toISOString());
      this.store.db.prepare("UPDATE review_barriers SET state='resolved' WHERE barrier_id=?").run(barrierId);
    });
    transaction();
    return { state: "resolved" };
  }

  status(runId: string, barrierId: string): Record<string, unknown> {
    const barrier = this.barrier(runId, barrierId);
    return { ...barrier, results: this.results(barrierId), resolutions: this.store.db.prepare("SELECT * FROM finding_resolutions WHERE barrier_id=? ORDER BY finding_id").all(barrierId) };
  }

  assertGate(runId: string): void {
    const test = this.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test' AND state='completed'").get(runId) as { count: number };
    const review = this.store.db.prepare("SELECT state FROM review_barriers WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string } | undefined;
    if (!test.count) throw new ValidationError("independent test dispatch has not completed");
    if (!review || !["passed", "resolved"].includes(review.state)) throw new ValidationError("review gate has not passed");
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
