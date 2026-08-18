import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { EnvironmentService } from "../src/environment.js";
import { retryTransient, ScopeGate } from "../src/gates.js";
import { commitPlanningRevision } from "../src/git.js";
import { frozenTaskWritePathsFromDocument, StateStore } from "../src/state.js";

const exec = promisify(execFile);
const rawGit = async (cwd: string, args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

test("transient failures retry at most twice and permanent failures do not retry", async () => {
  let transient = 0;
  await assert.rejects(retryTransient("network_timeout", async () => { transient += 1; throw new Error("offline"); }), /offline/);
  assert.equal(transient, 3);
  let permanent = 0;
  await assert.rejects(retryTransient("authentication", async () => { permanent += 1; throw new Error("denied"); }), /denied/);
  assert.equal(permanent, 1);
});

test("direct scope passes three matching gates and freezes on drift", async () => {
  const home = await mkdtemp(join(tmpdir(), "ai-team-gates-"));
  const store = await StateStore.open(home);
  try {
    store.registerRepository("repo", "/tmp/repo.git", "/tmp/repo");
    const run = store.createRun({ repoId: "repo", profile: "coding", mode: "feature" });
    const gate = new ScopeGate(store);
    assert.equal(gate.check(run, "triage", ["src/**"]).complete, false);
    assert.equal(gate.check(run, "pre_write", ["src/**"]).complete, false);
    assert.equal(gate.check(run, "pre_write", ["src/**"]).complete, false);
    const prepares = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='git-operator'").all(run) as Array<{ packet_json: string }>;
    assert.equal(prepares.length, 1);
    assert.equal(JSON.parse(prepares[0]!.packet_json).context.phase, "prepare_implementation_worktree");
    const completed = gate.check(run, "pre_commit", ["src/**"]);
    assert.equal(completed.complete, true);
    const eventCount = store.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id=? AND type LIKE 'scope.%'").get(run) as { count: number };
    assert.deepEqual(gate.check(run, "pre_commit", ["src/**"]), completed);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id=? AND type LIKE 'scope.%'").get(run) as { count: number }).count, eventCount.count);
    const drifted = store.createRun({ repoId: "repo", profile: "coding", mode: "bug" });
    gate.check(drifted, "triage", ["src/a.ts"]);
    await assert.rejects(async () => gate.check(drifted, "triage", ["src/b.ts"]), /run frozen/);
    assert.equal(store.getRun(drifted).state, "frozen");
    const outOfOrder = store.createRun({ repoId: "repo", profile: "coding", mode: "feature" });
    gate.check(outOfOrder, "triage", ["src/**"]);
    await assert.rejects(async () => gate.check(outOfOrder, "pre_commit", ["src/**"]), /scope gate out of order: pre_commit/);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});

test("planned pre_commit scope is bound to its run-owned worktree", async () => {
  const home = await mkdtemp(join(tmpdir(), "ai-team-planned-gate-"));
  const store = await StateStore.open(home);
  try {
    const repository = join(home, "repo");
    await mkdir(repository);
    await rawGit(repository, ["init", "-b", "main"]);
    await rawGit(repository, ["config", "user.name", "AI Team Test"]);
    await rawGit(repository, ["config", "user.email", "ai-team@example.test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await rawGit(repository, ["add", "README.md"]);
    await rawGit(repository, ["commit", "-m", "fixture"]);
    store.registerRepository("repo", join(repository, ".git"), repository);
    const run = store.createRun({ repoId: "repo", profile: "coding", mode: "planned", planId: "planned-gate", revision: "001" });
    assert.throws(() => store.initializeRunTasks(run, [{
      task_id: "TASK-001", source_path: "TASK-001.md", source_digest: "a".repeat(64), write_paths: ["test/**"],
    }]), /explicit repository paths/);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_planned_gate", run, "task/planned-gate/planned-gate-001--task-001", repository, await rawGit(repository, ["rev-parse", "HEAD"]), new Date().toISOString());
    const gate = new ScopeGate(store);
    assert.throws(() => gate.check(run, "pre_write", ["src/**"], "worktree_planned_gate"), /only the pre_commit/);
    assert.throws(() => gate.check(run, "pre_commit", ["src/**"]), /requires a worktree id/);
    const completed = gate.check(run, "pre_commit", ["src/**"], "worktree_planned_gate");
    assert.equal(completed.complete, true);
    assert.deepEqual(gate.check(run, "pre_commit", ["src/**"], "worktree_planned_gate"), completed);
    assert.throws(() => gate.check(run, "pre_commit", ["test/**"], "worktree_planned_gate"), /run frozen/);
    const events = store.db.prepare("SELECT type,payload_json FROM run_events WHERE run_id=? AND type LIKE 'scope.pre_commit%' ORDER BY event_id").all(run) as Array<{ type: string; payload_json: string }>;
    assert.deepEqual(events.map(({ type }) => type), ["scope.pre_commit", "scope.pre_commit_drift"]);
    assert.deepEqual(JSON.parse(events[0]!.payload_json).paths, ["src/**"]);
    assert.deepEqual(JSON.parse(events[1]!.payload_json).unauthorized_paths, ["src/**", "test/**"]);
    gate.assertPreCommit(run, ["src/**"], "worktree_planned_gate");
    assert.throws(() => gate.assertPreCommit(run, ["test/**"], "worktree_planned_gate"), /has not passed pre_commit/);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});

test("frozen Task write paths reject globs and role descriptions", () => {
  assert.deepEqual(frozenTaskWritePathsFromDocument("- 允许写入路径：`src/dispatch.ts`\n", "TASK-001.md"), ["src/dispatch.ts"]);
  assert.throws(() => frozenTaskWritePathsFromDocument("- 允许写入路径：`test/**`\n", "TASK-001.md"), /explicit repository paths/);
  assert.throws(() => frozenTaskWritePathsFromDocument("- 允许写入路径：`planning/coding角色文件`\n", "TASK-001.md"), /explicit repository paths/);
});

test("planning commit stages only the immutable revision and includes trailers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-plan-commit-"));
  try {
    await rawGit(root, ["init", "-b", "main"]);
    await rawGit(root, ["config", "user.name", "AI Team Test"]);
    await rawGit(root, ["config", "user.email", "ai-team@example.test"]);
    await writeFile(join(root, "README.md"), "base\n");
    await rawGit(root, ["add", "README.md"]); await rawGit(root, ["commit", "-m", "base"]);
    const revision = join(root, ".ai-team", "plans", "20260813-demo", "revisions", "001");
    await mkdir(revision, { recursive: true }); await writeFile(join(revision, "spec.md"), "spec\n");
    await writeFile(join(root, "user.txt"), "do not commit\n");
    const commit = await commitPlanningRevision(root, "20260813-demo", "001", "a".repeat(64));
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(await rawGit(root, ["show", "--format=", "--name-only", commit]), ".ai-team/plans/20260813-demo/revisions/001/spec.md");
    const body = await rawGit(root, ["show", "-s", "--format=%B", commit]);
    assert.match(body, /AI-Team-Plan: 20260813-demo/);
    assert.match(body, /AI-Team-Revision: 001/);
    assert.match(body, /AI-Team-Digest: a{64}/);
    assert.match((await rawGit(root, ["status", "--porcelain"])), /\?\? user.txt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("environment bootstrap exports strict JSON schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-schema-"));
  try {
    const service = new EnvironmentService(join(root, "config"), join(root, "user"));
    await service.bootstrap();
    const resultSchema = JSON.parse(await readFile(join(service.paths.schemas, "result-envelope-v1.json"), "utf8"));
    const environmentSchema = JSON.parse(await readFile(join(service.paths.schemas, "environment-v1.json"), "utf8"));
    assert.equal(resultSchema.additionalProperties, false);
    assert.equal(environmentSchema.additionalProperties, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
