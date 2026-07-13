/**
 * Shared helpers for the `http_request` instrumentation wrappers — the global
 * `fetch` patch (`fetch-http-governance-patch.ts`) and the node:http/node:https
 * deferred-blocking patch (`node-http-governance-patch.ts`). Both build the same
 * `http_request` spans (`spans/http-span-builder.ts`) and share content-type
 * classification, header flattening, and the id/time/telemetry primitives.
 *
 * Pure helpers only: nothing here patches globals or runs at import time. The
 * span/trace id minting, epoch-ns clock, and `PendingTelemetry` drain set are
 * re-exported from `file-io-shared.ts` (they are generic instrumentation
 * primitives, named there for historical reasons) so HTTP code imports its whole
 * toolkit from one surface.
 */

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export { mintSpanId, mintTraceId, nowEpochNs, PendingTelemetry } from "./file-io-shared.js";

/**
 * Content-type substrings safe to capture as a text body. Superset of
 * openbox-sdk-python's `{json,text,xml}` — adds `javascript` and
 * `x-www-form-urlencoded`, both text payloads worth capturing for governance.
 */
export const TEXT_CONTENT_MARKERS = ["json", "text", "xml", "javascript", "x-www-form-urlencoded"];

/** True when the content type indicates text (safe to read as a body). */
export function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return true; // assume text when unspecified (matches openbox-sdk-python)
  const lower = contentType.toLowerCase();
  return TEXT_CONTENT_MARKERS.some((marker) => lower.includes(marker));
}

/** Case-insensitive value lookup over an already-flattened header record. */
export function headerValueCI(headers: Record<string, string> | null, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** Flatten a WHATWG `Headers` (fetch) to a plain record; keys arrive lowercased. */
export function headersRecordFromFetchHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Flatten node's outgoing/incoming header shapes to a plain record. Values arrive
 * as `string | string[] | number | undefined`; arrays join with `, `, numbers
 * coerce, and `undefined` entries are dropped. Keys are preserved as-is (Core-side
 * redaction lowercases before comparing, so case is irrelevant to redaction).
 */
export function headersRecordFromNodeHeaders(
  headers: OutgoingHttpHeaders | IncomingHttpHeaders | null | undefined
): Record<string, string> | null {
  if (!headers) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
