# Phase 02 — Deferred-blocking node:http / node:https wrapper (core, high-risk)

**Goal:** patch `http.request`/`http.get`/`https.request`/`https.get` so a
governed request is withheld until `await runtime.preflight()` resolves; BLOCK/HALT
means the real request is **never created** (no bytes leave). ALLOW replays the
buffered request to a real `ClientRequest` and tees bodies for the completed span.

## Why a deferred stand-in (not "patch and await in place")

`http.request()` must return a `ClientRequest` **synchronously**; we cannot `await`
before returning. Unlike sync-fs (which runs in-thread and is therefore
telemetry-only), node:http dispatch is *deferred* — data is only written after
`.end()` and after the socket connects. So we return a stand-in that buffers, runs
preflight, and only then creates the real request. This is the one way to
*guarantee* zero bytes on BLOCK.

## Create

### `src/instrumentation/node-http-deferred-client-request.ts`
`class DeferredClientRequest extends stream.PassThrough` — the stand-in returned to
the caller. PassThrough gives `write`/`end`/`cork`/`uncork`/`drain`/`finish` +
EventEmitter for free. Responsibilities:

- **Buffer phase** (before `end()`): accumulate written chunks (for replay + body
  capture); record header mutations via `setHeader`/`removeHeader`/`getHeader`/
  `hasHeader`/`getHeaderNames`/`flushHeaders` (no-op-queue); `setTimeout`/
  `setNoDelay`/`setSocketKeepAlive` recorded and replayed post-creation.
- **Commit** (`_finalize()` invoked on `end()`): hand the buffered
  (method, url, headers, body) to the owner callback (the patch module) which runs
  preflight and, on ALLOW, calls `attachReal(realReq)`.
- **`attachReal(realReq)`**: replay buffered writes + `end()` to `realReq`; forward
  **realReq → stand-in** events: `response`, `error`, `socket`, `connect`,
  `upgrade`, `continue`, `information`, `drain`, `timeout`, `close`, `finish`;
  forward **stand-in → realReq** late method calls: `abort`/`destroy`/`setTimeout`.
- **`rejectGovernance(err)`**: on BLOCK/HALT, `this.destroy(err)` + `emit('error',
  err)` on next tick (so a synchronously-attached `'error'` listener fires); never
  create a real request. Mark a flag so a late `attachReal` is a no-op.
- **Abort during preflight**: if `abort()`/`destroy()` is called before the verdict
  resolves, set `aborted`; when preflight resolves ALLOW, skip real creation (or
  create-then-destroy) so an aborted request never dispatches.

Keep the surface to the **documented common path**. Exotic usage (reading
`req.socket` before `end()`, `CONNECT`/`upgrade` tunnels) is best-effort; document
as a coverage gap in Phase 04 rather than over-engineering.

### `src/instrumentation/node-http-governance-patch.ts`
`installNodeHttpGovernancePatch({ runtime, module: "http" | "https", logger })`:

- `createRequire(import.meta.url)` → `require("node:http" | "node:https")`; capture
  `originalRequest` + `originalGet`. Fail-loud (throw) if either isn't a function
  (caller `assertPatchable` owns the policy — mirror the sync-fs wrapper).
- Patched `request(...args)`:
  1. Normalize args → `{ method, url, headers }` (handle `(url)`, `(url, opts)`,
     `(opts)`, `(url, opts, cb)`; url as `string | URL`; default method `GET`).
  2. `isInternalCall()` → return `originalRequest(...args)` (no interception).
  3. `isSameOrigin(url, runtime.config.apiUrl)` → return `originalRequest(...args)`.
  4. Else build a `DeferredClientRequest`; on its commit callback:
     - spanless check: `contextStore.currentActivityContext() === null` →
       `spanlessCount++` + `logger.warn` (same message shape as fetch).
     - mint ids, `nowEpochNs()`, build started span via `buildStartedHttpSpan`
       (reuse `redactHttpHeaders`; body = captured buffered text, content-type
       gated, `capText`).
     - `await runtime.preflight({ spans:[started] })`:
       - throws (BLOCK/HALT) → `deferred.rejectGovernance(err)`.
       - resolves → `real = originalRequest(url, options, undefined)` (do NOT pass
         the caller's cb; the stand-in already owns the `'response'` relay);
         `deferred.attachReal(real)`; on real `'response'`, tee the response body
         (add our own `'data'`/`'end'` tap **after** relaying `'response'` to the
         stand-in's listeners, text-content gated, `capText`, never consume); on
         `'response'`-end or `'error'`, build completed span + `pending.track(
         runtime.completed(...))`.
  4b. Patched `get(...)` = patched `request(...)` then `req.end()` (matches core).
- Return handle: `restore()` (idempotent; reassign `originalRequest`/`originalGet`),
  `flush()` (delegate to the shared `PendingTelemetry`),
  `getSpanlessGovernedRequestCount()`.

> `http`/`https` are ESM-facing CJS builtins. Reassigning `httpModule.request`
> mutates the same object `import { request } from "node:http"` binds; unlike
> `node:fs`, callers usually `import http from "node:http"; http.request(...)`, so
> object-property reassignment suffices. Call `syncBuiltinESMExports()` after patch
> **and** restore (same as the fs wrappers) so named ESM imports observe the swap.
> `http.get`/`https.get` call their module-local `request`, so patch `get`
> **separately** (patching `request` alone does not cover `get`).

## Tests — `test/instrumentation-node-http-governance-patch.test.ts`

Drive a **real loopback server** (`http.createServer` on `127.0.0.1:0`) so
ClientRequest semantics are genuine; assert blocking by the server's request
counter. Reuse `FakeCore`/`FakeAdapter`/`ContextStore`/`buildRuntime` helper shape
from the fetch test. Install BEFORE creating requests; `restore()` in `afterEach`.

Matrix:
1. **BLOCK**: `http.request` to the loopback server inside `activityScope` →
   returned req emits `GovernanceBlockedError`; **server hit count === 0**.
2. **HALT**: same → `GovernanceHaltError`; hit count 0.
3. **ALLOW GET**: started span sent (assert FakeCore saw an `http_request` started
   payload), response delivered to caller intact, completed span has
   `http_status_code`, `duration_ns`, `response_body`.
4. **ALLOW POST with body**: request body captured + redacted headers; server
   receives the exact body bytes (buffering preserves payload).
5. **`http.get`**: auto-`end()` path blocks + allows correctly.
6. **response teeing**: caller's `res.on('data')` still receives the full body
   while the completed span also captures it.
7. **same-origin / internal**: request to `apiUrl` origin and inside
   `runAsInternal` bypass governance (no span, real request used).
8. **spanless**: governed request with no `activityScope` → warns, counts, still
   proceeds (server hit count 1).
9. **`https`**: repeat BLOCK + ALLOW against a TLS loopback server
   (`https.createServer` w/ a self-signed cert generated in-test, `rejectUnauthorized:false`).
10. **flush**: after an ALLOW response ends, `handle.flush()` resolves with the
    completed telemetry drained (`pending.size === 0`).
11. **restore**: after `restore()`, `http.request`/`http.get` are the originals.

## Risks / rollback

- **Highest-risk phase.** Buffering the full request body defeats streaming
  backpressure (`'drain'` timing differs) and holds the body in memory — acceptable
  for governed agent traffic (small, size-relevant bodies); documented in Phase 04.
- Event-forwarding omissions could drop an event a niche caller relies on — the
  test matrix covers the common set; gaps documented, not silently swallowed.
- If integration proves the stand-in too fragile for a real client lib in review,
  fall back is a **scoped** decision for the user (telemetry-only for node:http),
  NOT a silent downgrade — surface via HARD-GATE-NO-SIDE-EFFECTS.
