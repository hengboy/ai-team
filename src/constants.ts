export const PACKAGE_VERSION = "1.0.0";
export const SCHEMA_VERSION = 1;

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
