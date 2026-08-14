<!-- ai-team:project-context:start -->
## 项目上下文

### 项目形态
Node.js 22+ TypeScript ESM CLI package with Commander, SQLite workflow state, immutable planning revisions, generated role assets, and node:test coverage.

### 领域术语
- planning run
- dispatch
- decision
- revision
- plan_ready
- Git Operator
- result envelope
- read-only state store
- legacy output

### 仓库约束
- Node.js >=22.13.0 and npm verify scripts are required.
- Planning revisions are immutable complete document bundles.
- Git Operator owns planning revision Git mutations.
- Build and install from repository source; never edit global dist files.

### 职责
- src/cli.ts binds commands, recovery actions, and canonical JSON output.
- src/dispatch.ts owns validation, submission, planning lifecycle, resume, and commit-dispatch gates.
- src/state.ts owns writable and read-only SQLite open paths, locks, runs, decisions, and operations.
- src/planning.ts validates complete revision documents and revision/run stage consistency.
- src/contracts.ts owns result envelope and role payload schemas.
- src/command-contract.ts owns exact public and agent command syntax.
- skills/init-ai-team owns the reusable Codex workflow for initializing and validating AI Team in a target Git project.

### 模块边界
- src/git-orchestrator.ts and src/git.ts own Git orchestration.
- src/environment.ts and agent-build/roles own managed role generation and capabilities.
- skills/init-ai-team wraps public init and context validation commands without changing CLI behavior.
- test/*.test.ts contains unit, CLI end-to-end, lock, contract, and workflow regressions.
<!-- ai-team:project-context:end -->
