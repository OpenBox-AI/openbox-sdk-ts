import { createRequire } from "node:module";
import type * as RedisModule from "redis";

import { describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { installRedisCommandWrapper } from "../src/instrumentation/redis-command-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_redis" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

/** The SAME CJS `redis` module object `installRedisCommandWrapper` `require()`s. */
function redisCjs(): typeof RedisModule {
  const require = createRequire(import.meta.url);
  return require("redis") as typeof RedisModule;
}

/**
 * node-redis exports NO public class (see `redis-command-wrapper.ts`'s
 * module docstring) — construct a disposable, NEVER-CONNECTED client via the
 * real `createClient()` purely to reach the shared prototype `sendCommand`
 * lives on. No socket I/O ever happens (`.connect()` is never called).
 */
function probeClient(redis: typeof RedisModule): RedisModule.RedisClientType {
  const client = redis.createClient();
  client.on("error", () => {});
  return client as unknown as RedisModule.RedisClientType;
}

/** Mirrors `findPrototypeOwningMethod` from the source wrapper (kept independent — tests must not depend on internal, unexported helpers). */
function findOwnerOf(instance: unknown, methodName: string): Record<string, unknown> {
  let proto: unknown = Object.getPrototypeOf(instance);
  while (proto !== null && typeof proto === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
    if (descriptor && typeof descriptor.value === "function") return proto as Record<string, unknown>;
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error(`test setup: could not find an owner of ${methodName} in the prototype chain`);
}

type SpanRow = Record<string, unknown>;

function spansOf(fakeCore: FakeCore, index: number): SpanRow[] {
  return (fakeCore.evaluateRequests[index]!.bodyJson as { spans: SpanRow[] }).spans;
}

describe("installRedisCommandWrapper — op did not run on BLOCK", () => {
  it("BLOCK prevents the underlying sendCommand from ever dispatching", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    const sendCommandSpy = vi.fn(async () => "OK");
    proto["sendCommand"] = sendCommandSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => client.sendCommand(["SET", "foo", "bar"]))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(sendCommandSpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });
});

describe("installRedisCommandWrapper — ALLOW proceeds, wire-correct span, redacted statement", () => {
  it("dispatches the real sendCommand and reports db_statement (value-redacted)/db_operation", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    const sendCommandSpy = vi.fn(async () => "OK");
    proto["sendCommand"] = sendCommandSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () =>
        client.sendCommand(["SET", "session:42", "super-secret-session-value", "EX", "60"])
      );

      expect(result).toBe("OK");
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toHaveLength(2);

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["hook_type"]).toBe("db_query");
      expect(started?.["db_system"]).toBe("redis");
      expect(started?.["db_operation"]).toBe("SET");
      expect(started?.["db_statement"]).toBe("SET session:42 ? ? ?"); // key visible, value + EX + 60 each redacted
      expect(JSON.stringify(started)).not.toContain("super-secret-session-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["error"]).toBeNull();
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });

  it("a command with no key (e.g. PING) statement is the bare verb", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    proto["sendCommand"] = vi.fn(async () => "PONG");

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      await contextStore.activityScope(BOUND_CTX, () => client.sendCommand(["PING"]));
      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["db_statement"]).toBe("PING");
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });
});

describe("installRedisCommandWrapper — completed telemetry on failure, never swallows the error", () => {
  it("a genuine command error still produces completed telemetry with the error, then re-throws", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    const commandError = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    proto["sendCommand"] = vi.fn(async () => {
      throw commandError;
    });

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => client.sendCommand(["GET", "a-list-key"]))
      ).rejects.toThrow(/WRONGTYPE/);

      expect(fakeCore.evaluateRequests).toHaveLength(2);
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["error"]).toMatch(/WRONGTYPE/);
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });
});

describe("installRedisCommandWrapper — SUBSCRIBE/XREAD pass through ungoverned", () => {
  it("SUBSCRIBE bypasses governance entirely, even under a queued BLOCK verdict", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    const sendCommandSpy = vi.fn(async () => "OK");
    proto["sendCommand"] = sendCommandSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () => client.sendCommand(["SUBSCRIBE", "channel"]));

      expect(result).toBe("OK");
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toStrictEqual([]); // never even attempted governance
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });

  it("XREAD bypasses governance entirely, even under a queued BLOCK verdict", async () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const originalSendCommand = proto["sendCommand"];
    const sendCommandSpy = vi.fn(async () => null);
    proto["sendCommand"] = sendCommandSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    const client = probeClient(redis);

    try {
      await contextStore.activityScope(BOUND_CTX, () =>
        client.sendCommand(["XREAD", "COUNT", "2", "STREAMS", "mystream", "0"])
      );

      expect(sendCommandSpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toStrictEqual([]);
    } finally {
      handle.restore();
      proto["sendCommand"] = originalSendCommand;
    }
  });
});

describe("installRedisCommandWrapper — restore + fail-loud", () => {
  it("restores the true original sendCommand, and restore() is idempotent", () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const before = proto["sendCommand"];
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    const handle = installRedisCommandWrapper({ runtime, logger: silentLogger });
    expect(proto["sendCommand"]).not.toBe(before);

    handle.restore();
    expect(proto["sendCommand"]).toBe(before);
    handle.restore(); // idempotent
    expect(proto["sendCommand"]).toBe(before);
  });

  it("throws when sendCommand is missing/not a function at install time", () => {
    const redis = redisCjs();
    const proto = findOwnerOf(probeClient(redis), "sendCommand");
    const original = proto["sendCommand"];
    delete proto["sendCommand"];
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    try {
      expect(() => installRedisCommandWrapper({ runtime, logger: silentLogger })).toThrow(
        /RedisClient\.prototype\.sendCommand is missing or not a function/
      );
    } finally {
      proto["sendCommand"] = original;
    }
  });
});

describe("installRedisCommandWrapper — sendCommand-only coverage limitation warning", () => {
  it("emits a one-time logger.warn on install stating the sendCommand-only coverage limitation", () => {
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, error() {}, info() {} };

    const handle = installRedisCommandWrapper({ runtime, logger });
    try {
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("client.sendCommand([...]) only"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NOT preflight-blocked"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("docs/instrumentation-coverage.md"));
    } finally {
      handle.restore();
    }
  });

  it("falls back to console.warn when no logger option is provided", () => {
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = installRedisCommandWrapper({ runtime });

    try {
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("client.sendCommand([...]) only"));
    } finally {
      handle.restore();
      consoleWarnSpy.mockRestore();
    }
  });
});
