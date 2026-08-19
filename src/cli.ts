#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CONTRACT_DIGEST } from "./contracts.js";
import { EXIT, PACKAGE_VERSION, ROLES, STAGING_MAX_BYTES, type Role, type StagingKind } from "./constants.js";
import { DispatchService } from "./dispatch.js";
import { EnvironmentService } from "./environment.js";
import { AiTeamError, ValidationError, validationCause } from "./errors.js";
import { ROLE_MANIFEST_DIGEST } from "./roles.js";
import { AGENT_BUILD } from "./roles.js";
import { StateStore, type StagingBinding, type StagingEntry } from "./state.js";
import { assertReadablePath } from "./security.js";
import { registerEnvironmentCommands } from "./commands/environment.js";
import { registerProjectCommands } from "./commands/project.js";
import { reconcilePlanningCommit, registerDecisionResearchCommands, registerPlanningCommands, registerRunCommands } from "./commands/planning-run.js";
import { jsonOptions, registerDispatchCommands, registerStagingCommands } from "./commands/staging-dispatch.js";
import { registerGitCommands, registerReviewCommands } from "./commands/git-review.js";
import { InvocationResources, setInvocationResources, type ShutdownSignal } from "./resource-registry.js";
import { EVENT_SCHEMA_VERSION } from "./state.js";
import { EXECUTION_CONTRACT_SCHEMA_VERSION } from "./execution-contract.js";
import { HUMAN_RENDERER_VERSION, renderHuman } from "./human-renderer.js";
import { validateCommand } from "./command-contract.js";

let humanOutput = false;
let legacyOutput = false;
let invocation: InvocationResources | undefined;
const output = (value: unknown, options: { legacyRaw?: boolean } = {}): void => {
  if (legacyOutput && options.legacyRaw) { process.stdout.write(`${String(value)}\n`); return; }
  if (humanOutput) { process.stdout.write(`${renderHuman(value)}\n`); return; }
  const envelope = {
    ok: true,
    data: value,
    ...(legacyOutput && value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}),
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
};
const withStore = async <T>(action: (store: StateStore) => Promise<T> | T, options: { readonly?: boolean } = {}): Promise<T> => {
  invocation?.assertRunning();
  const store = await StateStore.open(undefined, options);
  const unregister = invocation?.registerStore(store);
  try { return await action(store); } finally {
    if (invocation?.quiescing) await invocation.quiesce(); else await store.closeAsync();
    unregister?.();
  }
};


const readSafeFile = async (path: string): Promise<string> => {
  assertReadablePath(path);
  const value = await readFile(path, "utf8");
  if (value.length > 2 * 1024 * 1024) throw new ValidationError("input file exceeds the 2 MiB limit");
  return value;
};

const readStdinJson = async (): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > STAGING_MAX_BYTES) throw new ValidationError("staging JSON exceeds the 2 MiB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

interface JsonInput {
  file?: string;
  stagingId?: string;
  inputStdin?: boolean;
  runId?: string;
  dispatchId?: string | null;
  role?: Role;
  roleFromValue?: (value: unknown) => Role;
  kind: StagingKind;
  readOnly?: boolean;
}

interface LoadedJson {
  value: unknown;
  entry?: StagingEntry;
  binding: StagingBinding;
  consume: (binding?: StagingBinding) => Promise<StagingEntry | undefined>;
  validationFailed: (error: unknown, binding?: StagingBinding) => never;
}

const stagingResult = (entry: StagingEntry): { staging_id: string; state: string; content_digest: string | null } => ({
  staging_id: entry.stagingId,
  state: entry.state,
  content_digest: entry.contentDigest,
});

const withStagingResult = <T>(result: T, entry?: StagingEntry): T | (T & { staging: ReturnType<typeof stagingResult> }) =>
  entry && result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, staging: stagingResult(entry) }
    : result;

const throwStagingFailure = (store: StateStore, entry: StagingEntry, error: unknown): never => {
  try { store.recordStagingValidationFailure(entry.stagingId, { runId: entry.runId, role: entry.role, kind: entry.kind }, error); }
  catch { /* do not mask the validation error */ }
  const current = store.getStagingEntry(entry.stagingId);
  const failure = error instanceof AiTeamError ? error : new ValidationError(error instanceof Error ? error.message : String(error));
  throw new AiTeamError(failure.message, failure.code, {
    cause: validationCause(failure),
    staging_id: current.stagingId,
    state: current.state,
  });
};

const loadJsonInput = async (store: StateStore, input: JsonInput, retentionHours: number): Promise<LoadedJson> => {
  const sourceCount = [input.file, input.stagingId, input.inputStdin].filter(Boolean).length;
  if (sourceCount !== 1) throw new ValidationError("provide exactly one JSON file option, --staging-id, or --input-stdin");
  if (input.file) {
    return {
      value: JSON.parse(await readSafeFile(input.file)),
      binding: {},
      consume: async () => undefined,
      validationFailed: (error) => { throw error; },
    };
  }
  if (!input.runId) throw new ValidationError("--run-id is required with --staging-id or --input-stdin");
  if (input.inputStdin) {
    let entry: StagingEntry | undefined;
    try {
      if (input.role) {
        const initialJson = input.kind === "dispatch-result" && input.dispatchId
          ? `${JSON.stringify(new DispatchService(store).template(input.runId, input.dispatchId, input.role), null, 2)}\n`
          : undefined;
        entry = await store.createStagingEntry({
          runId: input.runId,
          ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
          role: input.role,
          kind: input.kind,
          ...(initialJson ? { initialJson } : {}),
          retentionHours,
        });
      }
      const content = await readStdinJson();
      const value = JSON.parse(content.toString("utf8")) as unknown;
      if (!entry) {
        const role = input.roleFromValue?.(value);
        if (!role) throw new ValidationError("--input-stdin requires a resolvable staging role");
        entry = await store.createStagingEntry({ runId: input.runId, role, kind: input.kind, retentionHours });
      }
      entry = await store.writeStagingEntry(entry.stagingId, content, { runId: input.runId, role: entry.role, kind: input.kind }, undefined, retentionHours);
      const binding: StagingBinding = {
        runId: input.runId,
        ...(input.dispatchId !== undefined ? { dispatchId: input.dispatchId } : {}),
        role: entry.role,
        kind: input.kind,
      };
      return {
        value,
        entry,
        binding,
        consume: async (extra = {}) => store.consumeStagingEntry(entry!.stagingId, { ...binding, ...extra }, new Date(), retentionHours),
        validationFailed: (error, extra = {}) => {
          if (extra.role && extra.role !== entry!.role) {
            throwStagingFailure(store, entry!, new ValidationError("staging role binding does not match"));
          }
          return throwStagingFailure(store, entry!, error);
        },
      };
    } catch (error) {
      if (entry) throwStagingFailure(store, entry, error);
      throw error;
    }
  }
  const binding: StagingBinding = {
    runId: input.runId,
    ...(input.dispatchId !== undefined ? { dispatchId: input.dispatchId } : {}),
    ...(input.role ? { role: input.role } : {}),
    kind: input.kind,
  };
  const stagingId = input.stagingId!;
  let loaded;
  try { loaded = input.readOnly ? await store.inspectStagingEntry(stagingId, binding) : await store.readStagingEntry(stagingId, binding); }
  catch (error) {
    if (!input.readOnly) try { store.recordStagingValidationFailure(stagingId, binding, error); } catch { /* do not mask the validation error */ }
    throw error;
  }
  return {
    value: loaded.value,
    entry: loaded.entry,
    binding,
    consume: async (extra = {}) => store.consumeStagingEntry(stagingId, { ...binding, ...extra }, new Date(), retentionHours),
    validationFailed: (error) => throwStagingFailure(store, loaded.entry, error),
  };
};

const retentionHours = (): Promise<number> => new EnvironmentService().stagingRetentionHours();


export const buildProgram = (): Command => {
  const program = new Command().exitOverride().name("ai-team").description("Local AI coding team workflow orchestration").version(PACKAGE_VERSION)
    .option("--human", "render human-readable output")
    .option("--legacy-output", "include legacy top-level success fields");
  program.configureOutput({ outputError: () => {} });

  registerProjectCommands(program, { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult });

  registerPlanningCommands(program, { output, withStore, readSafeFile, jsonOptions, retentionHours, loadJsonInput, withStagingResult });

  registerRunCommands(program, { output, withStore, readSafeFile });

  registerStagingCommands(program, { output, withStore, readStdinJson, retentionHours });

  registerDispatchCommands(program, { output, withStore, readStdinJson, retentionHours, jsonOptions, loadJsonInput, withStagingResult });

  registerGitCommands(program, { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult, reconcilePlanningCommit });

  registerDecisionResearchCommands(program, { output, withStore, readSafeFile, jsonOptions, retentionHours, loadJsonInput, withStagingResult });

  registerReviewCommands(program, { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult });

  registerEnvironmentCommands(program, output);

  program.command("contract").description("Print the installed contract metadata").action(() => {
    validateCommand("contract", {});
    output({
    contract_digest: CONTRACT_DIGEST,
    role_manifest_digest: ROLE_MANIFEST_DIGEST,
    agent_build_digest: AGENT_BUILD.digest,
    template_version: AGENT_BUILD.templateVersion,
    event_schema_version: EVENT_SCHEMA_VERSION,
    execution_contract_schema_version: EXECUTION_CONTRACT_SCHEMA_VERSION,
    human_renderer_version: HUMAN_RENDERER_VERSION,
    roles: ROLES,
    });
  });
  return program;
};

export const main = async (argv = process.argv): Promise<void> => {
  humanOutput = argv.includes("--human");
  legacyOutput = argv.includes("--legacy-output");
  invocation = new InvocationResources();
  setInvocationResources(invocation);
  let receivedSignal: ShutdownSignal | undefined;
  const onSignal = (signal: ShutdownSignal): void => {
    if (receivedSignal) { invocation?.force(); return; }
    receivedSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void invocation?.quiesce();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try { await buildProgram().parseAsync(argv); }
  catch (error) {
    if (error instanceof AiTeamError) {
      const failure = { ok: false, error: error.message, details: error.details ?? null, code: error.code };
      process.stderr.write(`${humanOutput ? renderHuman(failure) : JSON.stringify(failure)}\n`);
      process.exitCode = error.code; return;
    }
    const commander = error as { code?: string; exitCode?: number; message?: string };
    if (commander.code?.startsWith("commander.")) {
      if (commander.exitCode === EXIT.ok) return;
      const failure = { ok: false, error: commander.message ?? commander.code, details: null, code: EXIT.args };
      process.stderr.write(`${humanOutput ? renderHuman(failure) : JSON.stringify(failure)}\n`);
      process.exitCode = EXIT.args; return;
    }
    const failure = { ok: false, error: error instanceof Error ? error.message : String(error), details: null, code: EXIT.internal };
    process.stderr.write(`${humanOutput ? renderHuman(failure) : JSON.stringify(failure)}\n`); process.exitCode = EXIT.internal;
  } finally {
    await invocation.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    setInvocationResources(undefined);
    invocation = undefined;
  }
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
