# Changelog

All notable changes to `@openbox-ai/openbox-sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-07-09

### Fixed

- **Approval polling used the wrong IDs.** `FrameworkAdapter.handleApproval`
  read `workflow_id`/`run_id`/`activity_id` from `result.raw`, but Core's
  evaluate response never echoes them, so a configured `ApprovalPoller` polled
  `POST /api/v1/governance/approval` with empty IDs. The originating context is
  now threaded into the approval seam: `handleApproval(result, context?)`
  accepts an optional `ActivityContext` (lifecycle events build one from the
  event; hook evaluations pass the bound context) and prefers it, with
  `result.raw` kept only as a backward-compatible fallback. Existing adapters
  implementing `handleApproval(result)` keep working (the extra param is optional).

### Documented

- **Non-auth 4xx follows `on_api_error` (fail-open by default).** A review
  flagged that non-401/403 `4xx` evaluate responses fail open under the default
  policy; this is intentional (availability) and now recorded in
  `docs/contract-conflict-ledger.md`. Only auth `401/403` hard-fails regardless.

## [0.1.0] - 2026-07-09

Initial release. `@openbox-ai/openbox-sdk` is the TypeScript **base SDK** for
the OpenBox governance platform — a contract-driven foundation that Node/TS
framework SDKs build on instead of each reimplementing signing, validation,
and instrumentation. Behavior is reproduced from the canonical OpenBox Core
wire contract and the hardened Python base SDK, and verified against ported
golden fixtures plus a real Core-parity gate (see `docs/source-of-truth.md`).

### Added

- **Contracts** — `Verdict` (5-tier `allow < constrain < require_approval <
  block < halt`), `EvaluationResult`, `ApprovalResult`, `GuardrailsResult`,
  `EventEnvelope`/`EventType` with event factories (`workflowStarted`,
  `activityStarted`, `activityCompleted`, `signalReceived`, `handoff`,
  `hook`, ...), span field matrices, and diagnostics — all pure and lenient
  on unknown fields, available from the package root.
- **Layered configuration** (`OpenBoxConfig`, subpath `./config`) — explicit
  arguments > SDK-scoped env vars > global `OPENBOX_*` env vars > defaults,
  with eager validation (API key format, HTTPS-required URLs, DID/private-key
  pairing) and secret-redacted logging/serialization.
- **Byte-exact Ed25519 request signing** (`AgentIdentity`, subpath
  `./identity`) — an ASCII-escaping body serializer that matches Python's
  `json.dumps(ensure_ascii=True)` byte-for-byte, PKCS8-DER-wrapped Ed25519 key
  loading, and the exact canonical signing string OpenBox Core verifies
  (`UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`, no trailing
  newline, `+00:00` signing timestamp distinct from the `Z` event-payload
  timestamp).
- **HTTP client** (`OpenBoxClient`, subpath `./client`) — `evaluate`,
  `pollApproval`, and `validateApiKey` against the OpenBox Core governance
  API. Fails **closed** on an auth/signing rejection (HTTP 401/403)
  regardless of the configured `onApiError` policy, so a persistent auth
  failure (revoked key, signing drift, clock skew) can never silently
  degrade into a fleet-wide fail-open ALLOW. Outage (network/5xx) policy is
  configurable via `onApiError`: `fail_open` (default), `fail_closed`, or
  `fail_closed_destructive` — the last blocks only db/file writes +
  non-idempotent HTTP on an outage, while reads/idempotent ops and lifecycle
  events stay available.
- **Approvals** (`ApprovalPoller`, subpath `./approvals`) — HITL poll-loop
  orchestration (interval, backoff, timeout budget, consecutive-failure
  ceiling) on top of `OpenBoxClient.pollApproval`, with strict, fail-safe
  approval-decision parsing (unknown/empty decisions are pending, never an
  implicit allow).
- **Always-strict validation gate** (root + internal `./gate`) — malformed
  event/runtime contracts raise `ContractError` before any network send,
  independent of the fail-open/fail-closed network policy. No
  observe/sanitize/strict mode toggle — the gate is always strict.
- **Runtime composition root** (`OpenBoxRuntime`, subpath `./runtime`) —
  wires config, client, gate, context, and a `FrameworkAdapter` together;
  drives lifecycle evaluation (`evaluateLifecycle`) and preflight/completed
  hook evaluation (`preflight`/`completed`) through one seam, enforcing
  verdict priority (`HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL >
  CONSTRAIN > ALLOW`).
- **Framework adapter contract** (`FrameworkAdapter`, `CoreAdapter`, subpath
  `./adapters`) — the one place a governance verdict becomes a
  framework-native effect. `CoreAdapter` raises the base error types
  directly and fails safe (REJECTED, not silently allowed) when no
  `ApprovalPoller` is configured.
- **Per-runtime context** (`ContextStore`, subpath `./context`) —
  `AsyncLocalStorage`-scoped activity binding with a bounded trace-id
  correlation map fallback, plus abort/halt flags. Each `OpenBoxRuntime`
  owns its own store; there is no process-wide singleton.
- **Conformance kit** (subpath `./conformance`) — `FakeCore`/`FakeAdapter`,
  scenario matrices, and wire-shape assertions for testing SDKs and adapters
  built on this package (test utility, not a frozen public API), plus a real
  **Core-parity gate**: a Go harness that unmarshals TS-emitted wire spans
  into OpenBox Core's actual `SpanData` struct (`DisallowUnknownFields`) and
  independently verifies Ed25519 signatures with Go's `crypto/ed25519` —
  proving TS ≡ Core, not merely TS ≡ a ported fixture.
- **Node instrumentation** (`initOpenBoxInstrumentation`, subpath
  `./instrumentation`) — opt-in, custom-wrapper-based governance (never
  OpenTelemetry, which cannot block a call):
  - Tier A1 (always available): global `fetch`, `fs.promises`
    (`readFile`/`writeFile`), and `traced()` for arbitrary wrapped functions.
  - Tier A2/B (opt-in per driver via `databases: [...]`, never
    auto-detected): `pg` (promise-form `query`), `redis` (`sendCommand` only
    — see Known limitations), `mysql2` (promise-form `query`/`execute`),
    `mongodb` (12 named CRUD methods).
  - Fail-loud patchability checks (hard diagnostic, or a thrown
    `OpenBoxInstrumentationError` under `{ strict: true }`), atomic
    partial-failure rollback, and a recursion guard so the SDK's own
    governance traffic is never itself evaluated.
- **Import-light package root** — `import "@openbox-ai/openbox-sdk"` pulls in
  no crypto, network, database-driver, or OpenTelemetry code and performs no
  global patching. Heavy subsystems live behind subpath exports only,
  enforced by a root-import-safety test and the `import:check` script (which
  imports the built `dist/index.js` in a clean process and fails on any
  heavy module load or global patch).

### Known limitations

- `redis` governance blocking covers `client.sendCommand([...])` only —
  typed commands (`.get()`, `.set()`, `.hSet()`, ...) bind to an internal
  executor at module load and bypass the patched method entirely, so they
  are neither blocked nor observed. See `docs/instrumentation-coverage.md`.
- `pg`/`mysql2` callback-style `query(text, cb)` and streaming/cursor APIs
  are not intercepted (promise-form calls only).
- `mongodb` governance covers 12 named CRUD methods; cursors
  (`find()`/`aggregate()`) and `watch()` change streams pass through
  ungoverned.
- LLM-provider instrumentation is reserved
  (`config.instrumentation.llmEnabled`) but not yet implemented.
- `redis` typed-command blocking is an accepted, documented limitation
  (`sendCommand`-only) — see `docs/instrumentation-coverage.md`.

### Requirements

- Node.js `>=24.10.0`.
