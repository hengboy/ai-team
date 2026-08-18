import { join } from "node:path";
import type { StateStore } from "./state.js";

export interface ReviewWorktree {
  worktree_id: string;
  path: string;
  kind: "integration" | "plan" | "legacy integration";
}

export const resolveReviewWorktree = (store: StateStore, runId: string): ReviewWorktree | undefined => {
  const run = store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
  if (run.mode !== "planned") {
    const row = store.db.prepare("SELECT worktree_id,path FROM worktrees WHERE run_id=? AND branch LIKE 'integration/%' AND state='active' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { worktree_id: string; path: string } | undefined;
    return row ? { ...row, kind: "integration" } : undefined;
  }
  if (!run.plan_id || !run.revision) return undefined;
  const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?")
    .get(run.repo_id) as { project_path: string } | undefined;
  if (!repository) return undefined;

  const planRevision = `${run.plan_id}-${run.revision}`;
  const branch = `plan/${run.plan_id}/${planRevision}`;
  const path = join(repository.project_path, ".worktrees", "plans", run.plan_id, planRevision);
  const canonical = store.db.prepare("SELECT worktree_id,path FROM worktrees WHERE branch=? AND path=? AND state='active'")
    .get(branch, path) as { worktree_id: string; path: string } | undefined;
  if (canonical) return { ...canonical, kind: "plan" };

  const short = runId.slice(-8).toLowerCase();
  const legacyBranch = `integration/${run.plan_id}/${short}`;
  const legacyPath = join(repository.project_path, ".worktrees", "integration", run.plan_id, short);
  const legacy = store.db.prepare("SELECT worktree_id,path FROM worktrees WHERE run_id=? AND branch=? AND path=? AND state='active'")
    .get(runId, legacyBranch, legacyPath) as { worktree_id: string; path: string } | undefined;
  if (!legacy) return undefined;
  const created = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='run.created' ORDER BY event_id LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  const operation = store.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND kind='git.integration.create' AND state='completed'
    AND json_extract(request_json,'$.branch')=? AND json_extract(request_json,'$.path')=?`).get(runId, legacyBranch, legacyPath);
  try {
    return JSON.parse(created?.payload_json ?? "{}").mode === "planned" && operation
      ? { ...legacy, kind: "legacy integration" }
      : undefined;
  } catch {
    return undefined;
  }
};
