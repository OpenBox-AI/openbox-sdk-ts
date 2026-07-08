import { describe, expect, it } from "vitest";

import { HookType } from "../src/contracts/otel-spans.js";
import { toCoreSpanData } from "../src/spans/core-span.js";
import { buildCompletedFunctionSpan, buildStartedFunctionSpan } from "../src/spans/function-span-builder.js";

const IDENTITY = { spanId: "a".repeat(16), traceId: "b".repeat(32) };

describe("buildStartedFunctionSpan", () => {
  it("populates the function_call family wire keys, capturing args when given", () => {
    const span = buildStartedFunctionSpan({
      ...IDENTITY,
      functionName: "charge",
      moduleName: "billing",
      startTimeNs: 10,
      args: [100, { currency: "USD" }]
    });
    expect(span["stage"]).toBe("started");
    expect(span["hook_type"]).toBe(HookType.FUNCTION_CALL);
    expect(span["function"]).toBe("charge");
    expect(span["module"]).toBe("billing");
    expect(span["args"]).toStrictEqual([100, { currency: "USD" }]);
    expect(span["attribute_key_identifiers"]).toStrictEqual(["function", "module"]);
  });

  it("args is null when capture is not requested (args undefined)", () => {
    const span = buildStartedFunctionSpan({ ...IDENTITY, functionName: "f", moduleName: null, startTimeNs: 1 });
    expect(span["args"]).toBeNull();
  });

  it("degrades to null instead of throwing when args contain a circular reference", () => {
    interface CircularHolder {
      self?: CircularHolder;
    }
    const circular: CircularHolder = {};
    circular.self = circular;
    const span = buildStartedFunctionSpan({
      ...IDENTITY,
      functionName: "f",
      moduleName: null,
      startTimeNs: 1,
      args: [circular]
    });
    expect(span["args"]).toBeNull();
  });

  it("normalizes cleanly through toCoreSpanData", () => {
    const span = buildStartedFunctionSpan({ ...IDENTITY, functionName: "f", moduleName: null, startTimeNs: 1 });
    const { wireSpan } = toCoreSpanData(span);
    expect(wireSpan["end_time"]).toBeNull();
    expect(wireSpan["duration_ns"]).toBeNull();
    expect(wireSpan["result"]).toBeNull();
  });
});

describe("buildCompletedFunctionSpan", () => {
  it("captures the result on success", () => {
    const span = buildCompletedFunctionSpan({
      ...IDENTITY,
      functionName: "charge",
      moduleName: "billing",
      startTimeNs: 0,
      endTimeNs: 5,
      durationNs: 5,
      result: { ok: true }
    });
    expect(span["result"]).toStrictEqual({ ok: true });
    expect(span["error"]).toBeNull();
  });

  it("result is null when capture is not requested (result undefined)", () => {
    const span = buildCompletedFunctionSpan({
      ...IDENTITY,
      functionName: "f",
      moduleName: null,
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1
    });
    expect(span["result"]).toBeNull();
  });

  it("carries the error message on failure, with no result", () => {
    const span = buildCompletedFunctionSpan({
      ...IDENTITY,
      functionName: "charge",
      moduleName: "billing",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      error: "insufficient funds"
    });
    expect(span["error"]).toBe("insufficient funds");
    expect(span["result"]).toBeNull();
  });
});
