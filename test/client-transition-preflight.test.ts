/**
 * Local candidate-vs-prepared-target check for v1/v2 transition preflight: a
 * no-op without a target, a method mismatch reported alone, Okta fields named
 * in a fixed order (only those the target pins), and the DID for openbox_did.
 */
import { describe, expect, it } from "vitest";

import { assertCandidateMatchesExpectedTarget } from "../src/client/transition-preflight.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import type { OktaAiAgentIdentityConfig, OpenBoxDidIdentityConfig } from "../src/identity/types.js";

const OKTA: OktaAiAgentIdentityConfig = {
  method: "okta_ai_agent",
  openboxAgentId: "agent-1",
  organizationId: "org-1",
  deploymentId: "deployment-1",
  externalAgentId: "wlp-1",
  keyId: "kid-1",
  algorithm: "RS256",
  privateKey: "unused",
  audience: "urn:openbox:deployment-1:core"
};
const DID: OpenBoxDidIdentityConfig = {
  method: "openbox_did",
  did: "did:openbox:agent:1",
  privateKey: "unused"
};

const PREFIX = "Candidate identity does not match the prepared transition target: ";
const SUFFIX = ". (Local convenience check — Core performs the authoritative binding check regardless.)";

function mismatchMessage(run: () => void): string {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OpenBoxConfigError);
  return (thrown as Error).message;
}

describe("assertCandidateMatchesExpectedTarget", () => {
  it("is a no-op without a target, or when every pinned field matches", () => {
    const oktaTarget = {
      method: OKTA.method,
      openboxAgentId: OKTA.openboxAgentId,
      organizationId: OKTA.organizationId,
      deploymentId: OKTA.deploymentId,
      externalAgentId: OKTA.externalAgentId,
      keyId: OKTA.keyId,
      algorithm: OKTA.algorithm
    };
    expect(() => assertCandidateMatchesExpectedTarget(OKTA, undefined)).not.toThrow();
    expect(() => assertCandidateMatchesExpectedTarget(OKTA, { method: "okta_ai_agent" })).not.toThrow();
    expect(() => assertCandidateMatchesExpectedTarget(OKTA, oktaTarget)).not.toThrow();
    expect(() => assertCandidateMatchesExpectedTarget(DID, { method: "openbox_did", did: DID.did })).not.toThrow();
  });

  it("reports a method mismatch alone, without comparing any other field", () => {
    expect(
      mismatchMessage(() => assertCandidateMatchesExpectedTarget(DID, { method: "okta_ai_agent", keyId: "kid-2" }))
    ).toBe(`${PREFIX}method (expected 'okta_ai_agent', got 'openbox_did')${SUFFIX}`);
  });

  it("names every pinned Okta field that differs, in a fixed order, ignoring unpinned ones", () => {
    const message = mismatchMessage(() =>
      assertCandidateMatchesExpectedTarget(OKTA, {
        method: "okta_ai_agent",
        algorithm: "RS512",
        keyId: "kid-2",
        externalAgentId: OKTA.externalAgentId,
        deploymentId: "deployment-2",
        organizationId: "org-2",
        openboxAgentId: "agent-2"
      })
    );
    expect(message).toBe(`${PREFIX}openboxAgentId, organizationId, deploymentId, keyId, algorithm${SUFFIX}`);
    expect(
      mismatchMessage(() =>
        assertCandidateMatchesExpectedTarget(OKTA, { method: "okta_ai_agent", externalAgentId: "wlp-2" })
      )
    ).toBe(`${PREFIX}externalAgentId${SUFFIX}`);
  });

  it("compares only the DID for an openbox_did candidate", () => {
    expect(
      mismatchMessage(() =>
        assertCandidateMatchesExpectedTarget(DID, {
          method: "openbox_did",
          did: "did:openbox:agent:2",
          keyId: "not-compared-for-a-did"
        })
      )
    ).toBe(`${PREFIX}did${SUFFIX}`);
  });
});
