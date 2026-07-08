import { describe, expect, it } from "vitest";

import { ActivityContext } from "../src/contracts/context.js";
import { BoundedTraceMap, canonicalTraceKey } from "../src/context/trace-map.js";

const CTX = new ActivityContext({ workflowId: "wf", activityId: "a" });

describe("canonicalTraceKey", () => {
  it("normalizes a 32-hex string to lowercase", () => {
    expect(canonicalTraceKey("AABBCCDD00112233AABBCCDD00112233")).toBe(
      "aabbccdd00112233aabbccdd00112233"
    );
  });

  it("converts a bigint to a zero-padded 32-hex string (never parseInt/Number)", () => {
    // This value exceeds Number.MAX_SAFE_INTEGER by many orders of magnitude —
    // parseInt/Number would silently lose precision here.
    const big = 0xaabbccddaabbccddaabbccddaabbccddn;
    expect(canonicalTraceKey(big)).toBe("aabbccddaabbccddaabbccddaabbccdd");
  });

  it("pads a small bigint to 32 hex characters", () => {
    expect(canonicalTraceKey(255n)).toBe("000000000000000000000000000000ff");
  });

  it("two 128-bit trace ids differing only above 2^53 must produce DIFFERENT keys", () => {
    // If canonicalization ever routed through Number()/parseInt, both of
    // these would collapse to the same imprecise float and collide.
    const a = "ffffffffffffffff0000000000000001";
    const b = "ffffffffffffffff0000000000000002";
    expect(canonicalTraceKey(a)).not.toBe(canonicalTraceKey(b));
  });

  it("rejects a non-32-hex string", () => {
    expect(() => canonicalTraceKey("not-hex")).toThrow(TypeError);
    expect(() => canonicalTraceKey("aa")).toThrow(TypeError);
  });

  it("rejects a negative bigint", () => {
    expect(() => canonicalTraceKey(-1n)).toThrow(TypeError);
  });

  it("rejects other types", () => {
    expect(() => canonicalTraceKey(123 as unknown as string)).toThrow(TypeError);
  });
});

describe("BoundedTraceMap", () => {
  it("stores and retrieves by string or bigint key interchangeably", () => {
    const map = new BoundedTraceMap();
    const hex = "0".repeat(31) + "1";
    map.set(hex, CTX);
    expect(map.get(1n)).toBe(CTX);
    expect(map.get(hex.toUpperCase())).toBe(CTX);
  });

  it("delete removes the entry", () => {
    const map = new BoundedTraceMap();
    map.set("1".repeat(32), CTX);
    map.delete("1".repeat(32));
    expect(map.get("1".repeat(32))).toBeNull();
    expect(map.size).toBe(0);
  });

  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const map = new BoundedTraceMap({ maxEntries: 2 });
    map.set("0".repeat(31) + "1", CTX);
    map.set("0".repeat(31) + "2", CTX);
    map.set("0".repeat(31) + "3", CTX); // evicts trace 1 (oldest)
    expect(map.size).toBe(2);
    expect(map.get("0".repeat(31) + "1")).toBeNull();
    expect(map.get("0".repeat(31) + "2")).toBe(CTX);
    expect(map.get("0".repeat(31) + "3")).toBe(CTX);
  });

  it("a read refreshes recency, protecting a hot entry from LRU eviction", () => {
    const map = new BoundedTraceMap({ maxEntries: 2 });
    const t1 = "0".repeat(31) + "1";
    const t2 = "0".repeat(31) + "2";
    const t3 = "0".repeat(31) + "3";
    map.set(t1, CTX);
    map.set(t2, CTX);
    map.get(t1); // touch t1 -> now more recent than t2
    map.set(t3, CTX); // evicts t2, not t1
    expect(map.get(t1)).toBe(CTX);
    expect(map.get(t2)).toBeNull();
    expect(map.get(t3)).toBe(CTX);
  });

  it("lazily expires an entry once its TTL elapses (injectable clock)", () => {
    let now = 1_000;
    const map = new BoundedTraceMap({ ttlMs: 100, now: () => now });
    const trace = "0".repeat(31) + "1";
    map.set(trace, CTX);
    now += 50;
    expect(map.get(trace)).toBe(CTX); // still fresh
    now += 100;
    expect(map.get(trace)).toBeNull(); // expired
    expect(map.size).toBe(0); // expired read also purges the entry
  });

  it("clear() drops everything", () => {
    const map = new BoundedTraceMap();
    map.set("0".repeat(31) + "1", CTX);
    map.set("0".repeat(31) + "2", CTX);
    map.clear();
    expect(map.size).toBe(0);
  });

  it("returns null for a trace id that was never registered", () => {
    const map = new BoundedTraceMap();
    expect(map.get("0".repeat(32))).toBeNull();
  });

  it("a misconfigured negative maxEntries never infinite-loops (defensive empty-map break)", () => {
    const map = new BoundedTraceMap({ maxEntries: -1 });
    // Insertion drives size above maxEntries even once empty; the eviction
    // loop must stop safely instead of looping forever on an empty map.
    expect(() => map.set("0".repeat(32), CTX)).not.toThrow();
    expect(map.size).toBe(0);
  });
});
