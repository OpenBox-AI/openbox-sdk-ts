/**
 * `pg` `Client.prototype.query` governance wrapper — Tier A2.
 *
 * Preflight blocking here is a CUSTOM WRAPPER, never OTel (Decision 15): wrap
 * the real prototype method, resolve the bound `ActivityContext` (via
 * `runtime.preflight`/`runtime.contextStore` internally — see
 * `runtime/hook-evaluator.ts`), build the `db_query` span, `await
 * runtime.preflight(...)` BEFORE calling the original `query`,
 * `runtime.completed(...)` in `finally`. A preflight BLOCK/HALT throws out of
 * `runtime.preflight`, so the real SQL dispatch below is provably never
 * reached.
 *
 * Lazy-require (CRITICAL constraint): `pg` is an OPTIONAL PEER the consumer
 * provides (a devDependency HERE, for tests only — never a runtime
 * `dependency` of this package). `require("pg")` runs INSIDE
 * `installPostgresClientQueryWrapper`, never at module top level, so merely
 * importing this file never loads `pg`.
 *
 * Scope — governs the PROMISE-returning call form only:
 * `await client.query(text, values?)` / `await client.query({text, values})`
 * — pg's dominant, documented modern usage. Two other call forms pass through
 * UNGOVERNED, matching this phase's own "streaming is out of scope" carve-out
 * (pg cursors are explicitly named as telemetry-only in the phase spec):
 *
 *  1. A `Submittable` (a `pg-cursor`/`pg-query-stream` object implementing
 *     `.submit()`) — pg's own streaming/cursor mechanism. This IS the "pg
 *     cursors" case the phase spec calls out as unblockable.
 *  2. A trailing callback argument (`query(text, cb)` / `query(text, values,
 *     cb)`) — legacy callback-style dispatch. `Client.prototype.query`
 *     returns a `Query` command object SYNCHRONOUSLY in this form (so callers
 *     can attach `.on('row', ...)` listeners), and a preflight gate is
 *     inherently asynchronous — gating this form would mean either breaking
 *     that synchronous return contract or silently returning a different
 *     value than callers expect. Deferred rather than done half-right.
 *
 * Bound values are NEVER read/serialized by this wrapper (Decision 16: redact
 * bound parameter values where the driver separates them) — only
 * `text`/`QueryConfig.text` (the SQL string, never containing literal bound
 * values when the caller uses parameterized queries) becomes `db_statement`;
 * the separate `values`/`QueryConfig.values` array is never touched.
 *
 * Fail-loud (Decision 17): throws a plain `Error` (never silent) if `pg`
 * cannot be `require()`d, or if `Client`/`Client.prototype.query` is
 * missing/not a function (unsupported pg version or a broken/stubbed
 * module). Policy (diagnostic vs. throw) is the caller's job — see
 * `assertPatchable` in `src/instrumentation/index.ts`. Documented minimum
 * supported version: pg >= 8.
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import type { ClientLogger } from "../client/index.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedDbSpan, buildStartedDbSpan } from "../spans/db-span-builder.js";

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

const PG_DB_SYSTEM = "postgresql";

type UnknownFn = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

/** Read a property off a value we cannot trust the shape of (a `require()`d module, or a test stub). Never throws. */
function readUnknownProperty(source: unknown, key: string): unknown {
  if (source === null) return undefined;
  const t = typeof source;
  if (t !== "object" && t !== "function") return undefined;
  return (source as Record<string, unknown>)[key];
}

/** Minimal query-config shape — avoids depending on `pg`'s own (devDependency-only) types. */
interface PgQueryConfigLike {
  readonly text?: unknown;
  readonly submit?: unknown; // presence marks a Submittable (pg-cursor/pg-query-stream) — out of scope, see module docstring
}

function isSubmittable(candidate: unknown): boolean {
  return typeof candidate === "object" && candidate !== null && isFunction((candidate as PgQueryConfigLike).submit);
}

function extractStatement(first: unknown): string | null {
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const text = (first as PgQueryConfigLike).text;
    if (typeof text === "string") return text;
  }
  return null;
}

/** First whitespace-delimited token, uppercased (SQL verb convention: "SELECT"/"INSERT"/...). */
function extractOperation(statement: string | null): string | null {
  const trimmed = statement?.trim();
  if (!trimmed) return null;
  // split(...,1) on a non-empty trimmed string always yields >= 1 element.
  return trimmed.split(/\s+/, 1)[0]!.toUpperCase();
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function extractRowCount(result: unknown): number | null {
  const rowCount = readUnknownProperty(result, "rowCount");
  return typeof rowCount === "number" ? rowCount : null;
}

/** Minimal shape of a `pg` `Client` instance sufficient for connection metadata. */
interface PgClientLike {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly database?: unknown;
}

export interface PostgresClientQueryWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface PostgresClientQueryWrapperHandle {
  /** Restore the true original `Client.prototype.query`. Idempotent. */
  restore(): void;
}

/**
 * Install the governed `pg` `Client.prototype.query` patch. Performs exactly
 * one install and returns a restore handle; fail-loud detection lives here,
 * strict-vs-diagnostic POLICY is the caller's job (`src/instrumentation/index.ts`).
 */
export function installPostgresClientQueryWrapper(
  options: PostgresClientQueryWrapperOptions
): PostgresClientQueryWrapperHandle {
  const nodeRequire = createRequire(import.meta.url);
  let pgModule: unknown;
  try {
    pgModule = nodeRequire("pg");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pg could not be loaded (is "pg" installed?) — cannot install DB governance: ${message}`);
  }

  const clientCtor = readUnknownProperty(pgModule, "Client");
  const clientPrototype = isFunction(clientCtor) ? readUnknownProperty(clientCtor, "prototype") : undefined;
  const originalQuery = readUnknownProperty(clientPrototype, "query");
  if (
    !isFunction(clientCtor) ||
    typeof clientPrototype !== "object" ||
    clientPrototype === null ||
    !isFunction(originalQuery)
  ) {
    throw new Error(
      "pg Client.prototype.query is missing or not a function — cannot install DB governance (unsupported pg version? minimum supported: pg >= 8)"
    );
  }
  const prototypeRecord = clientPrototype as Record<string, unknown>;
  // The fail-loud guard above proved originalQuery is callable; capture the
  // narrowed type in a const so the nested closure (into which TS does not carry
  // the narrowing) can invoke it without an `unknown` error.
  const boundOriginalQuery: UnknownFn = originalQuery;

  const { runtime } = options;
  let restored = false;

  async function governedQuery(this: PgClientLike, ...args: unknown[]): Promise<unknown> {
    const first = args.length > 0 ? args[0] : undefined;
    const lastArg = args.length > 0 ? args[args.length - 1] : undefined;

    // Out-of-scope call forms pass through entirely ungoverned — see module docstring.
    if (isSubmittable(first) || isFunction(lastArg)) {
      return boundOriginalQuery.apply(this, args);
    }

    const statement = extractStatement(first);
    const dbOperation = extractOperation(statement);
    const dbName = toNullableString(this.database);
    const serverAddress = toNullableString(this.host);
    const serverPort = toNullableNumber(this.port);
    const maxBodySize = runtime.config.privacy.maxBodySize;

    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();

    // BLOCK/HALT throws here — `originalQuery` below is provably never reached.
    await runtime.preflight({
      spans: [
        buildStartedDbSpan({
          spanId,
          traceId,
          dbSystem: PG_DB_SYSTEM,
          dbName,
          dbOperation,
          dbStatement: statement,
          serverAddress,
          serverPort,
          startTimeNs,
          maxBodySize
        })
      ]
    });

    let result: unknown;
    try {
      result = await boundOriginalQuery.apply(this, args);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.completed({
        spans: [
          buildCompletedDbSpan({
            spanId,
            traceId,
            dbSystem: PG_DB_SYSTEM,
            dbName,
            dbOperation,
            dbStatement: statement,
            serverAddress,
            serverPort,
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            error: message,
            maxBodySize
          })
        ]
      });
      throw error;
    }

    const endTimeNs = nowEpochNs();
    await runtime.completed({
      spans: [
        buildCompletedDbSpan({
          spanId,
          traceId,
          dbSystem: PG_DB_SYSTEM,
          dbName,
          dbOperation,
          dbStatement: statement,
          serverAddress,
          serverPort,
          rowcount: extractRowCount(result),
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          maxBodySize
        })
      ]
    });
    return result;
  }

  prototypeRecord["query"] = governedQuery;

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      prototypeRecord["query"] = originalQuery;
    }
  };
}
