# Instrumentation Coverage & Limitations

What `initOpenBoxInstrumentation()` actually **preflight-blocks** per target, and
where a governed operation can still get through. Preflight blocking uses custom
wrappers, never OpenTelemetry (OTel cannot block a Node driver — it fires
post-dispatch or swallows throws). Blocking is opt-in and installs **only** on an
explicit `initOpenBoxInstrumentation({ runtime, databases: [...] })` call — never
on import.

> **Security note:** treat this table as the source of truth for what a BLOCK
> verdict actually stops. Any call form marked "pass-through" is telemetry-blind
> AND unblockable — do not rely on governance for it.

## Tier A1 (always available)

| Target | Governed (BLOCK stops it) | Pass-through (NOT blocked) |
|---|---|---|
| **fetch** | global `fetch(...)` | requests to the configured Core origin + SDK-internal calls (recursion guard, by design) |
| **fs.promises** | `readFile` / `writeFile` | `createReadStream`/`createWriteStream` + sync `fs.*` (streaming/sync are telemetry-only) |
| **functions** | anything wrapped in `traced(fn)` | un-wrapped functions |

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
