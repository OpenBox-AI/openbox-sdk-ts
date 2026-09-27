/**
 * IAM v3 per-client token lifecycle: single-flight acquisition, isolation
 * between clients, cache timing (30 s margin, 300 s cap, no stale fallback),
 * authority refresh on renewal and after rejection, explicit refresh, and the
 * races that must never restore obsolete or closed state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVALUATE_PATH_V3, OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import { OpenBoxWorkloadAuthError } from "../src/errors/workload.js";
import {
  ACTIVATION_VERSION,
  NEXT_ACTIVATION_VERSION,
  OTHER_API_KEY,
  OTHER_WORKLOAD_PEM,
  WorkloadFakeEndpoints,
  controlledClock,
  deferred,
  jsonResponse,
  recordingLogger,
  tokenBody,
  workloadBootstrapBody,
  workloadClient
} from "./support/workload-identity-fakes.js";

const PAYLOAD = { event_type: "WorkflowStarted", workflow_id: "wf-1", run_id: "run-1" };

function tokensUsed(endpoints: WorkloadFakeEndpoints): string[] {
  return endpoints.runtimeCalls.map((call) => call.headers["x-openbox-workload-token"]!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("single-flight acquisition", () => {
  it("shares one bootstrap and one token exchange across 20 concurrent first operations", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);

    await Promise.all(Array.from({ length: 20 }, () => client.evaluate(PAYLOAD)));

    expect(endpoints.bootstrapCalls).toHaveLength(1);
    expect(endpoints.tokenCalls).toHaveLength(1);
    expect(new Set(tokensUsed(endpoints))).toEqual(new Set(["access-token-1"]));
  });

  it("shares one acquisition per renewal cycle, too", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);

    clock.advance(270_000); // refresh-due (300 s cache − 30 s margin)
    await Promise.all(Array.from({ length: 20 }, () => client.evaluate(PAYLOAD)));

    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(endpoints.tokenCalls).toHaveLength(2);
    expect(tokensUsed(endpoints).slice(1)).toEqual(Array(20).fill("access-token-2"));
  });

  it("rejects every waiter when the shared acquisition fails, then lets a later call retry", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.bootstrap = () => jsonResponse(503, {});
    const client = workloadClient(endpoints);

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => client.evaluate(PAYLOAD)));
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof OpenBoxWorkloadAuthError)).toBe(true);
    expect(endpoints.bootstrapCalls).toHaveLength(1);

    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody());
    await expect(client.evaluate(PAYLOAD)).resolves.toBeDefined();
    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(endpoints.legacyCalls).toHaveLength(0);
  });
});

describe("agent isolation", () => {
  it("never shares token, metadata, in-flight acquisition, errors, or source between clients", async () => {
    const endpointsA = new WorkloadFakeEndpoints();
    const endpointsB = new WorkloadFakeEndpoints();
    endpointsB.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ identity_source: "entra", client_id: "client-b" }));
    endpointsB.token = () => jsonResponse(200, tokenBody({ access_token: "token-for-b" }));
    const gate = deferred<Response>();
    endpointsA.bootstrap = () => gate.promise;
    const clientA = workloadClient(endpointsA);
    const clientB = workloadClient(endpointsB, { workloadPrivateKey: OTHER_WORKLOAD_PEM }, OTHER_API_KEY);

    // A's acquisition is stuck; B proceeds independently.
    const pendingA = clientA.evaluate(PAYLOAD);
    await clientB.evaluate(PAYLOAD);
    expect(clientB.workloadIdentityMetadata()?.identitySource).toBe("entra");
    expect(clientA.workloadIdentityMetadata()).toBeNull();

    // A fails; B is unaffected.
    gate.resolve(jsonResponse(503, {}));
    await expect(pendingA).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    await clientB.evaluate(PAYLOAD);

    expect(tokensUsed(endpointsB)).toEqual(["token-for-b", "token-for-b"]);
    expect(endpointsB.runtimeCalls.every((c) => c.headers["authorization"] === `Bearer ${OTHER_API_KEY}`)).toBe(true);
    expect(endpointsA.runtimeCalls).toHaveLength(0);
    expect(new URLSearchParams(endpointsB.tokenCalls[0]!.body).get("client_id")).toBe("client-b");
  });
});

describe("cache timing", () => {
  it("renews exactly at the 30 s margin before a 300 s cache", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);

    clock.advance(269_999);
    await client.evaluate(PAYLOAD);
    expect(endpoints.tokenCalls).toHaveLength(1);

    clock.advance(1);
    await client.evaluate(PAYLOAD);
    expect(endpoints.tokenCalls).toHaveLength(2);
    expect(tokensUsed(endpoints)).toEqual(["access-token-1", "access-token-1", "access-token-2"]);
  });

  it("caps an overlong expires_in at 300 s and honours a short one", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    let expiresIn = 3600;
    endpoints.token = () => jsonResponse(200, tokenBody({ access_token: `t-${expiresIn}`, expires_in: expiresIn }));
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    clock.advance(270_000);
    expiresIn = 60;
    await client.evaluate(PAYLOAD); // renewed at the capped 300 − 30 s
    clock.advance(30_000);
    await client.evaluate(PAYLOAD); // 60 − 30 s later
    expect(tokensUsed(endpoints)).toEqual(["t-3600", "t-60", "t-60"]);
    expect(endpoints.tokenCalls).toHaveLength(3);
  });

  it("measures the lifetime from the start of the exchange", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.token = () => {
      clock.advance(10_000); // a slow token endpoint
      return jsonResponse(200, tokenBody({ access_token: "slow" }));
    };
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    clock.advance(260_000); // 270 s after the exchange began
    endpoints.token = () => jsonResponse(200, tokenBody({ access_token: "renewed" }));
    await client.evaluate(PAYLOAD);
    expect(tokensUsed(endpoints)).toEqual(["slow", "renewed"]);
  });

  it("fails an acquisition whose token has no usable window left", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.token = () => {
      clock.advance(2_000);
      return jsonResponse(200, tokenBody({ expires_in: 31 }));
    };
    await expect(workloadClient(endpoints).evaluate(PAYLOAD)).rejects.toMatchObject({ stage: "token" });
    expect(endpoints.runtimeCalls).toHaveLength(0);
  });

  it("never falls back to a refresh-due token when renewal fails", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints, { onApiError: "fail_open" });
    await client.evaluate(PAYLOAD);
    clock.advance(270_000);
    endpoints.token = () => jsonResponse(500, {});

    await expect(client.evaluate(PAYLOAD)).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    await expect(client.evaluate(PAYLOAD)).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(tokensUsed(endpoints)).toEqual(["access-token-1"]);
    expect(client.workloadIdentityMetadata()).toBeNull();
  });
});

describe("authority refresh", () => {
  it("re-fetches bootstrap on every renewal and picks up a same-key activation change", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    expect(client.workloadIdentityMetadata()?.activationVersion).toBe(ACTIVATION_VERSION);

    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ activation_version: NEXT_ACTIVATION_VERSION }));
    clock.advance(270_000);
    await client.evaluate(PAYLOAD);

    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(client.workloadIdentityMetadata()?.activationVersion).toBe(NEXT_ACTIVATION_VERSION);
  });

  it("invalidates on a runtime 401, does not replay, and bootstraps again on the next operation", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);

    // Core rejects the old token after an activation change.
    endpoints.evaluate = () => jsonResponse(401, { code: 401, message: "invalid token or agent identity" });
    await expect(client.evaluate(PAYLOAD)).rejects.toMatchObject({ stage: "runtime", httpStatus: 401 });
    expect(client.workloadIdentityMetadata()).toBeNull();
    expect(endpoints.callsTo(EVALUATE_PATH_V3)).toHaveLength(2); // rejected op not replayed

    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ activation_version: NEXT_ACTIVATION_VERSION }));
    endpoints.evaluate = () => jsonResponse(200, { verdict: "allow" });
    await client.evaluate(PAYLOAD);
    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(tokensUsed(endpoints)).toEqual(["access-token-1", "access-token-1", "access-token-2"]);
    expect(client.workloadIdentityMetadata()?.activationVersion).toBe(NEXT_ACTIVATION_VERSION);
  });

  it("stays blocked while Keycloak rejects this process's key", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.token = () => jsonResponse(401, { error: "invalid_client" });
    const client = workloadClient(endpoints);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.evaluate(PAYLOAD)).rejects.toMatchObject({ stage: "token", reasonCode: "invalid_client" });
    }
    expect(endpoints.runtimeCalls).toHaveLength(0);
    expect(endpoints.bootstrapCalls).toHaveLength(3);
  });
});

describe("metadata and explicit refresh", () => {
  it("exposes an immutable snapshot only while a usable token backs it", async () => {
    const clock = controlledClock();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    expect(client.workloadIdentityMetadata()).toBeNull();
    await client.validateApiKey();
    const metadata = client.workloadIdentityMetadata();
    expect(metadata).toMatchObject({ activationVersion: ACTIVATION_VERSION, identitySource: "openbox" });
    expect(Object.isFrozen(metadata)).toBe(true);
    clock.advance(270_000);
    expect(client.workloadIdentityMetadata()).toBeNull();
  });

  it("refreshWorkloadIdentity invalidates immediately and re-acquires", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ activation_version: NEXT_ACTIVATION_VERSION }));

    const refreshed = await client.refreshWorkloadIdentity();
    expect(refreshed.activationVersion).toBe(NEXT_ACTIVATION_VERSION);
    await client.evaluate(PAYLOAD);
    expect(tokensUsed(endpoints)).toEqual(["access-token-1", "access-token-2"]);
  });

  it("leaves nothing usable when an explicit refresh fails", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    endpoints.token = () => jsonResponse(401, { error: "invalid_client" });

    await expect(client.refreshWorkloadIdentity()).rejects.toMatchObject({ stage: "token" });
    expect(client.workloadIdentityMetadata()).toBeNull();
    await expect(client.evaluate(PAYLOAD)).rejects.toMatchObject({ stage: "token" });
    expect(tokensUsed(endpoints)).toEqual(["access-token-1"]);
  });

  it("rejects refreshWorkloadIdentity on a non-workload client", async () => {
    const client = new OpenBoxClient("https://core.example.com", "obx_test_x", { fetchImpl: vi.fn() as never });
    await expect(client.refreshWorkloadIdentity()).rejects.toBeInstanceOf(OpenBoxConfigError);
    expect(client.workloadIdentityMetadata()).toBeNull();
  });
});

describe("races never restore obsolete or closed state", () => {
  it("an explicit refresh aborts an in-flight first acquisition; its waiters move on at once", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const hung = deferred<Response>(); // the first bootstrap never answers on its own
    let bootstraps = 0;
    endpoints.bootstrap = () => {
      bootstraps += 1;
      return bootstraps === 1
        ? hung.promise
        : jsonResponse(200, workloadBootstrapBody({ activation_version: NEXT_ACTIVATION_VERSION }));
    };
    const logger = recordingLogger();
    const client = workloadClient(endpoints, { logger });

    const early = client.evaluate(PAYLOAD);
    await vi.waitFor(() => expect(endpoints.bootstrapCalls).toHaveLength(1));
    await expect(client.refreshWorkloadIdentity()).resolves.toMatchObject({
      activationVersion: NEXT_ACTIVATION_VERSION
    });
    // The early waiter completes WITHOUT the superseded bootstrap ever answering.
    await early;

    expect(endpoints.signals[0]?.aborted).toBe(true);
    expect(endpoints.tokenCalls).toHaveLength(1); // no wasted exchange for the superseded flight
    expect(tokensUsed(endpoints)).toEqual(["access-token-1"]);
    expect(client.workloadIdentityMetadata()?.activationVersion).toBe(NEXT_ACTIVATION_VERSION);
    // Only the published acquisition is logged.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.all()).toContain(`activation ${NEXT_ACTIVATION_VERSION}`);
  });

  it("logs an authority change only when a new state is published", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const logger = recordingLogger();
    const client = workloadClient(endpoints, { logger });
    await client.evaluate(PAYLOAD);
    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ activation_version: NEXT_ACTIVATION_VERSION }));
    await client.refreshWorkloadIdentity();
    expect(logger.info.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/workload authentication ready/),
      expect.stringMatching(/workload authority changed \(activationVersion\)/)
    ]);
  });

  it("a late 401 for an old token never evicts a newer one", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.validateApiKey();

    const slowRejection = deferred<Response>();
    endpoints.evaluate = () => slowRejection.promise;
    const stale = client.evaluate(PAYLOAD); // carries access-token-1
    await vi.waitFor(() => expect(endpoints.callsTo(EVALUATE_PATH_V3)).toHaveLength(1));

    await client.refreshWorkloadIdentity(); // publishes access-token-2
    slowRejection.resolve(jsonResponse(401, {}));
    await expect(stale).rejects.toMatchObject({ stage: "runtime" });

    endpoints.evaluate = () => jsonResponse(200, { verdict: "allow" });
    await client.evaluate(PAYLOAD);
    expect(endpoints.bootstrapCalls).toHaveLength(2); // no third acquisition
    expect(tokensUsed(endpoints).slice(-1)).toEqual(["access-token-2"]);
  });

  it("concurrent refreshes converge on one published state", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    const [a, b] = await Promise.all([client.refreshWorkloadIdentity(), client.refreshWorkloadIdentity()]);
    expect(a).toEqual(b);
    await client.evaluate(PAYLOAD);
    const used = tokensUsed(endpoints)[0];
    expect(used === "access-token-1" || used === "access-token-2").toBe(true);
    expect(client.workloadIdentityMetadata()).toEqual(a);
  });

  it("close() during acquisition rejects waiters and publishes nothing", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const gate = deferred<Response>();
    endpoints.bootstrap = () => gate.promise;
    const client = workloadClient(endpoints);

    const pending = Promise.allSettled([client.evaluate(PAYLOAD), client.pollApproval("wf", "run", "act")]);
    await vi.waitFor(() => expect(endpoints.bootstrapCalls).toHaveLength(1));
    client.close();
    gate.resolve(jsonResponse(200, workloadBootstrapBody()));
    const results = await pending;

    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/has been closed/);
    }
    expect(client.workloadIdentityMetadata()).toBeNull();
    expect(endpoints.tokenCalls).toHaveLength(0);
    expect(endpoints.runtimeCalls).toHaveLength(0);
  });

  it("metadata and token always come from the same acquisition", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    let activation = ACTIVATION_VERSION;
    endpoints.bootstrap = () => jsonResponse(200, workloadBootstrapBody({ activation_version: activation }));
    // The fake Keycloak embeds the activation it saw in the assertion's audience context.
    let lastActivation = "";
    endpoints.token = () => jsonResponse(200, tokenBody({ access_token: `token-for-${lastActivation}` }));
    const originalBootstrap = endpoints.bootstrap;
    endpoints.bootstrap = (call) => {
      lastActivation = activation;
      return originalBootstrap(call);
    };
    const client = workloadClient(endpoints);
    await client.evaluate(PAYLOAD);
    activation = NEXT_ACTIVATION_VERSION;
    await client.refreshWorkloadIdentity();
    await client.evaluate(PAYLOAD);

    expect(client.workloadIdentityMetadata()?.activationVersion).toBe(NEXT_ACTIVATION_VERSION);
    expect(tokensUsed(endpoints).slice(-1)).toEqual([`token-for-${NEXT_ACTIVATION_VERSION}`]);
  });

  it("an aborted approval wait stops without cancelling the shared acquisition", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const gate = deferred<Response>();
    endpoints.bootstrap = () => gate.promise;
    const client = workloadClient(endpoints);
    const controller = new AbortController();

    const poll = client.pollApproval("wf", "run", "act", controller.signal);
    const evaluation = client.evaluate(PAYLOAD);
    controller.abort(new Error("shutdown"));
    await expect(poll).rejects.toThrow(/shutdown/);

    gate.resolve(jsonResponse(200, workloadBootstrapBody()));
    await expect(evaluation).resolves.toBeDefined();
    expect(endpoints.bootstrapCalls).toHaveLength(1);
    expect(endpoints.callsTo("/api/v3/governance/approval")).toHaveLength(0);
  });
});
