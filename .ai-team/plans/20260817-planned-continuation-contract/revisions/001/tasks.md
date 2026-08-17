---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

## 任务清单

### TASK-001：收紧 dispatch packet 与路径授权契约

- 需求覆盖：REQ-003、REQ-004、REQ-005
- 验收覆盖：AC-004、AC-005
- 目标：公开并验证 phase/role context，返回精确 JSON pointer，统一 `.` 的项目根递归授权语义。
- 允许写入路径：`src/contracts.ts`、`src/dispatch.ts`、`src/security.ts`、`src/cli.ts`、`test/core.test.ts`、`test/review-fixes.test.ts`、`test/cli-e2e.test.ts`
- 依赖：无

### TASK-002：补齐 planned continuation、恢复与展示

- 需求覆盖：REQ-001、REQ-002、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-001、AC-002、AC-003、AC-006、AC-007、AC-008
- 目标：在 prepare completion/resume 中幂等派生 Coding continuation，并收敛 planned gate、resolved retry action 和 `run show` 契约。
- 允许写入路径：`src/dispatch.ts`、`src/cli.ts`、`agent-build/roles/coding.md`、`test/review-fixes.test.ts`、`test/cli-e2e.test.ts`
- 依赖：TASK-001

### TASK-003：覆盖多 TASK E2E 与回归门禁

- 需求覆盖：REQ-009、REQ-010
- 验收覆盖：AC-009、AC-010、AC-011
- 目标：验证完整 planned 多 TASK 生命周期和旧行为兼容，完成独立评审与发布门禁。
- 允许写入路径：`test/workflow.test.ts`、`test/git-orchestrator.test.ts`、`test/cli-e2e.test.ts`、`test/review-fixes.test.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md`
- 依赖：TASK-002

## 依赖关系

```text
TASK-001 -> TASK-002 -> TASK-003
```

## 并行批次

三个任务顺序执行；共享 `src/dispatch.ts` 与测试文件，不并行写入。

## 风险与阻塞

- continuation 幂等键不足可能造成重复 Coding dispatch；必须覆盖 completion 与 resume 交错。
- phase/role validation 可能误拒绝历史或不适用 phase；只对创建/提交的新 packet 按适用上下文校验。
- `.` 语义修复可能扩大非 Explorer 权限；保持非 Explorer broad scope 禁止规则和 canonical root 边界。
- 任何需要修改指定历史 run 或直接编辑状态库的方案都视为阻塞，不得执行。
