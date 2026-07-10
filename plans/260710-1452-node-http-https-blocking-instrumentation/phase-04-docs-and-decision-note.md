# Phase 04 — Docs, changelog, decision note

**Goal:** document what node:http/https governance blocks vs. passes through, and
record the design decision so it is not re-litigated.

## Modify — `docs/instrumentation-coverage.md`

Add to the Tier A1 table:

| Target | Governed (BLOCK stops it) | Pass-through (NOT blocked) |
|---|---|---|
| **node:http / node:https** | `http.request`/`http.get`/`https.request`/`https.get` (deferred-dispatch preflight — the request is never sent on BLOCK) | requests to the Core origin + SDK-internal calls (recursion guard); `CONNECT` tunnels and `upgrade`/websocket handshakes; `node:http2`; direct `net.Socket` writes |

Add a short subsection mirroring the sync-fs note style:
- **Deferred-dispatch blocking**: the wrapper returns a stand-in `ClientRequest`,
  buffers the request until `.end()`, runs preflight, and only then dispatches — so
  a BLOCK verdict guarantees no byte reaches the network. Trade-off: the outbound
  request body is **buffered in memory** (backpressure/`'drain'` timing differs
  from an unwrapped request); fine for typical governed agent traffic.
- **Body capture**: request + response **text** bodies are captured best-effort and
  size-capped; binary content types are skipped; the caller's response stream is
  teed, never consumed.
- fetch remains the recommendation for undici-based flows; node:http/https covers
  axios / got / node-fetch@2 / superagent / other `node:http`-based clients.

## Modify — `README.md`

Update the "Opt-in Node instrumentation" paragraph: `initOpenBoxInstrumentation`
now installs governance patches for `fetch`, **`node:http`/`node:https`
(preflight-blockable, same as fetch)**, `fs.promises`, sync `fs`, `traced()`
functions, and opt-in DB drivers. Note all three HTTP surfaces share the
`instrumentation.httpEnabled` toggle.

## Modify — `CHANGELOG.md`

New `### Added` entry under a new unreleased/next-version heading: governed
`node:http`/`node:https` instrumentation with full preflight-blocking parity with
fetch; closes the gap for axios/got/node-fetch@2/superagent; shares `httpEnabled`;
completed telemetry drained via `flush()`.

## Create — `_notes/decision-node-http-https-deferred-blocking.md`

Frontmatter `type: decision`, `date: 2026-07-10`, `tags:[instrumentation, http,
blocking]`, `status: active`. Capture the *why*:
- fetch (undici) ≠ node:http, so axios/got/etc. bypassed governance — the gap this
  closes.
- Why **deferred stand-in** (only way to guarantee zero bytes on BLOCK given the
  synchronous streaming API) vs. why sync-fs went telemetry-only (in-thread, no
  deferral possible) — contrast the two constraints explicitly.
- XHR dropped: no Node global, no Python precedent.
- Buffered-body / backpressure trade-off + `get` patched separately from `request`
  + detached completed hook needs `flush()`.
- Link `[[decision-sync-fs-telemetry-only]]`.
Then add the one-line entry to `_notes/INDEX.md` under Decisions.

## Validation

- Links resolve; table renders; dates correct.
- `docs.maxLoc` (800) not exceeded on `instrumentation-coverage.md`.

## Risks / rollback

- Docs-only. No runtime impact.
