import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ValidationError } from "./errors.js";
import { validateResearchConclusions, type ResearchConclusion } from "./research.js";
import { StateStore } from "./state.js";
import { sha256, toPosix } from "./utils.js";
import { canonicalizeInside } from "./security.js";

const renderReport = (topic: string, conclusions: ResearchConclusion[]): string => {
  const sections = conclusions.map((item) => [
    `## ${item.kind}: ${item.statement}`,
    `- URL: ${item.url}`,
    `- Accessed: ${item.accessed_at}`,
    `- Applicable version: ${item.applicable_version}`,
    `- Source level: ${item.source_level}`,
  ].join("\n"));
  return [`# Research: ${topic}`, "", ...sections, ""].join("\n");
};

const safeTopic = (topic: string): string => {
  const value = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!value) throw new ValidationError("research topic must contain ASCII letters or digits");
  return value;
};

export class ResearchService {
  constructor(readonly store: StateStore) {}

  async archive(runId: string, project: string, topic: string, conclusions: ResearchConclusion[]): Promise<{ path: string; digest: string }> {
    validateResearchConclusions(conclusions);
    const run = this.store.getRun(runId) as { profile: string; plan_id?: string; revision?: string };
    const slug = safeTopic(topic);
    let path: string;
    if (run.profile === "planning" || run.plan_id || run.revision) {
      if (!run.plan_id || !run.revision) throw new ValidationError("planned research requires the run to bind plan_id and revision");
      path = join(project, ".ai-team", "plans", run.plan_id, "revisions", run.revision, "research", `${slug}.md`);
    } else {
      path = join(this.store.paths.artifacts, runId, "research", `${slug}.md`);
    }
    const directory = join(path, "..");
    await mkdir(directory, { recursive: true });
    if (run.plan_id && run.revision) await canonicalizeInside(project, directory);
    else await canonicalizeInside(this.store.paths.artifacts, directory);
    const report = renderReport(topic, conclusions);
    await writeFile(path, report, { mode: 0o600 });
    const digest = sha256(report);
    this.store.event(runId, "research.archived", { path: toPosix(relative(project, path)), digest, conclusion_count: conclusions.length });
    return { path, digest };
  }
}
