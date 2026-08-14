import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Umzug } from "umzug";
import lockfile from "proper-lockfile";
import { getHomePaths, type HomePaths } from "./home.js";
import { ValidationError } from "./errors.js";
import { makeId, redact, sha256, stableJson } from "./utils.js";
import { CONTRACT_DIGEST } from "./contracts.js";
import { AGENT_BUILD, ROLE_MANIFEST_DIGEST } from "./roles.js";

/** Increment when persisted state contracts change incompatibly. */
export const STATE_SCHEMA_EPOCH = 2;

export interface StateStoreOpenOptions {
  readonly?: boolean;
}

const migrations = [
  {
    name: "001-initial",
    up: async ({ context: db }: { context: Database.Database }) => {
      db.exec(`
        CREATE TABLE repositories (repo_id TEXT PRIMARY KEY, common_dir TEXT UNIQUE NOT NULL, project_path TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE runs (run_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(repo_id), profile TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, plan_id TEXT, revision TEXT, base_commit TEXT, target_branch TEXT, request TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE run_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE decisions (decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, question TEXT NOT NULL, choices_json TEXT NOT NULL, recommendation TEXT, status TEXT NOT NULL, choice TEXT, note TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE revisions (plan_id TEXT NOT NULL, revision TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES repositories(repo_id), state TEXT NOT NULL, target_branch TEXT NOT NULL, digest TEXT, plan_commit TEXT, supersedes TEXT, created_at TEXT NOT NULL, PRIMARY KEY(plan_id, revision));
        CREATE TABLE dispatches (dispatch_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, role TEXT NOT NULL, state TEXT NOT NULL, packet_json TEXT NOT NULL, prompt TEXT NOT NULL, schema_json TEXT NOT NULL, template_json TEXT NOT NULL, result_json TEXT, claimed_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, dispatch_id));
        CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, dispatch_id TEXT REFERENCES dispatches(dispatch_id), kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, redacted INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE worktrees (worktree_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, branch TEXT NOT NULL, path TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE operations (operation_id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE, idempotency_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, request_json TEXT NOT NULL, evidence_json TEXT, created_at TEXT NOT NULL, completed_at TEXT);
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE UNIQUE INDEX one_pending_decision ON decisions(run_id) WHERE status = 'pending';
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "002-review-barriers",
    up: async ({ context: db }: { context: Database.Database }) => {
      db.exec(`
        CREATE TABLE review_barriers (barrier_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, revision_sha TEXT NOT NULL, formal INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(run_id, revision_sha));
        CREATE TABLE review_results (barrier_id TEXT NOT NULL REFERENCES review_barriers(barrier_id) ON DELETE CASCADE, axis TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(barrier_id, axis));
        CREATE TABLE finding_resolutions (barrier_id TEXT NOT NULL REFERENCES review_barriers(barrier_id) ON DELETE CASCADE, finding_id TEXT NOT NULL, change_evidence TEXT NOT NULL, verification_evidence TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(barrier_id, finding_id));
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "003-run-stages-and-reconcile",
    up: async ({ context: db }: { context: Database.Database }) => {
      const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "stage")) db.exec("ALTER TABLE runs ADD COLUMN stage TEXT NOT NULL DEFAULT 'started';");
      if (!columns.some((column) => column.name === "scope_digest")) db.exec("ALTER TABLE runs ADD COLUMN scope_digest TEXT;");
      db.exec("CREATE INDEX IF NOT EXISTS dispatches_run_state ON dispatches(run_id,state); CREATE INDEX IF NOT EXISTS operations_run_state ON operations(run_id,state);");
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "004-repository-scoped-revisions",
    up: async ({ context: db }: { context: Database.Database }) => {
      db.exec(`
        ALTER TABLE revisions RENAME TO revisions_legacy;
        CREATE TABLE revisions (
          plan_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
          state TEXT NOT NULL,
          target_branch TEXT NOT NULL,
          digest TEXT,
          plan_commit TEXT,
          supersedes TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(repo_id, plan_id, revision)
        );
        INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,supersedes,created_at)
          SELECT plan_id,revision,repo_id,state,target_branch,digest,plan_commit,supersedes,created_at FROM revisions_legacy;
        DROP TABLE revisions_legacy;
      `);
      const addColumn = (table: string, name: string, definition: string): void => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      };
      // These columns are nullable to keep the migration compatible with existing rows;
      // new runs/dispatches always freeze their values at creation time.
      addColumn("runs", "client_platform", "TEXT");
      addColumn("runs", "environment", "TEXT");
      addColumn("runs", "contract_digest", "TEXT");
      addColumn("runs", "role_manifest_digest", "TEXT");
      addColumn("runs", "template_digest", "TEXT");
      addColumn("runs", "implementation_base_commit", "TEXT");
      addColumn("runs", "plan_digest", "TEXT");
      addColumn("decisions", "decision_type", "TEXT NOT NULL DEFAULT 'workflow'");
      addColumn("decisions", "receipt_json", "TEXT");
      addColumn("dispatches", "packet_digest", "TEXT");
      addColumn("dispatches", "prompt_digest", "TEXT");
      addColumn("dispatches", "schema_digest", "TEXT");
      addColumn("dispatches", "template_digest", "TEXT");
      addColumn("dispatches", "renderer_version", "TEXT");
      addColumn("review_barriers", "base_commit", "TEXT");
      addColumn("review_barriers", "head_commit", "TEXT");
      addColumn("review_barriers", "plan_id", "TEXT");
      addColumn("review_barriers", "revision", "TEXT");
      addColumn("review_barriers", "document_digest", "TEXT");
      addColumn("review_barriers", "diff_digest", "TEXT");
      addColumn("review_barriers", "test_evidence_digest", "TEXT");
      addColumn("review_barriers", "repair_commit", "TEXT");
      addColumn("review_barriers", "verification_evidence", "TEXT");
      db.exec("CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      db.prepare("INSERT INTO state_meta(key,value) VALUES ('schema_epoch', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(STATE_SCHEMA_EPOCH));
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
];

export class StateStore {
  readonly paths: HomePaths;
  readonly db: Database.Database;

  private constructor(paths: HomePaths, db: Database.Database, private readonly releaseLock: () => void) {
    this.paths = paths;
    this.db = db;
  }

  private static async backupLegacyState(paths: HomePaths, timestamp: string): Promise<string> {
    const directory = join(paths.backups, `state-${timestamp}`);
    await mkdir(directory, { recursive: true });
    const copyIfPresent = async (source: string, destination: string): Promise<void> => {
      try { await mkdir(join(destination, ".."), { recursive: true }); await copyFile(source, destination); } catch { /* optional state asset */ }
    };
    await copyIfPresent(paths.database, join(directory, "state.sqlite"));
    for (const suffix of ["-wal", "-shm", "-journal"]) await copyIfPresent(`${paths.database}${suffix}`, join(directory, `state.sqlite${suffix}`));
    for (const name of ["config.yaml", "manifest.json", "backup-index.json"]) {
      await copyIfPresent(join(paths.root, name), join(directory, name));
    }
    try {
      const files = await readdir(paths.environments);
      await mkdir(join(directory, "environments"), { recursive: true });
      for (const file of files.filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))) {
        await copyIfPresent(join(paths.environments, file), join(directory, "environments", file));
      }
    } catch { /* environments may not exist before first install */ }
    return directory;
  }

  private static async removeDatabase(database: string): Promise<void> {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${database}${suffix}`, { force: true });
  }

  private static async requiresEpochReset(database: string, root: string): Promise<boolean> {
    let db: Database.Database | undefined;
    try {
      db = new Database(database, { readonly: true });
      const hasMeta = (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_meta'").get() as unknown) !== undefined;
      if (!hasMeta) return true;
      const epoch = db.prepare("SELECT value FROM state_meta WHERE key='schema_epoch'").get() as { value: string } | undefined;
      if (!epoch || Number(epoch.value) !== STATE_SCHEMA_EPOCH) return true;
    } catch {
      return true;
    } finally {
      db?.close();
    }
    // A marked config from an older epoch is incompatible even when the DB itself
    // happens to have been upgraded. Unmarked configs are valid pre-bootstrap state.
    try {
      const text = await readFile(join(root, "config.yaml"), "utf8");
      const marker = text.match(/^state_schema_epoch:\s*([0-9]+)\s*$/m);
      if (marker && Number(marker[1]) !== STATE_SCHEMA_EPOCH) return true;
    } catch { /* optional config */ }
    return false;
  }

  static async open(home?: string, options: StateStoreOpenOptions = {}): Promise<StateStore> {
    const paths = getHomePaths(home);
    if (options.readonly) {
      const db = new Database(paths.database, { readonly: true, fileMustExist: true });
      db.pragma("foreign_keys = ON");
      return new StateStore(paths, db, () => {});
    }
    await Promise.all([paths.state, paths.backups, paths.artifacts, paths.environments, paths.schemas, paths.templates].map((path) => mkdir(path, { recursive: true })));
    const releaseLock = await lockfile.lock(paths.state, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
    let existing = false;
    try { existing = (await stat(paths.database)).size > 0; } catch { /* new database */ }
    if (existing && await StateStore.requiresEpochReset(paths.database, paths.root)) {
      await StateStore.backupLegacyState(paths, new Date().toISOString().replace(/[:.]/g, "-"));
      await StateStore.removeDatabase(paths.database);
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
    return new StateStore(paths, db, releaseLock);
  }

  close(): void { this.db.close(); this.releaseLock(); }

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
  }): string {
    const runId = makeId("run");
    const now = new Date().toISOString();
    const implementationBaseCommit = input.implementationBaseCommit ?? input.baseCommit ?? null;
    this.db.prepare(`INSERT INTO runs(run_id, repo_id, profile, mode, state, stage, plan_id, revision, base_commit, target_branch, request,
      client_platform, environment, contract_digest, role_manifest_digest, template_digest, implementation_base_commit, plan_digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'file-explorer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, input.repoId, input.profile, input.mode, input.planId ?? null, input.revision ?? null, input.baseCommit ?? null,
      input.targetBranch ?? null, input.request ?? null, input.clientPlatform ?? "codex", input.environment ?? "balanced",
      input.contractDigest ?? CONTRACT_DIGEST, input.roleManifestDigest ?? ROLE_MANIFEST_DIGEST,
      input.templateDigest ?? AGENT_BUILD.digest, implementationBaseCommit, input.planDigest ?? null, now, now,
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

  event(runId: string, type: string, payload: unknown): void {
    const serialized = redact(stableJson(payload));
    if (serialized.length > 128 * 1024) throw new ValidationError("event payload exceeds the 128 KiB limit");
    this.db.prepare("INSERT INTO run_events(run_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(runId, type, serialized, new Date().toISOString());
  }

  beginOperation(kind: string, key: string, request: unknown, runId?: string): { operationId: string; reused: boolean; state: string } {
    const existing = this.db.prepare("SELECT operation_id,state FROM operations WHERE idempotency_key=?").get(key) as { operation_id: string; state: string } | undefined;
    if (existing) return { operationId: existing.operation_id, reused: true, state: existing.state };
    const operationId = `op_${sha256(key).slice(0, 26)}`;
    const serialized = redact(stableJson(request));
    if (serialized.length > 128 * 1024) throw new ValidationError("operation request exceeds the 128 KiB limit");
    this.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,created_at) VALUES (?,?,?,?, 'pending', ?,?)")
      .run(operationId, runId ?? null, key, kind, serialized, new Date().toISOString());
    return { operationId, reused: false, state: "pending" };
  }

  finishOperation(operationId: string, evidence: unknown): void {
    const serialized = redact(stableJson(evidence));
    if (serialized.length > 128 * 1024) throw new ValidationError("operation evidence exceeds the 128 KiB limit");
    this.db.prepare("UPDATE operations SET state='completed',evidence_json=?,completed_at=? WHERE operation_id=?").run(serialized, new Date().toISOString(), operationId);
  }

  reconcileOperation(operationId: string, state: "completed" | "not_applied" | "unknown", evidence: unknown): void {
    if (state === "unknown") throw new ValidationError("unknown side effect cannot be marked reconciled without external evidence");
    const serialized = redact(stableJson({ reconciliation: state, evidence }));
    if (serialized.length > 128 * 1024) throw new ValidationError("reconciliation evidence exceeds the 128 KiB limit");
    this.db.prepare("UPDATE operations SET state=?,evidence_json=?,completed_at=? WHERE operation_id=? AND state='pending'")
      .run(state === "completed" ? "completed" : "failed", serialized, new Date().toISOString(), operationId);
  }

  createDecision(runId: string, question: string, choices: Array<{ id: string; label: string; impact: string }>, recommendation?: string, type = "workflow"): string {
    if (!question.trim() || choices.length < 2 || choices.some((choice) => !choice.id || !choice.label || !choice.impact)) {
      throw new ValidationError("typed decision requires a question and at least two complete choices");
    }
    const existing = this.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (existing) throw new ValidationError(`run already has a pending decision: ${(existing as any).decision_id}`);
    const decisionId = `decision_${makeId("dispatch").slice(9)}`;
    const receipt = { type, question, choices, recommendation: recommendation ?? null };
    this.db.prepare("INSERT INTO decisions(decision_id,run_id,question,choices_json,recommendation,decision_type,receipt_json,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)")
      .run(decisionId, runId, question, stableJson(choices), recommendation ?? null, type, stableJson(receipt), new Date().toISOString());
    return decisionId;
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
    this.event(runId, "decision.resolved", { decisionId, choice });
  }
}
