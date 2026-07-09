/**
 * Shared helpers for the `file_operation` instrumentation wrappers —
 * `file-io-promises-wrapper.ts` (async, preflight-enforced) and
 * `file-io-sync-wrapper.ts` (sync, telemetry-only). Span/trace id minting,
 * epoch-ns timestamps, `PathLike` label conversion, best-effort byte counting,
 * and fire-and-forget completed-telemetry tracking.
 *
 * Pure helpers only: nothing here patches globals or runs at import time.
 */

import { randomBytes } from "node:crypto";

export function mintSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function mintTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Epoch nanoseconds at millisecond resolution — matches the field's documented precision trade-off (contracts/otel-spans.ts). */
export function nowEpochNs(): number {
  return Date.now() * 1_000_000;
}

/**
 * Best-effort byte count for a file payload. Handles `string` (UTF-8), `Buffer`,
 * `Uint8Array`, any other `ArrayBufferView` (typed arrays, `DataView`), and a
 * raw `ArrayBuffer`. Only ever reads a length — it NEVER inspects, copies, or
 * emits raw file content. Unknown shapes count as 0.
 */
export function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  // Covers Buffer, Uint8Array, every other typed array, and DataView.
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
}

/** Best-effort human-readable path label for the span; never throws. */
export function resolvePathLabel(candidate: unknown): string {
  if (typeof candidate === "string") return candidate;
  if (candidate instanceof URL) return candidate.toString();
  if (Buffer.isBuffer(candidate)) return candidate.toString();
  return String(candidate);
}

/**
 * Tracks fire-and-forget completed-telemetry promises so a SYNCHRONOUS fs
 * wrapper — which must return the original result before the async
 * `runtime.completed(...)` evaluation settles — can be drained on SDK close
 * (Phase 4 `flush()` / `await openbox.close()`), never dropping the last fs
 * event.
 *
 * Each tracked promise removes itself from the set on settle, so the set stays
 * bounded by the in-flight count. Rejections are swallowed here (the runtime
 * already logs completed-hook failures) so a failed telemetry send never
 * surfaces as an unhandled rejection.
 */
export class PendingTelemetry {
  private readonly pending = new Set<Promise<unknown>>();

  /** Register a completed-telemetry promise. Non-blocking; never throws. */
  track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => {});
    this.pending.add(tracked);
    void tracked.finally(() => {
      this.pending.delete(tracked);
    });
  }

  /** In-flight telemetry count (test/observability aid). */
  get size(): number {
    return this.pending.size;
  }

  /** Await every tracked promise to settle. Never throws. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}
