import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AgentIdentity,
  EMPTY_BODY_SHA256,
  HEADER_BODY_SHA256,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  buildCanonicalString,
  prepareSignedRequest
} from "../src/identity/index.js";
import { serializeBody } from "../src/serialization/index.js";

/**
 * Golden signing tests — byte parity with the pinned Python signer fixture
 * (copied verbatim from openbox-sdk-python). Proves the TS SDK reproduces the
 * signed request byte-for-byte, INCLUDING the non-ASCII `café`/`☕` payload that
 * would drift if `JSON.stringify` emitted raw UTF-8 instead of `\uXXXX` escapes.
 *
 * This anchors TS ≡ Python. TS ≡ Core is proven separately by the Phase 4
 * Core-parity gate.
 */
interface GoldenFixture {
  method: string;
  path: string;
  payload: Record<string, unknown>;
  api_key: string;
  agent_did: string;
  seed_b64: string;
  timestamp: string;
  nonce: string;
  canonical: string;
  body_b64: string;
  body_sha256: string;
  signed_headers: Record<string, string>;
  empty_body_sha256: string;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/golden-temporal-signed-request.json", import.meta.url), "utf-8")
) as GoldenFixture;

function goldenIdentity(): AgentIdentity {
  return AgentIdentity.fromPrivateKey(FIXTURE.agent_did, FIXTURE.seed_b64);
}

function signGolden(): { headers: Record<string, string>; body: Buffer } {
  return prepareSignedRequest(FIXTURE.method, FIXTURE.path, FIXTURE.payload, {
    apiKey: FIXTURE.api_key,
    identity: goldenIdentity(),
    timestamp: FIXTURE.timestamp,
    nonce: FIXTURE.nonce
  });
}

describe("golden byte parity", () => {
  it("body bytes match the fixture exactly (non-ASCII escaped)", () => {
    const { body } = signGolden();
    expect(body.equals(Buffer.from(FIXTURE.body_b64, "base64"))).toBe(true);
  });

  it("body hash is SHA-256 of the transmitted bytes", () => {
    const { headers, body } = signGolden();
    expect(createHash("sha256").update(body).digest("hex")).toBe(FIXTURE.body_sha256);
    expect(headers[HEADER_BODY_SHA256]).toBe(FIXTURE.body_sha256);
  });

  it("canonical string matches", () => {
    const canonical = buildCanonicalString(
      FIXTURE.method,
      FIXTURE.path,
      FIXTURE.timestamp,
      FIXTURE.nonce,
      FIXTURE.body_sha256
    );
    expect(canonical).toBe(FIXTURE.canonical);
  });

  it("signature matches the golden fixture", () => {
    const { headers } = signGolden();
    expect(headers[HEADER_SIGNATURE]).toBe(FIXTURE.signed_headers[HEADER_SIGNATURE]);
  });

  it("all signed headers match", () => {
    const { headers } = signGolden();
    for (const [name, expected] of Object.entries(FIXTURE.signed_headers)) {
      expect(headers[name], `header ${name} diverged`).toBe(expected);
    }
  });

  it("signature is padded standard base64, 64 bytes", () => {
    const { headers } = signGolden();
    const sig = headers[HEADER_SIGNATURE]!;
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(sig, "base64").length).toBe(64);
  });
});

describe("signing contract invariants", () => {
  it("signing timestamp keeps +00:00, never Z", () => {
    expect(FIXTURE.timestamp.endsWith("+00:00")).toBe(true);
    const { headers } = signGolden();
    expect(headers[HEADER_TIMESTAMP]!.endsWith("+00:00")).toBe(true);
    expect(headers[HEADER_TIMESTAMP]!.endsWith("Z")).toBe(false);
  });

  it("path includes the /api/v1 prefix", () => {
    expect(FIXTURE.path.startsWith("/api/v1/")).toBe(true);
    expect(FIXTURE.canonical.split("\n")[1]).toBe(FIXTURE.path);
  });

  it("empty-body hash is the pinned constant", () => {
    expect(createHash("sha256").update(Buffer.alloc(0)).digest("hex")).toBe(EMPTY_BODY_SHA256);
    expect(FIXTURE.empty_body_sha256).toBe(EMPTY_BODY_SHA256);
  });

  it("null payload serializes to empty bytes + empty-body hash", () => {
    const { headers, body } = prepareSignedRequest("GET", "/api/v1/auth/validate", null, {
      apiKey: FIXTURE.api_key,
      identity: goldenIdentity(),
      timestamp: FIXTURE.timestamp,
      nonce: FIXTURE.nonce
    });
    expect(body.length).toBe(0);
    expect(headers[HEADER_BODY_SHA256]).toBe(EMPTY_BODY_SHA256);
  });

  it("serializes with compact separators (no spaces)", () => {
    expect(serializeBody({ a: 1, b: [1, 2] }).toString("utf-8")).toBe('{"a":1,"b":[1,2]}');
  });

  it("unsigned mode omits AIP headers but keeps bearer auth", () => {
    const { headers } = prepareSignedRequest("POST", FIXTURE.path, { x: 1 }, {
      apiKey: FIXTURE.api_key,
      identity: null
    });
    expect(Object.keys(headers).some((h) => h.startsWith("X-OpenBox-Agent"))).toBe(false);
    expect(headers["Authorization"]).toBe(`Bearer ${FIXTURE.api_key}`);
  });
});

describe("alternate signing inputs", () => {
  it("a Z timestamp produces different signed bytes (format guard)", () => {
    const identity = goldenIdentity();
    const zTimestamp = FIXTURE.timestamp.replace("+00:00", "Z");
    expect(zTimestamp).not.toBe(FIXTURE.timestamp);

    const zCanonical = buildCanonicalString(
      FIXTURE.method,
      FIXTURE.path,
      zTimestamp,
      FIXTURE.nonce,
      FIXTURE.body_sha256
    );
    expect(zCanonical).not.toBe(FIXTURE.canonical);
    expect(identity.sign(zCanonical)).not.toBe(identity.sign(FIXTURE.canonical));
  });
});
