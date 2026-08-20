---
plan_id: 20260820-main-agent-context-reduction
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

## 任务清单

### TASK-004：实现 run advance、指标验收与上下文维护

- 需求覆盖：REQ-007, REQ-008, REQ-009
- 验收覆盖：AC-007, AC-008, AC-009, AC-010
- 目标：实现确定性推进和硬停止边界，完成指标/兼容 fixtures 并同步项目上下文。
- 读取范围：`src/run-recovery.ts`、`src/commands/planning-run.ts`、`src/command-contract.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md`
- 写入范围：`src/run-recovery.ts`、`src/commands/planning-run.ts`、`src/command-contract.ts`、`test/workflow.test.ts`、`test/cli/project-runtime.test.ts`、`test/context.test.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md`
- 允许写入路径：`src/run-recovery.ts`、`src/commands/planning-run.ts`、`src/command-contract.ts`、`test/workflow.test.ts`、`test/cli/project-runtime.test.ts`、`test/context.test.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md`
- 依赖：TASK-003
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-007, AC-008, AC-009, AC-010 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm run verify`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

## 依赖关系

```text
TASK-003 -> TASK-004
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 3 | TASK-004 | `src/run-recovery.ts`、`src/commands/planning-run.ts`、`src/command-contract.ts`、`test/workflow.test.ts`、`test/cli/project-runtime.test.ts`、`test/context.test.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md` |

## 风险与阻塞

- 风险：实现偏离冻结 REQ/AC；影响：revision 不可验收；缓解：只按任务契约与 focused tests 修改。
- 阻塞：依赖 TASK-003 未完成或其 digest 不可用；需要 Coding/Planning 处理。

## 任务验收契约

```json
{
  "acceptance_criteria": [
    "AC-007",
    "AC-008",
    "AC-009",
    "AC-010"
  ],
  "acceptance_steps": [
    {
      "id": "VERIFY-001",
      "acceptance_criteria": [
        "AC-007"
      ],
      "command": "npm run verify",
      "expected_result": "AC-007 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-002",
      "acceptance_criteria": [
        "AC-008"
      ],
      "command": "npm run verify",
      "expected_result": "AC-008 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-003",
      "acceptance_criteria": [
        "AC-009"
      ],
      "command": "npm run verify",
      "expected_result": "AC-009 tests pass with observable contract evidence"
    },
    {
      "id": "VERIFY-004",
      "acceptance_criteria": [
        "AC-010"
      ],
      "command": "npm run verify",
      "expected_result": "AC-010 tests pass with observable contract evidence"
    }
  ],
  "task_mapping": [
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
    "npm run verify"
  ],
  "tdd_cycles": [
    {
      "acceptance_criterion": "AC-007",
      "test_path": "test/workflow.test.ts",
      "red": {
        "command": "npm run verify",
        "expected_failure": "new AC-007 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-007",
          "preserve existing contracts outside TASK-004 scope"
        ],
        "command": "npm run verify",
        "expected_result": "AC-007 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm run verify",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-008",
      "test_path": "test/workflow.test.ts",
      "red": {
        "command": "npm run verify",
        "expected_failure": "new AC-008 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-008",
          "preserve existing contracts outside TASK-004 scope"
        ],
        "command": "npm run verify",
        "expected_result": "AC-008 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm run verify",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-009",
      "test_path": "test/workflow.test.ts",
      "red": {
        "command": "npm run verify",
        "expected_failure": "new AC-009 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-009",
          "preserve existing contracts outside TASK-004 scope"
        ],
        "command": "npm run verify",
        "expected_result": "AC-009 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm run verify",
        "expected_result": "focused tests remain passing"
      }
    },
    {
      "acceptance_criterion": "AC-010",
      "test_path": "test/workflow.test.ts",
      "red": {
        "command": "npm run verify",
        "expected_failure": "new AC-010 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-010",
          "preserve existing contracts outside TASK-004 scope"
        ],
        "command": "npm run verify",
        "expected_result": "AC-010 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm run verify",
        "expected_result": "focused tests remain passing"
      }
    }
  ]
}
```
