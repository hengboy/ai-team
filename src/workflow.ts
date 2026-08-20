import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { currentBranch, currentHead, git, repositoryIdentity, worktreeStatus } from "./git.js";
import { frozenTaskWritePathsFromDocument, StateStore } from "./state.js";
import { DispatchService } from "./dispatch.js";
import { ValidationError } from "./errors.js";
import { parsePlanVerification, parseTaskVerification, triageRequest, type PlanVerification, type TaskVerification } from "./planning.js";
import { AGENT_BUILD } from "./roles.js";
import { assertReadablePath } from "./security.js";
import { GitOrchestrator } from "./git-orchestrator.js";
import { sha256 } from "./utils.js";
import type { Role } from "./constants.js";

const clientPlatform = (): string => {
  const value = process.env.AI_TEAM_CLIENT_PLATFORM ?? process.env.AI_TEAM_PLATFORM ?? "codex";
  if (!AGENT_BUILD.manifest.platforms.includes(value as any)) throw new ValidationError(`unsupported client platform: ${value}`);
  return value;
};

const directVerification = (request: string): PlanVerification => {
  const acceptanceCriterion = `AC-001: ${request.trim()}`;
  return {
    acceptance_criteria: [acceptanceCriterion],
    acceptance_steps: [{
      id: "VERIFY-001",
      acceptance_criteria: [acceptanceCriterion],
      command: "Independent Test verification",
      expected_result: "passes",
    }],
    task_mapping: [{ task_id: "DIRECT-001", acceptance_criteria: [acceptanceCriterion] }],
    test_commands: [],
  };
};

export class WorkflowService {
  readonly dispatches: DispatchService;
  constructor(readonly store: StateStore) { this.dispatches = new DispatchService(store); }

  async planningStart(project: string, request: string): Promise<{ run_id: string; dispatch_id: string }> {
    if (!request.trim()) throw new ValidationError("planning request cannot be empty");
    const repo = await repositoryIdentity(project);
    this.store.registerRepository(repo.repoId, repo.commonDir, repo.root);
    const branch = await currentBranch(repo.root);
    const runId = this.store.createRun({ repoId: repo.repoId, profile: "planning", mode: "planned", targetBranch: branch, request, clientPlatform: clientPlatform() });
    const commandId = this.store.startCommand(runId, "planning start");
    try {
      const dispatchId = this.store.terminalCommand(commandId, "completed", { command: "planning start", retry_safe: false }, () => this.dispatches.create(runId, "file-explorer", {
        objective: "Explore the repository for the planning request. Read existing MEMORY.md and .ai-team/index/feature-navigation.md first, then return entry points, constraints, risks, test locations, and project_context.",
        allowed_read_paths: ["."],
        allowed_write_paths: [],
        acceptance_criteria: ["Repository facts are supported by file paths", "Unknowns are explicit"],
        context: { request },
      }, "planning"));
      return { run_id: runId, dispatch_id: dispatchId };
    } catch (error) {
      this.store.terminalCommand(commandId, "failed", { command: "planning start", cause: error instanceof Error ? error.message : String(error), retry_safe: false }, () => {});
      throw error;
    }
  }

  handoffToPlanning(sourceRunId: string, request: string): { run_id: string; dispatch_id: string; source_run_id: string; reused: boolean } {
    if (!request.trim()) throw new ValidationError("planning handoff request cannot be empty");
    return this.store.db.transaction(() => {
      const source = this.store.getRun(sourceRunId) as { repo_id: string; profile: string; state: string; target_branch?: string; base_commit?: string };
      if (source.profile !== "coding" || source.state !== "frozen") throw new ValidationError("planning handoff requires a frozen coding run");
      const pendingOperation = this.store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending'").get(sourceRunId) as { operation_id: string } | undefined;
      if (pendingOperation) throw new ValidationError(`planning handoff requires operation reconciliation: ${pendingOperation.operation_id}`);
      const worktrees = this.store.db.prepare("SELECT worktree_id,branch,path,base_commit,state FROM worktrees WHERE run_id=? AND state='active' ORDER BY created_at").all(sourceRunId) as Array<Record<string, unknown>>;
      if (!worktrees.some((worktree) => String(worktree.branch).startsWith("task/"))) throw new ValidationError("planning handoff requires an active task worktree to preserve");
      const existing = this.store.db.prepare("SELECT run_id FROM runs WHERE source_run_id=?").get(sourceRunId) as { run_id: string } | undefined;
      if (existing) {
        const dispatch = this.store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? ORDER BY created_at LIMIT 1").get(existing.run_id) as { dispatch_id: string };
        return { run_id: existing.run_id, dispatch_id: dispatch.dispatch_id, source_run_id: sourceRunId, reused: true };
      }
      const runId = this.store.createRun({
        repoId: source.repo_id,
        profile: "planning",
        mode: "planned",
        ...(source.target_branch ? { targetBranch: source.target_branch } : {}),
        ...(source.base_commit ? { baseCommit: source.base_commit } : {}),
        request,
        clientPlatform: clientPlatform(),
        sourceRunId,
      });
      const dispatchId = this.dispatches.create(runId, "file-explorer", {
        objective: "Reconcile the frozen source run through Planning while preserving its managed task worktrees.",
        allowed_read_paths: ["."],
        allowed_write_paths: [],
        acceptance_criteria: ["Produce a planning revision linked to the frozen source run", "Preserve every source worktree and its audit identity"],
        context: { request, source_run_id: sourceRunId, preserved_worktrees: worktrees },
      }, "planning");
      const now = new Date().toISOString();
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE run_id=? AND state IN ('pending','claimed')").run(now, sourceRunId);
      this.store.event(sourceRunId, "run.planning_handoff_started", { planning_run_id: runId, preserved_worktree_ids: worktrees.map((worktree) => worktree.worktree_id) });
      this.store.event(runId, "planning.source_run_linked", { source_run_id: sourceRunId, preserved_worktree_ids: worktrees.map((worktree) => worktree.worktree_id) });
      return { run_id: runId, dispatch_id: dispatchId, source_run_id: sourceRunId, reused: false };
    })();
  }

  completePlanningHandoff(planningRunId: string, planId: string, revision: string, planDigest: string, planCommit: string): string | undefined {
    const planningRun = this.store.getRun(planningRunId) as { profile: string; source_run_id?: string };
    if (planningRun.profile !== "planning" || !planningRun.source_run_id) return undefined;
    const source = this.store.getRun(planningRun.source_run_id) as { profile: string; state: string };
    if (source.profile !== "coding" || !["frozen", "active"].includes(source.state)) throw new ValidationError("planning handoff source is not a recoverable coding run");
    if (source.state === "active") return planningRun.source_run_id;
    this.store.db.prepare("UPDATE runs SET state='active',stage='coding',plan_id=?,revision=?,plan_digest=?,updated_at=? WHERE run_id=? AND state='frozen'")
      .run(planId, revision, planDigest, new Date().toISOString(), planningRun.source_run_id);
    this.store.event(planningRun.source_run_id, "run.planning_handoff_completed", { planning_run_id: planningRunId, plan_id: planId, revision, plan_commit: planCommit });
    this.store.event(planningRunId, "planning.source_run_resumed", { source_run_id: planningRun.source_run_id });
    return planningRun.source_run_id;
  }

  async bindPlanningRevision(runId: string, project: string, planId: string, revision: string): Promise<void> {
    const repo = await repositoryIdentity(project);
    this.store.bindPlanningRevision(runId, repo.repoId, planId, revision);
  }

  requestCancellation(runId: string, reason: string): { state: "canceling" | "canceled"; dispatch_id: string | null; role: "git-operator" | null; depends_on: string[] } {
    if (!reason.trim()) throw new ValidationError("run cancellation requires a reason");
    const run = this.store.getRun(runId) as { profile: string; state: string; stage: string };
    if (run.profile !== "coding") throw new ValidationError("run cancellation is available only for coding runs");
    const existing = this.store.db.prepare("SELECT dispatch_id,state FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='cancel_cleanup' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { dispatch_id: string; state: string } | undefined;
    if (existing) return { state: existing.state === "completed" ? "canceled" : "canceling", dispatch_id: existing.dispatch_id, role: "git-operator", depends_on: [] };
    if (run.state === "completed" || run.state === "canceled") throw new ValidationError(`run cannot be canceled from ${run.state}`);
    const operation = this.store.db.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending' ORDER BY created_at LIMIT 1").get(runId) as { operation_id: string } | undefined;
    if (operation) throw new ValidationError(`run cancellation requires operation reconciliation: ${operation.operation_id}`);
    const worktrees = this.store.db.prepare("SELECT worktree_id FROM worktrees WHERE run_id=? AND state='active' ORDER BY created_at,worktree_id").all(runId) as Array<{ worktree_id: string }>;
    if (!worktrees.length) {
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND state IN ('pending','claimed')").run(new Date().toISOString(), runId);
        this.store.db.prepare("UPDATE runs SET state='canceled',stage='canceled',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.canceled", { reason, worktree_ids: [] });
      })();
      return { state: "canceled", dispatch_id: null, role: null, depends_on: [] };
    }
    const dispatchId = this.dispatches.create(runId, "git-operator", {
      objective: "Remove every clean worktree and branch owned by this canceled run.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Remove only the listed run-owned worktrees", "Refuse dirty worktrees or unsafe paths"],
      context: { stage: "git-operator", phase: "cancel_cleanup", reason, worktree_ids: worktrees.map(({ worktree_id }) => worktree_id) },
    }, "coding");
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE run_id=? AND dispatch_id<>? AND state IN ('pending','claimed')")
        .run(new Date().toISOString(), runId, dispatchId);
      this.store.db.prepare("UPDATE decisions SET status='canceled',resolved_at=COALESCE(resolved_at,?) WHERE run_id=? AND status='pending'").run(new Date().toISOString(), runId);
      this.store.db.prepare("UPDATE runs SET state='active',stage='canceling',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      this.store.event(runId, "run.cancellation_requested", { reason, cleanup_dispatch_id: dispatchId, worktree_ids: worktrees.map(({ worktree_id }) => worktree_id) });
    })();
    return { state: "canceling", dispatch_id: dispatchId, role: "git-operator", depends_on: [] };
  }

  private async planningSnapshot(project: string, planId: string, revision: string, planCommit?: string): Promise<{
    paths: string[];
    digest: string;
    planVerification: PlanVerification;
    tasks: Array<{ task_id: string; source_path: string; source_digest: string; write_paths: string[]; verification: TaskVerification }>;
  }> {
    const root = join(".ai-team", "plans", planId);
    const revisionRoot = join(root, "revisions", revision);
    const paths = [join(root, "plan.yaml"), join(revisionRoot, "spec.md"), join(revisionRoot, "plan.md")];
    try {
      await readFile(join(project, revisionRoot, "tasks.md"), "utf8");
      paths.push(join(revisionRoot, "tasks.md"));
    } catch { /* an unsplit plan has no tasks.md */ }
    let taskFiles: string[] = [];
    if (planCommit) {
      try {
        taskFiles = execFileSync("git", ["-C", project, "ls-tree", "-r", "--name-only", planCommit, "--", join(revisionRoot, "tasks")], { encoding: "utf8" })
          .split("\n").filter((path) => /\/TASK-\d{3}\.md$/.test(path)).sort();
      } catch { throw new ValidationError("planned TASK metadata could not be read from the frozen plan commit"); }
    } else {
      try {
        taskFiles = (await readdir(join(project, revisionRoot, "tasks"), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^TASK-\d{3}\.md$/.test(entry.name))
          .map((entry) => join(revisionRoot, "tasks", entry.name))
          .sort();
      } catch { /* an unsplit plan has no tasks directory */ }
    }
    paths.push(...taskFiles);
    const documents = await Promise.all(paths.map(async (path) => ({ path, content: await readFile(join(project, path), "utf8") })));
    const tasks = await Promise.all(taskFiles.map(async (path) => {
      const content = planCommit
        ? execFileSync("git", ["-C", project, "show", `${planCommit}:${path}`], { encoding: "utf8" })
        : await readFile(join(project, path), "utf8");
      const current = documents.find((document) => document.path === path)?.content;
      if (current !== content) throw new ValidationError(`planned Task differs from frozen plan commit: ${path}`);
      return {
        task_id: path.slice(path.lastIndexOf("/") + 1, -3),
        source_path: path,
        source_digest: sha256(content),
        write_paths: frozenTaskWritePathsFromDocument(content, path),
        verification: parseTaskVerification(content),
      };
    }));
    const planDocument = documents.find(({ path }) => path === join(revisionRoot, "plan.md"));
    if (!planDocument) throw new ValidationError("planned verification contract could not be read");
    return {
      paths,
      tasks,
      planVerification: parsePlanVerification(planDocument.content),
      digest: sha256(documents.map(({ path, content }) => `${path}\n${content}`).join("\n")),
    };
  }

  async codingStart(input: { project: string; mode: "planned" | "bug" | "feature"; planId?: string; revision?: string; request?: string }): Promise<{ run_id: string; dispatch_id: string; role: Role; depends_on: string[] }> {
    const repo = await repositoryIdentity(input.project);
    const status = await worktreeStatus(repo.root);
    if (!status.clean) throw new ValidationError("coding start requires a clean worktree", status);
    const branch = await currentBranch(repo.root);
    const head = await currentHead(repo.root);
    let selectedRevision = input.revision;
    let planDigest: string | undefined;
    let planVerification: PlanVerification | undefined;
    let planPaths: string[] = [];
    let planTasks: Array<{ task_id: string; source_path: string; source_digest: string; write_paths: string[]; verification: TaskVerification }> = [];
    if (input.mode === "planned") {
      if (!input.planId || input.request) throw new ValidationError("planned mode requires plan-id and forbids request input");
      const rows = this.store.db.prepare("SELECT * FROM revisions WHERE repo_id=? AND plan_id=? AND state='ready'").all(repo.repoId, input.planId) as any[];
      const selected = input.revision ? rows.find((row) => row.revision === input.revision) : rows.length === 1 ? rows[0] : undefined;
      if (!selected) throw new ValidationError(rows.length > 1 ? "multiple ready revisions; specify --revision" : "ready revision not found");
      if (selected.target_branch !== branch) throw new ValidationError("planned target branch differs from current branch; migration decision required", { planned: selected.target_branch, current: branch });
      if (selected.plan_commit) {
        if (!/^[a-f0-9]{40}$/.test(selected.plan_commit)) throw new ValidationError("planned revision has invalid planning baseline");
        try { await git(repo.root, ["cat-file", "-e", `${selected.plan_commit}^{commit}`]); await git(repo.root, ["merge-base", "--is-ancestor", selected.plan_commit, head]); }
        catch { throw new ValidationError("planning commit is not reachable from the current HEAD", { plan_commit: selected.plan_commit, head }); }
      } else if (selected.digest || selected.plan_digest) throw new ValidationError("planned revision has no committed planning baseline");
      selectedRevision = selected.revision as string;
      const snapshot = await this.planningSnapshot(repo.root, input.planId, selectedRevision, selected.plan_commit as string | undefined);
      planPaths = snapshot.paths;
      planTasks = snapshot.tasks;
      planVerification = snapshot.planVerification;
      planDigest = typeof selected.digest === "string" && selected.digest.trim() ? selected.digest : snapshot.digest;
    } else {
      if (input.planId || input.revision) throw new ValidationError(`${input.mode} mode forbids plan-id and revision`);
      if (!input.request?.trim()) throw new ValidationError(`${input.mode} mode requires request input`);
      const inferred = triageRequest(input.request);
      if (inferred !== input.mode) throw new ValidationError(`explicit ${input.mode} mode does not match inferred ${inferred}; planning required`);
      planVerification = directVerification(input.request);
    }
    this.store.registerRepository(repo.repoId, repo.commonDir, repo.root);
    const runId = this.store.createRun({ repoId: repo.repoId, profile: "coding", mode: input.mode, ...(input.planId ? { planId: input.planId } : {}), ...(selectedRevision ? { revision: selectedRevision } : {}), baseCommit: head, targetBranch: branch, ...(input.request ? { request: input.request } : {}), clientPlatform: clientPlatform(), ...(planDigest ? { planDigest } : {}), ...(planVerification ? { planVerification } : {}) });
    const commandId = this.store.startCommand(runId, "coding start");
    if (input.mode === "planned") {
      this.store.initializeRunTasks(runId, planTasks);
      try {
        const planWorktree = await new GitOrchestrator(this.store).prepareIntegration(runId);
        await Promise.all(planPaths.map((path) => readFile(join(planWorktree.path, path), "utf8")));
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const retry = "Resolve the reported branch/worktree collision or reconcile the failed run, then start a new planned coding run.";
        this.store.terminalCommand(commandId, "failed", { command: "coding start", phase: "prepare_plan_worktree", cause, retry_safe: false }, () => {
          this.store.db.prepare("UPDATE runs SET state='failed',stage='git-operator',updated_at=? WHERE run_id=? AND state='active'")
            .run(new Date().toISOString(), runId);
          this.store.event(runId, "run.start_failed", { phase: "prepare_plan_worktree", cause, retry });
        });
        throw new ValidationError("planned coding start failed to prepare its plan worktree; the run was marked failed", { run_id: runId, cause, retry });
      }
    }
    try {
      const dispatchId = this.store.terminalCommand(commandId, "completed", { command: "coding start", retry_safe: false }, () => this.dispatches.create(runId, "file-explorer", {
        objective: "Re-explore the repository at the implementation base. Read existing MEMORY.md and .ai-team/index/feature-navigation.md first, then return exact implementation and test scope plus project_context.",
        allowed_read_paths: ["."],
        allowed_write_paths: [],
        acceptance_criteria: ["Scope is exhaustive", "Current HEAD and test entry points are reported"],
        context: { mode: input.mode, plan_id: input.planId ?? null, revision: selectedRevision ?? null, request: input.request ?? null, implementation_base_commit: head },
      }, "coding"));
      return { run_id: runId, dispatch_id: dispatchId, role: "file-explorer", depends_on: [] };
    } catch (error) {
      const terminal = this.store.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(commandId);
      if (!terminal) this.store.terminalCommand(commandId, "failed", { command: "coding start", cause: error instanceof Error ? error.message : String(error), retry_safe: false }, () => {
        this.store.db.prepare("UPDATE runs SET state='failed',updated_at=? WHERE run_id=? AND state='active'").run(new Date().toISOString(), runId);
        this.store.event(runId, "run.start_failed", { phase: "create_explorer_dispatch", cause: error instanceof Error ? error.message : String(error) });
      });
      throw error;
    }
  }

  async codingStartAuto(project: string, request?: string, planId?: string, revision?: string): Promise<{ triage: "planned" | "bug" | "feature" | "planning"; run_id?: string; dispatch_id?: string; role?: Role; depends_on?: string[] }> {
    const repo = await repositoryIdentity(project);
    this.store.registerRepository(repo.repoId, repo.commonDir, repo.root);
    if (revision && !planId) throw new ValidationError("automatic planned triage requires plan-id with revision");
    if (planId) {
      const started = await this.codingStart({ project, mode: "planned", planId, ...(revision ? { revision } : {}) });
      return { triage: "planned", ...started };
    }
    const ready = this.store.db.prepare("SELECT plan_id,revision FROM revisions WHERE repo_id=? AND state='ready' ORDER BY created_at DESC").all(repo.repoId) as Array<{ plan_id: string; revision: string }>;
    if (ready.length === 1) {
      const started = await this.codingStart({ project, mode: "planned", planId: ready[0]!.plan_id, revision: ready[0]!.revision });
      return { triage: "planned", ...started };
    }
    if (ready.length > 1) throw new ValidationError("multiple ready revisions; specify a plan");
    if (!request?.trim()) throw new ValidationError("automatic coding triage requires a request");
    const mode = triageRequest(request);
    if (mode === "planning") return { triage: mode };
    const started = await this.codingStart({ project, mode, request });
    return { triage: mode, ...started };
  }

  static async requestFrom(file?: string, stdin = false): Promise<string> {
    if ((file ? 1 : 0) + (stdin ? 1 : 0) !== 1) throw new ValidationError("provide exactly one of --request-file or --request-stdin");
    if (file) { assertReadablePath(file); const value = await readFile(file, "utf8"); if (value.length > 128 * 1024) throw new ValidationError("request input exceeds the 128 KiB limit"); return value; }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
}
