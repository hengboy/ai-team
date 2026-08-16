import { readFile } from "node:fs/promises";
import { currentBranch, currentHead, git, repositoryIdentity, worktreeStatus } from "./git.js";
import { StateStore } from "./state.js";
import { DispatchService } from "./dispatch.js";
import { ValidationError } from "./errors.js";
import { triageRequest } from "./planning.js";
import { AGENT_BUILD } from "./roles.js";
import { assertReadablePath } from "./security.js";
import { GitOrchestrator } from "./git-orchestrator.js";

const clientPlatform = (): string => {
  const value = process.env.AI_TEAM_CLIENT_PLATFORM ?? process.env.AI_TEAM_PLATFORM ?? "codex";
  if (!AGENT_BUILD.manifest.platforms.includes(value as any)) throw new ValidationError(`unsupported client platform: ${value}`);
  return value;
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
    const dispatchId = this.dispatches.create(runId, "file-explorer", {
      objective: "Explore the repository for the planning request. Read existing MEMORY.md and .ai-team/index/feature-navigation.md first, then return entry points, constraints, risks, test locations, and project_context.",
      allowed_read_paths: ["."],
      allowed_write_paths: [],
      acceptance_criteria: ["Repository facts are supported by file paths", "Unknowns are explicit"],
      context: { request },
    }, "planning");
    return { run_id: runId, dispatch_id: dispatchId };
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

  async codingStart(input: { project: string; mode: "planned" | "bug" | "feature"; planId?: string; revision?: string; request?: string }): Promise<{ run_id: string; dispatch_id: string }> {
    const repo = await repositoryIdentity(input.project);
    const status = await worktreeStatus(repo.root);
    if (!status.clean) throw new ValidationError("coding start requires a clean worktree", status);
    const branch = await currentBranch(repo.root);
    const head = await currentHead(repo.root);
    let selectedRevision = input.revision;
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
    } else {
      if (input.planId || input.revision) throw new ValidationError(`${input.mode} mode forbids plan-id and revision`);
      if (!input.request?.trim()) throw new ValidationError(`${input.mode} mode requires request input`);
      const inferred = triageRequest(input.request);
      if (inferred !== input.mode) throw new ValidationError(`explicit ${input.mode} mode does not match inferred ${inferred}; planning required`);
    }
    this.store.registerRepository(repo.repoId, repo.commonDir, repo.root);
    const runId = this.store.createRun({ repoId: repo.repoId, profile: "coding", mode: input.mode, ...(input.planId ? { planId: input.planId } : {}), ...(selectedRevision ? { revision: selectedRevision } : {}), baseCommit: head, targetBranch: branch, ...(input.request ? { request: input.request } : {}), clientPlatform: clientPlatform() });
    if (input.mode === "planned") {
      try {
        await new GitOrchestrator(this.store).prepareIntegration(runId);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const retry = "Resolve the reported branch/worktree collision or reconcile the failed run, then start a new planned coding run.";
        this.store.db.transaction(() => {
          this.store.db.prepare("UPDATE runs SET state='failed',stage='git-operator',updated_at=? WHERE run_id=? AND state='active'")
            .run(new Date().toISOString(), runId);
          this.store.event(runId, "run.start_failed", { phase: "prepare_plan_worktree", cause, retry });
        })();
        throw new ValidationError("planned coding start failed to prepare its plan worktree; the run was marked failed", { run_id: runId, cause, retry });
      }
    }
    const dispatchId = this.dispatches.create(runId, "file-explorer", {
      objective: "Re-explore the repository at the implementation base. Read existing MEMORY.md and .ai-team/index/feature-navigation.md first, then return exact implementation and test scope plus project_context.",
      allowed_read_paths: ["."],
      allowed_write_paths: [],
      acceptance_criteria: ["Scope is exhaustive", "Current HEAD and test entry points are reported"],
      context: { mode: input.mode, plan_id: input.planId ?? null, revision: selectedRevision ?? null, request: input.request ?? null, implementation_base_commit: head },
    }, "coding");
    return { run_id: runId, dispatch_id: dispatchId };
  }

  async codingStartAuto(project: string, request?: string, planId?: string, revision?: string): Promise<{ triage: "planned" | "bug" | "feature" | "planning"; run_id?: string; dispatch_id?: string }> {
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
