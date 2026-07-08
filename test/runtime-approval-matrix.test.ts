import { describe, expect, it } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { ApprovalPoller } from "../src/approvals/index.js";
import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { APPROVAL_SCENARIOS, FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { Verdict } from "../src/contracts/results.js";
import { ApprovalExpiredError, ApprovalRejectedError, ApprovalTimeoutError } from "../src/errors/index.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({
  workflowId: "wf-1",
  runId: "run-1",
  activityId: "act-1",
  activityType: "charge"
});
const STARTED_SPAN = { stage: "started", hook_type: "http_request", http_method: "GET", http_url: "https://x" };

function buildRuntime(fakeCore: FakeCore, adapter: FakeAdapter | CoreAdapter) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
  const contextStore = new ContextStore();
  return { runtime: new OpenBoxRuntime(config, { client, adapter, contextStore, logger: silentLogger }), contextStore };
}

describe("Approval matrix — FakeAdapter (direct outcome, no real polling)", () => {
  it("allow: preflight proceeds without throwing", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-1" }
    });
    const { runtime, contextStore } = buildRuntime(fakeCore, new FakeAdapter({ approvalOutcome: "allow" }));
    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result?.verdict).toBe(Verdict.REQUIRE_APPROVAL);
  });

  it("reject: preflight throws ApprovalRejectedError", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-2" }
    });
    const { runtime, contextStore } = buildRuntime(fakeCore, new FakeAdapter({ approvalOutcome: "reject" }));
    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });

  it("expire: preflight throws ApprovalExpiredError", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      status: 200,
      body: { verdict: "require_approval", approval_id: "appr-3" }
    });
    const { runtime, contextStore } = buildRuntime(fakeCore, new FakeAdapter({ approvalOutcome: "expire" }));
    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(ApprovalExpiredError);
  });
});

describe("Approval matrix — CoreAdapter + real ApprovalPoller + FakeCore (genuine pending -> terminal)", () => {
  it("pending, then approved", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: { verdict: "require_approval", approval_id: "appr-1" } })
      .queueApproval({ status: 200, body: { action: "require_approval" } }, { status: 200, body: { action: "allow" } });
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1 });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new CoreAdapter({ approvalPoller: poller }),
      contextStore,
      logger: silentLogger
    });

    const result = await contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    expect(result?.verdict).toBe(Verdict.REQUIRE_APPROVAL);
    expect(fakeCore.approvalRequests).toHaveLength(2); // one pending poll, one terminal poll
  });

  it("pending, then rejected", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: { verdict: "require_approval", approval_id: "appr-2" } })
      .queueApproval({ status: 200, body: { action: "block", reason: "human said no" } });
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1 });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new CoreAdapter({ approvalPoller: poller }),
      contextStore,
      logger: silentLogger
    });

    const promise = contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow("human said no");
  });

  it("expired approval", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: { verdict: "require_approval", approval_id: "appr-3" } })
      .queueApproval({ status: 200, body: { expired: true, reason: "window closed" } });
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1 });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new CoreAdapter({ approvalPoller: poller }),
      contextStore,
      logger: silentLogger
    });

    const promise = contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    await expect(promise).rejects.toBeInstanceOf(ApprovalExpiredError);
    await expect(promise).rejects.toThrow("window closed");
  });

  it("Core-unreachable: bounded consecutive poll failures raise ApprovalTimeoutError, never an infinite poll", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: { verdict: "require_approval", approval_id: "appr-4" } })
      .failAllApprovals("core unreachable");
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1, maxConsecutiveFailures: 3 });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new CoreAdapter({ approvalPoller: poller }),
      contextStore,
      logger: silentLogger
    });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }))
    ).rejects.toBeInstanceOf(ApprovalTimeoutError);
    expect(fakeCore.approvalRequests).toHaveLength(3);
  });
});

describe("Approval matrix — data-driven via APPROVAL_SCENARIOS through the full Runtime", () => {
  it.each(APPROVAL_SCENARIOS)("scenario '$name' -> $expected", async (scenario) => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ status: 200, body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map((body) => ({ status: 200, body })));
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_approval" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1 });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new CoreAdapter({ approvalPoller: poller }),
      contextStore,
      logger: silentLogger
    });

    const promise = contextStore.activityScope(BOUND_CTX, () => runtime.preflight({ spans: [STARTED_SPAN] }));
    if (scenario.expected === "approved") {
      await expect(promise).resolves.toMatchObject({ verdict: Verdict.REQUIRE_APPROVAL });
    } else if (scenario.expected === "rejected") {
      await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    } else {
      await expect(promise).rejects.toBeInstanceOf(ApprovalExpiredError);
    }
  });
});
