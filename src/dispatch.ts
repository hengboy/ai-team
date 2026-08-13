import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./constants.js";
import { checkResultEnvelope, createResultTemplate, resultEnvelopeSchema, type ResultEnvelope } from "./contracts.js";
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
      VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, stableJson(packet), prompt, stableJson(resultEnvelopeSchema), stableJson(template), new Date().toISOString());
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
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(stableJson(result), new Date().toISOString(), dispatchId);
      this.store.db.prepare("INSERT OR IGNORE INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
        .run(artifactId, runId, dispatchId, artifact, digest, new Date().toISOString());
      this.store.event(runId, "dispatch.completed", { dispatchId, status: result.status, artifactId, digest });
    });
    transaction();
    return { reused: false, artifact };
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
