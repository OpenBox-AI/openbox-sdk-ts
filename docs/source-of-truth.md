# Source Of Truth

This package is **contract-driven, not Mastra-driven**. Behavior is reproduced
from the canonical wire contract and the hardened Python base SDK, then verified
against ported golden fixtures **and** a real Core-parity gate (Phase 4). Mastra
is the first integration target and a tooling reference — never a behavioral
source.

## Source-of-truth order

When sources disagree, **stop and record the conflict** in
[`contract-conflict-ledger.md`](./contract-conflict-ledger.md). Do not silently
copy TS SDK behavior into base.

1. `openbox-core` HTTP API + stored wire contract (**server = canonical**).
2. `openbox-core/docs/sdk-integration-guide.md`.
3. `openbox-sdk-python` — base-SDK architecture + hardened behavior.
4. Existing TS SDKs (`openbox-mastra-sdk`) — tooling reference + migration target
   only.

> Two research reports contained factual errors the red-team corrected (the
> "trailing-newline" and "redis-blocks-via-OTel" claims). **Trust source, not
> summaries.**

## Core endpoint contract (summary)

Reference repo: `openbox-core` (sibling checkout). Canonical request builder
independently re-verified 2026-07-08.

| Endpoint | Method | Body | Notes |
|---|---|---|---|
| `/api/v1/auth/validate` | `GET` | empty (→ empty-body SHA-256 when signed) | maps 401/403 |
| `/api/v1/governance/evaluate` | `POST` | evaluate payload | lenient parse, fail-open/closed |
| `/api/v1/governance/approval` | `POST` | approval poll | strict parse |

**Canonical signing string** (`internal/services/agent.go:92-100`,
`BuildAgentIdentityCanonicalRequest`):

```
strings.Join([UPPER(METHOD), PATH, TIMESTAMP, NONCE, BODY_SHA256_HEX], "\n")
```

- **No trailing newline** (`strings.Join` of 5 fields). `PATH` includes `/api/v1`.
- Core **reparses the literal `X-OpenBox-Agent-Timestamp` header** with
  `time.Parse(time.RFC3339Nano, ...)` and enforces a replay-TTL skew window
  (`agent.go` `identityReplayTTL`; ~±5 min) — so `+00:00`-vs-`Z` affects only
  **Python byte-parity**, not Core acceptance. The real Core-rejection risk is an
  internal hash/sign/transmit inconsistency (see ledger: non-ASCII escaping).
- Signature = Ed25519, standard padded base64. Core verifies server-side via
  `identityVerifier.Verify(alias, canonical, signature)` (`agent.go:184`) — a
  KMS-style aliased verifier; do NOT assume a bare `ed25519.Verify` call inside
  Core. The Phase 4 Core-parity gate's Go harness may call `ed25519.Verify`
  directly after extracting the agent public key.

Signed headers (only when DID + private key both configured):
`X-OpenBox-Agent-{DID,Timestamp,Nonce,Signature}`, `X-OpenBox-Body-SHA256`.
Always sent: `Authorization: Bearer`, `User-Agent: OpenBox-SDK/{version}`,
`X-OpenBox-SDK-Version`.

`SpanData` wire struct authoritative source:
`internal/content/governance.go:266-318` — drive the Phase 3 field matrix from
the Go struct, **not** the SDK integration guide (the guide under-reports).

## Python base SDK → TS module map

Reference repo: `openbox-sdk-python` (sibling checkout; package `openbox_core/`).
Internal `src/` layout is **inspired by Python, not a literal mirror**: Python has
no top-level `spans/` and folds normalization under `wire/` + `validation/`; TS
extracts a dedicated `spans/` (from Python `wire/core_span.py` +
`validation/span_normalization.py`) and folds the rest of `validation/`
(`event_rules`, `registry`, `diagnostics`) into `gate/`.

| Python (`openbox_core/…`) | TS (`src/…`) | Phase |
|---|---|---|
| `errors.py` | `errors/` | 2 |
| `contracts/results.py` | `contracts/results.ts` | 2 |
| `config.py` | `config/` | 2 |
| `serialization.py` | `serialization/` | 2 |
| `identity.py` | `identity/` | 2 |
| `client.py` | `client/` | 2 |
| `approvals.py` | `approvals/` | 2 |
| `contracts/events.py` | `contracts/events.ts` | 3 |
| `contracts/otel_spans.py` | `contracts/otel-spans.ts` | 3 |
| `wire/evaluate_payload.py` | `wire/evaluate-payload.ts` | 3 |
| `wire/core_span.py` + `validation/span_normalization.py` | `spans/core-span.ts` | 3 |
| `validation/event_rules.py` + `gate.py` + `validation/{registry,diagnostics}.py` | `gate/` | 3 |
| `contracts/context.py` | `contracts/context.ts` | 4 |
| `context.py` | `context/` | 4 |
| `adapters/base.py` | `adapters/base.ts` | 4 |
| `runtime.py` | `runtime/` | 4 |
| `conformance/*` | `conformance/` | 4 |
| `hooks/{events,wrappers,preflight}.py` | `hooks/` | 5 |
| `instrumentation/*` | `instrumentation/*` | 5 |
| `otel/*` | `otel/` (optional; no current consumer) | 5 |
| `sdk_version.py` | `src/index.ts` (`SDK_VERSION`) | 1 |

## Mastra duplicated surfaces to replace (Phase 6 delegate list)

These `openbox-mastra-sdk` paths currently reimplement shared behavior and will
**delegate to base** once base-backed replacements pass tests:

- `src/types/{verdict,governance-verdict-response,guardrails,errors,workflow-event-type}.ts`
- `src/client/openbox-client.ts`
- `src/config/openbox-config.ts` — ⚠ config divergence: Mastra adds
  `multiAgent`/`multiAgentSessionId` (copilotkit omits). Base exports the generic
  type; Mastra keeps its resolver in `src/mastra/`.
- `src/identity/agent-identity.ts`
- `src/governance/{approval-registry,context}.ts`

**Stays in Mastra (adapter/lifecycle only):** `src/mastra/*`,
`src/governance/activity-runtime.ts`, `src/otel/setup-openbox-opentelemetry.ts`,
`src/span/openbox-span-processor.ts`, and `src/types/workflow-span-buffer.ts`
(repoint its `Verdict` import to base).

## Mastra NOT trusted — re-verify before adopting (5 surfaces)

Mastra logic on these surfaces must be re-verified vs Python/Core **before** the
migration trusts it. **Base wins on conflict; document the change.**

1. **Error retry / fail-open** — a persistent auth/signing 401 must NOT fail-open
   to ALLOW as if it were a network outage (ledger + Phase 2 D6).
2. **Verdict priority + application** — `allow|constrain|require_approval|block|halt`
   = priority 1..5; alias handling.
3. **Config defaults** — precedence, `max_body_size` (65536), `on_api_error`
   default (open question: fail-open vs fail-closed for destructive hooks).
4. **Approval wire format** — STRICT parse; empty/unknown → pending (`null`), never
   implicit allow.
5. **Guardrails redaction** — redaction + truncation happen **before signing**
   (they change hashed bytes).
