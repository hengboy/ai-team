import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { createResultTemplate } from "../../src/contracts.js";
import { DispatchService } from "../../src/dispatch.js";
import { StateStore } from "../../src/state.js";

import { cli, cliWithInput, git, json, makeSandbox } from "../helpers/cli.js";

test("run decide projects a scope-blocked new-plan recovery as terminal", async (t) => {
  const sandbox = await makeSandbox(t);
  const store = await StateStore.open(sandbox.aiTeamHome);
  const repoId = "repo-terminal-recovery";
  store.registerRepository(repoId, sandbox.repo, sandbox.repo);
  const runId = store.createRun({ repoId, profile: "coding", mode: "feature", request: "Terminal recovery projection." });
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FB2";
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,result_json,prompt,schema_json,template_json,completed_at,created_at
  ) VALUES (?,?,?,'failed',?,?,?,?,?,?,?)`).run(
    dispatchId,
    runId,
    "backend-developer",
    JSON.stringify({
      objective: "Repair frozen Test failures",
      allowed_read_paths: ["src/dispatch.ts"],
      allowed_write_paths: ["src/dispatch.ts"],
      acceptance_criteria: ["Resolve frozen checks"],
      context: { phase: "test_repair" },
    }),
    JSON.stringify({ status: "failed", failure_class: "allowed_path_blocked", side_effect_state: "none" }),
    "",
    "{}",
    "{}",
    now,
    now,
  );
  const decisionId = store.createDecision(
    runId,
    "Frozen scope cannot repair the blocked path.",
    [
      { id: "abort", label: "Abort", impact: "Stop this run" },
      { id: "new_plan_required", label: "New plan required", impact: "Stop this run without a replacement" },
    ],
    "new_plan_required",
    "active_run_recovery",
  );
  store.db.prepare("UPDATE decisions SET dispatch_id=? WHERE decision_id=?").run(dispatchId, decisionId);
  store.db.prepare("UPDATE runs SET state='needs_decision',stage='coding' WHERE run_id=?").run(runId);
  store.close();

  const result = json<{
    status: string;
    dispatch_id: string;
    role: string;
    run_state: string;
    recovery_action: { type: string; choice: string };
  }>(await cli(sandbox, [
    "run", "decide", "--run-id", runId, "--decision-id", decisionId, "--choice", "new_plan_required",
  ]));
  assert.deepEqual(result, {
    status: "resolved",
    dispatch_id: dispatchId,
    role: "backend-developer",
    run_state: "canceled",
    recovery_action: { type: "run_terminated", choice: "new_plan_required" },
  });

  const resumed = json<{ run: { state: string }; pending_dispatches: unknown[]; pending_decision: unknown }>(await cli(sandbox, ["run", "resume", runId]));
  assert.equal(resumed.run.state, "canceled");
  assert.deepEqual(resumed.pending_dispatches, []);
  assert.equal(resumed.pending_decision, null);
});


test("planning revision creation enforces task preview approval and preserves retry state", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "planning-request.md");
  await writeFile(requestFile, "Plan revision approval recovery.\n");
  const first = json<{ run_id: string }>(await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]));

  const spec = [
    "# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景",
    "## 功能需求", "### REQ-001：需求", "对应验收 AC-001", "## 验收标准", "### AC-001：验收",
    "- Given：前置", "- When：操作", "- Then：结果", "- 覆盖需求：REQ-001", "- RED 判定：实施前失败",
    "- 可观察结果：实施后通过", "- 边界反例：无输入", "- 建议测试层级：unit", "- 验证命令或证据路径：npm test", "## 数据与接口", "无", "## 兼容约束", "无",
    "## 安全约束", "无", "## 错误与边界", "无", "## 迁移发布回滚", "回滚", "## 已确认偏好", "无",
    "## 默认取舍", "无", "## 已关闭问题", "无", "## 未决问题", "无",
  ].join("\n");
  const planContract = {
    acceptance_criteria: ["AC-001"],
    acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
    task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
    test_commands: ["npm test"],
  };
  const taskContract = {
    ...planContract,
    tdd_cycles: [{ acceptance_criterion: "AC-001", test_path: "test/example.test.ts", red: { command: "npm test", expected_failure: "fails" }, green: { implementation_steps: ["implement"], command: "npm test", expected_result: "passes" }, refactor: { scope: "none", command: "npm test", expected_result: "passes" } }],
  };
  const planMetadata = { extensions: { acceptance_contract: planContract } };
  const taskMetadata = { extensions: { acceptance_contract: taskContract } };
  const plan = (coverage: string) => [
    "# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", coverage,
    "## 验证", "验证", "## 发布与回滚", "回滚",
  ].join("\n");
  const simpleDocuments = { spec, plan: plan("REQ-001 AC-001"), planMetadata };
  const taskDocuments = {
    spec,
    plan: plan("REQ-001 AC-001"),
    planMetadata,
    tasks: ["# Tasks", "REQ-001 AC-001 TASK-001"].join("\n"),
    tasksMetadata: taskMetadata,
    taskFiles: { "TASK-001": ["# TASK-001", "REQ-001 AC-001 TASK-001"].join("\n") },
    taskMetadataFiles: { "TASK-001": taskMetadata },
  };
  const approvalChoices = [
    { id: "approve", label: "Approve", impact: "Create task documents" },
    { id: "revise", label: "Revise", impact: "Require another preview" },
  ];

  const store = await StateStore.open(sandbox.aiTeamHome);
  const repository = store.db.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(first.run_id) as { repo_id: string };
  const makeRun = (): string => store.createRun({ repoId: repository.repo_id, profile: "planning", mode: "planned", request: "revision approval" });
  const prepare = async (runId: string, documents: unknown, stage: "plan_ready" | "tasks_preview", choice?: "approve" | "revise") => {
    store.db.prepare("UPDATE runs SET stage=?,state=? WHERE run_id=?").run(stage, stage === "tasks_preview" && !choice ? "needs_decision" : "active", runId);
    let decisionId: string | undefined;
    if (stage === "tasks_preview") {
      decisionId = store.createDecision(runId, "Approve this task preview?", approvalChoices, "approve", "task_preview");
      if (choice) store.decide(runId, decisionId, choice);
    }
    const staging = await store.createStagingEntry({ runId, role: "planning", kind: "planning-documents", initialJson: JSON.stringify(documents) });
    return { decisionId, stagingId: staging.stagingId };
  };
  const noTaskRun = makeRun();
  const noTask = await prepare(noTaskRun, simpleDocuments, "plan_ready");
  const pendingRun = makeRun();
  const pending = await prepare(pendingRun, taskDocuments, "tasks_preview");
  const reviseRun = makeRun();
  const revise = await prepare(reviseRun, taskDocuments, "tasks_preview", "revise");
  store.close();

  const args = (command: "validate" | "create", planId: string, runId: string, stagingId: string) => [
    "planning", "revision", command, "--project", sandbox.repo, "--plan-id", planId, "--revision", "001",
    "--target-branch", "main", "--run-id", runId, "--staging-id", stagingId,
  ];
  const noTaskResult = json<{ path: string }>(await cli(sandbox, args("create", "20260816-no-task", noTaskRun, noTask.stagingId)));
  assert.equal(noTaskResult.path, join(sandbox.repo, ".ai-team", "plans", "20260816-no-task", "revisions", "001"));

  const pendingPlanId = "20260816-pending-task";
  const pendingPath = join(sandbox.repo, ".ai-team", "plans", pendingPlanId, "revisions", "001");
  const pendingValidation = await cli(sandbox, args("validate", pendingPlanId, pendingRun, pending.stagingId));
  assert.notEqual(pendingValidation.status, 0);
  assert.match(pendingValidation.stderr, /task preview decision must be resolved/);
  const pendingCreate = await cli(sandbox, args("create", pendingPlanId, pendingRun, pending.stagingId));
  assert.notEqual(pendingCreate.status, 0);
  assert.match(pendingCreate.stderr, /task preview decision must be resolved/);
  await assert.rejects(stat(pendingPath), { code: "ENOENT" });

  const revisePlanId = "20260816-revise-task";
  const reviseCreate = await cli(sandbox, args("create", revisePlanId, reviseRun, revise.stagingId));
  assert.notEqual(reviseCreate.status, 0);
  assert.match(reviseCreate.stderr, /task preview must be approved/);
  await assert.rejects(stat(join(sandbox.repo, ".ai-team", "plans", revisePlanId, "revisions", "001")), { code: "ENOENT" });

  const retryStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal((retryStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id IN (?,?)").get(pendingPlanId, revisePlanId) as { count: number }).count, 0);
  assert.equal(retryStore.getStagingEntry(pending.stagingId).state, "draft");
  assert.equal(retryStore.getStagingEntry(revise.stagingId).state, "draft");
  retryStore.decide(pendingRun, pending.decisionId!, "approve");
  retryStore.db.prepare("UPDATE runs SET state='active' WHERE run_id=?").run(pendingRun);
  retryStore.close();

  const validation = json<{ path: string; digest: string; valid: boolean }>(await cli(sandbox, args("validate", pendingPlanId, pendingRun, pending.stagingId)));
  assert.equal(validation.valid, true);
  await assert.rejects(stat(pendingPath), { code: "ENOENT" });
  const validatedStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal(validatedStore.getStagingEntry(pending.stagingId).state, "draft");
  assert.equal((validatedStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id=?").get(pendingPlanId) as { count: number }).count, 0);
  validatedStore.close();

  json(await cli(sandbox, args("create", pendingPlanId, pendingRun, pending.stagingId)));
  assert.match(await readFile(join(pendingPath, "tasks.md"), "utf8"), /TASK-001/);
  assert.match(await readFile(join(pendingPath, "tasks", "TASK-001.md"), "utf8"), /AC-001/);
  const completedStore = await StateStore.open(sandbox.aiTeamHome);
  assert.equal(completedStore.getStagingEntry(pending.stagingId).state, "consumed");
  assert.equal((completedStore.db.prepare("SELECT count(*) AS count FROM revisions WHERE plan_id=?").get(pendingPlanId) as { count: number }).count, 1);
  completedStore.close();

  const transitioned = json<{ state: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "revision", "transition", "--project", sandbox.repo, "--plan-id", pendingPlanId,
    "--revision", "001", "--to", "plan_ready",
  ]));
  assert.equal(transitioned.state, "plan_ready");
  const transitionStore = await StateStore.open(sandbox.aiTeamHome);
  assert.deepEqual(
    transitionStore.db.prepare("SELECT role,state FROM dispatches WHERE dispatch_id=?").get(transitioned.dispatch_id),
    { role: "git-operator", state: "pending" },
  );
  transitionStore.close();

  const documentsFile = join(sandbox.root, "task-documents.json");
  await writeFile(documentsFile, JSON.stringify(taskDocuments));
  const duplicate = await cli(sandbox, [
    "planning", "revision", "create", "--project", sandbox.repo, "--plan-id", pendingPlanId, "--revision", "001",
    "--target-branch", "main", "--run-id", pendingRun, "--documents-file", documentsFile,
  ]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /revisions are immutable/);
});

test("planning revision create stdin preserves failed preflight staging for retry", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "planning-request.md");
  await writeFile(requestFile, "Exercise direct revision input.\n");
  const started = json<{ run_id: string }>(await cli(sandbox, [
    "planning", "start", "--project", sandbox.repo, "--request-file", requestFile,
  ]));
  const documents = {
    spec: [
      "# Spec", "## 背景", "背景", "## 目标", "目标", "## 非目标", "无", "## 用户场景", "场景",
      "## 功能需求", "### REQ-001：需求", "对应验收 AC-001", "## 验收标准", "### AC-001：验收",
      "- Given：前置", "- When：操作", "- Then：结果", "- 覆盖需求：REQ-001", "- RED 判定：实施前失败",
      "- 可观察结果：实施后通过", "- 边界反例：无输入", "- 建议测试层级：unit", "- 验证命令或证据路径：npm test", "## 数据与接口", "无", "## 兼容约束", "无",
      "## 安全约束", "无", "## 错误与边界", "无", "## 迁移发布回滚", "回滚", "## 已确认偏好", "无",
      "## 默认取舍", "无", "## 已关闭问题", "无", "## 未决问题", "无",
    ].join("\n"),
    plan: [
      "# Plan", "## 方案摘要", "摘要", "## 实施步骤", "步骤", "## 需求覆盖", "REQ-001 AC-001", "## 验证", "验证",
      "## 发布与回滚", "回滚",
    ].join("\n"),
    planMetadata: { extensions: { acceptance_contract: {
        acceptance_criteria: ["AC-001"],
        acceptance_steps: [{ id: "VERIFY-001", acceptance_criteria: ["AC-001"], command: "npm test", expected_result: "passes" }],
        task_mapping: [{ task_id: "TASK-001", acceptance_criteria: ["AC-001"] }],
        test_commands: ["npm test"],
    } } },
  };
  const args = [
    "planning", "revision", "create", "--project", sandbox.repo,
    "--plan-id", "20260817-stdin-revision", "--revision", "001", "--target-branch", "main",
    "--run-id", started.run_id,
  ];
  const validateBlocked = await cliWithInput(sandbox, [
    ...args.slice(0, 2), "validate", ...args.slice(3), "--input-stdin",
  ], JSON.stringify(documents));
  assert.equal(validateBlocked.status, 2);
  const validateFailure = JSON.parse(validateBlocked.stderr) as { details: { staging_id: string; state: string } };
  assert.match(validateFailure.details.staging_id, /^staging_/);
  assert.equal(validateFailure.details.state, "ready");

  const blocked = await cliWithInput(sandbox, [...args, "--input-stdin"], JSON.stringify(documents));
  assert.equal(blocked.status, 2);
  const failure = JSON.parse(blocked.stderr) as { details: { staging_id: string; state: string } };
  assert.match(failure.details.staging_id, /^staging_/);
  assert.equal(failure.details.state, "ready");
  await assert.rejects(stat(join(sandbox.repo, ".ai-team", "plans", "20260817-stdin-revision", "revisions", "001")), { code: "ENOENT" });

  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM revisions WHERE plan_id=? AND revision=?").get("20260817-stdin-revision", "001") as { count: number }).count, 0);
  database.prepare("UPDATE runs SET stage='plan_ready' WHERE run_id=?").run(started.run_id);
  database.close();

  const created = json<{ staging: { staging_id: string; state: string }; digest: string }>(await cli(sandbox, [
    ...args, "--staging-id", failure.details.staging_id,
  ]));
  assert.equal(created.staging.staging_id, failure.details.staging_id);
  assert.equal(created.staging.state, "consumed");
  assert.match(created.digest, /^[a-f0-9]{64}$/);
  await stat(join(sandbox.repo, ".ai-team", "plans", "20260817-stdin-revision", "revisions", "001", "spec.md"));
});

test("independent task split decisions have one legal plan_ready continuation", async (t) => {
  const sandbox = await makeSandbox(t);
  json(await cli(sandbox, ["init", sandbox.repo, "--yes"]));
  const createPlanningRun = async (): Promise<{ runId: string; dispatchId: string }> => {
    const store = await StateStore.open(sandbox.aiTeamHome);
    store.registerRepository("repo-task-split", join(sandbox.repo, ".git"), sandbox.repo);
    const runId = store.createRun({ repoId: "repo-task-split", profile: "planning", mode: "planned", request: "split decision" });
    store.db.prepare("UPDATE runs SET stage='plan_ready' WHERE run_id=?").run(runId);
    const service = new DispatchService(store);
    const dispatchId = service.create(runId, "planning", {
      objective: "request task split", allowed_read_paths: ["README.md"], allowed_write_paths: [], acceptance_criteria: ["record decision"], context: {},
    }, "planning");
    service.claim(runId, dispatchId, "planning");
    store.close();
    return { runId, dispatchId };
  };
  const decision = {
    question: "Split implementation into tasks?",
    choices: [
      { id: "split", label: "Split", impact: "Preview task documents" },
      { id: "no_split", label: "Do not split", impact: "Create the revision without tasks" },
    ],
    recommendation: "no_split",
    type: "task_split",
  };

  const noSplit = await createPlanningRun();
  const noSplitCreated = json<{ decision_id: string }>(await cliWithInput(sandbox, [
    "decision", "create", "--run-id", noSplit.runId, "--dispatch-id", noSplit.dispatchId, "--input-stdin",
  ], JSON.stringify(decision)));
  const noSplitResolved = json<{ dispatch_id: string }>(await cli(sandbox, [
    "run", "decide", "--run-id", noSplit.runId, "--decision-id", noSplitCreated.decision_id, "--choice", "no_split",
  ]));
  assert.equal(noSplitResolved.dispatch_id, noSplit.dispatchId);
  const noSplitShow = json<{ run: { state: string; stage: string }; dispatches: Array<{ role: string; state: string }> }>(await cli(sandbox, ["run", "show", noSplit.runId]));
  assert.equal(noSplitShow.run.state, "active");
  assert.equal(noSplitShow.run.stage, "plan_ready");
  assert.equal(noSplitShow.dispatches.filter(({ role, state }) => role === "planning" && ["pending", "claimed", "failed"].includes(state)).length, 0);

  const split = await createPlanningRun();
  const splitCreated = json<{ decision_id: string }>(await cliWithInput(sandbox, [
    "decision", "create", "--run-id", split.runId, "--dispatch-id", split.dispatchId, "--input-stdin",
  ], JSON.stringify(decision)));
  const splitResolved = json<{ dispatch_id: string }>(await cli(sandbox, [
    "run", "decide", "--run-id", split.runId, "--decision-id", splitCreated.decision_id, "--choice", "split",
  ]));
  assert.notEqual(splitResolved.dispatch_id, split.dispatchId);
  const splitShow = json<{ run: { state: string; stage: string }; dispatches: Array<{ dispatch_id: string; role: string; state: string }> }>(await cli(sandbox, ["run", "show", split.runId]));
  assert.equal(splitShow.run.state, "active");
  assert.equal(splitShow.run.stage, "plan_ready");
  assert.deepEqual(splitShow.dispatches.filter(({ role, state }) => role === "planning" && ["pending", "claimed"].includes(state)).map(({ dispatch_id, role, state }) => ({ dispatch_id, role, state })), [
    { dispatch_id: splitResolved.dispatch_id, role: "planning", state: "pending" },
  ]);
});

test("CLI requirement decisions require mappings and create a clarification ledger", async (t) => {
  const sandbox = await makeSandbox(t);
  const store = await StateStore.open(sandbox.aiTeamHome);
  const repoId = "repo-cli-clarification";
  store.registerRepository(repoId, join(sandbox.repo, ".git"), sandbox.repo);
  const runId = store.createRun({ repoId, profile: "planning", mode: "planned", request: "Clarify requirements" });
  store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
  const service = new DispatchService(store);
  const dispatchId = service.create(runId, "planning", {
    objective: "Clarify one requirement", allowed_read_paths: ["README.md"], allowed_write_paths: [], acceptance_criteria: ["Record the decision"], context: {},
  }, "planning");
  service.claim(runId, dispatchId, "planning");
  store.close();

  const base = {
    question: "Which runtime is supported?",
    choices: [
      { id: "current", label: "Current", impact: "No compatibility work" },
      { id: "legacy", label: "Legacy", impact: "Add compatibility work" },
    ],
    recommendation: "current",
    type: "requirement",
  };
  const created = json<{ decision_id: string }>(await cliWithInput(sandbox, [
    "decision", "create", "--run-id", runId, "--dispatch-id", dispatchId, "--input-stdin",
  ], JSON.stringify({ ...base, requirement_ids: ["REQ-001"], acceptance_criteria: ["AC-001"] })));
  const shown = json<{ planning_clarifications: Array<Record<string, unknown>> }>(await cli(sandbox, ["run", "show", runId]));
  assert.deepEqual(shown.planning_clarifications, [{
    clarification_id: shown.planning_clarifications[0]!.clarification_id,
    decision_id: created.decision_id,
    source: "cli_decision_create",
    impact: base.choices,
    requirement_ids: ["REQ-001"],
    acceptance_criteria: ["AC-001"],
    status: "pending",
    answer: null,
  }]);

  json(await cli(sandbox, ["run", "decide", "--run-id", runId, "--decision-id", created.decision_id, "--choice", "current"]));
  const resolved = json<{ planning_clarifications: Array<{ status: string; answer: string }> }>(await cli(sandbox, ["run", "show", runId]));
  assert.deepEqual(resolved.planning_clarifications.map(({ status, answer }) => ({ status, answer })), [{ status: "resolved", answer: "current" }]);
});

test("planning dispatch can be claimed, inspected, submitted, resumed, and decided", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Plan a documented CLI change.\n");

  const missingRequest = await cli(sandbox, ["planning", "start", "--project", sandbox.repo]);
  assert.equal(missingRequest.status, 2);
  assert.match(missingRequest.stderr, /requires exactly one of requestFile, requestStdin|provide exactly one/);

  const started = json<{ run_id: string; dispatch_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  assert.match(started.run_id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(started.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);

  const identity = [
    "--run-id", started.run_id,
    "--dispatch-id", started.dispatch_id,
    "--role", "file-explorer",
  ];
  const claim = json<{ reused: boolean; packet: { objective: string; allowed_write_paths: string[] } }>(
    await cli(sandbox, ["dispatch", "claim", ...identity]),
  );
  assert.equal(claim.reused, false);
  assert.deepEqual(claim.packet.allowed_write_paths, []);
  assert.match(claim.packet.objective, /Explore the repository/);

  const prompt = json<string>(await cli(sandbox, ["dispatch", "prompt", ...identity]));
  assert.match(prompt, new RegExp(`Dispatch: ${started.dispatch_id}`));
  assert.match(prompt, /Role: file-explorer/);
  const schema = json<{ type: string; required: string[] }>(await cli(sandbox, ["dispatch", "schema", ...identity]));
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes("run_id"));
  assert.ok(schema.required.includes("verification"));

  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath, { readonly: true });
  const row = database.prepare("SELECT template_json FROM dispatches WHERE dispatch_id=?").get(started.dispatch_id) as {
    template_json: string;
  };
  database.close();
  const result = JSON.parse(row.template_json) as Record<string, unknown>;
  result.summary = "Repository entry points and tests were identified.";
  result.verification = [{ command: "git status --short", outcome: "passed" }];
  result.payload = {
    allowed_read_paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md", "README.md"],
    entry_points: ["README.md"],
    test_commands: ["npm test"],
    project_context: {
      project_shape: "documentation fixture",
      memory: { domain_terms: [], repository_constraints: [], responsibilities: [], module_boundaries: [] },
      navigation: [{ feature: "Fixture", keywords: ["fixture"], entry_paths: ["README.md"], module_boundary: "root" }],
      maintenance: { status: "current", paths: ["MEMORY.md", ".ai-team/index/feature-navigation.md"] },
    },
  };
  const resultFile = join(sandbox.root, "result.json");
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);

  const submitted = json<{ reused: boolean; artifact: string }>(
    await cli(sandbox, ["dispatch", "submit", ...identity, "--result-file", resultFile]),
  );
  assert.equal(submitted.reused, false);
  await stat(submitted.artifact);

  const shown = json<{
    run: { run_id: string; profile: string };
    events: Array<{ type: string }>;
    dispatches: Array<{ dispatch_id: string; state: string }>;
  }>(await cli(sandbox, ["run", "show", started.run_id]));
  assert.equal(shown.run.profile, "planning");
  assert.ok(shown.events.some(({ type }) => type === "dispatch.completed"));
  assert.deepEqual(shown.dispatches.map(({ state }) => state), ["completed", "pending"]);

  const decisionFile = join(sandbox.root, "decision.json");
  await writeFile(decisionFile, JSON.stringify({
    question: "Which implementation path?",
    choices: [
      { id: "minimal", label: "Minimal", impact: "Smallest scope" },
      { id: "broad", label: "Broad", impact: "Larger scope" },
    ],
    recommendation: "minimal",
  }));
  const decision = json<{ decision_id: string }>(
    await cli(sandbox, ["decision", "create", "--run-id", started.run_id, "--dispatch-id", shown.dispatches.at(-1)!.dispatch_id, "--file", decisionFile]),
  );
  const resumed = json<{
    pending_dispatches: unknown[];
    pending_decision: { decision_id: string; status: string };
    pending_operations: unknown[];
    last_event: { type: string };
  }>(await cli(sandbox, ["run", "resume", started.run_id]));
  assert.equal(resumed.pending_dispatches.length, 1);
  assert.equal(resumed.pending_decision.decision_id, decision.decision_id);
  assert.equal(resumed.pending_decision.status, "pending");
  assert.deepEqual(resumed.pending_operations, []);
  assert.equal(resumed.last_event.type, "run.stage_changed");

  const noteFile = join(sandbox.root, "note.txt");
  await writeFile(noteFile, "Keep the change narrowly scoped.\n");
  const resolved = json<{ status: string; dispatch_id: string }>(await cli(sandbox, [
      "run", "decide",
      "--run-id", started.run_id,
      "--decision-id", decision.decision_id,
      "--choice", "minimal",
      "--note-file", noteFile,
    ]));
  assert.equal(resolved.status, "resolved");
  assert.match(resolved.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);
  const finalState = json<{ decisions: Array<{ status: string; choice: string; note: string }> }>(
    await cli(sandbox, ["run", "show", started.run_id]),
  );
  assert.deepEqual(finalState.decisions.map(({ status, choice, note }) => ({ status, choice, note })), [{
    status: "resolved",
    choice: "minimal",
    note: "Keep the change narrowly scoped.\n",
  }]);
});

test("planning no_change submit consumes one staging entry and leaves a terminal run", async (t) => {
  const sandbox = await makeSandbox(t);
  const store = await StateStore.open(sandbox.aiTeamHome);
  const repoId = "repo-cli-no-change";
  store.registerRepository(repoId, join(sandbox.repo, ".git"), sandbox.repo);
  const runId = store.createRun({ repoId, profile: "planning", mode: "planned", request: "Verify the implementation already at HEAD" });
  store.db.prepare("UPDATE runs SET stage='requirements' WHERE run_id=?").run(runId);
  const dispatches = new DispatchService(store);
  const packet = {
    objective: "Confirm whether the existing implementation should close the run",
    allowed_read_paths: ["README.md"],
    allowed_write_paths: [],
    acceptance_criteria: ["Record the user choice"],
    context: {},
  };
  const questionDispatch = dispatches.create(runId, "planning", packet, "planning");
  dispatches.claim(runId, questionDispatch, "planning");
  const question = "The requested behavior exists at HEAD. How should this run finish?";
  const decision = {
    question,
    choices: [
      { id: "verify_existing", label: "Verify existing", impact: "Finish without changes" },
      { id: "plan_changes", label: "Plan changes", impact: "Continue planning" },
  ],
  recommendation: "verify_existing",
  requirement_ids: ["REQ-001"],
  acceptance_criteria: ["AC-001"],
};
  await dispatches.submitValue(runId, questionDispatch, "planning", {
    ...createResultTemplate(runId, questionDispatch, "planning"),
    summary: "HEAD behavior was presented for confirmation.",
    verification: [{ command: "git show HEAD", outcome: "Requested behavior is present" }],
    payload: { actions: ["confirm existing implementation"], stage: "requirements", pending_questions: [question], decision },
  });
  const decisionId = (store.db.prepare("SELECT decision_id FROM decisions WHERE run_id=?").get(runId) as { decision_id: string }).decision_id;
  const continuationId = dispatches.resolvePlanningDecision(runId, decisionId, "verify_existing");
  const result = {
    ...dispatches.template(runId, continuationId, "planning"),
    summary: "The run completed without repository changes.",
    verification: [{ command: "npm test", outcome: "Existing implementation passed" }],
    payload: {
      actions: ["record no-change completion"],
      stage: "no_change",
      pending_questions: [],
      decision: null,
      no_change: {
        decision_id: decisionId,
        conclusion: "The requested behavior is already implemented at HEAD.",
        repository_evidence: [{ command: "git show HEAD", outcome: "Implementation and tests are present" }],
      },
    },
  };
  store.close();

  json(await cli(sandbox, ["dispatch", "claim", "--run-id", runId, "--dispatch-id", continuationId, "--role", "planning"]));
  const submitted = json<{
    reused: boolean;
    submission: { state: string; artifact_id: string; digest: string };
    staging: { staging_id: string; state: string };
    continuation: { run_state: string; run_stage: string; pending_dispatches: unknown[]; pending_decision: unknown };
  }>(await cliWithInput(sandbox, [
    "dispatch", "submit", "--run-id", runId, "--dispatch-id", continuationId, "--role", "planning", "--input-stdin",
  ], JSON.stringify(result)));
  assert.equal(submitted.reused, false);
  assert.equal(submitted.submission.state, "submitted");
  assert.match(submitted.submission.artifact_id, /^artifact_/);
  assert.match(submitted.submission.digest, /^[a-f0-9]{64}$/);
  assert.equal(submitted.staging.state, "consumed");
  assert.deepEqual(submitted.continuation, { run_state: "completed", run_stage: "no_change", pending_dispatches: [], pending_decision: null });

  const terminal = await StateStore.open(sandbox.aiTeamHome);
  assert.deepEqual(
    terminal.db.prepare("SELECT state,stage,plan_id,revision FROM runs WHERE run_id=?").get(runId),
    { state: "completed", stage: "no_change", plan_id: null, revision: null },
  );
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM staging_entries WHERE run_id=?").get(runId) as { count: number }).count, 1);
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM staging_entries WHERE run_id=? AND state!='consumed'").get(runId) as { count: number }).count, 0);
  assert.equal((terminal.db.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").get(runId) as { count: number }).count, 0);
  terminal.close();
});

test("planning revision commit rejects a claimed Git Operator dispatch for another revision before mutation", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Plan a guarded revision commit.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-guarded";
  const revision = "001";
  const foreignDispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=? WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", "a".repeat(64), new Date().toISOString());
  database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`).run(
    foreignDispatchId,
    started.run_id,
    "git-operator",
    JSON.stringify({
      objective: "Commit another planning revision",
      allowed_read_paths: [".ai-team/plans/20260814-other/revisions/002"],
      allowed_write_paths: [],
      acceptance_criteria: ["Commit the other revision"],
      context: { plan_id: "20260814-other", revision: "002" },
    }),
    "",
    "{}",
    "{}",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  database.close();

  const headBefore = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  const result = await cli(sandbox, [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", foreignDispatchId,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /planning commit dispatch does not match the requested revision/);
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headBefore);
  assert.equal((await git(sandbox, ["status", "--porcelain"])).stdout, "");
  const finalDatabase = new Database(databasePath, { readonly: true });
  assert.equal(
    (finalDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state,
    "plan_ready",
  );
  finalDatabase.close();
});


test("completed planning commit reconciliation converges state, validates ownership, and reuses without Git", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Reconcile an externally confirmed planning commit.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const otherStarted = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-reconciled";
  const revision = "001";
  const dispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const otherDispatchId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const stalePlanningId = "dispatch_01ARZ3NDEKTSV4RRFFQ69G5FB1";
  const digest = "d".repeat(64);
  const confirmedCommit = "e".repeat(40);
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "plan_ready", "main", digest, new Date().toISOString());
  const insertDispatch = database.prepare(`INSERT INTO dispatches(
    dispatch_id,run_id,role,state,packet_json,prompt,schema_json,template_json,claimed_at,created_at
  ) VALUES (?,?,?,'claimed',?,?,?,?,?,?)`);
  const packet = JSON.stringify({
    objective: "Commit this planning revision",
    allowed_read_paths: [`.ai-team/plans/${planId}/revisions/${revision}`],
    allowed_write_paths: [],
    acceptance_criteria: ["Commit this revision"],
    context: { plan_id: planId, revision },
  });
  insertDispatch.run(dispatchId, started.run_id, "git-operator", packet, "", "{}", "{}", new Date().toISOString(), new Date().toISOString());
  insertDispatch.run(otherDispatchId, otherStarted.run_id, "git-operator", packet, "", "{}", "{}", new Date().toISOString(), new Date().toISOString());
  insertDispatch.run(stalePlanningId, started.run_id, "planning", JSON.stringify({
    objective: "stale split continuation", allowed_read_paths: ["README.md"], allowed_write_paths: [], acceptance_criteria: ["close on ready"], context: { stage: "plan_ready" },
  }), "", "{}", "{}", new Date().toISOString(), new Date().toISOString());
  database.close();

  const commitArgs = [
    "planning", "revision", "commit",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--run-id", started.run_id,
    "--dispatch-id", dispatchId,
  ];
  assert.notEqual((await cli(sandbox, commitArgs)).status, 0);
  const pendingDatabase = new Database(databasePath, { readonly: true });
  const operation = pendingDatabase.prepare("SELECT operation_id FROM operations WHERE run_id=? AND state='pending'").get(started.run_id) as { operation_id: string };
  pendingDatabase.close();

  const invalidEvidence = join(sandbox.root, "invalid-completed.json");
  await writeFile(invalidEvidence, JSON.stringify({ plan_commit: "not-a-commit" }));
  const invalid = await cli(sandbox, [
    "git", "reconcile", "--run-id", started.run_id, "--dispatch-id", dispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", invalidEvidence,
  ]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /plan_commit/);

  const completedEvidence = join(sandbox.root, "completed.json");
  await writeFile(completedEvidence, JSON.stringify({
    plan_commit: confirmedCommit,
    plan_id: planId,
    revision,
    digest,
  }));
  const wrongRun = await cli(sandbox, [
    "git", "reconcile", "--run-id", otherStarted.run_id, "--dispatch-id", otherDispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", completedEvidence,
  ]);
  assert.equal(wrongRun.status, 2);
  assert.match(wrongRun.stderr, /does not belong to run/);
  const unchangedDatabase = new Database(databasePath, { readonly: true });
  assert.equal((unchangedDatabase.prepare("SELECT state FROM operations WHERE operation_id=?").get(operation.operation_id) as { state: string }).state, "pending");
  assert.equal((unchangedDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state, "plan_ready");
  unchangedDatabase.close();

  const reconcileArgs = [
    "git", "reconcile", "--run-id", started.run_id, "--dispatch-id", dispatchId,
    "--operation-id", operation.operation_id, "--state", "completed", "--evidence-file", completedEvidence,
  ];
  const reconciled = json<{ operation_id: string; state: string; plan_commit: string; reused: boolean }>(await cli(sandbox, reconcileArgs));
  assert.deepEqual(reconciled, { operation_id: operation.operation_id, state: "completed", plan_commit: confirmedCommit, reused: false });
  const staleDatabase = new Database(databasePath, { readonly: true });
  assert.equal((staleDatabase.prepare("SELECT state FROM dispatches WHERE dispatch_id=?").get(stalePlanningId) as { state: string }).state, "completed");
  assert.equal((staleDatabase.prepare("SELECT count(*) AS count FROM dispatches WHERE run_id=? AND role='planning' AND state IN ('pending','claimed','needs_decision')").get(started.run_id) as { count: number }).count, 0);
  staleDatabase.close();
  const repeated = json<{ operation_id: string; state: string; plan_commit: string; reused: boolean }>(await cli(sandbox, reconcileArgs));
  assert.deepEqual(repeated, { ...reconciled, reused: true });

  const convergedDatabase = new Database(databasePath, { readonly: true });
  assert.deepEqual(convergedDatabase.prepare("SELECT state,stage FROM runs WHERE run_id=?").get(started.run_id), { state: "active", stage: "ready" });
  assert.deepEqual(
    convergedDatabase.prepare("SELECT state,plan_commit FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision),
    { state: "ready", plan_commit: confirmedCommit },
  );
  convergedDatabase.close();

  const revisionRoot = join(sandbox.repo, ".ai-team", "plans", planId, "revisions", revision);
  await mkdir(revisionRoot, { recursive: true });
  await writeFile(join(sandbox.repo, ".ai-team", "plans", planId, "plan.yaml"), `plan_id: ${planId}\n`);
  await writeFile(join(revisionRoot, "spec.md"), "# Spec\n");
  const headBeforeRetry = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
  const retry = json<{ plan_commit: string; operation_id: string; reused: boolean }>(await cli(sandbox, commitArgs));
  assert.deepEqual(retry, { plan_commit: confirmedCommit, operation_id: operation.operation_id, reused: true, state: "ready" });
  assert.equal((await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim(), headBeforeRetry);
  assert.match((await git(sandbox, ["status", "--porcelain"])).stdout, /\.ai-team/);
});


test("planning revision transition recovers plan-ready run from spec-ready revision and rejects other drift", async (t) => {
  const sandbox = await makeSandbox(t);
  const requestFile = join(sandbox.root, "request.md");
  await writeFile(requestFile, "Recover a partially advanced planning revision.\n");
  const started = json<{ run_id: string }>(
    await cli(sandbox, ["planning", "start", "--project", sandbox.repo, "--request-file", requestFile]),
  );
  const planId = "20260814-recovery";
  const revision = "001";
  const databasePath = join(sandbox.aiTeamHome, "state", "state.sqlite");
  const database = new Database(databasePath);
  const run = database.prepare("SELECT repo_id FROM runs WHERE run_id=?").get(started.run_id) as { repo_id: string };
  database.prepare("UPDATE runs SET plan_id=?,revision=?,stage='plan_ready' WHERE run_id=?").run(planId, revision, started.run_id);
  database.prepare("INSERT INTO revisions(plan_id,revision,repo_id,state,target_branch,digest,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(planId, revision, run.repo_id, "spec_ready", "main", "a".repeat(64), new Date().toISOString());
  database.close();

  const recovered = json<{ state: string; dispatch_id: string }>(await cli(sandbox, [
    "planning", "revision", "transition",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--to", "plan_ready",
  ]));
  assert.equal(recovered.state, "plan_ready");
  assert.match(recovered.dispatch_id, /^dispatch_[0-9A-HJKMNP-TV-Z]{26}$/);

  const driftedDatabase = new Database(databasePath);
  driftedDatabase.prepare("UPDATE revisions SET state='draft' WHERE repo_id=? AND plan_id=? AND revision=?")
    .run(run.repo_id, planId, revision);
  driftedDatabase.prepare("UPDATE runs SET stage='ready' WHERE run_id=?").run(started.run_id);
  driftedDatabase.close();
  const rejected = await cli(sandbox, [
    "planning", "revision", "transition",
    "--project", sandbox.repo,
    "--plan-id", planId,
    "--revision", revision,
    "--to", "requirements_confirmed",
  ]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /revision state draft is incompatible with planning run stage ready/);
  const finalDatabase = new Database(databasePath, { readonly: true });
  assert.equal(
    (finalDatabase.prepare("SELECT state FROM revisions WHERE repo_id=? AND plan_id=? AND revision=?").get(run.repo_id, planId, revision) as { state: string }).state,
    "draft",
  );
  finalDatabase.close();
});
