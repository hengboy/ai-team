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
import { verificationDigest } from "../../src/planning.js";
import { sha256 } from "../../src/utils.js";
import { completedResult, createRun, dispatchPacket, projectContext, temporaryDirectory, withStore } from "../helpers/dispatch.js";
import { REVIEW_COMMON_DIR, REVIEW_HEAD } from "../helpers/git.js";

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/dispatch/implementation-lifecycle.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
});

test("planned and direct packets freeze TDD contracts and require Developer/Test AC evidence", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const plan = {
      acceptance_criteria: ["AC-001"],
      acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
      task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
      test_commands: ["npm test"],
    };
    const task = {
      ...plan,
      tdd_cycles: [{ acceptance_criterion: "AC-001", test_path: "test/example.test.ts", red: { command: "npm test", expected_failure: "fails" }, green: { implementation_steps: ["implement"], command: "npm test", expected_result: "passes" }, refactor: { scope: "none", command: "npm test", expected_result: "passes" } }],
    };
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "tdd-plan", revision: "001", planVerification: plan });
    store.initializeRunTasks(runId, [{ task_id: "TASK-001", source_path: "tasks/TASK-001.md", source_digest: "a".repeat(64), write_paths: ["src/dispatch.ts"], verification: task }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_tdd", runId, "plan/tdd-plan/tdd-plan-001", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);

    const developerId = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]),
      allowed_write_paths: ["src/dispatch.ts"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_tdd", task_id: "TASK-001" },
    }, "coding");
    const developerPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(developerId) as { packet_json: string }).packet_json);
    assert.deepEqual(developerPacket.context.task_verification, task);
    assert.equal(developerPacket.context.task_verification_digest, verificationDigest(task));
    assert.equal(developerPacket.context.context_owner, "backend-developer");
    assert.deepEqual(developerPacket.context.context_maintenance.paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md"]);
    dispatches.claim(runId, developerId, "backend-developer");
    const missingDeveloperEvidence = completedResult(runId, developerId, "backend-developer", { modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] });
    assert.throws(() => dispatches.validateValue(runId, developerId, "backend-developer", missingDeveloperEvidence), /TDD evidence/);
    assert.doesNotThrow(() => dispatches.validateValue(runId, developerId, "backend-developer", {
      ...missingDeveloperEvidence,
      payload: {
        ...missingDeveloperEvidence.payload,
        verification_digest: verificationDigest(task),
        tdd_evidence: [{ acceptance_criterion: "AC-001", test_path: "test/example.test.ts", red: { command: "npm test", outcome: "failed as expected" }, green: { command: "npm test", outcome: "passed" }, refactor: { command: "npm test", outcome: "passed" } }],
      },
    }));

    assert.throws(() => dispatches.create(runId, "test", { ...dispatchPacket(["src/dispatch.ts"]), allowed_write_paths: ["src/dispatch.ts"] }), /write paths/);
    const testId = dispatches.create(runId, "test", dispatchPacket(["src/dispatch.ts"]));
    const testPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(testId) as { packet_json: string }).packet_json);
    assert.deepEqual(testPacket.context.plan_verification, plan);
    assert.equal(testPacket.context.plan_verification_digest, verificationDigest(plan));
    dispatches.claim(runId, testId, "test");
    const missingChecks = completedResult(runId, testId, "test", { checks: [{ command: "npm test", outcome: "passed" }], verification_digest: verificationDigest(plan) });
    assert.throws(() => dispatches.validateValue(runId, testId, "test", missingChecks), /acceptance checks/);
    assert.doesNotThrow(() => dispatches.validateValue(runId, testId, "test", {
      ...missingChecks,
      payload: { ...missingChecks.payload, verification_digest: verificationDigest(plan), acceptance_checks: [{ acceptance_criterion: "AC-001", command: "npm test", outcome: "passed" }] },
    }));

    const directRunId = store.createRun({ repoId, profile: "coding", mode: "feature", planVerification: plan });
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_direct_tdd", directRunId, "task/direct/tdd", `/tmp/${directRunId}-tdd`, REVIEW_HEAD, new Date().toISOString());
    const directExplorerId = dispatches.create(directRunId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(directRunId, directExplorerId)), new Date().toISOString(), directExplorerId);
    const directDeveloperId = dispatches.create(directRunId, "backend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]),
      allowed_write_paths: ["src/dispatch.ts"],
      context: { explorer_dispatch_id: directExplorerId, worktree_id: "worktree_direct_tdd" },
    }, "coding");
    const directDeveloperPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(directDeveloperId) as { packet_json: string }).packet_json);
    assert.deepEqual(directDeveloperPacket.context.verification_contract, plan);
    dispatches.claim(directRunId, directDeveloperId, "backend-developer");
    const directMissingEvidence = completedResult(directRunId, directDeveloperId, "backend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    });
    assert.throws(() => dispatches.validateValue(directRunId, directDeveloperId, "backend-developer", directMissingEvidence), /TDD evidence/);

    const directTestId = dispatches.create(directRunId, "test", dispatchPacket(["src/dispatch.ts"]));
    dispatches.claim(directRunId, directTestId, "test");
    const directMissingChecks = completedResult(directRunId, directTestId, "test", {
      checks: [{ command: "npm test", outcome: "passed" }], verification_digest: verificationDigest(plan),
    });
    assert.throws(() => dispatches.validateValue(directRunId, directTestId, "test", directMissingChecks), /acceptance checks/);
  });
});

test("failed task, final, and review-repair Tests return through Coding to the original Developer", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "repair-loop", revision: "001" });
    store.initializeRunTasks(runId, [{ task_id: "TASK-001", source_path: "tasks/TASK-001.md", source_digest: "a".repeat(64), write_paths: ["src/dispatch.ts"] }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_repair_loop", runId, "plan/repair-loop/repair-loop-001", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    store.advanceRunTask(runId, "TASK-001", "prepared", { worktree_id: "worktree_repair_loop" });
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const originalDeveloper = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]), allowed_write_paths: ["src/dispatch.ts"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_repair_loop", task_id: "TASK-001" },
    }, "coding");
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, originalDeveloper, "backend-developer", { modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }] })), new Date().toISOString(), originalDeveloper);
    store.advanceRunTask(runId, "TASK-001", "implemented", { developer_dispatch_id: originalDeveloper, worktree_id: "worktree_repair_loop" });

    const scopes = [
      { scope: "task", phase: "task_test", extra: { task_id: "TASK-001" } },
      { scope: "final", phase: undefined, extra: {} },
      { scope: "review_repair", phase: "review_repair_test", extra: { barrier_id: "review_aaaaaaaaaaaaaaaaaaaaaaaa" } },
    ] as const;
    const created: Array<{ source: string; coding: string; scope: string }> = [];
    for (const item of scopes) {
      const source = dispatches.create(runId, "test", {
        ...dispatchPacket(["src/dispatch.ts"]),
        context: {
          stage: "test", ...(item.phase ? { phase: item.phase } : {}), ...item.extra,
          explorer_dispatch_id: explorerId, worktree_id: "worktree_repair_loop", worktree_path: process.cwd(),
          implementation_dispatch_id: originalDeveloper, implementation_commit: REVIEW_HEAD,
          test_commands: ["npm test"],
        },
      });
      dispatches.claim(runId, source, "test");
      const failed = completedResult(runId, source, "test", { checks: [{ command: "npm test", outcome: "failed" }] });
      await dispatches.submitValue(runId, source, "test", { ...failed, status: "failed", failure_class: "test_failure", side_effect_state: "none" });
      const lineage = store.db.prepare("SELECT * FROM test_repair_lineage WHERE source_test_dispatch_id=?").get(source) as { test_scope: string; attempt: number; developer_role: string; worktree_id: string; coding_dispatch_id: string };
      assert.deepEqual({ scope: lineage.test_scope, attempt: lineage.attempt, role: lineage.developer_role, worktree: lineage.worktree_id }, {
        scope: item.scope, attempt: 1, role: "backend-developer", worktree: "worktree_repair_loop",
      });
      const codingPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(lineage.coding_dispatch_id) as { packet_json: string }).packet_json);
      assert.equal(codingPacket.context.phase, "test_repair");
      assert.equal(codingPacket.context.source_test_dispatch_id, source);
      created.push({ source, coding: lineage.coding_dispatch_id, scope: item.scope });
    }

    const taskRepair = created[0]!;
    dispatches.claim(runId, taskRepair.coding, "coding");
    const repairDeveloper = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]), allowed_write_paths: ["src/dispatch.ts"],
      context: {
        phase: "test_repair", test_scope: "task", source_test_dispatch_id: taskRepair.source,
        explorer_dispatch_id: explorerId, worktree_id: "worktree_repair_loop", worktree_path: process.cwd(), task_id: "TASK-001",
        coordinator_dispatch_id: taskRepair.coding,
      },
    }, "coding", taskRepair.coding);
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(repairDeveloper) as { replacement_for: string }).replacement_for, originalDeveloper);
    await dispatches.submitValue(runId, taskRepair.coding, "coding", completedResult(runId, taskRepair.coding, "coding", { actions: ["repair"] }));
    dispatches.claim(runId, repairDeveloper, "backend-developer");
    await dispatches.submitValue(runId, repairDeveloper, "backend-developer", completedResult(runId, repairDeveloper, "backend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    const lineage = store.db.prepare("SELECT repair_developer_dispatch_id,retest_dispatch_id FROM test_repair_lineage WHERE source_test_dispatch_id=?").get(taskRepair.source) as { repair_developer_dispatch_id: string; retest_dispatch_id: string };
    assert.equal(lineage.repair_developer_dispatch_id, repairDeveloper);
    assert.match(lineage.retest_dispatch_id, /^dispatch_/);
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(lineage.retest_dispatch_id) as { replacement_for: string }).replacement_for, taskRepair.source);
    assert.equal(store.runTasks(runId)[0]!.state, "implemented");
    dispatches.claim(runId, lineage.retest_dispatch_id, "test");
    const failedRetest = completedResult(runId, lineage.retest_dispatch_id, "test", { checks: [{ command: "npm test", outcome: "failed again" }] });
    await dispatches.submitValue(runId, lineage.retest_dispatch_id, "test", { ...failedRetest, status: "failed", failure_class: "test_failure", side_effect_state: "none" });
    const secondAttempt = store.db.prepare("SELECT attempt,developer_role,worktree_id FROM test_repair_lineage WHERE source_test_dispatch_id=?").get(lineage.retest_dispatch_id) as { attempt: number; developer_role: string; worktree_id: string };
    assert.deepEqual(secondAttempt, { attempt: 2, developer_role: "backend-developer", worktree_id: "worktree_repair_loop" });
  });
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
      await mkdir(join(repository, ".ai-team", "plans", "pre-commit-refreeze", "revisions", "001"), { recursive: true });
      await mkdir(join(repository, "src", "components", "AiRoutingGateway"), { recursive: true });
      await writeFile(join(repository, "MEMORY.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "plans", "pre-commit-refreeze", "revisions", "001", "plan.md"), "# plan\n\n## 验证\n\n- Run repository scripts.\n");
      await writeFile(join(repository, "src", "components", "AiRoutingGateway", "index.tsx"), "export const gateway = 1;\n");
      await writeFile(join(repository, "src", "components", "AiRoutingGateway", "AiRoutingGateway.test.tsx"), "export const tested = true;\n");
      await writeFile(join(repository, "src", "i18n.ts"), "export const locale = 'en';\n");
      await writeFile(join(repository, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint .", build: "tsc" } }));
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
        "npm run test",
        "npm run lint",
        "npm run build",
      ]);
      assert.deepEqual(postCommitPacket.context.test_command_provenance, {
        explorer_dispatch_id: explorerId,
        plan_id: planId,
        revision,
        repo_id: "repo-pre-commit-refreeze",
      });
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
    const changedPaths = execFileSync("git", ["diff", "--name-only", `${REVIEW_HEAD}^`, REVIEW_HEAD], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify({
      ...fileExplorerResult(runId, explorerId),
      payload: { ...fileExplorerResult(runId, explorerId).payload, allowed_read_paths: changedPaths },
    }), new Date().toISOString(), explorerId);
    const codingId = dispatches.create(runId, "coding", { ...dispatchPacket(changedPaths), context: { explorer_dispatch_id: explorerId } });
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_regression", runId, "task/regression", `${process.cwd()}/.worktrees/defect-regression`, REVIEW_HEAD, new Date().toISOString());
    const reviewBase = execFileSync("git", ["rev-parse", `${REVIEW_HEAD}^`], { encoding: "utf8" }).trim();
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_defect_integration", runId, "integration/regression", process.cwd(), reviewBase, new Date().toISOString());
    const developerId = dispatches.create(runId, "backend-developer", {
      ...dispatchPacket(changedPaths), context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_defect_regression" },
    }, "coding", codingId);
    const frontendId = dispatches.create(runId, "frontend-developer", {
      ...dispatchPacket(changedPaths), context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_defect_regression" },
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
    const testPacket = JSON.parse(testRow.packet_json);
    assert.equal(testPacket.context.implementation_commit, REVIEW_HEAD);

    dispatches.claim(runId, testRow.dispatch_id, "test");
    await dispatches.submitValue(runId, testRow.dispatch_id, "test", completedResult(runId, testRow.dispatch_id, "test", {
      checks: testPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })),
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

test("planned multi-Task resume handles a premature final Test and prepares the next Task from current plan HEAD", async () => {
  await withStore(async (store) => {
    const repository = await temporaryDirectory();
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      await mkdir(join(repository, ".ai-team", "index"), { recursive: true });
      await mkdir(join(repository, ".ai-team", "plans", "multi-task", "revisions", "001", "tasks"), { recursive: true });
      await writeFile(join(repository, "MEMORY.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "plans", "multi-task", "revisions", "001", "plan.md"), "# plan\n\n## 验证\n\n- Run repository scripts.\n");
      for (const taskId of ["TASK-001", "TASK-002", "TASK-003"]) {
        await writeFile(join(repository, ".ai-team", "plans", "multi-task", "revisions", "001", "tasks", `${taskId}.md`), `# ${taskId}\n\n- 允许写入路径：\`src/dispatch.ts\`\n`);
      }
      await writeFile(join(repository, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test", lint: "eslint ." } }));
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

      store.registerRepository("repo-multi-task", join(repository, ".git"), repository);
      const planDigest = "d".repeat(64);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
        .run("multi-task", "001", "repo-multi-task", "main", planDigest, baseCommit, new Date().toISOString());
      const runId = store.createRun({ repoId: "repo-multi-task", profile: "coding", mode: "planned", planId: "multi-task", revision: "001", baseCommit, targetBranch: "main", planDigest });
      store.initializeRunTasks(runId, ["TASK-001", "TASK-002", "TASK-003"].map((taskId) => ({
        task_id: taskId,
        source_path: `.ai-team/plans/multi-task/revisions/001/tasks/${taskId}.md`,
        source_digest: sha256(`# ${taskId}\n\n- 允许写入路径：\`src/dispatch.ts\`\n`),
        write_paths: ["src/dispatch.ts"],
      })));
      const legacyDispatches = new DispatchService(store) as unknown as { plannedTaskRows(runId: string): unknown };
      store.db.prepare("UPDATE runs SET plan_digest=? WHERE run_id=?").run("e".repeat(64), runId);
      assert.throws(() => legacyDispatches.plannedTaskRows(runId), /plan_digest does not match/);
      store.db.prepare("UPDATE runs SET plan_digest=? WHERE run_id=?").run(planDigest, runId);
      const planWorktree = await new GitOrchestrator(store).prepareIntegration(runId);
      execFileSync("git", ["commit", "--allow-empty", "-m", "preserve TASK-001 merge"], { cwd: planWorktree.path });
      const currentPlanHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: planWorktree.path, encoding: "utf8" }).trim();

      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
      const codingId = dispatches.create(runId, "coding", {
        ...dispatchPacket(["src/dispatch.ts", "test/dispatch/implementation-lifecycle.test.ts"]),
        context: { explorer_dispatch_id: explorerId, worktree_id: planWorktree.worktree_id },
      });
      dispatches.claim(runId, codingId, "coding");
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run("worktree_multi_task_001", runId, "task/multi-task/multi-task-001--task-001", join(repository, ".worktrees", "tasks", "multi-task", "task-001"), baseCommit, new Date().toISOString());
      const developerId = dispatches.create(runId, "backend-developer", {
        ...dispatchPacket(["src/dispatch.ts"]),
        allowed_write_paths: ["src/dispatch.ts"],
        context: { explorer_dispatch_id: explorerId, coordinator_dispatch_id: codingId, task_id: "TASK-001", worktree_id: "worktree_multi_task_001" },
      }, "coding", codingId);
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id IN (?,?)")
        .run(JSON.stringify(completedResult(runId, developerId, "backend-developer", { modified_paths: ["src/dispatch.ts"] })), new Date().toISOString(), codingId, developerId);
      const commit = store.beginOperation("git.commit", `multi-task-commit:${runId}`, {}, runId);
      store.finishOperation(commit.operationId, { commit: currentPlanHead, paths: ["src/dispatch.ts"], worktree_id: "worktree_multi_task_001" });
      const merge = store.beginOperation("git.merge.task", `multi-task-merge:${runId}`, {}, runId);
      store.finishOperation(merge.operationId, { commit: currentPlanHead, task_id: "TASK-001", task_worktree_id: "worktree_multi_task_001", integration_worktree_id: planWorktree.worktree_id });
      const prematureTest = dispatches.create(runId, "test", {
        ...dispatchPacket(["src/dispatch.ts"]),
        context: { stage: "test", implementation_commit: currentPlanHead, implementation_artifacts: [{ dispatch_id: developerId }] },
      });
      dispatches.claim(runId, prematureTest, "test");
      const prematureFailure = completedResult(runId, prematureTest, "test", {
        checks: [{ command: "npm run lint", outcome: "failed" }],
      });
      await dispatches.submitValue(runId, prematureTest, "test", {
        ...prematureFailure,
        status: "failed",
        failure_class: "test_failure",
        side_effect_state: "none",
      });
      const prematureArtifact = store.db.prepare("SELECT artifact_id,sha256 FROM artifacts WHERE run_id=? AND dispatch_id=?").get(runId, prematureTest) as { artifact_id: string; sha256: string };
      store.db.prepare("UPDATE runs SET stage='test' WHERE run_id=?").run(runId);

      const resumed = dispatches.resume(runId);
      assert.equal(store.runTasks(runId)[0]!.state, "integrated");
      assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(prematureTest) as { state: string }).state, "failed");
      assert.equal(resumed.pending_dispatches.length, 1);
      const next = store.db.prepare("SELECT role,packet_json FROM dispatches WHERE dispatch_id=?").get(resumed.pending_dispatches[0]!.dispatch_id) as { role: string; packet_json: string };
      const nextPacket = JSON.parse(next.packet_json);
      assert.equal(next.role, "git-operator");
      assert.equal(nextPacket.context.phase, "prepare_implementation_worktree");
      assert.equal(nextPacket.context.task_id, "TASK-002");
      assert.equal(nextPacket.context.base_commit, currentPlanHead);
      assert.deepEqual(nextPacket.context.predecessor_repair, {
        required: true,
        handled_tests: [{ dispatch_id: prematureTest, artifact_id: prematureArtifact.artifact_id, digest: prematureArtifact.sha256, failed_checks: [{ command: "npm run lint", outcome: "failed" }] }],
        required_commands: ["npm run lint"],
      });
      assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='test' AND state!='failed'").get(runId) as { count: number }).count, 0);

      dispatches.claim(runId, resumed.pending_dispatches[0]!.dispatch_id, "git-operator");
      const taskTwo = await new GitOrchestrator(store).prepareTask(runId, "TASK-002", currentPlanHead, undefined, resumed.pending_dispatches[0]!.dispatch_id);
      const prepared = await dispatches.submitValue(runId, resumed.pending_dispatches[0]!.dispatch_id, "git-operator", completedResult(runId, resumed.pending_dispatches[0]!.dispatch_id, "git-operator", {
        operations: [{ command: "prepare TASK-002", outcome: taskTwo.worktree_id }],
      }));
      const continuation = prepared.continuation.pending_dispatches.find(({ role, dispatch_id }) => {
        if (role !== "coding") return false;
        const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
        return JSON.parse(row.packet_json).context.task_id === "TASK-002";
      })!;
      const continuationPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(continuation.dispatch_id) as { packet_json: string }).packet_json);
      assert.deepEqual(continuationPacket.context.predecessor_repair, nextPacket.context.predecessor_repair);
      dispatches.claim(runId, continuation.dispatch_id, "coding");
      const developerTwoId = dispatches.create(runId, "backend-developer", {
        ...dispatchPacket(["src/dispatch.ts"]),
        allowed_write_paths: ["src/dispatch.ts"],
        context: {
          explorer_dispatch_id: explorerId,
          coordinator_dispatch_id: continuation.dispatch_id,
          task_id: "TASK-002",
          worktree_id: taskTwo.worktree_id,
          worktree_path: taskTwo.path,
          predecessor_repair: continuationPacket.context.predecessor_repair,
        },
      }, "coding", continuation.dispatch_id);
      dispatches.claim(runId, developerTwoId, "backend-developer");
      await dispatches.submitValue(runId, continuation.dispatch_id, "coding", completedResult(runId, continuation.dispatch_id, "coding", { actions: ["repair and implement TASK-002"] }));
      await assert.rejects(dispatches.submitValue(runId, developerTwoId, "backend-developer", completedResult(runId, developerTwoId, "backend-developer", {
        modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm run test", outcome: "passed" }],
      })), /missing successful frozen checks/);
      await assert.rejects(dispatches.submitValue(runId, developerTwoId, "backend-developer", completedResult(runId, developerTwoId, "backend-developer", {
        modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm run lint", outcome: "failed" }],
      })), /missing successful frozen checks/);
      await dispatches.submitValue(runId, developerTwoId, "backend-developer", completedResult(runId, developerTwoId, "backend-developer", {
        modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm run lint", outcome: "passed" }],
      }));
      assert.equal(store.runTasks(runId)[1]!.state, "implemented");
      const taskTest = store.db.prepare(`SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='test' AND state='pending'
        AND json_extract(packet_json,'$.context.phase')='task_test' AND json_extract(packet_json,'$.context.task_id')='TASK-002'`).get(runId) as { dispatch_id: string };
      assert.ok(taskTest.dispatch_id);
      store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), taskTest.dispatch_id);
      store.advanceRunTask(runId, "TASK-002", "integrated", { recovered: true, worktree_id: taskTwo.worktree_id });
      const nextPrepare = dispatches.resume(runId).pending_dispatches.find(({ role, dispatch_id }) => {
        if (role !== "git-operator") return false;
        const row = store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatch_id) as { packet_json: string };
        return JSON.parse(row.packet_json).context.task_id === "TASK-003";
      })!;
      const nextPreparePacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(nextPrepare.dispatch_id) as { packet_json: string }).packet_json);
      assert.equal(nextPreparePacket.context.predecessor_repair, undefined);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

test("planned Test submit binds pre_commit to developer modified_paths instead of the allowed write ceiling", async () => {
  await withStore(async (store) => {
    const repository = await temporaryDirectory();
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      await mkdir(join(repository, "src"), { recursive: true });
      await mkdir(join(repository, "test"), { recursive: true });
      await mkdir(join(repository, ".ai-team", "index"), { recursive: true });
      const taskPath = ".ai-team/plans/modified-subset/revisions/001/tasks/TASK-001.md";
      const taskContent = "# TASK-001\n\n- 允许写入路径：planning/coding角色文件 及相关测试，`test/**`\n";
      await mkdir(join(repository, ".ai-team", "plans", "modified-subset", "revisions", "001", "tasks"), { recursive: true });
      await writeFile(join(repository, "MEMORY.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
      await writeFile(join(repository, taskPath), taskContent);
      await writeFile(join(repository, ".ai-team", "plans", "modified-subset", "revisions", "001", "plan.md"), "# plan\n");
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 1;\n");
      await writeFile(join(repository, "test", "allowed.test.ts"), "export {};\n");
      await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      const repoId = "repo-modified-subset";
      store.registerRepository(repoId, join(repository, ".git"), repository);
      const planDigest = "c".repeat(64);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
        .run("modified-subset", "001", repoId, "main", planDigest, baseCommit, new Date().toISOString());
      const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "modified-subset", revision: "001", planDigest });
      store.initializeRunTasks(runId, [{
        task_id: "TASK-001", source_path: taskPath, source_digest: sha256(taskContent),
        write_paths: ["src/actual.ts", "test/allowed.test.ts"],
      }]);
      const worktreeId = "worktree_modified_subset";
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, "task/modified-subset/modified-subset-001--task-001", repository, baseCommit, new Date().toISOString());
      store.advanceRunTask(runId, "TASK-001", "prepared", { worktree_id: worktreeId });
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify({ ...fileExplorerResult(runId, explorerId), payload: { ...fileExplorerResult(runId, explorerId).payload, allowed_read_paths: ["src/actual.ts", "test/allowed.test.ts", "package.json"] } }), new Date().toISOString(), explorerId);
      const codingId = dispatches.create(runId, "coding", {
        ...dispatchPacket(["src/actual.ts", "test/allowed.test.ts", "package.json"]),
        context: { explorer_dispatch_id: explorerId, task_id: "TASK-001", worktree_id: worktreeId },
      });
      dispatches.claim(runId, codingId, "coding");
      const developerId = dispatches.create(runId, "backend-developer", {
        ...dispatchPacket(["src/actual.ts", "test/allowed.test.ts", "package.json"]),
        allowed_write_paths: ["src/actual.ts", "test/allowed.test.ts"],
        context: { explorer_dispatch_id: explorerId, coordinator_dispatch_id: codingId, task_id: "TASK-001", worktree_id: worktreeId, worktree_path: repository },
      }, "coding", codingId);
      await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["implemented"] }));
      dispatches.claim(runId, developerId, "backend-developer");
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 2;\n");
      await dispatches.submitValue(runId, developerId, "backend-developer", completedResult(runId, developerId, "backend-developer", {
        modified_paths: ["src/actual.ts"], self_tests: [{ command: "targeted fixture", outcome: "passed" }],
      }));
      new ScopeGate(store).check(runId, "pre_commit", ["src/actual.ts"], worktreeId);
      store.db.prepare("UPDATE run_events SET payload_json=json_remove(payload_json,'$.snapshot') WHERE run_id=? AND type='scope.pre_commit'").run(runId);
      const legacyScopePayload = (store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit'").get(runId) as { payload_json: string }).payload_json;
      store.db.prepare("UPDATE run_tasks SET write_paths_json=NULL WHERE run_id=? AND task_id='TASK-001'").run(runId);
      const testRow = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE run_id=? AND role='test' AND state='pending'").get(runId) as { dispatch_id: string; packet_json: string };
      dispatches.claim(runId, testRow.dispatch_id, "test");
      const testPacket = JSON.parse(testRow.packet_json);
      const result = completedResult(runId, testRow.dispatch_id, "test", { checks: testPacket.context.test_commands.map((command: string) => ({ command, outcome: "passed" })) });
      const staging = await store.createStagingEntry({ runId, dispatchId: testRow.dispatch_id, role: "test", kind: "dispatch-result" });
      const ready = await store.writeStagingEntry(staging.stagingId, JSON.stringify(result), { runId, dispatchId: testRow.dispatch_id, role: "test", kind: "dispatch-result" });
      const readyDigest = (store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(ready.stagingId) as { content_sha256: string }).content_sha256;
      store.db.prepare("UPDATE runs SET state='frozen',stage='test',updated_at=? WHERE run_id=?").run(new Date().toISOString(), runId);
      const resumed = dispatches.resume(runId);
      assert.equal(resumed.run.state, "active");
      assert.deepEqual(resumed.pending_dispatches.map(({ dispatch_id }) => dispatch_id), [testRow.dispatch_id]);
      assert.equal((store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(ready.stagingId) as { content_sha256: string }).content_sha256, readyDigest);
      const legacyRecovery = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit_legacy_restored'").get(runId) as { payload_json: string };
      assert.equal(JSON.parse(legacyRecovery.payload_json).test_dispatch_id, testRow.dispatch_id);
      const scope = JSON.parse((store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit'").get(runId) as { payload_json: string }).payload_json);
      assert.equal((store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit'").get(runId) as { payload_json: string }).payload_json, legacyScopePayload);
      const recoveredSnapshot = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='scope.pre_commit_snapshot_recovered'").get(runId) as { payload_json: string };
      assert.equal(JSON.parse(recoveredSnapshot.payload_json).original_scope_digest, scope.digest);
      const recoveredTask = store.runTasks(runId)[0]!;
      assert.deepEqual(JSON.parse(recoveredTask.write_paths_json!), ["src/actual.ts"]);
      assert.equal(JSON.parse(legacyRecovery.payload_json).frozen_task_scope_status, "unavailable_or_ambiguous");
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 3;\n");
      await assert.rejects(dispatches.submitStaging(runId, testRow.dispatch_id, "test", ready.stagingId), /run frozen/);
      assert.equal(store.getStagingEntry(ready.stagingId).state, "ready");
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 2;\n");
      assert.equal(dispatches.resume(runId).run.state, "active");
      const submission = await dispatches.submitStaging(runId, testRow.dispatch_id, "test", ready.stagingId);
      assert.equal(submission.staging.staging_id, ready.stagingId);
      assert.equal(submission.staging.state, "consumed");
      assert.equal(submission.staging.content_digest, readyDigest);
      assert.deepEqual(scope.paths, ["src/actual.ts"]);
      const continuation = submission.continuation.pending_dispatches.find(({ role }) => role === "coding");
      assert.ok(continuation);
      const packet = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(continuation.dispatch_id) as { packet_json: string }).packet_json);
      assert.deepEqual(packet.context.changed_paths, ["src/actual.ts"]);
    } finally { await rm(repository, { recursive: true, force: true }); }
  });
});

test("frozen planned new paths authorize downstream reads before the file exists", async () => {
  await withStore((store) => {
    const runId = createRun(store, "coding", { planId: "planned-new-path", revision: "001" });
    const dispatches = new DispatchService(store);
    store.initializeRunTasks(runId, [{
      task_id: "TASK-001",
      source_path: ".ai-team/plans/planned-new-path/revisions/001/tasks/TASK-001.md",
      source_digest: "1".repeat(64),
      write_paths: ["src/planned-new.ts"],
    }]);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?").run(JSON.stringify({
      ...fileExplorerResult(runId, explorerId),
      payload: { ...fileExplorerResult(runId, explorerId).payload, allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
    }), new Date().toISOString(), explorerId);

    assert.doesNotThrow(() => dispatches.create(runId, "test", {
      objective: "Read the planned new implementation path",
      allowed_read_paths: ["src/planned-new.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["The frozen Task authorizes the path"],
      context: { explorer_dispatch_id: explorerId },
    }));
    assert.throws(() => dispatches.create(runId, "test", {
      objective: "Reject an unrelated path",
      allowed_read_paths: ["src/not-planned.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Report the exact unauthorized path"],
      context: { explorer_dispatch_id: explorerId },
    }), (error: unknown) => error instanceof Error
      && /not authorized/.test(error.message)
      && JSON.stringify((error as { details?: unknown }).details).includes("src/not-planned.ts"));
  });
});

test("planned Test submit persists scope drift and leaves its ready staging unchanged", async () => {
  await withStore(async (store) => {
    const repository = await temporaryDirectory();
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      await mkdir(join(repository, "src"), { recursive: true });
      await mkdir(join(repository, ".ai-team", "index"), { recursive: true });
      await writeFile(join(repository, "MEMORY.md"), "# fixture\n");
      await writeFile(join(repository, ".ai-team", "index", "feature-navigation.md"), "# fixture\n");
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      store.registerRepository("repo-submit-drift", join(repository, ".git"), repository);
      const runId = store.createRun({ repoId: "repo-submit-drift", profile: "coding", mode: "planned", planId: "submit-drift", revision: "001" });
      store.initializeRunTasks(runId, [{ task_id: "TASK-001", source_path: "TASK-001.md", source_digest: "b".repeat(64), write_paths: ["src/actual.ts", "src/other.ts"] }]);
      const worktreeId = "worktree_submit_drift";
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, "task/submit-drift/submit-drift-001--task-001", repository, baseCommit, new Date().toISOString());
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify({ ...fileExplorerResult(runId, explorerId), payload: { ...fileExplorerResult(runId, explorerId).payload, allowed_read_paths: ["src/actual.ts", "src/other.ts"] } }), new Date().toISOString(), explorerId);
      const codingId = dispatches.create(runId, "coding", { ...dispatchPacket(["src/actual.ts", "src/other.ts"]), context: { explorer_dispatch_id: explorerId, task_id: "TASK-001", worktree_id: worktreeId } });
      dispatches.claim(runId, codingId, "coding");
      const developerId = dispatches.create(runId, "backend-developer", {
        ...dispatchPacket(["src/actual.ts", "src/other.ts"]), allowed_write_paths: ["src/actual.ts", "src/other.ts"],
        context: { explorer_dispatch_id: explorerId, coordinator_dispatch_id: codingId, task_id: "TASK-001", worktree_id: worktreeId },
      }, "coding", codingId);
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify(completedResult(runId, codingId, "coding", { actions: ["implemented"] })), new Date().toISOString(), codingId);
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify(completedResult(runId, developerId, "backend-developer", { modified_paths: ["src/actual.ts"] })), new Date().toISOString(), developerId);
      store.advanceRunTask(runId, "TASK-001", "prepared", { worktree_id: worktreeId });
      store.advanceRunTask(runId, "TASK-001", "implemented", { worktree_id: worktreeId, developer_dispatch_id: developerId });
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 2;\n");
      new ScopeGate(store).check(runId, "pre_commit", ["src/actual.ts"], worktreeId);
      await writeFile(join(repository, "src", "actual.ts"), "export const value = 3;\n");
      const testId = dispatches.create(runId, "test", { ...dispatchPacket(["src/actual.ts"]), context: { phase: "task_test", task_id: "TASK-001", worktree_id: worktreeId } });
      dispatches.claim(runId, testId, "test");
      const result = completedResult(runId, testId, "test", { checks: [{ command: "targeted", outcome: "passed" }] });
      const staging = await store.createStagingEntry({ runId, dispatchId: testId, role: "test", kind: "dispatch-result" });
      const ready = await store.writeStagingEntry(staging.stagingId, JSON.stringify(result), { runId, dispatchId: testId, role: "test", kind: "dispatch-result" });
      const readyDigest = (store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(ready.stagingId) as { content_sha256: string }).content_sha256;
      await assert.rejects(dispatches.submitStaging(runId, testId, "test", ready.stagingId), /run frozen/);
      assert.equal(store.getRun(runId).state, "frozen");
      const drift = store.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift' ORDER BY event_id DESC LIMIT 1").get(runId) as { type: string };
      assert.equal(drift.type, "scope.pre_commit_drift");
      const unchanged = store.getStagingEntry(ready.stagingId);
      assert.equal(unchanged.state, "ready");
      assert.equal((store.db.prepare("SELECT content_sha256 FROM staging_entries WHERE staging_id=?").get(ready.stagingId) as { content_sha256: string }).content_sha256, readyDigest);
      assert.equal(dispatches.resume(runId).run.state, "frozen");
      store.db.prepare("DELETE FROM run_events WHERE run_id=? AND type='scope.pre_commit_drift'").run(runId);
      assert.equal(dispatches.resume(runId).run.state, "frozen");
      assert.equal((store.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='scope.pre_commit_legacy_restored'").get(runId) as { count: number }).count, 0);
    } finally { await rm(repository, { recursive: true, force: true }); }
  });
});

test("Test command freezing rejects a path missing from the current repository", async () => {
  await withStore(async (store) => {
    const root = await temporaryDirectory();
    const repository = join(root, "repo");
    try {
      await mkdir(repository);
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      await mkdir(join(repository, ".ai-team", "plans", "path-check", "revisions", "001"), { recursive: true });
      await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      await writeFile(join(repository, ".ai-team", "plans", "path-check", "revisions", "001", "plan.md"), "## 验证\n\n- `npm run test -- test/missing.test.ts`\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "Freeze missing path command"], { cwd: repository });
      const missingCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      store.registerRepository("repo-path-check", join(repository, ".git"), repository);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
        .run("path-check", "001", "repo-path-check", "main", "1".repeat(64), missingCommit, new Date().toISOString());
      const runId = store.createRun({ repoId: "repo-path-check", profile: "coding", mode: "planned", planId: "path-check", revision: "001", planDigest: "1".repeat(64) });
      const dispatches = new DispatchService(store) as unknown as {
        testCommandSnapshot(run: string, path: string, explorer: string): unknown;
      };
      assert.throws(() => dispatches.testCommandSnapshot(runId, repository, "dispatch_explorer"), /does not exist inside/);
      await writeFile(join(root, "outside.test.ts"), "export {};\n");
      await mkdir(join(repository, ".ai-team", "plans", "path-check", "revisions", "002"), { recursive: true });
      await writeFile(join(repository, ".ai-team", "plans", "path-check", "revisions", "002", "plan.md"), "## 验证\n\n- `npm run test -- ../outside.test.ts`\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "Freeze outside path command"], { cwd: repository });
      const outsideCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
        .run("path-check", "002", "repo-path-check", "main", "2".repeat(64), outsideCommit, new Date().toISOString());
      const outsideRunId = store.createRun({ repoId: "repo-path-check", profile: "coding", mode: "planned", planId: "path-check", revision: "002", planDigest: "2".repeat(64) });
      assert.throws(() => dispatches.testCommandSnapshot(outsideRunId, repository, "dispatch_explorer"), /does not exist inside|escapes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("Test command freezing ignores mutable worktree plan changes after the revision commit", async () => {
  await withStore(async (store) => {
    const repository = await temporaryDirectory();
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "AI Team Tests"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "ai-team-tests@example.invalid"], { cwd: repository });
      const planPath = join(repository, ".ai-team", "plans", "command-freeze", "revisions", "001", "plan.md");
      await mkdir(join(repository, ".ai-team", "plans", "command-freeze", "revisions", "001"), { recursive: true });
      await mkdir(join(repository, "test"), { recursive: true });
      await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      await writeFile(join(repository, "test", "frozen.test.ts"), "export {};\n");
      await writeFile(join(repository, "test", "mutable.test.ts"), "export {};\n");
      await writeFile(planPath, "## 验证\n\n- `npm run test -- test/frozen.test.ts`\n");
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "-m", "Freeze test command"], { cwd: repository });
      const planCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
      await writeFile(planPath, "## 验证\n\n- `npm run test -- test/mutable.test.ts`\n");

      store.registerRepository("repo-command-freeze", join(repository, ".git"), repository);
      store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,plan_commit,created_at) VALUES (?,?,?,'ready',?,?,?,?)")
        .run("command-freeze", "001", "repo-command-freeze", "main", "3".repeat(64), planCommit, new Date().toISOString());
      const runId = store.createRun({ repoId: "repo-command-freeze", profile: "coding", mode: "planned", planId: "command-freeze", revision: "001", planDigest: "3".repeat(64) });
      const dispatches = new DispatchService(store) as unknown as {
        testCommandSnapshot(run: string, path: string, explorer: string): { commands: string[] };
      };
      assert.deepEqual(dispatches.testCommandSnapshot(runId, repository, "dispatch_explorer").commands, [
        "npm run test -- test/frozen.test.ts",
        "npm run test",
      ]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

test("completed Test result must report every frozen command", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const testId = dispatches.create(runId, "test", {
      ...dispatchPacket(["package.json"]),
      context: { test_commands: ["npm run test", "npm run lint"] },
    });
    dispatches.claim(runId, testId, "test");
    await assert.rejects(dispatches.submitValue(runId, testId, "test", completedResult(runId, testId, "test", {
      checks: [{ command: "npm run test", outcome: "passed" }],
    })), /missing successful frozen test commands/);
    await assert.rejects(dispatches.submitValue(runId, testId, "test", completedResult(runId, testId, "test", {
      checks: [{ command: "npm run test", outcome: "passed" }, { command: "npm run lint", outcome: "failed" }],
    })), /missing successful frozen test commands/);
  });
});
