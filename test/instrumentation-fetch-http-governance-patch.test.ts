import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { Verdict } from "../src/contracts/results.js";
import { GovernanceBlockedError, GovernanceHaltError } from "../src/errors/index.js";
import { captureBodyText, installFetchHttpGovernancePatch } from "../src/instrumentation/fetch-http-governance-patch.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "charge" });

interface UnderlyingFetchFake {
  readonly impl: typeof fetch;
  readonly urls: string[];
  callCount(): number;
}

/** A fast, deterministic stand-in for "the real network" — never touches the actual network. */
function makeUnderlyingFetch(): UnderlyingFetchFake {
  const urls: string[] = [];
  const impl: typeof fetch = async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  return { impl, urls, callCount: () => urls.length };
}

function buildRuntime(fakeCore: FakeCore, apiUrl = "https://core.test") {
  const config = OpenBoxConfig.resolve({ apiUrl, apiKey: "obx_test_fetch" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const adapter = new FakeAdapter();
  const runtime = new OpenBoxRuntime(config, { client, adapter, contextStore, logger: silentLogger });
  return { runtime, contextStore, adapter };
}

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("installFetchHttpGovernancePatch — op did not run on BLOCK/HALT", () => {
  it("BLOCK: the underlying fetch is NEVER invoked; preflight throws first", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "denied" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fetch("https://example.com/pay"))
    ).rejects.toBeInstanceOf(GovernanceBlockedError);

    expect(underlying.callCount()).toBe(0);
    handle.restore();
  });

  it("HALT: the underlying fetch is NEVER invoked", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "halt", reason: "kill" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fetch("https://example.com/pay"))
    ).rejects.toBeInstanceOf(GovernanceHaltError);

    expect(underlying.callCount()).toBe(0);
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — ALLOW proceeds, wire-correct span", () => {
  it("sends a started-stage http_request span and lets the real fetch run", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    const response = await contextStore.activityScope(BOUND_CTX, () =>
      fetch("https://example.com/x", { method: "POST", headers: { "content-type": "application/json" } })
    );

    expect(response.status).toBe(200);
    expect(underlying.callCount()).toBe(1);
    const sentSpans = fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> };
    expect(sentSpans.spans[0]?.["stage"]).toBe("started");
    expect(sentSpans.spans[0]?.["hook_type"]).toBe("http_request");
    expect(sentSpans.spans[0]?.["http_method"]).toBe("POST");
    handle.restore();
  });

  it("redacts credential headers before the span ever leaves the process", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await contextStore.activityScope(BOUND_CTX, () =>
      fetch("https://example.com/x", { headers: { Authorization: "Bearer secret-token" } })
    );

    const sentSpans = fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> };
    const headers = sentSpans.spans[0]?.["request_headers"] as Record<string, string>;
    expect(headers["authorization"]).toBe("[REDACTED]");
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — completed telemetry never undoes the operation", () => {
  it("a completed-stage BLOCK is recorded as telemetry AFTER the response is already returned", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore().queueEvaluate(
      { status: 200, body: { verdict: "allow" } },
      { status: 200, body: { verdict: "block", reason: "post-hoc" } }
    );
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    const response = await contextStore.activityScope(BOUND_CTX, () => fetch("https://example.com/x"));

    expect(response.status).toBe(200); // the response is NOT undone
    expect(underlying.callCount()).toBe(1); // the op ran exactly once
    expect(fakeCore.evaluateRequests).toHaveLength(2); // started + completed
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["stage"]).toBe("completed");
    handle.restore();
  });

  it("a thrown network error still produces completed telemetry with the error message, then re-throws", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    globalThis.fetch = failingFetch;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await expect(contextStore.activityScope(BOUND_CTX, () => fetch("https://example.com/x"))).rejects.toThrow(
      "ECONNRESET"
    );

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["error"]).toBe("ECONNRESET");
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — recursion guard: the SDK's own governance calls", () => {
  it("a client's own evaluate() call, routed through an already-installed governed fetch patch, is NEVER self-governed", async () => {
    const fakeCore = new FakeCore(); // backs BOTH the installing runtime's client AND acts as "the real Core"
    globalThis.fetch = fakeCore.fetchImpl; // stand-in for "the true original global fetch"

    const { runtime } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });
    // globalThis.fetch is now the governed wrapper; its "original" is fakeCore.fetchImpl.

    // A second OpenBoxClient with NO explicit fetchImpl captures globalThis.fetch —
    // i.e. the GOVERNED wrapper — exactly like a client constructed after
    // initOpenBoxInstrumentation() ran (a supported, realistic call order).
    const secondClient = new OpenBoxClient("https://core.test", "obx_test_second", { logger: silentLogger });

    const result = await secondClient.evaluate({ event_type: "ActivityStarted" });

    expect(result.verdict).toBe(Verdict.ALLOW);
    // Exactly the ONE evaluate request reached FakeCore — the fetch patch never
    // tried to preflight-govern the client's own outbound call (no recursion,
    // no doubled/looped evaluate traffic).
    expect(fakeCore.evaluateRequests).toHaveLength(1);
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — recursion guard: origin bypass attempts fail", () => {
  it("a host-SUFFIX bypass ({api_url}.evil.com) is NOT treated as ignorable — governance is attempted", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore, "https://core.test");
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await contextStore.activityScope(BOUND_CTX, () => fetch("https://core.test.evil.com/x"));

    expect(fakeCore.evaluateRequests.length).toBeGreaterThan(0); // preflight WAS attempted
    expect(underlying.callCount()).toBe(1); // ALLOW (FakeCore default) still let the real (fake) call through
    handle.restore();
  });

  it("startsWith itself would wrongly treat the host-suffix URL as the api_url — proving the guard must NOT use it", () => {
    expect("https://core.test.evil.com/x".startsWith("https://core.test")).toBe(true);
  });

  it("a userinfo bypass ({api_url}@evil.com) never reaches the network — the platform's own Request() rejects credentialed URLs before any origin check runs", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore, "https://core.test");
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fetch("https://core.test@evil.com/x"))
    ).rejects.toThrow(/credentials/);

    // Fails closed either way: never silently forwarded as "internal/ignorable" traffic.
    expect(underlying.callCount()).toBe(0);
    handle.restore();
  });

  it("the exact configured origin IS ignored (not double-governed) — sanity check for the positive case", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore, "https://core.test");
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await contextStore.activityScope(BOUND_CTX, () => fetch("https://core.test/some/path"));

    expect(fakeCore.evaluateRequests).toStrictEqual([]); // never governed — exact-origin match
    expect(underlying.callCount()).toBe(1); // still reaches the (fake) real network
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — span-less background fetch is governed+diagnosed, not silently skipped", () => {
  it("counts and logs a governed request with no bound ActivityContext, but still lets it proceed (Decision 14)", async () => {
    const underlying = makeUnderlyingFetch();
    globalThis.fetch = underlying.impl;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore); // no contextStore.activityScope wrapping below
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), error() {}, info() {} };
    const handle = installFetchHttpGovernancePatch({ runtime, logger });

    const response = await fetch("https://example.com/background");

    expect(response.status).toBe(200);
    expect(underlying.callCount()).toBe(1); // never blocked — Decision 14 skip is not an error
    expect(fakeCore.evaluateRequests).toStrictEqual([]); // no bound context ⇒ HookEvaluator itself skips the network call
    expect(handle.getSpanlessGovernedRequestCount()).toBe(1); // but it IS counted...
    expect(warnings.some((w) => w.includes("no bound ActivityContext"))).toBe(true); // ...and diagnosed
    handle.restore();
  });

  it("does not count/diagnose internal-call or same-origin traffic as span-less", async () => {
    const fakeCore = new FakeCore();
    globalThis.fetch = fakeCore.fetchImpl;
    const { runtime } = buildRuntime(fakeCore, "https://core.test");
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });

    await fetch("https://core.test/x"); // same-origin ignore path, no bound context either
    expect(handle.getSpanlessGovernedRequestCount()).toBe(0);
    handle.restore();
  });
});

describe("installFetchHttpGovernancePatch — restore", () => {
  it("restores the true original fetch, and restore() is idempotent", () => {
    const before = globalThis.fetch;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });
    expect(globalThis.fetch).not.toBe(before);

    handle.restore();
    expect(globalThis.fetch).toBe(before);
    handle.restore(); // second call must not throw or double-restore
    expect(globalThis.fetch).toBe(before);
  });

  it("throws when global fetch is not a function at install time", () => {
    // @ts-expect-error -- intentionally breaking the global for this one test
    globalThis.fetch = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    expect(() => installFetchHttpGovernancePatch({ runtime, logger: silentLogger })).toThrow(
      /global fetch is not available/
    );
  });
});

describe("captureBodyText — best-effort, never throws", () => {
  it("returns null (does not propagate) when the body clone/read itself fails", async () => {
    const clonable = {
      headers: new Headers({ "content-type": "text/plain" }),
      clone: () => ({
        text: () => Promise.reject(new Error("stream already consumed"))
      })
    };
    await expect(captureBodyText(clonable)).resolves.toBeNull();
  });

  it("returns null without attempting a read for a non-text content type", async () => {
    let cloneCalled = false;
    const clonable = {
      headers: new Headers({ "content-type": "image/png" }),
      clone: () => {
        cloneCalled = true;
        return { text: () => Promise.resolve("binary-garbage") };
      }
    };
    await expect(captureBodyText(clonable)).resolves.toBeNull();
    expect(cloneCalled).toBe(false);
  });

  it("returns null (not an empty string) for an empty body", async () => {
    const clonable = {
      headers: new Headers({ "content-type": "text/plain" }),
      clone: () => ({ text: () => Promise.resolve("") })
    };
    await expect(captureBodyText(clonable)).resolves.toBeNull();
  });
});
