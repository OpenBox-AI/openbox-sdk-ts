/**
 * `traced<T>()` — opt-in function-call governance wrapper (Tier A1).
 *
 * Unlike fetch/fs.promises (global/shared-object patches installed by
 * `initOpenBoxInstrumentation`), a function wrapper has no ambient target to
 * monkey-patch — the caller explicitly wraps the function they want governed,
 * exactly like `openbox-sdk-python`'s `@governed` decorator and the Mastra
 * reference's own `traced<T>()`. Because `traced()` is typically applied at
 * MODULE load time (before `initOpenBoxInstrumentation()` may have run), the
 * active runtime is resolved per-CALL from module-level state set by
 * `initOpenBoxInstrumentation`/its `shutdown()` — mirroring Python's
 * `get_hook_runtime()` / Mastra's `activeHookGovernanceRuntime`. No active
 * runtime ⇒ zero-governance passthrough (fast path, matches both references).
 *
 * Preflight blocking is a CUSTOM WRAPPER (Decision 15): `await
 * runtime.preflight(...)` runs BEFORE `fn(...args)`, so a BLOCK/HALT throws
 * and the wrapped function body provably never executes.
 */

import { randomBytes } from "node:crypto";

import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedFunctionSpan, buildStartedFunctionSpan } from "../spans/function-span-builder.js";

function mintSpanId(): string {
  return randomBytes(8).toString("hex");
}

function mintTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Epoch nanoseconds at millisecond resolution — matches the field's documented precision trade-off (contracts/otel-spans.ts). */
function nowEpochNs(): number {
  return Date.now() * 1_000_000;
}

let activeRuntime: OpenBoxRuntime | null = null;

/**
 * @internal Set by `initOpenBoxInstrumentation()`/its `shutdown()` only. Not
 * part of the public instrumentation surface — call sites outside this
 * package must never call this directly.
 */
export function setTracedGovernanceRuntime(runtime: OpenBoxRuntime | null): void {
  activeRuntime = runtime;
}

/** @internal Test/introspection seam — the runtime `traced()` currently resolves calls against. */
export function getTracedGovernanceRuntime(): OpenBoxRuntime | null {
  return activeRuntime;
}

export interface TracedOptions {
  /** Span/identifier name; defaults to `fn.name` (or `"anonymous"`). */
  readonly name?: string;
  readonly module?: string;
  /** Capture the call arguments on the span. Default `true`. */
  readonly captureArgs?: boolean;
  /** Capture the return value on the completed span. Default `true`. */
  readonly captureResult?: boolean;
}

/**
 * Wrap an async function with started/completed hook governance. Returns a
 * function with the SAME call signature; the wrapped function's `this` is
 * NOT forwarded (matches the Mastra reference — callers needing `this` should
 * bind before wrapping).
 */
export function traced<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: TracedOptions = {}
): (...args: TArgs) => Promise<TResult> {
  const functionName = options.name ?? (fn.name || "anonymous");
  const moduleName = options.module ?? null;
  const captureArgs = options.captureArgs ?? true;
  const captureResult = options.captureResult ?? true;

  return async function openBoxTracedFunction(...args: TArgs): Promise<TResult> {
    const runtime = activeRuntime;
    if (runtime === null) return fn(...args);

    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();

    // BLOCK/HALT throws here — `fn` below is provably never invoked.
    await runtime.preflight({
      spans: [
        buildStartedFunctionSpan({
          spanId,
          traceId,
          functionName,
          moduleName,
          startTimeNs,
          args: captureArgs ? args : undefined
        })
      ]
    });

    let result: TResult;
    try {
      result = await fn(...args);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.completed({
        spans: [
          buildCompletedFunctionSpan({
            spanId,
            traceId,
            functionName,
            moduleName,
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            args: captureArgs ? args : undefined,
            error: message
          })
        ]
      });
      throw error;
    }

    const endTimeNs = nowEpochNs();
    await runtime.completed({
      spans: [
        buildCompletedFunctionSpan({
          spanId,
          traceId,
          functionName,
          moduleName,
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          args: captureArgs ? args : undefined,
          result: captureResult ? result : undefined
        })
      ]
    });
    return result;
  };
}
