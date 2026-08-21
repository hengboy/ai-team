<!-- ai-team:feature-navigation:start -->
<!-- ai-team:context-format {"renderer_version":"context-renderer-v2","schema_version":2} -->
# 功能导航

| 功能 | 关键词 | 入口路径 | 模块边界 |
| --- | --- | --- | --- |
| Execution Contract | dispatch, execution, ceiling | `src/execution-contract.ts`<br>`src/dispatch/packet.ts`<br>`agent-build/schemas/role-v1.json` | 角色策略与冻结 packet |
| Command Lifecycle | command event, migration, shutdown | `src/state.ts`<br>`src/resource-registry.ts`<br>`src/cli.ts` | SQLite 生命周期与 invocation 资源 |
| Run Recovery Projection | timeline, next action, resume | `src/run-recovery.ts`<br>`src/dispatch.ts`<br>`src/commands/planning-run.ts` | 只读恢复投影 |
| Resolved Environment | effective config, provenance | `src/environment.ts`<br>`src/commands/environment.ts` | 环境解析与只读配置 |
| Human Output | human renderer, error output | `src/human-renderer.ts`<br>`src/cli.ts` | CLI 展示层 |
| TDD Contract | TDD, direct acceptance contract, verification digest | `src/planning.ts`<br>`agent-build/templates/spec.md`<br>`agent-build/templates/plan.md`<br>`agent-build/templates/task.md`<br>`src/workflow.ts` | Planned artifacts and direct entry requests freeze verification contracts before implementation |
| Verification Evidence and Repair Loop | acceptance check, TDD evidence, test repair lineage, context owner | `src/contracts.ts`<br>`src/dispatch.ts`<br>`src/state.ts`<br>`src/dispatch/implementation.ts` | Developer/Test evidence gates and task/final/review-repair retest orchestration; repair Test completion never reopens review |
| Current State and Staging | state, staging, schema | `src/state.ts`<br>`src/staging.ts`<br>`src/state/migrations.ts` | Current SQLite schema validation and sequence-named staging persistence |
| Canonical Context and Dispatch Renderer | context, packet, renderer, execution contract | `src/context.ts`<br>`src/dispatch/packet.ts`<br>`src/execution-contract.ts` | Canonical .ai-team context, renderer v5, and frozen execution contracts |
| Git Dispatch and Plan Worktree | git, dispatch, worktree | `src/git-orchestrator.ts`<br>`src/workflow.ts`<br>`src/git-orchestrator/runtime.ts` | Claimed Git Operator dispatch authorization and canonical plan worktree orchestration |
| Environment Cutover | environment, backup, verified | `src/environment.ts`<br>`src/commands/environment.ts` | Complete environment configuration, indexed restoration, and exact verified clients |
| Review Worktree Resolution | review, worktree, canonical | `src/worktree-review.ts`<br>`src/review.ts` | Review worktree lookup accepts canonical layouts and rejects legacy planned integration paths |

<!-- ai-team:feature-navigation-entry {"entry_paths":["src/execution-contract.ts","src/dispatch/packet.ts","agent-build/schemas/role-v1.json"],"feature":"Execution Contract","keywords":["dispatch","execution","ceiling"],"module_boundary":"角色策略与冻结 packet"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/state.ts","src/resource-registry.ts","src/cli.ts"],"feature":"Command Lifecycle","keywords":["command event","migration","shutdown"],"module_boundary":"SQLite 生命周期与 invocation 资源"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/run-recovery.ts","src/dispatch.ts","src/commands/planning-run.ts"],"feature":"Run Recovery Projection","keywords":["timeline","next action","resume"],"module_boundary":"只读恢复投影"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/environment.ts","src/commands/environment.ts"],"feature":"Resolved Environment","keywords":["effective config","provenance"],"module_boundary":"环境解析与只读配置"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/human-renderer.ts","src/cli.ts"],"feature":"Human Output","keywords":["human renderer","error output"],"module_boundary":"CLI 展示层"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/planning.ts","agent-build/templates/spec.md","agent-build/templates/plan.md","agent-build/templates/task.md","src/workflow.ts"],"feature":"TDD Contract","keywords":["TDD","direct acceptance contract","verification digest"],"module_boundary":"Planned artifacts and direct entry requests freeze verification contracts before implementation"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/contracts.ts","src/dispatch.ts","src/state.ts","src/dispatch/implementation.ts"],"feature":"Verification Evidence and Repair Loop","keywords":["acceptance check","TDD evidence","test repair lineage","context owner"],"module_boundary":"Developer/Test evidence gates and task/final/review-repair retest orchestration; repair Test completion never reopens review"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/state.ts","src/staging.ts","src/state/migrations.ts"],"feature":"Current State and Staging","keywords":["state","staging","schema"],"module_boundary":"Current SQLite schema validation and sequence-named staging persistence"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/context.ts","src/dispatch/packet.ts","src/execution-contract.ts"],"feature":"Canonical Context and Dispatch Renderer","keywords":["context","packet","renderer","execution contract"],"module_boundary":"Canonical .ai-team context, renderer v5, and frozen execution contracts"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/git-orchestrator.ts","src/workflow.ts","src/git-orchestrator/runtime.ts"],"feature":"Git Dispatch and Plan Worktree","keywords":["git","dispatch","worktree"],"module_boundary":"Claimed Git Operator dispatch authorization and canonical plan worktree orchestration"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/environment.ts","src/commands/environment.ts"],"feature":"Environment Cutover","keywords":["environment","backup","verified"],"module_boundary":"Complete environment configuration, indexed restoration, and exact verified clients"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/worktree-review.ts","src/review.ts"],"feature":"Review Worktree Resolution","keywords":["review","worktree","canonical"],"module_boundary":"Review worktree lookup accepts canonical layouts and rejects legacy planned integration paths"} -->
<!-- ai-team:feature-navigation:end -->
