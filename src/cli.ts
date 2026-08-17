#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { checkDecisionInput, CONTRACT_DIGEST, DECISION_INPUT_SCHEMA, DECISION_INPUT_TEMPLATE } from "./contracts.js";
import { validateCommand } from "./command-contract.js";
import { EXIT, PACKAGE_VERSION, ROLES, STAGING_KINDS, STAGING_MAX_BYTES, type Role, type StagingKind } from "./constants.js";
import { DispatchService, type DispatchPacket } from "./dispatch.js";
import { EnvironmentService, PLATFORMS, type Platform } from "./environment.js";
import { AiTeamError, ArgumentError, ValidationError } from "./errors.js";
import { commitPlanningRevision, repositoryIdentity, worktreeStatus } from "./git.js";
import { GitOrchestrator } from "./git-orchestrator.js";
import { ScopeGate } from "./gates.js";
import { runnableTaskBatches, validateTaskPreview, type TaskDefinition } from "./tasks.js";
import { assertRevisionCreateRunStage, assertRevisionDocuments, assertRevisionRunStage, hasTaskDocuments, preflightRevision, writeRevision, nextPlanState, type RevisionDocuments } from "./planning.js";
import { initializeProject } from "./project.js";
import { updateProjectContext, validateProjectContext } from "./context.js";
import { ReviewService, type FindingResolution, type ReviewResult } from "./review.js";
import { ResearchService } from "./research-service.js";
import type { ResearchConclusion } from "./research.js";
import { ROLE_MANIFEST_DIGEST } from "./roles.js";
import { AGENT_BUILD } from "./roles.js";
import { StateStore, type StagingBinding, type StagingEntry } from "./state.js";
import { WorkflowService } from "./workflow.js";
import { assertReadablePath } from "./security.js";

let humanOutput = false;
let legacyOutput = false;
const humanize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return String(value ?? "");
  if (Array.isArray(value)) return value.map((item) => humanize(item)).join("\n");
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
};
const output = (value: unknown, options: { legacyRaw?: boolean } = {}): void => {
  if (legacyOutput && options.legacyRaw) { process.stdout.write(`${String(value)}\n`); return; }
  if (humanOutput) { process.stdout.write(`${humanize(value)}\n`); return; }
  const envelope = {
    ok: true,
    data: value,
    ...(legacyOutput && value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}),
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
};
const roleOption = (): Option => new Option("--role <role>").choices([...ROLES]).makeOptionMandatory();
const platformList = (value: string): Platform[] => {
  const platforms = value.split(",") as Platform[];
  if (platforms.some((item) => !PLATFORMS.includes(item))) throw new ArgumentError(`invalid platform list: ${value}`);
  return platforms;
};

const withStore = async <T>(action: (store: StateStore) => Promise<T> | T, options: { readonly?: boolean } = {}): Promise<T> => {
  const store = await StateStore.open(undefined, options);
  try { return await action(store); } finally { store.close(); }
};

interface PlanningCommitRequest {
  repo_id: string;
  run_id: string;
  plan_id: string;
  revision: string;
  digest: string;
  dispatch_id: string;
  attempt?: number;
}

interface PlanningCommitOperation {
  operation_id: string;
  run_id: string;
  idempotency_key: string;
  kind: string;
  state: string;
  request_json: string;
  evidence_json?: string;
}

const planningCommitBaseKey = (request: PlanningCommitRequest): string => [
  "planning.revision.commit",
  request.repo_id,
  request.run_id,
  request.plan_id,
  request.revision,
  request.digest,
  request.dispatch_id,
].join(":");

const reconcilePlanningCommit = (
  store: StateStore,
  operation: PlanningCommitOperation,
  runId: string,
  dispatchId: string,
  state: "completed" | "not_applied",
  evidence: unknown,
): { operation_id: string; state: string; plan_commit?: string; reused: boolean } => {
  if (operation.run_id !== runId) throw new ValidationError("planning commit operation does not belong to run");
  const request = JSON.parse(operation.request_json) as PlanningCommitRequest;
  if (request.run_id !== runId || request.dispatch_id !== dispatchId) throw new ValidationError("planning commit operation identity does not match run and dispatch");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new ValidationError("planning commit reconciliation evidence must be an object");
  const supplied = evidence as Record<string, unknown>;
  const planCommit = supplied.plan_commit;
  if (state === "completed" && (typeof planCommit !== "string" || !/^[a-f0-9]{40}$/.test(planCommit))) {
    throw new ValidationError("completed planning commit reconciliation requires a 40-character plan_commit");
  }
  for (const [field, expected] of Object.entries({
    repo_id: request.repo_id,
    run_id: request.run_id,
    plan_id: request.plan_id,
    revision: request.revision,
    digest: request.digest,
    dispatch_id: request.dispatch_id,
  })) {
    if (supplied[field] !== undefined && supplied[field] !== expected) throw new ValidationError(`planning commit reconciliation ${field} does not match operation`);
  }
  const previousEvidence = operation.evidence_json ? JSON.parse(operation.evidence_json) as Record<string, unknown> : undefined;
  if (operation.state !== "pending") {
    const sameCompleted = state === "completed" && operation.state === "completed"
      && previousEvidence?.reconciliation === "completed" && previousEvidence.plan_commit === planCommit;
    const sameNotApplied = state === "not_applied" && operation.state === "failed"
      && previousEvidence?.reconciliation === "not_applied";
    if (sameCompleted) return { operation_id: operation.operation_id, state: "completed", plan_commit: planCommit as string, reused: true };
    if (sameNotApplied) return { operation_id: operation.operation_id, state: "not_applied", reused: true };
    throw new ValidationError(`planning commit operation cannot reconcile from ${operation.state}`);
  }
  const run = store.getRun(runId) as { repo_id: string; profile: string; plan_id?: string; revision?: string };
  if (run.profile !== "planning" || run.repo_id !== request.repo_id || run.plan_id !== request.plan_id || run.revision !== request.revision) {
    throw new ValidationError("planning commit operation does not match the bound planning run");
  }
  const revision = store.db.prepare("SELECT state,digest,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
    .get(request.repo_id, request.plan_id, request.revision) as { state: string; digest?: string; plan_commit?: string } | undefined;
  if (!revision || revision.digest !== request.digest) throw new ValidationError("planning commit operation does not match the bound revision digest");
  if (state === "completed" && !["plan_ready", "tasks_preview", "ready"].includes(revision.state)) {
    throw new ValidationError(`planning revision cannot reconcile completed from ${revision.state}`);
  }
  if (state === "completed" && revision.state === "ready" && revision.plan_commit !== planCommit) {
    throw new ValidationError("planning revision is already ready with a different plan_commit");
  }
  const normalized = {
    reconciliation: state,
    repo_id: request.repo_id,
    run_id: request.run_id,
    plan_id: request.plan_id,
    revision: request.revision,
    digest: request.digest,
    dispatch_id: request.dispatch_id,
    ...(state === "completed" ? { state: "ready", plan_commit: planCommit } : {}),
    confirmation: supplied,
  };
  store.db.transaction(() => {
    if (state === "completed") {
      store.db.prepare("UPDATE revisions SET state='ready',plan_commit=? WHERE repo_id=? AND plan_id=? AND revision=?")
        .run(planCommit, request.repo_id, request.plan_id, request.revision);
      store.db.prepare("UPDATE runs SET stage='ready',state='active',updated_at=? WHERE run_id=?")
        .run(new Date().toISOString(), runId);
      store.event(runId, "planning.revision_committed", { planId: request.plan_id, revision: request.revision, commit: planCommit, reconciled: true, operationId: operation.operation_id });
      store.finishOperation(operation.operation_id, normalized);
    } else {
      store.reconcileOperation(operation.operation_id, "not_applied", normalized);
    }
    store.event(runId, "planning.revision_reconciled", { operationId: operation.operation_id, state, ...(state === "completed" ? { commit: planCommit } : {}) });
  })();
  return { operation_id: operation.operation_id, state, ...(state === "completed" ? { plan_commit: planCommit as string } : {}), reused: false };
};

const readSafeFile = async (path: string): Promise<string> => {
  assertReadablePath(path);
  const value = await readFile(path, "utf8");
  if (value.length > 2 * 1024 * 1024) throw new ValidationError("input file exceeds the 2 MiB limit");
  return value;
};

const readStdinJson = async (): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > STAGING_MAX_BYTES) throw new ValidationError("staging JSON exceeds the 2 MiB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

interface JsonInput {
  file?: string;
  stagingId?: string;
  runId?: string;
  dispatchId?: string | null;
  role?: Role;
  kind: StagingKind;
  readOnly?: boolean;
}

interface LoadedJson {
  value: unknown;
  entry?: StagingEntry;
  binding: StagingBinding;
  consume: (binding?: StagingBinding) => Promise<void>;
  validationFailed: (error: unknown, binding?: StagingBinding) => void;
}

const loadJsonInput = async (store: StateStore, input: JsonInput, retentionHours: number): Promise<LoadedJson> => {
  if (Boolean(input.file) === Boolean(input.stagingId)) throw new ValidationError("provide exactly one JSON file option or --staging-id");
  if (input.file) {
    return {
      value: JSON.parse(await readSafeFile(input.file)),
      binding: {},
      consume: async () => {},
      validationFailed: () => {},
    };
  }
  if (!input.runId) throw new ValidationError("--run-id is required with --staging-id");
  const binding: StagingBinding = {
    runId: input.runId,
    ...(input.dispatchId !== undefined ? { dispatchId: input.dispatchId } : {}),
    ...(input.role ? { role: input.role } : {}),
    kind: input.kind,
  };
  const stagingId = input.stagingId!;
  let loaded;
  try { loaded = input.readOnly ? await store.inspectStagingEntry(stagingId, binding) : await store.readStagingEntry(stagingId, binding); }
  catch (error) {
    if (!input.readOnly) try { store.recordStagingValidationFailure(stagingId, binding, error); } catch { /* do not mask the validation error */ }
    throw error;
  }
  return {
    value: loaded.value,
    entry: loaded.entry,
    binding,
    consume: async (extra = {}) => { await store.consumeStagingEntry(stagingId, { ...binding, ...extra }, new Date(), retentionHours); },
    validationFailed: (error, extra = {}) => store.recordStagingValidationFailure(stagingId, { ...binding, ...extra }, error),
  };
};

const jsonOptions = (command: Command, fileFlag: string): Command => command.option(`${fileFlag} <file>`).option("--staging-id <id>");
const retentionHours = (): Promise<number> => new EnvironmentService().stagingRetentionHours();

const preflightPlanningRevision = async (
  store: StateStore,
  input: { project: string; repoId: string; planId: string; revision: string; supersedes?: string; runId?: string; documents: unknown },
): Promise<{ path: string; digest: string; documents: RevisionDocuments }> => {
  assertRevisionDocuments(input.documents);
  if (input.runId) {
    const run = store.getRun(input.runId) as { profile: string; repo_id: string; stage: string; state: string; plan_id?: string; revision?: string };
    if (run.profile !== "planning" || run.repo_id !== input.repoId) throw new ValidationError("planning revision does not belong to this run repository");
    if (run.plan_id && (run.plan_id !== input.planId || run.revision !== input.revision)) {
      throw new ValidationError("planning run is already bound to a different revision");
    }
    assertRevisionCreateRunStage(input.documents, run.stage);
    if (hasTaskDocuments(input.documents)) store.assertTaskPreviewApproved(input.runId);
    if (run.state !== "active") throw new ValidationError("planning revision requires an active planning run");
    const transition = nextPlanState("draft", "plan_ready");
    assertRevisionRunStage("draft", run.stage, transition);
    const conflictingRun = store.db.prepare("SELECT run_id FROM runs WHERE repo_id=? AND profile='planning' AND plan_id=? AND revision=? AND state='active' AND run_id!=?")
      .get(input.repoId, input.planId, input.revision, input.runId) as { run_id: string } | undefined;
    if (conflictingRun) throw new ValidationError("planning revision already has another bound active run");
  } else if (hasTaskDocuments(input.documents)) {
    throw new ValidationError("planning revisions with task documents require --run-id for task preview approval");
  }
  const result = await preflightRevision(input.project, input.planId, input.revision, input.documents, input.supersedes);
  return { ...result, documents: input.documents };
};

const requestOptions = (command: Command): Command => command.option("--request-file <file>").option("--request-stdin");

export const buildProgram = (): Command => {
  const program = new Command().exitOverride().name("ai-team").description("Local AI coding team workflow orchestration").version(PACKAGE_VERSION)
    .option("--human", "render human-readable output")
    .option("--legacy-output", "include legacy top-level success fields");
  program.configureOutput({ outputError: () => {} });

  program.command("init").argument("<project>").option("--yes", "confirm patches to dirty project files").action(async (project, options) => output(await initializeProject(project, options.yes)));
  const context = program.command("context");
  jsonOptions(context.command("update").requiredOption("--project <path>").option("--run-id <id>"), "--context-file").action(async (options) => {
    validateCommand("context.update", { project: options.project, contextFile: options.contextFile, stagingId: options.stagingId, runId: options.runId });
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.contextFile, stagingId: options.stagingId, runId: options.runId, role: "file-explorer", kind: "project-context" }, retention);
      try {
        if (options.stagingId) {
          const repo = await repositoryIdentity(options.project);
          const run = store.getRun(options.runId) as { repo_id: string };
          if (run.repo_id !== repo.repoId) throw new ValidationError("project context staging run does not belong to this repository");
        }
        const source = input.value as Record<string, unknown>;
        const value = source.payload && typeof source.payload === "object" && !Array.isArray(source.payload)
          ? (source.payload as Record<string, unknown>).project_context ?? source
          : source;
        const result = await updateProjectContext(options.project, value);
        await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });
  context.command("validate").requiredOption("--project <path>").action(async (options) => {
    validateCommand("context.validate", { project: options.project });
    output(await validateProjectContext(options.project));
  });
  program.command("status").option("--project <path>", "project path", process.cwd()).action(async ({ project }) => {
    const repo = await repositoryIdentity(project); const status = await worktreeStatus(repo.root);
    output({ repository: repo, worktree: status, contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST });
  });

  const planning = program.command("planning");
  requestOptions(planning.command("start").requiredOption("--project <path>")).action(async (options) => {
    validateCommand("planning.start", { project: options.project, requestFile: options.requestFile, requestStdin: options.requestStdin });
    const request = await WorkflowService.requestFrom(options.requestFile, options.requestStdin);
    output(await withStore((store) => new WorkflowService(store).planningStart(options.project, request)));
  });
  const revision = planning.command("revision");
  jsonOptions(revision.command("validate").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--target-branch <branch>").option("--supersedes <nnn>").option("--run-id <id>"), "--documents-file").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.documentsFile, stagingId: options.stagingId, runId: options.runId, role: "planning", kind: "planning-documents", readOnly: true }, retention);
      const result = await preflightPlanningRevision(store, {
        project: options.project, repoId: repo.repoId, planId: options.planId, revision: options.revision,
        supersedes: options.supersedes, runId: options.runId, documents: input.value,
      });
      return { path: result.path, digest: result.digest, valid: true };
    }, { readonly: true }));
  });
  jsonOptions(revision.command("create").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--target-branch <branch>").option("--supersedes <nnn>").option("--run-id <id>"), "--documents-file").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.documentsFile, stagingId: options.stagingId, runId: options.runId, role: "planning", kind: "planning-documents" }, retention);
      try {
      const checked = await preflightPlanningRevision(store, {
        project: options.project, repoId: repo.repoId, planId: options.planId, revision: options.revision,
        supersedes: options.supersedes, runId: options.runId, documents: input.value,
      });
      const docs = checked.documents;
      const result = await writeRevision(options.project, options.planId, options.revision, options.targetBranch, docs, options.supersedes);
      store.registerRepository(repo.repoId, repo.commonDir, repo.root);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,supersedes,created_at) VALUES (?,?,?,'draft',?,?,?,?)")
        .run(options.planId, options.revision, repo.repoId, options.targetBranch, result.digest, options.supersedes ?? null, new Date().toISOString());
      if (options.runId) store.bindPlanningRevision(options.runId, repo.repoId, options.planId, options.revision);
      await input.consume();
      return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });
  revision.command("transition").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--to <state>").option("--plan-commit <sha>").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    output(await withStore((store) => {
      const row = store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(repo.repoId, options.planId, options.revision) as { state: string } | undefined;
      if (!row) throw new ValidationError("planning revision not found");
      if (options.to === "ready") throw new ValidationError("ready state requires planning revision commit");
      const state = nextPlanState(row.state, options.to);
      const runs = store.db.prepare("SELECT run_id,stage FROM runs WHERE repo_id=? AND profile='planning' AND plan_id=? AND revision=? AND state='active'").all(repo.repoId, options.planId, options.revision) as Array<{ run_id: string; stage: string }>;
      if (runs.length > 1) throw new ValidationError("planning revision has multiple bound active runs");
      if (runs[0]) assertRevisionRunStage(row.state, runs[0].stage, state);
      let dispatchId: string | undefined;
      const transition = store.db.transaction(() => {
        store.db.prepare("UPDATE revisions SET state=?,plan_commit=COALESCE(?,plan_commit) WHERE repo_id=? AND plan_id=? AND revision=?").run(state, options.planCommit ?? null, repo.repoId, options.planId, options.revision);
        if (state === "plan_ready") {
          if (runs.length !== 1) throw new ValidationError("plan_ready transition requires exactly one bound active planning run");
          dispatchId = new DispatchService(store).createPlanningCommit(runs[0]!.run_id, {
            objective: `Commit immutable planning revision ${options.planId}/${options.revision}.`,
            allowed_read_paths: [`.ai-team/plans/${options.planId}/plan.yaml`, `.ai-team/plans/${options.planId}/revisions/${options.revision}`],
            allowed_write_paths: [],
            acceptance_criteria: ["Commit only plan.yaml, this revision, and its archived research", "Record the planning trailers and resulting commit"],
            context: { plan_id: options.planId, revision: options.revision },
          });
        }
      });
      transition();
      return { state, ...(dispatchId ? { dispatch_id: dispatchId } : {}) };
    }));
  });
  revision.command("commit").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    output(await withStore(async (store) => {
      new DispatchService(store).assertPlanningCommitClaimed(options.runId, options.dispatchId, options.planId, options.revision);
      const run = store.getRun(options.runId) as { repo_id: string; profile: string; stage: string; state: string };
      if (run.repo_id !== repo.repoId || run.profile !== "planning") throw new ValidationError("planning commit dispatch does not belong to this revision repository");
      if (run.state !== "active") throw new ValidationError("planning run must be active before revision commit");
      const row = store.db.prepare("SELECT * FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(repo.repoId, options.planId, options.revision) as { state: string; digest?: string; plan_commit?: string } | undefined;
      if (!row || !["plan_ready", "tasks_preview", "ready"].includes(row.state) || !row.digest) throw new ValidationError("planning revision is not ready to commit");
      const revisionDigest = row.digest;
      assertRevisionRunStage(row.state, run.stage, "ready");
      const operationRequest: PlanningCommitRequest = {
        repo_id: repo.repoId,
        run_id: options.runId,
        plan_id: options.planId,
        revision: options.revision,
        digest: row.digest,
        dispatch_id: options.dispatchId,
      };
      const operationBaseKey = planningCommitBaseKey(operationRequest);
      const attempts = (store.db.prepare("SELECT operation_id,idempotency_key,state,evidence_json FROM operations WHERE idempotency_key=? OR idempotency_key GLOB ?")
        .all(operationBaseKey, `${operationBaseKey}:attempt:*`) as Array<{ operation_id: string; idempotency_key: string; state: string; evidence_json?: string }>)
        .map((item) => ({
          ...item,
          attempt: item.idempotency_key === operationBaseKey ? 1 : Number(item.idempotency_key.slice(`${operationBaseKey}:attempt:`.length)),
        }))
        .filter(({ attempt }) => Number.isSafeInteger(attempt) && attempt > 0)
        .sort((left, right) => left.attempt - right.attempt);
      const latestAttempt = attempts.at(-1);
      if (row.state === "ready" && !latestAttempt) {
        throw new ValidationError("ready planning revision has no matching commit operation; reconcile state before retry");
      }
      if (latestAttempt?.state === "completed") {
        if (row.state === "ready" && latestAttempt.evidence_json) {
          const evidence = JSON.parse(latestAttempt.evidence_json) as { state?: string; plan_commit?: string };
          if (evidence.state === "ready" && evidence.plan_commit === row.plan_commit) {
            return { state: "ready", plan_commit: evidence.plan_commit, operation_id: latestAttempt.operation_id, reused: true };
          }
        }
        throw new ValidationError(`planning revision commit operation ${latestAttempt.operation_id} is completed but state has not converged; reconcile before retry`);
      }
      let attempt = 1;
      if (latestAttempt) {
        if (latestAttempt.state !== "failed") {
          throw new ValidationError(`planning revision commit operation ${latestAttempt.operation_id} is ${latestAttempt.state}; reconcile before retry`, {
            operation_id: latestAttempt.operation_id,
            state: latestAttempt.state,
          });
        }
        const priorEvidence = latestAttempt.evidence_json ? JSON.parse(latestAttempt.evidence_json) as { reconciliation?: string } : undefined;
        if (priorEvidence?.reconciliation !== "not_applied") {
          throw new ValidationError(`planning revision commit operation ${latestAttempt.operation_id} failed without confirmed not_applied evidence`);
        }
        attempt = latestAttempt.attempt + 1;
      }
      const operationKey = attempt === 1 ? operationBaseKey : `${operationBaseKey}:attempt:${attempt}`;
      const operation = store.beginOperation("planning.revision.commit", operationKey, {
        ...operationRequest,
        attempt,
      }, options.runId);
      if (operation.reused) {
        throw new ValidationError(`planning revision commit operation ${operation.operationId} is ${operation.state}; reconcile before retry`, {
          operation_id: operation.operationId,
          state: operation.state,
        });
      }
      let commit: string;
      try {
        commit = await commitPlanningRevision(repo.root, options.planId, options.revision, row.digest);
      } catch (error) {
        store.event(options.runId, "planning.revision_commit_uncertain", {
          operationId: operation.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ValidationError("planning revision commit failed; reconcile pending operation before retry", {
          operation_id: operation.operationId,
        });
      }
      store.db.transaction(() => {
        store.db.prepare("UPDATE revisions SET state='ready',plan_commit=? WHERE repo_id=? AND plan_id=? AND revision=?").run(commit, repo.repoId, options.planId, options.revision);
        store.db.prepare("UPDATE runs SET stage='ready',updated_at=? WHERE run_id=?").run(new Date().toISOString(), options.runId);
        store.event(options.runId, "planning.revision_committed", { planId: options.planId, revision: options.revision, commit });
        new WorkflowService(store).completePlanningHandoff(options.runId, options.planId, options.revision, revisionDigest, commit);
        store.finishOperation(operation.operationId, { state: "ready", plan_commit: commit });
      })();
      return { state: "ready", plan_commit: commit, operation_id: operation.operationId, reused: false };
    }));
  });
  const tasks = planning.command("tasks");
  jsonOptions(tasks.command("validate").option("--run-id <id>").option("--preview"), "--file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.file, stagingId: options.stagingId, runId: options.runId, role: "planning", kind: "planning-tasks" }, retention);
      try {
        const definitions = input.value as TaskDefinition[];
        if (options.preview) validateTaskPreview(definitions);
        const result = { valid: true, batches: runnableTaskBatches(definitions) };
        if (!options.preview) await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });

  const coding = program.command("coding");
  requestOptions(coding.command("start").requiredOption("--project <path>").addOption(new Option("--mode <mode>").choices(["planned", "bug", "feature"])).option("--plan-id <id>").option("--revision <nnn>"))
    .action(async (options) => {
      validateCommand("coding.start", { project: options.project, mode: options.mode, planId: options.planId, revision: options.revision, requestFile: options.requestFile, requestStdin: options.requestStdin });
      if (!options.mode) {
        const hasRequest = Boolean(options.requestFile || options.requestStdin);
        const request = hasRequest ? await WorkflowService.requestFrom(options.requestFile, options.requestStdin) : undefined;
        output(await withStore((store) => new WorkflowService(store).codingStartAuto(options.project, request, options.planId, options.revision)));
        return;
      }
      const direct = options.mode !== "planned";
      if (direct && !options.requestFile && !options.requestStdin || !direct && (options.requestFile || options.requestStdin)) throw new ValidationError("planned forbids request input; bug/feature require exactly one request input");
      if (direct && (options.planId || options.revision)) throw new ValidationError("bug/feature forbids plan-id and revision");
      const request = direct ? await WorkflowService.requestFrom(options.requestFile, options.requestStdin) : undefined;
      output(await withStore((store) => new WorkflowService(store).codingStart({ project: options.project, mode: options.mode, ...(options.planId ? { planId: options.planId } : {}), ...(options.revision ? { revision: options.revision } : {}), ...(request ? { request } : {}) })));
    });

  const run = program.command("run");
  run.command("show").argument("<run-id>").action(async (runId) => output(await withStore((store) => ({ run: store.getRun(runId), review_barrier: new ReviewService(store).current(runId), events: store.db.prepare("SELECT * FROM run_events WHERE run_id=? ORDER BY event_id").all(runId), decisions: store.db.prepare("SELECT * FROM decisions WHERE run_id=? ORDER BY created_at").all(runId), dispatches: store.db.prepare("SELECT dispatch_id,role,state,claimed_at,completed_at,created_at FROM dispatches WHERE run_id=? ORDER BY created_at").all(runId), worktrees: store.db.prepare("SELECT worktree_id,branch,path,base_commit,state,adopted_from_run_id FROM worktrees WHERE run_id=? ORDER BY created_at,worktree_id").all(runId) }), { readonly: true })));
  requestOptions(run.command("handoff-to-planning").argument("<run-id>"))
    .action(async (runId, options) => {
      const request = await WorkflowService.requestFrom(options.requestFile, options.requestStdin);
      output(await withStore((store) => new WorkflowService(store).handoffToPlanning(runId, request)));
    });
  run.command("resume").argument("<run-id>").action(async (runId) => output(await withStore((store) => new DispatchService(store).resume(runId))));
  run.command("decide").requiredOption("--run-id <id>").requiredOption("--decision-id <id>").requiredOption("--choice <id>").option("--note-file <file>").action(async (options) => withStore(async (store) => { const note = options.noteFile ? await readSafeFile(options.noteFile) : undefined; const dispatchId = new DispatchService(store).resolveDecision(options.runId, options.decisionId, options.choice, note); output({ status: "resolved", dispatch_id: dispatchId }); }));

  const staging = program.command("staging");
  staging.command("create").requiredOption("--run-id <id>").addOption(roleOption()).addOption(new Option("--kind <kind>").choices([...STAGING_KINDS]).makeOptionMandatory()).option("--dispatch-id <id>").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      let initialJson: string | undefined;
      if (options.kind === "dispatch-result") {
        if (!options.dispatchId) throw new ValidationError("dispatch-result staging requires --dispatch-id");
        initialJson = `${JSON.stringify(new DispatchService(store).template(options.runId, options.dispatchId, options.role), null, 2)}\n`;
      }
      return store.createStagingEntry({
        runId: options.runId,
        ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}),
        role: options.role,
        kind: options.kind,
        ...(initialJson ? { initialJson } : {}),
        retentionHours: retention,
      });
    }));
  });
  staging.command("write").requiredOption("--run-id <id>").addOption(roleOption()).requiredOption("--staging-id <id>").requiredOption("--input-stdin").action(async (options) => {
    const content = await readStdinJson();
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      try { return await store.writeStagingEntry(options.stagingId, content, { runId: options.runId, role: options.role }, undefined, retention); }
      catch (error) {
        try { store.recordStagingValidationFailure(options.stagingId, { runId: options.runId, role: options.role }, error); } catch { /* do not mask the write error */ }
        throw error;
      }
    }));
  });
  staging.command("show").requiredOption("--run-id <id>").addOption(roleOption()).option("--staging-id <id>").option("--content").action(async (options) => output(await withStore(async (store) => {
    if (!options.stagingId) {
      if (options.content) throw new ValidationError("--content requires --staging-id");
      return { entries: store.listStagingEntries(options.runId, options.role) };
    }
    if (!options.content) {
      const entry = store.getStagingEntry(options.stagingId);
      if (entry.runId !== options.runId || entry.role !== options.role) throw new ValidationError("staging identity does not match run and role");
      return { entry };
    }
    const result = await store.readStagingEntry(options.stagingId, { runId: options.runId, role: options.role });
    return { entry: result.entry, content: result.value };
  })));
  staging.command("cleanup").option("--expired").option("--run-id <id>").option("--staging-id <id>").option("--all").action(async (options) => {
    const explicit = Boolean(options.runId || options.stagingId);
    if (Boolean(options.expired) === explicit || explicit && !options.all || options.stagingId && !options.runId) {
      throw new ValidationError("use --expired, or --run-id [--staging-id] --all");
    }
    const retention = await retentionHours();
    output(await withStore((store) => store.cleanupStagingEntries({
      ...(options.expired ? { expired: true } : { runId: options.runId, ...(options.stagingId ? { stagingId: options.stagingId } : {}), all: true }),
      retentionHours: retention,
    })));
  });

  const dispatch = program.command("dispatch");
  jsonOptions(dispatch.command("create").requiredOption("--run-id <id>").addOption(roleOption()).addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).option("--actor-dispatch-id <id>"), "--packet-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
    if ((options.actorRole === "coding" || options.actorRole === "code-reviewer") && !options.actorDispatchId) throw new ValidationError(`${options.actorRole} dispatch creation requires --actor-dispatch-id`);
    const input = await loadJsonInput(store, { file: options.packetFile, stagingId: options.stagingId, runId: options.runId, dispatchId: options.actorDispatchId, role: options.actorRole, kind: "dispatch-packet" }, retention);
    try {
      const packet = input.value as any;
      if (options.actorRole === "coding" && options.role !== "file-explorer" && !packet?.context?.explorer_dispatch_id) throw new ValidationError("downstream dispatch requires packet context.explorer_dispatch_id");
      const result = { dispatch_id: new DispatchService(store).create(options.runId, options.role, packet, options.actorRole, options.actorDispatchId) };
      await input.consume();
      return result;
    } catch (error) { input.validationFailed(error); throw error; }
  }));
  });
  const dispatchCommand = (name: string): Command => dispatch.command(name).requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").addOption(roleOption()).hook("preAction", (_command, action) => validateCommand("dispatch.identity", { runId: action.opts().runId, dispatchId: action.opts().dispatchId, role: action.opts().role }));
  dispatchCommand("claim").action(async (options) => output(await withStore((store) => new DispatchService(store).claim(options.runId, options.dispatchId, options.role))));
  dispatchCommand("cancel").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).cancel(options.runId, options.dispatchId, options.role, options.actorRole, options.reason))));
  dispatchCommand("reissue").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).reissue(options.runId, options.dispatchId, options.role, options.actorRole, options.reason))));
  dispatchCommand("reconcile").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).reconcile(options.runId, options.dispatchId, options.role, options.actorRole, options.reason))));
  jsonOptions(dispatchCommand("supersede").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>"), "--packet-file")
    .action(async (options) => {
      const retention = await retentionHours();
      output(await withStore(async (store) => {
        const input = await loadJsonInput(store, {
          file: options.packetFile, stagingId: options.stagingId, runId: options.runId,
          role: options.actorRole, kind: "dispatch-packet",
        }, retention);
        try {
          const result = new DispatchService(store).supersede(options.runId, options.dispatchId, options.role, options.actorRole, options.reason, input.value as DispatchPacket);
          await input.consume();
          return result;
        } catch (error) { input.validationFailed(error); throw error; }
      }));
    });
  dispatchCommand("prompt").action(async (options) => output(await withStore((store) => new DispatchService(store).prompt(options.runId, options.dispatchId, options.role), { readonly: true }), { legacyRaw: true }));
  dispatchCommand("schema").action(async (options) => output(await withStore((store) => new DispatchService(store).schema(options.runId, options.dispatchId, options.role), { readonly: true })));
  dispatchCommand("template").action(async (options) => output(await withStore((store) => new DispatchService(store).template(options.runId, options.dispatchId, options.role), { readonly: true })));
  jsonOptions(dispatchCommand("validate"), "--result-file").action(async (options) => {
    if (options.resultFile && options.stagingId) throw new ValidationError("provide exactly one JSON file option or --staging-id");
    if (options.resultFile) { output({ valid: true, result: await withStore((store) => new DispatchService(store).validateFile(options.runId, options.dispatchId, options.role, options.resultFile), { readonly: true }) }); return; }
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { stagingId: options.stagingId, runId: options.runId, dispatchId: options.dispatchId, role: options.role, kind: "dispatch-result" }, retention);
      try { return { valid: true, result: new DispatchService(store).validateValue(options.runId, options.dispatchId, options.role, input.value) }; }
      catch (error) { input.validationFailed(error); throw error; }
    }));
  });
  jsonOptions(dispatchCommand("submit"), "--result-file").action(async (options) => {
    if (options.resultFile && !options.stagingId) { output(await withStore((store) => new DispatchService(store).submit(options.runId, options.dispatchId, options.role, options.resultFile))); return; }
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.resultFile, stagingId: options.stagingId, runId: options.runId, dispatchId: options.dispatchId, role: options.role, kind: "dispatch-result" }, retention);
      try {
        const result = await new DispatchService(store).submitValue(options.runId, options.dispatchId, options.role, input.value);
        await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });

  const gitCommand = program.command("git");
  gitCommand.command("status").requiredOption("--run-id <id>").action(async ({ runId }) => output(await withStore(async (store) => { const run = store.getRun(runId); const repo = store.db.prepare("SELECT * FROM repositories WHERE repo_id=?").get(run.repo_id); return { run_id: runId, repository: repo, worktree: await worktreeStatus((repo as any).project_path) }; }, { readonly: true })));
  gitCommand.command("prepare").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").option("--task-id <id>", "task id or implementation", "implementation").option("--integration").option("--base-commit <sha>").option("--depends-on <worktree-id>").action(async (options) => output(await withStore((store) => options.integration ? new GitOrchestrator(store).prepareIntegration(options.runId, options.dispatchId) : new GitOrchestrator(store).prepareTask(options.runId, options.taskId, options.baseCommit, options.dependsOn, options.dispatchId))));
  gitCommand.command("adopt").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").option("--path <path>").option("--branch <branch>").option("--base-commit <sha>").option("--commit <sha>").option("--task-id <id>", "task id or implementation", "implementation").action(async (options) => output(await withStore((store) => {
    if (options.commit && !options.path && !options.branch && !options.baseCommit) return new GitOrchestrator(store).adoptCommit(options.runId, options.commit, options.taskId, options.dispatchId);
    if (options.path && options.branch && options.baseCommit) return new GitOrchestrator(store).adopt(options.runId, options.path, options.branch, options.baseCommit, options.commit, options.dispatchId);
    throw new ValidationError("git adopt requires --commit alone, or --path, --branch, and --base-commit together");
  })));
  gitCommand.command("transfer").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").requiredOption("--worktree-id <id>").action(async (options) => output(await withStore((store) => new GitOrchestrator(store).transfer(options.runId, options.worktreeId, options.dispatchId))));
  gitCommand.command("commit").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").requiredOption("--worktree-id <id>").requiredOption("--message <message>").requiredOption("--scope <paths>", "comma-separated repository-relative scopes").action(async (options) => output(await withStore((store) => new GitOrchestrator(store).commit(options.runId, options.worktreeId, options.message, options.scope.split(","), options.dispatchId))));
  gitCommand.command("merge-task").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").requiredOption("--integration-id <id>").requiredOption("--task-id <id>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).mergeTask(options.runId, options.integrationId, options.taskId, options.dispatchId)) }));
  gitCommand.command("continue-conflict").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").requiredOption("--integration-id <id>").requiredOption("--scope <paths>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).continueConflict(options.runId, options.integrationId, options.scope.split(","), options.dispatchId)) }));
  gitCommand.command("integrate").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").requiredOption("--integration-id <id>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).integrateTarget(options.runId, options.integrationId, options.dispatchId)) }));
  jsonOptions(gitCommand.command("reconcile").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").option("--operation-id <id>").option("--state <state>"), "--evidence-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
    new DispatchService(store).assertClaimed(options.runId, options.dispatchId, "git-operator");
    if (options.operationId) {
      if (!options.state) throw new ValidationError("reconcile mutation requires --state and JSON evidence");
      const input = await loadJsonInput(store, { file: options.evidenceFile, stagingId: options.stagingId, runId: options.runId, dispatchId: options.dispatchId, role: "git-operator", kind: "git-reconcile-evidence" }, retention);
      try {
      const evidence = input.value;
      const operation = store.db.prepare("SELECT operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json FROM operations WHERE operation_id=?")
        .get(options.operationId) as PlanningCommitOperation | undefined;
      if (operation?.kind === "planning.revision.commit") {
        if (!["completed", "not_applied"].includes(options.state)) throw new ValidationError("planning commit reconciliation state must be completed or not_applied");
        const result = reconcilePlanningCommit(store, operation, options.runId, options.dispatchId, options.state, evidence);
        await input.consume();
        return result;
      }
      store.reconcileOperation(options.operationId, options.state, evidence);
      await input.consume();
      } catch (error) { input.validationFailed(error); throw error; }
    } else if (options.evidenceFile || options.stagingId || options.state) {
      throw new ValidationError("reconcile evidence requires --operation-id and --state");
    }
    return new GitOrchestrator(store).reconcile(options.runId);
  }));
  });
  gitCommand.command("cleanup").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").action(async ({ runId, dispatchId }) => output({ removed: await withStore((store) => new GitOrchestrator(store).cleanup(runId, dispatchId)) }));

  const scope = program.command("scope");
  scope.command("check").requiredOption("--run-id <id>").addOption(new Option("--stage <stage>").choices(["triage", "pre_write", "pre_commit"]).makeOptionMandatory()).requiredOption("--paths <paths>", "comma-separated repository-relative paths").action(async (options) => output(await withStore((store) => new ScopeGate(store).check(options.runId, options.stage, options.paths.split(",")))));

  const decision = program.command("decision");
  decision.command("schema").action(() => output(DECISION_INPUT_SCHEMA));
  decision.command("template").action(() => output(DECISION_INPUT_TEMPLATE));
  jsonOptions(decision.command("create").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>"), "--file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const run = store.getRun(options.runId) as { profile: Role };
      const role: Role = run.profile === "planning" ? "planning" : "coding";
      const input = await loadJsonInput(store, { file: options.file, stagingId: options.stagingId, runId: options.runId, role, kind: "decision" }, retention);
      try {
        const checked = checkDecisionInput(input.value);
        if (!checked.valid) throw new ValidationError("decision input is invalid", checked.errors);
        const value = checked.value;
        const result = { decision_id: store.createDecision(options.runId, value.question, value.choices, value.recommendation, value.type ?? "workflow", options.dispatchId) };
        await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });

  const research = program.command("research");
  jsonOptions(research.command("archive").requiredOption("--run-id <id>").requiredOption("--project <path>").requiredOption("--topic <topic>"), "--report-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.reportFile, stagingId: options.stagingId, runId: options.runId, role: "researcher", kind: "research-conclusions" }, retention);
      try {
        const result = await new ResearchService(store).archive(options.runId, options.project, options.topic, input.value as ResearchConclusion[]);
        await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });

  const review = program.command("review");
  review.command("create").requiredOption("--run-id <id>").requiredOption("--revision-sha <sha>").option("--formal").action(async (options) => { validateCommand("review.create", { runId: options.runId, revisionSha: options.revisionSha, formal: options.formal }); output(await withStore((store) => new ReviewService(store).create(options.runId, options.revisionSha, options.formal))); });
  jsonOptions(review.command("submit").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>"), "--result-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.resultFile, stagingId: options.stagingId, runId: options.runId, kind: "review-result" }, retention);
      try {
        const value = input.value as ReviewResult;
        const role: Role = value.axis === "spec" ? "review-spec" : "review-standards";
        if (input.entry && input.entry.role !== role) throw new ValidationError("review staging role does not match result axis");
        const result = new ReviewService(store).submit(options.runId, options.barrierId, value);
        await input.consume({ role });
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });
  jsonOptions(review.command("resolve").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>"), "--resolution-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.resolutionFile, stagingId: options.stagingId, runId: options.runId, role: "coding", kind: "review-resolution" }, retention);
      try {
        const result = new ReviewService(store).resolve(options.runId, options.barrierId, input.value as FindingResolution[]);
        await input.consume();
        return result;
      } catch (error) { input.validationFailed(error); throw error; }
    }));
  });
  review.command("status").requiredOption("--run-id <id>").option("--barrier-id <id>").option("--revision-sha <sha>").action(async (options) => output(await withStore((store) => new ReviewService(store).status(options.runId, options.barrierId, options.revisionSha), { readonly: true })));

  program.command("install").option("--platform <list>", "comma-separated platforms", platformList).option("--dry-run").action(async (options) => { const service = new EnvironmentService(); const environment = await service.load(await service.active()); const platforms = options.platform ?? environment.platforms; const versions = await service.validateClientVersions(platforms); output({ versions, plan: await service.generate(environment.name, platforms, options.dryRun) }); });
  const env = program.command("env");
  env.command("list").action(async () => output(await new EnvironmentService().list()));
  env.command("show").argument("<name>").option("--resolved").action(async (name, options) => { const service = new EnvironmentService(); const value = await service.load(name); output(options.resolved ? { environment: value, resolved: (await import("./environment.js")).resolveEnvironment(value) } : value); });
  env.command("validate").argument("<name>").action(async (name) => output(await new EnvironmentService().validate(name)));
  env.command("explain").argument("<name>")
    .addOption(new Option("--role <role>").choices([...ROLES]).makeOptionMandatory())
    .addOption(new Option("--platform <platform>").choices([...PLATFORMS]).makeOptionMandatory())
    .action(async (name, options) => output(await new EnvironmentService().explain(name, options.role as Role, options.platform as Platform)));
  env.command("diff").argument("<from>").argument("<to>")
    .addOption(new Option("--role <role>").choices([...ROLES]))
    .addOption(new Option("--platform <platform>").choices([...PLATFORMS]))
    .action(async (from, to, options) => output(await new EnvironmentService().diff(from, to, options.role as Role | undefined, options.platform as Platform | undefined)));
  env.command("edit").argument("<name>").action(async (name) => { const service = new EnvironmentService(); await service.load(name); output({ path: `${service.paths.environments}/${name}.yaml`, edited: false, note: "edit the validated YAML file with your preferred editor" }); });
  env.command("generate").option("--platform <list>", "comma-separated platforms", platformList).option("--dry-run").action(async (options) => { const service = new EnvironmentService(); output(await service.generate(await service.active(), options.platform, options.dryRun)); });
  env.command("switch").argument("<name>").option("--dry-run").action(async (name, options) => output(await new EnvironmentService().generate(name, undefined, options.dryRun)));
  env.command("status").action(async () => output(await new EnvironmentService().status()));
  env.command("doctor").option("--probe").action(async ({ probe }) => output(await new EnvironmentService().doctor(probe)));

  const backup = program.command("backup");
  backup.command("restore").argument("<path>").option("--dry-run").action(async (path, options) => output(await new EnvironmentService().restore(path, options.dryRun)));
  program.command("uninstall").option("--dry-run").action(async ({ dryRun }) => output(await new EnvironmentService().uninstall(dryRun)));

  program.command("contract").description("Print the installed contract metadata").action(() => output({ contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST, agent_build_digest: AGENT_BUILD.digest, template_version: AGENT_BUILD.templateVersion, roles: ROLES }));
  return program;
};

export const main = async (argv = process.argv): Promise<void> => {
  humanOutput = argv.includes("--human");
  legacyOutput = argv.includes("--legacy-output");
  try { await buildProgram().parseAsync(argv); }
  catch (error) {
    if (error instanceof AiTeamError) {
      const failure = { ok: false, error: error.message, details: error.details ?? null, code: error.code };
      process.stderr.write(`${humanOutput ? humanize(failure) : JSON.stringify(failure)}\n`);
      process.exitCode = error.code; return;
    }
    const commander = error as { code?: string; exitCode?: number; message?: string };
    if (commander.code?.startsWith("commander.")) {
      if (commander.exitCode === EXIT.ok) return;
      const failure = { ok: false, error: commander.message ?? commander.code, details: null, code: EXIT.args };
      process.stderr.write(`${humanOutput ? humanize(failure) : JSON.stringify(failure)}\n`);
      process.exitCode = EXIT.args; return;
    }
    const failure = { ok: false, error: error instanceof Error ? error.message : String(error), details: null, code: EXIT.internal };
    process.stderr.write(`${humanOutput ? humanize(failure) : JSON.stringify(failure)}\n`); process.exitCode = EXIT.internal;
  }
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
