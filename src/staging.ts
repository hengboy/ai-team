import type Database from "better-sqlite3";
import { readdir } from "node:fs/promises";
import type { HomePaths } from "./home.js";
import { IncompatibleError, ValidationError, validationCause } from "./errors.js";
import { makeId, redact } from "./utils.js";
import {
  STAGING_DEFAULT_RETENTION_HOURS,
  STAGING_KINDS,
  STAGING_OPPORTUNISTIC_CLEANUP_LIMIT,
  ROLES,
  type Role,
  type StagingKind,
  type StagingState,
} from "./constants.js";
import { ROLE_MANIFEST } from "./roles.js";
import {
  ensureManagedDirectory,
  readManagedJsonFile,
  removeManagedFile,
  stagingFilePath,
  stagingRunDirectory,
  writeManagedJsonFile,
  type ManagedFileIdentity,
} from "./security.js";

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

export interface StagingEntryRow {
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

export interface StagingContext {
  db: Database.Database;
  paths: HomePaths;
  event(runId: string, type: string, payload: unknown): void;
  getRun(runId: string): Record<string, unknown>;
}

export const assertCanonicalStagingFiles = async (paths: HomePaths, db: Database.Database): Promise<void> => {
  const invalidSequence = db.prepare("SELECT staging_id,run_id,sequence_no FROM staging_entries WHERE sequence_no IS NULL OR sequence_no < 1 LIMIT 1")
    .get() as { staging_id: string; run_id: string; sequence_no: number | null } | undefined;
  if (invalidSequence) {
    throw new IncompatibleError("staging metadata is incompatible with canonical filenames", {
      reason_code: "legacy_staging_metadata",
      next_action: "reset",
      staging_id: invalidSequence.staging_id,
      run_id: invalidSequence.run_id,
    });
  }
  const runIds = db.prepare("SELECT DISTINCT run_id FROM staging_entries").all() as Array<{ run_id: string }>;
  for (const { run_id: runId } of runIds) {
    let entries: string[];
    try { entries = await readdir(stagingRunDirectory(paths.staging, runId)); }
    catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const legacyFile = entries.find((entry) => /^staging_[A-Za-z0-9]+\.json$/.test(entry));
    if (legacyFile) {
      throw new IncompatibleError("legacy staging filenames are not supported", {
        reason_code: "legacy_staging_filename",
        next_action: "reset",
        run_id: runId,
        file: legacyFile,
      });
    }
  }
};

export class StagingStore {
  constructor(private readonly context: StagingContext) {}
  private get db(): Database.Database { return this.context.db; }
  private get paths(): HomePaths { return this.context.paths; }
  private event(runId: string, type: string, payload: unknown): void { this.context.event(runId, type, payload); }

  private row(stagingId: string): StagingEntryRow {
    const row = this.db.prepare("SELECT * FROM staging_entries WHERE staging_id=?").get(stagingId) as StagingEntryRow | undefined;
    if (!row) throw new ValidationError(`unknown staging entry: ${stagingId}`);
    return row;
  }

  private metadata(row: StagingEntryRow): StagingEntry {
    return {
      stagingId: row.staging_id, runId: row.run_id, dispatchId: row.dispatch_id, role: row.role, kind: row.kind, state: row.state,
      contentDigest: row.content_sha256, contentBytes: row.content_bytes, createdAt: row.created_at, updatedAt: row.updated_at,
      expiresAt: row.expires_at, consumedAt: row.consumed_at, cleanupAttemptedAt: row.cleanup_attempted_at, cleanupError: row.cleanup_error,
    };
  }

  private identity(row: StagingEntryRow): ManagedFileIdentity {
    if (!row.file_dev || !row.file_ino) throw new ValidationError(`staging entry has no content identity: ${row.staging_id}`);
    return { dev: row.file_dev, ino: row.file_ino };
  }

  private path(row: Pick<StagingEntryRow, "run_id" | "sequence_no" | "kind" | "role">): string {
    return stagingFilePath(this.paths.staging, row.run_id, row.sequence_no, row.kind, row.role);
  }

  private async ensureDirectories(runId?: string): Promise<void> {
    await ensureManagedDirectory(this.paths.root, this.paths.staging);
    if (runId) await ensureManagedDirectory(this.paths.staging, stagingRunDirectory(this.paths.staging, runId));
  }

  private assertBinding(row: StagingEntryRow, binding: StagingBinding): void {
    if (binding.runId !== undefined && row.run_id !== binding.runId) throw new ValidationError("staging run binding does not match");
    if (binding.dispatchId !== undefined && row.dispatch_id !== binding.dispatchId) throw new ValidationError("staging dispatch binding does not match");
    if (binding.role !== undefined && row.role !== binding.role) throw new ValidationError("staging role binding does not match");
    if (binding.kind !== undefined && row.kind !== binding.kind) throw new ValidationError("staging kind binding does not match");
  }

  private activeRow(stagingId: string, binding: StagingBinding = {}, now = new Date()): StagingEntryRow {
    this.expire(now);
    const row = this.row(stagingId);
    this.assertBinding(row, binding);
    if (row.state === "expired") throw new ValidationError(`staging entry has expired: ${stagingId}`);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry is not readable: ${row.state}`);
    return row;
  }

  get(stagingId: string): StagingEntry { return this.metadata(this.row(stagingId)); }

  list(runId: string, role: Role): StagingEntry[] {
    this.context.getRun(runId);
    return (this.db.prepare("SELECT * FROM staging_entries WHERE run_id=? AND role=? ORDER BY created_at,staging_id").all(runId, role) as StagingEntryRow[])
      .map((row) => this.metadata(row));
  }

  recordValidationFailure(stagingId: string, binding: StagingBinding, error: unknown): void {
    const row = this.row(stagingId);
    this.assertBinding(row, binding);
    this.event(row.run_id, "staging.validation_failed", {
      stagingId, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000), cause: validationCause(error),
    });
  }

  cancel(stagingId: string, binding: StagingBinding, reason: string): StagingEntry {
    if (!reason.trim()) throw new ValidationError("staging cancellation requires a reason");
    const row = this.row(stagingId);
    this.assertBinding(row, binding);
    if (row.state === "canceled") return this.metadata(row);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry cannot be canceled from ${row.state}`);
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE staging_entries SET state='canceled',consumed_at=?,updated_at=? WHERE staging_id=?").run(timestamp, timestamp, stagingId);
    this.event(row.run_id, "staging.canceled", { stagingId, dispatchId: row.dispatch_id, role: row.role, kind: row.kind, reason });
    return this.get(stagingId);
  }

  async create(input: { runId: string; dispatchId?: string; role: Role; kind: StagingKind; initialJson?: string | Buffer; retentionHours?: number; now?: Date }): Promise<StagingEntry> {
    if (!(ROLES as readonly string[]).includes(input.role)) throw new ValidationError(`unknown staging role: ${input.role}`);
    if (!(STAGING_KINDS as readonly string[]).includes(input.kind)) throw new ValidationError(`unknown staging kind: ${input.kind}`);
    if (!ROLE_MANIFEST[input.role].staging.owned_entries.includes(input.kind)) throw new ValidationError(`${input.role} does not own staging kind ${input.kind}`);
    this.context.getRun(input.runId);
    if (input.dispatchId) {
      const dispatch = this.db.prepare("SELECT run_id,role FROM dispatches WHERE dispatch_id=?").get(input.dispatchId) as { run_id: string; role: string } | undefined;
      if (!dispatch || dispatch.run_id !== input.runId || dispatch.role !== input.role) throw new ValidationError("staging dispatch binding does not match run and role");
    }
    const retentionHours = input.retentionHours ?? STAGING_DEFAULT_RETENTION_HOURS;
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const now = input.now ?? new Date();
    await this.ensureDirectories();
    await this.cleanup({ expired: true, limit: STAGING_OPPORTUNISTIC_CLEANUP_LIMIT, now });
    const stagingId = makeId("staging");
    const sequence = this.db.prepare(`UPDATE runs SET next_staging_sequence=next_staging_sequence+1 WHERE run_id=?
      RETURNING next_staging_sequence-1 AS sequence_no`).get(input.runId) as { sequence_no: number } | undefined;
    if (!sequence) throw new ValidationError(`unknown run: ${input.runId}`);
    const runDirectory = stagingRunDirectory(this.paths.staging, input.runId);
    await ensureManagedDirectory(this.paths.staging, runDirectory);
    const path = stagingFilePath(this.paths.staging, input.runId, sequence.sequence_no, input.kind, input.role);
  const defaultJson = input.kind === "planning-documents" ? JSON.stringify({
    spec: "",
    plan: "",
    planMetadata: {
      extensions: {
        acceptance_contract: {
          acceptance_criteria: ["AC-001"],
          acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "<自动化验收命令>", expected_result: "<可观察的通过结果>" }],
          task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
          test_commands: ["<完整方案测试命令>"],
        },
      },
    },
  }) : "null";
    const content = await writeManagedJsonFile(this.paths.staging, path, input.initialJson ?? defaultJson);
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
    try {
      this.db.prepare(`INSERT INTO staging_entries(staging_id,run_id,sequence_no,dispatch_id,role,kind,state,content_sha256,content_bytes,file_dev,file_ino,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?)`).run(stagingId, input.runId, sequence.sequence_no, input.dispatchId ?? null, input.role, input.kind,
        content.digest, content.bytes, content.identity.dev, content.identity.ino, timestamp, timestamp, expiresAt);
      this.event(input.runId, "staging.created", { stagingId, sequenceNo: sequence.sequence_no, dispatchId: input.dispatchId ?? null, role: input.role, kind: input.kind });
    } catch (error) {
      await removeManagedFile(this.paths.staging, path, content.identity).catch(() => {});
      throw error;
    }
    return this.get(stagingId);
  }

  async write(stagingId: string, content: string | Buffer, binding: StagingBinding = {}, beforeReplace?: () => Promise<void> | void, retentionHours = STAGING_DEFAULT_RETENTION_HOURS): Promise<StagingEntry> {
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const persisted = this.row(stagingId);
    await this.ensureDirectories(persisted.run_id);
    const row = this.activeRow(stagingId, binding);
    const written = await writeManagedJsonFile(this.paths.staging, this.path(row), content, this.identity(row), ...(beforeReplace ? [{ beforeReplace }] : []));
    const now = new Date();
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
    this.db.prepare(`UPDATE staging_entries SET state='ready',content_sha256=?,content_bytes=?,file_dev=?,file_ino=?,updated_at=?,expires_at=?,cleanup_error=NULL
      WHERE staging_id=? AND state IN ('draft','ready')`).run(written.digest, written.bytes, written.identity.dev, written.identity.ino, timestamp, expiresAt, stagingId);
    this.event(row.run_id, "staging.written", { stagingId, digest: written.digest, bytes: written.bytes });
    return this.get(stagingId);
  }

  async read(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    const persisted = this.row(stagingId);
    await this.ensureDirectories(persisted.run_id);
    const row = this.activeRow(stagingId, binding);
    const content = await readManagedJsonFile(this.paths.staging, this.path(row), this.identity(row));
    if (content.digest !== row.content_sha256 || content.bytes !== row.content_bytes) throw new ValidationError("staging content does not match persisted metadata");
    return { entry: this.metadata(row), value: content.value };
  }

  async inspect(stagingId: string, binding: StagingBinding = {}): Promise<{ entry: StagingEntry; value: unknown }> {
    const row = this.row(stagingId);
    this.assertBinding(row, binding);
    if (row.state === "expired" || row.expires_at <= new Date().toISOString()) throw new ValidationError(`staging entry has expired: ${stagingId}`);
    if (row.state !== "draft" && row.state !== "ready") throw new ValidationError(`staging entry is not readable: ${row.state}`);
    const content = await readManagedJsonFile(this.paths.staging, this.path(row), this.identity(row));
    if (content.digest !== row.content_sha256 || content.bytes !== row.content_bytes) throw new ValidationError("staging content does not match persisted metadata");
    return { entry: this.metadata(row), value: content.value };
  }

  async consume(stagingId: string, binding: StagingBinding = {}, now = new Date(), retentionHours = STAGING_DEFAULT_RETENTION_HOURS): Promise<StagingEntry> {
    if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
    const persisted = this.row(stagingId);
    await this.ensureDirectories(persisted.run_id);
    const row = this.activeRow(stagingId, binding, now);
    const timestamp = now.toISOString();
    this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',consumed_at=?,updated_at=?,cleanup_attempted_at=?,cleanup_error=NULL WHERE staging_id=?`).run(timestamp, timestamp, timestamp, stagingId);
    try {
      await removeManagedFile(this.paths.staging, this.path(row), this.identity(row));
      this.db.prepare(`UPDATE staging_entries SET state='consumed',consumed_at=?,updated_at=?,cleanup_attempted_at=?,cleanup_error=NULL WHERE staging_id=?`).run(timestamp, timestamp, timestamp, stagingId);
      this.event(row.run_id, "staging.consumed", { stagingId, digest: row.content_sha256, bytes: row.content_bytes });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const retryAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
      this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',updated_at=?,expires_at=?,cleanup_attempted_at=?,cleanup_error=? WHERE staging_id=?`).run(timestamp, retryAt, timestamp, message, stagingId);
      this.event(row.run_id, "staging.cleanup_pending", { stagingId, digest: row.content_sha256 });
    }
    return this.get(stagingId);
  }

  expire(now = new Date()): number {
    const timestamp = now.toISOString();
    const rows = this.db.prepare(`SELECT staging_id,run_id FROM staging_entries WHERE state IN ('draft','ready') AND expires_at<=?`).all(timestamp) as Array<{ staging_id: string; run_id: string }>;
    const update = this.db.prepare("UPDATE staging_entries SET state='expired',updated_at=? WHERE staging_id=?");
    for (const row of rows) {
      update.run(timestamp, row.staging_id);
      this.event(row.run_id, "staging.expired", { stagingId: row.staging_id });
    }
    return rows.length;
  }

  async cleanup(selector: StagingCleanupSelector = { expired: true }): Promise<{ matched: number; removed: number; pending: number }> {
    await this.ensureDirectories();
    const now = selector.now ?? new Date();
    const timestamp = now.toISOString();
    this.expire(now);
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
        await this.ensureDirectories(row.run_id);
        if (row.file_dev && row.file_ino) await removeManagedFile(this.paths.staging, this.path(row), { dev: row.file_dev, ino: row.file_ino });
        this.db.prepare("DELETE FROM staging_entries WHERE staging_id=?").run(row.staging_id);
        this.event(row.run_id, "staging.deleted", { stagingId: row.staging_id, state: row.state, digest: row.content_sha256 });
        removed += 1;
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
        const retentionHours = selector.retentionHours ?? STAGING_DEFAULT_RETENTION_HOURS;
        if (!Number.isInteger(retentionHours) || retentionHours <= 0) throw new ValidationError("staging retention hours must be a positive integer");
        const retryAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000).toISOString();
        this.db.prepare(`UPDATE staging_entries SET state='cleanup_pending',updated_at=?,expires_at=?,cleanup_attempted_at=?,cleanup_error=? WHERE staging_id=?`).run(timestamp, retryAt, timestamp, message, row.staging_id);
        this.event(row.run_id, "staging.cleanup_pending", { stagingId: row.staging_id, digest: row.content_sha256 });
        pending += 1;
      }
    }
    return { matched: rows.length, removed, pending };
  }
}
