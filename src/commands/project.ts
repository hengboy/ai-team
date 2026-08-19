import type { Command } from "commander";
import { validateCommand } from "../command-contract.js";
import { CONTRACT_DIGEST } from "../contracts.js";
import { updateProjectContext, validateProjectContext } from "../context.js";
import { ValidationError } from "../errors.js";
import { initializeProject } from "../project.js";
import { ROLE_MANIFEST_DIGEST } from "../roles.js";
import type { StateStore } from "../state.js";
import { repositoryIdentity, worktreeStatus } from "../git.js";

type Output = (value: unknown) => void;

export const registerProjectInit = (program: Command, output: Output): void => {
  program.command("init").argument("<project>").option("--yes", "confirm patches to dirty project files")
    .action(async (project, options) => output(await initializeProject(project, options.yes)));
};

interface ProjectDependencies {
  output: Output;
  withStore<T>(action: (store: StateStore) => Promise<T> | T): Promise<T>;
  jsonOptions(command: Command, fileFlag: string): Command;
  retentionHours(): Promise<number>;
  loadJsonInput(store: StateStore, input: any, retentionHours: number): Promise<any>;
  withStagingResult<T>(result: T, entry?: unknown): unknown;
}

export const registerProjectCommands = (program: Command, dependencies: ProjectDependencies): void => {
  const { output, withStore, jsonOptions, retentionHours, loadJsonInput, withStagingResult } = dependencies;
  registerProjectInit(program, output);
  const context = program.command("context");
  jsonOptions(context.command("update").requiredOption("--project <path>").option("--run-id <id>"), "--context-file").action(async (options) => {
    validateCommand("context.update", { project: options.project, contextFile: options.contextFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId });
    const retention = await retentionHours();
    output(await withStore(async (store) => {
      const input = await loadJsonInput(store, { file: options.contextFile, stagingId: options.stagingId, inputStdin: options.inputStdin, runId: options.runId, role: "file-explorer", kind: "project-context" }, retention);
      try {
        if (options.stagingId || options.inputStdin) {
          const repo = await repositoryIdentity(options.project);
          const run = store.getRun(options.runId) as { repo_id: string };
          if (run.repo_id !== repo.repoId) throw new ValidationError("project context staging run does not belong to this repository");
        }
        const source = input.value as Record<string, unknown>;
        const value = source.payload && typeof source.payload === "object" && !Array.isArray(source.payload)
          ? (source.payload as Record<string, unknown>).project_context ?? source
          : source;
        const result = await updateProjectContext(options.project, value);
        return withStagingResult(result, await input.consume());
      } catch (error) { input.validationFailed(error); }
    }));
  });
  context.command("validate").requiredOption("--project <path>").action(async (options) => {
    validateCommand("context.validate", { project: options.project });
    output(await validateProjectContext(options.project));
  });
  program.command("status").option("--project <path>", "project path", process.cwd()).action(async ({ project }) => {
    validateCommand("status", { project });
    const repo = await repositoryIdentity(project);
    output({ repository: repo, worktree: await worktreeStatus(repo.root), contract_digest: CONTRACT_DIGEST, role_manifest_digest: ROLE_MANIFEST_DIGEST });
  });
};

export const registerProjectStatus = (program: Command, output: Output): void => {
  program.command("status").option("--project <path>", "project path", process.cwd()).action(async ({ project }) => {
    output({ repository: repositoryIdentity(project), worktree: worktreeStatus(project) });
  });
};
