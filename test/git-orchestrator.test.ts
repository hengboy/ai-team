import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DispatchService } from "../src/dispatch.js";
import { IncompatibleError, ValidationError } from "../src/errors.js";
import { repositoryIdentity } from "../src/git.js";
import { GitOrchestrator } from "../src/git-orchestrator.js";
import { StateStore } from "../src/state.js";

interface Fixture {
  root: string;
  store: StateStore;
  orchestrator: GitOrchestrator;
  createRun: (mode?: "implementation" | "planned") => Promise<string>;
  claimGitOperator: (runId: string) => string;
  dispose: () => Promise<void>;
}

const fixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "ai-team-git-contract-"));
  const root = join(directory, "repository");
  const home = join(directory, "home");
  await mkdir(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "AI Team Test");
  git("config", "user.email", "ai-team@example.test");
  await writeFile(join(root, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-m", "Initial commit");
  const identity = await repositoryIdentity(root);
  const store = await StateStore.open(home);
  store.registerRepository(identity.repoId, identity.commonDir, identity.root);
  const createRun = async (mode: "implementation" | "planned" = "implementation") => store.createRun({
    repoId: identity.repoId,
    profile: "coding",
    mode,
    ...(mode === "planned" ? { planId: "plan", revision: "001" } : {}),
    baseCommit: git("rev-parse", "HEAD"),
    targetBranch: "main",
    request: "Git contract test",
  });
  const claimGitOperator = (runId: string) => {
    const dispatches = new DispatchService(store);
    const dispatchId = dispatches.create(runId, "git-operator", {
      objective: "Prepare the canonical worktree.",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["A canonical worktree is registered"],
      context: { phase: "prepare_initial_plan_worktree" },
    }, "coding");
    dispatches.claim(runId, dispatchId, "git-operator");
    return dispatchId;
  };
  return {
    root,
    store,
    orchestrator: new GitOrchestrator(store),
    createRun,
    claimGitOperator,
    dispose: async () => { store.close(); await rm(directory, { recursive: true, force: true }); },
  };
};

test("claimed Git Operator dispatch creates a canonical planned worktree", async () => {
  const value = await fixture();
  try {
    const runId = await value.createRun("planned");
    const prepared = await value.orchestrator.prepareIntegration(runId, value.claimGitOperator(runId));
    assert.equal(prepared.branch, "plan/plan/plan-001");
    assert.equal(prepared.path, await realpath(join(value.root, ".worktrees", "plans", "plan", "plan-001")));
    assert.equal(prepared.reused, false);
  } finally {
    await value.dispose();
  }
});

test("Git writes reject missing and unclaimed Git Operator dispatches", async () => {
  const value = await fixture();
  try {
    const runId = await value.createRun();
    await assert.rejects(() => (value.orchestrator as any).prepareIntegration(runId), ValidationError);
    const dispatchId = new DispatchService(value.store).create(runId, "git-operator", {
      objective: "Prepare a worktree.", allowed_read_paths: [], allowed_write_paths: [], acceptance_criteria: ["prepare"], context: {},
    }, "coding");
    await assert.rejects(() => value.orchestrator.prepareIntegration(runId, dispatchId), ValidationError);
  } finally {
    await value.dispose();
  }
});

test("legacy integration worktree layouts are rejected without provenance recovery", async () => {
  const value = await fixture();
  try {
    const runId = await value.createRun("planned");
    const legacyPath = join(value.root, ".worktrees", "integration", "plan", "legacy");
    value.store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_legacy", runId, "integration/plan/legacy", legacyPath, execFileSync("git", ["rev-parse", "HEAD"], { cwd: value.root, encoding: "utf8" }).trim(), new Date().toISOString());
    await assert.rejects(() => value.orchestrator.prepareIntegration(runId, value.claimGitOperator(runId)), (error: unknown) => {
      assert.ok(error instanceof IncompatibleError);
      assert.deepEqual(error.details, {
        reason_code: "legacy_plan_worktree_layout",
        next_action: "recreate_worktree",
        branch: "integration/plan/legacy",
        path: legacyPath,
      });
      return true;
    });
  } finally {
    await value.dispose();
  }
});
