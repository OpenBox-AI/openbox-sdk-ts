/**
 * `db_query` family span assembly for the Tier A2/B database driver wrappers
 * (`pg`, `redis`, `mysql2`, `mongodb`). Pure data-assembly module — no
 * crypto/network/driver imports — see `http-span-builder.ts` for the module
 * pattern this mirrors.
 *
 * `db_statement` truncation (Decision 16 / plan OQ6, `maxBodySize`): like
 * `http-span-builder.ts`'s own header redaction, this closes a gap
 * `toCoreSpanData` (Phase 3, `core-span.ts`) deliberately leaves open — its
 * `TRUNCATABLE_FIELDS` list covers `request_body`/`response_body` only, never
 * `db_statement`. Truncating HERE, at span-construction time (before the span
 * ever reaches `toCoreSpanData`/signing), closes that gap without modifying
 * the Phase 3 normalizer, reusing the Phase 2 `truncateString` helper exactly
 * as directed. `maxBodySize` is a REQUIRED input (callers pass
 * `runtime.config.privacy.maxBodySize`) — this module does no config lookup
 * of its own, keeping it a pure function of its inputs.
 *
 * Bound-parameter-VALUE redaction (the other half of Decision 16) is each DB
 * WRAPPER's job, not this module's: only the wrapper knows whether its driver
 * separates statement text from bound values (pg/mysql2 do — the wrapper
 * simply never serializes the separate `values`/`params` array into
 * `dbStatement` in the first place) or does not (redis — the wrapper replaces
 * everything past the key with `?` placeholders before calling here). By the
 * time a `dbStatement` reaches this module, it is already value-redacted;
 * this module only truncates for size.
 */

import { HookType, SEMANTIC_FIELDS_BY_HOOK_TYPE, type SpanRecord } from "../contracts/otel-spans.js";
import { truncateString } from "../serialization/index.js";

/** Truncate an already value-redacted statement to `maxBodySize` chars; `null` input passes through untouched. */
function truncateDbStatement(statement: string | null, maxBodySize: number | null): string | null {
  if (statement === null) return null;
  const [truncated] = truncateString(statement, maxBodySize);
  return truncated;
}

/** `db.<operation>` (lowercased), falling back to `db.query` when the operation could not be derived. */
function dbSpanName(dbOperation: string | null): string {
  return `db.${(dbOperation ?? "query").toLowerCase()}`;
}

export interface DbSpanIdentity {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string | null;
}

export interface BuildStartedDbSpanInput extends DbSpanIdentity {
  readonly dbSystem: string;
  readonly dbName?: string | null;
  readonly dbOperation?: string | null;
  readonly dbStatement?: string | null;
  readonly serverAddress?: string | null;
  readonly serverPort?: number | null;
  readonly startTimeNs: number;
  /** Truncation cap for `dbStatement`; pass `runtime.config.privacy.maxBodySize`. `null` disables truncation. */
  readonly maxBodySize: number | null;
}

/** Assemble the STARTED-stage `db_query` span (preflight — before the real driver call runs). */
export function buildStartedDbSpan(input: BuildStartedDbSpanInput): SpanRecord {
  const dbOperation = input.dbOperation ?? null;
  return {
    stage: "started",
    hook_type: HookType.DB_QUERY,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: dbSpanName(dbOperation),
    kind: "CLIENT",
    start_time: input.startTimeNs,
    db_system: input.dbSystem,
    db_name: input.dbName ?? null,
    db_operation: dbOperation,
    db_statement: truncateDbStatement(input.dbStatement ?? null, input.maxBodySize),
    server_address: input.serverAddress ?? null,
    server_port: input.serverPort ?? null,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.DB_QUERY]!]
  };
}

export interface BuildCompletedDbSpanInput extends DbSpanIdentity {
  readonly dbSystem: string;
  readonly dbName?: string | null;
  readonly dbOperation?: string | null;
  readonly dbStatement?: string | null;
  readonly serverAddress?: string | null;
  readonly serverPort?: number | null;
  readonly rowcount?: number | null;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly durationNs: number;
  /** Explicit error message from a thrown/rejected driver call. Omitted/`undefined` ⇒ no error. */
  readonly error?: string | null;
  readonly maxBodySize: number | null;
}

/** Assemble the COMPLETED-stage `db_query` span (telemetry — after the real driver call settles or throws). */
export function buildCompletedDbSpan(input: BuildCompletedDbSpanInput): SpanRecord {
  const dbOperation = input.dbOperation ?? null;
  return {
    stage: "completed",
    hook_type: HookType.DB_QUERY,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: dbSpanName(dbOperation),
    kind: "CLIENT",
    start_time: input.startTimeNs,
    end_time: input.endTimeNs,
    duration_ns: input.durationNs,
    db_system: input.dbSystem,
    db_name: input.dbName ?? null,
    db_operation: dbOperation,
    db_statement: truncateDbStatement(input.dbStatement ?? null, input.maxBodySize),
    server_address: input.serverAddress ?? null,
    server_port: input.serverPort ?? null,
    rowcount: input.rowcount ?? null,
    error: input.error ?? null,
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.DB_QUERY]!]
  };
}
