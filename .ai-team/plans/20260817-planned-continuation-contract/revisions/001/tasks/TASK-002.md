---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# TASK-002：补齐 planned continuation、恢复与展示

- 需求覆盖：REQ-001、REQ-002、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-001、AC-002、AC-003、AC-006、AC-007、AC-008
- 目标：在 prepare completion/resume 中幂等派生 Coding continuation，并收敛 planned gate、resolved retry action 和 `run show` 契约。
- 读取范围：TASK-001 交接、`src/dispatch.ts`、`src/cli.ts`、`src/gates.ts`、`src/git-orchestrator.ts`、Coding 角色契约及对应测试。
- 写入范围：dispatch 状态机、resume/replacement/show 投影、Coding 角色契约和聚焦测试。
- 允许写入路径：`src/dispatch.ts`、`src/cli.ts`、`agent-build/roles/coding.md`、`test/review-fixes.test.ts`、`test/cli-e2e.test.ts`
- 依赖：TASK-001
- 实现步骤：
  1. 增加幂等 planned task-prepare continuation helper。
  2. 从 Git completion 和 resume 的通用 recovery 之前调用该 helper。
  3. 验证 Explorer、task/worktree、prepare lineage 并授权 developer dispatch。
  4. 明确 planned 不适用 direct pre_write 的角色契约。
  5. 输出 resolved retry action、pending dependency、continuation 和建议命令。
- 验收标准：AC-001、AC-002、AC-003、AC-006、AC-007、AC-008 全部通过。
- 自测命令：`npm run typecheck && node --import tsx --test test/review-fixes.test.ts test/cli-e2e.test.ts`
- 交接内容：状态转换、幂等条件、resume 顺序、CLI 输出和测试证据。
