---
plan_id: 20260814-staging-json-a7c4
revision: "001"
target_branch: main
supersedes: null
---

# 实施计划

## 方案摘要

- 方案：在现有 `HomePaths`、`StateStore`、安全工具和 CLI JSON 读取边界上增加统一 staging 服务；内容文件保存在 `state/staging`，SQLite `staging_entries` 只保存绑定、状态和摘要；所有旧文件参数继续使用原路径，新 `--staging-id` 经统一解析、绑定校验和消费协调器接入 10 类业务命令。
- 关键取舍：文件系统内容与 SQLite 元数据分离；业务持久化是消费提交点，删除是可重试清理步骤；validate/preview 只读不消费；命令契约和角色生成在兼容 CLI 完成后更新；实现任务按不重叠写入范围拆分。
- 不采用的方案及原因：不继续让代理自行管理 `TMPDIR` 或项目临时文件，因为无法统一所有权、安全和保留；不把 JSON 原文存入 SQLite，因为扩大敏感数据面；不提升 `STATE_SCHEMA_EPOCH`，因为正常前向迁移足够且避免状态库重建；不自动处理旧临时文件，因为超出兼容范围且存在误删风险。

## 实施步骤

1. 步骤 1：以 `src/home.ts` 为路径入口，在 `src/state.ts` 新增 forward-only `staging_entries` 迁移和状态 API，在 `src/security.ts`/`src/utils.ts` 实现受管路径、UID、regular-file、link count、mode、realpath、path replacement、防越界、2 MiB、合法 JSON、同目录临时文件、`fsync` 和原子替换；写入范围为核心状态与安全模块及 `test/core.test.ts`；完成条件为 REQ-001..REQ-005 的底层 API 和 AC-001..AC-005、AC-008、AC-011 核心测试通过。
2. 步骤 2：以 `src/cli.ts` 为公共入口，新增 `staging create/write/show/cleanup`，在 `src/dispatch.ts`、`src/planning.ts` 和 CLI 适配层接入 10 个固定 kind；实现新旧参数互斥、run/dispatch/role/kind 校验、context/tasks 的 `--run-id` 要求、validate/preview 非消费、最终持久化后消费及 `cleanup_pending`；写入范围为 CLI/业务适配模块和 `test/cli-e2e.test.ts`；完成条件为 REQ-006..REQ-008 与 AC-006..AC-010 通过。
3. 步骤 3：以 `src/command-contract.ts`、`src/environment.ts`、`src/agent-build.ts`、`src/roles.ts` 和 `agent-build/**` 为入口，加入 staging 配置默认值、命令语法、参数类型、角色权限、禁止直接写临时路径的指令、`writes`/`staging.owned_entries` 展示，提升模板版本并重新生成三平台代理；写入范围为生成系统及 `test/environment.test.ts`、`test/agent-build.test.ts`；完成条件为 REQ-009、AC-011..AC-013 通过，且生成动作晚于兼容 CLI。
4. 步骤 4：以 `README.md`、`docs/agent-commands.md`、`docs/ai-team-v1.md` 记录 CLI、生命周期、安全和发布顺序；根据最终入口更新 `MEMORY.md` 与 `.ai-team/index/feature-navigation.md`，通过受管 context update 同步 File Explorer `project_context`；写入范围为文档、项目上下文和 `test/context.test.ts`；完成条件为 REQ-010、REQ-012 与 AC-014 的文档和上下文证据完成。
5. 步骤 5：由 Test 角色在不修改实现的前提下运行全 kind 表驱动、攻击边界、旧参数兼容、持久化脱敏、三平台生成和真实 OpenCode 流程；完成条件为针对性测试、`ai-team context validate` 和 `npm run verify` 全部通过，满足 REQ-011、AC-015。
6. 步骤 6：由 Git Operator 仅提交 plan revision 允许的实现路径；发布时先交付兼容 CLI，观察旧参数和 staging 双路径，再生成/安装代理；异常时停止后序生成/安装并回退实现提交，不修改冻结 revision 或清理历史临时文件。

## 需求覆盖

| 需求/验收 ID | 实施位置 | 验证方式 | 责任角色 |
| --- | --- | --- | --- |
| REQ-001 | `src/home.ts`, `src/state.ts`, `src/cli.ts` | core + CLI E2E | backend-developer |
| REQ-002 | `src/security.ts`, `src/utils.ts`, `src/state.ts` | `test/core.test.ts` | backend-developer |
| REQ-003 | `src/security.ts`, `src/state.ts` | 攻击与竞态测试 | backend-developer |
| REQ-004 | `src/state.ts` | 迁移、持久化、脱敏测试 | backend-developer |
| REQ-005 | `src/state.ts`, `src/environment.ts`, `src/cli.ts` | retention/cleanup 单元与 E2E | backend-developer |
| REQ-006 | `src/cli.ts`, `src/command-contract.ts`, `src/planning.ts`, `src/dispatch.ts` | 全 kind 表驱动 E2E | backend-developer |
| REQ-007 | `src/cli.ts`, `src/state.ts`, `src/dispatch.ts` | 绑定与消费时序 E2E | backend-developer |
| REQ-008 | `src/dispatch.ts`, `src/state.ts` | dispatch template/重试 E2E | backend-developer |
| REQ-009 | `src/command-contract.ts`, `src/environment.ts`, `src/agent-build.ts`, `src/roles.ts`, `agent-build/**` | agent-build/environment tests | environment-operator |
| REQ-010 | `MEMORY.md`, `.ai-team/index/feature-navigation.md` | `ai-team context validate` | backend-developer |
| REQ-011 | `test/core.test.ts`, `test/cli-e2e.test.ts`, `test/environment.test.ts`, `test/agent-build.test.ts`, `test/context.test.ts` | targeted tests + `npm run verify` | test |
| REQ-012 | `README.md`, `docs/agent-commands.md`, `docs/ai-team-v1.md` | 文档审阅 + 发布门禁 | backend-developer |
| AC-001 | `src/home.ts`, `src/state.ts`, `src/cli.ts` | `node --import tsx --test test/core.test.ts test/cli-e2e.test.ts` | backend-developer |
| AC-002 | `src/security.ts`, `src/utils.ts`, `src/state.ts` | 原子写故障注入测试 | backend-developer |
| AC-003 | `src/security.ts`, `src/state.ts` | symlink/hardlink/realpath/mode/race 测试 | backend-developer |
| AC-004 | `src/state.ts` | migration/epoch/redaction 测试 | backend-developer |
| AC-005 | `src/state.ts`, `src/cli.ts` | 状态转换矩阵测试 | backend-developer |
| AC-006 | `src/dispatch.ts`, `src/state.ts` | frozen template 与跨 dispatch 拒绝 E2E | backend-developer |
| AC-007 | `src/dispatch.ts`, `src/planning.ts`, `src/cli.ts` | validate/preview/成功后消费 E2E | backend-developer |
| AC-008 | `src/state.ts`, `src/cli.ts` | opportunistic/explicit cleanup 测试 | backend-developer |
| AC-009 | `src/cli.ts`, `src/command-contract.ts` | 10 kind 表驱动 E2E | backend-developer |
| AC-010 | `src/cli.ts`, `test/cli-e2e.test.ts` | 旧参数、新参数、互斥矩阵 | backend-developer |
| AC-011 | `src/environment.ts`, `src/state.ts`, `src/cli.ts` | config + 状态/输出脱敏测试 | environment-operator |
| AC-012 | `agent-build/roles/*.yaml`, `agent-build/instructions.md` | `test/agent-build.test.ts` | environment-operator |
| AC-013 | `src/environment.ts`, `src/agent-build.ts`, `agent-build/**` | 三平台生成 + 真实 OpenCode 流程 | environment-operator |
| AC-014 | `MEMORY.md`, `.ai-team/index/feature-navigation.md`, `test/context.test.ts` | `ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team` | backend-developer |
| AC-015 | `package.json` 定义的验证脚本与全部目标测试 | `npm run verify` | test |

## 验证

- 单元测试：`node --import tsx --test test/core.test.ts`，覆盖迁移、状态机、权限、原子写、链接/路径替换、防越界、清理和脱敏。
- 集成测试：`node --import tsx --test test/cli-e2e.test.ts`，覆盖 staging CLI、10 个 kind、新旧参数互斥、run/dispatch/role/kind、消费时序及真实 OpenCode 流程。
- 静态检查：`npm run typecheck` 与 `npm run lint`，由最终 `npm run verify` 聚合。
- 构建或打包：`npm run build`，并运行 `test/environment.test.ts`、`test/agent-build.test.ts` 校验三平台稳定生成、模板版本和角色权限。
- 手工验证：在隔离的 AI Team home 中依次 create/write/show、validate、业务成功消费、删除失败恢复、expired cleanup；检查 SQLite/event/operation 无 JSON 原文；执行 `ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team`。
- 失败时的诊断和回滚：保留失败 staging 条目与脱敏摘要 168 小时；利用 `cleanup_pending` 重试文件删除；不输出原文；停止代理生成/安装，先修复兼容 CLI；若已提交，由 Git Operator 对实现提交执行非交互式 `git revert <implementation-commit>`。

## 发布与回滚

- 发布前门禁：全部 targeted tests、context validate、三平台生成 diff、真实 OpenCode 流程及 `npm run verify` 通过；确认旧参数行为未回归且审计不含原文。
- 发布顺序：1. 发布向后兼容 CLI 和前向 migration；2. 验证旧文件与 staging 双路径；3. 提升模板版本并生成 Codex/Claude/OpenCode；4. 安装代理；5. 在观察窗口内运行真实流程。
- 监控和观察窗口：至少覆盖一次 create/write/validate/submit/cleanup 完整周期和 168 小时保留配置的模拟时钟测试；监控 `cleanup_pending` 数量、跨边界拒绝和旧参数失败率，不记录原文。
- 回滚条件：安全边界可绕过、原文进入持久审计、旧参数失败、消费早于业务持久化、迁移恢复失败、三平台契约不一致或真实 OpenCode 流程失败。
- 回滚命令：由 Git Operator 执行 `git revert <implementation-commit>` 并重新运行 `npm run verify`；若仅新代理失败，恢复上一模板版本的生成/安装资产并保留兼容 CLI；不得修改冻结 revision 或扫描删除历史临时文件。
