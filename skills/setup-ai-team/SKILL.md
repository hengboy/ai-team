---
name: setup-ai-team
description: 在目标 Git 仓库中设置、初始化或重新初始化 AI Team，并验证生成的项目上下文。当用户要求 setup ai-team、运行 ai-team init、创建 .ai-team 项目文件，或验证生成的 MEMORY.md 和功能导航上下文时使用。
---

# 设置 AI Team

使用已安装的 `ai-team` CLI 初始化用户指定的 Git 项目，保留覆盖确认边界，并验证生成的项目上下文。

## 工作流程

1. 获取用户指定的目标项目路径。如果路径缺失或含糊，先询问用户再运行命令。不要默认使用当前仓库。
2. 在不修改目标项目的前提下检查依赖：

   ```sh
   command -v ai-team
   git -C <project> rev-parse --show-toplevel
   ```

   后续所有命令都使用第二条命令返回的规范 Git 根目录。如果任一命令失败，停止并报告诊断信息。
3. 首次初始化时不要附加确认参数：

   ```sh
   ai-team init <canonical-project-root>
   ```

4. 检查命令返回的 JSON 结果。
   - 初始化成功时，继续执行验证。
   - 如果初始化因现有 `.gitignore`、项目上下文或指令文件包含未提交修改而失败，展示返回的脏文件路径，并询问用户是否覆盖这些明确列出的文件。
   - 在用户明确确认前，不要添加 `--yes`、重试或推定用户同意。
   - 如果因其他原因失败，停止并报告命令错误及详细信息。
5. 用户明确确认覆盖所报告的脏文件后，只重试一次：

   ```sh
   ai-team init <canonical-project-root> --yes
   ```

   不要将本次确认用于其他路径或之后的运行。如果重试失败，立即停止。
6. 验证初始化后的上下文：

   ```sh
   ai-team context validate --project <canonical-project-root>
   ```

7. 仅在 JSON 结果同时满足以下条件时报告成功：
   - `data.valid` 等于 `true`
   - `data.maintenance.status` 等于 `current`

   否则，报告相关的 `memory.issues`、`navigation.issues`、`navigation.invalid_paths`、指令文件状态和 `maintenance.paths`。上下文仍待维护时，不要声称初始化已完成。

## 边界

- 只使用上述公开 `ai-team` 命令，不要重新实现或修改其行为。
- 不要检查凭据、`.env*`、`.ai-team/runtime` 或与验证问题无关的文件。
- 除非用户另行明确要求，否则不要提交、合并、推送或以其他方式修改 Git 历史。
- 不要自动运行 `ai-team context update`。验证结果可能需要 File Explorer 证据和单独的上下文维护任务。
