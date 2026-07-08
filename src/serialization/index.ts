/**
 * Byte/transform-only serialization.
 *
 * Knows NOTHING about events or spans — evaluate-body assembly (`span_count`,
 * compat-noise removal) is owned by `wire/`. This module owns exactly:
 *
 * - `serializeBody` — the EXACT bytes that are signed and transmitted
 * - `toJsonSafe`    — Date/Map/Set-tolerant JSON coercion
 * - `truncateString` / `applyRedaction` — pre-signing transforms
 * - `rfc3339Now`    — event-payload wall-clock helper
 *
 * No crypto/network imports — safe to import widely.
 */

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Current UTC time, RFC3339 with millisecond precision and trailing `Z`.
 *
 * This is the EVENT-payload timestamp format. It is distinct from the request
 * *signing* timestamp, which keeps a `+00:00` offset (see `identity/`). Here
 * `Date#toISOString()` is exactly correct (millis + `Z`).
 */
export function rfc3339Now(): string {
  return new Date().toISOString();
}

/**
 * Serialize a payload to the EXACT bytes that will be transmitted.
 *
 * - `null`/`undefined` → empty bytes (body hash becomes the empty-body SHA-256).
 * - Compact separators (no spaces) and a single serialization pass, so the bytes
 *   we hash are identical to the bytes we send.
 * - **Non-ASCII is escaped as `\uXXXX`** to match Python's `json.dumps` default
 *   `ensure_ascii=True`. Plain `JSON.stringify` emits raw UTF-8 → different bytes
 *   → different SHA-256 → Core rejects the signature (401). Escaping every UTF-16
 *   code unit >= 0x80 reproduces Python's output byte-for-byte, including
 *   surrogate pairs for astral characters. The regex `[^\x00-\x7F]` matches any
 *   code unit above ASCII and, because JS regexes iterate UTF-16 code units,
 *   escapes surrogate halves individually — exactly like Python.
 */
export function serializeBody(payload: unknown): Buffer {
  if (payload === null || payload === undefined) return Buffer.alloc(0);
  const json = JSON.stringify(payload);
  if (json === undefined) return Buffer.alloc(0);
  // eslint-disable-next-line no-control-regex -- intentional: match every code unit >= 0x80 (incl. C1) to ASCII-escape it
  const nonAscii = /[^\x00-\x7F]/g;
  const asciiSafe = json.replace(nonAscii, (ch) =>
    ("\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  );
  // asciiSafe is pure ASCII, so utf-8 encoding equals the ASCII bytes.
  return Buffer.from(asciiSafe, "utf-8");
}

/** Byte-equality helper (for hash/body checks and tests). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively coerce `obj` into JSON-serializable primitives.
 *
 * Handles Date (RFC3339 `Z`), Map/Set (objects/arrays), and nested structures.
 * With `excludeNone` (default), null/undefined object values are dropped; set it
 * false to preserve explicit nulls (the gate uses this for started-stage spans,
 * where `end_time:null`/`duration_ns:null` must survive serialization).
 */
export function toJsonSafe(obj: unknown, excludeNone = true): unknown {
  if (obj === null) return excludeNone ? undefined : null;
  if (obj === undefined) return undefined;
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
    return obj;
  }
  if (typeof obj === "bigint") return obj.toString();
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map((v) => toJsonSafe(v, excludeNone) ?? null);
  if (obj instanceof Set) return [...obj].map((v) => toJsonSafe(v, excludeNone) ?? null);
  if (obj instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of obj) {
      if (excludeNone && (v === null || v === undefined)) continue;
      out[String(k)] = toJsonSafe(v, excludeNone);
    }
    return out;
  }
  if (isPlainObject(obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (excludeNone && (v === null || v === undefined)) continue;
      out[k] = toJsonSafe(v, excludeNone);
    }
    return out;
  }
  // Best-effort coercion of an exotic type (symbol, function, class instance) —
  // governance telemetry must never crash the host over an unusual payload.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(obj);
}

/**
 * Truncate `value` to `maxSize` characters. Returns `[value, truncated]`.
 * `null`/non-positive `maxSize` disables truncation. Applied BEFORE signing —
 * the signed bytes are the truncated bytes.
 */
export function truncateString(value: string, maxSize: number | null): [string, boolean] {
  if (!maxSize || maxSize <= 0 || value.length <= maxSize) return [value, false];
  return [value.slice(0, maxSize), true];
}

/**
 * Replace values of case-insensitive key matches anywhere in `obj`. Returns
 * `[redactedCopy, changedPaths]` so callers can attach diagnostics. Applied
 * BEFORE signing.
 */
export function applyRedaction(
  obj: unknown,
  redactKeys: ReadonlySet<string> | readonly string[],
  replacement: string = REDACTED_PLACEHOLDER
): [unknown, string[]] {
  const lowered = new Set<string>();
  for (const k of redactKeys) lowered.add(k.toLowerCase());
  if (lowered.size === 0) return [obj, []];
  const changed: string[] = [];

  function walk(node: unknown, path: string): unknown {
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        const childPath = path ? `${path}.${k}` : k;
        if (lowered.has(k.toLowerCase())) {
          out[k] = replacement;
          changed.push(childPath);
        } else {
          out[k] = walk(v, childPath);
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, `${path}[${i}]`));
    }
    return node;
  }

  return [walk(obj, ""), changed];
}
