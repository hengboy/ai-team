import { ValidationError } from "./errors.js";
import { StateStore } from "./state.js";
import { sha256, stableJson } from "./utils.js";
import { DispatchService } from "./dispatch.js";

export const TRANSIENT_FAILURES = new Set(["network_timeout", "client_process", "temporary_resource"]);

export const retryTransient = async <T>(failureClass: string, action: (attempt: number) => Promise<T>): Promise<T> => {
  const attempts = TRANSIENT_FAILURES.has(failureClass) ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(attempt); } catch (error) { lastError = error; }
  }
  throw lastError;
};

export type ScopeGateStage = "triage" | "pre_write" | "pre_commit";

export class ScopeGate {
  constructor(readonly store: StateStore) {}

  check(runId: string, stage: ScopeGateStage, paths: string[]): { digest: string; complete: boolean } {
    const run = this.store.getRun(runId) as any;
    if (!(["bug", "feature"] as string[]).includes(run.mode)) throw new ValidationError("scope gate applies only to direct runs");
    const normalized = [...new Set(paths)].sort();
    if (!normalized.length) throw new ValidationError("direct scope cannot be empty");
    const digest = sha256(stableJson(normalized));
    const previous = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type LIKE 'scope.%' ORDER BY event_id").all(runId) as Array<{ payload_json: string }>;
    const existing = previous.map((row) => JSON.parse(row.payload_json) as { stage: ScopeGateStage; digest: string });
    if (existing.some((item) => item.digest !== digest)) {
      this.store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      throw new ValidationError("direct scope changed; run frozen and Planning handoff required");
    }
    if (existing.some((item) => item.stage === stage)) {
      if (stage === "pre_write") new DispatchService(this.store).ensureGitPrepareDispatch(runId, "implementation");
      return { digest, complete: stage === "pre_commit" };
    }
    const order: ScopeGateStage[] = ["triage", "pre_write", "pre_commit"];
    if (existing.length !== order.indexOf(stage)) throw new ValidationError(`scope gate out of order: ${stage}`);
    this.store.event(runId, `scope.${stage}`, { stage, digest, paths: normalized });
    if (stage === "pre_write") new DispatchService(this.store).ensureGitPrepareDispatch(runId, "implementation");
    return { digest, complete: stage === "pre_commit" };
  }

  assertPassed(runId: string, stage: Exclude<ScopeGateStage, "pre_commit">): void {
    const event = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type=?").get(runId, `scope.${stage}`);
    if (!event) throw new ValidationError(`direct run has not passed ${stage} scope gate`);
  }
}
