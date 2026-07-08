---
title: OpenBox TypeScript Base SDK + Mastra Adapter Migration
description: >-
  Build @openbox-ai/openbox-sdk as the TS base SDK equivalent of
  openbox-sdk-python, grounded byte-for-byte in openbox-core wire contracts and
  Python base-SDK behavior, then migrate openbox-mastra-sdk to consume it as a
  thin adapter.
status: pending
priority: P1
branch: ''
tags:
  - sdk
  - governance
  - typescript
  - node
  - signing
  - instrumentation
  - mastra
  - migration
blockedBy: []
blocks: []
created: '2026-07-07T19:27:03.154Z'
createdBy: 'ck:plan'
source: skill
---

# OpenBox TypeScript Base SDK + Mastra Adapter Migration

## Overview

Create `@openbox-ai/openbox-sdk` — the TypeScript base SDK that plays the same
role for Node/TS framework SDKs that `openbox-sdk-python` plays for Python. It
owns shared OpenBox behavior (contracts, config, identity/signing, clients,
strict gate, runtime/context, spans/wire, hook runtime, instrumentation,
conformance kit). Then migrate `openbox-mastra-sdk` to consume it as a thin
adapter that keeps only Mastra lifecycle mapping.

This plan is **contract-driven, not Mastra-driven**: behavior is reproduced from
`openbox-sdk-python` + `openbox-core`, verified against ported golden fixtures
**and a real Core-parity gate** (see Decision 1). Mastra is the first integration
target and a tooling reference — never a behavioral source.

**Source of this plan:** [proposals/260707-openbox-sdk-ts-base-sdk](../../proposals/260707-openbox-sdk-ts-base-sdk/plan.md)
(design doc). Grounded against real source by four research passes
([python](./research/researcher-01-openbox-sdk-python-contracts-report.md),
[core](./research/researcher-02-openbox-core-wire-contract-report.md),
[mastra](./research/researcher-03-openbox-mastra-sdk-tooling-and-migration-report.md),
[instrumentation](./research/researcher-04-node-instrumentation-preflight-report.md))
and hardened by a 4-lens red-team (see `## Red Team Review` + `reports/`).

## Locked Scope Decisions (user-confirmed)

1. **Phases 1-7 end-to-end** — base SDK + Mastra migration + release. Phase 6
   Mastra migration is hard-gated behind Phase 4 conformance passing.
2. **Node engine `>=24.10.0`** — parity with the current TS SDK family.
3. **Broader instrumentation (all 7 targets)** — fetch + functions + `fs` + `pg`
   + `redis` + `mysql` + `mongodb`. Kept at user's explicit direction after
   red-team flagged that the only in-plan consumer (Mastra) blocks none of the
   DB targets. Phase 5 is split into three tiers: **A1** = fetch/fs/function
   (Mastra parity, the only Phase 6 gate), **A2** = pg/redis (common DB custom
   wrappers), **B** = mysql/mongodb. A2 and B are decoupled so neither blocks
   Phase 6. Streaming APIs are telemetry-only.
   **Documented risk:** DB preflight has no current in-plan consumer (Mastra uses
   OTel DB telemetry only) — see Risks.
4. **npm package name `@openbox-ai/openbox-sdk`**; repo `openbox-sdk-ts`.

## Source Of Truth Order

1. `openbox-core` HTTP API + stored wire contract (server = canonical).
2. `openbox-core/docs/sdk-integration-guide.md`.
3. `openbox-sdk-python` for base-SDK architecture and hardened behavior.
4. Existing TS SDKs (`openbox-mastra-sdk`) — tooling reference + migration
   target only.

When these disagree, **stop and record the conflict** in the contract conflict
ledger (Phase 1). Do not silently copy TS SDK behavior into base. (Note: two
research reports contained factual errors the red-team corrected — the canonical
trailing-newline and redis-blocks-via-OTel claims. Trust source, not summaries.)

## Architecture Boundary

**Base SDK owns:** `OpenBoxConfig` + layered env resolution; `AgentIdentity` +
signed request prep; `OpenBoxClient` (auth/validate, governance/evaluate,
governance/approval); `ApprovalPoller`; result contracts (`Verdict`,
`EvaluationResult`, `ApprovalResult`, guardrails, raw preservation); event
envelope + factories + wire projection; strict gate; `ActivityContext` + context
store + trace correlation; `FrameworkAdapter` interface + `CoreAdapter` default;
Core `SpanData` normalization + flat hook-span assertions; hook runtime
(preflight/completed); Node instrumentation; fake Core + conformance fixtures.

**Mastra SDK owns:** Mastra workflow/agent/tool/A2A lifecycle mapping; Mastra
metadata → `ActivityContext`; Mastra-native error classes and public API
(`withOpenBox`, wrappers); Mastra-specific enforcement ergonomics.

## Module Layout & Tooling Split (key distinction)

- **Internal `src/` modules are inspired by Python** (`openbox-sdk-python`):
  `contracts`, `wire`, `spans`, `gate`, `hooks`, `runtime`, `context`,
  `adapters`, `errors`, `client`, `config`, `identity`, `approvals`,
  `instrumentation`, `otel`, `conformance`, `serialization`. (Not a literal
  mirror — Python has no top-level `spans/` and does have `approvals`,
  `serialization`, `validation`; internal granularity is free.)
- **Public `exports` are consumer-driven**, not one-per-module. Start with `.`
  plus the subpaths Mastra actually imports (Phase 6); add subpaths on demand.
  `./conformance` ships as a test utility in v1 (promote to a public/shared
  package when a second consumer lands). `./otel` (completed-telemetry
  `OpenBoxSpanProcessor`) is optional and has no current consumer — build it but
  keep it out of the critical path.
- **Build/test/lint tooling mirrors Mastra** (canonical, most-modern TS SDK):
  `tsup` (ESM, `bundle:false`, `dts`, `target:node24`), `tsconfig` (ES2023 /
  ESNext / Bundler / strict + `exactOptionalPropertyTypes`), `vitest` (v8,
  node), `eslint` flat, `prettier`. Version pins verified current. Drop
  `@mastra/core` and framework-specific OTel instrumentations from the root.

## Contract Decisions (grounded, byte-exact)

Verified against source; each phase's tests must enforce them.

1. **Canonical signing string:** `UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`,
   `PATH` includes `/api/v1`. **No trailing newline** — Core builds it with
   `strings.Join([5 fields],"\n")` (`openbox-core/internal/services/agent.go:94-100`)
   and Python matches; the earlier "trailing newline" claim was a research error.
   The ported Python golden fixture (`golden_temporal_signed_request.json`) is a
   **Python-parity regression anchor, not a Core tiebreaker** — it is
   Python-generated and only self-checks. Phase 4 MUST add a real Core-parity
   gate: port `openbox-sdk-python/tests/wire/test_backend_compat.py` (a Go harness
   that unmarshals TS-produced payloads into Core's `content.SpanData` and
   verifies a TS signature via `ed25519.Verify`), or a dockerized Core round-trip.
2. **Two timestamp formats.** Signing timestamp = `+00:00` offset (never `Z`),
   microsecond precision; custom-formatted (`Date.toISOString()` is `Z`+millis →
   wrong for signing). Event-payload timestamp = RFC3339 `Z`, millis
   (`toISOString()` correct there). Note: Core rebuilds the canonical from the
   **literal** `X-OpenBox-Agent-Timestamp` header, so `+00:00`-vs-`Z` affects only
   Python byte-parity, not Core acceptance — the real Core-rejection risk is
   internal hash/sign/transmit inconsistency (Decision 3).
3. **Body bytes = signed bytes = transmitted bytes.** Compact JSON
   (`separators=(",",":")`, no spaces), single pass. **Non-ASCII must be escaped
   as `\uXXXX` (ASCII) to match Python `json.dumps` default `ensure_ascii=True`** —
   plain `JSON.stringify` emits raw UTF-8 and produces a DIFFERENT hash for any
   accented/non-Latin/emoji payload (reproduced: JS `9fccf5…` ≠ Python `7a49e2…`),
   which fails Core signature verification → 401. SHA-256 **hex** of the exact
   bytes. Client sends **raw body bytes** (never `json=`/re-serialize). Empty-body
   hash: `e3b0c442…b855`. Cover non-ASCII/control/astral-emoji in the golden suite.
4. **Signed headers** (only when DID + private key both configured):
   `X-OpenBox-Agent-{DID,Timestamp,Nonce,Signature}`, `X-OpenBox-Body-SHA256`.
   Always: `Authorization: Bearer`, `User-Agent: OpenBox-SDK/{id}`,
   `X-OpenBox-SDK-Version`. Signature = Ed25519, standard padded base64. Ed25519
   via `node:crypto` (no external dep) requires wrapping the raw 32-byte seed in
   PKCS8 DER: prefix `302e020100300506032b657004220420` + seed →
   `createPrivateKey({key, format:"der", type:"pkcs8"})` → `sign(null, data, key)`
   (verified byte-identical to Python; raw-seed and JWK-`d`-only paths do NOT work
   in Node). **Nonce must be a CSPRNG value** (`crypto.randomUUID()` / ≥16 random
   bytes), never `Math.random`. Signing timestamp must be fresh; clock skew >
   ±5 min → Core rejects (`agent.go:157`).
5. **Verdict** `allow|constrain|require_approval|block|halt` (priority 1..5).
   Aliases: `continue→allow`, `stop→halt`,
   `require-approval|request_approval→require_approval`.
6. **Evaluate parsing is lenient** (verdict-first, unknown→`ALLOW`, preserve `raw`,
   `fallback_used=true` only on network fail-open). **Approval parsing is STRICT** —
   decision set is explicit; empty/unknown→`null` (pending), never implicit allow.
   `guardrails` ≡ `guardrailsResult` (same object). **The evaluate path must
   distinguish persistent auth/signing 4xx (esp. 401 with a signing reason) from
   network/5xx**: a 401 must NOT be silently treated as a network outage that
   fail-opens to ALLOW — emit a loud diagnostic and fail-closed (or trip a
   breaker) after N consecutive auth rejections. (See Risks: fail-open default.)
7. **Auth validate is `GET`** `/api/v1/auth/validate` (empty body → empty-body
   SHA-256 when signed). Evaluate/approval are `POST`.
8. **Hook events** wire as `ActivityStarted` with `hook_trigger:true`,
   `spans:[flat SpanData]`, `span_count == spans.length`. Non-hook lifecycle omits
   `span_count`. `ActivityCompleted` never carries hook spans.
9. **Hook spans are flat** — reject nested `otel|openbox|metadata|data`. `stage` ∈
   `started|completed`; `hook_type` non-empty. Preflight accepts only `started`;
   completion only `completed`; stageless rejected in both.
10. **Started-stage spans emit explicit `end_time:null` and `duration_ns:null`**
    (Python parity). Wire-safe: Core `end_time` is non-pointer `int64` (null→0),
    `duration_ns` is `*int64,omitempty` (verified `governance.go:272-274`; no
    `.rego` reads them). **[verified-good — do not reverse.]**
11. **Span identity:** `span_id` 16-hex, `trace_id` 32-hex, `parent_span_id`
    16-hex or null; timestamps epoch **nanoseconds**.
12. **Full SpanData common-field matrix** (drive tests from Core's Go struct
    `governance.go:266-318`, not the SDK guide): common fields incl. `request_body`,
    `response_body`, `request_headers`, `response_headers`, `semantic_type`,
    `attribute_key_identifiers` (all omitempty but governance/guardrails inspect
    them — populate for http/db families, don't silently under-report). Per-family:
    http/db/file/function. `data` stripped per the nested-key rule.
13. **Context store — use `AsyncLocalStorage.run(ctx, cb)` scoping, NOT Python's
    `bind`/`reset(token)`** (Node ALS has no restore-token API; `enterWith` doesn't
    unwind). `activityScope` = `als.run(ctx, () => { register; try{cb()} finally{
    unregister } })`. Second lookup path (`traceId → ActivityContext`) is keyed by
    the **32-hex string** (or `BigInt`), **never `parseInt(hex,16)`** (loses 128-bit
    precision → cross-activity misattribution). The trace map MUST have a bounded
    lifetime (TTL/LRU + unregister on trace/activity end) — an unbounded
    passively-registered map leaks and risks cross-tenant context bleed in a
    long-lived Node process.
14. **No bound context ⇒ hook governance skipped** (not a contract error).
15. **Instrumentation preflight requires custom wrappers — OTel cannot block ANY
    Node driver.** OTel `requestHook` fires post-queue (pg) or is absent
    (node-redis v4/v5) or swallows throws (ioredis `safeExecuteInTheMiddle(…,true)`).
    So redis blocking needs a custom `sendCommand` wrapper (like pg's
    `Client.prototype.query`), NOT an OTel hook. OTel = completed telemetry only.
16. **Privacy redaction + truncation BEFORE signing** (they change hashed bytes).
    Redact keys case-insensitive; `max_body_size` default 65536.
17. **Fail-loud on un-patchable/unpatched drivers.** If a driver client was created
    before `initOpenBoxInstrumentation()`, or the target prototype method is
    absent/moved (driver version drift), the SDK must emit a hard diagnostic (opt-in
    strict mode may throw) — never silently leave governance off. Resolve the driver
    version-support policy before Phase 5 sets DB blocking success criteria.
18. **Insecure-URL check method:** parse with `new URL()`, read `.hostname`, strip
    IPv6 brackets (`[::1]`→`::1`), exact-match `{localhost,127.0.0.1,::1}`; reject
    all other hosts for `http:`. Never substring/`startsWith`/`includes`.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Repo Scaffolding And Source Audit](./phase-01-repo-scaffolding-and-source-audit.md) | ✅ Complete |
| 2 | [Contracts Config Identity Client](./phase-02-contracts-config-identity-client.md) | ✅ Complete |
| 3 | [Event Wire Span Gate](./phase-03-event-wire-span-gate.md) | ✅ Complete |
| 4 | [Runtime Adapter Conformance](./phase-04-runtime-adapter-conformance.md) | Pending |
| 5 | [Node Instrumentation Hook Runtime](./phase-05-node-instrumentation-hook-runtime.md) (Tier A1/A2/B) | Pending |
| 6 | [Mastra Adapter Migration](./phase-06-mastra-adapter-migration.md) | Pending |
| 7 | [Release Readiness](./phase-07-release-readiness.md) | Pending |

Dependency chain: `1 → 2 → 3 → 4 → {5, 6}`. **Phase 6 hard-gates on Phase 4**
(contracts/client/signing/hook-wire proven) **+ Phase 5 Tier A1** (fetch/fs/function
— Mastra's actual blocking surface). Phase 5 **Tier A2** (`pg`/`redis`) and **Tier
B** (`mysql`/`mongodb`) run in parallel and must NOT block Phase 6.

## Verification Gates

Every phase keeps green: `npm run lint`, `typecheck`, `test`, `build`,
`pack --dry-run`. Coverage thresholds mirror Mastra (70/90/75/75). Package root
must stay import-light (no crypto/network/OTel/driver side effects on root import)
— enforced by a root import-safety test from Phase 1. **Phase 4 adds a Core-parity
gate** (Go harness or dockerized Core round-trip; Decision 1) — the fixture alone
is insufficient.

## Risks

- **Non-ASCII signing drift** (Decision 3) — the single most likely byte-drift bug;
  reproduced. Gate: ensure_ascii-equivalent escaping + non-ASCII golden cases.
- **Fixture ≠ Core parity** (Decision 1) — Python-only fixture can't prove Core
  parity; add the Go-unmarshal/round-trip gate.
- **Fail-open default = silent governance bypass.** Default `on_api_error=fail_open`
  turns any persistent 401 (signing break, clock skew, key misconfig) OR any Core
  outage into fleet-wide ALLOW with only a `fallback_used` flag. Preflight blocking
  is silently conditional on Core reachability. **Open decision:** default
  `fail_closed` for destructive hook types (db/file writes, non-idempotent HTTP)?
- **Redis/DB preflight is Node-custom-wrapper work, not OTel** (Decision 15) — more
  surface than researcher-04 implied; redis needs a `sendCommand` wrapper.
- **DB preflight has no current in-plan consumer** — Mastra blocks only
  fetch/fs/function; pg/redis/mysql/mongodb preflight is built ahead of demand
  (user-confirmed). Schedule risk; Tier A2/B decoupled from Phase 6 to contain it.
- **Context trace-map leak / cross-tenant bleed** in long-lived processes
  (Decision 13) — bounded lifetime + unregister + leak test.
- **Import-order silent-off** (Decision 17) — client created before init → patch
  too late → governance silently off. Fail-loud, don't warn-and-continue.
- **Recursion-guard bypass** — host-unanchored `startsWith` + no-active-span skip →
  SSRF/exfil evasion. Use an internal-call flag + `URL.origin` exact match.
- **Approval infinite-poll** — port `ApprovalPoller` budget
  (`maxConsecutiveFailures`/`maxWaitMs`); `CoreAdapter`-no-poller REJECTS approvals.
- **Multi-runtime interference** — process-global instrumentation + shared context
  store: a 2nd runtime's `close()`/`init` can clear/disable the 1st. Define a
  single-instance invariant or per-controller scoping.
- Mastra public API break during migration; pg double-governance (base wrapper +
  retained Mastra OTel-pg) — atomic per-driver swap + one-event-per-query test.
- Signing byte drift; trusting unverified Mastra logic (re-verify 5 surfaces).

## Open Questions

1. Default `on_api_error`: keep `fail_open` fleet-wide, or `fail_closed` for
   destructive hook types? (product/security decision)
2. Phase 4 Core-parity gate **mechanism** (fixture-only is NOT an option — the
   gate is mandatory per Decision 1): Go harness (unmarshal into `content.SpanData`
   + `ed25519.Verify`) vs dockerized Core round-trip?
3. Single process-wide instrumentation controller (throw on 2nd init) vs
   per-controller-scoped patches/store?
4. DB driver version-support policy (e.g. `pg` 14+, `mysql2`, `mongodb`, redis
   client) for prototype patching. (blocks Phase 5 DB success criteria)
5. Instrumentation: auto-detect installed drivers vs explicit driver list?
6. Default redaction policy for `db_statement`/bodies — redact-by-default vs opt-in?
7. Mastra migration: update fixtures in place vs side-by-side legacy/base parity
   suite for one release?
8. Is there a known near-term consumer that needs blocking DB governance? (would
   retire the "no consumer" risk on Phase 5 DB targets)

## Definition Of Done

- `openbox-sdk-ts` is a standalone `@openbox-ai/openbox-sdk` implementing the
  contracts above, with (a) Python-parity golden fixtures AND (b) a Core-parity
  gate proving TS≡Core, an importable conformance kit, an import-light root, and
  clean `npm pack`.
- `openbox-mastra-sdk` depends on the base SDK for shared behavior, reduced to
  adapter/lifecycle mapping, with stable-or-documented public APIs and passing
  workflow/tool/agent/approval/A2A tests. No local base-SDK path refs in release
  artifacts.

## Red Team Review

### Session — 2026-07-08
**Findings:** 20 (18 accepted, 2 scope-challenges surfaced to user)
**Severity breakdown:** 4 Critical, 8 High, 6 Medium, 2 scope (user decision)
**Reviewers:** Security Adversary (Fact Checker), Failure Mode Analyst (Flow
Tracer), Assumption Destroyer (Scope Auditor), Scope & Complexity Critic (Contract
Verifier). Full reports in `reports/from-code-reviewer-to-planner-red-team-*.md`.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Non-ASCII `JSON.stringify` ≠ Python `ensure_ascii` → signing break → silent bypass | Critical | Accept | D3, Phase 2 |
| 2 | Golden fixture proves TS==Python not TS==Core; backend_compat Go test dropped | Critical | Accept | D1, Phase 4 |
| 3 | Redis preflight infeasible via Node OTel hooks | Critical | Accept | D15, Phase 5 |
| 4 | Fail-open default conflates auth-4xx with outage → silent governance bypass | Critical | Accept (fix) + surface default | D6, Risks, OQ1 |
| 5 | trace-map `parseInt(hex,16)` 128-bit precision loss | High | Accept | D13, Phase 4 |
| 6 | AsyncLocalStorage can't do `bind/reset(token)`; use `als.run` | High | Accept | D13, Phase 4 |
| 7 | Ed25519 raw-seed load needs exact PKCS8 DER recipe | High | Accept | D4, Phase 2 |
| 8 | Recursion guard host-unanchored + no-active-span → bypass/exfil | High | Accept | Phase 5 |
| 9 | `ApprovalPoller` unscoped; CoreAdapter-no-poller rejects; no poll budget | High | Accept | Layout, Phase 2/4 |
| 10 | trace→context map global, no unregister → leak + cross-tenant bleed | High | Accept | D13, Phase 4 |
| 11 | Phase 6 double-governs pg (base wrapper + Mastra OTel-pg) | High | Accept | Phase 6 |
| 12 | Phase 5/6 effort estimates optimistic | High | Accept | Phase 5 split, efforts |
| 13 | Insecure-URL method + `[::1]` brackets unspecified | Medium | Accept | D18, Phase 2 |
| 14 | Nonce entropy + ±5min skew unaddressed | Medium | Accept | D4, Phase 2 |
| 15 | DB blocking gated on unresolved driver-prototype OQ | Medium | Accept | D17, Phase 5, OQ4 |
| 16 | SpanData common matrix omits body/headers/semantic_type; wrong citation | Medium | Accept | D12, Phase 3 |
| 17 | Phase 6 drops public `workflow-span-buffer` export | Medium | Accept | Phase 6 |
| 18 | Public 16-subpath export surface over-committed; "mirrors Python" imprecise | Medium | Accept | Layout |
| S1 | DB preflight not on critical path (Mastra blocks none) | Critical* | Surfaced → user kept all 7 | Risks (documented) |
| S2 | mysql/mongodb pulled from researcher-04 deferred tier | High* | Surfaced → user kept; Tier B decoupled | Phase 5 |

\* Scope findings challenged a user-confirmed decision; surfaced per policy, not
auto-applied. User elected to keep all 7 instrumentation targets; risk documented
and Tier A2/B decoupled from Phase 6.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01..07 (all edited/reconciled).
- Decision deltas checked: 12 (no-trailing-newline; fixture=Python-anchor +
  Core-parity gate; non-ASCII escaping; `als.run` not `bind/reset`; trace key
  32-hex not `parseInt`; `approvals` module added; exports consumer-driven not
  16-subpath; redis custom-wrapper not OTel; Phase 6 dep `[4]` not `[5]`; SpanData
  full matrix; fail-open distinguishes auth-4xx; fail-loud driver patching).
- Reconciled stale references: 6 (phase-01 ledger trailing-newline entry; phase-01
  `src/` folder list +`approvals`/`serialization`; phase-01 exports map →
  consumer-driven; phase-01 "mirrors Python" wording; phase-01 ledger criterion;
  phase-06 `dependencies: [4]`). Verified by grep: `parseInt`/`bind-reset`/
  `trailing-newline`/`redis-OTel-blocking`/`16-subpath` survive only as negations
  or in this findings table.
- Unresolved contradictions: 0.
- **Remaining user decisions (not contradictions):** Open Questions 1 (fail-open
  default) and 8 (DB-preflight consumer) — product decisions, not plan defects.

### Post-Review Reconciliation — 2026-07-08 (user consistency findings)
3 defects fixed: (P1) Phase 5 tier model was contradictory across plan.md /
phase-05 / phase-06 — resolved by a 3-tier split **A1** (fetch/fs/function, the
only Phase 6 gate) / **A2** (pg/redis) / **B** (mysql/mongodb); Phase 6 depends on
Tier A1 only; A2+B decoupled. (P2) Stale dev-agent path
`openbox-sdk/plans/260707…` (in the source proposal, not this plan) repointed to
this plan. (P3) Open Question 2 reworded — Core-parity gate is mandatory
(Decision 1); fixture-only removed as an option, now Go-harness vs dockerized-Core.
Re-grep: 0 remaining bare "Tier A" / "fixture-only" / stale-path references.
