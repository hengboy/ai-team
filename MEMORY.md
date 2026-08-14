<!-- ai-team:project-context:start -->
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
- cleanup_pending

### 仓库约束
- 要求 Node.js >=22.13.0，并必须通过 npm 验证脚本。
- 规划修订是完整且不可变的文档包。
- 规划修订的 Git 变更仅由 Git Operator 执行。
- 必须从仓库源码构建和安装，禁止直接编辑全局 dist 文件。
- 代理生成的 JSON 必须使用受管 staging CLI；staging 元数据和审计事件不得保存原始 JSON。

### 职责
- `src/cli.ts` 负责绑定命令、恢复操作和规范 JSON 输出。
- `src/dispatch.ts` 负责校验、提交、规划生命周期、恢复和提交调度门禁。
- `src/state.ts` 负责 SQLite 的读写打开路径、锁、运行、决策和操作记录。
- `src/planning.ts` 负责校验完整修订文档以及修订与运行阶段的一致性。
- `src/contracts.ts` 负责结果信封和角色载荷 schema。
- `src/command-contract.ts` 负责公共命令和代理命令的精确语法。
- `src/security.ts` 与 `src/state.ts` 负责 staging 文件系统安全、生命周期元数据、保留和清理。
- `skills/init-ai-team` 负责在目标 Git 项目中初始化并校验 AI Team 的可复用 Codex 工作流。

### 模块边界
- `src/git-orchestrator.ts` 与 `src/git.ts` 负责 Git 编排。
- `src/environment.ts` 与 `agent-build/roles` 负责受管角色生成和能力定义。
- `src/cli.ts` 绑定 10 类支持 staging 的 JSON 消费命令，同时保留旧文件参数。
- `skills/init-ai-team` 封装公共初始化和上下文校验命令，不改变 CLI 行为。
- `test/*.test.ts` 包含单元测试、CLI 端到端测试、锁测试、契约测试和工作流回归测试。
<!-- ai-team:project-context:end -->
