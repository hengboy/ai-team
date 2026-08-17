---
name: setup-ai-team
description: 在目标 Git 仓库中设置、初始化或重新初始化 AI Team，并验证生成的项目上下文。当用户要求 setup ai-team、运行 ai-team init、创建 .ai-team 项目文件，或验证生成的 MEMORY.md 和功能导航上下文时使用。
---

# 设置 AI Team

使用已安装的 `ai-team` CLI 初始化用户指定的 Git 项目，委派 File Explorer 根据目标仓库的实际入口生成项目上下文，保留覆盖确认边界，并验证写入结果。

## 工作流程

1. 获取用户指定的目标项目路径。如果路径缺失或含糊，先询问用户再运行命令。不要默认使用当前仓库。
2. 在不修改目标项目的前提下检查依赖：

   ```sh
   command -v ai-team
   git -C <project> rev-parse --show-toplevel
   ```

   后续所有命令都使用第二条命令返回的规范 Git 根目录。如果任一命令失败，停止并报告诊断信息。
3. 委派 File Explorer 只读探索规范 Git 根目录。不得由其他角色执行宽范围搜索，也不得根据目录名或 manifest 猜测功能。要求 File Explorer 返回一个 JSON 对象，其中 `payload.project_context` 满足以下约束：
   - `project_shape` 描述实际项目形态。
   - `memory` 基于仓库证据列出领域术语、仓库约束、职责和模块边界。
   - `navigation` 按已确认的功能或模块列出 `feature`、`keywords`、`entry_paths` 和 `module_boundary`。
   - 每个 `entry_paths` 值都是真实存在、仓库相对、未越界且非敏感的入口路径。
   - 如果仓库没有可证实的功能入口，返回空 `navigation` 并明确说明原因，不要虚构条目。
4. 首次初始化时不要附加确认参数：

   ```sh
   ai-team init <canonical-project-root>
   ```

5. 检查命令返回的 JSON 结果。
   - 初始化成功时，继续执行验证。
   - 如果初始化因现有 `.gitignore`、项目上下文或指令文件包含未提交修改而失败，展示返回的脏文件路径，并询问用户是否覆盖这些明确列出的文件。
   - 在用户明确确认前，不要添加 `--yes`、重试或推定用户同意。
   - 如果因其他原因失败，停止并报告命令错误及详细信息。
6. 用户明确确认覆盖所报告的脏文件后，只重试一次：

   ```sh
   ai-team init <canonical-project-root> --yes
   ```

   不要将本次确认用于其他路径或之后的运行。如果重试失败，立即停止。
7. 初始化成功后，将 File Explorer 的完整 JSON 结果写入目标仓库之外的临时文件，并执行：

   ```sh
   ai-team context update --project <canonical-project-root> --context-file <explorer-result-json>
   ```

   检查返回的 `data.context`，确认其中包含 File Explorer 报告的项目形态、内存信息和导航条目。无论命令成功或失败，都删除临时文件；不要把探索结果文件留在目标仓库中。如果更新失败，停止并报告验证详情，不要跳过更新继续声称初始化完成。
8. 验证初始化后的上下文：

   ```sh
   ai-team context validate --project <canonical-project-root>
   ```

9. 仅在上下文更新成功，且验证 JSON 结果同时满足以下条件时报告成功：
   - `data.valid` 等于 `true`
   - `data.maintenance.status` 等于 `current`

   否则，报告相关的 `memory.issues`、`navigation.issues`、`navigation.invalid_paths`、指令文件状态和 `maintenance.paths`。上下文仍待维护时，不要声称初始化已完成。

## 边界

- 只使用上述公开 `ai-team` 命令写入和验证目标项目，不要重新实现或修改其行为。
- 不要检查凭据、`.env*`、`.ai-team/runtime` 或与验证问题无关的文件。
- 除非用户另行明确要求，否则不要提交、合并、推送或以其他方式修改 Git 历史。
- 只有取得本次目标仓库的 File Explorer 证据后才能运行 `ai-team context update`；不得复用其他仓库或旧探索结果。
