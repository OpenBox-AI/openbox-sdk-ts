import { describe, expect, it } from "vitest";

import {
  activityCompleted,
  activityStarted,
  handoff,
  hook,
  signalReceived,
  workflowCompleted,
  workflowFailed,
  workflowStarted
} from "../src/contracts/event-factories.js";
import {
  EventEnvelope,
  EventKind,
  EventType,
  SOURCE_WORKFLOW_TELEMETRY,
  classifyEvent,
  isEventType,
  wireEventType
} from "../src/contracts/events.js";
import type { SpanRecord } from "../src/contracts/otel-spans.js";

const WF = { workflowId: "wf-1", runId: "run-1", workflowType: "OrderWorkflow" };

function makeHook(overrides: Record<string, unknown> = {}) {
  const base = {
    activityContext: { ...WF, taskQueue: "q" },
    activityId: "act-1",
    activityType: "charge_card",
    spans: [{ span_id: "aa".repeat(8) }]
  };
  return hook({ ...base, ...overrides });
}

describe("classification", () => {
  it("hook classifies as HOOK but wires ActivityStarted", () => {
    const event = makeHook();
    expect(classifyEvent(event)).toBe(EventKind.HOOK);
    expect(wireEventType(event)).toBe(EventType.ACTIVITY_STARTED);
    expect(event.hookTrigger).toBe(true);
    expect(event.spans.length).toBe(1);
  });

  it("classifies lifecycle events", () => {
    expect(classifyEvent(workflowStarted(WF))).toBe(EventKind.LIFECYCLE);
    expect(classifyEvent(workflowCompleted(WF))).toBe(EventKind.LIFECYCLE);
    expect(classifyEvent(workflowFailed(WF))).toBe(EventKind.LIFECYCLE);
    const started = activityStarted({ ...WF, activityId: "a", activityType: "t" });
    expect(classifyEvent(started)).toBe(EventKind.LIFECYCLE);
  });

  it("classifies signal and handoff", () => {
    const sig = signalReceived({ ...WF, signalName: "approve" });
    expect(classifyEvent(sig)).toBe(EventKind.SIGNAL);
    const ho = handoff({ fromAgentDid: "did:aip:x", multiAgentSessionId: "s-1" });
    expect(classifyEvent(ho)).toBe(EventKind.HANDOFF);
  });

  it("wireEventType passes through for lifecycle", () => {
    const completed = activityCompleted({ ...WF, activityId: "a", activityType: "t" });
    expect(wireEventType(completed)).toBe(EventType.ACTIVITY_COMPLETED);
  });

  it("hand-built hook envelope still wires ActivityStarted (hookTrigger alone drives wire type)", () => {
    const event = new EventEnvelope({ eventType: EventType.ACTIVITY_COMPLETED, hookTrigger: true });
    expect(classifyEvent(event)).toBe(EventKind.HOOK);
    expect(wireEventType(event)).toBe(EventType.ACTIVITY_STARTED);
  });
});

describe("isEventType", () => {
  it("accepts all 7 wire values and rejects anything else", () => {
    for (const value of Object.values(EventType)) {
      expect(isEventType(value)).toBe(true);
    }
    expect(isEventType("Bogus")).toBe(false);
    expect(isEventType(123)).toBe(false);
    expect(isEventType(null)).toBe(false);
    expect(isEventType(undefined)).toBe(false);
  });
});

describe("toPayloadDict", () => {
  it("matches the lifecycle payload shape", () => {
    const event = workflowStarted({
      ...WF,
      taskQueue: "q",
      multiAgentSessionId: "sess-9",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
    expect(event.toPayloadDict()).toStrictEqual({
      source: SOURCE_WORKFLOW_TELEMETRY,
      event_type: "WorkflowStarted",
      workflow_id: "wf-1",
      run_id: "run-1",
      workflow_type: "OrderWorkflow",
      task_queue: "q",
      multi_agent_session_id: "sess-9",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
  });

  it("omits absent fields rather than emitting null", () => {
    const body = workflowStarted(WF).toPayloadDict();
    expect(body).not.toHaveProperty("multi_agent_session_id");
    expect(body).not.toHaveProperty("task_queue");
    expect(body).not.toHaveProperty("timestamp");
    expect(body).not.toHaveProperty("hook_trigger");
    expect(Object.values(body)).not.toContain(null);
  });

  it("still emits an explicit empty task_queue (not-null check, not truthy check)", () => {
    const body = workflowStarted({ ...WF, taskQueue: "" }).toPayloadDict();
    expect(body["task_queue"]).toBe("");
  });

  it("omits an explicit empty multi_agent_session_id (truthy check)", () => {
    const body = workflowStarted({ ...WF, multiAgentSessionId: "" }).toPayloadDict();
    expect(body).not.toHaveProperty("multi_agent_session_id");
  });

  it("carries activity identity fields", () => {
    const event = activityStarted({
      ...WF,
      activityId: "act-1",
      activityType: "charge",
      attempt: 2,
      activityInput: [1]
    });
    const body = event.toPayloadDict();
    expect(body["activity_id"]).toBe("act-1");
    expect(body["activity_type"]).toBe("charge");
    expect(body["attempt"]).toBe(2);
    expect(body["activity_input"]).toStrictEqual([1]);
  });

  it("attempt=0 and empty activityInput array are still emitted (not-null checks)", () => {
    const body = activityStarted({
      ...WF,
      activityId: "a",
      activityType: "t",
      attempt: 0,
      activityInput: []
    }).toPayloadDict();
    expect(body["attempt"]).toBe(0);
    expect(body["activity_input"]).toStrictEqual([]);
  });

  it("hook payload dict sets hook_trigger but never spans/span_count", () => {
    const body = makeHook().toPayloadDict();
    expect(body["hook_trigger"]).toBe(true);
    expect(body["event_type"]).toBe("ActivityStarted");
    expect(body).not.toHaveProperty("spans");
    expect(body).not.toHaveProperty("span_count");
  });

  it("ActivityCompleted never produces spans/span_count compat noise", () => {
    const body = activityCompleted({ ...WF, activityId: "a", activityType: "t" }).toPayloadDict();
    expect(body).not.toHaveProperty("spans");
    expect(body).not.toHaveProperty("span_count");
  });

  it("activityCompleted carries result/error/attempt when present — error is the structured object", () => {
    const body = activityCompleted({
      ...WF,
      activityId: "a",
      activityType: "t",
      result: { orderId: "ORD-1" },
      error: { type: "ToolError", message: "boom", stack_trace: "ToolError: boom\n  at x" },
      attempt: 3
    }).toPayloadDict();
    expect(body["result"]).toStrictEqual({ orderId: "ORD-1" });
    expect(body["error"]).toStrictEqual({
      type: "ToolError",
      message: "boom",
      stack_trace: "ToolError: boom\n  at x"
    });
    expect(typeof body["error"]).not.toBe("string");
    expect(body["attempt"]).toBe(3);
  });

  it("extra fields merge into the payload", () => {
    const body = workflowStarted({ ...WF, extra: { custom: "value" } }).toPayloadDict();
    expect(body["custom"]).toBe("value");
  });
});

describe("factory validation", () => {
  it("handoff requires both fields non-empty", () => {
    expect(() => handoff({ fromAgentDid: "  ", multiAgentSessionId: "s" })).toThrow(/fromAgentDid/);
    expect(() => handoff({ fromAgentDid: "did:aip:x", multiAgentSessionId: "" })).toThrow(
      /multiAgentSessionId/
    );
  });

  it("handoff omits toAgentDid (server-derived)", () => {
    const body = handoff({ fromAgentDid: "did:aip:x", multiAgentSessionId: "s" }).toPayloadDict();
    expect(body).not.toHaveProperty("to_agent_did");
    expect(body["from_agent_did"]).toBe("did:aip:x");
    expect(body["multi_agent_session_id"]).toBe("s");
  });

  it("hook requires a bound activity", () => {
    expect(() => makeHook({ activityId: "" })).toThrow(/bound activity/);
    expect(() => makeHook({ activityType: "" })).toThrow(/bound activity/);
  });

  it("hook requires non-empty spans", () => {
    expect(() => makeHook({ spans: [] })).toThrow(/spans/);
  });

  it("workflowFailed carries the structured error object, serialized unchanged", () => {
    const error = {
      type: "ApprovalRejectedError",
      message: "human said no",
      stack_trace: "ApprovalRejectedError: human said no\n  at gate",
      cause: { type: "Error", message: "root cause" },
      error_type: "governance",
      non_retryable: true
    };
    const body = workflowFailed({ ...WF, error }).toPayloadDict();
    expect(body["error"]).toStrictEqual(error);
    expect(typeof body["error"]).not.toBe("string");
  });

  it("a bare string error is no longer a valid factory input (Core rejects it with 400)", () => {
    // @ts-expect-error — WorkflowFailedOptions.error is ErrorInfo | null, not string
    workflowFailed({ ...WF, error: "boom" });
    // @ts-expect-error — ActivityCompletedOptions.error is ErrorInfo | null, not string
    activityCompleted({ ...WF, activityId: "a", activityType: "t", error: "boom" });
  });
});

describe("EventEnvelope immutability", () => {
  it("payload/spans are copies — mutating the input after construction does not affect the envelope", () => {
    const payload = { workflow_id: "wf-1" };
    const spans: SpanRecord[] = [{ stage: "started" }];
    const event = new EventEnvelope({ eventType: EventType.ACTIVITY_STARTED, payload, spans });
    payload["workflow_id"] = "mutated";
    spans.push({ stage: "completed" });
    expect(event.payload["workflow_id"]).toBe("wf-1");
    expect(event.spans.length).toBe(1);
  });

  it("defaults source to workflow-telemetry and timestamp/activity fields to null", () => {
    const event = new EventEnvelope({ eventType: EventType.WORKFLOW_STARTED });
    expect(event.source).toBe(SOURCE_WORKFLOW_TELEMETRY);
    expect(event.timestamp).toBeNull();
    expect(event.activityId).toBeNull();
    expect(event.activityType).toBeNull();
    expect(event.hookTrigger).toBe(false);
    expect(event.spans).toStrictEqual([]);
  });
});
