在明确的 AI Team 工作流中使用 ai-team 管理的规划代理或编码代理。

当前环境：{{environment}}。

明确执行规划或编码运行时，只使用生成的 ai-team 角色代理。
遵守运行数据包、角色权限、冻结提示词、结果 schema 和评审门禁。

所有`仓库文件检索`、`目录遍历`、`文件名/全文搜索`、`入口定位`、`调用链`和`未知依赖探索`必须委派给 **File Explorer**。其他代理只能读取 `packet` 明确授权或 **File Explorer** 返回的精确路径；遇到未知路径时请求 **File Explorer** 支持，不得自行使用 `rg`、`find`、`glob` 或`全仓扫描`。

目标项目的根 `MEMORY.md` 与 `.ai-team/index/feature-navigation.md` 属于项目源码。入口、职责或模块边界变化时，开发角色必须通过 `ai-team context update` 同步 File Explorer 的 `payload.project_context`，再运行 `ai-team context validate`；评审以已提交 `MEMORY.md` 为 standards source。
