---
type: decision
date: 2026-07-10
tags: [instrumentation, http, blocking, node-http]
status: active
---

# node:http / node:https governance blocks via a deferred stand-in ClientRequest

`initOpenBoxInstrumentation` patches `http.request`/`http.get`/`https.request`/
`https.get` (targets `"http"`/`"https"`, under the existing
`instrumentation.httpEnabled` toggle — no new config field) with **full
preflight-blocking parity with fetch**: a BLOCK/HALT verdict stops the request
before any byte reaches the socket.

## Why this exists (the gap)

Node's `fetch` is undici and does **not** traverse `node:http`. So every HTTP
client library built on `node:http`/`node:https` — axios, got, node-fetch@2,
superagent, aws-sdk v2 — completely bypassed the `fetch` patch. HTTP egress is
the primary exfiltration threat, so this was the biggest blind spot in Tier A1.

## Why a deferred stand-in (not "patch and await in place", not a custom Agent)

`http.request()` must return a `ClientRequest` **synchronously**, so the wrapper
cannot `await runtime.preflight(...)` before returning. The wrapper
(`node-http-deferred-client-request.ts`) returns a `PassThrough`-free
EventEmitter stand-in that buffers header mutations + the written body, runs
preflight on `.end()`, and **only creates the real request on ALLOW** — replaying
the buffered body to it. On BLOCK it never creates the real request, so no socket
is opened.

Rejected alternative — a custom `Agent.createConnection` hook that awaits
preflight before returning a socket:
- **Keep-alive socket reuse defeats it**: a reused free socket skips
  `createConnection` entirely, so a blocked request would slip straight through.
  This is a *correctness hole on the block path*, not a nicety.
- It would **clobber a caller's own agent/proxy** (e.g. `https-proxy-agent`),
  changing pooling/TLS/proxy behavior.

Contrast with [[decision-sync-fs-telemetry-only]]: sync `fs` runs **in-thread**,
so there is no async gap to defer into — it can only be telemetry-blocked.
`http.request` dispatch **is** deferrable (it happens after `.end()` and after the
socket connects), which is exactly what makes blocking possible here.

## Non-obvious implementation points

- **`get` is patched separately from `request`.** `http.get`/`https.get` call a
  module-*local* `request`, so reassigning `http.request` alone does not cover
  `get`. Both are patched (get = request + `.end()`).
- **Detached completed hook needs context re-binding.** The completed hook fires
  from socket events; with keep-alive **socket reuse** those events run in a
  different async context, so ALS does not carry the caller's `activityScope`.
  The bound context is captured at commit and re-bound via
  `contextStore.activityScope(...)` around `runtime.completed(...)` (which reads
  the ALS store synchronously at invocation). Its promise is tracked in
  `PendingTelemetry` and drained by `controller.flush()` — same drain-on-close
  contract as sync-fs.
- **Buffered-body trade-off.** The outbound body is buffered in memory until the
  verdict resolves (backpressure/`'drain'` timing differs). Fine for small
  governed agent bodies; documented in `instrumentation-coverage.md`.
- **Response teeing without stealing data.** The stand-in emits `'response'` to
  the caller FIRST, then the telemetry tap adds its own `res.on('data')` — so the
  caller attaches its consumers before the tap, and observation never causes the
  caller to miss bytes (the node:http analogue of fetch's `response.clone()`).
- **XHR dropped.** Node ≥24.10 has no `XMLHttpRequest`; no Python source-of-truth
  precedent. Scope is `node:http` + `node:https` only.
- **Pass-through gaps** (documented, not silent): `CONNECT` tunnels,
  `upgrade`/websocket handshakes, `node:http2`, direct `net.Socket` writes.

Shared HTTP helpers (id/time/content-type/header flattening) now live in
`http-governance-shared.ts`, consumed by both the fetch and node:http patches.
