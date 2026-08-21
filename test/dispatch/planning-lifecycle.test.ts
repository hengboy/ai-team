import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Ajv } from "ajv";

import { checkResultEnvelope, resultSchemaForRole } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { planningContinuationPacket } from "../../src/dispatch/planning.js";
import { completedResult, createRun, dispatchPacket, projectContext, withStore } from "../helpers/dispatch.js";

const fileExplorerResult = (runId: string, dispatchId: string) => completedResult(runId, dispatchId, "file-explorer", {
  allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
  entry_points: ["src/dispatch.ts"],
  test_commands: ["npm test"],
  project_context: projectContext(),
});

test("an exact File Explorer result creates one planning or coding dispatch and duplicate submit reuses it", async () => {
  await withStore(async (store, home) => {
    for (const [profile, nextRole] of [["planning", "planning"], ["coding", "coding"]] as const) {
      const runId = createRun(store, profile);
      const dispatches = new DispatchService(store);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      const claimed = dispatches.claim(runId, explorerId, "file-explorer");
      assert.deepEqual(claimed.packet.allowed_read_paths, ["MEMORY.md", ".ai-team/index/feature-navigation.md", "."]);
      const resultPath = join(home, `${profile}-file-explorer.json`);
      await writeFile(resultPath, JSON.stringify(fileExplorerResult(runId, explorerId)));

      const first = await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      assert.equal(first.reused, false);
      assert.equal(first.submission.state, "submitted");
      assert.equal(first.submission.artifact, first.artifact);
      assert.match(first.submission.artifact_id, /^artifact_/);
      assert.match(first.submission.digest, /^[a-f0-9]{64}$/);
      assert.equal(first.continuation.run_stage, nextRole);
      assert.equal(store.getRun(runId).stage, nextRole);
      const generated = store.db.prepare(
        "SELECT role, state, packet_json FROM dispatches WHERE run_id=? AND role=?",
      ).all(runId, nextRole) as Array<{ role: string; state: string; packet_json: string }>;
      assert.equal(generated.length, 1);
      assert.equal(generated[0]?.state, "pending");
      assert.deepEqual(JSON.parse(generated[0]?.packet_json ?? "{}").allowed_read_paths, [
        "MEMORY.md",
        ".ai-team/index/feature-navigation.md",
        "src/dispatch.ts",
        "test/dispatch/planning-lifecycle.test.ts",
      ]);
      const downstreamContext = JSON.parse(generated[0]?.packet_json ?? "{}").context;
      assert.equal(downstreamContext.explorer_dispatch_id, explorerId);
      assert.deepEqual(downstreamContext.explorer_result.findings, []);
      assert.match(downstreamContext.explorer_result.artifact_id, /^artifact_/);
      assert.equal(downstreamContext.explorer_result.digest, first.submission.digest);
      assert.deepEqual(downstreamContext.explorer_result.project_context, projectContext());
      assert.deepEqual(downstreamContext.explorer_result.payload, fileExplorerResult(runId, explorerId).payload);

      const duplicate = await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      assert.equal(duplicate.reused, true);
      assert.deepEqual(duplicate.submission, first.submission);
      assert.deepEqual(duplicate.continuation, first.continuation);
      const count = store.db.prepare(
        "SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role=?",
      ).get(runId, nextRole) as { count: number };
      assert.equal(count.count, 1);
      if (profile === "coding") {
        const prepare = store.db.prepare("SELECT state,packet_json FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { state: string; packet_json: string };
        assert.equal(prepare.state, "pending");
        assert.equal(JSON.parse(prepare.packet_json).context.phase, "prepare_worktrees");
      }
    }
  });
});

test("completed planned task continuations derive one developer for prepared and recovered worktrees", async () => {
  await withStore(async (store) => {
    const dispatches = new DispatchService(store);
    const prepareTask = async (phase: "prepare_implementation_worktree" | "recover_task_worktree") => {
      const repoId = "repo-review-fixture";
      store.registerRepository(repoId, join(process.cwd(), "."), process.cwd());
      const taskId = phase === "prepare_implementation_worktree" ? "TASK-001" : "TASK-002";
      const runId = store.createRun({
        repoId,
        profile: "coding",
        mode: "planned",
        planId: `20260820-${phase}`,
        revision: "001",
      });
      store.initializeRunTasks(runId, [{
        task_id: taskId,
        source_path: `.ai-team/plans/20260820-${phase}/revisions/001/tasks/${taskId}.md`,
        source_digest: "a".repeat(64),
        write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      }]);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"]));
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
      const coordinatorId = dispatches.create(runId, "coding", {
        ...dispatchPacket(["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"]),
        context: { explorer_dispatch_id: explorerId },
      });
      dispatches.claim(runId, coordinatorId, "coding");
      const worktreeId = `worktree_${phase}`;
      const worktreePath = `/tmp/${runId}-${taskId.toLowerCase()}`;
      const prepareId = dispatches.create(runId, "git-operator", {
        ...dispatchPacket([]),
        context: {
          phase,
          ...(phase === "recover_task_worktree" ? {
            operation: "recover-task-worktree",
            worktree_id: worktreeId,
            project: process.cwd(),
            source_run_id: "run_source_task",
            from_plan_id: "20260820-source",
            from_revision: "001",
            to_plan_id: `20260820-${phase}`,
            to_revision: "001",
            to_run_id: runId,
            expected_head: "a".repeat(40),
            expected_source_artifact: "artifact_source_task",
            expected_source_artifact_digest: "b".repeat(64),
          } : {}),
          task_id: taskId,
          explorer_dispatch_id: explorerId,
          coordinator_dispatch_id: coordinatorId,
        },
      }, "coding", coordinatorId);
      store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
        .run(JSON.stringify(completedResult(runId, coordinatorId, "coding", { actions: [`prepare ${taskId}`] })), new Date().toISOString(), coordinatorId);
      store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
        .run(worktreeId, runId, `task/20260820/${taskId.toLowerCase()}`, worktreePath, "a".repeat(40), new Date().toISOString());
      if (phase === "recover_task_worktree") {
        store.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json,created_at,completed_at) VALUES (?,?,?,'git.worktree.recover','completed',?,?,?,?)")
          .run(`op_${taskId.toLowerCase()}`, runId, `recover:${runId}:${taskId}`, "{}", JSON.stringify({ task_id: taskId, worktree_id: worktreeId }), new Date().toISOString(), new Date().toISOString());
      }
      dispatches.claim(runId, prepareId, "git-operator");
      const prepared = await dispatches.submitValue(runId, prepareId, "git-operator", completedResult(runId, prepareId, "git-operator", {
        operations: [{ command: `${phase} ${taskId}`, outcome: worktreeId }],
      }));
      const continuationId = prepared.continuation.pending_dispatches[0]!.dispatch_id;
      dispatches.claim(runId, continuationId, "coding");
      const continued = await dispatches.submitValue(runId, continuationId, "coding", completedResult(runId, continuationId, "coding", {
        actions: [`dispatch ${taskId} developer`],
      }));
      assert.equal(continued.continuation.pending_dispatches.length, 1);
      const developerId = continued.continuation.pending_dispatches[0]!.dispatch_id;
      const developer = store.db.prepare("SELECT role,packet_json FROM dispatches WHERE dispatch_id=?").get(developerId) as { role: string; packet_json: string };
      const context = JSON.parse(developer.packet_json).context;
      assert.equal(developer.role, "backend-developer");
      assert.deepEqual({
        explorer_dispatch_id: context.explorer_dispatch_id,
        coordinator_dispatch_id: context.coordinator_dispatch_id,
        prepare_git_dispatch_id: context.prepare_git_dispatch_id,
        task_id: context.task_id,
        worktree_id: context.worktree_id,
        worktree_path: context.worktree_path,
      }, {
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: continuationId,
        prepare_git_dispatch_id: prepareId,
        task_id: taskId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
      });
      assert.deepEqual(JSON.parse(developer.packet_json).allowed_write_paths, ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"]);
      assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')").get(runId) as { count: number }).count, 1);
    };

    await prepareTask("prepare_implementation_worktree");
    await prepareTask("recover_task_worktree");
  });
});

test("run resume compensates one missing developer dispatch for a completed planned continuation", () => {
  return withStore((store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), "."), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "20260820-resume", revision: "001" });
    const dispatches = new DispatchService(store);
    store.initializeRunTasks(runId, [{
      task_id: "TASK-001",
      source_path: ".ai-team/plans/20260820-resume/revisions/001/tasks/TASK-001.md",
      source_digest: "a".repeat(64),
      write_paths: ["src/dispatch.ts"],
    }]);
    const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["src/dispatch.ts"]));
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(fileExplorerResult(runId, explorerId)), new Date().toISOString(), explorerId);
    const prepareId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket([]),
      context: {
        phase: "recover_task_worktree", operation: "recover-task-worktree", task_id: "TASK-001",
        explorer_dispatch_id: explorerId, coordinator_dispatch_id: "dispatch_original_coordinator", worktree_id: "worktree_resume",
        project: process.cwd(), source_run_id: "run_source_task", from_plan_id: "20260820-source", from_revision: "001",
        to_plan_id: "20260820-resume", to_revision: "001", to_run_id: runId, expected_head: "a".repeat(40),
        expected_source_artifact: "artifact_source_task", expected_source_artifact_digest: "b".repeat(64),
      },
    });
    const continuationId = dispatches.create(runId, "coding", {
      ...dispatchPacket(["src/dispatch.ts"]),
      context: {
        phase: "continue_implementation",
        explorer_dispatch_id: explorerId,
        coordinator_dispatch_id: "dispatch_original_coordinator",
        prepare_git_dispatch_id: prepareId,
        task_id: "TASK-001",
        worktree_id: "worktree_resume",
        worktree_path: `/tmp/${runId}-task-001`,
      },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, prepareId, "git-operator", { operations: [] })), new Date().toISOString(), prepareId);
    store.db.prepare("UPDATE dispatches SET state='completed',result_json=?,completed_at=? WHERE dispatch_id=?")
      .run(JSON.stringify(completedResult(runId, continuationId, "coding", { actions: ["dispatch TASK-001 developer"] })), new Date().toISOString(), continuationId);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run("worktree_resume", runId, "task/20260820/task-001", `/tmp/${runId}-task-001`, "a".repeat(40), new Date().toISOString());
    store.advanceRunTask(runId, "TASK-001", "prepared", { worktree_id: "worktree_resume" });
    store.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json,created_at,completed_at) VALUES (?,?,?,'git.worktree.recover','completed',?,?,?,?)")
      .run("op_resume", runId, `recover:${runId}:TASK-001`, "{}", JSON.stringify({ task_id: "TASK-001", worktree_id: "worktree_resume" }), new Date().toISOString(), new Date().toISOString());

    const first = dispatches.resume(runId);
    const second = dispatches.resume(runId);
    assert.equal(first.pending_dispatches.length, 1);
    assert.equal(first.pending_dispatches[0]?.role, "backend-developer");
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role IN ('frontend-developer','backend-developer')").get(runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM run_events WHERE run_id=? AND type='coding.developer_dispatch_created' AND json_extract(payload_json,'$.source')='resume'").get(runId) as { count: number }).count, 1);
  });
});

test("public planning schema and runtime validator share the typed decision contract", () => {
  const runId = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const question = "Use the implementation already present at HEAD?";
  const base = {
    ...completedResult(runId, dispatchId, "planning", {
      actions: ["confirm existing implementation"],
      stage: "requirements",
      pending_questions: [question],
      decision: null,
    }),
    status: "needs_decision" as const,
    verification: [],
  };
  const schema = resultSchemaForRole("planning");
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const validDecision = {
    question,
    choices: [
      { id: "verify_existing", label: "Verify existing", impact: "Finish without product changes" },
      { id: "plan_changes", label: "Plan changes", impact: "Continue normal planning" },
    ],
  };
  const valid = { ...base, decisions_needed: [validDecision], payload: { ...base.payload, decision: validDecision } };
  assert.equal(validateSchema(valid), true);
  assert.equal(checkResultEnvelope(valid).valid, true);

  const invalidDecision = { question, choices: ["verify_existing", "plan_changes"] };
  const invalid = { ...base, decisions_needed: [invalidDecision], payload: { ...base.payload, decision: invalidDecision } };
  assert.equal(validateSchema(invalid), false);
  assert.equal(checkResultEnvelope(invalid).valid, false);
  assert.ok(validateSchema.errors?.some((error) => error.instancePath === "/decisions_needed/0/choices/0" && error.message === "must be object"));
  const runtime = checkResultEnvelope(invalid);
  assert.ok(!runtime.valid && runtime.errors.some((error) => error.pointer === "/decisions_needed/0/choices/0" && error.message.includes("{id,label,impact}")));
});

test("planning revision binding and Git Operator dispatch enforce run ownership", async () => {
  await withStore((store) => {
    const runId = createRun(store, "planning");
    assert.throws(
      () => store.bindPlanningRevision(runId, "another-repository", "20260814-plan", "001"),
      /does not belong/,
    );
    store.bindPlanningRevision(runId, "repo-review-fixture", "20260814-plan", "001");
    assert.equal(store.getRun(runId).plan_id, "20260814-plan");
    store.db.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,created_at) VALUES (?,?,?,?,?,?)")
      .run("20260814-plan", "001", "repo-review-fixture", "plan_ready", "main", new Date().toISOString());
    const dispatches = new DispatchService(store);
    const packet = {
      objective: "Commit the immutable planning revision",
      allowed_read_paths: [".ai-team/plans/20260814-plan/revisions/001"],
      allowed_write_paths: [],
      acceptance_criteria: ["Only planning files are committed"],
      context: { plan_id: "20260814-plan", revision: "001" },
    };
    const unrelatedId = dispatches.createPlanningCommit(runId, packet);
    store.db.prepare("UPDATE dispatches SET packet_json=? WHERE dispatch_id=?").run(JSON.stringify({
      ...packet,
      context: { plan_id: "20260814-other", revision: "002" },
    }), unrelatedId);
    const dispatchId = dispatches.createPlanningCommit(runId, packet);
    assert.notEqual(dispatchId, unrelatedId);
    assert.equal(dispatches.createPlanningCommit(runId, packet), dispatchId);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count,
      2,
    );
    assert.throws(() => dispatches.assertClaimed(runId, dispatchId, "git-operator"), /must be claimed/);
    dispatches.claim(runId, dispatchId, "git-operator");
    assert.doesNotThrow(() => dispatches.assertClaimed(runId, dispatchId, "git-operator"));
  });
});

test("planning results advance one stage and create at most one matching decision", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const question = "Which compatibility target should the complete requirements use?";
    const resultPath = join(home, "planning-stage.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No migration" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
        requirement_ids: ["REQ-001"],
        acceptance_criteria: ["AC-001"],
      },
    })));
    await dispatches.submit(runId, planningId, "planning", resultPath);
    assert.equal(store.getRun(runId).stage, "requirements");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { count: number }).count, 1);
    const firstDecision = store.db.prepare("SELECT decision_id,question,decision_type FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string; question: string; decision_type: string };
    assert.equal(firstDecision.question, `问题 1、${question}`);
    assert.equal(firstDecision.decision_type, "requirement");
    const secondPlanningId = dispatches.resolveDecision(runId, firstDecision.decision_id, "current");
    dispatches.claim(runId, secondPlanningId, "planning");
    const secondQuestion = "Which supported runtime is required?";
    await dispatches.submitValue(runId, secondPlanningId, "planning", completedResult(runId, secondPlanningId, "planning", {
      actions: ["clarify runtime"],
      stage: "requirements",
      pending_questions: [secondQuestion],
      decision: {
        question: secondQuestion,
        choices: [
          { id: "current", label: "Current", impact: "No compatibility work" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
        requirement_ids: ["REQ-002"],
        acceptance_criteria: ["AC-002"],
      },
    }));
    assert.equal((store.db.prepare("SELECT question FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { question: string }).question, `问题 2、${secondQuestion}`);

    const taskRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='plan_ready' WHERE run_id=?").run(taskRun);
    const taskPlanningId = dispatches.create(taskRun, "planning", dispatchPacket(), "planning");
    dispatches.claim(taskRun, taskPlanningId, "planning");
    const taskQuestion = "Should implementation be split into tasks?";
    await dispatches.submitValue(taskRun, taskPlanningId, "planning", completedResult(taskRun, taskPlanningId, "planning", {
      actions: ["confirm task split"],
      stage: "tasks_preview",
      pending_questions: [taskQuestion],
      decision: {
        question: taskQuestion,
        choices: [
          { id: "approve", label: "Approve", impact: "Creates the previewed task documents" },
          { id: "revise", label: "Revise", impact: "Requires another task preview" },
        ],
        recommendation: "approve",
      },
    }));
    const taskDecision = store.db.prepare("SELECT question,decision_type FROM decisions WHERE run_id=?").get(taskRun) as { question: string; decision_type: string };
    assert.equal(taskDecision.question, taskQuestion);
    assert.equal(taskDecision.decision_type, "task_preview");

    const invalidRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(invalidRun);
    const invalidId = dispatches.create(invalidRun, "planning", dispatchPacket(), "planning");
    dispatches.claim(invalidRun, invalidId, "planning");
    const invalidPath = join(home, "planning-skip.json");
    await writeFile(invalidPath, JSON.stringify(completedResult(invalidRun, invalidId, "planning", {
      actions: ["skip confirmation"], stage: "ready", pending_questions: [], decision: null,
    })));
    await assert.rejects(dispatches.submit(invalidRun, invalidId, "planning", invalidPath), /invalid planning stage transition/);
    assert.equal(
      (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(invalidId) as { state: string }).state,
      "claimed",
    );
    assert.equal(store.getRun(invalidRun).stage, "planning");
  });
});

test("requirements final confirmation is typed without a functional question number", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const dispatchId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, dispatchId, "planning");
    const decision = {
      question: "Confirm the complete requirements list?",
      choices: [
        { id: "confirm", label: "Confirm", impact: "Proceed to specification" },
        { id: "revise", label: "Revise", impact: "Return to requirements" },
      ],
      recommendation: "confirm",
    };
    await dispatches.submitValue(runId, dispatchId, "planning", {
      ...completedResult(runId, dispatchId, "planning", {
        actions: ["request final confirmation"], stage: "requirements", pending_questions: [], decision,
      }),
      status: "needs_decision",
      decisions_needed: [decision],
    });
    assert.deepEqual(
      store.db.prepare("SELECT question,decision_type FROM decisions WHERE run_id=?").get(runId),
      { question: decision.question, decision_type: "requirements_final" },
    );
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM planning_clarifications WHERE run_id=?").get(runId) as { count: number }).count, 0);
    assert.doesNotMatch((store.db.prepare("SELECT question FROM decisions WHERE run_id=?").get(runId) as { question: string }).question, /^问题 \d+、/);
  });
});

test("planning question results normalize completed and needs_decision into one atomic lifecycle", async () => {
  await withStore(async (store, home) => {
    for (const status of ["completed", "needs_decision"] as const) {
      const runId = createRun(store, "planning");
      store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
      const dispatches = new DispatchService(store);
      const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
      dispatches.claim(runId, planningId, "planning");
      const question = `Which compatibility target should ${status} use?`;
      const resultPath = join(home, `${status}-question.json`);
      await writeFile(resultPath, JSON.stringify({
        ...completedResult(runId, planningId, "planning", {
          actions: ["clarify compatibility"],
          stage: "requirements",
          pending_questions: [question],
          decision: {
            question,
            choices: [
              { id: "current", label: "Current", impact: "No migration" },
              { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
            ],
            recommendation: "current",
            requirement_ids: ["REQ-001"],
            acceptance_criteria: ["AC-001"],
          },
        }),
        status,
        decisions_needed: status === "needs_decision" ? [{
          question,
          choices: [
            { id: "current", label: "Current", impact: "No migration" },
            { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
          ],
          recommendation: "current",
          requirement_ids: ["REQ-001"],
          acceptance_criteria: ["AC-001"],
        }] : [],
      }));

      const first = await dispatches.submit(runId, planningId, "planning", resultPath);
      assert.equal(first.reused, false);
      assert.deepEqual(
        store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId),
        { state: "needs_decision", stage: "requirements" },
      );
      assert.equal(
        (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(planningId) as { state: string }).state,
        "needs_decision",
      );
      assert.equal(
        (store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { count: number }).count,
        1,
      );
      assert.equal((await dispatches.submit(runId, planningId, "planning", resultPath)).reused, true);
      assert.equal(
        (store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count,
        1,
      );
    }
  });
});

test("resolving a planning decision restores the run and creates exactly one continuation", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const question = "Which compatibility target should be selected?";
    const resultPath = join(home, "decision-question.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["clarify compatibility"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No migration" },
          { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
        ],
        recommendation: "current",
        requirement_ids: ["REQ-001"],
        acceptance_criteria: ["AC-001"],
      },
    })));
    await dispatches.submit(runId, planningId, "planning", resultPath);
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };

    const continuationId = dispatches.resolvePlanningDecision(runId, decision.decision_id, "current", "Keep scope small");
    assert.equal(store.getRun(runId).state, "active");
    assert.match(continuationId, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning' AND state='pending'").get(runId) as { count: number }).count,
      1,
    );
  });
});

test("verify_existing completes a planning run as audited no_change without implementation artifacts", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const questionDispatch = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, questionDispatch, "planning");
    const question = "The requested behavior exists at HEAD. How should this run finish?";
    const decision = {
      question,
      choices: [
        { id: "verify_existing", label: "Verify existing", impact: "Record evidence and finish without changes" },
        { id: "plan_changes", label: "Plan changes", impact: "Continue the normal planning workflow" },
    ],
    recommendation: "verify_existing",
    requirement_ids: ["REQ-001"],
    acceptance_criteria: ["AC-001"],
  };
    await dispatches.submitValue(runId, questionDispatch, "planning", completedResult(runId, questionDispatch, "planning", {
      actions: ["present verified HEAD implementation"],
      stage: "requirements",
      pending_questions: [question],
      decision,
    }));
    const decisionRow = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    const continuationId = dispatches.resolvePlanningDecision(runId, decisionRow.decision_id, "verify_existing", "Accept repository evidence");
    assert.equal(dispatches.resolvePlanningDecision(runId, decisionRow.decision_id, "verify_existing", "Accept repository evidence"), continuationId);
    dispatches.claim(runId, continuationId, "planning");

    const result = completedResult(runId, continuationId, "planning", {
      actions: ["record no-change completion"],
      stage: "no_change",
      pending_questions: [],
      decision: null,
      no_change: {
        decision_id: decisionRow.decision_id,
        conclusion: "The requested behavior is already implemented at HEAD.",
        repository_evidence: [
          { command: "git show HEAD:src/dispatch.ts", outcome: "The requested workflow is present" },
          { command: "npm test -- --test-name-pattern no_change", outcome: "Relevant behavior passed" },
        ],
      },
    });
    const first = await dispatches.submitValue(runId, continuationId, "planning", result);
    assert.deepEqual(
      store.db.prepare("SELECT state,stage,plan_id,revision FROM runs WHERE run_id=?").get(runId),
      { state: "completed", stage: "no_change", plan_id: null, revision: null },
    );
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator'").get(runId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM worktrees WHERE run_id=?").get(runId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM revisions").get() as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM operations WHERE run_id=?").get(runId) as { count: number }).count, 0);
    const event = store.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='planning.no_change_completed'").get(runId) as { payload_json: string };
    assert.equal((JSON.parse(event.payload_json) as { decision_receipt: { choice: string } }).decision_receipt.choice, "verify_existing");

    const retried = await dispatches.submitValue(runId, continuationId, "planning", result);
    assert.equal(retried.reused, true);
    assert.deepEqual(retried.submission, first.submission);
    assert.deepEqual(retried.continuation, { run_state: "completed", run_stage: "no_change", pending_dispatches: [], pending_decision: null });
  });
});

test("planning stages without questions continue automatically exactly once", async () => {
  await withStore(async (store, home) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const planningId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, planningId, "planning");
    const resultPath = join(home, "requirements-confirmed.json");
    await writeFile(resultPath, JSON.stringify(completedResult(runId, planningId, "planning", {
      actions: ["confirm requirements"],
      stage: "requirements_confirmed",
      pending_questions: [],
      decision: null,
    })));

    const first = await dispatches.submit(runId, planningId, "planning", resultPath);
    assert.equal(first.reused, false);
    assert.deepEqual(
      store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId),
      { state: "active", stage: "requirements_confirmed" },
    );
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning' AND state='pending'").get(runId) as { count: number }).count,
      1,
    );
    assert.equal((await dispatches.submit(runId, planningId, "planning", resultPath)).reused, true);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning'").get(runId) as { count: number }).count,
      2,
    );
  });
});

test("spec_ready task split continuation advances once and rejects a stage self-loop during validate", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='spec_ready' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const dispatchId = dispatches.continuePlanning(runId);
    const packet = JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { packet_json: string }).packet_json);
    assert.deepEqual(packet.context.phase, "task_split");
    assert.deepEqual(packet.context.target_stage, "plan_ready");
    assert.equal((dispatches.template(runId, dispatchId, "planning").payload as { stage: string }).stage, "plan_ready");
    dispatches.claim(runId, dispatchId, "planning");

    const retryableFailure = {
      ...completedResult(runId, dispatchId, "planning", {}),
      status: "retryable_failure" as const,
      verification: [],
      failure_class: "temporary_tool_failure",
      side_effect_state: "none" as const,
    };
    assert.doesNotThrow(() => dispatches.validateValue(runId, dispatchId, "planning", retryableFailure));
    assert.deepEqual(store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId), { state: "active", stage: "spec_ready" });
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count, 0);

    const invalid = completedResult(runId, dispatchId, "planning", {
      actions: ["repeat the current stage"], stage: "spec_ready", pending_questions: [], decision: null,
    });
    assert.throws(() => dispatches.validateValue(runId, dispatchId, "planning", invalid), /invalid planning stage transition: spec_ready -> spec_ready/);
    assert.equal((store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(dispatchId) as { state: string }).state, "claimed");

    const decision = {
      question: "Split the implementation into tasks?",
      choices: [
        { id: "split", label: "Split", impact: "Preview task documents" },
        { id: "no_split", label: "Do not split", impact: "Create the revision without tasks" },
      ],
      recommendation: "split",
    };
    const result = completedResult(runId, dispatchId, "planning", {
      actions: ["request task split"], stage: "plan_ready", pending_questions: [], decision,
    });
    assert.doesNotThrow(() => dispatches.validateValue(runId, dispatchId, "planning", result));
    const first = await dispatches.submitValue(runId, dispatchId, "planning", result);
    assert.equal(first.reused, false);
    assert.deepEqual(store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId), { state: "needs_decision", stage: "plan_ready" });
    assert.deepEqual(store.db.prepare("SELECT decision_type FROM decisions WHERE run_id=?").get(runId), { decision_type: "task_split" });
    const repeated = await dispatches.submitValue(runId, dispatchId, "planning", result);
    assert.equal(repeated.reused, true);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='task_split'").get(runId) as { count: number }).count, 1);
  });
});

test("fresh Planning and long-lived continuations share the spec_ready task split contract", async () => {
  await withStore(async (store) => {
    const dispatches = new DispatchService(store);
    const createSpecReadyRun = (): string => {
      const runId = createRun(store, "planning");
      store.db.prepare("UPDATE runs SET stage='spec_ready' WHERE run_id=?").run(runId);
      return runId;
    };
    const freshRun = createSpecReadyRun();
    const freshId = dispatches.create(freshRun, "planning", planningContinuationPacket("spec_ready"), "planning");
    const longLivedRun = createSpecReadyRun();
    const longLivedId = dispatches.continuePlanning(longLivedRun);
    const packet = (runId: string, dispatchId: string) => JSON.parse((store.db.prepare("SELECT packet_json FROM dispatches WHERE run_id=? AND dispatch_id=?").get(runId, dispatchId) as { packet_json: string }).packet_json);
    assert.deepEqual(packet(freshRun, freshId).context, packet(longLivedRun, longLivedId).context);
    assert.equal((dispatches.template(freshRun, freshId, "planning").payload as { stage: string }).stage, "plan_ready");
    assert.equal((dispatches.template(longLivedRun, longLivedId, "planning").payload as { stage: string }).stage, "plan_ready");

    for (const [runId, dispatchId] of [[freshRun, freshId], [longLivedRun, longLivedId]] as const) {
      dispatches.claim(runId, dispatchId, "planning");
      const decision = {
        question: "Split the implementation into tasks?",
        choices: [
          { id: "split", label: "Split", impact: "Preview task documents" },
          { id: "no_split", label: "Do not split", impact: "Create the revision without tasks" },
        ],
        recommendation: "split",
      };
      const result = completedResult(runId, dispatchId, "planning", {
        actions: ["request task split"], stage: "plan_ready", pending_questions: [], decision,
      });
      assert.doesNotThrow(() => dispatches.validateValue(runId, dispatchId, "planning", result));
      await dispatches.submitValue(runId, dispatchId, "planning", result);
      assert.deepEqual(store.db.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(runId), { state: "needs_decision", stage: "plan_ready" });
      assert.deepEqual(store.db.prepare("SELECT decision_type FROM decisions WHERE run_id=?").get(runId), { decision_type: "task_split" });
    }
  });
});

test("run resume recovers planning idempotently without crossing decisions or operations", async () => {
  await withStore((store) => {
    const recoverRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='requirements' WHERE run_id=?").run(recoverRun);
    const choices = [
      { id: "current", label: "Current", impact: "No migration" },
      { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
    ];
    const resolvedId = store.createDecision(recoverRun, "Which target?", choices, "current");
    store.decide(recoverRun, resolvedId, "current");
    const dispatches = new DispatchService(store);
    const first = dispatches.resume(recoverRun);
    const second = dispatches.resume(recoverRun);
    assert.equal((first.run as { state: string }).state, "active");
    assert.equal((second.run as { state: string }).state, "active");
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);

    const decisionRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='needs_decision',stage='requirements' WHERE run_id=?").run(decisionRun);
    store.createDecision(decisionRun, "Which target?", choices, "current");
    const decisionBlocked = dispatches.resume(decisionRun);
    assert.equal(decisionBlocked.pending_decision?.status, "pending");
    assert.equal(decisionBlocked.pending_dispatches.length, 0);
    assert.equal(store.getRun(decisionRun).state, "needs_decision");

    const operationRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(operationRun);
    store.beginOperation("git.commit", `commit:${operationRun}`, {}, operationRun);
    const operationBlocked = dispatches.resume(operationRun);
    assert.equal(operationBlocked.pending_operations.length, 1);
    assert.equal(operationBlocked.pending_dispatches.length, 0);

    const explorerRun = createRun(store, "planning");
    const explorerBlocked = dispatches.resume(explorerRun);
    assert.equal((explorerBlocked.run as { stage: string }).stage, "file-explorer");
    assert.equal((explorerBlocked.run as { state: string }).state, "needs_decision");
    assert.equal(explorerBlocked.pending_decision?.decision_type, "active_run_recovery");
    assert.equal(explorerBlocked.pending_dispatches.length, 0);

    const failedRun = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET state='failed',stage='requirements' WHERE run_id=?").run(failedRun);
    const failedBefore = store.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE run_id=?").get(failedRun);
    const failedResult = dispatches.resume(failedRun);
    assert.equal((failedResult.run as { state: string }).state, "failed");
    assert.deepEqual(store.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE run_id=?").get(failedRun), failedBefore);
    assert.equal(failedResult.pending_dispatches.length, 0);
  });
});

test("active run recovery retries the last durable stage instead of creating an acknowledgement loop", async () => {
  await withStore((store) => {
    const runId = createRun(store, "coding");
    const dispatches = new DispatchService(store);
    const originalId = dispatches.create(runId, "coding", {
      objective: "Continue the frozen coding stage",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: [],
      acceptance_criteria: ["Restore the original continuation"],
      context: { stage: "coding", phase: "continue_testing" },
    });
    store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?")
      .run(new Date().toISOString(), originalId);
    store.db.prepare("UPDATE runs SET state='active',stage='coding' WHERE run_id=?").run(runId);

    dispatches.resume(runId);
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    const replacementId = dispatches.resolveDecision(runId, decision.decision_id, "retry");
    const replacement = store.db.prepare("SELECT replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(replacementId) as { replacement_for: string; packet_json: string };
    assert.equal(replacement.replacement_for, originalId);
    assert.equal(JSON.parse(replacement.packet_json).objective, "Continue the frozen coding stage");

    const resumed = dispatches.resume(runId);
    assert.equal(resumed.pending_dispatches.length, 1);
    assert.equal(resumed.pending_dispatches[0]?.dispatch_id, replacementId);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery'").get(runId) as { count: number }).count, 1);
  });
});

test("active run recovery skips a completed authority conflict receipt and restores its developer", async () => {
  await withStore(async (store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), "."), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "20260820-authority-recovery", revision: "003" });
    const dispatches = new DispatchService(store);
    const taskId = "TASK-001";
    const worktreeId = "worktree_authority_recovery";
    const worktreePath = `/tmp/${runId}-task-001`;
    store.initializeRunTasks(runId, [{
      task_id: taskId,
      source_path: ".ai-team/plans/20260820-authority-recovery/revisions/003/tasks/TASK-001.md",
      source_digest: "a".repeat(64),
      write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
    }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, "task/20260820/task-001", worktreePath, "a".repeat(40), new Date().toISOString());
    store.advanceRunTask(runId, taskId, "prepared", { worktree_id: worktreeId });

    const developerId = dispatches.create(runId, "backend-developer", {
      objective: "Implement TASK-001 in its frozen prepared task worktree.",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      acceptance_criteria: ["Implement only the frozen Task scope"],
      context: { stage: "coding", phase: "implementation", task_id: taskId, worktree_id: worktreeId, worktree_path: worktreePath },
    });
    store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), developerId);
    store.db.prepare("UPDATE run_tasks SET state='implemented',developer_dispatch_id=? WHERE run_id=? AND task_id=?")
      .run(developerId, runId, taskId);
    const authorityId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket(),
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      context: {
        phase: "apply_task_authority",
        operation: "apply-task-authority",
        task_id: taskId,
        superseded_developer_dispatch_id: developerId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        authority_commit: "b".repeat(40),
        expected_head: "a".repeat(40),
      },
    });
    store.db.prepare("INSERT INTO operations(operation_id,run_id,idempotency_key,kind,state,request_json,evidence_json,created_at,completed_at) VALUES (?,?,?,'git.task_authority.apply','completed',?,?,?,?)")
      .run("op_authority_apply", runId, `authority:${runId}:${taskId}`, "{}", JSON.stringify({
        worktree_id: worktreeId,
        authority_commit: "b".repeat(40),
        head: "a".repeat(40),
      }), new Date().toISOString(), new Date().toISOString());
    dispatches.claim(runId, authorityId, "git-operator");
    await assert.rejects(
      dispatches.submitValue(runId, authorityId, "git-operator", completedResult(runId, authorityId, "git-operator", {
        operations: [{ command: "apply task authority", outcome: "completed" }],
      })),
      /authority application task is no longer ready for its replacement developer/,
    );
    store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), authorityId);
    const receiptId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket(),
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      acceptance_criteria: ["Record only the authority application receipt"],
      context: {
        phase: "continue_task_authority_conflict",
        operation: "continue-task-authority-conflict",
        authority_apply_dispatch_id: authorityId,
        authority_apply_operation_id: "op_authority_recovery",
        task_id: taskId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        authority_commit: "b".repeat(40),
        expected_head: "a".repeat(40),
        stash_commit: "c".repeat(40),
        dirty_paths: ["src/dispatch.ts"],
        authority_paths: ["src/dispatch.ts"],
        conflict_paths: ["src/dispatch.ts"],
        recovery: { completed_verification: [{ command: "git status", outcome: "clean" }, { command: "git status", outcome: "clean" }] },
      },
    });
    store.db.prepare("UPDATE dispatches SET replacement_for=? WHERE dispatch_id=?").run(authorityId, receiptId);
    store.db.prepare("UPDATE dispatches SET state='completed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), receiptId);
    store.db.prepare("UPDATE runs SET state='active',stage='git-operator' WHERE run_id=?").run(runId);

    dispatches.resume(runId);
    const decision = store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=? AND status='pending'").get(runId) as { decision_id: string };
    const replacementId = dispatches.resolveDecision(runId, decision.decision_id, "retry");
    const replacement = store.db.prepare("SELECT role,replacement_for,packet_json FROM dispatches WHERE dispatch_id=?").get(replacementId) as { role: string; replacement_for: string; packet_json: string };
    assert.equal(replacement.role, "backend-developer");
    assert.equal(replacement.replacement_for, developerId);
    assert.deepEqual(store.db.prepare("SELECT state,developer_dispatch_id FROM run_tasks WHERE run_id=? AND task_id=?").get(runId, taskId), {
      state: "prepared",
      developer_dispatch_id: replacementId,
    });
    assert.equal(JSON.parse(replacement.packet_json).context.phase, "implementation");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='continue_task_authority_conflict'").get(runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT status FROM decisions WHERE decision_id=?").get(decision.decision_id) as { status: string }).status, "resolved");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery' AND status='pending'").get(runId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery'").get(runId) as { count: number }).count, 1);

    const resumed = dispatches.resume(runId);
    assert.equal(resumed.pending_dispatches[0]?.dispatch_id, replacementId);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery' AND status='pending'").get(runId) as { count: number }).count, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery'").get(runId) as { count: number }).count, 1);
  });
});

test("run resume consumes a claimed completed authority conflict receipt and restores its developer", () => {
  return withStore((store) => {
    const repoId = "repo-review-fixture";
    store.registerRepository(repoId, join(process.cwd(), "."), process.cwd());
    const runId = store.createRun({ repoId, profile: "coding", mode: "planned", planId: "20260820-authority-recovery", revision: "003" });
    const dispatches = new DispatchService(store);
    const taskId = "TASK-001";
    const worktreeId = "worktree_authority_recovery";
    const worktreePath = `/tmp/${runId}-task-001`;
    store.initializeRunTasks(runId, [{
      task_id: taskId,
      source_path: ".ai-team/plans/20260820-authority-recovery/revisions/003/tasks/TASK-001.md",
      source_digest: "a".repeat(64),
      write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
    }]);
    store.db.prepare("INSERT INTO worktrees(worktree_id,run_id,branch,path,base_commit,state,created_at) VALUES (?,?,?,?,?,'active',?)")
      .run(worktreeId, runId, "task/20260820/task-001", worktreePath, "a".repeat(40), new Date().toISOString());
    store.advanceRunTask(runId, taskId, "prepared", { worktree_id: worktreeId });

    const developerId = dispatches.create(runId, "backend-developer", {
      objective: "Implement TASK-001 in its frozen prepared task worktree.",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      acceptance_criteria: ["Implement only the frozen Task scope"],
      context: { stage: "coding", phase: "implementation", task_id: taskId, worktree_id: worktreeId, worktree_path: worktreePath },
    });
    store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), developerId);
    store.db.prepare("UPDATE run_tasks SET state='prepared',developer_dispatch_id=? WHERE run_id=? AND task_id=?")
      .run(developerId, runId, taskId);
    const authorityId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket(),
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      context: {
        phase: "apply_task_authority",
        operation: "apply-task-authority",
        task_id: taskId,
        superseded_developer_dispatch_id: developerId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        authority_commit: "b".repeat(40),
        expected_head: "a".repeat(40),
      },
    });
    store.db.prepare("UPDATE dispatches SET state='failed',completed_at=? WHERE dispatch_id=?").run(new Date().toISOString(), authorityId);
    const receiptId = dispatches.create(runId, "git-operator", {
      ...dispatchPacket(),
      allowed_write_paths: ["src/dispatch.ts", "test/dispatch/planning-lifecycle.test.ts"],
      acceptance_criteria: ["Record only the authority application receipt"],
      context: {
        phase: "continue_task_authority_conflict",
        operation: "continue-task-authority-conflict",
        authority_apply_dispatch_id: authorityId,
        authority_apply_operation_id: "op_authority_recovery",
        task_id: taskId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        authority_commit: "b".repeat(40),
        expected_head: "a".repeat(40),
        stash_commit: "c".repeat(40),
        dirty_paths: ["src/dispatch.ts"],
        authority_paths: ["src/dispatch.ts"],
        conflict_paths: ["src/dispatch.ts"],
        recovery: { completed_verification: [{ command: "git status", outcome: "clean" }, { command: "git status", outcome: "clean" }] },
      },
    });
    store.db.prepare("UPDATE dispatches SET replacement_for=?,state='claimed',claimed_at=? WHERE dispatch_id=?")
      .run(authorityId, new Date().toISOString(), receiptId);
    store.db.prepare("UPDATE runs SET state='active',stage='git-operator' WHERE run_id=?").run(runId);

    const resumed = dispatches.resume(runId);
    const replacement = store.db.prepare("SELECT dispatch_id,role,replacement_for FROM dispatches WHERE run_id=? AND role='backend-developer' AND replacement_for=?")
      .get(runId, developerId) as { dispatch_id: string; role: string; replacement_for: string };
    assert.equal(resumed.pending_dispatches.length, 1);
    assert.equal(resumed.pending_dispatches[0]?.dispatch_id, replacement.dispatch_id);
    assert.equal(replacement.role, "backend-developer");
    assert.equal(replacement.replacement_for, developerId);
    assert.deepEqual(store.db.prepare("SELECT state,developer_dispatch_id FROM run_tasks WHERE run_id=? AND task_id=?").get(runId, taskId), {
      state: "prepared",
      developer_dispatch_id: replacement.dispatch_id,
    });
    assert.equal((store.db.prepare("SELECT state,result_json FROM dispatches WHERE dispatch_id=?").get(receiptId) as { state: string; result_json?: string }).state, "completed");
    assert.equal((store.db.prepare("SELECT state,result_json FROM dispatches WHERE dispatch_id=?").get(receiptId) as { state: string; result_json?: string }).result_json, null);
    assert.equal((store.db.prepare("SELECT stage FROM runs WHERE run_id=?").get(runId) as { stage: string }).stage, "coding");
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='git-operator' AND json_extract(packet_json,'$.context.phase')='continue_task_authority_conflict'").get(runId) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=? AND decision_type='active_run_recovery' AND status='pending'").get(runId) as { count: number }).count, 0);

    dispatches.resume(runId);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=?").get(runId) as { count: number }).count, 4);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count, 0);
  });
});

test("run resume repairs a stale planning retryable failure without crossing blockers or profiles", async () => {
  await withStore(async (store, home) => {
    const dispatches = new DispatchService(store);
    const makeRetryable = async (profile: "planning" | "coding", sideEffectState: "none" | "completed" | "unknown" = "none") => {
      const runId = createRun(store, profile);
      const explorerId = dispatches.create(runId, "file-explorer", dispatchPacket(["."]));
      dispatches.claim(runId, explorerId, "file-explorer");
      const resultPath = join(home, `${runId}-retryable.json`);
      await writeFile(resultPath, JSON.stringify({
        ...fileExplorerResult(runId, explorerId),
        status: "retryable_failure",
        verification: [],
        payload: {},
        failure_class: "temporary_tool_failure",
        side_effect_state: sideEffectState,
      }));
      await dispatches.submit(runId, explorerId, "file-explorer", resultPath);
      return { runId, explorerId };
    };

    const recoverable = await makeRetryable("planning");
    const first = dispatches.resume(recoverable.runId);
    const second = dispatches.resume(recoverable.runId);
    assert.equal((first.run as { state: string }).state, "active");
    assert.equal((second.run as { state: string }).state, "active");
    assert.equal(first.pending_dispatches.length, 1);
    assert.deepEqual(second.pending_dispatches, first.pending_dispatches);
    assert.equal(first.pending_dispatches[0]?.role, "file-explorer");
    assert.equal(
      (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(recoverable.explorerId) as { state: string }).state,
      "completed",
    );

    const decisionBlocked = await makeRetryable("planning");
    store.createDecision(decisionBlocked.runId, "Which target?", [
      { id: "current", label: "Current", impact: "No migration" },
      { id: "legacy", label: "Legacy", impact: "Adds compatibility work" },
    ], "current");
    const decisionResult = dispatches.resume(decisionBlocked.runId);
    assert.equal((decisionResult.run as { state: string }).state, "needs_decision");
    assert.equal(decisionResult.pending_dispatches.length, 0);
    assert.equal(
      (store.db.prepare("SELECT dispatch_id FROM decisions WHERE run_id=? AND status='pending'").get(decisionBlocked.runId) as { dispatch_id: string }).dispatch_id,
      decisionBlocked.explorerId,
    );

    const operationBlocked = await makeRetryable("planning");
    store.beginOperation("git.commit", `commit:${operationBlocked.runId}`, {}, operationBlocked.runId);
    const operationResult = dispatches.resume(operationBlocked.runId);
    assert.equal((operationResult.run as { state: string }).state, "retryable_failure");
    assert.equal(operationResult.pending_dispatches.length, 0);

    const coding = await makeRetryable("coding");
    const codingResult = dispatches.resume(coding.runId);
    assert.equal((codingResult.run as { state: string }).state, "active");
    assert.equal(codingResult.pending_dispatches.length, 1);
    assert.equal(codingResult.pending_dispatches[0]?.role, "file-explorer");

    for (const sideEffectState of ["completed", "unknown"] as const) {
      const blocked = await makeRetryable("planning", sideEffectState);
      const blockedResult = dispatches.resume(blocked.runId);
      assert.equal((blockedResult.run as { state: string }).state, "retryable_failure");
      assert.equal(blockedResult.pending_dispatches.length, 0);
      assert.equal(
        (store.db.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(blocked.explorerId) as { state: string }).state,
        "retryable_failure",
      );
    }

    for (const [name, resultJson] of [["missing", null], ["corrupt", "not-json"]] as const) {
      const blocked = await makeRetryable("planning");
      store.db.prepare("UPDATE dispatches SET result_json=? WHERE dispatch_id=?").run(resultJson, blocked.explorerId);
      const blockedResult = dispatches.resume(blocked.runId);
      assert.equal((blockedResult.run as { state: string }).state, "retryable_failure", name);
      assert.equal(blockedResult.pending_dispatches.length, 0, name);
    }
  });
});

test("requirement clarifications require explicit mappings and block planning continuation", async () => {
  await withStore(async (store) => {
    const runId = createRun(store, "planning");
    store.db.prepare("UPDATE runs SET stage='planning' WHERE run_id=?").run(runId);
    const dispatches = new DispatchService(store);
    const dispatchId = dispatches.create(runId, "planning", dispatchPacket(), "planning");
    dispatches.claim(runId, dispatchId, "planning");
    const question = "Which supported runtime is required?";
    const result = completedResult(runId, dispatchId, "planning", {
      actions: ["clarify runtime"],
      stage: "requirements",
      pending_questions: [question],
      decision: {
        question,
        choices: [
          { id: "current", label: "Current", impact: "No compatibility work" },
          { id: "legacy", label: "Legacy", impact: "Add compatibility work" },
        ],
        recommendation: "current",
      },
    });
    await assert.rejects(dispatches.submitValue(runId, dispatchId, "planning", result), /requirement_ids/);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM decisions WHERE run_id=?").get(runId) as { count: number }).count, 0);

    result.payload.decision = {
      ...result.payload.decision as Record<string, unknown>,
      requirement_ids: ["REQ-001"],
      acceptance_criteria: ["AC-001"],
    };
    await dispatches.submitValue(runId, dispatchId, "planning", result);
    const clarification = dispatches.runShowProjection(runId).planning_clarifications[0] as { clarification_id: string; status: string; answer: unknown };
    assert.equal(clarification.status, "pending");
    assert.equal(clarification.answer, null);
    assert.throws(() => dispatches.continuePlanning(runId), new RegExp(clarification.clarification_id));

    const decisionId = (store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=?").get(runId) as { decision_id: string }).decision_id;
    dispatches.resolvePlanningDecision(runId, decisionId, "current");
    assert.deepEqual(dispatches.runShowProjection(runId).planning_clarifications[0], {
      ...clarification,
      status: "resolved",
      answer: "current",
    });
  });
});
