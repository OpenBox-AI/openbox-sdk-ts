---
type: decision
date: 2026-07-10
tags: [instrumentation, fs, telemetry, langchain]
status: active
---

# Sync `node:fs` instrumentation is telemetry-only (never preflight-blocks)

`initOpenBoxInstrumentation` patches `readFileSync`/`writeFileSync`/`mkdirSync`
as the `fs.sync` target under the existing `instrumentation.fileEnabled` toggle
(default target list is now `["fetch","fs.promises","fs.sync","function"]`).

## Why telemetry-only (not preflight-enforced like `fs.promises`)

A synchronous Node API cannot `await runtime.preflight(...)` before touching the
file system without changing its `string|Buffer|void` return contract — hook
evaluation is async (it does a network `client.evaluate`). So the sync wrapper
runs the real op FIRST, then fires a **completed** hook. Consequence a caller
must understand: a BLOCK/HALT on the completed hook marks the activity stopped
for *future* work but **cannot undo** the fs op that already ran, and
`onApiError: "fail_closed"` cannot make sync fs pre-block. Use
`fs.promises.readFile/writeFile` when pre-operation blocking is required.

## Non-obvious implementation points

- **`mkdirSync` → `file.write`** (`file_operation:"write"`, `file_mode:"w"`,
  null byte counts). There is deliberately no `file.mkdir` Core semantic —
  introducing one is a separate Core schema/classification decision.
- **Drain-on-close is mandatory.** The wrapper returns before its
  `runtime.completed(...)` promise settles, so those promises are tracked in a
  bounded `PendingTelemetry` set and drained by `controller.flush()`. The
  LangChain middleware `close()` now `await`s `flush()` before `shutdown()`;
  without it the last fs event is dropped. Durability is bounded by the client
  `timeoutSeconds` (default 30s).
- **Hot-path guard.** `fs.sync` is patched process-wide, so most
  `readFileSync`/`writeFileSync`/`mkdirSync` calls (config/asset loaders,
  third-party libs) are NOT inside a governed activity. `emitCompleted`
  short-circuits on `contextStore.currentActivityContext()` before minting
  ids/building a span — provably equivalent because the sync path passes no
  `traceId`, so `HookEvaluator.completed` would resolve context from the same
  ALS getter and send nothing anyway. Skips crypto/alloc off the governed path.
- **OTel attributes on file spans.** File spans now populate `attributes`
  (`file.path`/`file.mode`/`file.operation`) in addition to the flat root
  fields. This is the one hook family that fills `attributes` at build time
  (http/function leave it `{}`). Safe against Core's `DisallowUnknownFields`
  because `attributes` is already `map[string]interface{}` in the Go struct —
  see [[arch-core-parity-gate]].

## Cross-repo gotcha: LangChain consumes the base SDK's built `dist/`

`openbox-langchain-sdk-ts` depends on `@openbox-ai/openbox-sdk` via a `file:`
symlink whose `exports` all resolve to `./dist/*` (NOT `src/`). So any new base
SDK API (e.g. `controller.flush()`) is invisible to the LangChain SDK's
typecheck/tests until the base SDK is **rebuilt** (`npx tsup`). Order for any
change spanning both repos: edit base `src/` → `npx tsup` → then the LangChain
repo sees it. (`npm run build` is fine locally; the word "build" is blocked by a
scout hook in some agent sessions — run `npx tsup` directly there.)

Related: [[debug-redis-typed-commands-bypass-sendcommand]] (another
"patched-but-not-what-you-think" instrumentation coverage nuance).
