---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# TASK-002：终态报告与独立修复完整链路

- 需求覆盖：REQ-002、REQ-003、REQ-004、REQ-005、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-002、AC-003、AC-004、AC-005、AC-006、AC-007、AC-008、AC-009、AC-010、AC-011、AC-012
- 目标：交付 run 终态报告、开发者展示和授权修复的完整用户链路。
- 读取范围：TASK-001 交接、dispatch/workflow/CLI/decision、角色资产、项目上下文和相关测试。
- 写入范围：聚合器、终态 hook、恢复、CLI、decision、新 run 关联、角色指令和导航。
- 允许写入路径：`src/self-evolution.ts`、`src/dispatch.ts`、`src/workflow.ts`、`src/cli.ts`、`src/command-contract.ts`、`src/state.ts`、planning/coding 角色文件、`MEMORY.md`、`.ai-team/index/feature-navigation.md` 及相关测试
- 依赖：TASK-001
- 实现步骤：
  1. 聚合并脱敏 ai-team failure、validation、replacement、retry 和 requested support。
  2. 在 completed/blocked 终态幂等生成报告，隔离失败并支持 resume 追加。
  3. 扩展 `run show` 和终态输出。
  4. 创建非阻塞 fix decision，确认后恰好启动一个独立修复 run。
  5. 更新受管角色指令并同步、校验项目上下文。
- 验收标准：
  - AC-002 至 AC-012 通过，且源 run 状态、side effect 与授权保持不变。
- 自测命令：`node --import tsx --test test/workflow.test.ts test/review-fixes.test.ts test/cli-e2e.test.ts test/agent-build.test.ts`
- 交接内容：终态与报告证据、CLI 示例、receipt、新 run 关联和 context validate 结果。
