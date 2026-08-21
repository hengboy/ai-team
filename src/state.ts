import Database from "better-sqlite3";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getHomePaths, type HomePaths } from "./home.js";
import { ValidationError } from "./errors.js";
import { makeId, redact, sha256, stableJson } from "./utils.js";
import { CONTRACT_DIGEST } from "./contracts.js";
import { checkDecisionInput } from "./contracts.js";
import { AGENT_BUILD, ROLE_MANIFEST_DIGEST } from "./roles.js";
import {
  STAGING_DEFAULT_RETENTION_HOURS,
  type Role,
  type StagingKind,
} from "./constants.js";
import { ensureManagedDirectory } from "./security.js";
import { migrateStagingFiles, StagingStore, type StagingBinding, type StagingCleanupSelector, type StagingEntry } from "./staging.js";
import { registerInvocationFinalizer } from "./resource-registry.js";
import type { PlanVerification, TaskVerification } from "./planning.js";

export type { StagingBinding, StagingCleanupSelector, StagingEntry } from "./staging.js";
import { Umzug } from "umzug";
import { backupLegacyState, migrations, pruneDatabaseBackups, removeDatabase, requiresStateEpochReset } from "./state/migrations.js";
export { STATE_SCHEMA_EPOCH } from "./state/migrations.js";
export const EVENT_SCHEMA_VERSION = 1;

const operationCommand = (kind: string): string => ({
  "git.worktree.replace": "git prepare",
  "git.worktree.create": "git prepare",
  "git.integration.create": "git prepare",
  "git.worktree.adopt": "git adopt",
  "git.worktree.transfer": "git transfer",
  "git.worktree.recover": "git recover-task-worktree",
  "git.commit": "git commit",
  "git.merge.task": "git merge-task",
  "git.sync": "git integrate",
  "git.merge.continue": "git continue-conflict",
  "git.task_authority.continue": "git continue-authority-conflict",
  "git.integrate": "git integrate",
  "git.cleanup": "git cleanup",
  "planning.revision.commit": "planning revision commit",
}[kind] ?? kind);

export const assertExplicitTaskWritePaths = (paths: string[], sourcePath: string): string[] => {
  const normalized = [...new Set(paths)].sort();
  if (!normalized.length) throw new ValidationError(`frozen Task is missing allowed write paths: ${sourcePath}`);
  const invalid = normalized.filter((path) => path === "." || path.startsWith("/") || path.includes("\\")
    || path.split("/").includes("..") || /[*?{}[\]]/.test(path) || !/^[A-Za-z0-9._/@+-]+$/.test(path)
    || (!path.includes("/") && !path.includes(".")));
  if (invalid.length) {
    throw new ValidationError(`frozen Task allowed write paths must be explicit repository paths: ${sourcePath}`, { invalid_paths: invalid });
  }
  return normalized;
};

export const frozenTaskWritePathsFromDocument = (content: string, sourcePath: string): string[] => {
  const line = content.split(/\r?\n/).find((candidate) => /^-\s*(?:允许写入路径|Allowed write paths)\s*[：:]/i.test(candidate));
  const paths = line ? [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean) : [];
  return assertExplicitTaskWritePaths(paths, sourcePath);
};

export interface StateStoreOpenOptions {
  readonly?: boolean;
}

export class StateStore {
  readonly paths: HomePaths;
  readonly db: Database.Database;

  private closed = false;
  private closePromise?: Promise<void>;
  private readonly commandFinalizers = new Map<string, () => void>();

  private constructor(paths: HomePaths, db: Database.Database, private readonly releaseLock: () => void | Promise<void>) {
    this.paths = paths;
    this.db = db;
  }

  static async open(home?: string, options: StateStoreOpenOptions = {}): Promise<StateStore> {
    const paths = getHomePaths(home);
    if (options.readonly) {
      const db = new Database(paths.database, { readonly: true, fileMustExist: true });
      db.pragma("foreign_keys = ON");
      return new StateStore(paths, db, () => {});
    }
    await Promise.all([paths.state, paths.backups, paths.artifacts, paths.environments, paths.schemas, paths.templates].map((path) => mkdir(path, { recursive: true })));
    await ensureManagedDirectory(paths.root, paths.staging);
    const releaseLock = await lockfile.lock(paths.state, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
    let existing = false;
    try { existing = (await stat(paths.database)).size > 0; } catch { /* new database */ }
    if (existing && await requiresStateEpochReset(paths.database, paths.root)) {
      await backupLegacyState(paths, new Date().toISOString().replace(/[:.]/g, "-"));
      await removeDatabase(paths.database);
      existing = false;
    }
    const backup = join(paths.backups, `state-${Date.now()}.sqlite`);
    if (existing) {
      await copyFile(paths.database, backup);
      for (const configFile of [join(paths.root, "config.yaml"), join(paths.root, "manifest.json")]) {
        try { await copyFile(configFile, `${backup}-${configFile.endsWith(".yaml") ? "config.yaml" : "manifest.json"}`); } catch { /* optional before first install */ }
      }
    }
    const db = new Database(paths.database);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const umzug = new Umzug({
      migrations,
      context: db,
      logger: undefined,
      storage: {
        executed: async () => {
          try { return db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row: any) => row.name as string); }
          catch { return []; }
        },
        logMigration: async ({ name }) => { db.prepare("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString()); },
        unlogMigration: async () => { throw new Error("forward-only migrations"); },
      },
    });
    try { await umzug.up(); }
    catch (error) {
      db.close();
      if (existing) {
        await copyFile(backup, paths.database);
        for (const configFile of [join(paths.root, "config.yaml"), join(paths.root, "manifest.json")]) {
          const snapshot = `${backup}-${configFile.endsWith(".yaml") ? "config.yaml" : "manifest.json"}`;
          try { await copyFile(snapshot, configFile); } catch { /* optional snapshot */ }
        }
      }
      // A reset starts from an empty state. The complete legacy snapshot is kept
      // for explicit recovery, but is intentionally never auto-restored.
      releaseLock();
      throw error;
    }
    try { await migrateStagingFiles(paths, db); }
    catch (error) {
      db.close();
      releaseLock();
      throw error;
    }
    try { await pruneDatabaseBackups(paths); }
    catch { /* Retention cleanup is retried on the next writable open. */ }
    return new StateStore(paths, db, releaseLock);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unregister of this.commandFinalizers.values()) unregister();
    this.commandFinalizers.clear();
    this.db.close();
    void this.releaseLock();
  }

  closeAsync(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.closed) return;
      this.closed = true;
      for (const unregister of this.commandFinalizers.values()) unregister();
      this.commandFinalizers.clear();
      this.db.close();
      await this.releaseLock();
    })();
    return this.closePromise;
  }

  registerRepository(repoId: string, commonDir: string, projectPath: string): void {
    this.db.prepare(`INSERT INTO repositories(repo_id, common_dir, project_path, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET project_path=excluded.project_path`).run(repoId, commonDir, projectPath, new Date().toISOString());
  }

  createRun(input: {
    repoId: string;
    profile: string;
    mode: string;
    planId?: string;
    revision?: string;
    baseCommit?: string;
    targetBranch?: string;
    request?: string;
    clientPlatform?: string;
    environment?: string;
    contractDigest?: string;
    roleManifestDigest?: string;
    templateDigest?: string;
    implementationBaseCommit?: string;
    planDigest?: string;
    planVerification?: PlanVerification;
    sourceRunId?: string;
  }): string {
    const runId = makeId("run");
    const now = new Date().toISOString();
    const implementationBaseCommit = input.implementationBaseCommit ?? input.baseCommit ?? null;
    this.db.prepare(`INSERT INTO runs(run_id, repo_id, profile, mode, state, stage, plan_id, revision, base_commit, target_branch, request,
      client_platform, environment, contract_digest, role_manifest_digest, template_digest, implementation_base_commit, plan_digest, plan_verification_json, source_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'file-explorer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, input.repoId, input.profile, input.mode, input.planId ?? null, input.revision ?? null, input.baseCommit ?? null,
      input.targetBranch ?? null, input.request ?? null, input.clientPlatform ?? "codex", input.environment ?? "balanced",
      input.contractDigest ?? CONTRACT_DIGEST, input.roleManifestDigest ?? ROLE_MANIFEST_DIGEST,
      input.templateDigest ?? AGENT_BUILD.digest, implementationBaseCommit, input.planDigest ?? null,
      input.planVerification ? stableJson(input.planVerification) : null, input.sourceRunId ?? null, now, now,
    );
    this.event(runId, "run.created", input);
    return runId;
  }

  bindPlanningRevision(runId: string, repoId: string, planId: string, revision: string): void {
    const run = this.getRun(runId) as { repo_id: string; profile: string };
    if (run.profile !== "planning" || run.repo_id !== repoId) throw new ValidationError("planning revision does not belong to this run repository");
    const revisionRow = this.db.prepare("SELECT digest FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?")
      .get(repoId, planId, revision) as { digest?: string } | undefined;
    this.db.prepare("UPDATE runs SET plan_id=?,revision=?,plan_digest=COALESCE(?,plan_digest),updated_at=? WHERE run_id=?")
      .run(planId, revision, revisionRow?.digest ?? null, new Date().toISOString(), runId);
    this.event(runId, "planning.revision_bound", { planId, revision });
  }

  getRun(runId: string): Record<string, unknown> {
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
    if (!run) throw new ValidationError(`unknown run: ${runId}`);
    return run;
  }

  initializeRunTasks(runId: string, tasks: Array<{ task_id: string; source_path: string; source_digest: string; write_paths: string[]; verification?: TaskVerification }>): void {
    this.getRun(runId);
    if (new Set(tasks.map(({ task_id }) => task_id)).size !== tasks.length
      || tasks.some(({ task_id, source_path, source_digest, write_paths }) => !/^TASK-\d{3}$/.test(task_id) || !source_path
        || !/^[a-f0-9]{64}$/.test(source_digest) || !write_paths.length || write_paths.some((path) => !path))) {
      throw new ValidationError("frozen run task metadata is invalid");
    }
    const existing = this.db.prepare("SELECT task_id,ordinal,source_path,source_digest,write_paths_json,verification_json FROM run_tasks WHERE run_id=? ORDER BY ordinal")
      .all(runId) as Array<{ task_id: string; ordinal: number; source_path: string; source_digest: string; write_paths_json?: string; verification_json?: string }>;
    const expected = tasks.map((task, ordinal) => ({
      ...task,
      write_paths: assertExplicitTaskWritePaths(task.write_paths, task.source_path),
      verification: task.verification ?? null,
      ordinal,
    }));
    if (existing.length) {
      const comparable = existing.map(({ write_paths_json, verification_json, ...task }) => ({
        ...task,
        write_paths: JSON.parse(write_paths_json ?? "[]"),
        verification: verification_json ? JSON.parse(verification_json) : null,
      }));
      if (stableJson(comparable) !== stableJson(expected)) throw new ValidationError("run task manifest is already frozen with different metadata");
      return;
    }
    const insert = this.db.prepare(`INSERT INTO run_tasks(run_id,task_id,ordinal,source_path,source_digest,write_paths_json,verification_json,state,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`);
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const task of expected) insert.run(runId, task.task_id, task.ordinal, task.source_path, task.source_digest, stableJson(task.write_paths), task.verification ? stableJson(task.verification) : null, now);
      if (expected.length) this.event(runId, "run.tasks_frozen", { tasks: expected });
    })();
  }

  replaceRunTaskManifest(
    runId: string,
    tasks: Array<{ task_id: string; source_path: string; source_digest: string; write_paths: string[]; verification?: TaskVerification }>,
  ): void {
    const run = this.getRun(runId) as { profile: string; mode: string; state: string };
    if (run.profile !== "coding" || run.mode !== "planned" || !["frozen", "failed"].includes(run.state)) {
      throw new ValidationError("task manifest replacement requires a frozen or failed planned coding run");
    }
    const existing = this.runTasks(runId);
    const expected = tasks.map((task, ordinal) => ({
      ...task,
      ordinal,
      write_paths: assertExplicitTaskWritePaths(task.write_paths, task.source_path),
      verification: task.verification ?? null,
    }));
    if (existing.length !== expected.length || existing.some((task, index) => task.task_id !== expected[index]?.task_id || task.ordinal !== index)) {
      throw new ValidationError("replacement task manifest must preserve frozen task identity and order");
    }
    for (const task of existing) {
      if (task.state !== "integrated") continue;
      const replacement = expected[task.ordinal]!;
      const unchanged = task.source_path === replacement.source_path
        && task.source_digest === replacement.source_digest
        && stableJson(JSON.parse(task.write_paths_json ?? "[]")) === stableJson(replacement.write_paths)
        && stableJson(task.verification_json ? JSON.parse(task.verification_json) : null) === stableJson(replacement.verification);
      if (!unchanged) throw new ValidationError(`replacement task manifest cannot alter integrated task: ${task.task_id}`);
    }
    this.db.transaction(() => {
      const update = this.db.prepare(`UPDATE run_tasks SET source_path=?,source_digest=?,write_paths_json=?,verification_json=?,updated_at=?
        WHERE run_id=? AND task_id=? AND state!='integrated'`);
      const now = new Date().toISOString();
      for (const task of expected) {
        update.run(task.source_path, task.source_digest, stableJson(task.write_paths), task.verification ? stableJson(task.verification) : null, now, runId, task.task_id);
      }
      this.event(runId, "run.task_manifest_replaced", {
        tasks: expected,
        preserved_integrated_task_ids: existing.filter((task) => task.state === "integrated").map((task) => task.task_id),
      });
    })();
  }

  runTasks(runId: string): Array<{
    task_id: string;
    ordinal: number;
    source_path: string;
    source_digest: string;
    write_paths_json?: string;
    verification_json?: string;
    state: "pending" | "prepared" | "implemented" | "tested" | "committed" | "integrated";
    worktree_id?: string;
    developer_dispatch_id?: string;
    test_dispatch_id?: string;
    implementation_commit?: string;
    integration_commit?: string;
  }> {
    return this.db.prepare("SELECT * FROM run_tasks WHERE run_id=? ORDER BY ordinal").all(runId) as ReturnType<StateStore["runTasks"]>;
  }

  advanceRunTask(
    runId: string,
    taskId: string,
    state: "prepared" | "implemented" | "tested" | "committed" | "integrated",
    evidence: {
      worktree_id?: string;
      developer_dispatch_id?: string;
      test_dispatch_id?: string;
      implementation_commit?: string;
      integration_commit?: string;
      recovered?: boolean;
    } = {},
  ): void {
    const task = this.db.prepare("SELECT state FROM run_tasks WHERE run_id=? AND task_id=?").get(runId, taskId) as { state: string } | undefined;
    if (!task) throw new ValidationError(`unknown frozen run task: ${taskId}`);
    const states = ["pending", "prepared", "implemented", "tested", "committed", "integrated"];
    const currentIndex = states.indexOf(task.state);
    const nextIndex = states.indexOf(state);
    if (nextIndex < currentIndex) return;
    if (nextIndex > currentIndex + 1 && !evidence.recovered) throw new ValidationError(`invalid run task transition: ${task.state} -> ${state}`);
    this.db.prepare(`UPDATE run_tasks SET state=?,worktree_id=COALESCE(?,worktree_id),developer_dispatch_id=COALESCE(?,developer_dispatch_id),
      test_dispatch_id=COALESCE(?,test_dispatch_id),implementation_commit=COALESCE(?,implementation_commit),integration_commit=COALESCE(?,integration_commit),updated_at=?
      WHERE run_id=? AND task_id=?`).run(
      state,
      evidence.worktree_id ?? null,
      evidence.developer_dispatch_id ?? null,
      evidence.test_dispatch_id ?? null,
      evidence.implementation_commit ?? null,
      evidence.integration_commit ?? null,
      new Date().toISOString(),
      runId,
      taskId,
    );
    this.event(runId, evidence.recovered ? "run.task_recovered" : "run.task_advanced", { task_id: taskId, from: task.state, to: state, ...evidence });
  }

  event(runId: string, type: string, payload: unknown): void {
    const serialized = redact(stableJson(payload));
    if (serialized.length > 128 * 1024) throw new ValidationError("event payload exceeds the 128 KiB limit");
    this.db.prepare("INSERT INTO run_events(run_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(runId, type, serialized, new Date().toISOString());
  }

  startCommand(runId: string, command: string, references: {
    correlationId?: string;
    dispatchId?: string;
    operationId?: string;
  } = {}): string {
    const commandId = makeId("command");
    const payload = redact(stableJson({ command, schema_version: EVENT_SCHEMA_VERSION }));
    this.db.prepare(`INSERT INTO run_events(run_id,type,payload_json,created_at,command_id,correlation_id,dispatch_id,operation_id)
      VALUES (?,'command.started',?,?,?,?,?,?)`).run(
      runId, payload, new Date().toISOString(), commandId, references.correlationId ?? null,
      references.dispatchId ?? null, references.operationId ?? null,
    );
    return commandId;
  }

  terminalCommand<T>(commandId: string, outcome: "completed" | "failed" | "interrupted", payload: unknown, commit: () => T): T {
    return this.db.transaction(() => {
      const started = this.db.prepare(`SELECT run_id,correlation_id,dispatch_id,operation_id FROM run_events
        WHERE command_id=? AND type='command.started'`).get(commandId) as {
        run_id: string;
        correlation_id?: string;
        dispatch_id?: string;
        operation_id?: string;
      } | undefined;
      if (!started) throw new ValidationError(`unknown command lifecycle: ${commandId}`);
      const existing = this.db.prepare(`SELECT type FROM run_events WHERE command_id=?
        AND type IN ('command.completed','command.failed','command.interrupted')`).get(commandId) as { type: string } | undefined;
      if (existing) throw new ValidationError(`command lifecycle is already terminal: ${commandId}`);
      const result = commit();
      const serialized = redact(stableJson({ ...((payload && typeof payload === "object" && !Array.isArray(payload)) ? payload as Record<string, unknown> : { value: payload }), schema_version: EVENT_SCHEMA_VERSION }));
      if (serialized.length > 128 * 1024) throw new ValidationError("event payload exceeds the 128 KiB limit");
      this.db.prepare(`INSERT INTO run_events(run_id,type,payload_json,created_at,command_id,correlation_id,dispatch_id,operation_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        started.run_id, `command.${outcome}`, serialized, new Date().toISOString(), commandId,
        started.correlation_id ?? null, started.dispatch_id ?? null, started.operation_id ?? null,
      );
      return result;
    })();
  }

  beginOperation(kind: string, key: string, request: unknown, runId?: string): { operationId: string; reused: boolean; state: string } {
    const existing = this.db.prepare("SELECT operation_id,state FROM operations WHERE idempotency_key=?").get(key) as { operation_id: string; state: string } | undefined;
    if (existing) return { operationId: existing.operation_id, reused: true, state: existing.state };
    const operationId = `op_${sha256(key).slice(0, 26)}`;
    const serialized = redact(stableJson(request));
    if (serialized.length > 128 * 1024) throw new ValidationError("operation request exceeds the 128 KiB limit");
    let commandId: string | undefined;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,created_at) VALUES (?,?,?,?, 'pending', ?,?)")
        .run(operationId, runId ?? null, key, kind, serialized, new Date().toISOString());
      if (runId) {
        const value = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : {};
        commandId = this.startCommand(runId, operationCommand(kind), {
          operationId,
          ...(typeof value.dispatch_id === "string" ? { dispatchId: value.dispatch_id } : {}),
          correlationId: operationId,
        });
      }
    })();
    if (commandId) {
      const id = commandId;
      const unregister = registerInvocationFinalizer(async () => {
        if (this.closed) return;
        const terminal = this.db.prepare("SELECT 1 FROM run_events WHERE command_id=? AND type IN ('command.completed','command.failed','command.interrupted')").get(id);
        if (!terminal) this.terminalCommand(id, "interrupted", { command: operationCommand(kind), retry_safe: false }, () => {});
        this.commandFinalizers.delete(id);
      });
      this.commandFinalizers.set(id, unregister);
    }
    return { operationId, reused: false, state: "pending" };
  }

  finishOperation(operationId: string, evidence: unknown): void {
    const serialized = redact(stableJson(evidence));
    if (serialized.length > 128 * 1024) throw new ValidationError("operation evidence exceeds the 128 KiB limit");
    const command = this.openCommandForOperation(operationId);
    const finish = (): void => {
      this.db.prepare("UPDATE operations SET state='completed',evidence_json=?,completed_at=? WHERE operation_id=?").run(serialized, new Date().toISOString(), operationId);
    };
    if (command) this.terminalCommand(command.command_id, "completed", { command: command.command, retry_safe: true }, finish);
    else finish();
    this.commandFinalizers.get(command?.command_id ?? "")?.();
    if (command) this.commandFinalizers.delete(command.command_id);
  }

  recordPendingOperationEvidence(operationId: string, evidence: unknown): void {
    const serialized = redact(stableJson(evidence));
    if (serialized.length > 128 * 1024) throw new ValidationError("operation evidence exceeds the 128 KiB limit");
    const updated = this.db.prepare("UPDATE operations SET evidence_json=? WHERE operation_id=? AND state='pending'").run(serialized, operationId);
    if (updated.changes !== 1) throw new ValidationError("pending operation was not found for evidence recording");
  }

  reconcileOperation(operationId: string, state: "completed" | "not_applied" | "unknown", evidence: unknown): void {
    if (state === "unknown") throw new ValidationError("unknown side effect cannot be marked reconciled without external evidence");
    const normalized = state === "completed" && evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? { ...(evidence as Record<string, unknown>), reconciliation: state }
      : { reconciliation: state, evidence };
    const serialized = redact(stableJson(normalized));
    if (serialized.length > 128 * 1024) throw new ValidationError("reconciliation evidence exceeds the 128 KiB limit");
    const targetState = state === "completed" ? "completed" : "failed";
    let updated!: { changes: number };
    const reconcile = (): void => {
      updated = this.db.prepare("UPDATE operations SET state=?,evidence_json=?,completed_at=? WHERE operation_id=? AND state='pending'")
        .run(targetState, serialized, new Date().toISOString(), operationId);
    };
    const command = this.openCommandForOperation(operationId);
    if (command) this.terminalCommand(command.command_id, state === "completed" ? "completed" : "failed", { command: command.command, reconciled: true, retry_safe: true }, reconcile);
    else reconcile();
    this.commandFinalizers.get(command?.command_id ?? "")?.();
    if (command) this.commandFinalizers.delete(command.command_id);
    if (updated.changes !== 1) {
      const existing = this.db.prepare("SELECT state FROM operations WHERE operation_id=?").get(operationId) as { state: string } | undefined;
      if (existing?.state !== targetState) throw new ValidationError("operation is unknown or cannot be reconciled from its current state");
    }
  }

  private openCommandForOperation(operationId: string): { command_id: string; command: string } | undefined {
    const row = this.db.prepare(`SELECT command_id,payload_json FROM run_events started WHERE operation_id=? AND type='command.started'
      AND NOT EXISTS (SELECT 1 FROM run_events terminal WHERE terminal.command_id=started.command_id
        AND terminal.type IN ('command.completed','command.failed','command.interrupted')) ORDER BY event_id DESC LIMIT 1`).get(operationId) as { command_id: string; payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { command?: string };
    return { command_id: row.command_id, command: payload.command ?? "operation reconcile" };
  }

  createDecision(
    runId: string,
    question: string,
    choices: Array<{ id: string; label: string; impact: string }>,
    recommendation?: string,
    type = "workflow",
    dispatchId?: string,
    mappings?: { requirementIds: string[]; acceptanceCriteria: string[] },
  ): string {
    const existing = this.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (existing) throw new ValidationError(`run already has a pending decision: ${(existing as any).decision_id}`);
    if (dispatchId) {
      const dispatch = this.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId);
      if (!dispatch) throw new ValidationError("decision dispatch binding does not match run");
    }
    const checked = checkDecisionInput({
      question,
      choices,
      recommendation,
      type,
      ...(mappings ? { requirement_ids: mappings.requirementIds, acceptance_criteria: mappings.acceptanceCriteria } : {}),
    });
    if (!checked.valid) throw new ValidationError("decision input is invalid", checked.errors);
    const decisionId = `decision_${makeId("dispatch").slice(9)}`;
    const receipt = { type: checked.value.type ?? "workflow", question, choices, recommendation: recommendation ?? null, dispatch_id: dispatchId ?? null };
    this.db.prepare("INSERT INTO decisions(decision_id,run_id,dispatch_id,question,choices_json,recommendation,decision_type,receipt_json,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'pending',?)")
      .run(decisionId, runId, dispatchId ?? null, question, stableJson(choices), recommendation, checked.value.type ?? "workflow", stableJson(receipt), new Date().toISOString());
    return decisionId;
  }

  createPlanningClarification(input: {
    runId: string;
    decisionId: string;
    source: string;
    impact: unknown;
    requirementIds: string[];
    acceptanceCriteria: string[];
  }): string {
    const decision = this.db.prepare("SELECT decision_type,status FROM decisions WHERE run_id=? AND decision_id=?")
      .get(input.runId, input.decisionId) as { decision_type: string; status: string } | undefined;
    if (!decision || decision.decision_type !== "requirement" || decision.status !== "pending") {
      throw new ValidationError("planning clarification requires a pending requirement decision");
    }
    const validMappings = (values: string[], pattern: RegExp, field: string): string[] => {
      const normalized = [...new Set(values)].sort();
      if (!normalized.length || normalized.some((value) => !pattern.test(value))) {
        throw new ValidationError(`planning clarification requires non-empty valid ${field}`);
      }
      return normalized;
    };
    const requirementIds = validMappings(input.requirementIds, /^REQ-[0-9]{3}$/, "requirement IDs");
    const acceptanceCriteria = validMappings(input.acceptanceCriteria, /^AC-[0-9]{3}$/, "acceptance criteria");
    const clarificationId = `clarification_${makeId("dispatch").slice(9)}`;
    this.db.prepare(`INSERT INTO planning_clarifications(
      clarification_id,run_id,decision_id,source,impact_json,requirement_ids_json,acceptance_criteria_json,status,created_at
    ) VALUES (?,?,?,?,?,?,?,'pending',?)`).run(
      clarificationId, input.runId, input.decisionId, input.source, stableJson(input.impact),
      stableJson(requirementIds), stableJson(acceptanceCriteria), new Date().toISOString(),
    );
    this.event(input.runId, "planning.clarification_opened", { clarification_id: clarificationId, decision_id: input.decisionId, source: input.source });
    return clarificationId;
  }

  planningClarifications(runId: string): Array<Record<string, unknown>> {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='planning_clarifications'").get();
    if (!table) return [];
    return (this.db.prepare(`SELECT c.clarification_id,c.source,c.impact_json,c.requirement_ids_json,c.acceptance_criteria_json,c.decision_id,
      d.status,d.choice FROM planning_clarifications c JOIN decisions d ON d.decision_id=c.decision_id
      WHERE c.run_id=? ORDER BY c.created_at,c.clarification_id`).all(runId) as Array<{
      clarification_id: string; source: string; impact_json: string; requirement_ids_json: string; acceptance_criteria_json: string;
      decision_id: string; status: string; choice?: string;
    }>).map(({ impact_json, requirement_ids_json, acceptance_criteria_json, status, choice, ...clarification }) => ({
      ...clarification,
      impact: JSON.parse(impact_json),
      requirement_ids: JSON.parse(requirement_ids_json),
      acceptance_criteria: JSON.parse(acceptance_criteria_json),
      status,
      answer: choice ?? null,
    }));
  }

  assertPlanningClarificationsResolved(runId: string): void {
    const clarifications = this.db.prepare(`SELECT c.clarification_id,c.requirement_ids_json,c.acceptance_criteria_json,c.status,c.answer,
      d.status AS decision_status,d.choice FROM planning_clarifications c JOIN decisions d ON d.decision_id=c.decision_id
      WHERE c.run_id=? ORDER BY c.created_at,c.clarification_id`).all(runId) as Array<{
      clarification_id: string; requirement_ids_json: string; acceptance_criteria_json: string; status: string; answer?: string;
      decision_status: string; choice?: string;
    }>;
    for (const clarification of clarifications) {
      let requirementIds: unknown;
      let acceptanceCriteria: unknown;
      try {
        requirementIds = JSON.parse(clarification.requirement_ids_json);
        acceptanceCriteria = JSON.parse(clarification.acceptance_criteria_json);
      } catch {
        throw new ValidationError(`planning clarification is structurally incomplete: ${clarification.clarification_id}`);
      }
      const valid = (values: unknown, pattern: RegExp): values is string[] => Array.isArray(values)
        && values.length > 0
        && values.every((value) => typeof value === "string" && pattern.test(value));
      if (!valid(requirementIds, /^REQ-[0-9]{3}$/) || !valid(acceptanceCriteria, /^AC-[0-9]{3}$/)
        || clarification.status !== clarification.decision_status
        || clarification.answer !== (clarification.choice ?? null)) {
        throw new ValidationError(`planning clarification is structurally incomplete: ${clarification.clarification_id}`);
      }
      if (clarification.decision_status !== "resolved") {
        throw new ValidationError(`planning has a pending clarification: ${clarification.clarification_id}`);
      }
    }
  }

  decide(runId: string, decisionId: string, choice: string, note?: string): void {
    const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id=? AND run_id=?").get(decisionId, runId) as any;
    if (!row || row.status !== "pending") throw new ValidationError("decision is unknown, stale, or already resolved");
    const choices = JSON.parse(row.choices_json) as Array<{ id: string }>;
    if (!choices.some((item) => item.id === choice)) throw new ValidationError(`unknown decision choice: ${choice}`);
    const resolvedAt = new Date().toISOString();
    const receipt = { ...JSON.parse(row.receipt_json ?? "{}"), decision_id: decisionId, choice, note: note ?? null, resolved_at: resolvedAt };
    this.db.prepare("UPDATE decisions SET status='resolved',choice=?,note=?,receipt_json=?,resolved_at=? WHERE decision_id=?")
      .run(choice, note ?? null, stableJson(receipt), resolvedAt, decisionId);
    const clarification = this.db.prepare(`UPDATE planning_clarifications SET status='resolved',answer=?,resolved_at=?
      WHERE run_id=? AND decision_id=? AND status='pending'`).run(choice, resolvedAt, runId, decisionId);
    this.event(runId, "decision.resolved", { decisionId, choice });
    if (clarification.changes) this.event(runId, "planning.clarification_resolved", { decision_id: decisionId, answer: choice });
  }

  assertTaskPreviewApproved(runId: string): void {
    const decision = this.db.prepare(`SELECT status,choice FROM decisions
      WHERE run_id=? AND decision_type='task_preview' ORDER BY created_at DESC,decision_id DESC LIMIT 1`)
      .get(runId) as { status: string; choice?: string } | undefined;
    if (!decision || decision.status !== "resolved") throw new ValidationError("task preview decision must be resolved before revision creation");
    if (decision.choice !== "approve") throw new ValidationError("task preview must be approved before revision creation");
  }

  private stagingStore(): StagingStore {
    return new StagingStore({
      db: this.db,
      paths: this.paths,
      event: (runId, type, payload) => this.event(runId, type, payload),
      getRun: (runId) => this.getRun(runId),
    });
  }

  getStagingEntry(stagingId: string): StagingEntry {
    return this.stagingStore().get(stagingId);
  }

  listStagingEntries(runId: string, role: Role): StagingEntry[] {
    return this.stagingStore().list(runId, role);
  }

  recordStagingValidationFailure(stagingId: string, binding: StagingBinding, error: unknown): void {
    this.stagingStore().recordValidationFailure(stagingId, binding, error);
  }

  cancelStagingEntry(stagingId: string, binding: StagingBinding, reason: string): StagingEntry {
    return this.stagingStore().cancel(stagingId, binding, reason);
  }

  async createStagingEntry(input: {
    runId: string;
    dispatchId?: string;
    role: Role;
    kind: StagingKind;
    initialJson?: string | Buffer;
    retentionHours?: number;
    now?: Date;
  }): Promise<StagingEntry> {
    return this.stagingStore().create(input);
  }

  async writeStagingEntry(
    stagingId: string,
    content: string | Buffer,
    binding: StagingBinding = {},
    beforeReplace?: () => Promise<void> | void,
    retentionHours = STAGING_DEFAULT_RETENTION_HOURS,
  ): Promise<StagingEntry> {
    return this.stagingStore().write(stagingId, content, binding, beforeReplace, retentionHours);
  }

  async readStagingEntry(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    return this.stagingStore().read(stagingId, binding);
  }

  async inspectStagingEntry(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    return this.stagingStore().inspect(stagingId, binding);
  }

  async consumeStagingEntry(stagingId: string, binding: StagingBinding = {}, now = new Date(), retentionHours = STAGING_DEFAULT_RETENTION_HOURS): Promise<StagingEntry> {
    return this.stagingStore().consume(stagingId, binding, now, retentionHours);
  }

  expireStagingEntries(now = new Date()): number {
    return this.stagingStore().expire(now);
  }

  async cleanupStagingEntries(selector: StagingCleanupSelector = { expired: true }): Promise<{ matched: number; removed: number; pending: number }> {
    return this.stagingStore().cleanup(selector);
  }
}
