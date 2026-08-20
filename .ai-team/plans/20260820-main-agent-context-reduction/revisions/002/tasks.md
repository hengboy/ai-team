---
plan_id: 20260820-main-agent-context-reduction
revision: "002"
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
- 写入范围：`src/state.ts`、`src/dispatch/planning.ts`、`test/dispatch/planning-lifecycle.test.ts`、`test/cli/planning.test.ts`、`test/core.test.ts`
- 允许写入路径：`src/state.ts`、`src/dispatch/planning.ts`、`test/dispatch/planning-lifecycle.test.ts`、`test/cli/planning.test.ts`、`test/core.test.ts`
- 依赖：无
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-001, AC-002 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

### TASK-002：注册最小权限 planning-writer

- 需求覆盖：REQ-003
- 验收覆盖：AC-003
- 目标：注册 planning-writer 并以 schema、命令和写入 ownership 强制最小权限。
- 读取范围：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/environment-v1.json`
- 写入范围：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`src/environment.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/role-v1.json`、`agent-build/schemas/manifest-v1.json`、`agent-build/roles/planning.md`、`agent-build/roles/planning.yaml`、`agent-build/roles/planning-writer.md`、`agent-build/roles/planning-writer.yaml`、`agent-build/environments/balanced.yaml`、`agent-build/environments/quality.yaml`、`agent-build/environments/economy.yaml`、`test/agent-build.test.ts`、`agent-build/schemas/environment-v1.json`
- 允许写入路径：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`src/environment.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/role-v1.json`、`agent-build/schemas/manifest-v1.json`、`agent-build/roles/planning.md`、`agent-build/roles/planning.yaml`、`agent-build/roles/planning-writer.md`、`agent-build/roles/planning-writer.yaml`、`agent-build/environments/balanced.yaml`、`agent-build/environments/quality.yaml`、`agent-build/environments/economy.yaml`、`test/agent-build.test.ts`、`agent-build/schemas/environment-v1.json`
- 依赖：无
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-003 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

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
TASK-001 -> TASK-003
TASK-002 -> TASK-003
TASK-003 -> TASK-004
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 1 | TASK-001, TASK-002 | state/planning lifecycle；role/agent-build |
| 2 | TASK-003 | dispatch/continuation |
| 3 | TASK-004 | recovery/CLI/context |

## 风险与阻塞

- 风险：compact/fresh continuation 可能漏 provenance；影响：恢复和评审不可信；缓解：双路径 fixture 和权威 ID/digest 断言。
- 风险：run advance 可能跨人工边界；影响：未授权副作用；缓解：逐类 boundary RED tests 与步数/无进展上限。
- 阻塞：任一新疑点、scope drift、unknown side effect 或用户 decision；需要 Planning/Coding 按 ID 处理后恢复。

- 恢复：继续使用 Coding run `run_01M0EGE2PJTX09YFPGV9PWXS3K` 的既有 worktrees/edits；TASK-001 依据 implementation `artifact_f7d8985f3a88a22361ebadb1` 与 test `artifact_3f61e92b80e5f6ee57970f18` 恢复，TASK-002 依据 `artifact_dd7fa4b1f6cab614b65358ba` 与已 claimed replacement `dispatch_01M0EJ4MA6163NK55W6D4SSM4Y` 继续；不得重建 worktree、重做或丢弃现有改动。

## 任务验收契约

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
    },
    {
      "acceptance_criterion": "AC-003",
      "test_path": "test/agent-build.test.ts",
      "red": {
        "command": "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts",
        "expected_failure": "new AC-003 behavior fails before implementation"
      },
      "green": {
        "implementation_steps": [
          "implement the minimum behavior required by AC-003",
          "preserve existing contracts outside TASK-002 scope"
        ],
        "command": "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts",
        "expected_result": "AC-003 and existing focused tests pass"
      },
      "refactor": {
        "scope": "only remove duplication introduced by this task",
        "command": "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts",
        "expected_result": "focused tests remain passing"
      }
    },
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
    },
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
