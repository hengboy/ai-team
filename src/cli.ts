#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { CONTRACT_DIGEST } from "./contracts.js";
import { validateCommand } from "./command-contract.js";
import { EXIT, PACKAGE_VERSION, ROLES } from "./constants.js";
import { DispatchService } from "./dispatch.js";
import { EnvironmentService, PLATFORMS, type Platform } from "./environment.js";
import { AiTeamError, ValidationError } from "./errors.js";
import { commitPlanningRevision, repositoryIdentity, worktreeStatus } from "./git.js";
import { GitOrchestrator } from "./git-orchestrator.js";
import { ScopeGate } from "./gates.js";
import { runnableTaskBatches, type TaskDefinition } from "./tasks.js";
import { writeRevision, nextPlanState, type RevisionDocuments } from "./planning.js";
import { initializeProject } from "./project.js";
import { ReviewService, type FindingResolution, type ReviewResult } from "./review.js";
import { ResearchService } from "./research-service.js";
import type { ResearchConclusion } from "./research.js";
import { ROLE_MANIFEST_DIGEST } from "./roles.js";
import { AGENT_BUILD } from "./roles.js";
import { StateStore } from "./state.js";
import { WorkflowService } from "./workflow.js";

const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
const roleOption = (): Option => new Option("--role <role>").choices([...ROLES]).makeOptionMandatory();
const platformList = (value: string): Platform[] => {
  const platforms = value.split(",") as Platform[];
  if (platforms.some((item) => !PLATFORMS.includes(item))) throw new ValidationError(`invalid platform list: ${value}`);
  return platforms;
};

const withStore = async <T>(action: (store: StateStore) => Promise<T> | T): Promise<T> => {
  const store = await StateStore.open();
  try { return await action(store); } finally { store.close(); }
};

const requestOptions = (command: Command): Command => command.option("--request-file <file>").option("--request-stdin");

export const buildProgram = (): Command => {
  const program = new Command().name("ai-team").description("Local AI coding team workflow orchestration").version(PACKAGE_VERSION);
  program.configureOutput({ outputError: (text) => process.stderr.write(text) });

  program.command("init").argument("<project>").option("--yes", "confirm a patch to a dirty .gitignore").action(async (project, options) => output(await initializeProject(project, options.yes)));
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
  revision.command("create").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--target-branch <branch>").requiredOption("--documents-file <file>").option("--supersedes <nnn>").option("--run-id <id>").action(async (options) => {
    const docs = JSON.parse(await readFile(options.documentsFile, "utf8")) as RevisionDocuments;
    const result = await writeRevision(options.project, options.planId, options.revision, options.targetBranch, docs, options.supersedes);
    const repo = await repositoryIdentity(options.project);
    await withStore((store) => {
      store.registerRepository(repo.repoId, repo.commonDir, repo.root);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,supersedes,created_at) VALUES (?,?,?,'draft',?,?,?,?)")
        .run(options.planId, options.revision, repo.repoId, options.targetBranch, result.digest, options.supersedes ?? null, new Date().toISOString());
      if (options.runId) store.bindPlanningRevision(options.runId, repo.repoId, options.planId, options.revision);
    });
    output(result);
  });
  revision.command("transition").requiredOption("--project <path>").requiredOption("--plan-id <id>").requiredOption("--revision <nnn>").requiredOption("--to <state>").option("--plan-commit <sha>").action(async (options) => {
    const repo = await repositoryIdentity(options.project);
    output(await withStore((store) => {
      const row = store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(repo.repoId, options.planId, options.revision) as { state: string } | undefined;
      if (!row) throw new ValidationError("planning revision not found");
      if (options.to === "ready") throw new ValidationError("ready state requires planning revision commit");
      const state = nextPlanState(row.state, options.to);
      let dispatchId: string | undefined;
      const transition = store.db.transaction(() => {
        store.db.prepare("UPDATE revisions SET state=?,plan_commit=COALESCE(?,plan_commit) WHERE repo_id=? AND plan_id=? AND revision=?").run(state, options.planCommit ?? null, repo.repoId, options.planId, options.revision);
        if (state === "plan_ready") {
          const runs = store.db.prepare("SELECT run_id FROM runs WHERE repo_id=? AND profile='planning' AND plan_id=? AND revision=? AND state='active'").all(repo.repoId, options.planId, options.revision) as Array<{ run_id: string }>;
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
      new DispatchService(store).assertClaimed(options.runId, options.dispatchId, "git-operator");
      const run = store.getRun(options.runId) as { repo_id: string; profile: string };
      if (run.repo_id !== repo.repoId || run.profile !== "planning") throw new ValidationError("planning commit dispatch does not belong to this revision repository");
      const row = store.db.prepare("SELECT * FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(repo.repoId, options.planId, options.revision) as any;
      if (!row || !["plan_ready", "tasks_preview"].includes(row.state) || !row.digest) throw new ValidationError("planning revision is not ready to commit");
      const commit = await commitPlanningRevision(repo.root, options.planId, options.revision, row.digest);
      store.db.prepare("UPDATE revisions SET state='ready',plan_commit=? WHERE repo_id=? AND plan_id=? AND revision=?").run(commit, repo.repoId, options.planId, options.revision);
      return { state: "ready", plan_commit: commit };
    }));
  });
  const tasks = planning.command("tasks");
  tasks.command("validate").requiredOption("--file <json>").action(async ({ file }) => {
    const definitions = JSON.parse(await readFile(file, "utf8")) as TaskDefinition[];
    output({ valid: true, batches: runnableTaskBatches(definitions) });
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
  run.command("show").argument("<run-id>").action(async (runId) => output(await withStore((store) => ({ run: store.getRun(runId), events: store.db.prepare("SELECT * FROM run_events WHERE run_id=? ORDER BY event_id").all(runId), decisions: store.db.prepare("SELECT * FROM decisions WHERE run_id=? ORDER BY created_at").all(runId), dispatches: store.db.prepare("SELECT dispatch_id,role,state,claimed_at,completed_at,created_at FROM dispatches WHERE run_id=? ORDER BY created_at").all(runId) }))));
  run.command("resume").argument("<run-id>").action(async (runId) => output(await withStore((store) => ({
    run: store.getRun(runId),
    pending_dispatches: store.db.prepare("SELECT dispatch_id,role,state FROM dispatches WHERE run_id=? AND state!='completed'").all(runId),
    pending_decision: store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").get(runId) ?? null,
    pending_operations: store.db.prepare("SELECT operation_id,kind,state FROM operations WHERE run_id=? AND state='pending'").all(runId),
    last_event: store.db.prepare("SELECT type,payload_json,created_at FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1").get(runId) ?? null,
  }))));
  run.command("decide").requiredOption("--run-id <id>").requiredOption("--decision-id <id>").requiredOption("--choice <id>").option("--note-file <file>").action(async (options) => withStore(async (store) => { const note = options.noteFile ? await readFile(options.noteFile, "utf8") : undefined; store.decide(options.runId, options.decisionId, options.choice, note); const run = store.getRun(options.runId) as { profile: string }; const dispatchId = run.profile === "planning" ? new DispatchService(store).continuePlanning(options.runId) : undefined; output({ status: "resolved", ...(dispatchId ? { dispatch_id: dispatchId } : {}) }); }));

  const dispatch = program.command("dispatch");
  dispatch.command("create").requiredOption("--run-id <id>").addOption(roleOption()).requiredOption("--packet-file <file>").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).action(async (options) => output(await withStore(async (store) => {
    const packet = JSON.parse(await readFile(options.packetFile, "utf8"));
    return { dispatch_id: new DispatchService(store).create(options.runId, options.role, packet, options.actorRole) };
  })));
  const dispatchCommand = (name: string): Command => dispatch.command(name).requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").addOption(roleOption()).hook("preAction", (_command, action) => validateCommand("dispatch.identity", { runId: action.opts().runId, dispatchId: action.opts().dispatchId, role: action.opts().role }));
  dispatchCommand("claim").action(async (options) => output(await withStore((store) => new DispatchService(store).claim(options.runId, options.dispatchId, options.role))));
  dispatchCommand("prompt").action(async (options) => { process.stdout.write(`${await withStore((store) => new DispatchService(store).prompt(options.runId, options.dispatchId, options.role))}\n`); });
  dispatchCommand("schema").action(async (options) => output(await withStore((store) => new DispatchService(store).schema(options.runId, options.dispatchId, options.role))));
  dispatchCommand("validate").requiredOption("--result-file <file>").action(async (options) => output({ valid: true, result: await withStore((store) => new DispatchService(store).validateFile(options.runId, options.dispatchId, options.role, options.resultFile)) }));
  dispatchCommand("submit").requiredOption("--result-file <file>").action(async (options) => output(await withStore((store) => new DispatchService(store).submit(options.runId, options.dispatchId, options.role, options.resultFile))));

  const gitCommand = program.command("git");
  gitCommand.command("status").requiredOption("--run-id <id>").action(async ({ runId }) => output(await withStore(async (store) => { const run = store.getRun(runId); const repo = store.db.prepare("SELECT * FROM repositories WHERE repo_id=?").get(run.repo_id); return { run_id: runId, repository: repo, worktree: await worktreeStatus((repo as any).project_path) }; })));
  gitCommand.command("prepare").requiredOption("--run-id <id>").option("--task-id <id>", "task id or implementation", "implementation").option("--integration").option("--base-commit <sha>").option("--depends-on <worktree-id>").action(async (options) => output(await withStore((store) => options.integration ? new GitOrchestrator(store).prepareIntegration(options.runId) : new GitOrchestrator(store).prepareTask(options.runId, options.taskId, options.baseCommit, options.dependsOn))));
  gitCommand.command("commit").requiredOption("--run-id <id>").requiredOption("--worktree-id <id>").requiredOption("--message <message>").requiredOption("--scope <paths>", "comma-separated repository-relative scopes").action(async (options) => output(await withStore((store) => new GitOrchestrator(store).commit(options.runId, options.worktreeId, options.message, options.scope.split(",")))));
  gitCommand.command("merge-task").requiredOption("--run-id <id>").requiredOption("--integration-id <id>").requiredOption("--task-id <id>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).mergeTask(options.runId, options.integrationId, options.taskId)) }));
  gitCommand.command("continue-conflict").requiredOption("--run-id <id>").requiredOption("--integration-id <id>").requiredOption("--scope <paths>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).continueConflict(options.runId, options.integrationId, options.scope.split(","))) }));
  gitCommand.command("integrate").requiredOption("--run-id <id>").requiredOption("--integration-id <id>").action(async (options) => output({ commit: await withStore((store) => new GitOrchestrator(store).integrateTarget(options.runId, options.integrationId)) }));
  gitCommand.command("reconcile").requiredOption("--run-id <id>").option("--operation-id <id>").option("--state <state>").option("--evidence-file <file>").action(async (options) => output(await withStore(async (store) => {
    if (options.operationId) {
      if (!options.state || !options.evidenceFile) throw new ValidationError("reconcile mutation requires --state and --evidence-file");
      const evidence = JSON.parse(await readFile(options.evidenceFile, "utf8"));
      store.reconcileOperation(options.operationId, options.state, evidence);
    }
    return new GitOrchestrator(store).reconcile(options.runId);
  })));
  gitCommand.command("cleanup").requiredOption("--run-id <id>").action(async ({ runId }) => output({ removed: await withStore((store) => new GitOrchestrator(store).cleanup(runId)) }));

  const scope = program.command("scope");
  scope.command("check").requiredOption("--run-id <id>").addOption(new Option("--stage <stage>").choices(["triage", "pre_write", "pre_commit"]).makeOptionMandatory()).requiredOption("--paths <paths>", "comma-separated repository-relative paths").action(async (options) => output(await withStore((store) => new ScopeGate(store).check(options.runId, options.stage, options.paths.split(",")))));

  const decision = program.command("decision");
  decision.command("create").requiredOption("--run-id <id>").requiredOption("--file <json>").action(async (options) => output(await withStore(async (store) => {
    const value = JSON.parse(await readFile(options.file, "utf8"));
    return { decision_id: store.createDecision(options.runId, value.question, value.choices, value.recommendation) };
  })));

  const research = program.command("research");
  research.command("archive").requiredOption("--run-id <id>").requiredOption("--project <path>").requiredOption("--topic <topic>").requiredOption("--report-file <file>").action(async (options) => output(await withStore(async (store) => {
    const conclusions = JSON.parse(await readFile(options.reportFile, "utf8")) as ResearchConclusion[];
    return new ResearchService(store).archive(options.runId, options.project, options.topic, conclusions);
  })));

  const review = program.command("review");
  review.command("create").requiredOption("--run-id <id>").requiredOption("--revision-sha <sha>").option("--formal").action(async (options) => { validateCommand("review.create", { runId: options.runId, revisionSha: options.revisionSha, formal: options.formal }); output(await withStore((store) => new ReviewService(store).create(options.runId, options.revisionSha, options.formal))); });
  review.command("submit").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>").requiredOption("--result-file <file>").action(async (options) => output(await withStore(async (store) => new ReviewService(store).submit(options.runId, options.barrierId, JSON.parse(await readFile(options.resultFile, "utf8")) as ReviewResult))));
  review.command("resolve").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>").requiredOption("--resolution-file <file>").action(async (options) => output(await withStore(async (store) => new ReviewService(store).resolve(options.runId, options.barrierId, JSON.parse(await readFile(options.resolutionFile, "utf8")) as FindingResolution[]))));
  review.command("status").requiredOption("--run-id <id>").requiredOption("--barrier-id <id>").action(async (options) => output(await withStore((store) => new ReviewService(store).status(options.runId, options.barrierId))));

  program.command("install").option("--platform <list>", "comma-separated platforms", platformList).option("--dry-run").action(async (options) => { const service = new EnvironmentService(); const environment = await service.load(await service.active()); const platforms = options.platform ?? environment.platforms; const versions = await service.validateClientVersions(platforms); output({ versions, plan: await service.generate(environment.name, platforms, options.dryRun) }); });
  const env = program.command("env");
  env.command("list").action(async () => output(await new EnvironmentService().list()));
  env.command("show").argument("<name>").option("--resolved").action(async (name, options) => { const service = new EnvironmentService(); const value = await service.load(name); output(options.resolved ? { environment: value, resolved: (await import("./environment.js")).resolveEnvironment(value) } : value); });
  env.command("validate").argument("<name>").action(async (name) => output(await new EnvironmentService().validate(name)));
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
  try { await buildProgram().parseAsync(argv); }
  catch (error) {
    if (error instanceof AiTeamError) { process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details ?? null })}\n`); process.exitCode = error.code; return; }
    const commander = error as { code?: string; exitCode?: number; message?: string };
    if (commander.code?.startsWith("commander.")) { process.exitCode = commander.exitCode ?? EXIT.validation; return; }
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = EXIT.internal;
  }
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
