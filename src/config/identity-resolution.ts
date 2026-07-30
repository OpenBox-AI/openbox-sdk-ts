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
