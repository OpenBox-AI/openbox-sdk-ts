import { afterEach, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { getTracedGovernanceRuntime, setTracedGovernanceRuntime, traced } from "../src/instrumentation/function-wrapper-traced.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_fn" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

afterEach(() => {
  setTracedGovernanceRuntime(null); // never leak active-runtime state across tests
});

describe("traced() — no active runtime: zero-governance passthrough", () => {
  it("calls the wrapped function directly when no runtime has been set", async () => {
    expect(getTracedGovernanceRuntime()).toBeNull();
    let calls = 0;
    const fn = traced(async (x: number) => {
      calls += 1;
      return x * 2;
    });
    await expect(fn(21)).resolves.toBe(42);
    expect(calls).toBe(1);
  });
});

describe("traced() — op did not run on BLOCK", () => {
  it("BLOCK prevents the wrapped function body from ever executing", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    let calls = 0;
    const fn = traced(async () => {
      calls += 1;
      return "should never run";
    });

    await expect(contextStore.activityScope(BOUND_CTX, () => fn())).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect(calls).toBe(0);
  });
});

describe("traced() — ALLOW proceeds, captures args/result", () => {
  it("captures args on the started span and the result on the completed span by default", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    const charge = traced(async (amount: number, currency: string) => ({ ok: true, amount, currency }), {
      name: "charge",
      module: "billing"
    });

    const result = await contextStore.activityScope(BOUND_CTX, () => charge(100, "USD"));
    expect(result).toStrictEqual({ ok: true, amount: 100, currency: "USD" });

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const startedSpan = (fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(startedSpan?.["hook_type"]).toBe("function_call");
    expect(startedSpan?.["function"]).toBe("charge");
    expect(startedSpan?.["module"]).toBe("billing");
    expect(startedSpan?.["args"]).toStrictEqual([100, "USD"]);
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["result"]).toStrictEqual({ ok: true, amount: 100, currency: "USD" });
  });

  it("captureArgs/captureResult=false suppress capture without breaking the call", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    const fn = traced(async (secret: string) => `handled:${secret}`, {
      captureArgs: false,
      captureResult: false
    });

    const result = await contextStore.activityScope(BOUND_CTX, () => fn("do-not-log-me"));
    expect(result).toBe("handled:do-not-log-me");

    const startedSpan = (fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(startedSpan?.["args"]).toBeNull();
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["result"]).toBeNull();
  });

  it("defaults the span name to fn.name when no explicit name is given", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    async function myNamedFunction(): Promise<string> {
      return "ok";
    }
    const fn = traced(myNamedFunction);
    await contextStore.activityScope(BOUND_CTX, () => fn());

    const startedSpan = (fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(startedSpan?.["function"]).toBe("myNamedFunction");
  });
});

describe("traced() — completed telemetry on failure, never swallows the error", () => {
  it("a thrown error still produces completed telemetry with the error message, then re-throws", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    const fn = traced(async () => {
      throw new Error("insufficient funds");
    });

    await expect(contextStore.activityScope(BOUND_CTX, () => fn())).rejects.toThrow("insufficient funds");

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["error"]).toBe("insufficient funds");
    expect(completedSpan?.["result"]).toBeNull();
  });

  it("a thrown error with captureArgs=false still omits args from the completed (failure) span", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    const fn = traced(
      async (secret: string) => {
        throw new Error(`failed for ${secret}`);
      },
      { captureArgs: false }
    );

    await expect(contextStore.activityScope(BOUND_CTX, () => fn("do-not-log-me"))).rejects.toThrow(
      "failed for do-not-log-me"
    );

    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["args"]).toBeNull();
  });
});

describe("traced() — no bound context still runs the function (Decision 14 skip, not an error)", () => {
  it("proceeds normally with no evaluate call at all when nothing is bound", async () => {
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    setTracedGovernanceRuntime(runtime);

    const fn = traced(async () => "unbound-ok");
    await expect(fn()).resolves.toBe("unbound-ok");
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });
});
