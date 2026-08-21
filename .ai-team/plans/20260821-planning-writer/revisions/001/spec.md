---
plan_id: 20260821-planning-writer
revision: "001"
target_branch: main
supersedes: null
---

# 规格说明

<!--
结构与填写规则：
1. H1 固定为“规格说明”；H2 使用下列固定章节并保持顺序，不得改名、合并或删除。
2. 场景、需求和验收标准使用 H3，格式分别为“场景 N：标题”“REQ-xxx：标题”“AC-xxx：标题”。
3. 只记录已确认事实；未知内容放入“未决问题”，不得补写为默认事实。
4. 每条功能需求和验收标准使用唯一、连续的 REQ/AC ID，并建立明确对应关系。
5. 每个 AC 必须定义可在实施前观察到的 RED 失败、实施后可观察结果、边界反例和建议测试层级。
6. 本文件经用户最终确认并写入 revision 后即冻结，不得修改；需求变化必须创建新 revision。
-->

## 背景

- 现状：AI Team 当前只有 12 个一等角色；planning 同时负责需求决策、规划文档生成、revision 创建和 Git Operator 交接。仓库还内置 balanced、quality、economy 三份环境源，并在 bootstrap 时同步到用户目录。
- 触发原因：用户要求把规划文档编写职责交给独立 planning-writer，同时让用户环境目录成为运行时唯一配置来源。
- 相关用户：使用 planning 工作流的 AI Team 操作者、维护角色与环境契约的开发者、升级既有 AI Team 安装的用户。
- 已知约束：Node.js 版本不低于 22.13.0；planning revision 不可变；JSON 通过受管 staging 传递；Git 只由 Git Operator 执行；旧冻结 dispatch 不得改写。

## 目标

- 新增可生成 Codex、Claude、OpenCode 代理资产的一等 planning-writer 角色。
- 让 planning 在已确认门禁后委派 writer 生成 spec、plan、tasks 及 metadata，并继续独占决策、阶段推进、revision 和 Git 交接。
- 把 ~/.config/ai-team/environments 设为运行时唯一环境来源，以 seed-only default.yaml 支持首次安装，并安全迁移既有用户环境。
- 通过角色契约、planning 生命周期、环境迁移、打包和上下文测试证明行为。

## 非目标

- planning-writer 不探索未知路径、不做需求或任务决策、不运行测试、不修改产品代码、不执行 Git、不委派其他角色。
- 不删除或重命名用户目录中已有的 balanced.yaml、quality.yaml、economy.yaml 或其他自定义环境文件。
- 不迁移或改写已有冻结 dispatch、revision、state schema 或 renderer v5 资产。
- 除新增 planning-writer 外，不改变 default.yaml 中现有角色的 balanced 模型基线。
- 不保留运行时从仓库环境源或隐藏默认值回退的兼容路径。

## 用户场景

### 场景 1：生成规格与实施计划

- 前置条件：完整需求列表已通过 confirm receipt，planning 持有冻结需求与仓库证据。
- 操作：planning 创建目标为 planning-documents 的 planning-writer dispatch。
- 预期结果：writer 写入 spec、plan、plan metadata staging 并提交专用结果；planning 验证来源和 digest 后继续流程。
- 异常或边界结果：需求未最终确认、输入未冻结或来源 dispatch 不匹配时不得创建或消费 writer 产物。

### 场景 2：生成任务文档

- 前置条件：用户选择拆分任务且 task preview receipt 已批准。
- 操作：planning 创建目标为 planning-tasks 的 planning-writer dispatch。
- 预期结果：writer 按冻结任务预览生成 tasks 文档和 metadata staging；planning 验证后创建带任务文档的 revision。
- 异常或边界结果：no_split、pending 或 revise 状态不得生成任务 staging。

### 场景 3：首次安装默认环境

- 前置条件：用户目录不存在 default.yaml。
- 操作：显式执行 install 或 bootstrap。
- 预期结果：系统只复制一次仓库 default.yaml，clean install 将 active_environment 设为 default，并从用户目录生成各平台代理。
- 异常或边界结果：default.yaml 已存在时字节内容不被覆盖；普通 list/load/resolve 不隐式播种。

### 场景 4：升级既有用户环境

- 前置条件：用户目录包含 balanced、quality、economy 或自定义 YAML。
- 操作：升级安装先预检全部环境，再为每份可解析配置同步 planning-writer 模型映射。
- 预期结果：所有环境具备 writer 配置，其他角色、默认值、自定义字段和值保持不变，旧环境文件继续由用户自管。
- 异常或边界结果：任一配置非法时迁移在写入前失败，不产生部分更新；回滚可恢复迁移前备份。

### 场景 5：诊断缺失环境

- 前置条件：普通运行时命令遇到目录缺失、目录为空或请求名称不存在。
- 操作：执行 env list/load/validate/explain/generate 或依赖环境解析的命令。
- 预期结果：命令以可诊断 ValidationError 和非零退出状态失败，不读取仓库环境源，也不合成旧默认配置。
- 异常或边界结果：显式 install/bootstrap 仍可按场景 3 首次播种 default.yaml。

## 功能需求

### REQ-001：注册一等 planning-writer 角色

- 描述：在运行时角色枚举、agent-build manifest/schema、角色 YAML/Markdown、结果 payload 映射和三平台代理生成中注册 planning-writer。
- 输入：当前角色契约、manifest、schema、生成器和已确认角色名称。
- 输出：完整第 13 个角色资产、专用结果 schema/template、更新后的 manifest 与 contract digest。
- 约束：manifest、ROLES、角色资源和 environment override 键集合必须一致；缺少任一资产时启动或构建失败。
- 对应验收：AC-001

### REQ-002：限制 writer 权限与执行能力

- 描述：writer 只处理 planning 冻结输入和受管 staging，不拥有 planning 主代理权限。
- 输入：带 source planning dispatch、冻结输入 digest、目标文档类型和精确允许路径的 packet。
- 输出：planning-documents、planning-tasks 或 dispatch-result staging；不得产生其他副作用。
- 约束：staging.owned_entries 仅含 planning-documents、planning-tasks、dispatch-result；delegates 为空；不得拥有 decision、revision、Git、测试、未知路径发现或仓库产品写入命令/工具。
- 对应验收：AC-002

### REQ-003：由 planning 按门禁委派 writer

- 描述：planning 主代理负责创建和协调 writer dispatch，并保持所有决策与阶段推进权。
- 输入：已确认需求 receipt 或已批准 task preview receipt，以及对应冻结规划输入。
- 输出：spec/plan writer dispatch 或 tasks writer dispatch，包含来源 planning dispatch 和冻结 digest。
- 约束：最终需求确认前不得委派 planning-documents；task preview 未 approve 或选择 no_split 时不得委派 planning-tasks；writer 提交后 continuation 返回 planning。
- 对应验收：AC-003

### REQ-004：受管交接规划文档 staging

- 描述：新增 writer 专用 payload，允许 planning 验证并消费 writer 所有的规划 staging，而不把 writer 当作 planning 替代角色。
- 输入：writer result envelope 与 writer 创建的 ready staging。
- 输出：包含 document_kind、source_planning_dispatch_id、frozen_input_digest、staging_id、staging_digest 的专用 payload 和可审计 submission receipt。
- 约束：来源、run、dispatch、目标文档类型和 digest 必须一致；同一 staging 只能消费一次；invalid、pending、重复或未冻结输入必须拒绝。
- 对应验收：AC-004

### REQ-005：配置 writer 的跨平台模型

- 描述：在 default seed 和全部用户环境迁移中配置 planning-writer 模型。
- 输入：环境 defaults 与用户确认的模型映射。
- 输出：Codex 使用 gpt-5.6-terra 和 reasoning high；OpenCode 使用 roufemad/gpt-5.6-terra 和 variant high；Claude 不写角色 override 并继承环境默认值。
- 约束：三种平台解析均通过 environment schema；OpenCode 保留合法 options 对象；迁移不得改变其他角色模型。
- 对应验收：AC-005

### REQ-006：以 default.yaml 替换仓库旧环境源

- 描述：删除 agent-build/environments 下 balanced.yaml、quality.yaml、economy.yaml，新增完整 default.yaml。
- 输入：当前 balanced 模型矩阵、13 角色集合和三平台 schema。
- 输出：name 为 default 的 seed，包含全部角色及 Codex、Claude、OpenCode 配置；现有角色沿用 balanced 基线，writer 使用 REQ-005 映射。
- 约束：打包产物只携带 default seed，不携带三份旧仓库环境源；旧用户文件不因此删除。
- 对应验收：AC-006

### REQ-007：用户环境目录成为运行时唯一来源

- 描述：分离 package seed 加载与 runtime 环境发现，运行时只读取 AI_TEAM_HOME/environments 对应的用户目录。
- 输入：显式 install/bootstrap 或普通运行时环境命令。
- 输出：install/bootstrap 在 default.yaml 缺失时播种一次且绝不覆盖；普通运行时从用户目录解析环境。
- 约束：clean install active_environment 为 default；普通 list/load/resolve 不调用隐式播种，不读取仓库 YAML，不合成 legacy defaults。
- 对应验收：AC-007

### REQ-008：迁移并保留既有用户环境

- 描述：升级时对用户目录全部环境 YAML 做先读后写迁移，为 writer 同步 REQ-005 配置并保留其余内容。
- 输入：用户目录中 balanced、quality、economy 和自定义环境文件。
- 输出：迁移前受管备份、全量预检结果、更新后的用户文件和可诊断迁移结果。
- 约束：不删除或重命名旧文件；不得覆盖无关配置；任一文件非法时不得写入任何文件；重复执行结果幂等；已有 writer 映射收敛到确认值。
- 对应验收：AC-008

### REQ-009：同步验证、文档和项目上下文

- 描述：更新角色、environment、planning lifecycle、CLI/packed-install 测试以及 README、MEMORY.md、feature navigation。
- 输入：REQ-001 至 REQ-008 的实现路径和冻结仓库证据。
- 输出：自动化测试、打包验证、用户文档和规范上下文全部反映新角色与环境来源边界。
- 约束：使用 ai-team context update 和 ai-team context validate；不在 planning 阶段运行测试；实现完成后全量门禁必须通过。
- 对应验收：AC-009

## 验收标准

### AC-001：角色契约与生成资产完整

- Given：当前运行时、manifest、schema 和生成器只有 12 个角色且不存在 planning-writer 资产。
- When：新增角色契约并为三平台生成代理。
- Then：ROLES、manifest、schema、ROLE_PAYLOAD_SCHEMAS、角色 YAML/Markdown 和生成结果一致包含 13 个角色。
- 覆盖需求：REQ-001
- RED 判定：先增加 planning-writer 契约断言后，node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts 因角色被拒绝、资源缺失或生成数量仍为 12 而非零退出。
- 可观察结果：同一命令退出 0，生成清单包含 planning-writer，manifest 与 contract digest 更新。
- 边界反例：只改 constants 但缺 role YAML、Markdown、payload 或 schema 时测试必须失败。
- 建议测试层级：单元测试与生成契约测试。
- 验证命令或证据路径：node --import tsx --test test/agent-build.test.ts test/dispatch/contracts.test.ts

### AC-002：writer 越权操作被拒绝

- Given：一个合法 planning-writer dispatch 和冻结 packet。
- When：writer 尝试创建 decision、revision、Git dispatch、委派、探索未知路径、运行测试或写仓库产品路径。
- Then：操作被 role manifest、execution contract、actor authorization 或 staging ownership 拒绝，且无状态、Git 或文件副作用。
- 覆盖需求：REQ-002
- RED 判定：先加入权限边界断言后，当前系统因角色不存在或无法表达独立 writer ceiling 而非零退出。
- 可观察结果：非法命令返回 ValidationError/退出码 2，合法 planning-documents、planning-tasks、dispatch-result staging 仍可创建和提交。
- 边界反例：把 writer 加入 planning payload 或给予 decision/planning revision 命令时测试必须失败。
- 建议测试层级：契约单元测试与 CLI 集成测试。
- 验证命令或证据路径：node --import tsx --test test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts

### AC-003：planning 只在确认门禁后委派

- Given：planning run 分别处于需求未确认、需求已 confirm、任务预览 pending、任务预览 approve 和 no_split 状态。
- When：planning lifecycle 计算 continuation。
- Then：仅需求 confirm 后创建 planning-documents writer dispatch，仅 task preview approve 后创建 planning-tasks writer dispatch，writer 完成后 continuation 返回 planning。
- 覆盖需求：REQ-003
- RED 判定：先加入生命周期断言后，当前实现只继续 planning role，找不到 planning-writer dispatch，命令非零退出。
- 可观察结果：dispatch role、目标 kind、source dispatch、frozen digest 和阶段与预期一致；不满足门禁时 dispatch 数量不增加。
- 边界反例：revise、pending、no_split 或 writer 自身结果不得直接推进 revision/Git 阶段。
- 建议测试层级：planning workflow 集成测试。
- 验证命令或证据路径：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/cli/planning.test.ts

### AC-004：writer staging 可审计且只消费一次

- Given：writer 返回专用 payload 和 ready planning-documents 或 planning-tasks staging。
- When：planning 校验来源并执行 revision validate/create 或 task preview 消费。
- Then：同一 run、source dispatch、document kind 和 digest 的 staging 成功交接并只消费一次。
- 覆盖需求：REQ-004
- RED 判定：先加入跨角色受管交接断言后，当前 planning loader 只接受 role planning staging，命令非零退出。
- 可观察结果：receipt 记录 writer dispatch、staging ID/digest 和 consumed 状态；重复消费返回拒绝且 revision 不重复创建。
- 边界反例：来源 dispatch、frozen digest、kind、run 或 staging digest 任一不匹配时必须失败并保留现场。
- 建议测试层级：dispatch/staging CLI 集成测试。
- 验证命令或证据路径：node --import tsx --test test/dispatch/planning-lifecycle.test.ts test/dispatch/contracts.test.ts test/cli/staging-dispatch.test.ts test/cli/planning.test.ts

### AC-005：模型映射跨平台解析正确

- Given：default seed 和待迁移用户环境具有 Codex、Claude、OpenCode defaults。
- When：解析 planning-writer 在三个运行器上的 resolved environment。
- Then：Codex 为 gpt-5.6-terra/high，OpenCode 为 roufemad/gpt-5.6-terra/high，Claude 与该环境 default 完全一致。
- 覆盖需求：REQ-005
- RED 判定：先把 planning-writer 加入 required overrides 和模型断言后，当前环境 schema/YAML 缺少角色而非零退出。
- 可观察结果：env explain 或环境解析测试输出精确 model/intensity/provenance，其他角色解析结果不变。
- 边界反例：OpenCode 使用无 provider ID、Claude 被写入 GPT 模型或任一环境遗漏 writer 时测试失败。
- 建议测试层级：环境 schema 单元测试与代理生成测试。
- 验证命令或证据路径：node --import tsx --test test/agent-build.test.ts test/environment.test.ts

### AC-006：打包只提供完整 default seed

- Given：当前仓库和 npm 包含 balanced、quality、economy 三个环境源且没有 default.yaml。
- When：完成环境资源 cutover 并打包安装。
- Then：仓库与包只提供 default.yaml，文件包含 13 个角色和三平台模型配置，现有角色保持 balanced 基线。
- 覆盖需求：REQ-006
- RED 判定：先加入 package/default 断言后，当前因 default 缺失和三个旧文件仍存在而非零退出。
- 可观察结果：agent-build loader 只加载 default seed，packed-install 检查通过且生成角色数为 13。
- 边界反例：旧源仍被打包、default 缺任一角色/平台或现有角色模型偏离 balanced 基线时失败。
- 建议测试层级：agent-build 单元测试与 packed-install 系统测试。
- 验证命令或证据路径：node --import tsx --test test/agent-build.test.ts test/environment.test.ts && npm run build && node --import tsx scripts/verify-packed-install.ts

### AC-007：首次播种且运行时只认用户目录

- Given：clean AI_TEAM_HOME、已有自定义 default.yaml、以及普通运行时缺失环境三种状态。
- When：分别执行显式 install/bootstrap 和普通 env list/load/resolve。
- Then：clean install 只播种一次并激活 default；已有 default 字节不变；普通运行时只读取用户目录并在缺失时失败。
- 覆盖需求：REQ-007
- RED 判定：先加入 source-of-truth 与 no-overwrite 断言后，当前 bootstrap 会同步全部 bundled 环境并将 active_environment 设为 balanced，命令非零退出。
- 可观察结果：用户目录文件集合、内容 digest、active_environment 和 provenance 明确显示 default seed 或用户文件来源，不出现仓库运行时来源。
- 边界反例：普通 list/load 自动重建配置、已有 default 被覆盖或目标缺失时回退 balanced 均必须失败。
- 建议测试层级：EnvironmentService 与 CLI 集成测试。
- 验证命令或证据路径：node --import tsx --test test/environment.test.ts test/cli/project-runtime.test.ts

### AC-008：用户环境迁移保留数据并具备原子失败

- Given：隔离 AI_TEAM_HOME 中包含合法旧环境、自定义环境、已有 writer 映射和非法 YAML 的组合。
- When：执行升级 install/bootstrap migration。
- Then：全量预检成功时每个环境收敛 writer 配置且其他内容不变；任一预检失败时所有原文件保持不变并返回诊断。
- 覆盖需求：REQ-008
- RED 判定：先加入迁移、幂等、保留和 no-partial-write 断言后，当前实现不会迁移用户环境且 schema 不接受 writer，命令非零退出。
- 可观察结果：迁移前备份存在，合法文件差异只涉及 writer，第二次执行无差异，旧环境文件名和自定义内容保留。
- 边界反例：删除 legacy 文件、覆盖其他角色、部分更新、重复执行继续改写或非法文件被静默跳过均必须失败。
- 建议测试层级：隔离用户目录的环境迁移集成测试。
- 验证命令或证据路径：node --import tsx --test test/environment.test.ts test/cli/project-runtime.test.ts test/tasks-and-version-gates.test.ts test/gates-and-planning-commit.test.ts

### AC-009：文档、上下文和完整门禁一致

- Given：REQ-001 至 REQ-008 已实现并完成目标测试。
- When：更新 README、MEMORY.md、feature navigation 并执行完整验证与打包检查。
- Then：静态检查、全部测试、构建、packed install 和 context validate 全部退出 0，文档不再声明 legacy bundled 环境或 12 角色行为。
- 覆盖需求：REQ-009
- RED 判定：实施前新增文档/包内容断言会因 README、MEMORY、导航和 packed-install 仍引用 balanced/12 roles 而失败。
- 可观察结果：所有命令退出 0，pack 内容和 context 证据指向 planning-writer 与 seed-only 用户目录边界。
- 边界反例：只更新代码但遗漏 packed-install、README、MEMORY 或功能导航任一项时门禁失败。
- 建议测试层级：静态检查、全量回归、构建、packed-install 与上下文验证。
- 验证命令或证据路径：npm run typecheck && npm run lint && npm test && npm run build && node --import tsx scripts/verify-packed-install.ts && ai-team context validate --project .

## 数据与接口

- 数据结构：新增 Role 值 planning-writer；新增 PlanningWriterPayload，字段为 document_kind、source_planning_dispatch_id、frozen_input_digest、staging_id、staging_digest；environment overrides 增加 planning-writer 键；default.yaml 的 defaults 含 codex、claude、opencode。
- 接口与错误码：沿用 dispatch create/claim/validate/submit、staging create/write/consume 和 planning revision/task 命令；ValidationError 通过 CLI 退出码 2 报告权限、来源、配置或迁移错误，不新增网络接口。
- 字段兼容要求：writer payload 使用严格 additionalProperties=false；旧 result payload 不改变；旧用户环境保留原字段，迁移仅收敛 planning-writer；旧冻结 dispatch 继续保留原 digest 但不得复用为新角色 dispatch。

## 兼容约束

- 现有行为必须保持：planning 独占 decision、stage、revision 和 Git Operator；旧用户环境文件不删除；现有角色在 default seed 中沿用 balanced 模型；staging/revision 不可变与单次消费保持。
- 支持版本或平台：Node.js 不低于 22.13.0；Codex、Claude、OpenCode；本地 AI_TEAM_HOME 或默认 ~/.config/ai-team。
- 迁移兼容窗口（无则写“无”）：升级时保留用户目录 legacy 环境并继续解析；仓库不再维护对应 seed。旧冻结 dispatch 仅保留审计，不跨新 role-manifest digest 复用。

## 安全约束

- 权限边界：planning-writer 不获得 filesystem.write 到仓库、git.read/git.write、network、decision、revision、test 或 delegate 权限；只通过 process/staging 受管命令写 owned entries。
- 敏感数据处理：环境迁移不记录环境文件中的潜在敏感 options 值；日志只报告相对文件名、状态和错误位置。
- 路径和输入校验：环境文件必须位于解析后的 AI_TEAM_HOME/environments 内并通过既有 canonical path 与 YAML/schema 校验；writer staging 必须绑定同一 run/dispatch/kind/digest。

## 错误与边界

- 非法输入：未知 role、payload 额外字段、错误 dispatch/digest、非法 YAML/schema、无 provider OpenCode model 均以 ValidationError 拒绝。
- 空数据：空环境目录、空 YAML、空 planning 文档、空 acceptance contract 或空 staging 不得进入 ready。
- 超时或外部依赖失败：本方案无网络依赖；文件/SQLite/进程失败时保留 staging 和用户备份，停止后续迁移或 revision 创建。
- 重试和幂等：writer submit 和 staging consume 只能成功一次；default seed 已存在时不写；环境迁移重复执行无差异；失败后基于同一未消费 staging 或已保存备份重试。

## 迁移发布回滚

- 迁移前置条件（无则写“无”）：目标测试先以 RED 证明缺失行为；用户环境全部预检通过；迁移前创建受管备份；当前 planning run 使用新 dispatch 而不复用旧 frozen packet。
- 发布与迁移顺序：先发布角色/schema/payload 与 planning 生命周期，再发布 default seed 和 runtime source cutover，随后执行用户环境预检/迁移，生成三平台代理，最后更新上下文并运行全量门禁。
- 回滚触发条件：角色契约或 planning 门禁可绕过、环境迁移产生非 writer 差异、default 覆盖用户文件、runtime 读取仓库源、完整验证失败。
- 回滚操作及验证：停止生成与后续写入；在运行旧版本前恢复迁移前用户环境备份并移除仅由新安装播种的 default；回滚代码/包；运行旧版本 env validate 与目标测试确认旧环境可解析。不得用旧版本读取带未知 planning-writer 键的未恢复文件。

## 已确认偏好

- 决定：planning-writer 采用独立受限角色；理由：契约层禁止决策和阶段推进；确认来源：decision_01M0HZBMQ6RZYRV0WTXGWDTSQS，choice dedicated_restricted。
- 决定：Terra 使用平台原生映射，Claude 回退环境默认；理由：避免 Claude runner 解析 GPT 模型；确认来源：decision_01M0HZGYRA1GVXMF6BZ9QSF0FV，choice native_terra_with_claude_fallback。
- 决定：用户环境目录覆盖全部环境迁移范围；理由：用户要求完全以该目录为准；确认来源：decision_01M0HZMYN0FK8SQ02KXPVNZB49 及后续用户修订。
- 决定：普通运行时缺失环境明确失败；理由：禁止隐式 legacy fallback；确认来源：decision_01M0HZRA8ABG9FPVM1WC8SKB8W，choice require_external_config。
- 决定：OpenCode 精确模型为 roufemad/gpt-5.6-terra；理由：与当前 provider 命名一致；确认来源：decision_01M0HZTC7MGA03BY1YJF5XG74N，choice roufemad_terra。
- 决定：default seed 只首次复制，之后用户目录权威；理由：兼顾 clean install 与用户配置所有权；确认来源：decision_01M0HZWMJ0FAF3YGY1SET32W1W，choice seed_once_then_home_authoritative。
- 决定：旧用户环境文件保留并转为用户自管；理由：避免删除用户数据；确认来源：decision_01M0HZY6GJ5YC55T7NRG8DPBMC，choice preserve_as_user_owned。
- 决定：default 采用 balanced 基线；理由：降低现有角色默认行为变化；确认来源：decision_01M0J031J7ZJEDJXR7WE859Y04，choice balanced_baseline。
- 决定：完整需求 REQ-001 至 REQ-009 和 AC-001 至 AC-009 已确认；理由：用户最终确认；确认来源：decision_01M0J0GETGFNG10363B7JG1Z17，choice confirm。

## 默认取舍

- 取舍：writer payload 使用最小五字段引用 staging，而不复制文档正文；理由：降低结果 envelope 重复并保持 digest 审计；不影响的 REQ/AC：REQ-004、AC-004 的文档内容与单次消费语义。
- 取舍：迁移采用全量预检后写入并复用现有 backup/restore 边界；理由：满足 no-partial-write 和回滚要求，不新增通用迁移框架；不影响的 REQ/AC：REQ-008、AC-008 的用户数据保留。
- 取舍：existing active_environment 指向仍存在的用户 legacy 文件时保持不变，clean install 才使用 default；理由：保留升级行为；不影响的 REQ/AC：REQ-007、AC-007 的用户目录唯一来源。

## 已关闭问题

- 问题：writer 是否复用 planning 权限；结论：否，独立受限角色；确认来源：问题 1 receipt。
- 问题：Terra 的跨平台映射；结论：Codex/OpenCode 使用 Terra high，Claude 继承默认；确认来源：问题 2 receipt。
- 问题：仓库与用户环境 source of truth；结论：仓库只保留 seed-only default，运行时用户目录权威；确认来源：问题 3、4、6 receipt 及用户修订。
- 问题：旧用户环境是否删除；结论：保留并用户自管，同时迁移 writer；确认来源：问题 7 receipt 与最终完整确认。
- 问题：default 模型基线；结论：balanced；确认来源：问题 8 receipt。

## 未决问题

- 无。
