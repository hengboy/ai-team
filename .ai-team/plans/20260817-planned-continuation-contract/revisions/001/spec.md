---
plan_id: 20260817-planned-continuation-contract
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

## 背景

planned 多 TASK coding run 在 Git Operator 完成 `prepare_implementation_worktree` 后只校验 task worktree 已注册，没有持久化后续 Coding coordinator。此时 `run resume` 会落入通用 active-run recovery，创建伪恢复 decision，而不是继续生成有权创建 developer dispatch 的 Coding continuation。现有 run `run_01M07FWREF33MXXV5KH7FXY2P1` 必须保持原状，作为该缺陷的只读回归证据。

## 目标

- [ ] 修复多 TASK planned run 在 implementation worktree prepare 完成后的 durable Coding continuation。
- [ ] 统一 dispatch packet、路径授权、planned gate、retry replacement、resume 和 `run show` 的公开契约。
- [ ] 以完整 E2E 证明 prepare、developer、test、commit、无 fast-forward merge、下一 TASK 派生和恢复幂等。
- [ ] 保持单 TASK planned、direct run 和普通 recovery 行为兼容。

## 非目标

- 不领取、恢复、取消、重发或修改 `run_01M07FWREF33MXXV5KH7FXY2P1`。
- 不直接修改 SQLite 或其他状态库记录。
- 不改变 unrelated workflow、Git 分支策略或角色权限。
- 不为 planned run 引入额外 feature flag、兼容层或迁移框架。

## 用户场景

### 场景 1：多 TASK prepare 后自动续接

Coding coordinator 为当前 TASK 创建 `implementation_prepare` Git Operator dispatch；Git Operator 注册 task worktree 并成功完成后，系统幂等创建 durable Coding continuation。该 continuation 继承 Explorer 授权、task/worktree 身份和 prepare lineage，并可创建 developer dispatch。

### 场景 2：中断后恢复

进程在 prepare 完成后中断。用户执行 `run resume` 时，系统补建或返回同一 continuation，不创建 `active_run_recovery` decision；重复 resume 不产生重复 dispatch。

### 场景 3：诊断当前阻塞点

用户执行 `run show`，可直接看到 pending dependency、continuation 状态和下一条建议命令，无需从原始 events/dispatches 推断。

## 功能需求

- REQ-001：Git `prepare_implementation_worktree` 成功完成后，planned 多 TASK run 必须持久化且幂等地派生 Coding continuation，并携带 `explorer_dispatch_id`、`worktree_id`、当前 task 身份及 prepare dispatch lineage。
- REQ-002：新 continuation 必须是创建当前 task developer dispatch 的授权主体；resume 必须优先修复该缺失 continuation，再进入通用 active-run recovery。
- REQ-003：dispatch packet schema 与 template 必须按 phase/role 公开必填 context，包括适用阶段的 `explorer_dispatch_id` 和 `worktree_id`。
- REQ-004：dispatch packet unknown-field 错误必须返回具体 JSON pointer，例如 `/depends_on`。
- REQ-005：`allowed_read_paths` 中 `.` 必须具有明确、一致的项目根递归授权语义，并在 packet 继承和 scope matching 中一致执行。
- REQ-006：公开说明 planned run 不适用 direct `pre_write` scope gate；planned 写入授权来自冻结 TASK、Explorer 授权与 implementation prepare 完成。
- REQ-007：resolved retry replacement 必须直接表达已确定的恢复动作和 lineage，不得再次要求用户重复选择恢复动作。
- REQ-008：`run show` 必须输出 pending dependency、durable continuation 和基于当前状态的建议命令。
- REQ-009：增加多 TASK planned E2E，覆盖 prepare、developer、test、commit、`--no-ff` merge、下一 TASK 基于 merge commit 派生及 resume 幂等。
- REQ-010：保持旧单 TASK planned、direct run、普通 recovery 和 commit continuation 语义不回归。

## 验收标准

- AC-001：完成 TASK-001 的 `prepare_implementation_worktree` dispatch 后，恰好存在一个 pending Coding continuation，包含正确 Explorer、task worktree、task 与 prepare dispatch 身份。
- AC-002：在上述状态调用 resume 一次或多次均返回/保留同一 continuation，且不创建 `active_run_recovery` decision。
- AC-003：该 Coding continuation 可创建 worktree 绑定正确的 developer dispatch；无继承身份或错误 worktree 的请求被拒绝。
- AC-004：dispatch schema/template 明确列出 phase/role context 要求；未知顶层字段 `depends_on` 的错误详情包含 pointer `/depends_on`。
- AC-005：Explorer 的 `allowed_read_paths: ["."]` 可递归授权项目内路径，并能被下游精确子集授权继承；越界路径仍被拒绝。
- AC-006：planned run 不调用 direct `pre_write` gate，且文档/角色契约明确其替代门禁；direct run 原 gate 测试保持通过。
- AC-007：已 resolved retry decision 的 replacement 输出恢复动作、来源 decision 与 replacement lineage，重复 resume 不再创建选择 decision。
- AC-008：`run show` 对等待依赖、可领取 continuation 和需执行恢复动作的状态分别给出稳定机器字段与建议命令。
- AC-009：多 TASK E2E 完成 TASK-001 的 prepare、developer、test、commit 与无 fast-forward merge，并证明 TASK-002 从该 merge commit 派生。
- AC-010：全量或等价回归证明单 TASK planned、direct run、普通 recovery、commit continuation 与 resume 幂等保持通过。
- AC-011：指定历史 run 及其 dispatch、decision、worktree 不发生任何写入或状态变化。

## 数据与接口

- dispatch packet 的顶层字段保持兼容；`context` 增加按 role/phase 判定的必填约束与公开 schema/template 描述。
- continuation 使用现有 dispatch/state 持久化，不新增平行状态源；幂等键由 run、当前 task、phase 与 prepare lineage 推导。
- `run show` 在现有 JSON envelope 中新增稳定投影字段，原始 run、events、decisions、dispatches、worktrees 保留。
- validation detail 采用现有 `pointer`/`constraint`/`message` 风格，不改变成功响应。

## 兼容约束

- 既有状态库无需破坏性迁移；历史 dispatch 缺少新 context 时只在创建/提交适用的新 packet 时执行 phase/role 校验。
- 单 TASK planned 继续复用 plan worktree，不误创建 implementation prepare continuation。
- direct run 继续执行 `pre_write` scope gate；普通 retry/recovery 与 `continue_commit` 保持原有入口。
- CLI 新字段为增量输出，不删除已有机器字段。

## 安全约束

- continuation 只能继承已完成 Explorer dispatch 的授权，不能扩大 `allowed_read_paths`。
- developer dispatch 必须绑定已注册且属于当前 TASK 的 worktree。
- `.` 仅代表项目根内递归授权，不能越过 canonical project root。
- 不直接改写状态库；所有新状态通过现有 service/store API 持久化。

## 错误与边界

- prepare dispatch 成功但 worktree 未注册时继续返回现有一致性错误，不创建 continuation。
- 重复 completion、重复 resume 或进程重启不得创建重复 continuation。
- 0/1 TASK planned run 不进入多 TASK task-worktree continuation 路径。
- 未知 packet 字段、缺失 phase context、错误 Explorer/worktree identity 必须在副作用前失败并返回精确 pointer。
- `run show` 无可执行下一步时返回明确空值，不伪造命令。

## 迁移发布回滚

- 发布顺序：先发布 packet validation/schema 与路径授权修复，再发布 continuation/resume/show 状态转换，最后启用完整 E2E 门禁。
- 无数据库迁移；新增 dispatch context 使用现有 JSON 存储。
- 回滚以完整提交回滚为单位；不得通过删除 continuation 或修改历史 run 状态回滚。
- 指定历史 run 只执行只读 `run show`（若需要人工证据），禁止执行 `run resume`。

## 已确认偏好

- 用户明确要求进入 Planning 并冻结计划后才实施，不使用 direct feature/bug 绕过规划。
- 用户明确要求当前会话不使用 ai-team 执行。
- 用户明确要求保留 `run_01M07FWREF33MXXV5KH7FXY2P1` 作为回归证据。
- 用户明确要求先由 File Explorer 定位入口、状态机、packet schema、validation、resume recovery 与测试。
- 用户明确要求最终实施、测试、评审并提交。

## 默认取舍

- 采用现有 dispatch 作为 durable continuation，不新增 continuation 表或兼容层。
- planned scope gate 采用“明确不适用 direct pre_write，并记录替代门禁”的方案。
- `.` 统一解释为项目根递归授权，同时保持 canonical root 越界拒绝。
- E2E 使用临时状态与 Git 仓库，不复用或修改指定历史 run。

## 已关闭问题

- 问题：prepare 完成后应创建 recovery decision 还是 Coding continuation。结论：创建 durable Coding continuation。
- 问题：planned 是否复用 direct pre_write。结论：不适用；使用冻结 TASK、Explorer 授权和 prepare completion。
- 问题：是否可修改历史 run 验证修复。结论：不可；仅可作为只读证据。
- 问题：是否需要数据库迁移。结论：优先复用现有 dispatch/context 持久化，不新增状态结构。

## 未决问题

- 无。
