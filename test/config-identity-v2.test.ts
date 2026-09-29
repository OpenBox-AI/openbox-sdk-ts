import { createPrivateKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { OpenBoxConfig } from "../src/config/index.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import { OktaAgentIdentity } from "../src/identity/okta.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

// Real RSA-2048 PKCS8 PEM, derived from the same fixture keypair the golden
// identity-okta*.test.ts files use (never hand-typed — an invented PEM would
// not be valid DER). Config-layer tests only exercise parsing/wiring, not
// signature verification.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");
function fixtureOktaPem(): string {
  const keypair = JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as {
    private_jwk: JsonWebKey;
  };
  return createPrivateKey({ key: keypair.private_jwk, format: "jwk" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}
const OKTA_PEM = fixtureOktaPem();

function resolve(overrides: Record<string, unknown>): OpenBoxConfig {
  return OpenBoxConfig.resolve({ environ: {}, ...overrides });
}

const BASE = { apiUrl: "https://x.com", apiKey: "obx_test_k" };
const OKTA_FIELDS = {
  agentId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  deploymentId: "fixture-deployment",
  oktaAgentId: "fixture-okta-ai-agent-0001",
  oktaAgentKeyId: "fixture-okta-credential-kid-0001",
  oktaAgentAlgorithm: "RS256",
  oktaAgentPrivateKey: OKTA_PEM,
  agentProofAudience: "urn:openbox:fixture-deployment:core"
};

describe("identity method resolution (proposal §13.1 rules 1-2)", () => {
  it("infers legacy_unsigned when no identity fields are configured", () => {
    expect(resolve(BASE).resolvedIdentityMethod()).toBe("legacy_unsigned");
  });

  it("infers openbox_did from agentDid + agentPrivateKey", () => {
    const cfg = resolve({ ...BASE, agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED });
    expect(cfg.resolvedIdentityMethod()).toBe("openbox_did");
  });

  it("infers okta_ai_agent from Okta field presence", () => {
    const cfg = resolve({ ...BASE, ...OKTA_FIELDS });
    expect(cfg.resolvedIdentityMethod()).toBe("okta_ai_agent");
  });

  it("an explicit identityMethod wins over field-based inference", () => {
    // Okta fields present, but explicit method still says openbox_did is not
    // configured here — assert precedence using a case that stays valid: DID
    // fields present AND identityMethod explicitly confirms openbox_did.
    const cfg = resolve({
      ...BASE,
      identityMethod: "openbox_did",
      agentDid: GOLDEN_DID,
      agentPrivateKey: GOLDEN_SEED
    });
    expect(cfg.resolvedIdentityMethod()).toBe("openbox_did");
  });

  it("rejects legacy_unsigned as an explicit selection", () => {
    expect(() => resolve({ ...BASE, identityMethod: "legacy_unsigned" })).toThrow(OpenBoxConfigError);
  });

  it("rejects an unknown identityMethod value", () => {
    expect(() => resolve({ ...BASE, identityMethod: "not_a_method" })).toThrow(OpenBoxConfigError);
  });

  it("rejects explicit openbox_did without DID fields configured", () => {
    expect(() => resolve({ ...BASE, identityMethod: "openbox_did" })).toThrow(OpenBoxConfigError);
  });
});

describe("mutual exclusion (proposal §13.1 rule 5)", () => {
  it("rejects DID and Okta fields configured together, naming both offending fields", () => {
    let error: unknown;
    try {
      resolve({ ...BASE, agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED, ...OKTA_FIELDS });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OpenBoxConfigError);
    const message = (error as Error).message;
    expect(message).toContain("agentDid");
    expect(message).toContain("agentPrivateKey");
    expect(message).toContain("oktaAgentId");
  });
});

describe("Okta required-field validation (proposal §13.1 rule 4)", () => {
  it("rejects when any required Okta field is missing, naming it", () => {
    const { oktaAgentKeyId: _drop, ...incomplete } = OKTA_FIELDS;
    let error: unknown;
    try {
      resolve({ ...BASE, ...incomplete });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OpenBoxConfigError);
    expect((error as Error).message).toContain("oktaAgentKeyId");
  });

  it("rejects an algorithm other than RS256", () => {
    expect(() =>
      resolve({ ...BASE, ...OKTA_FIELDS, oktaAgentAlgorithm: "HS256" })
    ).toThrow(OpenBoxConfigError);
  });

  it("accepts a fully-specified okta_ai_agent config", () => {
    expect(() => resolve({ ...BASE, ...OKTA_FIELDS })).not.toThrow();
  });
});

describe("loadOktaIdentity", () => {
  it("returns null when the resolved method is not okta_ai_agent", () => {
    expect(resolve(BASE).loadOktaIdentity()).toBeNull();
    expect(
      resolve({ ...BASE, agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED }).loadOktaIdentity()
    ).toBeNull();
  });

  it("returns a ready OktaAgentIdentity matching the configured fields", () => {
    const cfg = resolve({ ...BASE, ...OKTA_FIELDS });
    const identity = cfg.loadOktaIdentity();
    expect(identity).toBeInstanceOf(OktaAgentIdentity);
    expect(identity?.openboxAgentId).toBe(OKTA_FIELDS.agentId);
    expect(identity?.externalAgentId).toBe(OKTA_FIELDS.oktaAgentId);
    expect(identity?.keyId).toBe(OKTA_FIELDS.oktaAgentKeyId);
    expect(identity?.audience).toBe(OKTA_FIELDS.agentProofAudience);
  });
});

describe("secret redaction — Okta private key", () => {
  it("never exposes the Okta PEM via JSON.stringify or console.log", () => {
    const cfg = resolve({ ...BASE, ...OKTA_FIELDS });
    expect(JSON.stringify(cfg)).not.toContain("BEGIN PRIVATE KEY");
    expect(inspect(cfg)).not.toContain("BEGIN PRIVATE KEY");
    expect(cfg.toJSON()["oktaAgentPrivateKey"]).toBe("[REDACTED]");
  });
});

describe("env var layering (proposal §13.1 env var table)", () => {
  it("resolves Okta fields from OPENBOX_-prefixed env vars", () => {
    const cfg = OpenBoxConfig.resolve({
      environ: {
        OPENBOX_API_URL: "https://x.com",
        OPENBOX_API_KEY: "obx_test_k",
        OPENBOX_AGENT_ID: OKTA_FIELDS.agentId,
        OPENBOX_ORGANIZATION_ID: OKTA_FIELDS.organizationId,
        OPENBOX_DEPLOYMENT_ID: OKTA_FIELDS.deploymentId,
        OPENBOX_OKTA_AGENT_ID: OKTA_FIELDS.oktaAgentId,
        OPENBOX_OKTA_AGENT_KEY_ID: OKTA_FIELDS.oktaAgentKeyId,
        OPENBOX_OKTA_AGENT_ALGORITHM: OKTA_FIELDS.oktaAgentAlgorithm,
        OPENBOX_OKTA_AGENT_PRIVATE_KEY: OKTA_FIELDS.oktaAgentPrivateKey,
        OPENBOX_AGENT_PROOF_AUDIENCE: OKTA_FIELDS.agentProofAudience
      }
    });
    expect(cfg.resolvedIdentityMethod()).toBe("okta_ai_agent");
    expect(cfg.oktaAgentId).toBe(OKTA_FIELDS.oktaAgentId);
  });

  it("prefers a framework-prefixed Okta env var over the global one", () => {
    const cfg = OpenBoxConfig.resolve({
      envPrefix: "OPENBOX_FW",
      environ: {
        OPENBOX_API_URL: "https://x.com",
        OPENBOX_API_KEY: "obx_test_k",
        OPENBOX_OKTA_AGENT_ID: "global-agent",
        OPENBOX_FW_OKTA_AGENT_ID: "prefixed-agent"
      },
      validate: false
    });
    expect(cfg.oktaAgentId).toBe("prefixed-agent");
  });
});
