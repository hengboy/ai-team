---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# TASK-001：自我进化基础契约与配置

- 需求覆盖：REQ-001、REQ-003、REQ-006、REQ-008
- 验收覆盖：AC-001、AC-005、AC-008、AC-011、AC-012
- 目标：建立环境 opt-in、报告契约和兼容持久化基础。
- 读取范围：环境 schema/YAML、环境解析、contracts、state 与对应测试。
- 写入范围：环境配置、provenance、报告 schema、SQLite 迁移与测试。
- 允许写入路径：`agent-build/schemas/environment-v1.json`、`agent-build/environments/**`、`src/environment.ts`、`src/agent-build.ts`、`src/contracts.ts`、`src/constants.ts`、`src/state.ts`、`test/environment.test.ts`、`test/core.test.ts`
- 依赖：无
- 实现步骤：
  1. 增加默认关闭的 `features.selfEvolution.enabled` 并冻结 provenance。
  2. 定义严格 report/item/terminal sequence/source report 类型与 runtime 校验。
  3. 增加 available/unavailable、空数组、幂等唯一约束和兼容迁移。
  4. 覆盖旧配置、旧数据库、未知字段和敏感值测试。
- 验收标准：
  - AC-001、AC-005、AC-008、AC-011、AC-012 通过。
- 自测命令：`npm run typecheck && node --import tsx --test test/environment.test.ts test/core.test.ts`
- 交接内容：环境读取接口、报告存储 API、迁移和测试证据。
