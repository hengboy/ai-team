---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

## 任务清单

### TASK-001：自我进化基础契约与配置

- 需求覆盖：REQ-001、REQ-003、REQ-006、REQ-008
- 验收覆盖：AC-001、AC-005、AC-008、AC-011、AC-012
- 目标：建立默认关闭的环境开关、冻结 provenance、严格报告数据模型、terminal sequence、unavailable 状态和兼容 SQLite 持久化。
- 读取范围：环境 schema/YAML、`src/environment.ts`、`src/agent-build.ts`、`src/contracts.ts`、`src/constants.ts`、`src/state.ts` 及对应测试。
- 写入范围：环境配置与报告基础契约、状态迁移和单元测试。
- 允许写入路径：`agent-build/schemas/environment-v1.json`、`agent-build/environments/**`、`src/environment.ts`、`src/agent-build.ts`、`src/contracts.ts`、`src/constants.ts`、`src/state.ts`、`test/environment.test.ts`、`test/core.test.ts`。
- 依赖：无
- 实现步骤：
  1. 扩展环境 schema，并将缺失字段解析为 `false`。
  2. 将启用状态与配置来源冻结到 run/dispatch provenance。
  3. 定义 report、item、terminal sequence、available/unavailable 和 source report 类型及 runtime 校验。
  4. 增加兼容旧数据库的持久化、查询与幂等唯一约束。
  5. 覆盖旧配置、空报告、未知字段、迁移和脱敏基础测试。
- 验收标准：
  - 未启用时行为不变；显式启用状态可审计。
  - available 空报告与 unavailable 报告可区分。
  - 旧数据库和旧环境配置可读取。
- 自测命令：`npm run typecheck && node --import tsx --test test/environment.test.ts test/core.test.ts`
- 交接内容：环境 feature 读取接口、报告存储 API、迁移说明、schema 与测试证据。

### TASK-002：终态报告与独立修复完整链路

- 需求覆盖：REQ-002、REQ-003、REQ-004、REQ-005、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-002、AC-003、AC-004、AC-005、AC-006、AC-007、AC-008、AC-009、AC-010、AC-011、AC-012
- 目标：形成从 ai-team 证据聚合到 completed/blocked 报告、CLI 展示、开发者授权和独立修复 run 的端到端能力。
- 读取范围：TASK-001 交接、dispatch/workflow/CLI/decision 生命周期、角色生成资产、项目上下文和相关测试。
- 写入范围：报告聚合器、终态 hook、resume 追加、报告失败隔离、CLI、fix decision、新 run 来源关联、planning/coding 指令和导航。
- 允许写入路径：`src/self-evolution.ts`、`src/dispatch.ts`、`src/workflow.ts`、`src/cli.ts`、`src/command-contract.ts`、`src/state.ts`、planning/coding 角色文件、`MEMORY.md`、`.ai-team/index/feature-navigation.md` 及相关测试。
- 依赖：TASK-001
- 实现步骤：
  1. 聚合 failure、validation failure、replacement、retry 和 requested support，按根因去重并脱敏。
  2. 在 planning/coding completed 或 blocked 转换中按 terminal sequence 幂等写入报告。
  3. 保证 `needs_decision` 不触发、resume 后追加、报告失败不改变源终态。
  4. 扩展 `run show` 与终态输出，明确展示清单、无发现或 unavailable。
  5. 为非空报告创建非阻塞 fix decision，仅凭 resolved confirm receipt 创建来源关联的独立修复 run。
  6. 更新 planning/coding 受管指令；入口职责变化后执行 context update/validate。
- 验收标准：
  - completed、failed、retryable failure、resume 和空报告路径符合 AC。
  - decision pending/reject/replay 不创建修复 run，confirm 恰好创建一个独立 run。
  - 源 run 状态、side effect、授权和恢复语义不被报告逻辑改变。
- 自测命令：`node --import tsx --test test/workflow.test.ts test/review-fixes.test.ts test/cli-e2e.test.ts test/agent-build.test.ts`
- 交接内容：终态事件与报告证据、CLI 示例、decision receipt、新 run 关联、context validate 结果。

### TASK-003：综合回归验证与发布门禁

- 需求覆盖：REQ-001、REQ-002、REQ-003、REQ-004、REQ-005、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-001、AC-002、AC-003、AC-004、AC-005、AC-006、AC-007、AC-008、AC-009、AC-010、AC-011、AC-012
- 目标：集中验证跨模块行为、失败隔离、兼容性和发布门禁，并形成可交接证据。
- 读取范围：TASK-001/TASK-002 交接、全部相关测试与生成资产。
- 写入范围：仅 `test/**`；产品代码缺陷回交对应前置任务。
- 允许写入路径：`test/**`。
- 依赖：TASK-001、TASK-002
- 实现步骤：
  1. 补齐默认关闭、completed、blocked、needs_decision、resume 和重复 terminal sequence 场景。
  2. 增加报告持久化失败、敏感值、旧配置/数据库和 decision replay 负向测试。
  3. 验证 Codex、Claude、OpenCode 生成资产一致性和项目上下文。
  4. 依次运行 typecheck、lint、针对性测试、全量测试、build 和 verify。
- 验收标准：
  - AC-001 至 AC-012 都有自动化或明确手工证据。
  - 无默认行为回归、敏感信息泄漏、重复报告或未授权修复 run。
- 自测命令：`npm run typecheck && npm run lint && npm test && npm run build && npm run verify`
- 交接内容：完整命令结果、失败诊断、残余风险、发布与回滚建议。

## 依赖关系

```text
TASK-001 -> TASK-002 -> TASK-003
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 1 | TASK-001 | 环境、基础契约和状态存储 |
| 2 | TASK-002 | 终态链路、CLI、角色指令和导航 |
| 3 | TASK-003 | `test/**` |

## 风险与阻塞

- 风险：TASK-002 写入范围较广。影响：生命周期、CLI 与状态交叉回归。缓解：以 TASK-001 的稳定契约为前置，并由 TASK-003 集中故障注入和 E2E 验证。
- 风险：报告逻辑本身可能制造阻塞。影响：掩盖源 run 终态。缓解：unavailable 降级、无网络依赖、幂等 terminal sequence 和故障注入测试。
- 阻塞：任何敏感信息泄漏、源终态漂移或未确认创建修复 run 都必须停止发布并回交 TASK-002。
