---
plan_id: 20260820-main-agent-context-reduction
revision: "002"
target_branch: main
supersedes: "001"
---

# 实施计划

## 方案摘要

- 方案：依次实现 clarification ledger/硬门禁、最小权限 planning-writer、direct claim/compact/fresh continuation、run advance/metrics/context。
- 关键取舍：复用 SQLite、run events、artifact/dispatch lineage、managed staging 和 recovery projection；机械推进采用确定性服务。
- 不采用的方案及原因：不使用宽权限 LLM 总管、Git/Environment Operator 复用或单独 summarizer，避免权限扩大和 token 转移。

## 实施步骤

1. 步骤 1：读取现有 decisions/stage，写入 ledger migration、projection、gate 与生命周期测试；完成条件为 pending/revise/reopen 阻断通过。
2. 步骤 2：读取 role/agent-build contract，写入 planning-writer manifest/schema/environment/delegate 与权限测试；完成条件为允许操作成功且越权全部拒绝。
3. 步骤 3：读取 dispatch claim/submit/continuation，写入 compact contract、typed coordination、fresh packet 与原始 metrics 事件；完成条件为主代理默认无大对象且 provenance 完整。
4. 步骤 4：读取 recovery/CLI contract，写入 compact status、run advance boundary、metrics 聚合与等价 fixtures；完成条件为无重复副作用且指标达标。
5. 步骤 5：用 Explorer project_context 更新 MEMORY/navigation，运行 context validate 和全量 verify。

## 需求覆盖

| 需求/验收 ID | 实施位置 | 验证方式 | 责任角色 |
| --- | --- | --- | --- |
| REQ-001,REQ-002 / AC-001,AC-002 | state + planning lifecycle | planning lifecycle/CLI tests | backend-developer |
| REQ-003 / AC-003 | role + agent-build contracts | agent-build/permission tests | backend-developer |
| REQ-004..006 / AC-004..006 | dispatch + continuation | contract/recovery/CLI tests | backend-developer |
| REQ-007..009 / AC-007..010 | recovery + CLI + context | workflow/metrics/context/full verify | backend-developer,test |

## 验证

- 单元测试：ledger transition、gate predicate、compact serializer、boundary classifier、metrics aggregate。
- 集成测试：Planning/revision、dispatch/continuation、role permission、recovery/advance、context。
- 静态检查：`npm run typecheck`、`npm run lint`。
- 构建或打包：`npm run build`，最终由 `npm run verify` 覆盖。
- 手工验证：同 fixture 对比 compact/full 输出及 token/bytes 报告；运行 context validate。
- 失败时的诊断和回滚：保留 staging/run；按 receipt 修复；由 Git Operator revert 失败实现提交。

## 发布与回滚

- 发布前门禁：任务自测、双轴 review、独立 Test、verify 与 context validate。
- 发布顺序：ledger/gate -> writer -> compact/fresh -> advance/metrics -> context。
- 监控和观察窗口：固定 fixtures 比较主代理 P50/P95、总 token、boundary 命中和重复副作用。
- 回滚条件：P50/P95/总量不达标、state/digest/lineage 不等价、权限越界或跨人工边界。
- 回滚命令：由 Git Operator 对本次实现提交执行受控 revert。

## 方案验收契约

```json
{
  "acceptance_criteria": [
    "AC-001",
    "AC-002",
    "AC-003",
    "AC-004",
    "AC-005",
    "AC-006",
    "AC-007",
    "AC-008",
    "AC-009",
    "AC-010"
  ],
  "acceptance_steps": [
    {
      "id": "VERIFY-001",
      "acceptance_criteria": [
        "AC-001",
        "AC-002"
      ],
      "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
      "expected_result": "ledger lifecycle and planning hard gates pass"
    },
    {
      "id": "VERIFY-002",
      "acceptance_criteria": [
        "AC-003",
        "AC-004",
        "AC-005",
        "AC-006"
      ],
      "command": "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
      "expected_result": "writer permissions, compact contracts and fresh continuation pass"
    },
    {
      "id": "VERIFY-003",
      "acceptance_criteria": [
        "AC-007",
        "AC-008"
      ],
      "command": "npm test -- test/workflow.test.ts test/cli/planning.test.ts test/cli/project-runtime.test.ts",
      "expected_result": "advance boundaries and metrics thresholds pass"
    },
    {
      "id": "VERIFY-004",
      "acceptance_criteria": [
        "AC-009",
        "AC-010"
      ],
      "command": "npm run verify",
      "expected_result": "full verification, compatibility and context checks pass"
    }
  ],
  "task_mapping": [
    {
      "task_id": "TASK-001",
      "acceptance_criteria": [
        "AC-001",
        "AC-002"
      ]
    },
    {
      "task_id": "TASK-002",
      "acceptance_criteria": [
        "AC-003"
      ]
    },
    {
      "task_id": "TASK-003",
      "acceptance_criteria": [
        "AC-004",
        "AC-005",
        "AC-006"
      ]
    },
    {
      "task_id": "TASK-004",
      "acceptance_criteria": [
        "AC-007",
        "AC-008",
        "AC-009",
        "AC-010"
      ]
    }
  ],
  "test_commands": [
    "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
    "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
    "npm test -- test/workflow.test.ts test/cli/project-runtime.test.ts test/context.test.ts",
    "npm run verify",
    "ai-team context validate"
  ]
}
```
