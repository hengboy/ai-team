# AI Team v1 Contracts

The implementation contract is represented by `COMMAND_CONTRACT` in
`src/contracts.ts`; `ai-team contract` prints its SHA-256 digest. Unknown result
fields are rejected.

## Identifiers

| Field | Format |
| --- | --- |
| `plan_id` | `YYYYMMDD-<ascii-slug>`; slug must not end with four hexadecimal digits |
| `revision` | three digits |
| `task_id` | `TASK-<three digits>` |
| `run_id` | `run_<ULID>` |
| `dispatch_id` | `dispatch_<ULID>` |
| `commit` | 40 lowercase hexadecimal characters |
| time | RFC 3339 UTC |
| path | repository-relative POSIX path |

## Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | generic command failure |
| 2 | business, schema, or input validation failure; decision required |
| 3 | unknown or invalid workflow state |
| 4 | incompatible installation, concurrent change, or ownership conflict |
| 5 | argument syntax or format failure |
| 6 | Git gate or operation failure |
| 7 | security policy failure |
| 8 | unexpected internal failure |

All successful structured commands write JSON to stdout. Failures write one
JSON object with `error` and optional `details` to stderr. Schema errors use
JSON Pointer paths.

## Result Envelope

A result contains `schema_version`, dispatch identity, role, one of
`completed | retryable_failure | needs_decision | failed`, summary, findings,
changes, verification, risks, decisions, support requests, handoff, and a
role-specific payload. Completed results require verification evidence. Failed
and retryable results require `failure_class` and `side_effect_state`; unknown
side effects can only proceed through reconciliation.

The frozen dispatch prompt is a generated task prompt, not a saved user/model
conversation or chain of thought. It is retained with the packet, schema,
template, and result artifact for run recovery and audit.

Every dispatch schema replaces the generic payload with the selected role's
strict payload schema. Every review finding includes a source, file, line,
evidence, impact, and recommendation. Successful dispatch submission advances
the durable run stage once; failure statuses do not create a successor.

The File Explorer payload includes strict `project_context` data. Navigation
entries contain `feature`, `keywords`, repository-relative `entry_paths`, and
`module_boundary`; the CLI rejects missing, sensitive, absolute, escaping, and
symbolic-link paths before updating project context files.
