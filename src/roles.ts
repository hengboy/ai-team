import { ROLES, type Role } from "./constants.js";
import { sha256, stableJson } from "./utils.js";

export type Enforcement = "mechanical" | "instruction" | "unsupported";

export interface RoleDefinition {
  id: Role;
  purpose: string;
  writes: string[];
  delegates: Role[];
  commands: string[];
  discovery: boolean;
  enforcement: Record<string, Enforcement>;
}

const leaf = (id: Role, purpose: string, writes: string[] = []): RoleDefinition => ({
  id,
  purpose,
  writes,
  delegates: [],
  commands: ["dispatch claim", "dispatch prompt", "dispatch schema", "dispatch validate", "dispatch submit"],
  discovery: false,
  enforcement: { command_scope: "mechanical", read_scope: "instruction", write_scope: "instruction" },
});

export const ROLE_MANIFEST: Record<Role, RoleDefinition> = {
  planning: {
    ...leaf("planning", "Clarify requirements and create immutable planning revisions", [".ai-team/plans/**"]),
    delegates: ["file-explorer", "researcher"],
    commands: ["planning start", "planning revision *", "dispatch create", "decision create", "run show", "run resume", "run decide"],
  },
  coding: {
    ...leaf("coding", "Triage and orchestrate implementation, verification, review, repair, and integration"),
    delegates: ROLES.filter((role) => !["planning", "coding", "environment-operator"].includes(role)),
    commands: ["coding start", "dispatch create", "decision create", "scope check", "review *", "run show", "run resume", "run decide", "git *"],
  },
  "file-explorer": { ...leaf("file-explorer", "Discover repository files, entry points, dependencies, and tests"), discovery: true },
  "frontend-developer": leaf("frontend-developer", "Implement frontend behavior within an assigned worktree scope", ["dispatch.allowed_write_paths"]),
  "backend-developer": leaf("backend-developer", "Implement backend and general engineering work within an assigned scope", ["dispatch.allowed_write_paths"]),
  test: leaf("test", "Run independent tests, builds, static checks, and regressions"),
  "git-operator": { ...leaf("git-operator", "Perform the only allowed local Git mutations", ["git refs", ".worktree/**"]), commands: ["git *", "dispatch claim", "dispatch prompt", "dispatch submit"] },
  "code-reviewer": { ...leaf("code-reviewer", "Coordinate and aggregate one review barrier"), delegates: ["review-spec", "review-standards"] },
  "review-spec": leaf("review-spec", "Review implementation against a formal specification"),
  "review-standards": leaf("review-standards", "Review implementation against engineering standards"),
  "environment-operator": { ...leaf("environment-operator", "Install, generate, switch, restore, and uninstall managed global files", ["AI_TEAM_HOME", "platform agent directories"]), commands: ["install", "env *", "backup restore", "uninstall"] },
  researcher: leaf("researcher", "Research external facts and create a cited report artifact", ["dispatch.report_path"]),
};

export const ROLE_MANIFEST_DIGEST = sha256(stableJson(ROLE_MANIFEST));
