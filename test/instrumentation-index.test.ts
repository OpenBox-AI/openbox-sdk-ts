import { createRequire } from "node:module";
import type * as NodeFsPromisesModule from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { defaultInstrumentationConfig, OpenBoxConfig, type InstrumentationConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
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
  it("installs fetch, fs.promises, and function; the root import itself installs nothing", async () => {
    const before = globalThis.fetch;
    const mod = await import("../src/instrumentation/index.js");
    expect(globalThis.fetch).toBe(before); // importing the module alone is a no-op

    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    controller = mod.initOpenBoxInstrumentation({ runtime, logger: silentLogger });

    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "function"]);
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

  it("httpEnabled=false skips fetch but still installs fs.promises/function", () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { httpEnabled: false });
    const before = globalThis.fetch;
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fs.promises", "function"]);
    expect(globalThis.fetch).toBe(before);
  });

  it("fileEnabled=false skips fs.promises but still installs fetch/function", () => {
    const fsp = fsPromisesCjs();
    const beforeRead = fsp.readFile;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { fileEnabled: false });
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "function"]);
    expect(fsp.readFile).toBe(beforeRead);
  });

  it("functionEnabled=false leaves traced() as a zero-governance passthrough", async () => {
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore, { functionEnabled: false });
    controller = initOpenBoxInstrumentation({ runtime, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises"]);

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

  it("shutdown() is idempotent (double shutdown safe) and restores the true original fetch/fs", () => {
    const fsp = fsPromisesCjs();
    const beforeRead = fsp.readFile;
    const beforeFetch = globalThis.fetch;
    const fakeCore = new FakeCore();
    const runtime = buildRuntime(fakeCore);
    const c = initOpenBoxInstrumentation({ runtime, logger: silentLogger });

    c.shutdown();
    expect(globalThis.fetch).toBe(beforeFetch);
    expect(fsp.readFile).toBe(beforeRead);
    c.shutdown(); // must not throw
    expect(globalThis.fetch).toBe(beforeFetch);
  });

  it("after shutdown(), init() accepts a brand-new runtime (the slot was freed, not left stuck)", () => {
    const runtimeA = buildRuntime(new FakeCore());
    const cA = initOpenBoxInstrumentation({ runtime: runtimeA, logger: silentLogger });
    cA.shutdown();

    const runtimeB = buildRuntime(new FakeCore());
    controller = initOpenBoxInstrumentation({ runtime: runtimeB, logger: silentLogger });
    expect(controller.installedTargets).toStrictEqual(["fetch", "fs.promises", "function"]);
  });
});

describe("initOpenBoxInstrumentation — fail-loud (Decision 17)", () => {
  it("non-strict: an unpatchable fs.promises emits a hard (error-level) diagnostic and installs the OTHER targets anyway", () => {
    const fsp = fsPromisesCjs();
    const originalReadFile = fsp.readFile;
    // @ts-expect-error -- intentionally breaking the target for this one test
    fsp.readFile = undefined;
    const errors: string[] = [];
    const logger = { warn() {}, error: (m: string) => errors.push(m), info() {} };

    try {
      const fakeCore = new FakeCore();
      const runtime = buildRuntime(fakeCore);
      controller = initOpenBoxInstrumentation({ runtime, logger });
      expect(controller.installedTargets).toStrictEqual(["fetch", "function"]); // fs.promises excluded
      expect(errors.some((m) => m.includes("fs.promises"))).toBe(true);
    } finally {
      fsp.readFile = originalReadFile;
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
});
