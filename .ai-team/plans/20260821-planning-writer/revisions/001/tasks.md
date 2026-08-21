---
plan_id: 20260821-planning-writer
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

<!--
结构与填写规则：
1. H1 固定为“任务拆分”；H2 使用下列固定章节并保持顺序，不得改名、合并或删除。
2. 每个任务使用 H3，格式为“TASK-xxx：标题”；任务 Markdown 不记录或回写执行状态。
3. 任务按依赖顺序编号；依赖未完成或出现阻塞时，不得开始后续任务。
4. 每个任务只能写入“允许写入路径”，不得扩大范围或顺手修改无关文件。
5. 依赖关系、并行批次和各任务的前置任务、写入范围必须一致。
6. revision 冻结后不得修改任务文档；完成状态以 AI Team 运行状态和审计证据为准。
-->

## 任务清单

### TASK-001：新增 planning-writer 角色与 planning 委派交接

- 目标：实现第 13 个 planning-writer 角色、专用 result payload、最小 execution contract、planning 两阶段委派门禁，以及 writer-owned planning staging 的可审计单次交接。
- 需求覆盖：REQ-001、REQ-002、REQ-003、REQ-004
- 验收覆盖：AC-001、AC-002、AC-003、AC-004
- 前置任务：无
- 输入与已确认依据：spec.md 与 plan.md；decision_01M0HZBMQ6RZYRV0WTXGWDTSQS；File Explorer artifacts 8a9946300cfa279782db0fc40668f946fc0a8d51c13d1f0ea1dd92422ff3a649、b430eeda7577194d3ab21f76d3208fb559212aca5a7272c8b559d9d010855637。
- 读取范围：src/constants.ts、src/agent-build.ts、src/roles.ts、src/contracts.ts、src/execution-contract.ts、src/dispatch/planning.ts、src/dispatch/planning-lifecycle.ts、src/dispatch/packet.ts、src/dispatch/submission-lifecycle.ts、src/staging.ts、src/commands/planning-run.ts、agent-build manifest/schema/roles 与对应 tests。
- 写入范围：角色常量、manifest/schema、planning/planning-writer 角色资产、result/execution/dispatch/staging/planning CLI 实现及对应测试。
- 允许写入路径：src/constants.ts；src/agent-build.ts；src/roles.ts；src/contracts.ts；src/execution-contract.ts；src/dispatch/planning.ts；src/dispatch/planning-lifecycle.ts；src/dispatch/packet.ts；src/dispatch/submission-lifecycle.ts；src/staging.ts；src/commands/planning-run.ts；agent-build/manifest.yaml；agent-build/schemas/manifest-v1.json；agent-build/schemas/role-v1.json；agent-build/roles/planning.yaml；agent-build/roles/planning-writer.yaml；agent-build/roles/planning-writer.md；test/agent-build.test.ts；test/dispatch/contracts.test.ts；test/dispatch/planning-lifecycle.test.ts；test/cli/staging-dispatch.test.ts；test/cli/planning.test.ts。
- 禁止写入路径：未列入允许范围的产品文件；agent-build/environments/**；src/environment.ts；README.md；MEMORY.md；.ai-team/index/**；用户目录；Git 元数据。
- 实施步骤（按顺序）：
  1. 添加角色存在性、专用 payload、owned staging、空 delegates、越权拒绝、两阶段委派和 writer staging handoff 的 RED 测试。
  2. 运行自测命令，确认因 planning-writer 缺失、planning 只继续自身角色、planning loader 不接受 writer staging 而失败。
  3. 同步修改 Role、manifest/schema、角色 YAML/Markdown、ROLE_PAYLOAD_SCHEMAS 和生成器；planning delegates 增加 writer，writer 不获得 decision/revision/Git/test/discovery/仓库写权限。
  4. 扩展 planning packet/lifecycle 与 staging consumer，绑定 source planning dispatch、frozen input digest、document kind、staging ID/digest，并拒绝不匹配或重复消费。
  5. 运行 GREEN 命令；只整理本任务引入的角色列表或校验重复，不修改环境和文档范围。
- 完成条件：
  - 覆盖的 REQ/AC 均已实现。
  - 自测命令全部通过并记录证据。
  - 交接内容完整，且没有未解决阻塞。
- 验收证据：
  - AC-001：node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts；预期 13 角色资产和 payload 完整通过。
  - AC-002：node --import tsx --test test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts；预期越权拒绝且合法 staging 成功。
  - AC-003：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts；预期仅确认门禁后委派。
  - AC-004：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts test/cli/planning.test.ts；预期来源/digest 校验与单次消费通过。
- 自测命令：node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts test/dispatch/planning-lifecycle.test.ts test/cli/staging-dispatch.test.ts test/cli/planning.test.ts
- 失败与阻塞处理：停止任务，保留失败测试、staging 和状态证据；不得放宽 writer 权限或绕过 digest/actor 门禁；请求规划支持后再继续。
- 交接内容：角色和 lifecycle 变更摘要、修改路径、RED/GREEN 输出、contract/manifest digest 变化、TASK-002 所需的 13 角色/environment schema 输入和剩余风险。

### TASK-002：切换用户环境来源并迁移全部配置

- 目标：以完整 default seed 替换仓库三份旧环境源，让 runtime 只使用用户目录，并以全量预检、备份、原子写入和幂等规则迁移全部用户环境的 planning-writer 配置。
- 需求覆盖：REQ-005、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-005、AC-006、AC-007、AC-008
- 前置任务：TASK-001
- 输入与已确认依据：TASK-001 的 13 角色/schema/生成器；decision_01M0HZGYRA1GVXMF6BZ9QSF0FV、decision_01M0HZRA8ABG9FPVM1WC8SKB8W、decision_01M0HZTC7MGA03BY1YJF5XG74N、decision_01M0HZWMJ0FAF3YGY1SET32W1W、decision_01M0HZY6GJ5YC55T7NRG8DPBMC、decision_01M0J031J7ZJEDJXR7WE859Y04。
- 读取范围：agent-build/environments、environment schema、src/agent-build.ts、src/environment.ts、src/home.ts、src/commands/environment.ts、src/cli.ts、环境/runtime/version gate tests、scripts/verify-packed-install.ts、package.json。
- 写入范围：环境 schema/seeds、environment/home/CLI 服务、环境与 packed-install 测试及打包配置。
- 允许写入路径：agent-build/schemas/environment-v1.json；agent-build/environments/balanced.yaml；agent-build/environments/quality.yaml；agent-build/environments/economy.yaml；agent-build/environments/default.yaml；src/agent-build.ts；src/environment.ts；src/home.ts；src/commands/environment.ts；src/cli.ts；test/agent-build.test.ts；test/environment.test.ts；test/cli/project-runtime.test.ts；test/tasks-and-version-gates.test.ts；test/gates-and-planning-commit.test.ts；scripts/verify-packed-install.ts；package.json。
- 禁止写入路径：TASK-001 独占的 planning/dispatch/staging 文件；README.md；MEMORY.md；.ai-team/index/**；真实用户环境目录在测试通过前禁止写入；Git 元数据。
- 实施步骤（按顺序）：
  1. 添加模型映射、default seed/包内容、首次 seed/no-overwrite、home-only provenance、缺失失败、legacy 保留、全量迁移预检、备份、幂等与 no-partial-write RED 测试。
  2. 运行自测命令，确认当前因缺 default、旧 bundled source、active balanced、无 writer override 和无迁移逻辑而失败。
  3. 新增 balanced 基线 default.yaml，配置 Codex gpt-5.6-terra/high、OpenCode roufemad/gpt-5.6-terra/high、Claude default inheritance；删除三份仓库旧 seed。
  4. 分离 package seed 与 runtime discovery；显式 install/bootstrap 只在缺失时复制 default，普通 list/load/resolve 只读取用户目录并明确报告缺失/空/未知环境。
  5. 实现迁移：读取并校验全部用户 YAML，创建受管备份，全量预检通过后只收敛 writer 配置；保留其他内容与文件名，失败不写，重复执行无差异。
  6. 在隔离 AI_TEAM_HOME 运行 GREEN、build 和 packed-install；禁止用未验证实现直接迁移真实用户环境。
- 完成条件：
  - 覆盖的 REQ/AC 均已实现。
  - 自测命令全部通过并记录证据。
  - 交接内容完整，且没有未解决阻塞。
- 验收证据：
  - AC-005：node --import tsx --test test/agent-build.test.ts test/environment.test.ts；预期三平台 resolved model/provenance 正确。
  - AC-006：npm run build && node --import tsx scripts/verify-packed-install.ts；预期包只含完整 default seed 并生成 13 角色。
  - AC-007：node --import tsx --test test/environment.test.ts test/cli/project-runtime.test.ts；预期 seed-once/no-overwrite/home-only 与缺失错误通过。
  - AC-008：node --import tsx --test test/environment.test.ts test/cli/project-runtime.test.ts test/tasks-and-version-gates.test.ts test/gates-and-planning-commit.test.ts；预期迁移保留、幂等和原子失败通过。
- 自测命令：node --import tsx --test test/agent-build.test.ts test/environment.test.ts test/cli/project-runtime.test.ts test/tasks-and-version-gates.test.ts test/gates-and-planning-commit.test.ts && npm run build && node --import tsx scripts/verify-packed-install.ts
- 失败与阻塞处理：停止任务，保留隔离 home、备份和首个失败证据；任一非法环境或非 writer 差异都禁止后续真实环境迁移；请求规划或 Environment Operator 支持。
- 交接内容：default seed 与 source cutover 摘要、删除/新增路径、隔离迁移差异、RED/GREEN/packed-install 输出、备份/回滚说明和 TASK-003 的发布前输入。

### TASK-003：更新文档上下文并完成发布门禁

- 目标：更新用户文档和规范项目上下文，执行全方案验证，并在全部门禁通过后交接 Environment Operator 备份和同步真实用户环境。
- 需求覆盖：REQ-009
- 验收覆盖：AC-009
- 前置任务：TASK-001、TASK-002
- 输入与已确认依据：TASK-001 和 TASK-002 完整交接、所有目标 GREEN 证据、File Explorer project_context、spec.md 与 plan.md 的发布/回滚约束。
- 读取范围：README.md、MEMORY.md、.ai-team/index/feature-navigation.md、package.json、scripts/verify-packed-install.ts、TASK-001/TASK-002 所有变更和验证结果。
- 写入范围：README.md、MEMORY.md、.ai-team/index/feature-navigation.md；真实用户目录只由独立 Environment Operator action 通过发布版本写入。
- 允许写入路径：README.md；MEMORY.md；.ai-team/index/feature-navigation.md。
- 禁止写入路径：所有产品代码、schema、tests、package/pack 脚本、任务文档、真实用户目录和 Git 元数据；验证失败必须返回责任任务修复，不得在本任务顺手改代码。
- 实施步骤（按顺序）：
  1. 更新 README 的 planning-writer、default seed、用户目录 source of truth、模型、缺失错误、迁移和回滚说明。
  2. 使用 ai-team context update 同步 planning-writer 与 seed-only environment 的入口、职责和模块边界，再运行 ai-team context validate --project .。
  3. 依次运行 typecheck、lint、全部测试、build、packed-install 和 context validate；任一失败停止并返回责任任务。
  4. 在隔离 home 执行发布版本 ai-team install --dry-run --platform codex,claude,opencode，核对差异仅为 writer、default seed 和预期生成资产。
  5. 全部门禁通过后，请求 Environment Operator 备份并执行发布版本 install，同步真实 ~/.config/ai-team/environments；记录 managed paths、receipt、模型 explain 和回滚证据。
- 完成条件：
  - 覆盖的 REQ/AC 均已实现。
  - 自测命令全部通过并记录证据。
  - 交接内容完整，且没有未解决阻塞。
- 验收证据：
  - AC-009：npm run typecheck && npm run lint && npm test && npm run build && node --import tsx scripts/verify-packed-install.ts && ai-team context validate --project .；预期全部退出 0，文档/上下文与实现一致。
- 自测命令：npm run typecheck && npm run lint && npm test && npm run build && node --import tsx scripts/verify-packed-install.ts && ai-team context validate --project .
- 失败与阻塞处理：停止任务并保留首个失败命令；代码/测试失败退回 TASK-001 或 TASK-002；真实环境迁移失败由 Environment Operator 恢复备份，旧版本运行前确认环境 schema 兼容。
- 交接内容：文档与上下文摘要、完整验证记录、packed package、Environment Operator receipt、真实环境差异、剩余风险及 Git Operator 所需提交边界。

## 依赖关系

TASK-001 -> TASK-002 -> TASK-003

- 箭头表示前者完成后才能开始后者；TASK-003 同时要求 TASK-001 和 TASK-002 的最终 GREEN 证据。

## 并行批次

| 批次 | 前置批次 | 任务 | 不重叠写入范围 | 开始条件 |
| --- | --- | --- | --- | --- |
| 1 | 无 | TASK-001 | 角色、contracts、planning/dispatch/staging 与对应 tests | 冻结 revision 可读，写入范围无用户改动 |
| 2 | 1 | TASK-002 | environment/home/install、seeds、环境 tests 与 package gate | TASK-001 角色/schema/payload/lifecycle 全部 GREEN |
| 3 | 1、2 | TASK-003 | README.md、MEMORY.md、feature-navigation.md | 前两任务无阻塞且完整验证输入齐备 |

- 同一批次只允许放置无依赖且写入范围不重叠的任务；本方案三个任务均有明确依赖，故不并行实施。

## 风险与阻塞

- 风险：角色集合变化使 manifest/contract/environment digest 更新；影响：旧 frozen dispatch 不兼容；触发信号：旧 packet 被尝试复用；缓解措施：只创建新 dispatch，保留旧资产审计。
- 风险：用户环境迁移可能影响本地配置；影响：旧版本无法解析 writer 键或用户内容丢失；触发信号：非 writer 差异、部分写入或 validate 失败；缓解措施：隔离测试、全量预检、备份、原子写入、幂等和旧版本前恢复。
- 风险：TASK-001 与 TASK-002 共享 src/agent-build.ts 和 test/agent-build.test.ts；影响：并行修改冲突；触发信号：前置任务未完成；缓解措施：严格串行，TASK-002 基于 TASK-001 交接继续修改。
- 阻塞：任一 RED 无法定义可信失败、GREEN 失败、context validate 失败或 Environment Operator 无法提供受管 receipt；受影响任务：当前及后续任务；需要的决策或支持：planning、Test 或 Environment Operator；恢复条件：失败原因修正并重跑原命令通过。
