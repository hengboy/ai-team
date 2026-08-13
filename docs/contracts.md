# AI Team v1 Contracts

The implementation contract is represented by `COMMAND_CONTRACT` in
`src/contracts.ts`; `ai-team contract` prints its SHA-256 digest. Unknown result
fields are rejected.

## Identifiers

| Field | Format |
| --- | --- |
| `plan_id` | `YYYYMMDD-<ascii-slug>-<4 hex>` |
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
| 2 | command, schema, or input validation failure |
| 3 | invalid workflow state |
| 4 | concurrent or ownership conflict |
| 5 | environment or managed-file failure |
| 6 | Git operation failure |
| 70 | unexpected internal failure |

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
