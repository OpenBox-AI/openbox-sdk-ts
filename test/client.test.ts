import { describe, expect, it } from "vitest";

import { OpenBoxClient, checkExpiration } from "../src/client/index.js";
import { Verdict } from "../src/contracts/results.js";
import {
  GovernanceAPIError,
  OpenBoxAuthError,
  OpenBoxNetworkError,
  OpenBoxSigningError
} from "../src/errors/index.js";
import { AgentIdentity } from "../src/identity/index.js";
import { serializeBody } from "../src/serialization/index.js";

const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const silentLogger = { warn() {}, error() {}, info() {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function client(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}): OpenBoxClient {
  return new OpenBoxClient("https://core.example.com", "obx_test_k", {
    fetchImpl,
    logger: silentLogger,
    ...opts
  });
}

describe("evaluate", () => {
  it("parses a governance verdict on success", async () => {
    const c = client(async () => jsonResponse({ verdict: "block", reason: "nope" }));
    const result = await c.evaluate({ event_type: "ActivityStarted" });
    expect(result.verdict).toBe(Verdict.BLOCK);
    expect(result.reason).toBe("nope");
  });

  it("sends the raw signed body bytes verbatim (never re-serialized)", async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body;
      return jsonResponse({ verdict: "allow" });
    }) as typeof fetch;
    const c = client(fetchImpl);
    const payload = { note: "café☕" };
    await c.evaluate(payload);
    expect(Buffer.from(capturedBody as Uint8Array).equals(serializeBody(payload))).toBe(true);
  });

  it("fail_open returns a fallbackUsed ALLOW on a network error", async () => {
    const c = client(() => Promise.reject(new Error("ECONNREFUSED")), { onApiError: "fail_open" });
    const result = await c.evaluate({});
    expect(result.verdict).toBe(Verdict.ALLOW);
    expect(result.fallbackUsed).toBe(true);
  });

  it("fail_closed throws GovernanceAPIError on a network error", async () => {
    const c = client(() => Promise.reject(new Error("down")), { onApiError: "fail_closed" });
    await expect(c.evaluate({})).rejects.toBeInstanceOf(GovernanceAPIError);
  });

  it("a 401 auth rejection NEVER fail-opens — it throws even under fail_open", async () => {
    const c = client(async () => jsonResponse({}, 401), { onApiError: "fail_open" });
    await expect(c.evaluate({})).rejects.toBeInstanceOf(GovernanceAPIError);
  });

  it("a signed 401 with a reason code surfaces an OpenBoxSigningError", async () => {
    const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const c = client(async () => jsonResponse({ reason_code: "signature_invalid" }, 401), {
      identity
    });
    await expect(c.evaluate({})).rejects.toBeInstanceOf(OpenBoxSigningError);
  });

  it("a 5xx is treated as an outage (fail-open), not an auth failure", async () => {
    const c = client(async () => jsonResponse({}, 503), { onApiError: "fail_open" });
    const result = await c.evaluate({});
    expect(result.fallbackUsed).toBe(true);
  });
});

describe("pollApproval", () => {
  it("returns a parsed ApprovalResult on 200", async () => {
    const c = client(async () => jsonResponse({ action: "allow", id: "appr-1" }));
    const result = await c.pollApproval("wf", "run", "act");
    expect(result?.verdict).toBe(Verdict.ALLOW);
    expect(result?.approvalId).toBe("appr-1");
  });

  it("returns null on a non-200 or a network failure (treated as still pending)", async () => {
    expect(await client(async () => jsonResponse({}, 500)).pollApproval("w", "r", "a")).toBeNull();
    expect(await client(() => Promise.reject(new Error("x"))).pollApproval("w", "r", "a")).toBeNull();
  });
});

describe("checkExpiration", () => {
  it("flags past timestamps, treats tz-naive values as UTC, and leaves future ones", () => {
    expect(checkExpiration({ approval_expiration_time: "2000-01-01T00:00:00Z" }).expired).toBe(true);
    // tz-naive → assumed UTC (not host-local).
    expect(checkExpiration({ approval_expiration_time: "2000-01-01T00:00:00" }).expired).toBe(true);
    expect(checkExpiration({ approval_expiration_time: "2999-01-01T00:00:00Z" }).expired).toBeUndefined();
    expect(checkExpiration({}).expired).toBeUndefined();
  });
});

describe("validateApiKey", () => {
  it("returns true on 200", async () => {
    expect(await client(async () => new Response("", { status: 200 })).validateApiKey()).toBe(true);
  });

  it("throws OpenBoxAuthError on an unsigned 401 and OpenBoxNetworkError on 5xx", async () => {
    await expect(client(async () => jsonResponse({}, 401)).validateApiKey()).rejects.toBeInstanceOf(
      OpenBoxAuthError
    );
    await expect(client(async () => jsonResponse({}, 500)).validateApiKey()).rejects.toBeInstanceOf(
      OpenBoxNetworkError
    );
  });

  it("maps a signed 401 reason code to OpenBoxSigningError", async () => {
    const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
    const c = client(async () => jsonResponse({ code: "nonce_replayed" }, 403), { identity });
    await expect(c.validateApiKey()).rejects.toBeInstanceOf(OpenBoxSigningError);
  });
});
