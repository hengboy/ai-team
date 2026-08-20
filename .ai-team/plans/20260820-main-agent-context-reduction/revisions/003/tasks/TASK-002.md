---
plan_id: 20260820-main-agent-context-reduction
revision: "003"
target_branch: main
supersedes: "001"
---

# 任务拆分

## 任务清单

### TASK-002：注册最小权限 planning-writer

- 需求覆盖：REQ-003
- 验收覆盖：AC-003
- 目标：注册 planning-writer 并以 schema、命令和写入 ownership 强制最小权限。
- 读取范围：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`agent-build/manifest.yaml`
- 写入范围：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`src/environment.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/role-v1.json`、`agent-build/schemas/manifest-v1.json`、`agent-build/roles/planning.md`、`agent-build/roles/planning.yaml`、`agent-build/roles/planning-writer.md`、`agent-build/roles/planning-writer.yaml`、`agent-build/environments/balanced.yaml`、`agent-build/environments/quality.yaml`、`agent-build/environments/economy.yaml`、`test/agent-build.test.ts`
- 允许写入路径：`src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`src/environment.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/role-v1.json`、`agent-build/schemas/manifest-v1.json`、`agent-build/roles/planning.md`、`agent-build/roles/planning.yaml`、`agent-build/roles/planning-writer.md`、`agent-build/roles/planning-writer.yaml`、`agent-build/environments/balanced.yaml`、`agent-build/environments/quality.yaml`、`agent-build/environments/economy.yaml`、`test/agent-build.test.ts`
- 依赖：无
- 实现步骤：
  1. 先添加 RED tests，锁定行为、边界和兼容输出。
  2. 实现最小 production change 使 GREEN。
  3. 仅清理由本任务引入的重复并重跑 focused tests。
- 验收标准：AC-003 全部有可观察证据且未扩大写入范围。
- 自测命令：`npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts`
- 交接内容：变更路径、测试输出、artifact/digest、风险和后续依赖状态。

## 依赖关系

```text
TASK-002
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 1 | TASK-002 | `src/constants.ts`、`src/contracts.ts`、`src/agent-build.ts`、`src/environment.ts`、`agent-build/manifest.yaml`、`agent-build/schemas/role-v1.json`、`agent-build/schemas/manifest-v1.json`、`agent-build/roles/planning.md`、`agent-build/roles/planning.yaml`、`agent-build/roles/planning-writer.md`、`agent-build/roles/planning-writer.yaml`、`agent-build/environments/balanced.yaml`、`agent-build/environments/quality.yaml`、`agent-build/environments/economy.yaml`、`test/agent-build.test.ts` |

## 风险与阻塞

- 风险：实现偏离冻结 REQ/AC；影响：revision 不可验收；缓解：只按任务契约与 focused tests 修改。
- 阻塞：出现新疑点或 scope drift；需要 Coding/Planning 处理。

## 任务验收契约

```json
{
  "acceptance_criteria": [
    "AC-003"
  ],
  "acceptance_steps": [
    {
      "id": "VERIFY-001",
      "acceptance_criteria": [
        "AC-003"
      ],
      "command": "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts",
      "expected_result": "AC-003 tests pass with observable contract evidence"
    }
  ],
  "task_mapping": [
    {
      "task_id": "TASK-002",
      "acceptance_criteria": [
        "AC-003"
      ]
    }
  ],
  "test_commands": [
    "npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts"
  ],
  "tdd_cycles": [
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
    }
  ]
}
```
