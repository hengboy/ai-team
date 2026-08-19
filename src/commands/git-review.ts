import { Command, Option } from "commander";
import type { Role, StagingKind } from "../constants.js";
import { ArgumentError, ValidationError } from "../errors.js";
import { REVIEW_RESOLUTION_SCHEMA, REVIEW_RESOLUTION_TEMPLATE, REVIEW_RESULT_SCHEMA, ReviewService, type ReviewResult } from "../review.js";
import type { StateStore, StagingBinding, StagingEntry } from "../state.js";
import { validateCommand } from "../command-contract.js";
import { DispatchService } from "../dispatch.js";
import { worktreeStatus } from "../git.js";
import { GitOrchestrator } from "../git-orchestrator.js";
import { ScopeGate } from "../gates.js";

export const registerReviewSchema = (review: Command, output: (value: unknown) => void): void => {
  review.command("schema").action(() => output(REVIEW_RESULT_SCHEMA));
};

interface JsonInput {
  file?: string;
  stagingId?: string;
  inputStdin?: boolean;
  runId?: string;
  dispatchId?: string;
  role?: Role;
  kind: StagingKind;
  roleFromValue?: (value: unknown) => Role;
}

interface LoadedJson {
  value: unknown;
  entry?: StagingEntry;
  consume(extra?: StagingBinding): Promise<StagingEntry | undefined>;
  validationFailed(error: unknown): never;
}

interface ReviewDependencies {
  output(value: unknown): void;
  withStore<T>(action: (store: StateStore) => Promise<T> | T, options?: { readonly?: boolean }): Promise<T>;
  jsonOptions(command: Command, fileFlag: string): Command;
  retentionHours(): Promise<number>;
  loadJsonInput(store: StateStore, input: JsonInput, retentionHours: number): Promise<LoadedJson>;
  withStagingResult<T>(result: T, entry?: StagingEntry): T | (T & { staging: unknown });
}

interface GitDependencies extends ReviewDependencies {
  reconcilePlanningCommit(store: StateStore, operation: any, runId: string, dispatchId: string, state: "completed" | "not_applied", evidence: unknown): unknown;
}

export const registerGitCommands = (program: Command, dependencies: GitDependencies): void => {
  const { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult, reconcilePlanningCommit } = dependencies;
  const gitCommand = program.command("git");
  gitCommand.command("status").requiredOption("--run-id <id>").action(async ({ runId }) => output(await withStore(async (store) => {
    const run = store.getRun(runId);
    const repo = store.db.prepare("SELECT * FROM repositories WHERE repo_id=?").get(run.repo_id);
    return { run_id: runId, repository: repo, target_worktree: await worktreeStatus((repo as any).project_path), worktrees: await new GitOrchestrator(store).status(runId) };
  }, { readonly: true })));
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
  jsonOptions(gitCommand.command("reconcile").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").option("--operation-id <id>").addOption(new Option("--state <state>", "completed, not_applied, or conflicted; conflicted evidence requires integration_worktree_id, conflict_paths, integration_head_before, and target_head").choices(["completed", "not_applied", "conflicted"])), "--evidence-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
    const hasJsonInput = Boolean(options.evidenceFile || options.stagingId || options.inputStdin);
    if (hasJsonInput) {
      const input = await loadJsonInput(store, { file: options.evidenceFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, dispatchId: options.dispatchId, role: "git-operator", kind: "git-reconcile-evidence" }, retention);
      try {
      new DispatchService(store).assertClaimed(options.runId, options.dispatchId, "git-operator");
      if (!options.operationId || !options.state) throw new ValidationError("reconcile evidence requires --operation-id and --state");
      const evidence = input.value;
      const operation = store.db.prepare("SELECT operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json FROM operations WHERE operation_id=?")
        .get(options.operationId) as any;
      if (!operation || operation.run_id !== options.runId) throw new ValidationError("git reconciliation operation does not belong to run");
      if (operation?.kind === "planning.revision.commit") {
        if (!["completed", "not_applied"].includes(options.state)) throw new ValidationError("planning commit reconciliation state must be completed or not_applied");
        const result = reconcilePlanningCommit(store, operation, options.runId, options.dispatchId, options.state, evidence);
        return withStagingResult(result, await input.consume());
      }
      if (options.state === "conflicted") {
        const result = await new GitOrchestrator(store).reconcileSyncConflict(options.runId, options.operationId, evidence, options.dispatchId);
        return withStagingResult(result, await input.consume());
      }
      store.db.transaction(() => {
        store.reconcileOperation(options.operationId, options.state, evidence);
        const run = store.getRun(options.runId) as { state: string };
        if (run.state === "failed" || run.state === "retryable_failure") {
          store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), options.runId);
          store.event(options.runId, "run.git_reconciliation_activated", { dispatch_id: options.dispatchId, operation_id: options.operationId, reconciliation_state: options.state });
        }
      })();
      return withStagingResult(new GitOrchestrator(store).reconcile(options.runId), await input.consume());
      } catch (error) { input.validationFailed(error); }
    } else if (options.operationId || options.state) {
      throw new ValidationError("reconcile evidence requires --operation-id and --state");
    }
    new DispatchService(store).assertClaimed(options.runId, options.dispatchId, "git-operator");
    return new GitOrchestrator(store).reconcile(options.runId);
  }));
  });
  gitCommand.command("cleanup").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").action(async ({ runId, dispatchId }) => output({ removed: await withStore((store) => new GitOrchestrator(store).cleanup(runId, dispatchId)) }));

  const scope = program.command("scope");
  scope.command("check").requiredOption("--run-id <id>").addOption(new Option("--stage <stage>").choices(["triage", "pre_write", "pre_commit"]).makeOptionMandatory()).requiredOption("--paths <paths>", "comma-separated repository-relative paths").option("--worktree-id <id>", "required for planned pre_commit scope").action(async (options) => output(await withStore((store) => new ScopeGate(store).check(options.runId, options.stage, options.paths.split(","), options.worktreeId))));
};

export const registerReviewCommands = (program: Command, dependencies: ReviewDependencies): void => {
  const { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult } = dependencies;
  const review = program.command("review");
  registerReviewSchema(review, output);
  review.command("resolution-schema").description("Print the P0/P1 review resolution array schema").action(() => output(REVIEW_RESOLUTION_SCHEMA));
  review.command("resolution-template").description("Print a review resolution array template; omit P2/P3 findings").action(() => output(REVIEW_RESOLUTION_TEMPLATE));
  review.command("create").requiredOption("--run-id <id>").requiredOption("--revision-sha <sha>").option("--formal").action(async (options) => {
    validateCommand("review.create", { runId: options.runId, revisionSha: options.revisionSha, formal: options.formal });
    output(await withStore((store) => new ReviewService(store).create(options.runId, options.revisionSha, options.formal)));
  });
  jsonOptions(review.command("submit").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>").addOption(new Option("--role <role>").choices(["review-spec", "review-standards"])), "--result-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      if (options.inputStdin && !options.role) throw new ArgumentError("review submit --input-stdin requires --role");
      const input = await loadJsonInput(store, {
        file: options.resultFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, kind: "review-result",
        ...(options.inputStdin ? { role: options.role as Role } : {}),
        roleFromValue: (source) => (source as { axis?: unknown })?.axis === "spec" ? "review-spec" : "review-standards",
      }, retention);
      try {
        const value = input.value as ReviewResult;
        const role: Role = value.axis === "spec" ? "review-spec" : "review-standards";
        if (options.role && options.role !== role) throw new ValidationError("review role does not match result axis");
        if (input.entry && input.entry.role !== role) throw new ValidationError("review staging role does not match result axis");
        const result = await new ReviewService(store).submitValue(options.runId, options.barrierId, value);
        return withStagingResult(result, await input.consume({ role }));
      } catch (error) { input.validationFailed(error); }
    }));
  });
  jsonOptions(review.command("resolve").description("Resolve blocking P0/P1 findings from a resolution array; do not include P2/P3 findings").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>"), "--resolution-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.resolutionFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "coding", kind: "review-resolution" }, retention);
      try {
        const result = new ReviewService(store).resolve(options.runId, options.barrierId, input.value);
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });
  review.command("status").requiredOption("--run-id <id>").option("--barrier-id <id>").option("--revision-sha <sha>").action(async (options) => {
    output(await withStore((store) => new ReviewService(store).status(options.runId, options.barrierId, options.revisionSha), { readonly: true }));
  });
};
