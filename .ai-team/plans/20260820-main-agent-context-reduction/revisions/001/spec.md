---
plan_id: 20260820-main-agent-context-reduction
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

## 背景

AI Team 是 Node.js 22+ TypeScript ESM CLI，使用 SQLite 工作流状态、managed staging 和不可变 planning revision。File Explorer artifact `artifact_dc5fd20f8db6e676fb0ece00` 证明：Planning/Coding 协调路径仍会接触过大的 bundle/历史上下文；完整 clarification ledger、`planning-writer` 和 `run advance` 尚不存在；Coding 仍使用 `actions: string[]`。用户已确认以最小权限角色和确定性 driver 降低主代理 token，同时保持现有证据、权限与 lineage。

## 目标

- [ ] 主代理只承担分析、调度、决策、异常处理和验收闭环。
- [ ] 全部疑点持续澄清并由结构化 ledger 与硬门禁保证。
- [ ] 新增受限 `planning-writer`、direct claim、compact projection/receipt 和 fresh continuation。
- [ ] 确定性推进无歧义步骤，并以基线指标验证降耗。

## 非目标

- 不新增宽权限 LLM workflow 总管、通用 summarizer 或持久 mega-child。
- 不允许 planning-writer 自行决策、探索未知路径、修改产品代码或操作 Git。
- 不破坏完整 CLI 兼容路径、immutable revision、artifact digest 或 dispatch provenance。

## 用户场景

### 场景 1：持续澄清

- 前置条件：Planning 已取得 File Explorer/Researcher 证据。
- 操作：记录和解决全部疑点与 typed decision。
- 预期结果：仅在 ledger/decision 均关闭且全部需求维度明确时进入文档。
- 异常结果：新疑点、revise、冲突或范围变化重新关闭门禁。

### 场景 2：受限文档执行

- 前置条件：requirements_final 已确认。
- 操作：planning-writer 读取冻结输入并生成、校验规划 staging。
- 预期结果：返回完整 REQ/AC/task/test oracle 映射、artifact digest 和 compact receipt。
- 异常结果：结构缺口返回 Planning，不自行补假设或创建 revision。

### 场景 3：紧凑协调与自动推进

- 前置条件：存在可执行 dispatch 或明确 next action。
- 操作：目标角色 direct claim，主代理读取 compact projection；driver 推进至 boundary。
- 预期结果：新 continuation 不携带主代理历史，且 state/digest/lineage 保持等价。
- 异常结果：人工决策、未知副作用、漂移或无进展立即停止。

## 功能需求

### REQ-001：结构化澄清 ledger

- 描述：持久化疑点 ID、来源、影响、状态、答案、decision 引用与 REQ/AC 映射，并提供 compact projection。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-002：Planning 澄清硬门禁

- 描述：所有疑点、decision 和需求维度明确后才允许 planning-writer、revision 和 Coding；新疑点或 revise 必须重关门禁。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-003：受限 planning-writer

- 描述：注册仅能读取冻结输入、生成 spec/plan/tasks、写 planning staging、校验和提交 compact receipt 的角色；禁止决策、revision、未知探索、产品代码和 Git。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-004：Direct claim 与 compact receipt

- 描述：目标角色直接领取完整 bundle，主代理只消费 dispatch/artifact 身份、digest、失败项、变更摘要和下一边界；完整路径保持兼容。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-005：Compact projection 与结构化协调摘要

- 描述：主代理默认 run projection 不含完整 events/timeline/schema/template/artifact，并将 Coding actions 收紧为 typed coordination summary。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-006：Fresh continuation

- 描述：从权威状态和 artifact 引用为每次 continuation 组装新同角色上下文，保留 Explorer/developer/worktree/commit/test/replacement provenance。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-007：确定性 run advance

- 描述：新增 run advance --until-boundary，仅推进无歧义 claim/staging/validate/submit/resume，在用户决策、占位符、未知副作用、漂移、未声明并行、无进展或步数上限停止。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-008：Token 与上下文基线

- 描述：按 role、dispatch、run 记录 token 或明确标注的 bytes 代理指标，比较主代理 P50/P95 与全体总量。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

### REQ-009：项目上下文维护

- 描述：确保 feature-navigation 存在；入口、职责或模块边界改变后使用 File Explorer project_context 执行 context update/validate。
- 输入：冻结 run/dispatch/decision/artifact 状态及授权数据。
- 输出：结构化、可验证且可恢复的受管状态或 compact receipt。
- 约束：保持现有 schema、ownership、lineage、幂等和角色权限边界。

## 验收标准

### AC-001：澄清 ledger 完整持久化

- Given：Planning 产生、解决、修改或取代疑点。
- When：写入 ledger 并查询 compact projection。
- Then：唯一 ID、来源、影响、状态、答案、decision 和 REQ/AC 映射均与权威状态一致。
- RED：先在 `test/dispatch/planning-lifecycle.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：唯一 ID、来源、影响、状态、答案、decision 和 REQ/AC 映射均与权威状态一致。
- 边界反例：requirements_final、task_split、task_preview 不占功能问题编号。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts`。

### AC-002：未关闭疑点硬阻断并可重关

- Given：存在 pending ledger/decision、未明确维度或新冲突。
- When：尝试进入文档、revision 或 Coding。
- Then：操作拒绝并返回具体 ID；全部 resolved 才放行，新疑点重新阻断。
- RED：先在 `test/dispatch/planning-lifecycle.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：操作拒绝并返回具体 ID；全部 resolved 才放行，新疑点重新阻断。
- 边界反例：仅 summary 声称确认而 receipt 未 resolved 时不得放行。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts`。

### AC-003：planning-writer 权限最小化

- Given：planning-writer 领取合法文档 dispatch。
- When：执行允许命令或尝试 decision/revision/产品/Git/未知探索。
- Then：允许的 staging/validate/submit 成功，所有越权请求拒绝且副作用为 0。
- RED：先在 `test/agent-build.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：允许的 staging/validate/submit 成功，所有越权请求拒绝且副作用为 0。
- 边界反例：不能借 Planning actor 身份绕过门禁。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/agent-build.test.ts test/dispatch/contracts.test.ts`。

### AC-004：主代理默认不读取完整 bundle

- Given：目标角色可执行 pending dispatch。
- When：目标角色 claim 且主代理读取回执。
- Then：目标角色取得 bundle，主代理输出不含 prompt/schema/template/full artifact。
- RED：先在 `test/cli/staging-dispatch.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：目标角色取得 bundle，主代理输出不含 prompt/schema/template/full artifact。
- 边界反例：compact 输出仍保留 artifact/dispatch ID、digest 与 lineage。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts`。

### AC-005：Compact projection 与 typed coordination

- Given：run 含完整 events/tasks/worktrees/findings/decisions。
- When：主代理请求 compact status 或 Coding payload。
- Then：仅返回核心状态、失败 ID、changed paths、digest 和 boundary，coordination schema 拒绝自由字符串。
- RED：先在 `test/dispatch/recovery-review.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：仅返回核心状态、失败 ID、changed paths、digest 和 boundary，coordination schema 拒绝自由字符串。
- 边界反例：诊断所需权威 ID 不得丢失。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/recovery-review.test.ts test/cli/planning.test.ts`。

### AC-006：Fresh continuation 保留 provenance

- Given：上游 dispatch 已提交 artifact。
- When：下一同角色代理领取 continuation。
- Then：packet 由 artifact 引用重建且不嵌入完整上游 result，lineage/provenance 完整。
- RED：先在 `test/dispatch/contracts.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：packet 由 artifact 引用重建且不嵌入完整上游 result，lineage/provenance 完整。
- 边界反例：repair、replacement 和 test provenance 不能丢失。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/contracts.test.ts test/dispatch/recovery-review.test.ts`。

### AC-007：run advance 只推进无歧义步骤

- Given：run recovery 存在 next action。
- When：执行 run advance --until-boundary。
- Then：仅机械动作执行，返回 executed actions、boundary 和 compact state，重复副作用为 0。
- RED：先在 `test/workflow.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：仅机械动作执行，返回 executed actions、boundary 和 compact state，重复副作用为 0。
- 边界反例：pending decision、unknown effect、占位符、漂移和未声明并行均停止。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/workflow.test.ts test/cli/planning.test.ts`。

### AC-008：降耗指标可测且达标

- Given：改造前后运行同一 fixtures。
- When：聚合 role/dispatch/run token 或 bytes。
- Then：主代理输入 P50 降低至少 60%、P95 至少 50%，全体 token 增长不超过 15%。
- RED：先在 `test/cli/project-runtime.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：主代理输入 P50 降低至少 60%、P95 至少 50%，全体 token 增长不超过 15%。
- 边界反例：bytes 不得标记为 token，也不得删除验证上下文伪造降耗。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/dispatch/contracts.test.ts test/cli/project-runtime.test.ts`。

### AC-009：兼容、幂等与 lineage 等价

- Given：同一 fixture 分别使用兼容和新路径。
- When：执行完整状态转换与重复请求。
- Then：state/event 语义、digest、lineage 等价，重复 submit/revision/越权为 0。
- RED：先在 `test/workflow.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：state/event 语义、digest、lineage 等价，重复 submit/revision/越权为 0。
- 边界反例：现有 dispatch claim --bundle JSON 契约保持可用。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm run verify`。

### AC-010：项目上下文保持有效

- Given：角色、命令和模块职责落地。
- When：使用 Explorer project_context 更新并 validate。
- Then：maintenance current、导航入口存在且职责一致。
- RED：先在 `test/context.test.ts` 增加能在旧实现失败的行为测试。
- 可观察结果：maintenance current、导航入口存在且职责一致。
- 边界反例：不得写 Explorer 未证明的入口。
- 测试层级：单元、合同/生命周期集成与相关 CLI smoke。
- 验证命令或证据：`npm test -- test/context.test.ts test/cli/project-runtime.test.ts && ai-team context validate`。

## 数据与接口

- clarification ledger：ID、run、sequence、stage、question、source、impact、decision、status、answer、REQ/AC 映射和时间戳。
- planning-writer：角色 manifest/environment/command/staging contract 与 compact result payload。
- compact claim/submit/run projection、typed Coding coordination、fresh continuation、run advance boundary receipt。
- metrics：run events 中的 token 或明确标注的 prompt/packet/result/context/continuation bytes、计数和 compact 标记。

## 兼容约束

- 现有行为必须保持：`dispatch claim --bundle`、artifact 查询、immutable revision、replacement/test/commit provenance、错误码和 managed staging。
- 迁移兼容窗口：SQLite 受管 migration 支持已有状态库；本版本继续保留完整输出路径。

## 安全约束

- 权限边界：Planning/Coding 不写产品代码；Git 仅由 Git Operator；planning-writer 仅写规划路径和指定 staging。
- 敏感数据处理：compact projection 不复制完整 artifact 内容，仅返回授权引用与 digest。
- 路径和输入校验：继续校验 role、dispatch、staging、plan/task ID、相对路径和 ownership。

## 错误与边界

- 非法输入：结构化拒绝且不推进 state。
- 空数据：无疑点返回空 ledger；无 next action 返回完成或明确 boundary。
- 超时或外部依赖失败：保留可恢复现场并返回 retry/reconcile。
- 重试和幂等：重复 claim 可复用；submit、revision 和有副作用动作不得重复。

## 迁移发布回滚

- 发布步骤：ledger/gate -> planning-writer -> compact/fresh continuation -> advance/metrics -> context。
- 迁移步骤：受管 SQLite migration；同步 agent-build manifest、schema、environment 和生成物。
- 回滚触发条件和操作：任一权限、fixture 等价或指标门禁失败即停止发布，由 Git Operator revert 实现提交，不修改历史 revision/artifact。

## 已确认偏好

- 正式角色名为 `planning-writer`。
- Planning 必须持续澄清全部疑点后才进入下一步。
- 机械推进使用确定性 driver，不新增宽权限 LLM 总管。
- `decision_01M0EF8X7TRHTGT2YPHBKD349S` 已 resolved choice=`confirm`。
- `decision_01M0EFRCHTZS4AC4CSQH7SNCFT` 已 resolved choice=`split`。
- `decision_01M0EFYEFN4RH3TSE757H7NV2F` 已 resolved choice=`approve`。

## 默认取舍

- 优先记录真实 token；不可得时记录并标注 bytes，不推算伪 token。
- 完整 CLI 保持兼容，主代理默认使用 compact 路径。
- planning-writer 不执行 revision create/transition。

## 已关闭问题

- 问题：角色名称。结论：planning-writer。证据：用户明确更名。
- 问题：澄清深度。结论：所有疑点关闭后才能推进。证据：用户明确要求。
- 问题：仓库事实。结论：采用 File Explorer artifact 与精确路径。
- 问题：完整需求与任务拆分。结论：requirements confirm、split、task preview approve receipts 已 resolved。

## 未决问题

- 无。
