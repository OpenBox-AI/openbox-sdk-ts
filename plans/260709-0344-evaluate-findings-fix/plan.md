# Evaluate-path review findings — fix plan

Status: DONE (uncommitted) · #1 documented · #2 fixed+verified (ts/python/mastra) ·
#3 prepped (base bumped 0.1.0→0.1.2, Mastra→^0.1.2); publish + Mastra lockfile
refresh are outward steps left to the maintainer. Version-lineage caveat below.

## Verification (2026-07-09)
- ts: 529 tests, lint, typecheck, import:check, pack:check all green.
- python: 372 tests, ruff clean, mypy at pre-existing baseline (no new errors).
- mastra: 195 tests, lint, typecheck green; conformance test now asserts the real
  workflow/run IDs reach Core's approval endpoint end-to-end.
- packed base SDK installs cleanly into a fresh consumer (adapters subpath resolves).

## Version-lineage caveat (#3 — needs maintainer)
Registry has 0.1.0, 0.1.1, 0.1.2-beta.0/1/3; local tree was still 0.1.0 with newer
commits and no CHANGELOG trace of 0.1.1/betas. 0.1.2 stable is the natural cut of the
beta line, BUT confirm this tree contains everything in 0.1.2-beta.3 before publishing.
Post-publish: `cd openbox-mastra-sdk && npm install` to refresh its lockfile (still
`file:` until then).

Three verified findings from a red-team review of the evaluate path. User
decisions locked (see below). Base SDK contract is mirrored across
openbox-sdk-ts (base), openbox-sdk-python (source-of-truth parity), and
openbox-mastra-sdk (consumer).

## Findings & decisions

| # | Sev | Finding | Verified | Decision |
|---|-----|---------|----------|----------|
| 1 | P1 | Non-auth 4xx (400/404/422) evaluate responses fail open under default `fail_open` | Real; shared with Python; contradicts "network/outage only" doc | **Keep behavior** (intentional availability choice); document only |
| 2 | P1 | Approval poll reads workflow/run/activity IDs from `result.raw`, but Core's evaluate response never carries them → polls with empty IDs | Real; identical in Python; only reachable with a real poller (HITL) | **Fix all repos**: thread the originating context into `handleApproval` |
| 3 | P2 | Mastra depends on `file:../openbox-sdk-ts` | Real | **Fix**: swap for packed/published base SDK + refresh lockfile |

## #1 — document only (no client code change)
Fail-open-on-4xx is an accepted availability posture. Record it so it is not
re-flagged:
- contract-conflict-ledger entry (divergence rationale: 4xx treated as
  outage-class for `onApiError`, unlike auth 401/403 which always throws).
- `_notes/` decision entry.
Auth 401/403 stays fail-closed (unchanged).

## #2 — thread approval context (all repos)
Root cause: `CoreAdapter.handleApproval(result)` reads
`result.raw.{workflow_id,run_id,activity_id}`; Core's
`GovernanceVerdictPublicResponse` has none of them. The IDs ARE available at
both call sites (lifecycle event payload; hook `ActivityContext`). Python's
SYNC hook path already does this correctly via the poller; only the adapter
`handle_approval` seam (async paths) is wrong.

Approach: add `context?: ActivityContext | null` to `handleApproval` (mirrors
`onCompletedHookResult(result, context)`), prefer it, keep `result.raw` as a
backward-compat fallback. No third-party adapter breaks (TS structural typing;
Python signature-inspection like `on_completed_hook_result`).

Files:
- ts: adapters/base.ts, runtime/openbox-runtime.ts, runtime/hook-evaluator.ts,
  conformance/fake-adapter.ts, test/adapters-base.test.ts (+ any call-shape tests)
- python: adapters/base.py, runtime.py, hooks/preflight.py,
  conformance/hook_preflight.py, tests
- mastra: mastra/framework-adapter.ts (+ verify activity-runtime inline path), tests

## #3 — Mastra dependency
package.json `file:../openbox-sdk-ts` → published/packed version; refresh
package-lock.json.

## Acceptance
- ts + python: full test suites green; lint + typecheck clean.
- New tests prove: context IDs reach the poller with an EMPTY `result.raw`.
- mastra: adapter uses context; install resolves base SDK without the `file:` link.
- #1 documented in ledger + notes.
