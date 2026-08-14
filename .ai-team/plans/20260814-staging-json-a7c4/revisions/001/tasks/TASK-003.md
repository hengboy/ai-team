---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# TASK-003：更新命令契约、配置、角色权限与三平台代理

- 需求覆盖：REQ-005, REQ-006, REQ-009, REQ-012
- 验收覆盖：AC-009, AC-011, AC-012, AC-013, AC-015
- 目标：将 staging 能力同步到配置、统一命令契约、角色所有权和三平台生成资产。
- 读取范围：TASK-001/TASK-002 交接；`src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/**`, `test/environment.test.ts`, `test/agent-build.test.ts`
- 写入范围：命令/环境/生成模块，agent-build manifest/instructions/environments/roles，生成测试。
- 允许写入路径：`src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/manifest.yaml`, `agent-build/instructions.md`, `agent-build/environments/balanced.yaml`, `agent-build/environments/economy.yaml`, `agent-build/environments/quality.yaml`, `agent-build/roles/*.yaml`, `agent-build/roles/planning.md`, `test/environment.test.ts`, `test/agent-build.test.ts`
- 依赖：TASK-001
- 实现步骤：
  1. 增加 retention 配置默认值和规范化。
  2. 更新统一命令语法、参数类型与角色权限。
  3. 禁止直接临时路径写入，显示 writes/owned entries。
  4. 提升模板版本并重新生成 Codex/Claude/OpenCode。
- 验收标准：AC-009, AC-011, AC-012, AC-013, AC-015 全部通过。
- 自测命令：`node --import tsx --test test/environment.test.ts test/agent-build.test.ts`
- 交接内容：配置差异、角色矩阵、模板/digest、三平台生成证据。
