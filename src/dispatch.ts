import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./constants.js";
import { checkResultEnvelope, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { ROLE_MANIFEST } from "./roles.js";
import { assertReadablePath, assertWritablePath } from "./security.js";
import { StateStore } from "./state.js";
import { assertRelativePosixPath, makeId, readJson, redact, sha256, stableJson, writeJson } from "./utils.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
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
    return this.insert(runId, role, validated);
  }

  createPlanningCommit(runId: string, packet: DispatchPacket): string {
    const run = this.store.getRun(runId) as { profile: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.profile !== "planning" || !run.plan_id || !run.revision) throw new ValidationError("planning commit requires a bound planning revision");
    const revision = this.store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
    if (revision?.state !== "plan_ready") throw new ValidationError("planning commit dispatch requires a plan_ready revision");
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND state!='failed'").get(runId) as { dispatch_id: string } | undefined;
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

  async validateFile(runId: string, dispatchId: string, role: Role, path: string): Promise<ResultEnvelope> {
    this.get(runId, dispatchId, role);
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    const result = checkResultEnvelope(await readJson(path));
    if (!result.valid) throw new ValidationError("result envelope is invalid", result.errors);
    if (result.value.run_id !== runId || result.value.dispatch_id !== dispatchId || result.value.role !== role) {
      throw new ValidationError("result envelope identity does not match dispatch");
    }
    return result.value;
  }

  async submit(runId: string, dispatchId: string, role: Role, path: string): Promise<{ reused: boolean; artifact: string }> {
    const row = this.get(runId, dispatchId, role);
    if (row.state === "completed") {
      const result = JSON.parse(row.result_json) as ResultEnvelope;
      const incoming = await this.validateFile(runId, dispatchId, role, path);
      if (stableJson(result) !== stableJson(incoming)) throw new ValidationError("dispatch was already submitted with a different result");
      return { reused: true, artifact: this.artifactPath(runId, dispatchId) };
    }
    if (row.state !== "claimed") throw new ValidationError("dispatch must be claimed before submit");
    const result = await this.validateFile(runId, dispatchId, role, path);
    const artifactDirectory = join(this.store.paths.artifacts, runId, dispatchId);
    await mkdir(artifactDirectory, { recursive: true });
    const artifact = this.artifactPath(runId, dispatchId);
    const redacted = redact(await readFile(path, "utf8"));
    await writeFile(artifact, redacted, { mode: 0o600 });
    const digest = sha256(redacted);
    const artifactId = `artifact_${digest.slice(0, 24)}`;
    const dispatchState = result.status === "completed" ? "completed" : result.status;
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state=?,result_json=?,completed_at=? WHERE dispatch_id=?").run(dispatchState, stableJson(result), new Date().toISOString(), dispatchId);
      this.store.db.prepare("INSERT OR IGNORE INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
        .run(artifactId, runId, dispatchId, artifact, digest, new Date().toISOString());
      this.store.event(runId, "dispatch.completed", { dispatchId, status: result.status, artifactId, digest });
      if (result.status === "completed") {
        if (role === "planning") this.advancePlanning(runId, result);
        else this.advanceRun(runId, role, result);
      } else {
        this.store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
          .run(result.status === "retryable_failure" ? "retryable_failure" : result.status === "needs_decision" ? "needs_decision" : "failed", new Date().toISOString(), runId);
      }
    });
    transaction();
    return { reused: false, artifact };
  }

  private advanceRun(runId: string, role: Role, result: ResultEnvelope): void {
    const run = this.store.getRun(runId) as { profile: string; stage: string; mode: string };
    const next: Role | null = role === "file-explorer" ? (run.profile === "planning" ? "planning" : "coding") : role === "coding" ? "test" : role === "test" ? "code-reviewer" : null;
    if (!next) return;
    const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role=? AND state!='completed'").get(runId, next);
    if (existing) return;
    const packet: DispatchPacket = {
      objective: next === "planning" ? "Produce the complete requirements checklist and identify one highest-priority pending question." : next === "coding" ? "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles." : next === "test" ? "Independently run the task tests, build, static checks, and regression commands." : "Prepare the required review packet from the frozen implementation evidence.",
      allowed_read_paths: role === "file-explorer" ? ((result.payload.allowed_read_paths as string[] | undefined) ?? []) : next === "test" ? ["test", "package.json", "tsconfig.json"] : ["package.json"],
      allowed_write_paths: [],
      acceptance_criteria: ["Return structured evidence", "Request support for unknown paths"],
      context: { stage: next },
    };
    const dispatchId = this.create(runId, next as Role, packet, run.profile as Role);
    this.store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(next, new Date().toISOString(), runId);
    this.store.event(runId, "run.stage_changed", { stage: next, dispatchId });
  }

  private advancePlanning(runId: string, result: ResultEnvelope): void {
    const payload = result.payload as { stage: string; pending_questions: string[]; decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string } | null };
    const run = this.store.getRun(runId) as { stage: string };
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
    if (payload.pending_questions.length && payload.stage !== "requirements" && payload.stage !== "tasks_preview") {
      throw new ValidationError(`planning stage ${payload.stage} cannot have pending questions`);
    }
    this.store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(payload.stage, new Date().toISOString(), runId);
    this.store.event(runId, "planning.stage_changed", { stage: payload.stage });
    if (payload.pending_questions.length === 1) {
      if (!payload.decision) throw new ValidationError("planning pending question requires one matching decision");
      this.store.createDecision(runId, payload.decision.question, payload.decision.choices, payload.decision.recommendation);
    }
  }

  continuePlanning(runId: string): string {
    const run = this.store.getRun(runId) as { profile: string; stage: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can continue planning");
    const pending = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (pending) throw new ValidationError("planning cannot continue with a pending decision");
    return this.create(runId, "planning", {
      objective: "Continue the planning workflow from the resolved user decision, asking at most one highest-priority question.",
      allowed_read_paths: ["package.json"], allowed_write_paths: [".ai-team/plans/**"],
      acceptance_criteria: ["Return the next planning stage", "Return at most one pending question"], context: { stage: run.stage },
    }, "planning");
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
