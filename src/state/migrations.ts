import type Database from "better-sqlite3";
import { IncompatibleError } from "../errors.js";

/** Increment when persisted state contracts change incompatibly. */
export const STATE_SCHEMA_EPOCH = 2;

const requiredColumns: Record<string, string[]> = {
  repositories: ["repo_id", "common_dir", "project_path", "created_at"],
  runs: ["run_id", "repo_id", "stage", "client_platform", "environment", "next_staging_sequence", "plan_verification_json"],
  run_events: ["event_id", "run_id", "command_id", "correlation_id", "dispatch_id", "operation_id"],
  decisions: ["decision_id", "run_id", "decision_type", "receipt_json", "dispatch_id"],
  revisions: ["plan_id", "revision", "repo_id", "digest", "plan_commit"],
  dispatches: ["dispatch_id", "run_id", "packet_digest", "renderer_version", "replacement_for"],
  artifacts: ["artifact_id", "run_id"],
  worktrees: ["worktree_id", "run_id", "adopted_from_run_id"],
  operations: ["operation_id", "idempotency_key"],
  review_barriers: ["barrier_id", "run_id", "axes_json", "aggregate_json"],
  review_results: ["barrier_id", "axis"],
  finding_resolutions: ["barrier_id", "finding_id"],
  staging_entries: ["staging_id", "run_id", "sequence_no", "replaced_by_operation_id"],
  dispatch_worktree_bindings: ["dispatch_id", "run_id", "binding_kind", "worktree_id"],
  run_tasks: ["run_id", "task_id", "write_paths_json", "verification_json"],
  test_repair_lineage: ["source_test_dispatch_id", "run_id"],
  planning_clarifications: ["clarification_id", "run_id", "decision_id"],
  state_meta: ["key", "value"],
};

const incompatibleState = (reasonCode: string, details: Record<string, unknown> = {}): IncompatibleError =>
  new IncompatibleError("state database is incompatible with the current schema", {
    reason_code: reasonCode,
    next_action: "reset",
    ...details,
  });

export const isEmptyStateDatabase = (db: Database.Database): boolean =>
  (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count === 0;

export const createCurrentSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE repositories (repo_id TEXT PRIMARY KEY, common_dir TEXT UNIQUE NOT NULL, project_path TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(repo_id), profile TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, plan_id TEXT, revision TEXT, base_commit TEXT, target_branch TEXT, request TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'started', scope_digest TEXT, client_platform TEXT, environment TEXT, contract_digest TEXT, role_manifest_digest TEXT, template_digest TEXT, implementation_base_commit TEXT, plan_digest TEXT, source_run_id TEXT REFERENCES runs(run_id), next_staging_sequence INTEGER NOT NULL DEFAULT 1, plan_verification_json TEXT);
    CREATE TABLE run_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, command_id TEXT, correlation_id TEXT, dispatch_id TEXT, operation_id TEXT);
    CREATE TABLE decisions (decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, question TEXT NOT NULL, choices_json TEXT NOT NULL, recommendation TEXT, status TEXT NOT NULL, choice TEXT, note TEXT, created_at TEXT NOT NULL, resolved_at TEXT, decision_type TEXT NOT NULL DEFAULT 'workflow', receipt_json TEXT, dispatch_id TEXT REFERENCES dispatches(dispatch_id));
    CREATE TABLE revisions (plan_id TEXT NOT NULL, revision TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES repositories(repo_id), state TEXT NOT NULL, target_branch TEXT NOT NULL, digest TEXT, plan_commit TEXT, supersedes TEXT, created_at TEXT NOT NULL, PRIMARY KEY(repo_id, plan_id, revision));
    CREATE TABLE dispatches (dispatch_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, role TEXT NOT NULL, state TEXT NOT NULL, packet_json TEXT NOT NULL, prompt TEXT NOT NULL, schema_json TEXT NOT NULL, template_json TEXT NOT NULL, result_json TEXT, claimed_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, packet_digest TEXT, prompt_digest TEXT, schema_digest TEXT, template_digest TEXT, renderer_version TEXT, replacement_for TEXT REFERENCES dispatches(dispatch_id), UNIQUE(run_id, dispatch_id));
    CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, dispatch_id TEXT REFERENCES dispatches(dispatch_id), kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, redacted INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE worktrees (worktree_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, branch TEXT NOT NULL, path TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, adopted_from_run_id TEXT);
    CREATE TABLE operations (operation_id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE, idempotency_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, request_json TEXT NOT NULL, evidence_json TEXT, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE review_barriers (barrier_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, revision_sha TEXT NOT NULL, formal INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, base_commit TEXT, head_commit TEXT, plan_id TEXT, revision TEXT, document_digest TEXT, diff_digest TEXT, test_evidence_digest TEXT, repair_commit TEXT, verification_evidence TEXT, revision_digest TEXT, evidence_digest TEXT, axes_json TEXT, spec_dispatch_id TEXT REFERENCES dispatches(dispatch_id), standards_dispatch_id TEXT REFERENCES dispatches(dispatch_id), spec_result_digest TEXT, standards_result_digest TEXT, aggregate_json TEXT, UNIQUE(run_id, revision_sha));
    CREATE TABLE review_results (barrier_id TEXT NOT NULL REFERENCES review_barriers(barrier_id) ON DELETE CASCADE, axis TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(barrier_id, axis));
    CREATE TABLE finding_resolutions (barrier_id TEXT NOT NULL REFERENCES review_barriers(barrier_id) ON DELETE CASCADE, finding_id TEXT NOT NULL, change_evidence TEXT NOT NULL, verification_evidence TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(barrier_id, finding_id));
    CREATE TABLE staging_entries (staging_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, dispatch_id TEXT REFERENCES dispatches(dispatch_id) ON DELETE CASCADE, role TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project-context','planning-documents','planning-tasks','dispatch-packet','dispatch-result','decision','git-reconcile-evidence','research-conclusions','review-result','review-resolution')), state TEXT NOT NULL CHECK(state IN ('draft','ready','consumed','canceled','cleanup_pending','expired')), content_sha256 TEXT, content_bytes INTEGER, file_dev TEXT, file_ino TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, cleanup_attempted_at TEXT, cleanup_error TEXT, sequence_no INTEGER, replaced_by_operation_id TEXT REFERENCES operations(operation_id));
    CREATE TABLE dispatch_worktree_bindings (dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, binding_kind TEXT NOT NULL CHECK(binding_kind IN ('integration','task')), worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id), created_at TEXT NOT NULL, PRIMARY KEY(dispatch_id,binding_kind,worktree_id));
    CREATE TABLE run_tasks (run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, source_path TEXT NOT NULL, source_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','prepared','implemented','tested','committed','integrated')), worktree_id TEXT REFERENCES worktrees(worktree_id), developer_dispatch_id TEXT REFERENCES dispatches(dispatch_id), test_dispatch_id TEXT REFERENCES dispatches(dispatch_id), implementation_commit TEXT, integration_commit TEXT, updated_at TEXT NOT NULL, write_paths_json TEXT, verification_json TEXT, PRIMARY KEY(run_id,task_id), UNIQUE(run_id,ordinal));
    CREATE TABLE test_repair_lineage (source_test_dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, test_scope TEXT NOT NULL CHECK(test_scope IN ('task','final','review_repair')), attempt INTEGER NOT NULL, task_id TEXT, barrier_id TEXT, original_developer_dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id), developer_role TEXT NOT NULL CHECK(developer_role IN ('frontend-developer','backend-developer')), worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id), coding_dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id), repair_developer_dispatch_id TEXT REFERENCES dispatches(dispatch_id), repair_commit_dispatch_id TEXT REFERENCES dispatches(dispatch_id), retest_dispatch_id TEXT REFERENCES dispatches(dispatch_id), created_at TEXT NOT NULL);
    CREATE TABLE planning_clarifications (clarification_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id) ON DELETE CASCADE, source TEXT NOT NULL, impact_json TEXT NOT NULL, requirement_ids_json TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','resolved')), answer TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE UNIQUE INDEX one_pending_decision ON decisions(run_id) WHERE status = 'pending';
    CREATE INDEX dispatches_run_state ON dispatches(run_id,state);
    CREATE INDEX operations_run_state ON operations(run_id,state);
    CREATE INDEX decisions_dispatch ON decisions(run_id,dispatch_id,status);
    CREATE INDEX dispatches_replacement ON dispatches(run_id,replacement_for);
    CREATE UNIQUE INDEX active_worktree_path ON worktrees(path) WHERE state='active';
    CREATE UNIQUE INDEX active_worktree_branch ON worktrees(branch) WHERE state='active';
    CREATE INDEX review_barriers_run_revision ON review_barriers(run_id,revision_sha);
    CREATE INDEX review_barriers_leaf_dispatches ON review_barriers(spec_dispatch_id,standards_dispatch_id);
    CREATE UNIQUE INDEX one_planning_handoff_per_source ON runs(source_run_id) WHERE source_run_id IS NOT NULL;
    CREATE UNIQUE INDEX staging_entries_run_sequence ON staging_entries(run_id, sequence_no);
    CREATE INDEX staging_entries_expiry ON staging_entries(state, expires_at);
    CREATE INDEX staging_entries_run ON staging_entries(run_id, created_at);
    CREATE UNIQUE INDEX one_integration_binding_per_dispatch ON dispatch_worktree_bindings(dispatch_id) WHERE binding_kind='integration';
    CREATE INDEX dispatch_worktree_bindings_run ON dispatch_worktree_bindings(run_id,dispatch_id);
    CREATE INDEX run_tasks_state ON run_tasks(run_id,state,ordinal);
    CREATE INDEX run_events_command ON run_events(run_id,command_id,event_id);
    CREATE INDEX run_events_correlation ON run_events(run_id,correlation_id,event_id);
    CREATE INDEX run_events_dispatch ON run_events(run_id,dispatch_id,event_id);
    CREATE INDEX run_events_operation ON run_events(run_id,operation_id,event_id);
    CREATE UNIQUE INDEX one_command_started ON run_events(run_id,command_id) WHERE command_id IS NOT NULL AND type='command.started';
    CREATE UNIQUE INDEX one_command_terminal ON run_events(run_id,command_id) WHERE command_id IS NOT NULL AND type IN ('command.completed','command.failed','command.interrupted');
    CREATE INDEX test_repair_lineage_scope ON test_repair_lineage(run_id,test_scope,task_id,barrier_id,attempt);
    CREATE UNIQUE INDEX test_repair_lineage_coding ON test_repair_lineage(coding_dispatch_id);
    CREATE UNIQUE INDEX test_repair_lineage_retest ON test_repair_lineage(retest_dispatch_id) WHERE retest_dispatch_id IS NOT NULL;
    CREATE INDEX staging_entries_replaced_operation ON staging_entries(replaced_by_operation_id) WHERE replaced_by_operation_id IS NOT NULL;
    CREATE UNIQUE INDEX one_pending_planning_clarification ON planning_clarifications(run_id) WHERE status='pending';
    CREATE INDEX planning_clarifications_run_status ON planning_clarifications(run_id,status,created_at);
  `);
  db.prepare("INSERT INTO state_meta(key,value) VALUES ('schema_epoch', ?)").run(String(STATE_SCHEMA_EPOCH));
};

export const assertCurrentSchema = (db: Database.Database): void => {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name));
  if (tables.has("schema_migrations")) throw incompatibleState("legacy_state_migrations_table");
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!tables.has(table)) throw incompatibleState("state_schema_missing_table", { table });
    const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) throw incompatibleState("state_schema_missing_columns", { table, missing_columns: missing });
  }
  const epoch = db.prepare("SELECT value FROM state_meta WHERE key='schema_epoch'").get() as { value: string } | undefined;
  if (epoch?.value !== String(STATE_SCHEMA_EPOCH)) {
    throw incompatibleState("state_schema_epoch_mismatch", { actual_epoch: epoch?.value ?? null, expected_epoch: STATE_SCHEMA_EPOCH });
  }
};
