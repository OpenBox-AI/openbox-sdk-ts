/**
 * Transition preflight — pure candidate validation + response shaping for
 * `POST /api/{v1,v2}/auth/transition-proof` (proposal §13.5).
 *
 * Kept separate from client/index.ts so the local candidate-metadata check
 * is independently testable. No crypto/network imports.
 *
 * Security note (proposal §17.28, phase Key Insight): the candidate identity
 * passed to a preflight helper is ALWAYS explicit — never inferred from, or
 * defaulted to, the client's active identity. This module only ever inspects
 * the identity object it is handed; it has no access to (and must never gain
 * access to) "the active identity" as a fallback.
 */

import { OpenBoxConfigError } from "../errors/index.js";
import type { AgentIdentityTransitionCandidate } from "../identity/types.js";

export interface TransitionPreflightResult {
  proofVerified: boolean;
}

/**
 * Non-secret prepared-transition metadata for the LOCAL candidate check
 * (proposal §13.5 step 8: "before signing, the SDK checks that the explicit
 * candidate method, OpenBox agent, external agent or DID, kid, and algorithm
 * match that prepared metadata"). Optional on every field, and the whole
 * object is optional at the call site — this check is convenience only;
 * Core remains the authoritative binding check regardless (Security
 * Considerations: "do not let a local check become the reason a Core-side
 * binding check is skipped").
 */
export interface TransitionExpectedTarget {
  method: AgentIdentityTransitionCandidate["method"];
  openboxAgentId?: string;
  organizationId?: string;
  deploymentId?: string;
  externalAgentId?: string;
  did?: string;
  keyId?: string;
  algorithm?: string;
}

/**
 * Throws `OpenBoxConfigError` (naming every mismatched field) when `expected`
 * is supplied and disagrees with `candidate`. No-op when `expected` is
 * omitted. Never inspects or requires the client's active identity.
 */
export function assertCandidateMatchesExpectedTarget(
  candidate: AgentIdentityTransitionCandidate,
  expected: TransitionExpectedTarget | undefined
): void {
  if (!expected) return;
  const mismatches: string[] = [];

  if (expected.method !== candidate.method) {
    mismatches.push(`method (expected '${expected.method}', got '${candidate.method}')`);
  } else if (candidate.method === "okta_ai_agent") {
    if (expected.openboxAgentId !== undefined && expected.openboxAgentId !== candidate.openboxAgentId) {
      mismatches.push("openboxAgentId");
    }
    if (expected.organizationId !== undefined && expected.organizationId !== candidate.organizationId) {
      mismatches.push("organizationId");
    }
    if (expected.deploymentId !== undefined && expected.deploymentId !== candidate.deploymentId) {
      mismatches.push("deploymentId");
    }
    if (expected.externalAgentId !== undefined && expected.externalAgentId !== candidate.externalAgentId) {
      mismatches.push("externalAgentId");
    }
    if (expected.keyId !== undefined && expected.keyId !== candidate.keyId) {
      mismatches.push("keyId");
    }
    if (expected.algorithm !== undefined && expected.algorithm !== candidate.algorithm) {
      mismatches.push("algorithm");
    }
  } else if (expected.did !== undefined && expected.did !== candidate.did) {
    mismatches.push("did");
  }

  if (mismatches.length > 0) {
    throw new OpenBoxConfigError(
      `Candidate identity does not match the prepared transition target: ${mismatches.join(", ")}. ` +
        "(Local convenience check — Core performs the authoritative binding check regardless.)"
    );
  }
}

/** Parse Core's `transitionProofResponse` JSON body into the SDK's camelCase result shape. */
export function parseTransitionProofResponse(data: Record<string, unknown>): TransitionPreflightResult {
  return { proofVerified: Boolean(data["proof_verified"]) };
}
