import { describe, expect, it } from "vitest";

import { ATTR_REDACTED, ATTR_TRUNCATED, SPAN_ATTR_MISSING } from "../src/contracts/diagnostics.js";
import { HookType, Stage, type SpanRecord } from "../src/contracts/otel-spans.js";
import type { PrivacyConfig } from "../src/config/index.js";
import { semanticGapDiagnostics, toCoreSpanData } from "../src/spans/core-span.js";

function privacy(overrides: Partial<PrivacyConfig> = {}): PrivacyConfig {
  return { redactKeys: new Set<string>(), maxBodySize: 65536, ...overrides };
}

const SPAN_HEX = /^[0-9a-f]{16}$/;
const TRACE_HEX = /^[0-9a-f]{32}$/;

describe("toCoreSpanData — nested-key stripping", () => {
  it("strips otel/openbox/data/metadata so no nested envelope ever leaks to the wire", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.STARTED,
      otel: { name: "GET" },
      openbox: { stage: "started" },
      data: { attestation: true },
      metadata: { extra: 1 }
    });
    expect(wireSpan).not.toHaveProperty("otel");
    expect(wireSpan).not.toHaveProperty("openbox");
    expect(wireSpan).not.toHaveProperty("data");
    expect(wireSpan).not.toHaveProperty("metadata");
  });

  it("does not mutate the input span or its nested attributes object", () => {
    const input: SpanRecord = { stage: Stage.STARTED, attributes: { foo: "bar" } };
    const { wireSpan } = toCoreSpanData(input);
    wireSpan["attributes"] = { mutated: true };
    expect(input["attributes"]).toStrictEqual({ foo: "bar" });
  });
});

describe("toCoreSpanData — hex id defaults", () => {
  it("defaults span_id/trace_id to all-zero hex and parent_span_id to null", () => {
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED });
    expect(wireSpan["span_id"]).toMatch(SPAN_HEX);
    expect(wireSpan["trace_id"]).toMatch(TRACE_HEX);
    expect(wireSpan["span_id"]).toBe("0".repeat(16));
    expect(wireSpan["trace_id"]).toBe("0".repeat(32));
    expect(wireSpan["parent_span_id"]).toBeNull();
  });

  it("passes through caller-supplied hex ids unchanged", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.STARTED,
      span_id: "ab".repeat(8),
      trace_id: "cd".repeat(16),
      parent_span_id: "ef".repeat(8)
    });
    expect(wireSpan["span_id"]).toBe("ab".repeat(8));
    expect(wireSpan["trace_id"]).toBe("cd".repeat(16));
    expect(wireSpan["parent_span_id"]).toBe("ef".repeat(8));
  });
});

describe("toCoreSpanData — started/completed wire shape", () => {
  it("started-stage spans emit EXPLICIT end_time/duration_ns nulls (present keys, null values)", () => {
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED, start_time: 1_000 });
    expect(wireSpan).toHaveProperty("end_time");
    expect(wireSpan).toHaveProperty("duration_ns");
    expect(wireSpan["end_time"]).toBeNull();
    expect(wireSpan["duration_ns"]).toBeNull();
    expect(wireSpan["start_time"]).toBe(1_000);
  });

  it("completed-stage spans reconstruct end_time from start_time + duration_ns when absent", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.COMPLETED,
      start_time: 1_000,
      duration_ns: 500
    });
    expect(wireSpan["end_time"]).toBe(1_500);
  });

  it("completed-stage spans keep an already-present end_time (no override)", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.COMPLETED,
      start_time: 1_000,
      duration_ns: 500,
      end_time: 9_999
    });
    expect(wireSpan["end_time"]).toBe(9_999);
  });

  it("a realistic large epoch-nanosecond value round-trips as a JS number (not bigint, not string)", () => {
    // eslint-disable-next-line no-loss-of-precision -- intentional: ~1.75e18 exceeds Number.MAX_SAFE_INTEGER (2^53); the ~256ns imprecision is the documented, accepted trade-off (see contracts/otel-spans.ts).
    const bigNs = 1_750_000_000_000_000_123;
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED, start_time: bigNs });
    expect(typeof wireSpan["start_time"]).toBe("number");
  });
});

describe("toCoreSpanData — common root field matrix (Go struct governance.go:266-318)", () => {
  // Copied by hand from the Core Go `SpanData` struct JSON tags — NOT derived
  // from `contracts/otel-spans.ts` (that would be circular) and NOT from the
  // SDK integration guide (which under-reports several of these). `data` is
  // excluded: it is stripped per the nested-key rule and is never part of the
  // wire matrix.
  const COMMON_FIELDS_ALWAYS_PRESENT = [
    "span_id",
    "trace_id",
    "parent_span_id",
    "name",
    "kind",
    "start_time",
    "end_time",
    "duration_ns",
    "attributes",
    "status",
    "events",
    "stage",
    "hook_type",
    "semantic_type",
    "attribute_key_identifiers",
    "error"
  ];

  // request_headers/response_headers/request_body/response_body are also
  // top-level (non-family-namespaced) fields on the Go struct, but this SDK
  // only guarantees them present for the http family (matching Python and
  // the plan's family matrix) — asserted separately below.
  const HTTP_BODY_AND_HEADER_FIELDS = ["request_headers", "response_headers", "request_body", "response_body"];

  const FAMILY_FIELDS: Record<string, string[]> = {
    [HookType.HTTP_REQUEST]: ["http_method", "http_url", "http_status_code", ...HTTP_BODY_AND_HEADER_FIELDS],
    [HookType.DB_QUERY]: [
      "db_system",
      "db_name",
      "db_operation",
      "db_statement",
      "server_address",
      "server_port",
      "rowcount"
    ],
    [HookType.FILE_OPERATION]: [
      "file_path",
      "file_mode",
      "file_operation",
      "bytes_read",
      "bytes_written",
      "lines_count"
    ],
    [HookType.FUNCTION_CALL]: ["function", "module", "args", "result"]
  };

  for (const hookType of Object.values(HookType)) {
    if (hookType === HookType.LLM_CALL) continue; // reserved; sent as HTTP spans, no dedicated family.

    for (const stage of Object.values(Stage)) {
      it(`${hookType} / ${stage}: every common + family root field is present`, () => {
        const { wireSpan } = toCoreSpanData({ stage, hook_type: hookType, start_time: 1 });
        for (const field of COMMON_FIELDS_ALWAYS_PRESENT) {
          expect(wireSpan, `missing common field: ${field}`).toHaveProperty(field);
        }
        for (const field of FAMILY_FIELDS[hookType] ?? []) {
          expect(wireSpan, `missing ${hookType} field: ${field}`).toHaveProperty(field);
        }
      });
    }
  }

  it("semantic_type is never computed by the SDK — guaranteed present, but null", () => {
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED, hook_type: HookType.HTTP_REQUEST });
    expect(wireSpan["semantic_type"]).toBeNull();
  });

  it("non-http families do not force request/response body or header keys", () => {
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED, hook_type: HookType.DB_QUERY });
    expect(wireSpan).not.toHaveProperty("request_body");
    expect(wireSpan).not.toHaveProperty("response_headers");
  });
});

describe("toCoreSpanData — wrapper fields merge and pass through", () => {
  it("keeps arbitrary caller-supplied fields not part of any matrix", () => {
    const { wireSpan } = toCoreSpanData({ stage: Stage.STARTED, custom_field: "kept" });
    expect(wireSpan["custom_field"]).toBe("kept");
  });

  it("http wrapper fields (request_body, http_status_code) pass through at the root", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.COMPLETED,
      hook_type: HookType.HTTP_REQUEST,
      start_time: 1,
      duration_ns: 1,
      request_body: '{"q":1}',
      http_status_code: 200
    });
    expect(wireSpan["request_body"]).toBe('{"q":1}');
    expect(wireSpan["http_status_code"]).toBe(200);
  });
});

describe("toCoreSpanData — redaction", () => {
  it("redacts matching attribute keys and records a diagnostic with the dotted path", () => {
    const { wireSpan, diagnostics } = toCoreSpanData(
      { stage: Stage.STARTED, attributes: { authorization: "Bearer secret", "http.method": "GET" } },
      { privacy: privacy({ redactKeys: new Set(["authorization"]) }) }
    );
    expect((wireSpan["attributes"] as Record<string, unknown>)["authorization"]).toBe("[REDACTED]");
    expect((wireSpan["attributes"] as Record<string, unknown>)["http.method"]).toBe("GET");
    const redacted = diagnostics.filter((d) => d.code === ATTR_REDACTED);
    expect(redacted).toHaveLength(1);
    expect(redacted[0]?.detail["paths"]).toContain("attributes.authorization");
  });

  it("produces no redaction diagnostic when redactKeys is empty", () => {
    const { diagnostics } = toCoreSpanData(
      { stage: Stage.STARTED, attributes: { authorization: "secret" } },
      { privacy: privacy() }
    );
    expect(diagnostics.some((d) => d.code === ATTR_REDACTED)).toBe(false);
  });

  it("produces no redaction diagnostic when no privacy config is passed at all", () => {
    const { wireSpan, diagnostics } = toCoreSpanData({
      stage: Stage.STARTED,
      attributes: { authorization: "secret" }
    });
    expect((wireSpan["attributes"] as Record<string, unknown>)["authorization"]).toBe("secret");
    expect(diagnostics).toHaveLength(0);
  });
});

describe("toCoreSpanData — truncation", () => {
  it("truncates request_body/response_body to maxBodySize and records diagnostics", () => {
    const { wireSpan, diagnostics } = toCoreSpanData(
      {
        stage: Stage.COMPLETED,
        hook_type: HookType.HTTP_REQUEST,
        start_time: 1,
        duration_ns: 1,
        request_body: "x".repeat(100),
        response_body: "y".repeat(100)
      },
      { privacy: privacy({ maxBodySize: 8 }) }
    );
    expect(wireSpan["request_body"]).toBe("x".repeat(8));
    expect(wireSpan["response_body"]).toBe("y".repeat(8));
    expect(diagnostics.filter((d) => d.code === ATTR_TRUNCATED)).toHaveLength(2);
  });

  it("does not truncate when no privacy is passed", () => {
    const { wireSpan } = toCoreSpanData({
      stage: Stage.STARTED,
      hook_type: HookType.HTTP_REQUEST,
      request_body: "x".repeat(100)
    });
    expect(wireSpan["request_body"]).toBe("x".repeat(100));
  });

  it("leaves a request_body absent (not forced to a truncated empty string) when the wrapper never supplied one", () => {
    const { wireSpan } = toCoreSpanData(
      { stage: Stage.STARTED, hook_type: HookType.DB_QUERY },
      { privacy: privacy({ maxBodySize: 8 }) }
    );
    // db family does not guarantee request_body at all.
    expect(wireSpan).not.toHaveProperty("request_body");
  });
});

describe("semanticGapDiagnostics", () => {
  it("emits an INFO diagnostic per missing best-effort semantic field", () => {
    const diagnostics = semanticGapDiagnostics({ span_id: "x" }, "http_request");
    const pairs = new Set(
      diagnostics.map((d) => `${d.code}:${typeof d.detail["field"] === "string" ? d.detail["field"] : ""}`)
    );
    expect(pairs.has(`${SPAN_ATTR_MISSING}:http_url`)).toBe(true);
    expect(pairs.has(`${SPAN_ATTR_MISSING}:http_method`)).toBe(true);
  });

  it("produces no diagnostics when the semantic fields are present", () => {
    const diagnostics = semanticGapDiagnostics({ http_url: "https://x", http_method: "GET" }, "http_request");
    expect(diagnostics).toStrictEqual([]);
  });

  it("produces no diagnostics for an unknown or absent hook type", () => {
    expect(semanticGapDiagnostics({}, "llm_call")).toStrictEqual([]);
    expect(semanticGapDiagnostics({}, null)).toStrictEqual([]);
  });

  it("missing semantics degrade to a diagnostic, never a rejection — the span is still produced", () => {
    const { wireSpan, diagnostics } = toCoreSpanData({ stage: Stage.STARTED, hook_type: HookType.HTTP_REQUEST });
    expect(wireSpan["span_id"]).toBeTruthy();
    expect(diagnostics.some((d) => d.code === SPAN_ATTR_MISSING)).toBe(true);
  });
});
