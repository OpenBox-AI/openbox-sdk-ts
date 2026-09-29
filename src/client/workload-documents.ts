/**
 * Strict parsing for the IAM v3 workload documents: Core's active bootstrap
 * (`GET /api/v3/auth/bootstrap`), Core's candidate bootstrap
 * (`GET /api/v3/auth/workload-transition/bootstrap`), and Keycloak's
 * client-credentials token response.
 *
 * Pure: no network, crypto, or logging. Every check fails closed with a
 * sanitized `OpenBoxWorkloadAuthError`, before any token exchange or governed
 * request. Parsing is NOT cryptographic proof — Keycloak proves private-key
 * possession and Core verifies the resulting token against current authority —
 * so nothing here claims a key or thumbprint check it cannot perform (the v3
 * document carries no thumbprint). Values are taken from Core verbatim; nothing
 * local is merged into them.
 */

import { OpenBoxWorkloadAuthError, type WorkloadAuthStage } from "../errors/workload.js";
import { isLoopbackHostname } from "../config/url-security.js";

export const WORKLOAD_BOOTSTRAP_VERSION = 3;
export const WORKLOAD_CONTRACT_VERSION = 3;
/** Keycloak's token path relative to the realm issuer. */
export const TOKEN_ENDPOINT_SUFFIX = "/protocol/openid-connect/token";
/** Renew this long before the cached expiry (Python parity). */
export const ACCESS_TOKEN_REFRESH_MARGIN_SECONDS = 30;
/** Never cache a token longer than this, whatever `expires_in` says (Python parity). */
export const MAX_ACCESS_TOKEN_CACHE_SECONDS = 300;

export const WORKLOAD_IDENTITY_SOURCES = ["openbox", "okta", "entra"] as const;
/** Where the workload identity comes from — metadata only, never an authentication switch. */
export type WorkloadIdentitySource = (typeof WORKLOAD_IDENTITY_SOURCES)[number];

/** Validated, immutable, non-secret metadata for the agent's active service account. */
export interface WorkloadBootstrapDocument {
  readonly bootstrapVersion: 3;
  readonly contractVersion: 3;
  readonly tokenEndpoint: string;
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  /** The OpenBox service-account record id — not the token's Keycloak `sub`. */
  readonly serviceAccountId: string;
  readonly activationVersion: string;
  readonly identitySource: WorkloadIdentitySource;
  readonly kid: string;
}

/** Validated metadata for one prepared, not-yet-active candidate service account. */
export interface WorkloadTransitionBootstrapDocument {
  readonly bootstrapVersion: 3;
  readonly contractVersion: 3;
  readonly transitionId: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly kid: string;
  readonly identitySource: WorkloadIdentitySource;
  /** RFC 3339 timestamp with an explicit offset, as returned by Core. */
  readonly expiresAt: string;
}

/** A validated token response. `cacheSeconds` is already capped. */
export interface WorkloadAccessTokenResponse {
  readonly accessToken: string;
  readonly cacheSeconds: number;
}

type Json = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
// RFC 3339 date-time with a mandatory offset (`Z` or `±hh:mm`); Go marshals time.Time this way.
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
// A header-safe opaque token: visible ASCII only (JWTs are base64url segments and dots).
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * The canonical lowercase form of a hyphenated UUID, or null when `value` is
 * not one. Case-insensitive on input (RFC 9562), lowercase on output (Go's
 * `uuid.UUID` marshaling).
 */
export function canonicalUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function fail(stage: WorkloadAuthStage, message: string): never {
  throw new OpenBoxWorkloadAuthError(message, { stage });
}

function requireObject(raw: unknown, what: string, stage: WorkloadAuthStage): Json {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(stage, `${what} is invalid: expected a JSON object.`);
  }
  return raw as Json;
}

function requireVersions(body: Json, what: string, stage: WorkloadAuthStage): void {
  for (const [key, expected] of [
    ["bootstrap_version", WORKLOAD_BOOTSTRAP_VERSION],
    ["contract_version", WORKLOAD_CONTRACT_VERSION]
  ] as const) {
    if (body[key] !== expected) {
      fail(
        stage,
        `Unsupported ${what} ${key} ${JSON.stringify(body[key])}; this SDK supports ${expected}. ` +
          "Upgrade the OpenBox SDK to match your Core deployment."
      );
    }
  }
}

function requireString(body: Json, key: string, what: string, stage: WorkloadAuthStage): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(stage, `${what} is invalid: '${key}' must be a non-empty string.`);
  }
  return value;
}

function requireUuid(body: Json, key: string, what: string, stage: WorkloadAuthStage): string {
  const value = canonicalUuid(body[key]);
  if (value === null || value === NIL_UUID) {
    fail(stage, `${what} is invalid: '${key}' must be a canonical, non-nil UUID.`);
  }
  return value;
}

function requireSource(body: Json, what: string, stage: WorkloadAuthStage): WorkloadIdentitySource {
  const value = body["identity_source"];
  if (!(WORKLOAD_IDENTITY_SOURCES as readonly unknown[]).includes(value)) {
    fail(
      stage,
      `${what} is invalid: 'identity_source' must be one of ${WORKLOAD_IDENTITY_SOURCES.join(", ")}.`
    );
  }
  return value as WorkloadIdentitySource;
}

/**
 * Require an absolute HTTPS URL — plain HTTP only for the exact loopback hosts
 * `localhost`, `127.0.0.1`, `::1` — with no user information, query, fragment,
 * whitespace, or backslash. The host is compared exactly after parsing, never
 * by substring, so `localhost.evil.example` is not loopback.
 */
function requireSafeUrl(value: string, key: string, what: string, stage: WorkloadAuthStage): void {
  const invalid = (): never =>
    fail(
      stage,
      `${what} is invalid: '${key}' must be an absolute HTTPS URL (HTTP only for localhost, 127.0.0.1, ` +
        "or ::1) without user information, query, or fragment."
    );
  // Checked on the raw string: URL parsing silently drops an empty `?`/`#` and trims whitespace.
  if (/[\s\\?#]/.test(value)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.username || url.password) invalid();
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!secure || !url.hostname) invalid();
}

/** Core's own rule: the issuer, minus one trailing slash, plus the Keycloak token path. */
function tokenEndpointFor(issuer: string): string {
  return `${issuer.endsWith("/") ? issuer.slice(0, -1) : issuer}${TOKEN_ENDPOINT_SUFFIX}`;
}

/** Parse Core's active workload bootstrap document. */
export function parseWorkloadBootstrapDocument(raw: unknown): WorkloadBootstrapDocument {
  const stage = "bootstrap";
  const what = "Workload bootstrap response";
  const body = requireObject(raw, what, stage);
  requireVersions(body, "workload bootstrap", stage);

  const issuer = requireString(body, "issuer", what, stage);
  const tokenEndpoint = requireString(body, "token_endpoint", what, stage);
  requireSafeUrl(issuer, "issuer", what, stage);
  requireSafeUrl(tokenEndpoint, "token_endpoint", what, stage);
  if (tokenEndpoint !== tokenEndpointFor(issuer)) {
    fail(stage, `${what} is invalid: 'token_endpoint' does not belong to the advertised issuer.`);
  }

  return Object.freeze({
    bootstrapVersion: WORKLOAD_BOOTSTRAP_VERSION,
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    tokenEndpoint,
    issuer,
    audience: requireString(body, "audience", what, stage),
    clientId: requireString(body, "client_id", what, stage),
    serviceAccountId: requireUuid(body, "service_account_id", what, stage),
    activationVersion: requireUuid(body, "activation_version", what, stage),
    identitySource: requireSource(body, what, stage),
    kid: requireString(body, "kid", what, stage)
  });
}

/**
 * Parse Core's candidate bootstrap document for exactly `expectedTransitionId`
 * (canonical lowercase), requiring an `expires_at` still in the future at `nowMs`.
 */
export function parseWorkloadTransitionBootstrapDocument(
  raw: unknown,
  expectedTransitionId: string,
  nowMs: number
): WorkloadTransitionBootstrapDocument {
  const stage = "transition_bootstrap";
  const what = "Workload transition bootstrap response";
  const body = requireObject(raw, what, stage);
  requireVersions(body, "workload transition bootstrap", stage);

  if (canonicalUuid(body["transition_id"]) !== expectedTransitionId) {
    fail(stage, `${what} is invalid: 'transition_id' does not match the requested transition.`);
  }

  const tokenEndpoint = requireString(body, "token_endpoint", what, stage);
  requireSafeUrl(tokenEndpoint, "token_endpoint", what, stage);
  const issuer = tokenEndpoint.endsWith(TOKEN_ENDPOINT_SUFFIX)
    ? tokenEndpoint.slice(0, -TOKEN_ENDPOINT_SUFFIX.length)
    : "";
  if (!issuer) {
    fail(stage, `${what} is invalid: 'token_endpoint' is not a Keycloak realm token endpoint.`);
  }
  requireSafeUrl(issuer, "token_endpoint", what, stage);

  const expiresAt = requireString(body, "expires_at", what, stage);
  const expiresAtMs = RFC3339_WITH_OFFSET.test(expiresAt) ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(expiresAtMs)) {
    fail(stage, `${what} is invalid: 'expires_at' must be an RFC 3339 timestamp with a timezone offset.`);
  }
  if (expiresAtMs <= nowMs) {
    fail(stage, "The workload identity transition has expired; prepare a new transition.");
  }

  return Object.freeze({
    bootstrapVersion: WORKLOAD_BOOTSTRAP_VERSION,
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    transitionId: expectedTransitionId,
    tokenEndpoint,
    clientId: requireString(body, "client_id", what, stage),
    kid: requireString(body, "kid", what, stage),
    identitySource: requireSource(body, what, stage),
    expiresAt
  });
}

/** Parse Keycloak's client-credentials response and bound its cache lifetime. */
export function parseWorkloadTokenResponse(raw: unknown): WorkloadAccessTokenResponse {
  const stage = "token";
  const what = "Keycloak workload token response";
  const body = requireObject(raw, what, stage);

  const accessToken = body["access_token"];
  if (typeof accessToken !== "string" || !VISIBLE_ASCII.test(accessToken)) {
    fail(stage, `${what} is invalid: 'access_token' must be a non-empty token string.`);
  }
  const tokenType = body["token_type"];
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    fail(stage, `${what} is invalid: 'token_type' must be Bearer.`);
  }
  const expiresIn = body["expires_in"];
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= ACCESS_TOKEN_REFRESH_MARGIN_SECONDS
  ) {
    fail(
      stage,
      `${what} is invalid: 'expires_in' must be a number of seconds greater than ` +
        `${ACCESS_TOKEN_REFRESH_MARGIN_SECONDS}.`
    );
  }
  return { accessToken, cacheSeconds: Math.min(expiresIn, MAX_ACCESS_TOKEN_CACHE_SECONDS) };
}
