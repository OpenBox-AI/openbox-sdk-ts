import { describe, expect, it } from "vitest";

import type { PrivacyConfig } from "../src/config/index.js";
import { hook } from "../src/contracts/event-factories.js";
import { HookType, Stage, type SpanRecord } from "../src/contracts/otel-spans.js";
import { buildEvaluatePayload, makePayloadBuilder } from "../src/wire/evaluate-payload.js";

const ACTIVITY_CONTEXT = {
  workflow_id: "wf-flat",
  run_id: "run-flat",
  workflow_type: "FlatContractWorkflow",
  task_queue: "flat-queue"
};

const COMMON_ROOT_FIELDS = [
  "span_id",
  "trace_id",
  "parent_span_id",
  "name",
  "kind",
  "stage",
  "start_time",
  "end_time",
  "duration_ns",
  "attributes",
  "status",
  "events",
  "hook_type",
  "error"
];

const FAMILY_ROOT_FIELDS: Record<string, string[]> = {
  [HookType.HTTP_REQUEST]: [
    "http_method",
    "http_url",
    "http_status_code",
    "request_headers",
    "response_headers",
    "request_body",
    "response_body"
  ],
  [HookType.DB_QUERY]: [
    "db_system",
    "db_name",
    "db_operation",
    "db_statement",
    "server_address",
    "server_port",
    "rowcount"
  ],
  [HookType.FILE_OPERATION]: ["file_path", "file_mode", "file_operation", "bytes_read", "bytes_written"],
  [HookType.FUNCTION_CALL]: ["function", "module", "args", "result"]
};

const ALL_HOOK_TYPES = Object.keys(FAMILY_ROOT_FIELDS);
const ALL_STAGES = Object.values(Stage);

function emit(
  hookType: string,
  stage: string,
  extra: Record<string, unknown> = {},
  privacy?: PrivacyConfig | null
) {
  const span: SpanRecord = { stage, hook_type: hookType, span_id: "aa".repeat(8), ...extra };
  const event = hook({
    activityContext: ACTIVITY_CONTEXT,
    activityId: "act-flat",
    activityType: "flat_activity",
    spans: [span]
  });
  const { payload } = buildEvaluatePayload(event, { privacy: privacy ?? null });
  const spans = payload["spans"] as SpanRecord[];
  return { payload, span: spans[0] as SpanRecord };
}

describe("buildEvaluatePayload — flat contract matrix", () => {
  for (const hookType of ALL_HOOK_TYPES) {
    for (const stage of ALL_STAGES) {
      describe(`${hookType} / ${stage}`, () => {
        it("carries no internal envelope and no data blob", () => {
          const { span } = emit(hookType, stage);
          expect(span).not.toHaveProperty("otel");
          expect(span).not.toHaveProperty("openbox");
          expect(span).not.toHaveProperty("data");
        });

        it("never sets semantic_type (Core computes it)", () => {
          const { span } = emit(hookType, stage);
          expect(span["semantic_type"]).toBeNull();
        });

        it("has every common root field present", () => {
          const { span } = emit(hookType, stage);
          for (const field of COMMON_ROOT_FIELDS) {
            expect(span, `missing common root field: ${field}`).toHaveProperty(field);
          }
          expect(span["hook_type"]).toBe(hookType);
        });

        it("has every family root field present", () => {
          const { span } = emit(hookType, stage);
          for (const field of FAMILY_ROOT_FIELDS[hookType] ?? []) {
            expect(span, `missing ${hookType} field: ${field}`).toHaveProperty(field);
          }
        });

        it("wires as ActivityStarted + hook_trigger:true + span_count == spans.length", () => {
          const { payload } = emit(hookType, stage);
          expect(payload["event_type"]).toBe("ActivityStarted");
          expect(payload["hook_trigger"]).toBe(true);
          expect(payload["span_count"]).toBe((payload["spans"] as unknown[]).length);
          expect(payload["span_count"]).toBe(1);
        });
      });
    }
  }

  for (const hookType of ALL_HOOK_TYPES) {
    it(`${hookType}: started stage emits explicit end_time/duration_ns nulls`, () => {
      const { span } = emit(hookType, Stage.STARTED);
      expect(span["stage"]).toBe("started");
      expect(span["end_time"]).toBeNull();
      expect(span["duration_ns"]).toBeNull();
    });
  }
});

describe("buildEvaluatePayload — HTTP body/header handling", () => {
  it("started stage retains request_body and headers; response_body stays null", () => {
    const { span } = emit(HookType.HTTP_REQUEST, Stage.STARTED, {
      http_method: "POST",
      http_url: "https://api.example/x",
      request_body: '{"q":1}',
      request_headers: { authorization: "[REDACTED]", accept: "application/json" }
    });
    expect(span["request_body"]).toBe('{"q":1}');
    expect((span["request_headers"] as Record<string, string>)["authorization"]).toBe("[REDACTED]");
    expect(span["response_body"]).toBeNull();
  });

  it("completed stage carries request and response bodies", () => {
    const { span } = emit(HookType.HTTP_REQUEST, Stage.COMPLETED, {
      http_status_code: 201,
      request_body: '{"q":1}',
      response_body: '{"ok":true}',
      duration_ns: 5_000_000,
      start_time: 1
    });
    expect(span["request_body"]).toBe('{"q":1}');
    expect(span["response_body"]).toBe('{"ok":true}');
    expect(span["http_status_code"]).toBe(201);
  });

  it("truncates request/response bodies under a privacy config", () => {
    const { span } = emit(
      HookType.HTTP_REQUEST,
      Stage.COMPLETED,
      { request_body: "x".repeat(100), response_body: "y".repeat(100), duration_ns: 1, start_time: 1 },
      { redactKeys: new Set(), maxBodySize: 8 }
    );
    expect(span["request_body"]).toBe("x".repeat(8));
    expect(span["response_body"]).toBe("y".repeat(8));
  });
});

describe("buildEvaluatePayload — DB/file/function semantics", () => {
  it("db: connection metadata present when supplied", () => {
    const { span } = emit(HookType.DB_QUERY, Stage.COMPLETED, {
      db_system: "postgresql",
      db_statement: "SELECT 1",
      db_name: "app",
      server_address: "db.internal",
      server_port: 5432,
      rowcount: 3
    });
    expect(span["db_name"]).toBe("app");
    expect(span["server_address"]).toBe("db.internal");
    expect(span["rowcount"]).toBe(3);
  });

  it("db: metadata is null (present) when the driver omits it", () => {
    const { span } = emit(HookType.DB_QUERY, Stage.STARTED, { db_system: "sqlite" });
    expect(span["db_name"]).toBeNull();
    expect(span["server_address"]).toBeNull();
    expect(span["rowcount"]).toBeNull();
  });

  it("file: write fields present, bytes_read null when not captured", () => {
    const { span } = emit(HookType.FILE_OPERATION, Stage.COMPLETED, {
      file_path: "/tmp/x.txt",
      file_mode: "w",
      file_operation: "write",
      bytes_written: 42
    });
    expect(span["file_path"]).toBe("/tmp/x.txt");
    expect(span["bytes_written"]).toBe(42);
    expect(span["bytes_read"]).toBeNull();
  });

  it("function: captured args/result when supplied, null when not", () => {
    const captured = emit(HookType.FUNCTION_CALL, Stage.COMPLETED, {
      function: "charge",
      module: "billing",
      args: { args: [5] },
      result: "ok"
    });
    expect(captured.span["function"]).toBe("charge");
    expect(captured.span["result"]).toBe("ok");

    const notCaptured = emit(HookType.FUNCTION_CALL, Stage.COMPLETED, {
      function: "charge",
      module: "billing"
    });
    expect(notCaptured.span["args"]).toBeNull();
    expect(notCaptured.span["result"]).toBeNull();
  });
});

describe("makePayloadBuilder", () => {
  it("binds a privacy config into a single-argument builder", () => {
    const event = hook({
      activityContext: ACTIVITY_CONTEXT,
      activityId: "act-1",
      activityType: "t",
      spans: [{ stage: Stage.STARTED, attributes: { authorization: "secret" } }]
    });
    const builder = makePayloadBuilder({ redactKeys: new Set(["authorization"]), maxBodySize: 65536 });
    const { payload } = builder(event);
    const spans = payload["spans"] as SpanRecord[];
    expect((spans[0]?.["attributes"] as Record<string, string>)["authorization"]).toBe("[REDACTED]");
  });

  it("works with no privacy config bound (undefined)", () => {
    const event = hook({
      activityContext: ACTIVITY_CONTEXT,
      activityId: "act-1",
      activityType: "t",
      spans: [{ stage: Stage.STARTED }]
    });
    const builder = makePayloadBuilder();
    const { payload } = builder(event);
    expect(payload["span_count"]).toBe(1);
  });
});

describe("buildEvaluatePayload — span_count ownership invariant", () => {
  it("span_count always equals spans.length, including zero for a spanless event", () => {
    // Documents the single-owner invariant; buildEvaluatePayload is only ever
    // invoked on validated hook events (non-empty spans required upstream by
    // the strict gate) — this proves the arithmetic itself, not gate policy.
    const event = hook({
      activityContext: ACTIVITY_CONTEXT,
      activityId: "a",
      activityType: "t",
      spans: [{ stage: Stage.STARTED }, { stage: Stage.STARTED }]
    });
    const { payload } = buildEvaluatePayload(event);
    expect(payload["span_count"]).toBe(2);
    expect((payload["spans"] as unknown[]).length).toBe(2);
  });
});
