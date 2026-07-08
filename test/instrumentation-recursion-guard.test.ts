import { describe, expect, it } from "vitest";

import { isInternalCall, isSameOrigin, runAsInternal } from "../src/instrumentation/recursion-guard.js";

describe("runAsInternal / isInternalCall", () => {
  it("isInternalCall() is false outside any runAsInternal scope", () => {
    expect(isInternalCall()).toBe(false);
  });

  it("isInternalCall() is true synchronously inside runAsInternal", () => {
    let observed = false;
    runAsInternal(() => {
      observed = isInternalCall();
    });
    expect(observed).toBe(true);
  });

  it("isInternalCall() stays true across every await inside the wrapped async function", async () => {
    const observations: boolean[] = [];
    await runAsInternal(async () => {
      observations.push(isInternalCall());
      await Promise.resolve();
      observations.push(isInternalCall());
      await new Promise((resolve) => setTimeout(resolve, 0));
      observations.push(isInternalCall());
    });
    expect(observations).toStrictEqual([true, true, true]);
  });

  it("isInternalCall() is false again once runAsInternal's callback has settled", async () => {
    await runAsInternal(async () => Promise.resolve());
    expect(isInternalCall()).toBe(false);
  });

  it("returns the callback's value/resolved value unchanged", async () => {
    expect(runAsInternal(() => 42)).toBe(42);
    await expect(runAsInternal(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("propagates a synchronous throw from the callback", () => {
    expect(() =>
      runAsInternal(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");
  });

  it("propagates an async rejection from the callback", async () => {
    await expect(runAsInternal(() => Promise.reject(new Error("async boom")))).rejects.toThrow("async boom");
  });

  it("does not leak into a SIBLING (non-nested) async call outside its own chain", async () => {
    let sawInternalDuringSibling: boolean | undefined;
    const internalPromise = runAsInternal(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return isInternalCall();
    });
    // A concurrently-running, unrelated async flow started OUTSIDE runAsInternal.
    const siblingPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      sawInternalDuringSibling = isInternalCall();
    })();
    const [internalResult] = await Promise.all([internalPromise, siblingPromise]);
    expect(internalResult).toBe(true);
    expect(sawInternalDuringSibling).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("matches identical scheme+host+port", () => {
    expect(isSameOrigin("https://api.openbox.ai", "https://api.openbox.ai")).toBe(true);
    expect(isSameOrigin("https://api.openbox.ai/v1/x?y=1", "https://api.openbox.ai")).toBe(true);
  });

  it("ignores path/query/fragment differences", () => {
    expect(isSameOrigin("https://api.openbox.ai/a/b/c", "https://api.openbox.ai/other")).toBe(true);
  });

  it("rejects a different port (default vs explicit, and genuinely different ports)", () => {
    expect(isSameOrigin("https://api.openbox.ai:8443", "https://api.openbox.ai")).toBe(false);
    expect(isSameOrigin("https://api.openbox.ai:443", "https://api.openbox.ai")).toBe(true); // 443 is https's default
  });

  it("rejects a different scheme even with the same host", () => {
    expect(isSameOrigin("http://api.openbox.ai", "https://api.openbox.ai")).toBe(false);
  });

  it("REJECTS a host-suffix bypass — the classic startsWith trap", () => {
    // `"https://api.openbox.ai.evil.com".startsWith("https://api.openbox.ai")` is TRUE —
    // this is exactly why the guard must use URL.origin equality, never startsWith.
    expect("https://api.openbox.ai.evil.com".startsWith("https://api.openbox.ai")).toBe(true);
    expect(isSameOrigin("https://api.openbox.ai.evil.com", "https://api.openbox.ai")).toBe(false);
  });

  it("REJECTS a userinfo bypass (everything before @ is credentials, not host)", () => {
    expect(isSameOrigin("https://api.openbox.ai@evil.com", "https://api.openbox.ai")).toBe(false);
  });

  it("REJECTS a host-prefix bypass in the other direction", () => {
    expect(isSameOrigin("https://evilapi.openbox.ai", "https://api.openbox.ai")).toBe(false);
  });

  it("returns false (never throws) for a malformed candidate or reference URL", () => {
    expect(isSameOrigin("not a url", "https://api.openbox.ai")).toBe(false);
    expect(isSameOrigin("https://api.openbox.ai", "not a url")).toBe(false);
    expect(isSameOrigin("not a url", "also not a url")).toBe(false);
  });
});
