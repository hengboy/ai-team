import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors.js";
import { assertRelativePosixPath } from "./utils.js";

const SENSITIVE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /(^|\/)\.ssh(?:\/|$)/,
  /(^|\/)(?:credentials?|secrets?|keys?)(?:\/|$)/i,
  /^\.ai-team\/runtime(?:\/|$)/,
] as const;

export const isSensitivePath = (path: string): boolean => {
  const normalized = assertRelativePosixPath(path);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const assertWritablePath = (path: string): string => {
  if (isSensitivePath(path)) throw new ValidationError(`writing sensitive path is forbidden: ${path}`);
  return path;
};

export const canonicalizeInside = async (root: string, candidate: string, allowMissing = false): Promise<string> => {
  const canonicalRoot = await realpath(root);
  const absolute = resolve(root, candidate);
  let canonical: string;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) canonical = await realpath(absolute);
    else canonical = await realpath(absolute);
  } catch (error) {
    if (!allowMissing) throw error;
    canonical = absolute;
  }
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new ValidationError(`path escapes repository through canonicalization: ${candidate}`);
  return canonical;
};

export const pathMatchesScope = (path: string, scopes: string[]): boolean => scopes.some((scope) => {
  if (scope === "**") return true;
  const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return path === prefix || path.startsWith(`${prefix}/`);
});
