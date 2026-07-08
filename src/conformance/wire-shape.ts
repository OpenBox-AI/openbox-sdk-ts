/**
 * `assertHookWireShape` — assert a captured evaluate payload matches the flat
 * Core hook wire contract. Mirrors `openbox-sdk-python`
 * `conformance/fake_core.assert_hook_wire_shape`, adapted to this SDK's own
 * (fuller) field matrix: `contracts/otel-spans.ts` is the single source of
 * truth for the common/family field lists, so this never drifts from it.
 *
 * Uses `node:assert/strict` rather than a test-framework `expect` so this
 * stays usable from any test runner (it is a test UTILITY, not a frozen
 * public API — see plan.md; promoted to a shared package only when a second
 * consumer needs it).
 */

import assert from "node:assert/strict";

import { COMMON_SPAN_DEFAULTS, ROOT_FIELDS_BY_HOOK_TYPE } from "../contracts/otel-spans.js";

const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const COMMON_ROOT_FIELDS = Object.keys(COMMON_SPAN_DEFAULTS);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFlatSpanShape(span: Readonly<Record<string, unknown>>, index: number): void {
  assert.ok(!("otel" in span) && !("openbox" in span), `spans[${index}]: nested envelope leaked to the wire`);
  assert.ok(!("data" in span), `spans[${index}]: flat hook spans must not carry a data blob`);
  // Guaranteed-present-but-null (Core computes it) — see contracts/otel-spans.ts.
  assert.equal(span["semantic_type"], null, `spans[${index}]: semantic_type must be Core-computed (null from the SDK)`);

  for (const field of COMMON_ROOT_FIELDS) {
    assert.ok(field in span, `spans[${index}]: missing common root field '${field}'`);
  }

  const spanId = span["span_id"];
  assert.ok(
    typeof spanId === "string" && SPAN_ID_RE.test(spanId),
    `spans[${index}]: span_id must be 16 lowercase-hex chars, got ${JSON.stringify(spanId)}`
  );
  const traceId = span["trace_id"];
  assert.ok(
    typeof traceId === "string" && TRACE_ID_RE.test(traceId),
    `spans[${index}]: trace_id must be 32 lowercase-hex chars, got ${JSON.stringify(traceId)}`
  );
  const parentSpanId = span["parent_span_id"];
  if (parentSpanId !== null) {
    assert.ok(
      typeof parentSpanId === "string" && SPAN_ID_RE.test(parentSpanId),
      `spans[${index}]: parent_span_id must be 16 lowercase-hex chars or null, got ${JSON.stringify(parentSpanId)}`
    );
  }

  const stage = span["stage"];
  assert.ok(stage === "started" || stage === "completed", `spans[${index}]: stage must be started|completed, got ${JSON.stringify(stage)}`);

  const hookType = span["hook_type"];
  assert.ok(typeof hookType === "string" && hookType.length > 0, `spans[${index}]: hook_type must be non-empty at the root`);
  for (const field of ROOT_FIELDS_BY_HOOK_TYPE[hookType] ?? []) {
    assert.ok(field in span, `spans[${index}]: missing ${hookType} root field '${field}'`);
  }

  if (stage === "started") {
    assert.equal(span["end_time"], null, `spans[${index}]: started-stage end_time must be explicit null`);
    assert.equal(span["duration_ns"], null, `spans[${index}]: started-stage duration_ns must be explicit null`);
  }
}

/**
 * Assert one captured hook payload matches the flat Core wire contract:
 * `event_type=ActivityStarted` + `hook_trigger=true` + non-empty `spans`,
 * `span_count == spans.length`, hex-string ids (regex, not truthiness), no
 * nested `otel`/`openbox`/`data` envelope, every common + family-specific
 * root field present, and explicit started-stage `end_time`/`duration_ns`
 * nulls. Throws `AssertionError` (from `node:assert/strict`) on violation.
 */
export function assertHookWireShape(payload: Readonly<Record<string, unknown>>): void {
  assert.equal(payload["event_type"], "ActivityStarted", `event_type must be ActivityStarted, got ${JSON.stringify(payload["event_type"])}`);
  assert.equal(payload["hook_trigger"], true, "hook_trigger must be true");

  const spans = payload["spans"];
  assert.ok(Array.isArray(spans) && spans.length > 0, "hook payload must carry non-empty spans");
  assert.equal(payload["span_count"], spans.length, "span_count must equal spans.length");

  spans.forEach((raw: unknown, index: number) => {
    assert.ok(isPlainRecord(raw), `spans[${index}] must be a flat object`);
    assertFlatSpanShape(raw, index);
  });
}
