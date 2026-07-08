---
type: debug
date: 2026-07-09
tags: [fail-open, security, adapter, mastra, governance, phase-6]
status: active
---

# Fail-closed-on-auth must be enforced at the WRAPPER layer, not just the client

**Finding (Phase 6 Mastra migration, red-team Critical #4):** delegating the base
`OpenBoxClient` — which correctly THROWS `OpenBoxAuthError`/`OpenBoxSigningError`
on a 401/403 (never fail-opens) — is NOT sufficient. A framework adapter's
evaluate WRAPPER that does `try { verdict = await client.evaluate(...) } catch {
return null /* ALLOW under fail_open */ }` **re-swallows** that thrown auth error
and fails OPEN again. Under the default `on_api_error: fail_open`, a persistent
auth failure (revoked key, signing-key drift, clock skew) then silently runs
every gated operation ungoverned + skips REQUIRE_APPROVAL — the exact bypass the
base client fix was meant to close.

**Rule for any base-SDK adapter (Phase 7 adapter-checklist item):** at the
STARTED / pre-operation / resume boundary (where the verdict GATES the op), the
wrapper's catch MUST rethrow the fail-closed error classes — mirror base's
`isFailClosedCondition` (`OpenBoxAuthError` [covers `OpenBoxSigningError`],
`GovernanceAPIError`, `ContractError`) — regardless of `on_api_error`. Only a
genuine network/outage error (`OpenBoxNetworkError`) may fail-open under
`fail_open`. The COMPLETED / post-op path may keep swallowing (telemetry only —
matches base `hook-evaluator.ts`).

The base runtime (`OpenBoxRuntime`/`HookEvaluator.preflight`) already does this
correctly; the trap is only for adapters that wire the client directly instead of
going through the base runtime. See
[[decision-signing-parity-and-fail-closed-auth]] and
`docs/contract-conflict-ledger.md` (OQ1 posture).
