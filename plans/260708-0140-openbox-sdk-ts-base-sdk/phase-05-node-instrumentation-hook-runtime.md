---
phase: 5
title: "Node Instrumentation Hook Runtime"
status: in_progress
priority: P2
effort: "Tier A1 2-3d; Tier A2 3-4d; Tier B 4-6d"
dependencies: [4]
---

# Phase 5: Node Instrumentation Hook Runtime

## Overview

Add generic Node operation governance reusing the Phase 3/4 hook runtime and flat
span contract. Scope (user-confirmed **broader**, all 7 targets): fetch +
functions + `fs` + `pg` + `redis` + `mysql` + `mongodb`. **Preflight blocking is
delivered via custom wrappers, never OTel** (OTel cannot block any Node driver).

**Documented scope risk:** the only in-plan consumer (Mastra) preflight-blocks
*only* fetch/fs/function; DB preflight (pg/redis/mysql/mongodb) has no current
consumer (Mastra uses OTel DB telemetry). Kept at user direction; Tiers A2/B are
decoupled from Phase 6 so they cannot delay the migration.

## Status

**Tier A1 COMPLETE** (fetch + fs.promises + function wrapper, recursion guard,
fail-loud init/shutdown controller, http/file/function span builders). Code
review DONE (no Critical/High/Medium; both bypass-class risks closed + op-did-not-
run tests). Recursion guard: internal-call flag (ALS `runAsInternal`, wired
through `OpenBoxClient`'s own fetch calls) + `URL.origin` exact-equality — no
`startsWith`, no no-active-span-skip. Redaction default resolved (see ledger).
**Unblocks Phase 6** (with Phase 4). **Tier A2 (pg/redis) + Tier B
(mysql/mongodb) remain pending** (decoupled — do not block Phase 6).
Low follow-ups: span-less diagnostic counter under-counts a bound-but-incomplete
context (observability only); resolve OQ4 (driver version policy) + OQ5
(auto-detect vs explicit) before A2/B DB blocking.

## Tier split (Phase 6 depends on Tier A1 only)

- **Tier A1 — Mastra parity, the ONLY Phase 6 gate** — fetch, functions,
  `fs.promises`. Custom global/prototype wrappers; these are the only targets the
  in-plan consumer (Mastra) actually preflight-blocks.
- **Tier A2 — common DB, decoupled** — `pg` (`Client.prototype.query`) + `redis`
  (custom `sendCommand`/prototype wrapper — NOT OTel). No current consumer blocks
  these; **must not block Phase 6.**
- **Tier B — harder DB, decoupled** — `mysql`/`mysql2` (`Connection.prototype.query`),
  `mongodb` (Collection CRUD wrapper; Node has no `wrapt`, hand-roll). Runs in
  parallel; **must not block Phase 6.**
- **Out of preflight scope (telemetry-only):** streaming — `fs.createReadStream`,
  `redis SUBSCRIBE`/`XREAD`, `pg` cursors, `mongodb` change streams.

## Requirements

- Functional: started-hook BLOCK/HALT prevents the real operation for every
  claimed blocking target (proven by "op did not run" tests); completed-hook is
  telemetry only; SDK's own API calls are not self-governed; hook spans stay flat.
- Non-functional: root install-free; `init` idempotent + concurrency-safe;
  **fail-loud** (not silent) when a driver can't be patched.

## Architecture

Grounded in [instrumentation report](./research/researcher-04-node-instrumentation-preflight-report.md)
(with its redis-via-OTel claim corrected) + red-team findings. See plan.md
Decisions 13, 15, 16, 17.

**OTel cannot block (D15).** OTel `requestHook` fires post-queue (pg) or is absent
(node-redis v4/v5 has no `requestHook`) or swallows throws (ioredis
`safeExecuteInTheMiddle(fn,onErr,true)`). **redis therefore needs a custom
`sendCommand`/prototype wrapper, exactly like pg — not an OTel hook.** OTel is only
for completed telemetry (optional `otel/` module, no current consumer).

**Preflight pattern (all targets):** wrap the real entry point, resolve
`ActivityContext` (async-local or trace map), build the family span,
`await runtime.preflight()` BEFORE calling the original, `runtime.completed()` in
`finally`. Adapter routes BLOCK/HALT.

**Recursion guard (D-Risks — harden Mastra's).** Primary = an explicit internal-call
flag (AsyncLocalStorage boolean set around the SDK's own client calls). URL filter,
if kept, uses `new URL(url).origin` **exact equality** with the api_url origin —
never raw `startsWith` (host-unanchored → `api.openbox.ai.evil.com` bypass) and
never "no active span ⇒ skip" (too broad → background-fetch exfil). Emit a
diagnostic/counter for span-less governed URLs.

**Fail-loud patching (D17).** Pin supported driver major versions (resolve plan OQ4)
and, at `init`, assert each target prototype method exists and is the SDK's wrapper.
If a driver client was created before `init`, or the method is absent/moved, emit a
hard diagnostic (opt-in strict mode throws). Never silently leave governance off.

**Idempotency / multi-runtime.** Module-level restore closures; `init` guarded by a
flag/lock (no bare teardown-then-reinstall race that leaves an ungoverned window);
honor the Phase 4 single-instance invariant.

## Related Code Files

Create (kebab-case; no phase refs in names):
- `src/instrumentation/index.ts` — `initOpenBoxInstrumentation(options)` →
  controller with idempotent, concurrency-safe `shutdown()`; teardown registry;
  fail-loud prototype assertions.
- `src/instrumentation/function-wrapper-traced.ts` — `traced<T>()`.
- `src/instrumentation/fetch-http-governance-patch.ts` — global fetch + hardened guard.
- `src/instrumentation/file-io-promises-wrapper.ts` — `fs.promises` read/write.
- `src/instrumentation/postgres-client-query-wrapper.ts` — `pg` query wrapper (Tier A2).
- `src/instrumentation/redis-command-wrapper.ts` — custom `sendCommand`/prototype
  wrapper (Tier A2; NOT OTel).
- `src/instrumentation/mysql-client-query-wrapper.ts` — `mysql2` (Tier B).
- `src/instrumentation/mongodb-collection-crud-wrapper.ts` — Collection CRUD (Tier B).
- `src/instrumentation/recursion-guard.ts` — internal-call flag + origin-equality.
- `src/spans/{http,db,file,function}-span-builder.ts` — populate family + body/header
  fields from the Phase 3 matrix.
- `src/otel/index.ts` — optional `OpenBoxSpanProcessor` (completed telemetry only;
  no current consumer; not on the blocking path).

Reference (read-only): `openbox-sdk-python/openbox_core/instrumentation/*`
(before-execute listeners); `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts`
(fetch/fs custom patches — and its DB-telemetry-only pattern); the actual
`@opentelemetry/instrumentation-redis`/`-ioredis` sources (confirm no blocking hook).

## Implementation Steps

1. `recursion-guard` (internal-call flag + origin equality) + `init` skeleton
   (idempotent, concurrency-safe, fail-loud prototype assertions, lazy require).
2. Tier A1 (Phase 6 gate): `traced` → fetch → `fs.promises`. Then Tier A2: `pg`
   (`Client.prototype.query`) → `redis` (custom `sendCommand` wrapper — NOT OTel).
   For each: build family span, `preflight` before original, `completed` in finally.
3. Family span builders (http/db/file/function) incl. body/header/semantic fields.
4. Privacy: redact known fields (auth headers, `db_statement`, bodies) + truncate
   before send. (Resolve plan OQ6 redact-default.)
5. Tier B: `mysql2`, `mongodb` (hand-rolled CRUD wrap).
6. Streaming: telemetry-only paths where cheap; document the limitation.
7. Optional `OpenBoxSpanProcessor` for OTel completed telemetry.
8. Tests: "op did not run on BLOCK" per blocking target; recursion-guard bypass
   attempts; driver-created-before-init fail-loud; idempotent init/shutdown.

## Success Criteria

- [ ] Started-hook BLOCK/HALT demonstrably prevents the real operation for each
      blocking target (test asserts the op did NOT dispatch — not just that a hook
      fired). **redis proven via the custom wrapper, not an OTel hook.**
- [ ] Completed-hook BLOCK/HALT recorded; does not claim to undo work; not
      fire-and-forget where it sets abort/halt flags.
- [ ] SDK's own evaluate/approval requests not self-governed; recursion guard
      resists `{api_url}.evil.com` / `{api_url}@evil.com` / span-less exfil.
- [ ] Driver created before `init`, or missing/moved prototype method ⇒ hard
      diagnostic (strict mode throws) — never silent.
- [ ] `init`/`shutdown` idempotent + concurrency-safe (no ungoverned re-init window).
- [ ] Hook spans flat; families populate correct wire keys.
- [ ] Root install-free (root import-safety test green).
- [ ] Tier A2 (`pg`/`redis`) and Tier B (`mysql`/`mongodb`) delivered OR documented
      temporary with follow-up; **neither gates Phase 6.**

## Risk Assessment

- redis/DB "OTel can block" is false in Node → custom wrappers only (D15).
- Import-order silent-off → fail-loud (D17).
- Streaming not blockable → telemetry-only, documented.
- DB preflight has no current consumer → schedule risk; Tiers A2/B decoupled.
- Effort: split Tier A1/A2/B; DB blocking exceeds Mastra's current coverage —
  budget accordingly (Python instrumentation ≈ 2,024 LOC leveraging OTel; here
  DB blocking is hand-rolled).

## Explicit Non-Goals

- No OTel-as-preflight; no wholesale copy of Mastra's OTel processor; `llm_call`
  hook type stays reserved/disabled; streaming stays telemetry-only.
