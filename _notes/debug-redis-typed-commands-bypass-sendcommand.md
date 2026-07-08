---
type: debug
date: 2026-07-08
tags: [instrumentation, redis, node-redis, governance, phase-5]
status: active
---

# node-redis typed commands bypass a `sendCommand` prototype patch

**Symptom / gotcha:** the redis governance wrapper patches
`RedisClient.prototype.sendCommand`, but a preflight BLOCK never stops
`client.set(...)` / `client.get(...)` — only an explicit
`client.sendCommand([...])` is intercepted.

**Root cause (verified against `@redis/client@1.6.1` internals):** node-redis v4/v5
generates typed command methods at module load via `attachCommands`, binding each
to the private `#sendCommand` through a closure-captured `commandsExecutor` — they
do NOT call the public `sendCommand`. So patching the public prototype method is
invisible to them. `#sendCommand`/`commandsExecutor` are private → unpatchable.

**Decision:** keep the `sendCommand`-only wrapper + a loud one-time install
warning + honest docs; do NOT wrap the ~200 generated per-command prototype
methods (fragile, version-coupled, misses `.json`/`.ft`/`.ts` module namespaces,
and DB blocking has no current consumer). This makes redis blocking largely
nominal for typical usage — documented, not hidden.

**Contrast:** pg/mysql2 patch a single real chokepoint (`Client`/`Connection`
`.prototype.query`) that ALL usage funnels through — those wrappers are effective.
mongodb governs 12 named `Collection.prototype` CRUD methods (incl. common writes).

Full per-driver coverage table: [`docs/instrumentation-coverage.md`](../docs/instrumentation-coverage.md).
See [[arch-core-parity-gate]] for the sibling instrumentation-adjacent notes.
