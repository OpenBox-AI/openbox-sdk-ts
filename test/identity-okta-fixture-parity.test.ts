import { createHash, createPrivateKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OktaAgentIdentity, prepareOktaSignedRequest } from "../src/identity/okta.js";
import type { OktaAiAgentIdentityConfig } from "../src/identity/types.js";

/**
 * Golden byte-parity tests — proves the TS SDK mints the EXACT same compact
 * RS256 assertion bytes openbox-core's fixture generator produced for the
 * same inputs (deployment/org/agent/audience/jti/iat/exp/method/path/body),
 * not merely a mutually-verifiable one (phase 9 success criterion: "TS and
 * Python produce identical compact assertions for the same fixture input,
 * and Core verifies both").
 *
 * Do not edit files under test/fixtures/identity-v2 — CI runs the drift check
 * (see test/identity-v2-fixtures.test.ts).
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");

interface PositiveFixture {
  method: string;
  path: string;
  api_key: string;
  body_base64: string;
  body_sha256: string;
  header: { kid: string };
  claims: Record<string, unknown>;
  assertion: string;
}

interface KeypairFixture {
  private_jwk: JsonWebKey;
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

/** Convert the fixture's private JWK into the SDK's one canonical encoding (PKCS8 PEM). */
function fixturePrivateKeyPem(): string {
  const keypair = readFixture<KeypairFixture>("keypair.json");
  return createPrivateKey({ key: keypair.private_jwk, format: "jwk" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

const FIXTURE_PEM = fixturePrivateKeyPem();

function identityFromFixture(fixture: PositiveFixture): OktaAgentIdentity {
  const config: OktaAiAgentIdentityConfig = {
    method: "okta_ai_agent",
    openboxAgentId: fixture.claims.obx_agent_id as string,
    organizationId: fixture.claims.obx_organization_id as string,
    deploymentId: fixture.claims.obx_deployment_id as string,
    externalAgentId: fixture.claims.iss as string,
    keyId: fixture.header.kid,
    algorithm: "RS256",
    privateKey: FIXTURE_PEM,
    audience: fixture.claims.aud as string
  };
  return OktaAgentIdentity.fromConfig(config);
}

const CASES: Array<{ file: string; hasBody: boolean; isTransition?: boolean }> = [
  { file: "evaluate.json", hasBody: true },
  { file: "approval.json", hasBody: true },
  { file: "auth-validate.json", hasBody: false },
  { file: "handoff.json", hasBody: true },
  { file: "transition-proof.json", hasBody: true, isTransition: true }
];

describe("Okta v2 assertion — byte-for-byte golden fixture parity", () => {
  it.each(CASES)("mints an assertion byte-identical to $file for the same inputs", ({ file, hasBody, isTransition }) => {
    const fixture = readFixture<PositiveFixture>(file);
    const identity = identityFromFixture(fixture);
    const payload = hasBody
      ? (JSON.parse(Buffer.from(fixture.body_base64, "base64").toString("utf8")) as unknown)
      : null;
    const overrides = {
      jti: fixture.claims.jti as string,
      iat: fixture.claims.iat as number,
      exp: fixture.claims.exp as number
    };
    const transition = isTransition
      ? {
          transitionId: fixture.claims.obx_transition_id as string,
          transitionChallenge: fixture.claims.obx_transition_challenge as string
        }
      : null;

    const { headers, body } = prepareOktaSignedRequest(fixture.method, fixture.path, payload, {
      apiKey: fixture.api_key,
      identity,
      transition,
      overrides
    });

    expect(createHash("sha256").update(body).digest("hex")).toBe(fixture.body_sha256);
    expect(headers["X-OpenBox-Agent-Assertion"]).toBe(fixture.assertion);

    // No v1 identity header ever accompanies a v2 assertion.
    const v1Headers = Object.keys(headers).filter((name) => /^X-OpenBox-(Agent-DID|Agent-Timestamp|Agent-Nonce|Agent-Signature|Body-SHA256)$/.test(name));
    expect(v1Headers).toEqual([]);
  });
});
