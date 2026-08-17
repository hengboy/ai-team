---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# TASK-003：覆盖多 TASK E2E 与回归门禁

- 需求覆盖：REQ-009、REQ-010
- 验收覆盖：AC-009、AC-010、AC-011
- 目标：验证完整 planned 多 TASK 生命周期和旧行为兼容，完成独立评审与发布门禁。
- 读取范围：TASK-001/TASK-002 交接、planned workflow、Git orchestrator、CLI E2E、项目导航与全部相关回归。
- 写入范围：E2E/回归测试，以及入口职责变化时所需的项目上下文同步。
- 允许写入路径：`test/workflow.test.ts`、`test/git-orchestrator.test.ts`、`test/cli-e2e.test.ts`、`test/review-fixes.test.ts`、`MEMORY.md`、`.ai-team/index/feature-navigation.md`
- 依赖：TASK-002
- 实现步骤：
  1. 构造临时多 TASK planned run，完成 TASK-001 prepare、developer、test、commit 和无 fast-forward merge。
  2. 断言 TASK-002 worktree/branch 从 TASK-001 merge commit 派生。
  3. 断言 completion/resume 重放幂等且无伪 active recovery decision。
  4. 运行单 TASK planned、direct pre_write、普通 recovery 和 continue_commit 回归。
  5. 运行静态检查、定向测试、全量门禁并执行独立评审。
- 验收标准：AC-009、AC-010、AC-011 全部通过。
- 自测命令：`npm run typecheck && npm run lint && node --import tsx --test test/review-fixes.test.ts test/workflow.test.ts test/git-orchestrator.test.ts test/cli-e2e.test.ts && npm test`
- 交接内容：完整命令、退出码、关键状态断言、评审结论和残余风险。
