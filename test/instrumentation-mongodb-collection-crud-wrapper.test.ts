import { createRequire } from "node:module";
import type * as MongodbModule from "mongodb";

import { describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError } from "../src/errors/index.js";
import { installMongodbCollectionCrudWrapper } from "../src/instrumentation/mongodb-collection-crud-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "job" });

function buildRuntime(fakeCore: FakeCore) {
  const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_mongodb" });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: fakeCore.fetchImpl,
    logger: silentLogger
  });
  const contextStore = new ContextStore();
  const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

/** The SAME CJS `mongodb` module object `installMongodbCollectionCrudWrapper` `require()`s. */
function mongodbCjs(): typeof MongodbModule {
  const require = createRequire(import.meta.url);
  return require("mongodb") as typeof MongodbModule;
}

/**
 * `Collection` cannot be reached via a real `MongoClient` without connecting.
 * Its public `.d.ts` constructor is `@internal` (hidden from the published
 * types — real callers only ever reach it via `db.collection(name)`), so
 * this casts to the real 3-arg constructor shape verified against the
 * installed `mongodb@6.21.0` source (`lib/collection.js`), same pattern as
 * mysql2's `Connection` in the sibling test file. The fake `Db` only needs
 * the shape the constructor actually reads: `databaseName`/`client`/`options`.
 */
function fakeCollection(mongodb: typeof MongodbModule, collectionName = "widgets"): MongodbModule.Collection {
  const fakeDb = { databaseName: "testdb", client: {}, options: {} };
  const CollectionCtor = mongodb.Collection as unknown as new (
    db: typeof fakeDb,
    name: string,
    options: Record<string, unknown>
  ) => MongodbModule.Collection;
  return new CollectionCtor(fakeDb, collectionName, {});
}

type SpanRow = Record<string, unknown>;

function spansOf(fakeCore: FakeCore, index: number): SpanRow[] {
  return (fakeCore.evaluateRequests[index]!.bodyJson as { spans: SpanRow[] }).spans;
}

describe("installMongodbCollectionCrudWrapper — op did not run on BLOCK", () => {
  it("BLOCK prevents the underlying insertOne from ever dispatching", async () => {
    const mongodb = mongodbCjs();
    const originalInsertOne = mongodb.Collection.prototype.insertOne;
    const insertOneSpy = vi.fn(async () => ({ acknowledged: true, insertedId: "abc" }));
    // @ts-expect-error -- narrower test stub than mongodb's full insertOne() overload set
    mongodb.Collection.prototype.insertOne = insertOneSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => collection.insertOne({ name: "widget" }))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(insertOneSpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.insertOne = originalInsertOne;
    }
  });

  it("BLOCK prevents the underlying deleteMany from ever dispatching", async () => {
    const mongodb = mongodbCjs();
    const originalDeleteMany = mongodb.Collection.prototype.deleteMany;
    const deleteManySpy = vi.fn(async () => ({ acknowledged: true, deletedCount: 0 }));
    mongodb.Collection.prototype.deleteMany = deleteManySpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => collection.deleteMany({}))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(deleteManySpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.deleteMany = originalDeleteMany;
    }
  });

  it("BLOCK prevents the underlying replaceOne from ever dispatching", async () => {
    const mongodb = mongodbCjs();
    const originalReplaceOne = mongodb.Collection.prototype.replaceOne;
    const replaceOneSpy = vi.fn(async () => ({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null
    }));
    mongodb.Collection.prototype.replaceOne = replaceOneSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => collection.replaceOne({ name: "widget" }, { name: "widget-v2" }))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(replaceOneSpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.replaceOne = originalReplaceOne;
    }
  });

  it("BLOCK prevents the underlying bulkWrite from ever dispatching", async () => {
    const mongodb = mongodbCjs();
    const originalBulkWrite = mongodb.Collection.prototype.bulkWrite;
    const bulkWriteSpy = vi.fn(async () => ({
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0
    }));
    // @ts-expect-error -- narrower test stub than mongodb's full bulkWrite() overload set
    mongodb.Collection.prototype.bulkWrite = bulkWriteSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => collection.bulkWrite([{ insertOne: { document: { name: "widget" } } }]))
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(bulkWriteSpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.bulkWrite = originalBulkWrite;
    }
  });

  it("BLOCK prevents the underlying findOneAndUpdate from ever dispatching", async () => {
    const mongodb = mongodbCjs();
    const originalFindOneAndUpdate = mongodb.Collection.prototype.findOneAndUpdate;
    const findOneAndUpdateSpy = vi.fn(async () => ({ _id: "1", name: "widget" }));
    // @ts-expect-error -- narrower test stub than mongodb's full findOneAndUpdate() overload set
    mongodb.Collection.prototype.findOneAndUpdate = findOneAndUpdateSpy;

    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () =>
          collection.findOneAndUpdate({ name: "widget" }, { $set: { name: "widget-v2" } })
        )
      ).rejects.toBeInstanceOf(GovernanceBlockedError);

      expect(findOneAndUpdateSpy).not.toHaveBeenCalled();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });
});

describe("installMongodbCollectionCrudWrapper — ALLOW proceeds, wire-correct span, never leaks document content", () => {
  it("insertOne dispatches for real; db_statement is schema-only (collection.op), never document content", async () => {
    const mongodb = mongodbCjs();
    const originalInsertOne = mongodb.Collection.prototype.insertOne;
    const insertOneSpy = vi.fn(async () => ({ acknowledged: true, insertedId: "abc123" }));
    // @ts-expect-error -- narrower test stub than mongodb's full insertOne() overload set
    mongodb.Collection.prototype.insertOne = insertOneSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb, "orders");

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () =>
        collection.insertOne({ customerSsn: "super-secret-document-value" })
      );

      expect(result).toStrictEqual({ acknowledged: true, insertedId: "abc123" });
      expect(insertOneSpy).toHaveBeenCalledTimes(1);
      expect(fakeCore.evaluateRequests).toHaveLength(2);

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["hook_type"]).toBe("db_query");
      expect(started?.["db_system"]).toBe("mongodb");
      expect(started?.["db_operation"]).toBe("insertOne");
      expect(started?.["db_statement"]).toBe("orders.insertOne");
      expect(started?.["db_name"]).toBe("testdb");
      expect(JSON.stringify(started)).not.toContain("super-secret-document-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(1);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.insertOne = originalInsertOne;
    }
  });

  it("updateMany reports modifiedCount as rowcount", async () => {
    const mongodb = mongodbCjs();
    const originalUpdateMany = mongodb.Collection.prototype.updateMany;
    const updateManySpy = vi.fn(async () => ({
      acknowledged: true,
      matchedCount: 5,
      modifiedCount: 4,
      upsertedCount: 0
    }));
    // @ts-expect-error -- narrower test stub than mongodb's full updateMany() overload set
    mongodb.Collection.prototype.updateMany = updateManySpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb, "orders");

    try {
      await contextStore.activityScope(BOUND_CTX, () => collection.updateMany({ status: "pending" }, { $set: { status: "shipped" } }));

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["db_operation"]).toBe("updateMany");
      expect(completed?.["rowcount"]).toBe(4);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.updateMany = originalUpdateMany;
    }
  });

  it("findOne reports rowcount 0 when no document is found", async () => {
    const mongodb = mongodbCjs();
    const originalFindOne = mongodb.Collection.prototype.findOne;
    const findOneSpy = vi.fn(async () => null);
    mongodb.Collection.prototype.findOne = findOneSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () => collection.findOne({ name: "missing" }));

      expect(result).toBeNull();
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(0);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.findOne = originalFindOne;
    }
  });

  it("replaceOne reports modifiedCount as rowcount; db_statement is schema-only, never document content", async () => {
    const mongodb = mongodbCjs();
    const originalReplaceOne = mongodb.Collection.prototype.replaceOne;
    const replaceOneSpy = vi.fn(async () => ({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null
    }));
    mongodb.Collection.prototype.replaceOne = replaceOneSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb, "orders");

    try {
      await contextStore.activityScope(BOUND_CTX, () =>
        collection.replaceOne({ name: "widget" }, { customerSsn: "super-secret-document-value" })
      );

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["db_operation"]).toBe("replaceOne");
      expect(started?.["db_statement"]).toBe("orders.replaceOne");
      expect(JSON.stringify(started)).not.toContain("super-secret-document-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(1);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.replaceOne = originalReplaceOne;
    }
  });

  it("bulkWrite dispatches for real; rowcount is null (mixed-op result has no single count), never leaks operation content", async () => {
    const mongodb = mongodbCjs();
    const originalBulkWrite = mongodb.Collection.prototype.bulkWrite;
    const bulkWriteSpy = vi.fn(async () => ({
      insertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0
    }));
    // @ts-expect-error -- narrower test stub than mongodb's full bulkWrite() overload set
    mongodb.Collection.prototype.bulkWrite = bulkWriteSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb, "orders");

    try {
      await contextStore.activityScope(BOUND_CTX, () =>
        collection.bulkWrite([{ insertOne: { document: { customerSsn: "super-secret-document-value" } } }])
      );

      expect(bulkWriteSpy).toHaveBeenCalledTimes(1);
      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["db_operation"]).toBe("bulkWrite");
      expect(started?.["db_statement"]).toBe("orders.bulkWrite");
      expect(JSON.stringify(started)).not.toContain("super-secret-document-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBeNull();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.bulkWrite = originalBulkWrite;
    }
  });

  it("findOneAndUpdate reports rowcount 1 when a document is returned", async () => {
    const mongodb = mongodbCjs();
    const originalFindOneAndUpdate = mongodb.Collection.prototype.findOneAndUpdate;
    const findOneAndUpdateSpy = vi.fn(async () => ({ _id: "1", name: "widget-v2" }));
    // @ts-expect-error -- narrower test stub than mongodb's full findOneAndUpdate() overload set
    mongodb.Collection.prototype.findOneAndUpdate = findOneAndUpdateSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () =>
        collection.findOneAndUpdate({ name: "widget" }, { $set: { name: "widget-v2" } })
      );

      expect(result).toStrictEqual({ _id: "1", name: "widget-v2" });
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["db_operation"]).toBe("findOneAndUpdate");
      expect(completed?.["rowcount"]).toBe(1);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  it("findOneAndDelete reports rowcount 0 when no document is found", async () => {
    const mongodb = mongodbCjs();
    const originalFindOneAndDelete = mongodb.Collection.prototype.findOneAndDelete;
    const findOneAndDeleteSpy = vi.fn(async () => null);
    // @ts-expect-error -- narrower test stub than mongodb's full findOneAndDelete() overload set
    mongodb.Collection.prototype.findOneAndDelete = findOneAndDeleteSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      const result = await contextStore.activityScope(BOUND_CTX, () => collection.findOneAndDelete({ name: "missing" }));

      expect(result).toBeNull();
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["db_operation"]).toBe("findOneAndDelete");
      expect(completed?.["rowcount"]).toBe(0);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.findOneAndDelete = originalFindOneAndDelete;
    }
  });

  it("findOneAndReplace dispatches for real; db_statement never leaks replacement document content", async () => {
    const mongodb = mongodbCjs();
    const originalFindOneAndReplace = mongodb.Collection.prototype.findOneAndReplace;
    const findOneAndReplaceSpy = vi.fn(async () => ({ _id: "1", name: "widget-v2" }));
    // @ts-expect-error -- narrower test stub than mongodb's full findOneAndReplace() overload set
    mongodb.Collection.prototype.findOneAndReplace = findOneAndReplaceSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb, "orders");

    try {
      await contextStore.activityScope(BOUND_CTX, () =>
        collection.findOneAndReplace({ name: "widget" }, { customerSsn: "super-secret-document-value" })
      );

      const started = spansOf(fakeCore, 0)[0];
      expect(started?.["db_operation"]).toBe("findOneAndReplace");
      expect(started?.["db_statement"]).toBe("orders.findOneAndReplace");
      expect(JSON.stringify(started)).not.toContain("super-secret-document-value");

      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["rowcount"]).toBe(1);
    } finally {
      handle.restore();
      mongodb.Collection.prototype.findOneAndReplace = originalFindOneAndReplace;
    }
  });
});

describe("installMongodbCollectionCrudWrapper — completed telemetry on failure, never swallows the error", () => {
  it("a genuine driver error still produces completed telemetry with the error, then re-throws", async () => {
    const mongodb = mongodbCjs();
    const originalDeleteOne = mongodb.Collection.prototype.deleteOne;
    const deleteError = new Error("MongoNetworkError: connection closed");
    const deleteOneSpy = vi.fn(async () => {
      throw deleteError;
    });
    mongodb.Collection.prototype.deleteOne = deleteOneSpy;

    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    const collection = fakeCollection(mongodb);

    try {
      await expect(
        contextStore.activityScope(BOUND_CTX, () => collection.deleteOne({ name: "x" }))
      ).rejects.toThrow(/MongoNetworkError/);

      expect(fakeCore.evaluateRequests).toHaveLength(2);
      const completed = spansOf(fakeCore, 1)[0];
      expect(completed?.["error"]).toMatch(/MongoNetworkError/);
      expect(completed?.["rowcount"]).toBeNull();
    } finally {
      handle.restore();
      mongodb.Collection.prototype.deleteOne = originalDeleteOne;
    }
  });
});

describe("installMongodbCollectionCrudWrapper — find()/aggregate() are cursors, never patched (streaming out of scope)", () => {
  it("find remains the true original — untouched by install", () => {
    const mongodb = mongodbCjs();
    const beforeFind = mongodb.Collection.prototype.find;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    try {
      expect(mongodb.Collection.prototype.find).toBe(beforeFind);
    } finally {
      handle.restore();
    }
  });
});

describe("installMongodbCollectionCrudWrapper — restore + fail-loud", () => {
  it("restores all twelve true original CRUD methods, and restore() is idempotent", () => {
    const mongodb = mongodbCjs();
    const originals = [
      "insertOne",
      "insertMany",
      "updateOne",
      "updateMany",
      "replaceOne",
      "deleteOne",
      "deleteMany",
      "findOne",
      "findOneAndUpdate",
      "findOneAndDelete",
      "findOneAndReplace",
      "bulkWrite"
    ] as const;
    const before = Object.fromEntries(originals.map((name) => [name, mongodb.Collection.prototype[name]]));
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    const handle = installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger });
    for (const name of originals) {
      expect(mongodb.Collection.prototype[name]).not.toBe(before[name]);
    }

    handle.restore();
    for (const name of originals) {
      expect(mongodb.Collection.prototype[name]).toBe(before[name]);
    }
    handle.restore(); // idempotent
    expect(mongodb.Collection.prototype.insertOne).toBe(before["insertOne"]);
  });

  it("throws when Collection.prototype.findOne is missing/not a function at install time", () => {
    const mongodb = mongodbCjs();
    const original = mongodb.Collection.prototype.findOne;
    // @ts-expect-error -- intentionally breaking the target for this one test
    mongodb.Collection.prototype.findOne = undefined;
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);

    try {
      expect(() => installMongodbCollectionCrudWrapper({ runtime, logger: silentLogger })).toThrow(
        /Collection\.prototype\.findOne is missing or not a function/
      );
    } finally {
      mongodb.Collection.prototype.findOne = original;
    }
  });
});
