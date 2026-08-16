---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# 实施计划

## 方案摘要

- 方案：增加默认关闭的环境功能开关，将启用状态冻结到 run；扩展公共结果与状态契约以采集 ai-team 运行证据；在 planning/coding run 完成或阻塞的生命周期边界幂等生成结构化报告；通过 CLI 展示并创建非阻塞修复 decision，确认后启动来源可追踪的独立修复 run。
- 关键取舍：报告按 run 终态聚合，不按 dispatch 输出；报告失败与原终态隔离；历史报告不可变；修复必须重新授权。
- 不采用的方案及原因：不采用纯终端文本，因为不可审计；不采用仓库 Markdown，因为会制造工作树噪声；不采用自动修复，因为会突破 run、分支与提交边界；不采用仓库身份推断，因为会误伤 fork 和迁移场景。

## 实施步骤

1. 扩展环境配置与生成链路。读取 `agent-build/schemas/environment-v1.json`、内置环境 YAML、`src/agent-build.ts`、`src/environment.ts`；写入环境 feature schema、默认值、provenance 和生成测试。完成条件：旧配置解析为关闭，显式开启可冻结到 run/dispatch 上下文。覆盖 REQ-001、REQ-008、AC-001、AC-012。
2. 定义报告、报告项目和来源关联契约。读取 `src/contracts.ts`、`src/constants.ts`、`src/state.ts`；写入严格 runtime schema、类型、SQLite 迁移和查询方法。完成条件：available、unavailable、空数组、terminal sequence 与 source report 均可持久化并兼容旧数据库。覆盖 REQ-003、REQ-006、REQ-008、AC-005、AC-008、AC-011、AC-012。
3. 实现 ai-team 证据采集与聚合。读取 `src/dispatch.ts`、冻结 result artifact、run events 和失败恢复测试；写入纯本地聚合器，识别 failure、validation failure、replacement、retry、requested support，按根因去重并生成修复建议。完成条件：目标项目一般缺陷被排除，重复根因保留 occurrences 和全部安全引用。覆盖 REQ-003、REQ-004、AC-003、AC-006、AC-011。
4. 接入 run 终态生命周期。读取 `src/workflow.ts`、`src/dispatch.ts`、`src/state.ts`；在 planning/coding 的 completed 或 blocked 状态转换处幂等写报告。完成条件：needs_decision 不触发；同一 terminal sequence 不重复；resume 后新终态追加；报告失败不改变源状态。覆盖 REQ-002、REQ-006、AC-002、AC-003、AC-004、AC-007、AC-008。
5. 增加终态展示与查询。读取 `src/cli.ts`、`src/command-contract.ts`；扩展 `run show` 和终态命令 JSON，显示 defects、optimizations、无发现或 unavailable。完成条件：禁用时输出兼容，启用时机器字段稳定且终端清单清晰。覆盖 REQ-005、AC-001、AC-002、AC-005、AC-011。
6. 实现非阻塞修复授权与独立 run。读取 decision、workflow、CLI 和 state 入口；增加 self-evolution fix decision 类型、幂等 receipt 消费和 source report 关联的新 run 创建。完成条件：只有 resolved confirm receipt 创建一个独立 run，源 run 状态和授权不变，拒绝、pending、重复消费均无副作用。覆盖 REQ-007、AC-009、AC-010。
7. 更新 planning/coding 生成指令和项目导航。读取 `agent-build/roles/planning.md`、`agent-build/roles/coding.md`、角色 YAML、`MEMORY.md`、`.ai-team/index/feature-navigation.md`；写入终态报告展示与修复 handoff 规则，并在职责或入口变化时使用 `ai-team context update` 与 `ai-team context validate` 同步导航。完成条件：生成的 Codex、Claude、OpenCode 代理都遵守同一报告边界。覆盖 REQ-004、REQ-005、REQ-007、AC-012。
8. 完成分层验证和发布门禁。扩展 `test/environment.test.ts`、`test/agent-build.test.ts`、`test/core.test.ts`、`test/workflow.test.ts`、`test/review-fixes.test.ts`、`test/cli-e2e.test.ts`；运行静态检查、针对性测试、全量测试、构建和 verify。完成条件：所有 AC 有自动化证据且默认关闭路径无回归。覆盖 REQ-001 至 REQ-008、AC-001 至 AC-012。

## 需求覆盖

| 需求/验收 ID | 实施位置 | 验证方式 | 责任角色 |
| --- | --- | --- | --- |
| REQ-001 | `agent-build/schemas/environment-v1.json`、`src/environment.ts`、`src/agent-build.ts` | 环境 schema 与默认关闭测试 | coding |
| REQ-002 | `src/workflow.ts`、`src/dispatch.ts`、`src/state.ts` | completed、blocked、needs_decision、resume 集成测试 | coding |
| REQ-003 | `src/contracts.ts`、`src/state.ts` | schema、迁移与空报告测试 | coding |
| REQ-004 | `src/dispatch.ts`、报告聚合模块 | 去重、重试和归因单元测试 | coding |
| REQ-005 | `src/cli.ts`、planning/coding 角色指令 | CLI E2E 与生成资产测试 | coding |
| REQ-006 | `src/dispatch.ts`、`src/state.ts` | 故障注入与终态隔离测试 | coding |
| REQ-007 | `src/cli.ts`、`src/workflow.ts`、`src/state.ts` | decision receipt 与独立 run E2E | coding |
| REQ-008 | 环境、契约、状态、CLI 与脱敏模块 | 旧配置、旧数据库、严格字段、敏感信息测试 | coding |
| AC-001 | 环境解析与所有终态入口 | `npm test -- --test-name-pattern=self-evolution-disabled` | test |
| AC-002 | completed 生命周期与 `run show` | completed 集成测试 | test |
| AC-003 | failed/retryable_failure 阻塞入口 | `test/review-fixes.test.ts` 扩展 | test |
| AC-004 | needs_decision 生命周期 | decision 集成测试 | test |
| AC-005 | 报告 schema 与 CLI | 空数组 schema/CLI 断言 | test |
| AC-006 | 报告聚合模块 | 重复事件 fixture 单元测试 | test |
| AC-007 | resume 生命周期 | 阻塞、resume、再终态集成测试 | test |
| AC-008 | 报告持久化错误路径 | 故障注入与状态断言 | test |
| AC-009 | fix decision 消费入口 | CLI E2E 新 run 关联断言 | test |
| AC-010 | fix decision 负向路径 | pending/reject/replay E2E | test |
| AC-011 | 脱敏模块和持久化 | secret fixture 与存储扫描 | test |
| AC-012 | 全仓门禁 | `npm run verify` | test |

## 验证

- 单元测试：环境默认值、报告 schema、事件归因、去重、脱敏、幂等 terminal sequence 和 decision replay。
- 集成测试：planning/coding completed、failed、retryable_failure、needs_decision、resume、报告故障隔离、独立修复 run。
- 静态检查：`npm run typecheck && npm run lint`。
- 构建或打包：`npm run build`。
- 手工验证：在临时开发环境显式启用开关，分别运行无发现完成、注入 retryable failure、恢复后完成三条流程；检查 `run show`、报告顺序和修复 decision。截图如需生成，必须保存到 packet 提供的 `.ai-team/plans/<plan-id>/screenshot/` 精确目录。
- 失败时的诊断和回滚：先关闭环境开关，检查 run events、报告 status、terminal sequence 和 source report ID；不得删除源 run 或历史报告。

## 发布与回滚

- 发布前门禁：环境 schema、状态迁移、冻结 contract、CLI E2E、旧配置兼容、敏感信息扫描和 `npm run verify` 全部通过。
- 发布顺序：兼容状态迁移与读取 -> 环境 schema 和冻结 provenance -> 报告聚合与终态 hook -> CLI 展示和修复 decision -> 开发环境显式 opt-in。
- 监控和观察窗口：至少覆盖一次 planning completed、一次 coding completed、一次 retryable blocked/resume；观察重复报告、终态漂移、敏感值和错误修复 run。
- 回滚条件：原 run 状态被改变、报告重复、敏感信息泄漏、未确认即创建修复 run或默认关闭失效。
- 回滚命令：先将 `features.selfEvolution.enabled` 设为 `false` 并重新生成受管 agents；随后回滚功能提交。数据库新增结构保留兼容读取，不执行破坏性降级。
