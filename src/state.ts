import Database from "better-sqlite3";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Umzug } from "umzug";
import lockfile from "proper-lockfile";
import { getHomePaths, type HomePaths } from "./home.js";
import { ValidationError } from "./errors.js";
import { makeId, sha256, stableJson } from "./utils.js";

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
];

export class StateStore {
  readonly paths: HomePaths;
  readonly db: Database.Database;

  private constructor(paths: HomePaths, db: Database.Database, private readonly releaseLock: () => void) {
    this.paths = paths;
    this.db = db;
  }

  static async open(home?: string): Promise<StateStore> {
    const paths = getHomePaths(home);
    await Promise.all([paths.state, paths.backups, paths.artifacts, paths.environments, paths.schemas, paths.templates].map((path) => mkdir(path, { recursive: true })));
    const releaseLock = lockfile.lockSync(paths.state, { realpath: false, stale: 30_000 });
    let existing = false;
    try { existing = (await stat(paths.database)).size > 0; } catch { /* new database */ }
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

  createRun(input: { repoId: string; profile: string; mode: string; planId?: string; revision?: string; baseCommit?: string; targetBranch?: string; request?: string }): string {
    const runId = makeId("run");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO runs(run_id, repo_id, profile, mode, state, stage, plan_id, revision, base_commit, target_branch, request, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'file-explorer', ?, ?, ?, ?, ?, ?, ?)`).run(runId, input.repoId, input.profile, input.mode, input.planId ?? null, input.revision ?? null, input.baseCommit ?? null, input.targetBranch ?? null, input.request ?? null, now, now);
    this.event(runId, "run.created", input);
    return runId;
  }

  getRun(runId: string): Record<string, unknown> {
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
    if (!run) throw new ValidationError(`unknown run: ${runId}`);
    return run;
  }

  event(runId: string, type: string, payload: unknown): void {
    this.db.prepare("INSERT INTO run_events(run_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(runId, type, stableJson(payload), new Date().toISOString());
  }

  beginOperation(kind: string, key: string, request: unknown, runId?: string): { operationId: string; reused: boolean; state: string } {
    const existing = this.db.prepare("SELECT operation_id,state FROM operations WHERE idempotency_key=?").get(key) as { operation_id: string; state: string } | undefined;
    if (existing) return { operationId: existing.operation_id, reused: true, state: existing.state };
    const operationId = `op_${sha256(key).slice(0, 26)}`;
    this.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,created_at) VALUES (?,?,?,?, 'pending', ?,?)")
      .run(operationId, runId ?? null, key, kind, stableJson(request), new Date().toISOString());
    return { operationId, reused: false, state: "pending" };
  }

  finishOperation(operationId: string, evidence: unknown): void {
    this.db.prepare("UPDATE operations SET state='completed',evidence_json=?,completed_at=? WHERE operation_id=?").run(stableJson(evidence), new Date().toISOString(), operationId);
  }

  reconcileOperation(operationId: string, state: "completed" | "not_applied" | "unknown", evidence: unknown): void {
    if (state === "unknown") throw new ValidationError("unknown side effect cannot be marked reconciled without external evidence");
    this.db.prepare("UPDATE operations SET state=?,evidence_json=?,completed_at=? WHERE operation_id=? AND state='pending'")
      .run(state === "completed" ? "completed" : "failed", stableJson({ reconciliation: state, evidence }), new Date().toISOString(), operationId);
  }

  createDecision(runId: string, question: string, choices: Array<{ id: string; label: string; impact: string }>, recommendation?: string): string {
    const existing = this.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId);
    if (existing) throw new ValidationError(`run already has a pending decision: ${(existing as any).decision_id}`);
    const decisionId = `decision_${makeId("dispatch").slice(9)}`;
    this.db.prepare("INSERT INTO decisions(decision_id,run_id,question,choices_json,recommendation,status,created_at) VALUES (?,?,?,?,?,'pending',?)")
      .run(decisionId, runId, question, stableJson(choices), recommendation ?? null, new Date().toISOString());
    return decisionId;
  }

  decide(runId: string, decisionId: string, choice: string, note?: string): void {
    const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id=? AND run_id=?").get(decisionId, runId) as any;
    if (!row || row.status !== "pending") throw new ValidationError("decision is unknown, stale, or already resolved");
    const choices = JSON.parse(row.choices_json) as Array<{ id: string }>;
    if (!choices.some((item) => item.id === choice)) throw new ValidationError(`unknown decision choice: ${choice}`);
    this.db.prepare("UPDATE decisions SET status='resolved',choice=?,note=?,resolved_at=? WHERE decision_id=?").run(choice, note ?? null, new Date().toISOString(), decisionId);
    this.event(runId, "decision.resolved", { decisionId, choice });
  }
}
