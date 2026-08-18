import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./constants.js";
import { checkDecisionInput, checkResultEnvelope, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "./contracts.js";
import { ValidationError } from "./errors.js";
import { ROLE_MANIFEST } from "./roles.js";
import { assertReadablePath, pathMatchesScope } from "./security.js";
import { StateStore } from "./state.js";
import { assertRevisionRunStage } from "./planning.js";
import { makeId, readJson, redact, sha256, stableJson, writeJson } from "./utils.js";
import type { ReviewFinding, ReviewResult } from "./review.js";
import { ScopeGate } from "./gates.js";
import { completedMergeOwnershipPartialEffect, resolveTaskIdentityWorktree, type MergeOwnershipPartialEffect } from "./worktree-ownership.js";
import { resolveReviewWorktree } from "./worktree-review.js";
import {
  dispatchPacketSchema as packetSchema,
  dispatchPacketTemplate as packetTemplate,
  EXPLORER_CONTEXT_PATHS as PACKET_EXPLORER_CONTEXT_PATHS,
  mergeBindingsFromPacket as packetMergeBindings,
  promptFor as renderPrompt,
  promptForV2 as renderPromptV2,
  promptForV3 as renderPromptV3,
  RENDERER_VERSION as PACKET_RENDERER_VERSION,
  validatePacket as validateDispatchPacket,
} from "./dispatch/packet.js";
import { buildContinueTestingPacket, buildReviewPacket as assembleReviewPacket, buildTestPacket, IMPLEMENTATION_TEST_COMMANDS as TEST_COMMANDS } from "./dispatch/implementation.js";
import { assertPlanningTransition, planningContinuationPacket, planningSubmissionIntent } from "./dispatch/planning.js";
import { isManagedPlannedRecovery, livenessRecoveryIntent, managedCleanupPacket, reconciliationIntent, reissuePacket, retryableResultHasNoSideEffects } from "./dispatch/recovery.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
}

export interface MergeWorktreeBindings {
  integration_worktree_id: string | null;
  task_worktree_ids: string[];
}

const mergeBindingsFromPacket = (role: Role, packet: DispatchPacket): MergeWorktreeBindings | undefined => {
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
  } | null;
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
}

type ReplacementAction = "reissued" | "superseded" | "reconciled";
type ReplacementResult<Action extends ReplacementAction> = {
  action: Action;
  dispatch_id: string;
  replacement_for: string;
  reused: boolean;
};

interface ReviewBarrierRow {
  barrier_id: string;
  run_id: string;
  revision_sha: string;
  formal: number;
  state: string;
  axes_json?: string;
  spec_dispatch_id?: string;
  standards_dispatch_id?: string;
}

const RENDERER_VERSION = PACKET_RENDERER_VERSION;
const EXPLORER_CONTEXT_PATHS = PACKET_EXPLORER_CONTEXT_PATHS;
const IMPLEMENTATION_TEST_COMMANDS = TEST_COMMANDS;

export const dispatchPacketSchema = (role: Role, phase?: unknown, taskId?: unknown): Record<string, unknown> => {
  return packetSchema(role, phase, taskId);
};

export const dispatchPacketTemplate = (role: Role, packet: DispatchPacket): DispatchPacket => {
  return packetTemplate(role, packet);
};

interface ImplementationSnapshot {
  coordinatorDispatchId: string;
  explorerDispatchId: string | null;
  authorizedPaths: string[];
  developerDispatchIds: string[];
  implementationDispatchId: string;
  implementationArtifact: { artifact_id: string; digest: string };
  implementationArtifacts: Array<{ dispatch_id: string; artifact_id: string; digest: string }>;
  implementationCommit: string;
  implementationCommitted: boolean;
  changedPaths: string[];
  worktreeId: string;
  worktreePath: string;
  planId: string | null;
  revision: string | null;
  planDigest: string | null;
}

const dirtyWorktreePaths = (worktreePath: string): string[] => {
  const tracked = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
};

const promptForV2 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV2(runId, dispatchId, role, packet),
].join("");
const promptForV3 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPromptV3(runId, dispatchId, role, packet),
].join("");
const promptFor = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  renderPrompt(runId, dispatchId, role, packet),
].join("");

const validatePacket = (packet: unknown, role: Role): DispatchPacket => {
  return validateDispatchPacket(packet, role);
};

const validateReviewResult = (result: ReviewResult): void => {
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

const assertExplorerAuthorization = (store: StateStore, runId: string, role: Role, packet: DispatchPacket): void => {
  if (role === "file-explorer") return;
  const context = packet.context as { explorer_dispatch_id?: string; path_authorization?: string[] };
  if (!context.explorer_dispatch_id) return;
  const explorer = store.db.prepare("SELECT state,role,result_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, context.explorer_dispatch_id) as { state: string; role: string; result_json?: string } | undefined;
  if (!explorer || explorer.role !== "file-explorer" || explorer.state !== "completed" || !explorer.result_json) throw new ValidationError("downstream dispatch requires a completed Explorer dispatch");
  const payload = JSON.parse(explorer.result_json) as { payload?: { allowed_read_paths?: string[] } };
  const authorized = [...(payload.payload?.allowed_read_paths ?? []), ...(context.path_authorization ?? [])];
  const unauthorized = packet.allowed_read_paths.filter((path) => !pathMatchesScope(path, authorized));
  if (unauthorized.length) throw new ValidationError("downstream read paths are not authorized by Explorer evidence", unauthorized);
};

export class DispatchService {
  constructor(readonly store: StateStore) {}

  create(runId: string, role: Role, packet: DispatchPacket, actorRole?: Role, actorDispatchId?: string): string {
    const run = this.store.getRun(runId) as { profile: Role };
    const actor = actorRole ?? run.profile;
    const reviewerActor = run.profile === "coding" && actor === "code-reviewer" && (role === "code-reviewer" || role === "review-spec" || role === "review-standards");
    if (actorRole && actorRole !== run.profile && !reviewerActor) throw new ValidationError(`${actorRole} cannot act for ${run.profile} run`);
    let actorPacket: DispatchPacket | undefined;
    if (actorDispatchId) {
      this.assertClaimed(runId, actorDispatchId, actor);
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?")
        .get(runId, actorDispatchId, actor) as { packet_json: string };
      actorPacket = JSON.parse(row.packet_json) as DispatchPacket;
    }
    this.assertCommandAllowed(actor, "dispatch create");
    const definition = ROLE_MANIFEST[actor];
    if (role !== actor && !definition.delegates.includes(role)) {
      throw new ValidationError(`${actor} cannot delegate to ${role}`);
    }
    const validated = validatePacket(packet, role);
    if (actorRole === "coding" && role === "git-operator" && validated.context.phase === "prepare_implementation_worktree" && /^TASK-\d{3}$/.test(String(validated.context.task_id ?? ""))) {
      if (validated.context.coordinator_dispatch_id !== actorDispatchId) {
        throw new ValidationError("planned task prepare packet must preserve its Coding coordinator identity", ["/context/coordinator_dispatch_id"]);
      }
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") {
      this.assertContinueTestingDelegation(actorDispatchId!, role, actorPacket, validated);
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_implementation") {
      this.assertContinueImplementationDelegation(actorDispatchId!, role, actorPacket, validated);
    }
    if (role === "file-explorer") {
      const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get((this.store.getRun(runId) as { repo_id: string }).repo_id) as { project_path: string } | undefined;
      const missing = repository ? EXPLORER_CONTEXT_PATHS.filter((path) => !existsSync(join(repository.project_path, path))) : [...EXPLORER_CONTEXT_PATHS];
      if (missing.length) throw new ValidationError("File Explorer packet requires initialized project context", missing.map((path) => ({
        path: `/${path}`, pointer: `/${path}`, constraint: "exists", message: `${path} does not exist`, suggestion: `Run ai-team init ${repository?.project_path ?? "<project>"} --yes, then retry the run start.`,
      })));
    }
    assertExplorerAuthorization(this.store, runId, role, validated);
    if (actorRole === "coding" && (role === "frontend-developer" || role === "backend-developer")) {
      const worktreeId = (validated.context as { worktree_id?: unknown }).worktree_id;
      if (typeof worktreeId !== "string" || !worktreeId) throw new ValidationError(`${role} dispatch requires context.worktree_id`, ["/context/worktree_id"]);
      const worktree = this.store.db.prepare("SELECT branch FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId) as { branch: string } | undefined;
      const plannedPlanWorktree = (this.store.getRun(runId) as { mode?: string }).mode === "planned" && worktree?.branch.startsWith("plan/");
      if (!worktree?.branch.startsWith("task/") && !plannedPlanWorktree) throw new ValidationError(`${role} dispatch requires a prepared active implementation worktree`, ["/context/worktree_id"]);
    }
    const dispatchId = this.insert(runId, role, validated);
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") this.changeStage(runId, "test", dispatchId);
    return dispatchId;
  }

  private assertContinueImplementationDelegation(actorDispatchId: string, role: Role, coordinator: DispatchPacket, packet: DispatchPacket): void {
    if (role !== "frontend-developer" && role !== "backend-developer") {
      throw new ValidationError("continue_implementation Coding dispatch can only delegate to a developer role");
    }
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = ["explorer_dispatch_id", "task_id", "worktree_id", "worktree_path"];
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_implementation developer packet must preserve its frozen task identity", mismatch.map((key) => `/context/${key}`));
  }

  private assertContinueTestingDelegation(actorDispatchId: string, role: Role, coordinator: DispatchPacket, packet: DispatchPacket): void {
    if (role !== "test") throw new ValidationError("continue_testing Coding dispatch can only delegate to Test");
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = [
      "explorer_dispatch_id", "plan_id", "revision", "plan_digest", "worktree_id", "worktree_path",
      "implementation_dispatch_id", "implementation_artifact", "implementation_commit", "implementation_committed", "test_commands",
    ];
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_testing Test packet must preserve its frozen implementation evidence", mismatch.map((key) => `/context/${key}`));
    if (stableJson(actual.test_commands) !== stableJson(IMPLEMENTATION_TEST_COMMANDS)) {
      throw new ValidationError("continue_testing Test packet requires the frozen test commands", ["/context/test_commands"]);
    }
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

  private insert(runId: string, role: Role, packet: DispatchPacket, replacementFor?: string): string {
    const dispatchId = makeId("dispatch");
    const packetJson = redact(stableJson(packet));
    const frozenPacket = JSON.parse(packetJson) as DispatchPacket;
    const prompt = redact(promptFor(runId, dispatchId, role, frozenPacket));
    const template = createResultTemplate(runId, dispatchId, role);
    if (role === "review-spec" || role === "review-standards") {
      const barrierId = (frozenPacket.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId === "string") template.payload = { barrier_id: barrierId, finding_ids: [] };
    }
    const schemaJson = stableJson(resultSchemaForRole(role));
    const templateJson = stableJson(template);
    const digests = { packet: sha256(packetJson), schema: sha256(schemaJson), template: sha256(templateJson), prompt: sha256(prompt) };
    const columns = new Set((this.store.db.prepare("PRAGMA table_info(dispatches)").all() as Array<{ name: string }>).map((item) => item.name));
    this.store.db.transaction(() => {
      if (["packet_digest", "prompt_digest", "schema_digest", "template_digest", "renderer_version"].every((column) => columns.has(column))) {
        this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,packet_digest,prompt_digest,schema_digest,template_digest,renderer_version,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, digests.packet, digests.prompt, digests.schema, digests.template, RENDERER_VERSION, new Date().toISOString());
      } else {
        this.store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, new Date().toISOString());
      }
      if (replacementFor) this.store.db.prepare("UPDATE dispatches SET replacement_for=? WHERE dispatch_id=?").run(replacementFor, dispatchId);
      const bindings = mergeBindingsFromPacket(role, frozenPacket);
      if (bindings) {
        if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) {
          throw new ValidationError("merge dispatch requires persisted integration and task worktree bindings");
        }
        const insertBinding = this.store.db.prepare(`INSERT INTO dispatch_worktree_bindings(dispatch_id,run_id,binding_kind,worktree_id,created_at)
          VALUES (?,?,?,?,?)`);
        const createdAt = new Date().toISOString();
        insertBinding.run(dispatchId, runId, "integration", bindings.integration_worktree_id, createdAt);
        for (const worktreeId of bindings.task_worktree_ids) insertBinding.run(dispatchId, runId, "task", worktreeId, createdAt);
        this.assertStoredMergeWorktreeBindings(runId, dispatchId, bindings.integration_worktree_id, bindings.task_worktree_ids, true);
      }
      this.store.event(runId, "dispatch.created", { dispatchId, role, replacement_for: replacementFor ?? null, packet_digest: digests.packet, schema_digest: digests.schema, template_digest: digests.template, prompt_digest: digests.prompt, renderer_version: RENDERER_VERSION });
    })();
    return dispatchId;
  }

  private recoveryReplacement(
    runId: string,
    failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string },
    resolvedDecision?: Record<string, unknown>,
    replacementFor = failed.dispatch_id,
    additionalVerification: unknown[] = [],
  ): string {
    const previous = JSON.parse(failed.packet_json) as DispatchPacket;
    const result = failed.result_json ? JSON.parse(failed.result_json) as ResultEnvelope : undefined;
    let root = failed;
    const lineagePackets: DispatchPacket[] = [previous];
    while (root.replacement_for) {
      const parent = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
        .get(runId, root.replacement_for) as typeof root | undefined;
      if (!parent) break;
      root = parent;
      lineagePackets.push(JSON.parse(parent.packet_json) as DispatchPacket);
    }
    const rootPacket = JSON.parse(root.packet_json) as DispatchPacket;
    const lineageRecovery = lineagePackets.map((packet) => (packet.context as { recovery?: { completed_verification?: unknown[]; source_artifact_id?: string | null; source_artifact_digest?: string | null; source_packet_digest?: string | null } }).recovery).filter(Boolean);
    const completedVerification = lineageRecovery.flatMap((recovery) => recovery?.completed_verification ?? []);
    const originalRecovery = [...lineageRecovery].reverse().find((recovery) => recovery?.source_packet_digest || recovery?.source_artifact_id);
    const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? ORDER BY created_at DESC LIMIT 1")
      .get(runId, failed.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const activeWorktree = this.store.db.prepare("SELECT worktree_id,path,branch FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { worktree_id: string; path: string; branch: string } | undefined;
    const adoption = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.worktree.adopt' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { evidence_json?: string } | undefined;
    const adoptionEvidence = adoption?.evidence_json ? JSON.parse(adoption.evidence_json) as { implementation_revision?: string } : undefined;
    const previousContext = previous.context as { worktree_id?: unknown; implementation_worktree_id?: unknown; recovery?: { completed_verification?: unknown[]; source_artifact_id?: string | null; source_artifact_digest?: string | null; source_packet_digest?: string | null } };
    const worktreeContext = activeWorktree && (typeof previousContext.worktree_id === "string" || typeof previousContext.implementation_worktree_id === "string") ? {
      worktree_id: activeWorktree.worktree_id,
      implementation_worktree_id: activeWorktree.worktree_id,
      implementation_worktree_path: activeWorktree.path,
      implementation_branch: activeWorktree.branch,
    } : {};
    const replaceOwnedLocation = (value: string): string => {
      if (!activeWorktree) return value;
      const previousPath = typeof (rootPacket.context as { implementation_worktree_path?: unknown }).implementation_worktree_path === "string"
        ? (rootPacket.context as { implementation_worktree_path: string }).implementation_worktree_path
        : undefined;
      const previousBranch = typeof (rootPacket.context as { implementation_branch?: unknown }).implementation_branch === "string"
        ? (rootPacket.context as { implementation_branch: string }).implementation_branch
        : undefined;
      return [[previousPath, activeWorktree.path], [previousBranch, activeWorktree.branch]].reduce(
        (text, [from, to]) => from && to ? text.replaceAll(from, to) : text,
        value,
      );
    };
    const packet = validatePacket({
      ...previous,
      objective: replaceOwnedLocation(previous.objective),
      acceptance_criteria: previous.acceptance_criteria.map(replaceOwnedLocation),
      context: {
        ...previous.context,
        ...worktreeContext,
        ...(adoptionEvidence?.implementation_revision ? { implementation_revision: adoptionEvidence.implementation_revision } : {}),
        ...(resolvedDecision ? { resolved_decision: resolvedDecision } : {}),
        recovery: {
          replacement_for: replacementFor,
          source_packet_digest: originalRecovery?.source_packet_digest ?? root.packet_digest ?? sha256(root.packet_json),
          source_artifact_id: originalRecovery?.source_artifact_id ?? artifact?.artifact_id ?? null,
          source_artifact_digest: originalRecovery?.source_artifact_digest ?? artifact?.sha256 ?? null,
          completed_verification: [...completedVerification, ...(result?.verification ?? []), ...additionalVerification],
        },
      },
    }, failed.role);
    return this.insert(runId, failed.role, packet, replacementFor);
  }

  private plannedOwnershipRecovery(
    runId: string,
    failed: { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string },
  ): string | undefined {
    if (failed.role !== "git-operator") return undefined;
    const run = this.store.getRun(runId) as { mode?: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.mode !== "planned" || !run.plan_id || !run.revision) return undefined;
    const packet = JSON.parse(failed.packet_json) as DispatchPacket;
    const context = packet.context as {
      phase?: unknown;
      integration_worktree_id?: unknown;
      task_id?: unknown;
      task_worktree_id?: unknown;
      task_worktree_ids?: unknown;
      implementation_worktree_id?: unknown;
      worktree_id?: unknown;
    };
    if (context.phase !== "integrate_implementation"
      || typeof context.integration_worktree_id !== "string"
      || !Array.isArray(context.task_worktree_ids)
      || context.task_worktree_ids.some((id) => typeof id !== "string")) return undefined;
    const worktreeIds = [...new Set([context.integration_worktree_id, ...(context.task_worktree_ids as string[])])];
    const rows = worktreeIds.map((worktreeId) => this.store.db.prepare(`SELECT w.worktree_id,w.run_id,w.branch,w.path,w.base_commit,r.repo_id
      FROM worktrees w JOIN runs r ON r.run_id=w.run_id WHERE w.worktree_id=? AND w.state='active'`).get(worktreeId) as {
        worktree_id: string; run_id: string; branch: string; path: string; base_commit: string; repo_id: string;
      } | undefined);
    if (rows.some((row) => !row || row.repo_id !== run.repo_id)) return undefined;
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) return undefined;
    const planRevision = `${run.plan_id}-${run.revision}`;
    const integration = rows[0]!;
    const expectedPlanPath = join(repository.project_path, ".worktrees", "plans", run.plan_id, planRevision);
    if (integration.branch !== `plan/${run.plan_id}/${planRevision}` || integration.path !== expectedPlanPath) return undefined;
    const tasks = rows.slice(1).map((row) => row!);
    if (tasks.some((row) => !row.branch.startsWith(`task/${run.plan_id}/${planRevision}--`))) return undefined;
    const foreignTasks = tasks.filter((row) => row.run_id !== runId);
    if (!foreignTasks.length) return undefined;
    const adoptionTasks = foreignTasks.map((row) => {
      const commit = execFileSync("git", ["-C", row.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const parents = execFileSync("git", ["-C", row.path, "rev-list", "--parents", "-n", "1", commit], { encoding: "utf8" }).trim().split(" ");
      if (parents.length !== 2 || parents[1] !== row.base_commit) return undefined;
      return { worktree_id: row.worktree_id, path: row.path, branch: row.branch, base_commit: row.base_commit, commit };
    });
    if (adoptionTasks.some((task) => !task)) return undefined;
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, failed.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = this.insert(runId, "git-operator", validatePacket({
      objective: "Restore this planned run's registered worktree ownership before retrying the frozen task merge.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Adopt only the listed clean task worktrees with their existing direct-child commits", "Do not adopt the plan worktree or perform the task merge in this dispatch"],
      context: {
        stage: "git-operator",
        phase: "reconcile_worktree_ownership",
        source_dispatch_id: failed.dispatch_id,
        integration_worktree_id: context.integration_worktree_id,
        ...(typeof context.task_id === "string" ? { task_id: context.task_id } : {}),
        ...(typeof context.task_worktree_id === "string" ? { task_worktree_id: context.task_worktree_id } : {}),
        task_worktree_ids: context.task_worktree_ids,
        ...(typeof context.implementation_worktree_id === "string" ? { implementation_worktree_id: context.implementation_worktree_id } : {}),
        ...(typeof context.worktree_id === "string" ? { worktree_id: context.worktree_id } : {}),
        worktree_ids: foreignTasks.map(({ worktree_id }) => worktree_id),
        task_worktrees: adoptionTasks,
        recovery: {
          replacement_for: failed.dispatch_id,
          source_packet_digest: failed.packet_digest ?? sha256(failed.packet_json),
        },
      },
    }, "git-operator"), failed.dispatch_id);
    this.store.event(runId, "worktree.ownership_reconcile_created", {
      dispatch_id: dispatchId,
      source_dispatch_id: failed.dispatch_id,
      worktree_ids: foreignTasks.map(({ worktree_id }) => worktree_id),
    });
    return dispatchId;
  }

  private plannedMergePartialEffect(
    runId: string,
    dispatch: { dispatch_id: string; role: Role; packet_json: string },
  ): MergeOwnershipPartialEffect | undefined {
    if (dispatch.role !== "git-operator") return undefined;
    let context: Record<string, unknown>;
    try { context = (JSON.parse(dispatch.packet_json) as DispatchPacket).context; }
    catch { return undefined; }
    if (context.phase !== "integrate_implementation" && context.phase !== "reconcile_worktree_ownership") return undefined;
    const bindings = this.mergeWorktreeBindings(runId, dispatch.dispatch_id);
    if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) return undefined;
    return completedMergeOwnershipPartialEffect(
      this.store,
      runId,
      bindings.integration_worktree_id,
      bindings.task_worktree_ids,
    );
  }

  mergeWorktreeBindings(runId: string, dispatchId?: string): MergeWorktreeBindings {
    if (!dispatchId) return { integration_worktree_id: null, task_worktree_ids: [] };
    const rows = this.store.db.prepare(`SELECT binding_kind,worktree_id FROM dispatch_worktree_bindings
      WHERE run_id=? AND dispatch_id=? ORDER BY binding_kind,worktree_id`).all(runId, dispatchId) as Array<{ binding_kind: "integration" | "task"; worktree_id: string }>;
    return {
      integration_worktree_id: rows.find(({ binding_kind }) => binding_kind === "integration")?.worktree_id ?? null,
      task_worktree_ids: rows.filter(({ binding_kind }) => binding_kind === "task").map(({ worktree_id }) => worktree_id),
    };
  }

  private assertStoredMergeWorktreeBindings(runId: string, dispatchId: string, integrationId: string, taskWorktreeIds: string[], exact = false): MergeWorktreeBindings {
    const actual = this.mergeWorktreeBindings(runId, dispatchId);
    const expected = [integrationId, ...taskWorktreeIds];
    const actualIds = [actual.integration_worktree_id, ...actual.task_worktree_ids].filter((id): id is string => Boolean(id));
    const missing = expected.filter((id) => !actualIds.includes(id));
    const unexpected = exact ? actualIds.filter((id) => !expected.includes(id)) : [];
    if (actual.integration_worktree_id !== integrationId || missing.length || unexpected.length) {
      throw new ValidationError(`merge-task dispatch ${dispatchId} has invalid managed worktree bindings: constraint=packet_worktree_binding; expected_worktree_ids=${JSON.stringify(expected)}; actual_bound_ids=${JSON.stringify(actualIds)}; missing_bindings=${JSON.stringify(missing)}; unexpected_bindings=${JSON.stringify(unexpected)}`);
    }
    return actual;
  }

  assertMergeWorktreeBindings(runId: string, dispatchId: string, integrationId: string, taskId: string): MergeWorktreeBindings & { task_id: string; task_worktree_id: string } {
    const actual = this.mergeWorktreeBindings(runId, dispatchId);
    const dispatch = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as DispatchPacket).context : {};
    const actualTaskId = typeof context.task_id === "string" ? context.task_id : null;
    const resolvedTask = resolveTaskIdentityWorktree(this.store, runId, taskId);
    const expectedTaskWorktreeId = resolvedTask.worktree_id;
    const packetTaskWorktreeId = typeof context.task_worktree_id === "string" ? context.task_worktree_id : null;
    const implementationWorktreeId = typeof context.implementation_worktree_id === "string" ? context.implementation_worktree_id : null;
    const actualTaskWorktreeId = packetTaskWorktreeId ?? implementationWorktreeId
      ?? (actual.task_worktree_ids.length === 1 ? actual.task_worktree_ids[0] : null);
    const packetIntegrationWorktreeId = typeof context.integration_worktree_id === "string" ? context.integration_worktree_id : null;
    const phase = context.phase ?? null;
    const valid = actualTaskId === taskId
      && actual.integration_worktree_id === integrationId
      && packetIntegrationWorktreeId === integrationId
      && actual.task_worktree_ids.includes(expectedTaskWorktreeId)
      && actualTaskWorktreeId === expectedTaskWorktreeId
      && (packetTaskWorktreeId === null || packetTaskWorktreeId === expectedTaskWorktreeId)
      && (implementationWorktreeId === null || implementationWorktreeId === expectedTaskWorktreeId)
      && phase === "integrate_implementation";
    if (!valid) {
      throw new ValidationError(`merge-task dispatch ${dispatchId} has invalid managed worktree bindings: constraint=packet_worktree_binding; expected_task_id=${taskId}; actual_task_id=${String(actualTaskId)}; expected_task_worktree_id=${expectedTaskWorktreeId}; actual_task_worktree_id=${String(actualTaskWorktreeId)}; expected_integration_worktree_id=${integrationId}; actual_integration_worktree_id=${String(actual.integration_worktree_id)}; actual_phase=${String(phase)}`);
    }
    return { ...actual, task_id: taskId, task_worktree_id: expectedTaskWorktreeId };
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

  claimBundle(runId: string, dispatchId: string, role: Role): DispatchBundle {
    const claimed = this.claim(runId, dispatchId, role);
    const row = this.get(runId, dispatchId, role) as {
      packet_json: string;
      schema_json: string;
      template_json: string;
      packet_digest?: string;
      prompt_digest?: string;
      schema_digest?: string;
      template_digest?: string;
      renderer_version?: string;
    };
    const prompt = this.prompt(runId, dispatchId, role);
    return {
      ...claimed,
      prompt,
      schema: JSON.parse(row.schema_json),
      template: JSON.parse(row.template_json) as ResultEnvelope,
      packet_schema: this.packetSchema(runId, dispatchId, role),
      packet_template: this.packetTemplate(runId, dispatchId, role),
      digests: {
        packet: row.packet_digest ?? sha256(row.packet_json),
        prompt: row.prompt_digest ?? sha256(prompt),
        schema: row.schema_digest ?? sha256(row.schema_json),
        template: row.template_digest ?? sha256(row.template_json),
      },
      renderer_version: row.renderer_version ?? RENDERER_VERSION,
    };
  }

  cancel(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): { action: "canceled"; reused: boolean } {
    this.assertLifecycleActor(runId, actorRole, "dispatch cancel");
    if (!reason.trim()) throw new ValidationError("dispatch cancellation requires a reason");
    const row = this.get(runId, dispatchId, role) as { state: string };
    const prior = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.canceled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (row.state === "failed" && prior) return { action: "canceled", reused: true };
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be canceled from ${row.state}`);
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      this.store.event(runId, "dispatch.canceled", { dispatchId, role, actor_role: actorRole, reason });
    })();
    return { action: "canceled", reused: false };
  }

  reissue(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reissued"> {
    const row = this.get(runId, dispatchId, role) as {
      state: string; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string;
    };
    const run = this.store.getRun(runId) as { state: string };
    if (row.state === "failed" && run.state === "failed") {
      this.assertLifecycleActor(runId, actorRole, "dispatch reissue");
      if (!reason.trim()) throw new ValidationError("dispatch reissue requires a reason");
      let result: { side_effect_state?: string };
      try { result = JSON.parse(row.result_json ?? ""); }
      catch { throw new ValidationError("failed dispatch reissue requires a valid result envelope"); }
      if (result.side_effect_state !== "none") throw new ValidationError("failed dispatch can be revived only when no side effect occurred");
      const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      if (existing) return { action: "reissued", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
      let replacementId = "";
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        replacementId = this.plannedOwnershipRecovery(runId, { dispatch_id: dispatchId, role, ...row })
          ?? this.recoveryReplacement(runId, { dispatch_id: dispatchId, role, ...row });
        this.store.event(runId, "dispatch.reissued", { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason, revived_run: true });
      })();
      return { action: "reissued", dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
    }
    return this.replaceDispatch(runId, dispatchId, role, actorRole, reason, "reissued", JSON.parse(row.packet_json) as DispatchPacket);
  }

  supersede(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, packet: DispatchPacket): ReplacementResult<"superseded"> {
    return this.replaceDispatch(runId, dispatchId, role, actorRole, reason, "superseded", validatePacket(packet, role));
  }

  reconcile(runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): ReplacementResult<"reconciled"> & { resumed_finalization?: boolean } {
    this.assertLifecycleActor(runId, actorRole, "dispatch reconcile");
    if (!reason.trim()) throw new ValidationError("dispatch reconciliation requires a reason");
    const row = this.get(runId, dispatchId, role) as {
      state: string;
      role: Role;
      packet_json: string;
      packet_digest?: string;
      result_json?: string;
      replacement_for?: string;
    };
    const prior = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (prior) {
      const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      const resumed = this.store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.reconciled' AND json_extract(payload_json,'$.dispatchId')=? AND json_extract(payload_json,'$.resumed_finalization')=1")
        .get(runId, dispatchId);
      if (!existing && resumed) return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: true, resumed_finalization: true };
      if (!existing) throw new ValidationError("reconciled dispatch is missing its replacement");
      return { action: "reconciled", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    const run = this.store.getRun(runId) as { state: string };
    if (row.state === "claimed" && run.state === "completed") {
      this.verifyFinalization(runId, dispatchId, true);
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "dispatch.reconciled", { dispatchId, role, actor_role: actorRole, reason, verified_side_effects: true, resumed_finalization: true });
      })();
      return { action: "reconciled", dispatch_id: dispatchId, replacement_for: dispatchId, reused: false, resumed_finalization: true };
    }
    if (row.state !== "retryable_failure") throw new ValidationError(`dispatch cannot be reconciled from ${row.state}`);
    let result: { status?: string; side_effect_state?: string };
    try { result = JSON.parse(row.result_json ?? ""); }
    catch { throw new ValidationError("dispatch reconciliation requires a valid retryable result envelope"); }
    const partialEffect = this.plannedMergePartialEffect(runId, { dispatch_id: dispatchId, ...row });
    if (result.status !== "retryable_failure" || (result.side_effect_state !== "completed" && !partialEffect)) {
      throw new ValidationError("dispatch reconciliation requires confirmed completed side effects", [
        { path: "/side_effect_state", pointer: "/side_effect_state", field: "side_effect_state", constraint: "const", message: "must equal completed" },
      ]);
    }
    let replacementId = "";
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
        .run(new Date().toISOString(), dispatchId);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      replacementId = this.recoveryReplacement(runId, { dispatch_id: dispatchId, ...row });
      this.store.event(runId, "dispatch.reconciled", {
        dispatchId,
        replacement_dispatch_id: replacementId,
        role,
        actor_role: actorRole,
        reason,
        side_effect_state: "completed",
        ...(partialEffect ? { ownership_operation_ids: partialEffect.operation_ids, merge_pending: true } : {}),
      });
    })();
    return { action: "reconciled", dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
  }

  finalizationContext(runId: string, dispatchId: string, requiredState: "claimed" | "completed" = "claimed"): {
    barrier_id: string;
    revision_sha: string;
    integration_worktree_id: string;
  } {
    const row = this.store.db.prepare("SELECT role,state,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?")
      .get(runId, dispatchId) as { role: string; state: string; packet_json: string } | undefined;
    if (!row || row.role !== "git-operator" || row.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = (JSON.parse(row.packet_json) as DispatchPacket).context as Record<string, unknown>;
    if (context.phase !== "finalize_integration"
      || typeof context.barrier_id !== "string"
      || typeof context.revision_sha !== "string"
      || typeof context.integration_worktree_id !== "string") {
      throw new ValidationError("Git Operator dispatch is not a bound finalize integration dispatch");
    }
    return {
      barrier_id: context.barrier_id,
      revision_sha: context.revision_sha,
      integration_worktree_id: context.integration_worktree_id,
    };
  }

  assertFinalizingCleanup(runId: string, dispatchId: string): void {
    const context = this.finalizationContext(runId, dispatchId);
    const barrier = this.store.db.prepare("SELECT state,revision_sha FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || barrier.revision_sha !== context.revision_sha) {
      throw new ValidationError("finalization review barrier is not passed for the requested revision");
    }
    const operation = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { evidence_json?: string } | undefined;
    const evidence = JSON.parse(operation?.evidence_json ?? "{}") as Record<string, unknown>;
    if (!operation || !/^[a-f0-9]{40}$/.test(String(evidence.commit ?? "")) || evidence.integration_head && evidence.integration_head !== context.revision_sha) {
      throw new ValidationError("finalization cleanup requires a completed integration side effect for the reviewed revision");
    }
  }

  verifyFinalization(runId: string, dispatchId: string, allowClaimed = false): Record<string, unknown> {
    const dispatch = this.store.db.prepare("SELECT state FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { state: string } | undefined;
    const requiredState = allowClaimed ? "claimed" : "completed";
    if (!dispatch || dispatch.state !== requiredState) throw new ValidationError(`final Git Operator dispatch must be ${requiredState}`);
    const context = this.finalizationContext(runId, dispatchId, requiredState);
    const run = this.store.getRun(runId) as { repo_id: string; target_branch: string };
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("run repository is not registered");
    const barrier = this.store.db.prepare("SELECT state,revision_sha FROM review_barriers WHERE run_id=? AND barrier_id=?")
      .get(runId, context.barrier_id) as { state: string; revision_sha: string } | undefined;
    if (!barrier || !["passed", "resolved"].includes(barrier.state) || barrier.revision_sha !== context.revision_sha) {
      throw new ValidationError("finalization barrier and revision binding could not be verified");
    }
    const operation = this.store.db.prepare("SELECT operation_id,request_json,evidence_json FROM operations WHERE run_id=? AND kind='git.integrate' AND state='completed' ORDER BY completed_at DESC LIMIT 1")
      .get(runId) as { operation_id: string; request_json: string; evidence_json?: string } | undefined;
    if (!operation) throw new ValidationError("completed integration operation was not found");
    const request = JSON.parse(operation.request_json) as Record<string, unknown>;
    const evidence = JSON.parse(operation.evidence_json ?? "{}") as Record<string, unknown>;
    const targetHead = execFileSync("git", ["-C", repository.project_path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const targetBranch = execFileSync("git", ["-C", repository.project_path, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const parents = execFileSync("git", ["-C", repository.project_path, "rev-list", "--parents", "-n", "1", targetHead], { encoding: "utf8" }).trim().split(" ");
    if (targetBranch !== run.target_branch || evidence.commit !== targetHead || parents.length !== 3 || parents[2] !== context.revision_sha) {
      throw new ValidationError("target HEAD and merge parents do not match the finalized revision");
    }
    if (evidence.target_parent && evidence.target_parent !== parents[1]) throw new ValidationError("integration target parent does not match recorded evidence");
    if (evidence.integration_head && evidence.integration_head !== context.revision_sha) throw new ValidationError("integration revision does not match recorded evidence");
    if (evidence.barrier_id && evidence.barrier_id !== context.barrier_id) throw new ValidationError("integration barrier does not match recorded evidence");
    if (request.integration_worktree_id && request.integration_worktree_id !== context.integration_worktree_id) throw new ValidationError("integration worktree lineage does not match final dispatch");
    const worktrees = this.store.db.prepare("SELECT worktree_id,path,branch,state FROM worktrees WHERE run_id=?").all(runId) as Array<{ worktree_id: string; path: string; branch: string; state: string }>;
    const listed = execFileSync("git", ["-C", repository.project_path, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const worktree of worktrees) {
      const cleanup = this.store.db.prepare(`SELECT state FROM operations WHERE run_id=? AND kind='git.cleanup'
        AND json_extract(request_json,'$.worktreeId')=? ORDER BY created_at DESC LIMIT 1`).get(runId, worktree.worktree_id) as { state: string } | undefined;
      let branchExists = false;
      try {
        execFileSync("git", ["-C", repository.project_path, "show-ref", "--verify", `refs/heads/${worktree.branch}`], { stdio: "ignore" });
        branchExists = true;
      } catch { /* absent branch is required cleanup evidence */ }
      if (worktree.state !== "removed" || cleanup?.state !== "completed" || listed.includes(`worktree ${worktree.path}`) || branchExists) {
        throw new ValidationError("finalization worktree cleanup could not be verified", { worktree_id: worktree.worktree_id });
      }
    }
    return {
      operation_id: operation.operation_id,
      target_head: targetHead,
      merge_parents: parents.slice(1),
      barrier_id: context.barrier_id,
      revision_sha: context.revision_sha,
      integration_worktree_id: context.integration_worktree_id,
      worktree_cleanup: worktrees.map(({ worktree_id }) => worktree_id),
    };
  }

  private assertLifecycleActor(runId: string, actorRole: Role, command: string): void {
    const run = this.store.getRun(runId) as { profile: Role };
    if (run.profile !== actorRole) throw new ValidationError(`${actorRole} cannot manage a ${run.profile} run dispatch`);
    this.assertCommandAllowed(actorRole, command);
  }

  private replaceDispatch<Action extends "reissued" | "superseded">(
    runId: string,
    dispatchId: string,
    role: Role,
    actorRole: Role,
    reason: string,
    action: Action,
    packet: DispatchPacket,
  ): ReplacementResult<Action> {
    this.assertLifecycleActor(runId, actorRole, `dispatch ${action === "reissued" ? "reissue" : "supersede"}`);
    if (!reason.trim()) throw new ValidationError(`dispatch ${action} requires a reason`);
    const row = this.get(runId, dispatchId, role) as { state: string; packet_json: string };
    if (!["pending", "claimed", "failed", "retryable_failure"].includes(row.state)) throw new ValidationError(`dispatch cannot be ${action} from ${row.state}`);
    assertExplorerAuthorization(this.store, runId, role, packet);
    const sourceBindings = this.mergeWorktreeBindings(runId, dispatchId);
    const replacementBindings = mergeBindingsFromPacket(role, packet);
    const sourcePacket = JSON.parse(row.packet_json) as DispatchPacket;
    const sourceTaskId = typeof sourcePacket.context.task_id === "string" ? sourcePacket.context.task_id : null;
    const replacementTaskId = typeof packet.context.task_id === "string" ? packet.context.task_id : null;
    if (sourceTaskId !== replacementTaskId) {
      throw new ValidationError(`replacement dispatch must preserve task identity: expected_task_id=${String(sourceTaskId)}; actual_task_id=${String(replacementTaskId)}`);
    }
    for (const key of ["task_worktree_id", "implementation_worktree_id"] as const) {
      const expected = typeof sourcePacket.context[key] === "string" ? sourcePacket.context[key] : null;
      const actual = typeof packet.context[key] === "string" ? packet.context[key] : null;
      if (expected !== actual) {
        throw new ValidationError(`replacement dispatch must preserve task worktree mapping: field=${key}; expected_task_worktree_id=${String(expected)}; actual_task_worktree_id=${String(actual)}`);
      }
    }
    if (sourceBindings.integration_worktree_id) {
      const sourceIds = [sourceBindings.integration_worktree_id, ...sourceBindings.task_worktree_ids].sort();
      const replacementIds = replacementBindings
        ? [replacementBindings.integration_worktree_id, ...replacementBindings.task_worktree_ids].filter((id): id is string => Boolean(id)).sort()
        : [];
      if (stableJson(sourceIds) !== stableJson(replacementIds)) {
        throw new ValidationError(`replacement dispatch must preserve managed worktree bindings: expected_worktree_ids=${JSON.stringify(sourceIds)}; actual_bound_ids=${JSON.stringify(replacementIds)}`);
      }
    }
    const packetJson = redact(stableJson(packet));
    const existing = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, dispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      if (existing.packet_json !== packetJson) throw new ValidationError("dispatch already has a different replacement");
      return { action, dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    let replacementId = "";
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      if (row.state === "retryable_failure") {
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      replacementId = this.insert(runId, role, packet, dispatchId);
      this.store.event(runId, `dispatch.${action}`, { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason });
    })();
    return { action, dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
  }

  prompt(runId: string, dispatchId: string, role: Role): string {
    const row = this.get(runId, dispatchId, role);
    const renderer = row.renderer_version === RENDERER_VERSION ? promptFor : row.renderer_version === "dispatch-renderer-v3" ? promptForV3 : promptForV2;
    const rendered = renderer(runId, dispatchId, role, JSON.parse(row.packet_json) as DispatchPacket);
    if (row.prompt_digest && row.prompt_digest !== sha256(rendered)) throw new ValidationError("dispatch prompt digest mismatch; frozen asset is corrupted");
    return rendered;
  }
  schema(runId: string, dispatchId: string, role: Role): unknown { return JSON.parse(this.get(runId, dispatchId, role).schema_json); }
  template(runId: string, dispatchId: string, role: Role): ResultEnvelope { return JSON.parse(this.get(runId, dispatchId, role).template_json) as ResultEnvelope; }
  packetSchema(runId: string, dispatchId: string, role: Role): unknown {
    const packet = JSON.parse(this.get(runId, dispatchId, role).packet_json) as DispatchPacket;
    return dispatchPacketSchema(role, packet.context.phase, packet.context.task_id);
  }
  packetTemplate(runId: string, dispatchId: string, role: Role): DispatchPacket {
    const packet = JSON.parse(this.get(runId, dispatchId, role).packet_json) as DispatchPacket;
    return dispatchPacketTemplate(role, packet);
  }

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
    const validRunState = dispatch.state === "needs_decision"
      ? run.state === "needs_decision"
      : dispatch.state === "completed" ? run.state === "active" || run.state === "completed" : run.state === "active";
    if (!validRunState) throw new ValidationError("run must be active before validate");
    const result = checkResultEnvelope(value);
    if (!result.valid) throw new ValidationError("result envelope is invalid", result.errors);
    if (result.value.run_id !== runId || result.value.dispatch_id !== dispatchId || result.value.role !== role) {
      throw new ValidationError("result envelope identity does not match dispatch");
    }
    return result.value;
  }

  async submit(runId: string, dispatchId: string, role: Role, path: string): Promise<DispatchSubmission> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    const source = await readFile(path, "utf8");
    return this.submitValue(runId, dispatchId, role, JSON.parse(source), source);
  }

  async submitValue(runId: string, dispatchId: string, role: Role, value: unknown, source?: string): Promise<DispatchSubmission> {
    const row = this.get(runId, dispatchId, role);
    const bindReviewBarrier = (result: ResultEnvelope): void => {
      if ((role !== "review-spec" && role !== "review-standards") || result.status !== "completed") return;
      const packet = JSON.parse(row.packet_json) as DispatchPacket;
      const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
      result.payload = { ...result.payload, barrier_id: barrierId };
    };
    if (["completed", "needs_decision"].includes(row.state) && row.result_json) {
      const result = JSON.parse(row.result_json) as ResultEnvelope;
      const incoming = this.validateValue(runId, dispatchId, role, value);
      bindReviewBarrier(incoming);
      if (stableJson(result) !== stableJson(incoming)) throw new ValidationError("dispatch was already submitted with a different result");
      const artifact = this.store.db.prepare("SELECT artifact_id,path,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, dispatchId) as { artifact_id: string; path: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("submitted dispatch result artifact is missing");
      return {
        reused: true,
        artifact: artifact.path,
        submission: { state: "submitted", dispatch_state: row.state, artifact_id: artifact.artifact_id, artifact: artifact.path, digest: artifact.sha256 },
        continuation: this.continuation(runId),
      };
    }
    if (row.state !== "claimed") throw new ValidationError("dispatch must be claimed before submit");
    const result = this.validateValue(runId, dispatchId, role, value);
    if (role === "git-operator" && result.status === "failed" && result.side_effect_state === "none") {
      const phase = ((JSON.parse(row.packet_json) as DispatchPacket).context as { phase?: unknown }).phase;
      if (phase === "integrate_implementation" || phase === "reconcile_worktree_ownership") {
        result.status = "retryable_failure";
      }
    }
    if (role === "git-operator" && result.status === "completed") {
      this.assertGitPrepareResult(runId, JSON.parse(row.packet_json) as DispatchPacket);
      const context = (JSON.parse(row.packet_json) as DispatchPacket).context;
      if (context.phase === "finalize_integration") this.verifyFinalization(runId, dispatchId, true);
    }
    if (role === "test" && result.status === "completed") {
      const packet = JSON.parse(row.packet_json) as DispatchPacket;
      const testedCommit = (packet.context as { implementation_commit?: unknown }).implementation_commit;
      if (typeof testedCommit === "string" && /^[a-f0-9]{40}$/.test(testedCommit)) {
        result.payload = { ...result.payload, testedCommit };
      }
    }
    bindReviewBarrier(result);
    const artifactDirectory = join(this.store.paths.artifacts, runId, dispatchId);
    await mkdir(artifactDirectory, { recursive: true });
    const artifact = this.artifactPath(runId, dispatchId);
    const redacted = redact(role === "test" || role === "review-spec" || role === "review-standards" ? `${JSON.stringify(result, null, 2)}\n` : source ?? `${JSON.stringify(value, null, 2)}\n`);
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
        else if (role === "review-spec" || role === "review-standards") {
          const packet = JSON.parse(row.packet_json) as DispatchPacket;
          const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
          if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
          this.reconcileReview(runId, barrierId);
        }
        else this.advanceRun(runId, role, result);
      } else {
        if (result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1) {
          const checked = checkDecisionInput(result.decisions_needed[0]);
          if (!checked.valid) throw new ValidationError("needs_decision result requires one typed decision", checked.errors);
          this.store.createDecision(runId, checked.value.question, checked.value.choices, checked.value.recommendation, checked.value.type ?? "workflow", dispatchId);
        }
        this.store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
          .run(result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1 ? "needs_decision" : result.status === "retryable_failure" ? "retryable_failure" : "failed", new Date().toISOString(), runId);
      }
    });
    transaction();
    return {
      reused: false,
      artifact,
      submission: { state: "submitted", dispatch_state: dispatchState, artifact_id: artifactId, artifact, digest },
      continuation: this.continuation(runId),
    };
  }

  continuation(runId: string): DispatchContinuation {
    const run = this.store.getRun(runId) as { state: string; stage: string };
    const pending = this.store.db.prepare("SELECT dispatch_id,role,state,packet_json,replacement_for FROM dispatches WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at,dispatch_id")
      .all(runId) as Array<{ dispatch_id: string; role: string; state: string; packet_json: string; replacement_for?: string }>;
    return {
      run_state: run.state,
      run_stage: run.stage,
      pending_dispatches: pending.map(({ packet_json, replacement_for, ...dispatch }) => {
        const context = (JSON.parse(packet_json) as DispatchPacket).context;
        const dependencies = Object.entries(context)
          .filter(([key, value]) => key.endsWith("_dispatch_id") && typeof value === "string")
          .map(([, value]) => value as string);
        if (replacement_for) dependencies.push(replacement_for);
        return { ...dispatch, depends_on: [...new Set(dependencies)] };
      }),
      pending_decision: (this.store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending' ORDER BY created_at,decision_id LIMIT 1")
        .get(runId) as Record<string, unknown> | undefined) ?? null,
    };
  }

  runShowProjection(runId: string): {
    continuation: DispatchContinuation;
    pending_dependencies: Array<{ dispatch_id: string; depends_on: string[] }>;
    suggested_commands: string[];
  } {
    const continuation = this.continuation(runId);
    const suggestedCommands = continuation.pending_dispatches.map((dispatch) => dispatch.state === "pending"
      ? `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --bundle`
      : `ai-team staging create --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --kind dispatch-result`);
    const decision = continuation.pending_decision as { decision_id?: unknown } | null;
    if (typeof decision?.decision_id === "string") {
      suggestedCommands.push(`ai-team run decide --run-id ${runId} --decision-id ${decision.decision_id} --choice <choice>`);
    }
    const run = this.store.getRun(runId) as { state: string };
    if (!suggestedCommands.length && run.state === "active") suggestedCommands.push(`ai-team run resume ${runId}`);
    return {
      continuation,
      pending_dependencies: continuation.pending_dispatches.map(({ dispatch_id, depends_on }) => ({ dispatch_id, depends_on })),
      suggested_commands: suggestedCommands,
    };
  }

  private advanceRun(runId: string, role: Role, result: ResultEnvelope): void {
    const run = this.store.getRun(runId) as { profile: string; mode?: string };
    if (role === "file-explorer") {
      const next = run.profile === "planning" ? "planning" : "coding";
      const existing = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND role=? AND state IN ('pending','claimed')").get(runId, next);
      if (existing) return;
      if (next === "coding" && run.mode === "planned") {
        const dispatchId = this.ensureGitPrepareDispatch(runId, "integration", result.dispatch_id);
        this.changeStage(runId, "git-operator", dispatchId);
        return;
      }
      const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, result.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("completed File Explorer result artifact is missing");
      const dispatchId = this.create(runId, next, {
        objective: next === "planning" ? "Produce the complete requirements checklist and identify one highest-priority pending question." : "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles.",
        allowed_read_paths: (result.payload.allowed_read_paths as string[] | undefined) ?? [],
        allowed_write_paths: [],
        acceptance_criteria: ["Return structured evidence", "Request support for unknown paths"],
        context: {
          stage: next,
          explorer_dispatch_id: result.dispatch_id,
          explorer_result: {
            findings: result.findings,
            payload: result.payload,
            artifact_id: artifact.artifact_id,
            digest: artifact.sha256,
            project_context: result.payload.project_context,
          },
        },
      }, run.profile as Role);
      if (next === "coding") this.ensureGitPrepareDispatch(runId, "integration", result.dispatch_id);
      this.changeStage(runId, next, dispatchId);
      return;
    }
    if (role === "git-operator") {
      const row = this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(result.dispatch_id) as { packet_json: string } | undefined;
      const context = row ? (JSON.parse(row.packet_json) as DispatchPacket).context as { phase?: unknown; explorer_dispatch_id?: unknown; reconciliation?: unknown; source_dispatch_id?: unknown } : {};
      if (run.mode === "planned" && context.phase === "prepare_worktrees") {
        if (typeof context.explorer_dispatch_id === "string") this.createPlannedCodingDispatch(runId, context.explorer_dispatch_id, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && context.phase === "prepare_implementation_worktree") {
        this.ensurePlannedTaskContinuation(runId, result.dispatch_id);
        return;
      }
      if (run.mode === "planned" && context.phase === "reconcile_worktree_ownership") {
        if (typeof context.source_dispatch_id !== "string") throw new ValidationError("ownership reconciliation is missing its source merge dispatch");
        const failed = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND dispatch_id=?")
          .get(runId, context.source_dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined;
        if (!failed) throw new ValidationError("ownership reconciliation source merge dispatch was not found");
        this.recoveryReplacement(runId, failed, undefined, result.dispatch_id, result.verification);
        return;
      }
      if (context.phase === "cancel_cleanup") {
        this.store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.canceled", { cleanup_dispatch_id: result.dispatch_id, reconciliation: context.reconciliation ?? null });
        return;
      }
      if (context.phase === "finalize_integration") {
        const unfinished = this.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')")
          .get(runId) as { count: number };
        if (unfinished.count) throw new ValidationError("run cannot complete while dispatches remain pending or claimed");
        this.store.db.prepare("UPDATE runs SET state='completed',stage='completed',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.completed", { final_dispatch_id: result.dispatch_id });
        return;
      }
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
    const rows = this.store.db.prepare("SELECT kind,evidence_json FROM operations WHERE run_id=? AND kind IN ('git.merge.task','git.commit') AND state='completed' ORDER BY completed_at DESC, CASE kind WHEN 'git.merge.task' THEN 0 ELSE 1 END").all(runId) as Array<{ kind: string; evidence_json?: string }>;
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json ?? "{}") as { commit?: string; paths?: string[] };
        if (/^[a-f0-9]{40}$/.test(evidence.commit ?? "")) return { commit: evidence.commit!, paths: evidence.paths ?? [], kind: row.kind };
      } catch { /* malformed legacy evidence is not implementation proof */ }
    }
    return undefined;
  }

  private activeIntegrationWorktree(runId: string): { worktree_id: string; path: string } | undefined {
    return resolveReviewWorktree(this.store, runId);
  }

  private createPlannedCodingDispatch(runId: string, explorerDispatchId: string | undefined, gitDispatchId: string): string {
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const explorer = explorerDispatchId
      ? this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned Coding dispatch requires its completed Explorer dependency");
    const result = JSON.parse(explorer.result_json) as ResultEnvelope;
    const worktree = this.activeIntegrationWorktree(runId);
    if (!worktree) throw new ValidationError("planned Coding dispatch requires the verified plan worktree");
    const dispatchId = this.create(runId, "coding", {
      objective: "Create an implementation plan from the exact File Explorer scope and dispatch the implementation roles.",
      allowed_read_paths: (result.payload.allowed_read_paths as string[] | undefined) ?? [],
      allowed_write_paths: [],
      acceptance_criteria: ["Use the verified run-owned plan worktree", "Create Task worktrees only for a frozen plan with multiple explicit TASK files"],
      context: {
        stage: "coding",
        explorer_dispatch_id: explorerDispatchId,
        git_operator_dispatch_id: gitDispatchId,
        worktree_id: worktree.worktree_id,
        plan_worktree_path: worktree.path,
      },
    }, "coding");
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensurePlannedTaskContinuation(runId: string, prepareDispatchId?: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; mode?: string; state: string; plan_id?: string; revision?: string };
    if (run.profile !== "coding" || run.mode !== "planned" || run.state !== "active") return undefined;
    const prepare = (prepareDispatchId
      ? this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'`).get(runId, prepareDispatchId)
      : this.store.db.prepare(`SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='git-operator' AND state='completed'
          AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree' ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!prepare) return undefined;
    const preparePacket = JSON.parse(prepare.packet_json) as DispatchPacket;
    const prepareContext = preparePacket.context as Record<string, unknown>;
    const taskId = typeof prepareContext.task_id === "string" ? prepareContext.task_id : "";
    if (!/^TASK-\d{3}$/.test(taskId)) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='coding' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')='continue_implementation'
      AND json_extract(packet_json,'$.context.prepare_git_dispatch_id')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, prepare.dispatch_id) as { dispatch_id: string; state: string } | undefined;
    if (existing) return existing.state === "pending" || existing.state === "claimed" ? existing.dispatch_id : undefined;
    const taskKey = taskId.toLowerCase();
    const worktree = this.store.db.prepare(`SELECT worktree_id,path FROM worktrees WHERE run_id=? AND state='active'
      AND (branch LIKE ? OR branch LIKE ?) ORDER BY created_at DESC LIMIT 1`)
      .get(runId, `task/%/${taskKey}`, `task/%--${taskKey}`) as { worktree_id: string; path: string } | undefined;
    if (!worktree) throw new ValidationError("planned task continuation requires the prepared task worktree");
    const developer = this.store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer') AND state!='failed'
      AND json_extract(packet_json,'$.context.worktree_id')=?`).get(runId, worktree.worktree_id);
    if (developer) return undefined;
    const requestedCoordinatorId = typeof prepareContext.coordinator_dispatch_id === "string" ? prepareContext.coordinator_dispatch_id : undefined;
    const coordinator = (requestedCoordinatorId
      ? this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='coding' AND state='completed'").get(runId, requestedCoordinatorId)
      : this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) throw new ValidationError("planned task continuation requires its completed Coding coordinator");
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const explorerDispatchId = typeof prepareContext.explorer_dispatch_id === "string"
      ? prepareContext.explorer_dispatch_id
      : typeof coordinatorPacket.context.explorer_dispatch_id === "string" ? coordinatorPacket.context.explorer_dispatch_id : undefined;
    const explorer = explorerDispatchId
      ? this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, explorerDispatchId) as { result_json?: string } | undefined
      : undefined;
    if (!explorer?.result_json) throw new ValidationError("planned task continuation requires its completed Explorer authorization");
    const explorerResult = JSON.parse(explorer.result_json) as ResultEnvelope;
    const authorizedPaths = explorerResult.payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) throw new ValidationError("planned task continuation requires valid Explorer paths");
    const packet = validatePacket({
      objective: `Continue ${taskId} by dispatching one developer role in its prepared task worktree.`,
      allowed_read_paths: authorizedPaths,
      allowed_write_paths: [],
      acceptance_criteria: ["Dispatch a developer with the frozen task worktree identity", "Preserve the completed Explorer authorization and prepare lineage"],
      context: {
        stage: "coding",
        phase: "continue_implementation",
        explorer_dispatch_id: explorerDispatchId,
        coordinator_dispatch_id: coordinator.dispatch_id,
        prepare_git_dispatch_id: prepare.dispatch_id,
        task_id: taskId,
        worktree_id: worktree.worktree_id,
        worktree_path: worktree.path,
        plan_id: run.plan_id ?? null,
        revision: run.revision ?? null,
      },
    }, "coding");
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, coordinator.dispatch_id);
    this.store.event(runId, "coding.continue_implementation_created", {
      dispatchId,
      task_id: taskId,
      worktree_id: worktree.worktree_id,
      prepare_git_dispatch_id: prepare.dispatch_id,
      replacement_for: coordinator.dispatch_id,
    });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  ensureGitPrepareDispatch(runId: string, target: "integration" | "implementation", explorerDispatchId?: string): string {
    const phase = target === "integration" ? "prepare_worktrees" : "prepare_implementation_worktree";
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state IN ('pending','claimed','completed')
      AND json_extract(packet_json,'$.context.phase')=?
      ORDER BY created_at DESC LIMIT 1`).get(runId, phase) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const run = this.store.getRun(runId) as { base_commit?: string; mode?: string };
    return this.insert(runId, "git-operator", validatePacket({
      objective: target === "integration"
        ? run.mode === "planned" ? "Verify the plan worktree prepared for this planned run." : "Prepare the integration worktree for this run."
        : "Prepare the implementation task worktree after the direct pre_write scope gate.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: target === "integration"
        ? [run.mode === "planned" ? "Verify the active plan worktree already owned by this run" : "Register one active integration worktree owned by this run"]
        : ["Register the active implementation task worktree owned by this run from the run base commit"],
      context: {
        stage: "git-operator",
        phase,
        ...(target === "implementation" ? { task_id: "implementation" } : {}),
        ...(explorerDispatchId ? { explorer_dispatch_id: explorerDispatchId } : {}),
        base_commit: run.base_commit ?? null,
      },
    }, "git-operator"));
  }

  private assertGitPrepareResult(runId: string, packet: DispatchPacket): void {
    const context = packet.context as { phase?: unknown; task_id?: unknown; worktree_ids?: unknown };
    if (context.phase === "prepare_worktrees") {
      const worktree = this.activeIntegrationWorktree(runId);
      if (!worktree) throw new ValidationError("prepare_worktrees requires a registered active integration worktree or plan worktree owned by this run");
    }
    if (context.phase === "prepare_implementation_worktree") {
      const taskId = typeof context.task_id === "string" ? context.task_id.toLowerCase() : "implementation";
      const worktree = this.store.db.prepare("SELECT 1 FROM worktrees WHERE run_id=? AND state='active' AND (branch LIKE ? OR branch LIKE ?)")
        .get(runId, `task/%/${taskId}`, `task/%--${taskId}`);
      if (!worktree) throw new ValidationError("prepare_implementation_worktree requires a registered active implementation task worktree owned by this run");
    }
    if (context.phase === "reconcile_worktree_ownership") {
      if (!Array.isArray(context.worktree_ids) || !context.worktree_ids.length || context.worktree_ids.some((id) => typeof id !== "string")) {
        throw new ValidationError("ownership reconciliation requires registered worktree ids");
      }
      const owned = context.worktree_ids.every((worktreeId) => this.store.db.prepare("SELECT 1 FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId));
      if (!owned) throw new ValidationError("ownership reconciliation did not transfer every worktree to this run");
    }
  }

  private ensureIntegrationDispatch(
    runId: string,
    taskWorktreeIds: string[],
    integrationWorktreeId: string,
    taskBindings: Array<{ task_id: string | null; worktree_id: string }>,
  ): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state!='failed'
      AND json_extract(packet_json,'$.context.phase')='integrate_implementation'
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const onlyTaskBinding = taskBindings[0];
    const taskBinding = taskBindings.length === 1 && onlyTaskBinding?.task_id ? onlyTaskBinding : undefined;
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
        ...(taskBinding ? {
          task_id: taskBinding.task_id,
          task_worktree_id: taskBinding.worktree_id,
          implementation_worktree_id: taskBinding.worktree_id,
          worktree_id: taskBinding.worktree_id,
        } : {}),
      },
    }, "git-operator"));
  }

  private implementationSnapshot(runId: string): ImplementationSnapshot | undefined {
    const run = this.store.getRun(runId) as { mode?: string; plan_id?: string; revision?: string; plan_digest?: string };
    const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.state,d.result_json,d.packet_json,d.completed_at FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer')
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)`).all(runId) as Array<{ dispatch_id: string; state: string; result_json?: string; packet_json: string; completed_at?: string }>;
    if (!coordinator || !developers.length || developers.some((item) => item.state !== "completed")) return undefined;
    const developerBindings = developers.map((item) => {
      try {
        const context = (JSON.parse(item.packet_json) as { context?: { task_id?: string; worktree_id?: string } }).context;
        return context?.worktree_id ? { task_id: context.task_id ?? null, worktree_id: context.worktree_id } : undefined;
      } catch { return undefined; }
    });
    if (developerBindings.some((value) => !value)) return undefined;
    const taskBindings = developerBindings as Array<{ task_id: string | null; worktree_id: string }>;
    const taskWorktreeIds = [...new Set(taskBindings.map(({ worktree_id }) => worktree_id))];
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) return undefined;
    const usesPlanWorktreeDirectly = run.mode === "planned" && taskWorktreeIds.length === 1 && taskWorktreeIds[0] === integration.worktree_id;
    const commitOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>;
    const committedWorktrees = new Set(commitOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.worktree_id === "string" ? [evidence.worktree_id] : []; }
      catch { return []; }
    }));
    if (!usesPlanWorktreeDirectly && taskWorktreeIds.some((worktreeId) => !committedWorktrees.has(worktreeId))) return undefined;
    const mergeOperations = this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.merge.task' AND state='completed' ORDER BY completed_at").all(runId) as Array<{ evidence_json?: string }>;
    const mergedWorktrees = new Set(mergeOperations.flatMap((item) => {
      try { const evidence = JSON.parse(item.evidence_json ?? "{}"); return typeof evidence.task_worktree_id === "string" ? [evidence.task_worktree_id] : []; }
      catch { return []; }
    }));
    if (!usesPlanWorktreeDirectly && taskWorktreeIds.some((worktreeId) => !mergedWorktrees.has(worktreeId))) {
      this.ensureIntegrationDispatch(runId, taskWorktreeIds, integration.worktree_id, taskBindings);
      return undefined;
    }
    const implementation = this.completedImplementationOperation(runId);
    if (usesPlanWorktreeDirectly && implementation && implementation.kind !== "git.commit" || !usesPlanWorktreeDirectly && implementation?.kind !== "git.merge.task") return undefined;
    const integrationHead = execFileSync("git", ["-C", integration.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (implementation && implementation.commit !== integrationHead) return undefined;
    if (!implementation) return undefined;
    const changedPaths = [...new Set(implementation.paths)] as string[];
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
    const authorizedPaths = explorer?.result_json
      ? (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths
      : [...new Set([...developers.flatMap((developer) => (JSON.parse(developer.packet_json) as DispatchPacket).allowed_read_paths), "package.json"])];
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    if (!explorer && (this.store.getRun(runId) as { mode?: string }).mode === "planned") return undefined;
    if (changedPaths.some((path) => !pathMatchesScope(path, authorizedPaths as string[]))) throw new ValidationError("implementation paths are not authorized by Explorer evidence");
    const implementationArtifacts = developers.map((developer) => {
      const artifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
        .get(runId, developer.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
      return artifact ? { dispatch_id: developer.dispatch_id, artifact_id: artifact.artifact_id, digest: artifact.sha256 } : undefined;
    });
    if (implementationArtifacts.some((artifact) => !artifact)) return undefined;
    const primary = [...developers].sort((left, right) => (right.completed_at ?? "").localeCompare(left.completed_at ?? ""))[0]!;
    const primaryArtifact = implementationArtifacts[developers.indexOf(primary)]!;
    return {
      coordinatorDispatchId: coordinator.dispatch_id,
      explorerDispatchId: explorer?.dispatch_id ?? null,
      authorizedPaths: authorizedPaths as string[],
      developerDispatchIds: developers.map(({ dispatch_id }) => dispatch_id),
      implementationDispatchId: primary.dispatch_id,
      implementationArtifact: { artifact_id: primaryArtifact!.artifact_id, digest: primaryArtifact!.digest },
      implementationArtifacts: implementationArtifacts as ImplementationSnapshot["implementationArtifacts"],
      implementationCommit: implementation.commit,
      implementationCommitted: true,
      changedPaths,
      worktreeId: integration.worktree_id,
      worktreePath: integration.path,
      planId: run.plan_id ?? null,
      revision: run.revision ?? null,
      planDigest: run.plan_digest ?? null,
    };
  }

  private testPacket(snapshot: ImplementationSnapshot, coordinatorDispatchId?: string): DispatchPacket {
    return validatePacket(buildTestPacket(snapshot, coordinatorDispatchId), "test");
  }

  private createTestDispatch(runId: string, snapshot: ImplementationSnapshot, coordinatorDispatchId?: string): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, snapshot.implementationCommit) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const dispatchId = this.insert(runId, "test", this.testPacket(snapshot, coordinatorDispatchId));
    this.changeStage(runId, "test", dispatchId);
    return dispatchId;
  }

  private advanceImplementation(runId: string): void {
    const snapshot = this.implementationSnapshot(runId);
    if (!snapshot) return;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'
      AND json_extract(packet_json,'$.context.implementation_commit')=?`).get(runId, snapshot.implementationCommit);
    if (existing) return;
    const dispatchId = this.createTestDispatch(runId, snapshot);
    this.store.event(runId, "test.dispatch_created", { dispatchId, implementation_dispatch_id: snapshot.implementationDispatchId, implementation_artifact_id: snapshot.implementationArtifact.artifact_id });
  }

  private advanceReview(runId: string, result: ResultEnvelope): void {
    const packet = this.buildReviewPacket(runId, result);
    if (!packet) return;
    const revisionSha = packet.context.revision_sha;
    const existing = this.store.db.prepare(`SELECT 1 FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state!='failed'
      AND json_extract(packet_json,'$.context.revision_sha')=?`).get(runId, revisionSha);
    if (existing) return;
    const dispatchId = this.insert(runId, "code-reviewer", packet);
    this.changeStage(runId, "code-reviewer", dispatchId);
  }

  reconcileReview(runId: string, barrierId?: string): Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> {
    this.store.getRun(runId);
    const barriers = this.store.db.prepare(`SELECT * FROM review_barriers WHERE run_id=?${barrierId ? " AND barrier_id=?" : ""} ORDER BY created_at`)
      .all(...(barrierId ? [runId, barrierId] : [runId])) as ReviewBarrierRow[];
    if (barrierId && barriers.length === 0) throw new ValidationError("review barrier does not belong to run");
    const outcomes: Array<{ barrier_id: string; state: string; blocking: ReviewFinding[] }> = [];
    for (const barrier of barriers) {
      let outcome = { barrier_id: barrier.barrier_id, state: barrier.state, blocking: [] as ReviewFinding[] };
      this.store.db.transaction(() => {
        const axes: Array<"spec" | "standards"> = barrier.axes_json ? JSON.parse(barrier.axes_json) as Array<"spec" | "standards"> : barrier.formal ? ["spec", "standards"] : ["standards"];
        for (const axis of axes) {
          const role = axis === "spec" ? "review-spec" : "review-standards";
          const dispatchColumn = axis === "spec" ? "spec_dispatch_id" : "standards_dispatch_id";
          let dispatchId = axis === "spec" ? barrier.spec_dispatch_id : barrier.standards_dispatch_id;
          let leaf = dispatchId
            ? this.store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role)
            : undefined;
          if (!leaf) {
            leaf = (this.store.db.prepare("SELECT dispatch_id,state,packet_json,result_json FROM dispatches WHERE run_id=? AND role=? ORDER BY created_at DESC").all(runId, role) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>)
              .find((row) => (JSON.parse(row.packet_json) as DispatchPacket).context.barrier_id === barrier.barrier_id);
            dispatchId = (leaf as { dispatch_id?: string } | undefined)?.dispatch_id;
            if (dispatchId) this.store.db.prepare(`UPDATE review_barriers SET ${dispatchColumn}=? WHERE barrier_id=?`).run(dispatchId, barrier.barrier_id);
          }
          const row = leaf as { dispatch_id: string; state: string; packet_json: string; result_json?: string } | undefined;
          if (row?.state !== "completed" || !row.result_json) continue;
          const packet = JSON.parse(row.packet_json) as DispatchPacket;
          if (packet.context.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review packet is not bound to its barrier`);
          const envelope = JSON.parse(row.result_json) as ResultEnvelope;
          const payload = envelope.payload as { finding_ids?: unknown; barrier_id?: unknown };
          if (payload.barrier_id !== undefined && payload.barrier_id !== barrier.barrier_id) throw new ValidationError(`${axis} review result is not bound to its barrier`);
          const reviewResult: ReviewResult = { axis, summary: envelope.summary, findings: envelope.findings as ReviewFinding[] };
          validateReviewResult(reviewResult);
          const findingIds = reviewResult.findings.map((finding) => finding.finding_id);
          if (stableJson(payload.finding_ids ?? []) !== stableJson(findingIds)) throw new ValidationError(`${axis} review result finding ids do not match its findings`);
          const serialized = stableJson(reviewResult);
          const existing = this.store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? AND axis=?").get(barrier.barrier_id, axis) as { result_json: string } | undefined;
          if (existing && existing.result_json !== serialized) throw new ValidationError(`${axis} review was already submitted with a different result`);
          this.store.db.prepare("INSERT OR IGNORE INTO review_results(barrier_id,axis,result_json,created_at) VALUES (?,?,?,?)")
            .run(barrier.barrier_id, axis, serialized, new Date().toISOString());
          const artifact = this.store.db.prepare("SELECT sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
            .get(runId, row.dispatch_id) as { sha256: string } | undefined;
          const digestColumn = axis === "spec" ? "spec_result_digest" : "standards_result_digest";
          this.store.db.prepare(`UPDATE review_barriers SET ${digestColumn}=? WHERE barrier_id=?`).run(artifact?.sha256 ?? sha256(row.result_json), barrier.barrier_id);
          if (payload.barrier_id === undefined) {
            envelope.payload = { ...envelope.payload, barrier_id: barrier.barrier_id };
            this.store.db.prepare("UPDATE dispatches SET result_json=? WHERE dispatch_id=?").run(stableJson(envelope), row.dispatch_id);
          }
        }
        const results = (this.store.db.prepare("SELECT result_json FROM review_results WHERE barrier_id=? ORDER BY axis").all(barrier.barrier_id) as Array<{ result_json: string }>)
          .map((row) => JSON.parse(row.result_json) as ReviewResult);
        const blocking = results.flatMap((result) => result.findings).filter((finding) => finding.severity === "P0" || finding.severity === "P1");
        let state = barrier.state;
        if (results.length === axes.length && !["resolved"].includes(state)) state = blocking.length ? "blocked" : "passed";
        const aggregate = {
          status: state,
          axes,
          completed_axes: results.map((result) => result.axis),
          finding_ids: results.flatMap((result) => result.findings.map((finding) => finding.finding_id)),
          blocking_finding_ids: blocking.map((finding) => finding.finding_id),
        };
        this.store.db.prepare("UPDATE review_barriers SET axes_json=?,state=?,aggregate_json=?,completed_at=CASE WHEN ?='pending' THEN completed_at ELSE COALESCE(completed_at,?) END WHERE barrier_id=?")
          .run(stableJson(axes), state, stableJson(aggregate), state, new Date().toISOString(), barrier.barrier_id);
        if (state === "blocked") this.ensureReviewResolutionDispatch(runId, barrier, blocking);
        if (state === "passed" || state === "resolved") this.ensureFinalGitDispatch(runId, barrier);
        outcome = { barrier_id: barrier.barrier_id, state, blocking };
      })();
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private ensureReviewResolutionDispatch(runId: string, barrier: ReviewBarrierRow, blocking: ReviewFinding[]): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='review_resolution'
      AND json_extract(packet_json,'$.context.barrier_id')=? LIMIT 1`).get(runId, barrier.barrier_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const leafId = barrier.spec_dispatch_id ?? barrier.standards_dispatch_id;
    const leaf = leafId ? this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(leafId) as { packet_json: string } | undefined : undefined;
    const reviewPaths = leaf ? (JSON.parse(leaf.packet_json) as DispatchPacket).allowed_read_paths : [];
    const writablePaths = reviewPaths.filter((path) => !path.startsWith(".ai-team/plans/"));
    const dispatchId = this.insert(runId, "coding", validatePacket({
      objective: `Resolve every blocking finding for review barrier ${barrier.barrier_id}.`,
      allowed_read_paths: reviewPaths,
      allowed_write_paths: writablePaths,
      acceptance_criteria: ["Map every P0/P1 finding to change evidence", "Provide verification evidence after the repair commit"],
      context: { stage: "coding", phase: "review_resolution", barrier_id: barrier.barrier_id, revision_sha: barrier.revision_sha, blocking_findings: blocking },
    }, "coding"));
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureFinalGitDispatch(runId: string, barrier: ReviewBarrierRow): string {
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'
      AND json_extract(packet_json,'$.context.phase')='finalize_integration'
      AND json_extract(packet_json,'$.context.barrier_id')=? LIMIT 1`).get(runId, barrier.barrier_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const integration = this.activeIntegrationWorktree(runId);
    if (!integration) throw new ValidationError("passed review requires an active integration worktree");
    const dispatchId = this.insert(runId, "git-operator", validatePacket({
      objective: `Merge reviewed integration commit ${barrier.revision_sha} into the target branch and clean up owned worktrees.`,
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Merge the reviewed integration worktree into the target branch", "Clean up all run-owned worktrees after integration"],
      context: { stage: "git-operator", phase: "finalize_integration", barrier_id: barrier.barrier_id, revision_sha: barrier.revision_sha, integration_worktree_id: integration.worktree_id, actions: ["integrate", "cleanup"] },
    }, "git-operator"));
    const run = this.store.getRun(runId) as { state: string };
    if (run.state === "active") this.changeStage(runId, "git-operator", dispatchId);
    return dispatchId;
  }

  buildReviewPacket(runId: string, testResult?: ResultEnvelope, reissue?: { decision_id: string; dispatch_id: string; resolved_decision?: Record<string, unknown> }): DispatchPacket | undefined {
    const test = this.store.db.prepare("SELECT dispatch_id,state,result_json,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; state: string; result_json?: string; packet_json: string } | undefined;
    if (!test || test.state !== "completed" || !test.result_json) return undefined;
    const testPacket = JSON.parse(test.packet_json) as DispatchPacket;
    const testContext = testPacket.context as { implementation_commit?: string; implementation_committed?: boolean; changed_paths?: string[] };
    if (testContext.implementation_committed !== true) return undefined;
    const revisionSha = testContext.implementation_commit;
    if (!revisionSha || !/^[a-f0-9]{40}$/.test(revisionSha)) return undefined;
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; plan_digest?: string; base_commit?: string };
    const repository = this.store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get(run.repo_id) as { project_path: string } | undefined;
    if (!repository) throw new ValidationError("review repository is not registered");
    const integration = this.activeIntegrationWorktree(runId);
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
    const changedPaths = [...new Set(gitChangedPaths)];
    if (!changedPaths.length || !committedDiff.trim()) return undefined;
    const planningPaths = run.plan_id && run.revision ? ["spec.md", "plan.md", "tasks.md"].map((name) => `.ai-team/plans/${run.plan_id}/revisions/${run.revision}/${name}`) : [];
    const existingPlanningPaths = planningPaths.filter((path) => {
      try { execFileSync("git", ["-C", repository.project_path, "cat-file", "-e", `${revisionSha}:${path}`], { stdio: "ignore" }); return true; }
      catch { return false; }
    });
    const documentDigest = sha256(existingPlanningPaths.map((path) => `${path}\0${execFileSync("git", ["-C", repository.project_path, "show", `${revisionSha}:${path}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })}`).join("\n"));
    const frozenTestResult = testResult ?? JSON.parse(test.result_json) as ResultEnvelope;
    const testedCommit = (frozenTestResult.payload as { testedCommit?: unknown }).testedCommit ?? testContext.implementation_commit;
    if (testedCommit !== revisionSha) return undefined;
    const testEvidenceDigest = sha256(stableJson(frozenTestResult));
    const diffDigest = sha256(committedDiff);
    const artifacts = this.store.db.prepare(`SELECT a.artifact_id,a.dispatch_id,a.kind,a.path,a.sha256,d.role
      FROM artifacts a JOIN dispatches d ON d.dispatch_id=a.dispatch_id
      WHERE a.run_id=? AND d.role IN ('coding','frontend-developer','backend-developer','git-operator','test')
      ORDER BY a.created_at,a.artifact_id`).all(runId) as Array<{ artifact_id: string; dispatch_id: string; kind: string; path: string; sha256: string; role: string }>;
    const evidenceDigest = sha256(stableJson({ test_dispatch_id: test.dispatch_id, test_evidence_digest: testEvidenceDigest, artifact_digests: artifacts.map((artifact) => artifact.sha256) }));
    const revisionDigest = sha256(stableJson({ plan_id: run.plan_id ?? null, revision: run.revision ?? null, base_commit: baseCommit, revision_sha: revisionSha, document_digest: documentDigest, diff_digest: diffDigest, evidence_digest: evidenceDigest }));
    return validatePacket(assembleReviewPacket({
      revisionSha, baseCommit, planId: run.plan_id ?? null, revision: run.revision ?? null, planDigest: run.plan_digest ?? null,
      changedPaths, planningPaths: existingPlanningPaths, documentDigest, committedDiff, diffDigest,
      testDispatchId: test.dispatch_id, testEvidence: frozenTestResult, testEvidenceDigest, testedCommit,
      artifacts, evidenceDigest, revisionDigest, ...(reissue ? { reissue } : {}),
    }), "code-reviewer");
  }

  private advancePlanning(runId: string, result: ResultEnvelope): void {
    const payload = result.payload as {
      stage: string;
      pending_questions: string[];
      decision: { question: string; choices: Array<{ id: string; label: string; impact: string }>; recommendation: string } | null;
      no_change?: { decision_id: string; conclusion: string; repository_evidence: Array<{ command: string; outcome: string }> };
    };
    const run = this.store.getRun(runId) as { repo_id: string; plan_id?: string; revision?: string; stage: string };
    assertPlanningTransition(run.stage, payload.stage);
    if (payload.stage === "no_change") {
      if (!payload.no_change) throw new ValidationError("planning no_change requires repository evidence and a decision receipt");
      const decision = this.store.db.prepare("SELECT status,choice,receipt_json FROM decisions WHERE run_id=? AND decision_id=?")
        .get(runId, payload.no_change.decision_id) as { status: string; choice?: string; receipt_json?: string } | undefined;
      if (!decision || decision.status !== "resolved" || decision.choice !== "verify_existing") {
        throw new ValidationError("planning no_change requires a resolved verify_existing decision receipt");
      }
      if (run.plan_id || run.revision) throw new ValidationError("planning no_change cannot complete a run with a bound revision");
      const sideEffects = {
        worktrees: (this.store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count,
        operations: (this.store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=?").get(runId) as { count: number }).count,
        git_dispatches: (this.store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count,
      };
      if (sideEffects.worktrees || sideEffects.operations || sideEffects.git_dispatches) {
        throw new ValidationError("planning no_change cannot complete after implementation or Git side effects", sideEffects);
      }
      const decisionReceipt = JSON.parse(decision.receipt_json ?? "{}") as Record<string, unknown>;
      this.store.db.prepare("UPDATE runs SET stage='no_change',state='completed',updated_at=? WHERE run_id=?")
        .run(new Date().toISOString(), runId);
      this.store.event(runId, "planning.no_change_completed", {
        conclusion: payload.no_change.conclusion,
        repository_evidence: payload.no_change.repository_evidence,
        decision_receipt: decisionReceipt,
      });
      return;
    }
    if (run.plan_id && run.revision) {
      const revision = this.store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
        .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
      if (!revision) throw new ValidationError("bound planning revision not found");
      assertRevisionRunStage(revision.state, payload.stage);
    }
    const requirementDecisionCount = (this.store.db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE run_id=? AND decision_type='requirement'").get(runId) as { count: number }).count;
    const intent = planningSubmissionIntent(payload.stage, payload.pending_questions, payload.decision, requirementDecisionCount);
    const needsDecision = intent.needsDecision;
    this.store.db.prepare("UPDATE runs SET stage=?,state=?,updated_at=? WHERE run_id=?")
      .run(payload.stage, needsDecision ? "needs_decision" : "active", new Date().toISOString(), runId);
    this.store.event(runId, "planning.stage_changed", { stage: payload.stage });
    if (needsDecision) {
      if (!payload.decision) throw new ValidationError("planning pending question requires one matching decision");
      this.store.createDecision(runId, intent.question!, payload.decision.choices, payload.decision.recommendation, intent.decisionType!, result.dispatch_id);
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
    return this.create(runId, "planning", planningContinuationPacket(run.stage), "planning");
  }

  resolvePlanningDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string };
    if (run.profile !== "planning") throw new ValidationError("only planning runs can resolve planning decisions");
    const existing = this.store.db.prepare("SELECT status,choice,receipt_json,decision_type,dispatch_id FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; decision_type: string; dispatch_id?: string } | undefined;
    if (existing?.status === "resolved") {
      const receipt = JSON.parse(existing.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (existing.choice === choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      if (existing.choice === choice && ((existing.decision_type === "task_split" && choice === "no_split") || (existing.decision_type === "task_preview" && choice === "approve"))) {
        return existing.dispatch_id ?? "";
      }
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      this.store.decide(runId, decisionId, choice, note);
      this.store.db.prepare(`UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=(
        SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='planning' AND state='needs_decision' ORDER BY created_at DESC LIMIT 1
      )`)
        .run(new Date().toISOString(), runId);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      const terminalDecision = existing?.decision_type === "task_split" && choice === "no_split"
        || existing?.decision_type === "task_preview" && choice === "approve";
      dispatchId = terminalDecision
        ? existing?.dispatch_id ?? ""
        : this.continuePlanning(runId);
      const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: terminalDecision ? null : dispatchId, successor_packet_digest: terminalDecision ? null : successor?.packet_digest ?? null }), decisionId);
    })();
    return dispatchId;
  }

  resolveDecision(runId: string, decisionId: string, choice: string, note?: string): string {
    const run = this.store.getRun(runId) as { profile: string; mode?: string; repo_id?: string; plan_id?: string; revision?: string };
    if (run.profile === "planning") return this.resolvePlanningDecision(runId, decisionId, choice, note);
    const existingDecision = this.store.db.prepare("SELECT status,choice,receipt_json,dispatch_id,decision_type FROM decisions WHERE run_id=? AND decision_id=?").get(runId, decisionId) as { status: string; choice?: string; receipt_json?: string; dispatch_id?: string; decision_type: string } | undefined;
    if (existingDecision?.status === "resolved") {
      const receipt = JSON.parse(existingDecision.receipt_json ?? "{}") as { successor_dispatch_id?: string };
      if (choice === existingDecision.choice && receipt.successor_dispatch_id) return receipt.successor_dispatch_id;
      throw new ValidationError("decision is unknown, stale, or already resolved");
    }
    const managedPlannedRecovery = isManagedPlannedRecovery(run.mode, existingDecision?.decision_type, choice);
    if (managedPlannedRecovery) {
      if (!run.repo_id || !run.plan_id || !run.revision || !existingDecision?.dispatch_id) throw new ValidationError("managed planned recovery requires a bound planned run and dispatch");
      const pendingOperation = this.store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1").get(runId) as { operation_id: string } | undefined;
      if (pendingOperation) throw new ValidationError(`managed planned recovery requires operation reconciliation: ${pendingOperation.operation_id}`);
      const worktrees = this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' ORDER BY created_at,worktree_id").all(runId) as Array<{ worktree_id: string }>;
      if (!worktrees.length) throw new ValidationError("managed planned recovery requires at least one active run-owned worktree");
      const conflicts = this.store.db.prepare(`SELECT run_id FROM runs WHERE repo_id=? AND plan_id=? AND revision=? AND run_id<>? AND state='failed'
        ORDER BY created_at,run_id`).all(run.repo_id, run.plan_id, run.revision, runId) as Array<{ run_id: string }>;
      let dispatchId = "";
      this.store.db.transaction(() => {
        const blocked = this.store.db.prepare("SELECT dispatch_id,role FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
          .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role } | undefined;
        if (!blocked || blocked.role !== "coding") throw new ValidationError("managed planned recovery requires a blocked Coding dispatch");
        this.store.decide(runId, decisionId, choice, note);
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
        dispatchId = this.insert(runId, "git-operator", validatePacket(managedCleanupPacket({
          worktreeIds: worktrees.map(({ worktree_id }) => worktree_id), decisionId, choice,
          conflictingRunIds: conflicts.map(({ run_id }) => run_id), planId: run.plan_id!, revision: run.revision!,
        }), "git-operator"), blocked.dispatch_id);
        this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND dispatch_id<>? AND state IN ('pending','claimed')")
          .run(new Date().toISOString(), runId, dispatchId);
        this.store.db.prepare("UPDATE runs SET state='active',stage='canceling',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        for (const conflict of conflicts) {
          this.store.db.prepare("UPDATE runs SET state='canceled',stage='reconciled',source_run_id=?,updated_at=? WHERE run_id=? AND state='failed'")
            .run(runId, new Date().toISOString(), conflict.run_id);
          this.store.event(conflict.run_id, "run.failed_start_reconciled", { source_run_id: runId, decision_id: decisionId, cleanup_dispatch_id: dispatchId });
        }
        this.store.event(runId, "run.reconciliation_requested", { decision_id: decisionId, cleanup_dispatch_id: dispatchId, conflicting_run_ids: conflicts.map(({ run_id }) => run_id), worktree_ids: worktrees.map(({ worktree_id }) => worktree_id) });
        const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
        const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
        this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
          .run(stableJson({ ...JSON.parse(receipt.receipt_json), successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null, conflicting_run_ids: conflicts.map(({ run_id }) => run_id) }), decisionId);
        this.changeStage(runId, "canceling", dispatchId);
      })();
      return dispatchId;
    }
    let dispatchId = "";
    this.store.db.transaction(() => {
      if (!existingDecision?.dispatch_id) throw new ValidationError("decision is not bound to a dispatch");
      const blocked = this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for,state FROM dispatches WHERE run_id=? AND dispatch_id=? AND state IN ('needs_decision','retryable_failure')")
        .get(runId, existingDecision.dispatch_id) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string; state: string } | undefined;
      if (!blocked) throw new ValidationError("run has no dispatch waiting on this decision");
      this.store.decide(runId, decisionId, choice, note);
      const receipt = this.store.db.prepare("SELECT receipt_json FROM decisions WHERE decision_id=?").get(decisionId) as { receipt_json: string };
      const resolvedDecision = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
      this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), blocked.dispatch_id);
      this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      if (blocked.role === "code-reviewer" && choice === "pre_commit_then_refreeze") {
        dispatchId = this.ensurePreCommitDecisionContinuation(runId, decisionId, blocked.dispatch_id) ?? "";
        if (!dispatchId) throw new ValidationError("pre_commit_then_refreeze could not create a continuation");
        return;
      }
      let packet: DispatchPacket;
      if (choice === "reissue") {
        const reviewPacket = blocked.role === "code-reviewer"
          ? this.buildReviewPacket(runId, undefined, { decision_id: decisionId, dispatch_id: blocked.dispatch_id, resolved_decision: resolvedDecision })
          : undefined;
        if (blocked.role === "code-reviewer" && !reviewPacket) {
          throw new ValidationError("review reissue requires complete current integration and test evidence");
        }
        packet = reviewPacket ?? validatePacket(reissuePacket(blocked.role, decisionId, blocked.dispatch_id, resolvedDecision), blocked.role);
      } else {
        dispatchId = this.recoveryReplacement(runId, blocked, resolvedDecision);
        packet = JSON.parse((this.store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_json: string }).packet_json) as DispatchPacket;
      }
      if (choice === "reissue") dispatchId = this.insert(runId, blocked.role, packet, blocked.dispatch_id);
      const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
      this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
        .run(stableJson({ ...resolvedDecision, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decisionId);
      this.changeStage(runId, blocked.role, dispatchId);
    })();
    return dispatchId;
  }

  private ensurePreCommitDecisionContinuation(runId: string, decisionId?: string, reviewDispatchId?: string): string | undefined {
    const decision = (decisionId
      ? this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND decision_id=? AND status='resolved' AND choice='pre_commit_then_refreeze'")
        .get(runId, decisionId)
      : this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='resolved' AND choice='pre_commit_then_refreeze' ORDER BY resolved_at DESC LIMIT 1")
        .get(runId)) as { decision_id: string; dispatch_id?: string; receipt_json: string } | undefined;
    if (!decision) return undefined;
    const sourceReviewId = reviewDispatchId ?? decision.dispatch_id;
    if (!sourceReviewId) return undefined;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')
      AND json_extract(packet_json,'$.context.decision_id')=?
      AND json_extract(packet_json,'$.context.phase') IN ('pre_commit_implementation','pre_commit_scope_remediation')
      ORDER BY created_at DESC LIMIT 1`).get(runId, decision.decision_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;

    const run = this.store.getRun(runId) as { mode?: string; plan_id?: string; revision?: string; plan_digest?: string };
    const worktree = this.activeIntegrationWorktree(runId);
    if (!worktree) return undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.role,d.packet_json,d.completed_at FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer') AND d.state='completed'
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)
      ORDER BY d.completed_at DESC,d.created_at DESC`).all(runId) as Array<{ dispatch_id: string; role: Role; packet_json: string; completed_at?: string }>;
    if (!developers.length) return undefined;
    const relevantDevelopers = developers.filter((developer) => {
      try { return (JSON.parse(developer.packet_json) as DispatchPacket).context.worktree_id === worktree.worktree_id; }
      catch { return false; }
    });
    if (!relevantDevelopers.length) return undefined;
    const developerAllowedWritePaths = [...new Set(relevantDevelopers.flatMap((developer) => (JSON.parse(developer.packet_json) as DispatchPacket).allowed_write_paths))];
    const primaryDeveloper = relevantDevelopers[0]!;
    const primaryPacket = JSON.parse(primaryDeveloper.packet_json) as DispatchPacket;
    const explorerDispatchId = typeof primaryPacket.context.explorer_dispatch_id === "string"
      ? primaryPacket.context.explorer_dispatch_id
      : undefined;
    if (!explorerDispatchId) return undefined;
    const explorer = this.store.db.prepare("SELECT result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'")
      .get(runId, explorerDispatchId) as { result_json?: string } | undefined;
    if (!explorer?.result_json) return undefined;
    const authorizedPaths = (JSON.parse(explorer.result_json) as ResultEnvelope).payload.allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    const implementationArtifact = this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, primaryDeveloper.dispatch_id) as { artifact_id: string; sha256: string } | undefined;
    const test = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    const testArtifact = test ? this.store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result' ORDER BY created_at DESC LIMIT 1")
      .get(runId, test.dispatch_id) as { artifact_id: string; sha256: string } | undefined : undefined;
    if (!implementationArtifact || !test || !testArtifact) return undefined;

    const changedPaths = dirtyWorktreePaths(worktree.path);
    const blockedPaths = changedPaths.filter((path) => !pathMatchesScope(path, developerAllowedWritePaths));
    if (run.mode === "planned" && changedPaths.length && !blockedPaths.length) {
      new ScopeGate(this.store).check(runId, "pre_commit", developerAllowedWritePaths, worktree.worktree_id);
    }
    const commonContext = {
      decision_id: decision.decision_id,
      review_dispatch_id: sourceReviewId,
      plan_id: run.plan_id ?? null,
      revision: run.revision ?? null,
      plan_digest: run.plan_digest ?? null,
      explorer_dispatch_id: explorerDispatchId,
      worktree_id: worktree.worktree_id,
      worktree_path: worktree.path,
      implementation_dispatch_id: primaryDeveloper.dispatch_id,
      implementation_artifact: { artifact_id: implementationArtifact.artifact_id, digest: implementationArtifact.sha256 },
      test_dispatch_id: test.dispatch_id,
      test_artifact: { artifact_id: testArtifact.artifact_id, digest: testArtifact.sha256 },
      developer_dispatch_ids: relevantDevelopers.map(({ dispatch_id }) => dispatch_id),
      developer_allowed_write_paths: developerAllowedWritePaths,
      changed_paths: changedPaths,
    };
    let dispatchId: string;
    if (!changedPaths.length || blockedPaths.length) {
      dispatchId = this.insert(runId, primaryDeveloper.role, validatePacket({
        objective: blockedPaths.length
          ? "Remediate the real dirty diff that falls outside the frozen developer write scope before commit."
          : "Restore the missing implementation dirty diff before pre-commit can continue.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Leave only implementation paths authorized by the frozen developer packet", "Return fresh implementation evidence before commit"],
        context: { ...commonContext, stage: primaryDeveloper.role, phase: "pre_commit_scope_remediation", blocked_changed_paths: blockedPaths },
      }, primaryDeveloper.role), sourceReviewId);
      this.changeStage(runId, primaryDeveloper.role, dispatchId);
    } else {
      const packet = validatePacket({
        objective: "Commit the real dirty implementation diff, then refreeze tests and formal review on the new commit.",
        allowed_read_paths: authorizedPaths as string[],
        allowed_write_paths: developerAllowedWritePaths,
        acceptance_criteria: ["Commit only the real dirty paths within the frozen developer write scope", "Return the new implementation commit and committed paths"],
        context: { ...commonContext, stage: "git-operator", phase: "pre_commit_implementation", scope_digest: sha256(changedPaths.join("\n")) },
      }, "git-operator");
      assertExplorerAuthorization(this.store, runId, "git-operator", packet);
      dispatchId = this.insert(runId, "git-operator", packet, sourceReviewId);
      this.changeStage(runId, "git-operator", dispatchId);
    }
    const successor = this.store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_digest?: string };
    const receipt = JSON.parse(decision.receipt_json) as Record<string, unknown>;
    this.store.db.prepare("UPDATE decisions SET receipt_json=? WHERE decision_id=?")
      .run(stableJson({ ...receipt, successor_dispatch_id: dispatchId, successor_packet_digest: successor.packet_digest ?? null }), decision.decision_id);
    return dispatchId;
  }

  private ensureCodingCommitContinuation(runId: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; state: string; mode?: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const preCommit = this.store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit' ORDER BY event_id DESC LIMIT 1")
      .get(runId) as { payload_json: string } | undefined;
    if (!preCommit && run.mode !== "planned") return undefined;
    const developers = this.store.db.prepare(`SELECT d.dispatch_id,d.state,d.packet_json,d.result_json FROM dispatches d
      WHERE d.run_id=? AND d.role IN ('frontend-developer','backend-developer')
      AND NOT EXISTS (SELECT 1 FROM dispatches successor WHERE successor.replacement_for=d.dispatch_id)`).all(runId) as Array<{ dispatch_id: string; state: string; packet_json: string; result_json?: string }>;
    if (!developers.length || developers.some((developer) => developer.state !== "completed" || !developer.result_json)) return undefined;
    const developerWorktreeIds = developers.map((developer) => {
      try { return (JSON.parse(developer.packet_json) as DispatchPacket).context.worktree_id; }
      catch { return undefined; }
    });
    if (developerWorktreeIds.some((value) => typeof value !== "string" || !value)) return undefined;
    const worktreeIds = [...new Set(developerWorktreeIds as string[])];
    const activeTaskWorktrees = new Set((this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' AND branch LIKE 'task/%'").all(runId) as Array<{ worktree_id: string }>).map((worktree) => worktree.worktree_id));
    if (worktreeIds.some((worktreeId) => !activeTaskWorktrees.has(worktreeId))) return undefined;
    const committed = new Set((this.store.db.prepare("SELECT evidence_json FROM operations WHERE run_id=? AND kind='git.commit' AND state='completed'").all(runId) as Array<{ evidence_json?: string }>).flatMap((operation) => {
      try {
        const worktreeId = (JSON.parse(operation.evidence_json ?? "{}") as { worktree_id?: unknown }).worktree_id;
        return typeof worktreeId === "string" ? [worktreeId] : [];
      } catch { return []; }
    }));
    const uncommittedWorktreeIds = worktreeIds.filter((worktreeId) => !committed.has(worktreeId));
    if (!uncommittedWorktreeIds.length) return undefined;
    const coordinator = this.store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='coding' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; packet_json: string } | undefined;
    if (!coordinator) return undefined;
    const existing = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding' AND replacement_for=? AND state IN ('pending','claimed','completed') ORDER BY created_at DESC LIMIT 1")
      .get(runId, coordinator.dispatch_id) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const coordinatorPacket = JSON.parse(coordinator.packet_json) as DispatchPacket;
    const inheritedExplorerId = (coordinatorPacket.context as { explorer_dispatch_id?: unknown }).explorer_dispatch_id;
    const explorer = (typeof inheritedExplorerId === "string"
      ? this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='file-explorer' AND state='completed'").get(runId, inheritedExplorerId)
      : this.store.db.prepare("SELECT dispatch_id,result_json FROM dispatches WHERE run_id=? AND role='file-explorer' AND state='completed' ORDER BY completed_at DESC,created_at DESC LIMIT 1").get(runId)) as { dispatch_id: string; result_json?: string } | undefined;
    if (!explorer?.result_json) return undefined;
    const explorerResult = JSON.parse(explorer.result_json) as ResultEnvelope;
    const authorizedPaths = (explorerResult.payload as { allowed_read_paths?: unknown }).allowed_read_paths;
    if (!Array.isArray(authorizedPaths) || authorizedPaths.some((path) => typeof path !== "string")) return undefined;
    const changedPaths = [...new Set(developers.flatMap((developer) => {
      try { return ((JSON.parse(developer.result_json!) as ResultEnvelope).payload as { modified_paths?: string[] }).modified_paths ?? []; }
      catch { return []; }
    }))];
    if (changedPaths.some((path) => !pathMatchesScope(path, authorizedPaths as string[]))) throw new ValidationError("coding continuation developer paths are not authorized by Explorer evidence");
    const plannedScopeDigests: Array<{ worktree_id: string; digest: string }> = [];
    if (run.mode === "planned") {
      for (const worktreeId of uncommittedWorktreeIds) {
        const scopes = [...new Set(developers.flatMap((developer) => {
          try {
            const packet = JSON.parse(developer.packet_json) as DispatchPacket;
            return packet.context.worktree_id === worktreeId ? packet.allowed_write_paths : [];
          } catch { return []; }
        }))];
        if (!scopes.length) throw new ValidationError("planned pre_commit scope requires frozen developer write paths");
        const gate = new ScopeGate(this.store).check(runId, "pre_commit", scopes, worktreeId);
        plannedScopeDigests.push({ worktree_id: worktreeId, digest: gate.digest });
      }
    }
    const scope = preCommit ? JSON.parse(preCommit.payload_json) as { digest?: unknown } : undefined;
    const packet = validatePacket({
      objective: "Continue the completed implementation by dispatching Git Operator to commit every uncommitted task worktree.",
      allowed_read_paths: authorizedPaths as string[],
      allowed_write_paths: [],
      acceptance_criteria: ["Create the Git Operator commit dispatch for every listed task worktree", "Preserve the completed pre_commit scope and Explorer authorization"],
      context: {
        stage: "coding",
        phase: "continue_commit",
        explorer_dispatch_id: explorer.dispatch_id,
        coordinator_dispatch_id: coordinator.dispatch_id,
        developer_dispatch_ids: developers.map((developer) => developer.dispatch_id),
        task_worktree_ids: uncommittedWorktreeIds,
        changed_paths: changedPaths,
        scope_digest: plannedScopeDigests.length
          ? sha256(stableJson(plannedScopeDigests))
          : typeof scope?.digest === "string" ? scope.digest : sha256(stableJson(changedPaths.sort())),
      },
    }, "coding");
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, coordinator.dispatch_id);
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureContinueTestingContinuation(runId: string): string | undefined {
    const run = this.store.getRun(runId) as { profile: string; state: string };
    if (run.profile !== "coding" || run.state !== "active") return undefined;
    const test = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state!='failed' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string } | undefined;
    if (test) return test.dispatch_id;
    const existing = this.store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='coding'
      AND json_extract(packet_json,'$.context.phase')='continue_testing' AND state IN ('pending','claimed','completed')
      ORDER BY created_at DESC LIMIT 1`).get(runId) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    const snapshot = this.implementationSnapshot(runId);
    if (!snapshot) return undefined;
    const packet = validatePacket(buildContinueTestingPacket(snapshot), "coding");
    assertExplorerAuthorization(this.store, runId, "coding", packet);
    const dispatchId = this.insert(runId, "coding", packet, snapshot.coordinatorDispatchId);
    const orphanedStaging = this.store.db.prepare(`SELECT staging_id FROM staging_entries
      WHERE run_id=? AND dispatch_id=? AND kind='dispatch-packet' AND state IN ('draft','ready')`).all(runId, snapshot.coordinatorDispatchId) as Array<{ staging_id: string }>;
    for (const entry of orphanedStaging) {
      this.store.cancelStagingEntry(entry.staging_id, { runId, dispatchId: snapshot.coordinatorDispatchId, role: "coding", kind: "dispatch-packet" }, `superseded by ${dispatchId}`);
    }
    this.store.event(runId, "coding.continue_testing_created", { dispatchId, replacement_for: snapshot.coordinatorDispatchId, canceled_staging_ids: orphanedStaging.map(({ staging_id }) => staging_id) });
    this.changeStage(runId, "coding", dispatchId);
    return dispatchId;
  }

  private ensureActiveLivenessDecision(runId: string): void {
    const run = this.store.getRun(runId) as { profile: Role; state: string; stage: string };
    const pendingDispatch = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId);
    const pendingDecision = this.store.db.prepare("SELECT 1 FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    const pendingOperation = this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='pending'").get(runId);
    const intent = livenessRecoveryIntent(run.profile, run.state, run.stage, Boolean(pendingDispatch || pendingDecision || pendingOperation));
    if (!intent) return;
    const dispatchId = this.insert(runId, run.profile, validatePacket(intent.packet, run.profile));
    this.store.db.prepare("UPDATE dispatches SET state='needs_decision' WHERE dispatch_id=?").run(dispatchId);
    this.store.createDecision(runId, intent.decision.question, intent.decision.choices, intent.decision.recommendation, intent.decision.type, dispatchId);
    this.store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
    this.store.event(runId, "run.recovery_decision_created", { dispatch_id: dispatchId, stage: run.stage });
  }

  resume(runId: string): RunResumeResult {
    this.store.db.transaction(() => {
      let run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      const pendingDecision = this.store.db.prepare("SELECT decision_id,dispatch_id,receipt_json FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; dispatch_id?: string; receipt_json?: string } | undefined;
      const pendingOperation = this.store.db.prepare("SELECT 1 FROM operations WHERE run_id=? AND state='pending'").get(runId);
      if (pendingOperation) return;
      if (run.profile === "coding") {
        this.reconcileReview(runId);
        run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
      }
      const retryableDispatch = run.state === "retryable_failure"
        ? this.store.db.prepare("SELECT dispatch_id,role,packet_json,packet_digest,result_json,replacement_for FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1").get(runId) as { dispatch_id: string; role: Role; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string } | undefined
        : undefined;
      const mergePartialEffect = retryableDispatch ? this.plannedMergePartialEffect(runId, retryableDispatch) : undefined;
      if (pendingDecision) {
        if (retryableDispatch && !pendingDecision.dispatch_id) {
          const receipt = { ...JSON.parse(pendingDecision.receipt_json ?? "{}"), dispatch_id: retryableDispatch.dispatch_id };
          this.store.db.prepare("UPDATE decisions SET dispatch_id=?,receipt_json=? WHERE decision_id=?")
            .run(retryableDispatch.dispatch_id, stableJson(receipt), pendingDecision.decision_id);
          this.store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        }
        return;
      }
      if (!retryableDispatch) {
        const pendingTest = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1")
          .get(runId) as { dispatch_id: string } | undefined;
        if (pendingTest && run.stage !== "test") this.changeStage(runId, "test", pendingTest.dispatch_id);
        const pendingDispatch = this.store.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId);
        if (pendingDispatch) return;
        if (run.profile === "coding" && this.ensurePlannedTaskContinuation(runId)) return;
      }
      const retryableHasNoSideEffects = retryableResultHasNoSideEffects(retryableDispatch?.result_json);
      if (retryableDispatch && retryableHasNoSideEffects && !mergePartialEffect) {
        this.store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?")
          .run(new Date().toISOString(), retryableDispatch.dispatch_id);
        this.store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        if (!this.plannedOwnershipRecovery(runId, retryableDispatch)) this.recoveryReplacement(runId, retryableDispatch);
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
      if (run.profile === "coding" && run.state === "active") {
        const commitContinuation = this.ensurePreCommitDecisionContinuation(runId) ?? this.ensureCodingCommitContinuation(runId);
        if (!commitContinuation) this.ensureContinueTestingContinuation(runId);
      }
      this.ensureActiveLivenessDecision(runId);
    })();
    const resumedRun = this.store.getRun(runId) as Record<string, unknown> & { profile: Role; state: string };
    const blockedRetryable = resumedRun.state === "retryable_failure"
      ? this.store.db.prepare("SELECT dispatch_id,role,packet_json,result_json FROM dispatches WHERE run_id=? AND state='retryable_failure' ORDER BY created_at DESC LIMIT 1")
        .get(runId) as { dispatch_id: string; role: Role; packet_json: string; result_json?: string } | undefined
      : undefined;
    let recovery: RunResumeResult["recovery"] = null;
    if (blockedRetryable?.result_json) {
      const intent = reconciliationIntent(blockedRetryable.result_json, Boolean(this.plannedMergePartialEffect(runId, blockedRetryable)));
      if (intent) recovery = {
        state: "action_required", dispatch_id: blockedRetryable.dispatch_id, side_effect_state: intent.sideEffectState,
        next_command: intent.sideEffectState === "completed"
          ? `ai-team dispatch reconcile --run-id ${runId} --dispatch-id ${blockedRetryable.dispatch_id} --role ${blockedRetryable.role} --actor-role ${resumedRun.profile} --reason "reconcile confirmed completed side effect"`
          : null,
      };
    }
    return {
      run: resumedRun,
      pending_dispatches: this.store.db.prepare("SELECT dispatch_id,role,state FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").all(runId) as RunResumeResult["pending_dispatches"],
      pending_decision: (this.store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").get(runId) as Record<string, unknown> | undefined) ?? null,
      pending_operations: this.store.db.prepare("SELECT operation_id,kind,state FROM operations WHERE run_id=? AND state='pending'").all(runId) as RunResumeResult["pending_operations"],
      last_event: (this.store.db.prepare("SELECT type,payload_json,created_at FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined) ?? null,
      recovery,
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
