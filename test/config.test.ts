import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { OpenBoxConfig } from "../src/config/index.js";
import { OpenBoxAuthError, OpenBoxConfigError, OpenBoxInsecureURLError } from "../src/errors/index.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function resolve(overrides: Record<string, unknown>): OpenBoxConfig {
  return OpenBoxConfig.resolve({ environ: {}, ...overrides });
}

describe("OpenBoxConfig.resolve — layered env", () => {
  it("applies precedence: explicit > prefixed env > global env", () => {
    const cfg = OpenBoxConfig.resolve({
      envPrefix: "OPENBOX_FW",
      environ: {
        OPENBOX_API_KEY: "obx_test_global",
        OPENBOX_FW_API_KEY: "obx_test_prefixed",
        OPENBOX_API_URL: "https://global.example.com"
      },
      apiKey: "obx_test_explicit"
    });
    expect(cfg.apiKey).toBe("obx_test_explicit"); // explicit wins
    expect(cfg.apiUrl).toBe("https://global.example.com"); // global used when no explicit/prefixed
  });

  it("prefers prefixed env over global env", () => {
    const cfg = OpenBoxConfig.resolve({
      envPrefix: "OPENBOX_FW",
      environ: {
        OPENBOX_API_URL: "https://global.example.com",
        OPENBOX_FW_API_URL: "https://prefixed.example.com",
        OPENBOX_API_KEY: "obx_test_k"
      }
    });
    expect(cfg.apiUrl).toBe("https://prefixed.example.com");
  });
});

describe("OpenBoxConfig.normalized — validation", () => {
  it("requires apiUrl and apiKey", () => {
    expect(() => resolve({ apiKey: "obx_test_k" })).toThrow(OpenBoxConfigError);
    expect(() => resolve({ apiUrl: "https://x.com" })).toThrow(OpenBoxConfigError);
  });

  it("strips trailing slashes from apiUrl", () => {
    expect(resolve({ apiUrl: "https://x.com/", apiKey: "obx_test_k" }).apiUrl).toBe("https://x.com");
  });

  it("rejects malformed API keys", () => {
    expect(() => resolve({ apiUrl: "https://x.com", apiKey: "nope" })).toThrow(OpenBoxAuthError);
    expect(resolve({ apiUrl: "https://x.com", apiKey: "obx_live_abc" }).apiKey).toBe("obx_live_abc");
  });

  it("accepts an OpenShell provider placeholder for its bound local endpoint", () => {
    const apiKey = "openshell:resolve:env:OPENBOX_API_KEY";
    const config = resolve({
      apiUrl: "http://host.openshell.internal:8086",
      apiKey
    });

    expect(config.apiKey).toBe(apiKey);
    expect(config.apiUrl).toBe("http://host.openshell.internal:8086");
  });

  it("accepts an OpenShell revision-scoped provider placeholder", () => {
    const apiKey = "openshell:resolve:env:v12_OPENBOX_API_KEY";

    expect(resolve({
      apiUrl: "http://host.openshell.internal:8086",
      apiKey
    }).apiKey).toBe(apiKey);
  });

  it("does not treat other placeholders or ordinary keys as OpenShell endpoint authorization", () => {
    expect(() => resolve({
      apiUrl: "http://host.openshell.internal:8086",
      apiKey: "openshell:resolve:env:OTHER_API_KEY"
    })).toThrow(OpenBoxInsecureURLError);
    expect(() => resolve({
      apiUrl: "http://host.openshell.internal:8086",
      apiKey: "obx_test_k"
    })).toThrow(OpenBoxInsecureURLError);
  });

  it("accepts the fail_closed_destructive outage policy", () => {
    expect(
      resolve({ apiUrl: "https://x.com", apiKey: "obx_test_k", onApiError: "fail_closed_destructive" })
        .onApiError
    ).toBe("fail_closed_destructive");
  });

  it("rejects a non-numeric timeout and an invalid onApiError", () => {
    expect(() =>
      resolve({ apiUrl: "https://x.com", apiKey: "obx_test_k", timeoutSeconds: "abc" })
    ).toThrow(OpenBoxConfigError);
    expect(() =>
      resolve({ apiUrl: "https://x.com", apiKey: "obx_test_k", onApiError: "nope" })
    ).toThrow(OpenBoxConfigError);
  });
});

describe("URL security (D18) — exact-match localhost, never substring", () => {
  const key = "obx_test_k";
  it("accepts http only for exact localhost / 127.0.0.1 / [::1]", () => {
    expect(resolve({ apiUrl: "http://localhost:8080", apiKey: key }).apiUrl).toContain("localhost");
    expect(resolve({ apiUrl: "http://127.0.0.1:8080", apiKey: key }).apiUrl).toContain("127.0.0.1");
    expect(resolve({ apiUrl: "http://[::1]:8080", apiKey: key }).apiUrl).toContain("::1");
  });

  it("rejects http for look-alike hosts and credential-embedded hosts", () => {
    expect(() => resolve({ apiUrl: "http://localhost.evil.com", apiKey: key })).toThrow(
      OpenBoxInsecureURLError
    );
    expect(() => resolve({ apiUrl: "http://127.0.0.1.evil.com", apiKey: key })).toThrow(
      OpenBoxInsecureURLError
    );
    expect(() => resolve({ apiUrl: "http://user:pass@evil.com", apiKey: key })).toThrow(
      OpenBoxInsecureURLError
    );
  });

  it("accepts https for any host", () => {
    expect(resolve({ apiUrl: "https://api.openbox.ai", apiKey: key }).apiUrl).toBe(
      "https://api.openbox.ai"
    );
  });
});

describe("DID / private-key pairing + loadIdentity", () => {
  const base = { apiUrl: "https://x.com", apiKey: "obx_test_k" };

  it("requires DID and private key together", () => {
    expect(() => resolve({ ...base, agentDid: GOLDEN_DID })).toThrow(OpenBoxConfigError);
    expect(() => resolve({ ...base, agentPrivateKey: GOLDEN_SEED })).toThrow(OpenBoxConfigError);
  });

  it("loadIdentity returns null when unsigned, an identity when both present", () => {
    expect(resolve(base).loadIdentity()).toBeNull();
    const identity = resolve({ ...base, agentDid: GOLDEN_DID, agentPrivateKey: GOLDEN_SEED }).loadIdentity();
    expect(identity?.agentDid).toBe(GOLDEN_DID);
  });
});

describe("secret redaction", () => {
  it("never exposes the private-key seed or API key via JSON.stringify or console.log", () => {
    const cfg = resolve({
      apiUrl: "https://x.com",
      apiKey: "obx_live_supersecret",
      agentDid: GOLDEN_DID,
      agentPrivateKey: GOLDEN_SEED
    });
    expect(JSON.stringify(cfg)).not.toContain(GOLDEN_SEED);
    expect(JSON.stringify(cfg)).not.toContain("obx_live_supersecret");
    expect(inspect(cfg)).not.toContain(GOLDEN_SEED);
    expect(cfg.toJSON()["agentPrivateKey"]).toBe("[REDACTED]");
    expect(cfg.toJSON()["apiKey"]).toBe("[REDACTED]");
  });
});

describe("timeout resolution", () => {
  it("rejects a blank timeout env var (never silently becomes a 0ms timeout)", () => {
    expect(() =>
      OpenBoxConfig.resolve({
        environ: { OPENBOX_TIMEOUT_SECONDS: "" },
        apiUrl: "https://x.com",
        apiKey: "obx_test_k"
      })
    ).toThrow(OpenBoxConfigError);
  });
});
