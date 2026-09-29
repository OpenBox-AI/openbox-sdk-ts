/**
 * IAM v3 workload candidate proof — `OpenBoxClient.proveWorkloadIdentityTransition`.
 *
 * Proves possession of ONE prepared candidate service-account key:
 *   1. validate the transition id and the explicit candidate key locally;
 *   2. `GET /api/v3/auth/workload-transition/bootstrap?transition_id=<id>`
 *      (agent API key + SDK headers only) for the candidate's metadata;
 *   3. sign a one-minute client assertion for the candidate client/key, with
 *      the candidate token endpoint as audience;
 *   4. `POST /api/v3/auth/workload-transition/proof` and accept success only on
 *      an explicit `proof_verified: true`.
 *
 * Never calls Keycloak, never activates the candidate (activation is a separate
 * Backend administrator action), never resends, and never reads or mutates the
 * client's active authentication state. The candidate key is always explicit —
 * it never defaults to the active key and is never matched by `kid` alone.
 */

import { OpenBoxConfigError } from "../errors/index.js";
import { OpenBoxWorkloadAuthError } from "../errors/workload.js";
import { loadRsaPrivateKey } from "../identity/rsa-private-key.js";
import { buildWorkloadClientAssertion } from "../identity/workload.js";
import {
  canonicalUuid,
  parseWorkloadTransitionBootstrapDocument
} from "./workload-documents.js";
import {
  sendAuthenticationRequest,
  transitionBootstrapFailure,
  transitionProofFailure,
  type AuthenticationTransport
} from "./workload-http.js";

export const WORKLOAD_TRANSITION_BOOTSTRAP_PATH_V3 = "/api/v3/auth/workload-transition/bootstrap";
export const WORKLOAD_TRANSITION_PROOF_PATH_V3 = "/api/v3/auth/workload-transition/proof";

export interface WorkloadTransitionProofOptions {
  /** The prepared transition's UUID, from the management flow that prepared the candidate. */
  readonly transitionId: string;
  /** PKCS8 PEM RSA key of the CANDIDATE service account. Required; never the active key. */
  readonly candidatePrivateKey: string;
}

export interface WorkloadTransitionProofResult {
  readonly proofVerified: true;
}

export interface WorkloadTransitionContext {
  readonly apiUrl: string;
  /** Core auth + SDK identity headers: API key, `User-Agent`, `X-OpenBox-SDK-Version`. */
  readonly coreHeaders: () => Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function parseJsonBody(text: string, stage: "transition_bootstrap" | "transition_proof"): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenBoxWorkloadAuthError(
      `OpenBox Core's ${stage.replace("_", " ")} response is invalid: body is not valid JSON.`,
      { stage, httpStatus: 200 }
    );
  }
}

/** Run the candidate proof sequence described in the module docstring. */
export async function proveWorkloadTransition(
  context: WorkloadTransitionContext,
  options: WorkloadTransitionProofOptions
): Promise<WorkloadTransitionProofResult> {
  const transitionId = canonicalUuid(options?.transitionId);
  if (transitionId === null || transitionId === NIL_UUID) {
    throw new OpenBoxConfigError(
      "proveWorkloadIdentityTransition requires transitionId to be the prepared transition's canonical UUID."
    );
  }
  if (!options.candidatePrivateKey) {
    throw new OpenBoxConfigError(
      "proveWorkloadIdentityTransition requires an explicit candidatePrivateKey; it never falls back to " +
        "this client's active workload key."
    );
  }
  const candidate = loadRsaPrivateKey(options.candidatePrivateKey, "candidatePrivateKey");
  const transport: AuthenticationTransport = {
    fetchImpl: context.fetchImpl,
    timeoutMs: context.timeoutMs
  };

  const bootstrap = await sendAuthenticationRequest(
    transport,
    "transition_bootstrap",
    `${context.apiUrl}${WORKLOAD_TRANSITION_BOOTSTRAP_PATH_V3}?transition_id=${encodeURIComponent(transitionId)}`,
    { method: "GET", headers: { ...context.coreHeaders(), Accept: "application/json" } },
    {
      target: "OpenBox Core's workload transition bootstrap endpoint",
      networkFailure: (detail) =>
        `OpenBox Core could not be reached for the workload transition bootstrap (${detail}); no proof was sent.`
    }
  );
  if (bootstrap.status !== 200) throw transitionBootstrapFailure(bootstrap.status, bootstrap.text);
  const document = parseWorkloadTransitionBootstrapDocument(
    parseJsonBody(bootstrap.text, "transition_bootstrap"),
    transitionId,
    Date.now()
  );

  const proof = await sendAuthenticationRequest(
    transport,
    "transition_proof",
    `${context.apiUrl}${WORKLOAD_TRANSITION_PROOF_PATH_V3}`,
    {
      method: "POST",
      headers: {
        ...context.coreHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transition_id: transitionId,
        client_assertion: buildWorkloadClientAssertion(candidate, document)
      })
    },
    {
      target: "OpenBox Core's workload transition proof endpoint",
      // A proof that timed out may still have been accepted: report the
      // uncertainty instead of guessing, and never repost automatically.
      networkFailure: (detail) =>
        `The workload transition proof request did not complete (${detail}). Core may already have ` +
        "accepted it: check the transition's status through the OpenBox management API before trying " +
        "again. The SDK does not resend proofs or activate candidates automatically."
    }
  );
  if (proof.status !== 200) throw transitionProofFailure(proof.status, proof.text);
  const result = parseJsonBody(proof.text, "transition_proof");
  if (
    typeof result !== "object" ||
    result === null ||
    (result as Record<string, unknown>)["proof_verified"] !== true
  ) {
    throw new OpenBoxWorkloadAuthError(
      "OpenBox Core did not confirm the workload transition proof (proof_verified was not true); " +
        "the candidate is not proven.",
      { stage: "transition_proof", httpStatus: 200 }
    );
  }
  return Object.freeze({ proofVerified: true as const });
}
