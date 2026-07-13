/**
 * `node:fs` SYNC governance wrapper — Tier A1 sync file coverage: `readFileSync`,
 * `writeFileSync`, and `mkdirSync` ONLY. Every other sync fs method
 * (`appendFileSync`, `openSync`, `rmSync`, `unlinkSync`, file descriptors,
 * streams, watchers) is deliberately out of scope.
 *
 * TELEMETRY-ONLY, NOT preflight-enforced (Decision D4). A synchronous Node API
 * cannot `await runtime.preflight(...)` before touching the file system without
 * changing its contract, so the wrapper runs the real sync op FIRST, then fires
 * a completed-hook evaluation for correlated audit telemetry and post-operation
 * governance signals:
 *
 *     readFileSync/writeFileSync/mkdirSync
 *       -> run real sync fs op
 *       -> start async completed-hook telemetry (tracked, not awaited)
 *       -> return the original sync result immediately
 *
 * A BLOCK/HALT on the completed hook can mark the activity stopped for FUTURE
 * work but CANNOT undo the fs op that already ran. Callers needing
 * pre-operation blocking must use `fs.promises.readFile/writeFile`. No bound
 * activity context ⇒ the runtime skips the hook silently (nothing is sent).
 *
 * Because the wrapper returns before the completed-telemetry promise settles,
 * every such promise is tracked in a `PendingTelemetry` set and drained by the
 * controller's `flush()` (Phase 4) / `await openbox.close()`, so the last fs
 * event is never lost.
 *
 * Same CJS-builtin patch mechanics as the async wrapper: patch the mutable
 * `require("node:fs")` module object in place and call `syncBuiltinESMExports()`
 * on BOTH patch and restore so ESM named imports observe the current function.
 * Never runs at import time — every side effect happens inside install.
 */

import type * as NodeFsModule from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

import type { ClientLogger } from "../client/index.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedFileSpan, type FileOperationKind } from "../spans/file-span-builder.js";
import {
  byteLength,
  mintSpanId,
  mintTraceId,
  nowEpochNs,
  PendingTelemetry,
  resolvePathLabel,
  shouldBypassFileInstrumentation
} from "./file-io-shared.js";

type ReadFileSyncFn = typeof NodeFsModule.readFileSync;
type WriteFileSyncFn = typeof NodeFsModule.writeFileSync;
type MkdirSyncFn = typeof NodeFsModule.mkdirSync;

export interface FileIoSyncWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface FileIoSyncWrapperHandle {
  /** Restore the true original `readFileSync`/`writeFileSync`/`mkdirSync`. Idempotent. */
  restore(): void;
  /** Await all in-flight completed-telemetry promises to settle. Never throws. */
  flush(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install governed sync `node:fs` `readFileSync`/`writeFileSync`/`mkdirSync`.
 * Throws a plain `Error` if any target is missing/not a function — the
 * strict-vs-diagnostic fail-loud POLICY belongs to the caller
 * (`src/instrumentation/index.ts`); this function only detects and reports the
 * unpatchable condition.
 */
export function installFileIoSyncWrapper(options: FileIoSyncWrapperOptions): FileIoSyncWrapperHandle {
  const require = createRequire(import.meta.url);
  const fsModule = require("node:fs") as typeof NodeFsModule;

  const originalReadFileSync = fsModule.readFileSync;
  const originalWriteFileSync = fsModule.writeFileSync;
  const originalMkdirSync = fsModule.mkdirSync;
  if (
    typeof originalReadFileSync !== "function" ||
    typeof originalWriteFileSync !== "function" ||
    typeof originalMkdirSync !== "function"
  ) {
    throw new Error(
      "fs.readFileSync/writeFileSync/mkdirSync are missing or not functions — cannot install sync file governance"
    );
  }

  const { runtime } = options;
  const pending = new PendingTelemetry();
  let restored = false;

  /**
   * Fire completed-hook telemetry for a settled sync op and track the promise
   * for later draining. Never blocks the sync return; never throws.
   *
   * Hot-path guard: sync fs is patched PROCESS-WIDE, so the vast majority of
   * `readFileSync`/`writeFileSync`/`mkdirSync` calls (config/asset loaders,
   * third-party libs, tooling) run OUTSIDE any governed activity. Probe the
   * bound context up front and bail before minting ids / building the span /
   * allocating+tracking a promise. This is provably equivalent to the work
   * `runtime.completed(...)` would discard: the sync path passes no `traceId`,
   * so the hook evaluator resolves the bound context solely from this same ALS
   * getter and returns `null` (sends nothing) for exactly these cases.
   */
  function emitCompleted(
    filePath: string,
    operation: FileOperationKind,
    startTimeNs: number,
    counts: { bytesRead?: number | null; bytesWritten?: number | null },
    error?: string
  ): void {
    const ctx = runtime.contextStore.currentActivityContext();
    if (!ctx?.activityId || !ctx.activityType) return;
    const endTimeNs = nowEpochNs();
    pending.track(
      runtime.completed({
        spans: [
          buildCompletedFileSpan({
            spanId: mintSpanId(),
            traceId: mintTraceId(),
            filePath,
            operation,
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            bytesRead: counts.bytesRead ?? null,
            bytesWritten: counts.bytesWritten ?? null,
            error: error ?? null
          })
        ]
      })
    );
  }

  const governedReadFileSync = function openBoxReadFileSync(
    ...args: Parameters<ReadFileSyncFn>
  ): ReturnType<ReadFileSyncFn> {
    const filePath = resolvePathLabel(args[0]);
    // node_modules dependency I/O bypasses telemetry entirely — return the
    // original sync result directly (no ids, no completed hook).
    if (shouldBypassFileInstrumentation(filePath)) {
      return originalReadFileSync(...args);
    }
    const startTimeNs = nowEpochNs();
    let result: ReturnType<ReadFileSyncFn>;
    try {
      result = originalReadFileSync(...args);
    } catch (error) {
      emitCompleted(filePath, "read", startTimeNs, {}, errorMessage(error));
      throw error;
    }
    emitCompleted(filePath, "read", startTimeNs, { bytesRead: byteLength(result) });
    return result;
  } as ReadFileSyncFn;

  const governedWriteFileSync = function openBoxWriteFileSync(
    ...args: Parameters<WriteFileSyncFn>
  ): ReturnType<WriteFileSyncFn> {
    const filePath = resolvePathLabel(args[0]);
    // node_modules dependency I/O bypasses telemetry entirely — run the original
    // and return its (void) result directly (no byte count, no completed hook).
    if (shouldBypassFileInstrumentation(filePath)) {
      originalWriteFileSync(...args);
      return;
    }
    const bytesWritten = byteLength(args[1]);
    const startTimeNs = nowEpochNs();
    try {
      originalWriteFileSync(...args);
    } catch (error) {
      // The write did not definitely succeed — bytes_written stays null (Span Contract).
      emitCompleted(filePath, "write", startTimeNs, {}, errorMessage(error));
      throw error;
    }
    emitCompleted(filePath, "write", startTimeNs, { bytesWritten });
  } as WriteFileSyncFn;

  const governedMkdirSync = function openBoxMkdirSync(
    ...args: Parameters<MkdirSyncFn>
  ): ReturnType<MkdirSyncFn> {
    const filePath = resolvePathLabel(args[0]);
    // node_modules dependency I/O bypasses telemetry entirely — return the
    // original sync result directly (no ids, no completed hook).
    if (shouldBypassFileInstrumentation(filePath)) {
      return originalMkdirSync(...args);
    }
    const startTimeNs = nowEpochNs();
    let result: ReturnType<MkdirSyncFn>;
    try {
      result = originalMkdirSync(...args);
    } catch (error) {
      emitCompleted(filePath, "write", startTimeNs, {}, errorMessage(error));
      throw error;
    }
    // mkdir is a destructive write with no byte payload (D6). Preserve the exact
    // return value, including the `string | undefined` behavior under `recursive`.
    emitCompleted(filePath, "write", startTimeNs, {});
    return result;
  } as MkdirSyncFn;

  fsModule.readFileSync = governedReadFileSync;
  fsModule.writeFileSync = governedWriteFileSync;
  fsModule.mkdirSync = governedMkdirSync;
  syncBuiltinESMExports();

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      fsModule.readFileSync = originalReadFileSync;
      fsModule.writeFileSync = originalWriteFileSync;
      fsModule.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
    },
    flush(): Promise<void> {
      return pending.flush();
    }
  };
}
