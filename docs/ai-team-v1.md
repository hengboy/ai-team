# AI Team v1 生产级方案

状态：需求已确认，方案已校正

## 1. 目标与边界

AI Team 是一套全新的、本地运行的 AI 编码团队系统，不依赖或复用本机已有的 AI Work Flow/Engine。它提供 TypeScript + Node.js CLI、工作流状态机、Agent 生成器、项目规划协议和本地 Git 编排。

v1 的目标用户是个人开发者，用于管理多个本地 Git 项目。v1 生产支持 macOS + Node.js；Linux 和 Windows 只保留适配抽象，不承诺完整兼容。系统不使用 MCP，不由 CLI 启动 Codex、Claude Code 或 OpenCode 进程。

用户在 Codex、Claude Code 或 OpenCode 中选择原生 `planning` 或 `coding` Agent，然后直接输入自然语言需求。主 Agent 使用客户端原生子代理能力调度其他 Agent，并通过 `ai-team` CLI 提交状态、领取 dispatch、执行门禁和请求 Git 操作。

## 2. 产品组成

```text
@ai-team/cli
├── 命令行接口
├── Planning/Coding 工作流状态机
├── dispatch、packet、prompt、result 契约
├── SQLite 状态库与恢复机制
├── Git Operator 和 worktree 编排
├── Codex/Claude Code/OpenCode Agent 渲染器
├── 环境配置、模型配置和事务式生成
└── 本地 artifact、备份和诊断工具
```

公共命令名为 `ai-team`，npm 包名暂定 `@ai-team/cli`。用户不需要手工输入 `planning start` 或 `coding start`；主 Agent 根据会话中的自然语言调用对应内部命令。

## 3. 角色与调度

正式角色共 12 个：

```text
planning
coding
file-explorer
frontend-developer
backend-developer
test
git-operator
code-reviewer
review-spec
review-standards
environment-operator
researcher
```

### 3.1 角色职责

| 角色 | 职责 | 写入权限 | 调度权限 |
| --- | --- | --- | --- |
| `planning` | 需求澄清、需求清单、spec、plan、Task 预览和任务文档 | 当前工作区的规划文件 | `file-explorer`、`researcher` |
| `coding` | 自动分诊、任务编排、验证、评审、修复和集成 | 不直接写产品代码 | 全部实施流程角色、`researcher` |
| `file-explorer` | 仓库搜索、入口、调用链、影响范围和测试入口发现 | 只读 | 无 |
| `frontend-developer` | UI、交互、状态、浏览器和前端代码 | 指定 task worktree 的允许范围 | 无 |
| `backend-developer` | API、领域逻辑、数据库、配置、脚本和非 UI 通用工程 | 指定 task worktree 的允许范围 | 无 |
| `test` | 独立测试、构建、静态检查和回归验证 | 不写产品文件 | 无 |
| `git-operator` | 本地分支、提交、worktree、diff、merge、reconcile 和清理 | 唯一 Git mutation | 无 |
| `code-reviewer` | 编排一次双轴评审并原样汇总 | 只读 | `review-spec`、`review-standards` |
| `review-spec` | 正式方案的需求符合性评审 | 只读 | 无 |
| `review-standards` | 工程标准和代码质量评审 | 只读 | 无 |
| `environment-operator` | 安装、切换、生成、卸载和状态检查 | 仅全局受管理文件 | 无 |
| `researcher` | 外部联网调研并产出带引用的报告 | 仅指定报告 artifact | 无 |

`planning` 和 `coding` 是唯一的流程状态调度者。普通子代理不能调度其他子代理；唯一例外是 `code-reviewer` 调度两个评审叶子。子代理遇到职责外工作时返回 `requested_support`，由主代理创建新的 dispatch。

`environment-operator` 不参与普通 Coding run 的环境切换。`install`、`env switch`、备份恢复和卸载必须由用户显式执行；主代理不得自行改变全局环境。

### 3.2 文件检索边界

`file-explorer` 独占以下发现动作：文件名搜索、全文搜索、目录遍历、入口定位、调用链追踪、影响范围分析、测试入口查找和未知依赖探索。

其他代理只能读取 dispatch packet 明确提供的规划文档、diff slices、测试证据、指定文件和 `file-explorer` 返回的 `allowed_read_paths`。发现未知引用时必须请求 `file-explorer`，不得自行 `rg`、`find`、`glob` 或全仓扫描。Reviewer 只审查 Git Operator 提供的 committed diff 和明确上下文。Researcher 不搜索目标仓库，所需项目上下文由 `file-explorer` 提供。

## 4. 工作流入口与状态

### 4.1 Planning

Planning 始终在用户当前分支和当前工作区运行，不创建分支、不创建 worktree。

```text
接收自然语言需求
→ File Explorer 只读探索
→ 每轮只问一个最高优先级问题
→ 生成完整需求清单
→ 用户确认完整需求清单且未决问题为 none
→ 写 spec.md
→ 写 plan.md
→ 选择拆分或不拆分
→ 若拆分，循环 Task 预览和颗粒度确认
→ 写 tasks.md 与 tasks/TASK-xxx.md
→ Researcher 报告归档（如触发）
→ Git Operator 创建规划提交
→ revision 进入 ready
```

需求清单必须包含背景、目标、非目标、用户场景、功能需求、验收标准、数据/接口/兼容约束、安全约束、错误和边界、迁移/发布/回滚要求、已确认偏好、默认取舍、已关闭问题和未决问题。最终确认必须明确指向“完整需求清单”。

Task 拆分先只生成预览，展示 `TASK-ID`、标题、摘要、REQ/AC 覆盖、依赖、候选允许范围和并行建议。用户可合并、拆细、调整顺序或重新界定范围；每次调整后重新预览。未明确确认前不得写正式 Task 文件。

规划 revision 不可变，已提交的 `spec.md`、`plan.md`、`tasks.md` 和 Task 文件不原地编辑、不 amend。需求变化创建新 revision，记录 `supersedes` 和变更原因。规划提交只包含本次 revision 的规划文件和 Researcher 报告，不夹带用户其他修改。

### 4.2 Coding 三种入口

`coding` 收到自然语言后自动分诊：

- 有明确有效的 `plan_id/revision` 或唯一可实施的 `ready` revision，进入 `planned`。
- 存在实际行为、预期行为和复现/回归证据，进入 `bug`。
- 单一目标、验收闭合、无重要待决问题、范围可穷举、单模块、无需拆分且不触及敏感范围，进入 `feature`。
- 多个候选计划、Bug/功能含义不清或范围超限时询问用户或交 Planning。

正式方案（包括不拆分方案）执行 Spec + Standard 双轴评审。直接 Bug/小功能不生成 `direct-spec`，只执行一次 Standard Review。

Coding 启动时始终以当前目标分支最新 `HEAD` 重新探索和验证方案。Planning 记录的目标分支与当前分支不一致时，必须让用户选择切回原分支或显式迁移到当前分支；迁移后重新探索。工作区存在 staged、unstaged 或相关 untracked 文件时暂停，反馈给用户处理，禁止 stash、提交、清理或忽略。

### 4.3 状态枚举

规划状态：

```text
draft → requirements_confirmed → spec_ready → plan_ready
     → tasks_preview → ready → implemented
                                ↘ superseded / abandoned
```

run/dispatch 结果状态：

```text
completed | retryable_failure | needs_decision | failed
```

只有 `ready` revision 可实施。所有状态迁移由 CLI 校验并写入 SQLite，Agent 不得直接改运行状态文件。

## 5. 规划文档和项目目录

```text
.ai-team/
├── project.yaml
├── index/
│   └── feature-navigation.md
├── standards/
├── plans/
│   └── <plan-id>/
│       ├── plan.yaml
│       └── revisions/
│           ├── 001/
│           │   ├── spec.md
│           │   ├── plan.md
│           │   ├── research/
│           │   ├── tasks.md          # 仅拆分时
│           │   └── tasks/            # 仅拆分时
│           └── 002/
└── runtime/                          # 忽略，不提交
MEMORY.md
```

`plan_id` 格式为 `YYYYMMDD-<slug>`，slug 不得以四位十六进制字符结尾；revision 为三位递增数字；Task 为 `TASK-001`；run 和 dispatch 使用 `run_<ULID>`、`dispatch_<ULID>`。

文档使用 YAML frontmatter + 固定 Markdown 章节。正文默认中文，机器字段、ID、路径和命令使用 ASCII。`spec.md` 使用 `REQ-001` 和 `AC-001`；`plan.md` 与 Task 必须覆盖所有 REQ/AC，CLI 校验无遗漏、无未知引用。规划文件的 `plan_commit` 不写入自身提交，Git Operator 在提交后写入 SQLite；提交 trailer 包含 plan/revision/digest。

`ai-team init` 要求目标路径是 Git 仓库，幂等创建 `.ai-team` 结构，并在根 `.gitignore` 加入：

```gitignore
/.worktrees/
/.ai-team/runtime/
```

同时幂等创建根 `MEMORY.md` 与 `.ai-team/index/feature-navigation.md`。已有 `AGENTS.md` 或 `CLAUDE.md` 时追加一条上下文维护规则，但不创建不存在的指令文件。任何将被修改的上下文、指令或 `.gitignore` 文件存在未提交内容时，显示诊断并要求用户以 `--yes` 确认；不覆盖用户内容或规划目录冲突文件。

File Explorer 在代码搜索前读取已有 MEMORY 和导航索引，并返回严格的 `payload.project_context`。开发角色只通过 `ai-team context update` 合并领域术语、仓库约束、职责、模块边界和真实入口路径；结构重复、绝对/越界/敏感/不存在路径会阻断写入。入口、职责或模块边界变化时必须同轮更新并运行 `ai-team context validate`。

## 6. Researcher

Planning 或 Coding 只有在用户明确要求调研，或外部 API、框架、协议、许可证、安全公告、客户端能力等事实不确定时才调度 `researcher`。

Researcher 优先使用官方文档、标准、源码、维护者公告和安全公告；必要时补充二手来源。每个关键结论必须包含 URL、访问日期、适用版本和来源等级。报告区分 `fact`、`inference`、`recommendation`，不能把调研结果直接当作产品决定。

Planning 调研报告写入：

```text
.ai-team/plans/<plan-id>/revisions/<revision>/research/<topic>.md
```

并与同一 revision 的 spec/plan/tasks 一起由 Git Operator 提交。有 `plan_id`/`revision` 绑定的 Coding 实施期间产生的新报告同样归档到该 revision 的 `research/` 目录；无规划绑定的 bug/feature 调研才保存为 run artifact，不修改冻结 plan。若外部事实使方案失效，停止并转 Planning 新 revision。

## 7. Git、分支和 Worktree

Git Operator 只允许本地 Git 操作：worktree、分支、提交、diff 冻结、merge、reconcile 和安全清理。禁止 push、PR、tag、发布、远程分支修改、rebase、squash、cherry-pick、amend、reset、clean 和 stash。

Planning 不创建 worktree。Coding 使用 Planning 提交后的当前分支最新 `HEAD` 作为 `implementation_base_commit`，而不是使用旧的 `plan_commit`。Planned coding 启动时创建并由当前 run 持有 plan worktree；revision 使用现有三位数字，`TASK-001` 在 Git/path final segment 中规范化为小写 `task-001`：

```text
plan/<plan-id>/<plan-id>-<revision>
.worktrees/plans/<plan-id>/<plan-id>-<revision>/

task/<plan-id>/<plan-id>-<revision>--<task-id>
.worktrees/tasks/<plan-id>/<plan-id>-<revision>--<task-id>/
```

Direct Bug/feature 保持 run-scoped integration/task 结构：

```text
integration/<plan-or-direct-id>/<run-short-id>
.worktrees/integration/<plan-or-direct-id>/<run-short-id>/

task/<plan-or-direct-id>/<run-short-id>/<task-id>
.worktrees/tasks/<plan-or-direct-id>/<run-short-id>/<task-id>/
```

拆分 Task 从 plan worktree 当前 HEAD 派生，完成后以非快进提交合回 plan worktree；plan 全部完成并通过验证与评审后，再合入 run 的 `target_branch`。直接 Bug/feature 也使用独立 task worktree。无依赖且允许写入范围不重叠的 Task 可并行；有依赖的 Task 先合入 plan/integration 分支，再从其最新 commit 创建后续 Task。已存在且属于其他 run 或无法确认归属的分支/worktree/目录阻断，不复用、不覆盖。

开发代理自测后，Git Operator 创建实现提交；每次修复创建独立修复提交，禁止 amend。最终通过非快进 merge commit 合入用户明确选择的目标分支。目标分支漂移时最多同步 3 次；冲突由 Coding 委派对应开发代理解决，目标是保留两端已确认行为。冲突后运行完整最终验证，不重新双轴评审。成功集成且工作区干净后删除 task 及 plan/integration worktree；失败、暂停、`needs_decision` 或状态未知时保留。

## 8. 评审和验证

实现提交冻结后先由 `test` 独立运行 Task 要求的测试、构建、静态检查和回归命令，再执行一次评审。

Spec Review 检查正式 `spec.md` 的 REQ/AC 完成、非目标偏离、用户场景和兼容要求。Standard Review 按以下来源优先级检查：用户明确要求、Task/Plan 约束、项目指令文件、`.ai-team/standards`、工具配置/代码模式、通用工程实践。每个 finding 必须引用具体来源和证据。

严重级别：

```text
P0  安全、数据损坏或不可接受生产风险
P1  明确 Bug、需求缺失或高概率回归
P2  重要但不阻断的质量问题
P3  非阻断提醒
```

双轴评审每个冻结 revision 只执行一次。P0/P1 阻断，P2/P3 记录。Coding 一次性修复全部 P0/P1，并提交 `finding_id → 修改证据 → 验证证据` 映射；修复后只运行受影响测试和任务规定的最终完整验证，不重新启动评审或 Test Agent。任何无法修复/验证的 P0/P1 都返回 `needs_decision`，不得集成。

## 9. CLI 契约和 Agent 交互

### 9.1 用户/主 Agent 命令

```text
ai-team init <project>
ai-team install [--platform codex,claude,opencode] [--dry-run]
ai-team status [--project <path>]
ai-team context update --project <path> --context-file <json>
ai-team context validate --project <path>

ai-team planning start --project <path> (--request-file <file> | --request-stdin)

ai-team coding start --project <path> --mode planned --plan-id <id> [--revision <nnn>]
ai-team coding start --project <path> --mode bug (--request-file <file> | --request-stdin)
ai-team coding start --project <path> --mode feature (--request-file <file> | --request-stdin)

ai-team run show <run-id>
ai-team run resume <run-id>
ai-team run decide --run-id <id> --decision-id <id> --choice <id> [--note-file <file>]

ai-team env list
ai-team env show <name> [--resolved]
ai-team env validate <name>
ai-team env explain <name> --role <role> --platform <platform>
ai-team env diff <from> <to> [--role <role>] [--platform <platform>]
ai-team env edit <name>
ai-team env generate [--platform <list>] [--dry-run]
ai-team env switch <name> [--dry-run]
ai-team env status
ai-team env doctor [--probe]

ai-team backup restore <path> [--dry-run]
ai-team uninstall [--dry-run]
```

`planning/coding start` 由主 Agent 内部调用，普通用户直接输入自然语言。`planned` 禁止 request file；`bug/feature` 必须且只能提供 request file 或 stdin 之一。多个 `ready` plan 候选时必须让用户选择。

### 9.2 子 Agent 命令

```text
ai-team dispatch create --run-id <id> --role <role> --actor-role <role> --packet-file <file>
ai-team dispatch claim --run-id <id> --dispatch-id <id> --role <role>
ai-team dispatch prompt --run-id <id> --dispatch-id <id> --role <role>
ai-team dispatch schema --run-id <id> --dispatch-id <id> --role <role>
ai-team dispatch validate --run-id <id> --dispatch-id <id> --role <role> --result-file <file>
ai-team dispatch submit --run-id <id> --dispatch-id <id> --role <role> --result-file <file>
ai-team git status --run-id <id>
```

参数必须通过单一 typed command contract 校验。每个 dispatch 提供精确的只读 packet、冻结 prompt、schema 和已预填 result template。字段包含类型、required、枚举、格式、数量约束和空值语义；禁止未知字段。所有路径为仓库相对 POSIX 路径，时间为 RFC 3339 UTC，commit 为 40 位 SHA，ID 使用 CLI 生成值。

主 Agent 必须原样传递 CLI 生成的冻结 prompt；不得改写任务目标、范围、验收标准或返回字段。packet、冻结 prompt、result template 和结果 artifact 至少保留到 run 结束供恢复和审计；不保存模型思考内容。结果提交失败时使用 `dispatch validate` 返回 JSON Pointer 级错误，修复后再 submit。

### 9.3 结果信封

```json
{
  "schema_version": 1,
  "run_id": "run_01...",
  "dispatch_id": "dispatch_01...",
  "role": "file-explorer",
  "status": "completed",
  "summary": "...",
  "findings": [],
  "changes": [],
  "verification": [],
  "risks": [],
  "decisions_needed": [],
  "requested_support": [],
  "handoff": null,
  "payload": {}
}
```

状态固定为 `completed`、`retryable_failure`、`needs_decision`、`failed`。`completed` 必须有验收所需证据；临时失败记录 `failure_class` 和 `side_effect_state`；状态未知先 reconcile。大段输出写入脱敏 artifact，结果只保存引用、摘要和哈希。

### 9.4 用户决定

每次只存在一个当前 pending decision。主 Agent 必须展示 decision ID、问题、证据、候选 choice、推荐项和影响。用户自然语言回答由主 Agent 转换为结构化 choice，再提交：

```text
ai-team run decide --run-id <id> --decision-id <id> --choice <choice-id> [--note-file <file>]
```

旧 decision、未知 choice、无法唯一映射的“确认”均拒绝或继续澄清。需求清单确认、拆分颗粒度、分支迁移和冲突选择使用同一协议。

## 10. 状态库、恢复和并发

全局状态库默认位于 `~/.config/ai-team/state/state.sqlite`，按 Git common dir 生成 `repo_id` 隔离，并记录规范化项目路径。使用 `better-sqlite3 + Umzug`；只执行向前迁移，迁移前自动备份数据库、解析配置和 active environment，迁移失败恢复备份。

主要表：`repositories`、`runs`、`run_events`、`decisions`、`revisions`、`dispatches`、`artifacts`、`worktrees`、`operations`、`staging_entries`、`schema_migrations`。

代理 JSON 使用 `${AI_TEAM_HOME}/state/staging/<run-id>/<staging-id>.json` 的受管生命周期。根目录和 run 目录为 `0700`，文件为 `0600`；CLI 校验 UID、regular file、单 hardlink、真实路径、mode 和文件身份，并以同目录临时文件、文件 `fsync`、原子替换和目录同步发布不超过 2 MiB 的合法 JSON。`staging_entries` 只保存绑定、状态、SHA-256、大小和时间，不保存 JSON 原文，也不提升 `STATE_SCHEMA_EPOCH`。

默认 `staging.retention_hours` 为 168。业务失败保留内容；业务持久化后才消费，删除失败标记 `cleanup_pending`。`staging cleanup --expired` 完整清理过期项，指定 run/id 的清理必须显式 `--all`。升级时先发布兼容旧文件参数和 `--staging-id` 的 CLI，再生成或安装新版代理；不扫描、迁移或删除历史 `$TMPDIR/opencode` 文件。

所有副作用先写 operation，再执行，再写完成证据。重复 submit、重复 claim、重复 Git 操作使用幂等键；副作用明确未发生时可重试，明确已完成时复用，状态未知时阻断并 reconcile。网络超时、客户端进程异常和临时资源错误最多重试 2 次；认证、权限、配置、非法 schema 和未知副作用不自动重试、不换模型、不换平台。

多 run 可并存；File Explorer、Researcher、Test 和 Review 可在无冲突时并行，Git mutation 按 repo/ref/path 串行。数据库、配置和仓库操作使用文件锁。运行状态不依赖对话记忆恢复，必须从 SQLite、冻结文档、Git 事实和 artifact 恢复。

## 11. 全局环境和 Agent 生成

配置根目录为 `~/.config/ai-team/`，可由 `AI_TEAM_HOME` 覆盖：

```text
~/.config/ai-team/
├── config.yaml
├── environments/
│   ├── defaults.yaml
│   ├── quality.yaml
│   ├── balanced.yaml
│   └── economy.yaml
├── state/
│   └── staging/<run-id>/<staging-id>.json
├── backups/
├── schemas/
└── templates/
```

配置为 YAML + JSON Schema。环境只允许单层 defaults + overrides，不允许环境互相继承。默认激活 `balanced`。每个启用平台的 12 个角色都必须解析为明确平台原生模型配置：

```yaml
codex:
  model: string
  reasoning: string
claude:
  model: string
  effort: string
opencode:
  model: string
  variant: string
  options: object
```

推理强度不支持时阻断对应平台生成并提示用户修改；不自动降级、映射或静默忽略。三个客户端的最低版本和已验证版本写入全局配置：低于最低版本阻断，高于已验证范围警告。环境切换不发送模型请求；`env doctor --probe` 才执行显式真实探测。

生成目标：

```text
~/.codex/agents/<role>.toml
~/.claude/agents/<role>.md
~/.config/opencode/agents/<role>.md
```

安装同时修改或创建：

```text
~/.codex/AGENTS.md
~/.claude/CLAUDE.md
~/.config/opencode/AGENTS.md
```

全局指令只写受管理区块，按需激活 `planning/coding`，不影响普通会话。安装、更新和环境切换先在 staging 目录生成全部启用平台文件，再验证格式、角色全集、模型/强度、最低版本、权限、managed marker 和 digest，最后原子替换。任一启用平台失败，整笔事务回滚。

同名非受管理 Agent 按已确认策略先备份后覆盖，每个原路径只保留最新版备份。角色删除或重命名时：旧文件先备份；只有 managed marker 和原摘要匹配的文件才自动移除；未知或用户修改过的文件阻断；新角色按新 ID 生成；manifest 记录删除/重命名映射。卸载只删除匹配的受管理 Agent 和管理区块，不自动恢复备份；恢复必须通过用户显式执行 `backup restore`。

## 12. 平台 Agent 渲染

角色事实源由 manifest 定义职责、输入/输出 schema、允许 CLI 命令、允许读取/写入路径、委派关系、停止条件和 enforcement 能力。Codex、Claude Code、OpenCode 只负责渲染格式，不改变角色职责、状态机或结果 schema。

每个生成 Agent 包含 managed marker、role id、模板版本、平台、环境、模型/推理配置、contract digest、角色允许命令和精确参数类型说明。平台不支持的硬约束标记为 `unsupported` 时阻断生成；`instruction` 只能表示无法机械执行但仍需提示和评审的软约束。

OpenCode 文件必须以 YAML frontmatter 开头，使客户端能解析角色模式。`planning` 和 `coding` 使用 `mode: primary`；其余角色使用 `mode: subagent` 与 `hidden: true`，只能由主代理委派，不出现在用户的主代理切换列表中。

## 13. 安装、初始化和卸载

`ai-team init` 必须在 Git 仓库内运行，幂等创建 `.ai-team`、`.gitignore` 条目和目标项目上下文骨架；只向已有 `AGENTS.md/CLAUDE.md` 追加维护规则。将被修改的上下文、指令或 `.gitignore` 文件有未提交内容时展示诊断并要求确认。目标项目上下文属于源码，由用户决定何时提交。

`ai-team install` 修改/创建全局指令文件；文件存在时按路径创建最新版备份，使用 managed marker 保留用户内容。安装不修改项目代码、不创建 Git 提交、不修改用户 shell profile。已运行的客户端会话继续使用旧 Agent，新会话加载新版本。

`ai-team uninstall --dry-run` 先输出精确清单；实际卸载只移除内容摘要匹配的受管理 Agent 和 managed 区块。备份、SQLite、项目 `.ai-team` 文档和环境配置不自动删除。

## 14. 安全边界

- 默认拒绝 `.env*`、凭据/密钥目录以及 `.ai-team/runtime` 的业务写入。
- 鉴权、支付、生产基础设施、迁移等敏感任务必须进入正式 Planning。
- 不保存认证内容、环境变量、完整提示词、模型思考内容或完整未脱敏命令输出。
- artifact 写入前执行常见 token/key 模式基础脱敏；无法安全持久化时只保存退出码和摘要。
- 所有路径 canonicalize，拒绝符号链接逃逸。
- Git 命令使用固定参数数组，禁止自由 shell 拼接。
- v1 不提供 token、密钥、容器沙箱、远程策略中心、遥测或恶意本地进程防护。

## 15. 测试和验收

测试必须覆盖：

1. Command contract、参数类型、模式互斥、result envelope、角色 payload、退出码和 contract digest。
2. YAML defaults/overrides、平台配置、模型/推理能力、版本门禁和环境事务回滚。
3. Umzug migration、迁移备份恢复、幂等提交、状态迁移和并发锁。
4. Planning 逐问、需求清单确认、spec/plan 生成、Task 预览循环和 revision 不可变。
5. Coding planned/bug/feature 分诊、脏工作区、分支迁移、最新 HEAD 基线和范围三次门禁。
6. File Explorer 独占发现、严格 `project_context`、Researcher 报告及其 Planning/Coding 委派边界。
7. 上下文初始化、幂等合并、重复章节拒绝、真实路径校验、指令规则和原子失败恢复。
8. Git worktree、依赖 Task integration、冲突解决、目标分支漂移、非快进 merge 和清理。
9. 一次 Spec/Standard 评审、一次性 P0/P1 修复、无复审和最终验证门禁。
10. Codex TOML、Claude Markdown、OpenCode Markdown/AGENTS.md 的生成、回读和 drift 检查。
11. managed 文件备份、角色删除/重命名、卸载和 restore 冲突。
12. 路径 canonicalize、符号链接逃逸、敏感输出脱敏和未知副作用 reconcile。
13. 临时 Git 仓库中的端到端 Planning、拆分/不拆分 Coding、直接 Bug、小功能、Researcher 和环境切换回滚。

验收标准：启用平台全部 `in-sync`；12 个角色、委派图、模型配置和 contract digest 一致；所有 schema 严格通过；临时 Git 仓库可完成完整生命周期；SQLite 可从空库和上一版本迁移；不执行真实模型调用的测试全部通过；真实客户端探测仅由 `env doctor --probe` 触发。

## 16. 实施顺序

1. 初始化 TypeScript ESM 包、Node 版本约束、CLI 骨架、退出码和日志输出。
2. 实现单一 typed contract、JSON Schema、命令 parser、结果 envelope 和 digest。
3. 实现 YAML 配置、defaults/overrides、平台能力和环境校验。
4. 实现 better-sqlite3、Umzug、repo identity、迁移备份、事件和锁。
5. 实现 dispatch packet、冻结 prompt、schema/template、validate/submit 和 decision。
6. 实现 Planning/Coding 状态机、revision、REQ/AC 追踪和 Task 预览循环。
7. 实现 Git Operator、最新 HEAD 基线、task/integration worktree、merge、reconcile 和清理。
8. 实现 12 个角色 manifest、File Explorer/Researcher 边界、双轴评审和一次性修复门禁。
9. 实现 Codex/Claude Code/OpenCode 渲染器、全局指令 managed 区块、安装/更新/卸载/备份事务。
10. 完成 macOS 集成测试、迁移测试、CLI 帮助、schema 文档和 npm 打包发布。

## 17. 一致性结论

本方案已与最终需求清单对齐，特别明确了：

- `coding start` 的模式化参数和 `planned` 的 plan 绑定。
- Planning 与 Coding 均可按需调度 Researcher，但 Researcher 不搜索仓库。
- packet、冻结 prompt、result template 至少保留到 run 结束。
- 角色删除/重命名的备份、摘要匹配和阻断规则。
- task、integration 分支和 `.worktrees` 的精确命名及最新基线。
- Environment Operator 不得由普通 Coding run 切换环境。

除用户后续明确修订外，以上内容是 AI Team v1 的实现事实来源。
