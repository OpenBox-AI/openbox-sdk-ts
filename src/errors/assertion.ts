/**
 * v2 (`okta_ai_agent`) assertion rejection classification.
 *
 * Pure module: no network, crypto, OTel, logging, or wall-clock imports.
 * Mirrors `mapSigningError`'s shape for v1 but keyed on the DISJOINT v2
 * reason-code vocabulary (docs/agent-identity-v2-contract.md §7) — Core's
 * Phase 6 compatibility refactor kept v1's external reason codes byte-stable,
 * so the two vocabularies never overlap and must not be merged into one map.
 */

import { OpenBoxSigningError } from "./index.js";

/**
 * Raised when Core rejects a v2 (`X-OpenBox-Agent-Assertion`) request.
 * A distinct subclass from `OpenBoxSigningError` so callers can
 * `instanceof`-distinguish a v2 assertion rejection from a v1 signed-request
 * rejection when that matters (e.g. routing telemetry).
 */
export class OpenBoxAssertionError extends OpenBoxSigningError {}

// Contract §7's reason-code table → actionable SDK guidance. `verifier_unavailable`
// is a 500/503 (infrastructure), never itself a 401/403 auth rejection, but is
// included for completeness if a caller ever maps it through this function.
const ASSERTION_REASON_MESSAGES: Record<string, string> = {
  assertion_missing:
    "No assertion was sent (assertion_missing). Configure an okta_ai_agent identity " +
    "so X-OpenBox-Agent-Assertion is attached to every v2 request.",
  assertion_malformed:
    "The assertion is not a well-formed compact JWT (assertion_malformed).",
  assertion_typ_mismatch:
    "The assertion's 'typ' header is not 'openbox-agent-proof+jwt' (assertion_typ_mismatch).",
  assertion_alg_rejected:
    "The assertion's algorithm is not allowlisted (assertion_alg_rejected). Only RS256 is accepted.",
  assertion_embedded_key_rejected:
    "The assertion embeds a caller-supplied jwk/jku/x5u header (assertion_embedded_key_rejected), " +
    "which Core rejects before any signature work.",
  assertion_key_too_small:
    "The signing RSA key is below the 2048-bit minimum (assertion_key_too_small).",
  assertion_signature_invalid:
    "Assertion signature rejected (assertion_signature_invalid). Usually a body-hash mismatch " +
    "(send the exact hashed bytes, never re-serialize) or a wrong/rotated private key.",
  method_endpoint_mismatch:
    "This agent's verification method does not match the endpoint version called " +
    "(method_endpoint_mismatch). An okta_ai_agent identity must call /api/v2/* routes only.",
  binding_invalid:
    "The assertion's bound claims (org/agent/method/path/body) do not match the request " +
    "(binding_invalid). Check the configured deploymentId/organizationId/openboxAgentId/audience.",
  transition_proof_invalid:
    "Transition proof rejected (transition_proof_invalid) — unknown, expired, or consumed " +
    "transition intent, or a candidate/kid mismatch.",
  proof_expired:
    "Assertion or transition proof expired or outside the allowed clock skew (proof_expired).",
  proof_replayed:
    "This assertion's jti was already used (proof_replayed). Each request must carry a fresh jti.",
  identity_ineligible:
    "The linked Okta identity or credential is inactive or its projection is stale " +
    "(identity_ineligible). Re-sync or re-link the Okta AI Agent.",
  verifier_unavailable:
    "OpenBox Core's v2 verifier is temporarily unavailable (verifier_unavailable)."
};

/**
 * Map a Core v2 reason code to an actionable `OpenBoxAssertionError`. Unknown
 * or absent codes fall back to a generic message. Never throws — always
 * returns an error for the caller to raise.
 */
export function mapAssertionError(
  reasonCode: string | null | undefined,
  fallback = ""
): OpenBoxAssertionError {
  if (reasonCode && reasonCode in ASSERTION_REASON_MESSAGES) {
    return new OpenBoxAssertionError(ASSERTION_REASON_MESSAGES[reasonCode]!, reasonCode);
  }
  const msg =
    fallback ||
    "Okta agent assertion rejected by OpenBox Core" + (reasonCode ? ` (${reasonCode})` : "") + ".";
  return new OpenBoxAssertionError(msg, reasonCode ?? null);
}
