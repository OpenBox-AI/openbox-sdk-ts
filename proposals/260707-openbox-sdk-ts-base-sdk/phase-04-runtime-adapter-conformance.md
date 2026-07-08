# Phase 4: Runtime Adapter Conformance

## Goal

Build the framework-neutral runtime model and reusable conformance fixtures
that future TS framework SDKs can run.

## Work

1. Implement `ActivityContext`:
   - workflow identity
   - run identity
   - activity identity
   - input/output fields
   - agent metadata
   - session and multi-agent session fields
   - free-form metadata

2. Implement context binding:
   - async-local storage for Node
   - explicit bind/reset helpers
   - safe cleanup on thrown errors
   - trace correlation helpers

3. Implement `FrameworkAdapter`:
   - `name`
   - lifecycle block/halt behavior
   - hook block/halt behavior
   - async approval handling
   - optional sync approval handling
   - completed-hook result callback

4. Implement `OpenBoxRuntime`:
   - owns config, client, gate, context store, adapter
   - evaluates lifecycle events
   - evaluates hook preflight and completion
   - routes native effects through adapter
   - closes resources idempotently

5. Implement conformance kit:
   - fake Core
   - fake adapter
   - started hook block prevents operation execution
   - completed hook cannot pretend to undo completed work
   - approval parsing matrix
   - fail-open/fail-closed matrix
   - context cleanup matrix
   - hook wire shape assertions

## Acceptance Criteria

- Runtime can evaluate lifecycle events without framework dependencies.
- Runtime can evaluate hook preflight and completion without framework
  dependencies.
- Adapter is the only layer that creates native framework effects.
- Context is always reset after success and error paths.
- Conformance fixtures are importable by downstream SDK tests.
- Fake Core proves request body and header shapes.

## Explicit Non-Goals

- Do not migrate Mastra yet.
- Do not install global instrumentation yet.
- Do not require OTel for basic runtime usage.

## Test Focus

- adapter call order
- block/halt propagation
- approval pending/rejected/approved behavior
- fallback behavior under network errors
- context cleanup in thrown paths
- no bound context hook skip
- fake Core request capture
