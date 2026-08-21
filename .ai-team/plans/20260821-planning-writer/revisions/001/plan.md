---
plan_id: 20260821-planning-writer
revision: "001"
target_branch: main
supersedes: null
---

# 实施计划

<!--
结构与填写规则：
1. H1 固定为“实施计划”；H2 使用下列固定章节并保持顺序，不得改名、合并或删除。
2. 实施步骤使用 H3，格式为“STEP-xxx：标题”，并按依赖顺序排列。
3. 仅依据已确认且冻结的 spec.md 制定计划，不得在计划中改写需求。
4. 每一步必须可执行、可验证、可交接；前置步骤未完成时不得执行后续步骤。
5. 每个 REQ/AC 必须至少一次列入“需求覆盖”；重复映射时说明各步骤分别承担的范围。
-->

## 方案摘要

- 方案：按 TDD 顺序先冻结角色/权限、planning 生命周期、环境 source cutover 与迁移测试，再最小实现一等 planning-writer、跨角色 staging 交接和 seed-only 用户环境服务，最后更新 packed-install、README 与项目上下文。
- 关键取舍：writer 使用独立 payload 和最小 execution contract；planning 保留 workflow authority；package default 仅作 seed；runtime 与迁移只读写用户环境目录；迁移先全量预检再写并保留备份。
- 不采用的方案及原因：不复用 planning payload，避免 writer 获得 decision/stage/revision 权限；不持续同步 default，避免覆盖用户文件；不删除用户 legacy 环境，避免数据损失；不保留仓库 runtime fallback，避免双 source of truth。
- 受影响组件：角色常量与 agent-build manifest/schema/assets、result/execution/dispatch/staging contracts、planning lifecycle/CLI、environment/home/install 服务、默认 seed、测试、packed-install、README、MEMORY.md 和 feature navigation。
- 保持不变的行为：不可变 revision、renderer v5、旧 frozen dispatch 审计、Git Operator 独占提交、现有角色 balanced 模型、用户 legacy 环境名称与无关内容。

## 实施步骤

### STEP-001：建立 planning-writer 角色与权限契约

- 目标：以 RED 测试注册第 13 个角色、专用 payload 和最小 capability ceiling，再同步实现所有角色资产和生成器契约。
- 覆盖需求：REQ-001、REQ-002
- 覆盖验收：AC-001、AC-002
- 前置步骤：无
- 输入与已确认依据：冻结 spec；File Explorer dispatch dispatch_01M0J04VJ0JWRXER562GB1AJJ5；dedicated_restricted receipt。
- 读取范围：src/constants.ts、src/agent-build.ts、src/roles.ts、src/contracts.ts、src/execution-contract.ts、agent-build/manifest.yaml、agent-build/schemas/manifest-v1.json、agent-build/schemas/role-v1.json、agent-build/roles/planning.yaml、test/agent-build.test.ts、test/dispatch/contracts.test.ts、test/cli/staging-dispatch.test.ts。
- 写入范围：上述角色/契约源与测试；新增 agent-build/roles/planning-writer.yaml 和 planning-writer.md。
- 执行动作（按顺序）：
  1. 在 agent-build、result contract 和 staging/actor authorization 测试中添加 planning-writer 存在性、专用 payload、owned entries、空 delegates 和拒绝越权操作的断言，运行目标命令取得 RED。
  2. 将 planning-writer 加入 Role、manifest 和严格 schema，并新增 YAML/Markdown 角色资产。
  3. 定义严格 PlanningWriterPayload 和 result template，更新 ROLE_PAYLOAD_SCHEMAS、execution contract 与角色生成逻辑。
  4. 将 planning 的 delegates 增加 planning-writer，但不向 writer 添加 decision、revision、Git、test、discovery 或仓库写入能力。
  5. 运行目标测试至 GREEN，仅整理本步骤新增重复代码。
- 完成条件：角色集合、资产、schema、payload、生成器与权限测试一致；非法操作无副作用；目标测试全部通过。
- 验证命令：node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts
- 证据路径或预期结果：测试输出全部 pass；生成清单为 13 角色；planning-writer contract 只拥有三个 staging kind。
- 失败处理：停止后续步骤，保留现场并说明阻塞；不得跳过门禁。
- 交接产物：角色资产、schema/payload/ceiling 变更、RED/GREEN 输出和剩余 digest 兼容风险。

### STEP-002：实现 planning 门禁委派与 staging 交接

- 目标：让 planning 在两个已确认门禁后委派 writer，并安全消费 writer-owned planning staging，而不转移 planning authority。
- 覆盖需求：REQ-003、REQ-004
- 覆盖验收：AC-003、AC-004
- 前置步骤：STEP-001
- 输入与已确认依据：STEP-001 的 planning-writer 角色契约；冻结 planning decisions/task preview 规则；source dispatch 与 digest 字段要求。
- 读取范围：src/dispatch/planning.ts、src/dispatch/planning-lifecycle.ts、src/dispatch/packet.ts、src/dispatch/submission-lifecycle.ts、src/contracts.ts、src/staging.ts、src/commands/planning-run.ts、test/dispatch/planning-lifecycle.test.ts、test/dispatch/contracts.test.ts、test/cli/staging-dispatch.test.ts、test/cli/planning.test.ts。
- 写入范围：上述 planning/dispatch/staging/CLI 实现与测试。
- 执行动作（按顺序）：
  1. 添加需求 confirm 后 spec/plan 委派、task preview approve 后 tasks 委派、其他状态不委派的生命周期测试并取得 RED。
  2. 添加 writer payload 来源、run/kind/digest 校验、planning 受控消费和重复消费拒绝测试并取得 RED。
  3. 扩展 planning continuation packet，使其冻结 source planning dispatch、input digest、target document kind/stage 和允许输入范围。
  4. 实现 writer 完成后的 planning continuation，以及仅 planning 可执行的 writer staging validate/consume 桥接。
  5. 确保 writer 结果不会直接创建 decision、transition、revision 或 Git Operator dispatch；运行目标测试至 GREEN。
- 完成条件：两个委派门禁、两个文档 kind、来源审计和单次消费均有测试；旧 planning decision/revision 路径保持通过。
- 验证命令：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts test/cli/planning.test.ts
- 证据路径或预期结果：测试输出全部 pass；dispatch/staging receipt 含 source identity 与 digest；非法或重复交接无 revision 副作用。
- 失败处理：停止后续步骤，保留现场并说明阻塞；不得跳过门禁。
- 交接产物：planning-writer dispatch lifecycle、受控 staging handoff、RED/GREEN 输出和兼容说明。

### STEP-003：切换 seed-only 用户环境并迁移现有配置

- 目标：删除三份仓库旧环境源，新增完整 default seed，并让运行时只使用用户目录，同时安全迁移所有用户环境的 writer 配置。
- 覆盖需求：REQ-005、REQ-006、REQ-007、REQ-008
- 覆盖验收：AC-005、AC-006、AC-007、AC-008
- 前置步骤：STEP-001、STEP-002
- 输入与已确认依据：balanced_baseline、roufemad_terra、seed_once_then_home_authoritative、preserve_as_user_owned 和 require_external_config receipts；STEP-001 的 13 角色 schema。
- 读取范围：src/agent-build.ts、src/environment.ts、src/home.ts、src/commands/environment.ts、src/cli.ts、agent-build/schemas/environment-v1.json、agent-build/environments/balanced.yaml、quality.yaml、economy.yaml、test/agent-build.test.ts、test/environment.test.ts、test/cli/project-runtime.test.ts、test/tasks-and-version-gates.test.ts、test/gates-and-planning-commit.test.ts、scripts/verify-packed-install.ts、package.json。
- 写入范围：环境 loader/service/CLI/schema/tests/pack 脚本；删除三份旧 seed；新增 agent-build/environments/default.yaml。
- 执行动作（按顺序）：
  1. 添加 default 资源、精确模型映射、Claude fallback、package 内容、首次 seed/no-overwrite、home-only provenance、缺失失败、legacy 保留、全量预检、幂等和 no-partial-write 测试并取得 RED。
  2. 将 agent-build environment 资源拆分为单一 package seed 与 runtime home discovery，默认活动环境改为 clean install 的 default。
  3. 创建包含全部 13 角色和三平台配置的 default.yaml；现有角色复制 balanced 基线，writer 使用确认的 Codex/OpenCode 映射并继承 Claude default。
  4. 删除 balanced、quality、economy 仓库 seed，更新 schema、打包清单和 packed-install 断言。
  5. 实现显式 install/bootstrap 的 seed-once/no-overwrite；普通 list/load/resolve 对缺失/空/未知环境明确失败。
  6. 实现升级迁移：读取并验证全部用户 YAML，创建受管备份，全量预检通过后只收敛 writer 配置，保留其他内容与文件名；失败不写，重复执行无差异。
  7. 在隔离 AI_TEAM_HOME 运行目标测试至 GREEN，再通过 dry-run 检查三平台代理生成计划。
- 完成条件：default seed 完整；package 不含三份旧源；runtime provenance 只指向用户目录；迁移保护、幂等、失败回滚和模型解析全部通过。
- 验证命令：node --import tsx --test test/agent-build.test.ts test/environment.test.ts test/cli/project-runtime.test.ts test/tasks-and-version-gates.test.ts test/gates-and-planning-commit.test.ts && npm run build && node --import tsx scripts/verify-packed-install.ts
- 证据路径或预期结果：目标测试与 packed install 全部 pass；文件/digest 断言证明已有 default 不覆盖、legacy 保留、差异仅 writer、普通 runtime 无 repo fallback。
- 失败处理：停止后续步骤，保留现场并说明阻塞；恢复测试用户目录备份，不对真实用户目录执行未验证迁移。
- 交接产物：default seed、环境 cutover/migration 实现、package 变更、隔离 RED/GREEN 证据和真实环境同步前门禁。

### STEP-004：更新上下文并完成发布门禁

- 目标：同步用户文档和规范上下文，执行全量验证，并在通过后由 Environment Operator 使用发布版本迁移真实用户环境。
- 覆盖需求：REQ-009；复核 REQ-001、REQ-002、REQ-003、REQ-004、REQ-005、REQ-006、REQ-007、REQ-008
- 覆盖验收：AC-009；复核 AC-001、AC-002、AC-003、AC-004、AC-005、AC-006、AC-007、AC-008
- 前置步骤：STEP-001、STEP-002、STEP-003
- 输入与已确认依据：前三步 GREEN 证据；File Explorer project_context；项目 MEMORY 与 feature navigation 维护规则。
- 读取范围：README.md、MEMORY.md、.ai-team/index/feature-navigation.md、src/context.ts、package.json、scripts/verify-packed-install.ts 及前三步全部验证结果。
- 写入范围：README.md、MEMORY.md、.ai-team/index/feature-navigation.md 和必要的测试/打包期望；真实 ~/.config/ai-team/environments 仅由已授权 Environment Operator 通过发布后的 ai-team install 操作。
- 执行动作（按顺序）：
  1. 更新 README 的角色、default seed、用户目录 source of truth、缺失错误、升级迁移与模型说明。
  2. 通过 ai-team context update 同步 planning-writer 与 seed-only environment 的职责、入口和模块边界，再运行 context validate。
  3. 运行 typecheck、lint、全部测试、build 和 packed-install；任何失败均返回对应步骤修复，不跳过。
  4. 在发布包和隔离 AI_TEAM_HOME 上执行 ai-team install --dry-run --platform codex,claude,opencode，确认迁移计划只包含 writer 与预期生成资产。
  5. 全部门禁通过后，由 Environment Operator 备份并执行发布版本 ai-team install --platform codex,claude,opencode，同步真实用户目录；验证 default 和现有环境。
- 完成条件：完整验证全部退出 0；上下文 current；真实环境迁移有备份、receipt 和验证结果；无未解决阻塞。
- 验证命令：npm run typecheck && npm run lint && npm test && npm run build && node --import tsx scripts/verify-packed-install.ts && ai-team context validate --project .
- 证据路径或预期结果：命令全部退出 0；README/MEMORY/navigation 不再描述 12 roles 或 legacy bundled runtime；Environment Operator receipt 显示用户文件保留且 writer 可解析。
- 失败处理：停止后续步骤，保留现场并说明阻塞；代码问题回到对应步骤，真实环境问题在旧版本运行前恢复备份。
- 交接产物：完整验证记录、packed package、更新后的规范上下文、环境迁移 receipt、发布与回滚说明。

## 需求覆盖

| 需求/验收 ID | 实施步骤 | 实施位置 | 验证命令或证据 | 责任角色 |
| --- | --- | --- | --- | --- |
| REQ-001 | STEP-001 | src/constants.ts、agent-build/manifest.yaml、schemas、roles、src/contracts.ts | agent-build/contracts 目标测试 | backend-developer |
| AC-001 | STEP-001 | test/agent-build.test.ts、test/dispatch/contracts.test.ts | node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts | test |
| REQ-002 | STEP-001 | role manifest、execution contract、staging ownership | contracts/staging 目标测试 | backend-developer |
| AC-002 | STEP-001 | test/dispatch/contracts.test.ts、test/cli/staging-dispatch.test.ts | node --import tsx --test test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts | test |
| REQ-003 | STEP-002 | src/dispatch/planning.ts、planning-lifecycle.ts | planning lifecycle 目标测试 | backend-developer |
| AC-003 | STEP-002 | test/dispatch/planning-lifecycle.test.ts、test/cli/planning.test.ts | node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts | test |
| REQ-004 | STEP-002 | src/contracts.ts、src/staging.ts、submission lifecycle、planning-run CLI | dispatch/staging/planning 目标测试 | backend-developer |
| AC-004 | STEP-002 | planning lifecycle、contracts、staging、planning CLI tests | STEP-002 验证命令 | test |
| REQ-005 | STEP-003 | default.yaml、environment schema/service | agent-build/environment 目标测试 | backend-developer |
| AC-005 | STEP-003 | test/agent-build.test.ts、test/environment.test.ts | node --import tsx --test test/agent-build.test.ts test/environment.test.ts | test |
| REQ-006 | STEP-003 | agent-build/environments、package、packed install | build 与 verify-packed-install | backend-developer |
| AC-006 | STEP-003 | test/agent-build.test.ts、scripts/verify-packed-install.ts | npm run build && node --import tsx scripts/verify-packed-install.ts | test |
| REQ-007 | STEP-003 | src/environment.ts、src/home.ts、environment CLI | environment/project runtime 目标测试 | backend-developer |
| AC-007 | STEP-003 | test/environment.test.ts、test/cli/project-runtime.test.ts | node --import tsx --test test/environment.test.ts test/cli/project-runtime.test.ts | test |
| REQ-008 | STEP-003 | environment migration、backup/restore、install | migration/version gate 目标测试 | backend-developer |
| AC-008 | STEP-003 | environment、project runtime、version gate tests | STEP-003 验证命令 | test |
| REQ-009 | STEP-004 | README.md、MEMORY.md、feature-navigation.md、全部门禁 | 完整验证与 context validate | backend-developer |
| AC-009 | STEP-004 | package scripts、packed install、canonical context | STEP-004 验证命令 | test、environment-operator |

## 验证

按以下顺序执行；不适用项写明“不适用”及理由，不得留空。

1. 单元测试：node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts test/environment.test.ts；覆盖 REQ-001、REQ-002、REQ-005、REQ-006 与 AC-001、AC-002、AC-005、AC-006；全部测试 pass。
2. 集成或 smoke test：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/cli/staging-dispatch.test.ts test/cli/planning.test.ts test/cli/project-runtime.test.ts test/tasks-and-version-gates.test.ts test/gates-and-planning-commit.test.ts；覆盖 REQ-003、REQ-004、REQ-007、REQ-008 与 AC-003、AC-004、AC-007、AC-008；无未预期状态或用户文件副作用。
3. 静态检查：npm run typecheck && npm run lint；退出 0，无类型或 lint 错误。
4. 构建或打包：npm run build && node --import tsx scripts/verify-packed-install.ts；dist 和 npm pack 安装验证通过，包只含 default seed，生成 13 角色。
5. 手工验证：不适用；writer 权限、staging receipt、环境文件差异和平台代理内容均由 CLI/packed-install 自动化断言，真实用户目录同步由 Environment Operator receipt 记录。
6. 失败处理：从首个失败命令定位对应 STEP；停止后续步骤；staging 失败复用未消费 staging；环境迁移失败恢复备份；旧版本运行前必须移除或恢复不兼容的 writer override。

## 发布与回滚

- 发布前门禁：全部 REQ/AC 已覆盖，验证全部通过，阻塞项为零。
- 发布顺序（含迁移前后关系）：合并角色/契约与 lifecycle；合并环境 seed/source/migration；更新 docs/context；构建并 packed-install；在隔离 home dry-run；备份真实用户环境；安装发布版本并迁移；验证三平台代理。
- 发布后验证命令及预期结果：ai-team env validate default；ai-team env explain default --role planning-writer --platform codex；ai-team env explain default --role planning-writer --platform opencode；预期模型分别为 gpt-5.6-terra/high 与 roufemad/gpt-5.6-terra/high。对现有 active environment 重复 validate/explain，其他角色配置不变。
- 监控指标和观察窗口：本地发布操作完成后的同一维护窗口内检查 install/migration receipt、失败环境数量、生成代理数量、staging/dispatch authorization 错误；任一异常即停止。
- 回滚触发条件：writer 越权门禁失败、planning 误推进、环境非 writer 内容变化、default 被覆盖、任一环境不可解析、完整验证或 packed install 失败。
- 回滚顺序与命令：停止 install/generate；使用 EnvironmentService 既有 restore/备份能力恢复用户环境；确认旧 schema 可解析后回滚包/代码；恢复三份旧仓库 seed 仅作为代码回滚内容，不覆盖用户文件；重跑旧版本 env validate 和相关测试。
- 回滚后验证：旧 active environment 可 validate/generate，用户文件与备份 digest 一致，无 planning-writer 生成资产残留被旧版本消费，旧 frozen dispatch/revision 状态未改变。
