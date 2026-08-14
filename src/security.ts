import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep, join } from "node:path";
import { SecurityError } from "./errors.js";
import { assertRelativePosixPath } from "./utils.js";

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(?:[./]|$)/,
  /(^|\/)\.ssh(?:\/|$)/,
  /(^|\/)(?:credentials?|secrets?|keys?)(?:\/|$)/i,
  /^\.ai-team\/runtime(?:\/|$)/,
] as const;

export const isSensitivePath = (path: string): boolean => {
  const normalized = path.startsWith("/")
    ? path.replaceAll("\\", "/").replace(/^\/+/, "")
    : assertRelativePosixPath(path);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const assertWritablePath = (path: string): string => {
  if (isSensitivePath(path)) throw new SecurityError(`writing sensitive path is forbidden: ${path}`);
  return path;
};

/** Reads use the same sensitive-path policy as writes. Keeping this separate
 * makes call sites explicit and prevents read-only dispatches from leaking
 * credentials through packets or evidence. */
export const assertReadablePath = (path: string): string => {
  if (isSensitivePath(path)) throw new SecurityError(`reading sensitive path is forbidden: ${path}`);
  return path;
};

export const canonicalizeInside = async (root: string, candidate: string, allowMissing = false): Promise<string> => {
  assertReadablePath(candidate);
  const canonicalRoot = await realpath(root);
  const absolute = resolve(root, candidate);
  let canonical: string;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) canonical = await realpath(absolute);
    else canonical = await realpath(absolute);
  } catch (error) {
    if (!allowMissing) throw error;
    // A missing leaf can still sit below a symlinked parent. Canonicalize the
    // nearest existing ancestor before accepting the candidate.
    let ancestor = absolute;
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        canonical = join(canonicalAncestor, relative(ancestor, absolute));
        break;
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new SecurityError(`path escapes repository through canonicalization: ${candidate}`);
  return canonical;
};

export const pathMatchesScope = (path: string, scopes: string[]): boolean => scopes.some((scope) => {
  if (scope === "**") return true;
  const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return path === prefix || path.startsWith(`${prefix}/`);
});
