/**
 * IAM v3 client wire behavior against a Core + Keycloak double:
 * - every runtime operation selects its exact v3 route and header set;
 * - the token exchange carries exactly the RFC 7523 form and nothing OpenBox;
 * - no failure, under any outage policy, produces a v1/v2 or API-key-only
 *   request, and a bad contract never becomes a fallback ALLOW;
 * - secrets never reach logs or error messages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_PATH_V3,
  AUTH_BOOTSTRAP_PATH_V3,
  AUTH_VALIDATE_PATH_V3,
  EVALUATE_PATH_V3,
  HANDOFF_PATH_V3,
  OpenBoxClient
} from "../src/client/index.js";
import type { OnApiError } from "../src/config/index.js";
import {
  GovernanceAPIError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError
} from "../src/errors/index.js";
import { OpenBoxWorkloadAuthError } from "../src/errors/workload.js";
import { serializeBody } from "../src/serialization/index.js";
import {
  API_KEY,
  CLIENT_ID,
  CORE_URL,
  TOKEN_ENDPOINT,
  WORKLOAD_KID,
  WORKLOAD_PEM,
  WorkloadFakeEndpoints,
  decodeJwt,
  jsonResponse,
  recordingLogger,
  tokenBody,
  workloadBootstrapBody,
  workloadClient
} from "./support/workload-identity-fakes.js";

const PAYLOAD = { event_type: "WorkflowStarted", workflow_id: "wf-1", run_id: "run-1" };
const LEGACY_PROOF_HEADERS = [
  "x-openbox-agent-did",
  "x-openbox-agent-timestamp",
  "x-openbox-agent-nonce",
  "x-openbox-agent-signature",
  "x-openbox-body-sha256",
  "x-openbox-agent-assertion"
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("v3 runtime routes and headers", () => {
  it("selects the exact v3 path and header set for all four operations", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);

    await client.validateApiKey();
    await client.evaluate(PAYLOAD);
    await client.pollApproval("wf-1", "run-1", "act-1");
    await client.sendHandoff("88888888-8888-4888-8888-888888888888", { multiAgentSessionId: "mas-1" });

    expect(endpoints.runtimeCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${AUTH_VALIDATE_PATH_V3}`,
      `POST ${EVALUATE_PATH_V3}`,
      `POST ${APPROVAL_PATH_V3}`,
      `POST ${HANDOFF_PATH_V3}`
    ]);
    for (const call of endpoints.runtimeCalls) {
      expect(call.url.startsWith(CORE_URL)).toBe(true);
      expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
      // Raw token — never "Bearer "-prefixed.
      expect(call.headers["x-openbox-workload-token"]).toBe("access-token-1");
      expect(call.headers["x-openbox-sdk-version"]).toMatch(/^openbox-base-typescript-v/);
      expect(call.headers["user-agent"]).toMatch(/^OpenBox-SDK\/openbox-base-typescript-v/);
      for (const header of LEGACY_PROOF_HEADERS) expect(call.headers[header]).toBeUndefined();
    }
    // Payloads are unchanged; the identity lives in headers only.
    expect(endpoints.callsTo(EVALUATE_PATH_V3)[0]!.body).toBe(serializeBody(PAYLOAD).toString("utf-8"));
    expect(JSON.parse(endpoints.callsTo(APPROVAL_PATH_V3)[0]!.body)).toEqual({
      workflow_id: "wf-1",
      run_id: "run-1",
      activity_id: "act-1"
    });
    expect(JSON.parse(endpoints.callsTo(HANDOFF_PATH_V3)[0]!.body)).toEqual({
      target_agent_id: "88888888-8888-4888-8888-888888888888",
      multi_agent_session_id: "mas-1"
    });
    // One acquisition served all four operations.
    expect(endpoints.bootstrapCalls).toHaveLength(1);
    expect(endpoints.tokenCalls).toHaveLength(1);
    expect(endpoints.legacyCalls).toHaveLength(0);
  });

  it("initializes workload authentication when a handoff is the very first operation", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);

    await expect(client.sendHandoff("88888888-8888-4888-8888-888888888888")).resolves.toMatchObject({
      handoffId: "h-1"
    });
    expect(endpoints.calls.map((call) => call.path)).toEqual([
      AUTH_BOOTSTRAP_PATH_V3,
      new URL(TOKEN_ENDPOINT).pathname,
      HANDOFF_PATH_V3
    ]);
  });

  it("keeps the unsigned-handoff guard for legacy_unsigned clients only", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const unsigned = new OpenBoxClient(CORE_URL, API_KEY, { fetchImpl: endpoints.fetchImpl });
    await expect(unsigned.sendHandoff("88888888-8888-4888-8888-888888888888")).rejects.toThrow(
      /unsigned \(legacy_unsigned\) mode/
    );
    expect(endpoints.calls).toHaveLength(0);
  });
});

describe("bootstrap and token-exchange isolation", () => {
  it("sends bootstrap with the API key and SDK headers only, refusing redirects", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    await workloadClient(endpoints).validateApiKey();

    const bootstrap = endpoints.bootstrapCalls[0]!;
    expect(bootstrap.url).toBe(`${CORE_URL}${AUTH_BOOTSTRAP_PATH_V3}`);
    expect(bootstrap.method).toBe("GET");
    expect(bootstrap.redirect).toBe("manual");
    expect(bootstrap.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(bootstrap.headers["accept"]).toBe("application/json");
    expect(bootstrap.headers["x-openbox-workload-token"]).toBeUndefined();
    for (const header of LEGACY_PROOF_HEADERS) expect(bootstrap.headers[header]).toBeUndefined();
  });

  it("posts exactly the four RFC 7523 form fields to Keycloak — and nothing OpenBox", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    await workloadClient(endpoints).validateApiKey();

    const token = endpoints.tokenCalls[0]!;
    expect(token.url).toBe(TOKEN_ENDPOINT);
    expect(token.method).toBe("POST");
    expect(token.redirect).toBe("manual");
    expect(token.headers).toEqual({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    });
    const form = new URLSearchParams(token.body);
    expect([...form.keys()]).toEqual(["grant_type", "client_id", "client_assertion_type", "client_assertion"]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(token.body).not.toContain(API_KEY);
    expect(token.body).not.toMatch(/scope|audience|client_secret/);

    const { header, claims } = decodeJwt(form.get("client_assertion")!);
    expect(header).toEqual({ alg: "RS256", kid: WORKLOAD_KID, typ: "JWT" });
    expect(claims["aud"]).toBe(TOKEN_ENDPOINT);
    expect(claims["iss"]).toBe(CLIENT_ID);
    expect(claims["sub"]).toBe(CLIENT_ID);
  });

  it.each([
    ["the bootstrap", "bootstrap" as const],
    ["the token exchange", "token" as const]
  ])("rejects a redirect on %s with zero later requests", async (_label, stage) => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints[stage] = () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    const client = workloadClient(endpoints);

    await expect(client.evaluate(PAYLOAD)).rejects.toMatchObject({ stage, httpStatus: 302 });
    expect(endpoints.runtimeCalls).toHaveLength(0);
    if (stage === "bootstrap") expect(endpoints.tokenCalls).toHaveLength(0);
    expect(endpoints.calls.some((call) => call.url.startsWith("https://evil.example"))).toBe(false);
  });

  it.each([
    ["an array body", []],
    ["a wrong version", workloadBootstrapBody({ contract_version: 2 })],
    ["an invalid UUID", workloadBootstrapBody({ activation_version: "nope" })],
    ["an unknown source", workloadBootstrapBody({ identity_source: "google" })],
    ["an unsafe issuer", workloadBootstrapBody({ issuer: "http://identity.example.com/realms/openbox" })],
    ["a missing field", workloadBootstrapBody({ client_id: undefined })]
  ])("rejects a bootstrap document with %s before any token or runtime request", async (_label, body) => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.bootstrap = () => jsonResponse(200, body);
    const client = workloadClient(endpoints);

    await expect(client.evaluate(PAYLOAD)).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(endpoints.tokenCalls).toHaveLength(0);
    expect(endpoints.runtimeCalls).toHaveLength(0);
  });
});

describe("no protocol downgrade, under every outage policy", () => {
  const policies: OnApiError[] = ["fail_open", "fail_closed", "fail_closed_destructive"];
  const failures: Array<[string, (endpoints: WorkloadFakeEndpoints) => void, RegExp]> = [
    ["bootstrap 404", (e) => (e.bootstrap = () => jsonResponse(404, { code: 404 })), /does not serve GET \/api\/v3\/auth\/bootstrap/],
    [
      "bootstrap 409 workload_identity_unavailable",
      (e) => (e.bootstrap = () => jsonResponse(409, { code: 409, reason_code: "workload_identity_unavailable" })),
      /no usable active workload authority/
    ],
    ["bootstrap 401", (e) => (e.bootstrap = () => jsonResponse(401, { reason_code: "invalid_api_key" })), /not an outage/],
    ["bootstrap 403", (e) => (e.bootstrap = () => jsonResponse(403, { reason_code: "agent_inactive" })), /not an outage/],
    ["bootstrap 503", (e) => (e.bootstrap = () => jsonResponse(503, {})), /Retry later/],
    ["bootstrap 429", (e) => (e.bootstrap = () => jsonResponse(429, {})), /Retry later/],
    ["bootstrap network error", (e) => (e.bootstrap = () => Promise.reject(new TypeError("fetch failed"))), /could not be reached/],
    ["bootstrap malformed JSON", (e) => (e.bootstrap = () => new Response("<html>", { status: 200 })), /not valid JSON/],
    ["token 400", (e) => (e.token = () => jsonResponse(400, { error: "invalid_client", error_description: "bad" })), /rejected the workload client assertion/],
    ["token 401", (e) => (e.token = () => jsonResponse(401, { error: "invalid_client" })), /rejected the workload client assertion/],
    ["token 500", (e) => (e.token = () => jsonResponse(500, {})), /token endpoint failed/],
    ["token network error", (e) => (e.token = () => Promise.reject(new TypeError("fetch failed"))), /could not be reached/],
    ["token malformed body", (e) => (e.token = () => jsonResponse(200, tokenBody({ expires_in: "300" }))), /expires_in/],
    ["runtime 401", (e) => (e.evaluate = () => jsonResponse(401, { code: 401, message: "invalid token" })), /rejected the workload-authenticated evaluate/],
    ["runtime 403", (e) => (e.evaluate = () => jsonResponse(403, {})), /rejected the workload-authenticated evaluate/]
  ];

  for (const policy of policies) {
    it.each(failures)(`%s → throws, zero v1/v2 requests (${policy})`, async (_label, arrange, pattern) => {
      const endpoints = new WorkloadFakeEndpoints();
      arrange(endpoints);
      const client = workloadClient(endpoints, { onApiError: policy });

      const error: unknown = await client.evaluate(PAYLOAD).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenBoxWorkloadAuthError);
      expect(error).toBeInstanceOf(OpenBoxAuthError);
      expect((error as Error).message).toMatch(pattern);
      expect(endpoints.legacyCalls).toHaveLength(0);
      // Nothing API-key-only either: every Core request besides bootstrap carries a token.
      for (const call of endpoints.runtimeCalls) expect(call.headers["x-openbox-workload-token"]).toBeDefined();
    });
  }

  it("classifies stages with safe status and reason codes", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.token = () => jsonResponse(401, { error: "invalid_client", error_description: "secret detail" });
    const error = (await workloadClient(endpoints).evaluate(PAYLOAD).catch((e: unknown) => e)) as OpenBoxWorkloadAuthError;
    expect(error.stage).toBe("token");
    expect(error.httpStatus).toBe(401);
    expect(error.reasonCode).toBe("invalid_client");
    expect(error.message).not.toContain("secret detail");
  });

  it("preserves onApiError for a Core outage after successful authentication preparation", async () => {
    for (const [policy, expectation] of [
      ["fail_open", "fallback"],
      ["fail_closed", "throw"]
    ] as const) {
      const endpoints = new WorkloadFakeEndpoints();
      endpoints.evaluate = () => jsonResponse(503, {});
      const client = workloadClient(endpoints, { onApiError: policy });
      if (expectation === "fallback") {
        const result = await client.evaluate(PAYLOAD);
        expect(result.fallbackUsed).toBe(true);
      } else {
        await expect(client.evaluate(PAYLOAD)).rejects.toBeInstanceOf(GovernanceAPIError);
      }
      expect(endpoints.legacyCalls).toHaveLength(0);
    }
  });

  it("keeps fail_closed_destructive semantics for a runtime network failure", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.evaluate = () => Promise.reject(new TypeError("fetch failed"));
    const client = workloadClient(endpoints, { onApiError: "fail_closed_destructive" });
    // Lifecycle event: no destructive spans → fails open with the fallback marker.
    await expect(client.evaluate(PAYLOAD)).resolves.toMatchObject({ fallbackUsed: true });
    // A destructive span → blocked.
    await expect(
      client.evaluate({ ...PAYLOAD, spans: [{ hook_type: "http_request", http_method: "POST" }] })
    ).rejects.toBeInstanceOf(GovernanceAPIError);
  });

  it.each([400, 404, 405, 409, 422])(
    "treats a v3 evaluate %i as a contract error that never becomes ALLOW",
    async (status) => {
      const endpoints = new WorkloadFakeEndpoints();
      endpoints.evaluate = () => jsonResponse(status, { code: status });
      const client = workloadClient(endpoints, { onApiError: "fail_open" });
      const error: unknown = await client.evaluate(PAYLOAD).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GovernanceAPIError);
      expect((error as Error).message).toMatch(/contract error, not an outage/);
    }
  );

  it("keeps retryable 408/429 on the outage path", async () => {
    for (const status of [408, 429]) {
      const endpoints = new WorkloadFakeEndpoints();
      endpoints.evaluate = () => jsonResponse(status, {});
      await expect(workloadClient(endpoints, { onApiError: "fail_open" }).evaluate(PAYLOAD)).resolves.toMatchObject({
        fallbackUsed: true
      });
    }
  });
});

describe("approval polling and validation on v3", () => {
  it("throws — never returns pending — when acquisition fails", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    endpoints.bootstrap = () => jsonResponse(503, {});
    await expect(workloadClient(endpoints).pollApproval("wf", "run", "act")).rejects.toBeInstanceOf(
      OpenBoxWorkloadAuthError
    );
  });

  it("throws on a runtime 401 and on a contract error, but stays pending on outages", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    endpoints.approval = () => jsonResponse(401, {});
    await expect(client.pollApproval("wf", "run", "act")).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
    endpoints.approval = () => jsonResponse(400, {});
    await expect(client.pollApproval("wf", "run", "act")).rejects.toBeInstanceOf(GovernanceAPIError);
    endpoints.approval = () => jsonResponse(503, {});
    await expect(client.pollApproval("wf", "run", "act")).resolves.toBeNull();
    endpoints.approval = () => Promise.reject(new TypeError("fetch failed"));
    await expect(client.pollApproval("wf", "run", "act")).resolves.toBeNull();
    expect(endpoints.legacyCalls).toHaveLength(0);
  });

  it("maps validate failures without inferring outages from contract errors", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    endpoints.validate = () => jsonResponse(404, {});
    await expect(client.validateApiKey()).rejects.toBeInstanceOf(GovernanceAPIError);
    endpoints.validate = () => jsonResponse(503, {});
    await expect(client.validateApiKey()).rejects.toBeInstanceOf(OpenBoxNetworkError);
    endpoints.validate = () => jsonResponse(401, {});
    await expect(client.validateApiKey()).rejects.toBeInstanceOf(OpenBoxWorkloadAuthError);
  });
});

describe("secrets stay out of logs, errors, and inspection", () => {
  it("never logs or echoes the API key, private key, assertion, or access token", async () => {
    const logger = recordingLogger();
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints, { logger });
    await client.validateApiKey();
    const assertion = new URLSearchParams(endpoints.tokenCalls[0]!.body).get("client_assertion")!;

    endpoints.evaluate = () => jsonResponse(401, {});
    const error = (await client.evaluate(PAYLOAD).catch((e: unknown) => e)) as Error;
    endpoints.bootstrap = () => jsonResponse(500, { message: "boom" });
    const second = (await client.evaluate(PAYLOAD).catch((e: unknown) => e)) as Error;

    const surfaces = [logger.all(), error.message, second.message, JSON.stringify(client)];
    for (const text of surfaces) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("access-token-1");
      expect(text).not.toContain(assertion);
    }
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/workload authentication ready \(contract v3/));
  });

  it("keeps key and token material out of util.inspect", async () => {
    const { inspect } = await import("node:util");
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.validateApiKey();
    const view = inspect(client, { depth: 10, showHidden: true });
    expect(view).not.toContain("access-token-1");
    expect(view).not.toContain(API_KEY);
    expect(view).not.toContain("PRIVATE KEY");
    expect(view).toContain("contractVersion: 3");
  });
});

describe("client construction", () => {
  it.each([
    ["a v1 identity", { identity: {} as never }],
    ["an Okta identity", { oktaIdentity: {} as never }],
    ["an Okta bootstrap key", { oktaBootstrapPrivateKey: WORKLOAD_PEM }]
  ])("rejects workloadPrivateKey combined with %s", (_label, extra) => {
    expect(
      () => new OpenBoxClient(CORE_URL, API_KEY, { workloadPrivateKey: WORKLOAD_PEM, ...extra })
    ).toThrow(OpenBoxConfigError);
  });

  it("rejects an API key with an embedded line break or NUL before it can reach an error message", () => {
    for (const apiKey of ["obx_test_a\nb", "obx_test_a\rb", "obx_test_a\u0000b"]) {
      for (const options of [{}, { workloadPrivateKey: WORKLOAD_PEM }]) {
        let error: unknown;
        try {
          new OpenBoxClient(CORE_URL, apiKey, options);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(OpenBoxConfigError);
        expect((error as Error).message).not.toContain("obx_test_a");
      }
    }
    // Surrounding whitespace is stripped by fetch and stays accepted.
    expect(() => new OpenBoxClient(CORE_URL, `${API_KEY}\n`)).not.toThrow();
  });

  it("refuses cleartext Core URLs for a workload client, even without config validation", () => {
    expect(
      () => new OpenBoxClient("http://core.example.com", API_KEY, { workloadPrivateKey: WORKLOAD_PEM })
    ).toThrow(OpenBoxInsecureURLError);
    expect(
      () => new OpenBoxClient("http://localhost.evil.example", API_KEY, { workloadPrivateKey: WORKLOAD_PEM })
    ).toThrow(OpenBoxInsecureURLError);
    for (const loopback of ["http://localhost:8086", "http://127.0.0.1:8086", "http://[::1]:8086/"]) {
      expect(() => new OpenBoxClient(loopback, API_KEY, { workloadPrivateKey: WORKLOAD_PEM })).not.toThrow();
    }
    // v1/v2 construction is unchanged (their URL rule stays in config normalization).
    expect(() => new OpenBoxClient("http://core.example.com", API_KEY)).not.toThrow();
  });

  it("fails closed on an empty workload key instead of becoming a v1 client", () => {
    expect(() => new OpenBoxClient(CORE_URL, API_KEY, { workloadPrivateKey: "" })).toThrow(/Invalid workloadPrivateKey/);
  });

  it("rejects every send after close() without touching the network", async () => {
    const endpoints = new WorkloadFakeEndpoints();
    const client = workloadClient(endpoints);
    await client.validateApiKey();
    client.close();
    client.close(); // idempotent
    const before = endpoints.calls.length;
    await expect(client.evaluate(PAYLOAD)).rejects.toThrow(/has been closed/);
    await expect(client.pollApproval("wf", "run", "act")).rejects.toThrow(/has been closed/);
    await expect(client.validateApiKey()).rejects.toThrow(/has been closed/);
    await expect(client.sendHandoff("88888888-8888-4888-8888-888888888888")).rejects.toThrow(/has been closed/);
    await expect(client.refreshWorkloadIdentity()).rejects.toThrow(/has been closed/);
    expect(client.workloadIdentityMetadata()).toBeNull();
    expect(endpoints.calls.length).toBe(before);
  });
});
