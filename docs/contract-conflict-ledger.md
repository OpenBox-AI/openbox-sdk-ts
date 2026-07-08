# Contract Conflict Ledger

Every place where the sources of truth (`openbox-core` > integration guide >
`openbox-sdk-python`) disagreed, or where a naive TS implementation would drift
from the wire contract. Each entry records both sources, the resolution, and the
chosen wire form. Phase tests must enforce the resolution.

Legend: **[verified-good]** = resolution confirmed against source; do not reverse
on an audit counter-argument alone (surface new data instead).

---

## 1. Started-span `end_time` / `duration_ns`

- **Core docs / Go struct:** `end_time` is a non-pointer `int64` (absent → `0`);
  `duration_ns` is `*int64,omitempty` (`internal/content/governance.go:266-318`,
  verdict read verified at `governance.go:272-274`; no `.rego` policy reads them).
- **Python:** a *started*-stage span emits explicit `end_time: null` and
  `duration_ns: null`.
- **Conflict:** emit `0`/omit (Core-doc literal) vs explicit `null` (Python).
- **Resolution:** **emit explicit `null`** for started-stage spans. Core unmarshals
  `null` → `0` for `end_time`, and `duration_ns` is `omitempty` — both wire-safe.
  Choosing `null` preserves cross-SDK parity with Python. **[verified-good — do not
  reverse.]**
- **Wire form:** serialize started spans with **null inclusion** (Python
  `exclude_none=False` at the gate); a null-drop serializer would silently break
  started spans. Phase 3 tests assert the nulls survive serialization.

## 2. Canonical signing string — trailing newline

- **Claim (research report):** canonical string ends with a trailing newline.
- **Source (re-verified 2026-07-08):** `internal/services/agent.go:92-100`
  `BuildAgentIdentityCanonicalRequest` = `strings.Join([5 fields], "\n")`.
  `strings.Join` places separators only **between** elements → **no trailing
  newline**. Python matches.
- **Resolution:** **no trailing newline.** The earlier "disagreement" was a
  research-report error, not a real conflict. `PATH` includes `/api/v1`.
- **Wire form:** `UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`
  (exactly 4 `\n`). Phase 2 golden test pins this byte-for-byte.

## 3. Golden fixture scope — Python-parity anchor, NOT a Core tiebreaker

- **Fixture:** `openbox-sdk-python/tests/signing/golden_temporal_signed_request.json`
  is **Python-generated and self-checked**.
- **Conflict:** treating a Python-generated fixture as proof that TS ≡ Core.
- **Resolution:** the fixture is a **Python-parity regression anchor only**. It
  proves TS ≡ Python, not TS ≡ Core. TS ≡ Core is proven **separately** by the
  **Phase 4 Core-parity gate** (a Go harness that unmarshals TS payloads into
  `content.SpanData` + verifies a TS signature via `ed25519.Verify`, or a
  dockerized Core round-trip). Fixture-only is **not** an acceptable gate.

## 4. Non-ASCII body escaping (highest byte-drift risk)

- **Python:** `json.dumps(...)` defaults to `ensure_ascii=True` → every code point
  ≥ `0x80` is escaped as `\uXXXX` (ASCII output).
- **JS naive:** `JSON.stringify` emits **raw UTF-8** for non-ASCII.
- **Conflict:** the two produce **different bytes** for any accented / non-Latin /
  emoji payload → different SHA-256 → **Core signature verification fails (401)**.
  Reproduced: JS `9fccf5…` ≠ Python `7a49e2…` for the same logical payload.
- **Resolution:** TS `serializeBody` MUST ASCII-escape (Phase 2 D3): compact JSON
  (`separators=(",",":")` equivalent — no spaces), escape every code unit ≥ `0x80`
  as lowercase `\uXXXX`, correct surrogate pairs for astral chars. SHA-256 **hex**
  of the exact bytes; the client transmits those exact bytes (never re-serialize).
- **Wire form:** body bytes = signed bytes = transmitted bytes. Empty-body hash
  `e3b0c442…b855`. Golden suite must cover non-ASCII / control / astral-emoji.

## 5. Signing timestamp `+00:00` vs event timestamp `Z`

- **Signing timestamp:** `+00:00` offset (never `Z`), **microsecond** precision,
  custom-formatted. `Date.toISOString()` (`Z` + millis) is **wrong for signing**.
- **Event-payload timestamp:** RFC3339 `Z`, **millisecond** precision —
  `Date.toISOString()` **is correct here**.
- **Conflict:** one `toISOString()` for both would break signing byte-parity.
- **Resolution:** **two distinct formatters.** Note this affects Python byte-parity
  only — Core rebuilds the canonical from the literal timestamp header (entry 2),
  so a `Z` signing timestamp is still *accepted* by Core but breaks the golden
  fixture. Phase 2 asserts a `Z` signing timestamp yields a **different** signature
  (format guard).

## 6. TS↔Python byte-parity is total for strings, partial for numbers/keys

Verified empirically (real `serializeBody` vs Python `json.dumps`, 39 payloads).
**Byte-identical** for all string/Unicode cases (non-ASCII keys + values, emoji
surrogate pairs, lone surrogates, U+2028/29, C1 controls, `<>&`, backslash). Two
gaps are **JS↔Python representational differences, unfixable at the serializer**:

- **Integer-like object keys** — JS auto-sorts integer-index keys ascending;
  Python preserves insertion order (`{"2":_,"1":_}` → JS `{"1":,"2":}`).
- **Whole-number floats** — a JS `number` has no int/float distinction, so
  `1.0`→`1` (Python keeps `1.0`).

**Not a Core-401 risk:** signing is self-consistent — `serializeBody` runs once,
the bytes are hashed and sent verbatim, and Core re-hashes the received bytes.
Only *cross-SDK* byte-identity is affected. Avoid integer-like keys / whole-number
floats in signed payloads if cross-SDK hash identity is ever relied upon (audit/
dedup).

**Epoch-nanosecond span timestamps — RESOLVED (Phase 3): use JS `number`.**
`start_time`/`end_time`/`duration_ns` are epoch nanoseconds (~1.75e18), above JS's
safe-integer limit (2^53 ≈ 9e15), so a `number` carries ~256 ns of rounding. That
is accepted: `number` serializes as an unquoted JSON integer Core parses as int64,
no `.rego` policy reads these fields at ns precision (Decision 10), and timestamps
never enter the OPA input map (verified against Core `opa.go`). `bigint` was
rejected — it cannot pass `JSON.stringify` and buys no governance benefit. Cost:
sub-µs imprecision + loss of cross-SDK ns byte-identity, both immaterial here.

---

## Open decisions (product/security — not plan defects)

- **`on_api_error` default — RESOLVED (user decision):** default stays `fail_open`,
  plus an opt-in third policy `fail_closed_destructive` (config value) that blocks
  only DESTRUCTIVE ops on an outage — db writes, file writes, non-idempotent HTTP
  (POST/PUT/PATCH/DELETE) — while reads/idempotent ops + lifecycle events (no spans)
  stay available. Auth 401/403 always fails closed regardless (next item). The SDK
  exposes the posture as config and lets operators choose; it does not force
  fail-closed. (`client/index.ts` classifies destructiveness from the payload spans.)
- **evaluate() fails CLOSED on 401/403** (Phase 2, `client/index.ts`), regardless
  of `on_api_error` — a signing/auth rejection must never launder into a fail-open
  ALLOW. **Trade-off (accepted):** a non-Core 403 (WAF/proxy/gateway/rate-limit)
  also hard-fails. Kept fail-closed because Core often returns auth rejections with
  **no machine reason code**, so a "no reason → treat as outage → fail-open" rule
  would reintroduce the silent-governance-bypass vulnerability. Deployments behind
  a 403-emitting proxy should be aware. (Revisit with Open Question 1.)
- **DB driver version-support policy** for prototype patching (`pg`, `mysql2`,
  `mongodb`, redis client) — blocks Phase 5 DB blocking success criteria.
- **Redaction default — RESOLVED (Phase 5 Tier A1):** credential HTTP headers
  (`authorization`, `cookie`, `x-api-key`, …) are redacted **unconditionally**
  before signing (they are never needed for a policy decision). Bodies are
  length-truncated (`maxBodySize`) but not field-redacted; function `args`/`result`
  are captured verbatim (opt-out `captureArgs`/`captureResult:false`). Rationale:
  Core is the trusted governance backend that MUST inspect payloads to decide —
  redacting everything would blind governance. Matches Python. `db_statement`
  redaction default is deferred to Tier A2. Consumers with PII in args/bodies
  should set `redactKeys` or the capture opt-outs.

## Node engine

`>=24.10.0` (parity with the current TS SDK family). Revisit before publish.
