import { execFileSync } from "node:child_process";
import { DispatchService } from "./dispatch.js";
import { type ValidationDetail } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { StateStore } from "./state.js";
import { redact, sha256, stableJson } from "./utils.js";
import { resolveReviewWorktree } from "./worktree-review.js";

export type Severity = "P0" | "P1" | "P2" | "P3";
export interface ReviewFinding { finding_id: string; severity: Severity; title: string; source: string; source_file: string; source_line: number; evidence: string; impact: string; recommendation: string; }
export interface ReviewResult { axis: "spec" | "standards"; summary: string; findings: ReviewFinding[]; }
export interface FindingResolution { finding_id: string; change_evidence: string; verification_evidence: string; }
export interface ReviewCreateResult { barrier_id: string; axes: string[]; spec_dispatch_id: string | null; standards_dispatch_id: string; reused: boolean; }

export const REVIEW_RESOLUTION_SCHEMA = {
  type: "array",
  description: "Map only blocking P0/P1 findings. P2/P3 findings must not be included.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["finding_id", "change_evidence", "verification_evidence"],
    properties: {
      finding_id: { type: "string", pattern: "^FIND-[A-Z]+-[0-9]{3}$" },
      change_evidence: { type: "string", minLength: 1 },
      verification_evidence: { type: "string", minLength: 1 },
    },
  },
} as const;

export const REVIEW_RESOLUTION_TEMPLATE: FindingResolution[] = [{
  finding_id: "FIND-AXIS-001",
  change_evidence: "repair commit or change evidence",
  verification_evidence: "Test artifact and verification evidence",
}];

export const checkReviewResolutions = (value: unknown): { valid: true; value: FindingResolution[] } | { valid: false; errors: ValidationDetail[] } => {
  if (!Array.isArray(value)) return { valid: false, errors: [{ path: "/", pointer: "/", field: "$", constraint: "type", message: "must be an array" }] };
  const errors: ValidationDetail[] = [];
  value.forEach((item, index) => {
    const pointer = `/${index}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ path: pointer, pointer, field: String(index), constraint: "type", message: "must be an object" });
      return;
    }
    const row = item as Record<string, unknown>;
    for (const field of ["finding_id", "change_evidence", "verification_evidence"] as const) {
      if (typeof row[field] !== "string" || !row[field].trim()) {
        const fieldPointer = `${pointer}/${field}`;
        errors.push({ path: fieldPointer, pointer: fieldPointer, field, constraint: "minLength", message: "must be a non-empty string" });
      }
    }
    for (const field of Object.keys(row).filter((field) => !["finding_id", "change_evidence", "verification_evidence"].includes(field))) {
      const fieldPointer = `${pointer}/${field}`;
      errors.push({ path: fieldPointer, pointer: fieldPointer, field, constraint: "additionalProperties", message: "unknown field" });
    }
    if (typeof row.finding_id === "string" && !/^FIND-[A-Z]+-\d{3}$/.test(row.finding_id)) {
      const fieldPointer = `${pointer}/finding_id`;
      errors.push({ path: fieldPointer, pointer: fieldPointer, field: "finding_id", constraint: "pattern", message: "must match FIND-<AXIS>-<NNN>" });
    }
  });
  return errors.length ? { valid: false, errors } : { valid: true, value: value as FindingResolution[] };
};

export const REVIEW_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["finding_id", "severity", "title", "source", "source_file", "source_line", "evidence", "impact", "recommendation"],
  properties: {
    finding_id: { type: "string", pattern: "^FIND-[A-Z]+-[0-9]{3}$", description: "FIND-<AXIS>-<NNN>" },
    severity: { enum: ["P0", "P1", "P2", "P3"] },
    title: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    source_file: { type: "string", minLength: 1 },
    source_line: { type: "integer", minimum: 1 },
    evidence: { type: "string", minLength: 1 },
    impact: { type: "string", minLength: 1 },
    recommendation: { type: "string", minLength: 1 },
  },
} as const;

export const REVIEW_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["axis", "summary", "findings"],
  properties: {
    axis: { enum: ["spec", "standards"] },
    summary: { type: "string", minLength: 1 },
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
  },
} as const;

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

  create(runId: string, revisionSha: string, formal: boolean): ReviewCreateResult {
    const run = this.store.getRun(runId) as { mode: string; repo_id: string; plan_id?: string; revision?: string };
    const requiredFormal = run.mode === "planned";
    if (formal !== requiredFormal) throw new ValidationError(`${run.mode} runs require ${requiredFormal ? "formal" : "direct"} review axes`);
    if (!/^[a-f0-9]{40}$/.test(revisionSha)) throw new ValidationError("review revision must be a 40-character commit SHA");
    const existing = this.store.db.prepare("SELECT barrier_id,formal,axes_json,spec_dispatch_id,standards_dispatch_id FROM review_barriers WHERE run_id=? AND revision_sha=?")
      .get(runId, revisionSha) as { barrier_id: string; formal: number; axes_json?: string; spec_dispatch_id?: string; standards_dispatch_id?: string } | undefined;
    if (existing) {
      if (Boolean(existing.formal) !== formal) throw new ValidationError("existing review barrier has different axes");
      const existingAxes = existing.axes_json ? JSON.parse(existing.axes_json) as string[] : formal ? ["spec", "standards"] : ["standards"];
      if (!existing.standards_dispatch_id) throw new ValidationError("existing review barrier is missing its standards dispatch");
      return { barrier_id: existing.barrier_id, axes: existingAxes, spec_dispatch_id: existing.spec_dispatch_id ?? null, standards_dispatch_id: existing.standards_dispatch_id, reused: true };
    }
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    try { execFileSync("git", ["-C", repository.project_path, "cat-file", "-e", `${revisionSha}^{commit}`], { stdio: "ignore" }); }
    catch { throw new ValidationError("review revision commit does not exist", { revisionSha }); }
    const integration = resolveReviewWorktree(this.store, runId);
    const worktreeKind = integration?.kind ?? (run.mode === "planned" ? "plan" : "integration");
    const test = this.store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; packet_json: string } | undefined;
    const testedCommit = test ? (JSON.parse(test.packet_json) as { context?: { implementation_commit?: string } }).context?.implementation_commit : undefined;
    if (test?.state !== "completed" || testedCommit !== revisionSha) {
      throw new ValidationError("review requires a completed independent test bound to the same integration commit", { revisionSha, testedCommit: testedCommit ?? null });
    }
    if (!integration) throw new ValidationError(`review requires a prepared active ${worktreeKind} worktree`);
    const frozenHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (revisionSha !== frozenHead) {
      throw new ValidationError(`review revision must equal the frozen ${worktreeKind} HEAD`, { revisionSha, integrationHead: frozenHead });
    }
    const coordinator = (this.store.db.prepare("SELECT dispatch_id,state,packet_json,packet_digest FROM dispatches WHERE run_id=? AND role='code-reviewer' ORDER BY created_at DESC").all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string; packet_digest?: string }>)
      .map((row) => ({ ...row, packet: JSON.parse(row.packet_json) as { allowed_read_paths: string[]; context: Record<string, unknown> } }))
      .find((row) => row.packet.context.revision_sha === revisionSha && row.state !== "failed");
    if (!coordinator) throw new ValidationError("review requires a frozen code-reviewer packet for the tested integration commit");
    const context = coordinator.packet.context;
    const bindingFields = ["plan_id", "revision", "base_commit", "revision_sha", "changed_paths", "document_digest", "diff_digest", "test_evidence_digest", "revision_digest", "evidence_digest"] as const;
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
    const revisionDigest = context.revision_digest as string;
    const evidenceDigest = context.evidence_digest as string;
    const committedDiff = context.committed_diff;
    const testEvidence = context.test_evidence;
    const barrierId = `review_${sha256(`${runId}:${baseCommit}:${revisionSha}:${run.plan_id ?? ""}:${run.revision ?? ""}:${documentDigest}:${diffDigest}:${testEvidenceDigest}:${revisionDigest}:${evidenceDigest}`).slice(0, 24)}`;
    const axes = formal ? ["spec", "standards"] as const : ["standards"] as const;
    let reused = false;
    const create = this.store.db.transaction(() => {
      const columns = (this.store.db.prepare("PRAGMA table_info(review_barriers)").all() as Array<{ name: string }>).map((item) => item.name);
      const now = new Date().toISOString();
      const binding = { base_commit: baseCommit, head_commit: revisionSha, plan_id: run.plan_id ?? null, revision: run.revision ?? null, document_digest: documentDigest, diff_digest: diffDigest, test_evidence_digest: testEvidenceDigest, revision_digest: revisionDigest, evidence_digest: evidenceDigest };
      let inserted;
      if (["base_commit", "head_commit", "document_digest", "diff_digest", "test_evidence_digest", "revision_digest", "evidence_digest"].every((column) => columns.includes(column))) {
        inserted = this.store.db.prepare(`INSERT OR IGNORE INTO review_barriers(barrier_id,run_id,revision_sha,formal,state,base_commit,head_commit,plan_id,revision,document_digest,diff_digest,test_evidence_digest,revision_digest,evidence_digest,axes_json,created_at)
          VALUES (?,?,?,?, 'pending',?,?,?,?,?,?,?,?,?,?,?)`).run(barrierId, runId, revisionSha, formal ? 1 : 0, binding.base_commit, binding.head_commit, binding.plan_id, binding.revision, binding.document_digest, binding.diff_digest, binding.test_evidence_digest, binding.revision_digest, binding.evidence_digest, stableJson(axes), now);
      } else {
        inserted = this.store.db.prepare("INSERT OR IGNORE INTO review_barriers(barrier_id,run_id,revision_sha,formal,state,created_at) VALUES (?,?,?,?, 'pending', ?)")
          .run(barrierId, runId, revisionSha, formal ? 1 : 0, now);
      }
      if (!inserted.changes) { reused = true; return; }
      for (const axis of axes) {
        const dispatchId = dispatches.create(runId, axis === "spec" ? "review-spec" : "review-standards", {
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
        const column = axis === "spec" ? "spec_dispatch_id" : "standards_dispatch_id";
        this.store.db.prepare(`UPDATE review_barriers SET ${column}=? WHERE barrier_id=?`).run(dispatchId, barrierId);
      }
    });
    create();
    const row = this.store.db.prepare("SELECT barrier_id,spec_dispatch_id,standards_dispatch_id FROM review_barriers WHERE run_id=? AND revision_sha=?").get(runId, revisionSha) as { barrier_id: string; spec_dispatch_id?: string; standards_dispatch_id?: string };
    if (!row.standards_dispatch_id) throw new ValidationError("review barrier is missing its standards dispatch");
    return { barrier_id: row.barrier_id, axes: [...axes], spec_dispatch_id: row.spec_dispatch_id ?? null, standards_dispatch_id: row.standards_dispatch_id, reused };
  }

  async submitValue(runId: string, barrierId: string, result: ReviewResult): Promise<Record<string, unknown>> {
    validateFindings(result);
    const role = result.axis === "spec" ? "review-spec" : "review-standards";
    const leaf = (this.store.db.prepare("SELECT dispatch_id,state,packet_json FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC").all(runId, role) as Array<{ dispatch_id: string; state: string; packet_json: string }>)
      .find((item) => (JSON.parse(item.packet_json) as { context?: { barrier_id?: string } }).context?.barrier_id === barrierId);
    if (!leaf) throw new ValidationError(`${result.axis} review leaf dispatch was not found`);
    let dispatchSubmission: Record<string, unknown> | null = null;
    if (leaf.state === "claimed") {
      const dispatches = new DispatchService(this.store);
      const envelope = dispatches.template(runId, leaf.dispatch_id, role);
      dispatchSubmission = await dispatches.submitValue(runId, leaf.dispatch_id, role, {
        ...envelope,
        summary: result.summary,
        findings: result.findings,
        verification: [{ command: "review submit", outcome: "completed" }],
        payload: { finding_ids: result.findings.map(({ finding_id }) => finding_id) },
      }) as unknown as Record<string, unknown>;
    }
    const aggregate = this.submit(runId, barrierId, result);
    return { dispatch_id: leaf.dispatch_id, dispatch_submission: dispatchSubmission, ...aggregate };
  }

  submit(runId: string, barrierId: string, result: ReviewResult): { state: string; blocking: ReviewFinding[] } {
    validateFindings(result);
    const barrier = this.barrier(runId, barrierId);
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
    const reconciled = new DispatchService(this.store).reconcileReview(runId, barrierId)[0];
    return { state: reconciled?.state ?? barrier.state, blocking: reconciled?.blocking ?? [] };
  }

  resolve(runId: string, barrierId: string, input: unknown): { state: "resolved" } {
    const checked = checkReviewResolutions(input);
    if (!checked.valid) throw new ValidationError("review resolution input is invalid", checked.errors);
    const resolutions = checked.value;
    const barrier = this.barrier(runId, barrierId);
    if (barrier.state !== "blocked" && barrier.state !== "resolved") throw new ValidationError("only a blocked review can be resolved", [{ path: "/", pointer: "/", field: "$", constraint: "state", message: `barrier state must be blocked or resolved for idempotent repair evidence recovery, got ${barrier.state}` }]);
    const blocking = this.results(barrierId).flatMap((item) => item.findings).filter((finding) => finding.severity === "P0" || finding.severity === "P1");
    const byId = new Map(resolutions.map((item) => [item.finding_id, item]));
    const missing = blocking.filter((finding) => !byId.get(finding.finding_id)?.change_evidence || !byId.get(finding.finding_id)?.verification_evidence).map((finding) => finding.finding_id);
    const unknown = resolutions.filter((item) => !blocking.some((finding) => finding.finding_id === item.finding_id)).map((item) => item.finding_id);
    if (missing.length || unknown.length) throw new ValidationError("finding resolution mapping is incomplete", [
      ...missing.map((findingId) => ({ path: "/", pointer: "/", field: "$", constraint: "required", message: `missing blocking P0/P1 resolution: ${findingId}` })),
      ...unknown.map((findingId) => {
        const index = resolutions.findIndex((item) => item.finding_id === findingId);
        const pointer = `/${index}/finding_id`;
        return { path: pointer, pointer, field: "finding_id", constraint: "blocking", message: `${findingId} is not a blocking P0/P1 finding; P2/P3 findings must not be mapped` };
      }),
    ]);
    const worktree = resolveReviewWorktree(this.store, runId);
    if (!worktree) throw new ValidationError("review repair worktree is no longer active", [{ path: "/", pointer: "/", field: "$", constraint: "worktree", message: "the reviewed integration or plan worktree must remain active until resolution" }]);
    const worktreeHead = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const effectiveHead = barrier.state === "resolved" && barrier.repair_commit ? barrier.repair_commit : worktreeHead;
    let verification: Record<string, unknown> | null = null;
    if (effectiveHead !== barrier.revision_sha) {
      try { execFileSync("git", ["-C", worktree.path, "merge-base", "--is-ancestor", barrier.revision_sha, effectiveHead], { stdio: "ignore" }); }
      catch { throw new ValidationError("review repair commit must descend from the reviewed head", [{ path: "/", pointer: "/", field: "$", constraint: "ancestor", message: `${effectiveHead} is not a descendant of ${barrier.revision_sha}` }]); }
      const test = (this.store.db.prepare("SELECT dispatch_id,packet_json,result_json FROM dispatches WHERE run_id=? AND role='test' AND state='completed' ORDER BY completed_at DESC,created_at DESC").all(runId) as Array<{ dispatch_id: string; packet_json: string; result_json?: string }>)
        .find(({ packet_json, result_json }) => {
          const packet = JSON.parse(packet_json) as { context?: Record<string, unknown> };
          const result = JSON.parse(result_json ?? "{}") as { payload?: { testedCommit?: unknown } };
          return [packet.context?.implementation_commit, packet.context?.conflict_resolution_commit, result.payload?.testedCommit].includes(effectiveHead);
        });
      const artifact = test ? this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, test.dispatch_id) as { artifact_id: string; sha256: string } | undefined : undefined;
      if (!test || !artifact) throw new ValidationError("review repair requires a completed Test artifact bound to the repair commit", {
        repair_commit: effectiveHead,
        reviewed_commit: barrier.revision_sha,
      });
      verification = { dispatch_id: test.dispatch_id, artifact_id: artifact.artifact_id, digest: artifact.sha256, tested_commit: effectiveHead };
    }
    const insert = this.store.db.prepare("INSERT INTO finding_resolutions(barrier_id,finding_id,change_evidence,verification_evidence,created_at) VALUES (?,?,?,?,?)");
    const transaction = this.store.db.transaction(() => {
      if (barrier.state === "blocked") {
        for (const item of resolutions) insert.run(barrierId, item.finding_id, redact(item.change_evidence).slice(0, 16_384), redact(item.verification_evidence).slice(0, 16_384), new Date().toISOString());
      } else {
        const stored = this.store.db.prepare("SELECT finding_id,change_evidence,verification_evidence FROM finding_resolutions WHERE barrier_id=? ORDER BY finding_id")
          .all(barrierId) as FindingResolution[];
        const normalized = resolutions.map((item) => ({
          finding_id: item.finding_id,
          change_evidence: redact(item.change_evidence).slice(0, 16_384),
          verification_evidence: redact(item.verification_evidence).slice(0, 16_384),
        })).sort((left, right) => left.finding_id.localeCompare(right.finding_id));
        if (stableJson(stored) !== stableJson(normalized)) {
          throw new ValidationError("resolved review evidence does not match its persisted finding resolutions", [{
            path: "/", pointer: "/", field: "$", constraint: "const", message: "idempotent repair recovery requires the original P0/P1 resolution mappings",
          }]);
        }
      }
      this.store.db.prepare("UPDATE review_barriers SET state='resolved',repair_commit=?,verification_evidence=? WHERE barrier_id=?")
        .run(effectiveHead === barrier.revision_sha ? null : effectiveHead, verification ? stableJson(verification) : null, barrierId);
    });
    transaction();
    new DispatchService(this.store).reconcileReview(runId, barrierId);
    return { state: "resolved" };
  }

  status(runId: string, barrierId?: string, revisionSha?: string): Record<string, unknown> {
    if (Boolean(barrierId) === Boolean(revisionSha)) throw new ValidationError("review status requires exactly one barrier id or revision sha");
    const barrier = barrierId
      ? this.barrier(runId, barrierId)
      : this.store.db.prepare("SELECT * FROM review_barriers WHERE run_id=? AND revision_sha=?").get(runId, revisionSha) as any;
    if (!barrier) throw new ValidationError("review barrier was not found for run and revision");
    const axes = barrier.axes_json ? JSON.parse(barrier.axes_json) : barrier.formal ? ["spec", "standards"] : ["standards"];
    const aggregate = barrier.aggregate_json ? JSON.parse(barrier.aggregate_json) : { status: barrier.state, axes };
    const leafDispatches = [barrier.spec_dispatch_id, barrier.standards_dispatch_id].filter(Boolean).map((dispatchId: string) => {
      const leaf = this.store.db.prepare("SELECT dispatch_id,role,state,claimed_at,completed_at FROM dispatches WHERE dispatch_id=?").get(dispatchId);
      return leaf;
    });
    return {
      ...barrier,
      effective_reviewed_head: barrier.repair_commit ?? barrier.revision_sha,
      formal: Boolean(barrier.formal),
      axes,
      aggregate,
      result_artifact_digests: { spec: barrier.spec_result_digest ?? null, standards: barrier.standards_result_digest ?? null },
      leaf_dispatches: leafDispatches,
      results: this.results(barrier.barrier_id),
      resolutions: this.store.db.prepare("SELECT * FROM finding_resolutions WHERE barrier_id=? ORDER BY finding_id").all(barrier.barrier_id),
    };
  }

  current(runId: string): Record<string, unknown> | null {
    const row = this.store.db.prepare("SELECT barrier_id FROM review_barriers WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(runId) as { barrier_id: string } | undefined;
    return row ? this.status(runId, row.barrier_id) : null;
  }

  assertGate(runId: string, frozenHead?: string): void {
    const test = this.store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string } | undefined;
    const review = this.store.db.prepare("SELECT state,revision_sha,repair_commit,test_evidence_digest FROM review_barriers WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; revision_sha: string; repair_commit?: string; test_evidence_digest?: string } | undefined;
    if (!test || test.state !== "completed") throw new ValidationError("latest independent test dispatch has not completed");
    if (!review || !["passed", "resolved"].includes(review.state)) throw new ValidationError("review gate has not passed");
    const effectiveHead = review.repair_commit ?? review.revision_sha;
    if (frozenHead && frozenHead !== effectiveHead) {
      const operation = this.store.db.prepare("SELECT kind,evidence_json,completed_at FROM operations WHERE run_id=? AND kind IN ('git.sync','git.merge.continue') AND state='completed' ORDER BY completed_at DESC LIMIT 1").get(runId) as { kind: string; evidence_json: string; completed_at: string } | undefined;
      const evidence = operation ? JSON.parse(operation.evidence_json) as { commit?: string } : undefined;
      const latestTest = this.store.db.prepare("SELECT state,completed_at FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string; completed_at?: string } | undefined;
      let equivalentIntegratedTree = false;
      try {
        const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=(SELECT repo_id FROM runs WHERE run_id=?)").get(runId) as { project_path: string };
        execFileSync("git", ["-C", repository.project_path, "merge-base", "--is-ancestor", effectiveHead, frozenHead], { stdio: "ignore" });
        execFileSync("git", ["-C", repository.project_path, "diff", "--quiet", effectiveHead, frozenHead], { stdio: "ignore" });
        equivalentIntegratedTree = true;
      } catch { /* a changed tree requires a new review */ }
      if (!equivalentIntegratedTree && (!operation || evidence?.commit !== frozenHead || latestTest?.state !== "completed" || !latestTest.completed_at || latestTest.completed_at < operation.completed_at)) {
        throw new ValidationError("review is stale for the current integration HEAD", { reviewed: effectiveHead, current: frozenHead });
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
