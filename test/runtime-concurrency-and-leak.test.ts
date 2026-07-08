import { describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };

function traceIdFor(i: number): string {
  return i.toString(16).padStart(32, "0");
}

describe("Concurrency — two (and many) overlapping activityScopes never cross-observe context", () => {
  it("two overlapping OpenBoxRuntime.preflight calls each report their OWN activity_id, never swapped", async () => {
    const fakeCore = new FakeCore();
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_concurrency" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new FakeAdapter(),
      contextStore,
      logger: silentLogger
    });

    const ctxA = new ActivityContext({ workflowId: "wf-A", activityId: "act-A", activityType: "t" });
    const ctxB = new ActivityContext({ workflowId: "wf-B", activityId: "act-B", activityType: "t" });
    const span = { stage: "started", hook_type: "http_request" };

    const runA = contextStore.activityScope(ctxA, async () => {
      await Promise.resolve();
      return runtime.preflight({ spans: [span] });
    });
    const runB = contextStore.activityScope(ctxB, async () => {
      return runtime.preflight({ spans: [span] });
    });

    await Promise.all([runA, runB]);

    expect(fakeCore.evaluateRequests).toHaveLength(2);
    const activityIds = fakeCore.evaluateRequests
      .map((r) => (r.bodyJson as Record<string, unknown>)["activity_id"])
      .sort();
    expect(activityIds).toStrictEqual(["act-A", "act-B"]);
  });

  it("many concurrent preflight calls (N=30) each carry their own activity_id with no duplicates/swaps", async () => {
    const fakeCore = new FakeCore();
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_concurrency" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, {
      client,
      adapter: new FakeAdapter(),
      contextStore,
      logger: silentLogger
    });
    const total = 30;

    await Promise.all(
      Array.from({ length: total }, (_, i) => {
        const ctx = new ActivityContext({ workflowId: `wf-${i}`, activityId: `act-${i}`, activityType: "t" });
        return contextStore.activityScope(ctx, async () => {
          for (let tick = 0; tick < (i % 4); tick++) await Promise.resolve();
          return runtime.preflight({ spans: [{ stage: "started", hook_type: "http_request" }] });
        });
      })
    );

    const seenIds = fakeCore.evaluateRequests.map((r) => (r.bodyJson as Record<string, unknown>)["activity_id"]);
    expect(seenIds).toHaveLength(total);
    expect(new Set(seenIds).size).toBe(total); // every activity_id is distinct — no cross-context bleed
    expect(contextStore.currentActivityContext()).toBeNull();
  });
});

describe("Leak — bounded trace map returns to baseline after N requests, no stale resolution", () => {
  it("direct registerTrace/unregisterTrace cycle: many child-trace ids never accumulate", () => {
    const store = new ContextStore();
    const total = 200;
    const baseline = store.traceMapSize();
    const traceIds = Array.from({ length: total }, (_, i) => traceIdFor(i));

    for (const [i, traceId] of traceIds.entries()) {
      const ctx = new ActivityContext({ workflowId: `wf-${i}`, activityId: `act-${i}`, activityType: "t" });
      store.registerTrace(traceId, ctx);
      expect(store.contextForTrace(traceId)).toBe(ctx); // correct while registered
      store.unregisterTrace(traceId); // "activity end" cleanup — mandatory per trace/activity end
    }

    expect(store.traceMapSize()).toBe(baseline);
    for (const traceId of traceIds) {
      expect(store.contextForTrace(traceId)).toBeNull(); // no stale cross-context resolution
    }
  });

  it("N concurrent activityScope({traceId}) calls all clean up via the finally path — traceMapSize returns to baseline", async () => {
    const store = new ContextStore();
    const total = 100;
    const traceIds = Array.from({ length: total }, (_, i) => traceIdFor(i));

    const allCorrect = await Promise.all(
      traceIds.map((traceId, i) => {
        const ctx = new ActivityContext({ workflowId: `wf-${i}`, activityId: `act-${i}`, activityType: "t" });
        return store.activityScope(ctx, { traceId }, async () => {
          for (let tick = 0; tick < (i % 5); tick++) await Promise.resolve();
          // Resolve via the TRACE MAP specifically (not currentActivityContext()),
          // proving the second lookup path stays correct under concurrency.
          return store.contextForTrace(traceId) === ctx;
        });
      })
    );

    expect(allCorrect.every(Boolean)).toBe(true);
    expect(store.traceMapSize()).toBe(0);
    for (const traceId of traceIds) {
      expect(store.contextForTrace(traceId)).toBeNull();
    }
  });

  it("a request that throws still unregisters its trace (leak-safety under errors too)", async () => {
    const store = new ContextStore();
    const traceId = traceIdFor(999);
    const ctx = new ActivityContext({ workflowId: "wf-err", activityId: "act-err", activityType: "t" });

    await expect(
      store.activityScope(ctx, { traceId }, async () => {
        await Promise.resolve();
        throw new Error("simulated activity failure");
      })
    ).rejects.toThrow("simulated activity failure");

    expect(store.traceMapSize()).toBe(0);
    expect(store.contextForTrace(traceId)).toBeNull();
  });
});
