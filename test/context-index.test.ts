import { describe, expect, it } from "vitest";

import { ActivityContext } from "../src/contracts/context.js";
import { ContextStore } from "../src/context/index.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ContextStore.currentActivityContext", () => {
  it("returns null when nothing is bound", () => {
    expect(new ContextStore().currentActivityContext()).toBeNull();
  });
});

describe("ContextStore.activityScope — sync callbacks", () => {
  it("binds ctx for the duration of a sync callback and resets after", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf-1" });
    let seenInside: ActivityContext | null = null;

    const result = store.activityScope(ctx, () => {
      seenInside = store.currentActivityContext();
      return 42;
    });

    expect(result).toBe(42);
    expect(seenInside).toBe(ctx);
    expect(store.currentActivityContext()).toBeNull();
  });

  it("resets even when the callback throws synchronously", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf-1" });

    expect(() =>
      store.activityScope(ctx, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(store.currentActivityContext()).toBeNull();
  });
});

describe("ContextStore.activityScope — async callbacks", () => {
  it("keeps ctx bound across every await inside the callback, resets only after resolution", async () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf-async" });
    const gate = deferred<void>();
    const seen: (ActivityContext | null)[] = [];

    const pending = store.activityScope(ctx, async () => {
      seen.push(store.currentActivityContext());
      await gate.promise;
      seen.push(store.currentActivityContext());
      return "done";
    });

    // Mid-flight: the async callback is suspended on `gate`, not yet settled.
    expect(store.currentActivityContext()).toBeNull();
    gate.resolve();
    expect(await pending).toBe("done");
    expect(seen).toStrictEqual([ctx, ctx]);
    expect(store.currentActivityContext()).toBeNull();
  });

  it("resets after the returned promise REJECTS, not before", async () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf-async-throw" });
    const gate = deferred<void>();

    const pending = store.activityScope(ctx, async () => {
      await gate.promise;
      throw new Error("async boom");
    });

    gate.resolve();
    await expect(pending).rejects.toThrow("async boom");
    expect(store.currentActivityContext()).toBeNull();
  });
});

describe("ContextStore — concurrency: overlapping scopes never cross-observe", () => {
  it("two interleaved activityScope calls each see only their own context", async () => {
    const store = new ContextStore();
    const ctxA = new ActivityContext({ workflowId: "wf-A" });
    const ctxB = new ActivityContext({ workflowId: "wf-B" });
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const runA = store.activityScope(ctxA, async () => {
      await gateA.promise;
      expect(store.currentActivityContext()).toBe(ctxA);
      return "A";
    });
    const runB = store.activityScope(ctxB, async () => {
      await gateB.promise;
      expect(store.currentActivityContext()).toBe(ctxB);
      return "B";
    });

    // Both scopes are suspended (in flight) simultaneously before either
    // gate opens — resolving them (in either order) must never let one
    // callback observe the other's bound context.
    gateB.resolve();
    gateA.resolve();

    expect(await Promise.all([runA, runB])).toStrictEqual(["A", "B"]);
    expect(store.currentActivityContext()).toBeNull();
  });

  it("many concurrently-started scopes each observe their own context throughout", async () => {
    const store = new ContextStore();
    const total = 25;

    const results = await Promise.all(
      Array.from({ length: total }, (_, i) => {
        const ctx = new ActivityContext({ workflowId: `wf-${i}` });
        return store.activityScope(ctx, async () => {
          // Stagger resumption across a few microtask ticks per index so
          // scopes genuinely overlap rather than running strictly in order.
          for (let tick = 0; tick < (i % 4); tick++) {
            await Promise.resolve();
          }
          return store.currentActivityContext() === ctx ? i : -1;
        });
      })
    );

    expect(results).toStrictEqual(Array.from({ length: total }, (_, i) => i));
    expect(store.currentActivityContext()).toBeNull();
  });
});

describe("ContextStore.activityScope — traceId registration", () => {
  it("registers the trace for the sync duration and unregisters after", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf" });
    const traceId = "a".repeat(32);
    let seenDuring: ActivityContext | null = null;

    store.activityScope(ctx, { traceId }, () => {
      seenDuring = store.contextForTrace(traceId);
    });

    expect(seenDuring).toBe(ctx);
    expect(store.contextForTrace(traceId)).toBeNull();
    expect(store.traceMapSize()).toBe(0);
  });

  it("keeps the trace registered across awaits, unregisters only once the promise settles", async () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf" });
    const traceId = "b".repeat(32);
    const gate = deferred<void>();

    const pending = store.activityScope(ctx, { traceId }, async () => {
      await gate.promise;
    });

    expect(store.contextForTrace(traceId)).toBe(ctx); // still registered mid-flight
    gate.resolve();
    await pending;
    expect(store.contextForTrace(traceId)).toBeNull();
  });

  it("unregisters the trace even when the callback throws", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf" });
    const traceId = "c".repeat(32);

    expect(() =>
      store.activityScope(ctx, { traceId }, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(store.contextForTrace(traceId)).toBeNull();
  });

  it("throws a TypeError when called without a callback at all", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext();
    // Bypasses the overload typing to exercise the runtime guard directly —
    // a JS (non-TS) caller could hit this.
    const loose = store as unknown as { activityScope: (c: unknown, o: unknown) => unknown };
    expect(() => loose.activityScope(ctx, {})).toThrow(TypeError);
  });
});

describe("ContextStore — trace map direct API", () => {
  it("registerTrace/contextForTrace/unregisterTrace round-trip", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf" });
    const traceId = "d".repeat(32);

    store.registerTrace(traceId, ctx);
    expect(store.contextForTrace(traceId)).toBe(ctx);
    expect(store.traceMapSize()).toBe(1);

    store.unregisterTrace(traceId);
    expect(store.contextForTrace(traceId)).toBeNull();
    expect(store.traceMapSize()).toBe(0);
  });
});

describe("ContextStore — governance flags", () => {
  it("markActivityAborted / isActivityAborted / clearActivityAborted", () => {
    const store = new ContextStore();
    expect(store.isActivityAborted("wf", "run", "act")).toBe(false);

    store.markActivityAborted("wf", "run", "act");
    expect(store.isActivityAborted("wf", "run", "act")).toBe(true);
    expect(store.isActivityAborted("wf", "run", "other-activity")).toBe(false);

    store.clearActivityAborted("wf", "run", "act");
    expect(store.isActivityAborted("wf", "run", "act")).toBe(false);
  });

  it("the abort key includes runId — two runs of the same workflow reusing an activityId never collide", () => {
    const store = new ContextStore();
    store.markActivityAborted("wf", "run-A", "act");

    expect(store.isActivityAborted("wf", "run-A", "act")).toBe(true);
    expect(store.isActivityAborted("wf", "run-B", "act")).toBe(false);
  });

  it("requestHalt / isHaltRequested", () => {
    const store = new ContextStore();
    expect(store.isHaltRequested("wf", "run")).toBe(false);
    store.requestHalt("wf", "run");
    expect(store.isHaltRequested("wf", "run")).toBe(true);
  });

  it("HALT is per-run — requesting halt for one run never halts a different run", () => {
    const store = new ContextStore();
    store.requestHalt("wf", "run-A");

    expect(store.isHaltRequested("wf", "run-A")).toBe(true);
    expect(store.isHaltRequested("wf", "run-B")).toBe(false);
  });

  it("clearHalt drops only that run's entry and bounds haltedRuns", () => {
    const store = new ContextStore();
    store.requestHalt("wf", "run-A");
    store.requestHalt("wf", "run-B");
    expect(store.haltedRunsSize()).toBe(2);

    store.clearHalt("wf", "run-A");
    expect(store.isHaltRequested("wf", "run-A")).toBe(false);
    expect(store.isHaltRequested("wf", "run-B")).toBe(true);
    expect(store.haltedRunsSize()).toBe(1);
  });
});

describe("ContextStore.clear", () => {
  it("drops trace map entries, aborted flags, and halted runs (idempotent)", () => {
    const store = new ContextStore();
    store.registerTrace("e".repeat(32), new ActivityContext());
    store.markActivityAborted("wf", "run", "act");
    store.requestHalt("wf", "run");

    store.clear();

    expect(store.traceMapSize()).toBe(0);
    expect(store.isActivityAborted("wf", "run", "act")).toBe(false);
    expect(store.isHaltRequested("wf", "run")).toBe(false);

    // Calling clear() again on already-empty state must not throw.
    expect(() => store.clear()).not.toThrow();
  });
});
