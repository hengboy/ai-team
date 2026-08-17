---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# 实施计划

## 方案摘要

在现有 dispatch 状态机中补齐 `prepare_implementation_worktree -> Coding continuation` 转换，并让 completion 与 resume 共用同一个幂等派生 helper。同步把 packet phase/role context、JSON pointer、`.` 递归授权、planned gate、resolved retry action 和 `run show` 投影收敛为公开契约。实现不增加新状态表，不修改历史 run，并以临时仓库中的多 TASK planned E2E 验证完整生命周期。

## 实施步骤

1. 定义 dispatch packet 的 phase/role context 规则和公开 schema/template；统一 unknown-field validation detail 为 JSON pointer；统一 `.` 在授权继承与 scope matcher 中的项目根递归语义。完成条件：contract/unit/CLI 测试覆盖合法、缺失和越界输入。覆盖 REQ-003、REQ-004、REQ-005、AC-004、AC-005。
2. 在 planned 多 TASK 状态机中增加幂等 task-prepare Coding continuation helper，由 Git completion 和 resume 在通用 recovery 前调用；continuation 继承 Explorer、task/worktree 与 prepare lineage，并作为 developer dispatch authority。完成条件：completion/resume 只生成一个 continuation，且 developer dispatch 绑定正确 worktree。覆盖 REQ-001、REQ-002、AC-001、AC-002、AC-003。
3. 明确 planned 不适用 direct `pre_write`，更新 Coding 角色契约；将 resolved retry replacement 投影为确定的恢复动作；扩展 `run show` 输出 pending dependency、continuation 和建议命令。完成条件：direct gate 不变，resolved decision 不重复询问，show 输出可直接驱动下一步。覆盖 REQ-006、REQ-007、REQ-008、AC-006、AC-007、AC-008。
4. 增加多 TASK planned E2E 和聚焦回归，覆盖 prepare、developer、test、commit、`--no-ff` merge、下一 TASK 基于 merge commit 派生、completion/resume 幂等；运行静态检查、定向测试和全量测试。覆盖 REQ-009、REQ-010、AC-009、AC-010、AC-011。

## 需求覆盖

| 需求/验收 ID | 实施位置 | 验证方式 | 责任角色 |
| --- | --- | --- | --- |
| REQ-001、REQ-002 | `src/dispatch.ts` | planned continuation completion/resume 测试 | coding |
| REQ-003、REQ-004 | `src/contracts.ts`、`src/dispatch.ts`、`src/cli.ts` | schema/template 与 pointer 测试 | coding |
| REQ-005 | `src/security.ts`、`src/dispatch.ts` | root recursive scope 单元测试 | coding |
| REQ-006 | `src/gates.ts`、`src/git-orchestrator.ts`、Coding 角色契约 | planned/direct gate 回归 | coding |
| REQ-007 | `src/dispatch.ts`、`src/cli.ts` | resolved retry resume/CLI 测试 | coding |
| REQ-008 | `src/cli.ts`、`src/dispatch.ts` | `run show` E2E | coding |
| REQ-009 | `test/workflow.test.ts`、`test/git-orchestrator.test.ts`、`test/cli-e2e.test.ts` | 多 TASK planned E2E | test |
| REQ-010 | 既有 workflow/recovery/direct 测试 | 定向及全量回归 | test |
| AC-001 至 AC-003 | continuation 状态转换 | completion/resume/developer dispatch 断言 | test |
| AC-004、AC-005 | packet/scope contract | unit + CLI contract tests | test |
| AC-006 至 AC-008 | gate/retry/show contract | regression + CLI E2E | test |
| AC-009 至 AC-011 | 完整生命周期与保护边界 | 临时仓库 E2E + 只读证据约束 | test |

## 验证

- 规划门禁：调用 `preflightRevision` 等价校验章节、REQ/AC 覆盖；调用 task graph validator 校验 ID、依赖和写入范围。
- 静态检查：`npm run typecheck`、`npm run lint`。
- 定向测试：`node --import tsx --test test/review-fixes.test.ts test/workflow.test.ts test/git-orchestrator.test.ts test/cli-e2e.test.ts`。
- 全量回归：`npm test`；若仓库标准门禁另有 build/verify，则按 package scripts 运行。
- 历史证据：不对 `run_01M07FWREF33MXXV5KH7FXY2P1` 执行任何写命令；如需核对仅使用只读 `run show`。
- 截图：本次 CLI/状态机测试预计不产生截图；若测试实际产生截图，只能写入 `.ai-team/plans/20260817-planned-continuation-contract/screenshot/`。

## 发布与回滚

- 发布门禁：packet/schema、continuation/resume、run show、多 TASK E2E 及旧行为回归全部通过，独立评审无阻塞问题。
- 提交边界：规划 revision 与实现可在同一最终提交中精确纳入；不包含用户无关文件或状态库。
- 回滚方式：回滚该提交；不删除或手工修补历史 dispatch/run/state。
- 观察重点：重复 continuation、错误 active recovery decision、错误 worktree 绑定、`.` 授权扩大、direct gate 漂移。
