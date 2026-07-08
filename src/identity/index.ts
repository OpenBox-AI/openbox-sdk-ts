/**
 * AgentIdentity — AIP DID validation and Ed25519 request signing.
 *
 * Implements the Core signed-request contract. Canonical string (matches Core
 * `internal/services/agent.go` `BuildAgentIdentityCanonicalRequest`):
 *
 *     UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 *
 * Contract invariants:
 * - NO trailing newline (join of 5 fields). PATH includes `/api/v1`; no host/query.
 * - The signing TIMESTAMP keeps a `+00:00` offset and NEVER uses `Z` (the
 *   event-payload timestamp is a different field with `Z`).
 * - NONCE is a CSPRNG value (never Math.random).
 * - Signature is standard padded base64 of the Ed25519 signature over the
 *   canonical string's UTF-8 bytes.
 * - Body bytes are produced ONCE by `serializeBody` and sent verbatim — the SDK
 *   must never re-serialize (that would break Core's body-hash verification).
 *
 * `node:crypto` is imported here; this module is off the import-light root.
 */

import { createHash, createPrivateKey, randomBytes, sign as ed25519Sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { OpenBoxConfigError } from "../errors/index.js";
import { serializeBody } from "../serialization/index.js";
import {
  DEFAULT_SDK_ENGINE,
  DEFAULT_SDK_LANGUAGE,
  buildSdkIdentifier
} from "./sdk-identifier.js";

// Agent DID prefix; the suffix must be a canonical UUID.
export const AGENT_DID_PREFIX = "did:aip:";

// SHA-256 of empty bytes — body hash for GET / empty-body requests.
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// AIP signed-request header names (Core agent.go).
export const HEADER_DID = "X-OpenBox-Agent-DID";
export const HEADER_TIMESTAMP = "X-OpenBox-Agent-Timestamp";
export const HEADER_NONCE = "X-OpenBox-Agent-Nonce";
export const HEADER_SIGNATURE = "X-OpenBox-Agent-Signature";
export const HEADER_BODY_SHA256 = "X-OpenBox-Body-SHA256";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Node's createPrivateKey rejects a bare 32-byte seed and a JWK `d`-only key.
// The seed must be wrapped in this exact PKCS8 DER prefix for an Ed25519 key
// (verified byte-identical to Python's Ed25519PrivateKey.from_private_bytes).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Validate an agent DID (`did:aip:<uuid>`). Parses the suffix as a canonical
 * UUID so a malformed layout fails locally at init rather than as a Core 4xx.
 */
export function validateAgentDid(agentDid: string): void {
  if (typeof agentDid !== "string" || !agentDid.startsWith(AGENT_DID_PREFIX)) {
    const shown = String(agentDid).slice(0, 24);
    throw new OpenBoxConfigError(
      `Invalid agent DID format. Expected 'did:aip:<uuid>', got: '${shown}...' (showing first 24 chars)`
    );
  }
  const suffix = agentDid.slice(AGENT_DID_PREFIX.length);
  if (!UUID_RE.test(suffix)) {
    throw new OpenBoxConfigError(
      `Invalid agent DID: '${agentDid.slice(0, 24)}...' — the part after '${AGENT_DID_PREFIX}' is not a valid UUID.`
    );
  }
}

/**
 * Decode a base64 raw 32-byte Ed25519 seed and load a private key.
 * Never echoes key bytes in error messages — the seed is non-repudiation
 * material. Raises `OpenBoxConfigError` on bad base64, wrong length, or load error.
 */
export function loadEd25519Seed(agentPrivateKey: string): KeyObject {
  if (typeof agentPrivateKey !== "string" || !BASE64_RE.test(agentPrivateKey)) {
    throw new OpenBoxConfigError(
      "Invalid agent private key: not valid base64 (key bytes not shown)."
    );
  }
  const seed = Buffer.from(agentPrivateKey, "base64");
  if (seed.length !== 32) {
    throw new OpenBoxConfigError(
      `Invalid agent private key: expected a 32-byte Ed25519 seed, got ${seed.length} bytes (key bytes not shown).`
    );
  }
  try {
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new OpenBoxConfigError(
      "Invalid agent private key: could not load Ed25519 key (key bytes not shown)."
    );
  }
}

/** A validated agent DID plus its loaded Ed25519 signer. */
export class AgentIdentity {
  readonly agentDid: string;
  // The loaded key OBJECT — never raw seed bytes after init.
  private readonly signer: KeyObject;

  constructor(agentDid: string, signer: KeyObject) {
    this.agentDid = agentDid;
    this.signer = signer;
  }

  /** Validate the DID, decode + load the seed, return a ready identity. */
  static fromPrivateKey(agentDid: string, agentPrivateKey: string): AgentIdentity {
    validateAgentDid(agentDid);
    return new AgentIdentity(agentDid, loadEd25519Seed(agentPrivateKey));
  }

  /** Sign a canonical string; return standard padded base64. */
  sign(canonical: string): string {
    // Ed25519 uses no separate digest, so the algorithm argument is null.
    return ed25519Sign(null, Buffer.from(canonical, "utf-8"), this.signer).toString("base64");
  }
}

/** The exact canonical string Core verifies (no trailing newline). */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodySha256: string
): string {
  return [method.toUpperCase(), path, timestamp, nonce, bodySha256].join("\n");
}

/** Standard bearer auth headers for governance API calls. */
export function buildAuthHeaders(
  apiKey: string,
  sdkVersion: string | null = null,
  options?: { sdkEngine?: string; sdkLanguage?: string }
): Record<string, string> {
  const sdkIdentifier = buildSdkIdentifier({
    engine: options?.sdkEngine ?? DEFAULT_SDK_ENGINE,
    language: options?.sdkLanguage ?? DEFAULT_SDK_LANGUAGE,
    version: sdkVersion
  });
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": `OpenBox-SDK/${sdkIdentifier}`,
    "X-OpenBox-SDK-Version": sdkIdentifier
  };
}

/** Generate a fresh CSPRNG nonce (24 random bytes, url-safe base64, no padding). */
export function generateNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Current signing timestamp: `+00:00` offset (never `Z`), sub-second precision. */
function signingTimestampNow(): string {
  // toISOString() gives "...123Z"; the signing timestamp keeps a +00:00 offset.
  return new Date().toISOString().replace("Z", "000+00:00");
}

export interface PrepareSignedRequestOptions {
  apiKey: string;
  identity: AgentIdentity | null;
  sdkVersion?: string | null;
  sdkEngine?: string;
  sdkLanguage?: string;
  /** Deterministic injection for golden-fixture tests ONLY (never in production). */
  timestamp?: string;
  /** Deterministic injection for golden-fixture tests ONLY (never in production). */
  nonce?: string;
}

/**
 * Build request headers + the exact body bytes — the single source of truth.
 * Callers MUST send `body` verbatim (never re-serialize) so the transmitted
 * bytes match the hashed bytes. Signed headers are added only when an identity
 * is provided (DID + private key configured).
 */
export function prepareSignedRequest(
  method: string,
  path: string,
  payload: unknown,
  options: PrepareSignedRequestOptions
): { headers: Record<string, string>; body: Buffer } {
  const body = serializeBody(payload);
  const headers = buildAuthHeaders(options.apiKey, options.sdkVersion ?? null, {
    sdkEngine: options.sdkEngine ?? DEFAULT_SDK_ENGINE,
    sdkLanguage: options.sdkLanguage ?? DEFAULT_SDK_LANGUAGE
  });

  if (options.identity !== null) {
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const timestamp = options.timestamp ?? signingTimestampNow();
    const nonce = options.nonce ?? generateNonce();
    const canonical = buildCanonicalString(method, path, timestamp, nonce, bodySha256);
    headers[HEADER_DID] = options.identity.agentDid;
    headers[HEADER_TIMESTAMP] = timestamp;
    headers[HEADER_NONCE] = nonce;
    headers[HEADER_SIGNATURE] = options.identity.sign(canonical);
    headers[HEADER_BODY_SHA256] = bodySha256;
  }

  return { headers, body };
}
