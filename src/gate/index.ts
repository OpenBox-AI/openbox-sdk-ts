/**
 * Always-strict validation gate: envelope/stage checks (delegated to
 * `event-rules.ts`), compat-noise strip, finalize (JSON-safe + redaction
 * before signing), and payload preparation. Verdict enforcement
 * (`raiseForVerdict`) lives in `./verdict.js` and is re-exported here so this
 * file stays under the project's per-file line guideline.
 *
 * The gate is ALWAYS STRICT for OpenBox event contracts and runtime
 * invariants: malformed contracts throw `ContractError` BEFORE any network
 * send. There is deliberately NO `mode`/`OBSERVE`/`SANITIZE`/`STRICT` toggle
 * anywhere in this API — fail-open policy applies only to network errors
 * inside `client/index.ts`, never to contract violations.
 *
 * This module owns PURE preparation (validate → stamp → strip → finalize); it
 * does not call the network client or drive approvals — wiring this to
 * `OpenBoxClient` + a `FrameworkAdapter` is `OpenBoxRuntime`'s job (a later
 * phase). `prepareLifecyclePayload`/`prepareHookPayload` give that future
 * runtime the exact ingredients Python's `GovernanceGate._prepare_lifecycle`/
 * `_prepare_hook` combine internally.
 *
 * Enforcement priority (for adapters interpreting results):
 * HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW.
 */

import type { PrivacyConfig } from "../config/index.js";
import {
  COMPAT_NOISE_REMOVED,
  DiagnosticLevel,
  makeDiagnostic,
  redactionDiagnostics,
  type Diagnostic
} from "../contracts/diagnostics.js";
import type { EventEnvelope } from "../contracts/events.js";
import { Stage, type SpanRecord } from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import { applyRedaction, rfc3339Now, toJsonSafe } from "../serialization/index.js";
import {
  checkHookEnvelope,
  checkLifecycleEnvelope,
  checkStage,
  spanStage
} from "./event-rules.js";

export { checkHookEnvelope, checkLifecycleEnvelope, checkStage, spanStage };
export { raiseForVerdict } from "./verdict.js";

/** Hook stage constants (re-exported from `contracts/otel-spans.ts` for gate callers). */
export const STAGE_STARTED: Stage = Stage.STARTED;
export const STAGE_COMPLETED: Stage = Stage.COMPLETED;

/** A payload + the diagnostics accumulated while building/finalizing it. */
export interface GatePayloadResult {
  payload: Record<string, JsonValue>;
  diagnostics: Diagnostic[];
}

/** `event.spans` -> flat wire spans + `span_count` (see `wire/evaluate-payload.ts`). */
export type HookPayloadBuilder = (event: EventEnvelope) => {
  payload: Record<string, JsonValue>;
  diagnostics: Diagnostic[];
};

// ── Validation dispatch ──────────────────────────────────────────────────────

/**
 * Validate a lifecycle/signal/handoff envelope. Throws `ContractError` on
 * violation; returns diagnostics (none today — reserved for future rules).
 */
export function validateLifecycle(event: EventEnvelope): Diagnostic[] {
  checkLifecycleEnvelope(event);
  return [];
}

/**
 * Validate a hook envelope for the given stage (`"started"`/`"completed"`).
 * `checkHookEnvelope`'s first rule rejects `hookTrigger=false`, which also
 * covers non-HOOK envelopes routed here by mistake.
 */
export function validateHook(event: EventEnvelope, expectedStage: string): Diagnostic[] {
  checkHookEnvelope(event);
  checkStage(event, expectedStage);
  return [];
}

// ── Compat-noise + finalize ──────────────────────────────────────────────────

/**
 * Remove `spans=[]`/`span_count=0` from a lifecycle wire payload.
 *
 * Core ignores these empty fields, but they are contract noise. Removal is
 * recorded as a diagnostic — it is NOT a configurable mode. Non-empty spans
 * are not touched here (they are a strict failure upstream).
 */
export function stripCompatNoise(payload: Readonly<Record<string, JsonValue>>): GatePayloadResult {
  const cleaned: Record<string, JsonValue> = { ...payload };
  const removed: string[] = [];

  const spans = cleaned["spans"];
  if (Array.isArray(spans) && spans.length === 0) {
    delete cleaned["spans"];
    removed.push("spans");
  }
  if (cleaned["span_count"] === 0) {
    delete cleaned["span_count"];
    removed.push("span_count");
  }
  if (removed.length === 0) return { payload: cleaned, diagnostics: [] };
  return {
    payload: cleaned,
    diagnostics: [
      makeDiagnostic(
        DiagnosticLevel.INFO,
        COMPAT_NOISE_REMOVED,
        `Removed compatibility noise before send: ${JSON.stringify(removed)}`,
        { removed }
      )
    ]
  };
}

/** Stamp `timestamp` at the send boundary if the payload doesn't already carry one (setdefault semantics). */
export function stampTimestamp(payload: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  if (payload["timestamp"] !== undefined) return { ...payload };
  return { ...payload, timestamp: rfc3339Now() };
}

export interface FinalizePayloadOptions {
  privacy?: PrivacyConfig | null;
}

/**
 * JSON-safety + privacy redaction, applied BEFORE signing/sending.
 *
 * Null-inclusion (`toJsonSafe(payload, false)`) is deliberate: started-stage
 * spans carry EXPLICIT `end_time: null` / `duration_ns: null` (Core's
 * non-pointer int64 relies on them), so nulls must survive to the wire.
 * Omit-when-absent is handled where payloads are BUILT (keys left out), not
 * by dropping null here.
 */
export function finalizePayload(
  payload: Record<string, JsonValue>,
  diagnostics: readonly Diagnostic[],
  options: FinalizePayloadOptions = {}
): GatePayloadResult {
  const safe = toJsonSafe(payload, false) as Record<string, JsonValue>;
  const redactKeys = options.privacy?.redactKeys;
  if (redactKeys && redactKeys.size > 0) {
    const [redacted, changed] = applyRedaction(safe, redactKeys);
    return {
      payload: redacted as Record<string, JsonValue>,
      diagnostics: [...diagnostics, ...redactionDiagnostics(changed)]
    };
  }
  return { payload: safe, diagnostics: [...diagnostics] };
}

// ── Composed preparation (validate → stamp → strip/build → finalize) ────────

/** Prepare a lifecycle/signal/handoff payload end to end. Throws `ContractError` on violation. */
export function prepareLifecyclePayload(
  event: EventEnvelope,
  options: FinalizePayloadOptions = {}
): GatePayloadResult {
  const diagnostics = validateLifecycle(event);
  const stamped = stampTimestamp(event.toPayloadDict());
  const stripped = stripCompatNoise(stamped);
  return finalizePayload(stripped.payload, [...diagnostics, ...stripped.diagnostics], options);
}

/**
 * Prepare a hook payload end to end. `payloadBuilder` is the injected single
 * owner of `spans`/`span_count` assembly (`wire/evaluate-payload.ts`'s
 * `buildEvaluatePayload`, typically bound via `makePayloadBuilder`).
 */
export function prepareHookPayload(
  event: EventEnvelope,
  expectedStage: string,
  payloadBuilder: HookPayloadBuilder,
  options: FinalizePayloadOptions = {}
): GatePayloadResult {
  const diagnostics = validateHook(event, expectedStage);
  const built = payloadBuilder(event);
  const stamped = stampTimestamp(built.payload);
  return finalizePayload(stamped, [...diagnostics, ...built.diagnostics], options);
}

// Re-exported so callers normalizing raw span dicts don't need a second import.
export type { SpanRecord };
