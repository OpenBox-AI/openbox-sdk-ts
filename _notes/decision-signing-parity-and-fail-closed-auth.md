---
type: decision
date: 2026-07-08
tags: [signing, ed25519, serialization, fail-open, phase-2]
status: active
---

# Signing byte-parity + fail-closed-on-auth (Phase 2)

Two decisions that are **verified and load-bearing — do not "simplify" them away.**

## 1. serializeBody must ASCII-escape; Ed25519 needs the PKCS8-DER wrap

- `serializeBody` = `JSON.stringify(payload)` then escape **every UTF-16 code
  unit ≥ 0x80** as `\uXXXX` (regex `/[^\x00-\x7F]/g`). This reproduces Python's
  `json.dumps(..., ensure_ascii=True)` byte-for-byte. Plain `JSON.stringify` emits
  raw UTF-8 → different SHA-256 → Core 401 on any accented/emoji payload.
- Ed25519 via `node:crypto` requires wrapping the raw 32-byte seed in PKCS8 DER:
  prefix `302e020100300506032b657004220420` + seed → `createPrivateKey({format:"der",
  type:"pkcs8"})`. A bare seed / JWK-`d`-only does NOT load (there's a regression
  test that asserts the bare-seed load throws — keep it).
- Both are proven by `test/golden-signing.test.ts` against a fixture copied
  **byte-identically** from `openbox-sdk-python`. Verified — do not reverse on an
  audit argument alone.
- **Known parity gap (not a bug):** integer-like object keys reorder (JS sorts
  them) and whole-number floats collapse (`1.0`→`1`) vs Python. Unfixable at the
  serializer. Signing stays self-consistent (single serialize → hash → send
  verbatim) so Core still accepts; only cross-SDK byte-identity is affected. See
  [contract-conflict-ledger §6](../docs/contract-conflict-ledger.md).

## 2. evaluate() fails CLOSED on auth 401/403 — intentional divergence from Python

Python's client treats **all** HTTP ≥400 as a network failure → fail-open ALLOW
(only a `fallback_used` flag). That is the silent-governance-bypass hole the
red-team flagged: a persistent 401 (bad key / clock skew / signing break) would
disable governance fleet-wide.

**Base SDK diverges:** a 401/403 throws (fail-closed) regardless of `on_api_error`;
only network errors / 5xx / other 4xx honor fail-open. A signed 401/403 with a
Core reason code surfaces as `OpenBoxSigningError`.

- Do NOT revert to Python's "all ≥400 → fail-open."
- Trade-off (accepted): a non-Core 403 (WAF/proxy) also hard-fails. We keep
  fail-closed because Core often returns auth rejections with **no machine reason
  code**, so "no reason → treat as outage → fail-open" would reintroduce the
  vulnerability. Documented for proxy deployments in the ledger open-decisions.

See [[arch-base-sdk-scaffolding]] for tooling; ledger for the full contract set.
