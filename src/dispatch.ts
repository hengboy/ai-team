import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Role } from "./constants.js";
import { checkDecisionInput, checkResultEnvelope, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { ROLE_MANIFEST } from "./roles.js";
import { assertReadablePath, assertWritablePath } from "./security.js";
import { StateStore } from "./state.js";
import { assertRevisionRunStage } from "./planning.js";
import { assertRelativePosixPath, makeId, readJson, redact, sha256, stableJson, writeJson } from "./utils.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
}

export interface RunResumeResult {
  run: Record<string, unknown>;
  pending_dispatches: Array<{ dispatch_id: string; role: string; state: string }>;
  pending_decision: Record<string, unknown> | null;
  pending_operations: Array<{ operation_id: string; kind: string; state: string }>;
  last_event: Record<string, unknown> | null;
}

const RENDERER_VERSION = "dispatch-renderer-v2";

const promptFor = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  `Role: ${role}`,
  `Run: ${runId}`,
  `Dispatch: ${dispatchId}`,
  `Objective: ${packet.objective}`,
  `Allowed read paths: ${packet.allowed_read_paths.join(", ") || "none"}`,
  `Allowed write paths: ${packet.allowed_write_paths.join(", ") || "none"}`,
  `Acceptance criteria: ${packet.acceptance_criteria.join("; ")}`,
  `Context: ${stableJson(packet.context)}`,
  "Return only the frozen result envelope and role payload schema.",
].join("\n");

const validatePacket = (packet: unknown, role: Role): DispatchPacket => {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new ValidationError("dispatch packet must be an object");
  const value = packet as Record<string, unknown>;
  const allowed = new Set(["objective", "allowed_read_paths", "allowed_write_paths", "acceptance_criteria", "context"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError("dispatch packet has unknown fields", unknown.map((key) => `/${key}`));
  if (typeof value.objective !== "string" || !value.objective.trim()) throw new ValidationError("dispatch packet objective must be a non-empty string", ["/objective"]);
  for (const key of ["allowed_read_paths", "allowed_write_paths", "acceptance_criteria"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || !item.trim())) {
      throw new ValidationError(`dispatch packet ${key} must contain non-empty strings`, [`/${key}`]);
    }
  }
  if (!(value.context && typeof value.context === "object" && !Array.isArray(value.context))) throw new ValidationError("dispatch packet context must be an object", ["/context"]);
  if (!(value.acceptance_criteria as string[]).length) throw new ValidationError("dispatch packet requires acceptance criteria", ["/acceptance_criteria"]);
  const reads = value.allowed_read_paths as string[];
  const writes = value.allowed_write_paths as string[];
  for (const path of [...reads, ...writes]) {
    if (path !== "." && path !== "**") assertRelativePosixPath(path);
  }
  for (const path of reads) if (path !== "." && path !== "**") assertReadablePath(path);
  for (const path of writes) assertWritablePath(path);
  const broad = reads.filter((path) => path === "**" || path === "." || path.endsWith("/**"));
  if (role !== "file-explorer" && broad.length) throw new ValidationError(`${role} requires exact allowed_read_paths`);
  return value as unknown as DispatchPacket;
};

const assertExplorerAuthorization = (store: StateStore, runId: string, role: Role, packet: DispatchPacket): void => {
  if (role === "file-explorer") return;
  const context = packet.context as { explorer_dispatch_id?: string; path_authorization?: string[] };
  if (!context.explorer_dispatch_id) return;
  const explorer = store.db.prepare("SELECT state,role,result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, context.explorer_dispatch_id) as { state: string; role: string; result_json?: string } | undefined;
  if (!explorer || explorer.role !== "file-explorer" || explorer.state !== "completed" || !explorer.result_json) throw new ValidationError("downstream dispatch requires a completed Explorer dispatch");
  const payload = JSON.parse(explorer.result_json) as { payload?: { allowed_read_paths?: string[] } };
  const authorized = new Set([...(payload.payload?.allowed_read_paths ?? []), ...(context.path_authorization ?? [])]);
  const unauthorized = packet.allowed_read_paths.filter((path) => !authorized.has(path));
  if (unauthorized.length) throw new ValidationError("downstream read paths are not authorized by Explorer evidence", unauthorized);
};

export class DispatchService {
  constructor(readonly store: StateStore) {}

  create(runId: string, role: Role, packet: DispatchPacket, actorRole?: Role, actorDispatchId?: string): string {
    const run = this.store.getRun(runId) as { profile: Role };
    const actor = actorRole ?? run.profile;
    const reviewerActor = run.profile === "coding" && actor === "code-reviewer" && (role === "code-reviewer" || role === "review-spec" || role === "review-standards");
    if (actorRole && actorRole !== run.profile && !reviewerActor) throw new ValidationError(`${actorRole} cannot act for ${run.profile} run`);
    if (actorDispatchId) this.assertClaimed(runId, actorDispatchId, actor);
    this.assertCommandAllowed(actor, "dispatch create");
    const definition = ROLE_MANIFEST[actor];
    if (role !== actor && !definition.delegates.includes(role)) {
      throw new ValidationError(`${actor} cannot delegate to ${role}`);
    }
    const validated = validatePacket(packet, role);
    assertExplorerAuthorization(this.store, runId, role, validated);
    if (actorRole === "coding" && (role === "frontend-developer" || role === "backend-developer")) {
      const worktreeId = (validated.context as { worktree_id?: unknown }).worktree_id;
      if (typeof worktreeId !== "string" || !worktreeId) throw new ValidationError(`${role} dispatch requires context.worktree_id`, ["/context/worktree_id"]);
      const worktree = this.store.db.prepare("SELECT 1 FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId);
      if (!worktree) throw new ValidationError(`${role} dispatch requires a prepared active worktree`, ["/context/worktree_id"]);
    }
    return this.insert(runId, role, validated);
  }

  createPlanningCommit(runId: string, packet: DispatchPacket): string {
    const run = this.store.getRun(runId) as { profile: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.profile !== "planning" || !run.plan_id || !run.revision) throw new ValidationError("planning commit requires a bound planning revision");
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
    return this.insert(runId, "git-operator", validatePacket(packet, "git-operator"));
  }

  private insert(runId: string, role: Role, packet: DispatchPacket): string {
    const dispatchId = makeId("dispatch");
    const packetJson = redact(stableJson(packet));
    const frozenPacket = JSON.parse(packetJson) as DispatchPacket;
    const prompt = redact(promptFor(runId, dispatchId, role, frozenPacket));
    const template = createResultTemplate(runId, dispatchId, role);
    const schemaJson = stableJson(resultSchemaForRole(role));
    const templateJson = stableJson(template);
    const digests = { packet: sha256(packetJson), schema: sha256(schemaJson), template: sha256(templateJson), prompt: sha256(prompt) };
    const columns = new Set((this.store.db.prepare("PRAGMA table_info(dispatches)").all() as Array<{ name: string }>).map((item) => item.name));
    if (["packet_digest", "prompt_digest", "schema_digest", "template_digest", "renderer_version"].every((column) => columns.has(column))) {
      this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,packet_digest,prompt_digest,schema_digest,template_digest,renderer_version,created_at)
        VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, digests.packet, digests.prompt, digests.schema, digests.template, RENDERER_VERSION, new Date().toISOString());
    } else {
      this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at)
        VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, new Date().toISOString());
    }
    this.store.event(runId, "dispatch.created", { dispatchId, role, packet_digest: digests.packet, schema_digest: digests.schema, template_digest: digests.template, prompt_digest: digests.prompt, renderer_version: RENDERER_VERSION });
    return dispatchId;
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
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be claimed from ${row.state}`);
    const reused = row.state === "claimed";
    if (!reused) this.store.db.prepare("UPDATE dispatches SET state='claimed',claimed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
    return { reused, packet: JSON.parse(row.packet_json) as DispatchPacket };
  }

  prompt(runId: string, dispatchId: string, role: Role): string {
    const row = this.get(runId, dispatchId, role);
    const rendered = promptFor(runId, dispatchId, role, JSON.parse(row.packet_json) as DispatchPacket);
    if (row.renderer_version === RENDERER_VERSION && row.prompt_digest && row.prompt_digest !== sha256(rendered)) throw new ValidationError("dispatch prompt digest mismatch; frozen asset is corrupted");
    return rendered;
  }
  schema(runId: string, dispatchId: string, role: Role): unknown { return JSON.parse(this.get(runId, dispatchId, role).schema_json); }
  template(runId: string, dispatchId: string, role: Role): ResultEnvelope { return JSON.parse(this.get(runId, dispatchId, role).template_json) as ResultEnvelope; }

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
    const dispatch = this.get(runId, dispatchId, role) as { state: string };
    if (!["claimed", "completed", "needs_decision"].includes(dispatch.state)) {
      throw new ValidationError("dispatch must be claimed before validate");
    }
    const run = this.store.getRun(runId) as { state: string };
    const validRunState = dispatch.state === "needs_decision" ? run.state === "needs_decision" : run.state === "active";
    if (!validRunState) throw new ValidationError("run must be active before validate");
    const result = checkResultEnvelope(value);
    if (!result.valid) throw new ValidationError("result envelope is invalid", result.errors);
    if (result.value.run_id !== runId || result.value.dispatch_id !== dispatchId || result.value.role !== role) {
      throw new ValidationError("result envelope identity does not match dispatch");
    }
    return result.value;
  }

  async submit(runId: string, dispatchId: string, role: Role, path: string): Promise<{ reused: boolean; artifact: string }> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    const source = await readFile(path, "utf8");
    return this.submitValue(runId, dispatchId, role, JSON.parse(source), source);
  }

  async submitValue(runId: string, dispatchId: string, role: Role, value: unknown, source?: string): Promise<{ reused: boolean; artifact: string }> {
    const row = this.get(runId, dispatchId, role);
    if (["completed", "needs_decision"].includes(row.state) && row.result_json) {
      const result = JSON.parse(row.result_json) as ResultEnvelope;
      const incoming = this.validateValue(runId, dispatchId, role, value);
      if (stableJson(result) !== stableJson(incoming)) throw new ValidationError("dispatch was already submitted with a different result");
      return { reused: true, artifact: this.artifactPath(runId, dispatchId) };
    }
    if (row.state !== "claimed") throw new ValidationError("dispatch must be claimed before submit");
    const result = this.validateValue(runId, dispatchId, role, value);
    const artifactDirectory = join(this.store.paths.artifacts, runId, dispatchId);
    await mkdir(artifactDirectory, { recursive: true });
    const artifact = this.artifactPath(runId, dispatchId);
    const redacted = redact(source ?? `${JSON.stringify(value, null, 2)}\n`);
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
      if (result.status === "completed" || planningQuestion) {
        if (role === "planning") this.advancePlanning(runId, result);
        else this.advanceRun(runId, role, result);
      } else {
        if (result.status === "needs_decision") {
          const checked = checkDecisionInput(result.decisions_needed[0]);
          if (!checked.valid) throw new ValidationError("needs_decision result requires one typed decision", checked.errors);
          this.store.createDecision(runId, checked.value.question, checked.value.choices, checked.value.recommendation, checked.value.type ?? "workflow");
        }
        this.store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
          .run(result.status === "retryable_failure" ? "retryable_failure" : result.status === "needs_decision" ? "needs_decision" : "failed", new Date().toISOString(), runId);
      }
    });
    transaction();
    return { reused: false, artifact };
  }

  private advanceRun(runId: string, role: Role, result: ResultEnvelope): void {
    const run = this.store.getRun(runId) as { profile: string };
    if (role === "file-explorer") {
      const next = run.profile === "planning" ? "planning" : "coding";
      const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role=? AND state IN ('pending','claimed')").get(runId, next);
      if (existing) return;
      const dispatchId = this.create(runId, next, {
        objective: next === "planning" ? "Produce the complete requirements checklist and identify one highest-priority pending question." : "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles.",
        allowed_read_paths: (result.payload.allowed_read_paths as string[] | undefined) ?? [],
        allowed_write_paths: [],
        acceptance_criteria: ["Return structured evidence", "Request support for unknown paths"],
        context: { stage: next },
      }, run.profile as Role);
      if (next === "coding") this.ensureGitPrepareDispatch(runId);
      this.changeStage(runId, next, dispatchId);
      return;
    }
    if (["coding", "frontend-developer", "backend-developer", "git-operator"].includes(role)) {
      this.advanceImplementation(runId);
      return;
    }
    if (role === "test") this.advanceReview(runId, result);
  }

  private changeStage(runId: string, stage: string, dispatchId: string): void {
    this.store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(stage, new Date().toISOString(), runId);
    this.store.event(runId, "run.stage_changed", { stage, dispatchId });
  }

  private completedImplementationOperation(runId: string): { commit: string; paths: string[]; kind: string } | undefined {
    const rows = this.store.db.prepare("SELECT kind,evidence_json FROM operations WHERE run_id=? AND kind IN ('git.merge.task','git.commit') AND state='completed' ORDER BY completed_at DESC").all(runId) as Array<{ kind: string; evidence_json?: string }>;
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (/^[a-f0-9]{40}$/.test(evidence.commit ?? "")) return { commit: evidence.commit!, paths: evidence.paths ?? [], kind: row.kind };
      } catch { /* malformed legacy evidence is not implementation proof */ }
    }
    return undefined;
  }

  private ensureGitPrepareDispatch(runId: string): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state!='failed'
      AND json_extract(packet_json,'$.context.phase')='prepare_worktrees'
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = this.store.getRun(runId) as { base_commit?: string };
    return this.insert(runId, "git-operator", validatePacket({
      objective: "Prepare the integration worktree and implementation task worktree before developer dispatches are created.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Prepare one active integration worktree", "Prepare the implementation task worktree from the run base commit"],
      context: { stage: "git-operator", phase: "prepare_worktrees", task_id: "implementation", base_commit: run.base_commit ?? null },
    }, "git-operator"));
  }

  private ensureIntegrationDispatch(runId: string, taskWorktreeIds: string[], integrationWorktreeId: string): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state!='failed'
      AND json_extract(packet_json,'$.context.phase')='integrate_implementation'
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    return this.insert(runId, "git-operator", validatePacket({
      objective: "Merge every completed implementation task into the integration worktree before independent testing.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge every listed task worktree exactly once", "Return the frozen integration HEAD"],
      context: {
        stage: "git-operator",
        phase: "integrate_implementation",
        integration_worktree_id: integrationWorktreeId,
        task_worktree_ids: taskWorktreeIds,
      },
    }, "git-operator"));
  }

  private advanceImplementation(runId: string): void {
    const coordinator = this.store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND role='coding' ORDER BY created_at DESC LIMIT 1").get(runId) as { state: string } | undefined;
    const developers = this.store.db.prepare("SELECT state,result_json,packet_json FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')").all(runId) as Array<{ state: string; result_json?: string; packet_json: string }>;
    if (coordinator?.state !== "completed" || !developers.length || developers.some((item) => item.state !== "completed")) return;
    const developerWorktreeIds = developers.map((item) => {
      try { return (JSON.parse(item.packet_json) as { context?: { worktree_id?: string } }).context?.worktree_id; }
      catch { return undefined; }
    });
    if (developerWorktreeIds.some((value) => !value)) return;
    const taskWorktreeIds = [...new Set(developerWorktreeIds as string[])];
    const commitOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>;
    const committedWorktrees = new Set(commitOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.worktree_id === "string" ? [evidence.worktree_id] : []; }
      catch { return []; }
    }));
    if (taskWorktreeIds.some((worktreeId) => !committedWorktrees.has(worktreeId))) return;
    const integration = this.store.db.prepare("SELECT worktree_id,path FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as { worktree_id: string; path: string } | undefined;
    if (!integration) return;
    const mergeOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' ORDER BY completed_at").all(runId) as Array<{ evidence_json?: string }>;
    const mergedWorktrees = new Set(mergeOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.task_worktree_id === "string" ? [evidence.task_worktree_id] : []; }
      catch { return []; }
    }));
    if (taskWorktreeIds.some((worktreeId) => !mergedWorktrees.has(worktreeId))) {
      this.ensureIntegrationDispatch(runId, taskWorktreeIds, integration.worktree_id);
      return;
    }
    const implementation = this.completedImplementationOperation(runId);
    if (!implementation || implementation.kind !== "git.merge.task") return;
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (implementation.commit !== integrationHead) return;
    const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'").get(runId);
    if (existing) return;
    const modified = developers.flatMap((item) => {
      try { return (JSON.parse(item.result_json ?? "{}") as { payload?: { modified_paths?: string[] } }).payload?.modified_paths ?? []; }
      catch { return []; }
    });
    const paths = [...new Set([...implementation.paths, ...modified, "package.json"])] as string[];
    const dispatchId = this.insert(runId, "test", validatePacket({
      objective: `Independently verify implementation commit ${implementation.commit}.`,
      allowed_read_paths: paths,
      allowed_write_paths: [],
      acceptance_criteria: ["Run task tests, build, static checks, and regressions", "Bind evidence to the implementation commit"],
      context: { stage: "test", implementation_commit: implementation.commit, integration_worktree_id: integration.worktree_id, changed_paths: paths },
    }, "test"));
    this.changeStage(runId, "test", dispatchId);
  }

  private advanceReview(runId: string, result: ResultEnvelope): void {
    const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state!='failed'").get(runId);
    if (existing) return;
    const packet = this.buildReviewPacket(runId, result);
    if (!packet) return;
    const dispatchId = this.insert(runId, "code-reviewer", packet);
    this.changeStage(runId, "code-reviewer", dispatchId);
  }

  buildReviewPacket(runId: string, testResult?: ResultEnvelope, reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> }): DispatchPacket | undefined {
    const test = this.store.db.prepare("SELECT dispatch_id,state,result_json,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; state: string; result_json?: string; packet_json: string } | undefined;
    if (!test || test.state !== "completed" || !test.result_json) return undefined;
    const testPacket = JSON.parse(test.packet_json) as DispatchPacket;
    const testContext = testPacket.context as { implementation_commit?: string; changed_paths?: string[] };
    const revisionSha = testContext.implementation_commit;
    if (!revisionSha || !/^[a-f0-9]{40}$/.test(revisionSha)) return undefined;
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string; base_commit?: string };
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    const integration = this.store.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId) as { path: string } | undefined;
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
    const changedPaths = [...new Set([...(testContext.changed_paths ?? []), ...gitChangedPaths])];
    const planningPaths = run.plan_id && run.revision ? ["spec.md", "plan.md", "tasks.md"].map((name) => `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/${name}`) : [];
    const existingPlanningPaths = planningPaths.filter((path) => {
      try { execFileSync("git", ["-C", repository.project_path, "cat-file", "-e", `${revisionSha}:${path}`], { stdio: "ignore" }); return true; }
      catch { return false; }
    });
    const documentDigest = sha256(existingPlanningPaths.map((path) => `${path}\0${execFileSync("git", ["-C", repository.project_path, "show", `${revisionSha}:${path}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })}`).join("\n"));
    const frozenTestResult = testResult ?? JSON.parse(test.result_json) as ResultEnvelope;
    const testEvidenceDigest = sha256(stableJson(frozenTestResult));
    const diffDigest = sha256(committedDiff);
    const artifacts = this.store.db.prepare(`SELECT a.artifact_id,a.dispatch_id,a.kind,a.path,a.sha256,d.role
      FROM artifacts a JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND d.role IN ('coding','frontend-developer','backend-developer','git-operator','test')
      ORDER BY a.created_at,a.artifact_id`).all(runId) as Array<{ artifact_id: string; dispatch_id: string; kind: string; path: string; sha256: string; role: string }>;
    const revisionDigest = sha256(stableJson({ plan_id: run.plan_id ?? null, revision: run.revision ?? null, base_commit: baseCommit, revision_sha: revisionSha, document_digest: documentDigest, diff_digest: diffDigest, test_evidence_digest: testEvidenceDigest, artifact_digests: artifacts.map((artifact) => artifact.sha256) }));
    const allowedReadPaths = [...new Set([...changedPaths, ...existingPlanningPaths])];
    return validatePacket({
      objective: `Create the review barrier for frozen integration commit ${revisionSha}.`,
      allowed_read_paths: allowedReadPaths,
      allowed_write_paths: [],
      acceptance_criteria: ["Review the frozen integration commit", "Preserve all revision, document, diff, and test bindings"],
      context: {
        stage: "code-reviewer", implementation_commit: revisionSha, revision_sha: revisionSha, base_commit: baseCommit,
        plan_id: run.plan_id ?? null, revision: run.revision ?? null, plan_digest: run.plan_digest ?? null,
        changed_paths: changedPaths, document_digest: documentDigest,
        committed_diff: committedDiff, diff_digest: diffDigest, test_dispatch_id: test.dispatch_id, test_evidence: frozenTestResult,
        test_evidence_digest: testEvidenceDigest, artifacts, revision_digest: revisionDigest,
        ...(reissue ? { reissue: { decision_id: reissue.decision_id, dispatch_id: reissue.dispatch_id }, resolved_decision: reissue.resolved_decision ?? null } : {}),
      },
    }, "code-reviewer");
  }

  private advancePlanning(runId: string, result: ResultEnvelope): void {
    const payload = result.payload as { stage: string; pending_questions: string[]; decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string } | null };
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; stage: string };
    const transitions: Record<string, string[]> = {
      planning: ["requirements"],
      requirements: ["requirements", "requirements_confirmed"],
      requirements_confirmed: ["spec_ready"],
      spec_ready: ["plan_ready"],
      plan_ready: ["tasks_preview", "ready"],
      tasks_preview: ["tasks_preview", "ready"],
      ready: [],
    };
    if (!transitions[run.stage]?.includes(payload.stage)) throw new ValidationError(`invalid planning stage transition: ${run.stage} -> ${payload.stage}`);
    if (run.plan_id && run.revision) {
      const revision = this.store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
      if (!revision) throw new ValidationError("bound planning revision not found");
      assertRevisionRunStage(revision.state, payload.stage);
    }
    if (payload.pending_questions.length && payload.stage !== "requirements" && payload.stage !== "tasks_preview") {
      throw new ValidationError(`planning stage ${payload.stage} cannot have pending questions`);
    }
    const needsDecision = payload.pending_questions.length === 1;
    this.store.db.prepare("UPDATE runs SET stage=?,state=?,updated_at=? WHERE run_id=?")
      .run(payload.stage, needsDecision ? "needs_decision" : "active", new Date().toISOString(), runId);
    this.store.event(runId, "planning.stage_changed", { stage: payload.stage });
    if (needsDecision) {
      if (!payload.decision) throw new ValidationError("planning pending question requires one matching decision");
      this.store.createDecision(runId, payload.decision.question, payload.decision.choices, payload.decision.recommendation);
    } else if (payload.stage !== "ready") {
      this.continuePlanning(runId);
    }
  }

  continuePlanning(runId: string): string {
    const run = this.store.getRun(runId) as { profile: string; stage: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can continue planning");
    const pending = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (pending) throw new ValidationError("planning cannot continue with a pending decision");
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    return this.create(runId, "planning", {
      objective: "Continue the planning workflow from the current stage, asking at most one highest-priority question.",
      allowed_read_paths: ["package.json"], allowed_write_paths: [".ai-team/plans/**"],
      acceptance_criteria: ["Return the next planning stage", "Return at most one pending question"], context: { stage: run.stage },
    }, "planning");
  }

  resolvePlanningDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can resolve planning decisions");
    let dispatchId = "";
    this.store.db.transaction(() => {
      this.store.decide(runId, decisionId, choice, note);
      this.store.db.prepare(`UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=(
        SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state='needs_decision' ORDER BY created_at DESC LIMIT 1
      )`)
        .run(new Date().toISOString(), runId);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      dispatchId = this.continuePlanning(runId);
    })();
    return dispatchId;
  }

  resolveDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string };
    if (run.profile === "planning") return this.resolvePlanningDecision(runId, decisionId, choice, note);
    const existingDecision = this.store.db.prepare("SELECT status,choice,receipt_json FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string } | undefined;
    if (existingDecision?.status === "resolved") {
      const receipt = JSON.parse(existingDecision.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (choice === existingDecision.choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      const blocked = this.store.db.prepare("SELECT dispatch_id,role,packet_json FROM dispatches WHERE run_id=? AND state='needs_decision' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string } | undefined;
      if (!blocked) throw new ValidationError("run has no dispatch waiting on this decision");
      this.store.decide(runId, decisionId, choice, note);
      const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
      this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      let packet: DispatchPacket;
      if (choice === "reissue") {
        const reviewPacket = blocked.role === "code-reviewer"
          ? this.buildReviewPacket(runId, undefined, { decision_id: decisionId, dispatch_id: blocked.dispatch_id, resolved_decision: resolvedDecision })
          : undefined;
        if (blocked.role === "code-reviewer" && !reviewPacket) {
          throw new ValidationError("review reissue requires complete current integration and test evidence");
        }
        packet = reviewPacket ?? validatePacket({
          objective: `Reissue the ${blocked.role} stage after resolving decision ${decisionId}.`,
          allowed_read_paths: [],
          allowed_write_paths: [],
          acceptance_criteria: ["Use the resolved decision", "Return fresh evidence for the current run state"],
          context: {
            stage: blocked.role,
            resolved_decision: resolvedDecision,
            reissue: { decision_id: decisionId, dispatch_id: blocked.dispatch_id },
          },
        }, blocked.role);
      } else {
        const previous = JSON.parse(blocked.packet_json) as DispatchPacket;
        packet = validatePacket({ ...previous, context: { ...previous.context, resolved_decision: resolvedDecision } }, blocked.role);
      }
      dispatchId = this.insert(runId, blocked.role, packet);
      const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...resolvedDecision, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
      this.changeStage(runId, blocked.role, dispatchId);
    })();
    return dispatchId;
  }

  resume(runId: string): RunResumeResult {
    this.store.db.transaction(() => {
      const run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      const pendingDecision = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
      const pendingOperation = this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='pending'").get(runId);
      if (pendingDecision || pendingOperation) return;
      const pendingDispatch = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId);
      if (pendingDispatch) return;
      const retryableDispatch = run.state === "retryable_failure"
        ? this.store.db.prepare("SELECT dispatch_id,role,packet_json,result_json FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string; result_json?: string } | undefined
        : undefined;
      let retryableHasNoSideEffects = false;
      if (retryableDispatch?.result_json) {
        try {
          const result = JSON.parse(retryableDispatch.result_json) as { status?: string; side_effect_state?: string };
          retryableHasNoSideEffects = result.status === "retryable_failure" && result.side_effect_state === "none";
        } catch { /* corrupt legacy results remain blocked */ }
      }
      if (retryableDispatch && retryableHasNoSideEffects) {
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), retryableDispatch.dispatch_id);
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.insert(runId, retryableDispatch.role, JSON.parse(retryableDispatch.packet_json) as DispatchPacket);
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
    })();
    return {
      run: this.store.getRun(runId),
      pending_dispatches: this.store.db.prepare("SELECT dispatch_id,role,state FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").all(runId) as RunResumeResult["pending_dispatches"],
      pending_decision: (this.store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").get(runId) as Record<string, unknown> | undefined) ?? null,
      pending_operations: this.store.db.prepare("SELECT operation_id,kind,state FROM operations WHERE run_id=? AND state='pending'").all(runId) as RunResumeResult["pending_operations"],
      last_event: (this.store.db.prepare("SELECT type,payload_json,created_at FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined) ?? null,
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
