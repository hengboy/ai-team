import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ulid } from "ulid";
import { ValidationError } from "./errors.js";

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const stableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

export const makeId = (kind: "run" | "dispatch" | "staging" | "command"): string => `${kind}_${ulid()}`;

export const makePlanId = (slug: string, now = new Date()): string => {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (!normalized) throw new ValidationError("plan slug must contain ASCII letters or digits");
  if (/-[a-f0-9]{4}$/.test(normalized)) throw new ValidationError("plan slug must not end with four hexadecimal digits");
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${date}-${normalized}`;
};

export const assertRelativePosixPath = (value: string): string => {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new ValidationError(`path must be a repository-relative POSIX path: ${value}`);
  }
  return value;
};

export const assertInside = (root: string, candidate: string): string => {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    if (rel === "") return target;
    throw new ValidationError(`path escapes managed root: ${candidate}`);
  }
  return target;
};

const SECRET_PATTERNS = [
  /\b(sk-)[A-Za-z0-9_-]{16,}\b/g,
  /\b(gh[opusr]_)[A-Za-z0-9]{20,}\b/g,
  /\b(AKI)[A-Z0-9]{16}\b/g,
  /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
] as const;

export const redact = (value: string): string =>
  SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "$1[REDACTED]"), value);

export const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

export interface AtomicWriteOptions {
  beforeReplace?: () => Promise<void> | void;
}

export const atomicWriteFile = async (
  path: string,
  content: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> => {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeReplace?.();
    await rename(temporary, path);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
};

export const toPosix = (path: string): string => path.split(sep).join("/");
export const parentDirectory = dirname;
