import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CONTEXT_RULE, atomicReplaceFiles, initializeProjectContext, updateProjectContext, validateProjectContext } from "../src/context.js";
import { initializeProject } from "../src/project.js";
import { ValidationError } from "../src/errors.js";
import { DispatchService } from "../src/dispatch.js";
import { StateStore } from "../src/state.js";

const exec = promisify(execFile);

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-context-"));
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.name", "Context Test"], { cwd: root });
  await exec("git", ["config", "user.email", "context@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "# fixture\n");
  await exec("git", ["add", "--", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
};

const context = (entryPaths = ["src/entry.ts"]) => ({
  project_shape: "TypeScript CLI",
  memory: {
    domain_terms: ["dispatch", "dispatch"],
    repository_constraints: ["Node.js 22"],
    responsibilities: ["orchestrate work"],
    module_boundaries: ["src/runtime"],
  },
  navigation: [{ feature: "Dispatch", keywords: ["dispatch"], entry_paths: entryPaths, module_boundary: "src/runtime" }],
  maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
});

test("context initialization is idempotent and preserves existing instructions", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "AGENTS.md"), "# Keep this\n");
  await initializeProject(root, true);
  const firstMemory = await readFile(join(root, "MEMORY.md"), "utf8");
  const firstNavigation = await readFile(join(root, ".ai-team", "index", "feature-navigation.md"), "utf8");
  const second = await initializeProject(root);
  assert.equal(second.context.memory_status, "unchanged");
  assert.equal(await readFile(join(root, "MEMORY.md"), "utf8"), firstMemory);
  assert.equal(await readFile(join(root, ".ai-team", "index", "feature-navigation.md"), "utf8"), firstNavigation);
  const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.equal(instructions.split(CONTEXT_RULE).length - 1, 1);
  assert.match(instructions, /\*\*File Explorer\*\*/);
  assert.match(instructions, /`仓库文件检索`/);
  assert.match(instructions, /不得自行使用 `rg`、`find`、`glob`/);
  assert.match(instructions, /\.ai-team\/plans\/<planId>\/screenshot\//);
  assert.match(instructions, /`plan_id`/);
  await assert.rejects(stat(join(root, "CLAUDE.md")));
  assert.equal((await validateProjectContext(root)).valid, true);
});

test("File Explorer packet generation rejects missing project context with an init remedy", async (t) => {
  const root = await repository();
  const home = await mkdtemp(join(tmpdir(), "ai-team-context-state-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const store = await StateStore.open(home);
  t.after(() => store.close());
  store.registerRepository("repo-context-missing", join(root, ".git"), root);
  const runId = store.createRun({ repoId: "repo-context-missing", profile: "planning", mode: "planned", request: "inspect" });
  assert.throws(() => new DispatchService(store).create(runId, "file-explorer", {
    objective: "inspect", allowed_read_paths: ["."], allowed_write_paths: [], acceptance_criteria: ["report"], context: {},
  }), (error: unknown) => error instanceof ValidationError
    && /initialized project context/.test(error.message)
    && JSON.stringify(error.details).includes("ai-team init"));
});

test("context initialization migrates the legacy navigation path and MEMORY reference", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProjectContext(root, true);
  const canonicalPath = join(root, ".ai-team", "index", "feature-navigation.md");
  const legacyPath = join(root, ".ai-work-flow", "index", "feature-navigation.md");
  await mkdir(join(root, ".ai-work-flow", "index"), { recursive: true });
  await writeFile(legacyPath, await readFile(canonicalPath, "utf8"));
  await rm(canonicalPath);
  await writeFile(
    join(root, "MEMORY.md"),
    `${await readFile(join(root, "MEMORY.md"), "utf8")}\nNavigation: .ai-work-flow/index/feature-navigation.md\n`,
  );

  const legacy = await validateProjectContext(root);
  assert.equal(legacy.valid, false);
  assert.ok(legacy.navigation.issues.some((issue) => issue.includes(".ai-work-flow/index/feature-navigation.md") && issue.includes("ai-team init")));

  const migrated = await initializeProjectContext(root, true);
  assert.equal(migrated.navigation_path, ".ai-team/index/feature-navigation.md");
  assert.equal(migrated.navigation_status, "created");
  assert.match(await readFile(canonicalPath, "utf8"), /# 功能导航/);
  await assert.rejects(stat(legacyPath));
  const memory = await readFile(join(root, "MEMORY.md"), "utf8");
  assert.doesNotMatch(memory, /\.ai-work-flow\/index\/feature-navigation\.md/);
  assert.match(memory, /\.ai-team\/index\/feature-navigation\.md/);
  assert.equal((await validateProjectContext(root)).valid, true);
});

test("context update merges and deduplicates managed entries while retaining user content", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProjectContext(root, true);
  await mkdirForEntry(root);
  await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
  await writeFile(join(root, "src", "other.ts"), "export const other = true;\n");
  await writeFile(join(root, "MEMORY.md"), `${await readFile(join(root, "MEMORY.md"), "utf8")}\nUser notes stay here.\n`);
  const result = await updateProjectContext(root, context(["src/entry.ts"]));
  assert.deepEqual(result.updated_paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md"]);
  await updateProjectContext(root, context(["src/entry.ts", "src/other.ts"]));
  const memory = await readFile(join(root, "MEMORY.md"), "utf8");
  assert.match(memory, /User notes stay here/);
  assert.equal(memory.match(/- dispatch/g)?.length, 1);
  const navigation = await readFile(join(root, ".ai-team", "index", "feature-navigation.md"), "utf8");
  assert.match(navigation, /`src\/other\.ts`/);
  assert.equal((await validateProjectContext(root)).navigation.entries, 1);
});

test("context update rejects malformed sections and invalid navigation paths before writing", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeProjectContext(root, true);
  const memoryPath = join(root, "MEMORY.md");
  const original = await readFile(memoryPath, "utf8");
  await writeFile(memoryPath, `${original}${original.slice(original.indexOf("<!-- ai-team:project-context:start -->"))}`);
  await assert.rejects(() => updateProjectContext(root, context()), (error: unknown) => error instanceof ValidationError);
  await writeFile(memoryPath, original);
  for (const path of ["/etc/passwd", "../outside", ".env", "missing.ts"]) {
    await assert.rejects(() => updateProjectContext(root, context([path])), /invalid|sensitive|path/);
  }
  assert.equal(await readFile(memoryPath, "utf8"), original);
});

test("atomic replacement restores every original file after a mid-commit failure", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "old first");
  await writeFile(second, "old second");
  await assert.rejects(() => atomicReplaceFiles([
    { path: first, content: "new first", existed: true },
    { path: second, content: "new second", existed: true },
  ], (count) => { if (count === 1) throw new Error("injected failure"); }), /injected failure/);
  assert.equal(await readFile(first, "utf8"), "old first");
  assert.equal(await readFile(second, "utf8"), "old second");
});

const mkdirForEntry = async (root: string): Promise<void> => {
  await mkdir(join(root, "src"), { recursive: true });
};
