/**
 * `mongodb` v6 `Collection.prototype` CRUD governance wrapper — Tier B.
 *
 * Preflight blocking here is a CUSTOM WRAPPER, never OTel (Decision 15): wrap
 * the real prototype methods, `await runtime.preflight(...)` BEFORE calling
 * the original, `runtime.completed(...)` after (success + catch paths) —
 * structurally identical to the `pg` template
 * (`postgres-client-query-wrapper.ts`). Node has no `wrapt`-equivalent
 * generic method-patching helper, so each of the CRUD methods below is
 * hand-rolled via one shared factory (`buildGovernedCrudMethod`).
 *
 * ## Why `Collection`, and why only these twelve methods
 *
 * Unlike node-redis (no exported class — see `redis-command-wrapper.ts`),
 * `mongodb` exports its `Collection` class directly from the driver's public
 * API (`require("mongodb").Collection`, verified against the installed
 * `mongodb@6.21.0` source) — the same "public class, patch its prototype"
 * shape as `pg.Client` and `mysql2/promise`'s `Connection`.
 *
 * This wrapper governs every promise-returning `Collection` CRUD method. The
 * phase spec scopes this wrapper to "Collection CRUD" generically — it does
 * not name individual methods; the twelve below are this wrapper's own
 * enumeration of that surface, verified against the installed
 * `mongodb@6.21.0` `.d.ts` signatures: `insertOne`, `insertMany`,
 * `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`,
 * `findOne`, `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`,
 * `bulkWrite`.
 *
 * Explicit streaming carve-out — exactly three methods are deliberately never
 * patched: `find()` and `aggregate()` return a cursor SYNCHRONOUSLY
 * (`FindCursor<T>`/`AggregationCursor<T>`), and `watch()` (change streams)
 * synchronously returns a `ChangeStream`. None of the three ever produce a
 * `Promise` this wrapper's `await runtime.preflight(...)` → original →
 * `runtime.completed(...)` shape could wrap without breaking their
 * synchronous, event-driven return contract — this is this phase's own
 * "streaming is out of scope" carve-out (see `plan.md`'s Tier split), so
 * these three are simply never patched at all; no runtime call-shape
 * detection is needed the way `pg`'s Submittable/callback branch or `redis`'s
 * streaming-verb set are, because this wrapper never touches those methods in
 * the first place. (`bulkWrite()` is NOT part of this carve-out: unlike the
 * other three it returns `Promise<BulkWriteResult>`, verified against the
 * installed `.d.ts`, and is one of the twelve governed methods above.)
 *
 * ## Redaction (Decision 16) — the strictest of the four DB wrappers
 *
 * mongodb has no statement/bound-value split at all: the filter/document/
 * update argument passed to any of these twelve methods IS the query — there
 * is no separate "text" half the way pg/mysql2 have `text`/`QueryConfig.text`
 * or even the "verb + one visible key" convention `redis` uses. This wrapper
 * therefore NEVER serializes any argument content into `db_statement` —
 * `db_statement` is built purely from schema metadata already public on the
 * `Collection` instance itself (`"<collectionName>.<operationName>"`, e.g.
 * `"orders.insertOne"`), never from the call arguments.
 *
 * `db_operation` is left in the driver's own camelCase spelling
 * (`"insertOne"`, not `"INSERTONE"`) — SQL drivers uppercase because SQL
 * verbs are conventionally uppercase; mongodb's own idiomatic method names
 * are camelCase, so uppercasing them would be unrecognizable rather than
 * canonical.
 *
 * `server_address`/`server_port` are left `null`: a `Collection` is reached
 * through a `MongoClient` that may be a multi-host replica set/cluster, so
 * there is no single well-defined "the server" the way pg/mysql2's
 * single-socket connections have — reporting one host arbitrarily would be
 * misleading, not merely incomplete.
 *
 * Lazy-require (CRITICAL constraint): `mongodb` is an OPTIONAL PEER the
 * consumer provides (a devDependency HERE, for tests only — never a runtime
 * `dependency` of this package). `require("mongodb")` runs INSIDE
 * `installMongodbCollectionCrudWrapper`, never at module top level.
 *
 * Fail-loud (Decision 17): throws a plain `Error` (never silent) if `mongodb`
 * cannot be `require()`d, or if `Collection`/any of the twelve target methods
 * are missing/not functions (unsupported mongodb version or a broken/stubbed
 * module). Documented minimum supported version: mongodb >= 6 (the
 * `Collection` class and its promise-returning CRUD signatures have been
 * stable across the v6 line).
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

const MONGODB_DB_SYSTEM = "mongodb";

type UnknownFn = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

/** Read a property off a value we cannot trust the shape of (a result payload, or a test stub). Never throws. */
function readUnknownProperty(source: unknown, key: string): unknown {
  if (source === null) return undefined;
  const t = typeof source;
  if (t !== "object" && t !== "function") return undefined;
  return (source as Record<string, unknown>)[key];
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The twelve promise-returning CRUD methods this wrapper governs — see module docstring for why `find`/`aggregate`/`watch` are excluded. */
const CRUD_OPERATIONS = [
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "bulkWrite"
] as const;

type MongoCrudOperation = (typeof CRUD_OPERATIONS)[number];

/** Minimal shape of a `mongodb` `Collection` instance sufficient for span metadata. */
interface MongoCollectionLike {
  readonly dbName?: unknown;
  readonly collectionName?: unknown;
}

/** Best-effort row-count-equivalent per operation, read from that operation's own documented result shape. `null` when it cannot be determined. */
function extractMongoRowCount(operation: MongoCrudOperation, result: unknown): number | null {
  switch (operation) {
    case "insertOne": {
      const acknowledged = readUnknownProperty(result, "acknowledged");
      return acknowledged === true ? 1 : acknowledged === false ? 0 : null;
    }
    case "insertMany": {
      const insertedCount = readUnknownProperty(result, "insertedCount");
      return typeof insertedCount === "number" ? insertedCount : null;
    }
    case "updateOne":
    case "updateMany":
    case "replaceOne": {
      // `replaceOne` returns the same `UpdateResult` shape as `updateOne`/`updateMany` (verified in mongodb.d.ts).
      const modifiedCount = readUnknownProperty(result, "modifiedCount");
      return typeof modifiedCount === "number" ? modifiedCount : null;
    }
    case "deleteOne":
    case "deleteMany": {
      const deletedCount = readUnknownProperty(result, "deletedCount");
      return typeof deletedCount === "number" ? deletedCount : null;
    }
    case "findOne":
    case "findOneAndUpdate":
    case "findOneAndDelete":
    case "findOneAndReplace":
      // Default (`includeResultMetadata` unset/false) result contract is the
      // matched document or `null` — identical to findOne's own contract.
      // The rarer `includeResultMetadata: true` option instead returns a
      // `ModifyResult` wrapper object (always truthy, wrapping the real
      // `.value`), so that variant is best-effort only: a wrapped "not found"
      // (`.value === null`) still reports rowcount 1 here, matching this
      // function's documented "null when it cannot be determined" contract
      // rather than sniffing result shape from a document whose fields are
      // caller-defined.
      return result === null ? 0 : 1;
    case "bulkWrite":
      // A single bulkWrite call can mix inserts/updates/deletes/upserts in
      // one request — there is no single well-defined "rowcount" the way
      // there is for the single-purpose CRUD methods above, so this is
      // intentionally left undetermined rather than guessing via an
      // arbitrary sum of unrelated counters.
      return null;
  }
}

export interface MongodbCollectionCrudWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface MongodbCollectionCrudWrapperHandle {
  /** Restore the true original CRUD methods. Idempotent. */
  restore(): void;
}

/**
 * Install the governed `mongodb` `Collection.prototype` CRUD patch. Performs
 * exactly one install and returns a restore handle; fail-loud detection
 * lives here, strict-vs-diagnostic POLICY is the caller's job
 * (`src/instrumentation/index.ts`).
 */
export function installMongodbCollectionCrudWrapper(
  options: MongodbCollectionCrudWrapperOptions
): MongodbCollectionCrudWrapperHandle {
  const nodeRequire = createRequire(import.meta.url);
  let mongoModule: unknown;
  try {
    mongoModule = nodeRequire("mongodb");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`mongodb could not be loaded (is "mongodb" installed?) — cannot install DB governance: ${message}`);
  }

  const collectionCtor = readUnknownProperty(mongoModule, "Collection");
  const collectionPrototype = isFunction(collectionCtor) ? readUnknownProperty(collectionCtor, "prototype") : undefined;
  if (typeof collectionPrototype !== "object" || collectionPrototype === null) {
    throw new Error(
      "mongodb Collection.prototype is missing — cannot install DB governance (unsupported mongodb version? minimum supported: mongodb >= 6)"
    );
  }
  const prototypeRecord = collectionPrototype as Record<string, unknown>;

  const originals = new Map<MongoCrudOperation, UnknownFn>();
  for (const operation of CRUD_OPERATIONS) {
    const original = prototypeRecord[operation];
    if (!isFunction(original)) {
      throw new Error(
        `mongodb Collection.prototype.${operation} is missing or not a function — cannot install DB governance (unsupported mongodb version? minimum supported: mongodb >= 6)`
      );
    }
    originals.set(operation, original);
  }

  const { runtime } = options;
  let restored = false;

  /** Shared preflight/completed dance for all twelve CRUD methods — only the operation name and result shape differ. */
  function buildGovernedCrudMethod(operation: MongoCrudOperation): UnknownFn {
    // Populated for every entry in CRUD_OPERATIONS by the fail-loud loop above.
    const original = originals.get(operation)!;
    return async function openBoxGovernedMongoCrud(this: MongoCollectionLike, ...args: unknown[]): Promise<unknown> {
      const collectionName = toNullableString(this.collectionName);
      const dbName = toNullableString(this.dbName);
      const dbStatement = collectionName ? `${collectionName}.${operation}` : operation;
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
            dbSystem: MONGODB_DB_SYSTEM,
            dbName,
            dbOperation: operation,
            dbStatement,
            serverAddress: null,
            serverPort: null,
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
              dbSystem: MONGODB_DB_SYSTEM,
              dbName,
              dbOperation: operation,
              dbStatement,
              serverAddress: null,
              serverPort: null,
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
            dbSystem: MONGODB_DB_SYSTEM,
            dbName,
            dbOperation: operation,
            dbStatement,
            serverAddress: null,
            serverPort: null,
            rowcount: extractMongoRowCount(operation, result),
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

  for (const operation of CRUD_OPERATIONS) {
    prototypeRecord[operation] = buildGovernedCrudMethod(operation);
  }

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      for (const [operation, original] of originals) {
        prototypeRecord[operation] = original;
      }
    }
  };
}
