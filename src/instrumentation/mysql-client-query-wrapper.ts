/**
 * `mysql2` promise-API `Connection.prototype.query`/`.execute` governance
 * wrapper — Tier B.
 *
 * Preflight blocking here is a CUSTOM WRAPPER, never OTel (Decision 15): wrap
 * the real prototype methods, `await runtime.preflight(...)` BEFORE calling
 * the original, `runtime.completed(...)` after (success + catch paths) —
 * structurally identical to the `pg` template
 * (`postgres-client-query-wrapper.ts`).
 *
 * ## Which module this patches, and why
 *
 * mysql2 ships two INDEPENDENT API surfaces from two different entry points:
 *
 *   - `require("mysql2")` — the classic callback-style module. Its
 *     `Connection.prototype.query`, when called WITHOUT a trailing callback,
 *     returns a `Query` (an `EventEmitter`) synchronously so callers can
 *     attach `.on('result', ...)` listeners for streaming — the same
 *     "returns a live dispatch object, not a Promise" shape `pg`'s
 *     `Submittable`/callback forms have.
 *   - `require("mysql2/promise")` — a promise WRAPPER around the callback
 *     module. Its exported `Connection` (really `PromiseConnection`,
 *     verified against the installed `mysql2@3.22.6` source) implements
 *     `query`/`execute` that ALWAYS return a `Promise` and THROW
 *     synchronously if handed a trailing callback ("Callback function is not
 *     available with promise clients.") — there is no streaming method on
 *     this class at all; reaching the underlying callback connection to
 *     stream requires going around `PromiseConnection` entirely
 *     (`promiseConnection.connection`).
 *
 * This wrapper patches ONLY `mysql2/promise`'s exported `Connection.prototype`
 * — pg's dominant, documented modern usage equivalent for mysql2. The
 * callback-style module is never `require()`d or touched by this file, so
 * callback and streaming usage of mysql2 pass through UNGOVERNED simply by
 * never being patched in the first place (no runtime detection needed, unlike
 * `pg`'s single-module callback/Submittable branch check).
 *
 * Bound values are NEVER read/serialized by this wrapper (Decision 16: redact
 * bound parameter values where the driver separates them) — only the raw SQL
 * text (`query`/`QueryOptions.sql`, mirroring pg's `text`/`QueryConfig.text`)
 * becomes `db_statement`; the separate values/params argument is never
 * touched.
 *
 * Lazy-require (CRITICAL constraint): `mysql2` is an OPTIONAL PEER the
 * consumer provides (a devDependency HERE, for tests only — never a runtime
 * `dependency` of this package). `require("mysql2/promise")` runs INSIDE
 * `installMysqlClientQueryWrapper`, never at module top level.
 *
 * Fail-loud (Decision 17): throws a plain `Error` (never silent) if `mysql2`
 * cannot be `require()`d, or if the promise module's `Connection.prototype.query`
 * / `.execute` are missing/not functions (unsupported mysql2 version or a
 * broken/stubbed module). Documented minimum supported version: mysql2 >= 3
 * (the promise wrapper's `Connection`/`query`/`execute` shape has been stable
 * across the v3 line).
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

const MYSQL_DB_SYSTEM = "mysql";

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

/** Minimal query-options shape — avoids depending on `mysql2`'s own (devDependency-only) types. */
interface MysqlQueryOptionsLike {
  readonly sql?: unknown;
}

function extractStatement(first: unknown): string | null {
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const sql = (first as MysqlQueryOptionsLike).sql;
    if (typeof sql === "string") return sql;
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

/**
 * mysql2 resolves `query`/`execute` to a `[rows, fields]` tuple. `rows` is
 * either an array (SELECT) or a single `ResultSetHeader`-shaped object with
 * `affectedRows` (INSERT/UPDATE/DELETE).
 */
function extractRowCount(result: unknown): number | null {
  if (!Array.isArray(result) || result.length === 0) return null;
  const rows: unknown = result[0];
  if (Array.isArray(rows)) return rows.length;
  const affectedRows = readUnknownProperty(rows, "affectedRows");
  return typeof affectedRows === "number" ? affectedRows : null;
}

/** Minimal shape of a `mysql2/promise` `Connection` instance sufficient for connection metadata. */
interface MysqlConnectionLike {
  readonly config?: unknown;
}

export interface MysqlClientQueryWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface MysqlClientQueryWrapperHandle {
  /** Restore the true original `query`/`execute`. Idempotent. */
  restore(): void;
}

/**
 * Install the governed `mysql2/promise` `Connection.prototype.query`/`.execute`
 * patch. Performs exactly one install and returns a restore handle;
 * fail-loud detection lives here, strict-vs-diagnostic POLICY is the
 * caller's job (`src/instrumentation/index.ts`).
 */
export function installMysqlClientQueryWrapper(
  options: MysqlClientQueryWrapperOptions
): MysqlClientQueryWrapperHandle {
  const nodeRequire = createRequire(import.meta.url);
  let mysqlPromiseModule: unknown;
  try {
    mysqlPromiseModule = nodeRequire("mysql2/promise");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`mysql2 could not be loaded (is "mysql2" installed?) — cannot install DB governance: ${message}`);
  }

  const connectionCtor = readUnknownProperty(mysqlPromiseModule, "Connection");
  const connectionPrototype = isFunction(connectionCtor) ? readUnknownProperty(connectionCtor, "prototype") : undefined;
  const originalQuery = readUnknownProperty(connectionPrototype, "query");
  const originalExecute = readUnknownProperty(connectionPrototype, "execute");
  if (
    !isFunction(connectionCtor) ||
    typeof connectionPrototype !== "object" ||
    connectionPrototype === null ||
    !isFunction(originalQuery) ||
    !isFunction(originalExecute)
  ) {
    throw new Error(
      "mysql2/promise Connection.prototype.query/execute is missing or not a function — cannot install DB governance (unsupported mysql2 version? minimum supported: mysql2 >= 3)"
    );
  }
  const prototypeRecord = connectionPrototype as Record<string, unknown>;
  // The fail-loud guard above proved both are callable; capture the narrowed
  // types in consts so the nested closure (into which TS does not carry the
  // narrowing) can invoke them without an `unknown` error.
  const boundOriginalQuery: UnknownFn = originalQuery;
  const boundOriginalExecute: UnknownFn = originalExecute;

  const { runtime } = options;
  let restored = false;

  /** Shared preflight/completed dance for both `query` and `execute` — their promise/callback/statement shapes are identical. */
  function buildGovernedMethod(original: UnknownFn): UnknownFn {
    return async function openBoxGovernedMysqlMethod(this: MysqlConnectionLike, ...args: unknown[]): Promise<unknown> {
      const first = args.length > 0 ? args[0] : undefined;
      const lastArg = args.length > 0 ? args[args.length - 1] : undefined;

      // mysql2/promise's query/execute THROW synchronously when handed a
      // trailing callback ("Callback function is not available with promise
      // clients.") — pass through so the original's own error surfaces
      // normally, rather than spending a preflight round-trip on a call that
      // is guaranteed to fail regardless of the verdict.
      if (isFunction(lastArg)) {
        return original.apply(this, args);
      }

      const statement = extractStatement(first);
      const dbOperation = extractOperation(statement);
      const dbName = toNullableString(readUnknownProperty(this.config, "database"));
      const serverAddress = toNullableString(readUnknownProperty(this.config, "host"));
      const serverPort = toNullableNumber(readUnknownProperty(this.config, "port"));
      const maxBodySize = runtime.config.privacy.maxBodySize;

      const spanId = mintSpanId();
      const traceId = mintTraceId();
      const startTimeNs = nowEpochNs();

      // BLOCK/HALT throws here — `original` below is provably never reached.
      await runtime.preflight({
        spans: [
          buildStartedDbSpan({
            spanId,
            traceId,
            dbSystem: MYSQL_DB_SYSTEM,
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
        result = await original.apply(this, args);
      } catch (error) {
        const endTimeNs = nowEpochNs();
        const message = error instanceof Error ? error.message : String(error);
        await runtime.completed({
          spans: [
            buildCompletedDbSpan({
              spanId,
              traceId,
              dbSystem: MYSQL_DB_SYSTEM,
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
            dbSystem: MYSQL_DB_SYSTEM,
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
    };
  }

  prototypeRecord["query"] = buildGovernedMethod(boundOriginalQuery);
  prototypeRecord["execute"] = buildGovernedMethod(boundOriginalExecute);

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      prototypeRecord["query"] = originalQuery;
      prototypeRecord["execute"] = originalExecute;
    }
  };
}
