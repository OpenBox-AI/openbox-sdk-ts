/**
 * `function_call` family span assembly for `traced<T>()`. Pure data-assembly
 * — see `http-span-builder.ts` for the module pattern this mirrors.
 *
 * `args`/`result` capture is best-effort: `toJsonSafe` (Phase 2,
 * `serialization/index.ts`) recursively coerces arbitrary values into JSON
 * primitives, but a hostile/cyclic argument (or a getter that throws) must
 * never crash the governed call itself — a serialization failure degrades to
 * `null` for that field, mirroring `openbox-sdk-python`
 * `instrumentation/function.py` (`try: ... except Exception: fields["args"] = None`).
 * There is no size cap here beyond that: `core-span.ts`'s truncation list
 * (`request_body`/`response_body`) does not cover `args`/`result`, and adding
 * a bespoke cap for this phase would be scope creep — see the Tier A1
 * implementation report for the explicit scope note.
 */

import { HookType, SEMANTIC_FIELDS_BY_HOOK_TYPE, type SpanRecord } from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import { toJsonSafe } from "../serialization/index.js";

/** `toJsonSafe`, degrading to `null` instead of throwing (never crash the governed call over telemetry). */
function safeJsonSafe(value: unknown): JsonValue | null {
  try {
    return (toJsonSafe(value) ?? null) as JsonValue | null;
  } catch {
    return null;
  }
}

export interface FunctionSpanIdentity {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string | null;
}

export interface BuildStartedFunctionSpanInput extends FunctionSpanIdentity {
  readonly functionName: string;
  readonly moduleName: string | null;
  readonly startTimeNs: number;
  /** Present only when `captureArgs` is enabled; omitted/`undefined` means "do not capture". */
  readonly args?: readonly unknown[] | undefined;
}

/** Assemble the STARTED-stage `function_call` span (preflight — before the wrapped function runs). */
export function buildStartedFunctionSpan(input: BuildStartedFunctionSpanInput): SpanRecord {
  return {
    stage: "started",
    hook_type: HookType.FUNCTION_CALL,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `function.${input.functionName}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    function: input.functionName,
    module: input.moduleName,
    args: input.args !== undefined ? safeJsonSafe(input.args) : null,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FUNCTION_CALL]!]
  };
}

export interface BuildCompletedFunctionSpanInput extends FunctionSpanIdentity {
  readonly functionName: string;
  readonly moduleName: string | null;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly durationNs: number;
  readonly args?: readonly unknown[] | undefined;
  /** Present only when `captureResult` is enabled AND the call succeeded. */
  readonly result?: unknown;
  readonly error?: string | null;
}

/** Assemble the COMPLETED-stage `function_call` span (telemetry — after the wrapped function settles or throws). */
export function buildCompletedFunctionSpan(input: BuildCompletedFunctionSpanInput): SpanRecord {
  return {
    stage: "completed",
    hook_type: HookType.FUNCTION_CALL,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `function.${input.functionName}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    end_time: input.endTimeNs,
    duration_ns: input.durationNs,
    function: input.functionName,
    module: input.moduleName,
    args: input.args !== undefined ? safeJsonSafe(input.args) : null,
    result: input.result !== undefined ? safeJsonSafe(input.result) : null,
    error: input.error ?? null,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FUNCTION_CALL]!]
  };
}
