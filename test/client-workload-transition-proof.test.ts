/**
 * IAM v3 workload candidate proof: exact transition only, an explicit
 * candidate key (never the active one), strict candidate metadata, an
 * explicitly checked success, and no token exchange, activation, cache
 * mutation, or automatic resend.
 */
import { verify as cryptoVerify } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenBoxClient,
  WORKLOAD_TRANSITION_BOOTSTRAP_PATH_V3,
  WORKLOAD_TRANSITION_PROOF_PATH_V3
} from "../src/client/index.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import { OpenBoxWorkloadAuthError } from "../src/errors/workload.js";
import {
  API_KEY,
  CANDIDATE_PEM,
  CORE_URL,
  TRANSITION_ID,
  UNDERSIZED_PEM,
  WORKLOAD_PEM,
  WorkloadFakeEndpoints,
  decodeJwt,
  jsonResponse,
  publicKeyOf,
  workloadClient
} from "./support/workload-identity-fakes.js";

const CANDIDATE_ISSUER = "https://identity.example.com/realms/openbox";
const CANDIDATE_TOKEN_ENDPOINT = `${CANDIDATE_ISSUER}/protocol/openid-connect/token`;

function candidateBootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootstrap_version: 3,
    contract_version: 3,
    transition_id: TRANSITION_ID,
    token_endpoint: CANDIDATE_TOKEN_ENDPOINT,
    client_id: "candidate-client",
    kid: "candidate-kid",
    identity_source: "okta",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides
  };
}

function withTransition(endpoints: WorkloadFakeEndpoints): WorkloadFakeEndpoints {
  endpoints.transitionBootstrap = () => jsonResponse(200, candidateBootstrap());
  endpoints.transitionProof = () => jsonResponse(200, { proof_verified: true });
  return endpoints;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proveWorkloadIdentityTransition — success", () => {
  it("proves exactly the requested candidate with its own key, API-key authenticated", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    const client = workloadClient(endpoints);

    await expect(
      client.proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey: CANDIDATE_PEM })
    ).resolves.toEqual({ proofVerified: true });

    const [bootstrap, proof] = endpoints.calls;
    expect(bootstrap!.url).toBe(`${CORE_URL}${WORKLOAD_TRANSITION_BOOTSTRAP_PATH_V3}?transition_id=${TRANSITION_ID}`);
    expect(bootstrap!.redirect).toBe("manual");
    expect(proof!.url).toBe(`${CORE_URL}${WORKLOAD_TRANSITION_PROOF_PATH_V3}`);
    expect(proof!.method).toBe("POST");
    expect(proof!.redirect).toBe("manual");
    for (const call of [bootstrap!, proof!]) {
      expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
      expect(call.headers["x-openbox-workload-token"]).toBeUndefined();
      expect(call.headers["x-openbox-agent-assertion"]).toBeUndefined();
    }

    const body = JSON.parse(proof!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["client_assertion", "transition_id"]);
    expect(body["transition_id"]).toBe(TRANSITION_ID);
    const { header, claims, signingInput, signature } = decodeJwt(body["client_assertion"] as string);
    expect(header).toEqual({ alg: "RS256", kid: "candidate-kid", typ: "JWT" });
    expect(claims).toMatchObject({ aud: CANDIDATE_TOKEN_ENDPOINT, iss: "candidate-client", sub: "candidate-client" });
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBe(60);
    // Signed by the CANDIDATE key — never the active workload key.
    const input = Buffer.from(signingInput);
    expect(cryptoVerify("RSA-SHA256", input, publicKeyOf(CANDIDATE_PEM), signature)).toBe(true);
    expect(cryptoVerify("RSA-SHA256", input, publicKeyOf(WORKLOAD_PEM), signature)).toBe(false);
  });

  it("never calls Keycloak and never touches the active authentication state", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    const client = workloadClient(endpoints);
    await client.validateApiKey();
    const before = client.workloadIdentityMetadata();

    await client.proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey: CANDIDATE_PEM });
    await client.validateApiKey();

    expect(endpoints.tokenCalls).toHaveLength(1); // the active acquisition only
    expect(endpoints.bootstrapCalls).toHaveLength(1);
    expect(client.workloadIdentityMetadata()).toBe(before);
    const validates = endpoints.callsTo("/api/v3/auth/validate");
    expect(validates.map((c) => c.headers["x-openbox-workload-token"])).toEqual(["access-token-1", "access-token-1"]);
  });

  it("works from a legacy client — it needs only the agent API key", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    const client = new OpenBoxClient(CORE_URL, API_KEY, { fetchImpl: endpoints.fetchImpl });
    await expect(
      client.proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey: CANDIDATE_PEM })
    ).resolves.toEqual({ proofVerified: true });
    expect(endpoints.legacyCalls).toHaveLength(0);
  });
});

describe("proveWorkloadIdentityTransition — fails closed", () => {
  it("requires an explicit candidate key, with zero requests", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    const client = workloadClient(endpoints);
    for (const candidatePrivateKey of ["", undefined as unknown as string]) {
      await expect(
        client.proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey })
      ).rejects.toThrow(/explicit candidatePrivateKey/);
    }
    expect(endpoints.calls).toHaveLength(0);
  });

  it("rejects an unusable candidate key locally, naming candidatePrivateKey", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    await expect(
      workloadClient(endpoints).proveWorkloadIdentityTransition({
        transitionId: TRANSITION_ID,
        candidatePrivateKey: UNDERSIZED_PEM
      })
    ).rejects.toThrow(/Invalid candidatePrivateKey/);
    expect(endpoints.calls).toHaveLength(0);
  });

  it.each(["not-a-uuid", "00000000-0000-0000-0000-000000000000", ""])(
    "rejects transition id %j locally",
    async (transitionId) => {
      const endpoints = withTransition(new WorkloadFakeEndpoints());
      await expect(
        workloadClient(endpoints).proveWorkloadIdentityTransition({ transitionId, candidatePrivateKey: CANDIDATE_PEM })
      ).rejects.toBeInstanceOf(OpenBoxConfigError);
      expect(endpoints.calls).toHaveLength(0);
    }
  );

  it.each([
    ["a mismatched transition", { transition_id: "55555555-5555-4555-8555-555555555555" }],
    ["an expired candidate", { expires_at: new Date(Date.now() - 1_000).toISOString() }],
    ["a naive expiry", { expires_at: "2099-01-01T00:00:00" }],
    ["wrong versions", { bootstrap_version: 2 }],
    ["an unsafe token endpoint", { token_endpoint: "http://identity.example.com/realms/openbox/protocol/openid-connect/token" }]
  ])("sends no proof for %s", async (_label, overrides) => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionBootstrap = () => jsonResponse(200, candidateBootstrap(overrides));
    await expect(
      workloadClient(endpoints).proveWorkloadIdentityTransition({
        transitionId: TRANSITION_ID,
        candidatePrivateKey: CANDIDATE_PEM
      })
    ).rejects.toMatchObject({ stage: "transition_bootstrap" });
    expect(endpoints.callsTo(WORKLOAD_TRANSITION_PROOF_PATH_V3)).toHaveLength(0);
  });

  it.each([
    [409, /unavailable, expired, or no longer awaiting proof/],
    [401, /API key is absent, invalid, or revoked/],
    [404, /does not serve the workload transition bootstrap route/]
  ])("maps a candidate bootstrap %i", async (status, pattern) => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionBootstrap = () => jsonResponse(status, { reason_code: "transition_proof_invalid" });
    const error = (await workloadClient(endpoints)
      .proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey: CANDIDATE_PEM })
      .catch((e: unknown) => e)) as OpenBoxWorkloadAuthError;
    expect(error).toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(error.message).toMatch(pattern);
    expect(error.httpStatus).toBe(status);
  });

  it.each([
    ["a replayed proof", 401, { reason_code: "proof_replayed" }],
    ["an expired proof", 401, { reason_code: "proof_expired" }],
    ["a rejected candidate", 401, { reason_code: "transition_proof_invalid" }],
    ["a verifier outage", 503, { reason_code: "verifier_unavailable" }]
  ])("reports %s without resending", async (_label, status, body) => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionProof = () => jsonResponse(status, body);
    const error = (await workloadClient(endpoints)
      .proveWorkloadIdentityTransition({ transitionId: TRANSITION_ID, candidatePrivateKey: CANDIDATE_PEM })
      .catch((e: unknown) => e)) as OpenBoxWorkloadAuthError;
    expect(error).toMatchObject({ stage: "transition_proof", httpStatus: status, reasonCode: body.reason_code });
    expect(endpoints.callsTo(WORKLOAD_TRANSITION_PROOF_PATH_V3)).toHaveLength(1);
  });

  it.each([
    ["false", { proof_verified: false }],
    ["missing", {}],
    ["a truthy non-boolean", { proof_verified: "true" }]
  ])("accepts success only on an explicit proof_verified: true (%s)", async (_label, body) => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionProof = () => jsonResponse(200, body);
    await expect(
      workloadClient(endpoints).proveWorkloadIdentityTransition({
        transitionId: TRANSITION_ID,
        candidatePrivateKey: CANDIDATE_PEM
      })
    ).rejects.toThrow(/did not confirm the workload transition proof/);
  });

  it("reports an uncertain outcome when the proof POST fails in transit, and never reposts", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionProof = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      workloadClient(endpoints).proveWorkloadIdentityTransition({
        transitionId: TRANSITION_ID,
        candidatePrivateKey: CANDIDATE_PEM
      })
    ).rejects.toThrow(/Core may already have accepted it/);
    expect(endpoints.callsTo(WORKLOAD_TRANSITION_PROOF_PATH_V3)).toHaveLength(1);
  });

  it("refuses a redirect on the proof", async () => {
    const endpoints = withTransition(new WorkloadFakeEndpoints());
    endpoints.transitionProof = () => new Response(null, { status: 307, headers: { location: "https://evil.example/" } });
    await expect(
      workloadClient(endpoints).proveWorkloadIdentityTransition({
        transitionId: TRANSITION_ID,
        candidatePrivateKey: CANDIDATE_PEM
      })
    ).rejects.toMatchObject({ stage: "transition_proof", httpStatus: 307 });
  });
});
