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

export interface ValidationDetail {
  /** Backward-compatible JSON pointer alias. */
  path: string;
  pointer: string;
  field: string;
  constraint: string;
  message: string;
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

export interface TypedDecisionInput {
  question: string;
  choices: Array<{ id: string; label: string; impact: string }>;
  recommendation?: string;
  type?: string;
}

const DECISION_CHOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "impact"],
  properties: {
    id: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    impact: { type: "string", minLength: 1 },
  },
} as const;

const DECISION_INPUT_SHAPE = {
  type: "object",
  additionalProperties: false,
  required: ["question", "choices"],
  properties: {
    question: { type: "string", minLength: 1 },
    choices: { type: "array", minItems: 2, uniqueItems: true, items: DECISION_CHOICE_SCHEMA },
    recommendation: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
  },
} as const;
export const DECISION_INPUT_SCHEMA = {
  $id: "https://ai-team.local/schemas/decision-input-v1.json",
  ...DECISION_INPUT_SHAPE,
} as const;

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
    decisions_needed: { type: "array", items: DECISION_INPUT_SHAPE },
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
const decisionSchema = { anyOf: [DECISION_INPUT_SHAPE, { type: "null" }] } as const;
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
const planningProperties = {
  actions: stringArray,
  pending_questions: { type: "array", maxItems: 1, items: { type: "string", minLength: 1 } },
  decision: decisionSchema,
} as const;
const planningPayloadSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["actions", "stage", "pending_questions", "decision"],
      properties: { ...planningProperties, stage: { enum: ["requirements", "requirements_confirmed", "spec_ready", "plan_ready", "tasks_preview", "ready"] } },
    },
    {
      type: "object", additionalProperties: false, required: ["actions", "stage", "pending_questions", "decision", "no_change"],
      properties: {
        ...planningProperties,
        stage: { const: "no_change" },
        no_change: {
          type: "object", additionalProperties: false, required: ["decision_id", "conclusion", "repository_evidence"],
          properties: {
            decision_id: { type: "string", pattern: "^decision_[0-9A-HJKMNP-TV-Z]{26}$" },
            conclusion: { type: "string", minLength: 1 },
            repository_evidence: evidenceArray,
          },
        },
      },
    },
  ],
} as const;

export const ROLE_PAYLOAD_SCHEMAS: Record<Role, object> = {
  planning: planningPayloadSchema,
  coding: { type: "object", additionalProperties: false, required: ["actions"], properties: { actions: stringArray, triage: { enum: ["planned", "bug", "feature", "planning"] } } },
  "file-explorer": { type: "object", additionalProperties: false, required: ["allowed_read_paths", "entry_points", "test_commands", "project_context"], properties: { allowed_read_paths: stringArray, entry_points: stringArray, test_commands: stringArray, project_context: projectContextSchema } },
  "frontend-developer": { type: "object", additionalProperties: false, required: ["modified_paths", "self_tests"], properties: { modified_paths: stringArray, self_tests: evidenceArray } },
  "backend-developer": { type: "object", additionalProperties: false, required: ["modified_paths", "self_tests"], properties: { modified_paths: stringArray, self_tests: evidenceArray } },
  test: { type: "object", additionalProperties: false, required: ["checks"], properties: { checks: evidenceArray, testedCommit: { type: "string", pattern: "^[a-f0-9]{40}$" } } },
  "git-operator": { type: "object", additionalProperties: false, required: ["operations"], properties: { operations: evidenceArray } },
  "code-reviewer": { type: "object", additionalProperties: false, required: ["axes"], properties: { axes: { type: "array", items: { enum: ["spec", "standards"] }, minItems: 1, uniqueItems: true } } },
  "review-spec": { type: "object", additionalProperties: false, required: ["finding_ids"], properties: { finding_ids: stringArray, barrier_id: { type: "string", pattern: "^review_[a-f0-9]{24}$" } } },
  "review-standards": { type: "object", additionalProperties: false, required: ["finding_ids"], properties: { finding_ids: stringArray, barrier_id: { type: "string", pattern: "^review_[a-f0-9]{24}$" } } },
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

const pointerField = (pointer: string): string => {
  if (pointer === "/") return "$";
  return pointer.slice(pointer.lastIndexOf("/") + 1).replaceAll("~1", "/").replaceAll("~0", "~");
};

const validationDetail = (pointer: string, constraint: string, message: string): ValidationDetail => ({
  path: pointer,
  pointer,
  field: pointerField(pointer),
  constraint,
  message,
});

const prefixValidationDetail = (prefix: string, error: ValidationDetail): ValidationDetail => {
  const pointer = `${prefix}${error.pointer === "/" ? "" : error.pointer}`;
  const message = error.constraint === "type" && /\/decisions_needed\/\d+\/choices\/\d+$/.test(pointer)
    ? "must be an object with required string properties {id,label,impact}"
    : error.message;
  return { ...error, path: pointer, pointer, field: pointerField(pointer), message };
};

export const formatSchemaErrors = (errors: ErrorObject[] | null | undefined): ValidationDetail[] =>
  (errors ?? []).map((error) => {
    const missing = error.keyword === "required" ? (error.params as { missingProperty?: string }).missingProperty : undefined;
    const additional = error.keyword === "additionalProperties" ? (error.params as { additionalProperty?: string }).additionalProperty : undefined;
    const property = missing ?? additional;
    const pointer = property ? `${error.instancePath}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}` : error.instancePath || "/";
    const message = error.keyword === "type" && /\/decisions_needed\/\d+\/choices\/\d+$/.test(pointer)
      ? "must be an object with required string properties {id,label,impact}"
      : error.message ?? "invalid value";
    return validationDetail(pointer, error.keyword, message);
  });

export const checkDecisionInput = (value: unknown): { valid: true; value: TypedDecisionInput } | { valid: false; errors: ValidationDetail[] } => {
  if (!validateDecisionInput(value)) return { valid: false, errors: formatSchemaErrors(validateDecisionInput.errors) };
  const ids = value.choices.map((choice) => choice.id);
  if (new Set(ids).size !== ids.length) return { valid: false, errors: [validationDetail("/choices", "uniqueItems", "choice ids must be unique")] };
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

export const checkResultEnvelope = (value: unknown): { valid: true; value: ResultEnvelope } | { valid: false; errors: ValidationDetail[] } => {
  if (!validateResult(value)) return { valid: false, errors: formatSchemaErrors(validateResult.errors) };
  const envelope = value as ResultEnvelope;
  if (envelope.status === "needs_decision") {
    if (envelope.decisions_needed.length !== 1) {
      return { valid: false, errors: [validationDetail("/decisions_needed", "minItems/maxItems", "needs_decision requires exactly one typed decision")] };
    }
    const decision = checkDecisionInput(envelope.decisions_needed[0]);
    if (!decision.valid) return { valid: false, errors: decision.errors.map((error) => prefixValidationDetail("/decisions_needed/0", error)) };
    if (envelope.role === "planning") {
      const payloadDecision = (envelope.payload as { decision?: unknown }).decision;
      if (stableJson(payloadDecision) !== stableJson(decision.value)) {
        return { valid: false, errors: [validationDetail("/payload/decision", "const", "planning decision must match decisions_needed[0]")] };
      }
    }
  }
  if (envelope.status === "completed" && envelope.verification.length === 0) {
    return { valid: false, errors: [validationDetail("/verification", "minItems", "completed results require verification evidence")] };
  }
  const payloadValidator = validateRolePayload[envelope.role];
  const requiresPayload = envelope.status === "completed" || envelope.role === "planning" && envelope.status === "needs_decision";
  if (requiresPayload && !payloadValidator(envelope.payload)) {
    return { valid: false, errors: formatSchemaErrors(payloadValidator.errors).map((error) => prefixValidationDetail("/payload", error)) };
  }
  if (envelope.status === "completed" && envelope.role === "file-explorer") {
    const payload = envelope.payload as { allowed_read_paths: string[]; project_context: ProjectContext };
    const authorized = new Set(payload.allowed_read_paths);
    const requiredContextPaths = ["MEMORY.md", ".ai-team/index/feature-navigation.md"];
    const missingContextPaths = requiredContextPaths.filter((path) => !authorized.has(path));
    const missingEntryPaths = payload.project_context.navigation.flatMap((entry) => entry.entry_paths.filter((path) => !authorized.has(path)));
    if (missingContextPaths.length || missingEntryPaths.length) {
      return { valid: false, errors: [validationDetail("/payload/allowed_read_paths", "authorization", `project context paths are not authorized: ${[...missingContextPaths, ...missingEntryPaths].join(", ")}`)] };
    }
  }
  if (requiresPayload && envelope.role === "planning") {
    const payload = envelope.payload as { pending_questions: string[]; decision: { question: string; choices: Array<{ id: string }> } | null };
    const choiceIds = payload.decision?.choices.map(({ id }) => id).sort() ?? [];
    const nonFunctionalDecision = choiceIds.join(",") === "confirm,revise" || choiceIds.join(",") === "no_split,split";
    if (envelope.status === "needs_decision" && !payload.decision) {
      return { valid: false, errors: [validationDetail("/payload/decision", "required", "needs_decision requires one typed decision")] };
    }
    if (envelope.status === "needs_decision" && !nonFunctionalDecision && payload.pending_questions.length !== 1) {
      return { valid: false, errors: [validationDetail("/payload/pending_questions", "minItems", "a functional needs_decision requires one pending question")] };
    }
    if (payload.pending_questions.length === 1 && payload.decision?.question !== payload.pending_questions[0]) {
      return { valid: false, errors: [validationDetail("/payload/decision", "const", "must match the single pending question")] };
    }
    if (payload.pending_questions.length === 0 && payload.decision !== null && !nonFunctionalDecision) {
      return { valid: false, errors: [validationDetail("/payload/decision", "const", "must be null without a pending question")] };
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

const payloadTemplateForRole = (role: Role): Record<string, unknown> => {
  const evidence = [{ command: "replace with the executed command", outcome: "replace with the observed outcome" }];
  switch (role) {
    case "planning": return { actions: [], stage: "requirements", pending_questions: [], decision: null };
    case "coding": return { actions: [] };
    case "file-explorer": return {
      allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"],
      entry_points: [],
      test_commands: [],
      project_context: {
        project_shape: "replace with the observed project shape",
        memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
        navigation: [],
        maintenance: { status: "replace with the context maintenance status", paths: [] },
      },
    };
    case "frontend-developer":
    case "backend-developer": return { modified_paths: [], self_tests: evidence };
    case "test": return { checks: evidence };
    case "git-operator": return { operations: evidence };
    case "code-reviewer": return { axes: ["standards"] };
    case "review-spec":
    case "review-standards": return { finding_ids: [] };
    case "environment-operator": return { managed_paths: [] };
    case "researcher": return { report_path: "replace with the archived report path", conclusion_count: 1 };
  }
};

export const createResultTemplate = (runId: string, dispatchId: string, role: Role): ResultEnvelope => ({
  schema_version: SCHEMA_VERSION,
  run_id: runId,
  dispatch_id: dispatchId,
  role,
  status: "completed",
  summary: "replace with the completed work summary",
  findings: [],
  changes: [],
  verification: [{ command: "replace with the verification command", outcome: "replace with the observed outcome" }],
  risks: [],
  decisions_needed: [],
  requested_support: [],
  handoff: null,
  payload: payloadTemplateForRole(role),
});
