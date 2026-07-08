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

---

## Open decisions (product/security — not plan defects)

- **`on_api_error` default:** keep `fail_open` fleet-wide, or `fail_closed` for
  destructive hook types (db/file writes, non-idempotent HTTP)? A `fail_open`
  default turns any persistent 401 or Core outage into fleet-wide ALLOW with only a
  `fallback_used` flag. (Resolve before Phase 7 ships the default.)
- **DB driver version-support policy** for prototype patching (`pg`, `mysql2`,
  `mongodb`, redis client) — blocks Phase 5 DB blocking success criteria.
- **Redaction default** for `db_statement` / bodies — redact-by-default vs opt-in.

## Node engine

`>=24.10.0` (parity with the current TS SDK family). Revisit before publish.
