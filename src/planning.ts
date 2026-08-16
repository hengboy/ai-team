import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { PLAN_STATES } from "./constants.js";
import { ValidationError } from "./errors.js";
import { sha256 } from "./utils.js";
import { canonicalizeInside } from "./security.js";

const ID_RE = /\b(?:REQ|AC)-\d{3}\b/g;

export const SPEC_SECTIONS = ["背景", "目标", "非目标", "用户场景", "功能需求", "验收标准", "数据与接口", "兼容约束", "安全约束", "错误与边界", "迁移发布回滚", "已确认偏好", "默认取舍", "已关闭问题", "未决问题"] as const;
export const PLAN_SECTIONS = ["方案摘要", "实施步骤", "需求覆盖", "验证", "发布与回滚"] as const;

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
    draft: ["requirements_confirmed", "abandoned"],
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
  const errors: Array<{ path: string; message: string }> = Object.keys(documents)
    .filter((key) => !allowed.has(key))
    .map((key) => ({ path: `/${pointer(key)}`, message: "unknown field" }));
  for (const field of ["spec", "plan"] as const) {
    if (typeof documents[field] !== "string") errors.push({ path: `/${field}`, message: "must be a string" });
  }
  if (documents.tasks !== undefined && typeof documents.tasks !== "string") {
    errors.push({ path: "/tasks", message: "must be a string" });
  }
  if (documents.taskFiles !== undefined) {
    if (!documents.taskFiles || typeof documents.taskFiles !== "object" || Array.isArray(documents.taskFiles)) {
      errors.push({ path: "/taskFiles", message: "must be an object" });
    } else {
      for (const [name, document] of Object.entries(documents.taskFiles)) {
        if (typeof document !== "string") errors.push({ path: `/taskFiles/${pointer(name)}`, message: "must be a string" });
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
