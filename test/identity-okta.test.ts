import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { OpenBoxConfigError } from "../src/errors/index.js";
import {
  ASSERTION_ALGORITHM,
  ASSERTION_HEADER,
  ASSERTION_LIFETIME_SECONDS,
  ASSERTION_TYP,
  MIN_RSA_MODULUS_BITS,
  OktaAgentIdentity,
  loadRsaPkcs8PrivateKey,
  prepareOktaSignedRequest,
  signOktaAssertion
} from "../src/identity/okta.js";
import type { OktaAiAgentIdentityConfig } from "../src/identity/types.js";
import { serializeBody } from "../src/serialization/index.js";

// Same fixture keypair as test/identity-v2-fixtures.test.ts, but consumed here
// purely as an RSA-2048 test key — this file's own assertions are hand-built,
// not compared against fixture bytes (see identity-okta-fixture-parity.test.ts
// for the byte-for-byte golden comparison).
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");

interface KeypairFixture {
  private_jwk: JsonWebKey;
  undersized_key_for_negative_test: { private_jwk: JsonWebKey };
}

function readKeypairFixture(): KeypairFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as KeypairFixture;
}

function jwkToPkcs8Pem(jwk: JsonWebKey): string {
  return createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();
}

const VALID_PEM = jwkToPkcs8Pem(readKeypairFixture().private_jwk);

const BASE_CONFIG: OktaAiAgentIdentityConfig = {
  method: "okta_ai_agent",
  openboxAgentId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  deploymentId: "fixture-deployment",
  externalAgentId: "fixture-okta-ai-agent-0001",
  keyId: "fixture-okta-credential-kid-0001",
  algorithm: "RS256",
  privateKey: VALID_PEM,
  audience: "urn:openbox:fixture-deployment:core"
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("loadRsaPkcs8PrivateKey", () => {
  it("loads a valid PKCS8 PEM RSA-2048 key", () => {
    const key = loadRsaPkcs8PrivateKey(VALID_PEM);
    expect(key.type).toBe("private");
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it("rejects non-PEM garbage without echoing key bytes", () => {
    expect(() => loadRsaPkcs8PrivateKey("not a key")).toThrow(OpenBoxConfigError);
    expect(() => loadRsaPkcs8PrivateKey("not a key")).toThrow(/key bytes not shown/);
  });

  it("rejects a non-RSA (Ed25519) PKCS8 PEM key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const edPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadRsaPkcs8PrivateKey(edPem)).toThrow(OpenBoxConfigError);
    expect(() => loadRsaPkcs8PrivateKey(edPem)).toThrow(/expected an RSA key/);
  });

  it("rejects an RSA key below the 2048-bit floor", () => {
    const undersizedPem = jwkToPkcs8Pem(readKeypairFixture().undersized_key_for_negative_test.private_jwk);
    expect(() => loadRsaPkcs8PrivateKey(undersizedPem)).toThrow(OpenBoxConfigError);
    expect(() => loadRsaPkcs8PrivateKey(undersizedPem)).toThrow(
      new RegExp(`at least ${MIN_RSA_MODULUS_BITS} bits`)
    );
  });
});

describe("OktaAgentIdentity.fromConfig", () => {
  it("loads a valid config and exposes only its non-secret fields", () => {
    const identity = OktaAgentIdentity.fromConfig(BASE_CONFIG);
    expect(identity.openboxAgentId).toBe(BASE_CONFIG.openboxAgentId);
    expect(identity.organizationId).toBe(BASE_CONFIG.organizationId);
    expect(identity.deploymentId).toBe(BASE_CONFIG.deploymentId);
    expect(identity.externalAgentId).toBe(BASE_CONFIG.externalAgentId);
    expect(identity.keyId).toBe(BASE_CONFIG.keyId);
    expect(identity.algorithm).toBe("RS256");
    expect(identity.audience).toBe(BASE_CONFIG.audience);
  });

  it("rejects an algorithm other than RS256, even bypassing the static type", () => {
    // Simulates an untyped/env-driven caller — the allowlist is enforced at
    // runtime, not merely by the `"RS256"` literal type.
    const bad = { ...BASE_CONFIG, algorithm: "HS256" } as unknown as OktaAiAgentIdentityConfig;
    expect(() => OktaAgentIdentity.fromConfig(bad)).toThrow(OpenBoxConfigError);
    expect(() => OktaAgentIdentity.fromConfig(bad)).toThrow(/allowlisted/);
  });

  it("never leaks the private key via JSON.stringify or console.log-style inspect", () => {
    const identity = OktaAgentIdentity.fromConfig(BASE_CONFIG);
    // A distinctive interior slice of the PEM body — if this ever appears in
    // rendered output, the key itself leaked.
    const pemSnippet = VALID_PEM.slice(60, 100);
    expect(JSON.stringify(identity)).not.toContain(pemSnippet);
    expect(inspect(identity)).not.toContain(pemSnippet);
    expect(inspect(identity)).not.toContain("BEGIN PRIVATE KEY");
    expect(Object.keys(identity)).not.toContain("privateKey");
  });
});

describe("signOktaAssertion", () => {
  const identity = OktaAgentIdentity.fromConfig(BASE_CONFIG);

  it("builds the protected header with alg/kid/typ in that exact key order, no jwk/jku/x5u", () => {
    const assertion = signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x");
    const header = decodeSegment(assertion.split(".")[0]!);
    expect(Object.keys(header)).toEqual(["alg", "kid", "typ"]);
    expect(header.alg).toBe(ASSERTION_ALGORITHM);
    expect(header.typ).toBe(ASSERTION_TYP);
    expect(header.kid).toBe(BASE_CONFIG.keyId);
    expect(header).not.toHaveProperty("jwk");
    expect(header).not.toHaveProperty("jku");
    expect(header).not.toHaveProperty("x5u");
  });

  it("builds claims in the exact alphabetical key order the shared fixture uses", () => {
    const assertion = signOktaAssertion(
      identity,
      "POST",
      "/api/v2/governance/evaluate",
      "deadbeef",
      "obx_test_x",
      null,
      { jti: "fixed-jti", iat: 1000, exp: 1060 }
    );
    const claims = decodeSegment(assertion.split(".")[1]!);
    expect(Object.keys(claims)).toEqual([
      "aud",
      "body_sha256",
      "exp",
      "htm",
      "htu",
      "iat",
      "iss",
      "jti",
      "obx_agent_id",
      "obx_api_key_sha256",
      "obx_deployment_id",
      "obx_organization_id",
      "sub"
    ]);
    expect(claims.iss).toBe(BASE_CONFIG.externalAgentId);
    expect(claims.sub).toBe(BASE_CONFIG.externalAgentId);
    expect(claims.aud).toBe(BASE_CONFIG.audience);
    expect(claims.obx_api_key_sha256).toBe(createHash("sha256").update("obx_test_x").digest("hex"));
  });

  it("places transition claims between obx_organization_id and sub, alphabetical among themselves", () => {
    const assertion = signOktaAssertion(
      identity,
      "POST",
      "/api/v2/auth/transition-proof",
      "deadbeef",
      "obx_test_x",
      { transitionId: "t-1", transitionChallenge: "c-1" },
      { jti: "fixed-jti", iat: 1000, exp: 1060 }
    );
    const claims = decodeSegment(assertion.split(".")[1]!);
    expect(Object.keys(claims)).toEqual([
      "aud",
      "body_sha256",
      "exp",
      "htm",
      "htu",
      "iat",
      "iss",
      "jti",
      "obx_agent_id",
      "obx_api_key_sha256",
      "obx_deployment_id",
      "obx_organization_id",
      "obx_transition_challenge",
      "obx_transition_id",
      "obx_transition_purpose",
      "sub"
    ]);
    expect(claims.obx_transition_purpose).toBe("okta_ai_agent");
    expect(claims.obx_transition_id).toBe("t-1");
    expect(claims.obx_transition_challenge).toBe("c-1");
  });

  it("omits transition claims entirely on a non-transition assertion", () => {
    const assertion = signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x");
    const claims = decodeSegment(assertion.split(".")[1]!);
    expect(claims).not.toHaveProperty("obx_transition_purpose");
    expect(claims).not.toHaveProperty("obx_transition_id");
    expect(claims).not.toHaveProperty("obx_transition_challenge");
  });

  it("defaults exp - iat to the 60s ceiling and uppercases htm", () => {
    const before = Math.floor(Date.now() / 1000);
    const assertion = signOktaAssertion(identity, "post", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x");
    const claims = decodeSegment(assertion.split(".")[1]!);
    expect((claims.exp as number) - (claims.iat as number)).toBe(ASSERTION_LIFETIME_SECONDS);
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(claims.htm).toBe("POST");
  });

  it("generates a fresh jti per call by default", () => {
    const a = decodeSegment(
      signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x").split(".")[1]!
    );
    const b = decodeSegment(
      signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x").split(".")[1]!
    );
    expect(a.jti).not.toBe(b.jti);
  });

  it("is deterministic: identical inputs (incl. overrides) produce the identical assertion", () => {
    const overrides = { jti: "fixed-jti", iat: 1000, exp: 1060 };
    const a = signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x", null, overrides);
    const b = signOktaAssertion(identity, "POST", "/api/v2/governance/evaluate", "deadbeef", "obx_test_x", null, overrides);
    expect(a).toBe(b);
  });
});

describe("prepareOktaSignedRequest", () => {
  const identity = OktaAgentIdentity.fromConfig(BASE_CONFIG);

  it("adds ONLY the base auth headers plus X-OpenBox-Agent-Assertion — no v1 DID headers", () => {
    const { headers } = prepareOktaSignedRequest("POST", "/api/v2/governance/evaluate", { a: 1 }, {
      apiKey: "obx_test_x",
      identity
    });
    expect(Object.keys(headers).sort()).toEqual(
      ["Authorization", "User-Agent", "X-OpenBox-SDK-Version", ASSERTION_HEADER].sort()
    );
    expect(headers[ASSERTION_HEADER]).toBeTruthy();
    expect(headers["Authorization"]).toBe("Bearer obx_test_x");
  });

  it("hashes and sends the SAME body bytes — serialize once (proposal §13.4 steps 1-2, 9)", () => {
    const payload = { note: "café" };
    const { body, headers } = prepareOktaSignedRequest("POST", "/api/v2/governance/evaluate", payload, {
      apiKey: "obx_test_x",
      identity
    });
    expect(body.equals(serializeBody(payload))).toBe(true);
    const claims = decodeSegment(headers[ASSERTION_HEADER]!.split(".")[1]!);
    expect(claims.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("a null payload serializes to empty bytes and the well-known empty-body hash", () => {
    const { body, headers } = prepareOktaSignedRequest("GET", "/api/v2/auth/validate", null, {
      apiKey: "obx_test_x",
      identity
    });
    expect(body.length).toBe(0);
    const claims = decodeSegment(headers[ASSERTION_HEADER]!.split(".")[1]!);
    expect(claims.body_sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
