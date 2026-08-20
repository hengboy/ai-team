---
plan_id: 20260820-main-agent-context-reduction
revision: "003"
target_branch: main
supersedes: "001"
---

# 任务拆分

## 任务清单

### TASK-001：实现澄清 ledger 与 Planning 硬门禁

- 需求覆盖：REQ-001, REQ-002
- 验收覆盖：AC-001, AC-002
- 目标：持久化完整疑点生命周期，并在所有规划和 Coding 边界执行可重关闭的硬门禁。
- 读取范围：`src/state.ts`、`src/dispatch/planning.ts`、`src/dispatch.ts`、`test/core.test.ts`
- 写入范围：`src/state.ts`、`src/dispatch/planning.ts`、`src/dispatch.ts`、`test/dispatch/planning-lifecycle.test.ts`、`test/cli/planning.test.ts`、`test/core.test.ts`
- 允许写入路径：`src/state.ts`、`src/dispatch/planning.ts`、`src/dispatch.ts`、`test/dispatch/planning-lifecycle.test.ts`、`test/cli/planning.test.ts`、`test/core.test.ts`
- 依赖：无
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-001, AC-002 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

## 依赖关系

```text
TASK-001
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 1 | TASK-001 | `src/state.ts`、`src/dispatch/planning.ts`、`test/dispatch/planning-lifecycle.test.ts`、`test/cli/planning.test.ts` |

## 风险与阻塞

- 风险：实现偏离冻结 REQ/AC；影响：revision 不可验收；缓解：只按任务契约与 focused tests 修改。
- 阻塞：出现新疑点或 scope drift；需要 Coding/Planning 处理。

- 恢复：TASK-001 owner 仍为 old run `run_01M0EGE2PJTX09YFPGV9PWXS3K`，HEAD `7a6b9bdf381b729fe0ea3a4dd5a7a92b27204941`，worktree `worktree_a95dda40d4600c6e583bba44` 保留 3 dirty edits；复用合法 artifact `artifact_f7d8985f3a88a22361ebadb1`，不得重复恢复、重建或丢弃。TASK-002 已由 revision 002 run `run_01M0EQZRQ5Z750AEKKE0NE3XPV` 通过 receipt `op_b07cef843a6ccc55ecb6cd986c` 成功恢复，保留 11 dirty edits，不得重复恢复或重建。

## 任务验收契约

```json
{
  "acceptance_criteria": [
    "AC-001",
    "AC-002"
  ],
  "acceptance_steps": [
    {
      "id": "VERIFY-001",
      "acceptance_criteria": [
        "AC-001"
      ],
      "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
      "expected_result": "AC-001 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-002",
      "acceptance_criteria": [
        "AC-002"
      ],
      "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
      "expected_result": "AC-002 tests pass with observable contract evidence"
    }
  ],
  "task_mapping": [
    {
      "task_id": "TASK-001",
      "acceptance_criteria": [
        "AC-001",
        "AC-002"
      ]
    }
  ],
  "test_commands": [
    "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts"
  ],
  "tdd_cycles": [
    {
      "acceptance_criterion": "AC-001",
      "test_path": "test/dispatch/planning-lifecycle.test.ts",
      "red": {
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_failure": "new AC-001 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-001",
          "preserve existing contracts outside TASK-001 scope"
        ],
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_result": "AC-001 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-002",
      "test_path": "test/dispatch/planning-lifecycle.test.ts",
      "red": {
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_failure": "new AC-002 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-002",
          "preserve existing contracts outside TASK-001 scope"
        ],
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_result": "AC-002 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts",
        "expected_result": "focused tests remain passing"
      }
    }
  ]
}
```
