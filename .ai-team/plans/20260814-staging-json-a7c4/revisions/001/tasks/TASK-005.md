---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# TASK-005：执行独立回归与发布门禁

- 需求覆盖：REQ-011, REQ-012
- 验收覆盖：AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010, AC-011, AC-012, AC-013, AC-014, AC-015
- 目标：独立验证冻结规格的全部安全、生命周期、兼容、脱敏、生成和真实平台门禁。
- 读取范围：冻结 revision 允许的全部实现、测试、文档和生成资产。
- 写入范围：仅必要时最小修改 `package.json` 验证脚本；不得修改实现或测试以掩盖失败。
- 允许写入路径：`package.json`
- 依赖：TASK-001, TASK-002, TASK-003, TASK-004
- 实现步骤：
  1. 运行五个目标测试文件和跨边界攻击回归。
  2. 运行三平台生成和真实 OpenCode 完整流程。
  3. 运行 context validate 与 `npm run verify`。
  4. 返回退出码、证据和回滚建议。
- 验收标准：AC-001..AC-015 均有通过证据，`npm run verify` 返回 0。
- 自测命令：`npm run verify`
- 交接内容：命令、退出码、诊断、发布与回滚结论。
