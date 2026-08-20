import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { PLAN_STATES } from "./constants.js";
import { ValidationError } from "./errors.js";
import { sha256, stableJson } from "./utils.js";
import { canonicalizeInside } from "./security.js";

const ID_RE = /\b(?:REQ|AC)-\d{3}\b/g;

export const SPEC_SECTIONS = ["背景", "目标", "非目标", "用户场景", "功能需求", "验收标准", "数据与接口", "兼容约束", "安全约束", "错误与边界", "迁移发布回滚", "已确认偏好", "默认取舍", "已关闭问题", "未决问题"] as const;
export const PLAN_SECTIONS = ["方案摘要", "实施步骤", "需求覆盖", "验证", "方案验收契约", "发布与回滚"] as const;

const ACCEPTANCE_ID_RE = /^AC-\d{3}$/;
const REQUIREMENT_ID_RE = /^REQ-\d{3}$/;
const TASK_ID_RE = /^TASK-\d{3}$/;
const VERIFICATION_ID_RE = /^VERIFY-\d{3}$/;

export interface AcceptanceStep {
  id: string;
  acceptance_criteria: string[];
  command: string;
  expected_result: string;
}

export interface TaskMapping {
  task_id: string;
  acceptance_criteria: string[];
}

export interface PlanVerification {
  acceptance_criteria: string[];
  acceptance_steps: AcceptanceStep[];
  task_mapping: TaskMapping[];
  test_commands: string[];
}

export interface TddCycle {
  acceptance_criterion: string;
  test_path: string;
  red: { command: string; expected_failure: string };
  green: { implementation_steps: string[]; command: string; expected_result: string };
  refactor: { scope: string; command: string; expected_result: string };
}

export interface TaskVerification extends PlanVerification {
  tdd_cycles: TddCycle[];
}

const contractObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${path} must be an object`);
  return value as Record<string, unknown>;
};

const exactFields = (value: Record<string, unknown>, fields: readonly string[], path: string): void => {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new ValidationError(`${path} has unknown field`, { unknown });
  const missing = fields.filter((field) => !(field in value));
  if (missing.length) throw new ValidationError(`${path} is missing required fields`, { missing });
};

const nonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${path} must be a non-empty string`);
  return value;
};

const stringList = (value: unknown, path: string, pattern?: RegExp, idName?: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError(`${path} must be a non-empty array`);
  const result = value.map((item, index) => nonEmptyString(item, `${path}/${index}`));
  if (new Set(result).size !== result.length) throw new ValidationError(`${path} must not contain duplicates`);
  if (pattern) {
    const invalid = result.filter((item) => !pattern.test(item));
    if (invalid.length) throw new ValidationError(`${path} contains invalid ${idName ?? "id"}`, { invalid });
  }
  return result;
};

const parseContractBlock = (markdown: string, heading: string): unknown => {
  const headings = [...markdown.matchAll(new RegExp(`^## ${heading}$`, "gm"))];
  if (headings.length !== 1) throw new ValidationError(`${heading} must contain exactly one JSON contract block`);
  const start = headings[0]!.index! + headings[0]![0].length;
  const remainder = markdown.slice(start);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  const match = section.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (!match) throw new ValidationError(`${heading} must contain exactly one fenced JSON contract`);
  try {
    return JSON.parse(match[1]!);
  } catch (error) {
    throw new ValidationError(`${heading} contains invalid JSON`, { cause: error instanceof Error ? error.message : String(error) });
  }
};

const parseAcceptanceStep = (value: unknown, path: string): AcceptanceStep => {
  const item = contractObject(value, path);
  exactFields(item, ["id", "acceptance_criteria", "command", "expected_result"], path);
  const id = nonEmptyString(item.id, `${path}/id`);
  if (!VERIFICATION_ID_RE.test(id)) throw new ValidationError(`${path}/id contains invalid verification id`);
  return {
    id,
    acceptance_criteria: stringList(item.acceptance_criteria, `${path}/acceptance_criteria`, ACCEPTANCE_ID_RE, "acceptance criterion id"),
    command: nonEmptyString(item.command, `${path}/command`),
    expected_result: nonEmptyString(item.expected_result, `${path}/expected_result`),
  };
};

const parseTaskMapping = (value: unknown, path: string): TaskMapping => {
  const item = contractObject(value, path);
  exactFields(item, ["task_id", "acceptance_criteria"], path);
  const taskId = nonEmptyString(item.task_id, `${path}/task_id`);
  if (!TASK_ID_RE.test(taskId)) throw new ValidationError(`${path}/task_id contains invalid task id`);
  return {
    task_id: taskId,
    acceptance_criteria: stringList(item.acceptance_criteria, `${path}/acceptance_criteria`, ACCEPTANCE_ID_RE, "acceptance criterion id"),
  };
};

const assertMappedExactly = (criteria: string[], groups: string[][], path: string): void => {
  const expected = [...criteria].sort();
  const actual = [...new Set(groups.flat())].sort();
  const missing = expected.filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.includes(id));
  if (missing.length || unknown.length) throw new ValidationError(`${path} acceptance criteria mapping is incomplete`, { missing, unknown });
};

const parsePlanVerificationValue = (value: unknown, task = false): PlanVerification => {
  const contract = contractObject(value, task ? "task verification" : "plan verification");
  exactFields(contract, task
    ? ["acceptance_criteria", "acceptance_steps", "task_mapping", "test_commands", "tdd_cycles"]
    : ["acceptance_criteria", "acceptance_steps", "task_mapping", "test_commands"], task ? "task verification" : "plan verification");
  const criteria = stringList(contract.acceptance_criteria, "/acceptance_criteria", ACCEPTANCE_ID_RE, "acceptance criterion id");
  if (!Array.isArray(contract.acceptance_steps) || contract.acceptance_steps.length === 0) throw new ValidationError("/acceptance_steps must be a non-empty array");
  if (!Array.isArray(contract.task_mapping) || contract.task_mapping.length === 0) throw new ValidationError("/task_mapping must be a non-empty array");
  const acceptanceSteps = contract.acceptance_steps.map((item, index) => parseAcceptanceStep(item, `/acceptance_steps/${index}`));
  const taskMapping = contract.task_mapping.map((item, index) => parseTaskMapping(item, `/task_mapping/${index}`));
  if (new Set(acceptanceSteps.map(({ id }) => id)).size !== acceptanceSteps.length) throw new ValidationError("acceptance step ids must be unique");
  if (new Set(taskMapping.map(({ task_id }) => task_id)).size !== taskMapping.length) throw new ValidationError("task mapping ids must be unique");
  assertMappedExactly(criteria, acceptanceSteps.map(({ acceptance_criteria }) => acceptance_criteria), "/acceptance_steps");
  assertMappedExactly(criteria, taskMapping.map(({ acceptance_criteria }) => acceptance_criteria), "/task_mapping");
  return {
    acceptance_criteria: criteria,
    acceptance_steps: acceptanceSteps,
    task_mapping: taskMapping,
    test_commands: stringList(contract.test_commands, "/test_commands"),
  };
};

export const parsePlanVerification = (markdown: string): PlanVerification =>
  parsePlanVerificationValue(parseContractBlock(markdown, "方案验收契约"));

export const parseTaskVerification = (markdown: string): TaskVerification => {
  const value = contractObject(parseContractBlock(markdown, "任务验收契约"), "task verification");
  const verification = parsePlanVerificationValue(value, true);
  if (!Array.isArray(value.tdd_cycles) || value.tdd_cycles.length === 0) throw new ValidationError("/tdd_cycles must be a non-empty array");
  const tddCycles = value.tdd_cycles.map((entry, index): TddCycle => {
    const path = `/tdd_cycles/${index}`;
    const cycle = contractObject(entry, path);
    exactFields(cycle, ["acceptance_criterion", "test_path", "red", "green", "refactor"], path);
    const acceptanceCriterion = nonEmptyString(cycle.acceptance_criterion, `${path}/acceptance_criterion`);
    if (!ACCEPTANCE_ID_RE.test(acceptanceCriterion)) throw new ValidationError(`${path}/acceptance_criterion contains invalid acceptance criterion id`);
    const red = contractObject(cycle.red, `${path}/red`);
    const green = contractObject(cycle.green, `${path}/green`);
    const refactor = contractObject(cycle.refactor, `${path}/refactor`);
    exactFields(red, ["command", "expected_failure"], `${path}/red`);
    exactFields(green, ["implementation_steps", "command", "expected_result"], `${path}/green`);
    exactFields(refactor, ["scope", "command", "expected_result"], `${path}/refactor`);
    return {
      acceptance_criterion: acceptanceCriterion,
      test_path: nonEmptyString(cycle.test_path, `${path}/test_path`),
      red: { command: nonEmptyString(red.command, `${path}/red/command`), expected_failure: nonEmptyString(red.expected_failure, `${path}/red/expected_failure`) },
      green: {
        implementation_steps: stringList(green.implementation_steps, `${path}/green/implementation_steps`),
        command: nonEmptyString(green.command, `${path}/green/command`),
        expected_result: nonEmptyString(green.expected_result, `${path}/green/expected_result`),
      },
      refactor: {
        scope: nonEmptyString(refactor.scope, `${path}/refactor/scope`),
        command: nonEmptyString(refactor.command, `${path}/refactor/command`),
        expected_result: nonEmptyString(refactor.expected_result, `${path}/refactor/expected_result`),
      },
    };
  });
  assertMappedExactly(verification.acceptance_criteria, tddCycles.map(({ acceptance_criterion }) => [acceptance_criterion]), "/tdd_cycles");
  return { ...verification, tdd_cycles: tddCycles };
};

export const verificationDigest = (verification: PlanVerification | TaskVerification | unknown): string =>
  sha256(stableJson(verification));

const assertSections = (document: string, sections: readonly string[], name: string): void => {
  const headings = new Set([...document.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]!.trim()));
  const missing = sections.filter((section) => !headings.has(section));
  if (missing.length) throw new ValidationError(`${name} is missing required sections`, { missing });
};

export const extractRequirementIds = (markdown: string): Set<string> => new Set(markdown.match(ID_RE) ?? []);

export const validateCoverage = (spec: string, documents: string[]): { requirements: string[]; missing: string[]; unknown: string[] } => {
  const requirements = [...extractRequirementIds(spec)].sort();
  const covered = new Set(documents.flatMap((document) => [...extractRequirementIds(document)]));
  return {
    requirements,
    missing: requirements.filter((id) => !covered.has(id)),
    unknown: [...covered].filter((id) => !requirements.includes(id)).sort(),
  };
};

export const assertCoverage = (spec: string, documents: string[]): void => {
  const result = validateCoverage(spec, documents);
  if (result.missing.length || result.unknown.length) throw new ValidationError("planning coverage is incomplete", result);
};

export const nextPlanState = (current: string, target: string): string => {
  const terminal = new Set(["implemented", "superseded", "abandoned"]);
  if (!PLAN_STATES.includes(current as any) || !PLAN_STATES.includes(target as any)) throw new ValidationError("unknown planning state");
  if (terminal.has(current)) throw new ValidationError(`terminal revision cannot transition from ${current}`);
  const edges: Record<string, string[]> = {
    draft: ["requirements_confirmed", "plan_ready", "abandoned"],
    requirements_confirmed: ["spec_ready", "abandoned"],
    spec_ready: ["plan_ready", "abandoned"],
    plan_ready: ["tasks_preview", "ready", "abandoned"],
    tasks_preview: ["tasks_preview", "ready", "abandoned"],
    ready: ["implemented", "superseded", "abandoned"],
  };
  if (!edges[current]?.includes(target)) throw new ValidationError(`invalid planning transition: ${current} -> ${target}`);
  return target;
};

export interface RevisionDocuments {
  spec: string;
  plan: string;
  tasks?: string;
  taskFiles?: Record<string, string>;
}

export const hasTaskDocuments = (docs: RevisionDocuments): boolean =>
  docs.tasks !== undefined || docs.taskFiles !== undefined;

const pointer = (value: string): string => value.replace(/~/g, "~0").replace(/\//g, "~1");

export function assertRevisionDocuments(value: unknown): asserts value is RevisionDocuments {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("revision documents are invalid", [{ path: "/", message: "must be an object" }]);
  }
  const documents = value as Record<string, unknown>;
  const allowed = new Set(["spec", "plan", "tasks", "taskFiles"]);
  const errors: Array<{ path: string; pointer?: string; constraint?: string; message: string; suggestion?: string }> = Object.keys(documents)
    .filter((key) => !allowed.has(key))
    .map((key) => ({ path: `/${pointer(key)}`, pointer: `/${pointer(key)}`, constraint: "additionalProperties", message: "unknown field", suggestion: "Use the planning-documents fields spec, plan, tasks, and taskFiles." }));
  for (const field of ["spec", "plan"] as const) {
    if (typeof documents[field] !== "string") errors.push({ path: `/${field}`, pointer: `/${field}`, constraint: "type", message: "must be a string", suggestion: `Set ${field} to the complete Markdown document.` });
  }
  if (documents.tasks !== undefined && typeof documents.tasks !== "string") {
    errors.push({ path: "/tasks", pointer: "/tasks", constraint: "type", message: "must be a string", suggestion: "Set tasks to the complete tasks.md Markdown document." });
  }
  if (documents.taskFiles !== undefined) {
    if (!documents.taskFiles || typeof documents.taskFiles !== "object" || Array.isArray(documents.taskFiles)) {
      errors.push({ path: "/taskFiles", message: "must be an object" });
    } else {
      for (const [name, document] of Object.entries(documents.taskFiles)) {
        if (typeof document !== "string") {
          const path = `/taskFiles/${pointer(name)}`;
          errors.push({ path, pointer: path, constraint: "type", message: "must be a string", suggestion: "Set each taskFiles value to a complete task Markdown document." });
        }
      }
    }
  }
  if (errors.length) throw new ValidationError("revision documents are invalid", errors);
}

export const REVISION_RUN_STAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ["plan_ready", "tasks_preview"],
  requirements_confirmed: ["plan_ready"],
  spec_ready: ["plan_ready"],
  plan_ready: ["plan_ready", "tasks_preview"],
  tasks_preview: ["tasks_preview"],
  ready: ["plan_ready", "tasks_preview", "ready"],
  implemented: ["ready"],
  superseded: ["ready"],
  abandoned: ["plan_ready", "tasks_preview", "ready"],
});

export const assertRevisionRunStage = (revisionState: string, runStage: string, targetState = revisionState): void => {
  for (const state of [revisionState, targetState]) {
    if (!REVISION_RUN_STAGES[state]?.includes(runStage)) {
      throw new ValidationError(`revision state ${state} is incompatible with planning run stage ${runStage}`);
    }
  }
};

export const assertRevisionCreateRunStage = (docs: RevisionDocuments, runStage: string): void => {
  const requiredStage = hasTaskDocuments(docs) ? "tasks_preview" : "plan_ready";
  if (runStage !== requiredStage) {
    throw new ValidationError(`planning revision ${hasTaskDocuments(docs) ? "with task documents" : "without task documents"} requires run stage ${requiredStage}`);
  }
  assertRevisionRunStage("draft", runStage);
};

const exactIdSet = (expected: string[], actual: string[], message: string): void => {
  const expectedIds = [...new Set(expected)].sort();
  const actualIds = [...new Set(actual)].sort();
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const unknown = actualIds.filter((id) => !expectedIds.includes(id));
  if (missing.length || unknown.length) throw new ValidationError(message, { missing, unknown });
};

const assertSpecTddContract = (spec: string): string[] => {
  const requirements = [...spec.matchAll(/^###\s+(REQ-\d{3})：/gm)].map((match) => match[1]!);
  const criteria = [...spec.matchAll(/^###\s+(AC-\d{3})：/gm)];
  if (!requirements.length) throw new ValidationError("spec.md must define at least one requirement");
  if (!criteria.length) throw new ValidationError("spec.md must define at least one acceptance criterion");
  if (new Set(requirements).size !== requirements.length) throw new ValidationError("spec.md requirement ids must be unique");
  if (new Set(criteria.map((match) => match[1]!)).size !== criteria.length) throw new ValidationError("spec.md acceptance criterion ids must be unique");
  for (const id of requirements) if (!REQUIREMENT_ID_RE.test(id)) throw new ValidationError(`invalid requirement id: ${id}`);
  const requiredFields = [
    { name: "Given", labels: ["Given"] },
    { name: "When", labels: ["When"] },
    { name: "Then", labels: ["Then"] },
    { name: "RED", labels: ["RED 判定", "RED"] },
    { name: "可观察结果", labels: ["可观察结果"] },
    { name: "边界反例", labels: ["边界反例"] },
    { name: "测试层级", labels: ["建议测试层级", "测试层级"] },
    { name: "验证命令", labels: ["验证命令或证据路径", "验证命令或证据"] },
  ];
  for (const [index, match] of criteria.entries()) {
    const start = match.index! + match[0].length;
    const end = criteria[index + 1]?.index ?? spec.indexOf("\n## ", start);
    const section = spec.slice(start, end >= 0 ? end : undefined);
    const missing = requiredFields
      .filter(({ labels }) => !labels.some((label) => new RegExp(`^- ${label}：[ \\t]*\\S.*$`, "m").test(section)))
      .map(({ name }) => name);
    if (missing.length) throw new ValidationError(`spec.md ${match[1]} is missing TDD acceptance fields`, { missing });
  }
  return criteria.map((match) => match[1]!);
};

const assertVerificationMappings = (docs: RevisionDocuments, specCriteria: string[], planVerification: PlanVerification): void => {
  exactIdSet(specCriteria, planVerification.acceptance_criteria, "plan verification acceptance criteria do not match spec.md");
  const taskDocuments = [
    ...(docs.tasks === undefined ? [] : [{ name: "tasks", document: docs.tasks }]),
    ...Object.entries(docs.taskFiles ?? {}).map(([name, document]) => ({ name, document })),
  ];
  if (!taskDocuments.length) return;
  const taskMappings = new Map<string, string[]>();
  const hasIndividualTasks = Object.keys(docs.taskFiles ?? {}).length > 0;
  for (const { name, document } of taskDocuments) {
    const verification = parseTaskVerification(document);
    exactIdSet(verification.acceptance_criteria, verification.tdd_cycles.map(({ acceptance_criterion }) => acceptance_criterion), `${name} TDD cycles do not match its acceptance criteria`);
    if (name === "tasks") {
      exactIdSet(planVerification.acceptance_criteria, verification.acceptance_criteria, "tasks verification acceptance criteria do not match plan verification");
      exactIdSet(planVerification.task_mapping.map(({ task_id }) => task_id), verification.task_mapping.map(({ task_id }) => task_id), "tasks verification task mappings do not match plan verification");
      for (const mapping of planVerification.task_mapping) {
        exactIdSet(mapping.acceptance_criteria, verification.task_mapping.find(({ task_id }) => task_id === mapping.task_id)?.acceptance_criteria ?? [], `tasks verification AC mappings are inconsistent for ${mapping.task_id}`);
      }
      if (hasIndividualTasks) continue;
    }
    if (name !== "tasks" && (verification.task_mapping.length !== 1 || verification.task_mapping[0]!.task_id !== name)) {
      throw new ValidationError(`${name} task verification must map only its own task id`);
    }
    for (const mapping of verification.task_mapping) {
      if (taskMappings.has(mapping.task_id)) throw new ValidationError(`duplicate task verification mapping: ${mapping.task_id}`);
      taskMappings.set(mapping.task_id, mapping.acceptance_criteria);
    }
  }
  exactIdSet(planVerification.task_mapping.map(({ task_id }) => task_id), [...taskMappings.keys()], "plan and task verification task mappings are inconsistent");
  for (const mapping of planVerification.task_mapping) {
    exactIdSet(mapping.acceptance_criteria, taskMappings.get(mapping.task_id) ?? [], `plan and task verification AC mappings are inconsistent for ${mapping.task_id}`);
  }
};

export const preflightRevision = async (project: string, planId: string, revision: string, docs: RevisionDocuments, supersedes?: string): Promise<{ path: string; digest: string }> => {
  if (!/^(?!.*-[a-f0-9]{4}$)\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) throw new ValidationError("invalid plan id");
  if (!/^\d{3}$/.test(revision)) throw new ValidationError("invalid revision");
  if (supersedes && !/^\d{3}$/.test(supersedes)) throw new ValidationError("invalid superseded revision");
  assertRevisionDocuments(docs);
  const revisionPath = join(project, ".ai-team", "plans", planId, "revisions", revision);
  await canonicalizeInside(project, join(".ai-team", "plans", planId), true);
  try { await stat(revisionPath); throw new ValidationError("planning revisions are immutable; create a new revision"); } catch (error) { if (error instanceof ValidationError) throw error; }
  assertSections(docs.spec, SPEC_SECTIONS, "spec.md");
  assertSections(docs.plan, PLAN_SECTIONS, "plan.md");
  const specCriteria = assertSpecTddContract(docs.spec);
  const planVerification = parsePlanVerification(docs.plan);
  assertVerificationMappings(docs, specCriteria, planVerification);
  assertCoverage(docs.spec, [docs.plan, docs.tasks ?? "", ...Object.values(docs.taskFiles ?? {})]);
  for (const taskId of Object.keys(docs.taskFiles ?? {})) {
    if (!/^TASK-\d{3}$/.test(taskId)) throw new ValidationError(`invalid task id: ${taskId}`);
  }
  return {
    path: revisionPath,
    digest: sha256([docs.spec, docs.plan, docs.tasks ?? "", ...Object.values(docs.taskFiles ?? {})].join("\n")),
  };
};

export const writeRevision = async (project: string, planId: string, revision: string, targetBranch: string, docs: RevisionDocuments, supersedes?: string): Promise<{ path: string; digest: string }> => {
  const preflight = await preflightRevision(project, planId, revision, docs, supersedes);
  const revisionPath = preflight.path;
  const planRoot = join(project, ".ai-team", "plans", planId);
  let createdPlanMetadata = false;
  try {
    await mkdir(join(revisionPath, "research"), { recursive: true });
    const frontmatter = YAML.stringify({ plan_id: planId, revision, target_branch: targetBranch, supersedes: supersedes ?? null });
    const wrap = (body: string): string => `---\n${frontmatter}---\n\n${body.trim()}\n`;
    await writeFile(join(revisionPath, "spec.md"), wrap(docs.spec));
    await writeFile(join(revisionPath, "plan.md"), wrap(docs.plan));
    if (docs.tasks) await writeFile(join(revisionPath, "tasks.md"), wrap(docs.tasks));
    if (docs.taskFiles) {
      await mkdir(join(revisionPath, "tasks"));
      for (const [taskId, content] of Object.entries(docs.taskFiles)) {
        await writeFile(join(revisionPath, "tasks", `${taskId}.md`), wrap(content));
      }
    }
    try { await readFile(join(planRoot, "plan.yaml")); } catch { await writeFile(join(planRoot, "plan.yaml"), YAML.stringify({ plan_id: planId, active_revision: revision })); createdPlanMetadata = true; }
    return preflight;
  } catch (error) {
    await rm(revisionPath, { recursive: true, force: true });
    if (createdPlanMetadata) await rm(join(planRoot, "plan.yaml"), { force: true });
    throw error;
  }
};

export const triage = (input: { planId?: string; actual?: string; expected?: string; evidence?: string; singleGoal?: boolean; closedAcceptance?: boolean; exhaustiveScope?: boolean; singleModule?: boolean; sensitive?: boolean }): "planned" | "bug" | "feature" | "planning" => {
  if (input.planId) return "planned";
  if (input.actual && input.expected && input.evidence) return "bug";
  if (input.singleGoal && input.closedAcceptance && input.exhaustiveScope && input.singleModule && !input.sensitive) return "feature";
  return "planning";
};

export const triageRequest = (request: string, hasReadyRevision = false): "planned" | "bug" | "feature" | "planning" => {
  if (hasReadyRevision) return "planned";
  const fields = new Set([...request.matchAll(/^\s*(actual|expected|evidence|goal|acceptance|scope|module|sensitive)\s*:\s*(.+)$/gim)].map((match) => match[1]!.toLowerCase()));
  return triage({
    ...(fields.has("actual") ? { actual: "provided" } : {}),
    ...(fields.has("expected") ? { expected: "provided" } : {}),
    ...(fields.has("evidence") ? { evidence: "provided" } : {}),
    singleGoal: fields.has("goal"),
    closedAcceptance: fields.has("acceptance"),
    exhaustiveScope: fields.has("scope"),
    singleModule: fields.has("module"),
    sensitive: fields.has("sensitive"),
  });
};
