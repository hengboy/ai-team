---
name: git-commit
description: 在已授权的实现完成并通过验证后，生成规范的提交消息并创建精确范围的本地 Git 提交。同时支持 AI Team 的受控 action 和不使用 AI Team 的普通仓库；当用户要求提交已完成的代码改动时使用。
---

# 结果目标

创建一个范围准确、检查通过的本地提交，不带入范围外改动。

# 必要前置条件

- 用户已明确授权创建本地提交。
- 目标改动已完成，且有与当前改动对应的检查或验收证据。
- 在 AI Team action 中，input 还必须包含 run、worktree、base commit、完整 PathChange、允许范围和 dispatch 命令。
- 在普通仓库中，从用户请求和当前 diff 确定完整的仓库相对路径范围。如果不能把目标改动与其他改动按路径分开，停止并请求用户决定。
- 提交格式见 `references/commit-message.md`。

# 步骤

1. 确认当前仓库、HEAD、工作区和暂存区状态。根据允许范围检查目标 diff，不修改或清理范围外改动。
2. 根据已验证的结果和路径变更选择最准确的 type、可选 scope 与中文摘要，按引用规范生成提交消息。摘要只描述本次结果，不扩大范围。
3. 选择执行路径：
   - AI Team：仅运行 dispatch 提供的精确 `ai-team git commit ... --message <message> --scope <paths>` 命令。不得直接运行 `git commit`，不得添加 packet 未授权的参数。
   - 普通仓库：记录当前 HEAD，运行 `git add -- <paths>` 仅暂存目标路径，再运行 `git commit --only --message <message> -- <paths>`。必须传入精确的仓库相对路径；不使用包含范围外文件的目录路径，不使用 `.`。`--only` 用于避免带入已存在的其他暂存改动。
4. 验证新的 commit SHA、提交消息和已提交路径，并确认范围外的工作区或暂存区改动仍保留。
5. AI Team 路径按固定 `TaskResult` 返回 commit SHA、检查和 PathChange；普通仓库路径返回 commit SHA、消息、已提交路径和检查结果。

# 条件分支

- hook 或检查失败：保留 index/worktree 现场，返回真实错误，不 reset、clean 或自动重试。
- 范围或 HEAD 在检查后发生变化：停止并返回真实错误，不自行扩大提交范围。
- 普通仓库中没有可提交的目标改动，或目标路径中混有未授权改动：不创建提交，说明需要的用户决定。

# 最终验收

提交仅存在本地，消息符合约定，提交范围与用户或 action 授权范围精确一致，没有 push、amend、stash、reset、clean 或 tag。
