<!-- ai-team:project-context:start -->
<!-- ai-team:context-format {"renderer_version":"context-renderer-v2","schema_version":2} -->
## 项目上下文

### 项目形态
基于 Node.js 22+、TypeScript ESM 与 Commander 的 CLI 包，使用 SQLite 保存工作流状态，支持不可变规划修订、角色资产生成和 node:test 测试。

### 领域术语
- planning run
- dispatch
- decision
- revision
- plan_ready
- Git Operator
- result envelope
- read-only state store
- legacy output
- managed staging entry
- staging kind
- staging sequence
- cleanup_pending
- environment provenance
- packed install gate
- replacement dispatch
- worktree ownership transfer
- context renderer version
- testedCommit
- formal review barrier
- review reconciliation
- finalize_integration
- requirement question numbering
- phased worktree preparation
- planning handoff
- plan worktree
- requirements_final
- task_split
- structured validation cause
- dispatch worktree binding
- packet worktree binding
- execution contract
- command lifecycle
- recovery timeline
- next action
- human renderer

### 仓库约束
- 要求 Node.js >=22.13.0，并必须通过 npm 验证脚本。
- 规划修订是完整且不可变的文档包。
- 规划修订的 Git 变更仅由 Git Operator 执行。
- 必须从仓库源码构建和安装，禁止直接编辑全局 dist 文件。
- 发布验收必须安装真实 npm tarball，且该网络门禁与日常 `verify` 分离。
- 代理生成的 JSON 必须使用受管 staging CLI；staging 元数据和审计事件不得保存原始 JSON；文件名使用 run 内不可复用序号标识创建顺序和产出阶段。
- Git Operator merge authorization must use frozen dispatch-worktree bindings

### 职责
- `src/cli.ts` 保留规范输出、全局错误处理和注册组合；`src/commands/` 按项目、规划运行、staging/dispatch、Git/review 与环境职责注册命令。
- `src/workflow.ts` 负责 coding run 启动、主工作树 clean gate、实现基线冻结、planned plan worktree 创建，以及生成受管取消清理 dispatch。
- `src/dispatch.ts` 保留事务 facade、提交、规划生命周期、恢复和后继调度门禁；`src/dispatch/` 提供 packet、planning、implementation 与 recovery 的纯计算。
- `src/dispatch.ts` 同时负责 retryable replacement lineage、无副作用 Git 失败 reissue、planned merge 前置 TASK worktree adoption 恢复、dispatch-bound typed decision、planned recovery decision 到 Git cleanup 的转换、planned Git-before-Coding 依赖、integration commit 门禁和冻结 review packet。
- `src/state.ts` 负责 SQLite 打开、前向迁移、锁、运行、决策、replacement 和操作记录；`src/staging.ts` 负责 staging persistence、文件迁移与生命周期，并由 StateStore 保留兼容 facade。
- `src/planning.ts` 负责校验完整修订文档以及修订与运行阶段的一致性。
- `src/contracts.ts` 负责结果信封和角色载荷 schema。
- `src/command-contract.ts` 负责公共命令和代理命令的精确语法。
- `src/constants.ts` 从安装包 `package.json` 严格读取 CLI 版本。
- `src/environment.ts` 负责解析环境模型，并解释整对象 default/override 来源和环境间语义差异。
- `scripts/verify-packed-install.ts` 负责在隔离 consumer 中验证真实 npm tarball。
- `src/security.ts` 与 `src/staging.ts` 负责 staging 文件系统安全、run 内序号分配、可读文件名迁移、生命周期元数据、保留和清理。
- `skills/setup-ai-team` 负责在目标 Git 项目中初始化 AI Team，委派 File Explorer 基于仓库证据生成结构化项目上下文，并写入、校验真实功能导航。
- `skills/switch-ai-team-env` 负责预检并切换 AI Team 全局环境配置的可复用 Codex 工作流。
- `src/dispatch.ts` 将已完成的评审叶子汇总到所属 barrier，并幂等创建唯一的 review resolution 或最终 Git Operator continuation。
- `src/review.ts` 提供 barrier 幂等创建，以及按 barrier ID 或 run revision 查询状态。
- `src/workflow.ts` 负责显式 direct mode 分诊一致性，并将 frozen coding run 原子关联到 planning run，保留原 task worktree 所有权。
- `src/dispatch.ts` 负责区分 requirement 编号问题、requirements_final 与 task_split，冻结 File Explorer 结果证据，并管理无 stale Planning dispatch 的 continuation。
- `src/dispatch.ts` 负责 delegated role 自提交回执、renderer 版本冻结，以及 `verify_existing` 驱动的受审计 `no_change` 规划终态。
- src/state.ts persists dispatch-worktree binding migrations
- src/worktree-ownership.ts resolves persisted worktree ownership consumption
- src/dispatch.ts persists and preserves merge binding lineage for create, supersede, reissue, and reconcile
- src/git-orchestrator.ts validates merge-task against persisted dispatch bindings
- `src/execution-contract.ts` 从角色 YAML default/ceiling 冻结 dispatch execution contract，并校验 replacement 只能收紧。
- `src/run-recovery.ts` 将 command/domain events 与权威当前行投影为 timeline，并稳定计算 next actions 和 blocked_by。
- `src/resource-registry.ts` 管理 invocation-scoped AbortSignal、store、finalizer 与已注册子进程；`StateStore.closeAsync()` 等待数据库锁释放。
- `src/human-renderer.ts` 负责受支持命令的生产级 human 输出和无单行嵌套 JSON 的递归 fallback。
- `src/environment.ts` 在不探测客户端的前提下组合 resolved environment、effective config、provenance 与 digests。

### 模块边界
- `src/git-orchestrator.ts` 与 `src/git.ts` 负责 planned revision-scoped plan/task worktree、direct run-scoped integration/task 编排、精确 plan ownership 接受、已有直接子提交 TASK adoption、planned pre_commit worktree scope 与 no-ff merge，并将相关身份写入操作证据。
- `src/review.ts` 仅评审已通过独立测试的 planned plan HEAD 或 direct integration HEAD，并验证 code-reviewer packet 的 revision、文档、diff、testedCommit 与 evidence digest 绑定。
- `src/context.ts` 仅以 `.ai-team/index/feature-navigation.md` 为权威导航路径，并负责 schema/renderer 版本记录及旧格式迁移。
- `src/environment.ts` 与 `agent-build/roles` 负责受管角色生成、能力定义及只读环境查询。
- `src/cli.ts` 为受管 JSON 命令提供 file、`--staging-id` 与 `--input-stdin` 输入；新 dispatch prompt 固定走显式 staging，planning commit 会关闭遗留 Planning dispatch。
- `src/dispatch/packet.ts` 以 v5 renderer 生成显式 staging prompt，并由 `src/dispatch.ts` 按历史 renderer/digest 恢复旧 dispatch；claim bundle 与 submit continuation 保持只读投影。
- `skills/setup-ai-team` 封装公共初始化命令、File Explorer 上下文采集、`context update` 与校验，`skills/switch-ai-team-env` 封装公共环境切换和状态命令；两者均不改变 CLI 行为。
- `test/**/*.test.ts` 包含单元测试、CLI 端到端测试、锁测试、契约测试和工作流回归测试。
- `src/review.ts` 负责 formal review 绑定和公共状态查询，`src/dispatch.ts` 负责叶子汇总、恢复和 run 阶段推进。
- `run handoff-to-planning` 只接受无 pending operation 的 frozen coding run；规划 revision 提交 ready 后恢复 source run，旧 pending/claimed dispatch 不得继续授权。
- `src/contracts.ts` 让公开 result schema 与运行时 validator 复用 typed decision shape，并定义无 revision/worktree/Git 副作用的 planning `no_change` payload。
- `run show` 仅公开协调所需的 run-owned worktree 元数据，不公开其他角色的原始 result 或 staging 内容；submit continuation 只投影 run state/stage、pending dispatches 与 pending decision。
- dispatch-worktree binding rows are the durable authority for merge-task authorization; packet context remains frozen compatibility evidence
- `run_events` 的 command lifecycle 仅用于审计和恢复投影；runs、dispatches、decisions、operations 仍是权威状态，副作用幂等仅由 `operations.idempotency_key` 决定。
- `run show.events` 与 `run resume.last_event` 排除 `command.%` 以保持旧 domain event 语义；timeline 中 authoritative row 明确标记为当前投影。
- role YAML execution policy 是 default/ceiling 的事实源；legacy dispatch packet 与 digest 不回写，manifest 不匹配的 replacement 必须启动新 run。
<!-- ai-team:project-context:end -->
