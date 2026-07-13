/**
 * Event factories — build wire-consistent `EventEnvelope`s.
 *
 * Split out of `events.ts` (pure modularization, no behavior change) to keep
 * that file focused on the envelope/classification core.
 *
 * Factories throw a plain `Error` on programmer misuse (missing required
 * identity fields) — the JS analogue of Python's `ValueError` — never
 * `ContractError`. *Runtime* contract violations on arbitrary envelopes are
 * the strict gate's job (`ContractError`, see `gate/event-rules.ts`).
 */

import { EventEnvelope, EventType } from "./events.js";
import type { ErrorInfo } from "./error-info.js";
import type { SpanRecord } from "./otel-spans.js";
import type { JsonValue } from "./results.js";

export interface WorkflowEventOptions {
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue?: string | null;
  multiAgentSessionId?: string | null;
  timestamp?: string | null;
  extra?: Readonly<Record<string, JsonValue>> | null;
}

function baseWorkflowPayload(options: WorkflowEventOptions): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    workflow_id: options.workflowId,
    run_id: options.runId,
    workflow_type: options.workflowType
  };
  // `taskQueue` uses a not-null check (an explicit "" is still emitted);
  // `multiAgentSessionId` uses a truthy check (an explicit "" is omitted) —
  // this asymmetry matches Python's `_base_workflow_payload` exactly.
  if (options.taskQueue !== undefined && options.taskQueue !== null) {
    payload["task_queue"] = options.taskQueue;
  }
  if (options.multiAgentSessionId) {
    payload["multi_agent_session_id"] = options.multiAgentSessionId;
  }
  if (options.extra) {
    Object.assign(payload, options.extra);
  }
  return payload;
}

/** `WorkflowStarted` lifecycle event. */
export function workflowStarted(options: WorkflowEventOptions): EventEnvelope {
  return new EventEnvelope({
    eventType: EventType.WORKFLOW_STARTED,
    payload: baseWorkflowPayload(options),
    timestamp: options.timestamp ?? null
  });
}

/** `WorkflowCompleted` lifecycle event. */
export function workflowCompleted(options: WorkflowEventOptions): EventEnvelope {
  return new EventEnvelope({
    eventType: EventType.WORKFLOW_COMPLETED,
    payload: baseWorkflowPayload(options),
    timestamp: options.timestamp ?? null
  });
}

export interface WorkflowFailedOptions extends WorkflowEventOptions {
  /** Structured error object Core requires — a bare string is rejected (400). */
  error?: ErrorInfo | null;
}

/** `WorkflowFailed` lifecycle event. */
export function workflowFailed(options: WorkflowFailedOptions): EventEnvelope {
  const payload = baseWorkflowPayload(options);
  if (options.error !== undefined && options.error !== null) {
    payload["error"] = options.error;
  }
  return new EventEnvelope({
    eventType: EventType.WORKFLOW_FAILED,
    payload,
    timestamp: options.timestamp ?? null
  });
}

export interface ActivityStartedOptions extends WorkflowEventOptions {
  activityId: string;
  activityType: string;
  activityInput?: JsonValue | null;
  attempt?: number | null;
}

/** `ActivityStarted` lifecycle event (NOT a hook — `hookTrigger` stays false). */
export function activityStarted(options: ActivityStartedOptions): EventEnvelope {
  const payload = baseWorkflowPayload(options);
  if (options.activityInput !== undefined && options.activityInput !== null) {
    payload["activity_input"] = options.activityInput;
  }
  if (options.attempt !== undefined && options.attempt !== null) {
    payload["attempt"] = options.attempt;
  }
  return new EventEnvelope({
    eventType: EventType.ACTIVITY_STARTED,
    payload,
    activityId: options.activityId,
    activityType: options.activityType,
    timestamp: options.timestamp ?? null
  });
}

export interface ActivityCompletedOptions extends WorkflowEventOptions {
  activityId: string;
  activityType: string;
  result?: JsonValue | null;
  /** Structured error object Core requires — a bare string is rejected (400). */
  error?: ErrorInfo | null;
  attempt?: number | null;
}

/**
 * `ActivityCompleted` lifecycle event.
 *
 * Never carries hook spans. Empty `spans`/`span_count=0` noise is not
 * produced here at all; the gate additionally strips it from hand-built
 * payloads via `stripCompatNoise` (recorded as a diagnostic).
 */
export function activityCompleted(options: ActivityCompletedOptions): EventEnvelope {
  const payload = baseWorkflowPayload(options);
  if (options.result !== undefined && options.result !== null) {
    payload["result"] = options.result;
  }
  if (options.error !== undefined && options.error !== null) {
    payload["error"] = options.error;
  }
  if (options.attempt !== undefined && options.attempt !== null) {
    payload["attempt"] = options.attempt;
  }
  return new EventEnvelope({
    eventType: EventType.ACTIVITY_COMPLETED,
    payload,
    activityId: options.activityId,
    activityType: options.activityType,
    timestamp: options.timestamp ?? null
  });
}

export interface SignalReceivedOptions extends WorkflowEventOptions {
  signalName: string;
}

/** `SignalReceived` event. */
export function signalReceived(options: SignalReceivedOptions): EventEnvelope {
  const payload = baseWorkflowPayload(options);
  payload["signal_name"] = options.signalName;
  return new EventEnvelope({
    eventType: EventType.SIGNAL_RECEIVED,
    payload,
    timestamp: options.timestamp ?? null
  });
}

export interface HandoffOptions {
  fromAgentDid: string;
  multiAgentSessionId: string;
  timestamp?: string | null;
}

/**
 * Multi-agent `Handoff` event.
 *
 * Both fields are required and non-empty (throws before any network call).
 * `toAgentDid` is not included; the receiver is derived server-side from the
 * authenticated signed identity.
 */
export function handoff(options: HandoffOptions): EventEnvelope {
  if (!options.fromAgentDid || !options.fromAgentDid.trim()) {
    throw new Error("handoff: fromAgentDid is required and must be non-empty");
  }
  if (!options.multiAgentSessionId || !options.multiAgentSessionId.trim()) {
    throw new Error("handoff: multiAgentSessionId is required and must be non-empty");
  }
  return new EventEnvelope({
    eventType: EventType.HANDOFF,
    payload: {
      from_agent_did: options.fromAgentDid,
      multi_agent_session_id: options.multiAgentSessionId
    },
    timestamp: options.timestamp ?? null
  });
}

export interface HookOptions {
  /** Flat context payload fields (workflow_id, run_id, ...), merged at the top level. */
  activityContext: Readonly<Record<string, JsonValue>>;
  activityId: string;
  activityType: string;
  /** Non-empty flat Core `SpanData` payloads. */
  spans: readonly SpanRecord[];
  timestamp?: string | null;
}

/**
 * Hook (span-bearing) evaluation event.
 *
 * Internally `EventKind.HOOK`; serializes as wire `ActivityStarted` +
 * `hookTrigger=true` + non-empty `spans`. Must be attached to a bound
 * activity — callers resolve `activityContext` from the context store first
 * (no bound context means skip the hook entirely; don't call this).
 */
export function hook(options: HookOptions): EventEnvelope {
  if (!options.activityId || !options.activityType) {
    throw new Error(
      "hook: activityId and activityType are required — hook events must be attached to a bound activity"
    );
  }
  if (!options.spans || options.spans.length === 0) {
    throw new Error("hook: spans must be non-empty for a hook evaluation");
  }
  return new EventEnvelope({
    eventType: EventType.ACTIVITY_STARTED,
    payload: options.activityContext,
    spans: options.spans,
    hookTrigger: true,
    activityId: options.activityId,
    activityType: options.activityType,
    timestamp: options.timestamp ?? null
  });
}
