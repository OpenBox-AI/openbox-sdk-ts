/**
 * `ContextStore` — AsyncLocalStorage-scoped activity binding + bounded trace
 * correlation + governance flags.
 *
 * Two complementary lookup paths (both required):
 *  1. `AsyncLocalStorage` — the context bound to the current async call chain.
 *  2. trace-id -> `ActivityContext` map — for hook/instrumentation code that
 *     resolves context OUTSIDE that call chain (see `./trace-map.js`).
 *
 * Node's `AsyncLocalStorage` has NO restore-token API (unlike Python's
 * `contextvars.Token`/`ContextVar.reset`), and `enterWith()` does not unwind
 * for sibling calls — so scoping uses `als.run(ctx, callback)`, which
 * correctly re-establishes the PREVIOUS store once `callback` (and anything
 * it awaits) is done. See `activityScope` below.
 *
 * IMPORTANT — per-runtime, not process-global: each `OpenBoxRuntime` owns
 * its OWN `ContextStore` instance (constructed here, or injected). There is
 * deliberately no process-wide default store/singleton (unlike the Python
 * base SDK's `default_context_store()`): a second runtime's `close()` must
 * never clear a first runtime's bound activities or aborted-activity flags.
 * A separate, later question — a single process-wide *instrumentation*
 * controller for global driver patches — is deferred to that phase.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { ActivityContext } from "../contracts/context.js";
import {
  BoundedTraceMap,
  canonicalTraceKey,
  type BoundedTraceMapOptions,
  type TraceIdLike
} from "./trace-map.js";

export { canonicalTraceKey, BoundedTraceMap };
export type { BoundedTraceMapOptions, TraceIdLike };

export interface ActivityScopeOptions {
  /** Also register `ctx` under this trace id for the trace-map fallback lookup. */
  readonly traceId?: TraceIdLike;
}

export interface ContextStoreOptions {
  readonly traceMap?: BoundedTraceMapOptions;
  /** Hard cap on retained aborted-activity flags; the oldest is evicted past this. */
  readonly maxAbortedActivities?: number;
}

// The abort flag persists to short-circuit FUTURE execution of the same
// activity, so it is deliberately NOT cleared on scope exit. To stay bounded in
// a long-lived worker, the set is capped (FIFO eviction) — well above any
// realistic count of concurrently-blocked distinct activities.
const DEFAULT_MAX_ABORTED_ACTIVITIES = 10_000;

/** Runtime check for a thenable — used to defer scope cleanup past async callbacks. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class ContextStore {
  private readonly als = new AsyncLocalStorage<ActivityContext>();
  private readonly traceMap: BoundedTraceMap;
  private readonly abortedActivities = new Set<string>();
  private readonly maxAbortedActivities: number;
  private haltFlag = false;

  constructor(options: ContextStoreOptions = {}) {
    this.traceMap = new BoundedTraceMap(options.traceMap);
    this.maxAbortedActivities = options.maxAbortedActivities ?? DEFAULT_MAX_ABORTED_ACTIVITIES;
  }

  // ── AsyncLocalStorage binding ────────────────────────────────────────────

  /**
   * Run `cb` with `ctx` bound for its entire ASYNC lifetime.
   *
   * `AsyncLocalStorage` propagates the bound store across every `await`
   * inside `cb`, even though `als.run` itself returns as soon as `cb` does
   * (immediately, for an async function that has not yet settled) — this is
   * standard, documented Node behavior and is what makes two overlapping
   * `activityScope` calls never cross-observe each other's context.
   *
   * When `options.traceId` is given, the trace-map fallback entry is
   * registered up front and its removal is GUARANTEED once `cb` settles —
   * including when `cb` returns a Promise: cleanup is chained via
   * `.finally()` so the entry survives every await inside `cb`, not merely
   * its synchronous prefix (a plain `try/finally` around `cb()` would
   * unregister immediately after the synchronous prefix returns a pending
   * Promise, well before the awaited work actually finishes).
   */
  activityScope<T>(ctx: ActivityContext, cb: () => T): T;
  activityScope<T>(ctx: ActivityContext, options: ActivityScopeOptions, cb: () => T): T;
  activityScope(
    ctx: ActivityContext,
    optionsOrCb: ActivityScopeOptions | (() => unknown),
    maybeCb?: () => unknown
  ): unknown {
    const options: ActivityScopeOptions = typeof optionsOrCb === "function" ? {} : optionsOrCb;
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    if (cb === undefined) {
      throw new TypeError("activityScope: a callback is required");
    }

    return this.als.run(ctx, () => {
      if (options.traceId !== undefined) this.registerTrace(options.traceId, ctx);
      const traceId = options.traceId;
      const cleanup = (): void => {
        if (traceId !== undefined) this.unregisterTrace(traceId);
      };

      let result: unknown;
      try {
        result = cb();
      } catch (error) {
        cleanup();
        throw error;
      }

      if (isThenable(result)) {
        return Promise.resolve(result).finally(cleanup);
      }
      cleanup();
      return result;
    });
  }

  /** The context bound to the current async flow, or `null`. */
  currentActivityContext(): ActivityContext | null {
    return this.als.getStore() ?? null;
  }

  // ── Trace correlation map ────────────────────────────────────────────────

  registerTrace(traceId: TraceIdLike, ctx: ActivityContext): void {
    this.traceMap.set(traceId, ctx);
  }

  contextForTrace(traceId: TraceIdLike): ActivityContext | null {
    return this.traceMap.get(traceId);
  }

  /** Mandatory cleanup on activity completion/session end. */
  unregisterTrace(traceId: TraceIdLike): void {
    this.traceMap.delete(traceId);
  }

  /** Observability/leak-test hook. */
  traceMapSize(): number {
    return this.traceMap.size;
  }

  /** Observability/leak-test hook for the (bounded) aborted-activity set. */
  abortedActivitiesSize(): number {
    return this.abortedActivities.size;
  }

  // ── Governance flags (abort short-circuit, halt) ────────────────────────

  private static activityKey(workflowId: string | null, activityId: string | null): string {
    return `${String(workflowId)}:${String(activityId)}`;
  }

  /** Record that a prior hook verdict already stopped this activity (fail-fast, no re-evaluation). */
  markActivityAborted(workflowId: string | null, activityId: string | null): void {
    const key = ContextStore.activityKey(workflowId, activityId);
    if (this.abortedActivities.has(key)) return;
    this.abortedActivities.add(key);
    // Bounded FIFO: an evicted-then-re-executed activity is simply re-evaluated
    // (fail-safe — Core returns the same verdict), never wrongly allowed.
    if (this.abortedActivities.size > this.maxAbortedActivities) {
      const oldest = this.abortedActivities.values().next().value;
      if (oldest !== undefined) this.abortedActivities.delete(oldest);
    }
  }

  isActivityAborted(workflowId: string | null, activityId: string | null): boolean {
    return this.abortedActivities.has(ContextStore.activityKey(workflowId, activityId));
  }

  clearActivityAborted(workflowId: string | null, activityId: string | null): void {
    this.abortedActivities.delete(ContextStore.activityKey(workflowId, activityId));
  }

  /** Expose a HALT request; the framework adapter decides how to stop future work. */
  requestHalt(): void {
    this.haltFlag = true;
  }

  get haltRequested(): boolean {
    return this.haltFlag;
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  /** Drop ALL correlation state and flags (runtime close). Idempotent. */
  clear(): void {
    this.traceMap.clear();
    this.abortedActivities.clear();
    this.haltFlag = false;
  }
}
