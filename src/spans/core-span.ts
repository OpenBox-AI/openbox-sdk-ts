/**
 * `toCoreSpanData` — normalize a flat Core `SpanData` wire span.
 *
 * Wire rules:
 *
 * - Ids are HEX STRINGS: span_id 16 chars, trace_id 32 chars, parent_span_id
 *   16 chars or null. Converting raw OTel integer ids to hex is a real-Node-
 *   instrumentation concern (a later phase); this normalizer only guarantees
 *   defaults and passes through whatever hex the caller/wrapper supplied.
 * - Timestamps are epoch NANOSECONDS, represented as a JS `number` (see
 *   `contracts/otel-spans.ts` field matrix comment for the precision
 *   trade-off — a deliberate, documented decision: bigint cannot pass
 *   `JSON.stringify`, and no `.rego` policy reads these fields at
 *   nanosecond precision).
 * - started-stage spans emit EXPLICIT `end_time: null` and `duration_ns: null`
 *   (never omitted, never `end_time == start_time`) — Core's non-pointer
 *   `EndTime int64` unmarshals `null` -> `0`.
 * - The COMMON root fields are ALWAYS present — null-valued when absent,
 *   never omitted — matching the flat hook contract.
 * - Each hook family's own root fields (http_*, db_*, file_*, function) are
 *   ALSO always present for that family (null when the wrapper/attributes did not
 *   supply them). `attributes` carries OTel-native attributes ONLY.
 * - `semantic_type` is NEVER computed here — Core computes it; the key is
 *   only guaranteed present (null) so the wire matrix never silently omits it.
 * - Hook spans are FLAT in memory and on the wire: no `data` blob and no
 *   nested `{"otel", "openbox", "metadata"}` envelope.
 */

import type { PrivacyConfig } from "../config/index.js";
import {
  DiagnosticLevel,
  SPAN_ATTR_MISSING,
  makeDiagnostic,
  redactionDiagnostics,
  truncationDiagnostic,
  type Diagnostic
} from "../contracts/diagnostics.js";
import {
  COMMON_SPAN_DEFAULTS,
  ROOT_FIELDS_BY_HOOK_TYPE,
  SEMANTIC_FIELDS_BY_HOOK_TYPE,
  Stage,
  type SpanRecord
} from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import { applyRedaction, truncateString } from "../serialization/index.js";

// Wrapper-supplied fields eligible for body truncation.
const TRUNCATABLE_FIELDS = ["request_body", "response_body"] as const;

export interface ToCoreSpanDataOptions {
  privacy?: PrivacyConfig | null;
}

export interface ToCoreSpanDataResult {
  wireSpan: SpanRecord;
  diagnostics: Diagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clone a mutable default (`dict`/`list`) so spans never share references. */
function cloneDefaultValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return [...value];
  if (isPlainObject(value)) return { ...value };
  return value;
}

/**
 * INFO diagnostics for missing best-effort semantic fields. The span is still
 * sent — semantic gaps NEVER reject a span.
 */
export function semanticGapDiagnostics(
  spanWire: Readonly<SpanRecord>,
  hookType: string | null
): Diagnostic[] {
  const fields = SEMANTIC_FIELDS_BY_HOOK_TYPE[hookType ?? ""] ?? [];
  const diagnostics: Diagnostic[] = [];
  for (const fieldName of fields) {
    const value = spanWire[fieldName];
    if (value === null || value === undefined) {
      diagnostics.push(
        makeDiagnostic(
          DiagnosticLevel.INFO,
          SPAN_ATTR_MISSING,
          `Best-effort semantic attribute missing: ${fieldName}`,
          { hook_type: hookType, field: fieldName }
        )
      );
    }
  }
  return diagnostics;
}

/**
 * Normalize one flat Core `SpanData` dict.
 *
 * Returns `{wireSpan, diagnostics}`. Missing semantic attributes are
 * diagnostics, never failures; redaction/truncation is recorded.
 */
export function toCoreSpanData(
  span: Readonly<SpanRecord>,
  options: ToCoreSpanDataOptions = {}
): ToCoreSpanDataResult {
  const privacy = options.privacy ?? null;
  const diagnostics: Diagnostic[] = [];
  const wire: SpanRecord = { ...span };

  // Never let nested/debug shapes leak forward.
  delete wire["otel"];
  delete wire["openbox"];
  delete wire["data"];
  delete wire["metadata"];

  // Captured before defaults are filled below (COMMON_SPAN_DEFAULTS also
  // guarantees a `hook_type: null` key, which must not shadow this lookup).
  const rawHookType = span["hook_type"];
  const hookType = typeof rawHookType === "string" && rawHookType ? rawHookType : null;

  let attributes: Record<string, JsonValue> = isPlainObject(wire["attributes"])
    ? { ...wire["attributes"] }
    : {};
  if (privacy && privacy.redactKeys.size > 0) {
    const [redacted, changed] = applyRedaction(attributes, privacy.redactKeys);
    attributes = redacted as Record<string, JsonValue>;
    if (changed.length > 0) {
      diagnostics.push(...redactionDiagnostics(changed.map((path) => `attributes.${path}`)));
    }
  }
  wire["attributes"] = attributes;

  for (const fieldName of TRUNCATABLE_FIELDS) {
    if (!(fieldName in wire)) continue;
    const value = wire[fieldName];
    if (privacy && typeof value === "string") {
      const [truncated, wasTruncated] = truncateString(value, privacy.maxBodySize);
      if (wasTruncated) {
        diagnostics.push(truncationDiagnostic(fieldName, value.length, privacy.maxBodySize));
      }
      wire[fieldName] = truncated;
    }
  }

  for (const [fieldName, defaultValue] of Object.entries(COMMON_SPAN_DEFAULTS)) {
    if (fieldName in wire) continue;
    wire[fieldName] = cloneDefaultValue(defaultValue);
  }

  // Guarantee every family-specific root key exists (explicit null if neither
  // attributes nor the wrapper supplied it); the flat hook contract emits the
  // full family key set, and Core's `omitempty` tolerates the nulls.
  for (const fieldName of ROOT_FIELDS_BY_HOOK_TYPE[hookType ?? ""] ?? []) {
    if (!(fieldName in wire)) wire[fieldName] = null;
  }

  // OTel-owned HTTP spans are not always ended when the response hook fires,
  // so `end_time` may be null even though a duration was measured.
  // Reconstruct it from start_time + duration for completed spans.
  if (wire["stage"] !== Stage.STARTED && (wire["end_time"] === null || wire["end_time"] === undefined)) {
    const startTime = wire["start_time"];
    const measured = wire["duration_ns"];
    if (typeof startTime === "number" && typeof measured === "number") {
      wire["end_time"] = startTime + measured;
    }
  }

  diagnostics.push(...semanticGapDiagnostics(wire, hookType));
  return { wireSpan: wire, diagnostics };
}
