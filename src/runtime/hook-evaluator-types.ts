/**
 * Types + small pure helpers for `HookEvaluator` (split out of
 * `hook-evaluator.ts` to keep that file focused on the decision logic and
 * under the project's per-file line guideline — no behavior here).
 */

import type { FrameworkAdapter } from "../adapters/base.js";
import type { ClientLogger, OpenBoxClient } from "../client/index.js";
import type { PrivacyConfig } from "../config/index.js";
import type { ContextStore, TraceIdLike } from "../context/index.js";
import type { ActivityContext } from "../contracts/context.js";
import type { EventEnvelope } from "../contracts/events.js";
import type { SpanRecord } from "../contracts/otel-spans.js";
import { ContractError, GovernanceAPIError, OpenBoxAuthError } from "../errors/index.js";
import type { BuildEvaluatePayloadResult } from "../wire/evaluate-payload.js";

export interface HookEvaluationInput {
  /** Non-empty flat Core `SpanData` payloads for this evaluation. */
  readonly spans: readonly SpanRecord[];
  /**
   * Trace-map fallback key, used only when no context is bound on the
   * current async flow (e.g. detached instrumentation callbacks). Real
   * span -> trace-id extraction is an instrumentation-layer concern.
   */
  readonly traceId?: TraceIdLike;
  readonly timestamp?: string | null;
}

export interface HookEvaluatorDeps {
  readonly client: OpenBoxClient;
  readonly contextStore: ContextStore;
  readonly adapter: FrameworkAdapter;
  readonly payloadBuilder: (event: EventEnvelope) => BuildEvaluatePayloadResult;
  readonly privacy: PrivacyConfig;
  readonly preflightEnabled: () => boolean;
  readonly completedTelemetryEnabled: () => boolean;
  readonly logger: ClientLogger;
}

export interface BoundHookContext {
  readonly ctx: ActivityContext;
  readonly activityId: string;
  readonly activityType: string;
}

/**
 * Conditions under which a STARTED-hook evaluation failure must fail CLOSED
 * (routed through `adapter.raiseHookBlocked` as a synthetic HALT) rather than
 * propagate raw. `OpenBoxAuthError` (and its `OpenBoxSigningError` subtype)
 * is TS-specific: unlike Python's client, `OpenBoxClient.evaluate` can throw
 * an auth/signing error for a persistent 401/403 (see errors/index.ts) —
 * every preflight-stopping condition must go through the same adapter seam.
 */
export function isFailClosedCondition(error: unknown): boolean {
  return (
    error instanceof ContractError ||
    error instanceof GovernanceAPIError ||
    error instanceof OpenBoxAuthError
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
