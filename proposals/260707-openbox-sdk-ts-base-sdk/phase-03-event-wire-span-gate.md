# Phase 3: Event Wire Span Gate

## Goal

Implement event factories, Core evaluate payload assembly, flat span wire
normalization, and strict validation.

## Work

1. Implement event contracts:
   - `EventType`
   - `EventKind`
   - `EventEnvelope`
   - event classification
   - wire event type projection
   - lifecycle factories
   - signal factory
   - handoff factory
   - hook factory

2. Implement evaluate payload assembly:
   - flat top-level lifecycle fields
   - timestamp stamping at send boundary
   - hook spans emitted only by hook payload builder
   - hook payloads always include `span_count`
   - hook `span_count` must equal `spans.length`
   - non-hook lifecycle payloads omit `span_count`; legacy `span_count: 0` is
     compatibility noise and must not become a required lifecycle field

3. Implement Core `SpanData` normalization:
   - `span_id`: 16-char hex string
   - `trace_id`: 32-char hex string
   - `parent_span_id`: 16-char hex string or null
   - timestamps are epoch nanoseconds
   - started-stage `end_time` and `duration_ns` are explicit null
   - flat hook span shape only
   - common root fields are always present:
     - `span_id`
     - `trace_id`
     - `parent_span_id`
     - `name`
     - `kind`
     - `stage`
     - `start_time`
     - `end_time`
     - `duration_ns`
     - `attributes`
     - `status`
     - `events`
     - `hook_type`
     - `error`
   - family-specific HTTP/DB/file/function fields default to null when present
     in that hook family

   Common defaults:

   | Field | Default |
   |-------|---------|
   | `span_id` | 16 zero hex chars |
   | `trace_id` | 32 zero hex chars |
   | `parent_span_id` | null |
   | `name` | `span` |
   | `kind` | `INTERNAL` |
   | `stage` | null unless supplied by wrapper |
   | `start_time` | null |
   | `end_time` | null |
   | `duration_ns` | null |
   | `attributes` | `{}` |
   | `status` | `{ code: "UNSET", description: null }` |
   | `events` | `[]` |
   | `hook_type` | null unless supplied by wrapper |
   | `error` | null |

   Hook wire validation tightens those nullable defaults before send:
   - hook `stage` must be exactly `started` or `completed`
   - hook `hook_type` must be a non-empty string
   - preflight/started hook evaluation accepts only `stage: "started"`
   - completed hook evaluation accepts only `stage: "completed"`
   - stageless hook spans are rejected in both paths

4. Implement strict gate validation:
   - lifecycle events have required workflow/run fields
   - activity events have activity identity where required
   - handoff has required agent/session fields
   - hook event must serialize as `ActivityStarted`
   - hook event must have `hook_trigger: true`
   - hook event must have non-empty flat spans
   - every hook span must have `stage` in `started|completed`
   - every hook span must have non-empty `hook_type`
   - preflight rejects `completed` and stageless spans
   - completion rejects `started` and stageless spans
   - `ActivityCompleted` must not carry hook spans
   - nested span keys `otel`, `openbox`, `metadata`, and `data` are rejected

## Acceptance Criteria

- Event factory snapshots match the current Core SDK guide.
- Hook events wire as `ActivityStarted` with `hook_trigger=true`,
  non-empty `spans`, and `span_count == spans.length`.
- Non-hook lifecycle events do not require `span_count`; legacy
  `span_count: 0` is treated only as compatibility noise.
- Nested hook-span shapes fail before send.
- Started-stage spans preserve explicit nulls.
- Started-stage nulls are documented in the conflict ledger because Core docs
  still describe `0`.
- The full common root field matrix is enforced by tests.
- Family-specific field matrices are enforced for every implemented hook
  family.
- Hook spans without `stage` or `hook_type` fail strict validation before send.
- Hook spans with `stage` outside `started|completed` fail strict validation.
- Preflight hook validation rejects `completed` and stageless spans.
- Completion hook validation rejects `started` and stageless spans.
- Missing semantic fields create diagnostics, not gate failures.
- Strict validation has focused tests for each contract error.

## Explicit Non-Goals

- Do not implement actual Node instrumentation yet.
- Do not decide Mastra lifecycle mapping yet.
- Do not introduce a new Core event type for hooks.

## Test Focus

- workflow started/completed/failed payloads
- signal received payloads
- activity started/completed payloads
- handoff payloads with `multi_agent_session_id`
- hook payloads
- hook `span_count`
- hook `stage`
- hook `hook_type`
- preflight/completion stage mismatch failures
- `toCoreSpanData`
- common root `SpanData` field matrix
- family-specific `SpanData` field matrix
- `assertHookWireShape`
- strict gate failure diagnostics
