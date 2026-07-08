import { describe, expect, it } from "vitest";

import { hook } from "../src/contracts/event-factories.js";
import { Stage } from "../src/contracts/otel-spans.js";
import { STAGE_STARTED, prepareHookPayload } from "../src/gate/index.js";
import { serializeBody } from "../src/serialization/index.js";
import { makePayloadBuilder } from "../src/wire/evaluate-payload.js";

/**
 * End-to-end proof that a started-stage span's explicit `end_time:null` /
 * `duration_ns:null` survive the full gate → serialize path into the SIGNED
 * bytes. The object-level nulls are covered elsewhere; this asserts the finalize
 * step (`toJsonSafe(payload, false)`) does not drop them before `serializeBody`.
 */
describe("started-stage nulls survive end-to-end serialization", () => {
  it('emits literal "end_time":null and "duration_ns":null in the wire bytes', () => {
    const event = hook({
      activityContext: { workflow_id: "wf", run_id: "run", workflow_type: "W", task_queue: "q" },
      activityId: "act",
      activityType: "t",
      spans: [{ stage: Stage.STARTED, hook_type: "http_request", span_id: "aa".repeat(8) }]
    });
    const { payload } = prepareHookPayload(event, STAGE_STARTED, makePayloadBuilder());
    const bytes = serializeBody(payload).toString("utf-8");
    expect(bytes).toContain('"end_time":null');
    expect(bytes).toContain('"duration_ns":null');
  });
});
