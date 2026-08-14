import { ROLES, type Role } from "./constants.js";
import { loadAgentBuildSync } from "./agent-build.js";
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

export const AGENT_BUILD = loadAgentBuildSync();
export const ROLE_MANIFEST: Record<Role, RoleDefinition> = Object.fromEntries(ROLES.map((role) => {
  const source = AGENT_BUILD.roles[role];
  return [role, { id: role, purpose: source.purpose, writes: source.writes, delegates: source.delegates, commands: source.commands, discovery: source.discovery, enforcement: source.enforcement }];
})) as Record<Role, RoleDefinition>;
export const ROLE_MANIFEST_DIGEST = sha256(stableJson(ROLE_MANIFEST));
