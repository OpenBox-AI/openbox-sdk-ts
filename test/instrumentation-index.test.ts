import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFsModule from "node:fs";
import type * as NodeFsPromisesModule from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type * as PgModule from "pg";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { defaultInstrumentationConfig, OpenBoxConfig, type InstrumentationConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import {
  initOpenBoxInstrumentation,
  OpenBoxInstrumentationError,
  traced,
  type OpenBoxInstrumentationController
} from "../src/instrumentation/index.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };

function buildRuntime(fakeCore: FakeCore, instrumentation?: Partial<InstrumentationConfig>) {
  const config = OpenBoxConfig.resolve({
    apiUrl: "https://core.test",
    apiKey: "obx_test_index",
    instrumentation: { ...defaultInstrumentationConfig(), ...instrumentation }
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), logger: silentLogger });
  return runtime;
}

function fsPromisesCjs(): typeof NodeFsPromisesModule {
  const require = createRequire(import.meta.url);
  return require("node:fs/promises") as typeof NodeFsPromisesModule;
}

function fsCjs(): typeof NodeFsModule {
  const require = createRequire(import.meta.url);
  return require("node:fs") as typeof NodeFsModule;
}

function pgCjs(): typeof PgModule {
  const require = createRequire(import.meta.url);
  return require("pg") as typeof PgModule;
}

let realFetch: typeof fetch;
let controller: OpenBoxInstrumentationController | null = null;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  controller?.shutdown();
  controller = null;
  globalThis.fetch = realFetch;
});

describe("initOpenBoxInstrumentation — installs Tier A1 targets by default", () => {
  it("installs fetch, fs.promises, fs.sync, and function; the root import itself installs nothing", async () => {
    const before = globalThis.fetch;
    const mod = await import("../src/instrumentation/index.js");
    expect(globalThis.fetch).toBe(before); // importing the module alone is a no-op

    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    controller = mod.initOpenBoxInstrumentation({ runtime, logger: silentLogger });

    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function"]);
    expect(globalThis.fetch).not.toBe(before);
  });

  it("getSpanlessGovernedHttpRequestCount starts at 0", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.getSpanlessGovernedHttpRequestCount()).toBe(0);
  });
});

describe("initOpenBoxInstrumentation — config toggles", () => {
  it("instrumentation.enabled=false installs nothing at all", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { enabled: false });
    const before = globalThis.fetch;
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual([]);
    expect(globalThis.fetch).toBe(before);
    expect(controller.getSpanlessGovernedHttpRequestCount()).toBe(0); // no fetch handle installed at all
  });

  it("httpEnabled=false skips fetch but still installs fs.promises/fs.sync/function", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { httpEnabled: false });
    const before = globalThis.fetch;
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fs.promises", "fs.sync", "function"]);
    expect(globalThis.fetch).toBe(before);
  });

  it("fileEnabled=false skips BOTH fs.promises and fs.sync but still installs fetch/function", () => {
    const fsp = fsPromisesCjs();
    const fs = fsCjs();
    const beforeRead = fsp.readFile;
    const beforeReadSync = fs.readFileSync;
    const beforeMkdirSync = fs.mkdirSync;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { fileEnabled: false });
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "function"]);
    expect(fsp.readFile).toBe(beforeRead); // async file target untouched
    expect(fs.readFileSync).toBe(beforeReadSync); // sync file target untouched
    expect(fs.mkdirSync).toBe(beforeMkdirSync);
  });

  it("functionEnabled=false leaves traced() as a zero-governance passthrough", async () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { functionEnabled: false });
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync"]);

    let calls = 0;
    const fn = traced(async () => {
      calls += 1;
      return "ok";
    });
    await expect(fn()).resolves.toBe("ok");
    expect(calls).toBe(1);
    expect(fakeCore.evaluateRequests).toStrictEqual([]); // never even attempted governance
  });
});

describe("initOpenBoxInstrumentation — idempotency / concurrency-safety / single-runtime invariant", () => {
  it("re-init with the SAME runtime is a true no-op: returns the identical controller, no double-patch", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    const first = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    const patchedFetch = globalThis.fetch;

    const second = initOpenBoxInstrumentation({ runtime, logger: silentLogger });

    expect(second).toBe(first);
    expect(globalThis.fetch).toBe(patchedFetch); // untouched — no teardown-then-reinstall happened
    controller = first;
  });

  it("re-init with a DIFFERENT runtime while one is active throws, and does not disturb the active installation", () => {
    const fakeCore = new FakeCore();
    const runtimeA = buildRuntime(fakeCore);
    const runtimeB = buildRuntime(new FakeCore());
    controller = initOpenBoxInstrumentation({ runtime: runtimeA, logger: silentLogger });
    const patchedFetch = globalThis.fetch;

    expect(() => initOpenBoxInstrumentation({ runtime: runtimeB, logger: silentLogger })).toThrow(
      OpenBoxInstrumentationError
    );
    expect(globalThis.fetch).toBe(patchedFetch); // runtimeA's installation is still intact
  });

  it("shutdown() is idempotent (double shutdown safe) and restores the true original fetch/fs.promises/fs.sync", () => {
    const fsp = fsPromisesCjs();
    const fs = fsCjs();
    const beforeRead = fsp.readFile;
    const beforeReadSync = fs.readFileSync;
    const beforeMkdirSync = fs.mkdirSync;
    const beforeFetch = globalThis.fetch;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    const c = initOpenBoxInstrumentation({ runtime, logger: silentLogger });

    c.shutdown();
    expect(globalThis.fetch).toBe(beforeFetch);
    expect(fsp.readFile).toBe(beforeRead);
    expect(fs.readFileSync).toBe(beforeReadSync); // sync file target restored too
    expect(fs.mkdirSync).toBe(beforeMkdirSync);
    c.shutdown(); // must not throw
    expect(globalThis.fetch).toBe(beforeFetch);
  });

  it("after shutdown(), init() accepts a brand-new runtime (the slot was freed, not left stuck)", () => {
    const runtimeA = buildRuntime(new FakeCore());
    const cA = initOpenBoxInstrumentation({ runtime: runtimeA, logger: silentLogger });
    cA.shutdown();

    const runtimeB = buildRuntime(new FakeCore());
    controller = initOpenBoxInstrumentation({ runtime: runtimeB, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function"]);
  });
});

describe("initOpenBoxInstrumentation — fail-loud (Decision 17)", () => {
  it("non-strict: an unpatchable fs.promises diagnoses for fs.promises and still installs fs.sync + the others (target-specific)", () => {
    const fsp = fsPromisesCjs();
    const originalReadFile = fsp.readFile;
    // @ts-expect-error -- intentionally breaking ONLY the async file target for this one test
    fsp.readFile = undefined;
    const errors: string[] = [];
    const logger = { warn() {}, error: (m: string) => errors.push(m), info() {} };

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      controller = initOpenBoxInstrumentation({ runtime, logger });
      // fs.promises excluded, but the independent fs.sync target still installs.
      expect(controller.installedTargets).toStrictEqual(["fetch", "fs.sync", "function"]);
      expect(errors.some((m) => m.includes("fs.promises"))).toBe(true);
      expect(errors.some((m) => m.includes("fs.sync"))).toBe(false); // sync succeeded
    } finally {
      fsp.readFile = originalReadFile;
    }
  });

  it("non-strict: an unpatchable sync fs diagnoses for fs.sync and still installs fs.promises + the others (target-specific)", () => {
    const fs = fsCjs();
    const originalMkdirSync = fs.mkdirSync;
    // @ts-expect-error -- intentionally breaking ONLY the sync file target for this one test
    fs.mkdirSync = undefined;
    const errors: string[] = [];
    const logger = { warn() {}, error: (m: string) => errors.push(m), info() {} };

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      controller = initOpenBoxInstrumentation({ runtime, logger });
      // fs.sync excluded, but the independent fs.promises target still installs.
      expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "function"]);
      expect(errors.some((m) => m.includes("fs.sync"))).toBe(true);
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }
  });

  it("strict mode throws OpenBoxInstrumentationError instead of diagnosing, and installs nothing", () => {
    const fsp = fsPromisesCjs();
    const originalReadFile = fsp.readFile;
    // @ts-expect-error -- intentionally breaking the target for this one test
    fsp.readFile = undefined;
    const before = globalThis.fetch;

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      expect(() => initOpenBoxInstrumentation({ runtime, strict: true, logger: silentLogger })).toThrow(
        OpenBoxInstrumentationError
      );
      // Strict mode fails before completing installation: no lingering active
      // installation was registered, so global fetch is untouched too (the
      // fetch target is installed BEFORE the fs.promises target that failed).
      expect(globalThis.fetch).toBe(before);
    } finally {
      fsp.readFile = originalReadFile;
    }
  });

  it("strict mode: an unpatchable sync fs rolls back everything installed before it (incl. fs.promises)", () => {
    const fs = fsCjs();
    const fsp = fsPromisesCjs();
    const originalMkdirSync = fs.mkdirSync;
    const beforeFetch = globalThis.fetch;
    const beforePromisesRead = fsp.readFile;
    // @ts-expect-error -- intentionally breaking ONLY the sync file target for this one test
    fs.mkdirSync = undefined;

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      expect(() => initOpenBoxInstrumentation({ runtime, strict: true, logger: silentLogger })).toThrow(
        OpenBoxInstrumentationError
      );
      // fetch AND fs.promises were installed BEFORE sync fs failed; strict rolls
      // them ALL back — never a half-patched process with no controller to undo it.
      expect(globalThis.fetch).toBe(beforeFetch);
      expect(fsp.readFile).toBe(beforePromisesRead);
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }
  });

  it("flush() drains pending sync-fs completed telemetry after a governed sync write", async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "openbox-idx-fs-"));
    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
      const ctx = new ActivityContext({ workflowId: "wf", activityId: "act", activityType: "job" });

      // Governed sync write inside a bound activity — telemetry is fire-and-forget.
      runtime.contextStore.activityScope(ctx, () => writeFileSync(path.join(scratch, "f.txt"), "x"));
      await controller.flush(); // without this, the assertion below could race the telemetry

      const sawCompletedFileSpan = fakeCore.evaluateRequests.some((r) => {
        const spans = (r.bodyJson as { spans?: Array<Record<string, unknown>> }).spans ?? [];
        return spans.some((s) => s["hook_type"] === "file_operation" && s["stage"] === "completed");
      });
      expect(sawCompletedFileSpan).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("initOpenBoxInstrumentation — DB driver opt-in (Tier A2/B, explicit, OQ5)", () => {
  it("options.databases omitted installs no DB driver at all, even though dbEnabled defaults to true", () => {
    const pg = pgCjs();
    const beforeQuery = pg.Client.prototype.query;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);

    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function"]);
    expect(pg.Client.prototype.query).toBe(beforeQuery); // untouched — no driver was requested
  });

  it("databases: ['pg'] installs only pg among the DB tier", () => {
    const pg = pgCjs();
    const beforeQuery = pg.Client.prototype.query;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);

    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger, databases: ["pg"] });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function", "pg"]);
    expect(pg.Client.prototype.query).not.toBe(beforeQuery);

    controller.shutdown();
    expect(pg.Client.prototype.query).toBe(beforeQuery);
  });

  it("dbEnabled=false skips every DB driver even when options.databases requests one", () => {
    const pg = pgCjs();
    const beforeQuery = pg.Client.prototype.query;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { dbEnabled: false });

    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger, databases: ["pg"] });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function"]);
    expect(pg.Client.prototype.query).toBe(beforeQuery);
  });

  it("idempotent shutdown restores every requested DB driver's handle, and double-shutdown is safe", () => {
    const pg = pgCjs();
    const beforeQuery = pg.Client.prototype.query;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);

    const c = initOpenBoxInstrumentation({ runtime, logger: silentLogger, databases: ["pg"] });
    expect(pg.Client.prototype.query).not.toBe(beforeQuery);

    c.shutdown();
    expect(pg.Client.prototype.query).toBe(beforeQuery);
    c.shutdown(); // must not throw
    expect(pg.Client.prototype.query).toBe(beforeQuery);
  });

  it("non-strict: an unpatchable requested driver emits a hard diagnostic and installs the OTHER targets (incl. other requested DB drivers) anyway", () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    // @ts-expect-error -- intentionally breaking the target for this one test
    pg.Client.prototype.query = undefined;
    const errors: string[] = [];
    const logger = { warn() {}, error: (m: string) => errors.push(m), info() {} };

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      controller = initOpenBoxInstrumentation({ runtime, logger, databases: ["pg"] });
      expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "fs.sync", "function"]); // pg excluded
      expect(errors.some((m) => m.includes("pg"))).toBe(true);
    } finally {
      pg.Client.prototype.query = originalQuery;
    }
  });

  it("strict mode throws OpenBoxInstrumentationError when a requested DB driver cannot be patched, and installs nothing", () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    // @ts-expect-error -- intentionally breaking the target for this one test
    pg.Client.prototype.query = undefined;
    const before = globalThis.fetch;

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      expect(() =>
        initOpenBoxInstrumentation({ runtime, strict: true, logger: silentLogger, databases: ["pg"] })
      ).toThrow(OpenBoxInstrumentationError);
      // Strict mode fails before completing installation: fetch/fs.promises/function
      // were installed earlier in the sequence, but the whole call rolls back to
      // nothing — never a half-patched state with no controller to undo it.
      expect(globalThis.fetch).toBe(before);
    } finally {
      pg.Client.prototype.query = originalQuery;
    }
  });
});
