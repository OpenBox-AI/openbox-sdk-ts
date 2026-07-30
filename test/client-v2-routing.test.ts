import { createPrivateKey, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_PATH,
  APPROVAL_PATH_V2,
  AUTH_VALIDATE_PATH,
  AUTH_VALIDATE_PATH_V2,
  EVALUATE_PATH,
  EVALUATE_PATH_V2,
  HANDOFF_PATH_V1,
  HANDOFF_PATH_V2,
  OpenBoxClient,
  TRANSITION_PROOF_PATH_V1,
  TRANSITION_PROOF_PATH_V2
} from "../src/client/index.js";
import { OpenBoxAuthError, OpenBoxConfigError } from "../src/errors/index.js";
import { OpenBoxAssertionError } from "../src/errors/assertion.js";
import { AgentIdentity } from "../src/identity/index.js";
import { OktaAgentIdentity } from "../src/identity/okta.js";
import type { OktaAiAgentIdentityConfig, OpenBoxDidIdentityConfig } from "../src/identity/types.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const OTHER_DID = "did:aip:87654321-4321-8765-4321-876543218765";
// A fresh, valid 32-byte Ed25519 seed — generated, never hand-typed (a
// mistyped constant would silently fail to decode to 32 bytes).
const OTHER_SEED = randomBytes(32).toString("base64");
const silentLogger = { warn() {}, error() {}, info() {} };

// `Headers` always normalizes names to lowercase on iteration — match
// case-insensitively rather than reconstructing canonical case.
const V1_IDENTITY_HEADER_RE =
  /^x-openbox-(agent-did|agent-timestamp|agent-nonce|agent-signature|body-sha256)$/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** `fetchImpl`'s first argument is typed `string | URL | Request` (matching `typeof fetch`); this
 * client always calls it with a plain string, but coerce properly rather than a bare `String()`
 * (which would print `[object Object]` for a `Request`). */
function urlToString(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return url.url;
}

// Real RSA-2048 PKCS8 PEM, derived from the shared fixture keypair — never
// hand-typed (see test/identity-okta.test.ts for the same pattern).
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");
function fixtureOktaPem(): string {
  const keypair = JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as {
    private_jwk: JsonWebKey;
    public_jwk: JsonWebKey;
  };
  return createPrivateKey({ key: keypair.private_jwk, format: "jwk" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}
function fixturePublicKey() {
  const keypair = JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as {
    public_jwk: JsonWebKey;
  };
  return createPublicKey({ key: keypair.public_jwk, format: "jwk" });
}
const FIXTURE_PEM = fixtureOktaPem();

function oktaConfig(overrides: Partial<OktaAiAgentIdentityConfig> = {}): OktaAiAgentIdentityConfig {
  return {
    method: "okta_ai_agent",
    openboxAgentId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000001",
    deploymentId: "fixture-deployment",
    externalAgentId: "fixture-okta-ai-agent-0001",
    keyId: "fixture-okta-credential-kid-0001",
    algorithm: "RS256",
    privateKey: FIXTURE_PEM,
    audience: "urn:openbox:fixture-deployment:core",
    ...overrides
  };
}

function decodeAssertionClaims(assertion: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function decodeAssertionHeader(assertion: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(assertion.split(".")[0]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("v2 endpoint selection — no cross-version retry", () => {
  function v2Client(fetchImpl: typeof fetch): OpenBoxClient {
    return new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl,
      logger: silentLogger,
      oktaIdentity: OktaAgentIdentity.fromConfig(oktaConfig())
    });
  }

  it("evaluate() calls the v2 path and signs an assertion (never v1)", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const c = v2Client(async (url, init) => {
      capturedUrl = urlToString(url);
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse({ verdict: "allow" });
    });
    await c.evaluate({ event_type: "ActivityStarted" });
    expect(capturedUrl).toBe(`https://core.example.com${EVALUATE_PATH_V2}`);
    expect(capturedUrl).not.toContain(EVALUATE_PATH);
    expect(capturedHeaders["x-openbox-agent-assertion"]).toBeTruthy();
  });

  it("approval polling calls the v2 path", async () => {
    let capturedUrl = "";
    const c = v2Client(async (url) => {
      capturedUrl = urlToString(url);
      return jsonResponse({ action: "allow" });
    });
    await c.pollApproval("wf", "run", "act");
    expect(capturedUrl).toBe(`https://core.example.com${APPROVAL_PATH_V2}`);
  });

  it("validateApiKey calls GET v2 auth/validate", async () => {
    let capturedUrl = "";
    const c = v2Client(async (url) => {
      capturedUrl = urlToString(url);
      return new Response("", { status: 200 });
    });
    await c.validateApiKey();
    expect(capturedUrl).toBe(`https://core.example.com${AUTH_VALIDATE_PATH_V2}`);
    expect(capturedUrl).not.toContain(AUTH_VALIDATE_PATH);
  });

  it("handoff calls the v2 handoffs path", async () => {
    let capturedUrl = "";
    const c = v2Client(async (url) => {
      capturedUrl = urlToString(url);
      return jsonResponse({ handoff_id: "h1", from_agent_id: "a", to_agent_id: "b" });
    });
    await c.sendHandoff("00000000-0000-4000-8000-0000000000ff");
    expect(capturedUrl).toBe(`https://core.example.com${HANDOFF_PATH_V2}`);
  });

  it("a v2 auth failure throws OpenBoxAssertionError and is never retried against v1", async () => {
    let callCount = 0;
    const c = v2Client(async () => {
      callCount += 1;
      return jsonResponse({ reason_code: "assertion_signature_invalid" }, 401);
    });
    await expect(c.evaluate({})).rejects.toBeInstanceOf(OpenBoxAssertionError);
    expect(callCount).toBe(1); // no fallback/retry attempt against a v1 path
  });

  it("approval 401/403 fails closed instead of returning pending/null (proposal §13.6)", async () => {
    const c = v2Client(async () => jsonResponse({}, 401));
    await expect(c.pollApproval("wf", "run", "act")).rejects.toBeInstanceOf(Error);
  });
});

describe("v1 identity headers never accompany a v2 request", () => {
  it("no X-OpenBox-Agent-DID/-Timestamp/-Nonce/-Signature/-Body-SHA256 header is ever sent", async () => {
    let capturedHeaders: Record<string, string> = {};
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async (_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse({ verdict: "allow" });
      },
      logger: silentLogger,
      oktaIdentity: OktaAgentIdentity.fromConfig(oktaConfig())
    });
    await c.evaluate({ event_type: "ActivityStarted" });

    const leaked = Object.keys(capturedHeaders).filter((name) => V1_IDENTITY_HEADER_RE.test(name));
    expect(leaked).toEqual([]);
    expect(capturedHeaders["x-openbox-agent-assertion"]).toBeTruthy();
  });

  it("a client cannot be constructed with both a v1 and a v2 identity", () => {
    const v1Identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const v2Identity = OktaAgentIdentity.fromConfig(oktaConfig());
    expect(
      () =>
        new OpenBoxClient("https://core.example.com", "obx_test_k", {
          identity: v1Identity,
          oktaIdentity: v2Identity
        })
    ).toThrow(OpenBoxConfigError);
  });
});

describe("handoff — unsigned mode is blocked", () => {
  it("legacy_unsigned (no identity configured) cannot send a source-authenticated handoff", async () => {
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => jsonResponse({}),
      logger: silentLogger
    });
    await expect(c.sendHandoff("00000000-0000-4000-8000-0000000000ff")).rejects.toBeInstanceOf(
      OpenBoxConfigError
    );
  });

  it("v1 (openbox_did) handoff calls the v1 handoffs path", async () => {
    let capturedUrl = "";
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async (url) => {
        capturedUrl = urlToString(url);
        return jsonResponse({ handoff_id: "h1", from_agent_id: "a", to_agent_id: "b" });
      },
      logger: silentLogger,
      identity: AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED)
    });
    const result = await c.sendHandoff("00000000-0000-4000-8000-0000000000ff", { reason: "delegation" });
    expect(capturedUrl).toBe(`https://core.example.com${HANDOFF_PATH_V1}`);
    expect(result).toEqual({ handoffId: "h1", fromAgentId: "a", toAgentId: "b" });
  });
});

describe("transition preflight — explicit candidate only (proposal §13.5, §17.28)", () => {
  it("validateOktaIdentityTransition rejects locally when no candidate is supplied — no network call", async () => {
    let called = false;
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ proof_verified: true });
      },
      logger: silentLogger,
      oktaIdentity: OktaAgentIdentity.fromConfig(oktaConfig())
    });
    await expect(
      c.validateOktaIdentityTransition({
        transitionId: "t-1",
        challenge: "chal",
        candidateIdentity: undefined as unknown as OktaAiAgentIdentityConfig
      })
    ).rejects.toBeInstanceOf(OpenBoxConfigError);
    expect(called).toBe(false);
  });

  it("validateOpenBoxDidIdentityTransition rejects locally when no candidate is supplied — no network call", async () => {
    let called = false;
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ proof_verified: true });
      },
      logger: silentLogger,
      identity: AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED)
    });
    await expect(
      c.validateOpenBoxDidIdentityTransition({
        transitionId: "t-1",
        challenge: "chal",
        candidateIdentity: undefined as unknown as OpenBoxDidIdentityConfig
      })
    ).rejects.toBeInstanceOf(OpenBoxConfigError);
    expect(called).toBe(false);
  });

  it("Okta preflight signs with the EXPLICIT candidate key even when the client's active signer differs", async () => {
    // The client's ACTIVE identity uses kid "active-kid" (a different keypair
    // than the candidate). If the preflight ever fell back to it, the
    // asserted `kid`/`iss`/`obx_agent_id` below would read "active-*" instead
    // of "candidate-*", and/or the signature would verify under the wrong key.
    const activeIdentity = OktaAgentIdentity.fromConfig(
      oktaConfig({ keyId: "active-kid", externalAgentId: "active-external-agent" })
    );
    const candidateConfig = oktaConfig({
      keyId: "candidate-kid",
      externalAgentId: "candidate-external-agent",
      openboxAgentId: "00000000-0000-4000-8000-0000000000cc"
    });

    let capturedUrl = "";
    let capturedAssertion = "";
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async (url, init) => {
        capturedUrl = urlToString(url);
        const headers = new Headers(init?.headers);
        capturedAssertion = headers.get("X-OpenBox-Agent-Assertion") ?? "";
        return jsonResponse({ proof_verified: true });
      },
      logger: silentLogger,
      oktaIdentity: activeIdentity
    });

    const result = await c.validateOktaIdentityTransition({
      transitionId: "00000000-0000-4000-8000-000000000003",
      challenge: "Y2hhbGxlbmdl",
      candidateIdentity: candidateConfig
    });

    expect(result.proofVerified).toBe(true);
    expect(capturedUrl).toBe(`https://core.example.com${TRANSITION_PROOF_PATH_V2}`);

    const header = decodeAssertionHeader(capturedAssertion);
    const claims = decodeAssertionClaims(capturedAssertion);
    expect(header.kid).toBe("candidate-kid");
    expect(header.kid).not.toBe("active-kid");
    expect(claims.iss).toBe("candidate-external-agent");
    expect(claims.obx_agent_id).toBe("00000000-0000-4000-8000-0000000000cc");
    expect(claims.obx_transition_purpose).toBe("okta_ai_agent");
    expect(claims.obx_transition_id).toBe("00000000-0000-4000-8000-000000000003");

    // Strongest proof: the signature verifies under the CANDIDATE's public
    // key, not the active identity's — a wrong-key signature would fail here.
    const [h, p, s] = capturedAssertion.split(".");
    const verified = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      fixturePublicKey(),
      Buffer.from(s!, "base64url")
    );
    expect(verified).toBe(true);
  });

  it("DID preflight signs with the EXPLICIT candidate DID even when the client's active identity differs", async () => {
    const activeIdentity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const candidate: OpenBoxDidIdentityConfig = {
      method: "openbox_did",
      did: OTHER_DID,
      privateKey: OTHER_SEED
    };

    let capturedHeaders: Record<string, string> = {};
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async (_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse({ proof_verified: true });
      },
      logger: silentLogger,
      identity: activeIdentity
    });

    await c.validateOpenBoxDidIdentityTransition({
      transitionId: "t-2",
      challenge: "Y2hhbGxlbmdl",
      candidateIdentity: candidate
    });

    expect(capturedHeaders["x-openbox-agent-did"]).toBe(OTHER_DID);
    expect(capturedHeaders["x-openbox-agent-did"]).not.toBe(GOLDEN_DID);
  });

  it("rejects locally when the candidate does not match the supplied expectedTarget metadata", async () => {
    let called = false;
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ proof_verified: true });
      },
      logger: silentLogger,
      oktaIdentity: OktaAgentIdentity.fromConfig(oktaConfig())
    });

    await expect(
      c.validateOktaIdentityTransition({
        transitionId: "t-1",
        challenge: "chal",
        candidateIdentity: oktaConfig({ keyId: "candidate-kid" }),
        expectedTarget: { method: "okta_ai_agent", keyId: "a-completely-different-kid" }
      })
    ).rejects.toBeInstanceOf(OpenBoxConfigError);
    expect(called).toBe(false);
  });

  it("a 401 on the transition-proof route maps to a typed error, not a silent success", async () => {
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => jsonResponse({ reason_code: "transition_proof_invalid" }, 401),
      logger: silentLogger,
      oktaIdentity: OktaAgentIdentity.fromConfig(oktaConfig())
    });
    await expect(
      c.validateOktaIdentityTransition({
        transitionId: "t-1",
        challenge: "chal",
        candidateIdentity: oktaConfig({ keyId: "candidate-kid" })
      })
    ).rejects.toBeInstanceOf(OpenBoxAssertionError);
  });

  it("v1 candidate transition proof rejects on auth failure via OpenBoxAuthError-family error", async () => {
    const c = new OpenBoxClient("https://core.example.com", "obx_test_k", {
      fetchImpl: async () => jsonResponse({}, 401),
      logger: silentLogger,
      identity: AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED)
    });
    await expect(
      c.validateOpenBoxDidIdentityTransition({
        transitionId: "t-1",
        challenge: "chal",
        candidateIdentity: { method: "openbox_did", did: OTHER_DID, privateKey: OTHER_SEED }
      })
    ).rejects.toBeInstanceOf(OpenBoxAuthError);
  });
});
