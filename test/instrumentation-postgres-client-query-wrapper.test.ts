import { createRequire } from "node:module";
import type * as PgModule from "pg";

import { describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { installPostgresClientQueryWrapper } from "../src/instrumentation/postgres-client-query-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_pg" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

/** The SAME CJS `pg` module object `installPostgresClientQueryWrapper` `require()`s — stubbing `Client.prototype.query` here BEFORE install is what lets the stub become the wrapper's captured "original". */
function pgCjs(): typeof PgModule {
  const require = createRequire(import.meta.url);
  return require("pg") as typeof PgModule;
}

type SpanRow = Record<string, unknown>;

function spansOf(fakeCore: FakeCore, index: number): SpanRow[] {
  return (fakeCore.evaluateRequests[index]!.bodyJson as { spans: SpanRow[] }).spans;
}

describe("installPostgresClientQueryWrapper — op did not run on BLOCK", () => {
  it("BLOCK prevents the underlying query from ever dispatching", async () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    const querySpy = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    // @ts-expect-error -- narrower test stub than pg's full query() overload set
    pg.Client.prototype.query = querySpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installPostgresClientQueryWrapper({ runtime, logger: silentLogger });
    const client = new pg.Client({ host: "127.0.0.1", port: 5432, database: "testdb" });

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => client.query("SELECT 1"))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      pg.Client.prototype.query = originalQuery;
    }
  });
});

describe("installPostgresClientQueryWrapper — ALLOW proceeds, wire-correct span, redacted statement", () => {
  it("dispatches the real query and reports db_statement (value-redacted)/db_operation/rowcount", async () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    const querySpy = vi.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    // @ts-expect-error -- narrower test stub than pg's full query() overload set
    pg.Client.prototype.query = querySpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installPostgresClientQueryWrapper({ runtime, logger: silentLogger });
    const client = new pg.Client({ host: "127.0.0.1", port: 5432, database: "testdb" });

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () =>
        client.query("SELECT * FROM users WHERE id = $1", ["super-secret-bound-value"])
      );

      expect(result).toStrictEqual({ rows: [{ id: 1 }], rowCount: 1 });
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toHaveLength(2); // started + completed

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["hook_type"]).toBe("db_query");
      expect(started?.["db_system"]).toBe("postgresql");
      expect(started?.["db_operation"]).toBe("SELECT");
      expect(started?.["db_statement"]).toBe("SELECT * FROM users WHERE id = $1");
      expect(JSON.stringify(started)).not.toContain("super-secret-bound-value"); // bound value never leaks

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(1);
      expect(completed?.["error"]).toBeNull();
    } finally {
      handle.restore();
      pg.Client.prototype.query = originalQuery;
    }
  });
});

describe("installPostgresClientQueryWrapper — completed telemetry on failure, never swallows the error", () => {
  it("a genuine query error still produces completed telemetry with the error, then re-throws", async () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    const queryError = new Error("connection terminated unexpectedly");
    const querySpy = vi.fn(async () => {
      throw queryError;
    });
    pg.Client.prototype.query = querySpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installPostgresClientQueryWrapper({ runtime, logger: silentLogger });
    const client = new pg.Client({ host: "127.0.0.1", database: "testdb" });

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => client.query("SELECT 1"))
      ).rejects.toThrow(/connection terminated unexpectedly/);

      expect(fakeCore.evaluateRequests).toHaveLength(2);
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["error"]).toMatch(/connection terminated unexpectedly/);
      expect(completed?.["rowcount"]).toBeNull();
    } finally {
      handle.restore();
      pg.Client.prototype.query = originalQuery;
    }
  });
});

describe("installPostgresClientQueryWrapper — callback/streaming forms pass through ungoverned", () => {
  it("a trailing callback bypasses governance entirely, even under a queued BLOCK verdict", async () => {
    const pg = pgCjs();
    const originalQuery = pg.Client.prototype.query;
    const querySpy = vi.fn((_sql: string, cb: (err: unknown, res: unknown) => void) => {
      cb(null, { rows: [], rowCount: 0 });
      return {};
    });
    // @ts-expect-error -- narrower test stub than pg's full query() overload set
    pg.Client.prototype.query = querySpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installPostgresClientQueryWrapper({ runtime, logger: silentLogger });
    const client = new pg.Client({ host: "127.0.0.1", database: "testdb" });

    try {
      await contextStore.activityScope(
        BOUND_CTX,
        () =>
          new Promise<void>((resolve) => {
            client.query("SELECT 1", () => resolve());
          })
      );

      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toStrictEqual([]); // never even attempted governance
    } finally {
      handle.restore();
      pg.Client.prototype.query = originalQuery;
    }
  });
});

describe("installPostgresClientQueryWrapper — restore + fail-loud", () => {
  it("restores the true original query, and restore() is idempotent", () => {
    const pg = pgCjs();
    const before = pg.Client.prototype.query;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    const handle = installPostgresClientQueryWrapper({ runtime, logger: silentLogger });
    expect(pg.Client.prototype.query).not.toBe(before);

    handle.restore();
    expect(pg.Client.prototype.query).toBe(before);
    handle.restore(); // idempotent
    expect(pg.Client.prototype.query).toBe(before);
  });

  it("throws when Client.prototype.query is missing/not a function at install time", () => {
    const pg = pgCjs();
    const original = pg.Client.prototype.query;
    // @ts-expect-error -- intentionally breaking the target for this one test
    pg.Client.prototype.query = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    try {
      expect(() => installPostgresClientQueryWrapper({ runtime, logger: silentLogger })).toThrow(
        /Client\.prototype\.query is missing or not a function/
      );
    } finally {
      pg.Client.prototype.query = original;
    }
  });
});
