import type { StateStore } from "./state.js";

export interface TimelineEntry {
  source: "event" | "authoritative_row";
  identity: string;
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

export interface NextAction {
  id: string;
  priority: number;
  type: string;
  identity: string;
  created_at: string;
  command: string | null;
  blocked_by: string[];
  details?: Record<string, unknown>;
}

const parseObject = (value?: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

export const timelineForRun = (store: StateStore, runId: string): TimelineEntry[] => {
  const events = store.db.prepare(`SELECT event_id,type,payload_json,created_at,command_id,correlation_id,dispatch_id,operation_id
    FROM run_events WHERE run_id=? ORDER BY event_id`).all(runId) as Array<Record<string, unknown> & { event_id: number; type: string; payload_json: string; created_at: string }>;
  const timeline: TimelineEntry[] = events.map((event) => ({
    source: "event",
    identity: `event:${event.event_id}`,
    type: event.type,
    created_at: event.created_at,
    data: {
      ...parseObject(event.payload_json),
      ...(event.command_id ? { command_id: event.command_id } : {}),
      ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
      ...(event.dispatch_id ? { dispatch_id: event.dispatch_id } : {}),
      ...(event.operation_id ? { operation_id: event.operation_id } : {}),
    },
  }));
  const run = store.getRun(runId) as Record<string, unknown> & { created_at: string };
  timeline.push({ source: "authoritative_row", identity: `run:${runId}`, type: "run.current", created_at: run.created_at, data: run });
  const rows: Array<{ source: string; identity: string; type: string; created_at: string; data: Record<string, unknown> }> = [];
  for (const row of store.db.prepare("SELECT * FROM operations WHERE run_id=? AND state='pending'").all(runId) as Array<Record<string, unknown> & { operation_id: string; created_at: string }>) {
    rows.push({ source: "authoritative_row", identity: `operation:${row.operation_id}`, type: "operation.current", created_at: row.created_at, data: row });
  }
  for (const row of store.db.prepare("SELECT * FROM decisions WHERE run_id=? AND status='pending'").all(runId) as Array<Record<string, unknown> & { decision_id: string; created_at: string }>) {
    rows.push({ source: "authoritative_row", identity: `decision:${row.decision_id}`, type: "decision.current", created_at: row.created_at, data: row });
  }
  for (const row of store.db.prepare("SELECT dispatch_id,role,state,claimed_at,completed_at,created_at FROM dispatches WHERE run_id=? AND state IN ('pending','claimed','retryable_failure')").all(runId) as Array<Record<string, unknown> & { dispatch_id: string; created_at: string }>) {
    rows.push({ source: "authoritative_row", identity: `dispatch:${row.dispatch_id}`, type: "dispatch.current", created_at: row.created_at, data: row });
  }
  return [...timeline, ...rows as TimelineEntry[]].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.identity.localeCompare(b.identity));
};

export const nextActionsForRun = (store: StateStore, runId: string): NextAction[] => {
  const actions: NextAction[] = [];
  const operations = store.db.prepare("SELECT operation_id,kind,request_json,evidence_json,created_at FROM operations WHERE run_id=? AND state='pending'").all(runId) as Array<{
    operation_id: string; kind: string; request_json: string; evidence_json?: string; created_at: string;
  }>;
  for (const operation of operations) {
    const request = parseObject(operation.request_json);
    const dispatchId = typeof request.dispatch_id === "string" ? request.dispatch_id : null;
    actions.push({
      id: `operation:${operation.operation_id}`,
      priority: 10,
      type: "reconcile_operation",
      identity: operation.operation_id,
      created_at: operation.created_at,
      command: dispatchId ? `ai-team git reconcile --run-id ${runId} --dispatch-id ${dispatchId} --operation-id ${operation.operation_id} --input-stdin` : null,
      blocked_by: [],
      details: { kind: operation.kind, evidence_required: true },
    });
  }
  const decisions = store.db.prepare("SELECT decision_id,choices_json,dispatch_id,created_at FROM decisions WHERE run_id=? AND status='pending'").all(runId) as Array<{
    decision_id: string; choices_json: string; dispatch_id?: string; created_at: string;
  }>;
  for (const decision of decisions) {
    const choices = JSON.parse(decision.choices_json) as unknown[];
    actions.push({
      id: `decision:${decision.decision_id}`,
      priority: 20,
      type: "resolve_decision",
      identity: decision.decision_id,
      created_at: decision.created_at,
      command: `ai-team run decide --run-id ${runId} --decision-id ${decision.decision_id} --choice <choice-id>`,
      blocked_by: [],
      details: { choices, dispatch_id: decision.dispatch_id ?? null },
    });
  }
  const retryable = store.db.prepare("SELECT dispatch_id,role,result_json,created_at FROM dispatches WHERE run_id=? AND state='retryable_failure'").all(runId) as Array<{
    dispatch_id: string; role: string; result_json?: string; created_at: string;
  }>;
  const run = store.getRun(runId) as { profile: string };
  for (const dispatch of retryable) {
    const result = parseObject(dispatch.result_json);
    const completed = result.side_effect_state === "completed";
    actions.push({
      id: `retryable:${dispatch.dispatch_id}`,
      priority: 30,
      type: "reconcile_dispatch",
      identity: dispatch.dispatch_id,
      created_at: dispatch.created_at,
      command: completed ? `ai-team dispatch reconcile --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --actor-role ${run.profile} --reason "reconcile confirmed completed side effect"` : null,
      blocked_by: [],
      details: { side_effect_state: result.side_effect_state ?? "unknown" },
    });
  }
  const dispatches = store.db.prepare("SELECT dispatch_id,role,state,created_at FROM dispatches WHERE run_id=? AND state IN ('pending','claimed')").all(runId) as Array<{
    dispatch_id: string; role: string; state: string; created_at: string;
  }>;
  for (const dispatch of dispatches) actions.push({
    id: `dispatch:${dispatch.dispatch_id}`,
    priority: 40,
    type: "claim_dispatch",
    identity: dispatch.dispatch_id,
    created_at: dispatch.created_at,
    command: `ai-team dispatch claim --run-id ${runId} --dispatch-id ${dispatch.dispatch_id} --role ${dispatch.role} --bundle`,
    blocked_by: [],
    details: { state: dispatch.state },
  });
  const interrupted = store.db.prepare("SELECT command_id,payload_json,created_at FROM run_events WHERE run_id=? AND type='command.interrupted'").all(runId) as Array<{
    command_id: string; payload_json: string; created_at: string;
  }>;
  for (const event of interrupted) {
    const payload = parseObject(event.payload_json);
    actions.push({
      id: `command:${event.command_id}`,
      priority: 50,
      type: "retry_command",
      identity: event.command_id,
      created_at: event.created_at,
      command: payload.retry_safe === true && typeof payload.command === "string" ? payload.command : null,
      blocked_by: [],
      details: { retry_safe: payload.retry_safe === true },
    });
  }
  actions.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at) || a.identity.localeCompare(b.identity));
  for (let index = 0; index < actions.length; index += 1) actions[index]!.blocked_by = actions.slice(0, index).map(({ id }) => id);
  return actions;
};

export const recoveryProjection = (store: StateStore, runId: string): {
  timeline: TimelineEntry[];
  next_actions: NextAction[];
  next_action: NextAction | null;
} => {
  const timeline = timelineForRun(store, runId);
  const nextActions = nextActionsForRun(store, runId);
  return { timeline, next_actions: nextActions, next_action: nextActions[0] ?? null };
};
