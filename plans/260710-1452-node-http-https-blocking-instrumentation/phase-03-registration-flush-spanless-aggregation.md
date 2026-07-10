# Phase 03 — Registration, flush + spanless aggregation, index tests

**Goal:** wire the two new patches into `initOpenBoxInstrumentation` under the
existing `httpEnabled` toggle, aggregate their `flush()` and spanless counts into
the controller, and honor strict/rollback/idempotency exactly like the existing
targets.

## Modify — `src/instrumentation/index.ts`

- Import `installNodeHttpGovernancePatch` + its handle type.
- Add two handles: `httpHandle`, `httpsHandle` (both
  `NodeHttpGovernancePatchHandle | null`).
- Inside the `if (instrumentation.httpEnabled)` block, **after** the fetch install,
  add two more `assertPatchable` installs:
  - `installNodeHttpGovernancePatch({ runtime, module: "http", logger })` → target
    `"http"`.
  - `installNodeHttpGovernancePatch({ runtime, module: "https", logger })` → target
    `"https"`.
  Each pushes its name to `installedTargets` on success. Keep fetch first so the
  target order is `["fetch","http","https", ...]`.
- `restoreInstalledSoFar()`: add `httpHandle?.restore(); httpsHandle?.restore();`
  (covers both the public `shutdown()` and the strict-mode partial-failure path).
- `getSpanlessGovernedHttpRequestCount()`: return
  `(fetchHandle?…) + (httpHandle?…) + (httpsHandle?…)` — the count is now the sum
  across all three HTTP surfaces. Update the doc-comment on the controller method
  to say "across fetch + node:http + node:https".
- `flush()`: `Promise.all([...])` over `fileSyncHandle?.flush()`,
  `httpHandle?.flush()`, `httpsHandle?.flush()` (each `?? Promise.resolve()`) then
  `void`-return. Update the `flush()` doc-comment: the node:http **completed** hook
  fires detached (after response end), so it is drained here alongside sync-fs.
- Update the module docstring's target-list examples to include `http`/`https`.

## Tests — extend `test/instrumentation-index.test.ts`

- `httpEnabled: true` ⇒ `installedTargets` includes `"fetch"`, `"http"`, `"https"`.
- `httpEnabled: false` ⇒ none of the three present; `logger.info` disabled message.
- `shutdown()` restores `http.request`/`https.request`/`http.get`/`https.get` to
  originals (capture refs before init, compare after shutdown).
- Strict-mode partial failure: if the https install is forced to throw, fetch+http
  are rolled back and nothing stays patched (reuse the existing strict-rollback
  test scaffold).
- `getSpanlessGovernedHttpRequestCount()` reflects a node:http spanless request
  (drive one via the loopback helper, or a focused unit assertion).
- `flush()` resolves and drains a node:http completed promise.

## Validation

- `npm run test -- instrumentation-index instrumentation-node-http` green.
- Full `npm run test` — no regression in fetch/fs/db/runtime suites.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run import:check`
  (root stays import-light; new modules are never re-exported from `src/index.ts`).

## Risks / rollback

- Low-to-moderate: additive to a well-guarded install path. The atomic-rollback and
  idempotency invariants are already established; this phase only adds two handles
  into the existing pattern. Rollback = revert the index.ts diff + its tests.
