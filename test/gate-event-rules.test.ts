import { describe, expect, it } from "vitest";

import { handoff, hook, signalReceived, workflowStarted } from "../src/contracts/event-factories.js";
import { EventEnvelope, EventType } from "../src/contracts/events.js";
import type { SpanRecord } from "../src/contracts/otel-spans.js";
import { ContractError } from "../src/errors/index.js";
import { checkHookEnvelope, checkLifecycleEnvelope, checkStage, spanStage } from "../src/gate/event-rules.js";

const WF = { workflow_id: "wf-1", run_id: "run-1", workflow_type: "W" };

function startedSpan(extra: Record<string, unknown> = {}): SpanRecord {
  return { stage: "started", span_id: "aa".repeat(8), ...extra };
}

function completedSpan(extra: Record<string, unknown> = {}): SpanRecord {
  return { stage: "completed", span_id: "aa".repeat(8), ...extra };
}

function makeHookEvent(spans: SpanRecord[]) {
  return hook({ activityContext: WF, activityId: "a-1", activityType: "charge", spans });
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
  throw new Error("expected fn to throw a ContractError");
}

describe("checkLifecycleEnvelope — strict lifecycle failures", () => {
  it("ENVELOPE_MISSING_FIELDS: missing workflow fields raise before send", () => {
    const bad = new EventEnvelope({ eventType: EventType.WORKFLOW_STARTED, payload: { workflow_id: "wf" } });
    expect(codeOf(() => checkLifecycleEnvelope(bad))).toBe("ENVELOPE_MISSING_FIELDS");
    expect(() => checkLifecycleEnvelope(bad)).toThrow(/missing required fields/);
  });

  it("ENVELOPE_MISSING_FIELDS: signal requires signal_name", () => {
    const bad = new EventEnvelope({ eventType: EventType.SIGNAL_RECEIVED, payload: WF });
    expect(() => checkLifecycleEnvelope(bad)).toThrow(/signal_name/);
    expect(codeOf(() => checkLifecycleEnvelope(bad))).toBe("ENVELOPE_MISSING_FIELDS");
  });

  it("ENVELOPE_MISSING_FIELDS: handoff requires identity fields", () => {
    const bad = new EventEnvelope({ eventType: EventType.HANDOFF, payload: { from_agent_did: "d" } });
    expect(() => checkLifecycleEnvelope(bad)).toThrow(/multi_agent_session_id/);
  });

  it("ENVELOPE_BAD_EVENT_TYPE: a non-EventType value is rejected before classification", () => {
    const bad = new EventEnvelope({ eventType: "Bogus" as EventType, payload: WF });
    expect(codeOf(() => checkLifecycleEnvelope(bad))).toBe("ENVELOPE_BAD_EVENT_TYPE");
  });

  it("HOOK_ON_LIFECYCLE_PATH: a hook event routed to the lifecycle path is rejected", () => {
    const event = makeHookEvent([startedSpan()]);
    expect(codeOf(() => checkLifecycleEnvelope(event))).toBe("HOOK_ON_LIFECYCLE_PATH");
  });

  it("ACTIVITY_COMPLETED_WITH_SPANS: ActivityCompleted must not carry non-empty hook spans", () => {
    const bad = new EventEnvelope({
      eventType: EventType.ACTIVITY_COMPLETED,
      payload: WF,
      spans: [completedSpan()]
    });
    expect(codeOf(() => checkLifecycleEnvelope(bad))).toBe("ACTIVITY_COMPLETED_WITH_SPANS");
    expect(() => checkLifecycleEnvelope(bad)).toThrow(/must not carry/);
  });

  it("HOOK_TRIGGER_FALSE: a span-bearing non-hook lifecycle event is rejected", () => {
    const bad = new EventEnvelope({
      eventType: EventType.WORKFLOW_STARTED,
      payload: WF,
      spans: [startedSpan()]
    });
    expect(codeOf(() => checkLifecycleEnvelope(bad))).toBe("HOOK_TRIGGER_FALSE");
    expect(() => checkLifecycleEnvelope(bad)).toThrow(/hookTrigger=false/);
  });

  it("accepts well-formed lifecycle, signal, and handoff envelopes", () => {
    expect(() => checkLifecycleEnvelope(workflowStarted({ workflowId: "w", runId: "r", workflowType: "T" }))).not.toThrow();
    expect(() =>
      checkLifecycleEnvelope(signalReceived({ workflowId: "w", runId: "r", workflowType: "T", signalName: "go" }))
    ).not.toThrow();
    expect(() =>
      checkLifecycleEnvelope(handoff({ fromAgentDid: "did:aip:x", multiAgentSessionId: "s" }))
    ).not.toThrow();
  });
});

describe("checkHookEnvelope — strict hook failures", () => {
  it("HOOK_TRIGGER_FALSE: hookTrigger=false is rejected even with spans and identity", () => {
    const bad = new EventEnvelope({
      eventType: EventType.ACTIVITY_STARTED,
      payload: WF,
      spans: [startedSpan()],
      hookTrigger: false,
      activityId: "a",
      activityType: "t"
    });
    expect(codeOf(() => checkHookEnvelope(bad))).toBe("HOOK_TRIGGER_FALSE");
    expect(() => checkHookEnvelope(bad)).toThrow(/hookTrigger=true/);
  });

  it("HOOK_WRONG_WIRE_TYPE: hookTrigger=true with a non-ActivityStarted eventType is rejected", () => {
    const bad = new EventEnvelope({
      eventType: EventType.ACTIVITY_COMPLETED,
      payload: WF,
      spans: [startedSpan()],
      hookTrigger: true,
      activityId: "a",
      activityType: "t"
    });
    expect(codeOf(() => checkHookEnvelope(bad))).toBe("HOOK_WRONG_WIRE_TYPE");
    expect(() => checkHookEnvelope(bad)).toThrow(/ActivityStarted/);
  });

  it("HOOK_EMPTY_SPANS: hookTrigger=true with no spans is rejected", () => {
    const bad = new EventEnvelope({
      eventType: EventType.ACTIVITY_STARTED,
      payload: WF,
      hookTrigger: true,
      activityId: "a",
      activityType: "t"
    });
    expect(codeOf(() => checkHookEnvelope(bad))).toBe("HOOK_EMPTY_SPANS");
  });

  it("HOOK_UNBOUND_ACTIVITY: hookTrigger=true without activityId/activityType is rejected", () => {
    const bad = new EventEnvelope({
      eventType: EventType.ACTIVITY_STARTED,
      payload: WF,
      spans: [startedSpan()],
      hookTrigger: true
    });
    expect(codeOf(() => checkHookEnvelope(bad))).toBe("HOOK_UNBOUND_ACTIVITY");
    expect(() => checkHookEnvelope(bad)).toThrow(/bound activity/);
  });

  it.each(["otel", "openbox", "metadata", "data"])(
    "HOOK_SPAN_NOT_FLAT: a nested `%s` key on a span is rejected",
    (key) => {
      const event = makeHookEvent([{ stage: "started", [key]: { nested: true } }]);
      expect(codeOf(() => checkHookEnvelope(event))).toBe("HOOK_SPAN_NOT_FLAT");
    }
  );

  it("HOOK_SPAN_NOT_FLAT: reports every forbidden key found on the offending span", () => {
    const event = makeHookEvent([{ stage: "started", otel: {}, openbox: {} }]);
    try {
      checkHookEnvelope(event);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).detail["forbidden"]).toStrictEqual(["openbox", "otel"]);
      expect((error as ContractError).detail["index"]).toBe(0);
    }
  });

  it("a non-object span entry is skipped by the flat-shape check (degrades gracefully, matches Python's isinstance guard)", () => {
    const event = makeHookEvent([null as unknown as SpanRecord]);
    expect(() => checkHookEnvelope(event)).not.toThrow();
  });

  it("accepts a well-formed flat hook envelope", () => {
    expect(() => checkHookEnvelope(makeHookEvent([startedSpan()]))).not.toThrow();
  });
});

describe("checkStage — stage mismatch failures", () => {
  it("HOOK_STAGE_MISMATCH: a started-stage check rejects a completed-stage span", () => {
    const event = makeHookEvent([completedSpan()]);
    expect(codeOf(() => checkStage(event, "started"))).toBe("HOOK_STAGE_MISMATCH");
    expect(() => checkStage(event, "started")).toThrow(/started-stage evaluation received a completed/);
  });

  it("HOOK_STAGE_MISMATCH: a completed-stage check rejects a started-stage span", () => {
    const event = makeHookEvent([startedSpan()]);
    expect(codeOf(() => checkStage(event, "completed"))).toBe("HOOK_STAGE_MISMATCH");
    expect(() => checkStage(event, "completed")).toThrow(/completed-stage evaluation received a started/);
  });

  it("HOOK_SPAN_NO_STAGE: a stageless span is rejected for either expected stage", () => {
    const event = makeHookEvent([{ span_id: "aa".repeat(8) }]);
    expect(codeOf(() => checkStage(event, "started"))).toBe("HOOK_SPAN_NO_STAGE");
    expect(codeOf(() => checkStage(event, "completed"))).toBe("HOOK_SPAN_NO_STAGE");
  });

  it("accepts a matching stage", () => {
    expect(() => checkStage(makeHookEvent([startedSpan()]), "started")).not.toThrow();
    expect(() => checkStage(makeHookEvent([completedSpan()]), "completed")).not.toThrow();
  });
});

describe("spanStage", () => {
  it("extracts a string stage", () => {
    expect(spanStage({ stage: "started" })).toBe("started");
  });

  it("returns null for a missing, non-string, null, or undefined span", () => {
    expect(spanStage({})).toBeNull();
    expect(spanStage({ stage: 1 as unknown as string })).toBeNull();
    expect(spanStage(null)).toBeNull();
    expect(spanStage(undefined)).toBeNull();
  });
});
