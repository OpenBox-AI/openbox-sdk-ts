import { describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { defaultInstrumentationConfig, OpenBoxConfig, type InstrumentationConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { Verdict } from "../src/contracts/results.js";
import { GovernanceBlockedError, GovernanceHaltError, OpenBoxSigningError } from "../src/errors/index.js";
import { AgentIdentity } from "../src/identity/index.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const BOUND_CTX = new ActivityContext({
  workflowId: "wf-1",
  runId: "run-1",
  workflowType: "W",
  activityId: "act-1",
  activityType: "charge"
});

const STARTED_SPAN = { stage: "started", hook_type: "http_request", http_method: "GET", http_url: "https://x" };
const COMPLETED_SPAN = {
  stage: "completed",
  hook_type: "http_request",
  http_method: "GET",
  http_url: "https://x",
  http_status_code: 200,
  start_time: 1,
  duration_ns: 1000
};

interface BuildOptions {
  adapter?: FakeAdapter;
  onApiError?: "fail_open" | "fail_closed";
  identity?: AgentIdentity;
  instrumentation?: Partial<InstrumentationConfig>;
  contextStore?: ContextStore;
}

function build(fakeCore: FakeCore, options: BuildOptions = {}) {
  const config = OpenBoxConfig.resolve({
    apiUrl: "https://core.test",
    apiKey: "obx_test_hook",
    instrumentation: { ...defaultInstrumentationConfig(), ...options.instrumentation }
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger,
    onApiError: options.onApiError ?? "fail_open",
    ...(options.identity !== undefined ? { identity: options.identity } : {})
  });
  const adapter = options.adapter ?? new FakeAdapter();
  const contextStore = options.contextStore ?? new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter, contextStore, logger: silentLogger });
  return { runtime, adapter, contextStore };
}

describe("OpenBoxRuntime.preflight — skip semantics (Decision 14: skip, not ContractError)", () => {
  it("no bound context: returns null, no network call", async () => {
    const fakeCore = new FakeCore();
    const { runtime } = build(fakeCore);
    const result = await runtime.preflight({ spans: [STARTED_SPAN] });
    expect(result).toBeNull();
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });

  it("a bound context WITHOUT an activity binding also skips", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = build(fakeCore);
    const workflowOnly = new ActivityContext({ workflowId: "wf-only" });
    const result = await contextStore.activityScope(workflowOnly, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result).toBeNull();
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });

  it("preflight disabled by config: skips even when bound", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = build(fakeCore, { instrumentation: { preflightEnabled: false } });
    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result).toBeNull();
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });
});

describe("OpenBoxRuntime.preflight — ALLOW", () => {
  it("proceeds and sends a wire-correct started-stage hook payload", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = build(fakeCore);

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));

    expect(result?.verdict).toBe(Verdict.ALLOW);
    expect(fakeCore.evaluateRequests).toHaveLength(1);
    const payload = fakeCore.evaluateRequests[0]!.bodyJson as Record<string, unknown>;
    expect(payload["event_type"]).toBe("ActivityStarted");
    expect(payload["hook_trigger"]).toBe(true);
    expect(payload["activity_id"]).toBe("act-1");
    expect((payload["spans"] as unknown[])[0]).toMatchObject({ stage: "started" });
  });
});

describe("OpenBoxRuntime.preflight — BLOCK/HALT", () => {
  it("BLOCK marks the activity aborted and throws via adapter.raiseHookBlocked", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "denied" } });
    const { runtime, adapter, contextStore } = build(fakeCore);

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(GovernanceBlockedError);

    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseHookBlocked"]);
    expect(contextStore.isActivityAborted("wf-1", "run-1", "act-1")).toBe(true);
  });

  it("HALT sets contextStore.isHaltRequested for this run and throws GovernanceHaltError", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "halt", reason: "kill" } });
    const { runtime, contextStore } = build(fakeCore);

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(GovernanceHaltError);
    expect(contextStore.isHaltRequested("wf-1", "run-1")).toBe(true);
  });

  it("abort short-circuit: a prior aborted activity blocks WITHOUT another network call", async () => {
    const fakeCore = new FakeCore();
    const { runtime, adapter, contextStore } = build(fakeCore);
    contextStore.markActivityAborted("wf-1", "run-1", "act-1");

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toThrow(/prior hook/);

    expect(fakeCore.evaluateRequests).toStrictEqual([]); // short-circuited before any send
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseHookBlocked"]);
  });
});

describe("OpenBoxRuntime.preflight — REQUIRE_APPROVAL", () => {
  it("drives adapter.handleApproval; resolving proceeds", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-1" }
    });
    const { runtime, adapter, contextStore } = build(fakeCore, {
      adapter: new FakeAdapter({ approvalOutcome: "allow" })
    });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result?.verdict).toBe(Verdict.REQUIRE_APPROVAL);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["handleApproval"]);
  });
});

describe("OpenBoxRuntime.preflight — fail-open vs fail-closed", () => {
  it("fail_open + network error: proceeds with a fallbackUsed ALLOW, adapter never blocked", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "ECONNREFUSED" });
    const { runtime, adapter, contextStore } = build(fakeCore, { onApiError: "fail_open" });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result?.verdict).toBe(Verdict.ALLOW);
    expect(result?.fallbackUsed).toBe(true);
    expect(adapter.calls).toStrictEqual([]);
  });

  it("fail_closed + network error: fails CLOSED as a synthetic HALT via adapter.raiseHookBlocked", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "core is down" });
    const { runtime, adapter, contextStore } = build(fakeCore, { onApiError: "fail_closed" });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(GovernanceHaltError);

    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseHookBlocked"]);
    const blockedResult = adapter.calls[0]!.result;
    expect(blockedResult.verdict).toBe(Verdict.HALT);
    expect(blockedResult.fallbackUsed).toBe(true);
    expect(blockedResult.raw["fail_closed_error"]).toContain("core is down");
    expect(contextStore.isActivityAborted("wf-1", "run-1", "act-1")).toBe(true);
  });

  it("a persistent UNSIGNED 401 fails CLOSED regardless of onApiError (never a silent fail-open)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 401, body: {} });
    const { runtime, adapter, contextStore } = build(fakeCore, { onApiError: "fail_open" });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(GovernanceHaltError);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseHookBlocked"]);
  });

  it("a persistent SIGNED 401 with a signing reason code ALSO fails CLOSED via the adapter (TS-specific: OpenBoxSigningError routes through the same seam)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 401, body: { reason_code: "signature_invalid" } });
    const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const { runtime, adapter, contextStore } = build(fakeCore, { onApiError: "fail_open", identity });

    let caught: unknown;
    try {
      await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GovernanceHaltError);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseHookBlocked"]);
    // The underlying cause is recorded on the synthetic HALT result for diagnostics.
    const blockedResult = adapter.calls[0]!.result;
    expect(blockedResult.raw["error_type"]).toBe(OpenBoxSigningError.name);
  });
});

describe("OpenBoxRuntime.completed — never raises, never undoes the operation", () => {
  it("ALLOW: sends a completed-stage payload and calls adapter.onCompletedHookResult", async () => {
    const fakeCore = new FakeCore();
    const { runtime, adapter, contextStore } = build(fakeCore);

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.completed({ spans: [COMPLETED_SPAN] }));

    expect(result?.verdict).toBe(Verdict.ALLOW);
    expect(fakeCore.evaluateRequests).toHaveLength(1);
    const sentBody = fakeCore.evaluateRequests[0]!.bodyJson as { spans: unknown[] };
    expect(sentBody.spans[0]).toMatchObject({ stage: "completed" });
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["onCompletedHookResult"]);
  });

  it("BLOCK marks the activity aborted for FUTURE execution only — never throws", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "post-hoc" } });
    const { runtime, adapter, contextStore } = build(fakeCore);

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.completed({ spans: [COMPLETED_SPAN] }));

    expect(result?.verdict).toBe(Verdict.BLOCK);
    expect(contextStore.isActivityAborted("wf-1", "run-1", "act-1")).toBe(true);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["onCompletedHookResult"]);
  });

  it("swallows an evaluate-level failure (fail_closed network error): returns null, adapter never called", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "down" });
    const { runtime, adapter, contextStore } = build(fakeCore, { onApiError: "fail_closed" });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.completed({ spans: [COMPLETED_SPAN] }));

    expect(result).toBeNull();
    expect(adapter.calls).toStrictEqual([]);
  });

  it("completedTelemetryEnabled=false skips entirely", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = build(fakeCore, { instrumentation: { completedTelemetryEnabled: false } });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.completed({ spans: [COMPLETED_SPAN] }));
    expect(result).toBeNull();
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });

  it("no bound context: returns null, no network call", async () => {
    const fakeCore = new FakeCore();
    const { runtime } = build(fakeCore);
    expect(await runtime.completed({ spans: [COMPLETED_SPAN] })).toBeNull();
    expect(fakeCore.evaluateRequests).toStrictEqual([]);
  });

  it("an adapter.onCompletedHookResult failure is logged and swallowed, not propagated", async () => {
    class ThrowingAdapter extends FakeAdapter {
      override onCompletedHookResult(): void {
        throw new Error("adapter callback exploded");
      }
    }
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = build(fakeCore, { adapter: new ThrowingAdapter() });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.completed({ spans: [COMPLETED_SPAN] }));
    expect(result?.verdict).toBe(Verdict.ALLOW);
  });
});

describe("OpenBoxRuntime.preflight — non-fail-closed errors propagate raw", () => {
  it("an unexpected error from client.evaluate is NOT converted to a synthetic HALT via the adapter", async () => {
    const weirdClient = {
      evaluate: () => Promise.reject(new Error("totally unexpected"))
    } as unknown as OpenBoxClient;
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_hook" });
    const adapter = new FakeAdapter();
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, { client: weirdClient, adapter, contextStore, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toThrow("totally unexpected");
    expect(adapter.calls).toStrictEqual([]); // never routed through the adapter's fail-closed seam
  });
});
