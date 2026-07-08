# Phase 5: Node Instrumentation Hook Runtime

## Goal

Add generic Node operation governance without relying on Mastra-specific code.

Instrumentation should use the same hook runtime and flat span contract already
validated in earlier phases.

## Scope Strategy

Start small and safe. The first implementation may include only:

- function wrappers
- fetch/undici or HTTP client wrapper where preflight can occur before the
  operation

Add DB, file, and provider-specific instrumentation only after their preflight
and completed semantics are clear.

## Work

1. Implement hook runtime:
   - started/preflight event
   - completed event
   - no context means skip
   - recursion guard for OpenBox client's own requests
   - adapter owns block/halt/approval effects

2. Implement span builders:
   - HTTP/fetch span builder
   - function span builder
   - placeholder extension points for DB/file/LLM

3. Implement instrumentation manager:
   - install once
   - uninstall idempotently
   - avoid package-root side effects
   - avoid patching unsupported runtimes

4. Add privacy controls:
   - redact keys before signing
   - truncate large request/response fields
   - produce diagnostics

5. Add tests proving preflight happens before real operation execution.

## Acceptance Criteria

- Started-hook BLOCK/HALT prevents the real operation.
- Completed-hook BLOCK/HALT is recorded for future framework behavior and does
  not claim to undo work already done.
- OpenBox client's own evaluate/approval requests do not recursively govern
  themselves.
- Hook spans remain flat.
- Unsupported instrumentation targets fail closed at setup only when explicitly
  requested; otherwise they are skipped with diagnostics.

## Explicit Non-Goals

- Do not promise full DB/file parity in v1 unless implementation proves it.
- Do not copy Mastra OTel processor behavior wholesale.
- Do not use OTel as the only source of truth if a preflight wrapper must block
  before the operation.

## Test Focus

- function preflight block
- function completed telemetry
- fetch preflight block
- fetch completed telemetry
- recursion guard
- privacy redaction
- truncation diagnostics
- install/uninstall idempotency
