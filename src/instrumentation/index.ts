/**
 * `initOpenBoxInstrumentation(options)` — Tier A1 composition root.
 *
 * Installs the fetch + fs.promises governance patches and activates
 * `traced()` for ONE bound `OpenBoxRuntime`, per the Phase 4 per-runtime
 * invariant applied to this phase's process-global patch surface: fetch is a
 * process global and `fs.promises` is a single shared module object, so at
 * most one runtime can govern them at a time. Root-import-free by
 * construction — nothing in this module (or anything it imports) runs at
 * import time; every side effect happens inside `initOpenBoxInstrumentation`
 * itself, and this module is never re-exported from the package root
 * (`src/index.ts`).
 *
 * Also installs Tier A2/B database driver governance (`pg`, `redis`,
 * `mysql2`, `mongodb`) — but ONLY for drivers the caller explicitly names via
 * `options.databases` (resolving plan OQ5 as explicit opt-in, never
 * auto-detected). Unlike fetch/fs, none of the four DB drivers are
 * dependencies of this package at all (each is an OPTIONAL PEER, a
 * devDependency of this repo for tests only) — attempting to `require()` one
 * the caller never asked for would fail-loud/diagnose for a driver the host
 * application may not even have installed, merely because instrumentation
 * happens to be on. `instrumentation.dbEnabled` (default `true`) is the
 * master kill switch for the whole DB tier, the same shape as
 * `httpEnabled`/`fileEnabled`; `options.databases` (default empty — i.e. no
 * driver is ever patched by default) selects WHICH drivers to attempt when
 * that switch is on. Each requested driver is installed/rolled back through
 * the SAME fail-loud `assertPatchable` and atomic-partial-failure handling
 * already used for fetch/fs/function below.
 *
 * Idempotency / concurrency-safety: `initOpenBoxInstrumentation` and
 * `shutdown()` are both fully SYNCHRONOUS (no internal `await`). Because
 * Node's event loop never preempts a running synchronous function, two
 * "concurrent" callers can never actually interleave inside either one —
 * there is no window where fetch/fs.promises sit half-patched. Re-init with
 * the SAME runtime while already active is a true no-op (the existing
 * installation is returned untouched, so no teardown-then-reinstall step
 * — and therefore no ungoverned window — ever happens). Re-init with a
 * DIFFERENT runtime while one is active throws rather than silently swapping
 * governance out from under the first runtime.
 *
 * Fail-loud (Decision 17): each target's patchability is checked before
 * installing. A target that cannot be patched emits a HARD diagnostic
 * (`logger.error`, never `warn`/`info`) and instrumentation proceeds WITHOUT
 * that target rather than silently doing nothing; `options.strict` upgrades
 * that diagnostic to a thrown `OpenBoxInstrumentationError` instead. Tier A1
 * has no per-instance "driver client created before init" failure mode (fetch
 * is a global, fs.promises is a shared module object — both are patched fresh
 * on every `init()` regardless of when other code imported them); that
 * failure mode is inherent to per-instance prototype patches (`pg.Client`,
 * `mysql.Connection`, ...) and is a Tier A2/B concern. `assertPatchable`
 * below is written generically so those tiers can reuse it unchanged.
 */

import type { ClientLogger } from "../client/index.js";
import { OpenBoxError } from "../errors/index.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import {
  installFetchHttpGovernancePatch,
  type FetchHttpGovernancePatchHandle
} from "./fetch-http-governance-patch.js";
import { installFileIoPromisesWrapper, type FileIoPromisesWrapperHandle } from "./file-io-promises-wrapper.js";
import { setTracedGovernanceRuntime } from "./function-wrapper-traced.js";
import {
  installMongodbCollectionCrudWrapper,
  type MongodbCollectionCrudWrapperHandle
} from "./mongodb-collection-crud-wrapper.js";
import { installMysqlClientQueryWrapper, type MysqlClientQueryWrapperHandle } from "./mysql-client-query-wrapper.js";
import {
  installPostgresClientQueryWrapper,
  type PostgresClientQueryWrapperHandle
} from "./postgres-client-query-wrapper.js";
import { installRedisCommandWrapper, type RedisCommandWrapperHandle } from "./redis-command-wrapper.js";

export { traced, type TracedOptions } from "./function-wrapper-traced.js";
export { isInternalCall, isSameOrigin, runAsInternal } from "./recursion-guard.js";

/** Tier A2/B database drivers this controller can govern — see `options.databases` (explicit opt-in, OQ5). */
export type DatabaseDriverName = "pg" | "redis" | "mysql2" | "mongodb";

/**
 * Raised by opt-in strict mode when a target cannot be patched, and when
 * `initOpenBoxInstrumentation` is called for a second, DIFFERENT runtime
 * while one is already active.
 */
export class OpenBoxInstrumentationError extends OpenBoxError {}

export interface InitOpenBoxInstrumentationOptions {
  readonly runtime: OpenBoxRuntime;
  /** Throw instead of emitting a hard diagnostic when a target cannot be patched. Default `false`. */
  readonly strict?: boolean;
  readonly logger?: ClientLogger;
  /**
   * Explicit opt-in list of DB drivers to attempt patching (OQ5 — never
   * auto-detected). Default: none — `instrumentation.dbEnabled=true` alone
   * does NOT patch any driver; the caller must additionally name it here.
   * Ignored entirely when `instrumentation.dbEnabled` is `false`.
   */
  readonly databases?: readonly DatabaseDriverName[];
}

export interface OpenBoxInstrumentationController {
  /** Targets successfully patched this call, e.g. `["fetch", "fs.promises", "function", "pg", "redis", "mysql2", "mongodb"]`. */
  readonly installedTargets: readonly string[];
  /** Governed HTTP requests observed with no bound ActivityContext. 0 when HTTP governance was not installed. */
  getSpanlessGovernedHttpRequestCount(): number;
  /** Restore every patched target. Idempotent and concurrency-safe (see module docstring). */
  shutdown(): void;
}

interface ActiveInstallation {
  readonly runtime: OpenBoxRuntime;
  readonly controller: OpenBoxInstrumentationController;
}

// Process-wide, deliberately: see the module docstring's Phase-4-invariant note.
let activeInstallation: ActiveInstallation | null = null;

/**
 * Run `attempt` (expected to throw on an unpatchable target); returns `true`
 * on success. On failure: strict mode re-throws as `OpenBoxInstrumentationError`,
 * non-strict mode emits a hard (`error`-level) diagnostic and returns `false`
 * — the target is left ungoverned but the caller is NEVER left unaware.
 */
function assertPatchable(
  attempt: () => void,
  target: string,
  strict: boolean,
  logger: ClientLogger
): boolean {
  try {
    attempt();
    return true;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `OpenBox instrumentation: ${target} could not be patched — governance for ${target} is OFF (${cause})`;
    if (strict) throw new OpenBoxInstrumentationError(message);
    logger.error(message);
    return false;
  }
}

export function initOpenBoxInstrumentation(
  options: InitOpenBoxInstrumentationOptions
): OpenBoxInstrumentationController {
  const { runtime } = options;
  const strict = options.strict ?? false;
  const logger = options.logger ?? console;

  if (activeInstallation !== null) {
    if (activeInstallation.runtime === runtime) {
      return activeInstallation.controller;
    }
    throw new OpenBoxInstrumentationError(
      "initOpenBoxInstrumentation is already active for a different OpenBoxRuntime instance — " +
        "fetch/fs.promises are process-wide singular targets, so only one runtime can govern them " +
        "at a time. Call shutdown() on the existing controller before initializing a new one."
    );
  }

  const instrumentation = runtime.config.instrumentation;
  const installedTargets: string[] = [];
  let fetchHandle: FetchHttpGovernancePatchHandle | null = null;
  let fileHandle: FileIoPromisesWrapperHandle | null = null;
  let functionInstalled = false;
  let pgHandle: PostgresClientQueryWrapperHandle | null = null;
  let redisHandle: RedisCommandWrapperHandle | null = null;
  let mysqlHandle: MysqlClientQueryWrapperHandle | null = null;
  let mongodbHandle: MongodbCollectionCrudWrapperHandle | null = null;

  // Restores every target actually patched so far THIS call. Used both by the
  // public shutdown() and by the strict-mode failure path below — a strict
  // throw partway through (e.g. fetch already patched, fs.promises then fails)
  // must leave NOTHING installed, never a half-patched state with no
  // controller to undo it.
  function restoreInstalledSoFar(): void {
    fetchHandle?.restore();
    fileHandle?.restore();
    if (functionInstalled) setTracedGovernanceRuntime(null);
    pgHandle?.restore();
    redisHandle?.restore();
    mysqlHandle?.restore();
    mongodbHandle?.restore();
  }

  try {
    if (!instrumentation.enabled) {
      logger.info("OpenBox instrumentation disabled by config (instrumentation.enabled=false) — no targets installed");
    } else {
      if (instrumentation.httpEnabled) {
        const installed = assertPatchable(
          () => {
            fetchHandle = installFetchHttpGovernancePatch({ runtime, logger });
          },
          "fetch",
          strict,
          logger
        );
        if (installed) installedTargets.push("fetch");
      } else {
        logger.info("HTTP (fetch) instrumentation disabled by config (instrumentation.httpEnabled=false)");
      }

      if (instrumentation.fileEnabled) {
        const installed = assertPatchable(
          () => {
            fileHandle = installFileIoPromisesWrapper({ runtime, logger });
          },
          "fs.promises",
          strict,
          logger
        );
        if (installed) installedTargets.push("fs.promises");
      } else {
        logger.info("File (fs.promises) instrumentation disabled by config (instrumentation.fileEnabled=false)");
      }

      if (instrumentation.functionEnabled) {
        setTracedGovernanceRuntime(runtime);
        functionInstalled = true;
        installedTargets.push("function");
      } else {
        logger.info("Function (traced()) instrumentation disabled by config (instrumentation.functionEnabled=false)");
      }

      if (!instrumentation.dbEnabled) {
        logger.info("Database instrumentation disabled by config (instrumentation.dbEnabled=false)");
      } else {
        const requestedDatabases = new Set(options.databases ?? []);
        if (requestedDatabases.size === 0) {
          logger.info(
            "Database instrumentation: no drivers requested (options.databases is empty) — explicit opt-in required, no driver patched"
          );
        } else {
          // Fixed canonical order regardless of `options.databases` ordering,
          // so `installedTargets` is deterministic for a given request set.
          if (requestedDatabases.has("pg")) {
            const installed = assertPatchable(
              () => {
                pgHandle = installPostgresClientQueryWrapper({ runtime, logger });
              },
              "pg",
              strict,
              logger
            );
            if (installed) installedTargets.push("pg");
          }
          if (requestedDatabases.has("redis")) {
            const installed = assertPatchable(
              () => {
                redisHandle = installRedisCommandWrapper({ runtime, logger });
              },
              "redis",
              strict,
              logger
            );
            if (installed) installedTargets.push("redis");
          }
          if (requestedDatabases.has("mysql2")) {
            const installed = assertPatchable(
              () => {
                mysqlHandle = installMysqlClientQueryWrapper({ runtime, logger });
              },
              "mysql2",
              strict,
              logger
            );
            if (installed) installedTargets.push("mysql2");
          }
          if (requestedDatabases.has("mongodb")) {
            const installed = assertPatchable(
              () => {
                mongodbHandle = installMongodbCollectionCrudWrapper({ runtime, logger });
              },
              "mongodb",
              strict,
              logger
            );
            if (installed) installedTargets.push("mongodb");
          }
        }
      }
    }
  } catch (error) {
    restoreInstalledSoFar();
    throw error;
  }

  let torndown = false;

  const controller: OpenBoxInstrumentationController = {
    installedTargets,
    getSpanlessGovernedHttpRequestCount(): number {
      return fetchHandle?.getSpanlessGovernedRequestCount() ?? 0;
    },
    shutdown(): void {
      // Idempotency-flag-guarded and fully synchronous — see module docstring
      // for why this makes concurrent callers safe by construction.
      if (torndown) return;
      torndown = true;
      restoreInstalledSoFar();
      activeInstallation = null;
    }
  };

  activeInstallation = { runtime, controller };
  logger.info(`OpenBox instrumentation installed: ${JSON.stringify(installedTargets)}`);
  return controller;
}
