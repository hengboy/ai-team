import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createResultTemplate } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { ResearchService } from "../../src/research-service.js";
import type { ResearchConclusion } from "../../src/research.js";
import { ReviewService, type ReviewResult } from "../../src/review.js";
import { completedResult, createRun, dispatchPacket, projectContext, withStore } from "../helpers/dispatch.js";
import { REVIEW_BASE, REVIEW_COMMON_DIR, REVIEW_HEAD } from "../helpers/git.js";

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/dispatch/recovery-review.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
});

test("dispatch lifecycle support cancels, reissues, and supersedes with audited lineage", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    const dispatches = new DispatchService(store);
    const original = dispatches.create(runId, "file-explorer", dispatchPacket(["src/dispatch.ts"]));
    dispatches.claim(runId, original, "file-explorer");

    const reissued = dispatches.reissue(runId, original, "file-explorer", "planning", "repair incomplete support dispatch");
    assert.equal(reissued.action, "reissued");
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(original) as { state: string }).state, "failed");
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(reissued.dispatch_id) as { replacement_for: string }).replacement_for, original);
    assert.deepEqual(dispatches.reissue(runId, original, "file-explorer", "planning", "repair incomplete support dispatch"), { ...reissued, reused: true });

    const replacementPacket = dispatchPacket(["src/planning.ts"]);
    const superseded = dispatches.supersede(runId, reissued.dispatch_id, "file-explorer", "planning", "correct authorized scope", replacementPacket);
    assert.equal(superseded.action, "superseded");
    assert.equal((store.db.prepare("SELECT replacement_for FROM dispatches WHERE dispatch_id=?").get(superseded.dispatch_id) as { replacement_for: string }).replacement_for, reissued.dispatch_id);
    assert.deepEqual(JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(superseded.dispatch_id) as { packet_json: string }).packet_json).allowed_read_paths, [
      "MEMORY.md", ".ai-team/index/feature-navigation.md", "src/planning.ts",
    ]);

    assert.deepEqual(dispatches.cancel(runId, superseded.dispatch_id, "file-explorer", "planning", "no longer required"), { action: "canceled", reused: false });
    assert.deepEqual(dispatches.cancel(runId, superseded.dispatch_id, "file-explorer", "planning", "no longer required"), { action: "canceled", reused: true });
    assert.deepEqual(
      (store.db.prepare("SELECT type FROM run_events WHERE type LIKE 'dispatch.%ed' ORDER BY event_id").all() as Array<{ type: string }>).map(({ type }) => type),
      ["dispatch.created", "dispatch.created", "dispatch.reissued", "dispatch.created", "dispatch.superseded", "dispatch.canceled"],
    );
  });
});

test("a claimed sibling recovery dispatch can validate and submit after its batch makes the run retryable", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const packet = (taskId: string) => ({
      ...dispatchPacket(),
      context: { phase: "recover_task_worktree", recovery_batch_id: "recovery_batch_001", task_id: taskId, worktree_id: `worktree_${taskId.toLowerCase()}` },
    });
    const first = dispatches.create(runId, "git-operator", packet("TASK-001"));
    const second = dispatches.create(runId, "git-operator", packet("TASK-002"));
    dispatches.claim(runId, first, "git-operator");
    dispatches.claim(runId, second, "git-operator");
    await dispatches.submitValue(runId, first, "git-operator", {
      ...createResultTemplate(runId, first, "git-operator"),
      status: "failed", summary: "TASK-001 recovery needs retry", verification: [], payload: { operations: [] },
      failure_class: "temporary_tool_failure", side_effect_state: "none",
    });
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(first) as { state: string }).state, "retryable_failure");
    assert.equal(store.getRun(runId).state, "retryable_failure");
    const secondResult = completedResult(runId, second, "git-operator", { operations: [{ command: "recover TASK-002", outcome: "completed" }] });
    assert.equal(dispatches.validateValue(runId, second, "git-operator", secondResult).status, "completed");
    assert.equal((await dispatches.submitValue(runId, second, "git-operator", secondResult)).submission.state, "submitted");
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(second) as { state: string }).state, "completed");
    assert.equal(store.getRun(runId).state, "retryable_failure");
  });
});

test("review findings without a concrete location or impact are rejected", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    store.db.prepare("UPDATE runs SET base_commit=? WHERE run_id=?").run(REVIEW_BASE, runId);
    const dispatches = new DispatchService(store);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(`worktree_integration_${runId.slice(-8)}`, runId, `integration/review/${runId.slice(-8)}`, process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const testId = dispatches.create(runId, "test", {
      ...dispatchPacket(), context: { implementation_commit: REVIEW_HEAD, implementation_committed: true, changed_paths: ["src/dispatch.ts"] },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, testId, "test", { checks: [{ command: "npm test", outcome: "passed" }] })), new Date().toISOString(), testId);
    const reviewPacket = dispatches.buildReviewPacket(runId);
    assert.ok(reviewPacket);
    dispatches.create(runId, "code-reviewer", reviewPacket);
    const reviews = new ReviewService(store);
    const barrier = reviews.create(runId, REVIEW_HEAD, false);
    const validFinding: ReviewResult["findings"][number] = {
      finding_id: "FIND-CODE-001",
      severity: "P1",
      title: "Concrete defect",
      source: "requirements",
      source_file: "docs/contracts.md",
      source_line: 53,
      evidence: "The accepted payload has no field validation.",
      impact: "Invalid results can advance a run.",
      recommendation: "Validate the role payload.",
    };
    for (const finding of [
      { ...validFinding, source_file: "" },
      { ...validFinding, source_line: 0 },
      { ...validFinding, impact: "" },
    ]) {
      assert.throws(
        () => reviews.submit(runId, barrier.barrier_id, {
          axis: "standards",
          summary: "reviewed",
          findings: [finding],
        }),
        /lacks source, location, impact, or recommendation/,
      );
    }
    const leaf = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-standards'").get(runId) as { dispatch_id: string };
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify({ ...completedResult(runId, leaf.dispatch_id, "review-standards", { finding_ids: [validFinding.finding_id] }), summary: "reviewed", findings: [validFinding] }), new Date().toISOString(), leaf.dispatch_id);
    const specLeaf = store.db.prepare("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='review-spec'").get(runId) as { dispatch_id: string };
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify({ ...completedResult(runId, specLeaf.dispatch_id, "review-spec", { finding_ids: [] }), summary: "passed", findings: [] }), new Date().toISOString(), specLeaf.dispatch_id);
    reviews.submit(runId, barrier.barrier_id, { axis: "spec", summary: "passed", findings: [] });
    assert.equal(reviews.submit(runId, barrier.barrier_id, {
      axis: "standards",
      summary: "reviewed",
      findings: [validFinding],
    }).state, "blocked");
  });
});

test("reconcileOperation persists completed and not-applied states while rejecting unknown", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const completed = store.beginOperation("git.worktree", `worktree:${runId}:completed`, {}, runId);
    store.reconcileOperation(completed.operationId, "completed", { fact: "owned worktree exists" });
    assert.deepEqual(
      store.db.prepare("SELECT state,evidence_json FROM operations WHERE operation_id=?").get(completed.operationId),
      { state: "completed", evidence_json: '{"fact":"owned worktree exists","reconciliation":"completed"}' },
    );

    const notApplied = store.beginOperation("git.worktree", `worktree:${runId}:absent`, {}, runId);
    store.reconcileOperation(notApplied.operationId, "not_applied", { fact: "owned worktree absent" });
    assert.deepEqual(
      store.db.prepare("SELECT state,evidence_json FROM operations WHERE operation_id=?").get(notApplied.operationId),
      {
        state: "failed",
        evidence_json: '{"evidence":{"fact":"owned worktree absent"},"reconciliation":"not_applied"}',
      },
    );

    const unresolved = store.beginOperation("git.commit", `commit:${runId}:unknown`, {}, runId);
    assert.throws(
      () => store.reconcileOperation(unresolved.operationId, "unknown", { fact: "manual evidence required" }),
      /unknown side effect cannot be marked reconciled/,
    );
    assert.equal(
      (store.db.prepare("SELECT state FROM operations WHERE operation_id=?").get(unresolved.operationId) as { state: string }).state,
      "pending",
    );
  });
});

test("merge dispatch creation rejects a plan worktree bound as its own task worktree", async () => {
  await withStore((store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    assert.throws(() => dispatches.create(runId, "git-operator", {
      objective: "Invalid self integration",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Must be rejected before creation"],
      context: {
        stage: "git-operator",
        phase: "integrate_implementation",
        integration_worktree_id: "worktree_same",
        task_worktree_ids: ["worktree_same"],
      },
    }), /integration worktree cannot also be a task worktree/);
  });
});

test("final integration precondition failures are retryable and failed runs cannot create or claim work", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const finalId = dispatches.create(runId, "git-operator", {
      objective: "Finalize reviewed integration",
      allowed_read_paths: [],
      allowed_write_paths: [],
      acceptance_criteria: ["Retry a no-side-effect precondition failure"],
      context: { stage: "git-operator", phase: "finalize_integration", barrier_id: "review_fixture", revision_sha: REVIEW_HEAD, integration_worktree_id: "worktree_fixture" },
    });
    dispatches.claim(runId, finalId, "git-operator");
    await dispatches.submitValue(runId, finalId, "git-operator", {
      ...createResultTemplate(runId, finalId, "git-operator"),
      status: "failed",
      summary: "target worktree is dirty",
      verification: [],
      payload: {},
      failure_class: "dirty_target",
      side_effect_state: "none",
    });
    assert.equal(store.getRun(runId).state, "retryable_failure");
    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.equal(resumed.pending_dispatches.length, 1);

    const blockedId = resumed.pending_dispatches[0]!.dispatch_id;
    store.db.prepare("UPDATE runs SET state='failed' WHERE run_id=?").run(runId);
    assert.throws(() => dispatches.create(runId, "test", dispatchPacket()), /run must be active before dispatch creation/);
    assert.throws(() => dispatches.claim(runId, blockedId, "git-operator"), /run must be active before dispatch claim/);
  });
});

test("planned research is archived with its revision while direct coding research stays in run artifacts", async () => {
  await withStore(async (store, home) => {
    const project = join(home, "project");
    const conclusion: ResearchConclusion = {
      kind: "fact",
      statement: "The documented API is available.",
      url: "https://example.com/api",
      accessed_at: "2026-08-13",
      applicable_version: "1.0.0",
      source_level: "official",
    };
    const research = new ResearchService(store);

    const unboundPlanning = createRun(store, "planning");
    await assert.rejects(
      research.archive(unboundPlanning, project, "API support", [conclusion]),
      /planned research requires the run to bind plan_id and revision/,
    );

    const planningRun = createRun(store, "planning", { planId: "20260813-api", revision: "001" });
    const planning = await research.archive(planningRun, project, "API support", [conclusion]);
    assert.equal(planning.path, join(
      project,
      ".ai-team",
      "plans",
      "20260813-api",
      "revisions",
      "001",
      "research",
      "api-support.md",
    ));
    assert.match(await readFile(planning.path, "utf8"), /Source level: official/);

    const codingRun = createRun(store, "coding", { planId: "20260813-api", revision: "001" });
    const coding = await research.archive(codingRun, project, "API support", [conclusion]);
    assert.equal(coding.path, join(project, ".ai-team", "plans", "20260813-api", "revisions", "001", "research", "api-support.md"));
    assert.equal(coding.path.startsWith(join(project, ".ai-team", "plans")), true);
    assert.match(await readFile(coding.path, "utf8"), /# Research: API support/);
  });
});

test("run resume creates one claimed coding continuation before Git commit dispatch", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const coordinatorPacket = {
      ...dispatchPacket(["src/dispatch.ts", "test/dispatch/recovery-review.test.ts"]),
      context: { explorer_dispatch_id: explorerId },
    };
    const codingId = dispatches.create(runId, "coding", coordinatorPacket);
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_resume_commit", runId, "task/resume/implementation", `/tmp/${runId}-resume`, REVIEW_HEAD, new Date().toISOString());
    const developerId = dispatches.create(runId, "backend-developer", {
      ...coordinatorPacket,
      allowed_write_paths: ["src/dispatch.ts"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_resume_commit" },
    }, "coding", codingId);
    dispatches.claim(runId, developerId, "backend-developer");
    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["dispatch implementation"] }));
    await dispatches.submitValue(runId, developerId, "backend-developer", completedResult(runId, developerId, "backend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    for (const stage of ["triage", "pre_write", "pre_commit"] as const) {
      store.event(runId, `scope.${stage}`, { stage, digest: "stable-scope", paths: ["src/dispatch.ts"] });
    }

    assert.throws(() => dispatches.create(runId, "git-operator", dispatchPacket(), "coding", codingId), /coding dispatch must be claimed/);
    const first = dispatches.resume(runId);
    const second = dispatches.resume(runId);
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    const continuationId = first.pending_dispatches[0]!.dispatch_id;
    const continuation = store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(continuationId) as { replacement_for: string; packet_json: string };
    assert.equal(continuation.replacement_for, codingId);
    assert.equal(JSON.parse(continuation.packet_json).context.phase, "continue_commit");

    dispatches.claim(runId, continuationId, "coding");
    const gitId = dispatches.create(runId, "git-operator", {
      objective: "Commit the resumed task worktree",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit the authorized task changes"],
      context: { explorer_dispatch_id: explorerId, worktree_id: "worktree_resume_commit", phase: "commit_implementation" },
    }, "coding", continuationId);
    assert.match(gitId, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

test("planned run resume restores a missing task continuation without a recovery decision", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), REVIEW_COMMON_DIR), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "20260817-resume", revision: "001" });
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const coordinatorId = dispatches.create(runId, "coding", { ...dispatchPacket(["src/dispatch.ts"]), context: { explorer_dispatch_id: explorerId } });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, coordinatorId, "coding", { actions: ["prepare TASK-001"] })), new Date().toISOString(), coordinatorId);
    const prepareId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket([]),
      context: { phase: "prepare_implementation_worktree", task_id: "TASK-001", explorer_dispatch_id: explorerId, coordinator_dispatch_id: coordinatorId },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, prepareId, "git-operator", { operations: [] })), new Date().toISOString(), prepareId);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_resume_task_001", runId, "task/20260817-resume/20260817-resume-001--task-001", `/tmp/${runId}-task-001`, REVIEW_HEAD, new Date().toISOString());

    const first = dispatches.resume(runId);
    const second = dispatches.resume(runId);
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    const restored = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(first.pending_dispatches[0]!.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(restored.context.phase, "continue_implementation");
    assert.equal(restored.context.prepare_git_dispatch_id, prepareId);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count, 0);
  });
});

test("confirmed retryable side effects reconcile through an idempotent replacement lineage", async () => {
  await withStore(async (store) => {
    const dispatches = new DispatchService(store);
    const makeRetryable = async (sideEffectState: "completed" | "unknown") => {
      const runId = createRun(store, "planning");
      const dispatchId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, dispatchId, "file-explorer");
      await dispatches.submitValue(runId, dispatchId, "file-explorer", {
        ...fileExplorerResult(runId, dispatchId),
        status: "retryable_failure",
        verification: [{ command: "git status", outcome: "side effect completed before timeout" }],
        payload: {},
        failure_class: "client_disconnect",
        side_effect_state: sideEffectState,
      });
      return { runId, dispatchId };
    };

    const confirmed = await makeRetryable("completed");
    const resumed = dispatches.resume(confirmed.runId);
    assert.deepEqual(resumed.recovery, {
      state: "action_required",
      dispatch_id: confirmed.dispatchId,
      side_effect_state: "completed",
      next_command: `ai-team dispatch reconcile --run-id ${confirmed.runId} --dispatch-id ${confirmed.dispatchId} --role file-explorer --actor-role planning --reason "reconcile confirmed completed side effect"`,
    });

    const reconciled = dispatches.reconcile(confirmed.runId, confirmed.dispatchId, "file-explorer", "planning", "confirmed side effect is durable");
    assert.deepEqual(reconciled, {
      action: "reconciled",
      dispatch_id: reconciled.dispatch_id,
      replacement_for: confirmed.dispatchId,
      reused: false,
    });
    assert.deepEqual(dispatches.reconcile(confirmed.runId, confirmed.dispatchId, "file-explorer", "planning", "confirmed side effect is durable"), { ...reconciled, reused: true });
    assert.equal(store.getRun(confirmed.runId).state, "active");
    assert.deepEqual(
      store.db.prepare("SELECT state,replacement_for FROM dispatches WHERE dispatch_id=?").get(reconciled.dispatch_id),
      { state: "pending", replacement_for: confirmed.dispatchId },
    );
    const recoveryPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(reconciled.dispatch_id) as { packet_json: string }).packet_json);
    assert.equal(recoveryPacket.context.recovery.replacement_for, confirmed.dispatchId);
    assert.deepEqual(recoveryPacket.context.recovery.completed_verification, [{ command: "git status", outcome: "side effect completed before timeout" }]);

    const unknown = await makeRetryable("unknown");
    assert.equal(dispatches.resume(unknown.runId).recovery?.next_command, null);
    assert.throws(
      () => dispatches.reconcile(unknown.runId, unknown.dispatchId, "file-explorer", "planning", "cannot confirm side effect"),
      /requires confirmed completed side effects/,
    );
    const reissued = dispatches.reissue(unknown.runId, unknown.dispatchId, "file-explorer", "planning", "replace after external investigation");
    assert.equal(reissued.replacement_for, unknown.dispatchId);
    assert.equal(store.getRun(unknown.runId).state, "active");

    const supersededSource = await makeRetryable("completed");
    const superseded = dispatches.supersede(
      supersededSource.runId,
      supersededSource.dispatchId,
      "file-explorer",
      "planning",
      "replace with corrected scope",
      dispatchPacket(["src/planning.ts"]),
    );
    assert.equal(superseded.replacement_for, supersededSource.dispatchId);
    assert.equal(store.getRun(supersededSource.runId).state, "active");
  });
});

test("retryable frontend recovery preserves the claimed coordinator and creates a linked replacement", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    store.db.prepare("INSERT INTO artifacts(artifact_id,run_id,dispatch_id,kind,path,sha256,redacted,created_at) VALUES (?,?,?,'result',?,?,1,?)")
      .run("artifact_recovery_explorer", runId, explorerId, "/tmp/explorer-result.json", "a".repeat(64), new Date().toISOString());
    const codingId = dispatches.create(runId, "coding", dispatchPacket(["src/dispatch.ts"]));
    dispatches.claim(runId, codingId, "coding");
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_recovered_owner", runId, "task/recovered/implementation", "/tmp/recovered-owner", REVIEW_HEAD, new Date().toISOString());
    const adoption = store.beginOperation("git.worktree.adopt", `adopt:${runId}`, {}, runId);
    store.finishOperation(adoption.operationId, { implementation_revision: REVIEW_HEAD, worktree_id: "worktree_recovered_owner" });
    const frontendId = dispatches.create(runId, "frontend-developer", {
      ...dispatchPacket(["src/dispatch.ts"]),
      acceptance_criteria: ["Operate only in /tmp/old-owner on branch task/old/implementation."],
      context: {
        explorer_dispatch_id: explorerId,
        revision: "001",
        implementation_commit: REVIEW_HEAD,
        worktree_id: "worktree_old_owner",
        implementation_worktree_path: "/tmp/old-owner",
        implementation_branch: "task/old/implementation",
      },
    });
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", {
      ...createResultTemplate(runId, frontendId, "frontend-developer"),
      status: "retryable_failure",
      summary: "Context renderer is stale",
      verification: [{ command: "unit tests", outcome: "passed before context validation" }],
      payload: {},
      failure_class: "context_migration_required",
      side_effect_state: "none",
    });

    const resumed = dispatches.resume(runId);
    assert.equal((resumed.run as { state: string }).state, "active");
    assert.ok(resumed.pending_dispatches.some((item) => item.dispatch_id === codingId && item.state === "claimed"));
    const replacement = store.db.prepare("SELECT dispatch_id,replacement_for,packet_json FROM dispatches WHERE replacement_for=?").get(frontendId) as { dispatch_id: string; replacement_for: string; packet_json: string };
    assert.equal(replacement.replacement_for, frontendId);
    const packet = JSON.parse(replacement.packet_json);
    assert.equal(packet.context.revision, "001");
    assert.equal(packet.context.implementation_commit, REVIEW_HEAD);
    assert.equal(packet.context.implementation_revision, REVIEW_HEAD);
    assert.equal(packet.context.worktree_id, "worktree_recovered_owner");
    assert.deepEqual(packet.acceptance_criteria, ["Operate only in /tmp/recovered-owner on branch task/recovered/implementation."]);
    assert.equal(packet.context.explorer_dispatch_id, explorerId);
    assert.equal(packet.context.recovery.replacement_for, frontendId);
    assert.deepEqual(packet.context.recovery.completed_verification, [{ command: "unit tests", outcome: "passed before context validation" }]);

    dispatches.claim(runId, replacement.dispatch_id, "frontend-developer");
    await dispatches.submitValue(runId, replacement.dispatch_id, "frontend-developer", {
      ...createResultTemplate(runId, replacement.dispatch_id, "frontend-developer"),
      status: "retryable_failure",
      summary: "Frozen text still referenced the root worktree",
      verification: [],
      payload: {},
      failure_class: "stale_recovery_packet",
      side_effect_state: "none",
    });
    dispatches.resume(runId);
    const second = store.db.prepare("SELECT dispatch_id,packet_json FROM dispatches WHERE replacement_for=?").get(replacement.dispatch_id) as { dispatch_id: string; packet_json: string };
    const secondPacket = JSON.parse(second.packet_json);
    assert.deepEqual(secondPacket.acceptance_criteria, ["Operate only in /tmp/recovered-owner on branch task/recovered/implementation."]);
    assert.deepEqual(secondPacket.context.recovery.completed_verification, [{ command: "unit tests", outcome: "passed before context validation" }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_recovered_integration", runId, "integration/recovered", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const commit = store.beginOperation("git.commit", `commit:${runId}:recovered`, {}, runId);
    store.finishOperation(commit.operationId, { commit: REVIEW_HEAD, paths: ["src/dispatch.ts"], worktree_id: "worktree_recovered_owner" });
    dispatches.claim(runId, second.dispatch_id, "frontend-developer");
    await dispatches.submitValue(runId, second.dispatch_id, "frontend-developer", completedResult(runId, second.dispatch_id, "frontend-developer", {
      modified_paths: ["src/dispatch.ts"], self_tests: [{ command: "npm test", outcome: "passed" }],
    }));
    await dispatches.submitValue(runId, codingId, "coding", completedResult(runId, codingId, "coding", { actions: ["resume replacement"] }));
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='integrate_implementation'").get(runId) as { count: number }).count,
      1,
    );
  });
});

test("retryable recovery decision is dispatch-bound and regenerate-context activates one replacement", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    const dispatches = new DispatchService(store);
    const frontendId = dispatches.create(runId, "frontend-developer", dispatchPacket(["src/context.ts"]));
    dispatches.claim(runId, frontendId, "frontend-developer");
    await dispatches.submitValue(runId, frontendId, "frontend-developer", {
      ...createResultTemplate(runId, frontendId, "frontend-developer"),
      status: "retryable_failure",
      summary: "Choose context recovery",
      verification: [],
      decisions_needed: [{
        question: "How should context recover?",
        choices: [
          { id: "regenerate-context", label: "Regenerate", impact: "Migrate managed context" },
          { id: "stop", label: "Stop", impact: "Leave the run blocked" },
        ],
        recommendation: "regenerate-context",
        type: "workflow_recovery",
      }],
      payload: {},
      failure_class: "context_migration_required",
      side_effect_state: "completed",
    });
    const decision = store.db.prepare("SELECT decision_id,dispatch_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; dispatch_id: string };
    assert.equal(decision.dispatch_id, frontendId);
    assert.equal(store.getRun(runId).state, "needs_decision");
    const replacementId = dispatches.resolveDecision(runId, decision.decision_id, "regenerate-context");
    assert.equal(store.getRun(runId).state, "active");
    assert.deepEqual(
      store.db.prepare("SELECT state,replacement_for FROM dispatches WHERE dispatch_id=?").get(replacementId),
      { state: "pending", replacement_for: frontendId },
    );
    const replacementPacket = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(replacementId) as { packet_json: string }).packet_json);
    assert.equal(replacementPacket.context.recovery.replacement_for, frontendId);
    assert.equal(replacementPacket.context.resolved_decision.choice, "regenerate-context");
    assert.equal(dispatches.resume(runId).pending_decision, null);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE replacement_for=?").get(frontendId) as { count: number }).count, 1);
  });
});

test("reissue rebuilds the review packet once and returns the same successor on retry", async () => {
  await withStore(async (store) => {
    const runId = createRun(store);
    store.db.prepare("UPDATE runs SET base_commit=? WHERE run_id=?").run(REVIEW_BASE, runId);
    const dispatches = new DispatchService(store);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_reissue_integration", runId, "integration/reissue", process.cwd(), REVIEW_HEAD, new Date().toISOString());
    const testId = dispatches.create(runId, "test", {
      ...dispatchPacket(), context: { implementation_commit: REVIEW_HEAD, implementation_committed: true, changed_paths: ["src/dispatch.ts"] },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, testId, "test", { checks: [{ command: "npm test", outcome: "passed" }] })), new Date().toISOString(), testId);
    const frozen = dispatches.buildReviewPacket(runId);
    assert.ok(frozen);
    const reviewerId = dispatches.create(runId, "code-reviewer", frozen);
    dispatches.claim(runId, reviewerId, "code-reviewer");
    await dispatches.submitValue(runId, reviewerId, "code-reviewer", {
      ...createResultTemplate(runId, reviewerId, "code-reviewer"),
      status: "needs_decision",
      summary: "Review packet must be reissued",
      verification: [],
      decisions_needed: [{
        question: "How should the frozen review continue?",
        choices: [
          { id: "reissue", label: "Reissue", impact: "Rebuild from current frozen evidence" },
          { id: "abort", label: "Abort", impact: "Stop the review" },
        ],
        recommendation: "reissue",
        type: "review_reissue",
      }],
      payload: {},
    });
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    const oldDigest = (store.db.prepare("SELECT packet_digest FROM dispatches WHERE dispatch_id=?").get(reviewerId) as { packet_digest: string }).packet_digest;

    const successor = dispatches.resolveDecision(runId, decision.decision_id, "reissue");
    assert.equal(dispatches.resolveDecision(runId, decision.decision_id, "reissue"), successor);
    const newRow = store.db.prepare("SELECT packet_json,packet_digest FROM dispatches WHERE dispatch_id=?").get(successor) as { packet_json: string; packet_digest: string };
    const packet = JSON.parse(newRow.packet_json);
    assert.notEqual(newRow.packet_digest, oldDigest);
    assert.equal(packet.context.revision_sha, REVIEW_HEAD);
    assert.equal(packet.context.reissue.decision_id, decision.decision_id);
    assert.equal(packet.context.resolved_decision.choice, "reissue");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='code-reviewer' AND state='pending'").get(runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM review_barriers WHERE run_id=?").get(runId) as { count: number }).count, 0);
  });
});
