import type { Role } from "./constants.js";
import { ValidationError } from "./errors.js";
import { ROLE_MANIFEST, ROLE_MANIFEST_DIGEST } from "./roles.js";
import type { ApprovalPolicy, ExecutionCwdKind, ExecutionTool } from "./agent-build.js";

export const EXECUTION_CONTRACT_SCHEMA_VERSION = 1;

export interface ExecutionRequest {
  cwd?: { kind: ExecutionCwdKind; worktree_id?: string };
  tools?: ExecutionTool[];
  approval_policy?: ApprovalPolicy;
}

export interface ExecutionContract {
  schema_version: 1;
  cwd: { kind: ExecutionCwdKind; worktree_id?: string };
  tools: ExecutionTool[];
  approval_policy: ApprovalPolicy;
  source: {
    kind: "role_default" | "dispatch_request" | "source_contract";
    role: Role;
    role_manifest_digest: string;
  };
}

export interface ExecutionPacketFields {
  allowed_write_paths: string[];
  context: Record<string, unknown>;
  execution_request?: ExecutionRequest;
  execution_contract?: ExecutionContract;
}

const approvalRank: Record<ApprovalPolicy, number> = { never: 0, on_request: 1, always: 2 };

const boundWorktreeId = (context: Record<string, unknown>): string | undefined => {
  for (const key of ["worktree_id", "task_worktree_id", "implementation_worktree_id", "integration_worktree_id"]) {
    if (typeof context[key] === "string" && context[key]) return context[key] as string;
  }
  return undefined;
};

const validateRequest = (request: ExecutionRequest, role: Role): void => {
  const allowed = new Set(["cwd", "tools", "approval_policy"]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError("execution_request has unknown fields", unknown.map((key) => `/execution_request/${key}`));
  const policy = ROLE_MANIFEST[role].execution;
  if (request.tools) {
    if (!Array.isArray(request.tools) || !request.tools.length || new Set(request.tools).size !== request.tools.length) {
      throw new ValidationError("execution_request.tools must contain unique tools", ["/execution_request/tools"]);
    }
    const outside = request.tools.filter((tool) => !policy.ceiling.tools.includes(tool));
    if (outside.length) throw new ValidationError("execution_request exceeds the role tool ceiling", outside.map((tool) => `/execution_request/tools/${tool}`));
  }
  if (request.approval_policy && (!policy.ceiling.approval_policies.includes(request.approval_policy)
    || approvalRank[request.approval_policy] < approvalRank[policy.default.approval_policy])) {
    throw new ValidationError("execution_request cannot weaken the role approval policy", ["/execution_request/approval_policy"]);
  }
  if (request.cwd && !policy.ceiling.cwd.includes(request.cwd.kind)) {
    throw new ValidationError("execution_request exceeds the role cwd ceiling", ["/execution_request/cwd/kind"]);
  }
};

export const freezeExecutionContract = <T extends ExecutionPacketFields>(role: Role, packet: T, source?: ExecutionContract): Omit<T, "execution_request" | "execution_contract"> & { execution_contract: ExecutionContract } => {
  if (packet.execution_contract && !source) throw new ValidationError("execution_contract is server-generated", ["/execution_contract"]);
  const request = packet.execution_request;
  if (request) validateRequest(request, role);
  const policy = ROLE_MANIFEST[role].execution;
  const sourceContract = source?.source.role_manifest_digest === ROLE_MANIFEST_DIGEST ? source : undefined;
  if (source && !sourceContract) throw new ValidationError("source dispatch role manifest does not match the current role manifest", {
    reason_code: "role_manifest_mismatch",
    next_action: "start_new_run",
  });
  const requestedCwd = request?.cwd;
  const sourceCwd = sourceContract?.cwd;
  const cwd = requestedCwd ?? sourceCwd ?? { kind: policy.default.cwd, ...(policy.default.cwd === "worktree" ? { worktree_id: boundWorktreeId(packet.context) } : {}) };
  const worktreeId = boundWorktreeId(packet.context);
  if (cwd.kind === "worktree" && cwd.worktree_id && cwd.worktree_id !== worktreeId) {
    throw new ValidationError("execution cwd must use the dispatch-bound worktree", ["/execution_request/cwd/worktree_id"]);
  }
  if (sourceCwd && (cwd.kind !== sourceCwd.kind && !(sourceCwd.kind === "project" && cwd.kind === "worktree" && cwd.worktree_id === worktreeId))) {
    throw new ValidationError("replacement execution cwd may only stay fixed or narrow to the bound worktree", ["/execution_request/cwd"]);
  }
  const tools = request?.tools ?? sourceContract?.tools ?? policy.default.tools;
  if (sourceContract && tools.some((tool) => !sourceContract.tools.includes(tool))) {
    throw new ValidationError("replacement execution tools may only be narrowed", ["/execution_request/tools"]);
  }
  if (role === "git-operator" && tools.includes("filesystem.write") && packet.allowed_write_paths.length === 0) {
    throw new ValidationError("Git Operator filesystem.write requires non-empty allowed_write_paths", ["/allowed_write_paths"]);
  }
  const approval = request?.approval_policy ?? sourceContract?.approval_policy ?? policy.default.approval_policy;
  if (sourceContract && approvalRank[approval] < approvalRank[sourceContract.approval_policy]) {
    throw new ValidationError("replacement execution approval policy may only be tightened", ["/execution_request/approval_policy"]);
  }
  const rest = { ...packet };
  delete rest.execution_request;
  delete rest.execution_contract;
  return {
    ...rest,
    execution_contract: {
      schema_version: EXECUTION_CONTRACT_SCHEMA_VERSION,
      cwd,
      tools: [...tools],
      approval_policy: approval,
      source: {
        kind: sourceContract ? "source_contract" : request ? "dispatch_request" : "role_default",
        role,
        role_manifest_digest: ROLE_MANIFEST_DIGEST,
      },
    },
  } as Omit<T, "execution_request" | "execution_contract"> & { execution_contract: ExecutionContract };
};

export const executionEnforcement = (contract?: ExecutionContract): Record<string, unknown> => contract ? {
  contract_status: "specified",
  schema_version: contract.schema_version,
  tool_scope: "instruction",
  cwd: "delegated",
  approval_policy: "unverified",
  process_isolation: "unverified",
} : {
  contract_status: "legacy_unspecified",
  tool_scope: "unverified",
  cwd: "unverified",
  approval_policy: "unverified",
  process_isolation: "unverified",
};
