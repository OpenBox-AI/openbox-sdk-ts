/**
 * Event contracts — `EventType`, `EventKind`, `EventEnvelope`, and
 * classification. Factory functions (`workflowStarted`, `hook`, ...) live in
 * `./event-factories.js` (split out to keep this file focused and under the
 * project's per-file line guideline); both are re-exported together from
 * `contracts/index.ts`.
 *
 * Pure, import-safe module: no network, crypto, OTel, logging, wall-clock, or
 * random. Timestamps are RFC3339 strings *passed in* by callers — never
 * generated here (the sending layer stamps missing timestamps; see
 * `gate/index.ts` `stampTimestamp`).
 *
 * Core wire rules:
 * - `EventEnvelope.eventType` stores the **backend wire type** the caller
 *   asked for; `wireEventType()` is what actually goes on the wire — a hook
 *   event ALWAYS projects to `ActivityStarted` regardless of `eventType`.
 * - Hook evaluations are internally `EventKind.HOOK` but serialize as
 *   `ActivityStarted` + `hookTrigger=true` + non-empty `spans`.
 * - `ActivityCompleted` must not carry non-empty hook spans (enforced by the
 *   strict gate — see `gate/event-rules.ts`).
 * - Handoff payloads require `fromAgentDid` + `multiAgentSessionId` (both
 *   non-empty); `toAgentDid` is omitted because the receiver is derived
 *   server-side from the authenticated signed identity.
 */

import type { JsonValue } from "./results.js";
import type { SpanRecord } from "./otel-spans.js";

/** `source` field Core receives on every governance event. */
export const SOURCE_WORKFLOW_TELEMETRY = "workflow-telemetry";

/** Backend wire event types (Core's accepted `event_type` values). */
export const EventType = {
  WORKFLOW_STARTED: "WorkflowStarted",
  WORKFLOW_COMPLETED: "WorkflowCompleted",
  WORKFLOW_FAILED: "WorkflowFailed",
  SIGNAL_RECEIVED: "SignalReceived",
  ACTIVITY_STARTED: "ActivityStarted",
  ACTIVITY_COMPLETED: "ActivityCompleted",
  HANDOFF: "Handoff"
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

const EVENT_TYPE_VALUES = new Set<string>(Object.values(EventType));

/** True if `value` is one of the 7 backend wire event types. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_VALUES.has(value);
}

/** Internal event classification. Not a wire concept. */
export const EventKind = {
  LIFECYCLE: "lifecycle",
  HOOK: "hook",
  SIGNAL: "signal",
  HANDOFF: "handoff"
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface EventEnvelopeInit {
  eventType: EventType;
  payload?: Readonly<Record<string, JsonValue>> | null;
  spans?: readonly SpanRecord[] | null;
  hookTrigger?: boolean;
  activityId?: string | null;
  activityType?: string | null;
  timestamp?: string | null;
  source?: string;
}

/**
 * A governance event addressed to OpenBox Core. Immutable — every field is
 * `readonly` and set once from the constructor; there are no setters.
 */
export class EventEnvelope {
  /** Backend **wire** event type the caller asked for (see `wireEventType`). */
  readonly eventType: EventType;
  /** Flat wire fields (`workflow_id`, `run_id`, ...) — serialized at the top level. */
  readonly payload: Readonly<Record<string, JsonValue>>;
  /** Flat Core `SpanData` hook payloads. Empty for lifecycle events. */
  readonly spans: readonly SpanRecord[];
  /** True only for hook evaluations. */
  readonly hookTrigger: boolean;
  /** The bound activity for activity-scoped and hook events. */
  readonly activityId: string | null;
  readonly activityType: string | null;
  /** RFC3339 `Z` string, passed in. `null` means the sending layer stamps it. */
  readonly timestamp: string | null;
  /** Constant event source tag Core expects. */
  readonly source: string;

  constructor(init: EventEnvelopeInit) {
    this.eventType = init.eventType;
    this.payload = { ...(init.payload ?? {}) };
    this.spans = [...(init.spans ?? [])];
    this.hookTrigger = init.hookTrigger ?? false;
    this.activityId = init.activityId ?? null;
    this.activityType = init.activityType ?? null;
    this.timestamp = init.timestamp ?? null;
    this.source = init.source ?? SOURCE_WORKFLOW_TELEMETRY;
  }

  /**
   * Flat lifecycle wire dict (omit-when-absent; never null keys).
   *
   * Spans and `span_count` are deliberately NOT emitted here — hook body
   * assembly is owned by `wire/evaluate-payload.ts`, the single owner of the
   * evaluate body shape.
   */
  toPayloadDict(): Record<string, JsonValue> {
    const body: Record<string, JsonValue> = {
      source: this.source,
      event_type: wireEventType(this),
      ...this.payload
    };
    if (this.activityId !== null) body["activity_id"] = this.activityId;
    if (this.activityType !== null) body["activity_type"] = this.activityType;
    if (this.hookTrigger) body["hook_trigger"] = true;
    if (this.timestamp !== null) body["timestamp"] = this.timestamp;
    return body;
  }
}

/**
 * Classify an envelope. Derived from stored fields — never trust callers to
 * pass a separate, possibly-inconsistent kind.
 */
export function classifyEvent(event: EventEnvelope): EventKind {
  if (event.hookTrigger) return EventKind.HOOK;
  if (event.eventType === EventType.HANDOFF) return EventKind.HANDOFF;
  if (event.eventType === EventType.SIGNAL_RECEIVED) return EventKind.SIGNAL;
  return EventKind.LIFECYCLE;
}

/**
 * Backend wire event type. A HOOK-kind event is always `ActivityStarted` on
 * the wire regardless of what the envelope stores in `eventType`.
 */
export function wireEventType(event: EventEnvelope): EventType {
  if (event.hookTrigger) return EventType.ACTIVITY_STARTED;
  return event.eventType;
}
