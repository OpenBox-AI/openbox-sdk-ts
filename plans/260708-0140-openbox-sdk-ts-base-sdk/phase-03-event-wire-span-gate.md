---
phase: 3
title: "Event Wire Span Gate"
status: pending
priority: P1
effort: "3-4d"
dependencies: [2]
---

# Phase 3: Event Wire Span Gate

## Overview

Implement event contracts + factories, the evaluate-payload assembler, flat Core
`SpanData` normalization, and the always-strict validation gate. This is where
the hook wire shape and span field matrices are enforced before any send.

## Requirements

- Functional: event factories produce Core-guide-compatible payloads; hooks wire
  as `ActivityStarted`; span normalization matches Core `SpanData`; gate raises
  `ContractError` before send for all 8 strict codes.
- Non-functional: `span_count` only on hook payloads; started-stage nulls
  preserved (serialize with null-inclusion, not null-drop).

## Architecture

Grounded in [Python report](./research/researcher-01-openbox-sdk-python-contracts-report.md)
§8-11 and [Core report](./research/researcher-02-openbox-core-wire-contract-report.md)
§4-5. See plan.md decisions 8-12, 16.

- `EventType` (7 wire types) is separate from internal `EventKind`
  (`lifecycle|hook|signal|handoff`). `wireEventType` projects hook → `ActivityStarted`.
- The **evaluate-payload assembler is the single owner** of `spans` + `span_count`;
  the envelope's `toPayloadDict()` never emits them.
- Span normalization strips forbidden nested keys, fills the common-field matrix
  with defaults (null when absent), guarantees per-family keys, and preserves
  explicit started-stage nulls. Serialize started spans with **null inclusion**
  (Python uses `exclude_none=False` at the gate for this reason).

### Core SpanData field matrix (drive tests from the Go struct, NOT the SDK guide)

Authoritative source: `openbox-core/internal/content/governance.go:266-318`
(`SpanData` struct). The matrix test must be driven from that field list so it
cannot silently under-report.

Common: `span_id`(16-hex), `trace_id`(32-hex), `parent_span_id`(16-hex|null),
`name`, `kind`(default `INTERNAL`), `stage`, `start_time`(ns), `end_time`(ns;
null on started), `duration_ns`(null on started), `attributes`, `status`
(`{code:"UNSET",description:null}`), `events`, `hook_type`, `error`, and — also
common in the Go struct, and inspected by governance/guardrails, so populate them
for the relevant families rather than omitting: `request_body`, `response_body`,
`request_headers`, `response_headers`, `semantic_type`, `attribute_key_identifiers`.
(`data` is stripped per the nested-key rule.)
Family — http: `http_method`/`http_url`/`http_status_code` (+ `request_body`/
`response_body`/`request_headers`/`response_headers`); db: `db_system`/`db_name`/
`db_operation`/`db_statement`/`server_address`/`server_port`/`rowcount`;
file: `file_path`/`file_mode`/`file_operation`/`bytes_read`/`bytes_written`/
`lines_count`; function: `function`/`module`/`args`/`result`.

## Related Code Files

Create:
- `src/contracts/events.ts` — `EventType`/`EventKind` enums; `EventEnvelope`
  (immutable; `eventType`, `payload`, `spans`, `hookTrigger`, `activityId`,
  `activityType`, `timestamp`, `source="workflow-telemetry"`); `toPayloadDict()`
  (omit-absent, no spans/span_count); `classifyEvent`; `wireEventType`; factories
  `workflowStarted/Completed/Failed`, `signalReceived`, `handoff`
  (require `fromAgentDid`+`multiAgentSessionId`), `activityStarted`
  (`hookTrigger:false`), `activityCompleted` (empty spans), `hook`
  (`hookTrigger:true`, require activity identity + non-empty spans).
- `src/contracts/otel-spans.ts` — `Stage` (`started|completed`), `HookType`
  (`http_request|db_query|file_operation|function_call|llm_call`), common
  defaults + per-family root-field lists.
- `src/spans/core-span.ts` — `toCoreSpanData(span,{privacy,...})` →
  `{wireSpan, diagnostics}`: strip nested `otel|openbox|data|metadata`; redact +
  truncate bodies; fill common defaults; guarantee family keys; reconstruct
  `end_time` from `start_time+duration_ns` for completed; keep started nulls.
- `src/wire/evaluate-payload.ts` — `buildEvaluatePayload(event,{privacy})`:
  normalize each span, assemble `spans` + `span_count == spans.length`;
  `makePayloadBuilder(privacy)`.
- `src/gate/event-rules.ts` — `checkLifecycleEnvelope`, `checkHookEnvelope`,
  `checkStage(event, expected)` emitting the 8 `ContractError` codes.
- `src/gate/index.ts` — `validateLifecycle`/`validateHook`; timestamp stamping at
  send boundary (`rfc3339Now` → `Z` millis); compat-noise strip; finalize
  (JSON-safe with null inclusion + redaction before signing); `raiseForVerdict`
  (HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW).
- Event timestamp helper `rfc3339Now()` (`Z`, millisecond precision — here
  `Date.toISOString()` IS correct).

Reference (read-only): `openbox-sdk-python/openbox_core/contracts/events.py`,
`wire/{core_span,evaluate_payload}.py`, `validation/event_rules.py`, `gate.py`;
Core `internal/content/governance.go` SpanData struct.

## Implementation Steps

1. Event enums + immutable `EventEnvelope` + `toPayloadDict` (omit-absent).
2. `classifyEvent` + `wireEventType` (hook → `ActivityStarted`).
3. All factories with `ValueError`-equivalent guards for missing required fields.
4. `otel-spans` defaults/matrices; `toCoreSpanData` normalization + diagnostics.
5. `buildEvaluatePayload` (single owner of spans/span_count).
6. Gate rules: lifecycle checks (reject hook-classified, `ActivityCompleted` with
   spans → `ACTIVITY_COMPLETED_WITH_SPANS`, span-bearing non-hook →
   `HOOK_TRIGGER_FALSE`, handoff/lifecycle/signal identity); hook checks
   (`HOOK_TRIGGER_FALSE`, `HOOK_WRONG_WIRE_TYPE`, `HOOK_EMPTY_SPANS`,
   `HOOK_UNBOUND_ACTIVITY`, `HOOK_SPAN_NOT_FLAT`); stage checks
   (`HOOK_SPAN_NO_STAGE`, `HOOK_STAGE_MISMATCH`).
7. Gate finalize + `raiseForVerdict`; ensure started nulls survive serialization.
8. Snapshot tests vs the Core SDK integration guide payloads.

## Success Criteria

- [ ] Factory snapshots match the Core SDK guide for each event type.
- [ ] Hook events wire as `ActivityStarted` + `hook_trigger:true` + non-empty
      `spans` + `span_count == spans.length`.
- [ ] Non-hook lifecycle omits `span_count`; legacy `span_count:0` treated as noise.
- [ ] Started-stage spans preserve explicit `end_time:null`/`duration_ns:null`
      through serialization.
- [ ] Full common-field matrix (incl. `request_body`/`response_body`/`request_headers`/
      `response_headers`/`semantic_type`/`attribute_key_identifiers`) + each family
      matrix enforced by tests driven from the Go struct field list.
- [ ] Nested hook-span shapes fail before send; all 8 strict codes have focused
      tests; missing semantic fields produce diagnostics, not failures.

## Risk Assessment

- Null-drop serialization would silently break started spans → test explicitly
  that nulls remain present.
- Field-name drift vs Core struct (e.g. `function` not `func_name`,
  `server_address` not `db_host`) → matrix tests pin exact wire keys.

## Explicit Non-Goals

- No real Node instrumentation yet; no Mastra lifecycle mapping; no new Core event
  type for hooks.
