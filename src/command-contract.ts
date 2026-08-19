import { ArgumentError, ValidationError } from "./errors.js";
import { SCHEMA_VERSION } from "./constants.js";

/** Values accepted by the CLI command guards. */
export type CommandValue = string | boolean | undefined;

/** The typed portion of the command contract used by Commander and agents. */
export interface CommandSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly patterns?: Readonly<Record<string, RegExp>>;
  readonly exclusive?: readonly (readonly string[])[];
  readonly syntax?: readonly string[];
}

const IDS = {
  runId: /^run_[0-9A-HJKMNP-TV-Z]{26}$/,
  dispatchId: /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/,
  stagingId: /^staging_[0-9A-HJKMNP-TV-Z]{26}$/,
  planId: /^(?!.*-[a-f0-9]{4}$)\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  revision: /^\d{3}$/,
  commit: /^[a-f0-9]{40}$/,
} as const;

/** Stable parameter vocabulary rendered into every generated agent manual. */
export const COMMAND_PARAMETER_TYPES = Object.freeze({
  path: "string; canonical local filesystem path",
  file: "string; readable file path",
  json: "string; readable JSON file path",
  name: "string; lowercase environment name matching ^[a-z][a-z0-9-]*$",
  role: "enum; one of the 12 manifest role IDs",
  platform: "enum; codex, claude, or opencode",
  mode: "enum; planned, bug, or feature",
  "platform-list": "comma-separated enum; codex, claude, or opencode",
  "plan-id": "string; eight decimal digits followed by a lowercase slug that does not end with four hexadecimal digits",
  revision: "string; exactly three decimal digits",
  "task-id": "string; TASK- followed by three decimal digits",
  "run-id": "string; run_ followed by a 26-character Crockford ULID",
  "dispatch-id": "string; dispatch_ followed by a 26-character Crockford ULID",
  "staging-id": "string; staging_ followed by a 26-character Crockford ULID",
  kind: "enum; one of the 10 managed staging JSON kinds",
  commit: "string; exactly 40 lowercase hexadecimal characters",
  "opaque-id": "string; CLI-issued identifier",
  branch: "string; Git branch name",
  state: "enum; planning state, or Git reconciliation state completed, not_applied, or conflicted",
  stage: "enum; triage, pre_write, or pre_commit",
  paths: "comma-separated repository-relative POSIX paths",
  boolean: "boolean; presence of the flag means true",
  text: "non-empty string",
} as const);

/** Exact command spellings. This is the only syntax table used by renderers. */
export const COMMAND_SYNTAX: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "planning start": ["ai-team planning start --project <path> (--request-file <file> | --request-stdin)"],
  "context update": ["ai-team context update --project <path> (--context-file <json> | --run-id <run-id> (--staging-id <staging-id> | --input-stdin))"],
  "context validate": ["ai-team context validate --project <path>"],
  "planning revision create": ["ai-team planning revision create --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> (--documents-file <file> | --run-id <run-id> (--staging-id <staging-id> | --input-stdin)) [--supersedes <revision>]"],
  "planning revision validate": ["ai-team planning revision validate --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> (--documents-file <file> | --run-id <run-id> (--staging-id <staging-id> | --input-stdin)) [--supersedes <revision>]"],
  "planning revision transition": ["ai-team planning revision transition --project <path> --plan-id <plan-id> --revision <revision> --to <state> [--plan-commit <commit>]"],
  "planning revision commit": ["ai-team planning revision commit --project <path> --plan-id <plan-id> --revision <revision> --run-id <run-id> --dispatch-id <dispatch-id>"],
  "planning tasks validate": ["ai-team planning tasks validate (--file <json> | --run-id <run-id> (--staging-id <staging-id> | --input-stdin)) [--preview]"],
  "coding start": [
    "ai-team coding start --project <path> --mode planned --plan-id <plan-id> [--revision <revision>]",
    "ai-team coding start --project <path> --mode bug (--request-file <file> | --request-stdin)",
    "ai-team coding start --project <path> --mode feature (--request-file <file> | --request-stdin)",
  ],
  "dispatch create": ["ai-team dispatch create --run-id <run-id> --role <role> --actor-role <role> [--actor-dispatch-id <dispatch-id>] (--packet-file <json> | --staging-id <staging-id> | --input-stdin)"],
  "dispatch claim": ["ai-team dispatch claim --run-id <run-id> --dispatch-id <dispatch-id> --role <role> [--bundle]"],
  "dispatch cancel": ["ai-team dispatch cancel --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text>"],
  "dispatch reissue": ["ai-team dispatch reissue --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text>"],
  "dispatch reconcile": ["ai-team dispatch reconcile --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text> [--staging-id <staging-id>]"],
  "dispatch supersede": ["ai-team dispatch supersede --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text> (--packet-file <json> | --staging-id <staging-id> | --input-stdin)"],
  "dispatch prompt": ["ai-team dispatch prompt --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch schema": ["ai-team dispatch schema --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch template": ["ai-team dispatch template --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch packet-schema": ["ai-team dispatch packet-schema --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch packet-template": ["ai-team dispatch packet-template --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"],
  "dispatch validate": ["ai-team dispatch validate --run-id <run-id> --dispatch-id <dispatch-id> --role <role> (--result-file <json> | --staging-id <staging-id> | --input-stdin)"],
  "dispatch submit": ["ai-team dispatch submit --run-id <run-id> --dispatch-id <dispatch-id> --role <role> (--result-file <json> | --staging-id <staging-id> | --input-stdin)"],
  "decision create": ["ai-team decision create --run-id <run-id> --dispatch-id <dispatch-id> (--file <json> | --staging-id <staging-id> | --input-stdin)"],
  "decision schema": ["ai-team decision schema"],
  "decision template": ["ai-team decision template"],
  "staging create": ["ai-team staging create --run-id <run-id> --role <role> --kind <kind> [--dispatch-id <dispatch-id>]"],
  "staging write": ["ai-team staging write --run-id <run-id> --role <role> --staging-id <staging-id> --input-stdin"],
  "staging show": ["ai-team staging show --run-id <run-id> --role <role> [--staging-id <staging-id>] [--content]"],
  "staging cleanup": ["ai-team staging cleanup --expired", "ai-team staging cleanup --run-id <run-id> [--staging-id <staging-id>] --all"],
  "run show": ["ai-team run show <run-id>"],
  "run resume": ["ai-team run resume <run-id>"],
  "run cancel": ["ai-team run cancel <run-id> --reason <text>"],
  "run decide": ["ai-team run decide --run-id <run-id> --decision-id <opaque-id> --choice <text> [--note-file <file>]"],
  "scope check": ["ai-team scope check --run-id <run-id> --stage <stage> --paths <paths> [--worktree-id <worktree-id>]"],
  "review create": ["ai-team review create --run-id <run-id> --revision-sha <commit> [--formal]"],
  "review schema": ["ai-team review schema"],
  "review resolution-schema": ["ai-team review resolution-schema"],
  "review resolution-template": ["ai-team review resolution-template"],
  "review submit": ["ai-team review submit --run-id <run-id> --barrier-id <opaque-id> ((--result-file <json> | --staging-id <staging-id>) | --role <role> --input-stdin)"],
  "review resolve": ["ai-team review resolve --run-id <run-id> --barrier-id <opaque-id> (--resolution-file <json> | --staging-id <staging-id> | --input-stdin)"],
  "review status": ["ai-team review status --run-id <run-id> (--barrier-id <opaque-id> | --revision-sha <commit>)"],
  "git status": ["ai-team git status --run-id <run-id>"],
  "git prepare": ["ai-team git prepare --run-id <run-id> --dispatch-id <dispatch-id> [--task-id <task-id>] [--integration] [--base-commit <commit>] [--depends-on <opaque-id>]"],
  "git adopt": [
    "ai-team git adopt --run-id <run-id> --dispatch-id <dispatch-id> --commit <commit> [--task-id <task-id>]",
    "ai-team git adopt --run-id <run-id> --dispatch-id <dispatch-id> --path <path> --branch <branch> --base-commit <commit> [--commit <commit>]",
  ],
  "git transfer": ["ai-team git transfer --run-id <run-id> --dispatch-id <dispatch-id> --worktree-id <opaque-id>"],
  "git commit": ["ai-team git commit --run-id <run-id> --dispatch-id <dispatch-id> --worktree-id <opaque-id> --message <text> --scope <paths>"],
  "git merge-task": ["ai-team git merge-task --run-id <run-id> --dispatch-id <dispatch-id> --integration-id <opaque-id> --task-id <task-id>"],
  "git continue-conflict": ["ai-team git continue-conflict --run-id <run-id> --dispatch-id <dispatch-id> --integration-id <opaque-id> --scope <paths>"],
  "git integrate": ["ai-team git integrate --run-id <run-id> --dispatch-id <dispatch-id> --integration-id <opaque-id>"],
  "git reconcile": ["ai-team git reconcile --run-id <run-id> --dispatch-id <dispatch-id> [--operation-id <opaque-id> --state <state> (--evidence-file <json> | --staging-id <staging-id> | --input-stdin)]"],
  "git cleanup": ["ai-team git cleanup --run-id <run-id> --dispatch-id <dispatch-id>"],
  "research archive": ["ai-team research archive --run-id <run-id> --project <path> --topic <text> (--report-file <json> | --staging-id <staging-id> | --input-stdin)"],
  install: ["ai-team install [--platform <platform-list>] [--dry-run]"],
  "env list": ["ai-team env list"],
  "env show": ["ai-team env show <name> [--resolved]"],
  "env validate": ["ai-team env validate <name>"],
  "env explain": ["ai-team env explain <name> --role <role> --platform <platform>"],
  "env diff": ["ai-team env diff <from> <to> [--role <role>] [--platform <platform>]"],
  "env edit": ["ai-team env edit <name>"],
  "env generate": ["ai-team env generate [--platform <platform-list>] [--dry-run]"],
  "env switch": ["ai-team env switch <name> [--dry-run]"],
  "env status": ["ai-team env status"],
  "env doctor": ["ai-team env doctor [--probe]"],
  "backup restore": ["ai-team backup restore <path> [--dry-run]"],
  uninstall: ["ai-team uninstall [--dry-run]"],
});

/** Agent manuals only expose managed staging for JSON produced during a run. */
const AGENT_COMMAND_SYNTAX_OVERRIDES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "context update": ["ai-team context update --project <path> --run-id <run-id> --input-stdin"],
  "planning revision create": ["ai-team planning revision create --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> --run-id <run-id> --input-stdin [--supersedes <revision>]"],
  "planning revision validate": ["ai-team planning revision validate --project <path> --plan-id <plan-id> --revision <revision> --target-branch <branch> --run-id <run-id> --staging-id <staging-id> [--supersedes <revision>]"],
  "planning tasks validate": ["ai-team planning tasks validate --run-id <run-id> --input-stdin [--preview]"],
  "dispatch create": ["ai-team dispatch create --run-id <run-id> --role <role> --actor-role <role> [--actor-dispatch-id <dispatch-id>] --input-stdin"],
  "dispatch claim": ["ai-team dispatch claim --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --bundle"],
  "dispatch supersede": ["ai-team dispatch supersede --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text> --input-stdin"],
  "dispatch validate": ["ai-team dispatch validate --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --staging-id <staging-id>"],
  "dispatch submit": ["ai-team dispatch submit --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --staging-id <staging-id>"],
  "decision create": ["ai-team decision create --run-id <run-id> --dispatch-id <dispatch-id> --input-stdin"],
  "review submit": ["ai-team review submit --run-id <run-id> --barrier-id <opaque-id> --role <role> --input-stdin"],
  "review resolve": ["ai-team review resolve --run-id <run-id> --barrier-id <opaque-id> --input-stdin"],
  "git reconcile": ["ai-team git reconcile --run-id <run-id> --dispatch-id <dispatch-id> [--operation-id <opaque-id> --state <state> --input-stdin]"],
  "research archive": ["ai-team research archive --run-id <run-id> --project <path> --topic <text> --input-stdin"],
});

const PUBLIC_COMMANDS = ["init", "install", "status", "context update", "context validate", "planning start", "coding start", "run show", "run resume", "run cancel", "run decide", "env list", "env show", "env validate", "env explain", "env diff", "env edit", "env generate", "env switch", "env status", "env doctor", "backup restore", "uninstall"] as const;
const AGENT_COMMANDS = ["context update", "context validate", "planning revision validate", "planning revision create", "planning revision transition", "planning revision commit", "planning tasks validate", "dispatch create", "dispatch claim", "dispatch cancel", "dispatch reissue", "dispatch reconcile", "dispatch supersede", "dispatch prompt", "dispatch schema", "dispatch template", "dispatch packet-schema", "dispatch packet-template", "dispatch validate", "dispatch submit", "decision create", "decision schema", "decision template", "staging create", "staging write", "staging show", "staging cleanup", "scope check", "git status", "git prepare", "git adopt", "git transfer", "git commit", "git merge-task", "git integrate", "git reconcile", "git cleanup", "research archive", "review create", "review submit", "review resolution-schema", "review resolution-template", "review resolve", "review status"] as const;

/** Runtime guards for commands whose values are consumed as an identity. */
export const COMMAND_VALIDATORS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  "context.update": { required: ["project"], optional: ["contextFile", "stagingId", "inputStdin", "runId"], exclusive: [["contextFile", "stagingId", "inputStdin"]], patterns: { stagingId: IDS.stagingId, runId: IDS.runId }, ...((COMMAND_SYNTAX["context update"]) ? { syntax: COMMAND_SYNTAX["context update"] } : {}) },
  "context.validate": { required: ["project"], optional: [], ...((COMMAND_SYNTAX["context validate"]) ? { syntax: COMMAND_SYNTAX["context validate"] } : {}) },
  "planning.start": { required: ["project"], optional: ["requestFile", "requestStdin"], exclusive: [["requestFile", "requestStdin"]], ...((COMMAND_SYNTAX["planning start"]) ? { syntax: COMMAND_SYNTAX["planning start"] } : {}) },
  "coding.start": { required: ["project"], optional: ["mode", "planId", "revision", "requestFile", "requestStdin"], patterns: { planId: IDS.planId, revision: IDS.revision }, ...((COMMAND_SYNTAX["coding start"]) ? { syntax: COMMAND_SYNTAX["coding start"] } : {}) },
  "dispatch.identity": { required: ["runId", "dispatchId", "role"], optional: [], patterns: { runId: IDS.runId, dispatchId: IDS.dispatchId }, syntax: ["ai-team dispatch <claim|prompt|schema|template|packet-schema|packet-template|validate|submit> --run-id <run-id> --dispatch-id <dispatch-id> --role <role>"] },
  "run.identity": { required: ["runId"], optional: [], patterns: { runId: IDS.runId }, syntax: ["ai-team run <show|resume> <run-id>"] },
  "review.create": { required: ["runId", "revisionSha"], optional: ["formal"], patterns: { runId: IDS.runId, revisionSha: IDS.commit }, ...((COMMAND_SYNTAX["review create"]) ? { syntax: COMMAND_SYNTAX["review create"] } : {}) },
});

/** Canonical serialisable command contract. Consumers should derive metadata from this value. */
export const COMMAND_CONTRACT_BASE = {
  schema_version: SCHEMA_VERSION,
  identifiers: {
    plan_id: "^(?!.*-[a-f0-9]{4}$)[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$",
    revision: "^[0-9]{3}$",
    task_id: "^TASK-[0-9]{3}$",
    run_id: "^run_[0-9A-HJKMNP-TV-Z]{26}$",
    dispatch_id: "^dispatch_[0-9A-HJKMNP-TV-Z]{26}$",
    staging_id: "^staging_[0-9A-HJKMNP-TV-Z]{26}$",
    commit: "^[a-f0-9]{40}$",
  },
  commands: { public: [...PUBLIC_COMMANDS], agent: [...AGENT_COMMANDS] },
  command_specs: Object.fromEntries(Object.entries(COMMAND_VALIDATORS).map(([name, spec]) => [name, {
    required: [...spec.required], optional: [...spec.optional],
    ...(spec.syntax ? { syntax: [...spec.syntax] } : {}),
  }])),
  syntax: Object.fromEntries(Object.entries(COMMAND_SYNTAX).map(([name, syntax]) => [name, [...syntax]])),
  parameter_types: COMMAND_PARAMETER_TYPES,
} as const;

export const commandContractFor = (commands: readonly string[]) => ({
  allowed_commands: [...commands],
  syntax: [...new Set(commands.flatMap((command) => COMMAND_SYNTAX[command] ?? []))],
  parameter_types: COMMAND_PARAMETER_TYPES,
});

const RECOVERY_ONLY_COMMANDS = new Set([
  "planning revision validate",
  "dispatch prompt",
  "dispatch schema",
  "dispatch template",
  "dispatch packet-schema",
  "dispatch packet-template",
  "dispatch validate",
  "decision schema",
  "decision template",
  "staging create",
  "staging write",
  "staging show",
  "staging cleanup",
]);

export const recommendedCommandSyntaxFor = (commands: readonly string[]): string[] =>
  [...new Set(commands.filter((command) => !RECOVERY_ONLY_COMMANDS.has(command)).flatMap((command) => AGENT_COMMAND_SYNTAX_OVERRIDES[command] ?? COMMAND_SYNTAX[command] ?? []))];

export const validateCommand = (name: string, values: Record<string, CommandValue>): void => {
  const spec = COMMAND_VALIDATORS[name];
  if (!spec) throw new ArgumentError(`unknown command contract: ${name}`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ArgumentError(`${name} has unknown parameters`, unknown);
  const missing = spec.required.filter((key) => values[key] === undefined || values[key] === "");
  if (missing.length) throw new ValidationError(`${name} is missing required parameters`, missing);
  for (const [key, pattern] of Object.entries(spec.patterns ?? {})) {
    const value = values[key]; if (typeof value === "string" && !pattern.test(value)) throw new ArgumentError(`${name}.${key} has invalid format`);
  }
  for (const group of spec.exclusive ?? []) {
    if (group.filter((key) => Boolean(values[key])).length !== 1) throw new ValidationError(`${name} requires exactly one of ${group.join(", ")}`);
  }
};
