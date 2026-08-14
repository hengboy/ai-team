---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# TASK-001：实现 staging 核心存储、安全与生命周期

- 需求覆盖：REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-007
- 验收覆盖：AC-001, AC-002, AC-003, AC-004, AC-005, AC-007, AC-008, AC-011
- 目标：在 `state/staging` 建立受管 JSON 文件和 SQLite 元数据状态机，提供安全、原子、可恢复的底层生命周期。
- 读取范围：`src/home.ts`, `src/state.ts`, `src/security.ts`, `src/utils.ts`, `src/constants.ts`, `src/contracts.ts`, `test/core.test.ts`
- 写入范围：同读取范围。
- 允许写入路径：`src/home.ts`, `src/state.ts`, `src/security.ts`, `src/utils.ts`, `src/constants.ts`, `src/contracts.ts`, `test/core.test.ts`
- 依赖：无
- 实现步骤：
  1. 定义 staging path、kind、metadata 和状态转换。
  2. 新增 forward-only migration，保持 `STATE_SCHEMA_EPOCH`。
  3. 实现 0700/0600、2 MiB、JSON、原子写与 fsync。
  4. 实现 UID/regular/link/realpath/mode 与 path replacement 防护。
  5. 实现 retention、expired 和 cleanup_pending，并确保无原文审计。
- 验收标准：AC-001, AC-002, AC-003, AC-004, AC-005, AC-007, AC-008, AC-011 全部通过。
- 自测命令：`node --import tsx --test test/core.test.ts`
- 交接内容：API、migration、状态图、安全不变量、测试证据。
