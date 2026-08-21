import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { DispatchService } from "../../src/dispatch.js";
import { repositoryIdentity } from "../../src/git.js";
import { GitOrchestrator } from "../../src/git-orchestrator.js";
import { StateStore } from "../../src/state.js";

import { cli, git, json, makeSandbox } from "../helpers/cli.js";


test("init creates project metadata, context skeletons, and documented ignore entries", async (t) => {
  const sandbox = await makeSandbox(t, false);

  const initialized = json<{
    project: string;
    additions: string[];
    gitignoreDirty: boolean;
    patch: string;
  }>(await cli(sandbox, ["init", sandbox.repo]));

  assert.equal(initialized.project, await realpath(sandbox.repo));
  assert.equal(initialized.gitignoreDirty, false);
  assert.deepEqual(initialized.additions, ["/.worktrees/", "/.ai-team/runtime/"]);
  assert.equal(initialized.patch, "+/.worktrees/\n+/.ai-team/runtime/");
  assert.equal(await readFile(join(sandbox.repo, ".gitignore"), "utf8"), "/.worktrees/\n/.ai-team/runtime/\n");
  const project = await readFile(join(sandbox.repo, ".ai-team", "project.yaml"), "utf8");
  assert.match(project, /schema_version: 1/);
  assert.match(project, /repo_id:/);
  assert.match(await readFile(join(sandbox.repo, "MEMORY.md"), "utf8"), /## 项目上下文/);
  assert.match(await readFile(join(sandbox.repo, ".ai-team", "index", "feature-navigation.md"), "utf8"), /# 功能导航/);
});

test("CLI git prepare preserves omitted task-id for a planned prepare_worktrees dispatch", async (t) => {
  const sandbox = await makeSandbox(t);
  const planId = "20260820-prepare-default";
  const revision = "001";
  const taskDirectory = join(sandbox.repo, ".ai-team", "plans", planId, "revisions", revision, "tasks");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(taskDirectory, "TASK-001.md"), "# TASK-001\n");
  await writeFile(join(taskDirectory, "TASK-002.md"), "# TASK-002\n");
  assert.equal((await git(sandbox, ["add", ".ai-team"])).status, 0);
  assert.equal((await git(sandbox, ["commit", "-m", "Add planned task fixture"])).status, 0);
  const baseCommit = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();

  const store = await StateStore.open(sandbox.aiTeamHome);
  let runId: string;
  let dispatchId: string;
  let planWorktreeId: string;
  try {
    const identity = await repositoryIdentity(sandbox.repo);
    store.registerRepository(identity.repoId, identity.commonDir, identity.root);
    runId = store.createRun({
      repoId: identity.repoId,
      profile: "coding",
      mode: "planned",
      planId,
      revision,
      baseCommit,
      targetBranch: "main",
    });
    const dispatches = new DispatchService(store);
    dispatchId = dispatches.create(runId, "git-operator", {
      objective: "Verify the plan worktree prepared for this planned run.",
      allowed_read_paths: [".ai-team/plans"],
      allowed_write_paths: [],
      acceptance_criteria: ["Plan worktree is prepared"],
      context: { phase: "prepare_worktrees", base_commit: baseCommit },
    });
    dispatches.claim(runId, dispatchId, "git-operator");
    const plan = await new GitOrchestrator(store).prepareIntegration(runId, dispatchId);
    planWorktreeId = plan.worktree_id;
  } finally {
    store.close();
  }

  const prepared = json<{ worktree_id: string; branch: string; path: string; base_commit: string; reused: boolean }>(await cli(sandbox, [
    "git", "prepare", "--run-id", runId!, "--dispatch-id", dispatchId!, "--base-commit", baseCommit,
  ]));
  assert.equal(prepared.worktree_id, planWorktreeId!);
  assert.equal(prepared.branch, `plan/${planId}/${planId}-${revision}`);
  assert.equal(prepared.path, await realpath(join(sandbox.repo, ".worktrees", "plans", planId, `${planId}-${revision}`)));
  assert.equal(prepared.base_commit, baseCommit);
  assert.equal(prepared.reused, true);

  const verifyStore = await StateStore.open(sandbox.aiTeamHome, { readonly: true });
  try {
    const implementationWorktrees = verifyStore.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=? AND branch LIKE ?")
      .get(runId, `%--implementation`) as { count: number };
    assert.equal(implementationWorktrees.count, 0);
  } finally {
    verifyStore.close();
  }
});

test("context update accepts File Explorer output and validate reports maintenance state", async (t) => {
  const sandbox = await makeSandbox(t);
  await cli(sandbox, ["init", sandbox.repo]);
  const explorerResult = join(sandbox.root, "explorer-result.json");
  await writeFile(explorerResult, JSON.stringify({
    payload: {
      project_context: {
        project_shape: "Node.js CLI",
        memory: {
          domain_terms: ["dispatch"],
          repository_constraints: ["Node.js 22+"],
          responsibilities: ["README documents the fixture"],
          module_boundaries: ["root documentation"],
        },
        navigation: [{ feature: "Fixture", keywords: ["readme"], entry_paths: ["README.md"], module_boundary: "root" }],
        maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
      },
    },
  }));
  const updated = json<{ updated_paths: string[] }>(await cli(sandbox, [
    "context", "update", "--project", sandbox.repo, "--context-file", explorerResult,
  ]));
  assert.deepEqual(updated.updated_paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md"]);
  const validation = json<{ valid: boolean; navigation: { entries: number }; maintenance: { status: string; paths: string[] } }>(
    await cli(sandbox, ["context", "validate", "--project", sandbox.repo]),
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.navigation.entries, 1);
  assert.deepEqual(validation.maintenance, { status: "current", paths: [] });

  const memoryPath = join(sandbox.repo, "MEMORY.md");
  const navigationPath = join(sandbox.repo, ".ai-team", "index", "feature-navigation.md");
  const formatLine = /^<!-- ai-team:context-format .* -->\n/gm;
  await writeFile(memoryPath, (await readFile(memoryPath, "utf8")).replace(formatLine, ""));
  await writeFile(navigationPath, (await readFile(navigationPath, "utf8")).replace(formatLine, "").replace("# 功能导航", "# Feature Navigation"));
  const legacy = json<{ valid: boolean; navigation: { issues: string[] }; maintenance: { status: string } }>(
    await cli(sandbox, ["context", "validate", "--project", sandbox.repo]),
  );
  assert.equal(legacy.valid, false);
  assert.equal(legacy.maintenance.status, "needs_update");
  assert.ok(legacy.navigation.issues.some((issue) => issue.includes("unsupported")));
  const businessBefore = await readFile(join(sandbox.repo, "README.md"), "utf8");
  const rejected = await cli(sandbox, ["context", "update", "--project", sandbox.repo, "--context-file", explorerResult]);
  assert.equal(rejected.status, 4);
  const failure = JSON.parse(rejected.stderr) as { details: { reason_code: string; next_action: string } };
  assert.deepEqual(failure.details, { reason_code: "legacy_navigation_heading", next_action: "reinitialize_context" });
  assert.equal((json<{ valid: boolean }>(await cli(sandbox, ["context", "validate", "--project", sandbox.repo]))).valid, false);
  assert.equal(await readFile(join(sandbox.repo, "README.md"), "utf8"), businessBefore);
});

test("context validate and init reject the legacy navigation path", async (t) => {
  const sandbox = await makeSandbox(t);
  json(await cli(sandbox, ["init", sandbox.repo]));
  const canonicalPath = join(sandbox.repo, ".ai-team", "index", "feature-navigation.md");
  const legacyPath = join(sandbox.repo, ".ai-work-flow", "index", "feature-navigation.md");
  await mkdir(join(sandbox.repo, ".ai-work-flow", "index"), { recursive: true });
  await rename(canonicalPath, legacyPath);
  await writeFile(join(sandbox.repo, "MEMORY.md"), `${await readFile(join(sandbox.repo, "MEMORY.md"), "utf8")}\nLegacy: .ai-work-flow/index/feature-navigation.md\n`);

  const diagnosed = json<{ valid: boolean; navigation: { issues: string[] } }>(await cli(sandbox, ["context", "validate", "--project", sandbox.repo]));
  assert.equal(diagnosed.valid, false);
  assert.ok(diagnosed.navigation.issues.some((issue) => issue.includes(".ai-work-flow/index/feature-navigation.md") && issue.includes("reinitialize context")));

  const rejected = await cli(sandbox, ["init", sandbox.repo, "--yes"]);
  assert.equal(rejected.status, 4);
  const failure = JSON.parse(rejected.stderr) as { details: { reason_code: string; next_action: string } };
  assert.deepEqual(failure.details, { reason_code: "legacy_navigation_path", next_action: "reinitialize_context" });
  await assert.rejects(stat(canonicalPath));
  await stat(legacyPath);
  assert.match(await readFile(join(sandbox.repo, "MEMORY.md"), "utf8"), /\.ai-work-flow\/index\/feature-navigation\.md/);
});

test("run show opens read-only while a writer lock is held and creates no backup", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Inspect a run without taking the write lock.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const writer = await StateStore.open(sandbox.aiTeamHome);
  try {
    const before = await readdir(join(sandbox.aiTeamHome, "backups"));
    const shown = json<{ run: { run_id: string } }>(await cli(sandbox, ["run", "show", started.run_id]));
    assert.equal(shown.run.run_id, started.run_id);
    assert.deepEqual(await readdir(join(sandbox.aiTeamHome, "backups")), before);
  } finally {
    writer.close();
  }
});

test("direct coding rejects a dirty repository before creating a run and starts when clean", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  const request = "actual: command fails\nexpected: command succeeds\nevidence: reproducible CLI test\n";
  await writeFile(requestFile, request);
  const dirtyFile = join(sandbox.repo, "dirty.txt");
  await writeFile(dirtyFile, "uncommitted\n");

  const blocked = await cli(sandbox, [
    "coding", "start",
    "--project", sandbox.repo,
    "--mode", "bug",
    "--request-file", requestFile,
  ]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /coding start requires a clean worktree/);
  const database = new Database(join(sandbox.aiTeamHome, "state", "state.sqlite"), { readonly: true });
  const runCount = database.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number };
  database.close();
  assert.equal(runCount.count, 0);

  await unlink(dirtyFile);
  await mkdir(join(sandbox.repo, ".worktrees", "runtime"), { recursive: true });
  await writeFile(join(sandbox.repo, ".worktrees", "runtime", "owned.txt"), "owned worktree state\n");
  const started = json<{ run_id: string; dispatch_id: string }>(
    await cli(sandbox, [
      "coding", "start",
      "--project", sandbox.repo,
      "--mode", "bug",
      "--request-file", requestFile,
    ]),
  );
  const shown = json<{ run: { profile: string; mode: string; request: string; base_commit: string } }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.equal(shown.run.profile, "coding");
  assert.equal(shown.run.mode, "bug");
  assert.equal(shown.run.request, request);
  assert.match(shown.run.base_commit, /^[a-f0-9]{40}$/);
});

test("environment commands isolate homes, dry-run generation, status, and non-probing doctor", async (t) => {
  const sandbox = await makeSandbox(t);

  assert.deepEqual(json(await cli(sandbox, ["env", "list"])), ["balanced", "economy", "quality"]);
  const validation = json<{ name: string; roles: number; platforms: number; digest: string }>(
    await cli(sandbox, ["env", "validate", "balanced"]),
  );
  assert.deepEqual({ name: validation.name, roles: validation.roles, platforms: validation.platforms }, {
    name: "balanced",
    roles: 12,
    platforms: 3,
  });
  assert.match(validation.digest, /^[a-f0-9]{64}$/);

  const explanation = json<{
    environment: string;
    role: string;
    platform: string;
    value: Record<string, unknown>;
    source: { kind: string; file: string; pointer: string };
  }>(await cli(sandbox, ["env", "explain", "balanced", "--role", "coding", "--platform", "codex"]));
  assert.deepEqual(explanation, {
    environment: "balanced",
    role: "coding",
    platform: "codex",
    value: { model: "gpt-5.2", reasoning: "medium" },
    source: {
      kind: "override",
      file: join(sandbox.aiTeamHome, "environments", "balanced.yaml"),
      pointer: "/overrides/coding/codex",
    },
  });

  const allChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality"]),
  );
  assert.ok(allChanges.changes.length > 0);
  const roleChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality", "--role", "coding"]),
  );
  assert.ok(roleChanges.changes.length > 0);
  assert.ok(roleChanges.changes.every(({ role }) => role === "coding"));
  const platformChanges = json<{ changes: Array<{ role: string; platform: string }> }>(
    await cli(sandbox, ["env", "diff", "balanced", "quality", "--platform", "codex"]),
  );
  assert.ok(platformChanges.changes.length > 0);
  assert.ok(platformChanges.changes.every(({ platform }) => platform === "codex"));
  assert.deepEqual(json(await cli(sandbox, ["env", "diff", "balanced", "balanced"])), {
    from: "balanced",
    to: "balanced",
    changes: [],
  });

  const plan = json<{ writes: Array<{ path: string }>; backups: unknown[]; removals: unknown[] }>(
    await cli(sandbox, ["env", "generate", "--dry-run"]),
  );
  assert.equal(plan.writes.length, 39);
  assert.deepEqual(plan.backups, []);
  assert.deepEqual(plan.removals, []);
  assert.ok(plan.writes.every(({ path }) => path.startsWith(sandbox.userHome)));
  await assert.rejects(stat(join(sandbox.userHome, ".codex", "agents", "planning.toml")), { code: "ENOENT" });
  assert.deepEqual(json(await cli(sandbox, ["env", "status"])), []);

  const bin = join(sandbox.root, "bin");
  const probeLog = join(sandbox.root, "probe.log");
  await mkdir(bin);
  for (const executable of ["codex", "claude", "opencode"]) {
    const path = join(bin, executable);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' ${executable} >> "$AI_TEAM_PROBE_LOG"\n`);
    await chmod(path, 0o700);
  }
  sandbox.env.PATH = bin;
  sandbox.env.AI_TEAM_PROBE_LOG = probeLog;
  assert.deepEqual(json(await cli(sandbox, ["env", "doctor"])), [
    { platform: "codex", status: "not-probed" },
    { platform: "claude", status: "not-probed" },
    { platform: "opencode", status: "not-probed" },
  ]);
  await assert.rejects(stat(probeLog), { code: "ENOENT" });
});
