---
plan_id: 20260814-staged-patch-a11c
revision: "001"
target_branch: main
supersedes: null
---

# 实施计划

## 方案摘要

- 方案：把当前 30-path staged snapshot 视为待 reconciliation 的既有实现，先冻结完整 spec/plan revision，再由唯一 Git Operator 提交规划 revision；随后按同一 scope digest 执行验证、Spec/Standards review、scope triage/pre_write/pre_commit 和最终 patch 提交，最后构建/受管安装 CLI 并仅恢复指定 OneSpace run。
- 关键取舍：AIT-001..011 与 context-path migration 分别归属但共同纳入提交；共享入口按多需求边界审阅；未执行的安装/恢复只作为后置 gate。
- 不采用的方案及原因：不拆分实现 tasks，因为 patch 已存在；不直接提交现有 staged patch，因为会绕过规划 revision、scope 和 review；不把 context migration 排除，因为它是当前 project-context 契约的必要联动；不直接编辑 global dist 或 OneSpace 产品代码。

## 实施步骤

1. 冻结规划 revision：读取 File Explorer digest 和用户 receipt；写入完整 `spec.md`/`plan.md`；通过 runtime schema 原子创建 `20260814-staged-patch-a11c/001`；完成条件是双文档、frontmatter、run/revision 绑定一致且无半成品。
2. 推进 plan_ready：对 revision/run stage、文档、digest 和目标状态做预检；创建或复用唯一匹配的 Git Operator planning-commit dispatch；完成条件是仅一个 pending/claimed matching dispatch。
3. 提交规划 revision：Git Operator 只写 planning revision 允许路径，返回 40 位 commit、dispatch identity 和 digest；planning reconciliation 在 SQLite transaction 中收敛 revision/run/events/operation；完成条件是 revision commit 证据可重复校验。
4. Reconcile 当前 patch：以 30-path snapshot 为范围，按 REQ-001..REQ-011 审阅 shared workflow/contract/state/role/test 边界，按 REQ-013 审阅 context migration；完成条件是每条 staged path 有唯一或明确共享归属，无额外路径。
5. 执行验证和 review：运行 targeted tests、typecheck、lint、test、build、verify、context validate、diff check；依次通过 Spec review、Standards review 和 scope triage/pre_write/pre_commit；完成条件是无 P0/P1、digest 未漂移。
6. 受管提交完整 patch：由正式 Git Operator dispatch 在精确 scope 内提交，不覆盖/撤销用户变更；完成条件是 commit 与 frozen digest/path set 一致，planning/coding/review artifacts 可审计。
7. 构建、安装与恢复：从仓库源构建并受管安装 CLI，不编辑 global dist；仅恢复 OneSpace `run_01KZZ9GW5TG7PVBDV4T285VMR4` 的 revision 001，经 plan_ready、唯一 Git Operator dispatch、planning revision commit、result submit 到 ready；coding start 前核验 plan/dispatch/contract/role/template digest。

## 需求覆盖

| 需求/验收 ID | 实施位置 | 验证方式 | 责任角色 |
| --- | --- | --- | --- |
| REQ-001 / AC-001 | `src/contracts.ts`, `src/dispatch.ts`, `src/state.ts`, `test/review-fixes.test.ts` | targeted planning lifecycle tests | backend-developer / test |
| REQ-002 / AC-002 | `src/dispatch.ts`, `src/workflow.ts`, `test/review-fixes.test.ts`, `test/workflow.test.ts` | continuation uniqueness tests | backend-developer / test |
| REQ-003 / AC-003 | `src/cli.ts`, `src/dispatch.ts`, `test/cli-e2e.test.ts` | resume E2E and concurrency tests | backend-developer / test |
| REQ-004 / AC-004 | `src/cli.ts`, `src/dispatch.ts`, `src/planning.ts`, `test/cli-e2e.test.ts` | plan_ready and dispatch gate tests | backend-developer / test |
| REQ-005 / AC-005 | `src/planning.ts`, `agent-build/roles/planning.md`, `agent-build/roles/git-operator.md`, `test/core.test.ts` | atomic documents/failure tests | backend-developer / test |
| REQ-006 / AC-006 | `src/planning.ts`, `src/cli.ts`, `test/workflow.test.ts`, `test/cli-e2e.test.ts` | transition zero-side-effect tests | backend-developer / test |
| REQ-007 / AC-007 | `src/planning.ts`, `src/cli.ts`, `test/core.test.ts`, `test/cli-e2e.test.ts` | documents runtime schema tests | backend-developer / test |
| REQ-008 / AC-008 | `src/planning.ts`, `src/state.ts`, `src/cli.ts`, `test/workflow.test.ts` | state matrix/reconciliation tests | backend-developer / test |
| REQ-009 / AC-009 | `src/state.ts`, `src/cli.ts`, `test/core.test.ts`, `test/cli-e2e.test.ts` | multi-process read/lock/backup tests | backend-developer / test |
| REQ-010 / AC-010 | `src/command-contract.ts`, `src/cli.ts`, `agent-build/roles/git-operator.yaml`, role docs, contract tests | parser/manifest/reconciliation E2E | backend-developer / git-operator / test |
| REQ-011 / AC-011 | `src/cli.ts`, `src/command-contract.ts`, `test/cli-e2e.test.ts`, `test/environment.test.ts` | canonical/legacy JSON snapshots | backend-developer / test |
| REQ-012 / AC-012 | File Explorer digest 对应全部 30 staged paths | diff name/check, scope triage/pre_write/pre_commit | file-explorer / review-spec / review-standards |
| REQ-013 / AC-013 | `.ai-team/index/feature-navigation.md`, `.ai-team/project.yaml`, `MEMORY.md`, README/docs/context/workflow/role/context tests | context validate and role/doc tests | file-explorer / review-standards / test |
| REQ-014 / AC-014 | repository scripts, managed installation, OneSpace planning state | full verify, installation record, run/revision/digest evidence | test / environment-operator / git-operator / planning |

## 验证

- 单元测试：`node --import tsx --test test/review-fixes.test.ts test/core.test.ts test/workflow.test.ts test/agent-build.test.ts test/environment.test.ts test/context.test.ts`。
- 集成测试：`node --import tsx --test test/cli-e2e.test.ts`；OneSpace 指定 run 的 planning revision/dispatch/result/reconciliation 流程。
- 静态检查：`npm run typecheck`、`npm run lint`、`git diff --cached --check`。
- 构建或打包：`npm run build`、`npm run verify`，随后校验构建产物并走受管安装；禁止编辑 global dist。
- 手工验证：核对 30 staged paths 与 scope digest；核对 context maintenance current；核对唯一 Git Operator dispatch；核对 OneSpace ready 与五类 digest。
- 失败时的诊断和回滚：保留 frozen revision、dispatch/result/operation 和测试输出；任一 P0/P1、scope 漂移、测试/安装/digest 失败即停止后续步骤；由对应受管角色修复或回滚，不修改 OneSpace 产品代码。

## 发布与回滚

- 发布前门禁：规划 revision committed；30-path scope 固定；typecheck/lint/test/build/verify/context validate/diff check 通过；Spec/Standards review 无 P0/P1；scope triage/pre_write/pre_commit 通过。
- 发布顺序：规划 revision commit -> patch review/scope -> patch Git Operator commit -> build/verify -> 受管安装 -> 指定 OneSpace 恢复 -> digest 核验 -> coding start。
- 监控和观察窗口：每次 state transition 后检查 run/revision/dispatch/event/operation；安装后执行 CLI version/contract smoke test；OneSpace ready 后在 coding start 前重新核验 digest。
- 回滚条件：任一状态漂移、重复 dispatch、测试失败、scope 变化、安装产物不一致、OneSpace digest 不一致。
- 回滚命令：不预设破坏性命令。Git 回滚由授权 Git Operator 根据已提交 commit 生成可审计回滚；安装由 Environment Operator 使用受管恢复流程；OneSpace 停留在最后一致 state，不修改产品代码。
