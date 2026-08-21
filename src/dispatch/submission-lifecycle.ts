import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Role } from "../constants.js";
import { checkDecisionInput, createResultTemplate, resultSchemaForRole, type ResultEnvelope } from "../contracts.js";
import { IncompatibleError, ValidationError, validationCause } from "../errors.js";
import { ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "../roles.js";
import { assertReadablePath, pathMatchesScope } from "../security.js";
import { makeId, redact, sha256, stableJson, writeJson } from "../utils.js";
import { resolveTaskIdentityWorktree } from "../worktree-ownership.js";
import { executionEnforcement, freezeExecutionContract } from "../execution-contract.js";
import * as common from "./store.js";
export function create(store: common.StateStore, ops: common.DispatchOperations, runId: string, role: Role, packet: common.DispatchPacket, actorRole?: Role, actorDispatchId?: string): string {
    const run = store.getRun(runId) as { profile: Role; state: string };
    if (run.state !== "active") throw new ValidationError(`run must be active before dispatch creation: ${run.state}`);
    const actor = actorRole ?? run.profile;
    const reviewerActor = run.profile === "coding" && actor === "code-reviewer" && (role === "code-reviewer" || role === "review-spec" || role === "review-standards");
    if (actorRole && actorRole !== run.profile && !reviewerActor) throw new ValidationError(`${actorRole} cannot act for ${run.profile} run`);
    let actorPacket: common.DispatchPacket | undefined;
    if (actorDispatchId) {
      ops.assertClaimed!(store, ops, runId, actorDispatchId, actor);
      const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?")
        .get(runId, actorDispatchId, actor) as { packet_json: string };
      actorPacket = JSON.parse(row.packet_json) as common.DispatchPacket;
    }
    ops.assertCommandAllowed!(store, ops, actor, "dispatch create");
    const definition = ROLE_MANIFEST[actor];
    if (role !== actor && !definition.delegates.includes(role)) {
      throw new ValidationError(`${actor} cannot delegate to ${role}`);
    }
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    let validated = common.validatePacket(packet, role);
    if (actorRole === "coding" && role === "git-operator" && validated.context.phase === "prepare_implementation_worktree" && /^TASK-\d{3}$/.test(String(validated.context.task_id ?? ""))) {
      if (validated.context.coordinator_dispatch_id !== actorDispatchId) {
        throw new ValidationError("planned task prepare packet must preserve its Coding coordinator identity", ["/context/coordinator_dispatch_id"]);
      }
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") {
      ops.assertContinueTestingDelegation!(store, ops, actorDispatchId!, role, actorPacket, validated);
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_implementation") {
      ops.assertContinueImplementationDelegation!(store, ops, runId, actorDispatchId!, role, actorPacket, validated);
    }
    let replacementFor: string | undefined;
    if (actorPacket && actorPacket.context.phase === "test_repair") {
      if (role !== "frontend-developer" && role !== "backend-developer") throw new ValidationError("test repair Coding dispatch can only delegate to its original Developer role");
      const lineage = store.db.prepare("SELECT * FROM test_repair_lineage WHERE run_id=? AND coding_dispatch_id=?")
        .get(runId, actorDispatchId) as { source_test_dispatch_id: string; original_developer_dispatch_id: string; developer_role: string; worktree_id: string; task_id?: string; barrier_id?: string } | undefined;
      if (!lineage || role !== lineage.developer_role || validated.context.worktree_id !== lineage.worktree_id
        || validated.context.source_test_dispatch_id !== lineage.source_test_dispatch_id
        || validated.context.coordinator_dispatch_id !== actorDispatchId
        || (lineage.task_id && validated.context.task_id !== lineage.task_id)
        || (lineage.barrier_id && validated.context.barrier_id !== lineage.barrier_id)) {
        throw new ValidationError("test repair Developer packet must preserve the original role, worktree, and Test scope");
      }
      validated.context.phase = "test_repair";
      replacementFor = lineage.original_developer_dispatch_id;
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "review_resolution"
      && (role === "frontend-developer" || role === "backend-developer")) {
      const barrierId = (actorPacket.context as { barrier_id?: unknown }).barrier_id;
      const integration = ops.activeIntegrationWorktree!(store, ops, runId);
      if (typeof barrierId !== "string" || validated.context.barrier_id !== barrierId
        || !integration || validated.context.worktree_id !== integration.worktree_id) {
        throw new ValidationError("review repair developer packet must preserve the barrier and plan worktree identity", [
          "/context/barrier_id", "/context/worktree_id",
        ]);
      }
      validated.context.phase = "review_repair";
    }
    validated = freezeExecutionContract(role, ops.freezeVerificationContext!(store, ops, runId, role, validated)) as common.DispatchPacket;
    if (role === "file-explorer") {
      const repository = store.db.prepare("SELECT project_path FROM repositories WHERE repo_id=?").get((store.getRun(runId) as { repo_id: string }).repo_id) as { project_path: string } | undefined;
      const missing = repository ? common.EXPLORER_CONTEXT_PATHS.filter((path) => !existsSync(join(repository.project_path, path))) : [...common.EXPLORER_CONTEXT_PATHS];
      if (missing.length) throw new ValidationError("File Explorer packet requires initialized project context", missing.map((path) => ({
        path: `/${path}`, pointer: `/${path}`, constraint: "exists", message: `${path} does not exist`, suggestion: `Run ai-team init ${repository?.project_path ?? "<project>"} --yes, then retry the run start.`,
      })));
    }
    common.assertExplorerAuthorization(store, runId, role, validated);
    if (actorRole === "coding" && (role === "frontend-developer" || role === "backend-developer")) {
      const tasks = ops.plannedTaskRows!(store, ops, runId);
      if (tasks.length === 1 && validated.context.task_id !== tasks[0]!.task_id) {
        throw new ValidationError("single explicit planned Task developer packet must preserve its frozen task identity", ["/context/task_id"]);
      }
      const worktreeId = (validated.context as { worktree_id?: unknown }).worktree_id;
      if (typeof worktreeId !== "string" || !worktreeId) throw new ValidationError(`${role} dispatch requires context.worktree_id`, ["/context/worktree_id"]);
      const worktree = store.db.prepare("SELECT branch FROM worktrees WHERE worktree_id=? AND run_id=? AND state='active'").get(worktreeId, runId) as { branch: string } | undefined;
      const plannedPlanWorktree = (store.getRun(runId) as { mode?: string }).mode === "planned" && worktree?.branch.startsWith("plan/");
      if (!worktree?.branch.startsWith("task/") && !plannedPlanWorktree) throw new ValidationError(`${role} dispatch requires a prepared active implementation worktree`, ["/context/worktree_id"]);
    }
    const dispatchId = ops.insert!(store, ops, runId, role, validated, replacementFor);
    if (replacementFor && actorPacket?.context.phase === "test_repair") {
      store.db.prepare("UPDATE test_repair_lineage SET repair_developer_dispatch_id=? WHERE coding_dispatch_id=?").run(dispatchId, actorDispatchId);
    }
    if (actorPacket && (actorPacket.context as { phase?: unknown }).phase === "continue_testing") ops.changeStage!(store, ops, runId, "test", dispatchId);
    return dispatchId;
  }

export function assertContinueImplementationDelegation(store: common.StateStore, ops: common.DispatchOperations, runId: string, actorDispatchId: string, role: Role, coordinator: common.DispatchPacket, packet: common.DispatchPacket): void {
    if (role !== "frontend-developer" && role !== "backend-developer") {
      throw new ValidationError("continue_implementation Coding dispatch can only delegate to a developer role");
    }
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = ["explorer_dispatch_id", "task_id", "worktree_id", "worktree_path"];
    if (expected.predecessor_repair !== undefined) inherited.push("predecessor_repair");
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_implementation developer packet must preserve its frozen task identity", mismatch.map((key) => `/context/${key}`));
    if (ops.plannedTaskRows!(store, ops, runId).some((task) => task.task_id === expected.task_id)) {
      const frozenTaskWritePaths = ops.frozenTaskWritePaths!(store, ops, runId, String(expected.task_id));
      const unauthorized = packet.allowed_write_paths.filter((path) => !pathMatchesScope(path, frozenTaskWritePaths));
      if (unauthorized.length) throw new ValidationError("continue_implementation developer write paths exceed the frozen Task authorization", {
        offending_dispatch_id: actorDispatchId,
        unauthorized_paths: unauthorized,
        authorization_source_expected: "frozen Task allowed write paths",
        frozen_task_write_paths: frozenTaskWritePaths,
      });
    }
  }

export function assertContinueTestingDelegation(store: common.StateStore, ops: common.DispatchOperations, actorDispatchId: string, role: Role, coordinator: common.DispatchPacket, packet: common.DispatchPacket): void {
    if (role !== "test") throw new ValidationError("continue_testing Coding dispatch can only delegate to Test");
    const expected = coordinator.context as Record<string, unknown>;
    const actual = packet.context as Record<string, unknown>;
    const inherited = [
      "explorer_dispatch_id", "plan_id", "revision", "plan_digest", "worktree_id", "worktree_path",
      "implementation_dispatch_id", "implementation_artifact", "implementation_artifacts", "implementation_commit", "implementation_committed",
      "changed_paths", "frozen_task_ids", "test_commands", "test_command_provenance",
    ];
    const mismatch = inherited.filter((key) => stableJson(actual[key]) !== stableJson(expected[key]));
    if (actual.coordinator_dispatch_id !== actorDispatchId) mismatch.push("coordinator_dispatch_id");
    if (mismatch.length) throw new ValidationError("continue_testing Test packet must preserve its frozen implementation evidence", mismatch.map((key) => `/context/${key}`));
  }

export function createPlanningCommit(store: common.StateStore, ops: common.DispatchOperations, runId: string, packet: common.DispatchPacket): string {
    const run = store.getRun(runId) as { profile: string; repo_id: string; plan_id?: string; revision?: string };
    if (run.profile !== "planning" || !run.plan_id || !run.revision) throw new ValidationError("planning commit requires a bound planning revision");
    store.assertPlanningClarificationsResolved(runId);
    const revision = store.db.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(run.repo_id, run.plan_id, run.revision) as { state: string } | undefined;
    if (revision?.state !== "plan_ready") throw new ValidationError("planning commit dispatch requires a plan_ready revision");
    const context = packet.context as { plan_id?: string; revision?: string };
    if (context.plan_id !== run.plan_id || context.revision !== run.revision) {
      throw new ValidationError("planning commit packet does not match the bound planning revision");
    }
    const existing = store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND state!='failed'
      AND json_extract(packet_json,'$.context.plan_id')=? AND json_extract(packet_json,'$.context.revision')=?`)
      .get(runId, run.plan_id, run.revision) as { dispatch_id: string } | undefined;
    if (existing) return existing.dispatch_id;
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    return ops.insert!(store, ops, runId, "git-operator", freezeExecutionContract("git-operator", common.validatePacket(packet, "git-operator")));
  }

export function insert(store: common.StateStore, ops: common.DispatchOperations, runId: string, role: Role, packet: common.DispatchPacket, replacementFor?: string): string {
    packet = ops.freezeVerificationContext!(store, ops, runId, role, packet);
    packet = packet.execution_contract ? packet : freezeExecutionContract(role, packet);
    const dispatchId = makeId("dispatch");
    const packetJson = redact(stableJson(packet));
    const frozenPacket = JSON.parse(packetJson) as common.DispatchPacket;
    const prompt = redact(common.promptFor(runId, dispatchId, role, frozenPacket));
    const template = createResultTemplate(runId, dispatchId, role);
    if (role === "planning" && typeof frozenPacket.context.target_stage === "string") {
      template.payload = { ...template.payload, stage: frozenPacket.context.target_stage };
    }
    if (role === "review-spec" || role === "review-standards") {
      const barrierId = (frozenPacket.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId === "string") template.payload = { barrier_id: barrierId, finding_ids: [] };
    }
    const schemaJson = stableJson(resultSchemaForRole(role));
    const templateJson = stableJson(template);
    const digests = { packet: sha256(packetJson), schema: sha256(schemaJson), template: sha256(templateJson), prompt: sha256(prompt) };
    const columns = new Set((store.db.prepare("PRAGMA table_info(dispatches)").all() as Array<{ name: string }>).map((item) => item.name));
    store.db.transaction(() => {
      if (["packet_digest", "prompt_digest", "schema_digest", "template_digest", "renderer_version"].every((column) => columns.has(column))) {
        store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,packet_digest,prompt_digest,schema_digest,template_digest,renderer_version,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, digests.packet, digests.prompt, digests.schema, digests.template, common.RENDERER_VERSION, new Date().toISOString());
      } else {
        store.db.prepare(`INSERT INTO dispatches(dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,created_at)
          VALUES (?,?,?,'pending',?,?,?,?,?)`).run(dispatchId, runId, role, packetJson, "", schemaJson, templateJson, new Date().toISOString());
      }
      if (replacementFor) store.db.prepare("UPDATE dispatches SET replacement_for=? WHERE dispatch_id=?").run(replacementFor, dispatchId);
      const bindings = common.mergeBindingsFromPacket(role, frozenPacket);
      if (bindings) {
        if (!bindings.integration_worktree_id || !bindings.task_worktree_ids.length) {
          throw new ValidationError("merge dispatch requires persisted integration and task worktree bindings");
        }
        const insertBinding = store.db.prepare(`INSERT INTO dispatch_worktree_bindings(dispatch_id,run_id,binding_kind,worktree_id,created_at)
          VALUES (?,?,?,?,?)`);
        const createdAt = new Date().toISOString();
        insertBinding.run(dispatchId, runId, "integration", bindings.integration_worktree_id, createdAt);
        for (const worktreeId of bindings.task_worktree_ids) insertBinding.run(dispatchId, runId, "task", worktreeId, createdAt);
        ops.assertStoredMergeWorktreeBindings!(store, ops, runId, dispatchId, bindings.integration_worktree_id, bindings.task_worktree_ids, true);
      }
      store.event(runId, "dispatch.created", { dispatchId, role, replacement_for: replacementFor ?? null, packet_digest: digests.packet, schema_digest: digests.schema, template_digest: digests.template, prompt_digest: digests.prompt, renderer_version: common.RENDERER_VERSION });
    })();
    return dispatchId;
  }

export function mergeWorktreeBindings(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId?: string): common.MergeWorktreeBindings {
    if (!dispatchId) return { integration_worktree_id: null, task_worktree_ids: [] };
    const rows = store.db.prepare(`SELECT binding_kind,worktree_id FROM dispatch_worktree_bindings
      WHERE run_id=? AND dispatch_id=? ORDER BY binding_kind,worktree_id`).all(runId, dispatchId) as Array<{ binding_kind: "integration" | "task"; worktree_id: string }>;
    return {
      integration_worktree_id: rows.find(({ binding_kind }) => binding_kind === "integration")?.worktree_id ?? null,
      task_worktree_ids: rows.filter(({ binding_kind }) => binding_kind === "task").map(({ worktree_id }) => worktree_id),
    };
  }

export function assertStoredMergeWorktreeBindings(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, integrationId: string, taskWorktreeIds: string[], exact = false): common.MergeWorktreeBindings {
    const actual = ops.mergeWorktreeBindings!(store, ops, runId, dispatchId);
    const expected = [integrationId, ...taskWorktreeIds];
    const actualIds = [actual.integration_worktree_id, ...actual.task_worktree_ids].filter((id): id is string => Boolean(id));
    const missing = expected.filter((id) => !actualIds.includes(id));
    const unexpected = exact ? actualIds.filter((id) => !expected.includes(id)) : [];
    if (actual.integration_worktree_id !== integrationId || missing.length || unexpected.length) {
      throw new ValidationError(`merge-task dispatch ${dispatchId} has invalid managed worktree bindings: constraint=packet_worktree_binding; expected_worktree_ids=${JSON.stringify(expected)}; actual_bound_ids=${JSON.stringify(actualIds)}; missing_bindings=${JSON.stringify(missing)}; unexpected_bindings=${JSON.stringify(unexpected)}`);
    }
    return actual;
  }

export function assertMergeWorktreeBindings(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, integrationId: string, taskId: string): common.MergeWorktreeBindings & { task_id: string; task_worktree_id: string } {
    const actual = ops.mergeWorktreeBindings!(store, ops, runId, dispatchId);
    const dispatch = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
      .get(runId, dispatchId) as { packet_json: string } | undefined;
    const context = dispatch ? (JSON.parse(dispatch.packet_json) as common.DispatchPacket).context : {};
    const actualTaskId = typeof context.task_id === "string" ? context.task_id : null;
    const resolvedTask = resolveTaskIdentityWorktree(store, runId, taskId);
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

export function get(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): any {
    const row = store.db.prepare("SELECT * FROM dispatches WHERE run_id=? AND dispatch_id=? AND role=?").get(runId, dispatchId, role);
    if (!row) throw new ValidationError("dispatch identity does not match run and role");
    const platform = process.env.AI_TEAM_CLIENT_PLATFORM ?? process.env.AI_TEAM_PLATFORM;
    if (platform) {
      const run = store.getRun(runId) as { client_platform?: string };
      if (run.client_platform && run.client_platform !== platform) throw new ValidationError("client platform is locked to this run", { expected: run.client_platform, actual: platform });
    }
    return row;
  }

export function claim(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): { reused: boolean; packet: common.DispatchPacket } {
    const row = ops.get!(store, ops, runId, dispatchId, role);
    const run = store.getRun(runId) as { state: string };
    if (run.state !== "active") throw new ValidationError(`run must be active before dispatch claim: ${run.state}`);
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be claimed from ${row.state}`);
    const reused = row.state === "claimed";
    if (!reused) store.db.prepare("UPDATE dispatches SET state='claimed',claimed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
    return { reused, packet: JSON.parse(row.packet_json) as common.DispatchPacket };
  }

export function claimBundle(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): common.DispatchBundle {
    const claimed = ops.claim!(store, ops, runId, dispatchId, role);
    const row = ops.get!(store, ops, runId, dispatchId, role) as {
      packet_json: string;
      schema_json: string;
      template_json: string;
      packet_digest?: string;
      prompt_digest?: string;
      schema_digest?: string;
      template_digest?: string;
      renderer_version?: string;
    };
    const prompt = ops.prompt!(store, ops, runId, dispatchId, role);
    return {
      ...claimed,
      prompt,
      schema: JSON.parse(row.schema_json),
      template: JSON.parse(row.template_json) as ResultEnvelope,
      packet_schema: ops.packetSchema!(store, ops, runId, dispatchId, role),
      packet_template: ops.packetTemplate!(store, ops, runId, dispatchId, role),
      digests: {
        packet: row.packet_digest ?? sha256(row.packet_json),
        prompt: row.prompt_digest ?? sha256(prompt),
        schema: row.schema_digest ?? sha256(row.schema_json),
        template: row.template_digest ?? sha256(row.template_json),
      },
      renderer_version: row.renderer_version ?? "dispatch-renderer-v2",
      execution_enforcement: executionEnforcement(claimed.packet.execution_contract),
    };
  }

export function cancel(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): { action: "canceled"; reused: boolean } {
    ops.assertLifecycleActor!(store, ops, runId, actorRole, "dispatch cancel");
    if (!reason.trim()) throw new ValidationError("dispatch cancellation requires a reason");
    const row = ops.get!(store, ops, runId, dispatchId, role) as { state: string };
    const prior = store.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='dispatch.canceled' AND json_extract(payload_json,'$.dispatchId')=?")
      .get(runId, dispatchId);
    if (row.state === "failed" && prior) return { action: "canceled", reused: true };
    if (!["pending", "claimed"].includes(row.state)) throw new ValidationError(`dispatch cannot be canceled from ${row.state}`);
    store.db.transaction(() => {
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      store.event(runId, "dispatch.canceled", { dispatchId, role, actor_role: actorRole, reason });
    })();
    return { action: "canceled", reused: false };
  }

export function reissue(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string): common.ReplacementResult<"reissued"> {
    const row = ops.get!(store, ops, runId, dispatchId, role) as {
      state: string; packet_json: string; packet_digest?: string; result_json?: string; replacement_for?: string;
    };
    const run = store.getRun(runId) as { state: string };
    const cleanup = ops.integratedTaskCleanupRecovery!(store, ops, runId, { dispatch_id: dispatchId, role, ...row });
    if (cleanup) {
      ops.assertLifecycleActor!(store, ops, runId, actorRole, "dispatch reissue");
      if (!reason.trim()) throw new ValidationError("dispatch reissue requires a reason");
      let cleanupDispatchId = "";
      store.db.transaction(() => {
        cleanupDispatchId = ops.activateIntegratedTaskCleanup!(store, ops, runId, cleanup.merge_operation_id, cleanup.request, dispatchId);
        store.event(runId, "dispatch.reissued", {
          dispatchId, replacement_dispatch_id: cleanupDispatchId, role, actor_role: actorRole, reason,
          revived_run: true, cleanup_only: true,
        });
      })();
      return { action: "reissued", dispatch_id: cleanupDispatchId, replacement_for: dispatchId, reused: false };
    }
    if (row.state === "failed" && run.state === "failed") {
      ops.assertLifecycleActor!(store, ops, runId, actorRole, "dispatch reissue");
      if (!reason.trim()) throw new ValidationError("dispatch reissue requires a reason");
      let result: { side_effect_state?: string };
      try { result = JSON.parse(row.result_json ?? ""); }
      catch { throw new ValidationError("failed dispatch reissue requires a valid result envelope"); }
      if (result.side_effect_state !== "none") throw new ValidationError("failed dispatch can be revived only when no side effect occurred");
      const existing = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
        .get(runId, dispatchId) as { dispatch_id: string } | undefined;
      if (existing) return { action: "reissued", dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
      let replacementId = "";
      store.db.transaction(() => {
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
        replacementId = ops.plannedOwnershipRecovery!(store, ops, runId, { dispatch_id: dispatchId, role, ...row })
          ?? ops.recoveryReplacement!(store, ops, runId, { dispatch_id: dispatchId, role, ...row });
        store.event(runId, "dispatch.reissued", { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason, revived_run: true });
      })();
      return { action: "reissued", dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
    }
    return ops.replaceDispatch!(store, ops, runId, dispatchId, role, actorRole, reason, "reissued", JSON.parse(row.packet_json) as common.DispatchPacket);
  }

export function supersede(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, packet: common.DispatchPacket): common.ReplacementResult<"superseded"> {
    if (packet.execution_contract) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
    return ops.replaceDispatch!(store, ops, runId, dispatchId, role, actorRole, reason, "superseded", common.validatePacket(packet, role));
  }

export function replaceDispatch<Action extends common.ReplacementAction>(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, actorRole: Role, reason: string, action: Action, packet: common.DispatchPacket): common.ReplacementResult<Action> {
    ops.assertLifecycleActor!(store, ops, runId, actorRole, `dispatch ${action === "reissued" ? "reissue" : "supersede"}`);
    const run = store.getRun(runId) as { state: string };
    if (!reason.trim()) throw new ValidationError(`dispatch ${action} requires a reason`);
    const row = ops.get!(store, ops, runId, dispatchId, role) as { state: string; packet_json: string };
    if (run.state !== "active" && !(run.state === "retryable_failure" && row.state === "retryable_failure")) {
      throw new ValidationError(`run must be active before dispatch ${action}: ${run.state}`);
    }
    if (!["pending", "claimed", "failed", "retryable_failure"].includes(row.state)) throw new ValidationError(`dispatch cannot be ${action} from ${row.state}`);
    common.assertExplorerAuthorization(store, runId, role, packet);
    const sourceBindings = ops.mergeWorktreeBindings!(store, ops, runId, dispatchId);
    const replacementBindings = common.mergeBindingsFromPacket(role, packet);
    const sourcePacket = JSON.parse(row.packet_json) as common.DispatchPacket;
    const sourceTaskId = typeof sourcePacket.context.task_id === "string" ? sourcePacket.context.task_id : null;
    const replacementTaskId = typeof packet.context.task_id === "string" ? packet.context.task_id : null;
    if (sourceTaskId !== replacementTaskId) {
      throw new ValidationError(`replacement dispatch must preserve task identity: expected_task_id=${String(sourceTaskId)}; actual_task_id=${String(replacementTaskId)}`);
    }
    if ((role === "frontend-developer" || role === "backend-developer")
      && stableJson(sourcePacket.context.predecessor_repair) !== stableJson(packet.context.predecessor_repair)) {
      throw new ValidationError("replacement developer dispatch must preserve predecessor repair evidence");
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
    const sourceContract = sourcePacket.execution_contract;
    if (!sourceContract) {
      const frozen = store.getRun(runId) as { role_manifest_digest?: string };
      if (frozen.role_manifest_digest !== ROLE_MANIFEST_DIGEST) throw new IncompatibleError("legacy dispatch role manifest does not match the current role manifest", {
        reason_code: "role_manifest_mismatch",
        next_action: "start_new_run",
      });
    }
    const requestedPacket = { ...packet };
    delete requestedPacket.execution_contract;
    packet = freezeExecutionContract(role, requestedPacket, sourceContract) as common.DispatchPacket;
    const packetJson = redact(stableJson(packet));
    const existing = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND replacement_for=? ORDER BY created_at LIMIT 1")
      .get(runId, dispatchId) as { dispatch_id: string; packet_json: string } | undefined;
    if (existing) {
      if (existing.packet_json !== packetJson) throw new ValidationError("dispatch already has a different replacement");
      return { action, dispatch_id: existing.dispatch_id, replacement_for: dispatchId, reused: true };
    }
    let replacementId = "";
    store.db.transaction(() => {
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=COALESCE(completed_at,?) WHERE dispatch_id=?").run(new Date().toISOString(), dispatchId);
      if (row.state === "retryable_failure") {
        store.db.prepare("UPDATE runs SET state='active',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      }
      replacementId = ops.insert!(store, ops, runId, role, packet, dispatchId);
      store.event(runId, `dispatch.${action}`, { dispatchId, replacement_dispatch_id: replacementId, role, actor_role: actorRole, reason });
    })();
    return { action, dispatch_id: replacementId, replacement_for: dispatchId, reused: false };
  }

export function assertLifecycleActor(store: common.StateStore, ops: common.DispatchOperations, runId: string, actorRole: Role, command: string): void {
    const run = store.getRun(runId) as { profile: Role };
    if (run.profile !== actorRole) throw new ValidationError(`${actorRole} cannot manage a ${run.profile} run dispatch`);
    ops.assertCommandAllowed!(store, ops, actorRole, command);
  }

export function prompt(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): string {
    const row = ops.get!(store, ops, runId, dispatchId, role);
    const renderer = row.renderer_version === common.RENDERER_VERSION ? common.promptFor : row.renderer_version === "dispatch-renderer-v3" ? common.promptForV3 : common.promptForV2;
    const rendered = renderer(runId, dispatchId, role, JSON.parse(row.packet_json) as common.DispatchPacket);
    if (row.prompt_digest && row.prompt_digest !== sha256(rendered)) throw new ValidationError("dispatch prompt digest mismatch; frozen asset is corrupted");
    return rendered;
  }

export function claimCommand(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string): string {
    return `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatchId} --role git-operator --bundle`;
  }

export function schema(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): unknown { return JSON.parse(ops.get!(store, ops, runId, dispatchId, role).schema_json); }

export function template(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): ResultEnvelope { return JSON.parse(ops.get!(store, ops, runId, dispatchId, role).template_json) as ResultEnvelope; }

export function packetSchema(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): unknown {
    const packet = JSON.parse(ops.get!(store, ops, runId, dispatchId, role).packet_json) as common.DispatchPacket;
    return common.dispatchPacketSchema(role, packet.context.phase, packet.context.task_id);
  }

export function packetTemplate(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): common.DispatchPacket {
    const packet = JSON.parse(ops.get!(store, ops, runId, dispatchId, role).packet_json) as common.DispatchPacket;
    return common.dispatchPacketTemplate(role, packet);
  }

export function assertClaimed(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role): void {
    const row = ops.get!(store, ops, runId, dispatchId, role);
    if (row.state !== "claimed") throw new ValidationError(`${role} dispatch must be claimed before this operation`);
  }

export function assertPlanningCommitClaimed(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, planId: string, revision: string): void {
    ops.assertClaimed!(store, ops, runId, dispatchId, "git-operator");
    const run = store.getRun(runId) as { profile: string; plan_id?: string; revision?: string };
    let packet: common.DispatchPacket;
    try {
      const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=? AND role='git-operator'")
        .get(runId, dispatchId) as { packet_json: string };
      packet = JSON.parse(row.packet_json) as common.DispatchPacket;
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

export async function submit(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, path: string): Promise<common.DispatchSubmission> {
    assertReadablePath(path);
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) throw new ValidationError("result file exceeds the 2 MiB limit");
    const source = await readFile(path, "utf8");
    return ops.submitValue!(store, ops, runId, dispatchId, role, JSON.parse(source), source);
  }

export async function submitStaging(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, stagingId: string): Promise<common.DispatchSubmission & {
    staging: { staging_id: string; state: string; content_digest: string | null };
  }> {
    const binding = { runId, dispatchId, role, kind: "dispatch-result" as const };
    try {
      const input = await store.readStagingEntry(stagingId, binding);
      const digest = (store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(stagingId) as { content_sha256?: string }).content_sha256 ?? null;
      const submission = await ops.submitValue!(store, ops, runId, dispatchId, role, input.value);
      const consumed = await store.consumeStagingEntry(stagingId, binding);
      return {
        ...submission,
        staging: { staging_id: consumed.stagingId, state: consumed.state, content_digest: digest },
      };
    } catch (error) {
      try { store.recordStagingValidationFailure(stagingId, binding, error); } catch { /* preserve the original staging failure */ }
      const entry = store.getStagingEntry(stagingId);
      throw new ValidationError(error instanceof Error ? error.message : String(error), {
        staging_id: stagingId,
        state: entry.state,
        cause: validationCause(error),
      });
    }
  }

export async function submitValue(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, value: unknown, source?: string): Promise<common.DispatchSubmission> {
    const commandId = store.startCommand(runId, "dispatch submit", { dispatchId, correlationId: dispatchId });
    try {
      return await ops.submitValueWithCommand!(store, ops, runId, dispatchId, role, value, commandId, source);
    } catch (error) {
      const terminal = store.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(commandId);
      if (!terminal) store.terminalCommand(commandId, "failed", { command: "dispatch submit", cause: error instanceof Error ? error.message : String(error), retry_safe: false }, () => {});
      throw error;
    }
  }

export async function submitValueWithCommand(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, value: unknown, commandId: string, source?: string): Promise<common.DispatchSubmission> {
    const row = ops.get!(store, ops, runId, dispatchId, role);
    const bindReviewBarrier = (result: ResultEnvelope): void => {
      if ((role !== "review-spec" && role !== "review-standards") || result.status !== "completed") return;
      const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
      const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
      if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
      result.payload = { ...result.payload, barrier_id: barrierId };
    };
    if (["completed", "needs_decision"].includes(row.state) && row.result_json) {
      const result = JSON.parse(row.result_json) as ResultEnvelope;
      const incoming = ops.validateValue!(store, ops, runId, dispatchId, role, value);
      bindReviewBarrier(incoming);
      if (stableJson(result) !== stableJson(incoming)) throw new ValidationError("dispatch was already submitted with a different result");
      const artifact = store.db.prepare("SELECT artifact_id,path,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=? AND kind='result'")
        .get(runId, dispatchId) as { artifact_id: string; path: string; sha256: string } | undefined;
      if (!artifact) throw new ValidationError("submitted dispatch result artifact is missing");
      return store.terminalCommand(commandId, "completed", { command: "dispatch submit", reused: true, retry_safe: true }, () => ({
        reused: true,
        artifact: artifact.path,
        submission: { state: "submitted", dispatch_state: row.state, artifact_id: artifact.artifact_id, artifact: artifact.path, digest: artifact.sha256 },
        continuation: ops.continuation!(store, ops, runId),
      }));
    }
    if (row.state !== "claimed") throw new ValidationError("dispatch must be claimed before submit");
    const result = ops.validateValue!(store, ops, runId, dispatchId, role, value);
    if (role === "git-operator" && result.status === "failed" && result.side_effect_state === "none") {
      const phase = ((JSON.parse(row.packet_json) as common.DispatchPacket).context as { phase?: unknown }).phase;
      if (phase === "integrate_implementation" || phase === "reconcile_worktree_ownership" || phase === "recover_task_worktree" || phase === "finalize_integration") {
        result.status = "retryable_failure";
      }
    }
    if (role === "git-operator" && result.status === "completed") {
      ops.assertGitPrepareResult!(store, ops, runId, JSON.parse(row.packet_json) as common.DispatchPacket);
      const context = (JSON.parse(row.packet_json) as common.DispatchPacket).context;
      if (context.phase === "finalize_integration") ops.verifyFinalization!(store, ops, runId, dispatchId, true);
    }
    let resolvedPredecessorRepair: { handled_test_dispatch_ids: string[]; required_commands: string[] } | undefined;
    if ((role === "frontend-developer" || role === "backend-developer") && result.status === "completed") {
      const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
      const predecessor = packet.context.predecessor_repair as { required_commands?: unknown; handled_tests?: unknown } | undefined;
      const requiredCommands = Array.isArray(predecessor?.required_commands)
        ? predecessor.required_commands.filter((command): command is string => typeof command === "string")
        : [];
      if (requiredCommands.length) {
        const selfTests = Array.isArray((result.payload as { self_tests?: unknown }).self_tests)
          ? (result.payload as { self_tests: Array<{ command?: unknown; outcome?: unknown }> }).self_tests
          : [];
        const byCommand = new Map(selfTests.flatMap(({ command, outcome }) => typeof command === "string" ? [[command, outcome] as const] : []));
        const failed = requiredCommands.filter((command) => !common.successfulOutcome(byCommand.get(command)));
        if (failed.length) throw new ValidationError("developer predecessor repair is missing successful frozen checks", failed);
        const handledTestDispatchIds = Array.isArray(predecessor?.handled_tests)
          ? predecessor.handled_tests.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as { dispatch_id?: unknown }).dispatch_id === "string"
            ? [(entry as { dispatch_id: string }).dispatch_id]
            : [])
          : [];
        resolvedPredecessorRepair = { handled_test_dispatch_ids: handledTestDispatchIds, required_commands: requiredCommands };
      }
    }
    if (role === "test" && result.status === "completed") {
      const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
      const expectedCommands = Array.isArray(packet.context.test_commands)
        ? packet.context.test_commands.filter((command): command is string => typeof command === "string")
        : [];
      const checks = Array.isArray((result.payload as { checks?: unknown }).checks)
        ? (result.payload as { checks: Array<{ command?: unknown; outcome?: unknown }> }).checks
        : [];
      const checkedCommands = new Map(checks.flatMap(({ command, outcome }) => typeof command === "string" ? [[command, outcome] as const] : []));
      const failedCommands = expectedCommands.filter((command) => !common.successfulOutcome(checkedCommands.get(command)));
      if (failedCommands.length) throw new ValidationError("completed Test result is missing successful frozen test commands", failedCommands);
      const testedCommit = (packet.context as { implementation_commit?: unknown }).implementation_commit;
      if (typeof testedCommit === "string" && /^[a-f0-9]{40}$/.test(testedCommit)) {
        result.payload = { ...result.payload, testedCommit };
      }
      ops.assertPlannedTaskTestScope!(store, ops, runId, dispatchId, packet);
    }
    bindReviewBarrier(result);
    const artifactDirectory = join(store.paths.artifacts, runId, dispatchId);
    await mkdir(artifactDirectory, { recursive: true });
    const artifact = ops.artifactPath!(store, ops, runId, dispatchId);
    const redacted = redact(role === "test" || role === "review-spec" || role === "review-standards" ? `${JSON.stringify(result, null, 2)}\n` : source ?? `${JSON.stringify(value, null, 2)}\n`);
    await writeFile(artifact, redacted, { mode: 0o600 });
    const digest = sha256(redacted);
    const artifactId = `artifact_${digest.slice(0, 24)}`;
    const planningPayload = role === "planning" ? result.payload as { pending_questions?: string[] } : undefined;
    const planningQuestion = role === "planning" && (result.status === "needs_decision" || result.status === "completed" && planningPayload?.pending_questions?.length === 1);
    const dispatchState = planningQuestion ? "needs_decision" : result.status === "completed" ? "completed" : result.status;
    const transaction = store.db.transaction(() => {
      store.db.prepare("UPDATE dispatches SET state=?,result_json=?,completed_at=? WHERE dispatch_id=?").run(dispatchState, stableJson(result), new Date().toISOString(), dispatchId);
      store.db.prepare("INSERT OR IGNORE INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
        .run(artifactId, runId, dispatchId, artifact, digest, new Date().toISOString());
      store.event(runId, "dispatch.completed", { dispatchId, status: result.status, artifactId, digest });
      if (resolvedPredecessorRepair) store.event(runId, "test.predecessor_repair_resolved", {
        developer_dispatch_id: dispatchId,
        ...resolvedPredecessorRepair,
      });
      if (result.status === "completed" || planningQuestion) {
        if (role === "planning") ops.advancePlanning!(store, ops, runId, result);
        else if (role === "review-spec" || role === "review-standards") {
          const packet = JSON.parse(row.packet_json) as common.DispatchPacket;
          const barrierId = (packet.context as { barrier_id?: unknown }).barrier_id;
          if (typeof barrierId !== "string") throw new ValidationError(`${role} dispatch is not bound to a review barrier`);
          ops.reconcileReview!(store, ops, runId, barrierId);
        }
        else ops.advanceRun!(store, ops, runId, role, result);
      } else {
        if (result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1) {
          const checked = checkDecisionInput(result.decisions_needed[0]);
          if (!checked.valid) throw new ValidationError("needs_decision result requires one typed decision", checked.errors);
          store.createDecision(runId, checked.value.question, checked.value.choices, checked.value.recommendation, checked.value.type ?? "workflow", dispatchId);
        }
        const repairableTest = role === "test" && (result.status === "failed" || result.status === "retryable_failure") && result.decisions_needed.length === 0;
        const repairDispatchId = repairableTest
          ? ops.createTestRepair!(store, ops, runId, dispatchId, JSON.parse(row.packet_json) as common.DispatchPacket, result)
          : undefined;
        if (!ops.createBlockedTestRepairRecovery!(store, ops, runId, dispatchId) && !repairDispatchId) store.db.prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
          .run(result.status === "needs_decision" || result.status === "retryable_failure" && result.decisions_needed.length === 1 ? "needs_decision" : result.status === "retryable_failure" ? "retryable_failure" : "failed", new Date().toISOString(), runId);
      }
    });
    store.terminalCommand(commandId, "completed", { command: "dispatch submit", dispatch_state: dispatchState, retry_safe: true }, () => transaction());
    return {
      reused: false,
      artifact,
      submission: { state: "submitted", dispatch_state: dispatchState, artifact_id: artifactId, artifact, digest },
      continuation: ops.continuation!(store, ops, runId),
    };
  }

export function continuation(store: common.StateStore, ops: common.DispatchOperations, runId: string): common.DispatchContinuation {
    const run = store.getRun(runId) as { state: string; stage: string };
    const pending = store.db.prepare("SELECT dispatch_id,role,state,packet_json,replacement_for FROM dispatches WHERE run_id=? AND state IN ('pending','claimed') ORDER BY created_at,dispatch_id")
      .all(runId) as Array<{ dispatch_id: string; role: string; state: string; packet_json: string; replacement_for?: string }>;
    return {
      run_state: run.state,
      run_stage: run.stage,
      pending_dispatches: pending.map(({ packet_json, replacement_for, ...dispatch }) => {
        const context = (JSON.parse(packet_json) as common.DispatchPacket).context;
        const dependencies = Object.entries(context)
          .filter(([key, value]) => key.endsWith("_dispatch_id") && typeof value === "string")
          .map(([, value]) => value as string);
        if (replacement_for) dependencies.push(replacement_for);
        return { ...dispatch, depends_on: [...new Set(dependencies)] };
      }),
      pending_decision: (store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending' ORDER BY created_at,decision_id LIMIT 1")
        .get(runId) as Record<string, unknown> | undefined) ?? null,
    };
  }

export function runShowProjection(store: common.StateStore, ops: common.DispatchOperations, runId: string): {
    continuation: common.DispatchContinuation;
    planning_clarifications: Array<Record<string, unknown>>;
    pending_dependencies: Array<{ dispatch_id: string; depends_on: string[] }>;
    suggested_commands: string[];
  } {
    const continuation = ops.continuation!(store, ops, runId);
    const suggestedCommands = continuation.pending_dispatches.map((dispatch) => dispatch.state === "pending"
      ? `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --bundle`
      : `ai-team staging create --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --kind dispatch-result`);
    const decision = continuation.pending_decision as { decision_id?: unknown } | null;
    if (typeof decision?.decision_id === "string") {
      suggestedCommands.push(`ai-team run decide --run-id ${runId} --decision-id ${decision.decision_id} --choice <choice>`);
    }
    const run = store.getRun(runId) as { state: string };
    if (!suggestedCommands.length && run.state === "active") suggestedCommands.push(`ai-team run resume ${runId}`);
    return {
      continuation,
      planning_clarifications: store.planningClarifications(runId),
      pending_dependencies: continuation.pending_dispatches.map(({ dispatch_id, depends_on }) => ({ dispatch_id, depends_on })),
      suggested_commands: suggestedCommands,
    };
  }

export function artifactPath(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string): string { return join(store.paths.artifacts, runId, dispatchId, "result.json"); }

export async function exportTemplate(store: common.StateStore, ops: common.DispatchOperations, runId: string, dispatchId: string, role: Role, path: string): Promise<void> {
    await writeJson(path, ops.template!(store, ops, runId, dispatchId, role));
  }

export function assertCommandAllowed(store: common.StateStore, ops: common.DispatchOperations, role: Role, command: string): void {
    if (!ROLE_MANIFEST[role].commands.some((allowed) => allowed === command || allowed.endsWith("*") && command.startsWith(allowed.slice(0, -1)))) {
      throw new ValidationError(`${role} is not allowed to run ${command}`);
    }
  }
