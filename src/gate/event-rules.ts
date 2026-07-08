/**
 * Strict contract failures — throw `ContractError` BEFORE any network send.
 *
 * The gate is ALWAYS strict for OpenBox event contracts and runtime
 * invariants; there is no OBSERVE/SANITIZE/STRICT mode and no way to
 * downgrade these to diagnostics. Fail-open applies only to network errors
 * (see `client/index.ts`), never here.
 *
 * The 8 strict codes this module raises for hook/span contract violations:
 * `ACTIVITY_COMPLETED_WITH_SPANS`, `HOOK_TRIGGER_FALSE`,
 * `HOOK_WRONG_WIRE_TYPE`, `HOOK_EMPTY_SPANS`, `HOOK_UNBOUND_ACTIVITY`,
 * `HOOK_SPAN_NOT_FLAT`, `HOOK_SPAN_NO_STAGE`, `HOOK_STAGE_MISMATCH`. Three
 * additional codes cover generic lifecycle-envelope malformation
 * (`ENVELOPE_MISSING_FIELDS`, `ENVELOPE_BAD_EVENT_TYPE`,
 * `HOOK_ON_LIFECYCLE_PATH`), matching `openbox-sdk-python`
 * `validation/event_rules.py` in full.
 *
 * Deviation from Python (deliberate, plan.md Decision 9): the flat-shape
 * check also rejects a nested `metadata` key, not just `otel`/`openbox`/
 * `data` — Python's strict check only tests 3 keys; `metadata` is stripped
 * later during normalization but not gate-rejected. The plan explicitly
 * widens this to 4 keys for the TS port.
 */

import {
  EventKind,
  EventType,
  classifyEvent,
  isEventType,
  type EventEnvelope
} from "../contracts/events.js";
import type { SpanRecord } from "../contracts/otel-spans.js";
import { ContractError } from "../errors/index.js";

// Payload fields every workflow-scoped lifecycle event must carry.
const REQUIRED_WORKFLOW_FIELDS = ["workflow_id", "run_id", "workflow_type"] as const;
const REQUIRED_HANDOFF_FIELDS = ["from_agent_did", "multi_agent_session_id"] as const;

// Nested/debug keys that must never appear on a flat hook span.
const FORBIDDEN_NESTED_KEYS = ["otel", "openbox", "metadata", "data"] as const;

/**
 * Extract the stage from a span payload. Spans are flat-only: the stage lives
 * at the top level.
 */
export function spanStage(span: Readonly<SpanRecord> | null | undefined): string | null {
  if (span === null || span === undefined) return null;
  const stage = span["stage"];
  return typeof stage === "string" ? stage : null;
}

function requireFields(event: EventEnvelope, fields: readonly string[], what: string): void {
  const missing = fields.filter((field) => !event.payload[field]);
  if (missing.length > 0) {
    throw new ContractError(
      `Malformed ${what} envelope: missing required fields ${JSON.stringify(missing)}`,
      "ENVELOPE_MISSING_FIELDS",
      { missing, eventType: event.eventType }
    );
  }
}

/** Strict checks for non-hook envelopes (lifecycle/signal/handoff). */
export function checkLifecycleEnvelope(event: EventEnvelope): void {
  if (!isEventType(event.eventType)) {
    throw new ContractError(
      `Malformed envelope: eventType must be a valid EventType, got ${JSON.stringify(event.eventType)}`,
      "ENVELOPE_BAD_EVENT_TYPE"
    );
  }

  const kind = classifyEvent(event);
  if (kind === EventKind.HOOK) {
    throw new ContractError(
      "checkLifecycleEnvelope received a hook event — route hook events through validateHook()",
      "HOOK_ON_LIFECYCLE_PATH"
    );
  }

  // A span-bearing envelope that is not marked as a hook is malformed: either
  // it IS a hook (then hookTrigger must be true) or the spans are noise.
  if (event.spans.length > 0) {
    if (event.eventType === EventType.ACTIVITY_COMPLETED) {
      throw new ContractError(
        "ActivityCompleted must not carry non-empty hook spans — completed telemetry " +
          "routes through a completed-stage hook evaluation",
        "ACTIVITY_COMPLETED_WITH_SPANS",
        { spanCount: event.spans.length }
      );
    }
    throw new ContractError(
      `${event.eventType} carries spans but hookTrigger=false — span-bearing evaluations must be hook events`,
      "HOOK_TRIGGER_FALSE",
      { spanCount: event.spans.length }
    );
  }

  if (kind === EventKind.HANDOFF) {
    requireFields(event, REQUIRED_HANDOFF_FIELDS, "handoff");
    return;
  }
  requireFields(event, REQUIRED_WORKFLOW_FIELDS, "lifecycle");
  if (kind === EventKind.SIGNAL && !event.payload["signal_name"]) {
    throw new ContractError("Malformed signal envelope: missing signal_name", "ENVELOPE_MISSING_FIELDS", {
      missing: ["signal_name"]
    });
  }
}

/** Strict checks for hook (span-bearing) envelopes. */
export function checkHookEnvelope(event: EventEnvelope): void {
  if (!event.hookTrigger) {
    throw new ContractError("Hook evaluation requires hookTrigger=true", "HOOK_TRIGGER_FALSE");
  }
  if (event.eventType !== EventType.ACTIVITY_STARTED) {
    throw new ContractError(
      `Hook events must use wire event type ActivityStarted, got ${event.eventType}`,
      "HOOK_WRONG_WIRE_TYPE",
      { eventType: event.eventType }
    );
  }
  if (event.spans.length === 0) {
    throw new ContractError(
      "Hook event carries no spans — instrumentation produced an impossible hook event",
      "HOOK_EMPTY_SPANS"
    );
  }
  if (!event.activityId || !event.activityType) {
    throw new ContractError(
      "Hook event is not attached to a bound activity (activityId and activityType are required)",
      "HOOK_UNBOUND_ACTIVITY",
      { activityId: event.activityId, activityType: event.activityType }
    );
  }
  event.spans.forEach((span, index) => {
    // Mirrors Python's `isinstance(span, dict)` guard: a non-object span (or
    // `null`) silently skips this check rather than throwing a raw TypeError
    // from `in` — `checkStage` rejects it downstream (no stage -> HOOK_SPAN_NO_STAGE).
    if (typeof span !== "object" || span === null || Array.isArray(span)) return;
    const forbidden = FORBIDDEN_NESTED_KEYS.filter((key) => key in span).sort();
    if (forbidden.length > 0) {
      throw new ContractError(
        `Hook spans must be flat Core SpanData objects — nested/debug keys are not allowed ` +
          `at spans[${index}]: ${JSON.stringify(forbidden)}`,
        "HOOK_SPAN_NOT_FLAT",
        { index, forbidden }
      );
    }
  });
}

/** Reject stage-mismatched spans (preflight=started, completed=completed). */
export function checkStage(event: EventEnvelope, expectedStage: string): void {
  event.spans.forEach((span, index) => {
    const stage = spanStage(span);
    if (stage === null) {
      throw new ContractError(
        `Hook span[${index}] has no stage — instrumentation produced a malformed hook span`,
        "HOOK_SPAN_NO_STAGE",
        { index }
      );
    }
    if (stage !== expectedStage) {
      throw new ContractError(
        `${expectedStage}-stage evaluation received a ${stage}-stage span at spans[${index}]`,
        "HOOK_STAGE_MISMATCH",
        { index, expected: expectedStage, actual: stage }
      );
    }
  });
}
