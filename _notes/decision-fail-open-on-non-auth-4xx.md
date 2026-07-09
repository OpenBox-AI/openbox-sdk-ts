---
type: decision
date: 2026-07-09
tags: [client, fail-open, governance, security]
status: active
---

# Keep fail-open on non-auth 4xx (intentional)

A red-team review of the evaluate path flagged that non-auth `4xx` responses
from Core can fail **open**: in [`client/index.ts`](../src/client/index.ts)
every non-401/403 status `>= 400` is routed through `networkFailure()`, which
under the default `on_api_error="fail_open"` returns a `fallback_used=true`
ALLOW. So a Core `400/404/422` (malformed payload, wrong endpoint, schema
reject) — which is a contract/version mismatch, not an outage — silently lets
the governed operation proceed.

## Decision

**Keep the behavior. Do not fail-closed on 4xx.** (Maintainer decision,
2026-07-09.) This is an availability-over-strictness posture: a contract/version
skew that makes Core reject the SDK's payload should not brick the fleet under
the default policy. Operators who want the stricter posture already have knobs:

- `on_api_error="fail_closed"` — blocks on any outage, including 4xx.
- `on_api_error="fail_closed_destructive"` — blocks destructive ops only.

## Why (not just what)

- **Parity:** `openbox-sdk-python` `_parse_evaluate_response` lumps all
  `status >= 400` the same way — this is shared source-of-truth behavior, not a
  TS-only miss. TS already *diverges* from Python for auth `401/403` (always
  fail-closed — see [[decision-signing-parity-and-fail-closed-auth]]); the
  maintainer chose NOT to extend that divergence to contract 4xx.
- **Auth is the one carve-out:** only `401/403` hard-fails regardless of policy,
  because a signing/auth break would otherwise silently disable governance
  fleet-wide. A 4xx contract error is comparatively rare and self-announcing
  (the SDK is sending something Core rejects), and the operator can opt into
  fail-closed if that risk matters to them.

## Sharp edge for future readers

The `client/index.ts` docstring and `docs/framework-adapter-guide.md` say
fail-open applies to "network/outage failures only (5xx, timeouts)". That
framing is about the **auth** carve-out — it is NOT a claim that non-auth 4xx
fails closed. Non-auth 4xx follows `on_api_error` like any outage. The
authoritative record is the "Open decisions" section of
[`docs/contract-conflict-ledger.md`](../docs/contract-conflict-ledger.md).

Do not "fix" this by throwing on 4xx without re-confirming with the maintainer —
it was reviewed and deliberately kept.
