/**
 * `buildEvaluatePayload` — the SINGLE owner of the evaluate request body.
 *
 * Assembles the exact `/api/v1/governance/evaluate` body for hook events: the
 * `EventEnvelope` fields at the top level (`event_type=ActivityStarted`,
 * `hook_trigger=true`, `activity_id`/`activity_type`, `timestamp`), `spans` as
 * a list of flat Core `SpanData` dicts, and `span_count`.
 *
 * The gate (`gate/index.ts`) injects this as its hook payload builder — the
 * gate never reimplements body assembly, and `serialization.serializeBody`
 * (byte-only) then produces the signed bytes. `EventEnvelope.toPayloadDict()`
 * NEVER emits `spans`/`span_count` — this module is the only place that does.
 */

import type { PrivacyConfig } from "../config/index.js";
import type { EventEnvelope } from "../contracts/events.js";
import type { Diagnostic } from "../contracts/diagnostics.js";
import type { SpanRecord } from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import { toCoreSpanData } from "../spans/core-span.js";

export interface BuildEvaluatePayloadOptions {
  privacy?: PrivacyConfig | null;
}

export interface BuildEvaluatePayloadResult {
  payload: Record<string, JsonValue>;
  diagnostics: Diagnostic[];
}

/**
 * Assemble the hook evaluate body from a validated hook envelope.
 *
 * Spans are flat Core `SpanData` dicts in memory. `toCoreSpanData` enforces
 * the final no-nested/no-data wire shape and applies privacy transforms.
 */
export function buildEvaluatePayload(
  event: EventEnvelope,
  options: BuildEvaluatePayloadOptions = {}
): BuildEvaluatePayloadResult {
  const diagnostics: Diagnostic[] = [];
  const wireSpans: SpanRecord[] = [];
  for (const span of event.spans) {
    const { wireSpan, diagnostics: spanDiagnostics } = toCoreSpanData(span, {
      privacy: options.privacy ?? null
    });
    diagnostics.push(...spanDiagnostics);
    wireSpans.push(wireSpan);
  }

  const payload = event.toPayloadDict();
  payload["spans"] = wireSpans;
  payload["span_count"] = wireSpans.length;
  return { payload, diagnostics };
}

/** Bind a privacy config into a single-argument hook payload-builder seam. */
export function makePayloadBuilder(
  privacy?: PrivacyConfig | null
): (event: EventEnvelope) => BuildEvaluatePayloadResult {
  return (event: EventEnvelope) => buildEvaluatePayload(event, { privacy: privacy ?? null });
}
