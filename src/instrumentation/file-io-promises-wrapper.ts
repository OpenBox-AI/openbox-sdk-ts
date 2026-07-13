/**
 * `fs.promises` governance wrapper — Tier A1 (Mastra parity): `readFile` and
 * `writeFile` only (matches the Mastra reference's own scope; other
 * `fs.promises` methods and all streaming APIs — `fs.createReadStream` etc. —
 * are out of scope, telemetry-only-or-nothing, and documented as such).
 *
 * Node exposes `fs.promises`/`node:fs/promises` as ONE shared CJS object
 * (`require("node:fs").promises === require("node:fs/promises")`, verified
 * empirically against this repo's Node version), so patching it in place
 * governs every consumer that already holds a reference to that object
 * (`import { promises } from "node:fs"`, `fs.promises.readFile(...)`, ...).
 * The one case that does NOT automatically see the patch is an ESM NAMED or
 * NAMESPACE import of the builtin (`import { readFile } from "node:fs/promises"`,
 * `import * as fsp from "node:fs/promises"`) — Node's ESM wrapper for CJS
 * builtins snapshots exports and only re-syncs them when
 * `node:module`'s `syncBuiltinESMExports()` is called. Both patch AND restore
 * call it, exactly like the Mastra reference implementation, so every import
 * style observes the current (patched or restored) function.
 *
 * Preflight blocking here is a CUSTOM WRAPPER (Decision 15) — wrap the real
 * function, `await runtime.preflight(...)` BEFORE calling the original, so a
 * BLOCK/HALT throws and the real fs call is provably never reached.
 */

import type * as NodeFsModule from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as NodeFsPromisesModule from "node:fs/promises";

import type { ClientLogger } from "../client/index.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedFileSpan, buildStartedFileSpan } from "../spans/file-span-builder.js";
import {
  byteLength,
  mintSpanId,
  mintTraceId,
  nowEpochNs,
  resolvePathLabel,
  shouldBypassFileInstrumentation
} from "./file-io-shared.js";

type ReadFileFn = typeof NodeFsPromisesModule.readFile;
type WriteFileFn = typeof NodeFsPromisesModule.writeFile;

export interface FileIoPromisesWrapperOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface FileIoPromisesWrapperHandle {
  /** Restore the true original `readFile`/`writeFile`. Idempotent. */
  restore(): void;
}

/**
 * Install governed `fs.promises.readFile`/`writeFile`. Throws a plain `Error`
 * if either target is missing/not a function — the strict-vs-diagnostic
 * fail-loud POLICY decision belongs to the caller (`src/instrumentation/index.ts`),
 * this function only detects and reports the unpatchable condition.
 */
export function installFileIoPromisesWrapper(
  options: FileIoPromisesWrapperOptions
): FileIoPromisesWrapperHandle {
  const require = createRequire(import.meta.url);
  const fsModule = require("node:fs") as typeof NodeFsModule;
  const fsPromisesModule = require("node:fs/promises") as typeof NodeFsPromisesModule;

  const originalReadFile = fsPromisesModule.readFile;
  const originalWriteFile = fsPromisesModule.writeFile;
  if (typeof originalReadFile !== "function" || typeof originalWriteFile !== "function") {
    throw new Error(
      "fs.promises.readFile/writeFile are missing or not functions — cannot install file governance"
    );
  }

  const { runtime } = options;
  let restored = false;

  const governedReadFile = (async function openBoxReadFile(
    ...args: Parameters<ReadFileFn>
  ): Promise<Awaited<ReturnType<ReadFileFn>>> {
    const filePath = resolvePathLabel(args[0]);
    // node_modules dependency I/O bypasses governance AND telemetry entirely —
    // call the original immediately (no preflight, no ids, no completed hook).
    if (shouldBypassFileInstrumentation(filePath)) {
      return originalReadFile(...args);
    }
    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();

    // BLOCK/HALT throws here — `originalReadFile` below is provably never reached.
    await runtime.preflight({
      spans: [buildStartedFileSpan({ spanId, traceId, filePath, operation: "read", startTimeNs })]
    });

    let result: Awaited<ReturnType<ReadFileFn>>;
    try {
      result = await originalReadFile(...args);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.completed({
        spans: [
          buildCompletedFileSpan({
            spanId,
            traceId,
            filePath,
            operation: "read",
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            error: message
          })
        ]
      });
      throw error;
    }

    const endTimeNs = nowEpochNs();
    await runtime.completed({
      spans: [
        buildCompletedFileSpan({
          spanId,
          traceId,
          filePath,
          operation: "read",
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          bytesRead: byteLength(result)
        })
      ]
    });
    return result;
  }) as ReadFileFn;

  const governedWriteFile = (async function openBoxWriteFile(
    ...args: Parameters<WriteFileFn>
  ): Promise<Awaited<ReturnType<WriteFileFn>>> {
    const filePath = resolvePathLabel(args[0]);
    // node_modules dependency I/O bypasses governance AND telemetry entirely —
    // call the original immediately (no preflight, no byte count, no completed hook).
    if (shouldBypassFileInstrumentation(filePath)) {
      return originalWriteFile(...args);
    }
    const bytesWritten = byteLength(args[1]);
    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();

    await runtime.preflight({
      spans: [buildStartedFileSpan({ spanId, traceId, filePath, operation: "write", startTimeNs })]
    });

    try {
      await originalWriteFile(...args);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      await runtime.completed({
        spans: [
          buildCompletedFileSpan({
            spanId,
            traceId,
            filePath,
            operation: "write",
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            error: message
          })
        ]
      });
      throw error;
    }

    const endTimeNs = nowEpochNs();
    await runtime.completed({
      spans: [
        buildCompletedFileSpan({
          spanId,
          traceId,
          filePath,
          operation: "write",
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          bytesWritten
        })
      ]
    });
  }) as WriteFileFn;

  fsPromisesModule.readFile = governedReadFile;
  fsPromisesModule.writeFile = governedWriteFile;
  fsModule.promises.readFile = governedReadFile;
  fsModule.promises.writeFile = governedWriteFile;
  syncBuiltinESMExports();

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      fsPromisesModule.readFile = originalReadFile;
      fsPromisesModule.writeFile = originalWriteFile;
      fsModule.promises.readFile = originalReadFile;
      fsModule.promises.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    }
  };
}
