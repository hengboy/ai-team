
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Role } from "../constants.js";
import { type ResultEnvelope } from "../contracts.js";
import { ValidationError } from "../errors.js";
import { pathMatchesScope } from "../security.js";
import { StateStore } from "../state.js";
import { sha256, stableJson } from "../utils.js";
import { type ReviewResult } from "../review.js";
import { dispatchPacketSchema as packetSchema, dispatchPacketTemplate as packetTemplate, EXPLORER_CONTEXT_PATHS as PACKET_EXPLORER_CONTEXT_PATHS, mergeBindingsFromPacket as packetMergeBindings, promptFor as renderPrompt, promptForV2 as renderPromptV2, promptForV3 as renderPromptV3, RENDERER_VERSION as PACKET_RENDERER_VERSION, validatePacket as validateDispatchPacket } from "./packet.js";
import { type ExecutionContract, type ExecutionRequest } from "../execution-contract.js";
import { type NextAction, type TimelineEntry } from "../run-recovery.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
  execution_request?: ExecutionRequest;
  execution_contract?: ExecutionContract;
}

export interface MergeWorktreeBindings {
  integration_worktree_id: string | null;
  task_worktree_ids: string[];
}

export const mergeBindingsFromPacket = (role: Role, packet: DispatchPacket): MergeWorktreeBindings | undefined => {
  return packetMergeBindings(role, packet);
};

export interface RunResumeResult {
  run: Record<string, unknown>;
  pending_dispatches: Array<{ dispatch_id: string; role: string; state: string }>;
  pending_decision: Record<string, unknown> | null;
  pending_operations: Array<{ operation_id: string; kind: string; state: string }>;
  last_event: Record<string, unknown> | null;
  recovery: {
    state: "action_required";
    dispatch_id: string;
    side_effect_state: "completed" | "unknown";
    next_command: string | null;
    evidence_template?: Record<string, unknown>;
  } | null;
  timeline_tail: TimelineEntry[];
  next_actions: NextAction[];
  next_action: NextAction | null;
}

export interface DispatchContinuation {
  run_state: string;
  run_stage: string;
  pending_dispatches: Array<{ dispatch_id: string; role: string; state: string; depends_on: string[] }>;
  pending_decision: Record<string, unknown> | null;
}

export interface DispatchSubmission {
  reused: boolean;
  artifact: string;
  submission: {
    state: "submitted";
    dispatch_state: string;
    artifact_id: string;
    artifact: string;
    digest: string;
  };
  continuation: DispatchContinuation;
}

export interface DispatchBundle {
  reused: boolean;
  packet: DispatchPacket;
  prompt: string;
  schema: unknown;
  template: ResultEnvelope;
  packet_schema: unknown;
  packet_template: DispatchPacket;
  digests: { packet: string; prompt: string; schema: string; template: string };
  renderer_version: string;
  execution_enforcement: Record<string, unknown>;
}

export type ReplacementAction = "reissued" | "superseded" | "reconciled";
export type ReplacementResult<Action extends ReplacementAction> = {
  action: Action;
  dispatch_id: string;
  replacement_for: string;
  reused: boolean;
};

export interface ReviewBarrierRow {
  barrier_id: string;
  run_id: string;
  revision_sha: string;
  formal: number;
  state: string;
  repair_commit?: string;
  verification_evidence?: string;
  axes_json?: string;
  spec_dispatch_id?: string;
  standards_dispatch_id?: string;
}

export const RENDERER_VERSION = PACKET_RENDERER_VERSION;
export const EXPLORER_CONTEXT_PATHS = PACKET_EXPLORER_CONTEXT_PATHS;
export const dispatchPacketSchema = (role: Role, phase?: unknown, taskId?: unknown): Record<string, unknown> => {
  return packetSchema(role, phase, taskId);
};

export const dispatchPacketTemplate = (role: Role, packet: DispatchPacket): DispatchPacket => {
  return packetTemplate(role, packet);
};

export interface ImplementationSnapshot {
  coordinatorDispatchId: string;
  explorerDispatchId: string | null;
  authorizedPaths: string[];
  developerDispatchIds: string[];
  implementationDispatchId: string;
  implementationArtifact: { artifact_id: string; digest: string };
  implementationArtifacts: Array<{ task_id?: string; dispatch_id: string; artifact_id: string; digest: string }>;
  implementationCommit: string;
  implementationCommitted: boolean;
  changedPaths: string[];
  worktreeId: string;
  worktreePath: string;
  planId: string | null;
  revision: string | null;
  planDigest: string | null;
  frozenTaskIds: string[];
  testCommands: string[];
  testCommandProvenance: { explorer_dispatch_id: string; plan_id: string | null; revision: string | null; repo_id: string };
}

export const dirtyWorktreePaths = (worktreePath: string): string[] => {
  const tracked = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
};

export const successfulOutcome = (value: unknown): boolean => typeof value === "string"
  && ["passed", "success", "succeeded", "completed", "ok"].includes(value.trim().toLowerCase());

export const promptForV2 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV2(runId, dispatchId, role, packet),
].join("");
export const promptForV3 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV3(runId, dispatchId, role, packet),
].join("");
export const promptFor = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPrompt(runId, dispatchId, role, packet),
].join("");

export const validatePacket = (packet: unknown, role: Role): DispatchPacket => {
  return validateDispatchPacket(packet, role);
};

export const validateReviewResult = (result: ReviewResult): void => {
  if (!result.summary || !Array.isArray(result.findings)) throw new ValidationError("review result requires summary and findings");
  const ids = new Set<string>();
  for (const finding of result.findings) {
    if (!/^FIND-[A-Z]+-\d{3}$/.test(finding.finding_id)) throw new ValidationError(`invalid finding id: ${finding.finding_id}`);
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new ValidationError(`invalid finding severity: ${finding.finding_id}`);
    if (!finding.title || !finding.source || !finding.source_file || !Number.isInteger(finding.source_line) || finding.source_line < 1 || !finding.evidence || !finding.impact || !finding.recommendation) {
      throw new ValidationError(`finding lacks source, location, impact, or recommendation: ${finding.finding_id}`);
    }
    if (ids.has(finding.finding_id)) throw new ValidationError(`duplicate finding id: ${finding.finding_id}`);
    ids.add(finding.finding_id);
  }
};

export const assertExplorerAuthorization = (store: StateStore, runId: string, role: Role, packet: DispatchPacket): void => {
  if (role === "file-explorer") return;
  const context = packet.context as { explorer_dispatch_id?: string; path_authorization?: string[] };
  if (!context.explorer_dispatch_id) return;
  const explorer = store.db.prepare("SELECT state,role,result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, context.explorer_dispatch_id) as { state: string; role: string; result_json?: string } | undefined;
  if (!explorer || explorer.role !== "file-explorer" || explorer.state !== "completed" || !explorer.result_json) throw new ValidationError("downstream dispatch requires a completed Explorer dispatch");
  const payload = JSON.parse(explorer.result_json) as { payload?: { allowed_read_paths?: string[] } };
  const plannedPaths = (store.db.prepare("SELECT write_paths_json FROM run_tasks WHERE run_id=? AND write_paths_json IS NOT NULL").all(runId) as Array<{ write_paths_json: string }>)
    .flatMap(({ write_paths_json }) => JSON.parse(write_paths_json) as string[]);
  const authorized = [...(payload.payload?.allowed_read_paths ?? []), ...(context.path_authorization ?? []), ...plannedPaths];
  const unauthorized = packet.allowed_read_paths.filter((path) => !pathMatchesScope(path, authorized));
  if (unauthorized.length) throw new ValidationError("downstream read paths are not authorized by Explorer evidence", unauthorized.map((path) => ({
    path: "/allowed_read_paths",
    pointer: "/allowed_read_paths",
    field: "allowed_read_paths",
    constraint: "authorization",
    message: `unauthorized path: ${path}`,
  })));
};


export { StateStore } from "../state.js";

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

export const checkScope = (store: StateStore, runId: string, stage: "pre_commit", paths: string[], worktreeId: string, diagnostics: Record<string, unknown> = {}): { digest: string; complete: boolean } => {
  const run = store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
  if (run.mode !== "planned" || !run.plan_id || !run.revision) throw new ValidationError("planned pre_commit scope requires a planned run");
  const normalized = [...new Set(paths)].sort();
  if (!normalized.length) throw new ValidationError("scope cannot be empty");
  const digest = sha256(stableJson(normalized));
  const worktree = store.db.prepare("SELECT run_id,branch,path,state FROM worktrees WHERE worktree_id=?").get(worktreeId) as { run_id: string; branch: string; path: string; state: string } | undefined;
  const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
  const planRevision = `${run.plan_id}-${run.revision}`;
  const owned = worktree?.state === "active" && (worktree.run_id === runId || Boolean(repository && worktree.branch === `plan/${run.plan_id}/${planRevision}` && worktree.path === join(repository.project_path, ".worktrees", "plans", run.plan_id, planRevision)));
  if (!owned) throw new ValidationError("planned pre_commit worktree does not belong to run or plan revision");
  const previous = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1").get(runId, worktreeId) as { payload_json: string } | undefined;
  if (previous) {
    const existing = JSON.parse(previous.payload_json) as { digest: string; paths?: string[]; snapshot?: unknown };
    if (existing.digest !== digest) {
      const snapshot = plannedWorktreeSnapshot(worktree.path);
      store.db.prepare("UPDATE runs SET state='frozen',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      const unauthorized = [...new Set([...normalized.filter((file) => !(existing.paths ?? []).includes(file)), ...(existing.paths ?? []).filter((file) => !normalized.includes(file))])].sort();
      store.event(runId, "scope.pre_commit_drift", { worktree_id: worktreeId, offending_worktree_id: worktreeId, original_paths: existing.paths ?? [], original_digest: existing.digest, attempted_paths: normalized, attempted_digest: digest, unauthorized_paths: unauthorized, original_snapshot: existing.snapshot ?? null, snapshot, ...diagnostics });
      throw new ValidationError("planned pre_commit scope changed; run frozen", { ...diagnostics, offending_worktree_id: worktreeId, actual_modified_paths: normalized, pre_commit_paths: existing.paths ?? [], pre_commit_digest: existing.digest, unauthorized_paths: unauthorized });
    }
    return { digest, complete: true };
  }
  store.event(runId, "scope.pre_commit", { stage, digest, paths: normalized, worktree_id: worktreeId, snapshot: plannedWorktreeSnapshot(worktree.path) });
  return { digest, complete: true };
};

export const assertPreCommitScope = (store: StateStore, runId: string, paths: string[], worktreeId: string): void => {
  const digest = sha256(stableJson([...new Set(paths)].sort()));
  const event = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' AND json_extract(payload_json,'$.worktree_id')=? ORDER BY event_id DESC LIMIT 1").get(runId, worktreeId) as { payload_json: string } | undefined;
  if (!event || (JSON.parse(event.payload_json) as { digest?: string }).digest !== digest) throw new ValidationError("planned run has not passed pre_commit scope gate for this worktree");
};

export type DispatchOperations = Record<string, (store: StateStore, ops: DispatchOperations, ...args: any[]) => any> & {
  plannedTaskRows: (store: StateStore, ops: DispatchOperations, runId: string) => ReturnType<StateStore["runTasks"]>;
  continuation: (store: StateStore, ops: DispatchOperations, runId: string) => DispatchContinuation;
};
