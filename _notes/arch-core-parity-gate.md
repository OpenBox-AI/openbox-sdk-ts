---
type: arch
date: 2026-07-08
tags: [core-parity, signing, spans, go, testing, phase-4]
status: active
---

# Core-parity gate — proving TS ≡ Core (not just TS ≡ Python)

The golden fixture ([[decision-signing-parity-and-fail-closed-auth]]) proves TS ≡
**Python**. That is not enough — a Python-generated fixture can't prove the TS
output is accepted by **Core**. Plan Decision 1 mandates a real Core-parity gate.

## Mechanism (`test/core-parity/`)

A standalone Go program (`go-spandata-compat/main.go`) with Core's `SpanData`
struct **copied verbatim** from `openbox-core internal/content/governance.go`
(internal packages can't be imported cross-module, so the contract is pinned by
copy, cited to source). `core-parity.test.ts` drives it via stdin/stdout:

1. **Structural:** pipe TS-emitted wire spans → Go `json.Decode` with
   `DisallowUnknownFields()`. Any unknown top-level span field the SDK emits →
   Go rejects → test fails. This is the drift alarm: if a future phase adds a
   span field Core doesn't know, this catches it. Also confirms `end_time:null`
   → Core's non-pointer `int64` 0, `duration_ns` pointer nil, etc.
2. **Signing:** TS signs a canonical (over a non-ASCII payload) with the real
   `AgentIdentity`; the test derives the raw Ed25519 pubkey from the seed and Go's
   `crypto/ed25519.Verify` (the SAME primitive Core uses) checks it. Proves the
   TS signature is cryptographically valid to Core, not merely byte-equal to
   Python. A negative control asserts a tampered canonical fails.

## Gotchas

- **Requires a Go toolchain.** The test `describe.skipIf(!goAvailable)` — it
  silently skips if `go` is absent. CI MUST install Go or the gate is a no-op
  (it does not fail-closed on a missing toolchain). Go 1.26 present on this box.
- First `go run` compiles (~1.5s); per-test timeout is 120s. Harness has zero
  external deps (stdlib only) → runs offline, no `go.sum`.
- If this test starts failing after a span-shape change, the SDK emitted a field
  Core's `SpanData` doesn't have — fix the SDK, not the harness (the harness is
  the source of truth, pinned to Core).

See [[decision-signing-parity-and-fail-closed-auth]] and
`docs/contract-conflict-ledger.md`.
