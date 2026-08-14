import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import { RESULT_STATUSES, ROLES, SCHEMA_VERSION, type ResultStatus, type Role } from "./constants.js";
import { COMMAND_CONTRACT_BASE } from "./command-contract.js";
import { sha256, stableJson } from "./utils.js";
import { isSensitivePath } from "./security.js";

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

export interface ProjectContext {
  project_shape: string;
  memory: {
    domain_terms: string[];
    repository_constraints: string[];
    responsibilities: string[];
    module_boundaries: string[];
  };
  navigation: Array<{
    feature: string;
    keywords: string[];
    entry_paths: string[];
    module_boundary: string;
  }>;
  maintenance: { status: string; paths: string[] };
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
const contextText = { type: "string", minLength: 1, pattern: "^(?!\\s*$)[^\\r\\n]+$" } as const;
const contextStringArray = { type: "array", items: contextText } as const;
const evidenceArray = { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["command", "outcome"], properties: { command: { type: "string" }, outcome: { type: "string" } } } } as const;
export interface TypedDecisionInput {
  question: string;
  choices: Array<{ id: string; label: string; impact: string }>;
  recommendation?: string;
  type?: string;
}

export const DECISION_INPUT_SCHEMA = {
  $id: "https://ai-team.local/schemas/decision-input-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["question", "choices"],
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
    type: { type: "string", minLength: 1 },
  },
} as const;
const decisionSchema = { anyOf: [DECISION_INPUT_SCHEMA, { type: "null" }] } as const;
export const projectContextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_shape", "memory", "navigation", "maintenance"],
  properties: {
    project_shape: contextText,
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["domain_terms", "repository_constraints", "responsibilities", "module_boundaries"],
      properties: {
        domain_terms: contextStringArray,
        repository_constraints: contextStringArray,
        responsibilities: contextStringArray,
        module_boundaries: contextStringArray,
      },
    },
    navigation: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["feature", "keywords", "entry_paths", "module_boundary"],
        properties: {
          feature: contextText,
          keywords: { ...contextStringArray, minItems: 1 },
          entry_paths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$" } },
          module_boundary: contextText,
        },
      },
    },
    maintenance: {
      type: "object",
      additionalProperties: false,
      required: ["status", "paths"],
      properties: { status: contextText, paths: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$" } } },
    },
  },
} as const;
const validateProjectContextInput = ajv.compile<ProjectContext>(projectContextSchema);
const validateDecisionInput = ajv.compile<TypedDecisionInput>(DECISION_INPUT_SCHEMA);
export const ROLE_PAYLOAD_SCHEMAS: Record<Role, object> = {
  planning: { type: "object", additionalProperties: false, required: ["actions", "stage", "pending_questions", "decision"], properties: { actions: stringArray, stage: { enum: ["requirements", "requirements_confirmed", "spec_ready", "plan_ready", "tasks_preview", "ready"] }, pending_questions: { type: "array", maxItems: 1, items: { type: "string", minLength: 1 } }, decision: decisionSchema } },
  coding: { type: "object", additionalProperties: false, required: ["actions"], properties: { actions: stringArray, triage: { enum: ["planned", "bug", "feature", "planning"] } } },
  "file-explorer": { type: "object", additionalProperties: false, required: ["allowed_read_paths", "entry_points", "test_commands", "project_context"], properties: { allowed_read_paths: stringArray, entry_points: stringArray, test_commands: stringArray, project_context: projectContextSchema } },
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

export const checkProjectContext = (value: unknown): { valid: true; value: ProjectContext } | { valid: false; errors: Array<{ path: string; message: string }> } => {
  if (!validateProjectContextInput(value)) return { valid: false, errors: formatSchemaErrors(validateProjectContextInput.errors) };
  const sensitive = [
    ...value.navigation.flatMap((entry) => entry.entry_paths),
    ...value.maintenance.paths,
  ].filter((path) => isSensitivePath(path));
  if (sensitive.length) return { valid: false, errors: sensitive.map((path) => ({ path: "/navigation", message: `sensitive project context path is forbidden: ${path}` })) };
  return { valid: true, value };
};

export const formatSchemaErrors = (errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> =>
  (errors ?? []).map((error) => {
    const missing = error.keyword === "required" ? (error.params as { missingProperty?: string }).missingProperty : undefined;
    const path = missing ? `${error.instancePath}/${missing}` : error.instancePath || "/";
    return { path, message: error.message ?? "invalid value" };
  });

export const checkDecisionInput = (value: unknown): { valid: true; value: TypedDecisionInput } | { valid: false; errors: Array<{ path: string; message: string }> } => {
  if (!validateDecisionInput(value)) return { valid: false, errors: formatSchemaErrors(validateDecisionInput.errors) };
  const ids = value.choices.map((choice) => choice.id);
  if (new Set(ids).size !== ids.length) return { valid: false, errors: [{ path: "/choices", message: "choice ids must be unique" }] };
  return { valid: true, value };
};

export const DECISION_INPUT_TEMPLATE: TypedDecisionInput = {
  question: "",
  choices: [
    { id: "option-a", label: "", impact: "" },
    { id: "option-b", label: "", impact: "" },
  ],
  recommendation: "",
  type: "workflow",
};

export const checkResultEnvelope = (value: unknown): { valid: true; value: ResultEnvelope } | { valid: false; errors: Array<{ path: string; message: string }> } => {
  if (!validateResult(value)) return { valid: false, errors: formatSchemaErrors(validateResult.errors) };
  const envelope = value as ResultEnvelope;
  if (envelope.status === "needs_decision" && envelope.role !== "planning") {
    if (envelope.decisions_needed.length !== 1) {
      return { valid: false, errors: [{ path: "/decisions_needed", message: "needs_decision requires exactly one typed decision" }] };
    }
    const decision = checkDecisionInput(envelope.decisions_needed[0]);
    if (!decision.valid) return { valid: false, errors: decision.errors.map((error) => ({ ...error, path: `/decisions_needed/0${error.path === "/" ? "" : error.path}` })) };
  }
  if (envelope.status === "completed" && envelope.verification.length === 0) {
    return { valid: false, errors: [{ path: "/verification", message: "completed results require verification evidence" }] };
  }
  const payloadValidator = validateRolePayload[envelope.role];
  const requiresPayload = envelope.status === "completed" || envelope.role === "planning" && envelope.status === "needs_decision";
  if (requiresPayload && !payloadValidator(envelope.payload)) {
    return { valid: false, errors: formatSchemaErrors(payloadValidator.errors).map((error) => ({ ...error, path: `/payload${error.path === "/" ? "" : error.path}` })) };
  }
  if (envelope.status === "completed" && envelope.role === "file-explorer") {
    const payload = envelope.payload as { allowed_read_paths: string[]; project_context: ProjectContext };
    const authorized = new Set(payload.allowed_read_paths);
    const requiredContextPaths = ["MEMORY.md", ".ai-team/index/feature-navigation.md"];
    const missingContextPaths = requiredContextPaths.filter((path) => !authorized.has(path));
    const missingEntryPaths = payload.project_context.navigation.flatMap((entry) => entry.entry_paths.filter((path) => !authorized.has(path)));
    if (missingContextPaths.length || missingEntryPaths.length) {
      return { valid: false, errors: [{ path: "/payload/allowed_read_paths", message: `project context paths are not authorized: ${[...missingContextPaths, ...missingEntryPaths].join(", ")}` }] };
    }
  }
  if (requiresPayload && envelope.role === "planning") {
    const payload = envelope.payload as { pending_questions: string[]; decision: { question: string } | null };
    if (envelope.status === "needs_decision" && payload.pending_questions.length !== 1) {
      return { valid: false, errors: [{ path: "/payload/pending_questions", message: "needs_decision requires one pending question" }] };
    }
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
  ...COMMAND_CONTRACT_BASE,
  result_envelope: resultEnvelopeSchema,
  roles: ROLES,
} as const;

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
