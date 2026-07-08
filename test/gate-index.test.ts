import { describe, expect, it } from "vitest";

import { COMPAT_NOISE_REMOVED, ATTR_REDACTED } from "../src/contracts/diagnostics.js";
import { activityCompleted, hook, workflowStarted } from "../src/contracts/event-factories.js";
import { Stage } from "../src/contracts/otel-spans.js";
import {
  EvaluationResult,
  GuardrailsResult,
  Verdict,
  verdictPriority,
  verdictShouldStop
} from "../src/contracts/results.js";
import { ContractError, GovernanceBlockedError, GovernanceHaltError, GuardrailsValidationError } from "../src/errors/index.js";
import {
  STAGE_COMPLETED,
  STAGE_STARTED,
  finalizePayload,
  prepareHookPayload,
  prepareLifecyclePayload,
  raiseForVerdict,
  stampTimestamp,
  stripCompatNoise,
  validateHook,
  validateLifecycle
} from "../src/gate/index.js";
import { buildEvaluatePayload } from "../src/wire/evaluate-payload.js";

const WF = { workflowId: "wf-1", runId: "run-1", workflowType: "W" };

describe("STAGE_STARTED / STAGE_COMPLETED", () => {
  it("mirror contracts/otel-spans Stage values", () => {
    expect(STAGE_STARTED).toBe(Stage.STARTED);
    expect(STAGE_COMPLETED).toBe(Stage.COMPLETED);
  });
});

describe("validateLifecycle / validateHook", () => {
  it("validateLifecycle returns no diagnostics for a well-formed event", () => {
    expect(validateLifecycle(workflowStarted(WF))).toStrictEqual([]);
  });

  it("validateLifecycle throws ContractError for a malformed event", () => {
    const bad = hook({
      activityContext: WF,
      activityId: "a",
      activityType: "t",
      spans: [{ stage: "started" }]
    });
    expect(() => validateLifecycle(bad)).toThrow(ContractError);
  });

  it("validateHook returns no diagnostics for a matching stage", () => {
    const event = hook({
      activityContext: WF,
      activityId: "a",
      activityType: "t",
      spans: [{ stage: "started" }]
    });
    expect(validateHook(event, STAGE_STARTED)).toStrictEqual([]);
  });

  it("validateHook throws ContractError on stage mismatch", () => {
    const event = hook({
      activityContext: WF,
      activityId: "a",
      activityType: "t",
      spans: [{ stage: "completed" }]
    });
    expect(() => validateHook(event, STAGE_STARTED)).toThrow(ContractError);
  });
});

describe("stripCompatNoise", () => {
  it("removes spans:[] and span_count:0 together and records one diagnostic", () => {
    const { payload, diagnostics } = stripCompatNoise({ workflow_id: "w", spans: [], span_count: 0 });
    expect(payload).not.toHaveProperty("spans");
    expect(payload).not.toHaveProperty("span_count");
    expect(payload["workflow_id"]).toBe("w");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(COMPAT_NOISE_REMOVED);
    expect(diagnostics[0]?.detail["removed"]).toStrictEqual(["spans", "span_count"]);
  });

  it("leaves a nonzero span_count and non-empty spans untouched", () => {
    const { payload, diagnostics } = stripCompatNoise({ span_count: 3, spans: ["x"] });
    expect(payload["span_count"]).toBe(3);
    expect(payload["spans"]).toStrictEqual(["x"]);
    expect(diagnostics).toStrictEqual([]);
  });

  it("is a no-op when neither key is present", () => {
    const { payload, diagnostics } = stripCompatNoise({ workflow_id: "w" });
    expect(payload).toStrictEqual({ workflow_id: "w" });
    expect(diagnostics).toStrictEqual([]);
  });

  it("removes only spans when span_count is absent", () => {
    const { payload, diagnostics } = stripCompatNoise({ spans: [] });
    expect(payload).not.toHaveProperty("spans");
    expect(diagnostics[0]?.detail["removed"]).toStrictEqual(["spans"]);
  });
});

describe("stampTimestamp", () => {
  it("stamps an RFC3339 Z timestamp when absent", () => {
    const stamped = stampTimestamp({ workflow_id: "w" });
    expect(typeof stamped["timestamp"]).toBe("string");
    expect(stamped["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("preserves an explicit timestamp (setdefault semantics)", () => {
    const stamped = stampTimestamp({ timestamp: "2026-01-01T00:00:00.000Z" });
    expect(stamped["timestamp"]).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("finalizePayload", () => {
  it("preserves explicit nulls (null-inclusion, not null-drop)", () => {
    const { payload } = finalizePayload({ end_time: null, duration_ns: null, name: "span" }, []);
    expect(payload).toHaveProperty("end_time");
    expect(payload).toHaveProperty("duration_ns");
    expect(payload["end_time"]).toBeNull();
    expect(payload["duration_ns"]).toBeNull();
  });

  it("a realistic large epoch-ns value serializes as an unquoted JSON integer (not a string, not exponential)", () => {
    // eslint-disable-next-line no-loss-of-precision -- intentional: ~1.75e18 exceeds Number.MAX_SAFE_INTEGER (2^53); the ~256ns imprecision is the documented, accepted trade-off (see contracts/otel-spans.ts).
    const { payload } = finalizePayload({ start_time: 1_750_000_000_000_000_123 }, []);
    const json = JSON.stringify(payload);
    expect(json).toContain('"start_time":1750000000000000000');
    expect(json).not.toMatch(/"start_time":"/);
    expect(json).not.toMatch(/e\+?\d+/i);
  });

  it("redacts matching keys and appends a redaction diagnostic when a privacy config is given", () => {
    const { payload, diagnostics } = finalizePayload(
      { activity_input: { password: "hunter2", user: "bob" } },
      [],
      { privacy: { redactKeys: new Set(["password"]), maxBodySize: 65536 } }
    );
    const activityInput = payload["activity_input"] as Record<string, unknown>;
    expect(activityInput["password"]).toBe("[REDACTED]");
    expect(activityInput["user"]).toBe("bob");
    expect(diagnostics.some((d) => d.code === ATTR_REDACTED)).toBe(true);
  });

  it("does not redact when no privacy config is given", () => {
    const { payload, diagnostics } = finalizePayload({ activity_input: { password: "x" } }, []);
    expect((payload["activity_input"] as Record<string, unknown>)["password"]).toBe("x");
    expect(diagnostics).toStrictEqual([]);
  });

  it("does not redact when redactKeys is an empty set", () => {
    const { payload } = finalizePayload({ secret: "x" }, [], {
      privacy: { redactKeys: new Set(), maxBodySize: 65536 }
    });
    expect(payload["secret"]).toBe("x");
  });

  it("a non-empty redactKeys set that matches nothing adds no redaction diagnostic", () => {
    const { payload, diagnostics } = finalizePayload({ harmless: "x" }, [], {
      privacy: { redactKeys: new Set(["password"]), maxBodySize: 65536 }
    });
    expect(payload["harmless"]).toBe("x");
    expect(diagnostics).toStrictEqual([]);
  });
});

describe("raiseForVerdict — priority order (HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW)", () => {
  function resultWith(verdict: Verdict, guardrailsFailing = false): EvaluationResult {
    const result = new EvaluationResult();
    result.verdict = verdict;
    result.reason = "because";
    if (guardrailsFailing) {
      const guardrails = new GuardrailsResult();
      guardrails.validationPassed = false;
      guardrails.reasons = [{ reason: "blocked content" }];
      result.guardrails = guardrails;
    }
    return result;
  }

  it("HALT throws GovernanceHaltError", () => {
    expect(() => raiseForVerdict(resultWith(Verdict.HALT))).toThrow(GovernanceHaltError);
  });

  it("HALT with no reason falls back to a default message", () => {
    const result = resultWith(Verdict.HALT);
    result.reason = null;
    expect(() => raiseForVerdict(result)).toThrow(/Halted by governance policy/);
  });

  it("BLOCK with no reason falls back to a default message", () => {
    const result = resultWith(Verdict.BLOCK);
    result.reason = null;
    expect(() => raiseForVerdict(result)).toThrow(/Blocked by governance policy/);
  });

  it("BLOCK throws GovernanceBlockedError carrying the verdict", () => {
    try {
      raiseForVerdict(resultWith(Verdict.BLOCK));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceBlockedError);
      expect((error as GovernanceBlockedError).verdict).toBe(Verdict.BLOCK);
    }
  });

  it("guardrails failure outranks REQUIRE_APPROVAL — never swallowed by a HITL flow", () => {
    expect(() => raiseForVerdict(resultWith(Verdict.REQUIRE_APPROVAL, true))).toThrow(
      GuardrailsValidationError
    );
  });

  it("guardrails failure with no reasons still throws with a default message", () => {
    const result = resultWith(Verdict.ALLOW);
    result.guardrails = new GuardrailsResult();
    result.guardrails.validationPassed = false;
    result.guardrails.reasons = [];
    try {
      raiseForVerdict(result);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GuardrailsValidationError);
      expect((error as GuardrailsValidationError).reasons).toStrictEqual(["Guardrails validation failed"]);
    }
  });

  it("REQUIRE_APPROVAL and CONSTRAIN return the result unchanged (caller decides)", () => {
    expect(raiseForVerdict(resultWith(Verdict.REQUIRE_APPROVAL))).toBeInstanceOf(EvaluationResult);
    expect(raiseForVerdict(resultWith(Verdict.CONSTRAIN)).verdict).toBe(Verdict.CONSTRAIN);
  });

  it("ALLOW returns the result unchanged", () => {
    expect(raiseForVerdict(resultWith(Verdict.ALLOW)).verdict).toBe(Verdict.ALLOW);
  });

  it("verdictShouldStop/verdictPriority agree with which verdicts raiseForVerdict throws on", () => {
    const stopping = [Verdict.HALT, Verdict.BLOCK].sort((a, b) => verdictPriority(b) - verdictPriority(a));
    expect(stopping).toStrictEqual([Verdict.HALT, Verdict.BLOCK]);
    for (const verdict of Object.values(Verdict)) {
      const shouldThrow = verdict === Verdict.HALT || verdict === Verdict.BLOCK;
      expect(verdictShouldStop(verdict)).toBe(shouldThrow);
      if (shouldThrow) {
        expect(() => raiseForVerdict(resultWith(verdict))).toThrow();
      } else {
        expect(() => raiseForVerdict(resultWith(verdict))).not.toThrow();
      }
    }
  });
});

describe("prepareLifecyclePayload", () => {
  it("stamps a timestamp and strips compat noise end to end", () => {
    const event = activityCompleted({
      ...WF,
      activityId: "a",
      activityType: "t",
      extra: { spans: [], span_count: 0 }
    });
    const { payload, diagnostics } = prepareLifecyclePayload(event);
    expect(payload).not.toHaveProperty("spans");
    expect(payload).not.toHaveProperty("span_count");
    expect(typeof payload["timestamp"]).toBe("string");
    expect(diagnostics.some((d) => d.code === COMPAT_NOISE_REMOVED)).toBe(true);
  });

  it("preserves an explicit timestamp instead of overwriting it", () => {
    const event = workflowStarted({ ...WF, timestamp: "2026-01-01T00:00:00.000Z" });
    const { payload } = prepareLifecyclePayload(event);
    expect(payload["timestamp"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("applies redaction via the privacy option", () => {
    const event = activityCompleted({
      ...WF,
      activityId: "a",
      activityType: "t",
      extra: { activity_input: { password: "hunter2", user: "bob" } }
    });
    const { payload, diagnostics } = prepareLifecyclePayload(event, {
      privacy: { redactKeys: new Set(["password"]), maxBodySize: 65536 }
    });
    const activityInput = payload["activity_input"] as Record<string, unknown>;
    expect(activityInput["password"]).toBe("[REDACTED]");
    expect(activityInput["user"]).toBe("bob");
    expect(diagnostics.some((d) => d.code === ATTR_REDACTED)).toBe(true);
  });

  it("throws ContractError before building a payload for a malformed envelope", () => {
    const bad = workflowStarted({ workflowId: "", runId: "", workflowType: "" });
    expect(() => prepareLifecyclePayload(bad)).toThrow(ContractError);
  });
});

describe("prepareHookPayload", () => {
  it("validates, builds spans, stamps a timestamp, and finalizes end to end", () => {
    const event = hook({
      activityContext: WF,
      activityId: "a-1",
      activityType: "charge",
      spans: [{ stage: "started", hook_type: "http_request", attributes: { authorization: "secret" } }]
    });
    const { payload, diagnostics } = prepareHookPayload(
      event,
      STAGE_STARTED,
      (e) => buildEvaluatePayload(e, { privacy: { redactKeys: new Set(["authorization"]), maxBodySize: 65536 } }),
      { privacy: { redactKeys: new Set(["authorization"]), maxBodySize: 65536 } }
    );
    expect(payload["event_type"]).toBe("ActivityStarted");
    expect(payload["hook_trigger"]).toBe(true);
    expect(payload["span_count"]).toBe(1);
    expect(typeof payload["timestamp"]).toBe("string");
    const spans = payload["spans"] as Record<string, unknown>[];
    expect((spans[0]?.["attributes"] as Record<string, string>)["authorization"]).toBe("[REDACTED]");
    // Missing http_url/http_method semantic-gap diagnostics from toCoreSpanData surface through.
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("throws ContractError before ever invoking the payload builder for an invalid hook envelope", () => {
    const event = hook({
      activityContext: WF,
      activityId: "a-1",
      activityType: "charge",
      spans: [{ stage: "completed" }]
    });
    let builderCalls = 0;
    expect(() =>
      prepareHookPayload(event, STAGE_STARTED, (e) => {
        builderCalls += 1;
        return buildEvaluatePayload(e);
      })
    ).toThrow(ContractError);
    expect(builderCalls).toBe(0);
  });
});
