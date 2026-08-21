import { Command, Option } from "commander";
import { ROLES, STAGING_KINDS } from "../constants.js";
import { validateCommand } from "../command-contract.js";
import { DispatchService, type DispatchPacket } from "../dispatch.js";
import { ValidationError } from "../errors.js";
import type { StateStore, StagingEntry } from "../state.js";

export const roleOption = (): Option => new Option("--role <role>").choices([...ROLES]).makeOptionMandatory();

export const jsonOptions = (command: Command, fileFlag: string): Command => command.option(`${fileFlag} <file>`).option("--staging-id <id>").option("--input-stdin");

interface StagingDependencies {
  output(value: unknown, options?: { legacyRaw?: boolean }): void;
  withStore<T>(action: (store: StateStore) => Promise<T> | T, options?: { readonly?: boolean }): Promise<T>;
  readStdinJson(): Promise<Buffer>;
  retentionHours(): Promise<number>;
}

interface DispatchDependencies extends StagingDependencies {
  jsonOptions(command: Command, fileFlag: string): Command;
  loadJsonInput(store: StateStore, input: any, retentionHours: number): Promise<any>;
  withStagingResult<T>(result: T, entry?: StagingEntry): unknown;
}

export const registerStagingCommands = (program: Command, dependencies: StagingDependencies): void => {
  const { output, withStore, readStdinJson, retentionHours } = dependencies;
  const staging = program.command("staging");
  staging.command("create").requiredOption("--run-id <id>").addOption(roleOption()).addOption(new Option("--kind <kind>").choices([...STAGING_KINDS]).makeOptionMandatory()).option("--dispatch-id <id>").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      let initialJson: string | undefined;
      if (options.kind === "dispatch-result") {
        if (!options.dispatchId) throw new ValidationError("dispatch-result staging requires --dispatch-id");
        initialJson = `${JSON.stringify(new DispatchService(store).template(options.runId, options.dispatchId, options.role), null, 2)}\n`;
      }
      return store.createStagingEntry({
        runId: options.runId,
        ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}),
        role: options.role,
        kind: options.kind,
        ...(initialJson ? { initialJson } : {}),
        retentionHours: retention,
      });
    }));
  });
  staging.command("write").requiredOption("--run-id <id>").addOption(roleOption()).requiredOption("--staging-id <id>").requiredOption("--input-stdin").action(async (options) => {
    const content = await readStdinJson();
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      try { return await store.writeStagingEntry(options.stagingId, content, { runId: options.runId, role: options.role }, undefined, retention); }
      catch (error) {
        try { store.recordStagingValidationFailure(options.stagingId, { runId: options.runId, role: options.role }, error); } catch { /* do not mask the write error */ }
        throw error;
      }
    }));
  });
  staging.command("show").requiredOption("--run-id <id>").addOption(roleOption()).option("--staging-id <id>").option("--content").action(async (options) => output(await withStore(async (store) => {
    if (!options.stagingId) {
      if (options.content) throw new ValidationError("--content requires --staging-id");
      return { entries: store.listStagingEntries(options.runId, options.role) };
    }
    if (!options.content) {
      const entry = store.getStagingEntry(options.stagingId);
      if (entry.runId !== options.runId || entry.role !== options.role) throw new ValidationError("staging identity does not match run and role");
      return { entry };
    }
    const result = await store.readStagingEntry(options.stagingId, { runId: options.runId, role: options.role });
    return { entry: result.entry, content: result.value };
  })));
  staging.command("cancel").requiredOption("--run-id <id>").addOption(roleOption()).requiredOption("--staging-id <id>").requiredOption("--reason <text>").action(async (options) => {
    output(await withStore((store) => store.cancelStagingEntry(options.stagingId, { runId: options.runId, role: options.role }, options.reason)));
  });
  staging.command("cleanup").option("--expired").option("--run-id <id>").option("--staging-id <id>").option("--all").action(async (options) => {
    const explicit = Boolean(options.runId || options.stagingId);
    if (Boolean(options.expired) === explicit || explicit && !options.all || options.stagingId && !options.runId) throw new ValidationError("use --expired, or --run-id [--staging-id] --all");
    const retention = await retentionHours();
    output(await withStore((store) => store.cleanupStagingEntries({
      ...(options.expired ? { expired: true } : { runId: options.runId, ...(options.stagingId ? { stagingId: options.stagingId } : {}), all: true }),
      retentionHours: retention,
    })));
  });
};

export const registerDispatchCommands = (program: Command, dependencies: DispatchDependencies): void => {
  const { output, withStore, retentionHours, jsonOptions, loadJsonInput, withStagingResult } = dependencies;
  const dispatch = program.command("dispatch");
  jsonOptions(dispatch.command("create").requiredOption("--run-id <id>").addOption(roleOption()).addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).option("--actor-dispatch-id <id>"), "--packet-file").action(async (options) => {
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.packetFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, dispatchId: options.actorDispatchId, role: options.actorRole, kind: "dispatch-packet" }, retention);
      try {
        if ((options.actorRole === "coding" || options.actorRole === "code-reviewer") && !options.actorDispatchId) throw new ValidationError(`${options.actorRole} dispatch creation requires --actor-dispatch-id`);
        const packet = input.value as DispatchPacket;
        if (options.actorRole === "coding" && options.role !== "file-explorer" && !packet?.context?.explorer_dispatch_id) throw new ValidationError("downstream dispatch requires packet context.explorer_dispatch_id");
        const result = { dispatch_id: new DispatchService(store).create(options.runId, options.role, packet, options.actorRole, options.actorDispatchId) };
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });
  const dispatchCommand = (name: string): Command => dispatch.command(name).requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>").addOption(roleOption()).hook("preAction", (_command, action) => validateCommand("dispatch.identity", { runId: action.opts().runId, dispatchId: action.opts().dispatchId, role: action.opts().role }));
  dispatchCommand("claim").option("--bundle").action(async (options) => output(await withStore((store) => {
    const service = new DispatchService(store);
    return options.bundle ? service.claimBundle(options.runId, options.dispatchId, options.role) : service.claim(options.runId, options.dispatchId, options.role);
  })));
  dispatchCommand("cancel").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).cancel(options.runId, options.dispatchId, options.role, options.actorRole, options.reason))));
  dispatchCommand("reissue").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).reissue(options.runId, options.dispatchId, options.role, options.actorRole, options.reason))));
  dispatchCommand("reconcile").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>").option("--staging-id <id>")
    .action(async (options) => {
      const retention = await retentionHours();
      output(await withStore(async (store) => {
        const service = new DispatchService(store);
        const reconciliation = service.reconcile(options.runId, options.dispatchId, options.role, options.actorRole, options.reason);
        if (!options.stagingId) return reconciliation;
        if (!reconciliation.resumed_finalization) throw new ValidationError("--staging-id is only valid for verified finalization reconciliation");
        const input = await loadJsonInput(store, { stagingId: options.stagingId, runId: options.runId, dispatchId: options.dispatchId, role: options.role, kind: "dispatch-result" }, retention);
        try {
          const submission = await service.submitValue(options.runId, options.dispatchId, options.role, input.value);
          return { reconciliation, submission, staging: await input.consume() };
        } catch (error) { input.validationFailed(error); }
      }));
    });
  jsonOptions(dispatchCommand("supersede").addOption(new Option("--actor-role <role>").choices([...ROLES]).makeOptionMandatory()).requiredOption("--reason <text>"), "--packet-file")
    .action(async (options) => {
      const retention = await retentionHours();
      output(await withStore(async (store) => {
        const input = await loadJsonInput(store, { file: options.packetFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: options.actorRole, kind: "dispatch-packet" }, retention);
        try {
          const result = new DispatchService(store).supersede(options.runId, options.dispatchId, options.role, options.actorRole, options.reason, input.value as DispatchPacket);
          return withStagingResult(result, await input.consume());
        } catch (error) { input.validationFailed(error); }
      }));
    });
  dispatchCommand("recover-claimed-task-scope").requiredOption("--authority-commit <sha>").requiredOption("--expected-head <sha>").requiredOption("--add-write-path <path...>")
    .action(async (options) => output(await withStore((store) => new DispatchService(store).recoverClaimedTaskScope({
      runId: options.runId,
      dispatchId: options.dispatchId,
      authorityCommit: options.authorityCommit,
      expectedHead: options.expectedHead,
      addedWritePaths: options.addWritePath,
    }))));
  dispatch.command("repair-claimed-task-scope-replacement").requiredOption("--run-id <id>").requiredOption("--dispatch-id <id>")
    .action(async (options) => {
      validateCommand("dispatch.repair-claimed-task-scope-replacement", { runId: options.runId, dispatchId: options.dispatchId });
      output(await withStore((store) => new DispatchService(store).repairClaimedTaskScopeReplacement({
        runId: options.runId,
        dispatchId: options.dispatchId,
      })));
    });
  dispatchCommand("prompt").action(async (options) => output(await withStore((store) => new DispatchService(store).prompt(options.runId, options.dispatchId, options.role), { readonly: true }), { legacyRaw: true }));
  dispatchCommand("schema").action(async (options) => output(await withStore((store) => new DispatchService(store).schema(options.runId, options.dispatchId, options.role), { readonly: true })));
  dispatchCommand("template").action(async (options) => output(await withStore((store) => new DispatchService(store).template(options.runId, options.dispatchId, options.role), { readonly: true })));
  dispatchCommand("packet-schema").action(async (options) => output(await withStore((store) => new DispatchService(store).packetSchema(options.runId, options.dispatchId, options.role), { readonly: true })));
  dispatchCommand("packet-template").action(async (options) => output(await withStore((store) => new DispatchService(store).packetTemplate(options.runId, options.dispatchId, options.role), { readonly: true })));
  jsonOptions(dispatchCommand("validate"), "--result-file").action(async (options) => {
    if (options.resultFile && (options.stagingId || options.inputStdin)) throw new ValidationError("provide exactly one JSON file option, --staging-id, or --input-stdin");
    if (options.resultFile) { output({ valid: true, result: await withStore((store) => new DispatchService(store).validateFile(options.runId, options.dispatchId, options.role, options.resultFile), { readonly: true }) }); return; }
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, dispatchId: options.dispatchId, role: options.role, kind: "dispatch-result" }, retention);
      try { return withStagingResult({ valid: true, result: new DispatchService(store).validateValue(options.runId, options.dispatchId, options.role, input.value) }, input.entry); }
      catch (error) { input.validationFailed(error); }
    }));
  });
  jsonOptions(dispatchCommand("submit"), "--result-file").action(async (options) => {
    if (options.resultFile && !options.stagingId && !options.inputStdin) {
      output(await withStore((store) => new DispatchService(store).submit(options.runId, options.dispatchId, options.role, options.resultFile)));
      return;
    }
    if (options.stagingId && !options.resultFile && !options.inputStdin) {
      output(await withStore((store) => new DispatchService(store).submitStaging(options.runId, options.dispatchId, options.role, options.stagingId)));
      return;
    }
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.resultFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, dispatchId: options.dispatchId, role: options.role, kind: "dispatch-result" }, retention);
      try {
        const result = await new DispatchService(store).submitValue(options.runId, options.dispatchId, options.role, input.value);
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });
};
