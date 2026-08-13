import { ValidationError } from "./errors.js";
import { pathMatchesScope } from "./security.js";

export interface TaskDefinition {
  task_id: string;
  title: string;
  requirements: string[];
  acceptance_criteria: string[];
  dependencies: string[];
  allowed_write_paths: string[];
}

const overlaps = (left: string[], right: string[]): boolean => left.some((a) => right.some((b) => pathMatchesScope(a, [b]) || pathMatchesScope(b, [a])));

export const validateTaskGraph = (tasks: TaskDefinition[]): void => {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  if (byId.size !== tasks.length) throw new ValidationError("task ids must be unique");
  for (const task of tasks) {
    if (!/^TASK-\d{3}$/.test(task.task_id) || !task.title || !task.requirements.length || !task.acceptance_criteria.length || !task.allowed_write_paths.length) throw new ValidationError(`invalid task definition: ${task.task_id}`);
    const unknown = task.dependencies.filter((id) => !byId.has(id));
    if (unknown.length) throw new ValidationError(`${task.task_id} has unknown dependencies`, unknown);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ValidationError(`task dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.task_id);
};

export const runnableTaskBatches = (tasks: TaskDefinition[]): string[][] => {
  validateTaskGraph(tasks);
  const remaining = new Map(tasks.map((task) => [task.task_id, task]));
  const completed = new Set<string>(); const batches: string[][] = [];
  while (remaining.size) {
    const candidates = [...remaining.values()].filter((task) => task.dependencies.every((id) => completed.has(id))).sort((a, b) => a.task_id.localeCompare(b.task_id));
    if (!candidates.length) throw new ValidationError("task graph cannot make progress");
    const batch: TaskDefinition[] = [];
    for (const task of candidates) if (batch.every((selected) => !overlaps(task.allowed_write_paths, selected.allowed_write_paths))) batch.push(task);
    batches.push(batch.map((task) => task.task_id));
    for (const task of batch) { remaining.delete(task.task_id); completed.add(task.task_id); }
  }
  return batches;
};
