import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applyRedaction,
  bytesEqual,
  rfc3339Now,
  serializeBody,
  toJsonSafe,
  truncateString
} from "../src/serialization/index.js";

describe("serializeBody", () => {
  it("emits compact separators with no spaces", () => {
    expect(serializeBody({ a: 1, b: [1, 2] }).toString("utf-8")).toBe('{"a":1,"b":[1,2]}');
  });

  it("null/undefined serialize to empty bytes", () => {
    expect(serializeBody(null).length).toBe(0);
    expect(serializeBody(undefined).length).toBe(0);
  });

  it("escapes non-ASCII as \\uXXXX (ensure_ascii parity), not raw UTF-8", () => {
    const bytes = serializeBody({ note: "café☕" });
    const text = bytes.toString("utf-8");
    // Every byte is ASCII (< 0x80) — proves nothing was emitted as raw UTF-8.
    expect(bytes.every((b) => b < 0x80)).toBe(true);
    expect(text).toBe('{"note":"caf\\u00e9\\u2615"}');
  });

  it("escapes astral characters as surrogate pairs (matches Python)", () => {
    // U+1F600 GRINNING FACE → surrogate pair 😀.
    expect(serializeBody({ e: "😀" }).toString("utf-8")).toBe('{"e":"\\ud83d\\ude00"}');
  });

  it("produces a stable hash for a non-ASCII payload", () => {
    const a = createHash("sha256").update(serializeBody({ x: "é" })).digest("hex");
    const b = createHash("sha256").update(serializeBody({ x: "é" })).digest("hex");
    expect(a).toBe(b);
    // Raw-UTF-8 stringify would differ from the ASCII-escaped bytes.
    expect(serializeBody({ x: "é" }).toString("utf-8")).toBe('{"x":"\\u00e9"}');
  });
});

describe("rfc3339Now", () => {
  it("uses Z with millisecond precision (event-payload format)", () => {
    expect(rfc3339Now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("toJsonSafe", () => {
  it("drops null/undefined keys by default; keeps them when excludeNone=false", () => {
    expect(toJsonSafe({ a: 1, b: null, c: undefined })).toEqual({ a: 1 });
    expect(toJsonSafe({ a: 1, b: null }, false)).toEqual({ a: 1, b: null });
  });

  it("coerces Date, Map, Set, bigint", () => {
    const date = new Date("2026-07-02T00:00:00.000Z");
    expect(toJsonSafe(date)).toBe("2026-07-02T00:00:00.000Z");
    expect(toJsonSafe(new Map([["k", 1]]))).toEqual({ k: 1 });
    expect(toJsonSafe(new Set([1, 2]))).toEqual([1, 2]);
    expect(toJsonSafe(10n)).toBe("10");
  });

  it("preserves explicit null inside arrays and passes through primitives", () => {
    expect(toJsonSafe([1, null], false)).toEqual([1, null]);
    expect(toJsonSafe("x")).toBe("x");
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(undefined)).toBeUndefined();
  });
});

describe("truncateString", () => {
  it("truncates only above maxSize", () => {
    expect(truncateString("hello", 3)).toEqual(["hel", true]);
    expect(truncateString("hi", 3)).toEqual(["hi", false]);
    expect(truncateString("hi", null)).toEqual(["hi", false]);
    expect(truncateString("hi", 0)).toEqual(["hi", false]);
  });
});

describe("applyRedaction", () => {
  it("replaces case-insensitive key matches anywhere, reporting paths", () => {
    const [redacted, changed] = applyRedaction(
      { Password: "secret", nested: { token: "abc", ok: 1 } },
      new Set(["password", "token"])
    );
    expect(redacted).toEqual({ Password: "[REDACTED]", nested: { token: "[REDACTED]", ok: 1 } });
    expect(changed.sort()).toEqual(["Password", "nested.token"]);
  });

  it("is a no-op with no redact keys", () => {
    const obj = { a: 1 };
    expect(applyRedaction(obj, [])).toEqual([obj, []]);
  });
});

describe("bytesEqual", () => {
  it("compares byte content", () => {
    expect(bytesEqual(Buffer.from("ab"), Buffer.from("ab"))).toBe(true);
    expect(bytesEqual(Buffer.from("ab"), Buffer.from("ac"))).toBe(false);
    expect(bytesEqual(Buffer.from("a"), Buffer.from("ab"))).toBe(false);
  });
});
