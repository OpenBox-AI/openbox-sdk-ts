import { createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OpenBoxConfigError } from "../src/errors/index.js";
import {
  AgentIdentity,
  buildAuthHeaders,
  buildCanonicalString,
  generateNonce,
  loadEd25519Seed,
  validateAgentDid
} from "../src/identity/index.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 bytes 0..31

describe("validateAgentDid", () => {
  it("accepts a canonical did:aip:<uuid>", () => {
    expect(() => validateAgentDid(GOLDEN_DID)).not.toThrow();
  });

  it("rejects a bad prefix or non-UUID suffix", () => {
    expect(() => validateAgentDid("did:web:example.com")).toThrow(OpenBoxConfigError);
    expect(() => validateAgentDid("did:aip:not-a-uuid")).toThrow(OpenBoxConfigError);
  });
});

describe("loadEd25519Seed", () => {
  it("loads a valid 32-byte seed", () => {
    expect(loadEd25519Seed(GOLDEN_SEED).type).toBe("private");
  });

  it("rejects invalid base64 and wrong-length seeds (without echoing key bytes)", () => {
    expect(() => loadEd25519Seed("!!!not base64!!!")).toThrow(OpenBoxConfigError);
    expect(() => loadEd25519Seed(Buffer.alloc(16).toString("base64"))).toThrow(OpenBoxConfigError);
  });

  it("PKCS8-DER wrap is REQUIRED — a bare raw seed does not load (regression guard)", () => {
    // Guards against a future "simplification" that drops the PKCS8 DER prefix.
    const rawSeed = Buffer.from(GOLDEN_SEED, "base64");
    expect(() => createPrivateKey({ key: rawSeed, format: "der", type: "pkcs8" })).toThrow();
  });
});

describe("AgentIdentity", () => {
  it("signs canonical strings as padded base64 (64-byte Ed25519 signature)", () => {
    const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const sig = identity.sign("POST\n/api/v1/x\nts\nnonce\nhash");
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(sig, "base64").length).toBe(64);
  });
});

describe("buildCanonicalString", () => {
  it("joins 5 upper-cased fields with \\n and no trailing newline", () => {
    const canonical = buildCanonicalString("post", "/api/v1/x", "ts", "nonce", "hash");
    expect(canonical).toBe("POST\n/api/v1/x\nts\nnonce\nhash");
    expect(canonical.split("\n")).toHaveLength(5);
    expect(canonical.endsWith("\n")).toBe(false);
  });
});

describe("buildAuthHeaders", () => {
  it("emits bearer auth + framework-branded SDK identifier", () => {
    const headers = buildAuthHeaders("obx_test_k");
    expect(headers["Authorization"]).toBe("Bearer obx_test_k");
    expect(headers["User-Agent"]).toMatch(/^OpenBox-SDK\/openbox-base-typescript-v\d/);
    expect(headers["X-OpenBox-SDK-Version"]).toMatch(/^openbox-base-typescript-v\d/);
  });
});

describe("generateNonce", () => {
  it("produces distinct url-safe base64 values", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBe(32);
  });
});
