# 代理命令生命周期

生成的 `planning` 和 `coding` 代理按以下顺序工作：

1. 启动运行并接收首个 File Explorer 调度。
2. 领取调度，读取冻结提示词和 schema，然后提交严格结果。
3. 按需创建其他角色调度，或创建唯一一个待用户处理的决策。
4. `planning` 写入不可变修订，并且只沿合法状态边推进。
5. `planned` coding 启动时创建归属当前 run 的 plan worktree，拆分 Task 从其当前 HEAD 派生并合回；direct coding 请求 Git Operator 准备 run-scoped worktree，并且只提交允许路径。
6. `test` 在评审门禁前完成独立验证。
7. Code Reviewer 对要求的冻结 Spec/Standards 结果各提交一次。
8. `coding` 为每个 P0/P1 提供修改证据和验证证据并完成处理。
9. Git Operator 执行最终的非快进目标合并和安全清理。

调度成功后，CLI 自动推进已持久化的阶段。`planning` 在创建 worktree
前校验 Task 依赖图。发生合并冲突时，指定开发代理只能处理允许路径，Git
Operator 以新提交继续合并，`test` 执行完整最终门禁，不再创建第二个评审门禁。

创建或修改状态的命令即使出现在 CLI 帮助中，也属于内部代理命令。平台渲染器
只输出角色 manifest 允许的命令。普通叶子代理不能创建调度，也不能执行 Git 变更。

仓库探索仅由 File Explorer 执行。其他代理使用 packet 中的路径，发现未知依赖时
请求支持。Researcher 从 File Explorer 接收项目上下文，并以 `fact`、`inference`
或 `recommendation` 类型写入带引用的结论；它不搜索目标仓库。

File Explorer 还会返回 `payload.project_context`，其中包含项目形态、四组受管
MEMORY 条目、模块边界、导航条目和维护状态。开发代理通过 `context update`
更新目标项目的 `MEMORY.md` 与 `.ai-team/index/feature-navigation.md`；`test`
和评审角色在完成前校验这些文件。

## 受管 staging 生命周期

代理不得直接把临时 JSON 写入 `$TMPDIR`、目标项目或任何 `AI_TEAM_HOME` 路径。
角色只能为自身声明的 `staging.owned_entries` 创建条目，通过 stdin 写入 JSON，
再把不透明 ID 传给业务命令。创建 `dispatch-result` 时必须提供 dispatch ID，
其初始内容为对应调度的冻结结果模板。

条目从 `draft` 进入 `ready`，业务持久化成功后进入 `consumed`。`draft` 和
`ready` 可以重写。validate 和 Task preview 不消费条目；输入无效或业务命令失败时，
系统记录不含原文的 `staging.validation_failed` 事件，其中保留 JSON pointer、constraint 和修复建议，并保留条目供修正。删除失败
时进入 `cleanup_pending`，到期时进入 `expired`。

```text
ai-team staging create --run-id <run-id> --role <role> --kind <kind> [--dispatch-id <dispatch-id>]
ai-team staging write --run-id <run-id> --role <role> --staging-id <staging-id> --input-stdin
ai-team staging show --run-id <run-id> --role <role> [--staging-id <staging-id>] [--content]
ai-team staging cleanup --expired
ai-team staging cleanup --run-id <run-id> [--staging-id <staging-id>] --all
```

所有 JSON 消费命令都保留旧文件参数，并接受与之互斥的 `--staging-id`。
`context update` 和 `planning tasks validate` 在 staging 模式下还必须提供
`--run-id`。系统在产生业务副作用前校验 run、dispatch、role 和 kind 绑定。
