---
type: debug
date: 2026-07-09
tags: [approvals, adapters, hitl, core-contract]
status: active
---

# Approval poll sent empty workflow/run/activity IDs

## Symptom (latent)

With a real `ApprovalPoller` wired (HITL), a `REQUIRE_APPROVAL` verdict drove
`CoreAdapter.handleApproval`, which polled
`POST /api/v1/governance/approval` with **empty** `workflow_id` / `run_id` /
`activity_id` — so Core could never match the pending approval and the poll
would reject/time out. Reachable only with a poller configured; the default
no-poller adapter rejects outright (fail-safe), which is why it went unnoticed.

## Root cause

`handleApproval` read the IDs from `result.raw.{workflow_id,run_id,activity_id}`,
but Core's **public** evaluate response `GovernanceVerdictPublicResponse`
(`openbox-core/internal/content/governance.go`) does not carry those fields —
they exist only on the *request* structs. So `result.raw` never contains them
and each `readRawString` returned `""`. `openbox-sdk-python` had the identical
code (`adapters/base.py`) — a shared source-of-truth bug, not a TS port slip.
The Python **sync** hook path already did it right (resolves `ctx`, passes IDs
to the poller directly); only the adapter `handle_approval` seam (async paths)
was wrong.

The tests hid it: they hand-injected `raw: {workflow_id, ...}` that real Core
never sends, and otherwise only asserted a poll count.

## Fix (ts + python + mastra)

Thread the originating context into the approval seam instead of trusting the
response echo — mirrors the existing `onCompletedHookResult(result, context)`:

- `FrameworkAdapter.handleApproval(result, context?)` — optional `ActivityContext`;
  `CoreAdapter`/`MastraFrameworkAdapter` prefer it, keep `result.raw` as a
  legacy fallback.
- Lifecycle path builds the context from the event (`workflow_id`/`run_id` live
  in `event.payload`; `activity_id` is the envelope field) — see
  `approvalContextFromEvent` in `runtime/openbox-runtime.ts`.
- Hook path passes the bound `ActivityContext`.
- Backward-compat: TS via structural typing (extra optional param); Python via
  signature inspection (`adapter_accepts_context`, same trick already used for
  `on_completed_hook_result`) so adapters taking only `result` still work.

Tests now prove IDs reach the poll with an **empty** `result.raw`. Related:
[[decision-fail-open-on-non-auth-4xx]] (the other finding from the same review).
