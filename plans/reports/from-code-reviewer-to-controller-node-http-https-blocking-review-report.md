# Code Review — node:http / node:https preflight-blocking governance

Adversarial production-readiness review. Branch `feat/node-http-https-instrumentation`.
Status GREEN going in (562 tests, lint/type/build clean); focus is correctness/robustness/edge cases.

## Scope
- `src/instrumentation/node-http-deferred-client-request.ts` (stand-in ClientRequest)
- `src/instrumentation/node-http-governance-patch.ts` (install/commit/tee/completed)
- `src/instrumentation/node-http-request-args.ts` (arg normalization + URL reconstruction)
- `src/instrumentation/http-governance-shared.ts` (shared helpers)
- `src/instrumentation/index.ts` (registration/flush/rollback)
- fetch patch refactor + both test files
- Cross-checked: recursion-guard, hook-evaluator, context store, span builder, adapters, coverage doc, decision note.

## Overall assessment
The blocking guarantee — the load-bearing security property — is **sound**. On every BLOCK/HALT/abort path I traced, `originalRequest(...)` is never called, so no socket is opened. Context re-bind for the detached completed hook is correct, spanless never sends a completed evaluate, callback double-emit is avoided, and the fetch refactor is byte-identical (import-only). 

The one serious defect is on the **ALLOW path**, not the block path: the real-request dispatch is unguarded, so a synchronous throw from `originalRequest(...)` is swallowed by `void governCommit(...)` → unhandled rejection (process-terminating on Node's default) + the caller's request hangs forever. Confirmed empirically.

---

## CRITICAL

### C1. Unguarded dispatch: sync throw from `originalRequest` → unhandled rejection (process crash) + caller hang
`node-http-governance-patch.ts:190-249` (`governCommit`). Only the `await runtime.preflight(...)` is wrapped in try/catch (lines 209-227). The dispatch that follows is NOT:

```ts
const real = normalized.urlArg != null ? originalRequest(normalized.urlArg, mergedOptions) : originalRequest(mergedOptions);
deferred.attachReal(real, completeOnce(...));
```

`governCommit` is fired as `void governCommit(self, normalized)` (line 261). Node's `http.request(...)` throws **synchronously** for malformed input — empirically confirmed:

| Input | Sync throw |
|---|---|
| invalid header name (`{"bad key":"v"}`) | `ERR_INVALID_HTTP_TOKEN` |
| invalid header value (`"a\nb"`) | `ERR_INVALID_CHAR` |
| invalid method (`"BAD METHOD"`) | `ERR_INVALID_HTTP_TOKEN` |
| invalid URL string (`"http://[invalid"`) | `ERR_INVALID_URL` |
| bad protocol (`{protocol:"ftp:"}`) | `ERR_INVALID_PROTOCOL` |

The stand-in performs **no** validation, so `governedRequest(...)` returns successfully; the throw lands inside the async `governCommit` and rejects its promise. The `void` discards it.

Failure scenario (inputs → wrong behavior):
1. App issues a governed request whose headers/URL/method are invalid (e.g. a gateway forwarding a user-supplied header value containing `\n`, or a URL built from user input).
2. Preflight returns ALLOW (or the request is spanless — the dispatch runs in both cases).
3. `originalRequest(...)` throws synchronously → `governCommit` rejects → swallowed.
4. **Result:** (a) unhandled promise rejection — terminates the process on Node ≥15 default (`--unhandled-rejections=throw`), and this SDK's floor is Node ≥24.10; (b) the caller's stand-in emits no `'error'`/`'response'`/`'close'` — the request hangs forever. Both confirmed by a minimal reproduction of the deferred pattern.

Regression vs. unwrapped: unwrapped `http.request(badOpts)` throws **synchronously and catchably** at the call site. Under governance the same call silently crashes the process. Because the malformed component is frequently attacker-influenceable (header injection, user-controlled URLs), this is a remote-DoS vector, not merely a robustness gap.

Note: the blocking guarantee is unaffected — on BLOCK, `originalRequest` is never reached.

Fix direction: wrap the dispatch (lines 233-248) in try/catch and route failures to `deferred.rejectGovernance(err instanceof Error ? err : new Error(String(err)))`, so the stand-in surfaces an async `'error'` (the correct deferred analogue of a sync construction throw). Add a defensive `.catch()` on the `void governCommit(...)` call (line 261) as a second layer so no dispatch bug can ever escape as an unhandled rejection. Consider validating nothing extra in the stand-in — surfacing via `'error'` is sufficient and matches deferral semantics.

---

## MEDIUM

### M1. Response tee breaks asynchronous / deferred response consumption
`node-http-deferred-client-request.ts:248-251` + `node-http-governance-patch.ts:153-183`. On `'response'` the stand-in emits to the caller first, then the tap attaches its own `res.on('data')` (when content-type is text). For **synchronous** consumers (a `.on('data')`/`.pipe()` inside the `'response'` handler) this is correct and tested — all listeners attached in the same tick receive every chunk.

It breaks for consumers that read the response **later**: a caller that stashes `res` and consumes it via `for await (const chunk of res)` or attaches `.on('data')` in a subsequent tick. The tap switches the stream to flowing mode before the caller starts reading, so early chunks are consumed/dropped → the caller loses part or all of the body. The coverage-doc guarantee ("caller attaches its consumers before the tap") only holds for synchronous consumers; the async-deferred case is undocumented. Also fires for spanless requests, where the tap is attached but the captured body is discarded (wasted teeing).

Fix direction: either document async-deferred consumption as an explicit gap alongside the CONNECT/upgrade gaps, or skip the data tap when the response has no synchronously-attached data consumer, or gate the tap so it is not installed for spanless requests (`boundContext === null`).

### M2. Abort/destroy during the preflight window emits no terminal event
`node-http-deferred-client-request.ts:185-194, 276-280`. If the caller calls `abort()`/`destroy()` while preflight is in flight (`#real` still null), `#cancel()` sets the canceled flag and `this.#real?.…` is a no-op. `governCommit` then correctly skips dispatch (`isCanceledBeforeDispatch()`), so the blocking side is fine — but the stand-in emits nothing. A real `ClientRequest.destroy()`/`abort()` emits `'close'` (and `'abort'`). A caller awaiting `'close'` after destroying its own request hangs. Narrow (self-initiated abort in the brief preflight window) but a hang.

Fix direction: in `#cancel`, when no real request exists yet, schedule `emit('close')` (and `'abort'` for `abort()`) on `process.nextTick`, mirroring the `rejectGovernance` pattern.

### M3. IPv6 host in options form mis-reconstructs the URL
`node-http-request-args.ts:31-45` (`computeUrl`). For `http.request({ host: "::1", port: 8080, path: "/" })`, `host.includes(":")` is true so no bracketing/port is applied, producing `http://::1`, which `new URL()` rejects → the catch returns `http://unknown`. Consequences: the span `http_url` and `metaFromUrl` host are wrong (`unknown`), and the same-origin check runs against `http://unknown`. Security is fail-safe (mis-parse → not same-origin → governed, never wrongly bypassed; and dispatch uses the original options, not the mis-parsed URL, so the real request is unaffected) — this is a telemetry-accuracy defect, plus a redundant governance call if Core's api_url is itself an IPv6 origin reached without `runAsInternal`.

Fix direction: bracket IPv6 literals when composing `base` (`host.includes(":") && !host.startsWith("[") → `[${host}]``), and append the port for the bracketed form.

---

## LOW

- **L1. `getHeader`/`hasHeader` case-normalization is half-broken.** `node-http-deferred-client-request.ts:144-155`. Lookup lowercases the *query* key but `setHeader`/constructor store under the *original* case, so `setHeader("Content-Type",…)` then `getHeader("content-type")` returns `undefined` (real Node returns the value). Does **not** affect governance — request-body content-type gating uses `headerValueCI`, which scans case-insensitively over entries. Caller-facing fidelity only; can cause a library's `hasHeader` guard to set a duplicate header. Fix: normalize header keys to lowercase on store, matching Node.
- **L2. `write()`/`end(chunk)` after commit are silently accepted.** `node-http-deferred-client-request.ts:103-134`. `end()` processes its chunk/cb before the `#ended` guard; a post-`end()` `write()` during the preflight window is buffered and replayed. Write-after-end should error in Node. Caller-bug territory; low impact.
- **L3. Unconsumed non-text responses never fire the completed hook.** `node-http-governance-patch.ts:153-183`. When content-type is binary the tap attaches only `'end'`/`'error'`/`'aborted'`; `'end'` fires only once the body is consumed, so a caller that never reads a binary response yields no completed span. Telemetry gap; consistent with best-effort framing.
- **L4. `decodeRequestBody` stringifies the whole buffer before slicing.** `node-http-governance-patch.ts:93-98`. `body.toString("utf8").slice(0, maxBody)` materializes the full body as a string before truncation. Slice the Buffer first for large bodies. Perf only.
- **L5. Buffered request body held fully in memory** (`bufferedBody()`), so a large streaming upload through a governed request risks OOM. Documented/accepted trade-off in the decision note and coverage doc — noted for completeness, not a blocker.

---

## Blocking-guarantee verdict (explicit)
**The zero-byte-on-BLOCK guarantee holds under all abort / keep-alive / get paths I examined.** Reasoning:
- **Preflight BLOCK/HALT:** `governCommit` catches the throw and calls `rejectGovernance`; `originalRequest` (line 237-238) is below the catch's `return` and is never reached. Proven by loopback `server.hits() === 0` for BLOCK and HALT, and by the https unroutable-port test (a dispatched request would surface ECONNREFUSED, not the governance error).
- **Abort/destroy during the async preflight window:** JS is single-threaded; `abort()` sets `#canceled` synchronously, and `governCommit` re-checks `isCanceledBeforeDispatch()` after the `await` with no interleaving possible → no dispatch.
- **`http.get` auto-end:** `governedGet` routes through `governedRequest` + stand-in `.end()`; same commit path. Tested (block + hits 0).
- **Request that never calls `.end()`:** `#onCommit` never fires → preflight never runs → real request never created.
- `originalRequest` is only ever invoked after a resolved (ALLOW/skip) preflight — confirmed there is no other call site.

The detached completed hook re-binds `boundContext` via `contextStore.activityScope(...)` (line 149); `HookEvaluator.resolveBoundContext` reads the ALS store synchronously at invocation, so keep-alive socket-reuse contexts resolve correctly, and spanless (`boundContext === null`) returns before `runtime.completed` — no completed evaluate, matching Decision 14. Started/completed spans use the same builders as fetch, so Core's DisallowUnknownFields is satisfied (parity, not just the passing gate).

## Acceptance criteria
1. BLOCK/HALT never hit origin + emit governance error — **PASS**.
2. ALLOW: started + completed spans, response intact — **PASS** (caveat M1 for async-deferred consumers).
3. Response teeing preserves caller consumption — **PASS for synchronous consumers; FAILS for async-deferred** (M1).
4. Recursion `isInternalCall` + `isSameOrigin` bypass parity — **PASS**.
5. No bound context → warn + count + proceed, no evaluate — **PASS**.
6. flush drains detached completed; shutdown restores all four fns; idempotent; strict atomic rollback — **PASS** (verified by index tests).
7. No fetch regression — **PASS** (diff is import-only + one rename; function bodies identical).

## Test-coverage gaps (all currently GREEN, but these paths are untested)
- Malformed request that throws at real-request creation on ALLOW (C1) — no test.
- Async/deferred response consumption `for await (…res)` (M1) — no test.
- `abort()`/`destroy()` during the preflight window (M2) — no test.
- IPv6 host option form (M3) — no test.

## Recommended actions (priority order)
1. **C1** — wrap dispatch in try/catch → `rejectGovernance`; add `.catch()` on `void governCommit`. Add a test: bad header on ALLOW must surface `'error'` on the request and must not crash the process.
2. **M1** — document the async-deferred-consumption gap and/or skip the tap when spanless / no sync consumer.
3. **M2** — emit `'close'`/`'abort'` on pre-dispatch cancel.
4. **M3** — bracket IPv6 literals in `computeUrl`.
5. **L1** — lowercase header keys on store for `getHeader`/`hasHeader` fidelity.

## Unresolved questions
- Is a swallowed sync-construction error acceptable to convert into an async `'error'` event (C1 fix), given it changes `http.request`'s documented synchronous-throw contract? This is inherent to deferral; recommend accepting it and documenting, since the alternative (crash/hang) is strictly worse.
- Should spanless requests be teed at all (M1)? They capture a body that is never sent — skipping the tap when `boundContext === null` avoids both the waste and the async-consumption breakage for that case.

Status: DONE_WITH_CONCERNS
Summary: Blocking guarantee is sound across all block/abort/get/keep-alive paths, but the ALLOW-path dispatch is unguarded — a sync throw from `originalRequest` becomes an unhandled rejection (process crash on Node default) plus a hung caller (C1, critical); M1 async-response-tee data loss and three medium/low fidelity gaps follow.
Concerns: C1 must be fixed before landing; M1 needs at minimum a documented-gap note.
