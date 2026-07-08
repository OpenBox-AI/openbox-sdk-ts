import { describe, expect, it } from "vitest";

import { ActivityContext } from "../src/contracts/context.js";
import { ContextStore } from "../src/context/index.js";

/**
 * The fail-fast abort flag must PERSIST beyond its activity scope (it
 * short-circuits FUTURE execution of the same activity), yet stay bounded so
 * `abortedActivities` cannot grow without limit in a long-lived worker
 * (leak-correctness is a Phase 4 gate).
 */
describe("aborted-activity flag — persistent but bounded", () => {
  it("persists after the activity scope exits (short-circuits future execution)", () => {
    const store = new ContextStore();
    const ctx = new ActivityContext({ workflowId: "wf", activityId: "act" });
    store.activityScope(ctx, () => {
      store.markActivityAborted(ctx.workflowId, ctx.activityId);
    });
    expect(store.isActivityAborted("wf", "act")).toBe(true);
  });

  it("evicts the oldest flag past the cap (FIFO) — no unbounded growth", () => {
    const store = new ContextStore({ maxAbortedActivities: 3 });
    for (let i = 0; i < 5; i++) store.markActivityAborted("wf", `act-${i}`);
    expect(store.abortedActivitiesSize()).toBe(3);
    expect(store.isActivityAborted("wf", "act-0")).toBe(false); // evicted (oldest)
    expect(store.isActivityAborted("wf", "act-1")).toBe(false); // evicted
    expect(store.isActivityAborted("wf", "act-4")).toBe(true); // retained (newest)
  });

  it("re-marking an existing flag does not grow or reorder the set", () => {
    const store = new ContextStore({ maxAbortedActivities: 2 });
    store.markActivityAborted("wf", "a");
    store.markActivityAborted("wf", "b");
    store.markActivityAborted("wf", "a"); // idempotent
    expect(store.abortedActivitiesSize()).toBe(2);
    expect(store.isActivityAborted("wf", "a")).toBe(true);
    expect(store.isActivityAborted("wf", "b")).toBe(true);
  });

  it("clear() drops all flags (runtime close)", () => {
    const store = new ContextStore();
    store.markActivityAborted("wf", "act");
    store.clear();
    expect(store.isActivityAborted("wf", "act")).toBe(false);
    expect(store.abortedActivitiesSize()).toBe(0);
  });
});
