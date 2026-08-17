---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# TASK-001：收紧 dispatch packet 与路径授权契约

- 需求覆盖：REQ-003、REQ-004、REQ-005
- 验收覆盖：AC-004、AC-005
- 目标：公开并验证 phase/role context，返回精确 JSON pointer，统一 `.` 的项目根递归授权语义。
- 读取范围：`src/contracts.ts`、`src/dispatch.ts`、`src/security.ts`、`src/cli.ts` 及对应测试。
- 写入范围：packet contract、validation、scope matcher、CLI schema/template 和聚焦测试。
- 允许写入路径：`src/contracts.ts`、`src/dispatch.ts`、`src/security.ts`、`src/cli.ts`、`test/core.test.ts`、`test/review-fixes.test.ts`、`test/cli-e2e.test.ts`
- 依赖：无
- 实现步骤：
  1. 定义按 phase/role 适用的必填 context 并用于 runtime validation。
  2. 扩展 schema/template 公开 `explorer_dispatch_id`、`worktree_id` 等上下文。
  3. 将 unknown-field detail 统一为 JSON pointer 风格。
  4. 统一 `.` 在授权继承和 scope matcher 中的项目根递归语义。
  5. 增加合法、缺失、未知字段、递归授权和越界拒绝测试。
- 验收标准：AC-004、AC-005 全部通过。
- 自测命令：`npm run typecheck && node --import tsx --test test/core.test.ts test/review-fixes.test.ts test/cli-e2e.test.ts`
- 交接内容：packet context 规则、schema/template 示例、scope 语义与测试证据。
