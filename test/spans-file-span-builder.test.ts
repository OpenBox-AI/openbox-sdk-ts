import { describe, expect, it } from "vitest";

import { HookType } from "../src/contracts/otel-spans.js";
import { toCoreSpanData } from "../src/spans/core-span.js";
import { buildCompletedFileSpan, buildStartedFileSpan } from "../src/spans/file-span-builder.js";

const IDENTITY = { spanId: "a".repeat(16), traceId: "b".repeat(32) };

describe("buildStartedFileSpan", () => {
  it("populates the file_operation family wire keys for a read", () => {
    const span = buildStartedFileSpan({ ...IDENTITY, filePath: "/tmp/x.txt", operation: "read", startTimeNs: 10 });
    expect(span["stage"]).toBe("started");
    expect(span["hook_type"]).toBe(HookType.FILE_OPERATION);
    expect(span["file_path"]).toBe("/tmp/x.txt");
    expect(span["file_mode"]).toBe("r");
    expect(span["file_operation"]).toBe("read");
    expect(span["attribute_key_identifiers"]).toStrictEqual(["file_path", "file_operation"]);
  });

  it("uses mode 'w' for a write", () => {
    const span = buildStartedFileSpan({ ...IDENTITY, filePath: "/tmp/x.txt", operation: "write", startTimeNs: 10 });
    expect(span["file_mode"]).toBe("w");
  });

  it("normalizes cleanly through toCoreSpanData (no body/content fields ever forced onto a file span)", () => {
    const span = buildStartedFileSpan({ ...IDENTITY, filePath: "/tmp/x.txt", operation: "read", startTimeNs: 1 });
    const { wireSpan } = toCoreSpanData(span);
    expect(wireSpan).not.toHaveProperty("request_body");
    expect(wireSpan).not.toHaveProperty("response_body");
    expect(wireSpan["end_time"]).toBeNull();
    expect(wireSpan["duration_ns"]).toBeNull();
    expect(wireSpan["bytes_read"]).toBeNull();
    expect(wireSpan["bytes_written"]).toBeNull();
    expect(wireSpan["lines_count"]).toBeNull();
  });
});

describe("buildCompletedFileSpan", () => {
  it("carries byte counts and timing for a successful read", () => {
    const span = buildCompletedFileSpan({
      ...IDENTITY,
      filePath: "/tmp/x.txt",
      operation: "read",
      startTimeNs: 1_000,
      endTimeNs: 1_200,
      durationNs: 200,
      bytesRead: 42
    });
    expect(span["stage"]).toBe("completed");
    expect(span["bytes_read"]).toBe(42);
    expect(span["bytes_written"]).toBeNull();
    expect(span["end_time"]).toBe(1_200);
    expect(span["duration_ns"]).toBe(200);
    expect(span["error"]).toBeNull();
  });

  it("carries byte counts for a successful write", () => {
    const span = buildCompletedFileSpan({
      ...IDENTITY,
      filePath: "/tmp/x.txt",
      operation: "write",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      bytesWritten: 7
    });
    expect(span["bytes_written"]).toBe(7);
    expect(span["bytes_read"]).toBeNull();
  });

  it("carries the error message on failure, with no byte counts", () => {
    const span = buildCompletedFileSpan({
      ...IDENTITY,
      filePath: "/tmp/missing.txt",
      operation: "read",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      error: "ENOENT: no such file or directory"
    });
    expect(span["error"]).toBe("ENOENT: no such file or directory");
    expect(span["bytes_read"]).toBeNull();
  });
});
