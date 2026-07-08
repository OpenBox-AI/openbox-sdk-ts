---
phase: 2
title: "Contracts Config Identity Client"
status: pending
priority: P1
effort: "4-5d"
dependencies: [1]
---

# Phase 2: Contracts Config Identity Client

## Overview

Port the framework-independent typed primitives: errors, result contracts,
layered config, byte-exact serialization + identity/signing, the HTTP client, and
the approval poller. Highest-risk phase — signing must be byte-for-byte compatible
with `openbox-sdk-python` and accepted by `openbox-core`.

## Requirements

- Functional: golden Python-parity signing; lenient evaluate parsing; strict
  approval parsing; approval poll loop with budget; config precedence + validation;
  client fail-open/fail-closed with auth-4xx distinguished from network.
- Non-functional: no runtime-heavy deps at package root; crypto via `node:crypto`.

## Architecture

Grounded in [Python report](./research/researcher-01-openbox-sdk-python-contracts-report.md)
§2-7 + [Core report](./research/researcher-02-openbox-core-wire-contract-report.md)
§2-3,6-7. See plan.md Contract Decisions 1-7, 16, 18.

### Signing (byte-exact — plan.md D1-D4)

Canonical string: `UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`,
**no trailing newline** (`openbox-core/internal/services/agent.go:94-100` uses
`strings.Join(...,"\n")`; Python matches). `PATH` includes `/api/v1`. Sign ASCII
bytes with Ed25519 via `node:crypto`; signature = standard padded base64.

**Ed25519 key load (pin the recipe):** input is base64 raw 32-byte seed. Node
`createPrivateKey` rejects a bare seed and JWK-`d`-only. Wrap in PKCS8 DER:
`Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"), seed])` →
`createPrivateKey({key: der, format:"der", type:"pkcs8"})` → `sign(null, data, key)`.
Verified byte-identical to Python's `Ed25519PrivateKey.from_private_bytes`. Add a
negative test asserting a raw-seed load throws (guards against future
"simplification").

**Body bytes (plan.md D3 — CRITICAL):** compact single-pass JSON with **non-ASCII
escaped as `\uXXXX`** to match Python `json.dumps(...)` default `ensure_ascii=True`.
Plain `JSON.stringify` emits raw UTF-8 → different bytes → different hash → Core
401. Implement an ascii-escaping serializer (escape every code unit ≥ 0x80,
lowercase hex, correct surrogate pairs for astral chars). SHA-256 **hex** of the
exact bytes; client transmits those exact bytes (never `json=`/re-serialize).

**Timestamps:** signing timestamp = `+00:00` offset, microsecond precision,
custom-formatted (not `toISOString()`); injectable for the golden test. Event
timestamps handled in Phase 3.

**Nonce:** CSPRNG (`crypto.randomUUID()` or ≥16 random bytes base64url), never
`Math.random`. Note the ±5-min Core skew window as a diagnostic concern.

**Golden fixture is a Python-parity regression anchor, NOT a Core tiebreaker**
(plan.md D1). Port `golden_temporal_signed_request.json` verbatim (it contains
`café`/`☕` — the non-ASCII guard) and assert canonical/body/hash/signature/header
equality + that a `Z` timestamp yields a different signature. The real TS≡Core
gate is added in Phase 4 (Go harness / round-trip).

### Insecure-URL validation (plan.md D18)

`new URL(api_url).hostname`, strip `[]` for IPv6, exact-match
`{localhost,127.0.0.1,::1}`; reject any other host for `http:`. Never
substring/`startsWith`. Test `localhost.evil.com`, `127.0.0.1.evil`, `[::1]`,
`http://user:pass@evil.com`.

### Client fail-open vs auth-4xx (plan.md D6)

`evaluate` must NOT treat a persistent auth/signing 401 as a network outage that
fail-opens to ALLOW. Distinguish: network error / 5xx → fail-open (fallbackAllow)
or fail-closed per config; 401 with a signing reason → loud diagnostic + fail-closed
(or trip a breaker after N consecutive auth rejections). Mirror the auth endpoint's
reason-code extraction.

## Related Code Files

Create:
- `src/errors/index.ts` — full hierarchy incl. `ContractError`(`code`,`detail`),
  `OpenBoxSigningError`(`reasonCode`), `OpenBoxInsecureURLError`, governance +
  approval errors; `extractGovernanceError` walker.
- `src/contracts/results.ts` — `Verdict`+`fromString`; `GuardrailsResult`;
  `EvaluationResult.fromDict` (lenient, `raw`, `fallbackAllow`,
  `guardrails`≡`guardrailsResult`); `ApprovalResult.fromDict` (STRICT).
- `src/config/index.ts` — `OpenBoxConfig`+sub-configs; layered `resolve()`;
  `.normalized()` (D18 URL method, API-key pattern, DID+privkey both-or-neither);
  `.loadIdentity()`.
- `src/serialization/index.ts` — `serializeBody` (compact + ascii-escape),
  `toJsonSafe`, `applyRedaction`, `truncateString`, byte-equality helper.
- `src/identity/index.ts` — DID validate, PKCS8-DER Ed25519 load,
  `buildCanonicalString`, `buildAuthHeaders`, `prepareSignedRequest`, CSPRNG nonce,
  header constants, `EMPTY_BODY_SHA256`.
- `src/client/index.ts` — `OpenBoxClient` (`validateApiKey` GET, `evaluate` POST,
  `pollApproval` POST) via global `fetch` + `AbortSignal.timeout`; raw bytes;
  fail-open/closed with auth-4xx distinction; raw preservation; expiry parse.
- `src/approvals/index.ts` — `ApprovalPoller` (interval/backoff, expiry,
  `maxConsecutiveFailures`, `maxWaitMs` → `ApprovalTimeoutError`) over
  `client.pollApproval`. Configured by `HitlConfig`.

Reference (read-only): `openbox-sdk-python/openbox_core/{errors,identity,
serialization,client,config,approvals}.py`, `contracts/results.py`,
`tests/signing/golden_temporal_signed_request.json`, `tests/test_golden_signing.py`.

## Implementation Steps

1. Errors; `Verdict`; `EvaluationResult`(lenient) + `ApprovalResult`(strict).
2. Config precedence + `.normalized()` (D18 URL method, key pattern, DID pairing).
3. Serialization: ascii-escaping compact body bytes; redaction/truncation; byte
   equality. Test non-ASCII/control/astral vs a Python-generated expected hash.
4. Identity: PKCS8-DER seed load (+ negative raw-seed test), canonical string,
   CSPRNG nonce, signed headers, empty-body case.
5. Port golden fixture + parity test (canonical/body/hash/sig/headers; `Z`≠`+00:00`).
6. Client: 3 calls; raw bytes; evaluate distinguishes auth-4xx from network/5xx;
   pollApproval null on network/non-200; validateApiKey maps 401/403.
7. `ApprovalPoller` loop with budget + timeout.

## Success Criteria

- [ ] Golden signing test proves Python byte-parity (canonical/body/hex-hash/
      base64-sig/all 5 headers); non-ASCII payload hashes match Python (not raw UTF-8).
- [ ] Raw-seed / JWK-`d` Ed25519 load throws; PKCS8-DER load reproduces the golden sig.
- [ ] `Z` signing timestamp ⇒ different signature (format guard).
- [ ] Unknown evaluate fields in `raw`; unknown/empty approval → pending (never ALLOW).
- [ ] `guardrails` ≡ `guardrailsResult`.
- [ ] Config rejects bad key + insecure non-local HTTP (incl. `localhost.evil.com`,
      `[::1]` accepted); missing one of DID/privkey errors.
- [ ] evaluate fail-closes / diagnoses on persistent 401; fail-opens only on network/5xx.
- [ ] `ApprovalPoller` raises `ApprovalTimeoutError` on budget/consecutive-failure.
- [ ] Root import-safety test still green.

## Risk Assessment

- Non-ASCII hash drift (D3) — ascii-escape serializer + non-ASCII golden cases.
- Fixture proves only Python parity — Core parity deferred to Phase 4 gate (D1).
- Node vs Python Ed25519 — PKCS8-DER recipe pinned + golden signature assert.
- Fail-open hiding a signing break — auth-4xx distinction (D6).

## Explicit Non-Goals

- No framework adapter, OTel, or hook instrumentation. No Mastra dependency.
