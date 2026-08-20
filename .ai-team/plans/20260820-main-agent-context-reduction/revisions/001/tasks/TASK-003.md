---
plan_id: 20260820-main-agent-context-reduction
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

## 任务清单

### TASK-003：实现 direct claim、compact receipt 与 fresh continuation

- 需求覆盖：REQ-004, REQ-005, REQ-006
- 验收覆盖：AC-004, AC-005, AC-006
- 目标：把完整 bundle 下沉给目标角色，为主代理提供 compact 协调输出和引用式 fresh continuation。
- 读取范围：`src/dispatch.ts`、`src/dispatch/packet.ts`、`src/dispatch/implementation.ts`、`src/commands/staging-dispatch.ts`
- 写入范围：`src/dispatch.ts`、`src/dispatch/packet.ts`、`src/dispatch/implementation.ts`、`src/commands/staging-dispatch.ts`、`test/dispatch/contracts.test.ts`、`test/dispatch/recovery-review.test.ts`、`test/cli/staging-dispatch.test.ts`
- 允许写入路径：`src/dispatch.ts`、`src/dispatch/packet.ts`、`src/dispatch/implementation.ts`、`src/commands/staging-dispatch.ts`、`test/dispatch/contracts.test.ts`、`test/dispatch/recovery-review.test.ts`、`test/cli/staging-dispatch.test.ts`
- 依赖：TASK-001, TASK-002
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-004, AC-005, AC-006 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

## 依赖关系

```text
TASK-001 -> TASK-003
TASK-002 -> TASK-003
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 2 | TASK-003 | `src/dispatch.ts`、`src/dispatch/packet.ts`、`src/dispatch/implementation.ts`、`src/commands/staging-dispatch.ts`、`test/dispatch/contracts.test.ts`、`test/dispatch/recovery-review.test.ts`、`test/cli/staging-dispatch.test.ts` |

## 风险与阻塞

- 风险：实现偏离冻结 REQ/AC；影响：revision 不可验收；缓解：只按任务契约与 focused tests 修改。
- 阻塞：依赖 TASK-001, TASK-002 未完成或其 digest 不可用；需要 Coding/Planning 处理。

## 任务验收契约

```json
{
  "acceptance_criteria": [
    "AC-004",
    "AC-005",
    "AC-006"
  ],
  "acceptance_steps": [
    {
      "id": "VERIFY-001",
      "acceptance_criteria": [
        "AC-004"
      ],
      "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
      "expected_result": "AC-004 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-002",
      "acceptance_criteria": [
        "AC-005"
      ],
      "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
      "expected_result": "AC-005 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-003",
      "acceptance_criteria": [
        "AC-006"
      ],
      "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
      "expected_result": "AC-006 tests pass with observable contract evidence"
    }
  ],
  "task_mapping": [
    {
      "task_id": "TASK-003",
      "acceptance_criteria": [
        "AC-004",
        "AC-005",
        "AC-006"
      ]
    }
  ],
  "test_commands": [
    "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts"
  ],
  "tdd_cycles": [
    {
      "acceptance_criterion": "AC-004",
      "test_path": "test/dispatch/contracts.test.ts",
      "red": {
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_failure": "new AC-004 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-004",
          "preserve existing contracts outside TASK-003 scope"
        ],
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "AC-004 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-005",
      "test_path": "test/dispatch/contracts.test.ts",
      "red": {
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_failure": "new AC-005 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-005",
          "preserve existing contracts outside TASK-003 scope"
        ],
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "AC-005 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-006",
      "test_path": "test/dispatch/contracts.test.ts",
      "red": {
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_failure": "new AC-006 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-006",
          "preserve existing contracts outside TASK-003 scope"
        ],
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "AC-006 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts test/cli/staging-dispatch.test.ts",
        "expected_result": "focused tests remain passing"
      }
    }
  ]
}
```
