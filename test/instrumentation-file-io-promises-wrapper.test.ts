import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  unlink as fsUnlink,
  writeFile as fsWriteFile
} from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { installFileIoPromisesWrapper } from "../src/instrumentation/file-io-promises-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

// Real (unpatched) mkdtempSync — runs at module scope before any wrapper is
// installed, so creating the scratch dir never flows through governance.
const SCRATCH_DIR = mkdtempSync(path.join(os.tmpdir(), "openbox-fs-promises-"));

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_fs" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

/**
 * The SAME CJS `fs.promises` object `installFileIoPromisesWrapper` patches
 * (verified identical to `require("node:fs").promises`) — spying here, not on
 * an ESM namespace object (frozen, and a DIFFERENT object entirely), is what
 * lets a spy installed BEFORE `installFileIoPromisesWrapper` become the
 * wrapper's captured "original" function.
 */
function fsPromisesCjs(): typeof NodeFsPromisesModule {
  const require = createRequire(import.meta.url);
  return require("node:fs/promises") as typeof NodeFsPromisesModule;
}

let testFilePath: string;

beforeEach(() => {
  testFilePath = path.join(SCRATCH_DIR, `openbox-fs-wrapper-test-${process.hrtime.bigint().toString()}.txt`);
});

afterEach(async () => {
  await fsUnlink(testFilePath).catch(() => {});
});

describe("installFileIoPromisesWrapper — op did not run on BLOCK", () => {
  it("BLOCK prevents the underlying writeFile from ever creating the file (named ESM import path)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fsWriteFile(testFilePath, "should never be written"))
    ).rejects.toBeInstanceOf(GovernanceBlockedError);

    handle.restore();
    await expect(fsReadFile(testFilePath, "utf-8")).rejects.toThrow(/ENOENT/);
  });

  it("BLOCK prevents the underlying readFile from ever being called (spy-verified on the real fs.promises object)", async () => {
    await fsWriteFile(testFilePath, "secret contents"); // pre-create, before any governance is installed
    const readSpy = vi.spyOn(fsPromisesCjs(), "readFile");

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fsReadFile(testFilePath, "utf-8"))
    ).rejects.toBeInstanceOf(GovernanceBlockedError);

    expect(readSpy).not.toHaveBeenCalled();
    handle.restore();
    readSpy.mockRestore();
  });
});

describe("installFileIoPromisesWrapper — ALLOW proceeds, wire-correct span, real bytes", () => {
  it("writeFile actually writes the file and reports bytes_written on the completed span", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    await contextStore.activityScope(BOUND_CTX, () => fsWriteFile(testFilePath, "hello openbox"));

    const onDisk = await fsReadFile(testFilePath, "utf-8");
    expect(onDisk).toBe("hello openbox");

    expect(fakeCore.evaluateRequests).toHaveLength(2); // started + completed
    const startedSpan = (fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(startedSpan?.["hook_type"]).toBe("file_operation");
    expect(startedSpan?.["file_operation"]).toBe("write");
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["bytes_written"]).toBe(Buffer.byteLength("hello openbox"));
    handle.restore();
  });

  it("readFile actually reads the file and reports bytes_read on the completed span", async () => {
    await fsWriteFile(testFilePath, "café \u{1F600}"); // multi-byte content to exercise real byte counting
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    const content = await contextStore.activityScope(BOUND_CTX, () => fsReadFile(testFilePath, "utf-8"));

    expect(content).toBe("café \u{1F600}");
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["bytes_read"]).toBe(Buffer.byteLength("café \u{1F600}"));
    handle.restore();
  });
});

describe("installFileIoPromisesWrapper — completed telemetry on failure, never swallows the error", () => {
  it("a genuine ENOENT still produces completed telemetry with the error, then re-throws", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fsReadFile(path.join(SCRATCH_DIR, "does-not-exist-x.txt"), "utf-8"))
    ).rejects.toThrow(/ENOENT/);

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(typeof completedSpan?.["error"]).toBe("string");
    expect(completedSpan?.["error"]).toMatch(/ENOENT/);
    handle.restore();
  });

  it("a writeFile failure (missing parent directory) produces completed telemetry with the error, then re-throws", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });
    const badPath = path.join(SCRATCH_DIR, "no-such-subdir", "x.txt");

    await expect(
      contextStore.activityScope(BOUND_CTX, () => fsWriteFile(badPath, "unreachable"))
    ).rejects.toThrow(/ENOENT/);

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const completedSpan = (fakeCore.evaluateRequests[1]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(completedSpan?.["error"]).toMatch(/ENOENT/);
    expect(completedSpan?.["bytes_written"]).toBeNull();
    handle.restore();
  });
});

describe("installFileIoPromisesWrapper — path label resolution", () => {
  it("accepts a URL path (file://) and resolves a readable label for the span", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });
    const fileUrl = new URL(`file://${testFilePath}`);

    await contextStore.activityScope(BOUND_CTX, () => fsWriteFile(fileUrl, "via-url"));

    expect(await fsReadFile(testFilePath, "utf-8")).toBe("via-url");
    const startedSpan = (fakeCore.evaluateRequests[0]!.bodyJson as { spans: Array<Record<string, unknown>> })
      .spans[0];
    expect(startedSpan?.["file_path"]).toBe(fileUrl.toString());
    handle.restore();
  });
});

describe("installFileIoPromisesWrapper — restore + fail-loud", () => {
  it("restores the true original readFile/writeFile, and restore() is idempotent", async () => {
    const fsp = fsPromisesCjs();
    const beforeRead = fsp.readFile;
    const beforeWrite = fsp.writeFile;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });
    expect(fsp.readFile).not.toBe(beforeRead);
    expect(fsp.writeFile).not.toBe(beforeWrite);

    handle.restore();
    expect(fsp.readFile).toBe(beforeRead);
    expect(fsp.writeFile).toBe(beforeWrite);
    handle.restore(); // idempotent
    expect(fsp.readFile).toBe(beforeRead);
  });

  it("throws when readFile/writeFile are missing/not functions at install time", () => {
    const fsp = fsPromisesCjs();
    const originalReadFile = fsp.readFile;
    // @ts-expect-error -- intentionally breaking the target for this one test
    fsp.readFile = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    try {
      expect(() => installFileIoPromisesWrapper({ runtime, logger: silentLogger })).toThrow(
        /readFile\/writeFile are missing or not functions/
      );
    } finally {
      fsp.readFile = originalReadFile;
    }
  });
});

describe("installFileIoPromisesWrapper — node_modules paths bypass governance AND telemetry", () => {
  let nmRoot: string;
  let nmFile: string;

  beforeEach(() => {
    // Unique per-test tree so runs never collide; the dependency file lives under
    // a real `node_modules/` segment and is created with the UNPATCHED fs below,
    // before any wrapper is installed.
    nmRoot = path.join(SCRATCH_DIR, `openbox-nm-${process.hrtime.bigint().toString()}`);
    nmFile = path.join(nmRoot, "node_modules", "pkg", "index.js");
  });

  afterEach(async () => {
    await fsRm(nmRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("readFile beneath node_modules returns the real content even when Core is set to BLOCK, sending 0 evaluations", async () => {
    await fsMkdir(path.dirname(nmFile), { recursive: true });
    await fsWriteFile(nmFile, "module.exports = 1;"); // pre-write with the unpatched fs
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    try {
      const content = await contextStore.activityScope(BOUND_CTX, () => fsReadFile(nmFile, "utf-8"));
      expect(content).toBe("module.exports = 1;"); // real result, verbatim
      expect(fakeCore.evaluateRequests).toHaveLength(0); // preflight never ran → no Core evaluation
    } finally {
      handle.restore();
    }
  });

  it("writeFile beneath node_modules writes the real bytes even when Core is set to BLOCK, sending 0 evaluations", async () => {
    await fsMkdir(path.dirname(nmFile), { recursive: true });
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    try {
      await contextStore.activityScope(BOUND_CTX, () => fsWriteFile(nmFile, "written-despite-block"));
      expect(fakeCore.evaluateRequests).toHaveLength(0);
    } finally {
      handle.restore();
    }
    expect(await fsReadFile(nmFile, "utf-8")).toBe("written-despite-block"); // bytes actually landed on disk
  });

  it("a sibling path WITHOUT node_modules is still governed under the same wrapper (BLOCK throws)", async () => {
    // Proves the bypass is scoped to the predicate, not a blanket disable.
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => fsWriteFile(testFilePath, "should be blocked"))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);
      expect(fakeCore.evaluateRequests).toHaveLength(1); // preflight WAS evaluated for the governed path
    } finally {
      handle.restore();
    }
    await expect(fsReadFile(testFilePath, "utf-8")).rejects.toThrow(/ENOENT/); // never written
  });

  it("a bypassed readFile preserves the thrown fs error (ENOENT) unchanged and still sends 0 evaluations", async () => {
    const missing = path.join(nmRoot, "node_modules", "pkg", "missing.js"); // parent dir never created
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });

    try {
      await expect(contextStore.activityScope(BOUND_CTX, () => fsReadFile(missing, "utf-8"))).rejects.toThrow(
        /ENOENT/
      );
      expect(fakeCore.evaluateRequests).toHaveLength(0);
    } finally {
      handle.restore();
    }
  });
});
