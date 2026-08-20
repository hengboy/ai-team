import { Option, type Command } from "commander";
import { validateCommand } from "../command-contract.js";
import { checkDecisionInput, DECISION_INPUT_SCHEMA, DECISION_INPUT_TEMPLATE } from "../contracts.js";
import type { Role } from "../constants.js";
import { DispatchService, type DispatchPacket } from "../dispatch.js";
import { ValidationError } from "../errors.js";
import { recoveryProjection } from "../run-recovery.js";
import { commitPlanningRevision, repositoryIdentity } from "../git.js";
import { assertRevisionCreateRunStage, assertRevisionDocuments, assertRevisionRunStage, hasTaskDocuments, nextPlanState, preflightRevision, writeRevision, type RevisionDocuments } from "../planning.js";
import { ReviewService } from "../review.js";
import { ResearchService } from "../research-service.js";
import type { ResearchConclusion } from "../research.js";
import type { StateStore } from "../state.js";
import { runnableTaskBatches, validateTaskPreview, type TaskDefinition } from "../tasks.js";
import { WorkflowService } from "../workflow.js";

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

export const reconcilePlanningCommit = (
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
      const closedPlanning = store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND role='planning' AND state IN ('pending','claimed','needs_decision')")
        .run(new Date().toISOString(), runId).changes;
      store.db.prepare("UPDATE runs SET stage='ready',state='active',updated_at=? WHERE run_id=?")
        .run(new Date().toISOString(), runId);
      store.event(runId, "planning.revision_committed", { planId: request.plan_id, revision: request.revision, commit: planCommit, reconciled: true, operationId: operation.operation_id });
      if (closedPlanning) store.event(runId, "planning.stale_dispatches_closed", { count: closedPlanning, reason: "revision_reconciled" });
      store.finishOperation(operation.operation_id, normalized);
    } else {
      store.reconcileOperation(operation.operation_id, "not_applied", normalized);
    }
    store.event(runId, "planning.revision_reconciled", { operationId: operation.operation_id, state, ...(state === "completed" ? { commit: planCommit } : {}) });
  })();
  return { operation_id: operation.operation_id, state, ...(state === "completed" ? { plan_commit: planCommit as string } : {}), reused: false };
};

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

export const requestOptions = (command: Command): Command => command.option("--request-file <file>").option("--request-stdin");

interface PlanningRunDependencies {
  output(value: unknown): void;
  withStore<T>(action: (store: StateStore) => Promise<T> | T, options?: { readonly?: boolean }): Promise<T>;
  readSafeFile(path: string): Promise<string>;
}

interface PlanningDependencies extends PlanningRunDependencies {
  jsonOptions(command: Command, fileFlag: string): Command;
  retentionHours(): Promise<number>;
  loadJsonInput(store: StateStore, input: any, retentionHours: number): Promise<any>;
  withStagingResult<T>(result: T, entry?: unknown): unknown;
}

export const registerPlanningCommands = (program: Command, dependencies: PlanningDependencies): void => {
  const { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult } = dependencies;
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
      const input = await loadJsonInput(store, { file: options.documentsFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "planning", kind: "planning-documents", readOnly: true }, retention);
      try {
        const result = await preflightPlanningRevision(store, {
          project: options.project, repoId: repo.repoId, planId: options.planId, revision: options.revision,
          supersedes: options.supersedes, runId: options.runId, documents: input.value,
        });
        return withStagingResult({ path: result.path, digest: result.digest, valid: true }, input.entry);
      } catch (error) { input.validationFailed(error); }
    }, { readonly: !options.inputStdin }));
  });
  jsonOptions(revision.command("create").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--target-branch <branch>").option("--supersedes <nnn>").option("--run-id <id>"), "--documents-file").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.documentsFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "planning", kind: "planning-documents" }, retention);
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
      return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
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
      const handoff = store.getRun(options.runId) as { source_run_id?: string };
      const handoffContract = handoff.source_run_id
        ? await new WorkflowService(store).planningSnapshot(repo.root, options.planId, options.revision, commit)
        : undefined;
      store.db.transaction(() => {
        store.db.prepare("UPDATE revisions SET state='ready',plan_commit=? WHERE repo_id=? AND plan_id=? AND revision=?").run(commit, repo.repoId, options.planId, options.revision);
        const closedPlanning = store.db.prepare("UPDATE dispatches SET state='completed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND role='planning' AND state IN ('pending','claimed','needs_decision')").run(new Date().toISOString(), options.runId).changes;
        store.db.prepare("UPDATE runs SET stage='ready',updated_at=? WHERE run_id=?").run(new Date().toISOString(), options.runId);
        store.event(options.runId, "planning.revision_committed", { planId: options.planId, revision: options.revision, commit });
        if (closedPlanning) store.event(options.runId, "planning.stale_dispatches_closed", { count: closedPlanning, reason: "revision_committed" });
        new WorkflowService(store).completePlanningHandoff(options.runId, options.planId, options.revision, revisionDigest, commit, handoffContract);
        store.finishOperation(operation.operationId, { state: "ready", plan_commit: commit });
      })();
      return { state: "ready", plan_commit: commit, operation_id: operation.operationId, reused: false };
    }));
  });
  const tasks = planning.command("tasks");
  jsonOptions(tasks.command("validate").option("--run-id <id>").option("--preview"), "--file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.file, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "planning", kind: "planning-tasks" }, retention);
      try {
        const definitions = input.value as TaskDefinition[];
        if (options.preview) validateTaskPreview(definitions);
        const result = { valid: true, batches: runnableTaskBatches(definitions) };
        return withStagingResult(result, options.preview ? input.entry : await input.consume());
      } catch (error) { input.validationFailed(error); }
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
};

export const registerDecisionResearchCommands = (program: Command, dependencies: PlanningDependencies): void => {
  const { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult } = dependencies;
  const decision = program.command("decision");
  decision.command("schema").action(() => output(DECISION_INPUT_SCHEMA));
  decision.command("template").action(() => output(DECISION_INPUT_TEMPLATE));
  jsonOptions(decision.command("create").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>"), "--file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const run = store.getRun(options.runId) as { profile: Role };
      const role: Role = run.profile === "planning" ? "planning" : "coding";
      const input = await loadJsonInput(store, { file: options.file, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role, kind: "decision" }, retention);
      try {
        const checked = checkDecisionInput(input.value);
        if (!checked.valid) throw new ValidationError("decision input is invalid", checked.errors);
        const value = checked.value;
        let taskSplit = false;
        if (run.profile === "planning" && value.type === "task_split") {
          const current = store.getRun(options.runId) as { stage: string; state: string };
          const ids = value.choices.map(({ id }) => id).sort();
          if (current.stage !== "plan_ready" || current.state !== "active") throw new ValidationError("task_split decision requires an active plan_ready run");
          if (ids.length !== 2 || ids[0] !== "no_split" || ids[1] !== "split") throw new ValidationError("task_split decision choices must be split and no_split");
          const dispatch = store.db.prepare("SELECT state,role FROM dispatches WHERE run_id=? AND dispatch_id=?").get(options.runId, options.dispatchId) as { state: string; role: string } | undefined;
          if (!dispatch || dispatch.role !== "planning" || !["claimed", "completed"].includes(dispatch.state)) throw new ValidationError("task_split decision requires a claimed or completed planning dispatch");
          taskSplit = true;
        }
        const result = { decision_id: store.createDecision(options.runId, value.question, value.choices, value.recommendation, value.type ?? "workflow", options.dispatchId) };
        if (taskSplit) {
          store.db.prepare("UPDATE dispatches SET state='needs_decision',completed_at=NULL WHERE dispatch_id=?").run(options.dispatchId);
          store.db.prepare("UPDATE runs SET state='needs_decision',updated_at=? WHERE run_id=?").run(new Date().toISOString(), options.runId);
        }
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });

  const research = program.command("research");
  jsonOptions(research.command("archive").requiredOption("--run-id <id>").requiredOption("--project <path>").requiredOption("--topic <topic>"), "--report-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.reportFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "researcher", kind: "research-conclusions" }, retention);
      try {
        const result = await new ResearchService(store).archive(options.runId, options.project, options.topic, input.value as ResearchConclusion[]);
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });
};

export const registerRunCommands = (program: Command, dependencies: PlanningRunDependencies): void => {
  const { output, withStore, readSafeFile } = dependencies;
  const run = program.command("run");
  run.command("show").argument("<run-id>").action(async (runId) => output(await withStore((store) => ({
    run: store.getRun(runId),
    review_barrier: new ReviewService(store).current(runId),
    events: store.db.prepare("SELECT * FROM run_events WHERE run_id=? AND type NOT LIKE 'command.%' ORDER BY event_id").all(runId),
    decisions: store.db.prepare("SELECT * FROM decisions WHERE run_id=? ORDER BY created_at").all(runId),
    dispatches: store.db.prepare("SELECT dispatch_id,role,state,claimed_at,completed_at,created_at FROM dispatches WHERE run_id=? ORDER BY created_at").all(runId),
    tasks: store.runTasks(runId),
    worktrees: store.db.prepare("SELECT worktree_id,branch,path,base_commit,state,adopted_from_run_id FROM worktrees WHERE run_id=? ORDER BY created_at,worktree_id").all(runId),
    ...new DispatchService(store).runShowProjection(runId),
    ...recoveryProjection(store, runId),
  }), { readonly: true })));
  requestOptions(run.command("handoff-to-planning").argument("<run-id>")).action(async (runId, options) => {
    validateCommand("run.handoff-to-planning", { runId, requestFile: options.requestFile, requestStdin: options.requestStdin });
    const request = await WorkflowService.requestFrom(options.requestFile, options.requestStdin);
    output(await withStore((store) => new WorkflowService(store).handoffToPlanning(runId, request)));
  });
  run.command("resume").argument("<run-id>").action(async (runId) => output(await withStore((store) => new DispatchService(store).resume(runId))));
  run.command("cancel").argument("<run-id>").requiredOption("--reason <text>").action(async (runId, options) => output(await withStore((store) => new WorkflowService(store).requestCancellation(runId, options.reason))));
  run.command("decide").requiredOption("--run-id <id>").requiredOption("--decision-id <id>").requiredOption("--choice <id>").option("--note-file <file>").action(async (options) => withStore(async (store) => {
    const note = options.noteFile ? await readSafeFile(options.noteFile) : undefined;
    const dispatchId = new DispatchService(store).resolveDecision(options.runId, options.decisionId, options.choice, note);
    const dispatch = store.db.prepare("SELECT role,replacement_for,packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(options.runId, dispatchId) as { role: string; replacement_for?: string; packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as DispatchPacket).context : {};
    output({ status: "resolved", dispatch_id: dispatchId, role: dispatch?.role ?? null, recovery_action: dispatch?.replacement_for || context.resolved_decision ? {
      type: "dispatch_replacement",
      replacement_for: dispatch?.replacement_for ?? null,
      resolved_decision: context.resolved_decision ?? null,
      next_command: dispatch ? `ai-team dispatch claim --run-id ${options.runId} --dispatch-id ${dispatchId} --role ${dispatch.role} --bundle` : null,
    } : null });
  }));
};
