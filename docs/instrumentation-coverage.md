# Instrumentation Coverage & Limitations

What `initOpenBoxInstrumentation()` actually **preflight-blocks** per target, and
where a governed operation can still get through. Preflight blocking uses custom
wrappers, never OpenTelemetry (OTel cannot block a Node driver — it fires
post-dispatch or swallows throws). Blocking is opt-in and installs **only** on an
explicit `initOpenBoxInstrumentation({ runtime, databases: [...] })` call — never
on import.

> **Security note:** treat this table as the source of truth for what a BLOCK
> verdict actually stops. Any call form marked "pass-through" is unblockable — do
> not rely on governance to stop it. Most pass-through forms are also
> telemetry-blind; the one exception is sync `fs` (`readFileSync`/`writeFileSync`/
> `mkdirSync`), which is telemetry-**visible** (emits a completed hook) yet still
> unblockable — see the fs (sync) note below.

## Tier A1 (always available)

| Target | Governed (BLOCK stops it) | Pass-through (NOT blocked) |
|---|---|---|
| **fetch** | global `fetch(...)` | requests to the configured Core origin + SDK-internal calls (recursion guard, by design) |
| **node:http / node:https** | `http.request`/`http.get`/`https.request`/`https.get` (deferred-dispatch preflight — the request is never sent on BLOCK) | requests to the Core origin + SDK-internal calls (recursion guard); `CONNECT` tunnels and `upgrade`/websocket handshakes; `node:http2`; direct `net.Socket` writes |
| **fs.promises** | `readFile` / `writeFile` (preflight-blockable) | `createReadStream`/`createWriteStream` (streaming is telemetry-only) |
| **fs (sync)** | — telemetry-only, never preflight-blocks (see note below) | `readFileSync`/`writeFileSync`/`mkdirSync` always run before the hook; `appendFileSync`/`openSync`/`rmSync`/`unlinkSync`/fds/streams/watchers uninstrumented |
| **functions** | anything wrapped in `traced(fn)` | un-wrapped functions |

`fetch`, `node:http`, and `node:https` all share the one
`instrumentation.httpEnabled` master toggle (the same way `fileEnabled` governs
both fs targets). Node's `fetch` is undici and does **not** traverse
`node:http`, so libraries built directly on `node:http`/`node:https` — axios,
got, node-fetch@2, superagent, aws-sdk v2 — need the separate node:http/https
patch; the fetch patch alone does not cover them.

### node:http / node:https: deferred-dispatch preflight blocking

`http.request()` must return a `ClientRequest` **synchronously**, so the wrapper
cannot `await runtime.preflight(...)` in place. Instead it returns a stand-in
that buffers the request, runs preflight on `.end()`, and only creates the real
request on ALLOW — so a BLOCK verdict guarantees **no byte reaches the network**
(unlike sync `fs`, which runs in-thread and can only be telemetry-blocked). This
is also why a custom-`Agent` `createConnection` hook is NOT used: it would miss
keep-alive **socket reuse** (a reused socket skips `createConnection`, so a
blocked request would slip through) and would clobber a caller's own agent/proxy.

- **Buffered body trade-off:** the outbound request body is buffered in memory
  until the verdict resolves, so backpressure/`'drain'` timing differs from an
  unwrapped request. Fine for typical governed agent traffic (small bodies).
- **Body capture:** request + response **text** bodies are captured best-effort
  and capped at `privacy.maxBodySize`; binary content types are skipped. node:http
  has no `response.clone()`, so the response body is only captured when the caller
  consumes it in **flowing** mode synchronously (`res.on('data')`/`res.pipe(...)`
  in the response handler — the common case). A caller that defers reading, or
  reads in paused mode (`res.read()`), is left alone (no capture) rather than
  risk stealing its bytes — the caller's data is never corrupted.
- **Detached completed hook:** the completed hook fires after the response ends
  (a socket-event context that, with keep-alive reuse, is not the caller's
  `activityScope`), so the bound context is captured at request time and re-bound
  for the completed evaluation, and its promise is drained by `flush()` — `await`
  the controller's `flush()` before shutdown so the last event is not dropped.

### fs (sync): completed-hook telemetry only, never preflight-blocked

`readFileSync`, `writeFileSync`, and `mkdirSync` are instrumented under the same
`instrumentation.fileEnabled` master toggle as `fs.promises`, but they are
**telemetry-only**. A synchronous Node API cannot `await` the async runtime
before touching the file system, so the wrapper runs the real op FIRST, then
fires a **completed** hook for correlated audit telemetry and post-operation
governance signals — it never sends a started/preflight hook and cannot stop the
op. A BLOCK/HALT on the completed hook marks the activity stopped for FUTURE work
but cannot undo an fs op that already ran; `onApiError: "fail_closed"` cannot make
sync fs preflight-block either. `mkdirSync` is recorded as a destructive
`file.write` (`file_operation: "write"`, `file_mode: "w"`) — there is no
`file.mkdir` semantic. Use `fs.promises.readFile`/`writeFile` when you need
pre-operation blocking. Because the sync wrapper returns before its telemetry
settles, `await` the controller's `flush()` (or a middleware `close()` that calls
it) so the last fs event is not dropped. `instrumentation.fileEnabled: false`
disables BOTH the async and sync file hooks.

## Tier A2/B (opt-in via `databases`)

| Driver | Governed | Pass-through (NOT blocked) |
|---|---|---|
| **pg** (`>=8`) | `client.query(text\|{text,values})` (promise form) | callback form `query(text, cb)`; `Submittable` cursors (`pg-cursor`/`pg-query-stream`) |
| **redis** (node-redis v4/v5) | **`client.sendCommand([...])` ONLY** | **typed commands `.get()`/`.set()`/… — see limitation below**; `SUBSCRIBE`/`XREAD`/streaming |
| **mysql2** (`>=3`) | `Connection.prototype.query` / `.execute` (promise form) | callback form; streaming |
| **mongodb** (`>=6`) | `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOne`, `replaceOne`, `bulkWrite`, `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace` | `find()`/`aggregate()` cursors; `watch()` change streams |

### ⚠ redis: typed commands are NOT blocked

The redis wrapper patches `RedisClient.prototype.sendCommand`, but node-redis
binds its typed command methods (`.get()`, `.set()`, `.hSet()`, …) to an internal
executor **at module load**, bypassing the public `sendCommand`. So a BLOCK
verdict only stops explicit `client.sendCommand([...])` calls — **normal typed
usage is not preflight-blocked** (it is not intercepted at all). The install
emits a one-time warning to this effect. Per-command prototype wrapping was
deliberately not implemented (fragile, version-coupled, misses `.json`/`.ft`/`.ts`
module namespaces); revisit if a consumer needs full redis blocking.

## Privacy / redaction (applied before signing)

- **HTTP headers:** credential headers (`authorization`, `cookie`, `x-api-key`, …)
  redacted unconditionally.
- **SQL (pg/mysql2):** only the parameterized statement text is sent as
  `db_statement`; bound parameter values are never serialized.
- **redis:** the command verb + first arg (the KEY) are kept; argument VALUES are
  redacted. Note redis keys can embed identifiers/PII — treat `db_statement` for
  redis accordingly.
- **mongodb:** only `collection.<operation>` is recorded — no filters/documents.
- **function `traced()`:** `args`/`result` are captured verbatim (opt-out
  `captureArgs`/`captureResult: false`). Bodies truncated to `maxBodySize`.

## Optional peer drivers

`pg`, `redis`, `mysql2`, `mongodb` are **optional** — the SDK never declares them
as dependencies and lazy-`require`s only the drivers you name in `databases`.
Install the ones you use in your own app; the base SDK stays dependency-light and
its package root never loads a driver.
