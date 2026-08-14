---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# TASK-004：同步文档与项目上下文

- 需求覆盖：REQ-010, REQ-012
- 验收覆盖：AC-014, AC-015
- 目标：让用户文档、MEMORY 和功能导航准确描述最终 staging 边界与发布顺序。
- 读取范围：TASK-002/TASK-003 交接；`README.md`, `docs/agent-commands.md`, `docs/ai-team-v1.md`, `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts`
- 写入范围：同读取范围。
- 允许写入路径：`README.md`, `docs/agent-commands.md`, `docs/ai-team-v1.md`, `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts`
- 依赖：TASK-002, TASK-003
- 实现步骤：
  1. 记录 CLI、kind、安全、状态、保留和兼容发布。
  2. 同步 MEMORY 与 feature navigation。
  3. 通过受管 context update/validate。
- 验收标准：AC-014, AC-015 全部通过。
- 自测命令：`node --import tsx --test test/context.test.ts && ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team`
- 交接内容：文档 diff、project_context payload、validate 证据。
