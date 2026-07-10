# Phase 01 — Shared HTTP helper extraction + fetch DRY

**Goal:** create one home for HTTP-governance helpers so the fetch patch and the
new node:http wrapper share id/time/content-type/header logic. **No behavior
change** — fetch's observable output stays byte-identical.

## Context

- `src/instrumentation/fetch-http-governance-patch.ts` currently defines local
  copies of `mintSpanId`, `mintTraceId`, `nowEpochNs`, `TEXT_CONTENT_MARKERS`,
  `isTextContentType`, `headersToRecord`.
- `mintSpanId` / `mintTraceId` / `nowEpochNs` / `PendingTelemetry` already exist,
  generic, in `src/instrumentation/file-io-shared.ts`.

## Create

`src/instrumentation/http-governance-shared.ts` — HTTP-governance helpers:
- `TEXT_CONTENT_MARKERS`, `isTextContentType(contentType: string | null)` — moved
  verbatim from the fetch patch (keep the fetch superset markers: `json`, `text`,
  `xml`, `javascript`, `x-www-form-urlencoded`).
- `headersRecordFromFetchHeaders(headers: Headers): Record<string,string>` — the
  current `headersToRecord`.
- `headersRecordFromNodeHeaders(h: OutgoingHttpHeaders | IncomingHttpHeaders):
  Record<string,string>` — flatten node header shapes (`string | string[] |
  number | undefined`) to `Record<string,string>` (join arrays with `, `, coerce
  numbers, drop `undefined`). New; used by Phase 02.
- `MAX_CAPTURE_BYTES` cap + `capText(s, cap)` for best-effort body truncation at
  capture time (node streams have no `.clone()`; we accumulate up to the cap).
- Re-export `mintSpanId`, `mintTraceId`, `nowEpochNs`, `PendingTelemetry` from
  `./file-io-shared.js` so HTTP code imports from one surface.

## Modify

`src/instrumentation/fetch-http-governance-patch.ts`:
- Delete the 3 local id/time helpers + `TEXT_CONTENT_MARKERS`/`isTextContentType`
  + `headersToRecord`; import them from `./http-governance-shared.js`
  (`headersToRecord` → `headersRecordFromFetchHeaders`).
- Keep `captureBodyText` + `Clonable` here (fetch-specific: uses `Request`/
  `Response.clone()`).
- No logic change anywhere else.

## Tests / validation

- `npm run test -- fetch` — existing fetch + span-builder suites pass unchanged.
- `npm run typecheck` + `npm run lint`.
- Grep confirms no other importer referenced the deleted fetch-local symbols
  (they were module-private).

## Risks / rollback

- Low. Pure extraction. If `import:check` or a test regresses, revert this phase's
  two-file diff — nothing else depends on it yet.
