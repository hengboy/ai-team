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

<!-- ai-team:feature-navigation-entry {"entry_paths":["src/execution-contract.ts","src/dispatch/packet.ts","agent-build/schemas/role-v1.json"],"feature":"Execution Contract","keywords":["dispatch","execution","ceiling"],"module_boundary":"角色策略与冻结 packet"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/state.ts","src/resource-registry.ts","src/cli.ts"],"feature":"Command Lifecycle","keywords":["command event","migration","shutdown"],"module_boundary":"SQLite 生命周期与 invocation 资源"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/run-recovery.ts","src/dispatch.ts","src/commands/planning-run.ts"],"feature":"Run Recovery Projection","keywords":["timeline","next action","resume"],"module_boundary":"只读恢复投影"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/environment.ts","src/commands/environment.ts"],"feature":"Resolved Environment","keywords":["effective config","provenance"],"module_boundary":"环境解析与只读配置"} -->
<!-- ai-team:feature-navigation-entry {"entry_paths":["src/human-renderer.ts","src/cli.ts"],"feature":"Human Output","keywords":["human renderer","error output"],"module_boundary":"CLI 展示层"} -->
<!-- ai-team:feature-navigation:end -->
