import { ROLES, type Role } from "../constants.js";
import { ValidationError } from "../errors.js";
import { assertReadablePath, assertWritablePath } from "../security.js";
import { assertRelativePosixPath, stableJson } from "../utils.js";
import type { ExecutionContract, ExecutionRequest } from "../execution-contract.js";

export interface DispatchPacket {
  objective: string;
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  acceptance_criteria: string[];
  context: Record<string, unknown>;
  execution_request?: ExecutionRequest;
  execution_contract?: ExecutionContract;
}

export interface MergeWorktreeBindings {
  integration_worktree_id: string | null;
  task_worktree_ids: string[];
}

export const RENDERER_VERSION = "dispatch-renderer-v5";
export const EXPLORER_CONTEXT_PATHS = ["MEMORY.md", ".ai-team/index/feature-navigation.md"] as const;
export const isBroadReadPath = (path: string): boolean => path === "**" || path === "." || path.endsWith("/**");

export const mergeBindingsFromPacket = (role: Role, packet: DispatchPacket): MergeWorktreeBindings | undefined => {
  if (role !== "git-operator" || !["integrate_implementation", "reconcile_worktree_ownership"].includes(String(packet.context.phase))) return undefined;
  const integration = typeof packet.context.integration_worktree_id === "string" ? packet.context.integration_worktree_id : null;
  const taskIds = [
    ...(Array.isArray(packet.context.task_worktree_ids) ? packet.context.task_worktree_ids.filter((id): id is string => typeof id === "string") : []),
    ...(typeof packet.context.task_worktree_id === "string" ? [packet.context.task_worktree_id] : []),
  ];
  const taskWorktreeIds = [...new Set(taskIds)].sort();
  if (integration && taskWorktreeIds.includes(integration)) {
    throw new ValidationError("integration worktree cannot also be a task worktree", [{
      path: "/context/task_worktree_ids",
      pointer: "/context/task_worktree_ids",
      field: "task_worktree_ids",
      constraint: "disjoint",
      message: `worktree ${integration} is already the integration worktree`,
    }]);
  }
  return { integration_worktree_id: integration, task_worktree_ids: taskWorktreeIds };
};

const packetContextRequirements = (role: Role, phase?: unknown, taskId?: unknown): string[] => {
  if (phase === "continue_implementation") return ["phase", "explorer_dispatch_id", "coordinator_dispatch_id", "prepare_git_dispatch_id", "task_id", "worktree_id", "worktree_path"];
  if (phase === "prepare_implementation_worktree") {
    return /^TASK-\d{3}$/.test(String(taskId ?? ""))
      ? ["phase", "task_id", "explorer_dispatch_id", "coordinator_dispatch_id"]
      : ["phase", "task_id"];
  }
  if (phase === "recover_task_worktree") {
    return ["phase", "task_id", "worktree_id"];
  }
  if (phase === "apply_task_authority") {
    return ["phase", "operation", "task_id", "worktree_id", "worktree_path", "authority_commit", "expected_head", "superseded_developer_dispatch_id"];
  }
  if (role === "frontend-developer" || role === "backend-developer") return ["explorer_dispatch_id", "worktree_id"];
  return [];
};

export const dispatchPacketSchema = (role: Role, phase?: unknown, taskId?: unknown): Record<string, unknown> => {
  const contextRequired = packetContextRequirements(role, phase, taskId);
  const contextProperties = Object.fromEntries(contextRequired.map((key) => [key, {
    type: "string",
    ...(key === "task_id" ? { pattern: phase === "continue_implementation" ? "^TASK-[0-9]{3}$" : "^(?:TASK-[0-9]{3}|implementation)$" } : {}),
    ...(key === "operation" && phase === "recover_task_worktree" ? { const: "recover-task-worktree" } : {}),
    ...(key === "operation" && phase === "apply_task_authority" ? { const: "apply-task-authority" } : {}),
  }]));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    required: ["objective", "allowed_read_paths", "allowed_write_paths", "acceptance_criteria", "context"],
    properties: {
      objective: { type: "string", minLength: 1 },
      allowed_read_paths: { type: "array", items: { type: "string", minLength: 1 } },
      allowed_write_paths: { type: "array", items: { type: "string", minLength: 1 } },
      acceptance_criteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      context: { type: "object", additionalProperties: true, ...(contextRequired.length ? { required: contextRequired } : {}), properties: contextProperties },
      execution_request: {
        type: "object",
        additionalProperties: false,
        properties: {
          cwd: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: { enum: ["project", "worktree", "ai_team_home"] },
              worktree_id: { type: "string", minLength: 1 },
            },
          },
          tools: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: ["filesystem.read", "filesystem.write", "process.exec", "git.read", "git.write", "network"] },
          },
          approval_policy: { enum: ["never", "on_request", "always"] },
        },
      },
      execution_contract: {
        type: "object",
        readOnly: true,
        additionalProperties: false,
        required: ["schema_version", "cwd", "tools", "approval_policy", "source"],
        properties: {
          schema_version: { const: 1 },
          cwd: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: { enum: ["project", "worktree", "ai_team_home"] },
              worktree_id: { type: "string", minLength: 1 },
            },
          },
          tools: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: ["filesystem.read", "filesystem.write", "process.exec", "git.read", "git.write", "network"] },
          },
          approval_policy: { enum: ["never", "on_request", "always"] },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "role", "role_manifest_digest"],
            properties: {
              kind: { enum: ["role_default", "dispatch_request", "source_contract"] },
              role: { enum: [...ROLES] },
              role_manifest_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          },
        },
      },
    },
  };
};

export const dispatchPacketTemplate = (role: Role, packet: DispatchPacket): DispatchPacket => {
  const required = packetContextRequirements(role, packet.context.phase, packet.context.task_id);
  return {
    objective: packet.objective,
    allowed_read_paths: [...packet.allowed_read_paths],
    allowed_write_paths: [...packet.allowed_write_paths],
    acceptance_criteria: [...packet.acceptance_criteria],
    context: { ...packet.context, ...Object.fromEntries(required.map((key) => [key, packet.context[key] ?? ""])) },
    ...(packet.execution_contract ? { execution_contract: structuredClone(packet.execution_contract) } : {}),
  };
};

const promptLines = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string[] => [
  `Role: ${role}`, `Run: ${runId}`, `Dispatch: ${dispatchId}`, `Objective: ${packet.objective}`,
  `Allowed read paths: ${packet.allowed_read_paths.join(", ") || "none"}`,
  `Allowed write paths: ${packet.allowed_write_paths.join(", ") || "none"}`,
  `Acceptance criteria: ${packet.acceptance_criteria.join("; ")}`, `Context: ${stableJson(packet.context)}`,
];

export const promptForV2 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  ...promptLines(runId, dispatchId, role, packet), "Return only the frozen result envelope and role payload schema.",
].join("\n");

export const promptForV3 = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  ...promptLines(runId, dispatchId, role, packet),
  "Build the frozen result envelope from the template and schema, then submit it exactly once with dispatch submit --input-stdin.",
  "Return the CLI submission receipt containing submission and continuation; do not return an unsubmitted envelope.",
].join("\n");

export const promptFor = (runId: string, dispatchId: string, role: Role, packet: DispatchPacket): string => [
  ...promptLines(runId, dispatchId, role, packet),
  "Create a dispatch-result staging entry, write the frozen result envelope with staging write --run-id <run-id> --role <role> --staging-id <staging-id> --input-stdin, validate it, then submit it exactly once with dispatch submit --staging-id <staging-id>.",
  "Return the CLI submission receipt containing submission and continuation; do not return an unsubmitted envelope.",
  "Do not claim a workflow action in the final output unless it is recorded by the returned artifact, decision, or run event.",
].join("\n");

export const validatePacket = (packet: unknown, role: Role): DispatchPacket => {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new ValidationError("dispatch packet must be an object");
  const value = packet as Record<string, unknown>;
  const allowed = new Set(["objective", "allowed_read_paths", "allowed_write_paths", "acceptance_criteria", "context", "execution_request", "execution_contract"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError("dispatch packet has unknown fields", unknown.map((key) => ({ path: `/${key}`, pointer: `/${key}`, field: key, constraint: "additionalProperties", message: "unknown field" })));
  if (typeof value.objective !== "string" || !value.objective.trim()) throw new ValidationError("dispatch packet objective must be a non-empty string", ["/objective"]);
  for (const key of ["allowed_read_paths", "allowed_write_paths", "acceptance_criteria"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || !item.trim())) throw new ValidationError(`dispatch packet ${key} must contain non-empty strings`, [`/${key}`]);
  }
  if (!(value.context && typeof value.context === "object" && !Array.isArray(value.context))) throw new ValidationError("dispatch packet context must be an object", ["/context"]);
  for (const key of ["execution_request", "execution_contract"] as const) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      throw new ValidationError(`dispatch packet ${key} must be an object`, [`/${key}`]);
    }
  }
  if (value.execution_request && value.execution_contract) throw new ValidationError("dispatch packet cannot contain both execution_request and execution_contract");
  const context = value.context as Record<string, unknown>;
  const enforcedContext = context.phase === "continue_implementation" || context.phase === "prepare_implementation_worktree" || context.phase === "recover_task_worktree" || context.phase === "apply_task_authority"
    ? packetContextRequirements(role, context.phase, context.task_id)
    : [];
  const missingContext = enforcedContext.filter((key) => typeof context[key] !== "string" || !(context[key] as string).trim());
  if (missingContext.length) throw new ValidationError("dispatch packet context is incomplete for role and phase", missingContext.map((key) => ({ path: `/context/${key}`, pointer: `/context/${key}`, field: key, constraint: "required", message: "required context field is missing" })));
  if (context.phase === "recover_task_worktree" && context.operation !== undefined) {
    const recoveryFields = [
      "operation", "explorer_dispatch_id", "coordinator_dispatch_id", "project", "source_run_id",
      "from_plan_id", "from_revision", "to_plan_id", "to_revision", "to_run_id", "expected_head",
      "expected_source_artifact", "expected_source_artifact_digest",
    ];
    const missingRecoveryFields = recoveryFields.filter((key) => typeof context[key] !== "string" || !(context[key] as string).trim());
    if (missingRecoveryFields.length) throw new ValidationError("recovery dispatch packet context is incomplete", missingRecoveryFields.map((key) => ({ path: `/context/${key}`, pointer: `/context/${key}`, field: key, constraint: "required", message: "required recovery context field is missing" })));
    if (context.operation !== "recover-task-worktree") throw new ValidationError("recovery dispatch packet operation must be recover-task-worktree", ["/context/operation"]);
  }
  if (context.phase === "apply_task_authority" && context.operation !== "apply-task-authority") {
    throw new ValidationError("task authority packet operation must be apply-task-authority", ["/context/operation"]);
  }
  if (typeof context.task_id === "string" && context.task_id !== "implementation" && !/^TASK-\d{3}$/.test(context.task_id)) {
    throw new ValidationError("dispatch packet context.task_id is invalid", [{ path: "/context/task_id", pointer: "/context/task_id", field: "task_id", constraint: "pattern", message: "must match TASK- followed by three digits" }]);
  }
  if (!(value.acceptance_criteria as string[]).length) throw new ValidationError("dispatch packet requires acceptance criteria", ["/acceptance_criteria"]);
  const reads = role === "file-explorer" ? [...new Set([...EXPLORER_CONTEXT_PATHS, ...(value.allowed_read_paths as string[])])] : value.allowed_read_paths as string[];
  const writes = value.allowed_write_paths as string[];
  if (role === "test" && writes.length) throw new ValidationError("Test dispatch packets must have empty write paths", ["/allowed_write_paths"]);
  for (const path of [...reads, ...writes]) if (path !== "." && path !== "**") assertRelativePosixPath(path);
  for (const path of reads) if (path !== "." && path !== "**") assertReadablePath(path);
  for (const path of writes) assertWritablePath(path);
  const broad = reads.filter(isBroadReadPath);
  if (role !== "file-explorer" && broad.length) throw new ValidationError(`${role} requires exact allowed_read_paths`);
  return { ...value, allowed_read_paths: reads } as unknown as DispatchPacket;
};
