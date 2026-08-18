import { ValidationError } from "./errors.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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

export const plannedWorktreeSnapshot = (path: string): { head: string; dirty_paths: string[]; diff_digest: string } | null => {
  try {
    const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
    const dirtyPaths = [...new Set(status.map((entry) => entry.slice(3)))].sort();
    const trackedDiff = execFileSync("git", ["-C", path, "diff", "--binary", "--no-ext-diff", "HEAD"], { encoding: "utf8" });
    const untracked = status.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)).sort();
    const untrackedObjects = untracked.map((file) => `${file}\0${execFileSync("git", ["-C", path, "hash-object", "--", file], { encoding: "utf8" }).trim()}`);
    return /^[a-f0-9]{40}$/.test(head)
      ? { head, dirty_paths: dirtyPaths, diff_digest: sha256(`${trackedDiff}\0${untrackedObjects.join("\0")}`) }
      : null;
  } catch { return null; }
};

export class ScopeGate {
  constructor(readonly store: StateStore) {}

  private plannedWorktreeIsAuthorized(runId: string, worktreeId: string): boolean {
    const run = this.store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
    const row = this.store.db.prepare("SELECT run_id,branch,path,state FROM worktrees WHERE worktree_id=?").get(worktreeId) as {
      run_id: string; branch: string; path: string; state: string;
    } | undefined;
    if (!row || row.state !== "active") return false;
    if (row.run_id === runId) return true;
    if (run.mode !== "planned" || !run.plan_id || !run.revision) return false;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    const planRevision = `${run.plan_id}-${run.revision}`;
    return Boolean(repository
      && row.branch === `plan/${run.plan_id}/${planRevision}`
      && row.path === join(repository.project_path, ".worktrees", "plans", run.plan_id, planRevision));
  }

  check(runId: string, stage: ScopeGateStage, paths: string[], worktreeId?: string, diagnostics: Record<string, unknown> = {}): { digest: string; complete: boolean } {
    const run = this.store.getRun(runId) as any;
    const direct = (["bug", "feature"] as string[]).includes(run.mode);
    if (!direct && run.mode !== "planned") throw new ValidationError("scope gate applies only to direct or planned coding runs");
    const normalized = [...new Set(paths)].sort();
    if (!normalized.length) throw new ValidationError("scope cannot be empty");
    const digest = sha256(stableJson(normalized));
    if (!direct) {
      if (stage !== "pre_commit") throw new ValidationError("planned runs support only the pre_commit scope gate");
      if (!worktreeId) throw new ValidationError("planned pre_commit scope requires a worktree id");
      if (!this.plannedWorktreeIsAuthorized(runId, worktreeId)) throw new ValidationError("planned pre_commit worktree does not belong to run or plan revision");
      const previous = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
        .get(runId, worktreeId) as { payload_json: string } | undefined;
      if (previous) {
        const existing = JSON.parse(previous.payload_json) as { digest: string; paths?: string[]; snapshot?: { head: string; dirty_paths: string[]; diff_digest: string } | null };
        if (existing.digest !== digest) {
          const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE worktree_id=?").get(worktreeId) as { path: string };
          const snapshot = plannedWorktreeSnapshot(worktree.path);
          this.store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
          const unauthorized = [...new Set([
            ...normalized.filter((path) => !(existing.paths ?? []).includes(path)),
            ...(existing.paths ?? []).filter((path) => !normalized.includes(path)),
          ])].sort();
          this.store.event(runId, "scope.pre_commit_drift", {
            worktree_id: worktreeId,
            offending_worktree_id: worktreeId,
            original_paths: existing.paths ?? [],
            original_digest: existing.digest,
            attempted_paths: normalized,
            attempted_digest: digest,
            unauthorized_paths: unauthorized,
            original_snapshot: existing.snapshot ?? null,
            snapshot,
            ...diagnostics,
          });
          throw new ValidationError("planned pre_commit scope changed; run frozen", {
            ...diagnostics,
            offending_worktree_id: worktreeId,
            actual_modified_paths: normalized,
            pre_commit_paths: existing.paths ?? [],
            pre_commit_digest: existing.digest,
            unauthorized_paths: unauthorized,
          });
        }
        return { digest, complete: true };
      }
      const worktree = this.store.db.prepare("SELECT path FROM worktrees WHERE worktree_id=?").get(worktreeId) as { path: string };
      this.store.event(runId, "scope.pre_commit", { stage, digest, paths: normalized, worktree_id: worktreeId, snapshot: plannedWorktreeSnapshot(worktree.path) });
      return { digest, complete: true };
    }
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

  assertPreCommit(runId: string, paths: string[], worktreeId: string): void {
    const digest = sha256(stableJson([...new Set(paths)].sort()));
    const event = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1")
      .get(runId, worktreeId) as { payload_json: string } | undefined;
    if (!event || (JSON.parse(event.payload_json) as { digest?: string }).digest !== digest) {
      throw new ValidationError("planned run has not passed pre_commit scope gate for this worktree");
    }
  }

  assertPassed(runId: string, stage: Exclude<ScopeGateStage, "pre_commit">): void {
    const event = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type=?").get(runId, `scope.${stage}`);
    if (!event) throw new ValidationError(`direct run has not passed ${stage} scope gate`);
  }
}
