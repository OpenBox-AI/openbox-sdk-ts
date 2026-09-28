/**
 * IAM v3 workload configuration: deterministic mode resolution, environment
 * precedence, the explicit-only Okta-key alias, conflict rejection naming every
 * field, secret redaction, and the `fromConfig` guarantee that `validate: false`
 * never skips mode exclusivity or key checks.
 */
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig, type ResolveOptions } from "../src/config/index.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import {
  EC_PEM,
  OTHER_WORKLOAD_PEM,
  UNDERSIZED_PEM,
  WORKLOAD_PEM
} from "./support/workload-identity-fakes.js";
import { fakePrivateKeyPem } from "./support/fake-private-key-pem.js";

const BASE = { apiUrl: "https://core.example.com", apiKey: "obx_test_workloadcfg" };
const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function resolve(overrides: Partial<ResolveOptions> & Record<string, unknown>): OpenBoxConfig {
  return OpenBoxConfig.resolve({ environ: {}, ...BASE, ...overrides });
}

describe("workload mode resolution", () => {
  it("infers keycloak_workload from workloadPrivateKey alone", () => {
    const config = resolve({ workloadPrivateKey: WORKLOAD_PEM });
    expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
    expect(config.loadIdentity()).toBeNull();
    expect(config.loadOktaIdentity()).toBeNull();
    expect(config.oktaBootstrapPrivateKey()).toBeNull();
  });

  it("accepts an explicit keycloak_workload selection with the neutral key", () => {
    const config = resolve({ identityMethod: "keycloak_workload", workloadPrivateKey: WORKLOAD_PEM });
    expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
  });

  it("uses oktaAgentPrivateKey as the migration alias only under explicit keycloak_workload", () => {
    const config = resolve({ identityMethod: "keycloak_workload", oktaAgentPrivateKey: WORKLOAD_PEM });
    expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
    // No Okta v2 identity is ever built from the alias.
    expect(config.loadOktaIdentity()).toBeNull();
    expect(config.oktaBootstrapPrivateKey()).toBeNull();
    expect(config.oktaConfigMode()).toBeNull();
  });

  it("keeps an Okta-only configuration on v2 — no implicit v3", () => {
    const config = resolve({ oktaAgentPrivateKey: WORKLOAD_PEM });
    expect(config.resolvedIdentityMethod()).toBe("okta_ai_agent");
    expect(config.resolvedWorkloadPrivateKey()).toBeNull();
    expect(config.oktaBootstrapPrivateKey()).toBe(WORKLOAD_PEM);
  });

  it("keeps DID configuration on v1 and no configuration on legacy_unsigned", () => {
    expect(resolve({ agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED }).resolvedIdentityMethod()).toBe(
      "openbox_did"
    );
    expect(resolve({}).resolvedIdentityMethod()).toBe("legacy_unsigned");
    expect(resolve({}).resolvedWorkloadPrivateKey()).toBeNull();
  });

  it("rejects explicit keycloak_workload without either accepted key", () => {
    expect(() => resolve({ identityMethod: "keycloak_workload" })).toThrow(OpenBoxConfigError);
    expect(() => resolve({ identityMethod: "keycloak_workload" })).toThrow(/workloadPrivateKey/);
  });

  it("rejects the neutral key together with its alias, naming both", () => {
    for (const identityMethod of ["keycloak_workload", null] as const) {
      const attempt = (): OpenBoxConfig =>
        resolve({ identityMethod, workloadPrivateKey: WORKLOAD_PEM, oktaAgentPrivateKey: OTHER_WORKLOAD_PEM });
      expect(attempt).toThrow(OpenBoxConfigError);
      expect(attempt).toThrow(/workloadPrivateKey.*oktaAgentPrivateKey|oktaAgentPrivateKey.*workloadPrivateKey/);
    }
  });

  it("rejects DID fields in workload mode, naming them", () => {
    expect(() =>
      resolve({ workloadPrivateKey: WORKLOAD_PEM, agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED })
    ).toThrow(/agentDid.*agentPrivateKey/);
    expect(() =>
      resolve({
        identityMethod: "keycloak_workload",
        workloadPrivateKey: WORKLOAD_PEM,
        agentDid: GOLDEN_DID,
        agentPrivateKey: GOLDEN_SEED
      })
    ).toThrow(OpenBoxConfigError);
  });

  it("rejects leftover Okta metadata in workload mode, naming every field", () => {
    let message = "";
    try {
      resolve({
        identityMethod: "keycloak_workload",
        oktaAgentPrivateKey: WORKLOAD_PEM,
        agentId: "00000000-0000-4000-8000-000000000002",
        oktaAgentKeyId: "stale-kid",
        oktaAgentAlgorithm: "RS256"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OpenBoxConfigError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/agentId \(OPENBOX_AGENT_ID\)/);
    expect(message).toMatch(/oktaAgentKeyId \(OPENBOX_OKTA_AGENT_KEY_ID\)/);
    expect(message).toMatch(/oktaAgentAlgorithm \(OPENBOX_OKTA_AGENT_ALGORITHM\)/);
  });

  it("rejects a workload key under another explicit method", () => {
    expect(() => resolve({ identityMethod: "okta_ai_agent", workloadPrivateKey: WORKLOAD_PEM })).toThrow(
      /only by identityMethod 'keycloak_workload'/
    );
    expect(() =>
      resolve({
        identityMethod: "openbox_did",
        agentDid: GOLDEN_DID,
        agentPrivateKey: GOLDEN_SEED,
        workloadPrivateKey: WORKLOAD_PEM
      })
    ).toThrow(OpenBoxConfigError);
  });

  it("lists keycloak_workload among selectable methods and still refuses legacy_unsigned", () => {
    expect(() => resolve({ identityMethod: "legacy_unsigned" as never })).toThrow(/keycloak_workload/);
  });
});

describe("workload environment precedence (explicit > prefixed > global)", () => {
  const environ = {
    OPENBOX_WORKLOAD_PRIVATE_KEY: WORKLOAD_PEM,
    OPENBOX_FRAMEWORK_WORKLOAD_PRIVATE_KEY: OTHER_WORKLOAD_PEM
  };

  it("resolves the global variable", () => {
    const config = OpenBoxConfig.resolve({ ...BASE, environ: { OPENBOX_WORKLOAD_PRIVATE_KEY: WORKLOAD_PEM } });
    expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
  });

  it("prefers the SDK-prefixed variable over the global one", () => {
    const config = OpenBoxConfig.resolve({ ...BASE, envPrefix: "OPENBOX_FRAMEWORK", environ });
    expect(config.resolvedWorkloadPrivateKey()).toBe(OTHER_WORKLOAD_PEM);
  });

  it("lets an empty prefixed variable fall through to the global key instead of shadowing it", () => {
    for (const blank of ["", "  "]) {
      const config = OpenBoxConfig.resolve({
        ...BASE,
        envPrefix: "OPENBOX_FRAMEWORK",
        environ: { OPENBOX_FRAMEWORK_WORKLOAD_PRIVATE_KEY: blank, OPENBOX_WORKLOAD_PRIVATE_KEY: WORKLOAD_PEM }
      });
      expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
      expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
    }
  });

  it("prefers an explicit value over both variables", () => {
    const explicit = fakePrivateKeyPem("explicit");
    const config = OpenBoxConfig.resolve({
      ...BASE,
      envPrefix: "OPENBOX_FRAMEWORK",
      environ,
      workloadPrivateKey: explicit
    });
    expect(config.resolvedWorkloadPrivateKey()).toBe(explicit);
  });

  it("accepts keycloak_workload through the AGENT_IDENTITY_METHOD variable, enabling the alias", () => {
    const config = OpenBoxConfig.resolve({
      ...BASE,
      environ: { OPENBOX_AGENT_IDENTITY_METHOD: "keycloak_workload", OPENBOX_OKTA_AGENT_PRIVATE_KEY: WORKLOAD_PEM }
    });
    expect(config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
  });

  it("rejects a prefixed workload key colliding with a global Okta key", () => {
    expect(() =>
      OpenBoxConfig.resolve({
        ...BASE,
        envPrefix: "OPENBOX_FRAMEWORK",
        environ: {
          OPENBOX_FRAMEWORK_WORKLOAD_PRIVATE_KEY: WORKLOAD_PEM,
          OPENBOX_OKTA_AGENT_PRIVATE_KEY: OTHER_WORKLOAD_PEM
        }
      })
    ).toThrow(OpenBoxConfigError);
  });
});

describe("workload key redaction", () => {
  it("never exposes the workload key through JSON or inspection", () => {
    const config = resolve({ workloadPrivateKey: WORKLOAD_PEM });
    const serialized = JSON.stringify(config);
    const inspected = inspect(config, { depth: 5 });
    for (const view of [serialized, inspected]) {
      expect(view).not.toContain("PRIVATE KEY");
      expect(view).not.toContain(BASE.apiKey);
      expect(view).toContain("[REDACTED]");
    }
  });
});

describe("OpenBoxClient.fromConfig enforces identity checks even with validate: false", () => {
  it("rejects conflicting modes before any request", () => {
    const fetchImpl = vi.fn();
    const config = OpenBoxConfig.resolve({
      ...BASE,
      environ: {},
      validate: false,
      workloadPrivateKey: WORKLOAD_PEM,
      oktaAgentPrivateKey: OTHER_WORKLOAD_PEM
    });
    expect(() => OpenBoxClient.fromConfig(config, { fetchImpl: fetchImpl as unknown as typeof fetch })).toThrow(
      OpenBoxConfigError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["an undersized RSA key", UNDERSIZED_PEM, /at least 2048 bits/],
    ["a non-RSA key", EC_PEM, /expected an RSA key/],
    ["a non-PEM value", "not a key", /PKCS8 PEM/]
  ])("rejects %s locally, naming workloadPrivateKey without key bytes", (_label, pem, pattern) => {
    const fetchImpl = vi.fn();
    const config = OpenBoxConfig.resolve({ ...BASE, environ: {}, validate: false, workloadPrivateKey: pem });
    let error: unknown;
    try {
      OpenBoxClient.fromConfig(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OpenBoxConfigError);
    expect((error as Error).message).toMatch(/workloadPrivateKey/);
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toContain("MII");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps each resolved mode to exactly one client identity option", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const workload = OpenBoxClient.fromConfig(resolve({ workloadPrivateKey: WORKLOAD_PEM }), { fetchImpl });
    const unsigned = OpenBoxClient.fromConfig(resolve({}), { fetchImpl });
    const did = OpenBoxClient.fromConfig(resolve({ agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED }), {
      fetchImpl
    });
    const okta = OpenBoxClient.fromConfig(resolve({ oktaAgentPrivateKey: WORKLOAD_PEM }), { fetchImpl });
    expect(workload.toJSON()["contractVersion"]).toBe(3);
    expect(unsigned.toJSON()["contractVersion"]).toBe(1);
    expect(did.toJSON()["contractVersion"]).toBe(1);
    expect(okta.toJSON()["contractVersion"]).toBe(2);
  });
});
