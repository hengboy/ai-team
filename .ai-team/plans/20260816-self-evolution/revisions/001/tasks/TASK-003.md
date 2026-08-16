---
plan_id: 20260816-self-evolution
revision: "001"
target_branch: main
supersedes: null
---

# TASK-003：综合回归验证与发布门禁

- 需求覆盖：REQ-001、REQ-002、REQ-003、REQ-004、REQ-005、REQ-006、REQ-007、REQ-008
- 验收覆盖：AC-001、AC-002、AC-003、AC-004、AC-005、AC-006、AC-007、AC-008、AC-009、AC-010、AC-011、AC-012
- 目标：完成跨模块回归、失败隔离、兼容性和发布门禁验证。
- 读取范围：前置任务交接、全部相关测试和生成资产。
- 写入范围：仅 `test/**`。
- 允许写入路径：`test/**`
- 依赖：TASK-001、TASK-002
- 实现步骤：
  1. 覆盖默认关闭、完成、阻塞、决策等待、恢复和重复终态。
  2. 覆盖报告失败、敏感值、旧数据和 decision replay。
  3. 验证多平台生成资产与项目上下文。
  4. 运行全部静态、测试、构建和 verify 门禁。
- 验收标准：
  - AC-001 至 AC-012 均有通过证据。
- 自测命令：`npm run typecheck && npm run lint && npm test && npm run build && npm run verify`
- 交接内容：命令结果、残余风险、发布和回滚建议。
