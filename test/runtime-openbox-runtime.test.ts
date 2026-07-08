import { describe, expect, it } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { workflowStarted } from "../src/contracts/event-factories.js";
import { EvaluationResult, GuardrailsResult, Verdict } from "../src/contracts/results.js";
import {
  ApprovalRejectedError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError
} from "../src/errors/index.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const WF = { workflowId: "wf-1", runId: "run-1", workflowType: "W" };

function buildRuntime(
  fakeCore: FakeCore,
  options: { adapter?: FakeAdapter | CoreAdapter } = {}
): OpenBoxRuntime {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_runtime" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  return new OpenBoxRuntime(config, {
    client,
    contextStore: new ContextStore(),
    ...(options.adapter !== undefined ? { adapter: options.adapter } : {})
  });
}

describe("OpenBoxRuntime — composition root defaults", () => {
  it("defaults to a poller-less CoreAdapter and a fresh ContextStore when not injected", () => {
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_runtime" });
    const runtime = new OpenBoxRuntime(config);
    expect(runtime.adapter).toBeInstanceOf(CoreAdapter);
    expect(runtime.contextStore).toBeInstanceOf(ContextStore);
    expect(runtime.client).toBeInstanceOf(OpenBoxClient);
  });

  it("uses injected client/adapter/contextStore verbatim", () => {
    const fakeCore = new FakeCore();
    const adapter = new FakeAdapter();
    const contextStore = new ContextStore();
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_runtime" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl });
    const runtime = new OpenBoxRuntime(config, { client, adapter, contextStore });
    expect(runtime.adapter).toBe(adapter);
    expect(runtime.contextStore).toBe(contextStore);
    expect(runtime.client).toBe(client);
  });
});

describe("OpenBoxRuntime.evaluateLifecycle — ALLOW/CONSTRAIN", () => {
  it("returns the result unchanged on ALLOW without touching the adapter", async () => {
    const fakeCore = new FakeCore();
    const adapter = new FakeAdapter();
    const runtime = buildRuntime(fakeCore, { adapter });

    const result = await runtime.evaluateLifecycle(workflowStarted(WF));
    expect(result.verdict).toBe(Verdict.ALLOW);
    expect(adapter.calls).toStrictEqual([]);
  });
});

describe("OpenBoxRuntime.evaluateLifecycle — BLOCK/HALT", () => {
  it("BLOCK routes through adapter.raiseLifecycleBlocked and throws", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const adapter = new FakeAdapter();
    const runtime = buildRuntime(fakeCore, { adapter });

    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["raiseLifecycleBlocked"]);
  });

  it("HALT sets contextStore.haltRequested and throws GovernanceHaltError", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "halt", reason: "kill" } });
    const adapter = new FakeAdapter();
    const runtime = buildRuntime(fakeCore, { adapter });

    expect(runtime.contextStore.haltRequested).toBe(false);
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(GovernanceHaltError);
    expect(runtime.contextStore.haltRequested).toBe(true);
  });

  it("a CoreAdapter (no custom adapter) maps BLOCK/HALT to the same base error types", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const runtime = buildRuntime(fakeCore);
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(GovernanceBlockedError);
  });
});

describe("OpenBoxRuntime.evaluateLifecycle — guardrails", () => {
  it("a guardrails failure throws GuardrailsValidationError even on an ALLOW verdict", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "allow", guardrails_result: { validation_passed: false, reasons: [{ reason: "pii" }] } }
    });
    const adapter = new FakeAdapter();
    const runtime = buildRuntime(fakeCore, { adapter });

    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(GuardrailsValidationError);
    // Guardrails failure is not a BLOCK/HALT verdict — the adapter's stop path is never invoked.
    expect(adapter.calls).toStrictEqual([]);
  });

  it("guardrails failure outranks REQUIRE_APPROVAL — never reaches handleApproval", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: {
        verdict: "require_approval",
        guardrails_result: { validation_passed: false, reasons: [{ reason: "pii" }] }
      }
    });
    const adapter = new FakeAdapter();
    const runtime = buildRuntime(fakeCore, { adapter });

    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(GuardrailsValidationError);
    expect(adapter.calls).toStrictEqual([]);
  });
});

describe("OpenBoxRuntime.evaluateLifecycle — REQUIRE_APPROVAL", () => {
  it("drives adapter.handleApproval; resolving means proceed (result still shaped REQUIRE_APPROVAL)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-1" }
    });
    const adapter = new FakeAdapter({ approvalOutcome: "allow" });
    const runtime = buildRuntime(fakeCore, { adapter });

    const result = await runtime.evaluateLifecycle(workflowStarted(WF));
    expect(result.verdict).toBe(Verdict.REQUIRE_APPROVAL);
    expect(adapter.calls.map((c) => c.kind)).toStrictEqual(["handleApproval"]);
  });

  it("propagates the adapter's rejection", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-1" }
    });
    const adapter = new FakeAdapter({ approvalOutcome: "reject" });
    const runtime = buildRuntime(fakeCore, { adapter });

    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(ApprovalRejectedError);
  });

  it("a CoreAdapter with no poller REJECTS REQUIRE_APPROVAL from the lifecycle path too", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-1" }
    });
    const runtime = buildRuntime(fakeCore);
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(ApprovalRejectedError);
  });
});

describe("OpenBoxRuntime.close", () => {
  it("clears the context store and is idempotent", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    runtime.contextStore.markActivityAborted("wf", "act");
    runtime.contextStore.requestHalt();
    runtime.contextStore.registerTrace("f".repeat(32), new ActivityContext());

    runtime.close();
    expect(runtime.contextStore.isActivityAborted("wf", "act")).toBe(false);
    expect(runtime.contextStore.haltRequested).toBe(false);
    expect(runtime.contextStore.traceMapSize()).toBe(0);

    expect(() => runtime.close()).not.toThrow();
  });
});

describe("EvaluationResult/GuardrailsResult wiring sanity", () => {
  it("guardrails and guardrailsResult are the same object (parsed from the wire)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "allow", guardrails_result: { validation_passed: true } }
    });
    const runtime = buildRuntime(fakeCore);
    const result = await runtime.evaluateLifecycle(workflowStarted(WF));
    expect(result.guardrails).toBeInstanceOf(GuardrailsResult);
    expect(result.guardrailsResult).toBe(result.guardrails);
  });
});
