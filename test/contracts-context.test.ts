import { describe, expect, it } from "vitest";

import { ActivityContext } from "../src/contracts/context.js";

describe("ActivityContext", () => {
  it("defaults every field to null and metadata to an empty object", () => {
    const ctx = new ActivityContext();
    expect(ctx.workflowId).toBeNull();
    expect(ctx.runId).toBeNull();
    expect(ctx.activityId).toBeNull();
    expect(ctx.activityType).toBeNull();
    expect(ctx.metadata).toStrictEqual({});
  });

  it("is immutable — assigning a field throws (frozen instance)", () => {
    const ctx = new ActivityContext({ workflowId: "wf-1" });
    expect(() => {
      (ctx as unknown as { workflowId: string }).workflowId = "wf-2";
    }).toThrow();
    expect(ctx.workflowId).toBe("wf-1");
  });

  it("freezes metadata too (mutating the metadata object throws)", () => {
    const ctx = new ActivityContext({ metadata: { tenant: "acme" } });
    expect(() => {
      (ctx.metadata as Record<string, unknown>)["tenant"] = "other";
    }).toThrow();
  });

  it("toPayloadFields omits absent first-class fields and includes present ones", () => {
    const ctx = new ActivityContext({
      workflowId: "wf-1",
      runId: "run-1",
      activityId: "act-1",
      activityType: "charge"
    });
    const payload = ctx.toPayloadFields();
    expect(payload).toStrictEqual({
      workflow_id: "wf-1",
      run_id: "run-1",
      activity_id: "act-1",
      activity_type: "charge"
    });
  });

  it("toPayloadFields includes explicit falsy-but-non-null values (e.g. activityInput: 0)", () => {
    const ctx = new ActivityContext({ activityInput: 0 });
    expect(ctx.toPayloadFields()["activity_input"]).toBe(0);
  });

  it("merges metadata entries at the top level via setdefault semantics", () => {
    const ctx = new ActivityContext({
      workflowId: "wf-1",
      metadata: { tenant: "acme", extra_field: "x" }
    });
    const payload = ctx.toPayloadFields();
    expect(payload["tenant"]).toBe("acme");
    expect(payload["extra_field"]).toBe("x");
  });

  it("metadata NEVER overwrites a first-class field of the same wire key", () => {
    const ctx = new ActivityContext({
      workflowId: "wf-real",
      // A hostile/careless caller tries to smuggle a metadata key that
      // collides with a first-class field's wire name.
      metadata: { workflow_id: "wf-spoofed" }
    });
    expect(ctx.toPayloadFields()["workflow_id"]).toBe("wf-real");
  });

  it("all first-class wire keys map to the expected snake_case names", () => {
    const ctx = new ActivityContext({
      workflowId: "wf",
      runId: "run",
      workflowType: "W",
      taskQueue: "q",
      activityId: "a",
      activityType: "t",
      activityInput: { x: 1 },
      agentName: "agent",
      agentRole: "role",
      sessionId: "sess",
      multiAgentSessionId: "mas"
    });
    expect(ctx.toPayloadFields()).toStrictEqual({
      workflow_id: "wf",
      run_id: "run",
      workflow_type: "W",
      task_queue: "q",
      activity_id: "a",
      activity_type: "t",
      activity_input: { x: 1 },
      agent_name: "agent",
      agent_role: "role",
      session_id: "sess",
      multi_agent_session_id: "mas"
    });
  });
});
