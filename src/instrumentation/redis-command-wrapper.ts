/**
 * node-redis (v4/v5) command-dispatch governance wrapper — Tier A2.
 *
 * ## COVERAGE LIMITATION — read this first
 *
 * This wrapper governs `client.sendCommand([...])` ONLY — node-redis's raw,
 * low-level "send a command array" escape hatch. The ~200 auto-generated
 * TYPED command methods (`client.get()`, `.set()`, `.hGet()`, ...) are NOT
 * intercepted and are therefore NEVER preflight-blocked or traced by this
 * wrapper; a consumer that needs every command governed must issue it via
 * `client.sendCommand(["GET", key])` instead of `client.get(key)`. This is a
 * documented, verified limitation of node-redis's internals (see "Scope"
 * below for the full mechanism), not a bug in this wrapper, and not
 * something a future change to this file can "just fix" by patching more
 * prototype methods (see "Scope" below for why that specifically does not
 * work). `installRedisCommandWrapper` emits a one-time `logger.warn` stating
 * this same limitation at install time, so it is never silently invisible to
 * a consumer who only reads logs rather than source — see
 * `docs/instrumentation-coverage.md` for the consumer-facing summary.
 *
 * Preflight blocking here is a CUSTOM WRAPPER, never OTel (Decision 15):
 * node-redis v4/v5 has no `requestHook`-style extension point at all, so
 * there is nothing for OTel to block through in the first place — this
 * module wraps the real prototype method directly, `await
 * runtime.preflight(...)` BEFORE calling the original command dispatch, and
 * `runtime.completed(...)` after (success + catch paths), exactly like the
 * `pg` template (`postgres-client-query-wrapper.ts`).
 *
 * ## Scope — VERIFIED node-redis internal quirk (read before changing this file)
 *
 * This wrapper governs ONLY `RedisClient.prototype.sendCommand(args, options)`
 * — node-redis's documented low-level "send a raw command array" escape
 * hatch, present in both v4 and v5. It deliberately does NOT attempt to
 * govern the ~200 auto-generated typed command methods (`client.get()`,
 * `.set()`, `.hGet()`, ...), because doing so via prototype patching does
 * not work — verified empirically against the installed `redis@4.7.1`
 * (`@redis/client@1.6.1`) source:
 *
 *   - Every typed command method is created ONCE, the first time anything in
 *     the process `require()`s `redis`/`@redis/client`, via
 *     `attachCommands({ BaseClass: RedisClient, commands, executor:
 *     RedisClient.prototype.commandsExecutor })`. `attachCommands` builds
 *     each method as `function(...args) { return executor.call(this,
 *     command, args, name); }` — `executor` is a plain JS closure variable,
 *     bound to whatever function VALUE `RedisClient.prototype.commandsExecutor`
 *     held at that single call site, not a live `this.commandsExecutor(...)`
 *     lookup. Reassigning `RedisClient.prototype.commandsExecutor` afterwards
 *     — which is unavoidable, since `require("redis")` must fully evaluate
 *     (generating every command method) before this wrapper's `install`
 *     function ever runs — has NO EFFECT on those already-created closures.
 *   - The per-module command namespaces the top-level `redis` package always
 *     injects (`.json.*`, `.ft.*`, `.ts.*`, `.ml.*`/bloom) DO re-read
 *     `RedisClient.prototype.commandsExecutor` fresh on every `createClient()`
 *     call, so patching it would help ONLY for clients created after this
 *     wrapper installs — an ordering this SDK cannot guarantee (the host
 *     application may construct its redis client before ever calling
 *     `initOpenBoxInstrumentation()`). Patching `commandsExecutor` anyway
 *     would create a false impression of coverage without ever being
 *     reliable, so this wrapper does not attempt it.
 *   - The private implementation both `commandsExecutor` and the public
 *     `sendCommand` ultimately call is a true ECMAScript `#private` class
 *     method — genuinely unreachable from outside the class body, by design.
 *
 * **Net effect:** only calls that go through the public `sendCommand` method
 * are governed. A consumer that needs every command governed must issue it
 * via the raw form — `client.sendCommand(["GET", key])` instead of
 * `client.get(key)` — this is a documented limitation, not a bug, and is
 * reported as a deviation alongside this phase's other findings.
 *
 * ## No exported class — why this wrapper constructs a throwaway client
 *
 * Unlike `pg` (`Client`) or `mysql2/promise` (`Connection`), node-redis
 * exports NO public class at all — only a `createClient()` FACTORY function
 * (`RedisClient` itself, and the dynamic per-call subclass `createClient()`
 * actually instantiates, are both unexported internals). The only way to
 * reach the shared prototype every client instance inherits `sendCommand`
 * from is to construct one instance and walk its prototype chain. This
 * wrapper builds exactly one such client via the real, public `createClient()`
 * — and NEVER calls `.connect()` on it, so no socket I/O ever happens — purely
 * to locate the prototype object that owns `sendCommand`, then discards the
 * throwaway instance immediately. `findPrototypeOwningMethod` below reads
 * property DESCRIPTORS (never invokes a property getter — `RedisClient`
 * exposes several, e.g. `v4`, that throw when accessed off-mode) while
 * walking the chain, so probing is side-effect-free.
 *
 * ## Redaction (Decision 16)
 *
 * redis does not separate statement text from bound values the way pg/mysql2
 * do — a command array like `["SET", "foo", "secret-value"]` mixes the verb,
 * the key, and the value inline. `db_statement` therefore keeps only the verb
 * plus the first positional argument (the redis key, for commands that have
 * one) and replaces every remaining argument with a bare `?` — never
 * serializing an actual argument value.
 *
 * ## Out of scope (telemetry-only-or-nothing, never preflighted)
 *
 * `SUBSCRIBE`/`UNSUBSCRIBE`/`PSUBSCRIBE`/`PUNSUBSCRIBE`/`SSUBSCRIBE`/
 * `SUNSUBSCRIBE` (pub/sub — already structurally exempt, since they dispatch
 * via a dedicated `#pubSubCommand` path, never `sendCommand`) and
 * `XREAD`/`XREADGROUP` (streaming reads) are matched by verb, case-
 * insensitively, and passed straight to the original — this is this phase's
 * own "streaming is out of scope" carve-out (see `plan.md`'s Tier split).
 *
 * Lazy-require (CRITICAL constraint): `redis` is an OPTIONAL PEER the
 * consumer provides (a devDependency HERE, for tests only — never a runtime
 * `dependency` of this package). `require("redis")` runs INSIDE
 * `installRedisCommandWrapper`, never at module top level.
 *
 * Fail-loud (Decision 17): throws a plain `Error` (never silent) if `redis`
 * cannot be `require()`d, if `createClient` is missing, or if no prototype in
 * the throwaway client's chain owns a callable `sendCommand` (unsupported
 * redis version or a broken/stubbed module). Documented minimum supported
 * version: node-redis (the `redis` npm package) v4 or v5 — both build on the
 * same `@redis/client` `RedisClient` base whose `sendCommand` shape has been
 * stable across both majors.
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

const REDIS_DB_SYSTEM = "redis";

/**
 * Emitted once per successful `installRedisCommandWrapper` call (never per
 * dispatched command) — see the module docstring's "COVERAGE LIMITATION"
 * section for the full explanation of why typed commands are unreachable.
 */
const REDIS_COVERAGE_LIMITATION_WARNING =
  "OpenBox redis governance intercepts client.sendCommand([...]) only; typed commands (.get/.set/…) are NOT preflight-blocked — see docs/instrumentation-coverage.md.";

type UnknownFn = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

/** Read a property off a value we cannot trust the shape of. Never throws. */
function readUnknownProperty(source: unknown, key: string): unknown {
  if (source === null) return undefined;
  const t = typeof source;
  if (t !== "object" && t !== "function") return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Walk `instance`'s prototype chain looking for the object that OWNS
 * `methodName` as its own function-valued property. Reads property
 * DESCRIPTORS rather than the property itself, so an accessor (`get`/`set`)
 * property of the same name is never invoked — see module docstring (some
 * `RedisClient` getters throw when accessed off-mode). `null` if not found
 * within a bounded number of hops (defends against a corrupted/cyclic chain).
 */
function findPrototypeOwningMethod(instance: unknown, methodName: string): Record<string, unknown> | null {
  const t = typeof instance;
  let proto: unknown = instance === null || (t !== "object" && t !== "function") ? null : Object.getPrototypeOf(instance);
  for (let hops = 0; proto !== null && hops < 16; hops += 1) {
    const protoType = typeof proto;
    if (protoType === "object" || protoType === "function") {
      const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
      if (descriptor && isFunction(descriptor.value)) {
        return proto as Record<string, unknown>;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/** Command verbs that establish a long-lived/streaming exchange — out of scope, see module docstring. */
const STREAMING_OR_PUBSUB_COMMANDS = new Set([
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "PSUBSCRIBE",
  "PUNSUBSCRIBE",
  "SSUBSCRIBE",
  "SUNSUBSCRIBE",
  "XREAD",
  "XREADGROUP"
]);

/** The raw command verb (`args[0]`, uppercased), or `null` when it cannot be determined. */
function extractRedisOperation(rawArgs: unknown): string | null {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) return null;
  const first: unknown = rawArgs[0];
  return typeof first === "string" ? first.toUpperCase() : null;
}

/** Value-redacted `db_statement` — verb + key visible, everything past the key becomes `?` (Decision 16; see module docstring). */
function buildRedisDbStatement(rawArgs: unknown, operation: string | null): string | null {
  if (operation === null || !Array.isArray(rawArgs)) return null;
  if (rawArgs.length <= 1) return operation;
  const key: unknown = rawArgs[1];
  const keyLabel = typeof key === "string" ? key : typeof key === "number" ? String(key) : "?";
  const redactedRest = rawArgs.slice(2).map(() => "?");
  return [operation, keyLabel, ...redactedRest].join(" ");
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Minimal shape of a `redis` client instance sufficient for connection metadata. */
interface RedisClientLike {
  readonly options?: unknown;
}

function extractDbName(clientOptions: unknown): string | null {
  const database = readUnknownProperty(clientOptions, "database");
  return typeof database === "number" ? String(database) : null;
}

function extractServerAddress(clientOptions: unknown): string | null {
  return toNullableString(readUnknownProperty(readUnknownProperty(clientOptions, "socket"), "host"));
}

function extractServerPort(clientOptions: unknown): number | null {
  return toNullableNumber(readUnknownProperty(readUnknownProperty(clientOptions, "socket"), "port"));
}

export interface RedisCommandWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface RedisCommandWrapperHandle {
  /** Restore the true original `sendCommand`. Idempotent. */
  restore(): void;
}

/**
 * Install the governed `redis` `sendCommand` patch. Performs exactly one
 * install and returns a restore handle; fail-loud detection lives here,
 * strict-vs-diagnostic POLICY is the caller's job (`src/instrumentation/index.ts`).
 */
export function installRedisCommandWrapper(options: RedisCommandWrapperOptions): RedisCommandWrapperHandle {
  const nodeRequire = createRequire(import.meta.url);
  let redisModule: unknown;
  try {
    redisModule = nodeRequire("redis");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`redis could not be loaded (is "redis" installed?) — cannot install DB governance: ${message}`);
  }

  const createClientFn = readUnknownProperty(redisModule, "createClient");
  if (!isFunction(createClientFn)) {
    throw new Error(
      "redis createClient is missing or not a function — cannot install DB governance (unsupported redis version? minimum supported: node-redis v4+)"
    );
  }

  // No public class is exported — construct one disposable, NEVER-CONNECTED
  // client purely to reach the shared prototype. See module docstring.
  let probe: unknown;
  try {
    probe = createClientFn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `redis createClient() failed while probing for the governance target (no connection was attempted) — cannot install DB governance: ${message}`
    );
  }
  const probeOn = readUnknownProperty(probe, "on");
  if (isFunction(probeOn)) {
    // Defensive only: this probe is never connected, so no event is ever
    // expected to fire — but an unhandled 'error' event on an EventEmitter
    // crashes the process.
    probeOn.call(probe, "error", () => {});
  }

  const sendCommandOwner = findPrototypeOwningMethod(probe, "sendCommand");
  const originalSendCommand = sendCommandOwner ? sendCommandOwner["sendCommand"] : undefined;
  if (sendCommandOwner === null || !isFunction(originalSendCommand)) {
    throw new Error(
      "redis RedisClient.prototype.sendCommand is missing or not a function — cannot install DB governance (unsupported redis version? minimum supported: node-redis v4+)"
    );
  }
  // The fail-loud guard above proved both are non-null/callable; capture
  // narrowed consts so the nested closures below (into which TS does not
  // carry the narrowing) can use them without an `unknown`-related error.
  const ownerRecord: Record<string, unknown> = sendCommandOwner;
  const boundOriginalSendCommand: UnknownFn = originalSendCommand;

  const { runtime } = options;
  const logger = options.logger ?? console;
  let restored = false;

  async function governedSendCommand(this: RedisClientLike, ...args: unknown[]): Promise<unknown> {
    const rawArgs = args.length > 0 ? args[0] : undefined;
    const operation = extractRedisOperation(rawArgs);

    // Out-of-scope call forms pass through entirely ungoverned — see module docstring.
    if (operation !== null && STREAMING_OR_PUBSUB_COMMANDS.has(operation)) {
      return boundOriginalSendCommand.apply(this, args);
    }

    const dbStatement = buildRedisDbStatement(rawArgs, operation);
    const dbName = extractDbName(this.options);
    const serverAddress = extractServerAddress(this.options);
    const serverPort = extractServerPort(this.options);
    const maxBodySize = runtime.config.privacy.maxBodySize;

    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();

    // BLOCK/HALT throws here — `boundOriginalSendCommand` below is provably never reached.
    await runtime.preflight({
      spans: [
        buildStartedDbSpan({
          spanId,
          traceId,
          dbSystem: REDIS_DB_SYSTEM,
          dbName,
          dbOperation: operation,
          dbStatement,
          serverAddress,
          serverPort,
          startTimeNs,
          maxBodySize
        })
      ]
    });

    let result: unknown;
    try {
      result = await boundOriginalSendCommand.apply(this, args);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.completed({
        spans: [
          buildCompletedDbSpan({
            spanId,
            traceId,
            dbSystem: REDIS_DB_SYSTEM,
            dbName,
            dbOperation: operation,
            dbStatement,
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
          dbSystem: REDIS_DB_SYSTEM,
          dbName,
          dbOperation: operation,
          dbStatement,
          serverAddress,
          serverPort,
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          maxBodySize
        })
      ]
    });
    return result;
  }

  ownerRecord["sendCommand"] = governedSendCommand;

  // One-time (per install, never per dispatched command) — makes the
  // sendCommand-only coverage limitation visible to a consumer who only
  // reads logs rather than this file's source. See module docstring.
  logger.warn(REDIS_COVERAGE_LIMITATION_WARNING);

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      ownerRecord["sendCommand"] = originalSendCommand;
    }
  };
}
