# Plan: node:http / node:https preflight-blocking governance instrumentation

Add governed instrumentation for `node:http` and `node:https` (`request()` /
`get()`), *beside* the existing `fetch` patch, with **full preflight-blocking
parity** — a BLOCK/HALT verdict stops the request before any byte leaves the
socket, exactly like fetch. Closes the gap where axios / got / node-fetch@2 /
superagent (which use `node:http`/`https`, not undici `fetch`) bypass governance.

## Locked decisions (user, 2026-07-10)

1. **Enforcement:** full preflight-blocking (parity with fetch), via a deferred
   stand-in `ClientRequest` that withholds real dispatch until
   `await runtime.preflight()` resolves.
2. **XHR:** OUT of scope. Node has no native `XMLHttpRequest`; no Python
   precedent. Only `node:http` + `node:https`.
3. **Body capture:** request **and** response text bodies (best-effort, size-capped,
   never consume the caller's stream) — parity with fetch.
4. **Config:** reuse the existing `instrumentation.httpEnabled` toggle for all HTTP
   targets. No new public `InstrumentationConfig` field. New targets surface in
   `installedTargets` as `"http"` and `"https"`.

## Status

| Phase | Title | Status |
|---|---|---|
| 01 | Shared HTTP helper extraction + fetch DRY (no behavior change) | done |
| 02 | Deferred-blocking `node:http`/`https` wrapper + wrapper tests | done |
| 03 | Registration, flush + spanless-count aggregation, index tests | done |
| 04 | Docs (coverage / README / CHANGELOG) + decision note | done |

Dependencies: 01 → 02 → 03 → 04 (strictly sequential; 02 is the high-risk core).

## Review outcome (code-reviewer, 2026-07-10)

Adversarial review confirmed the **blocking guarantee holds** on every
BLOCK/HALT/abort/keep-alive/get path (real request never created). Findings, all
**fixed + regression-tested**:
- **C1 (critical):** a synchronous throw from `originalRequest` on the ALLOW path
  (invalid header/URL) escaped the try/catch in a `void`-ed async fn → unhandled
  rejection (process crash) + hung caller. Now guarded → surfaced as the
  stand-in's `'error'`; plus a `.catch()` backstop.
- **M1:** the response tap forced flowing mode → a deferred/paused reader lost
  bytes. Now tees only when the caller already has a flowing consumer; skipped for
  spanless. Caller data is never corrupted.
- **M2:** abort/destroy before dispatch emitted no terminal event → caller
  awaiting `'close'` hung. Now emits guarded terminal `'error'`/`'abort'`/`'close'`.
- **M3:** IPv6 host in options form mis-parsed the span URL (fail-safe). Bracketed.
- **L4:** request body decoded-then-sliced. Now sliced first.

Report: `plans/reports/from-code-reviewer-to-controller-node-http-https-blocking-review-report.md`
Final: 566 tests pass, lint/typecheck/build/import-light clean.

## Acceptance criteria

1. `initOpenBoxInstrumentation({ runtime })` with `httpEnabled: true` lists
   `"http"` and `"https"` in `installedTargets` (alongside `"fetch"`); `false`
   installs none of the three. No new config field.
2. Governed `http.request` / `http.get` / `https.request` / `https.get` inside an
   `activityScope`:
   - **BLOCK** → returned request emits `GovernanceBlockedError` on `'error'`; the
     origin server **never receives the request** (fake-server hit count stays 0).
   - **HALT** → same, `GovernanceHaltError`.
   - **ALLOW** → request proceeds; a **started** `http_request` span is sent at
     preflight and a **completed** span (status, request+response bodies, duration)
     after the response ends.
3. Request + response text bodies captured without breaking the caller's
   `res.on('data')`/`.pipe()` consumption; credential headers redacted via the
   existing `redactHttpHeaders`.
4. Recursion / self-governance: `isInternalCall()` and `isSameOrigin(url, apiUrl)`
   requests bypass governance (parity with fetch).
5. No bound `ActivityContext` ⇒ warn + count (aggregated into
   `getSpanlessGovernedHttpRequestCount()`), request proceeds unblocked
   (Decision 14 parity).
6. `controller.flush()` drains node:http detached completed-telemetry too;
   `shutdown()` restores all four functions; idempotent; strict-mode +
   atomic-partial-rollback honored.
7. No regressions: existing fetch + fs + db tests pass; `lint` + `typecheck` +
   `build` + `import:check` clean (module never re-exported from the root).

## Scope boundary (OUT)

- `XMLHttpRequest` / xhr (dropped per decision 2).
- `node:http2` (HTTP/2), `CONNECT` tunnels, `upgrade` (websocket) handshakes —
  documented as pass-through gaps in `instrumentation-coverage.md`.
- Any change to fetch's *behavior* (Phase 01 only de-duplicates helpers).
- OTel-based interception (SDK blocks via custom wrappers by Decision 15).

## Non-negotiable constraints

ESM, Node ≥24.10, kebab-case filenames, modules split near ~200 LoC, vitest, **no
new dependencies**, reuse `http-span-builder` + `redactHttpHeaders` + recursion
guard + `PendingTelemetry`, preserve all public contracts, keep the package root
import-light.

## Phase files

- [phase-01-shared-helper-extraction.md](phase-01-shared-helper-extraction.md)
- [phase-02-node-http-deferred-blocking-wrapper.md](phase-02-node-http-deferred-blocking-wrapper.md)
- [phase-03-registration-flush-spanless-aggregation.md](phase-03-registration-flush-spanless-aggregation.md)
- [phase-04-docs-and-decision-note.md](phase-04-docs-and-decision-note.md)
