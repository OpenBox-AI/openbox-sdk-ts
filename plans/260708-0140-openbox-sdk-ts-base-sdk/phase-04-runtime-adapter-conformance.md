---
phase: 4
title: "Runtime Adapter Conformance"
status: pending
priority: P1
effort: "4-5d"
dependencies: [3]
---

# Phase 4: Runtime Adapter Conformance

## Overview

Build the framework-neutral runtime model (context store, adapter seam,
composition root, approval driving) and a reusable conformance kit **plus a real
Core-parity gate**. This phase is the hard gate: Phase 6 (Mastra migration) must
not begin until conformance proves signing, client, approval, and hook wire shape
match Python **and Core**.

## Requirements

- Functional: runtime evaluates lifecycle + hook with no framework deps; adapter
  is the only layer producing native effects; context scoping is leak-free and
  concurrency-safe; approval matrix behaves per strict parsing; conformance kit
  importable; **TS≡Core proven, not just TS≡Python**.
- Non-functional: OTel not required for basic runtime use; conformance kit shipped
  as a test utility in v1 (not a frozen public API).

## Architecture

Grounded in [Python report](./research/researcher-01-openbox-sdk-python-contracts-report.md)
§12-15. See plan.md Decisions 1, 6, 13-14.

- **Context scoping uses `AsyncLocalStorage.run(ctx, cb)`** — NOT Python's
  `bind(ctx)->Token`/`reset(token)` (Node ALS has no restore-token API;
  `enterWith` does not unwind for siblings). `activityScope(ctx,{traceId})` =
  `als.run(ctx, () => { register?; try { return cb() } finally { unregister? } })`.
- **Second lookup path** `traceId → ActivityContext` keyed by the **32-hex string**
  (or `BigInt("0x"+hex)`), never `parseInt(hex,16)`. It exists for instrumentation
  that lost async-local context. It MUST be bounded: TTL/LRU cap + explicit
  unregister on trace/activity end. If a passive `OpenBoxSpanProcessor.on_start`
  registers child-trace ids, `on_end`/completion MUST unregister them — otherwise a
  long-lived Node process leaks `ActivityContext` and risks cross-tenant bleed.
- **Adapter seam:** `FrameworkAdapter` (async `handleApproval`, optional
  `handleApprovalSync`, `raiseLifecycleBlocked`, `raiseHookBlocked`,
  `onCompletedHookResult`). Base ships `CoreAdapter`. **`CoreAdapter` with no
  poller REJECTS `REQUIRE_APPROVAL`** (matches `adapters/base.py:87`) — it does not
  pend or allow. Pending/approved/expired outcomes require an `ApprovalPoller`
  (Phase 2) or the `FakeAdapter`.
- **Runtime** owns config, client, gate, context store, adapter, payload builder,
  and drives approvals via the adapter; idempotent `close()`.
- **Multi-runtime invariant (plan.md OQ3):** decide + document either one
  process-wide controller (throw on 2nd `init`) or per-controller-scoped
  patches/store, so runtime B's `close()` cannot clear runtime A's state.

## Related Code Files

Create:
- `src/contracts/context.ts` — `ActivityContext` (immutable) + `toPayloadFields()`
  (metadata via setdefault; never overwrites first-class fields).
- `src/context/index.ts` — `ContextStore`: `activityScope`/`currentActivityContext`
  over `AsyncLocalStorage.run`; bounded `registerTrace`/`contextForTrace`/
  `unregisterTrace` (32-hex/BigInt key, TTL/LRU); governance flags; `clear()`;
  `traceMapSize()` test hook; controller-scoped or documented-singleton.
- `src/adapters/base.ts` — `FrameworkAdapter` + `CoreAdapter` (no-poller REJECTS
  approvals; completed-hook no-op).
- `src/runtime/index.ts` — `OpenBoxRuntime` composition root + lifecycle/hook
  evaluation + approval driving + idempotent close.
- `src/conformance/index.ts` — kit (test utility): `FakeCore` (captures body +
  headers, scripts verdicts), `FakeAdapter` (records call order + drives approval
  matrix), scenario matrices, `assertHookWireShape`.
- `test/core-parity/` — **Core-parity gate** (plan.md D1): a Go harness that
  unmarshals TS-produced evaluate payloads into `content.SpanData` and verifies a
  TS-produced signature via `BuildAgentIdentityCanonicalRequest` + `ed25519.Verify`
  (port `openbox-sdk-python/tests/wire/test_backend_compat.py`), or a dockerized
  Core round-trip asserting 2xx. Gated behind an opt-in CI job if Go/Docker absent.

Reference (read-only): `openbox-sdk-python/openbox_core/{context,runtime,approvals}.py`,
`contracts/context.py`, `adapters/base.py`, `otel/span_processor.py`,
`tests/wire/test_backend_compat.py`; `openbox-mastra-sdk/src/governance/context.ts`
(the working `als.run` pattern).

## Implementation Steps

1. `ActivityContext` + `toPayloadFields`.
2. `ContextStore` on `als.run`; bounded trace map (32-hex key, TTL/LRU, unregister);
   flags; `activityScope` finally-unregister. Concurrency + leak tests below.
3. `FrameworkAdapter` + `CoreAdapter` (no-poller rejects; document it).
4. `OpenBoxRuntime`: wire everything; `evaluateLifecycle`, `preflight`/`completed`;
   adapter effects (preflight BLOCK/HALT → `raiseHookBlocked`; completed →
   `onCompletedHookResult`); drive approval via `ApprovalPoller`+adapter; idempotent close.
5. Conformance kit (test utility): `FakeCore` capture; `FakeAdapter`; matrices —
   started-hook block prevents op; completed cannot undo; approval
   pending/rejected/approved/expired (via FakeAdapter/poller) + **Core-unreachable
   ⇒ ApprovalTimeoutError** (not infinite poll); **fail-open vs fail-closed under
   network error AND under persistent 401**; context cleanup on success + throw;
   no-bound-context skip; hook wire-shape.
6. Core-parity gate (`test/core-parity/`).
7. Concurrency test: two overlapping `activityScope`s never observe each other's
   context. Leak test: mint many child-trace ids, drive N "requests", assert
   `traceMapSize()` returns to baseline and no cross-context resolution.

## Success Criteria

- [ ] Runtime evaluates lifecycle + hook with zero framework deps.
- [ ] Adapter is the only layer creating native effects; `CoreAdapter`
      completed-hook is a no-op; `CoreAdapter`-no-poller rejects `REQUIRE_APPROVAL`.
- [ ] `activityScope` (als.run) resets on success + throw; two overlapping scopes
      never cross-observe context.
- [ ] Trace map keyed by 32-hex/BigInt (no `parseInt`); bounded — `traceMapSize()`
      returns to baseline after N requests; no stale cross-tenant resolution.
- [ ] Approval matrix (pending/rejected/approved/expired) behaves per strict
      parsing via FakeAdapter/poller; Core-unreachable ⇒ `ApprovalTimeoutError`.
- [ ] `FakeCore` proves request body + all signed headers.
- [ ] **Core-parity gate green** (Go harness or Core round-trip): TS≡Core, not just
      TS≡Python — including a non-ASCII payload.
- [ ] Conformance kit importable by an external test file (test-utility path).
- [ ] **Conformance + Core-parity gates green → unblocks Phase 6.**

## Risk Assessment

- ALS context loss across driver callbacks → bounded trace-map path; leak + bleed
  tests are the mitigation.
- Approval "unknown → allow" regression → strict approval matrix.
- Multi-runtime shared-state interference → single-instance invariant test.

## Explicit Non-Goals

- No Mastra migration; no global instrumentation install; OTel not required here.
