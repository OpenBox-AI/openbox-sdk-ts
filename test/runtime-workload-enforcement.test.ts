/**
 * IAM v3 through the runtime: the shared `fromConfig` path, fail-closed
 * propagation of workload-authentication failures through lifecycle
 * enforcement and hook preflight (under the default `fail_open` policy),
 * runtime shutdown owning its client, and token acquisition/renewal with the
 * fetch governance patch installed — no recursive governance, no deadlock,
 * no credential-bearing telemetry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVALUATE_PATH_V3, OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { workflowStarted } from "../src/contracts/event-factories.js";
import { GovernanceHaltError } from "../src/errors/index.js";
import { OpenBoxWorkloadAuthError } from "../src/errors/workload.js";
import { installFetchHttpGovernancePatch } from "../src/instrumentation/fetch-http-governance-patch.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";
import { buildStartedHttpSpan } from "../src/spans/http-span-builder.js";
import {
  API_KEY,
  CORE_URL,
  TOKEN_ENDPOINT,
  WORKLOAD_PEM,
  WorkloadFakeEndpoints,
  controlledClock,
  jsonResponse,
  recordingLogger
} from "./support/workload-identity-fakes.js";

const WF = { workflowId: "wf-1", runId: "run-1", workflowType: "orders" };
const BOUND = new ActivityContext({ workflowId: "wf-1", runId: "run-1", activityId: "act-1", activityType: "charge" });
const EXTERNAL_URL = "https://external.example/api/charge";

function workloadConfig(): OpenBoxConfig {
  return OpenBoxConfig.resolve({ environ: {}, apiUrl: CORE_URL, apiKey: API_KEY, workloadPrivateKey: WORKLOAD_PEM });
}

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("OpenBoxRuntime with a keycloak_workload config", () => {
  it("builds its client through fromConfig and speaks v3 only", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    globalThis.fetch = endpoints.fetchImpl; // the runtime's default transport
    const runtime = new OpenBoxRuntime(workloadConfig(), { logger: recordingLogger() });

    await runtime.evaluateLifecycle(workflowStarted(WF));

    expect(endpoints.callsTo(EVALUATE_PATH_V3)).toHaveLength(1);
    expect(endpoints.legacyCalls).toHaveLength(0);
    runtime.close();
  });

  it("stops lifecycle enforcement on acquisition failure even under fail_open", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.bootstrap = () => jsonResponse(503, {});
    const config = workloadConfig();
    expect(config.onApiError).toBe("fail_open");
    const runtime = new OpenBoxRuntime(config, {
      client: OpenBoxClient.fromConfig(config, { fetchImpl: endpoints.fetchImpl, logger: recordingLogger() })
    });
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(endpoints.runtimeCalls).toHaveLength(0);
  });

  it("stops lifecycle enforcement on a runtime 401 even under fail_open", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.evaluate = () => jsonResponse(401, {});
    const config = workloadConfig();
    const runtime = new OpenBoxRuntime(config, {
      client: OpenBoxClient.fromConfig(config, { fetchImpl: endpoints.fetchImpl, logger: recordingLogger() })
    });
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toMatchObject({ stage: "runtime" });
  });

  it("turns a hook-preflight acquisition failure into a fail-closed HALT via the adapter", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.token = () => Promise.reject(new TypeError("fetch failed")); // a NETWORK cause
    const config = workloadConfig();
    const adapter = new FakeAdapter();
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      adapter,
      contextStore,
      client: OpenBoxClient.fromConfig(config, { fetchImpl: endpoints.fetchImpl, logger: recordingLogger() })
    });

    const error: unknown = await contextStore
      .activityScope(BOUND, () =>
        runtime.preflight({
          spans: [
            buildStartedHttpSpan({
              spanId: "00f067aa0ba902b7",
              traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
              method: "GET",
              url: EXTERNAL_URL,
              startTimeNs: 1_700_000_000_000_000_000
            })
          ]
        })
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GovernanceHaltError);
    // Failed closed because of the acquisition, not a span contract error.
    expect((error as Error).message).toMatch(/Keycloak's token endpoint could not be reached/);
    expect(endpoints.tokenCalls).toHaveLength(1);
    expect(adapter.calls.map((c) => c.kind)).toEqual(["raiseHookBlocked"]);
    expect(contextStore.isActivityAborted("wf-1", "run-1", "act-1")).toBe(true);
  });

  it("close() closes the client too — including an injected one", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const config = workloadConfig();
    const client = OpenBoxClient.fromConfig(config, { fetchImpl: endpoints.fetchImpl, logger: recordingLogger() });
    const runtime = new OpenBoxRuntime(config, { client });
    await runtime.evaluateLifecycle(workflowStarted(WF));

    runtime.close();
    runtime.close();
    await expect(client.evaluate({ event_type: "WorkflowStarted" })).rejects.toThrow(/has been closed/);
    expect(client.workloadIdentityMetadata()).toBeNull();
  });
});

describe("token acquisition with the fetch governance patch installed", () => {
  it("acquires and renews without recursive governance, deadlock, or credential-bearing spans", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const external: string[] = [];
    // The "network" under the patch: Core + Keycloak via the fake, plus one external service.
    globalThis.fetch = ((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://external.example")) {
        external.push(url);
        return Promise.resolve(new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
      }
      return endpoints.fetchImpl(input, init);
    });

    const config = workloadConfig();
    const contextStore = new ContextStore();
    // Late-bound: the client's own traffic goes THROUGH the patched global fetch,
    // so only the internal-call guard can keep it from governing itself.
    const client = OpenBoxClient.fromConfig(config, {
      fetchImpl: (input, init) => globalThis.fetch(input, init),
      logger: recordingLogger()
    });
    const runtime = new OpenBoxRuntime(config, { client, contextStore, adapter: new FakeAdapter(), logger: recordingLogger() });
    const handle = installFetchHttpGovernancePatch({ runtime, logger: recordingLogger() });
    try {
      await contextStore.activityScope(BOUND, () => fetch(EXTERNAL_URL));
      clock.advance(270_000); // force a renewal under instrumentation
      await contextStore.activityScope(BOUND, () => fetch(EXTERNAL_URL));
    } finally {
      handle.restore();
    }

    expect(external).toEqual([EXTERNAL_URL, EXTERNAL_URL]);
    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(endpoints.tokenCalls).toHaveLength(2);

    // Only the two external requests were governed (started + completed each).
    const evaluations = endpoints.callsTo(EVALUATE_PATH_V3);
    expect(evaluations).toHaveLength(4);
    const governedUrls = evaluations.flatMap((call) => {
      const spans = (JSON.parse(call.body) as { spans?: Array<{ http_url?: string }> }).spans ?? [];
      return spans.map((span) => span.http_url);
    });
    expect(new Set(governedUrls)).toEqual(new Set([EXTERNAL_URL]));
    for (const call of evaluations) {
      expect(call.body).not.toContain(TOKEN_ENDPOINT);
      expect(call.body).not.toContain("/api/v3/auth/bootstrap");
      expect(call.body).not.toContain("access-token-");
      expect(call.body).not.toContain(API_KEY);
    }
  });
});
