# AI Team

AI Team is a local TypeScript and Node.js CLI for coordinating native Codex,
Claude Code, and OpenCode agents around auditable planning and coding workflows.
It stores workflow state in SQLite, creates isolated Git worktrees, validates
agent results, and transactionally renders platform-native agent definitions.
It does not start AI client processes and does not use MCP.

## Requirements

- macOS
- Node.js 22.13 or newer
- Git 2.39 or newer

Install the package and initialize a Git project:

```sh
npm install --global @ai-team/cli
ai-team init /path/to/project
ai-team install --dry-run
ai-team install
```

`ai-team init` creates `.ai-team/project.yaml`, planning directories, the
required `.gitignore` entries, and the target project's `MEMORY.md` plus
`.ai-team/index/feature-navigation.md`. It appends the maintenance rule
to an existing `AGENTS.md` or `CLAUDE.md` without creating either file. If any
existing target context or instruction file is modified, inspect the JSON
diagnostic and repeat with `--yes`.

Use `ai-team context update --project <path> --context-file <json>` for the
structured File Explorer result, and `ai-team context validate --project <path>`
to inspect sections, real navigation paths, instruction rules, and pending
maintenance.

## Workflow

Users select a generated `planning` or `coding` agent in their client and enter
a natural-language request. Those main agents invoke the internal CLI commands;
users do not normally run `planning start` or `coding start` themselves.

Planning creates an immutable revision under:

```text
.ai-team/plans/<plan-id>/revisions/<revision>/
```

Only a `ready` revision can enter planned coding. Coding always records the
current target branch HEAD as its implementation base, blocks on a dirty target
worktree, and uses managed worktrees under `.worktrees/`. Planned coding creates
one run-owned plan worktree named `<plan-id>-<revision>` at startup; split tasks
use `<plan-id>-<revision>--<task-id>` and merge back into that plan worktree.
Direct bug and feature runs retain their run-scoped integration and task names.

Use these recovery commands after a client session ends:

```sh
ai-team run show <run-id>
ai-team run resume <run-id>
ai-team run decide --run-id <run-id> --decision-id <decision-id> --choice <choice-id>
```

## Environment Management

AI Team stores global state below `~/.config/ai-team`, or `AI_TEAM_HOME` when
set. The default environment is `balanced`; `quality` and `economy` are also
created on first use. Each environment resolves all 12 roles for every enabled
platform.

```sh
ai-team env list
ai-team env show balanced --resolved
ai-team env validate balanced
ai-team env explain balanced --role coding --platform codex
ai-team env diff balanced quality
ai-team env generate --dry-run
ai-team env switch quality --dry-run
ai-team env status
ai-team env doctor
ai-team env doctor --probe
```

Only `env doctor --probe` executes client binaries. Generate, switch, install,
restore, and uninstall occur only after an explicit user command. Managed files
are staged and validated before replacement; changed files block destructive
removal, and backups require an explicit `backup restore` command.

`install` requires client versions recorded by an earlier explicit probe.
Versions below the configured minimum block installation; versions above the
verified range produce a warning. Unsupported hard platform capabilities block
rendering instead of being silently downgraded.

## Agent Commands

Generated main agents use `dispatch`, `decision`, `planning revision`, `git`,
and `review` subcommands. Every dispatch binds a run, role, packet, frozen task
prompt, strict result schema, and result template. A completed result requires
verification evidence and is stored as a redacted, hashed artifact.

Formal plans require one Spec and one Standards review for each frozen revision.
Direct bug and feature runs require one Standards review. P0 and P1 findings
must all have change and verification evidence before integration. Reviews are
not rerun after repair.

Dispatch submission advances the persisted run stage and creates its successor
exactly once. File Explorer may receive the repository root; downstream packets
contain the exact paths returned by File Explorer. Planning Task graphs are
validated for IDs, dependencies, cycles, coverage fields, and overlapping write
scopes before safe execution batches are produced.

Run `ai-team <command> --help` for exact parameters. `ai-team contract` prints
the contract and role-manifest digests used to detect drift.

### Managed JSON staging

Agent-produced JSON is stored under
`${AI_TEAM_HOME:-~/.config/ai-team}/state/staging/<run-id>/` and is managed only
through the CLI:

```sh
ai-team staging create --run-id <id> --role <role> --kind <kind> [--dispatch-id <id>]
ai-team staging write --run-id <id> --role <role> --staging-id <id> --input-stdin
ai-team staging show --run-id <id> --role <role> [--staging-id <id>] [--content]
ai-team staging cleanup --expired
ai-team staging cleanup --run-id <id> [--staging-id <id>] --all
```

The 10 kinds are `project-context`, `planning-documents`, `planning-tasks`,
`dispatch-packet`, `dispatch-result`, `decision`, `git-reconcile-evidence`,
`research-conclusions`, `review-result`, and `review-resolution`. Existing JSON
file options remain supported; each consumer accepts either its file option or
`--staging-id`, never both. Validation and Task preview do not consume content.
Successful mutating commands persist their business result before deleting the
staged file. Failed deletion is recorded as `cleanup_pending` for retry.

Directories are mode `0700`, files are `0600`, and writes are limited to 2 MiB
of valid JSON with atomic replacement and link/ownership/path checks. The
default failure retention is 168 hours and can be set with
`staging.retention_hours` in `config.yaml`. Metadata and audit events contain
digests and sizes, not raw staging JSON.

## Safety

AI Team rejects credential paths, `.env*`, `.ai-team/runtime`, and symlink path
escapes. Git commands are passed as fixed argument arrays. Push, tag, rebase,
reset, clean, stash, squash, cherry-pick, amend, remote mutation, and release
operations are not available. Failed or uncertain operations retain worktrees
and require reconciliation.

Upgrade the compatible CLI before regenerating or installing agents. AI Team
does not scan, migrate, or remove historical `$TMPDIR/opencode` files.

## Development

```sh
npm install
npm run verify
npm run verify:packed
npm pack --dry-run
```

`verify:packed` is the networked release gate. It packs without lifecycle scripts,
installs the tarball into an isolated external consumer, and verifies only the
installed CLI and packaged resources. It is intentionally separate from the
daily `verify` command.

Tests create isolated temporary homes and Git repositories and never call a
real model. Client processes are only exercised by explicit probe tests.
