import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { PLAN_STATES } from "./constants.js";
import { ValidationError } from "./errors.js";
import { sha256 } from "./utils.js";

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

export const writeRevision = async (project: string, planId: string, revision: string, targetBranch: string, docs: RevisionDocuments, supersedes?: string): Promise<{ path: string; digest: string }> => {
  if (!/^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/.test(planId)) throw new ValidationError("invalid plan id");
  if (!/^\d{3}$/.test(revision)) throw new ValidationError("invalid revision");
  const revisionPath = join(project, ".ai-team", "plans", planId, "revisions", revision);
  try { await stat(revisionPath); throw new ValidationError("planning revisions are immutable; create a new revision"); } catch (error) { if (error instanceof ValidationError) throw error; }
  assertSections(docs.spec, SPEC_SECTIONS, "spec.md");
  assertSections(docs.plan, PLAN_SECTIONS, "plan.md");
  assertCoverage(docs.spec, [docs.plan, docs.tasks ?? "", ...Object.values(docs.taskFiles ?? {})]);
  await mkdir(join(revisionPath, "research"), { recursive: true });
  const frontmatter = YAML.stringify({ plan_id: planId, revision, target_branch: targetBranch, supersedes: supersedes ?? null });
  const wrap = (body: string): string => `---\n${frontmatter}---\n\n${body.trim()}\n`;
  await writeFile(join(revisionPath, "spec.md"), wrap(docs.spec));
  await writeFile(join(revisionPath, "plan.md"), wrap(docs.plan));
  if (docs.tasks) await writeFile(join(revisionPath, "tasks.md"), wrap(docs.tasks));
  if (docs.taskFiles) {
    await mkdir(join(revisionPath, "tasks"));
    for (const [taskId, content] of Object.entries(docs.taskFiles)) {
      if (!/^TASK-\d{3}$/.test(taskId)) throw new ValidationError(`invalid task id: ${taskId}`);
      await writeFile(join(revisionPath, "tasks", `${taskId}.md`), wrap(content));
    }
  }
  const digest = sha256([docs.spec, docs.plan, docs.tasks ?? "", ...Object.values(docs.taskFiles ?? {})].join("\n"));
  const planRoot = join(project, ".ai-team", "plans", planId);
  try { await readFile(join(planRoot, "plan.yaml")); } catch { await writeFile(join(planRoot, "plan.yaml"), YAML.stringify({ plan_id: planId, active_revision: revision })); }
  return { path: revisionPath, digest };
};

export const triage = (input: { planId?: string; actual?: string; expected?: string; evidence?: string; singleGoal?: boolean; closedAcceptance?: boolean; exhaustiveScope?: boolean; singleModule?: boolean; sensitive?: boolean }): "planned" | "bug" | "feature" | "planning" => {
  if (input.planId) return "planned";
  if (input.actual && input.expected && input.evidence) return "bug";
  if (input.singleGoal && input.closedAcceptance && input.exhaustiveScope && input.singleModule && !input.sensitive) return "feature";
  return "planning";
};
