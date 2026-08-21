import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep, join } from "node:path";
import { SecurityError } from "./errors.js";
import { assertInside, assertRelativePosixPath, atomicWriteFile, sha256, type AtomicWriteOptions } from "./utils.js";
import { STAGING_MAX_BYTES, type Role, type StagingKind } from "./constants.js";

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
  if (scope === "**" || scope === ".") return true;
  const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return path === prefix || path.startsWith(`${prefix}/`);
});

export interface ManagedFileIdentity {
  dev: string;
  ino: string;
}

export interface ManagedJsonFile {
  bytes: number;
  digest: string;
  identity: ManagedFileIdentity;
  text: string;
  value: unknown;
}

const currentUid = (): number | undefined => process.getuid?.();
const permissionBits = (mode: bigint): number => Number(mode & 0o777n);
const identityOf = (info: { dev: bigint; ino: bigint }): ManagedFileIdentity => ({ dev: String(info.dev), ino: String(info.ino) });
const sameIdentity = (left: ManagedFileIdentity, right: ManagedFileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;

export const assertStagingId = (value: string): string => {
  if (!/^staging_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) throw new SecurityError(`invalid staging id: ${value}`);
  return value;
};

export const assertRunId = (value: string): string => {
  if (!/^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) throw new SecurityError(`invalid run id: ${value}`);
  return value;
};

export const stagingRunDirectory = (root: string, runId: string): string =>
  assertInside(root, join(root, assertRunId(runId)));

const assertStagingSequence = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SecurityError(`invalid staging sequence: ${value}`);
  return value;
};

const assertStagingFilenamePart = (value: string, label: string): string => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new SecurityError(`invalid staging ${label}: ${value}`);
  return value;
};

export const stagingFileName = (sequenceNo: number, kind: StagingKind, role: Role): string =>
  `${String(assertStagingSequence(sequenceNo)).padStart(4, "0")}--${assertStagingFilenamePart(kind, "kind")}--${assertStagingFilenamePart(role, "role")}.json`;

export const stagingFilePath = (root: string, runId: string, sequenceNo: number, kind: StagingKind, role: Role): string =>
  assertInside(root, join(stagingRunDirectory(root, runId), stagingFileName(sequenceNo, kind, role)));

export const ensureManagedDirectory = async (homeRoot: string, directory: string): Promise<void> => {
  assertInside(homeRoot, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new SecurityError(`managed staging path is not a directory: ${directory}`);
  if (currentUid() !== undefined && Number(info.uid) !== currentUid()) throw new SecurityError("managed staging directory is not owned by the current uid");
  if (permissionBits(info.mode) !== 0o700) throw new SecurityError("managed staging directory must have mode 0700");
  const canonicalHome = await realpath(homeRoot);
  const canonicalDirectory = await realpath(directory);
  assertInside(canonicalHome, canonicalDirectory);
};

const inspectManagedFile = async (root: string, path: string): Promise<ManagedFileIdentity> => {
  assertInside(root, path);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new SecurityError("staging content must be a regular file");
  if (info.nlink !== 1n) throw new SecurityError("staging content must have exactly one hard link");
  if (currentUid() !== undefined && Number(info.uid) !== currentUid()) throw new SecurityError("staging content is not owned by the current uid");
  if (permissionBits(info.mode) !== 0o600) throw new SecurityError("staging content must have mode 0600");
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  assertInside(canonicalRoot, canonicalPath);
  const expectedCanonicalPath = resolve(canonicalRoot, relative(resolve(root), resolve(path)));
  if (canonicalPath !== expectedCanonicalPath) throw new SecurityError("staging content canonical path does not match its managed path");
  return identityOf(info);
};

const assertExpectedIdentity = (actual: ManagedFileIdentity, expected?: ManagedFileIdentity): void => {
  if (expected && !sameIdentity(actual, expected)) throw new SecurityError("staging content identity changed unexpectedly");
};

const assertManagedPathMissing = async (root: string, path: string): Promise<void> => {
  assertInside(root, path);
  try {
    await lstat(path);
    throw new SecurityError("staging content path already exists");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
};

export const renameManagedFile = async (
  root: string,
  source: string,
  destination: string,
  expected: ManagedFileIdentity,
): Promise<void> => {
  assertInside(root, source);
  assertInside(root, destination);
  if (dirname(source) !== dirname(destination)) throw new SecurityError("staging rename must remain in the same run directory");
  assertExpectedIdentity(await inspectManagedFile(root, source), expected);
  await assertManagedPathMissing(root, destination);
  await rename(source, destination);
  try {
    assertExpectedIdentity(await inspectManagedFile(root, destination), expected);
    const directoryHandle = await open(dirname(destination), fsConstants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    try { await rename(destination, source); } catch { /* leave the file at its inspected destination for retry */ }
    throw error;
  }
};

export const readManagedJsonFile = async (
  root: string,
  path: string,
  expected?: ManagedFileIdentity,
): Promise<ManagedJsonFile> => {
  const pathIdentity = await inspectManagedFile(root, path);
  assertExpectedIdentity(pathIdentity, expected);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    const descriptorIdentity = identityOf(info);
    assertExpectedIdentity(descriptorIdentity, pathIdentity);
    if (!info.isFile() || info.nlink !== 1n || permissionBits(info.mode) !== 0o600) {
      throw new SecurityError("staging content identity or permissions changed during open");
    }
    if (currentUid() !== undefined && Number(info.uid) !== currentUid()) throw new SecurityError("staging content owner changed during open");
    if (info.size > BigInt(STAGING_MAX_BYTES)) throw new SecurityError(`staging JSON exceeds ${STAGING_MAX_BYTES} bytes`);
    const buffer = await handle.readFile();
    if (buffer.byteLength > STAGING_MAX_BYTES) throw new SecurityError(`staging JSON exceeds ${STAGING_MAX_BYTES} bytes`);
    const text = buffer.toString("utf8");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new SecurityError("staging content is not valid JSON"); }
    return { bytes: buffer.byteLength, digest: sha256(buffer), identity: descriptorIdentity, text, value };
  } finally {
    await handle.close();
  }
};

export const writeManagedJsonFile = async (
  root: string,
  path: string,
  content: string | Buffer,
  expected?: ManagedFileIdentity,
  options: AtomicWriteOptions = {},
): Promise<ManagedJsonFile> => {
  assertInside(root, path);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (buffer.byteLength > STAGING_MAX_BYTES) throw new SecurityError(`staging JSON exceeds ${STAGING_MAX_BYTES} bytes`);
  try { JSON.parse(buffer.toString("utf8")); } catch { throw new SecurityError("staging content is not valid JSON"); }
  if (expected) assertExpectedIdentity(await inspectManagedFile(root, path), expected);
  else await assertManagedPathMissing(root, path);
  await atomicWriteFile(path, buffer, {
    ...(options.beforeReplace ? { beforeReplace: async () => {
      await options.beforeReplace?.();
      if (expected) assertExpectedIdentity(await inspectManagedFile(root, path), expected);
      else await assertManagedPathMissing(root, path);
    } } : expected ? { beforeReplace: async () => {
      assertExpectedIdentity(await inspectManagedFile(root, path), expected);
    } } : { beforeReplace: async () => assertManagedPathMissing(root, path) }),
  });
  return readManagedJsonFile(root, path);
};

export const removeManagedFile = async (
  root: string,
  path: string,
  expected: ManagedFileIdentity,
  beforeRemove?: () => Promise<void> | void,
): Promise<boolean> => {
  try {
    assertExpectedIdentity(await inspectManagedFile(root, path), expected);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await beforeRemove?.();
  assertExpectedIdentity(await inspectManagedFile(root, path), expected);
  const quarantine = join(root, `.${randomBytes(16).toString("hex")}.delete`);
  await rename(path, quarantine);
  try {
    assertExpectedIdentity(await inspectManagedFile(root, quarantine), expected);
    await rm(quarantine);
    const directoryHandle = await open(root, fsConstants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return true;
  } catch (error) {
    try { await rename(quarantine, path); } catch { /* leave the suspect file contained for retry */ }
    throw error;
  }
};
