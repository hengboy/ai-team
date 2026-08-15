import { readFileSync } from "node:fs";

const readPackageVersion = (): string => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ai-team installation is corrupt: cannot read package.json (${reason})`);
  }
  const version = (manifest as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("ai-team installation is corrupt: package.json version must be a non-empty string");
  }
  return version;
};

export const PACKAGE_VERSION = readPackageVersion();
export const SCHEMA_VERSION = 1;
export const PROJECT_CONTEXT_SCHEMA_VERSION = 2;
export const PROJECT_CONTEXT_RENDERER_VERSION = "context-renderer-v2";

export const EXIT = {
  ok: 0,
  failure: 1,
  decision: 2,
  unknown: 3,
  incompatible: 4,
  args: 5,
  git: 6,
  security: 7,
  internal: 8,
  // Compatibility aliases used by existing service errors.
  validation: 2,
  state: 3,
  conflict: 4,
  environment: 5,
} as const;

export const PLAN_STATES = [
  "draft",
  "requirements_confirmed",
  "spec_ready",
  "plan_ready",
  "tasks_preview",
  "ready",
  "implemented",
  "superseded",
  "abandoned",
] as const;

export const RESULT_STATUSES = [
  "completed",
  "retryable_failure",
  "needs_decision",
  "failed",
] as const;

export const ROLES = [
  "planning",
  "coding",
  "file-explorer",
  "frontend-developer",
  "backend-developer",
  "test",
  "git-operator",
  "code-reviewer",
  "review-spec",
  "review-standards",
  "environment-operator",
  "researcher",
] as const;

export type Role = (typeof ROLES)[number];
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const STAGING_KINDS = [
  "project-context",
  "planning-documents",
  "planning-tasks",
  "dispatch-packet",
  "dispatch-result",
  "decision",
  "git-reconcile-evidence",
  "research-conclusions",
  "review-result",
  "review-resolution",
] as const;

export const STAGING_STATES = ["draft", "ready", "consumed", "cleanup_pending", "expired"] as const;
export const STAGING_MAX_BYTES = 2 * 1024 * 1024;
export const STAGING_DEFAULT_RETENTION_HOURS = 168;
export const STAGING_OPPORTUNISTIC_CLEANUP_LIMIT = 100;

export type StagingKind = (typeof STAGING_KINDS)[number];
export type StagingState = (typeof STAGING_STATES)[number];
