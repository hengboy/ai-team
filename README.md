# AI Team

AI Team 是一个本地 TypeScript 和 Node.js CLI，用于协调原生 Codex、
Claude Code 与 OpenCode 代理，支持可审计的规划和编码工作流。
它将工作流状态存储在 SQLite 中，创建隔离的 Git worktree，校验
代理结果，并以事务方式生成平台原生的代理定义。
它不会启动 AI 客户端进程，也不使用 MCP。

源码按职责分层：`src/commands/` 注册 CLI 命令，`src/dispatch/` 计算冻结 packet、
规划、实现和恢复 intent，`src/staging.ts` 管理 JSON staging 生命周期，
`src/worktree-review.ts` 统一只读评审 worktree 定位；`src/cli.ts`、
`src/dispatch.ts` 与 `src/state.ts` 保留公共 facade、事务和输出边界。

## 环境要求

- macOS
- Node.js 22.13 或更高版本
- Git 2.39 或更高版本

安装软件包并初始化 Git 项目：

```sh
npm install --global @ai-team/cli
ai-team init /path/to/project
ai-team install --dry-run
ai-team install
```

`ai-team init` 会创建 `.ai-team/project.yaml`、规划目录、必需的
`.gitignore` 条目，以及目标项目的 `MEMORY.md` 和
`.ai-team/index/feature-navigation.md`。它会将维护规则追加到已有的
`AGENTS.md` 或 `CLAUDE.md`，但不会创建这两个文件。若修改了任何现有的
目标上下文或指令文件，请检查 JSON 诊断信息，然后携带 `--yes` 重试。

内置的 `setup-ai-team` 技能会先委派 File Explorer 执行只读检查，再将其
结构化结果传给 `ai-team context update`，以完成初始化。这样会将目标仓库
实际的职责、模块边界和入口路径写入 `MEMORY.md` 和功能导航，而不是仅保留
初始骨架。

直接维护上下文时，使用 `ai-team context update --project <path> --context-file <json>`
处理结构化的 File Explorer 结果；使用
`ai-team context validate --project <path>` 检查章节、真实导航路径、指令规则
和待完成的维护项。

## 工作流

用户在客户端中选择生成的 `planning` 或 `coding` 代理，并输入自然语言请求。
这些主代理会调用内部 CLI 命令；用户通常无需自行运行 `planning start` 或
`coding start`。

规划会在以下位置创建不可变修订：

```text
.ai-team/plans/<plan-id>/revisions/<revision>/
```

只有 `ready` 修订可以进入计划内编码。编码始终记录当前目标分支的 HEAD 作为
实现基线；目标 worktree 不干净时会被阻止，并使用 `.worktrees/` 下受管理的
worktree。计划内编码启动时会创建一个由运行拥有、名为
`<plan-id>-<revision>` 的计划 worktree；拆分任务直接使用该计划 worktree，
除非冻结修订包含多个明确的 `TASK-*.md` 文件。多任务修订使用
`<plan-id>-<revision>--<task-id>`，并合并回计划 worktree。
直接 bug 和功能运行使用各自 run-scoped integration/task worktree，与主工作树及
其他运行隔离。

客户端会话结束后，使用以下恢复命令：

```sh
ai-team run show <run-id>
ai-team run resume <run-id>
ai-team run cancel <run-id> --reason <reason>
ai-team run decide --run-id <run-id> --decision-id <decision-id> --choice <choice-id>
ai-team dispatch reconcile --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --actor-role <role> --reason <text>
```

当运行拥有 worktree 时，`run cancel` 会返回一个 Git Operator 清理 dispatch。
领取该 dispatch，运行 `git cleanup`，校验并提交其冻结结果，然后启动替代运行。
取消操作会拒绝存在待处理 Git 操作、不干净 worktree 或不安全路径的情况。

使用 `repair-recreate` 或 `managed-reconcile` 解决计划中的恢复决策，会执行
相同的受管理取消操作，在审计事件中关联失败的启动运行，并返回 `git-operator`
清理 dispatch，而不是复制被阻止的 Coding packet。

当可重试结果报告已确认完成的副作用时，`run resume` 会返回精确的
`dispatch reconcile` 命令，以创建经过审计的替代项，同时保留原始 dispatch
谱系和验证证据。

## 环境管理

AI Team 将全局状态存储在 `~/.config/ai-team` 下，或在设置时使用
`AI_TEAM_HOME`。默认环境为 `balanced`；首次使用时也会创建 `quality` 和
`economy`。每个环境都会为每个已启用的平台解析全部 12 个角色。

```sh
ai-team env list
ai-team env show balanced --resolved
ai-team env validate balanced
ai-team env explain balanced --role coding --platform codex
ai-team env diff balanced quality
ai-team env generate --dry-run
ai-team env switch quality --dry-run
ai-team env status
ai-team env doctor
ai-team env doctor --probe
```

只有 `env doctor --probe` 会执行客户端二进制文件。生成、切换、安装、恢复和
卸载仅在用户显式发出命令后进行。受管理的文件会在替换前暂存并校验；已修改的
文件会阻止破坏性删除，恢复备份需要显式执行 `backup restore` 命令。

`install` 需要先前显式探测记录的客户端版本。低于配置最低版本的客户端会阻止
安装；高于已验证范围的版本会产生警告。不受支持的硬平台能力会阻止生成，而不会
被静默降级。

## 代理命令

生成的主代理使用 `dispatch`、`decision`、`planning revision`、`git` 和
`review` 子命令。每个 dispatch 都绑定一个运行、角色、packet、冻结的任务
提示词、严格的结果 schema 和结果模板。完成的结果需要验证证据，并会以脱敏且
带哈希的工件形式存储。

标准的双命令 dispatch 路径会将所有冻结资产作为一个 bundle 领取，并通过 stdin
提交结果：

```sh
ai-team dispatch claim --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --bundle
ai-team dispatch submit --run-id <run-id> --dispatch-id <dispatch-id> --role <role> --staging-id <staging-id>
```

bundle 包含 packet、prompt、schema、template、它们的摘要和渲染器版本。被委派的
角色负责自身提交：它只提交一次 envelope，并返回 CLI 回执，而非未提交的 envelope。
回执包含提交状态、工件 ID/路径、摘要，以及一个只读续接信息，其中包含当前运行
状态/阶段、待处理 dispatch 和待处理决策。收到 `submission.state=\"submitted\"`
的协调器不得创建新的 staging 条目或再次提交该 dispatch。重复提交仍具幂等性。

正式计划要求每个冻结修订各进行一次 Spec 和 Standards 评审。直接 bug 和功能
运行需要一次 Standards 评审。P0 和 P1 发现的问题必须在集成前全部具备变更和
验证证据。修复后不会重新运行评审。

提交 dispatch 会推进持久化的运行阶段，并且只创建一次后续阶段。File Explorer 可以
接收仓库根目录；下游 packet 包含 File Explorer 返回的精确路径。生成安全执行批次
前，会校验 Planning Task 图中的 ID、依赖关系、环、覆盖字段和重叠写入范围。

规划运行仅能在解决 `verify_existing` 决策后，基于需求以 `no_change` 结束。规划
结果会记录仓库证据和决策回执，在不产生修订、worktree、Git Operator dispatch 或
产品提交的情况下完成运行，也不会创建续接项。

运行 `ai-team <command> --help` 查看精确参数。`ai-team contract` 会输出用于
检测漂移的 contract 和角色清单摘要。

### 受管理的 JSON 暂存

代理生成的 JSON 存储在
`${AI_TEAM_HOME:-~/.config/ai-team}/state/staging/<run-id>/` 下，并且只能通过
CLI 管理。代理 dispatch 结果使用显式条目：创建 `dispatch-result`，使用
`--input-stdin` 写入，再将相同的 `--staging-id` 传给校验和提交。为兼容其他
消费者，仍保留直接 stdin。显式命令也是恢复和诊断路径：

```sh
ai-team staging create --run-id <id> --role <role> --kind <kind> [--dispatch-id <id>]
ai-team staging write --run-id <id> --role <role> --staging-id <id> --input-stdin
ai-team staging show --run-id <id> --role <role> [--staging-id <id>] [--content]
ai-team staging cleanup --expired
ai-team staging cleanup --run-id <id> [--staging-id <id>] --all
```

这 10 种类型为 `project-context`、`planning-documents`、`planning-tasks`、
`dispatch-packet`、`dispatch-result`、`decision`、`git-reconcile-evidence`、
`research-conclusions`、`review-result` 和 `review-resolution`。现有 JSON 文件
选项仍受支持；13 个受管理 JSON 命令中的每一个都恰好接受其文件选项、
`--staging-id` 或 `--input-stdin` 三者之一。校验和 Task 预览不会消耗内容。
成功的变更命令会在删除暂存文件前持久化业务结果。输入或业务校验失败时，会返回
保留的 `staging_id` 和状态，以便通过已有的 `--staging-id` 路径修正。删除失败会
记录为 `cleanup_pending`，供后续重试。

创建 `planning-documents` 会初始化一个可发现的
`{"spec":"","plan":""}` 骨架。校验失败会返回并审计一个包含 JSON 指针、
约束和修复建议的结构化原因。

由于 review 暂存所有权按维度区分，`review submit --input-stdin` 还要求指定
`--role review-spec` 或 `--role review-standards`。文件和 `--staging-id` 形式的
review 提交保留其现有语法。

目录权限为 `0700`，文件权限为 `0600`；写入限制为 2 MiB 的有效 JSON，并执行
原子替换以及链接/所有权/路径检查。默认失败保留期为 168 小时，可通过
`config.yaml` 中的 `staging.retention_hours` 设置。元数据和审计事件包含摘要和
大小，不包含原始暂存 JSON。

## 安全性

AI Team 拒绝凭证路径、`.env*`、`.ai-team/runtime` 和通过符号链接逃逸的路径。
Git 命令以固定参数数组传递。不提供 push、tag、rebase、reset、clean、stash、
squash、cherry-pick、amend、远端变更和发布操作。失败或不确定的操作会保留
worktree，并要求进行协调处理。

重新生成或安装代理前，请升级兼容的 CLI。AI Team 不会扫描、迁移或删除历史
`$TMPDIR/opencode` 文件。

## 开发

`agent-build/` 是受管角色定义和渲染输入的事实源；生成产物必须从仓库源码构建，
不得直接修改已安装的 `dist` 或平台代理文件。

```sh
npm install
npm run verify
npm run verify:packed
npm pack --dry-run
```

日常 `verify` 覆盖类型、lint、测试与构建。`verify:packed` 是联网的发布门禁，
仅在 package/publish/install 变化时运行；它会在不运行生命周期脚本的情况下打包，将
tarball 安装到隔离的外部消费者中，并且只校验已安装的 CLI 和已打包资源。它有意
与日常的 `verify` 命令分开。

测试会创建隔离的临时主目录和 Git 仓库，绝不会调用真实模型。客户端进程仅由显式的
探测测试执行。
