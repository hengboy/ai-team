---
name: switch-ai-team-env
description: 预检并切换 AI Team 的全局环境配置。当用户要求切换 ai-team 环境、在 balanced、quality、economy 或自定义环境之间切换、预览切换影响，或验证切换后的受管代理状态时使用。
---

# 切换 AI Team 环境

使用已安装的 `ai-team` CLI 验证目标环境、预览受管文件变更，在用户确认后切换，并检查切换结果。

## 工作流程

1. 获取用户指定的目标环境名。如果缺失或含糊，先询问用户；不要默认选择环境。
2. 在不切换 active environment 或写入受管 agent 文件的前提下检查 CLI 和可用环境：

   ```sh
   command -v ai-team
   ai-team env list
   ```

   首次运行 `env list` 可能初始化 AI Team 全局配置。仅继续处理列表中与用户输入完全一致的环境名。如果 CLI 不存在或目标环境不存在，停止并报告。
3. 验证目标环境：

   ```sh
   ai-team env validate <name>
   ```

   验证失败时不要尝试切换或编辑环境文件。
4. 预览实际切换计划：

   ```sh
   ai-team env switch <name> --dry-run
   ```

   汇总计划中的 `writes`、`backups`、`removals` 和 `blocked`。如果存在 `blocked`，停止并报告对应路径；不要覆盖 drifted 文件。
5. 展示目标环境和预览摘要，询问用户是否执行本次切换。用户明确确认前，不要运行无 `--dry-run` 的命令。
6. 用户确认后执行一次：

   ```sh
   ai-team env switch <name>
   ```

   如果版本门禁、drift 或其他错误阻止切换，立即停止并原样报告错误详情。
7. 检查受管文件状态：

   ```sh
   ai-team env status
   ```

   仅当切换命令成功，且状态中没有 `missing` 或 `drifted` 时报告切换完成。保留 `disabled` 状态并向用户说明，不把它当作切换失败。

## 可选差异说明

如果用户同时给出来源环境，或明确要求比较环境，再运行：

```sh
ai-team env diff <from> <name>
```

不要猜测当前来源环境，也不要直接读取或修改内部配置文件来推断它。

## 边界

- 只使用公开的 `ai-team env` 命令，不重新实现环境解析或写入逻辑。
- 不自动运行 `env edit`、`backup restore`、`install` 或 `uninstall`。
- 不读取凭据、`.env*` 或与切换结果无关的用户文件。
- 除非用户另行明确要求，否则不要提交、推送或修改任何项目仓库。
