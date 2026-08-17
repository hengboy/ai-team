import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Umzug } from "umzug";
import lockfile from "proper-lockfile";
import { getHomePaths, type HomePaths } from "./home.js";
import { ValidationError, validationCause } from "./errors.js";
import { makeId, redact, sha256, stableJson } from "./utils.js";
import { CONTRACT_DIGEST } from "./contracts.js";
import { checkDecisionInput } from "./contracts.js";
import { AGENT_BUILD, ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "./roles.js";
import {
  STAGING_DEFAULT_RETENTION_HOURS,
  STAGING_KINDS,
  STAGING_OPPORTUNISTIC_CLEANUP_LIMIT,
  ROLES,
  type Role,
  type StagingKind,
  type StagingState,
} from "./constants.js";
import {
  ensureManagedDirectory,
  legacyStagingFilePath,
  readManagedJsonFile,
  removeManagedFile,
  renameManagedFile,
  stagingFilePath,
  stagingRunDirectory,
  writeManagedJsonFile,
  type ManagedFileIdentity,
} from "./security.js";

/** Increment when persisted state contracts change incompatibly. */
export const STATE_SCHEMA_EPOCH = 2;

export interface StateStoreOpenOptions {
  readonly?: boolean;
}

export interface StagingEntry {
  stagingId: string;
  runId: string;
  dispatchId: string | null;
  role: Role;
  kind: StagingKind;
  state: StagingState;
  contentDigest: string | null;
  contentBytes: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  cleanupAttemptedAt: string | null;
  cleanupError: string | null;
}

interface StagingEntryRow {
  staging_id: string;
  run_id: string;
  sequence_no: number;
  dispatch_id: string | null;
  role: Role;
  kind: StagingKind;
  state: StagingState;
  content_sha256: string | null;
  content_bytes: number | null;
  file_dev: string | null;
  file_ino: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  consumed_at: string | null;
  cleanup_attempted_at: string | null;
  cleanup_error: string | null;
}

export interface StagingBinding {
  runId?: string;
  dispatchId?: string | null;
  role?: Role;
  kind?: StagingKind;
}

export interface StagingCleanupSelector {
  stagingId?: string;
  runId?: string;
  all?: boolean;
  expired?: boolean;
  limit?: number;
  now?: Date;
  retentionHours?: number;
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
  {
    name: "005-staging-entries",
    up: async ({ context: db }: { context: Database.Database }) => {
      db.exec(`
        CREATE TABLE staging_entries (
          staging_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          dispatch_id TEXT REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('project-context','planning-documents','planning-tasks','dispatch-packet','dispatch-result','decision','git-reconcile-evidence','research-conclusions','review-result','review-resolution')),
          state TEXT NOT NULL CHECK(state IN ('draft','ready','consumed','cleanup_pending','expired')),
          content_sha256 TEXT,
          content_bytes INTEGER,
          file_dev TEXT,
          file_ino TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          cleanup_attempted_at TEXT,
          cleanup_error TEXT
        );
        CREATE INDEX staging_entries_expiry ON staging_entries(state, expires_at);
        CREATE INDEX staging_entries_run ON staging_entries(run_id, created_at);
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "006-recovery-provenance",
    up: async ({ context: db }: { context: Database.Database }) => {
      const addColumn = (table: string, name: string, definition: string): void => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      };
      addColumn("decisions", "dispatch_id", "TEXT REFERENCES dispatches(dispatch_id)");
      addColumn("dispatches", "replacement_for", "TEXT REFERENCES dispatches(dispatch_id)");
      addColumn("worktrees", "adopted_from_run_id", "TEXT");
      addColumn("review_barriers", "revision_digest", "TEXT");
      addColumn("review_barriers", "evidence_digest", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS decisions_dispatch ON decisions(run_id,dispatch_id,status);
        CREATE INDEX IF NOT EXISTS dispatches_replacement ON dispatches(run_id,replacement_for);
        CREATE UNIQUE INDEX IF NOT EXISTS active_worktree_path ON worktrees(path) WHERE state='active';
        CREATE UNIQUE INDEX IF NOT EXISTS active_worktree_branch ON worktrees(branch) WHERE state='active';
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "007-review-barrier-reconciliation",
    up: async ({ context: db }: { context: Database.Database }) => {
      const addColumn = (name: string, definition: string): void => {
        const columns = db.prepare("PRAGMA table_info(review_barriers)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE review_barriers ADD COLUMN ${name} ${definition}`);
      };
      addColumn("axes_json", "TEXT");
      addColumn("spec_dispatch_id", "TEXT REFERENCES dispatches(dispatch_id)");
      addColumn("standards_dispatch_id", "TEXT REFERENCES dispatches(dispatch_id)");
      addColumn("spec_result_digest", "TEXT");
      addColumn("standards_result_digest", "TEXT");
      addColumn("aggregate_json", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS review_barriers_run_revision ON review_barriers(run_id,revision_sha);
        CREATE INDEX IF NOT EXISTS review_barriers_leaf_dispatches ON review_barriers(spec_dispatch_id,standards_dispatch_id);
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "008-run-planning-handoff",
    up: async ({ context: db }: { context: Database.Database }) => {
      const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "source_run_id")) db.exec("ALTER TABLE runs ADD COLUMN source_run_id TEXT REFERENCES runs(run_id);");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_planning_handoff_per_source ON runs(source_run_id) WHERE source_run_id IS NOT NULL;");
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "009-readable-staging-filenames",
    up: async ({ context: db }: { context: Database.Database }) => {
      const stagingColumns = db.prepare("PRAGMA table_info(staging_entries)").all() as Array<{ name: string }>;
      if (!stagingColumns.some((column) => column.name === "sequence_no")) db.exec("ALTER TABLE staging_entries ADD COLUMN sequence_no INTEGER;");
      const runColumns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      if (!runColumns.some((column) => column.name === "next_staging_sequence")) {
        db.exec("ALTER TABLE runs ADD COLUMN next_staging_sequence INTEGER NOT NULL DEFAULT 1;");
      }
      db.exec(`
        WITH ranked AS (
          SELECT staging_id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at, staging_id) AS sequence_no
          FROM staging_entries
        )
        UPDATE staging_entries
          SET sequence_no=(SELECT ranked.sequence_no FROM ranked WHERE ranked.staging_id=staging_entries.staging_id)
          WHERE sequence_no IS NULL;
        UPDATE runs SET next_staging_sequence=COALESCE(
          (SELECT MAX(sequence_no) + 1 FROM staging_entries WHERE staging_entries.run_id=runs.run_id),
          1
        );
        CREATE UNIQUE INDEX IF NOT EXISTS staging_entries_run_sequence ON staging_entries(run_id, sequence_no);
      `);
    },
    down: async () => { throw new Error("forward-only migrations"); },
  },
  {
    name: "010-cancelable-staging-entries",
    up: async ({ context: db }: { context: Database.Database }) => {
      db.exec(`
        CREATE TABLE staging_entries_v10 (
          staging_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          dispatch_id TEXT REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('project-context','planning-documents','planning-tasks','dispatch-packet','dispatch-result','decision','git-reconcile-evidence','research-conclusions','review-result','review-resolution')),
          state TEXT NOT NULL CHECK(state IN ('draft','ready','consumed','canceled','cleanup_pending','expired')),
          content_sha256 TEXT,
          content_bytes INTEGER,
          file_dev TEXT,
          file_ino TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          cleanup_attempted_at TEXT,
          cleanup_error TEXT,
          sequence_no INTEGER
        );
        INSERT INTO staging_entries_v10 SELECT
          staging_id,run_id,dispatch_id,role,kind,state,content_sha256,content_bytes,file_dev,file_ino,
          created_at,updated_at,expires_at,consumed_at,cleanup_attempted_at,cleanup_error,sequence_no
          FROM staging_entries;
        DROP TABLE staging_entries;
        ALTER TABLE staging_entries_v10 RENAME TO staging_entries;
        CREATE INDEX staging_entries_expiry ON staging_entries(state, expires_at);
        CREATE INDEX staging_entries_run ON staging_entries(run_id, created_at);
        CREATE UNIQUE INDEX staging_entries_run_sequence ON staging_entries(run_id, sequence_no);
      `);
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

  private static async migrateStagingFiles(paths: HomePaths, db: Database.Database): Promise<void> {
    const completed = db.prepare("SELECT value FROM state_meta WHERE key='staging_filename_migration'").get() as { value: string } | undefined;
    if (completed?.value === "complete") return;
    const rows = db.prepare(`SELECT * FROM staging_entries
      WHERE file_dev IS NOT NULL AND file_ino IS NOT NULL AND state <> 'consumed'
      ORDER BY run_id,sequence_no`).all() as StagingEntryRow[];
    for (const row of rows) {
      const inspectCandidate = async (path: string): Promise<ManagedFileIdentity> => {
        const content = await readManagedJsonFile(paths.staging, path);
        if (content.digest !== row.content_sha256 || content.bytes !== row.content_bytes) {
          throw new ValidationError(`legacy staging content does not match persisted metadata: ${row.staging_id}`);
        }
        return content.identity;
      };
      const destination = stagingFilePath(paths.staging, row.run_id, row.sequence_no, row.kind, row.role);
      try {
        const identity = await inspectCandidate(destination);
        db.prepare("UPDATE staging_entries SET file_dev=?,file_ino=? WHERE staging_id=?")
          .run(identity.dev, identity.ino, row.staging_id);
        continue;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      const source = legacyStagingFilePath(paths.staging, row.run_id, row.staging_id);
      const identity = await inspectCandidate(source);
      await renameManagedFile(paths.staging, source, destination, identity);
      db.prepare("UPDATE staging_entries SET file_dev=?,file_ino=? WHERE staging_id=?")
        .run(identity.dev, identity.ino, row.staging_id);
    }
    db.prepare("INSERT INTO state_meta(key,value) VALUES ('staging_filename_migration','complete') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
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
    await ensureManagedDirectory(paths.root, paths.staging);
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
    try { await StateStore.migrateStagingFiles(paths, db); }
    catch (error) {
      db.close();
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
    sourceRunId?: string;
  }): string {
    const runId = makeId("run");
    const now = new Date().toISOString();
    const implementationBaseCommit = input.implementationBaseCommit ?? input.baseCommit ?? null;
    this.db.prepare(`INSERT INTO runs(run_id, repo_id, profile, mode, state, stage, plan_id, revision, base_commit, target_branch, request,
      client_platform, environment, contract_digest, role_manifest_digest, template_digest, implementation_base_commit, plan_digest, source_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'file-explorer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, input.repoId, input.profile, input.mode, input.planId ?? null, input.revision ?? null, input.baseCommit ?? null,
      input.targetBranch ?? null, input.request ?? null, input.clientPlatform ?? "codex", input.environment ?? "balanced",
      input.contractDigest ?? CONTRACT_DIGEST, input.roleManifestDigest ?? ROLE_MANIFEST_DIGEST,
      input.templateDigest ?? AGENT_BUILD.digest, implementationBaseCommit, input.planDigest ?? null, input.sourceRunId ?? null, now, now,
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

  createDecision(runId: string, question: string, choices: Array<{ id: string; label: string; impact: string }>, recommendation?: string, type = "workflow", dispatchId?: string): string {
    const existing = this.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (existing) throw new ValidationError(`run already has a pending decision: ${(existing as any).decision_id}`);
    if (dispatchId) {
      const dispatch = this.db.prepare("SELECT 1 FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId);
      if (!dispatch) throw new ValidationError("decision dispatch binding does not match run");
    }
    const checked = checkDecisionInput({ question, choices, recommendation, type });
    if (!checked.valid) throw new ValidationError("decision input is invalid", checked.errors);
    const decisionId = `decision_${makeId("dispatch").slice(9)}`;
    const receipt = { type: checked.value.type ?? "workflow", question, choices, recommendation: recommendation ?? null, dispatch_id: dispatchId ?? null };
    this.db.prepare("INSERT INTO decisions(decision_id,run_id,dispatch_id,question,choices_json,recommendation,decision_type,receipt_json,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'pending',?)")
      .run(decisionId, runId, dispatchId ?? null, question, stableJson(choices), recommendation, checked.value.type ?? "workflow", stableJson(receipt), new Date().toISOString());
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

  assertTaskPreviewApproved(runId: string): void {
    const decision = this.db.prepare(`SELECT status,choice FROM decisions
      WHERE run_id=? AND decision_type='task_preview' ORDER BY created_at DESC,decision_id DESC LIMIT 1`)
      .get(runId) as { status: string; choice?: string } | undefined;
    if (!decision || decision.status !== "resolved") throw new ValidationError("task preview decision must be resolved before revision creation");
    if (decision.choice !== "approve") throw new ValidationError("task preview must be approved before revision creation");
  }

  private stagingRow(stagingId: string): StagingEntryRow {
    const row = this.db.prepare("SELECT * FROM staging_entries WHERE staging_id=?").get(stagingId) as StagingEntryRow | undefined;
    if (!row) throw new ValidationError(`unknown staging entry: ${stagingId}`);
    return row;
  }

  private stagingMetadata(row: StagingEntryRow): StagingEntry {
    return {
      stagingId: row.staging_id,
      runId: row.run_id,
      dispatchId: row.dispatch_id,
      role: row.role,
      kind: row.kind,
      state: row.state,
      contentDigest: row.content_sha256,
      contentBytes: row.content_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      cleanupAttemptedAt: row.cleanup_attempted_at,
      cleanupError: row.cleanup_error,
    };
  }

  private stagingIdentity(row: StagingEntryRow): ManagedFileIdentity {
    if (!row.file_dev || !row.file_ino) throw new ValidationError(`staging entry has no content identity: ${row.staging_id}`);
    return { dev: row.file_dev, ino: row.file_ino };
  }

  private stagingPath(row: Pick<StagingEntryRow, "run_id" | "sequence_no" | "kind" | "role">): string {
    return stagingFilePath(this.paths.staging, row.run_id, row.sequence_no, row.kind, row.role);
  }

  private async ensureStagingDirectories(runId?: string): Promise<void> {
    await ensureManagedDirectory(this.paths.root, this.paths.staging);
    if (runId) await ensureManagedDirectory(this.paths.staging, stagingRunDirectory(this.paths.staging, runId));
  }

  private assertStagingBinding(row: StagingEntryRow, binding: StagingBinding): void {
    if (binding.runId !== undefined && row.run_id !== binding.runId) throw new ValidationError("staging run binding does not match");
    if (binding.dispatchId !== undefined && row.dispatch_id !== binding.dispatchId) throw new ValidationError("staging dispatch binding does not match");
    if (binding.role !== undefined && row.role !== binding.role) throw new ValidationError("staging role binding does not match");
    if (binding.kind !== undefined && row.kind !== binding.kind) throw new ValidationError("staging kind binding does not match");
  }

  private activeStagingRow(stagingId: string, binding: StagingBinding = {}, now = new Date()): StagingEntryRow {
    this.expireStagingEntries(now);
    const row = this.stagingRow(stagingId);
    this.assertStagingBinding(row, binding);
    if (row.state === "expired") throw new ValidationError(`staging entry has expired: ${stagingId}`);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry is not readable: ${row.state}`);
    return row;
  }

  getStagingEntry(stagingId: string): StagingEntry {
    return this.stagingMetadata(this.stagingRow(stagingId));
  }

  listStagingEntries(runId: string, role: Role): StagingEntry[] {
    this.getRun(runId);
    return (this.db.prepare("SELECT * FROM staging_entries WHERE run_id=? AND role=? ORDER BY created_at,staging_id")
      .all(runId, role) as StagingEntryRow[]).map((row) => this.stagingMetadata(row));
  }

  recordStagingValidationFailure(stagingId: string, binding: StagingBinding, error: unknown): void {
    const row = this.stagingRow(stagingId);
    this.assertStagingBinding(row, binding);
    this.event(row.run_id, "staging.validation_failed", {
      stagingId,
      error: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000),
      cause: validationCause(error),
    });
  }

  cancelStagingEntry(stagingId: string, binding: StagingBinding, reason: string): StagingEntry {
    if (!reason.trim()) throw new ValidationError("staging cancellation requires a reason");
    const row = this.stagingRow(stagingId);
    this.assertStagingBinding(row, binding);
    if (row.state === "canceled") return this.stagingMetadata(row);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry cannot be canceled from ${row.state}`);
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE staging_entries SET state='canceled',consumed_at=?,updated_at=? WHERE staging_id=?")
      .run(timestamp, timestamp, stagingId);
    this.event(row.run_id, "staging.canceled", { stagingId, dispatchId: row.dispatch_id, role: row.role, kind: row.kind, reason });
    return this.getStagingEntry(stagingId);
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
    if (!(ROLES as readonly string[]).includes(input.role)) throw new ValidationError(`unknown staging role: ${input.role}`);
    if (!(STAGING_KINDS as readonly string[]).includes(input.kind)) throw new ValidationError(`unknown staging kind: ${input.kind}`);
    if (!ROLE_MANIFEST[input.role].staging.owned_entries.includes(input.kind)) {
      throw new ValidationError(`${input.role} does not own staging kind ${input.kind}`);
    }
    this.getRun(input.runId);
    if (input.dispatchId) {
      const dispatch = this.db.prepare("SELECT run_id,role FROM dispatches WHERE dispatch_id=?").get(input.dispatchId) as { run_id: string; role: string } | undefined;
      if (!dispatch || dispatch.run_id !== input.runId || dispatch.role !== input.role) {
        throw new ValidationError("staging dispatch binding does not match run and role");
      }
    }
    const retentionHours = input.retentionHours ?? STAGING_DEFAULT_RETENTION_HOURS;
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const now = input.now ?? new Date();
    await this.ensureStagingDirectories();
    await this.cleanupStagingEntries({ expired: true, limit: STAGING_OPPORTUNISTIC_CLEANUP_LIMIT, now });
    const stagingId = makeId("staging");
    const sequence = this.db.prepare(`UPDATE runs SET next_staging_sequence=next_staging_sequence+1 WHERE run_id=?
      RETURNING next_staging_sequence-1 AS sequence_no`).get(input.runId) as { sequence_no: number } | undefined;
    if (!sequence) throw new ValidationError(`unknown run: ${input.runId}`);
    const runDirectory = stagingRunDirectory(this.paths.staging, input.runId);
    await ensureManagedDirectory(this.paths.staging, runDirectory);
    const path = stagingFilePath(this.paths.staging, input.runId, sequence.sequence_no, input.kind, input.role);
    const defaultJson = input.kind === "planning-documents" ? '{"spec":"","plan":""}' : "null";
    const content = await writeManagedJsonFile(this.paths.staging, path, input.initialJson ?? defaultJson);
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
    try {
      this.db.prepare(`INSERT INTO staging_entries(
        staging_id,run_id,sequence_no,dispatch_id,role,kind,state,content_sha256,content_bytes,file_dev,file_ino,created_at,updated_at,expires_at
      ) VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?)`).run(
        stagingId, input.runId, sequence.sequence_no, input.dispatchId ?? null, input.role, input.kind, content.digest, content.bytes,
        content.identity.dev, content.identity.ino, timestamp, timestamp, expiresAt,
      );
      this.event(input.runId, "staging.created", { stagingId, sequenceNo: sequence.sequence_no, dispatchId: input.dispatchId ?? null, role: input.role, kind: input.kind });
    } catch (error) {
      await removeManagedFile(this.paths.staging, path, content.identity).catch(() => {});
      throw error;
    }
    return this.getStagingEntry(stagingId);
  }

  async writeStagingEntry(
    stagingId: string,
    content: string | Buffer,
    binding: StagingBinding = {},
    beforeReplace?: () => Promise<void> | void,
    retentionHours = STAGING_DEFAULT_RETENTION_HOURS,
  ): Promise<StagingEntry> {
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const persisted = this.stagingRow(stagingId);
    await this.ensureStagingDirectories(persisted.run_id);
    const row = this.activeStagingRow(stagingId, binding);
    const written = await writeManagedJsonFile(
      this.paths.staging,
      this.stagingPath(row),
      content,
      this.stagingIdentity(row),
      ...(beforeReplace ? [{ beforeReplace }] : []),
    );
    const now = new Date();
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
    this.db.prepare(`UPDATE staging_entries SET state='ready',content_sha256=?,content_bytes=?,file_dev=?,file_ino=?,updated_at=?,expires_at=?,cleanup_error=NULL
      WHERE staging_id=? AND state IN ('draft','ready')`).run(
      written.digest, written.bytes, written.identity.dev, written.identity.ino, timestamp, expiresAt, stagingId,
    );
    this.event(row.run_id, "staging.written", { stagingId, digest: written.digest, bytes: written.bytes });
    return this.getStagingEntry(stagingId);
  }

  async readStagingEntry(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    const persisted = this.stagingRow(stagingId);
    await this.ensureStagingDirectories(persisted.run_id);
    const row = this.activeStagingRow(stagingId, binding);
    const content = await readManagedJsonFile(
      this.paths.staging,
      this.stagingPath(row),
      this.stagingIdentity(row),
    );
    if (content.digest !== row.content_sha256 || content.bytes !== row.content_bytes) {
      throw new ValidationError("staging content does not match persisted metadata");
    }
    return { entry: this.stagingMetadata(row), value: content.value };
  }

  async inspectStagingEntry(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    const row = this.stagingRow(stagingId);
    this.assertStagingBinding(row, binding);
    if (row.state === "expired" || row.expires_at <= new Date().toISOString()) throw new ValidationError(`staging entry has expired: ${stagingId}`);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry is not readable: ${row.state}`);
    const content = await readManagedJsonFile(this.paths.staging, this.stagingPath(row), this.stagingIdentity(row));
    if (content.digest !== row.content_sha256 || content.bytes !== row.content_bytes) {
      throw new ValidationError("staging content does not match persisted metadata");
    }
    return { entry: this.stagingMetadata(row), value: content.value };
  }

  async consumeStagingEntry(stagingId: string, binding: StagingBinding = {}, now = new Date(), retentionHours = STAGING_DEFAULT_RETENTION_HOURS): Promise<StagingEntry> {
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const persisted = this.stagingRow(stagingId);
    await this.ensureStagingDirectories(persisted.run_id);
    const row = this.activeStagingRow(stagingId, binding, now);
    const timestamp = now.toISOString();
    this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',consumed_at=?,updated_at=?,cleanup_attempted_at=?,cleanup_error=NULL
      WHERE staging_id=?`).run(timestamp, timestamp, timestamp, stagingId);
    try {
      await removeManagedFile(this.paths.staging, this.stagingPath(row), this.stagingIdentity(row));
      this.db.prepare(`UPDATE staging_entries SET state='consumed',consumed_at=?,updated_at=?,cleanup_attempted_at=?,cleanup_error=NULL
        WHERE staging_id=?`).run(timestamp, timestamp, timestamp, stagingId);
      this.event(row.run_id, "staging.consumed", { stagingId, digest: row.content_sha256, bytes: row.content_bytes });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const retryAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
      this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',updated_at=?,expires_at=?,cleanup_attempted_at=?,cleanup_error=?
        WHERE staging_id=?`).run(timestamp, retryAt, timestamp, message, stagingId);
      this.event(row.run_id, "staging.cleanup_pending", { stagingId, digest: row.content_sha256 });
    }
    return this.getStagingEntry(stagingId);
  }

  expireStagingEntries(now = new Date()): number {
    const timestamp = now.toISOString();
    const rows = this.db.prepare(`SELECT staging_id,run_id FROM staging_entries
      WHERE state IN ('draft','ready') AND expires_at<=?`).all(timestamp) as Array<{ staging_id: string; run_id: string }>;
    const update = this.db.prepare("UPDATE staging_entries SET state='expired',updated_at=? WHERE staging_id=?");
    for (const row of rows) {
      update.run(timestamp, row.staging_id);
      this.event(row.run_id, "staging.expired", { stagingId: row.staging_id });
    }
    return rows.length;
  }

  async cleanupStagingEntries(selector: StagingCleanupSelector = { expired: true }): Promise<{ matched: number; removed: number; pending: number }> {
    await this.ensureStagingDirectories();
    const now = selector.now ?? new Date();
    const timestamp = now.toISOString();
    this.expireStagingEntries(now);
    let sql = "SELECT * FROM staging_entries";
    const parameters: unknown[] = [];
    if (selector.stagingId) {
      sql += selector.runId ? " WHERE staging_id=? AND run_id=?" : " WHERE staging_id=?";
      parameters.push(selector.stagingId);
      if (selector.runId) parameters.push(selector.runId);
    } else if (selector.runId) {
      sql += " WHERE run_id=?";
      parameters.push(selector.runId);
    } else if (!selector.all) {
      sql += " WHERE state='expired' OR (state='cleanup_pending' AND expires_at<=?)";
      parameters.push(timestamp);
    }
    sql += " ORDER BY created_at,staging_id";
    if (selector.limit !== undefined) {
      if (!Number.isInteger(selector.limit) || selector.limit <= 0) throw new ValidationError("staging cleanup limit must be a positive integer");
      sql += " LIMIT ?";
      parameters.push(selector.limit);
    }
    const rows = this.db.prepare(sql).all(...parameters) as StagingEntryRow[];
    let removed = 0;
    let pending = 0;
    for (const row of rows) {
      try {
        await this.ensureStagingDirectories(row.run_id);
        if (row.file_dev && row.file_ino) {
          await removeManagedFile(
            this.paths.staging,
            this.stagingPath(row),
            { dev: row.file_dev, ino: row.file_ino },
          );
        }
        this.db.prepare("DELETE FROM staging_entries WHERE staging_id=?").run(row.staging_id);
        this.event(row.run_id, "staging.deleted", { stagingId: row.staging_id, state: row.state, digest: row.content_sha256 });
        removed += 1;
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
        const retentionHours = selector.retentionHours ?? STAGING_DEFAULT_RETENTION_HOURS;
        if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
        const retryAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
        this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',updated_at=?,expires_at=?,cleanup_attempted_at=?,cleanup_error=?
          WHERE staging_id=?`).run(timestamp, retryAt, timestamp, message, row.staging_id);
        this.event(row.run_id, "staging.cleanup_pending", { stagingId: row.staging_id, digest: row.content_sha256 });
        pending += 1;
      }
    }
    return { matched: rows.length, removed, pending };
  }
}
