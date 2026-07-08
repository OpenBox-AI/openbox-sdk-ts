/**
 * `file_operation` family span assembly for the `fs.promises` governance
 * wrapper. Pure data-assembly — see `http-span-builder.ts` for the module
 * pattern this mirrors.
 *
 * No body/content field exists on the file family matrix
 * (`ROOT_FIELDS_BY_HOOK_TYPE.file_operation` — see `contracts/otel-spans.ts`):
 * only path/mode/operation and byte/line COUNTS. There is therefore nothing
 * here to redact or truncate — file spans never carry raw file content.
 */

import { HookType, SEMANTIC_FIELDS_BY_HOOK_TYPE, type SpanRecord } from "../contracts/otel-spans.js";

export type FileOperationKind = "read" | "write";

export interface FileSpanIdentity {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string | null;
}

export interface BuildStartedFileSpanInput extends FileSpanIdentity {
  readonly filePath: string;
  readonly operation: FileOperationKind;
  readonly startTimeNs: number;
}

/** Assemble the STARTED-stage `file_operation` span (preflight — before the fs call runs). */
export function buildStartedFileSpan(input: BuildStartedFileSpanInput): SpanRecord {
  return {
    stage: "started",
    hook_type: HookType.FILE_OPERATION,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `file.${input.operation}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    file_path: input.filePath,
    file_mode: input.operation === "read" ? "r" : "w",
    file_operation: input.operation,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]!]
  };
}

export interface BuildCompletedFileSpanInput extends FileSpanIdentity {
  readonly filePath: string;
  readonly operation: FileOperationKind;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly durationNs: number;
  readonly bytesRead?: number | null;
  readonly bytesWritten?: number | null;
  readonly error?: string | null;
}

/** Assemble the COMPLETED-stage `file_operation` span (telemetry — after the fs call settles or throws). */
export function buildCompletedFileSpan(input: BuildCompletedFileSpanInput): SpanRecord {
  return {
    stage: "completed",
    hook_type: HookType.FILE_OPERATION,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `file.${input.operation}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    end_time: input.endTimeNs,
    duration_ns: input.durationNs,
    file_path: input.filePath,
    file_mode: input.operation === "read" ? "r" : "w",
    file_operation: input.operation,
    bytes_read: input.bytesRead ?? null,
    bytes_written: input.bytesWritten ?? null,
    error: input.error ?? null,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]!]
  };
}
