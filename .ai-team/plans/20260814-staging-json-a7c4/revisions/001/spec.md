---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

## 背景

当前项目是 Node.js 22+ TypeScript ESM CLI，使用 SQLite/Umzug 保存工作流状态，并从统一命令契约与角色清单生成 Codex、Claude、OpenCode 三平台代理。现有 JSON 消费入口直接读取代理提供的外部文件路径，缺少由 AI Team 独占、可绑定 run/dispatch/role/kind、可审计且不泄露原文的临时 JSON 生命周期。用户已冻结本方案，要求在保持旧文件参数兼容的前提下引入受管 staging，并先发布兼容 CLI，再更新生成代理。

## 目标

- [ ] 提供位于 `${AI_TEAM_HOME:-~/.config/ai-team}/state/staging` 的受管 JSON 创建、写入、查看、消费和清理生命周期。
- [ ] 让全部 10 类 JSON 消费命令支持安全的 `--staging-id`，并保持旧文件参数兼容。
- [ ] 将 staging 元数据、状态和脱敏审计纳入现有 SQLite 前向迁移，不提升 `STATE_SCHEMA_EPOCH`。
- [ ] 更新角色权限和三平台生成资产，使代理只能经 CLI 操作 staging。
- [ ] 以安全、生命周期、兼容、持久化、脱敏和真实平台流程测试完成发布门禁。

## 非目标

- 不扫描、迁移或删除旧 `TMPDIR`、OpenCode 或其他历史临时 JSON 文件。
- 不移除或改变旧文件参数的成功行为，仅增加与 `--staging-id` 的互斥校验。
- 不把 JSON 原文写入 SQLite 元数据、run event、operation 或其他审计记录。
- 不扩大项目目录、`TMPDIR` 或 `AI_TEAM_HOME` 的代理直接写入权限。
- 不提升 `STATE_SCHEMA_EPOCH`，不借此触发状态库重建。

## 用户场景

### 场景 1：代理创建并提交受管 JSON

- 前置条件：代理拥有当前角色允许的 staging 命令和一个有效 run；需要 dispatch 绑定的 kind 时还拥有有效 dispatch。
- 操作：调用 `staging create`，经 `staging write` 写入合法 JSON，再以 `--staging-id` 调用业务命令。
- 预期结果：CLI 校验所有绑定和文件安全属性；业务持久化成功后条目变为 `consumed` 并删除内容文件。
- 异常结果：绑定、kind、大小、JSON 或文件属性不合法时拒绝业务操作且不消费；业务失败时条目继续保留。

### 场景 2：校验或预览但不消费

- 前置条件：staging 条目为可读的 `draft` 或 `ready` 状态。
- 操作：以 `--staging-id` 执行 dispatch validate 或 planning tasks `--preview` 等只校验操作。
- 预期结果：返回校验结果，条目状态和内容保持可重试。
- 异常结果：过期、已消费或绑定不匹配时拒绝读取，不改变业务状态。

### 场景 3：重写、过期和清理

- 前置条件：条目属于调用者允许的 run/dispatch/role/kind 边界。
- 操作：重写 `draft`/`ready` 条目，或执行自动/显式 cleanup。
- 预期结果：允许安全重写未消费条目；create 最多顺带清理 100 个过期条目；显式 cleanup 可完整清理 expired，或按 run/id/`--all` 清理。
- 异常结果：`consumed` 条目不可复用；删除失败时记录 `cleanup_pending` 并保留可重试元数据 168 小时。

### 场景 4：旧文件参数兼容

- 前置条件：调用者仍使用现有 JSON 文件参数。
- 操作：不提供 `--staging-id` 执行原命令，或同时提供新旧参数。
- 预期结果：仅提供旧参数时行为保持；同时提供时在读取或业务持久化前以稳定错误拒绝。
- 异常结果：不得因为引入 staging 而扫描或迁移旧临时文件。

### 场景 5：生成和安装三平台代理

- 前置条件：兼容 CLI、统一命令契约、角色清单和模板版本已经更新并通过测试。
- 操作：重新生成 Codex、Claude、OpenCode 代理并执行真实 OpenCode 流程验证。
- 预期结果：代理提示词只允许通过 staging CLI 操作临时 JSON，明确展示 `writes` 与 `staging.owned_entries`，生成资产和摘要一致。
- 异常结果：任一平台仍引导写 `TMPDIR`、项目目录或 `AI_TEAM_HOME` 时阻止发布。

## 功能需求

### REQ-001：受管 staging CLI 与目录

- 描述：新增 `staging create/write/show/cleanup` CLI，并将内容文件放入 `${AI_TEAM_HOME:-~/.config/ai-team}/state/staging`。
- 输入：run、可选 dispatch、role、kind、staging id、JSON 内容及 cleanup 选择器。
- 输出：不含 JSON 原文的结构化条目元数据、查看结果或清理汇总。
- 约束：代理只经 CLI 操作 staging；目录由 AI Team 管理。

### REQ-002：安全且持久的 JSON 写入

- 描述：staging 目录/文件使用 0700/0600，仅接受不超过 2 MiB 的合法 JSON，并采用同目录临时文件、文件 `fsync`、原子替换及目录同步。
- 输入：待写 JSON。
- 输出：原子发布的 staging 内容与内容摘要。
- 约束：失败不得暴露部分写入或替换既有有效内容。

### REQ-003：文件系统边界防护

- 描述：创建、重写、查看、消费和清理均校验当前 UID、regular file、单硬链接、realpath、mode 和预期路径身份。
- 输入：staging id 解析出的受管路径。
- 输出：安全读取/写入/删除，或稳定拒绝。
- 约束：必须拒绝 symlink、hardlink、越界 realpath 和检查后 path replacement。

### REQ-004：staging 元数据迁移与脱敏审计

- 描述：新增 `staging_entries` 前向迁移，保存 `draft/ready/consumed/cleanup_pending/expired` 状态及必要绑定、摘要、大小和时间元数据。
- 输入：生命周期状态变化。
- 输出：可查询、可审计、可恢复的元数据记录。
- 约束：不提升 `STATE_SCHEMA_EPOCH`；SQLite、审计、事件和 operation 不保存 JSON 原文。

### REQ-005：保留与清理策略

- 描述：新增 `staging.retention_hours`，默认 168 小时；create 最多顺带清理 100 个过期条目；cleanup 支持完整 expired 清理和指定 run/id/`--all`。
- 输入：环境配置及 cleanup 选择器。
- 输出：清理计数、失败状态和剩余条目元数据。
- 约束：业务或删除失败的 staging 内容保留 168 小时；删除失败转 `cleanup_pending`。

### REQ-006：10 类消费者兼容接入

- 描述：为 context update/project-context、planning revision create/planning-documents、planning tasks validate/planning-tasks、dispatch create/dispatch-packet、dispatch validate+submit/dispatch-result、decision create/decision、git reconcile/git-reconcile-evidence、research archive/research-conclusions、review submit/review-result、review resolve/review-resolution 增加 `--staging-id`。
- 输入：旧文件参数或 `--staging-id` 二选一。
- 输出：与现有业务 schema 相同的解析对象和业务结果。
- 约束：新旧参数互斥；旧参数继续可用；kind 映射固定且表驱动可验证。

### REQ-007：绑定校验和消费时序

- 描述：staging 模式严格校验 run/dispatch/role/kind；context update 与 planning tasks staging 模式要求 `--run-id`。
- 输入：命令上下文与 staging 条目元数据。
- 输出：边界匹配时执行业务，否则拒绝且不消费。
- 约束：validate/preview 不消费；仅在最终业务成功持久化后消费；文件删除失败转 `cleanup_pending`。

### REQ-008：dispatch-result 冻结初始化和重试

- 描述：`dispatch-result` 条目以 dispatch 的冻结 template 初始化并绑定该 dispatch。
- 输入：有效 dispatch 与其冻结 template。
- 输出：可由对应角色完成的 `draft`/`ready` JSON。
- 约束：`draft`/`ready` 可重写；失败不消费；`consumed` 禁止重写或复用。

### REQ-009：角色清单、契约和三平台生成

- 描述：更新统一命令契约、相关角色命令清单、生成指令和模板版本，并重新生成 Codex、Claude、OpenCode 资产。
- 输入：staging 命令语法、参数类型、角色与 kind 所有权。
- 输出：三平台一致的生成代理和更新后的 digest。
- 约束：代理提示词禁止直接写 `TMPDIR`、项目目录和 `AI_TEAM_HOME`，并明确 `writes` 与 `staging.owned_entries`。

### REQ-010：项目上下文同步

- 描述：实现入口、职责或模块边界变化后同步 `MEMORY.md` 与 `.ai-team/index/feature-navigation.md`。
- 输入：最终实现边界。
- 输出：可供 File Explorer 使用的最新项目上下文。
- 约束：更新后必须通过 `ai-team context validate`。

### REQ-011：完整验证门禁

- 描述：覆盖文件安全、生命周期、跨边界拒绝、全 kind 表驱动、旧参数兼容、持久化与脱敏、三平台生成和真实 OpenCode 流程。
- 输入：单元、集成、E2E、生成资产与平台流程测试。
- 输出：失败可定位的测试证据。
- 约束：最终必须通过 `npm run verify`。

### REQ-012：兼容发布与精准范围

- 描述：先发布兼容 CLI，再生成/安装新代理；改动限于 staging、消费者接入、生成资产、文档和测试所需范围。
- 输入：已验证的 CLI 与代理资产。
- 输出：可回滚的分阶段发布结果。
- 约束：不处理历史 `TMPDIR`/OpenCode 文件，不清理无关代码或扩大权限。

## 验收标准

### AC-001：目录、文件和标识安全创建

- Given：使用新的 AI Team home 和有效 run/role/kind。
- When：执行 `staging create`。
- Then：只在 `state/staging` 内创建 0700 目录和 0600 regular file，返回 opaque staging id 与脱敏元数据。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`

### AC-002：大小、JSON 与原子持久化

- Given：存在未消费条目。
- When：分别写入合法 JSON、非法 JSON、超过 2 MiB 内容，并注入替换前后的失败。
- Then：仅合法且不超限内容通过同目录临时文件、`fsync` 和原子替换完整可见；失败不破坏旧内容。
- 验证命令或证据：`node --import tsx --test test/core.test.ts`

### AC-003：链接和路径替换攻击拒绝

- Given：条目文件或父路径被替换为 symlink、hardlink、错误 mode、其他 UID/非 regular file、越界 realpath 或竞态替换目标。
- When：执行 write/show/consume/cleanup。
- Then：操作在业务副作用前拒绝，且不读取、覆盖或删除 staging 根目录外对象。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`

### AC-004：前向迁移和无原文状态

- Given：已有兼容状态库。
- When：首次以写模式打开升级版本。
- Then：只执行一次新增前向迁移并创建 `staging_entries`；`STATE_SCHEMA_EPOCH` 不变；数据库、event、operation 和审计查询均不含 JSON 原文。
- 验证命令或证据：`node --import tsx --test test/core.test.ts`

### AC-005：状态机和重写规则

- Given：条目依次处于 `draft`、`ready`、`consumed`、`cleanup_pending` 或 `expired`。
- When：执行允许或禁止的 write/show/consume/cleanup 操作。
- Then：仅合法状态边转换成功，`draft/ready` 可重写，`consumed` 不可复用，失败状态保留可重试证据。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`

### AC-006：dispatch-result 冻结绑定

- Given：存在冻结 packet/prompt/schema/template 的 dispatch。
- When：为 `dispatch-result` 创建 staging 条目。
- Then：内容由冻结 template 初始化并绑定该 dispatch、run、role、kind；其他边界不能读取或提交。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts`

### AC-007：校验不消费、成功后消费

- Given：一个可用 staging 条目。
- When：先执行 validate/preview，再执行失败业务命令，最后执行成功业务命令。
- Then：前两类操作不消费；最终业务成功持久化后才消费；删除失败时业务结果保持成功且条目为 `cleanup_pending`。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`

### AC-008：过期和选择性清理

- Given：存在 expired、cleanup_pending、失败后保留及不同 run 的条目。
- When：触发 create 顺带清理，或按 expired、run、id、`--all` 显式 cleanup。
- Then：create 单次最多处理 100 个；显式 expired 完整处理；选择器不越界；失败条目按 168 小时策略保留。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`

### AC-009：全 kind 和 10 类命令覆盖

- Given：每个固定 kind 均有边界正确与错误的 staging 条目。
- When：以表驱动方式调用全部 10 类 JSON 消费命令。
- Then：正确 kind 完成原业务，错误 run/dispatch/role/kind 全部拒绝；context update 和 planning tasks staging 模式缺少 `--run-id` 时拒绝。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts`

### AC-010：旧参数兼容与互斥

- Given：每类命令已有旧文件参数调用。
- When：分别只传旧参数、只传 `--staging-id`、同时传两者。
- Then：前两种成功且业务结果等价，第三种在读取前以稳定错误拒绝。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts`

### AC-011：配置和脱敏输出

- Given：默认配置或显式 `staging.retention_hours`。
- When：执行 config、show、run/dispatch 审计与失败路径。
- Then：默认值为 168，显式合法值规范化返回；输出只含元数据摘要，敏感 JSON 原文不出现。
- 验证命令或证据：`node --import tsx --test test/environment.test.ts test/core.test.ts test/cli-e2e.test.ts`

### AC-012：角色权限和所有权提示

- Given：相关角色 manifest 和统一命令契约。
- When：构建角色指令。
- Then：仅所需角色拥有对应 staging 命令，提示词禁止直接临时文件写入并明确 `writes` 与 `staging.owned_entries`。
- 验证命令或证据：`node --import tsx --test test/agent-build.test.ts`

### AC-013：三平台生成与模板升级

- Given：兼容 CLI、更新后的命令契约、角色清单和提升后的模板版本。
- When：重新生成 Codex、Claude、OpenCode 资产并运行生成测试。
- Then：三平台语法和权限一致、digest 更新、生成结果稳定，真实 OpenCode staging 流程成功。
- 验证命令或证据：`node --import tsx --test test/environment.test.ts test/agent-build.test.ts test/cli-e2e.test.ts`

### AC-014：项目上下文一致

- Given：实现入口和模块边界已定稿。
- When：更新 `MEMORY.md` 和 `.ai-team/index/feature-navigation.md` 后执行校验。
- Then：导航包含 staging、消费者和生成边界，且 context 校验通过。
- 验证命令或证据：`ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team`

### AC-015：完整验证和发布顺序

- Given：全部实现和生成资产完成。
- When：执行最终门禁并按发布步骤操作。
- Then：`npm run verify` 通过；先交付兼容 CLI，再生成/安装代理；未扫描、迁移或删除旧临时文件。
- 验证命令或证据：`npm run verify`

## 数据与接口

- `staging_entries` 至少表达 opaque `staging_id`、`run_id`、可选 `dispatch_id`、`role`、固定 `kind`、`state`、内容摘要、字节数、创建/更新时间、过期时间、消费时间和 cleanup 结果；具体列名遵循现有 SQLite 命名约定。
- 内容文件位于 `state/staging`，SQLite 只保存元数据；任何 event、operation、artifact 索引或审计输出不得嵌入 JSON 原文。
- CLI 接口为 `staging create/write/show/cleanup`；所有消费者的新输入为 `--staging-id`，与各自旧文件参数互斥。
- 固定 kind 为 `project-context`、`planning-documents`、`planning-tasks`、`dispatch-packet`、`dispatch-result`、`decision`、`git-reconcile-evidence`、`research-conclusions`、`review-result`、`review-resolution`。
- `dispatch-result` 的初始 JSON 来自 dispatch 冻结 template；show 和业务输出按既有 JSON 输出契约返回脱敏元数据。

## 兼容约束

- 现有行为必须保持：全部旧 JSON 文件参数继续可用；现有业务 schema、成功结果和错误语义除互斥校验外不变；只读命令保持无迁移、无锁和无目录创建副作用。
- 迁移兼容窗口：先发布同时支持旧文件参数和 `--staging-id` 的 CLI，再生成和安装只使用 staging CLI 的代理；本次不设旧参数删除期限。

## 安全约束

- 权限边界：staging 根目录 0700，内容文件 0600；调用 UID 必须拥有对象；只允许 regular file 且硬链接数为 1。
- 敏感数据处理：JSON 原文仅存在于受管内容文件和当次内存解析对象，不进入 SQLite、审计、事件、operation 或日志；所有持久元数据只含摘要和必要绑定。
- 路径和输入校验：opaque id 不能变成任意路径；所有操作在真实路径、父目录、文件身份、mode、link count 和预期 inode/路径关系验证后进行，并抵抗检查后替换。

## 错误与边界

- 非法输入：拒绝非法 JSON、超过 2 MiB、未知 kind、错误状态、错误绑定、新旧参数并用和缺少 staging 模式必需 `--run-id`。
- 空数据：空文件不是合法 JSON；合法的 JSON `null`、数组或对象是否接受由对应业务 schema 决定，staging 层只保证 JSON 语法。
- 超时或外部依赖失败：业务持久化失败不消费条目；文件删除失败不回滚已成功业务，而转为 `cleanup_pending`。
- 重试和幂等：`draft/ready` 可安全重写；validate/preview 可重复；已消费条目不可再次提交；cleanup 对已不存在且元数据已终结的目标保持稳定结果。

## 迁移发布回滚

- 发布步骤：实现并验证兼容 CLI与迁移；更新契约、角色和模板版本；重新生成三平台代理；安装/验证真实 OpenCode 流程；最后切换代理使用 staging。
- 迁移步骤：以新的 forward-only migration 创建 `staging_entries`，沿用 StateStore 备份、锁和失败恢复；不改变 `STATE_SCHEMA_EPOCH`。
- 回滚触发条件和操作：安全测试、旧参数兼容、脱敏、生成一致性或真实平台流程任一失败即停止代理生成/安装；回滚新代理到兼容 CLI 的旧文件参数路径，保留数据库迁移和 staging 元数据供诊断，不删除用户历史临时文件。

## 已确认偏好

- 用户已明确决定：覆盖全部 10 类 JSON 消费命令；默认保留 168 小时；validate/preview 不消费；业务成功后消费；删除失败进入 `cleanup_pending`；dispatch-result 绑定冻结 template；先兼容 CLI 后生成代理；不处理历史临时文件。

## 默认取舍

- 未明确事项的默认决策及理由：内部函数名、SQLite 列名和错误码沿用现有模块与 CLI 风格，以减少无关差异；不增加本规格以外的配置开关或迁移工具。

## 已关闭问题

- 问题：`--staging-id` 覆盖范围。结论：覆盖全部 10 类 JSON 消费命令。证据：用户冻结方案与 requirements typed decision receipt。
- 问题：保留时长。结论：默认及失败保留时长均为 168 小时。证据：用户冻结方案与 requirements typed decision receipt。
- 问题：是否迁移旧临时文件。结论：不扫描、不迁移、不删除。证据：用户冻结方案与 requirements typed decision receipt。
- 问题：是否拆分实现任务。结论：需要拆分并先做 Task 预览。证据：用户要求形成可执行 ready plan revision/tasks。

## 未决问题

- 无。
