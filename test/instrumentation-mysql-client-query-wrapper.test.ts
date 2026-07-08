import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type * as MysqlPromiseModule from "mysql2/promise";

import { describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { installMysqlClientQueryWrapper } from "../src/instrumentation/mysql-client-query-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_mysql" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

/** The SAME CJS `mysql2/promise` module object `installMysqlClientQueryWrapper` `require()`s. */
function mysqlPromiseCjs(): typeof MysqlPromiseModule {
  const require = createRequire(import.meta.url);
  return require("mysql2/promise") as typeof MysqlPromiseModule;
}

/**
 * A minimal stand-in for mysql2's "core" callback-style connection —
 * `PromiseConnection` (the real, un-mocked class under test) is constructed
 * with THIS as its dependency, so no real TCP connection is ever attempted.
 * `query`/`execute` are plain spies the tests assert on directly.
 */
class FakeCoreConnection extends EventEmitter {
  // mysql2's own callback contract is `done(err, rows, fields)` — TWO
  // separate trailing args, NOT a single pre-bundled `[rows, fields]` tuple
  // (`makeDoneCb` in `mysql2/lib/promise/make_done_cb.js` does that bundling
  // itself: `resolve([rows, fields])`) — so these fakes must call back with
  // `rows`/`fields` as distinct arguments to match the real core connection.
  readonly query = vi.fn((_sql: unknown, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: unknown, rows: unknown, fields: unknown) => void;
    cb(null, [], []);
  });
  readonly execute = vi.fn((_sql: unknown, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: unknown, rows: unknown, fields: unknown) => void;
    cb(null, { affectedRows: 0 }, []);
  });
  config: Record<string, unknown> = { host: "10.0.0.5", port: 3306, database: "appdb" };
}

/**
 * `mysql2/promise`'s public `.d.ts` exposes no usable constructor for
 * `Connection` (real callers only ever reach it via `createConnection()`) —
 * cast to the real 2-arg constructor shape verified against the installed
 * `mysql2@3.22.6` source (`lib/promise/connection.js`), same pattern as
 * `mongodb`'s `Collection` in the sibling test file.
 */
function makeConnection(mysqlPromise: typeof MysqlPromiseModule, coreConnection: FakeCoreConnection): MysqlPromiseModule.Connection {
  const ConnectionCtor = mysqlPromise.Connection as unknown as new (
    coreConnection: FakeCoreConnection,
    promiseImpl: PromiseConstructor
  ) => MysqlPromiseModule.Connection;
  return new ConnectionCtor(coreConnection, Promise);
}

type SpanRow = Record<string, unknown>;

function spansOf(fakeCore: FakeCore, index: number): SpanRow[] {
  return (fakeCore.evaluateRequests[index]!.bodyJson as { spans: SpanRow[] }).spans;
}

describe("installMysqlClientQueryWrapper — op did not run on BLOCK", () => {
  it("BLOCK prevents the underlying query() from ever dispatching", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => connection.query("SELECT 1"))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(coreConnection.query).not.toHaveBeenCalled();
    } finally {
      handle.restore();
    }
  });

  it("BLOCK prevents the underlying execute() from ever dispatching", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => connection.execute("UPDATE t SET x = 1"))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(coreConnection.execute).not.toHaveBeenCalled();
    } finally {
      handle.restore();
    }
  });
});

describe("installMysqlClientQueryWrapper — ALLOW proceeds, wire-correct span, redacted statement", () => {
  it("query() dispatches for real and reports db_statement (value-redacted)/db_operation/rowcount", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    coreConnection.query.mockImplementation((_sql: unknown, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: unknown, rows: unknown, fields: unknown) => void;
      cb(null, [{ id: 1 }], []);
    });
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      const [rows] = await contextStore.activityScope(BOUND_CTX, () =>
        connection.query("SELECT * FROM users WHERE id = ?", ["super-secret-bound-value"])
      );

      expect(rows).toStrictEqual([{ id: 1 }]);
      expect(coreConnection.query).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toHaveLength(2);

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["hook_type"]).toBe("db_query");
      expect(started?.["db_system"]).toBe("mysql");
      expect(started?.["db_operation"]).toBe("SELECT");
      expect(started?.["db_statement"]).toBe("SELECT * FROM users WHERE id = ?");
      expect(started?.["server_address"]).toBe("10.0.0.5");
      expect(started?.["db_name"]).toBe("appdb");
      expect(JSON.stringify(started)).not.toContain("super-secret-bound-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(1);
    } finally {
      handle.restore();
    }
  });

  it("execute() reports affectedRows as rowcount for a non-SELECT statement", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    coreConnection.execute.mockImplementation((_sql: unknown, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: unknown, rows: unknown, fields: unknown) => void;
      cb(null, { affectedRows: 3 }, []);
    });
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      await contextStore.activityScope(BOUND_CTX, () => connection.execute("UPDATE t SET x = 1"));

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["db_operation"]).toBe("UPDATE");
      expect(completed?.["rowcount"]).toBe(3);
    } finally {
      handle.restore();
    }
  });
});

describe("installMysqlClientQueryWrapper — completed telemetry on failure, never swallows the error", () => {
  it("a genuine query error still produces completed telemetry with the error, then re-throws", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    coreConnection.query.mockImplementation((_sql: unknown, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: unknown, result: unknown) => void;
      cb(new Error("ER_BAD_FIELD_ERROR: unknown column"), null);
    });
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => connection.query("SELECT bad_column FROM t"))
      ).rejects.toThrow(/ER_BAD_FIELD_ERROR/);

      expect(fakeCore.evaluateRequests).toHaveLength(2);
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["error"]).toMatch(/ER_BAD_FIELD_ERROR/);
      expect(completed?.["rowcount"]).toBeNull();
    } finally {
      handle.restore();
    }
  });
});

describe("installMysqlClientQueryWrapper — callback form passes through ungoverned", () => {
  it("a trailing callback throws mysql2's own synchronous error, bypassing governance", async () => {
    const mysqlPromise = mysqlPromiseCjs();
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    const coreConnection = new FakeCoreConnection();
    const connection = makeConnection(mysqlPromise, coreConnection);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () =>
          Promise.resolve(
            // @ts-expect-error -- exercising the promise API's own callback rejection, not a real call form
            connection.query("SELECT 1", () => {})
          )
        )
      ).rejects.toThrow(/Callback function is not available with promise clients/);

      expect(fakeCore.evaluateRequests).toStrictEqual([]); // never even attempted governance
    } finally {
      handle.restore();
    }
  });
});

describe("installMysqlClientQueryWrapper — restore + fail-loud", () => {
  it("restores the true original query/execute, and restore() is idempotent", () => {
    const mysqlPromise = mysqlPromiseCjs();
    const beforeQuery = mysqlPromise.Connection.prototype.query;
    const beforeExecute = mysqlPromise.Connection.prototype.execute;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    const handle = installMysqlClientQueryWrapper({ runtime, logger: silentLogger });
    expect(mysqlPromise.Connection.prototype.query).not.toBe(beforeQuery);
    expect(mysqlPromise.Connection.prototype.execute).not.toBe(beforeExecute);

    handle.restore();
    expect(mysqlPromise.Connection.prototype.query).toBe(beforeQuery);
    expect(mysqlPromise.Connection.prototype.execute).toBe(beforeExecute);
    handle.restore(); // idempotent
    expect(mysqlPromise.Connection.prototype.query).toBe(beforeQuery);
  });

  it("throws when Connection.prototype.query is missing/not a function at install time", () => {
    const mysqlPromise = mysqlPromiseCjs();
    const original = mysqlPromise.Connection.prototype.query;
    // @ts-expect-error -- intentionally breaking the target for this one test
    mysqlPromise.Connection.prototype.query = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    try {
      expect(() => installMysqlClientQueryWrapper({ runtime, logger: silentLogger })).toThrow(
        /Connection\.prototype\.query\/execute.*is missing or not a function/
      );
    } finally {
      mysqlPromise.Connection.prototype.query = original;
    }
  });
});
