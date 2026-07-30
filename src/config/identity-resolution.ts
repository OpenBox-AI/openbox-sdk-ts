/**
 * Pure identity-method resolution + validation helpers for `OpenBoxConfig`
 * (proposal §13.1). Kept separate from config/index.ts so the (already
 * large) layered-env config class doesn't also own this branching — every
 * function here is a plain data transform, easy to unit test in isolation.
 *
 * No crypto/network imports.
 */

import type { AgentIdentityMethod } from "../identity/types.js";

export type ResolvedIdentityMethod = AgentIdentityMethod | "legacy_unsigned";

/** The flat, env-resolved identity fields `OpenBoxConfig` carries. */
export interface IdentityFields {
  identityMethod: AgentIdentityMethod | null;
  agentDid: string | null;
  agentPrivateKey: string | null;
  oktaAgentId: string | null;
  oktaAgentKeyId: string | null;
  oktaAgentPrivateKey: string | null;
  oktaAgentAlgorithm: string | null;
  agentId: string | null;
  organizationId: string | null;
  deploymentId: string | null;
  agentProofAudience: string | null;
}

function hasDidFields(fields: IdentityFields): boolean {
  return Boolean(fields.agentDid) || Boolean(fields.agentPrivateKey);
}

function hasOktaFields(fields: IdentityFields): boolean {
  return (
    Boolean(fields.oktaAgentId) ||
    Boolean(fields.oktaAgentKeyId) ||
    Boolean(fields.oktaAgentPrivateKey)
  );
}

/**
 * Resolve the active method: explicit wins; DID fields infer `openbox_did`;
 * Okta fields infer `okta_ai_agent`; neither infers `legacy_unsigned`
 * (proposal §13.1 rules 1-2).
 */
export function resolveIdentityMethod(fields: IdentityFields): ResolvedIdentityMethod {
  if (fields.identityMethod) return fields.identityMethod;
  if (hasDidFields(fields)) return "openbox_did";
  if (hasOktaFields(fields)) return "okta_ai_agent";
  return "legacy_unsigned";
}

/**
 * Describe DID vs Okta fields present together (mutual exclusion, proposal
 * §13.1 rule 5), naming every offending field, or `null` when there is no
 * conflict.
 */
export function describeMutualExclusionConflict(fields: IdentityFields): string | null {
  if (!hasDidFields(fields) || !hasOktaFields(fields)) return null;
  const didNames: string[] = [];
  if (fields.agentDid) didNames.push("agentDid");
  if (fields.agentPrivateKey) didNames.push("agentPrivateKey");
  const oktaNames: string[] = [];
  if (fields.oktaAgentId) oktaNames.push("oktaAgentId");
  if (fields.oktaAgentKeyId) oktaNames.push("oktaAgentKeyId");
  if (fields.oktaAgentPrivateKey) oktaNames.push("oktaAgentPrivateKey");
  return (
    `OpenBox DID fields (${didNames.join(", ")}) and Okta fields (${oktaNames.join(", ")}) ` +
    "are mutually exclusive; configure exactly one identity method."
  );
}

/**
 * Every field the `okta_ai_agent` method requires (proposal §13.1 rule 4).
 * Returns the labels of any missing ones (empty array when complete) — fail
 * at construction, not at first request.
 */
export function listMissingOktaFields(fields: IdentityFields): string[] {
  const required: Array<[value: string | null, label: string]> = [
    [fields.agentId, "agentId (OPENBOX_AGENT_ID)"],
    [fields.organizationId, "organizationId (OPENBOX_ORGANIZATION_ID)"],
    [fields.deploymentId, "deploymentId (OPENBOX_DEPLOYMENT_ID)"],
    [fields.oktaAgentId, "oktaAgentId (OPENBOX_OKTA_AGENT_ID)"],
    [fields.oktaAgentKeyId, "oktaAgentKeyId (OPENBOX_OKTA_AGENT_KEY_ID)"],
    [fields.oktaAgentAlgorithm, "oktaAgentAlgorithm (OPENBOX_OKTA_AGENT_ALGORITHM)"],
    [fields.oktaAgentPrivateKey, "oktaAgentPrivateKey (OPENBOX_OKTA_AGENT_PRIVATE_KEY)"],
    [fields.agentProofAudience, "agentProofAudience (OPENBOX_AGENT_PROOF_AUDIENCE)"]
  ];
  return required.filter(([value]) => !value).map(([, label]) => label);
}

/**
 * How an `okta_ai_agent` configuration supplies its identity metadata.
 *
 * - `bootstrap`  — only the private key is local; Core supplies the rest.
 * - `legacy`     — every metadata field is configured locally; no bootstrap call.
 * - `mixed`      — SOME metadata fields are configured. Rejected, never merged.
 *
 * `mixed` is an error rather than a "fill in the gaps from Core" convenience
 * because partially-stale local metadata is the exact failure this feature
 * exists to eliminate: a leftover `oktaAgentKeyId` from before a rotation would
 * silently win over the correct value Core would have supplied.
 */
export type OktaConfigMode = "bootstrap" | "legacy" | "mixed";

/**
 * The metadata fields Core supplies in bootstrap mode, and their env names.
 *
 * `oktaAgentAlgorithm` is deliberately NOT here: it is an algorithm constraint
 * rather than identity metadata, it is harmless to leave set to its only
 * allowed value, and the algorithm actually used is the one Core returns
 * (re-checked as RS256 on arrival).
 */
const BOOTSTRAP_MANAGED_FIELDS: Array<[key: keyof IdentityFields, label: string]> = [
  ["agentId", "agentId (OPENBOX_AGENT_ID)"],
  ["organizationId", "organizationId (OPENBOX_ORGANIZATION_ID)"],
  ["deploymentId", "deploymentId (OPENBOX_DEPLOYMENT_ID)"],
  ["agentProofAudience", "agentProofAudience (OPENBOX_AGENT_PROOF_AUDIENCE)"],
  ["oktaAgentId", "oktaAgentId (OPENBOX_OKTA_AGENT_ID)"],
  ["oktaAgentKeyId", "oktaAgentKeyId (OPENBOX_OKTA_AGENT_KEY_ID)"]
];

/** The bootstrap-managed fields that are set — the "unexpected" list for `mixed`. */
export function listUnexpectedBootstrapFields(fields: IdentityFields): string[] {
  return BOOTSTRAP_MANAGED_FIELDS.filter(([key]) => Boolean(fields[key])).map(([, label]) => label);
}

/**
 * Classify an `okta_ai_agent` configuration into exactly one mode.
 *
 * Callers must have already established that the resolved method is
 * `okta_ai_agent`; this function only decides how its metadata arrives.
 */
export function classifyOktaConfigMode(fields: IdentityFields): OktaConfigMode {
  const present = listUnexpectedBootstrapFields(fields);
  if (present.length === 0) return "bootstrap";
  if (present.length === BOOTSTRAP_MANAGED_FIELDS.length) return "legacy";
  return "mixed";
}

/** The error text for a `mixed` configuration, naming the offending fields. */
export function describeMixedOktaConfig(fields: IdentityFields): string {
  const present = listUnexpectedBootstrapFields(fields);
  const missing = BOOTSTRAP_MANAGED_FIELDS.filter(([key]) => !fields[key]).map(([, label]) => label);
  return (
    "Okta identity configuration is incomplete and cannot be combined with identity bootstrap. " +
    `Configured: ${present.join(", ")}. Missing: ${missing.join(", ")}. ` +
    "Either remove the configured field(s) to let OpenBox Core supply all identity metadata " +
    "(bootstrap mode, requiring only apiUrl, apiKey and oktaAgentPrivateKey), or configure every " +
    "remaining field for fully explicit configuration."
  );
}
