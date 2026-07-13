import { describe, expect, it } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { ApprovalPoller } from "../src/approvals/index.js";
import { OpenBoxClient } from "../src/client/index.js";
import {
  APPROVAL_SCENARIOS,
  CONFORMANCE_ACTIVITY_CONTEXT,
  CONFORMANCE_HOOK_TYPE_SCENARIOS,
  FakeAdapter,
  FakeCore,
  assertHookWireShape,
  buildConformanceRuntime
} from "../src/conformance/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { hook } from "../src/contracts/event-factories.js";
import { HookType } from "../src/contracts/otel-spans.js";
import { EvaluationResult, Verdict, type JsonValue } from "../src/contracts/results.js";
import { ApprovalExpiredError, ApprovalRejectedError } from "../src/errors/index.js";
import { AgentIdentity } from "../src/identity/index.js";
import { buildEvaluatePayload } from "../src/wire/evaluate-payload.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const ACTIVITY_CONTEXT = {
  workflow_id: "wf-1",
  run_id: "run-1",
  workflow_type: "W"
};

function evalResult(verdict: Verdict, reason: string | null = null): EvaluationResult {
  const result = new EvaluationResult();
  result.verdict = verdict;
  result.reason = reason;
  return result;
}

function startedHookPayload(): Record<string, JsonValue> {
  const event = hook({
    activityContext: ACTIVITY_CONTEXT,
    activityId: "act-1",
    activityType: "charge",
    spans: [{ stage: "started", hook_type: "http_request", http_method: "GET", http_url: "https://x" }]
  });
  return buildEvaluatePayload(event).payload;
}

describe("FakeCore — request capture", () => {
  it("captures method/path/body for an evaluate call, answering the default ALLOW", async () => {
    const fakeCore = new FakeCore();
    const client = new OpenBoxClient("https://core.test", "obx_test_x", { fetchImpl: fakeCore.fetchImpl });

    const result = await client.evaluate({ event_type: "WorkflowStarted", workflow_id: "wf-1" });

    expect(result.verdict).toBe(Verdict.ALLOW);
    expect(fakeCore.evaluateRequests).toHaveLength(1);
    const captured = fakeCore.evaluateRequests[0]!;
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe("/api/v1/governance/evaluate");
    expect(captured.bodyJson).toStrictEqual({ event_type: "WorkflowStarted", workflow_id: "wf-1" });
  });

  it("proves EVERY signed header reaches the wire (all X-OpenBox-Agent-* + body hash)", async () => {
    const fakeCore = new FakeCore();
    const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const client = new OpenBoxClient("https://core.test", "obx_test_x", {
      fetchImpl: fakeCore.fetchImpl,
      identity
    });

    await client.evaluate({ note: "hello" });

    const headers = fakeCore.evaluateRequests[0]!.headers;
    expect(headers["x-openbox-agent-did"]).toBe(GOLDEN_DID);
    expect(headers["x-openbox-agent-timestamp"]).toMatch(/\+00:00$/);
    expect(headers["x-openbox-agent-nonce"]).toBeTruthy();
    expect(headers["x-openbox-agent-signature"]).toBeTruthy();
    expect(headers["x-openbox-body-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["authorization"]).toBe("Bearer obx_test_x");
  });

  it("scripts responses FIFO and falls back to ALLOW once the queue drains", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const client = new OpenBoxClient("https://core.test", "obx_test_x", { fetchImpl: fakeCore.fetchImpl });

    expect((await client.evaluate({})).verdict).toBe(Verdict.BLOCK);
    expect((await client.evaluate({})).verdict).toBe(Verdict.ALLOW); // queue drained -> default
  });

  it("scripts a network error via queueEvaluate", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "ECONNREFUSED" });
    const client = new OpenBoxClient("https://core.test", "obx_test_x", {
      fetchImpl: fakeCore.fetchImpl,
      onApiError: "fail_closed"
    });
    await expect(client.evaluate({})).rejects.toThrow();
  });

  it("answers auth/validate requests too, scriptable via queueAuth", async () => {
    const fakeCore = new FakeCore();
    const client = new OpenBoxClient("https://core.test", "obx_test_x", { fetchImpl: fakeCore.fetchImpl });
    expect(await client.validateApiKey()).toBe(true); // default 200
    expect(fakeCore.authRequests).toHaveLength(1);
    expect(fakeCore.authRequests[0]!.path).toBe("/api/v1/auth/validate");

    fakeCore.queueAuth({ status: 401, body: {} });
    await expect(client.validateApiKey()).rejects.toThrow();
  });

  it("failAllApprovals makes every subsequent approval poll network-error", async () => {
    const fakeCore = new FakeCore().failAllApprovals("core down");
    const client = new OpenBoxClient("https://core.test", "obx_test_x", { fetchImpl: fakeCore.fetchImpl });
    expect(await client.pollApproval("w", "r", "a")).toBeNull();
    expect(fakeCore.approvalRequests).toHaveLength(1);
  });

  it("classifies captured requests by stage/kind", async () => {
    const fakeCore = new FakeCore();
    const client = new OpenBoxClient("https://core.test", "obx_test_x", { fetchImpl: fakeCore.fetchImpl });
    await client.evaluate({ event_type: "WorkflowStarted" });
    await client.evaluate(startedHookPayload());

    expect(fakeCore.lifecycleRequests).toHaveLength(1);
    expect(fakeCore.startedRequests).toHaveLength(1);
    expect(fakeCore.completedRequests).toHaveLength(0);
  });
});

describe("FakeAdapter", () => {
  it("records call order across all four callbacks", async () => {
    const adapter = new FakeAdapter();
    await adapter.handleApproval(evalResult(Verdict.REQUIRE_APPROVAL));
    try {
      adapter.raiseHookBlocked(evalResult(Verdict.BLOCK, "x"));
    } catch {
      /* expected */
    }
    adapter.onCompletedHookResult(evalResult(Verdict.ALLOW), null);

    expect(adapter.calls.map((c) => c.kind)).toStrictEqual([
      "handleApproval",
      "raiseHookBlocked",
      "onCompletedHookResult"
    ]);
  });

  it("drives the approval matrix via approvalOutcome", async () => {
    const allowResult = evalResult(Verdict.REQUIRE_APPROVAL);

    await expect(new FakeAdapter({ approvalOutcome: "allow" }).handleApproval(allowResult)).resolves.toBeUndefined();
    await expect(new FakeAdapter({ approvalOutcome: "reject" }).handleApproval(allowResult)).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
    await expect(new FakeAdapter({ approvalOutcome: "expire" }).handleApproval(allowResult)).rejects.toBeInstanceOf(
      ApprovalExpiredError
    );
  });

  it("reset() clears call history", () => {
    const adapter = new FakeAdapter();
    adapter.onCompletedHookResult(evalResult(Verdict.ALLOW));
    expect(adapter.calls).toHaveLength(1);
    adapter.reset();
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("assertHookWireShape", () => {
  it("passes for a real SDK-produced hook payload", () => {
    expect(() => assertHookWireShape(startedHookPayload())).not.toThrow();
  });

  it("throws when event_type/hook_trigger are wrong", () => {
    expect(() => assertHookWireShape({ event_type: "ActivityCompleted", hook_trigger: true, spans: [] })).toThrow();
  });

  it("throws when a nested envelope key leaks onto a span", () => {
    const payload = startedHookPayload();
    const spans = payload["spans"] as Record<string, unknown>[];
    spans[0]!["otel"] = {};
    expect(() => assertHookWireShape(payload)).toThrow();
  });

  it("throws when span_id/trace_id are not valid hex", () => {
    const payload = startedHookPayload();
    const spans = payload["spans"] as Record<string, unknown>[];
    spans[0]!["span_id"] = "not-hex";
    expect(() => assertHookWireShape(payload)).toThrow();
  });

  it("accepts a valid non-null parent_span_id and rejects a malformed one", () => {
    const valid = startedHookPayload();
    (valid["spans"] as Record<string, unknown>[])[0]!["parent_span_id"] = "a".repeat(16);
    expect(() => assertHookWireShape(valid)).not.toThrow();

    const invalid = startedHookPayload();
    (invalid["spans"] as Record<string, unknown>[])[0]!["parent_span_id"] = "too-short";
    expect(() => assertHookWireShape(invalid)).toThrow();
  });
});

describe("conformance scenarios", () => {
  it("CONFORMANCE_ACTIVITY_CONTEXT is a fully-bound activity context", () => {
    expect(CONFORMANCE_ACTIVITY_CONTEXT.activityId).toBeTruthy();
    expect(CONFORMANCE_ACTIVITY_CONTEXT.activityType).toBeTruthy();
    expect(CONFORMANCE_ACTIVITY_CONTEXT.workflowId).toBeTruthy();
  });

  it("CONFORMANCE_HOOK_TYPE_SCENARIOS covers every non-reserved HookType", () => {
    const covered = CONFORMANCE_HOOK_TYPE_SCENARIOS.map((s) => s.hookType).sort();
    const expected = [HookType.HTTP_REQUEST, HookType.DB_QUERY, HookType.FILE_OPERATION, HookType.FUNCTION_CALL].sort();
    expect(covered).toStrictEqual(expected);
  });

  it("buildConformanceRuntime wires a runtime whose client hits the given FakeCore", async () => {
    const fakeCore = new FakeCore();
    const runtime = buildConformanceRuntime(fakeCore);
    await runtime.client.evaluate({});
    expect(fakeCore.evaluateRequests).toHaveLength(1);
  });

  it.each(APPROVAL_SCENARIOS)("approval scenario '$name' resolves to $expected", async (scenario) => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map((body) => ({ status: 200, body })));
    const client = new OpenBoxClient("https://core.test", "obx_test_conformance", {
      fetchImpl: fakeCore.fetchImpl
    });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });

    const evaluated = await client.evaluate({});
    // The runtime always threads the originating ActivityContext — the poll is
    // keyed on these IDs (approval_id in the scenario bodies is inert metadata).
    const drive = adapter.handleApproval(
      evaluated,
      new ActivityContext({ workflowId: "wf-conf", runId: "run-conf", activityId: "act-conf" })
    );

    if (scenario.expected === "approved") {
      await expect(drive).resolves.toBeUndefined();
    } else if (scenario.expected === "rejected") {
      await expect(drive).rejects.toBeInstanceOf(ApprovalRejectedError);
    } else {
      await expect(drive).rejects.toBeInstanceOf(ApprovalExpiredError);
    }
  });
});
