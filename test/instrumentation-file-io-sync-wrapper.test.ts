import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFsModule from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import {
  installFileIoSyncWrapper,
  type FileIoSyncWrapperHandle
} from "../src/instrumentation/file-io-sync-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_fs_sync" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, {
    client,
    adapter: new FakeAdapter(),
    contextStore,
    logger: silentLogger
  });
  return { runtime, contextStore };
}

/** The SAME mutable CJS `node:fs` object the wrapper patches. */
function fsCjs(): typeof NodeFsModule {
  const require = createRequire(import.meta.url);
  return require("node:fs") as typeof NodeFsModule;
}

/** First span of each captured evaluate request, in order. */
function completedSpans(fakeCore: FakeCore): Array<Record<string, unknown>> {
  return fakeCore.evaluateRequests.map((r) => (r.bodyJson as { spans: Array<Record<string, unknown>> }).spans[0]!);
}

let scratchDir: string;
// Safety net: restore even if an assertion throws before the inline restore.
let activeHandle: FileIoSyncWrapperHandle | null = null;

beforeAll(() => {
  // Real (unpatched) mkdtempSync — no wrapper is installed at module scope.
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "openbox-sync-fs-"));
});

afterEach(() => {
  activeHandle?.restore();
  activeHandle = null;
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("installFileIoSyncWrapper — completed telemetry + return-value preservation", () => {
  it("readFileSync emits a completed file.read span with bytes_read and returns the real content", async () => {
    const filePath = path.join(scratchDir, "read-1.txt");
    const content = "café \u{1F600} sync read";
    writeFileSync(filePath, content); // real write, before install

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    const result = contextStore.activityScope(BOUND_CTX, () => readFileSync(filePath, "utf8"));
    await activeHandle.flush();

    expect(result).toBe(content); // return value preserved exactly
    expect(fakeCore.evaluateRequests).toHaveLength(1); // completed only — sync sends no started preflight
    const span = completedSpans(fakeCore)[0]!;
    expect(span["stage"]).toBe("completed");
    expect(span["hook_type"]).toBe("file_operation");
    expect(span["name"]).toBe("file.read");
    expect(span["file_operation"]).toBe("read");
    expect(span["file_mode"]).toBe("r");
    expect(span["file_path"]).toBe(filePath);
    expect(span["bytes_read"]).toBe(Buffer.byteLength(content));
    expect(span["bytes_written"]).toBeNull();
    expect(span["attributes"]).toMatchObject({
      "file.path": filePath,
      "file.mode": "r",
      "file.operation": "read"
    });
  });

  it("writeFileSync emits a completed file.write span with bytes_written and actually writes the file", async () => {
    const filePath = path.join(scratchDir, "write-1.txt");
    const content = "hello sync openbox";

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    const result = contextStore.activityScope(BOUND_CTX, () => writeFileSync(filePath, content));
    await activeHandle.flush();

    expect(result).toBeUndefined(); // writeFileSync returns void
    activeHandle.restore();
    expect(readFileSync(filePath, "utf8")).toBe(content); // real bytes landed on disk

    const span = completedSpans(fakeCore)[0]!;
    expect(span["name"]).toBe("file.write");
    expect(span["file_operation"]).toBe("write");
    expect(span["file_mode"]).toBe("w");
    expect(span["bytes_written"]).toBe(Buffer.byteLength(content));
    expect(span["bytes_read"]).toBeNull();
    expect(span["attributes"]).toMatchObject({
      "file.path": filePath,
      "file.mode": "w",
      "file.operation": "write"
    });
  });

  it("mkdirSync emits a completed file.write span with null byte counts and preserves the return value", async () => {
    const base = path.join(scratchDir, "mk-1");
    const nested = path.join(base, "a", "b");

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    // recursive:true returns the first-created dir path (string) — the wrapper
    // must pass that exact `string | undefined` contract through unchanged.
    const result = contextStore.activityScope(BOUND_CTX, () => mkdirSync(nested, { recursive: true }));
    await activeHandle.flush();
    activeHandle.restore();

    expect(result).toBe(base); // Node returns the first directory created
    expect(existsSync(nested)).toBe(true); // the full nested tree was actually created

    const span = completedSpans(fakeCore)[0]!;
    expect(span["name"]).toBe("file.write");
    expect(span["file_operation"]).toBe("write");
    expect(span["file_mode"]).toBe("w");
    expect(span["bytes_read"]).toBeNull();
    expect(span["bytes_written"]).toBeNull();
    expect(span["attributes"]).toMatchObject({ "file.path": nested, "file.operation": "write" });
  });
});

describe("installFileIoSyncWrapper — rethrows the original error, still emits completed telemetry", () => {
  it("readFileSync rethrows ENOENT and emits completed telemetry with the error", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });
    const missing = path.join(scratchDir, "no-such-dir", "missing.txt");

    expect(() => contextStore.activityScope(BOUND_CTX, () => readFileSync(missing, "utf8"))).toThrow(/ENOENT/);
    await activeHandle.flush();

    const span = completedSpans(fakeCore)[0]!;
    expect(span["file_operation"]).toBe("read");
    expect(String(span["error"])).toMatch(/ENOENT/);
    expect(span["bytes_read"]).toBeNull();
  });

  it("writeFileSync rethrows and emits completed telemetry with the error and null bytes_written", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });
    const badPath = path.join(scratchDir, "still-no-dir", "x.txt");

    expect(() => contextStore.activityScope(BOUND_CTX, () => writeFileSync(badPath, "unreachable"))).toThrow(/ENOENT/);
    await activeHandle.flush();

    const span = completedSpans(fakeCore)[0]!;
    expect(span["file_operation"]).toBe("write");
    expect(String(span["error"])).toMatch(/ENOENT/);
    expect(span["bytes_written"]).toBeNull();
  });
});

describe("installFileIoSyncWrapper — patch mechanics: ESM named imports, restore, fail-loud", () => {
  it("patches and restores the true originals on the CJS fs module object (idempotent)", () => {
    const fs = fsCjs();
    const beforeRead = fs.readFileSync;
    const beforeWrite = fs.writeFileSync;
    const beforeMkdir = fs.mkdirSync;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const handle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    expect(fs.readFileSync).not.toBe(beforeRead);
    expect(fs.writeFileSync).not.toBe(beforeWrite);
    expect(fs.mkdirSync).not.toBe(beforeMkdir);

    handle.restore();
    expect(fs.readFileSync).toBe(beforeRead);
    expect(fs.writeFileSync).toBe(beforeWrite);
    expect(fs.mkdirSync).toBe(beforeMkdir);
    handle.restore(); // idempotent
    expect(fs.readFileSync).toBe(beforeRead);
  });

  it("ESM named imports observe the patch after syncBuiltinESMExports() and revert after restore", async () => {
    const before = readFileSync; // ESM named-import live binding
    const filePath = path.join(scratchDir, "esm-named.txt");
    writeFileSync(filePath, "esm-named-content"); // pre-write with the original

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    expect(readFileSync).not.toBe(before); // the named binding re-synced to the governed fn

    const out = contextStore.activityScope(BOUND_CTX, () => readFileSync(filePath, "utf8"));
    await handle.flush();
    handle.restore();

    expect(out).toBe("esm-named-content");
    expect(fakeCore.evaluateRequests).toHaveLength(1); // the named-import call WAS governed
    expect(readFileSync).toBe(before); // reverted
  });

  it("throws when readFileSync/writeFileSync/mkdirSync are missing/not functions at install time", () => {
    const fs = fsCjs();
    const original = fs.mkdirSync;
    // @ts-expect-error -- intentionally breaking the target for this one test
    fs.mkdirSync = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    try {
      expect(() => installFileIoSyncWrapper({ runtime, logger: silentLogger })).toThrow(
        /readFileSync\/writeFileSync\/mkdirSync are missing or not functions/
      );
    } finally {
      fs.mkdirSync = original;
    }
  });
});

describe("installFileIoSyncWrapper — context binding, content safety, flush", () => {
  it("emits no hook event when called with no bound activity context", async () => {
    const filePath = path.join(scratchDir, "unbound.txt");
    writeFileSync(filePath, "unbound"); // pre-write

    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    const out = readFileSync(filePath, "utf8"); // NOT inside any activity scope
    await activeHandle.flush();

    expect(out).toBe("unbound"); // still returns the real content
    expect(fakeCore.evaluateRequests).toHaveLength(0); // no bound context ⇒ nothing sent
  });

  it("never emits raw file content — only byte counts", async () => {
    const filePath = path.join(scratchDir, "secret.txt");
    const secret = "TOP-SECRET-PAYLOAD-9f3a2b";
    writeFileSync(filePath, secret); // pre-write with the original

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    contextStore.activityScope(BOUND_CTX, () => {
      writeFileSync(filePath, secret); // governed write
      return readFileSync(filePath, "utf8"); // governed read
    });
    await activeHandle.flush();

    const wire = JSON.stringify(fakeCore.evaluateRequests.map((r) => r.bodyJson));
    expect(wire).not.toContain(secret);
    expect(fakeCore.evaluateRequests.length).toBeGreaterThanOrEqual(2); // telemetry WAS sent, sans content
  });

  it("flush() awaits in-flight completed telemetry so it is durable after the sync call returns", async () => {
    const filePath = path.join(scratchDir, "flush-1.txt");
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    activeHandle = installFileIoSyncWrapper({ runtime, logger: silentLogger });

    contextStore.activityScope(BOUND_CTX, () => writeFileSync(filePath, "durable"));
    // Telemetry is fire-and-forget; flush() is what makes it observable.
    await activeHandle.flush();
    expect(fakeCore.evaluateRequests).toHaveLength(1);
  });
});
