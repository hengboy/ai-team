---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# TASK-002：接入 staging CLI 与全部 JSON 消费命令

- 需求覆盖：REQ-001, REQ-005, REQ-006, REQ-007, REQ-008
- 验收覆盖：AC-001, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010
- 目标：新增 staging CLI，并用固定 kind 统一接入全部 10 类 JSON 消费命令。
- 读取范围：TASK-001 交接；`src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts`
- 写入范围：同列出的源码和测试。
- 允许写入路径：`src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts`
- 依赖：TASK-001
- 实现步骤：
  1. 注册 create/write/show/cleanup。
  2. 接入 10 kind、旧参数互斥和 staging `--run-id` 规则。
  3. 实现绑定、非消费校验、成功持久化后消费和 cleanup_pending。
  4. 用冻结 template 初始化并绑定 dispatch-result。
- 验收标准：AC-001, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010 全部通过。
- 自测命令：`node --import tsx --test test/cli-e2e.test.ts`
- 交接内容：syntax、kind 映射、消费时序、兼容 E2E 证据。
