/**
 * Retained Okta v2 bootstrap under IAM v3: the `authority` object is required
 * and strictly shaped, a failed refresh leaves no stale signer, and an older
 * in-flight bootstrap can never overwrite a newer identity.
 */
import { describe, expect, it, vi } from "vitest";

import { AUTH_VALIDATE_PATH_V2, OpenBoxClient } from "../src/client/index.js";
import { AUTH_BOOTSTRAP_PATH_V2, parseBootstrapDocument } from "../src/config/bootstrap.js";
import { OpenBoxConfigError } from "../src/errors/index.js";
import { WORKLOAD_PEM, decodeJwt, deferred, jsonResponse } from "./support/workload-identity-fakes.js";

// WORKLOAD_PEM is the shared v2 fixture key; this is its pinned RFC 7638 thumbprint.
const FIXTURE_THUMBPRINT = "P8EMAIrSnD-kQcn47Cpq_LlDPywhP3mqfM1RhwySFdk";
const API_URL = "https://core.example.com";

const AUTHORITY = {
  assignment_id: "10000000-0000-4000-8000-000000000001",
  provider_generation_id: "20000000-0000-4000-8000-000000000002",
  generation_number: 7,
  activation_version: "30000000-0000-4000-8000-000000000003",
  identity_id: "40000000-0000-4000-8000-000000000004",
  credential_id: "50000000-0000-4000-8000-000000000005",
  projection_version: "opaque-projection-version-9"
};

function v2Document(overrides: Record<string, unknown> = {}, kid = "credential-kid-1"): Record<string, unknown> {
  return {
    bootstrap_version: 1,
    identity_method: "okta_ai_agent",
    openbox_agent_id: "00000000-0000-4000-8000-000000000002",
    organization_id: "org-opaque-identifier",
    deployment_id: "fixture-deployment",
    assertion_audience: "urn:openbox:fixture-deployment:core",
    authority: AUTHORITY,
    okta: {
      external_agent_id: "okta-agent-1",
      credential_kid: kid,
      algorithm: "RS256",
      public_jwk_thumbprint: FIXTURE_THUMBPRINT
    },
    ...overrides
  };
}

describe("parseBootstrapDocument — authority", () => {
  it("maps the snake_case authority into the document", () => {
    expect(parseBootstrapDocument(v2Document()).authority).toEqual({
      assignmentId: AUTHORITY.assignment_id,
      providerGenerationId: AUTHORITY.provider_generation_id,
      generationNumber: 7,
      activationVersion: AUTHORITY.activation_version,
      identityId: AUTHORITY.identity_id,
      credentialId: AUTHORITY.credential_id,
      projectionVersion: AUTHORITY.projection_version
    });
  });

  it("fails closed when authority is missing — even at bootstrap_version 1", () => {
    expect(() => parseBootstrapDocument(v2Document({ authority: undefined }))).toThrow(/predates IAM-aware bootstrap/);
    expect(() => parseBootstrapDocument(v2Document({ authority: [] }))).toThrow(OpenBoxConfigError);
    expect(() => parseBootstrapDocument(v2Document({ authority: null }))).toThrow(OpenBoxConfigError);
  });

  it.each([0, -1, 1.5, "7", true, null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects generation_number %j",
    (generation_number) => {
      expect(() => parseBootstrapDocument(v2Document({ authority: { ...AUTHORITY, generation_number } }))).toThrow(
        /generation_number/
      );
    }
  );

  it.each(["assignment_id", "provider_generation_id", "activation_version", "identity_id", "credential_id"])(
    "requires a UUID-shaped %s",
    (key) => {
      for (const value of ["not-a-uuid", "", undefined, 5]) {
        expect(() => parseBootstrapDocument(v2Document({ authority: { ...AUTHORITY, [key]: value } }))).toThrow(
          new RegExp(`authority\\.${key}`)
        );
      }
    }
  );

  it("keeps projection_version and organization_id opaque, but required", () => {
    expect(() =>
      parseBootstrapDocument(v2Document({ authority: { ...AUTHORITY, projection_version: "" } }))
    ).toThrow(/authority\.projection_version/);
    expect(parseBootstrapDocument(v2Document()).organizationId).toBe("org-opaque-identifier");
  });
});

interface V2Harness {
  fetchImpl: typeof fetch;
  bootstraps: Array<() => Promise<Response>>;
  validates: Array<Record<string, string>>;
  bootstrapCount(): number;
}

function v2Harness(): V2Harness {
  const harness: V2Harness = {
    bootstraps: [],
    validates: [],
    bootstrapCount: () => bootstrapCount,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(AUTH_BOOTSTRAP_PATH_V2)) {
        bootstrapCount += 1;
        const next = harness.bootstraps.shift();
        return next ? next() : Promise.reject(new Error("no bootstrap scripted"));
      }
      if (url.endsWith(AUTH_VALIDATE_PATH_V2)) {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        harness.validates.push(headers);
      }
      return Promise.resolve(jsonResponse(200, { valid: true }));
    })
  };
  let bootstrapCount = 0;
  return harness;
}

function bootstrapClient(harness: V2Harness): OpenBoxClient {
  return new OpenBoxClient(API_URL, "obx_test_v2authority", {
    oktaBootstrapPrivateKey: WORKLOAD_PEM,
    fetchImpl: harness.fetchImpl,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
}

describe("Okta bootstrap client — authority and refresh coordination", () => {
  it("sends no governed request when Core omits authority", async () => {
    const harness = v2Harness();
    harness.bootstraps.push(() => Promise.resolve(jsonResponse(200, v2Document({ authority: undefined }))));
    const client = bootstrapClient(harness);
    await expect(client.validateApiKey()).rejects.toThrow(/authority/);
    expect(harness.validates).toHaveLength(0);
    expect(client.identityMetadata()).toBeNull();
  });

  it("exposes the authority snapshot through identityMetadata()", async () => {
    const harness = v2Harness();
    harness.bootstraps.push(() => Promise.resolve(jsonResponse(200, v2Document())));
    const client = bootstrapClient(harness);
    await client.validateApiKey();
    expect(client.identityMetadata()?.authority.generationNumber).toBe(7);
  });

  it("drops the identity when a refresh returns a document without authority", async () => {
    const harness = v2Harness();
    harness.bootstraps.push(
      () => Promise.resolve(jsonResponse(200, v2Document())),
      () => Promise.resolve(jsonResponse(200, v2Document({ authority: undefined })))
    );
    const client = bootstrapClient(harness);
    await client.validateApiKey();
    await expect(client.refreshIdentityMetadata()).rejects.toThrow(/authority/);
    expect(client.identityMetadata()).toBeNull();
    await expect(client.validateApiKey()).rejects.toThrow(); // re-bootstraps; nothing scripted
    expect(harness.validates).toHaveLength(1);
  });

  it("never lets an older in-flight bootstrap overwrite a newer refresh", async () => {
    const harness = v2Harness();
    const first = deferred<Response>();
    harness.bootstraps.push(
      () => first.promise,
      () => Promise.resolve(jsonResponse(200, v2Document({}, "credential-kid-2")))
    );
    const client = bootstrapClient(harness);

    const early = client.validateApiKey(); // bootstrap #1 hangs
    await vi.waitFor(() => expect(harness.bootstrapCount()).toBe(1));
    await expect(client.refreshIdentityMetadata()).resolves.toMatchObject({
      okta: expect.objectContaining({ credentialKid: "credential-kid-2" }) as unknown
    });
    first.resolve(jsonResponse(200, v2Document({}, "credential-kid-1"))); // late and obsolete
    await early;
    await client.validateApiKey();

    expect(client.identityMetadata()?.okta.credentialKid).toBe("credential-kid-2");
    const kids = harness.validates.map((h) => decodeJwt(h["x-openbox-agent-assertion"]!).header["kid"]);
    expect(kids).toEqual(["credential-kid-2", "credential-kid-2"]);
  });
});
