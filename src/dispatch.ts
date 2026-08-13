import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./constants.js";
import { checkResultEnvelope, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { ROLE_MANIFEST } from "./roles.js";
import { StateStore } from "./state.js";
import { makeId, readJson, redact, sha256, stableJson, writeJson } from "./utils.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
}

export class DispatchService {
  constructor(readonly store: StateStore) {}

  create(runId: string, role: Role, packet: DispatchPacket): string {
    this.store.getRun(runId);
    if (!packet.objective.trim() || !packet.acceptance_criteria.length) throw new ValidationError("dispatch packet requires objective and acceptance criteria");
    const broad = packet.allowed_read_paths.filter((path) => path === "**" || path.endsWith("/**"));
    if (role !== "file-explorer" && (broad.length || packet.allowed_read_paths.includes("."))) throw new ValidationError(`${role} requires exact allowed_read_paths`);
    const dispatchId = makeId("dispatch");
    const prompt = [
      `Role: ${role}`,
      `Dispatch: ${dispatchId}`,
      `Objective: ${packet.objective}`,
      `Allowed reads: ${packet.allowed_read_paths.join(", ") || "none"}`,
      `Allowed writes: ${packet.allowed_write_paths.join(", ") || "none"}`,
      `Return only a result matching the frozen schema. Request support for work outside this packet.`,
    ].join("\n");
    const template = createResultTemplate(runId, dispatchId, role);
    this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at)
      VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, stableJson(packet), prompt, stableJson(resultSchemaForRole(role)), stableJson(template), new Date().toISOString());
    this.store.event(runId, "dispatch.created", { dispatchId, role, prompt_digest: sha256(prompt) });
    return dispatchId;
  }

  private get(runId: string, dispatchId: string, role: Role): any {
    const row = this.store.db.prepare("SELECT * FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role);
    if (!row) throw new ValidationError("dispatch identity does not match run and role");
    return row;
  }

  claim(runId: string, dispatchId: string, role: Role): { reused: boolean; packet: DispatchPacket } {
    const row = this.get(runId, dispatchId, role);
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be claimed from ${row.state}`);
    const reused = row.state === "claimed";
    if (!reused) this.store.db.prepare("UPDATE dispatches SET state='claimed',claimed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
    return { reused, packet: JSON.parse(row.packet_json) as DispatchPacket };
  }

  prompt(runId: string, dispatchId: string, role: Role): string { return this.get(runId, dispatchId, role).prompt as string; }
  schema(runId: string, dispatchId: string, role: Role): unknown { return JSON.parse(this.get(runId, dispatchId, role).schema_json); }
  template(runId: string, dispatchId: string, role: Role): ResultEnvelope { return JSON.parse(this.get(runId, dispatchId, role).template_json) as ResultEnvelope; }

  async validateFile(runId: string, dispatchId: string, role: Role, path: string): Promise<ResultEnvelope> {
    this.get(runId, dispatchId, role);
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
    });
    transaction();
    if (result.status === "completed") this.advanceRun(runId, role, result);
    else this.store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?").run(result.status === "retryable_failure" ? "retryable_failure" : result.status === "needs_decision" ? "needs_decision" : "failed", new Date().toISOString(), runId);
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
    const dispatchId = this.create(runId, next as Role, packet);
    this.store.db.prepare("UPDATE runs SET stage=?,updated_at=? WHERE run_id=?").run(next, new Date().toISOString(), runId);
    this.store.event(runId, "run.stage_changed", { stage: next, dispatchId });
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
