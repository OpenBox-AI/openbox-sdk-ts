import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AUTH_VALIDATE_PATH_V2, EVALUATE_PATH_V2, OpenBoxClient } from "../src/client/index.js";
import { AUTH_BOOTSTRAP_PATH_V2 } from "../src/config/bootstrap.js";
import { OpenBoxConfigError, OpenBoxNetworkError } from "../src/errors/index.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");

interface FixtureKeypair {
  private_jwk: JsonWebKey;
  undersized_key_for_negative_test: { private_jwk: JsonWebKey };
}
function fixtureKeypair(): FixtureKeypair {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as FixtureKeypair;
}
function pemOf(jwk: JsonWebKey): string {
  return createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();
}

const OKTA_PEM = pemOf(fixtureKeypair().private_jwk);
const UNDERSIZED_PEM = pemOf(fixtureKeypair().undersized_key_for_negative_test.private_jwk);

/** Same pinned vector as identity-jwk-thumbprint.test.ts, openbox-core, and the Python SDK. */
const FIXTURE_THUMBPRINT = "P8EMAIrSnD-kQcn47Cpq_LlDPywhP3mqfM1RhwySFdk";

const API_URL = "https://core.example.com";
const API_KEY = "obx_test_bootstrapkey";

const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const DEPLOYMENT_ID = "fixture-deployment";
const AUDIENCE = "urn:openbox:fixture-deployment:core";
const EXTERNAL_AGENT_ID = "fixture-okta-ai-agent-0001";
const CREDENTIAL_KID = "fixture-okta-credential-kid-0001";

/** Core's IAM-aware `authority` object — required by the parser even at bootstrap_version 1. */
const AUTHORITY = {
  assignment_id: "10000000-0000-4000-8000-000000000001",
  provider_generation_id: "20000000-0000-4000-8000-000000000002",
  generation_number: 3,
  activation_version: "30000000-0000-4000-8000-000000000003",
  identity_id: "40000000-0000-4000-8000-000000000004",
  credential_id: "50000000-0000-4000-8000-000000000005",
  projection_version: "projection-2026-09-25T00:00:00Z"
};

function bootstrapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootstrap_version: 1,
    identity_method: "okta_ai_agent",
    openbox_agent_id: AGENT_ID,
    organization_id: ORG_ID,
    deployment_id: DEPLOYMENT_ID,
    assertion_audience: AUDIENCE,
    authority: AUTHORITY,
    okta: {
      external_agent_id: EXTERNAL_AGENT_ID,
      credential_kid: CREDENTIAL_KID,
      algorithm: "RS256",
      public_jwk_thumbprint: FIXTURE_THUMBPRINT
    },
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

interface FakeCore {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: string | null }>;
  bootstrapCallCount: () => number;
}

/**
 * A fetch double that answers bootstrap from a FIFO queue and every other route
 * with a benign 200, recording each call so tests can assert on ordering,
 * headers, and call counts.
 */
function fakeCore(bootstrapResponses: Array<() => Response | never>): FakeCore {
  const calls: FakeCore["calls"] = [];
  const queue = [...bootstrapResponses];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url, headers, body: (init?.body as string | null) ?? null });

    if (url.endsWith(AUTH_BOOTSTRAP_PATH_V2)) {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra bootstrap call");
      return Promise.resolve(next());
    }
    if (url.endsWith(AUTH_VALIDATE_PATH_V2)) {
      return Promise.resolve(jsonResponse(200, { valid: true, agent_id: AGENT_ID }));
    }
    return Promise.resolve(jsonResponse(200, { verdict: "allow" }));
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    bootstrapCallCount: () => calls.filter((c) => c.url.endsWith(AUTH_BOOTSTRAP_PATH_V2)).length
  };
}

function bootstrapClient(core: FakeCore, privateKey = OKTA_PEM): OpenBoxClient {
  return new OpenBoxClient(API_URL, API_KEY, {
    oktaBootstrapPrivateKey: privateKey,
    fetchImpl: core.fetchImpl,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
}

describe("bootstrap success path", () => {
  it("fetches metadata and signs with the bootstrapped values", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const client = bootstrapClient(core);

    await client.validateApiKey();

    // Bootstrap happened first, then the governed request.
    expect(core.calls[0]!.url).toBe(`${API_URL}${AUTH_BOOTSTRAP_PATH_V2}`);
    expect(core.calls[1]!.url).toBe(`${API_URL}${AUTH_VALIDATE_PATH_V2}`);

    // The governed request carries an assertion built from bootstrapped values.
    const assertion = core.calls[1]!.headers["x-openbox-agent-assertion"];
    expect(assertion).toBeDefined();

    const [rawHeader, rawClaims] = assertion!.split(".");
    const header = JSON.parse(Buffer.from(rawHeader!, "base64url").toString()) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(rawClaims!, "base64url").toString()) as Record<string, unknown>;

    expect(header["kid"]).toBe(CREDENTIAL_KID);
    expect(header["alg"]).toBe("RS256");
    expect(claims["aud"]).toBe(AUDIENCE);
    expect(claims["obx_agent_id"]).toBe(AGENT_ID);
    expect(claims["obx_organization_id"]).toBe(ORG_ID);
    expect(claims["obx_deployment_id"]).toBe(DEPLOYMENT_ID);
    expect(claims["iss"]).toBe(EXTERNAL_AGENT_ID);
    expect(claims["sub"]).toBe(EXTERNAL_AGENT_ID);
    // Per-request claims are still computed locally, not bootstrapped.
    expect(claims["htm"]).toBe("GET");
    expect(claims["htu"]).toBe(AUTH_VALIDATE_PATH_V2);
    expect(claims["jti"]).toBeTruthy();
    expect(claims["body_sha256"]).toBeTruthy();
  });

  it("sends the bootstrap request with the API key and no assertion", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    await bootstrapClient(core).validateApiKey();

    const bootstrapCall = core.calls[0]!;
    expect(bootstrapCall.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    // Requiring an assertion here would be circular — this response is what
    // makes constructing one possible.
    expect(bootstrapCall.headers["x-openbox-agent-assertion"]).toBeUndefined();
    expect(bootstrapCall.headers["accept"]).toBe("application/json");
  });

  it("caches per client instance — one bootstrap for many requests", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const client = bootstrapClient(core);

    await client.validateApiKey();
    await client.evaluate({ event_type: "WorkflowStarted" });
    await client.validateApiKey();

    expect(core.bootstrapCallCount()).toBe(1);
  });

  it("performs exactly one fetch for concurrent first requests", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const client = bootstrapClient(core);

    // Without single-flight, each of these would start its own bootstrap.
    await Promise.all([
      client.validateApiKey(),
      client.validateApiKey(),
      client.evaluate({ event_type: "WorkflowStarted" })
    ]);

    expect(core.bootstrapCallCount()).toBe(1);
  });

  it("exposes the validated metadata", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const client = bootstrapClient(core);

    expect(client.identityMetadata()).toBeNull();
    await client.validateApiKey();

    const metadata = client.identityMetadata();
    expect(metadata?.openboxAgentId).toBe(AGENT_ID);
    expect(metadata?.okta.credentialKid).toBe(CREDENTIAL_KID);
    // Non-secret only — no key material is retained.
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE KEY");
  });

  it("routes to v2 paths, never v1", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    await bootstrapClient(core).evaluate({ event_type: "WorkflowStarted" });

    expect(core.calls.some((c) => c.url.endsWith(EVALUATE_PATH_V2))).toBe(true);
    expect(core.calls.some((c) => c.url.includes("/api/v1/"))).toBe(false);
  });
});

describe("local key validation, before any network call", () => {
  it("rejects a malformed key without contacting Core", async () => {
    const core = fakeCore([]);
    const client = bootstrapClient(core, "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----");

    await expect(client.validateApiKey()).rejects.toThrow(OpenBoxConfigError);
    expect(core.bootstrapCallCount()).toBe(0);
  });

  it("rejects a non-RSA key without contacting Core", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const core = fakeCore([]);

    await expect(bootstrapClient(core, pem).validateApiKey()).rejects.toThrow(/RSA/);
    expect(core.bootstrapCallCount()).toBe(0);
  });

  it("rejects an undersized RSA key without contacting Core", async () => {
    const core = fakeCore([]);
    await expect(bootstrapClient(core, UNDERSIZED_PEM).validateApiKey()).rejects.toThrow(/2048/);
    expect(core.bootstrapCallCount()).toBe(0);
  });

  it("never echoes key bytes in a key error", async () => {
    const core = fakeCore([]);
    try {
      await bootstrapClient(core, UNDERSIZED_PEM).validateApiKey();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("key bytes not shown");
      expect((e as Error).message).not.toContain("BEGIN PRIVATE KEY");
    }
  });
});

describe("thumbprint mismatch", () => {
  it("fails before sending any governed request", async () => {
    // A different key's thumbprint — i.e. the runtime holds the wrong key.
    const core = fakeCore([
      () =>
        jsonResponse(
          200,
          bootstrapBody({
            okta: {
              external_agent_id: EXTERNAL_AGENT_ID,
              credential_kid: CREDENTIAL_KID,
              algorithm: "RS256",
              public_jwk_thumbprint: "mvZ_gJ0t0lSgT1112pD9yjrvBBi0-20HzVE7nzfz41c"
            }
          })
        )
    ]);
    const client = bootstrapClient(core);

    await expect(client.validateApiKey()).rejects.toThrow(
      /does not match the selected Okta credential/
    );

    // The bootstrap call happened; the governed request did NOT.
    expect(core.bootstrapCallCount()).toBe(1);
    expect(core.calls.some((c) => c.url.endsWith(AUTH_VALIDATE_PATH_V2))).toBe(false);
  });

  it("gives actionable remediation", async () => {
    const core = fakeCore([
      () => jsonResponse(200, bootstrapBody({ okta: { ...(bootstrapBody()["okta"] as object), public_jwk_thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }))
    ]);

    try {
      await bootstrapClient(core).validateApiKey();
      expect.unreachable("should have thrown");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("Export the private key associated with the selected credential");
      expect(message).toContain("rotate the agent credential");
    }
  });
});

describe("failure handling — never falls back", () => {
  it("surfaces upgrade guidance on 404", async () => {
    const core = fakeCore([() => jsonResponse(404, { code: 404, message: "not found" })]);

    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(
      /does not support Okta identity bootstrap/
    );
  });

  it("never downgrades to v1 or an unsigned request on any failure", async () => {
    const failures: Array<[name: string, respond: () => Response | never]> = [
      ["404", () => jsonResponse(404, {})],
      ["401", () => jsonResponse(401, { reason_code: "invalid_api_key" })],
      ["409", () => jsonResponse(409, { reason_code: "identity_method_mismatch" })],
      ["503", () => jsonResponse(503, { reason_code: "provider_metadata_stale" })],
      ["network error", () => { throw new Error("ECONNREFUSED"); }],
      ["invalid json", () => new Response("not json", { status: 200 })]
    ];

    for (const [name, respond] of failures) {
      const core = fakeCore([respond]);
      const client = bootstrapClient(core);

      await expect(client.validateApiKey(), name).rejects.toThrow();

      // No v1 route, and no v2 route without an assertion.
      expect(core.calls.some((c) => c.url.includes("/api/v1/")), name).toBe(false);
      expect(core.calls.some((c) => c.url.endsWith(AUTH_VALIDATE_PATH_V2)), name).toBe(false);
    }
  });

  it("reports an unreachable Core as a network error", async () => {
    const core = fakeCore([() => { throw new Error("ECONNREFUSED"); }]);
    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(OpenBoxNetworkError);
  });

  it("surfaces Core's reason code guidance", async () => {
    const core = fakeCore([() => jsonResponse(409, { reason_code: "selected_credential_missing" })]);
    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(
      /select or register an Okta credential/
    );
  });

  it("rejects an unknown bootstrap version with upgrade guidance", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody({ bootstrap_version: 2 }))]);
    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(/Upgrade the OpenBox SDK/);
  });

  it("rejects a non-Okta identity method", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody({ identity_method: "openbox_did" }))]);
    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(/not 'okta_ai_agent'/);
  });

  it("rejects an unsupported algorithm", async () => {
    const core = fakeCore([
      () => jsonResponse(200, bootstrapBody({ okta: { ...(bootstrapBody()["okta"] as object), algorithm: "RS512" } }))
    ]);
    await expect(bootstrapClient(core).validateApiKey()).rejects.toThrow(/only 'RS256'/);
  });

  it("rejects a response missing a required field", async () => {
    for (const field of [
      "openbox_agent_id",
      "organization_id",
      "deployment_id",
      "assertion_audience"
    ]) {
      const body = bootstrapBody();
      delete body[field];
      const core = fakeCore([() => jsonResponse(200, body)]);
      await expect(bootstrapClient(core).validateApiKey(), field).rejects.toThrow(
        new RegExp(field)
      );
    }
  });

  it("rejects a response missing a required okta field", async () => {
    for (const field of ["external_agent_id", "credential_kid", "public_jwk_thumbprint"]) {
      const okta = { ...(bootstrapBody()["okta"] as Record<string, unknown>) };
      delete okta[field];
      const core = fakeCore([() => jsonResponse(200, bootstrapBody({ okta }))]);
      await expect(bootstrapClient(core).validateApiKey(), field).rejects.toThrow(
        new RegExp(field)
      );
    }
  });

  it("allows a retry after a transient failure", async () => {
    // The shared in-flight promise is cleared on failure, so a later request may
    // retry an outage rather than being permanently poisoned.
    const core = fakeCore([
      () => { throw new Error("ECONNREFUSED"); },
      () => jsonResponse(200, bootstrapBody())
    ]);
    const client = bootstrapClient(core);

    await expect(client.validateApiKey()).rejects.toThrow();
    await expect(client.validateApiKey()).resolves.toBeDefined();
    expect(core.bootstrapCallCount()).toBe(2);
  });
});

describe("refreshIdentityMetadata", () => {
  it("replaces cached metadata after re-verifying the thumbprint", async () => {
    const rotatedKid = "rotated-credential-kid-0002";
    const core = fakeCore([
      () => jsonResponse(200, bootstrapBody()),
      () =>
        jsonResponse(
          200,
          bootstrapBody({
            okta: { ...(bootstrapBody()["okta"] as object), credential_kid: rotatedKid }
          })
        )
    ]);
    const client = bootstrapClient(core);

    await client.validateApiKey();
    expect(client.identityMetadata()?.okta.credentialKid).toBe(CREDENTIAL_KID);

    const refreshed = await client.refreshIdentityMetadata();
    expect(refreshed.okta.credentialKid).toBe(rotatedKid);
    expect(client.identityMetadata()?.okta.credentialKid).toBe(rotatedKid);

    // Subsequent requests sign with the refreshed kid.
    await client.validateApiKey();
    const lastValidate = [...core.calls].reverse().find((c) => c.url.endsWith(AUTH_VALIDATE_PATH_V2))!;
    const header = JSON.parse(
      Buffer.from(lastValidate.headers["x-openbox-agent-assertion"]!.split(".")[0]!, "base64url").toString()
    ) as Record<string, unknown>;
    expect(header["kid"]).toBe(rotatedKid);
  });

  it("leaves no stale signer when the refreshed credential does not match the key", async () => {
    // Credential rotated to a key this runtime does not hold: the refresh must
    // fail rather than adopt metadata it cannot sign for — and must not keep
    // signing with the superseded identity either.
    const core = fakeCore([
      () => jsonResponse(200, bootstrapBody()),
      () =>
        jsonResponse(
          200,
          bootstrapBody({
            okta: {
              ...(bootstrapBody()["okta"] as object),
              credential_kid: "rotated-away-kid",
              public_jwk_thumbprint: "mvZ_gJ0t0lSgT1112pD9yjrvBBi0-20HzVE7nzfz41c"
            }
          })
        )
    ]);
    const client = bootstrapClient(core);

    await client.validateApiKey();
    await expect(client.refreshIdentityMetadata()).rejects.toThrow(
      /does not match the selected Okta credential/
    );

    // Neither the unusable document nor the superseded identity remains.
    expect(client.identityMetadata()).toBeNull();
    // The next send bootstraps again rather than signing with the old identity;
    // with no further bootstrap scripted, it fails before any governed request.
    const governedBefore = core.calls.filter((c) => c.url.endsWith(AUTH_VALIDATE_PATH_V2)).length;
    await expect(client.validateApiKey()).rejects.toThrow();
    expect(core.bootstrapCallCount()).toBe(3);
    expect(core.calls.filter((c) => c.url.endsWith(AUTH_VALIDATE_PATH_V2)).length).toBe(governedBefore);
  });

  it("is rejected for a client not in bootstrap mode", async () => {
    const core = fakeCore([]);
    const client = new OpenBoxClient(API_URL, API_KEY, { fetchImpl: core.fetchImpl });

    await expect(client.refreshIdentityMetadata()).rejects.toThrow(/requires identity bootstrap mode/);
  });

  it("does not refresh automatically after an auth failure", async () => {
    // A 401 must surface, not trigger a hidden re-bootstrap-and-replay: rotation
    // may have selected a key this process does not hold, which a retry cannot fix.
    const calls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.endsWith(AUTH_BOOTSTRAP_PATH_V2)) return Promise.resolve(jsonResponse(200, bootstrapBody()));
      return Promise.resolve(jsonResponse(401, { reason_code: "assertion_signature_invalid" }));
    }) as typeof fetch;

    const client = new OpenBoxClient(API_URL, API_KEY, {
      oktaBootstrapPrivateKey: OKTA_PEM,
      fetchImpl,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await expect(client.validateApiKey()).rejects.toThrow();
    expect(calls.filter((u) => u.endsWith(AUTH_BOOTSTRAP_PATH_V2))).toHaveLength(1);
  });
});

describe("constructor guards", () => {
  it("rejects bootstrap mode combined with a resolved Okta identity", () => {
    expect(
      () =>
        new OpenBoxClient(API_URL, API_KEY, {
          oktaBootstrapPrivateKey: OKTA_PEM,
          // A resolved identity already carries what bootstrap would fetch.
          oktaIdentity: {} as never
        })
    ).toThrow(OpenBoxConfigError);
  });

  it("rejects bootstrap mode combined with a v1 DID identity", () => {
    expect(
      () =>
        new OpenBoxClient(API_URL, API_KEY, {
          oktaBootstrapPrivateKey: OKTA_PEM,
          identity: {} as never
        })
    ).toThrow(OpenBoxConfigError);
  });
});

describe("logging", () => {
  it("logs success metadata but never secrets", async () => {
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new OpenBoxClient(API_URL, API_KEY, {
      oktaBootstrapPrivateKey: OKTA_PEM,
      fetchImpl: core.fetchImpl,
      logger
    });

    await client.validateApiKey();

    const logged = logger.info.mock.calls.flat().join(" ");
    expect(logged).toContain(AGENT_ID);
    expect(logged).toContain(CREDENTIAL_KID);
    expect(logged).toContain("thumbprint matched");

    // Never the API key, the private key, or the assertion.
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("BEGIN PRIVATE KEY");
    expect(logged).not.toContain("eyJ");
  });
});

describe("handoff on a bootstrap-mode client", () => {
  it("bootstraps and succeeds when handoff is the very first call", async () => {
    // The unsigned-mode guard must test isV2, not the resolved identity: in
    // bootstrap mode the identity is not resolved until the first request needs
    // it, so testing the resolved field would reject a correctly configured
    // agent and tell the operator to provision an identity they already have.
    const core = fakeCore([() => jsonResponse(200, bootstrapBody())]);
    const client = bootstrapClient(core);

    await client.sendHandoff("00000000-0000-4000-8000-00000000000f", {
      reason: "escalation"
    });

    expect(core.bootstrapCallCount()).toBe(1);
    expect(core.calls.map((c) => new URL(c.url).pathname)).toEqual([
      AUTH_BOOTSTRAP_PATH_V2,
      "/api/v2/handoffs"
    ]);
    // And it is signed, not API-key-only.
    expect(core.calls[1]!.headers["x-openbox-agent-assertion"]).toBeDefined();
  });

  it("still refuses a handoff from a genuinely unsigned client", async () => {
    const core = fakeCore([]);
    const client = new OpenBoxClient(API_URL, API_KEY, { fetchImpl: core.fetchImpl });

    await expect(
      client.sendHandoff("00000000-0000-4000-8000-00000000000f")
    ).rejects.toThrow(/unsigned \(legacy_unsigned\) mode/);
    expect(core.bootstrapCallCount()).toBe(0);
  });
});
