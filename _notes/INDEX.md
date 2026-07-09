# Notes Index

Entry point for `openbox-sdk-ts` project notes. One line per note.

## Architecture

- [arch-base-sdk-scaffolding](arch-base-sdk-scaffolding.md) — Phase 1 scaffolding, tooling provenance (mirrors Mastra), and the npm-cache / Node-25 `moduleLoadList` sharp edges.
- [arch-core-parity-gate](arch-core-parity-gate.md) — how `test/core-parity/` proves TS ≡ Core (Go `SpanData` unmarshal + `ed25519.Verify`); requires a Go toolchain (skips silently without one).

## Debugging

- [debug-redis-typed-commands-bypass-sendcommand](debug-redis-typed-commands-bypass-sendcommand.md) — why node-redis `.get()`/`.set()` slip past a `sendCommand` prototype patch (closure-bound at module load); redis blocking is `sendCommand`-only by design.
- [debug-adapter-fail-closed-must-be-enforced-at-wrapper-layer](debug-adapter-fail-closed-must-be-enforced-at-wrapper-layer.md) — a base client that throws on 401/403 is defeated by an adapter wrapper that catch-alls + fail-opens; adapters must rethrow fail-closed errors at the pre-op boundary.
- [debug-approval-poll-missing-workflow-ids](debug-approval-poll-missing-workflow-ids.md) — approval poll sent empty IDs because Core's evaluate response never echoes workflow/run/activity_id; fix threads the originating context into handleApproval (ts+python+mastra).

## Decisions

- [decision-signing-parity-and-fail-closed-auth](decision-signing-parity-and-fail-closed-auth.md) — the two sticky Phase 2 decisions: ASCII-escape + PKCS8-DER signing byte-parity, and evaluate() failing CLOSED on auth 401/403 (intentional divergence from Python's fail-open).
- [decision-fail-open-on-non-auth-4xx](decision-fail-open-on-non-auth-4xx.md) — non-auth 4xx (400/404/422) follows on_api_error and fails OPEN under default; kept intentionally (availability), documented so it's not re-flagged.
