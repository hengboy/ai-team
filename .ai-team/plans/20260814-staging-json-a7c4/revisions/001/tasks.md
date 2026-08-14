---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# 任务拆分

## 任务清单

### TASK-001：实现 staging 核心存储、安全与生命周期

- 需求覆盖：REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-007
- 验收覆盖：AC-001, AC-002, AC-003, AC-004, AC-005, AC-007, AC-008, AC-011
- 目标：提供安全、原子、可审计且不保存原文的 staging 底层 API 与前向迁移。
- 读取范围：`src/home.ts`, `src/state.ts`, `src/security.ts`, `src/utils.ts`, `src/constants.ts`, `src/contracts.ts`, `test/core.test.ts`
- 写入范围：核心 home/state/security/contracts 与单元测试。
- 允许写入路径：`src/home.ts`, `src/state.ts`, `src/security.ts`, `src/utils.ts`, `src/constants.ts`, `src/contracts.ts`, `test/core.test.ts`
- 依赖：无
- 实现步骤：
  1. 为 `state/staging`、固定 kind、条目元数据和状态定义最小契约。
  2. 新增 forward-only `staging_entries` migration，不提升 `STATE_SCHEMA_EPOCH`。
  3. 实现 0700/0600、2 MiB、JSON 校验、同目录临时文件、文件/目录同步和原子替换。
  4. 实现 UID、regular file、单硬链接、realpath、mode、symlink/hardlink/path replacement 防护。
  5. 实现 draft/ready/consumed/cleanup_pending/expired、168 小时保留和 cleanup 核心逻辑。
- 验收标准：
  - 核心状态与安全矩阵覆盖所有允许/拒绝路径，持久状态与审计不含原文。
- 自测命令：`node --import tsx --test test/core.test.ts`
- 交接内容：staging API、migration、错误语义、故障注入点及通过的核心测试证据。

### TASK-002：接入 staging CLI 与全部 JSON 消费命令

- 需求覆盖：REQ-001, REQ-005, REQ-006, REQ-007, REQ-008
- 验收覆盖：AC-001, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010
- 目标：交付 staging CLI，并使全部 10 类消费者支持安全且向后兼容的 `--staging-id`。
- 读取范围：TASK-001 交接；`src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts`
- 写入范围：CLI、dispatch/planning 适配与 CLI E2E。
- 允许写入路径：`src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts`
- 依赖：TASK-001
- 实现步骤：
  1. 注册 `staging create/write/show/cleanup`，保持 show/validate/preview 的只读语义。
  2. 为 10 个固定 kind 接入 `--staging-id`，与旧文件参数互斥且兼容。
  3. 校验 run/dispatch/role/kind，并强制 context update 与 planning tasks staging 模式的 `--run-id`。
  4. 将消费提交点放在最终业务成功持久化之后；删除失败转 `cleanup_pending`。
  5. 用 dispatch 冻结 template 初始化并绑定 `dispatch-result`，验证可重写与不可复用状态。
- 验收标准：
  - 10 kind 表驱动、新旧参数、跨边界、validate/preview、失败重试和成功消费 E2E 全部通过。
- 自测命令：`node --import tsx --test test/cli-e2e.test.ts`
- 交接内容：CLI syntax、kind/旧参数映射表、消费时序、E2E 证据和兼容性说明。

### TASK-003：更新命令契约、配置、角色权限与三平台代理

- 需求覆盖：REQ-005, REQ-006, REQ-009, REQ-012
- 验收覆盖：AC-009, AC-011, AC-012, AC-013, AC-015
- 目标：把兼容 CLI 能力准确投射到配置、命令契约、角色权限和 Codex/Claude/OpenCode 生成资产。
- 读取范围：TASK-001 API 与 TASK-002 CLI 契约；`src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/**`, `test/environment.test.ts`, `test/agent-build.test.ts`
- 写入范围：统一契约、环境/生成逻辑、manifest/instructions/environments/roles 和生成测试。
- 允许写入路径：`src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/manifest.yaml`, `agent-build/instructions.md`, `agent-build/environments/balanced.yaml`, `agent-build/environments/economy.yaml`, `agent-build/environments/quality.yaml`, `agent-build/roles/backend-developer.yaml`, `agent-build/roles/code-reviewer.yaml`, `agent-build/roles/coding.yaml`, `agent-build/roles/environment-operator.yaml`, `agent-build/roles/file-explorer.yaml`, `agent-build/roles/frontend-developer.yaml`, `agent-build/roles/git-operator.yaml`, `agent-build/roles/planning.md`, `agent-build/roles/planning.yaml`, `agent-build/roles/researcher.yaml`, `agent-build/roles/review-spec.yaml`, `agent-build/roles/review-standards.yaml`, `agent-build/roles/test.yaml`, `test/environment.test.ts`, `test/agent-build.test.ts`
- 依赖：TASK-001
- 实现步骤：
  1. 增加默认 `staging.retention_hours=168` 的 schema、bootstrap 和规范化返回。
  2. 更新所有 staging 与消费者命令的统一 syntax、参数类型和 role command 权限。
  3. 更新角色指令：只能经 CLI 操作 staging，禁止直接写 `TMPDIR`、项目、`AI_TEAM_HOME`，显示 `writes` 和 `staging.owned_entries`。
  4. 提升 template version，并从统一 contract 重新生成三平台代理。
  5. 覆盖稳定输出、权限最小化、digest 变化和真实 OpenCode 流程。
- 验收标准：
  - 三平台生成一致，只有所需角色获得 staging 命令，模板和 digest 升级可验证。
- 自测命令：`node --import tsx --test test/environment.test.ts test/agent-build.test.ts`
- 交接内容：配置和命令契约差异、角色所有权矩阵、模板版本、三平台生成证据。

### TASK-004：同步文档与项目上下文

- 需求覆盖：REQ-010, REQ-012
- 验收覆盖：AC-014, AC-015
- 目标：使用户文档、项目 MEMORY 和 File Explorer 导航与最终实现入口和发布顺序一致。
- 读取范围：TASK-002/TASK-003 交接；`README.md`, `docs/agent-commands.md`, `docs/ai-team-v1.md`, `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts`
- 写入范围：用户文档、项目上下文与 context 测试。
- 允许写入路径：`README.md`, `docs/agent-commands.md`, `docs/ai-team-v1.md`, `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts`
- 依赖：TASK-002, TASK-003
- 实现步骤：
  1. 记录 staging 命令、kind、兼容参数、状态、保留、安全和错误语义。
  2. 记录先兼容 CLI 后生成/安装代理且不处理历史临时文件的发布策略。
  3. 更新 `MEMORY.md` 和功能导航中的入口、职责和模块边界。
  4. 通过 `ai-team context update` 同步 File Explorer `project_context`，再运行 validate。
- 验收标准：
  - 文档不承诺规格外行为，导航覆盖 staging/消费者/生成边界，context validate 通过。
- 自测命令：`node --import tsx --test test/context.test.ts && ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team`
- 交接内容：文档差异、project_context payload、context validate 输出。

### TASK-005：执行独立回归与发布门禁

- 需求覆盖：REQ-011, REQ-012
- 验收覆盖：AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010, AC-011, AC-012, AC-013, AC-014, AC-015
- 目标：独立证明安全、生命周期、兼容、脱敏、生成与真实平台流程满足冻结规格。
- 读取范围：全部任务交接和冻结 revision 允许范围。
- 写入范围：仅当验证脚本缺失冻结门禁时可最小修改 `package.json`；不得修改产品代码或测试来掩盖失败。
- 允许写入路径：`package.json`
- 依赖：TASK-001, TASK-002, TASK-003, TASK-004
- 实现步骤：
  1. 运行五个目标测试文件并核对全 kind、攻击边界、旧参数、生命周期、脱敏和三平台断言。
  2. 在隔离 AI Team home 执行真实 OpenCode create/write/validate/submit/cleanup 流程。
  3. 运行 context validate、typecheck、lint、build 和最终 `npm run verify`。
  4. 失败时返回可复现证据，不扩大写入或降低门禁。
- 验收标准：
  - 所有冻结 AC 均有通过证据，最终 `npm run verify` 返回 0。
- 自测命令：`npm run verify`
- 交接内容：完整命令、退出码、失败诊断（如有）、发布/回滚建议。

## 依赖关系

```text
TASK-001 -> TASK-002
TASK-001 -> TASK-003
TASK-002 -> TASK-004
TASK-003 -> TASK-004
TASK-004 -> TASK-005
```

## 并行批次

| 批次 | 任务 | 不重叠写入范围 |
| --- | --- | --- |
| 1 | TASK-001 | `src/home.ts`, `src/state.ts`, `src/security.ts`, `src/utils.ts`, `src/constants.ts`, `src/contracts.ts`, `test/core.test.ts` |
| 2 | TASK-002 | `src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts` |
| 2 | TASK-003 | `src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/**`, `test/environment.test.ts`, `test/agent-build.test.ts` |
| 3 | TASK-004 | `README.md`, `docs/**`, `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts` |
| 4 | TASK-005 | `package.json`（仅必要时） |

## 风险与阻塞

- 风险：文件删除与 SQLite 事务不能成为单一原子事务。影响：业务已成功但文件残留。缓解：先持久化业务，再以 `cleanup_pending` 记录可重试删除，审计只含摘要。
- 风险：TASK-002 和 TASK-003 并行时 CLI syntax 与生成 contract 漂移。影响：代理拿到错误命令。缓解：固定 kind/参数映射，TASK-003 读取 TASK-002 契约交接，最终生成测试和真实 OpenCode 门禁统一校验。
- 风险：安全检查存在 TOCTOU。影响：越界读取/覆盖/删除。缓解：以目录内受控创建、文件身份复核、link/mode/realpath 校验和原子替换覆盖攻击测试。
- 阻塞：无；Task 预览已验证且 typed decision `decision_01KZZR9RG2WXMA9N1NKA6CTCNE=approve` 已记录。
