import { ValidationError } from "./errors.js";

export type CommandValue = string | boolean | undefined;
export interface CommandSpec { required: string[]; optional: string[]; patterns?: Record<string, RegExp>; exclusive?: string[][]; }

const IDS = {
  runId: /^run_[0-9A-HJKMNP-TV-Z]{26}$/,
  dispatchId: /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/,
  planId: /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/,
  revision: /^\d{3}$/,
  commit: /^[a-f0-9]{40}$/,
} as const;

export const COMMAND_SPECS: Record<string, CommandSpec> = {
  "planning.start": { required: ["project"], optional: ["requestFile", "requestStdin"], exclusive: [["requestFile", "requestStdin"]] },
  "coding.start": { required: ["project"], optional: ["mode", "planId", "revision", "requestFile", "requestStdin"], patterns: { planId: IDS.planId, revision: IDS.revision } },
  "dispatch.identity": { required: ["runId", "dispatchId", "role"], optional: [], patterns: { runId: IDS.runId, dispatchId: IDS.dispatchId } },
  "run.identity": { required: ["runId"], optional: [], patterns: { runId: IDS.runId } },
  "review.create": { required: ["runId", "revisionSha"], optional: ["formal"], patterns: { runId: IDS.runId, revisionSha: IDS.commit } },
};

export const validateCommand = (name: string, values: Record<string, CommandValue>): void => {
  const spec = COMMAND_SPECS[name];
  if (!spec) throw new ValidationError(`unknown command contract: ${name}`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError(`${name} has unknown parameters`, unknown);
  const missing = spec.required.filter((key) => values[key] === undefined || values[key] === "");
  if (missing.length) throw new ValidationError(`${name} is missing required parameters`, missing);
  for (const [key, pattern] of Object.entries(spec.patterns ?? {})) {
    const value = values[key]; if (typeof value === "string" && !pattern.test(value)) throw new ValidationError(`${name}.${key} has invalid format`);
  }
  for (const group of spec.exclusive ?? []) {
    if (group.filter((key) => Boolean(values[key])).length !== 1) throw new ValidationError(`${name} requires exactly one of ${group.join(", ")}`);
  }
};
