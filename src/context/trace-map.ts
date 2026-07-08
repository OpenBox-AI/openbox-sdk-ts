/**
 * Bounded trace-id -> ActivityContext correlation map.
 *
 * This is the SECOND lookup path `ContextStore` exposes, for hook or
 * instrumentation code that resolves the bound context outside the
 * AsyncLocalStorage-scoped call chain (e.g. a passive span-processor
 * correlating a child trace id minted after the activity was bound — a
 * later instrumentation phase).
 *
 * Keys are normalized to a canonical lowercase 32-hex-character string.
 * Both a hex string and a `bigint` are accepted as input, but the key is
 * NEVER derived via `parseInt`/`Number()` — either would silently lose
 * precision above 2^53 and could misattribute governance context across
 * activities/tenants in a long-lived, high-throughput process.
 *
 * Bounded by two independent mechanisms so code that forgets an explicit
 * `unregisterTrace` (or crashes mid-activity) cannot leak forever:
 *  - LRU eviction once `maxEntries` is exceeded (checked on every insert).
 *  - Lazy TTL expiry (checked on read) as a staleness backstop.
 */

import type { ActivityContext } from "../contracts/context.js";

export type TraceIdLike = string | bigint;

const HEX_32_RE = /^[0-9a-f]{32}$/;

/** Normalize a hex string or bigint trace id to a canonical lowercase 32-hex key. Never parseInt/Number(). */
export function canonicalTraceKey(traceId: TraceIdLike): string {
  if (typeof traceId === "bigint") {
    if (traceId < 0n) {
      throw new TypeError("traceId bigint must be non-negative");
    }
    return traceId.toString(16).padStart(32, "0");
  }
  if (typeof traceId === "string") {
    const normalized = traceId.trim().toLowerCase();
    if (!HEX_32_RE.test(normalized)) {
      throw new TypeError(
        `traceId string must be a 32-hex-character trace id, got: ${JSON.stringify(traceId)}`
      );
    }
    return normalized;
  }
  throw new TypeError(
    `traceId must be a 32-hex string or a bigint, got ${typeof traceId}`
  );
}

export interface BoundedTraceMapOptions {
  /** Hard cap on entries; oldest (least-recently-used) is evicted past this. */
  readonly maxEntries?: number;
  /** Lazy expiry window, measured from the last write (`set`); reads refresh LRU recency but not TTL. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic TTL tests. */
  readonly now?: () => number;
}

interface TraceEntry {
  readonly ctx: ActivityContext;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** LRU + TTL bounded map — the sole state backing `ContextStore`'s trace lookup path. */
export class BoundedTraceMap {
  private readonly entries = new Map<string, TraceEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedTraceMapOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  set(traceId: TraceIdLike, ctx: ActivityContext): void {
    const key = canonicalTraceKey(traceId);
    // Delete-then-set moves the key to the Map's most-recently-used end —
    // JS Maps preserve insertion order, so this is what makes eviction below
    // an actual LRU (not merely FIFO-since-first-insert).
    this.entries.delete(key);
    this.entries.set(key, { ctx, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(traceId: TraceIdLike): ActivityContext | null {
    const key = canonicalTraceKey(traceId);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency on read too (LRU, not just LRI).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.ctx;
  }

  delete(traceId: TraceIdLike): void {
    this.entries.delete(canonicalTraceKey(traceId));
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
