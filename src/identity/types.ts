/**
 * Tagged agent-identity configuration shapes (proposal §13.1, contract §1,
 * IAM v3 workload identity).
 *
 * Pure type module — no crypto/network imports — shared by config parsing,
 * client endpoint/signing selection, and the transition preflight helpers.
 *
 * `legacy_unsigned` is deliberately NOT a member of `AgentIdentityVerification`:
 * it is an internal compatibility classification inferred only when neither
 * shape below is configured (proposal §13.1 rule 6), never a method a caller
 * selects explicitly.
 */

/** Existing v1 OpenBox DID + Ed25519 identity (byte-compatible, unchanged). */
export interface OpenBoxDidIdentityConfig {
  readonly method: "openbox_did";
  readonly did: string;
  /** Base64, raw 32-byte Ed25519 seed — see identity/index.ts. */
  readonly privateKey: string;
}

/**
 * New v2 Okta AI Agent + RS256 identity (proposal §13.1, contract §3-4).
 *
 * `privateKey` is PKCS8 PEM — the one canonical private-key encoding chosen
 * for this release (proposal §13.1 rule 8). Private-JWK input is
 * deliberately not accepted yet; it can be added as a second variant when a
 * real consumer needs it, without disturbing this shape.
 */
export interface OktaAiAgentIdentityConfig {
  readonly method: "okta_ai_agent";
  /** OpenBox agent UUID (resolved from the bearer API key; also signed as `obx_agent_id`). */
  readonly openboxAgentId: string;
  /** OpenBox organization UUID (also signed as `obx_organization_id`). */
  readonly organizationId: string;
  /** Stable deployment identifier (`OPENBOX_DEPLOYMENT_ID`; also signed as `obx_deployment_id`). */
  readonly deploymentId: string;
  /** The linked Okta AI Agent's external ID (signed as `iss`/`sub`). */
  readonly externalAgentId: string;
  /** The selected public credential's `kid` (protected header, never a bare lookup key at Core). */
  readonly keyId: string;
  /** Allowlisted at exactly one value for this release (contract §3, decision 24.2). */
  readonly algorithm: "RS256";
  /** PKCS8 PEM-encoded RSA private key (>= 2048-bit modulus). Never logged, never echoed. */
  readonly privateKey: string;
  /** Deployment-scoped audience: `urn:openbox:<deployment-id>:core`. Never a shared constant. */
  readonly audience: string;
}

/**
 * IAM v3 Keycloak workload identity. The OpenBox API key still resolves the
 * stable agent; this RSA key authenticates the agent's active Keycloak service
 * account (`private_key_jwt`) to obtain a short-lived workload token. Every
 * other value — client id, key id, issuer, audience, activation — comes from
 * Core's `GET /api/v3/auth/bootstrap`, never from local configuration.
 */
export interface KeycloakWorkloadIdentityConfig {
  readonly method: "keycloak_workload";
  /** PKCS8 PEM-encoded RSA private key (>= 2048-bit modulus). Never logged, never echoed. */
  readonly privateKey: string;
}

/** Discriminated union of the selectable verification methods. */
export type AgentIdentityVerification =
  | OpenBoxDidIdentityConfig
  | OktaAiAgentIdentityConfig
  | KeycloakWorkloadIdentityConfig;

/** The subset of `method` values a caller may explicitly select (excludes `legacy_unsigned`). */
export type AgentIdentityMethod = AgentIdentityVerification["method"];

/**
 * Candidate identity for a v1/v2 transition preflight (proposal §13.5). Kept as
 * a distinct alias so call sites read as "the explicit candidate", never "the
 * active identity". Deliberately limited to the DID and Okta variants: a
 * workload candidate is proved through `proveWorkloadIdentityTransition`, which
 * takes only a candidate key because Core supplies the candidate's metadata.
 */
export type AgentIdentityTransitionCandidate = OpenBoxDidIdentityConfig | OktaAiAgentIdentityConfig;
