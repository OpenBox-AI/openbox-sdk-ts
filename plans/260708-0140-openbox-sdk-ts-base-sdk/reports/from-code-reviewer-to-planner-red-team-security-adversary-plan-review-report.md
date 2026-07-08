# Red-Team Plan Review — Security Adversary + Fact Checker

**Plan:** `260708-0140-openbox-sdk-ts-base-sdk` (plan.md + phase-01..07)
**Perspective:** Security Adversary. **Verification role:** Fact Checker.
**Method:** 40+ claims grepped/read against `openbox-sdk-python`, `openbox-core`, `openbox-mastra-sdk`; two signing/crypto claims verified empirically in Node v25.8.2 against the actual golden fixture.
**Verdict:** Signing design is mostly sound and byte-identity IS feasible — but the plan's written contract omits the single most likely byte-drift bug (non-ASCII JSON escaping), which the default fail-open policy silently converts into a fleet-wide governance bypass.

Findings: **1 Critical, 3 High, 3 Medium.**

---

## Finding 1: `JSON.stringify` diverges from Python `json.dumps` on all non-ASCII → signature mismatch → silent governance bypass under default fail-open

- **Severity:** Critical
- **Location:** plan.md "Contract Decisions" #3 (lines 106-111); Phase 2 "Signing" + `serializeBody` spec.
- **Flaw:** Decision 3 enumerates the byte-exactness traps (trailing newline, `+00:00` vs `Z`, JS millis vs Python micros, re-serialization after hash) but **omits non-ASCII escaping**. Python `serialize_body` calls `json.dumps(payload, separators=(",",":"))` with the implicit `ensure_ascii=True` default, so every codepoint ≥ 0x80 is emitted as `\uXXXX` ASCII. JS `JSON.stringify` emits raw UTF-8. The two byte-streams differ for any accented name, non-Latin text, or emoji — extremely common in agent telemetry (user names, prompts, tool args).
- **Failure scenario:** I reproduced the exact golden payload in Node. `JSON.stringify` produced body SHA-256 `9fccf50d80f07f78050a3c36338c515bf21c49171d52745e6941055dc6390c5e`; Python's stored hash is `7a49e279b410d4e53187f5a52a4227bf167f4f681306370db6cb74564aaa3ab9`. JS emitted `...unicode-café-☕"}`; Python emitted `...café-☕"}`. Because `X-OpenBox-Body-SHA256` and the Ed25519 signature both cover these bytes, Core rejects with `body_sha256_mismatch` (agent.go:167) or `signature_invalid`. The client treats any HTTP ≥ 400 as a network failure (`_parse_evaluate_response`, client.py:203-204) and, under the **default `on_api_error="fail_open"`**, returns `EvaluationResult.fallback_allow(...)` = ALLOW (client.py:214-219). Net effect: **any governed operation carrying a non-ASCII payload silently escapes governance**, reported as allowed with a `fallback_used=true` flag most callers ignore. The golden fixture (which happens to contain `café`/`☕`) is the *only* guard, and it is a single test an implementer could "fix" by regenerating from JS output.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/serialization.py:85` — `return json.dumps(payload, separators=(",", ":")).encode("utf-8")` (no `ensure_ascii=False` → defaults to True/escaped).
  - `openbox-sdk-python/tests/signing/golden_temporal_signed_request.json:24` — `"note": "unicode-café-☕"`; `:33` body_sha256 `7a49e279...`.
  - Node repro (scratchpad `verify.mjs`): `BODIES EQUAL? false`; JS hash `9fccf50d...` ≠ PY `7a49e279...`.
  - `openbox-core/internal/services/agent.go:167` — `subtle.ConstantTimeCompare(...bodyHashHex... headers.BodySHA256) != 1` → reject.
  - `openbox-sdk-python/openbox_core/client.py:203-204, 214-219` — `status_code >= 400` → `_network_failure` → fail-open `fallback_allow`.
  - Grep of all four research reports + plan: **zero** occurrences of `ensure_ascii` / non-ASCII / `\u00` escaping.
- **Suggested fix:** Add an explicit contract rule: TS `serializeBody` must escape every UTF-16 code unit ≥ 0x80 as lowercase `\uXXXX` (matching Python's surrogate-pair output for astral chars, e.g. `😀`→`😀`) — `JSON.stringify` alone is wrong. Add non-ASCII, control-char, and astral-emoji cases to the golden/round-trip suite, and forbid regenerating the fixture from JS. See also Finding 7 (fail-open should not mask this).

---

## Finding 2: The golden fixture is Python-generated and only tested against Python — it structurally cannot adjudicate the Python-vs-Core question the plan assigns it

- **Severity:** High
- **Location:** plan.md "Contract Decisions" #1 (lines 92-99); Phase 1 ledger step 6 ("Canonical string trailing newline… pin empirically via ported golden fixture"); Phase 2 "Trailing-newline resolution".
- **Flaw:** The plan treats a claimed Python-vs-Core disagreement on the trailing newline as the top signing risk and designates the ported golden fixture as "the empirical tiebreaker." But the fixture was generated *from a Python signer* (`_generated_by`/`_source_signer` fields) and `test_golden_signing.py` only asserts the SDK's own signer reproduces the stored values — i.e. it proves Python≡TS, **never TS≡Core**. A fixture that encodes only Python's behavior cannot detect a Python-vs-Core divergence: if Core truly required a trailing newline, Python and TS would agree with each other and both be rejected by Core, and every plan test would still pass.
- **Failure scenario:** The "disagreement" is in fact a research error. researcher-02 asserts the canonical string includes a trailing `\n` "verified in test at agent_test.go," but Core builds it with `strings.Join([5 elements], "\n")` (no trailing newline), and agent_test.go:879-880 merely round-trips through that same function — it makes no independent trailing-newline assertion. Here Core happens to match Python, so no live break results; but the plan's stated methodology would give false confidence for the general case (e.g. the Finding 1 non-ASCII drift, or a future field-order change), because nothing in the chain checks the wire against Core.
- **Evidence:**
  - `openbox-core/internal/services/agent.go:93-101` — `BuildAgentIdentityCanonicalRequest` = `strings.Join([]string{ToUpper(method), path, timestamp, nonce, bodySHA256}, "\n")` → **no trailing newline**.
  - `openbox-core/internal/services/agent_test.go:879-880` — test calls the same `BuildAgentIdentityCanonicalRequest(...)` then `ed25519.Sign(...)`; no separate newline check.
  - `researcher-02-openbox-core-wire-contract-report.md:217,231` — template `...{BODY_SHA256}\n` and "including trailing newline (verified in test at agent_test.go)" — **contradicted by source**.
  - `tests/signing/golden_temporal_signed_request.json:2-3,31` — `_source_signer` = Python; `canonical` has no trailing `\n`. `tests/signing/test_golden_signing.py:44-81` — all assertions compare to the Python-generated fixture only.
- **Suggested fix:** Correct the ledger to cite `services/agent.go:93-101` (strings.Join → no trailing newline) as the authority, not "the fixture." Add a real Core-side check: either an integration test that POSTs the TS-signed request to a running Core and asserts 2xx, or a checked-in Go-verifier vector, so parity is TS≡Core, not TS≡Python.

---

## Finding 3: The plan's Ed25519 key-load guidance offers a non-working alternative and omits the one detail that makes "no external crypto dep" reproducible

- **Severity:** High
- **Location:** plan.md Decision #4 (lines 116-117, "Use Node built-in `node:crypto` Ed25519 — no external crypto dep"); Phase 2 "Ed25519 seed" (lines 49-52).
- **Flaw:** Phase 2 says the seed load is `crypto.createPrivateKey` "from a PKCS8 wrapper **or** `createPrivateKey({key, format})` Ed25519." The provisioned key is a raw 32-byte seed (Python: `Ed25519PrivateKey.from_private_bytes(seed)`). Node's `createPrivateKey` has **no format that accepts a raw 32-byte seed** — the second alternative is a dead end, and the JWK path additionally requires the public key. Only the PKCS8-DER-wrap path works, and the plan never states the required 16-byte prefix, so the sole viable route is under-specified.
- **Failure scenario:** An implementer picks the simpler-looking `createPrivateKey({key: seed, format:"der", type:"pkcs8"})` and hits `error:068000A8:asn1 encoding routines::wrong tag` (verified), or tries JWK and hits `key.x must be of type string` (verified). Under deadline pressure they add an external Ed25519 dependency (defeating the stated goal) or hand-roll a wrap incorrectly. Byte-identity itself is feasible: wrapping the seed with prefix `302e020100300506032b657004220420` and signing reproduces the golden signature `xLV65W0P...XQNH7Cg==` exactly — so the fix is purely to pin the recipe.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/identity.py:123` — `Ed25519PrivateKey.from_private_bytes(seed)` (raw 32-byte seed).
  - Node repro (`verify.mjs`): TEST 3 raw seed → `wrong tag`; TEST 4 JWK d-only → `key.x must be of type string`; TEST 2 PKCS8-wrap → `SIGNATURES EQUAL? true`.
  - `phase-02:49-52` — "`crypto.createPrivateKey` from a PKCS8 wrapper or `createPrivateKey({key, format})` Ed25519."
- **Suggested fix:** Replace the two-option phrasing with the concrete recipe: prepend the fixed PKCS8 DER header `302e020100300506032b657004220420` to the 32-byte seed and call `createPrivateKey({key: der, format:"der", type:"pkcs8"})`; sign via `crypto.sign(null, data, key)`. Add a negative test asserting the raw-seed load throws (guards against a future "simplification").

---

## Finding 4: Recursion guard uses host-unanchored `url.startsWith(prefix)` → attacker-influenced outbound URL bypasses preflight governance

- **Severity:** High
- **Location:** plan.md Risks ("ignored-URL prefix guard + no-active-span check", lines 192-193); Phase 5 "Cross-cutting → Recursion guard" (lines 55-56); reference `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts`.
- **Flaw:** The plan reuses Mastra's recursion guard as the primary self-call filter, and that guard is a plain string prefix test: `ignoredUrls.some(prefix => url.startsWith(prefix))`. The ignored prefix is the OpenBox API base (client builds its own URL as `f"{api_url}{path}"`). A string `startsWith` on the full URL is **not host-anchored**, so any governed operation whose URL merely *begins with* the api_url string is treated as an internal SDK call and skips governance entirely. Preflight (block-before-execute) is the security control here; a bypass defeats it.
- **Failure scenario:** With `api_url = "https://api.openbox.ai"`, an agent outbound call (e.g. a prompt-injected/SSRF tool call) to `https://api.openbox.ai.evil.com/exfil` or `https://api.openbox.ai@evil.com/exfil` returns `true` from `shouldIgnoreUrl` (both start with the prefix), so `runtime.preflight()` is never awaited and a BLOCK/HALT policy cannot stop the request — yet the request actually resolves to `evil.com`. This is governance evasion, not just a loop-prevention miss. Custom `api_url`, proxies, or redirect targets that don't share the prefix are the inverse hole (self-calls get governed → recursion).
- **Evidence:**
  - `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:1004-1009` — `return ignoredUrls.some(prefix => url.startsWith(prefix));`
  - `openbox-sdk-python/openbox_core/client.py:179` — self URL = `f"{self._api_url}{path}"` (the string used as the prefix).
  - `phase-05:55-56` — "Recursion guard: ignored-URL prefix (OpenBox API base) in the fetch patch + a no-active-span / internal-call check."
- **Suggested fix:** Make the internal-call flag (AsyncLocalStorage / depth counter) the *primary* guard for the SDK's own client calls, not URL matching. If URL filtering is kept, compare the parsed `new URL(url).origin` (scheme+host+port) for **exact equality** with the api_url origin — never `startsWith` on the raw string. Add tests for `{api_url}.evil.com`, `{api_url}@evil.com`, and a custom/proxied api_url.

---

## Finding 5: Insecure-URL validation is specified as a rule, not a method — a naive TS port leaks the API key over cleartext HTTP; the `[::1]` bracket divergence also breaks IPv6 localhost

- **Severity:** Medium
- **Location:** Phase 2 step 4 (line 92, "allow http only for localhost/127.0.0.1/::1"); reference `config.py:_validate_url_security`.
- **Flaw:** Python extracts the host with `urlparse(api_url).hostname` and tests exact membership in `("localhost","127.0.0.1","::1")`. The plan states only the *rule*, not that TS must use the WHATWG `new URL(api_url).hostname` with exact set membership. A substring/`startsWith`/`includes` port is an easy mistake and creates a cleartext key-leak bypass. Separately, JS and Python disagree on the IPv6 host form, which a faithful port gets wrong.
- **Failure scenario:** (a) If TS implements `hostname.includes("localhost")`, then `api_url="http://localhost.evil.com"` is treated as localhost → HTTP allowed → the `Authorization: Bearer <api_key>` and all signed headers are sent in cleartext to `evil.com`, interceptable on the wire. (b) Even a correct exact-membership port breaks on IPv6: `new URL("http://[::1]:8080/").hostname` returns `"[::1]"` **with brackets** (verified), which is not in Python's bracket-less `{"::1"}` set → a legitimate IPv6-localhost dev URL is rejected, tempting the implementer into an unsafe bracket-strip.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/config.py:254-256` — `parsed = urlparse(api_url); is_localhost = parsed.hostname in ("localhost","127.0.0.1","::1"); if parsed.scheme=="http" and not is_localhost: raise OpenBoxInsecureURLError`.
  - Node repro (`verify.mjs` TEST 5): `http://[::1]:8080/ -> hostname='[::1]'`; `http://localhost.attacker.com/ -> hostname='localhost.attacker.com'`; `http://127.0.0.1.evil/ -> hostname='127.0.0.1.evil'`.
- **Suggested fix:** Specify the method: parse with `new URL()`, read `.hostname`, strip surrounding brackets for IPv6 (`[::1]`→`::1`), then exact-match the allowlist; reject anything else for `http:`. Add tests for `localhost.evil.com`, `127.0.0.1.evil`, `[::1]`, and `http://user:pass@evil.com`.

---

## Finding 6: Nonce entropy and the ±5-minute replay/skew window are unaddressed in the plan

- **Severity:** Medium
- **Location:** plan.md Decision #4 (signed headers, lines 112-117); Risks ("Nonce/replay + timestamp window" is asked for but no concrete mitigation); Phase 2 `prepareSignedRequest`/`buildAuthHeaders` spec.
- **Flaw:** Python generates the nonce with `secrets.token_urlsafe(24)` (192-bit CSPRNG). The plan lists `X-OpenBox-Agent-Nonce` but never pins the TS primitive (must be `crypto.randomBytes`/`randomUUID`, not `Math.random`) or a minimum entropy. It also never surfaces Core's ±5-minute timestamp window / replay TTL as an SDK constraint, so there is no clock-skew diagnostic.
- **Failure scenario:** (a) A `Math.random`-based or short nonce can collide across workers/process restarts; Core's replay cache is keyed on `(did, nonce)` with a 5-minute TTL and rejects a collision as `nonce_replayed` (a legitimate request fails as if replayed — availability hit). (b) If the host clock skews > 5 minutes, Core rejects every signed request as `timestamp_outside_window`; with the default fail-open (Finding 7) this becomes a silent governance blackout rather than a surfaced error. The plan gives implementers no guidance on either.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/identity.py:223` — `nonce = ... secrets.token_urlsafe(24)`.
  - `openbox-core/internal/services/agent.go:32` — `defaultAgentIdentityReplayTTL = 5 * time.Minute`; `:157` — `timestamp.Before(now.Add(-TTL)) || timestamp.After(now.Add(TTL))`; `:207-213` — `agent_identity_nonce:{did}:{nonce}` → `nonce_replayed`.
  - `researcher-02:...273-274,290-294` document the ±5min window and replay cache, but the plan does not carry them into any phase requirement.
- **Suggested fix:** Require a CSPRNG nonce (`crypto.randomUUID()` or ≥16 random bytes base64url) in Decision 4 / Phase 2; add a note that the signing timestamp must be fresh per request and that clock skew > ±5 min causes rejection; consider a startup `validateApiKey` that maps `timestamp_outside_window` to an actionable diagnostic.

---

## Finding 7: Default fail-open treats signing/auth 4xx identically to a network outage → any persistent signing regression becomes a silent, fleet-wide governance bypass

- **Severity:** High
- **Location:** plan.md Decision #6 (fail-open on network fail, lines 121-124); Phase 2 step 8 ("evaluate fail-open returns fallbackAllow"); reference `client.py:_parse_evaluate_response`/`_network_failure`.
- **Flaw:** The plan faithfully reproduces Python's behavior where `_parse_evaluate_response` maps **any** `status_code >= 400` to `_network_failure`, which under the default `on_api_error="fail_open"` returns an allow-shaped result. This conflates a client-side auth/signing rejection (401 `signature_invalid` / `body_sha256_mismatch` / `nonce_replayed` / `timestamp_outside_window`) with a transient network outage. The plan's risk list flags "Signing byte drift" but never connects it to the fail-open path, so a signing regression fails *open*, not loud.
- **Failure scenario:** Any of Findings 1, 5-clock-skew, or a future key/DID misconfig produces a persistent 401 from Core. Every `evaluate` call returns `fallback_allow` = ALLOW with `fallback_used=true`. Governance is silently disabled for the whole deployment until someone notices the flag (most callers don't). An attacker who can force signing failures (e.g. inject non-ASCII per Finding 1) gets deterministic governance evasion.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/client.py:202-204` — `if response.status_code >= 400: return self._network_failure(...)`.
  - `openbox-sdk-python/openbox_core/client.py:214-219` — `_network_failure`: `if fail_closed: raise; return EvaluationResult.fallback_allow(reason)`.
  - `openbox-sdk-python/openbox_core/client.py:284-295` — the auth endpoint *does* distinguish 401/403 and surfaces reason codes; the evaluate path does not.
- **Suggested fix:** In Phase 2, require the evaluate path to distinguish persistent auth/signing 4xx (esp. 401 with a signing `reason_code`) from network/5xx: emit a loud diagnostic and either fail-closed or trip a circuit-breaker after N consecutive auth rejections, so a signing break cannot masquerade as an outage and silently allow-all.

---

## Verified correct (threat-model checks that did NOT yield a finding)

To avoid abstract worries: these adversary angles were checked against source and are sound in the plan.

- **Redaction/truncation before signing:** correct ordering — `gate.py:158-162` runs `to_json_safe` then `apply_redaction` before the payload is handed to the client/signer; Decision 16 + Phase 3 finalize reproduce this. No secret is hashed post-redaction.
- **Ed25519 byte-identity feasibility:** empirically true (Finding 3, TEST 2) — Node reproduces the golden signature exactly, so "no external crypto dep" is achievable.
- **`guardrails` ≡ `guardrailsResult` same object:** `results.py:135-137` returns `self.guardrails` via a property; the plan's getter approach matches.
- **`content=body` (never `json=`) discipline:** enforced in Python (`client.py:188`, AST test in `test_golden_signing.py:145-163`); Phase 2 carries it as a requirement.
- **Private-key hygiene:** Python keeps `agent_private_key` `repr=False` (config.py:136), stores only the key object (identity.py:139), and never echoes key bytes (identity.py:112-127); Phase 7 security review reiterates it.

---

## Unresolved questions

1. Does a running Core instance ever 3xx-redirect `/api/v1/...` to a different host (CDN/edge)? If so, Finding 4's origin-equality guard must account for redirect targets, and the global-`fetch` patch's interaction with transparent redirect-following needs a test.
2. Is `install_opentelemetry: true` + `file_enabled: true` defaulting-on (config.py:88-91) intended for the base SDK, given the plan's "import-light root, install nothing on import" gate? Confirm the base SDK ships these defaults OFF until `initOpenBoxInstrumentation()` is called.
3. Should the base SDK default `on_api_error` to `fail_closed` for signed/production configs (Finding 7), or is fleet-wide fail-open an accepted product decision?
