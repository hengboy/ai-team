import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createResultTemplate } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { ScopeGate } from "../../src/gates.js";
import { GitOrchestrator } from "../../src/git-orchestrator.js";
import { ReviewService } from "../../src/review.js";
import { completedResult, createRun, dispatchPacket, projectContext, temporaryDirectory, withStore } from "../helpers/dispatch.js";
import { REVIEW_COMMON_DIR, REVIEW_HEAD } from "../helpers/git.js";

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/dispatch/implementation-lifecycle.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
});

test("direct Git prepare phases require registered run-owned worktrees and defer the task until pre_write", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    dispatches.claim(runId, explorerId, "file-explorer");
    await dispatches.submitValue(runId, explorerId, "file-explorer", fileExplorerResult(runId, explorerId));

    const integrationPrepare = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { dispatch_id: string };
    dispatches.claim(runId, integrationPrepare.dispatch_id, "git-operator");
    const integrationResult = completedResult(runId, integrationPrepare.dispatch_id, "git-operator", {
      operations: [{ command: "reported both worktrees", outcome: "not authoritative" }],
    });
    await assert.rejects(dispatches.submitValue(runId, integrationPrepare.dispatch_id, "git-operator", integrationResult), /registered active integration worktree/);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_phase_integration", runId, "integration/phase/test", `/tmp/${runId}-integration`, REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, integrationPrepare.dispatch_id, "git-operator", integrationResult);

    const gate = new ScopeGate(store);
    gate.check(runId, "triage", ["src/dispatch.ts"]);
    gate.check(runId, "pre_write", ["src/dispatch.ts"]);
    gate.check(runId, "pre_write", ["src/dispatch.ts"]);
    const implementationRows = store.db.prepare(`SELECT dispatch_id FROM dispatches
      WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='prepare_implementation_worktree'`).all(runId) as Array<{ dispatch_id: string }>;
    assert.equal(implementationRows.length, 1);

    const implementationId = implementationRows[0]!.dispatch_id;
    dispatches.claim(runId, implementationId, "git-operator");
    const implementationResult = completedResult(runId, implementationId, "git-operator", {
      operations: [{ command: "reported task worktree", outcome: "not authoritative" }],
    });
    await assert.rejects(dispatches.submitValue(runId, implementationId, "git-operator", implementationResult), /registered active implementation task worktree/);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_phase_implementation", runId, "task/phase/test/implementation", `/tmp/${runId}-implementation`, REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, implementationId, "git-operator", implementationResult);
  });
});

test("planned Git prepare ignores arbitrary direct integration worktrees", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const runId = store.createRun({
      repoId,
      profile: "coding",
      mode: "planned",
      planId: "20260816-identity",
      revision: "001",
      baseCommit: REVIEW_HEAD,
      targetBranch: "main",
    });
    const dispatches = new DispatchService(store);
    const prepareId = dispatches.ensureGitPrepareDispatch(runId, "integration");
    dispatches.claim(runId, prepareId, "git-operator");
    const result = completedResult(runId, prepareId, "git-operator", { operations: [{ command: "prepare", outcome: "completed" }] });
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_wrong_planned_integration", runId, "integration/direct/wrong", `/tmp/${runId}-wrong`, REVIEW_HEAD, new Date().toISOString());

    await assert.rejects(dispatches.submitValue(runId, prepareId, "git-operator", result), /registered active integration worktree or plan worktree/);
    const planId = "20260816-identity";
    const planRevision = `${planId}-001`;
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_exact_planned", runId, `plan/${planId}/${planRevision}`, join(process.cwd(), ".worktrees", "plans", planId, planRevision), REVIEW_HEAD, new Date().toISOString());
    await dispatches.submitValue(runId, prepareId, "git-operator", result);
  });
});

test("planned Coding dispatch waits for Git Operator and exposes dispatch dependencies", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const planId = "20260817-dispatch-order";
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId, revision: "001", baseCommit: REVIEW_HEAD, targetBranch: "main", planDigest: "a".repeat(64) });
    const planRevision = `${planId}-001`;
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_dispatch_order", runId, `plan/${planId}/${planRevision}`, join(process.cwd(), ".worktrees", "plans", planId, planRevision), REVIEW_HEAD, new Date().toISOString());
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    dispatches.claim(runId, explorerId, "file-explorer");
    const explorerSubmission = await dispatches.submitValue(runId, explorerId, "file-explorer", fileExplorerResult(runId, explorerId));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='coding'").get(runId) as { count: number }).count, 0);
    assert.equal(explorerSubmission.continuation.pending_dispatches[0]?.role, "git-operator");
    assert.deepEqual(explorerSubmission.continuation.pending_dispatches[0]?.depends_on, [explorerId]);

    const gitDispatch = explorerSubmission.continuation.pending_dispatches[0]!;
    dispatches.claim(runId, gitDispatch.dispatch_id, "git-operator");
    const gitSubmission = await dispatches.submitValue(runId, gitDispatch.dispatch_id, "git-operator", completedResult(runId, gitDispatch.dispatch_id, "git-operator", {
      operations: [{ command: "verify registered plan worktree", outcome: "verified" }],
    }));
    assert.equal(gitSubmission.continuation.pending_dispatches[0]?.role, "coding");
    assert.deepEqual(new Set(gitSubmission.continuation.pending_dispatches[0]?.depends_on), new Set([explorerId, gitDispatch.dispatch_id]));
  });
});

test("planned task prepare completion creates one identity-bound Coding continuation", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "20260817-continuation", revision: "001" });
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const coordinatorId = dispatches.create(runId, "coding", {
      ...dispatchPacket(["src/dispatch.ts", "test/dispatch/implementation-lifecycle.test.ts"]),
      context: { explorer_dispatch_id: explorerId },
    });
    dispatches.claim(runId, coordinatorId, "coding");
    const prepareId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket([]),
      context: {
        phase: "prepare_implementation_worktree",
        task_id: "TASK-001",
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: coordinatorId,
      },
    }, "coding", coordinatorId);
    await dispatches.submitValue(runId, coordinatorId, "coding", completedResult(runId, coordinatorId, "coding", { actions: ["prepare TASK-001"] }));
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_task_001", runId, "task/20260817-continuation/20260817-continuation-001--task-001", `/tmp/${runId}-task-001`, REVIEW_HEAD, new Date().toISOString());
    dispatches.claim(runId, prepareId, "git-operator");
    const submitted = await dispatches.submitValue(runId, prepareId, "git-operator", completedResult(runId, prepareId, "git-operator", {
      operations: [{ command: "ai-team git prepare --task-id TASK-001", outcome: "registered worktree_task_001" }],
    }));

    assert.equal(submitted.continuation.pending_dispatches.length, 1);
    const continuationId = submitted.continuation.pending_dispatches[0]!.dispatch_id;
    const continuation = store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(continuationId) as { replacement_for: string; packet_json: string };
    const context = JSON.parse(continuation.packet_json).context;
    assert.equal(continuation.replacement_for, coordinatorId);
    assert.deepEqual({
      phase: context.phase,
      explorer_dispatch_id: context.explorer_dispatch_id,
      coordinator_dispatch_id: context.coordinator_dispatch_id,
      prepare_git_dispatch_id: context.prepare_git_dispatch_id,
      task_id: context.task_id,
      worktree_id: context.worktree_id,
    }, {
      phase: "continue_implementation",
      explorer_dispatch_id: explorerId,
      coordinator_dispatch_id: coordinatorId,
      prepare_git_dispatch_id: prepareId,
      task_id: "TASK-001",
      worktree_id: "worktree_task_001",
    });
    assert.deepEqual(dispatches.resume(runId).pending_dispatches, submitted.continuation.pending_dispatches.map(({ dispatch_id, role, state }) => ({ dispatch_id, role, state })));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count, 0);

    dispatches.claim(runId, continuationId, "coding");
    const developerPacket = {
      objective: "Implement TASK-001",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: ["src/dispatch.ts"],
      acceptance_criteria: ["Implement the frozen task"],
      context: {
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: continuationId,
        task_id: "TASK-001",
        worktree_id: "worktree_task_001",
        worktree_path: `/tmp/${runId}-task-001`,
      },
    };
    assert.throws(() => dispatches.create(runId, "backend-developer", {
      ...developerPacket,
      context: { ...developerPacket.context, task_id: "TASK-002" },
    }, "coding", continuationId), /preserve its frozen task identity/);
    assert.match(dispatches.create(runId, "backend-developer", developerPacket, "coding", continuationId), /^dispatch_/);
  });
});

test("pre_commit_then_refreeze dispatches Git from the real dirty diff and refreezes post-commit evidence", async () => {
  await withStore(async (store) => {
    const repository = await temporaryDirectory();
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      await mkdir(join(repository, ".ai-team", "index"), { recursive: true });
      await mkdir(join(repository, "src", "components", "AiRoutingGateway"), { recursive: true });
      await writeFile(join(repository, "MEMORY.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
      await writeFile(join(repository, "src", "components", "AiRoutingGateway", "index.tsx"), "export const gateway = 1;\n");
      await writeFile(join(repository, "src", "components", "AiRoutingGateway", "AiRoutingGateway.test.tsx"), "export const tested = true;\n");
      await writeFile(join(repository, "src", "i18n.ts"), "export const locale = 'en';\n");
      await writeFile(join(repository, "package.json"), "{\"name\":\"fixture\"}\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      const planId = "pre-commit-refreeze";
      const revision = "001";
      const worktreePath = join(repository, ".worktrees", "plans", planId, `${planId}-${revision}`);
      await mkdir(join(repository, ".worktrees", "plans", planId), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", `plan/${planId}/${planId}-${revision}`, worktreePath, baseCommit], { cwd: repository });

      store.registerRepository("repo-pre-commit-refreeze", join(repository, ".git"), repository);
      const runId = store.createRun({ repoId: "repo-pre-commit-refreeze", profile: "coding", mode: "planned", request: "refreeze", planId, revision, baseCommit });
      store.db.prepare("UPDATE runs SET plan_digest=? WHERE run_id=?").run("plan-digest-refreeze", runId);
      const worktreeId = "worktree_pre_commit_refreeze";
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, `plan/${planId}/${planId}-${revision}`, worktreePath, baseCommit, new Date().toISOString());
      const allowedPaths = [
        "src/components/AiRoutingGateway/index.tsx",
        "src/components/AiRoutingGateway/AiRoutingGateway.test.tsx",
        "src/i18n.ts",
      ];
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify({
        ...fileExplorerResult(runId, explorerId),
        payload: { ...fileExplorerResult(runId, explorerId).payload, allowed_read_paths: allowedPaths },
      }), new Date().toISOString(), explorerId);
      const codingId = dispatches.create(runId, "coding", {
        ...dispatchPacket(allowedPaths), context: { explorer_dispatch_id: explorerId, worktree_id: worktreeId },
      });
      dispatches.claim(runId, codingId, "coding");
      const developerId = dispatches.create(runId, "frontend-developer", {
        ...dispatchPacket(allowedPaths),
        allowed_write_paths: allowedPaths,
        context: { explorer_dispatch_id: explorerId, worktree_id: worktreeId },
      }, "coding", codingId);
      await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["implemented"] }));
      dispatches.claim(runId, developerId, "frontend-developer");
      await writeFile(join(worktreePath, allowedPaths[0]!), "export const gateway = 2;\n");
      await dispatches.submitValue(runId, developerId, "frontend-developer", completedResult(runId, developerId, "frontend-developer", {
        modified_paths: [...allowedPaths, "package.json"], self_tests: [{ command: "npm test", outcome: "passed" }],
      }));
      const implementationArtifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE dispatch_id=?").get(developerId) as { artifact_id: string; sha256: string };

      const preCommitTestId = dispatches.create(runId, "test", {
        ...dispatchPacket(allowedPaths),
        context: { implementation_commit: baseCommit, implementation_committed: false, changed_paths: [...allowedPaths, "package.json"] },
      });
      dispatches.claim(runId, preCommitTestId, "test");
      await dispatches.submitValue(runId, preCommitTestId, "test", completedResult(runId, preCommitTestId, "test", {
        checks: [{ command: "npm test", outcome: "passed" }],
      }));
      assert.equal(dispatches.buildReviewPacket(runId), undefined);
      assert.throws(() => new ReviewService(store).create(runId, baseCommit, true), /review requires/);

      const reviewerId = dispatches.create(runId, "code-reviewer", {
        ...dispatchPacket([]),
        context: { implementation_commit: baseCommit, revision_sha: baseCommit, changed_paths: [], committed_diff: "" },
      });
      dispatches.claim(runId, reviewerId, "code-reviewer");
      await dispatches.submitValue(runId, reviewerId, "code-reviewer", {
        ...createResultTemplate(runId, reviewerId, "code-reviewer"),
        status: "needs_decision",
        summary: "Commit before refreezing review",
        verification: [],
        decisions_needed: [{
          question: "How should review continue?",
          choices: [
            { id: "pre_commit_then_refreeze", label: "Commit then refreeze", impact: "Bind review to a real commit" },
            { id: "abort", label: "Abort", impact: "Stop review without committing" },
          ],
          recommendation: "pre_commit_then_refreeze",
          type: "review_refreeze",
        }],
        payload: {},
      });
      const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
      const gitDispatchId = dispatches.resolveDecision(runId, decision.decision_id, "pre_commit_then_refreeze");
      assert.equal(dispatches.resolveDecision(runId, decision.decision_id, "pre_commit_then_refreeze"), gitDispatchId);
      const gitRow = store.db.prepare("SELECT role,packet_json FROM dispatches WHERE dispatch_id=?").get(gitDispatchId) as { role: string; packet_json: string };
      const gitPacket = JSON.parse(gitRow.packet_json);
      assert.equal(gitRow.role, "git-operator");
      assert.equal(gitPacket.context.phase, "pre_commit_implementation");
      assert.deepEqual(gitPacket.context.changed_paths, [allowedPaths[0]]);
      assert.equal(gitPacket.context.changed_paths.includes("package.json"), false);
      assert.deepEqual(gitPacket.allowed_write_paths, allowedPaths);
      assert.equal(gitPacket.context.plan_id, planId);
      assert.equal(gitPacket.context.revision, revision);
      assert.equal(gitPacket.context.plan_digest, "plan-digest-refreeze");
      assert.equal(gitPacket.context.worktree_id, worktreeId);
      assert.equal(gitPacket.context.explorer_dispatch_id, explorerId);
      assert.deepEqual(gitPacket.context.implementation_artifact, { artifact_id: implementationArtifact.artifact_id, digest: implementationArtifact.sha256 });
      assert.deepEqual(dispatches.resume(runId).pending_dispatches.map(({ dispatch_id }) => dispatch_id), [gitDispatchId]);

      dispatches.claim(runId, gitDispatchId, "git-operator");
      const committed = await new GitOrchestrator(store).commit(runId, worktreeId, "Commit implementation", allowedPaths, gitDispatchId);
      await dispatches.submitValue(runId, gitDispatchId, "git-operator", completedResult(runId, gitDispatchId, "git-operator", {
        operations: [{ command: "git commit", outcome: committed.commit }],
      }));
      const tests = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='test' ORDER BY created_at").all(runId) as Array<{ dispatch_id: string; packet_json: string }>;
      assert.equal(tests.length, 2);
      const postCommitTest = tests[1]!;
      const postCommitPacket = JSON.parse(postCommitTest.packet_json);
      assert.equal(postCommitPacket.context.implementation_commit, committed.commit);
      assert.equal(postCommitPacket.context.implementation_committed, true);
      assert.deepEqual(postCommitPacket.context.changed_paths, [allowedPaths[0]]);
      assert.deepEqual(postCommitPacket.context.test_commands, [
        "npm run test -- src/components/AiRoutingGateway/AiRoutingGateway.test.tsx",
        "npm run test",
        "npm run lint",
        "npm run build",
      ]);
      dispatches.claim(runId, postCommitTest.dispatch_id, "test");
      await dispatches.submitValue(runId, postCommitTest.dispatch_id, "test", completedResult(runId, postCommitTest.dispatch_id, "test", {
        checks: postCommitPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })),
      }));
      const postCommitReview = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='code-reviewer' ORDER BY created_at DESC LIMIT 1").get(runId) as { packet_json: string };
      assert.equal(JSON.parse(postCommitReview.packet_json).context.revision_sha, committed.commit);
      const barrier = new ReviewService(store).create(runId, committed.commit, true);
      assert.deepEqual(barrier.axes, ["spec", "standards"]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

test("coding decisions are created from results and resolution atomically resumes the blocked dispatch", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const reviewerId = dispatches.create(runId, "code-reviewer", dispatchPacket());
    dispatches.claim(runId, reviewerId, "code-reviewer");
    const decision = {
      question: "Which review baseline should be used?",
      choices: [
        { id: "implementation", label: "Implementation commit", impact: "Review the submitted task commit" },
        { id: "integration", label: "Integration HEAD", impact: "Prepare integration before review" },
      ],
      recommendation: "implementation",
      type: "review_baseline",
    };
    await dispatches.submitValue(runId, reviewerId, "code-reviewer", {
      ...createResultTemplate(runId, reviewerId, "code-reviewer"),
      status: "needs_decision",
      summary: "Review baseline is ambiguous",
      verification: [],
      decisions_needed: [decision],
      payload: {},
    });

    const pending = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    assert.equal(store.getRun(runId).state, "needs_decision");
    const continuationId = dispatches.resolveDecision(runId, pending.decision_id, "implementation");
    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.equal(resumed.pending_decision, null);
    assert.deepEqual(resumed.pending_dispatches, [{ dispatch_id: continuationId, role: "code-reviewer", state: "pending" }]);
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(reviewerId) as { state: string }).state, "completed");
  });
});

test("implementation dependencies and commit gate test creation and freeze the complete review packet", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const codingId = dispatches.create(runId, "coding", dispatchPacket());
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_regression", runId, "task/regression", `${process.cwd()}/.worktrees/defect-regression`, REVIEW_HEAD, new Date().toISOString());
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_integration", runId, "integration/regression", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const changedPaths = ["src/dispatch.ts", "src/state.ts", "src/contracts.ts", "src/cli.ts", "src/review.ts", "test/dispatch/implementation-lifecycle.test.ts"];
    const developerId = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(changedPaths), context: { worktree_id: "worktree_defect_regression" },
    }, "coding", codingId);
    const frontendId = dispatches.create(runId, "frontend-developer", {
      ...dispatchPacket(changedPaths), context: { worktree_id: "worktree_defect_regression" },
    }, "coding", codingId);
    const gitId = dispatches.create(runId, "git-operator", dispatchPacket(changedPaths), "coding", codingId);

    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["dispatch implementation"] }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    dispatches.claim(runId, developerId, "backend-developer");
    await dispatches.submitValue(runId, developerId, "backend-developer", completedResult(runId, developerId, "backend-developer", {
      modified_paths: changedPaths, self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", completedResult(runId, frontendId, "frontend-developer", {
      modified_paths: changedPaths, self_tests: [{ command: "npm test", outcome: "passed" }],
    }));

    const commit = store.beginOperation("git.commit", `commit:${runId}:regression`, { paths: changedPaths }, runId);
    store.finishOperation(commit.operationId, { commit: REVIEW_HEAD, paths: changedPaths, worktree_id: "worktree_defect_regression" });
    dispatches.claim(runId, gitId, "git-operator");
    await dispatches.submitValue(runId, gitId, "git-operator", completedResult(runId, gitId, "git-operator", {
      operations: [{ command: "git commit", outcome: REVIEW_HEAD }],
    }));
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { count: number }).count, 0);
    const integrationDispatch = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='integrate_implementation'").get(runId) as { dispatch_id: string };
    const merge = store.beginOperation("git.merge.task", `merge:${runId}:regression`, {}, runId);
    store.finishOperation(merge.operationId, {
      commit: REVIEW_HEAD,
      task_worktree_id: "worktree_defect_regression",
      integration_worktree_id: "worktree_defect_integration",
    });
    dispatches.claim(runId, integrationDispatch.dispatch_id, "git-operator");
    await dispatches.submitValue(runId, integrationDispatch.dispatch_id, "git-operator", completedResult(runId, integrationDispatch.dispatch_id, "git-operator", {
      operations: [{ command: "git merge", outcome: REVIEW_HEAD }],
    }));
    const testRow = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='test'").get(runId) as { dispatch_id: string; packet_json: string };
    assert.equal(JSON.parse(testRow.packet_json).context.implementation_commit, REVIEW_HEAD);

    dispatches.claim(runId, testRow.dispatch_id, "test");
    await dispatches.submitValue(runId, testRow.dispatch_id, "test", completedResult(runId, testRow.dispatch_id, "test", {
      checks: [{ command: "npm test", outcome: "passed" }],
    }));
    const storedTest = JSON.parse((store.db.prepare("SELECT result_json FROM dispatches WHERE dispatch_id=?").get(testRow.dispatch_id) as { result_json: string }).result_json);
    assert.equal(storedTest.payload.testedCommit, REVIEW_HEAD);
    const review = store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND role='code-reviewer'").get(runId) as { packet_json: string };
    const packet = JSON.parse(review.packet_json);
    const committedPaths = execFileSync("git", ["diff", "--name-only", `${REVIEW_HEAD}^`, REVIEW_HEAD], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.equal(packet.context.implementation_commit, REVIEW_HEAD);
    assert.equal(packet.context.revision_sha, REVIEW_HEAD);
    assert.match(packet.context.base_commit, /^[a-f0-9]{40}$/);
    assert.match(packet.context.document_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(packet.context.changed_paths, committedPaths);
    assert.equal(packet.context.changed_paths.includes("package.json"), committedPaths.includes("package.json"));
    assert.match(packet.context.diff_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.test_evidence_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.revision_digest, /^[a-f0-9]{64}$/);
    assert.match(packet.context.evidence_digest, /^[a-f0-9]{64}$/);
    assert.equal(packet.context.testedCommit, REVIEW_HEAD);
    assert.deepEqual(new Set(packet.context.artifacts.map((artifact: { role: string }) => artifact.role)), new Set(["coding", "frontend-developer", "backend-developer", "git-operator", "test"]));
    assert.ok(packet.context.artifacts.every((artifact: { artifact_id: string; sha256: string }) => /^artifact_/.test(artifact.artifact_id) && /^[a-f0-9]{64}$/.test(artifact.sha256)));
    assert.ok(committedPaths.every((path) => packet.allowed_read_paths.includes(path)));
  });
});
