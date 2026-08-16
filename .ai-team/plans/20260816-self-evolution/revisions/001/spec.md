---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

## 背景

ai-team 当前以严格冻结的 dispatch 结果契约和 SQLite run 状态驱动 planning/coding 工作流。现有完成结果会推进生命周期，`failed` 与 `retryable_failure` 会使 run 阻塞，但系统没有开发者专用的自我进化开关，也没有按 run 汇总 ai-team 自身缺陷与优化项的结构化报告。用户确认该能力主要用于发现并修复使用 ai-team 时遇到的阻塞、错误和反复重试问题。

## 目标

- [ ] 在开发者显式启用后，为 planning/coding run 的完成或阻塞终态生成可审计的自我进化报告。
- [ ] 报告只描述 ai-team 自身的工作流缺陷、错误、反复重试和流程优化机会，并提供可执行修复建议。
- [ ] 报告存在可执行项时，经开发者确认后可启动边界独立的修复 run。

## 非目标

- 不报告目标项目自身的一般业务或代码缺陷。
- 不在原 run 内自动修改 ai-team，不自动创建提交或自动启动修复 run。
- 不为每个 dispatch 单独输出报告，不生成持续进入仓库的 Markdown 报告文件。
- 不改变未显式启用功能时的 planning/coding 行为。

## 用户场景

### 场景 1：正常完成后复盘

- 前置条件：当前环境显式启用自我进化报告，planning/coding run 正常执行。
- 操作：run 进入 `completed`。
- 预期结果：系统持久化并展示一份结构化报告；有可执行项时请求开发者确认是否启动独立修复 run。
- 异常结果：报告生成失败时保留原完成状态，并记录报告不可用原因。

### 场景 2：阻塞停止后复盘

- 前置条件：功能已启用，run 因 `failed` 或 `retryable_failure` 进入阻塞。
- 操作：系统处理阻塞终态。
- 预期结果：报告列出 ai-team 错误、阻塞、重试次数和相关 dispatch/event 证据。
- 异常结果：不得因报告失败覆盖原失败分类、side effect 状态或恢复能力。

### 场景 3：没有发现问题

- 前置条件：功能已启用，run 到达终态且没有可归因于 ai-team 的问题。
- 操作：系统生成报告。
- 预期结果：持久化 `defects: []` 与 `optimizations: []`，终态输出明确显示无发现，不创建修复决策。
- 异常结果：空清单不得被解释为报告缺失。

### 场景 4：开发者授权修复

- 前置条件：终态报告包含至少一个缺陷或优化项。
- 操作：开发者对修复提示作出确认或拒绝。
- 预期结果：确认后以报告为输入启动独立修复 run；拒绝时不产生新 run。
- 异常结果：任何未 resolved、无效或重复 receipt 均不得启动修复。

## 功能需求

### REQ-001：环境级显式启用

- 描述：环境配置增加自我进化功能开关，作为开发者使用意图的可审计来源。
- 输入：环境配置中的 `features.selfEvolution.enabled` 布尔值。
- 输出：冻结到 run/dispatch 上下文的启用状态及来源信息。
- 约束：字段缺失时默认为 `false`；所有现有内置环境默认关闭；不得通过仓库路径或包名自动推断。

### REQ-002：run 级终态触发

- 描述：只在整个 planning/coding run 正常完成或进入阻塞停止时触发一次报告生成。
- 输入：run profile、生命周期状态、终态 dispatch 结果和事件流。
- 输出：与 run 及终态序号关联的报告记录。
- 约束：临时 `needs_decision` 不视为终态；阻塞后恢复并再次完成或阻塞时追加新报告，不覆盖历史记录。

### REQ-003：结构化报告模型

- 描述：每份报告包含 `defects` 与 `optimizations` 两个数组。
- 输入：dispatch 结果、失败分类、requested support、验证失败、替换 dispatch 和重试事件。
- 输出：报告状态、触发状态、创建时间及结构化项目列表。
- 约束：每项至少包含稳定 ID、标题、证据引用、影响和修复建议；无发现时两个数组必须存在且为空。

### REQ-004：ai-team 缺陷识别与证据聚合

- 描述：聚合 ai-team 自身造成的阻塞、错误、反复重试和流程低效，不混入目标项目的一般缺陷。
- 输入：run events、dispatch artifacts、`failure_class`、`side_effect_state`、重试和 staging 校验记录。
- 输出：去重后的缺陷与优化项及其 run/dispatch/event 证据。
- 约束：相同原因的重复事件应合并并保留次数；无法确定归因时标记为待确认，不伪装为事实。

### REQ-005：持久化与终态展示

- 描述：报告持久化在 ai-team 状态存储中，并通过 run 终态输出和 `run show` 展示。
- 输入：已生成的结构化报告。
- 输出：机器可读报告及面向开发者的缺陷、优化项清单。
- 约束：禁用时不得增加报告、额外提示或后续决策；空报告明确显示无发现。

### REQ-006：报告失败隔离

- 描述：报告生成属于附加诊断，不得改变或掩盖原 run 的终态。
- 输入：报告生成或持久化错误。
- 输出：`unavailable` 报告状态及脱敏原因，同时保留原终态。
- 约束：保留原失败分类、side effect 状态和 resume 语义；不得通过无限重试报告生成制造新阻塞。

### REQ-007：显式授权的独立修复 run

- 描述：报告含可执行项时创建非阻塞 typed decision，询问开发者是否启动独立修复 run。
- 输入：报告 ID、报告项和 resolved receipt。
- 输出：确认时创建以报告为请求来源的新修复 run；拒绝或无报告项时不创建。
- 约束：源 run 保持原终态；每次启动都需要独立 receipt；不得自动或递归启动，不得复用源 run 的写入、分支或提交授权。

### REQ-008：兼容与安全

- 描述：扩展环境、结果、状态和 CLI 契约时保持默认兼容，并对报告证据脱敏。
- 输入：旧环境配置、旧 run 数据、错误消息和用户输入。
- 输出：兼容读取结果和不含敏感值的报告。
- 约束：未知严格字段仍被拒绝；旧配置按关闭处理；不得持久化密钥、凭据、token、完整敏感输入或未授权源码内容。

## 验收标准

### AC-001：关闭状态保持现状

- Given：环境未配置开关或值为 `false`。
- When：planning/coding run 完成或阻塞。
- Then：不创建自我进化报告、修复决策或额外 run，原输出和状态转换保持兼容。
- 验证命令或证据：`npm test -- --test-name-pattern=self-evolution-disabled`

### AC-002：完成终态生成报告

- Given：开关为 `true` 且 planning/coding run 可正常完成。
- When：run 进入 `completed`。
- Then：恰好新增一份关联 run 与终态序号的结构化报告，并能由 `run show` 读取。
- 验证命令或证据：生命周期集成测试断言报告数量、trigger status 和 run ID。

### AC-003：阻塞终态生成报告

- Given：开关为 `true`。
- When：dispatch 返回 `failed` 或 `retryable_failure` 并使 run 阻塞。
- Then：报告保留 failure class、side effect state、dispatch/event 引用和重试证据，原 run 仍为阻塞。
- 验证命令或证据：`test/review-fixes.test.ts` 的失败与恢复场景扩展测试。

### AC-004：等待决策不触发

- Given：开关为 `true` 且 run 暂停等待 typed decision。
- When：状态为 `needs_decision`，尚未到完成或阻塞终态。
- Then：不生成终态报告。
- 验证命令或证据：decision 生命周期测试断言报告记录为零。

### AC-005：空报告可区分于缺失

- Given：开关为 `true` 且没有发现 ai-team 问题。
- When：run 到达终态。
- Then：报告状态为 available，`defects` 和 `optimizations` 均为空数组，输出显示无发现。
- 验证命令或证据：schema 单元测试与 CLI snapshot/JSON 断言。

### AC-006：报告项目完整且去重

- Given：同一根因产生多次校验失败、replacement 或 retry 事件。
- When：系统聚合报告。
- Then：生成一个项目，包含稳定 ID、标题、影响、建议、全部证据引用及发生次数。
- 验证命令或证据：聚合器单元测试使用重复事件 fixture。

### AC-007：恢复后追加报告

- Given：run 已因 retryable failure 产生一份阻塞报告并成功 resume。
- When：run 后续再次完成或阻塞。
- Then：追加新的终态报告，旧报告保持不可变且终态序号不同。
- 验证命令或证据：resume 集成测试断言两份报告及顺序。

### AC-008：报告失败不改变原终态

- Given：终态报告生成或持久化被注入失败。
- When：run 完成或阻塞。
- Then：原终态、failure class、side effect 和 resume 行为不变，并存在 unavailable 记录及脱敏原因。
- 验证命令或证据：故障注入测试断言原子边界与无无限重试。

### AC-009：确认后启动独立修复 run

- Given：报告至少包含一个项目，修复 decision 已 resolved 且 choice 为确认。
- When：系统消费 receipt。
- Then：创建一个来源关联该报告的新修复 run，源 run 状态和授权不变。
- 验证命令或证据：CLI E2E 测试断言 source report、独立 run ID 和初始 dispatch。

### AC-010：未确认时不修复

- Given：报告为空，或 decision pending、拒绝、无效、重复消费。
- When：系统处理后续动作。
- Then：不创建修复 run，不发生 Git mutation 或产品代码写入。
- 验证命令或证据：负向 E2E 测试与 run 数量断言。

### AC-011：敏感信息脱敏

- Given：错误、输入或工具输出包含 token、凭据或敏感值。
- When：系统生成和展示报告。
- Then：报告只保留必要的类型、摘要和安全引用，不含原始敏感值。
- 验证命令或证据：脱敏单元测试与持久化内容扫描。

### AC-012：契约与回归门禁通过

- Given：实现完成。
- When：运行静态检查、构建和全量验证。
- Then：环境 schema、冻结结果契约、CLI、生命周期和旧配置测试全部通过。
- 验证命令或证据：`npm run typecheck && npm run lint && npm test && npm run build && npm run verify`

## 数据与接口

- 环境字段：`features.selfEvolution.enabled: boolean`，缺失等价于 `false`，解析结果需进入环境 provenance 和冻结 run 上下文。
- 报告结构：`reportId`、`runId`、`terminalSequence`、`triggerStatus`、`status`、`createdAt`、`defects[]`、`optimizations[]`、可选 `unavailableReason`。
- 报告项目：`itemId`、`title`、`evidence[]`、`occurrences`、`impact`、`suggestedFix`；证据引用使用 run/dispatch/event/artifact 标识和脱敏摘要。
- CLI：`run show` 返回报告列表；run 终态命令结果返回最新报告摘要及可选非阻塞修复 decision。
- 修复来源：新 run 保存 source report ID，不继承源 run 的写权限、分支授权或提交许可。

## 兼容约束

- 现有行为必须保持：旧环境配置、现有内置环境和未启用 run 不生成报告；严格 schema 对未知字段继续拒绝；现有 completed/blocked/resume 状态语义不变。
- 迁移兼容窗口：状态存储迁移必须兼容既有数据库与无报告历史 run；读取旧 run 时返回空报告集合，而不是迁移失败。

## 安全约束

- 权限边界：报告和修复 decision 不授予代码写入或 Git mutation；独立修复 run 重新建立角色、路径和提交边界。
- 敏感数据处理：报告生成前统一脱敏，不持久化密钥、token、凭据、环境变量值或完整敏感输入。
- 路径和输入校验：证据只引用已存在的受管 artifact/event 标识；source report ID 和 decision receipt 按既有 opaque ID 契约校验。

## 错误与边界

- 非法输入：非布尔环境开关、未知报告字段、无效 report ID 或 decision choice 必须被拒绝且不产生副作用。
- 空数据：无发现时持久化 available 空数组；无报告历史 run 返回空集合。
- 超时或外部依赖失败：报告生成不得依赖网络；本地生成失败写 unavailable 记录并保留原终态。
- 重试和幂等：同一 run terminal sequence 只能生成一份报告；重复 receipt 不得创建多个修复 run；恢复后的新终态使用新 sequence。

## 迁移发布回滚

- 发布步骤：先发布兼容读取与状态迁移，再启用环境 schema、报告生成和 CLI 展示，最后在开发环境显式开启。
- 迁移步骤：新增报告持久化结构和 source report 关联；旧记录无需回填。
- 回滚触发条件和操作：出现终态回归、敏感信息泄漏或重复修复 run 时立即将开关关闭；回滚生成与展示代码，保留新增数据供兼容读取，不破坏既有 run。

## 已确认偏好

- 用户已明确决定：采用 `environment_flag`、`run_terminal`、`structured_run_report`、`report_and_offer_fix`、`explicit_opt_in`。
- 用户已明确决定：自我进化主要针对 ai-team 使用过程中的阻塞、错误和反复重试问题进行修复。

## 默认取舍

- `needs_decision` 视为可恢复等待而非完成或阻塞终态。
- 报告失败使用 unavailable 记录，不反向阻塞或改变源 run。
- 阻塞 run 恢复后再次到达终态时追加报告，不覆盖历史。
- 空报告不创建修复 decision；所有修复启动均需新的开发者 receipt。
- 所有内置环境默认关闭，避免普通用户行为变化。

## 已关闭问题

- 问题：开发者专用如何启用。结论：环境级功能开关，默认关闭并显式 opt-in。证据：`decision_01M04TMC12A2C7BDGFJA9PZTS1`、`decision_01M04VPSHKR46Z9T22W47H5ERY`。
- 问题：报告触发边界。结论：整个 planning/coding run 完成或阻塞时。证据：`decision_01M04V9R6NFD83RXPYFEDY20QD`。
- 问题：报告形式。结论：结构化持久 run 报告并展示。证据：`decision_01M04VH65N9VPBK069ZYE1PXWJ`。
- 问题：如何进入修复。结论：报告后请求开发者确认，再启动独立修复 run。证据：`decision_01M04VM858AA2D5V8FAAV8CP59`。
- 问题：完整需求是否确认。结论：确认。证据：`decision_01M04VR6YDJDMM0QZ466DEHPTD`。

## 未决问题

- 无。
