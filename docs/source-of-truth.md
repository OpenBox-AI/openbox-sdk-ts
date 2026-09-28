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

## IAM v3 workload contract summary

Reference: `openbox-core` `origin/develop` `bbe79ca` (handlers
`internal/api/keycloak_workload_bootstrap.go`, `keycloak_workload_transition.go`;
wire types `internal/content/keycloak_workload_identity.go`; verifiers
`internal/services/identity/keycloak_workload_token.go`, `keycloak_workload_transition.go`).
Design: `openbox-iam-v3-typescript-sdk-spec.md` (workspace root). Re-inspect the
target Core revision before relying on this table.

| Step | Request | Notes |
|---|---|---|
| Bootstrap | `GET /api/v3/auth/bootstrap`, API key + SDK headers only | Direct JSON object: `bootstrap_version`/`contract_version` = 3, `token_endpoint`, `issuer`, `audience`, `client_id`, `service_account_id`, `activation_version` (canonical non-nil UUIDs), `identity_source` (`openbox`/`okta`/`entra`), `kid`. `404` = no v3 on this Core; `409 workload_identity_unavailable` = no active authority. |
| Token | `POST <token_endpoint>` form: `grant_type`, `client_id`, `client_assertion_type`, `client_assertion` | RS256 assertion: header `{alg,kid,typ:"JWT"}`, claims `{aud: token_endpoint, exp: iat+60, iat, iss=sub=client_id, jti}`. No API key, proof, scope, audience, or secret. |
| Runtime | `/api/v3/{auth/validate, governance/evaluate, governance/approval, handoffs}` | `Authorization: Bearer <API key>` + raw `X-OpenBox-Workload-Token`. Core verifies locally (RS256, issuer, audience, ≤ 6 min lifetime, 60 s skew, active realm key, `sub`/`azp`/`openbox_*` claims vs the active service account) and collapses failures into a generic 401. `Handoff` on v3 evaluate is a 400. |
| Candidate | `GET /api/v3/auth/workload-transition/bootstrap?transition_id=`, then `POST /api/v3/auth/workload-transition/proof` `{transition_id, client_assertion}` | API key only; Core verifies the candidate's registered key, claims the `jti` once, and records proof. No Keycloak call; activation is a separate Backend action. |

Rules enforced in `src/client/workload-*.ts`: token endpoint must equal the issuer
(one trailing slash trimmed) + `/protocol/openid-connect/token`; issuer/token URLs
are HTTPS (HTTP only for exact `localhost`/`127.0.0.1`/`::1`) with no userinfo,
query, or fragment; no v3 request follows a redirect (a runtime redirect is a contract
error — ledger 12); bootstrap/token/transition requests run in
`runAsInternal` (Keycloak is not Core's origin); tokens cache ≤ 300 s with a 30 s
margin, `expires_in` must be a number > 30.

**Intentional differences from `openbox-sdk-python`** (design decisions, not
conflicts — see the spec §1, §6.1, §7.3, §10):

1. Workload mode is fixed to v3 before the first request; Python resumes legacy
   authentication on bootstrap `404`/`409 workload_identity_unavailable`. TS never does.
2. Every renewal re-fetches bootstrap; Python reuses the cached document.
3. `proveWorkloadIdentityTransition` requires an explicit candidate key; Python
   defaults to the active workload key.
4. The Okta key is a workload alias only under explicit `keycloak_workload`; Python
   uses it whenever no neutral key is set.
5. `identity_source` must match exactly (Python lowercases it); UUIDs are accepted
   case-insensitively and normalized to lowercase (as Python does).
6. A blank env var (empty or whitespace-only) counts as unset and falls through to the
   next layer (user decision, 2026-09-28); Python treats any set value, even an empty
   one, as set.

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
