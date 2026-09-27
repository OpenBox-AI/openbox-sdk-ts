import { createPrivateKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OpenBoxConfig } from "../src/config/index.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import { fakePrivateKeyPem } from "./support/fake-private-key-pem.js";

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

const BASE = { apiUrl: "https://core.example.com", apiKey: "obx_test_k" };

/** The 6 metadata fields Core supplies in bootstrap mode. */
const MANAGED_FIELDS = {
  agentId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  deploymentId: "fixture-deployment",
  agentProofAudience: "urn:openbox:fixture-deployment:core",
  oktaAgentId: "fixture-okta-ai-agent-0001",
  oktaAgentKeyId: "fixture-okta-credential-kid-0001"
} as const;

const LEGACY_FIELDS = { ...MANAGED_FIELDS, oktaAgentAlgorithm: "RS256" };

// `environ: {}` isolates every case from the real process environment.
function resolve(overrides: Record<string, unknown>): OpenBoxConfig {
  return OpenBoxConfig.resolve({ environ: {}, ...BASE, ...overrides });
}

describe("bootstrap mode", () => {
  it("accepts the minimal three-value configuration", () => {
    const config = resolve({ oktaAgentPrivateKey: OKTA_PEM });

    expect(config.resolvedIdentityMethod()).toBe("okta_ai_agent");
    expect(config.oktaConfigMode()).toBe("bootstrap");
    expect(config.oktaBootstrapPrivateKey()).toBe(OKTA_PEM);
    // The identity cannot exist yet — Core has not supplied its metadata.
    expect(config.loadOktaIdentity()).toBeNull();
  });

  it("infers okta_ai_agent from the private key alone", () => {
    // The private key is one of the method-inference trigger fields, so a
    // three-value config still resolves to v2 rather than legacy_unsigned.
    expect(resolve({ oktaAgentPrivateKey: OKTA_PEM }).resolvedIdentityMethod()).toBe(
      "okta_ai_agent"
    );
  });

  it("resolves from environment variables", () => {
    const config = OpenBoxConfig.resolve({
      environ: {
        OPENBOX_API_URL: "https://core.example.com",
        OPENBOX_API_KEY: "obx_live_envkey",
        OPENBOX_OKTA_AGENT_PRIVATE_KEY: OKTA_PEM
      }
    });
    expect(config.oktaConfigMode()).toBe("bootstrap");
    expect(config.oktaBootstrapPrivateKey()).toBe(OKTA_PEM);
  });

  it("does not require OPENBOX_DEPLOYMENT_ID", () => {
    // The operator no longer sets this, which is what prevents a runtime from
    // signing for one deployment while calling another.
    const config = resolve({ oktaAgentPrivateKey: OKTA_PEM });
    expect(config.deploymentId).toBeNull();
    expect(config.agentProofAudience).toBeNull();
  });

  it("tolerates an explicitly set RS256 algorithm", () => {
    expect(
      resolve({ oktaAgentPrivateKey: OKTA_PEM, oktaAgentAlgorithm: "RS256" }).oktaConfigMode()
    ).toBe("bootstrap");
  });

  it("rejects a stale non-RS256 algorithm rather than ignoring it", () => {
    expect(() => resolve({ oktaAgentPrivateKey: OKTA_PEM, oktaAgentAlgorithm: "RS512" })).toThrow(
      /RS256/
    );
  });

  it("does not parse the private key during offline resolution", () => {
    // normalized() must stay pure and offline — key parsing and the thumbprint
    // check belong to the bootstrap step. A garbage key resolves fine here and
    // fails later, at bootstrap.
    const config = resolve({ oktaAgentPrivateKey: fakePrivateKeyPem("nope") });
    expect(config.oktaConfigMode()).toBe("bootstrap");
  });

  it("still redacts the private key from logs", () => {
    const config = resolve({ oktaAgentPrivateKey: OKTA_PEM });
    const json = JSON.stringify(config);

    expect(json).toContain("[REDACTED]");
    expect(json).not.toContain("BEGIN PRIVATE KEY");
    expect(json).not.toContain("obx_test_k");
  });
});

describe("legacy explicit mode", () => {
  it("still works unchanged with every field configured", () => {
    const config = resolve({ ...LEGACY_FIELDS, oktaAgentPrivateKey: OKTA_PEM });

    expect(config.oktaConfigMode()).toBe("legacy");
    // No bootstrap will be attempted.
    expect(config.oktaBootstrapPrivateKey()).toBeNull();

    const identity = config.loadOktaIdentity();
    expect(identity).not.toBeNull();
    expect(identity!.keyId).toBe(MANAGED_FIELDS.oktaAgentKeyId);
    expect(identity!.audience).toBe(MANAGED_FIELDS.agentProofAudience);
    expect(identity!.externalAgentId).toBe(MANAGED_FIELDS.oktaAgentId);
  });

  it("still requires the algorithm field", () => {
    // Pre-existing behaviour: legacy mode's completeness check is unchanged.
    expect(() => resolve({ ...MANAGED_FIELDS, oktaAgentPrivateKey: OKTA_PEM })).toThrow(
      /oktaAgentAlgorithm/
    );
  });
});

describe("invalid mixed mode", () => {
  // Each case configures exactly one managed field, which must be rejected
  // rather than merged with bootstrapped values — a leftover field from before a
  // rotation would otherwise silently win over the correct value from Core.
  for (const [field, value] of Object.entries(MANAGED_FIELDS)) {
    it(`rejects a partial configuration carrying only ${field}`, () => {
      expect(() => resolve({ oktaAgentPrivateKey: OKTA_PEM, [field]: value })).toThrow(
        OpenBoxConfigError
      );
    });
  }

  it("names both the configured and the missing fields", () => {
    let message = "";
    try {
      resolve({ oktaAgentPrivateKey: OKTA_PEM, oktaAgentKeyId: MANAGED_FIELDS.oktaAgentKeyId });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("oktaAgentKeyId");
    expect(message).toContain("OPENBOX_OKTA_AGENT_KEY_ID");
    // The missing ones are listed too, so the operator can choose a direction.
    expect(message).toContain("agentId");
    expect(message).toContain("organizationId");
    // And both remedies are stated.
    expect(message).toContain("bootstrap mode");
  });

  it("rejects a configuration missing exactly one managed field", () => {
    const { oktaAgentKeyId: _omitted, ...allButOne } = MANAGED_FIELDS;
    expect(() =>
      resolve({ ...allButOne, oktaAgentAlgorithm: "RS256", oktaAgentPrivateKey: OKTA_PEM })
    ).toThrow(OpenBoxConfigError);
  });
});

describe("identity method boundaries", () => {
  it("requires a private key in every Okta mode", () => {
    // Core can never supply this value, so its absence is fatal regardless of mode.
    expect(() => resolve({ identityMethod: "okta_ai_agent" })).toThrow(/oktaAgentPrivateKey/);
  });

  it("rejects DID configuration combined with an Okta private key", () => {
    // Must be an explicit error, never a silent guess about which method wins.
    expect(() =>
      resolve({
        agentDid: "did:aip:12345678-1234-5678-1234-567812345678",
        agentPrivateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        oktaAgentPrivateKey: OKTA_PEM
      })
    ).toThrow(/mutually exclusive/);
  });

  it("leaves DID-only configuration untouched", () => {
    const config = resolve({
      agentDid: "did:aip:12345678-1234-5678-1234-567812345678",
      agentPrivateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
    });

    expect(config.resolvedIdentityMethod()).toBe("openbox_did");
    expect(config.oktaConfigMode()).toBeNull();
    expect(config.oktaBootstrapPrivateKey()).toBeNull();
    expect(config.loadIdentity()).not.toBeNull();
  });

  it("leaves unsigned configuration untouched", () => {
    const config = resolve({});
    expect(config.resolvedIdentityMethod()).toBe("legacy_unsigned");
    expect(config.oktaConfigMode()).toBeNull();
    expect(config.oktaBootstrapPrivateKey()).toBeNull();
  });
});
