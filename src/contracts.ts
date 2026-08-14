import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import { RESULT_STATUSES, ROLES, SCHEMA_VERSION, type ResultStatus, type Role } from "./constants.js";
import { sha256, stableJson } from "./utils.js";

export interface ResultEnvelope {
  schema_version: number;
  run_id: string;
  dispatch_id: string;
  role: Role;
  status: ResultStatus;
  summary: string;
  findings: unknown[];
  changes: unknown[];
  verification: unknown[];
  risks: unknown[];
  decisions_needed: unknown[];
  requested_support: unknown[];
  handoff: unknown | null;
  payload: Record<string, unknown>;
  failure_class?: string;
  side_effect_state?: "none" | "completed" | "unknown";
}

export const resultEnvelopeSchema = {
  $id: "https://ai-team.local/schemas/result-envelope-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "run_id", "dispatch_id", "role", "status", "summary", "findings", "changes", "verification", "risks", "decisions_needed", "requested_support", "handoff", "payload"],
  properties: {
    schema_version: { type: "integer", const: SCHEMA_VERSION },
    run_id: { type: "string", pattern: "^run_[0-9A-HJKMNP-TV-Z]{26}$" },
    dispatch_id: { type: "string", pattern: "^dispatch_[0-9A-HJKMNP-TV-Z]{26}$" },
    role: { type: "string", enum: [...ROLES] },
    status: { type: "string", enum: [...RESULT_STATUSES] },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    findings: { type: "array", items: {} },
    changes: { type: "array", items: {} },
    verification: { type: "array", items: {} },
    risks: { type: "array", items: {} },
    decisions_needed: { type: "array", items: {} },
    requested_support: { type: "array", items: {} },
    handoff: { type: ["object", "string", "null"] },
    payload: { type: "object", required: [], additionalProperties: true },
    failure_class: { type: "string" },
    side_effect_state: { type: "string", enum: ["none", "completed", "unknown"] },
  },
  allOf: [
    {
      if: { properties: { status: { const: "retryable_failure" } } },
      then: { required: ["failure_class", "side_effect_state"] },
    },
    {
      if: { properties: { status: { const: "failed" } } },
      then: { required: ["failure_class", "side_effect_state"] },
    },
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateResult = ajv.compile<ResultEnvelope>(resultEnvelopeSchema);

const stringArray = { type: "array", items: { type: "string" } } as const;
const evidenceArray = { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["command", "outcome"], properties: { command: { type: "string" }, outcome: { type: "string" } } } } as const;
const decisionSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["question", "choices", "recommendation"],
  properties: {
    question: { type: "string", minLength: 1 },
    choices: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "impact"],
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          impact: { type: "string", minLength: 1 },
        },
      },
    },
    recommendation: { type: "string", minLength: 1 },
  },
} as const;
export const ROLE_PAYLOAD_SCHEMAS: Record<Role, object> = {
  planning: { type: "object", additionalProperties: false, required: ["actions", "stage", "pending_questions", "decision"], properties: { actions: stringArray, stage: { enum: ["requirements", "requirements_confirmed", "spec_ready", "plan_ready", "tasks_preview", "ready"] }, pending_questions: { type: "array", maxItems: 1, items: { type: "string", minLength: 1 } }, decision: decisionSchema } },
  coding: { type: "object", additionalProperties: false, required: ["actions"], properties: { actions: stringArray, triage: { enum: ["planned", "bug", "feature", "planning"] } } },
  "file-explorer": { type: "object", additionalProperties: false, required: ["allowed_read_paths", "entry_points", "test_commands"], properties: { allowed_read_paths: stringArray, entry_points: stringArray, test_commands: stringArray } },
  "frontend-developer": { type: "object", additionalProperties: false, required: ["modified_paths", "self_tests"], properties: { modified_paths: stringArray, self_tests: evidenceArray } },
  "backend-developer": { type: "object", additionalProperties: false, required: ["modified_paths", "self_tests"], properties: { modified_paths: stringArray, self_tests: evidenceArray } },
  test: { type: "object", additionalProperties: false, required: ["checks"], properties: { checks: evidenceArray } },
  "git-operator": { type: "object", additionalProperties: false, required: ["operations"], properties: { operations: evidenceArray } },
  "code-reviewer": { type: "object", additionalProperties: false, required: ["axes"], properties: { axes: { type: "array", items: { enum: ["spec", "standards"] }, minItems: 1, uniqueItems: true } } },
  "review-spec": { type: "object", additionalProperties: false, required: ["finding_ids"], properties: { finding_ids: stringArray } },
  "review-standards": { type: "object", additionalProperties: false, required: ["finding_ids"], properties: { finding_ids: stringArray } },
  "environment-operator": { type: "object", additionalProperties: false, required: ["managed_paths"], properties: { managed_paths: stringArray } },
  researcher: { type: "object", additionalProperties: false, required: ["report_path", "conclusion_count"], properties: { report_path: { type: "string" }, conclusion_count: { type: "integer", minimum: 1 } } },
};
const validateRolePayload = Object.fromEntries(ROLES.map((role) => [role, ajv.compile(ROLE_PAYLOAD_SCHEMAS[role])])) as Record<Role, ReturnType<Ajv["compile"]>>;

export const formatSchemaErrors = (errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> =>
  (errors ?? []).map((error) => ({ path: error.instancePath || "/", message: error.message ?? "invalid value" }));

export const checkResultEnvelope = (value: unknown): { valid: true; value: ResultEnvelope } | { valid: false; errors: Array<{ path: string; message: string }> } => {
  if (!validateResult(value)) return { valid: false, errors: formatSchemaErrors(validateResult.errors) };
  const envelope = value as ResultEnvelope;
  if (envelope.status === "completed" && envelope.verification.length === 0) {
    return { valid: false, errors: [{ path: "/verification", message: "completed results require verification evidence" }] };
  }
  const payloadValidator = validateRolePayload[envelope.role];
  if (envelope.status === "completed" && !payloadValidator(envelope.payload)) {
    return { valid: false, errors: formatSchemaErrors(payloadValidator.errors).map((error) => ({ ...error, path: `/payload${error.path === "/" ? "" : error.path}` })) };
  }
  if (envelope.status === "completed" && envelope.role === "planning") {
    const payload = envelope.payload as { pending_questions: string[]; decision: { question: string } | null };
    if (payload.pending_questions.length === 1 && payload.decision?.question !== payload.pending_questions[0]) {
      return { valid: false, errors: [{ path: "/payload/decision", message: "must match the single pending question" }] };
    }
    if (payload.pending_questions.length === 0 && payload.decision !== null) {
      return { valid: false, errors: [{ path: "/payload/decision", message: "must be null without a pending question" }] };
    }
  }
  return { valid: true, value: envelope };
};

export const COMMAND_CONTRACT = {
  schema_version: SCHEMA_VERSION,
  identifiers: {
    plan_id: "^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$",
    revision: "^[0-9]{3}$",
    task_id: "^TASK-[0-9]{3}$",
    run_id: "^run_[0-9A-HJKMNP-TV-Z]{26}$",
    dispatch_id: "^dispatch_[0-9A-HJKMNP-TV-Z]{26}$",
    commit: "^[a-f0-9]{40}$",
  },
  result_envelope: resultEnvelopeSchema,
  roles: ROLES,
  commands: {
    public: ["init", "install", "status", "planning start", "coding start", "run show", "run resume", "run decide", "env list", "env show", "env validate", "env edit", "env generate", "env switch", "env status", "env doctor", "backup restore", "uninstall"],
    agent: ["planning revision create", "planning revision transition", "planning revision commit", "dispatch create", "dispatch claim", "dispatch prompt", "dispatch schema", "dispatch validate", "dispatch submit", "decision create", "scope check", "git status", "git prepare", "git commit", "git merge-task", "git integrate", "git reconcile", "git cleanup", "review create", "review submit", "review resolve", "review status"],
  },
  command_specs: {
    "planning.start": { required: ["project"], optional: ["requestFile", "requestStdin"] },
    "coding.start": { required: ["project"], optional: ["mode", "planId", "revision", "requestFile", "requestStdin"] },
    "dispatch.identity": { required: ["runId", "dispatchId", "role"], optional: [] },
    "review.create": { required: ["runId", "revisionSha"], optional: ["formal"] },
  },
};

export const CONTRACT_DIGEST = sha256(stableJson(COMMAND_CONTRACT));

export const resultSchemaForRole = (role: Role): Record<string, unknown> => ({
  ...resultEnvelopeSchema,
  properties: { ...resultEnvelopeSchema.properties, payload: ROLE_PAYLOAD_SCHEMAS[role] },
});

export const createResultTemplate = (runId: string, dispatchId: string, role: Role): ResultEnvelope => ({
  schema_version: SCHEMA_VERSION,
  run_id: runId,
  dispatch_id: dispatchId,
  role,
  status: "completed",
  summary: "",
  findings: [],
  changes: [],
  verification: [],
  risks: [],
  decisions_needed: [],
  requested_support: [],
  handoff: null,
  payload: {},
});
