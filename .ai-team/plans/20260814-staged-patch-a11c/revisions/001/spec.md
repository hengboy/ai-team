---
plan_id: 20260814-staged-patch-a11c
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

## 背景

当前仓库存在一组已暂存修复，File Explorer frozen result（dispatch `dispatch_01KZZN2WP1FFT1RXEAG5N9E6D1`，digest `068dfd419a0416a4902bf0781d4286d98d4dd78b7ee90ee7f195ec816da7cb2e`）确认共有 30 条 staged 路径。变更同时包含 AIT-001 至 AIT-011 的 planning workflow 修复，以及从 `.ai-work-flow/index` 到 `.ai-team/index` 的 project-context migration。用户已授权审计并最终提交这组完整 patch，但不得绕过 scope/review 门禁，不得修改 OneSpace 产品代码，不得直接编辑全局 dist。

File Explorer 已确认 `git diff --cached --check` 通过；完整 `npm run verify`、CLI 构建/受管安装、OneSpace 指定 run 恢复与 digest 核验尚未在本 run 中执行，必须作为后置验收。

## 目标

- [ ] 修复并验证 AIT-001 至 AIT-011，P0 优先覆盖 AIT-001 至 AIT-004。
- [ ] 对全部 30 条 staged 路径完成可追踪 reconciliation，不覆盖、不撤销、不夹带未归属变更。
- [ ] 将 context-path migration 与 AIT 实现分别归属并一并纳入 scope/review。
- [ ] 通过 typecheck、lint、test、build、verify、scope 和 Spec/Standards review 后，由唯一 Git Operator 提交。
- [ ] 受管安装新 CLI 后，仅恢复指定 OneSpace run 并在 coding start 前核验 digest。

## 非目标

- 不修改 OneSpace 产品代码。
- 不直接编辑全局 dist。
- 不恢复 `run_01KZZ9GW5TG7PVBDV4T285VMR4` 之外的 OneSpace run。
- 不在 planning 角色执行 Git mutation。
- 不创建 tasks.md 或实现任务拆分；当前 patch 已存在，工作性质是 reconciliation、验证和受管提交。

## 用户场景

### 场景 1：规划决策与恢复

- 前置条件：planning run 处于可推进 stage，结果需要决策或需要恢复 continuation。
- 操作：提交 needs_decision/completed 结果、resolve decision 或执行 run resume。
- 预期结果：事务化更新状态，run 恢复 active，并且每个 continuation 只有一个有效 planning dispatch。
- 异常结果：schema、归属或状态不合法时零副作用失败；未决 decision 不被 resume 越过。

### 场景 2：规划 revision 与 Git Operator 门禁

- 前置条件：完整 spec/plan 已准备，run/revision/stage 一致。
- 操作：原子创建 revision、推进 plan_ready、请求 planning revision commit。
- 预期结果：只创建与当前 run/revision/operation/digest 匹配的唯一 Git Operator dispatch。
- 异常结果：文档不完整、状态漂移或 dispatch 归属不匹配时拒绝且不产生部分状态。

### 场景 3：完整 staged patch 提交与恢复

- 前置条件：30-path scope 已冻结，测试和评审门禁通过。
- 操作：Git Operator 提交规划 revision，再按受管流程审计并提交完整 staged patch，构建并安装 CLI，恢复指定 OneSpace run。
- 预期结果：提交只包含已归属 patch；OneSpace revision 001 到达 ready 且 digest 在 coding start 前核验一致。
- 异常结果：scope、测试、review、安装或 digest 任一不满足时停止，不修改 OneSpace 产品代码。

## 功能需求

### REQ-001：AIT-001 planning 决策事务

- 描述：规范路径为 `status=needs_decision`；planning payload 必须包含 `stage`、最多一个 `pending_questions` 和严格匹配的 `decision`。submit 在单一事务推进 stage、创建唯一 open decision、更新来源 dispatch 和 run 为 needs_decision。`completed+pending_questions` 归一化为等价兼容入口并允许标记后续弃用；resolve 后 run active 且幂等续发唯一 planning dispatch。
- 输入：planning frozen result envelope。
- 输出：一致的 run/dispatch/decision/stage 状态与唯一 continuation。
- 约束：任何中途失败必须整体回滚。

### REQ-002：AIT-002 自动 continuation

- 描述：decision resolve 与无问题 completed 均通过统一 continuation 路径创建或复用当前 stage 的唯一 planning dispatch。
- 输入：resolved decision 或 completed planning result。
- 输出：绑定当前 run/stage 的 planning dispatch。
- 约束：重复、并发和重试均不得产生重复有效 dispatch。

### REQ-003：AIT-003 幂等 run resume

- 描述：run resume 对 active 且缺失 continuation 的 run 补发唯一 planning dispatch；已有有效 dispatch 时复用；needs_decision 时不得越过未决 decision。
- 输入：run id。
- 输出：恢复后的 run 视图与必要的唯一 dispatch。
- 约束：stage 不倒退，重复/并发调用幂等。

### REQ-004：AIT-004 plan_ready 与唯一 Git Operator 门禁

- 描述：plan_ready 仅允许 run/revision/stage 一致的转换；planning-commit dispatch 必须匹配当前 run、revision、operation 和 digest，不得复用其他非 failed dispatch。
- 输入：合法 revision transition。
- 输出：唯一 Git Operator planning revision commit dispatch。
- 约束：错误用途、错误 revision 或错误 run 的 dispatch 不可复用。

### REQ-005：AIT-005 revision 原子双文档

- 描述：revision create 通过 runtime-validated documents 输入原子创建完整 `spec.md` 与 `plan.md`，写入一致 frontmatter，并同步 planning/Git Operator 提示契约。
- 输入：`--documents-file` 中的 spec/plan 字符串。
- 输出：不可变、完整的 revision 目录。
- 约束：禁止 plan-first 或半成品 revision。

### REQ-006：AIT-006 transition 预检

- 描述：revision transition 在任何 mutation 或 dispatch 创建前验证目标状态、文档完整性、run/revision 绑定、commit 与门禁。
- 输入：revision transition 请求。
- 输出：一次合法转换，或零副作用错误。
- 约束：预检失败不写 revision、run、event、dispatch。

### REQ-007：AIT-007 documents runtime schema

- 描述：`--documents-file` 必须在使用前通过 runtime schema，拒绝 malformed JSON、缺失/未知字段、错误类型及非法输入。
- 输入：JSON documents file。
- 输出：已验证的 spec/plan，或稳定可机器识别错误。
- 约束：失败发生在 revision 写入前。

### REQ-008：AIT-008 run/revision 双状态一致性

- 描述：定义并强制 `run.stage` 与 `revision.state` 映射；create、transition、resume、decide、commit、submit 不得制造漂移。
- 输入：所有影响 planning/revision 的命令。
- 输出：一致状态，或显式拒绝/受控 reconciliation。
- 约束：event 与最终状态一致。

### REQ-009：AIT-009 并行只读、锁与备份

- 描述：只读 state 打开不触发写锁或备份；并发只读可共存；备份产生一致快照且不损坏活动库；迁移/恢复写操作仍受排他保护。
- 输入：只读/读写/备份并发操作。
- 输出：一致查询、可恢复备份与正确锁生命周期。
- 约束：无 database locked、脏快照或遗留锁。

### REQ-010：AIT-010 revision commit 语法与角色权限

- 描述：CLI、COMMAND_SYNTAX、环境能力、planning/Git Operator 角色提示必须一致；仅 Git Operator 可执行 Git mutation，planning 只交接 dispatch identity 与 digest；reconciliation 必须验证 operation/run/dispatch/revision/digest/commit。
- 输入：planning revision commit 与 reconciliation result。
- 输出：40 位 commit 或可审计失败/重试状态。
- 约束：planning 不得直接执行 Git mutation；盲重试必须阻止。

### REQ-011：AIT-011 版本化 JSON 兼容

- 描述：默认输出 canonical `ok/data` envelope 和明确 schema version；显式 `--legacy-output` 保留旧消费者兼容，stdout 不混入非 JSON。
- 输入：CLI 成功、needs_decision、校验失败、resume/commit 等命令。
- 输出：稳定可机器解析 JSON。
- 约束：兼容窗口内旧消费者不破坏，弃用可识别。

### REQ-012：30-path staged patch reconciliation

- 描述：后续 scope、review 和提交覆盖 File Explorer 确认的全部 30 条 staged 路径。共享入口 `src/cli.ts`、`src/dispatch.ts`、`test/cli-e2e.test.ts`、`test/review-fixes.test.ts` 按多个 AIT 的共同边界审阅。
- 输入：当前 staged snapshot 与 File Explorer digest。
- 输出：每条路径有 AIT 或 context migration 归属。
- 约束：`package.json` 仅为允许读取的验证输入，不计入 30 条 staged 路径。

### REQ-013：project-context migration 归属

- 描述：`.ai-team/index/feature-navigation.md`、`.ai-team/project.yaml`、`MEMORY.md` 及 README/docs/context/workflow/role/test 联动变更归属 context-path migration，并作为当前 patch 的必要 project-context reconciliation。
- 输入：context migration staged paths。
- 输出：一致的路径契约、角色指引和测试。
- 约束：不得将其伪装为独立 AIT，也不得因非 AIT 而遗漏提交。

### REQ-014：交付、安装与 OneSpace 恢复

- 描述：规划 revision commit 后依次执行 typecheck、lint、test、build、verify、scope 和正式 review；通过后构建并受管安装 CLI，再仅恢复指定 OneSpace run 的 revision 001 到 ready，coding start 前核验 plan/dispatch/contract/role/template digest。
- 输入：受管提交、构建产物、指定 OneSpace run。
- 输出：验证证据、安装证据、ready frozen run 与 digest 证据。
- 约束：不直接编辑全局 dist，不修改 OneSpace 产品代码，不触碰其他 OneSpace run。

## 验收标准

### AC-001：决策事务与兼容语义

- Given：合法/非法 needs_decision 与 completed+pending_questions 结果。
- When：validate/submit/resolve，并注入中途失败或重复请求。
- Then：schema 完整且 question/decision 匹配；两种入口状态等价；decision 唯一；失败全回滚；resolve 后 active 且 continuation 唯一。
- 验证命令或证据：`node --import tsx --test test/review-fixes.test.ts`。

### AC-002：自动 continuation 唯一

- Given：resolved decision、无问题 completed、已有或失败 dispatch。
- When：推进 planning。
- Then：每个 run/stage 仅一个有效 planning dispatch，绑定正确。
- 验证命令或证据：`node --import tsx --test test/review-fixes.test.ts test/workflow.test.ts`。

### AC-003：resume 幂等

- Given：active 缺 dispatch、active 有 dispatch、needs_decision 三类 run。
- When：单次、重复或并发执行 run resume。
- Then：只补必要 dispatch，不越过 decision，stage 不倒退。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts test/review-fixes.test.ts`。

### AC-004：plan_ready Git Operator 唯一门禁

- Given：合法及绑定漂移的 run/revision，且存在匹配或不匹配 dispatch。
- When：推进 plan_ready 或重试。
- Then：只创建/复用精确匹配的唯一 Git Operator dispatch；非法请求零副作用拒绝。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts test/workflow.test.ts`。

### AC-005：原子 revision 双文档

- Given：合法完整 documents 或任一写入点故障。
- When：revision create。
- Then：成功时双文档和 frontmatter 完整；失败时无部分目录/文件；角色提示契约一致。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/agent-build.test.ts`。

### AC-006：transition 零副作用预检

- Given：非法目标、缺文档、绑定漂移、缺 commit 与合法请求。
- When：revision transition。
- Then：非法请求不改变 revision/run/event/dispatch；合法转换仅一次。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts test/workflow.test.ts`。

### AC-007：documents runtime schema

- Given：合法、malformed、缺字段、额外字段、错误类型 documents 输入。
- When：revision create。
- Then：非法输入在写入前返回机器可识别错误；合法输入创建完整 revision。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`。

### AC-008：双状态矩阵

- Given：所有合法 run.stage/revision.state 映射与人工漂移状态。
- When：create/transition/resume/decide/commit/submit。
- Then：合法转换保持一致；漂移显式拒绝或受控 reconciliation；event 一致。
- 验证命令或证据：`node --import tsx --test test/workflow.test.ts test/cli-e2e.test.ts`。

### AC-009：只读锁与备份

- Given：多进程只读、读写竞争、备份期间读取。
- When：并发打开 StateStore、run show 和备份/恢复。
- Then：只读无写锁/备份副作用，无 database locked、脏快照、遗留锁。
- 验证命令或证据：`node --import tsx --test test/core.test.ts test/cli-e2e.test.ts`。

### AC-010：命令与权限一致

- Given：planning 与 Git Operator 两种角色及正确/错误 reconciliation evidence。
- When：解析、执行 planning revision commit/reconcile。
- Then：contract/manifest/help 一致；planning 越权拒绝；合法结果为 40 位 commit；pending/not_applied/retry 可审计且无盲 Git 重试。
- 验证命令或证据：`node --import tsx --test test/agent-build.test.ts test/environment.test.ts test/cli-e2e.test.ts`。

### AC-011：版本化 JSON 输出

- Given：成功、needs_decision、校验失败和恢复命令。
- When：默认或显式 legacy 模式执行。
- Then：默认 canonical JSON 可解析且含版本；legacy 保持兼容；stdout 无非 JSON。
- 验证命令或证据：`node --import tsx --test test/cli-e2e.test.ts`。

### AC-012：30-path scope 完整

- Given：File Explorer digest 对应 staged snapshot。
- When：执行 scope triage/pre_write/pre_commit 与正式 review。
- Then：30 条 staged 路径全部有归属，无新增、遗漏、覆盖或撤销。
- 验证命令或证据：`git diff --cached --name-only`、`git diff --cached --check`、scope digest。

### AC-013：context migration 一致

- Given：context migration 的 15 个联动边界及共享文档。
- When：执行 context validate、role/doc/test review。
- Then：navigation 新路径、MEMORY、workflow、角色提示和测试一致，maintenance 为 current。
- 验证命令或证据：`ai-team context validate --project /Users/yuqiyu/AiHistorys/ai-team`、`node --import tsx --test test/context.test.ts test/agent-build.test.ts`。

### AC-014：完整交付与指定恢复

- Given：规划 revision 已由 Git Operator 提交且 scope/review 通过。
- When：运行全门禁、受管安装并恢复指定 OneSpace run。
- Then：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run verify` 全通过；仅指定 run 的 revision 001 到达 ready；coding start 前 digest 一致；OneSpace 产品代码不变。
- 验证命令或证据：命令输出、安装记录、OneSpace `run show`/revision/dispatch/result/digest 证据。

## 数据与接口

- planning result envelope：`schema_version`、`status`、`payload.stage`、`payload.pending_questions`、`payload.decision`。
- planning state：run、dispatch、decision、event、operation 必须在定义的事务和唯一约束内变化。
- revision documents runtime schema：顶层仅接受字符串字段 `spec` 与 `plan`，由 create 写为 `spec.md` 与 `plan.md`。
- planning commit reconciliation：验证 operation、run、dispatch、plan_id、revision、digest、40 位 plan_commit。
- staged scope：30 条 staged 路径；`package.json` 是读取/脚本入口，不计入 staged path count。

## 兼容约束

- 现有行为必须保持：`completed+pending_questions` 在兼容窗口语义等价于 needs_decision；`--legacy-output` 显式保留旧 JSON 消费者；合法旧 run 的恢复必须受状态映射保护。
- 迁移兼容窗口：兼容入口与 legacy 输出应有可识别弃用标记，移除需独立版本决策；context navigation 新路径必须同步文档、角色和测试。

## 安全约束

- 权限边界：planning 不执行 Git mutation；仅匹配 frozen dispatch 的 Git Operator 可提交；OneSpace 恢复不得修改产品代码。
- 敏感数据处理：result、dispatch、digest、commit 只记录必要标识，不输出无关环境数据。
- 路径和输入校验：documents runtime schema、canonical project path、plan/revision/run/dispatch identity 和 30-path scope 必须校验。

## 错误与边界

- 非法输入：schema、状态、绑定、digest、commit 或路径不合法时在 mutation 前拒绝。
- 空数据：空 pending_questions 表示无需决策；空/缺失 spec 或 plan 禁止创建 revision。
- 超时或外部依赖失败：Git Operator、安装或 OneSpace 恢复失败时保留可审计 operation/result，不推进后续 gate。
- 重试和幂等：submit、resolve、resume、continuation、plan_ready、commit reconciliation 必须幂等；pending attempt 禁止盲重试，not_applied 可创建确定性新 attempt。

## 迁移发布回滚

- 发布步骤：提交规划 revision；执行 scope/review；由唯一 Git Operator 提交完整 staged patch；运行全门禁；构建并受管安装；恢复指定 OneSpace run；核验 digest。
- 迁移步骤：context navigation 切换到 `.ai-team/index`，同步 MEMORY、project config、README/docs、workflow、roles 和 tests。
- 回滚触发条件和操作：任一 P0/P1 review finding、测试失败、scope 漂移、安装校验失败或 digest 不一致即停止。规划文档保持冻结；产品 patch 由 Git Operator 依据已提交边界执行可审计回滚；不得通过直接编辑 global dist 或 OneSpace 产品代码回滚。

## 已确认偏好

- 用户已明确决定：提交当前完整 staged patch；AIT-001..011 与所需 contract/roles/context/docs/tests 全部纳入；先规划 revision commit，再经过 review/scope 门禁；不修改 OneSpace 产品代码；不直接编辑全局 dist。

## 默认取舍

- 不拆分 tasks：当前实现 patch 已存在，下一步是 reconciliation 与 gate，而非并行实现。
- context migration 与 AIT 实现分别归属但同一 patch 审计：既避免混淆，也避免遗漏用户授权的必要联动。
- 安装与 OneSpace 恢复保持后置：当前没有执行证据，不将未来动作写成已完成事实。

## 已关闭问题

- 问题：是否提交完整 staged patch？结论：是。证据：用户明确授权。
- 问题：staged path 数是约 29 还是 30？结论：30。证据：File Explorer frozen result 与 `git diff --cached --name-only | nl -ba`。
- 问题：context migration 是否纳入？结论：纳入并独立归属。证据：用户授权范围与 File Explorer 报告。
- 问题：是否需要新的产品决策？结论：不需要。证据：用户已明确 scope、门禁、安装和恢复边界。

## 未决问题

- 无。
