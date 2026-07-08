/**
 * OpenBox base SDK — unified error hierarchy.
 *
 * Pure module: no network, crypto, OTel, logging, or wall-clock imports; safe
 * to import from constrained framework paths. Mirrors the Python hierarchy so
 * cross-SDK error handling stays consistent.
 */

import { verdictFromString, type Verdict } from "../contracts/results.js";

/** Base class for all OpenBox SDK errors. */
export class OpenBoxError extends Error {
  constructor(message?: string) {
    super(message);
    // new.target gives the actual subclass, so every subclass gets a correct name.
    this.name = new.target.name;
  }
}

/**
 * Raised by the always-strict gate on a malformed event/runtime contract.
 *
 * Contract violations raise *before* any network send, regardless of the
 * `on_api_error` fail-open/fail-closed setting — fail-open applies only to
 * network errors, never to contract violations.
 */
export class ContractError extends OpenBoxError {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(message: string, code = "", detail: Record<string, unknown> | null = null) {
    super(message);
    this.code = code;
    this.detail = detail ?? {};
  }
}

/** Raised when OpenBox configuration fails. */
export class OpenBoxConfigError extends OpenBoxError {}

/** Raised when API key validation fails. */
export class OpenBoxAuthError extends OpenBoxConfigError {}

/** Raised when network connectivity fails. */
export class OpenBoxNetworkError extends OpenBoxConfigError {}

/** Raised when HTTP is used for a non-localhost URL. */
export class OpenBoxInsecureURLError extends OpenBoxConfigError {}

/**
 * Raised when Core rejects a signed (AIP DID) request.
 * `reasonCode` is Core's machine reason code (e.g. `signature_invalid`).
 */
export class OpenBoxSigningError extends OpenBoxAuthError {
  readonly reasonCode: string | null;

  constructor(message: string, reasonCode: string | null = null) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

// Core signed-request rejection reason codes → actionable SDK guidance.
// Forward-compatible: Core today often collapses identity failures into a
// generic body with no machine code; these richer messages activate once Core
// emits a machine reason code (`reason_code`/`code`/`reason`).
const SIGNING_REASON_MESSAGES: Record<string, string> = {
  signature_invalid:
    "Request signature rejected (signature_invalid). The signed bytes did not " +
    "match — usually a body-hash mismatch (send raw body bytes, never re-serialize) " +
    "or a wrong/rotated private key.",
  nonce_replayed:
    "Request nonce was already used (nonce_replayed). Each request must carry a " +
    "fresh nonce; do not retry a fully-prepared request verbatim.",
  did_agent_mismatch:
    "DID does not match the authenticated agent (did_agent_mismatch). Check that " +
    "agentDid matches the agent the API key/private key were provisioned for.",
  verifier_not_configured:
    "Core has no verifier for this agent (verifier_not_configured). The agent's " +
    "public key may not be imported to KMS yet — re-provision the agent.",
  // Core's code is `timestamp_outside_window`; `timestamp_skew` kept as an alias.
  timestamp_outside_window:
    "Request timestamp outside the allowed window (timestamp_outside_window). Sync " +
    "the host clock (NTP); signatures are valid only within ±300s.",
  timestamp_skew:
    "Request timestamp outside the allowed window (timestamp_skew). Sync the host " +
    "clock (NTP); signatures are valid only within ±300s."
};

/**
 * Map a Core signing reason code to an actionable `OpenBoxSigningError`.
 * Unknown/empty codes fall back to a generic message (optionally augmented with
 * `fallback`). Never throws — always returns an error to raise.
 */
export function mapSigningError(
  reasonCode: string | null | undefined,
  fallback = ""
): OpenBoxSigningError {
  if (reasonCode && reasonCode in SIGNING_REASON_MESSAGES) {
    return new OpenBoxSigningError(SIGNING_REASON_MESSAGES[reasonCode]!, reasonCode);
  }
  const msg =
    fallback ||
    "Signed request rejected by OpenBox Core" +
      (reasonCode ? ` (${reasonCode})` : "") +
      ".";
  return new OpenBoxSigningError(msg, reasonCode ?? null);
}

/**
 * Raised when governance blocks an operation (default adapter behavior).
 * Framework adapters typically translate this into a native error type.
 */
export class GovernanceBlockedError extends OpenBoxError {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly url: string;

  constructor(verdict: string, reason: string, url = "") {
    const resolved = verdictFromString(verdict);
    super(`Governance ${resolved}: ${reason}`);
    this.verdict = resolved;
    this.reason = reason;
    this.url = url;
  }
}

/**
 * Raised when governance halts execution (HALT verdict) — the framework adapter
 * decides how to stop future work.
 */
export class GovernanceHaltError extends OpenBoxError {}

/** Raised when the governance API fails and policy is fail_closed. */
export class GovernanceAPIError extends OpenBoxError {}

/** Raised when guardrails `validation_passed` is false. */
export class GuardrailsValidationError extends OpenBoxError {
  readonly reasons: string[];

  constructor(reasons: string[] | null = null) {
    const list = reasons ?? [];
    super(list.length ? list.join("; ") : "Guardrails validation failed");
    this.reasons = list;
  }
}

/** Raised when the HITL approval window expires (server-side deadline). */
export class ApprovalExpiredError extends OpenBoxError {}

/** Raised when a HITL approval is explicitly rejected by a human. */
export class ApprovalRejectedError extends OpenBoxError {}

/** Raised when HITL polling exceeds the configured max wait time. */
export class ApprovalTimeoutError extends OpenBoxError {
  readonly maxWaitMs: number | null;

  constructor(maxWaitMs: number | null = null) {
    super(
      maxWaitMs ? `Approval polling timed out after ${maxWaitMs}ms` : "Approval polling timed out"
    );
    this.maxWaitMs = maxWaitMs;
  }
}

/**
 * Walk an error's `cause` chain to find a wrapped `GovernanceBlockedError`.
 * Frameworks and client libraries often wrap errors; this recovers the original
 * for verdict inspection. Cycle-safe.
 */
export function extractGovernanceError(exc: unknown): GovernanceBlockedError | null {
  const seen = new Set<unknown>();
  let current: unknown = exc;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof GovernanceBlockedError) return current;
    const next =
      current instanceof Error
        ? (current.cause ?? (current as { context?: unknown }).context)
        : undefined;
    current = next;
  }
  return null;
}
