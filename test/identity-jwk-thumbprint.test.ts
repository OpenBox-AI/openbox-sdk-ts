import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OpenBoxConfigError } from "../src/errors/index.js";
import { jwkThumbprintSha256, thumbprintsMatch } from "../src/identity/jwk-thumbprint.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "identity-v2");

/**
 * The RFC 7638 thumbprint of fixtures/identity-v2/keypair.json's public_jwk.
 *
 * This exact literal is also pinned in openbox-core and openbox-sdk-python
 * against their byte-identical copies of the same fixture. Bootstrap compares
 * Core's value against this SDK's locally derived one, so a canonicalization
 * drift in any of the three repos must fail a test rather than silently break
 * every bootstrapping client. Pinned, never re-derived from the same code under
 * test.
 */
const FIXTURE_THUMBPRINT = "P8EMAIrSnD-kQcn47Cpq_LlDPywhP3mqfM1RhwySFdk";
const FIXTURE_UNDERSIZED_THUMBPRINT = "mvZ_gJ0t0lSgT1112pD9yjrvBBi0-20HzVE7nzfz41c";

interface FixtureKeypair {
  private_jwk: JsonWebKey;
  public_jwk: JsonWebKey;
  undersized_key_for_negative_test: { private_jwk: JsonWebKey; public_jwk: JsonWebKey };
}

function fixtureKeypair(): FixtureKeypair {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "keypair.json"), "utf8")) as FixtureKeypair;
}

describe("jwkThumbprintSha256", () => {
  it("matches the pinned cross-repo fixture vector", () => {
    const kp = fixtureKeypair();

    // Derived from the PRIVATE key — the direction the SDK actually uses.
    const fromPrivate = createPrivateKey({ key: kp.private_jwk, format: "jwk" });
    expect(jwkThumbprintSha256(fromPrivate)).toBe(FIXTURE_THUMBPRINT);

    // And from the public key, which must agree.
    const fromPublic = createPublicKey({ key: kp.public_jwk, format: "jwk" });
    expect(jwkThumbprintSha256(fromPublic)).toBe(FIXTURE_THUMBPRINT);
  });

  it("matches RFC 7638 §3.1's own published reference vector", () => {
    // Independent of the fixture: proves the implementation follows the standard,
    // so a mistake replicated across all three repos would still be caught.
    const rfcJwk: JsonWebKey = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29"
    };
    const key = createPublicKey({ key: rfcJwk, format: "jwk" });
    expect(jwkThumbprintSha256(key)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("ignores kid/alg/use, which the SDK never knows locally", () => {
    const { n, e } = fixtureKeypair().public_jwk;
    expect(n).toBeTypeOf("string");
    expect(e).toBeTypeOf("string");

    // The fixture's public_jwk carries kid/alg/use; a key rebuilt from only the
    // required members must still produce the same thumbprint.
    const minimal = createPublicKey({
      key: { kty: "RSA", n: n as string, e: e as string },
      format: "jwk"
    });
    expect(jwkThumbprintSha256(minimal)).toBe(FIXTURE_THUMBPRINT);
  });

  it("distinguishes different keys", () => {
    const kp = fixtureKeypair();
    const undersized = createPublicKey({
      key: kp.undersized_key_for_negative_test.public_jwk,
      format: "jwk"
    });
    expect(jwkThumbprintSha256(undersized)).toBe(FIXTURE_UNDERSIZED_THUMBPRINT);
    expect(jwkThumbprintSha256(undersized)).not.toBe(FIXTURE_THUMBPRINT);
  });

  it("produces unpadded base64url of a 32-byte digest", () => {
    const kp = fixtureKeypair();
    const thumbprint = jwkThumbprintSha256(createPrivateKey({ key: kp.private_jwk, format: "jwk" }));

    expect(thumbprint).not.toContain("=");
    expect(thumbprint).not.toContain("+");
    expect(thumbprint).not.toContain("/");
    expect(Buffer.from(thumbprint, "base64url")).toHaveLength(32);
  });

  it("rejects a non-RSA key rather than producing a wrong digest", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => jwkThumbprintSha256(privateKey)).toThrow(OpenBoxConfigError);
    // The error must not echo key material.
    try {
      jwkThumbprintSha256(privateKey);
    } catch (e) {
      expect((e as Error).message).toContain("key bytes not shown");
    }
  });
});

describe("thumbprintsMatch", () => {
  it("is true for identical values and false otherwise", () => {
    expect(thumbprintsMatch(FIXTURE_THUMBPRINT, FIXTURE_THUMBPRINT)).toBe(true);
    expect(thumbprintsMatch(FIXTURE_THUMBPRINT, FIXTURE_UNDERSIZED_THUMBPRINT)).toBe(false);
  });

  it("returns false — never throws — on a length mismatch", () => {
    // timingSafeEqual throws on unequal lengths; the helper must absorb that.
    expect(thumbprintsMatch(FIXTURE_THUMBPRINT, "short")).toBe(false);
    expect(thumbprintsMatch("", FIXTURE_THUMBPRINT)).toBe(false);
    expect(thumbprintsMatch("", "")).toBe(true);
  });

  it("detects a single-character difference", () => {
    const tampered = `${FIXTURE_THUMBPRINT.slice(0, -1)}X`;
    expect(tampered).toHaveLength(FIXTURE_THUMBPRINT.length);
    expect(thumbprintsMatch(FIXTURE_THUMBPRINT, tampered)).toBe(false);
  });
});
