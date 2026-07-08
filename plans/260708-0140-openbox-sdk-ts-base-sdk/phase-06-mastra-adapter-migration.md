---
phase: 6
title: "Mastra Adapter Migration"
status: complete
priority: P2
effort: "6-8d"
dependencies: [4]
---

# Phase 6: Mastra Adapter Migration

## Overview

Refactor `openbox-mastra-sdk` to consume `@openbox-ai/openbox-sdk` for all shared
OpenBox behavior, keeping only Mastra lifecycle mapping and public API in the
Mastra package. Prove behavior via parity tests; carry no incorrect Mastra logic
back into base.

## Prerequisite (hard gate)

Start only after **Phase 4 conformance + Core-parity gate pass**. Requires Phase 5
**Tier A1** (fetch/fs/function — Mastra's actual blocking surface). Phase 5 **Tier
A2** (pg/redis) and **Tier B** (mysql/mongodb) do NOT gate this phase — Mastra blocks
no databases today. If any base hook coverage is still incomplete, state which
existing Mastra hook coverage stays local for one release and file a follow-up.

## Requirements

- Functional: Mastra public exports stable (or documented breaks); shared
  primitives delegate to base; base conformance kit runs inside Mastra; exactly one
  governance event per instrumented op (no double-governance).
- Non-functional: dev resolves base from `../openbox-sdk-ts`; release from a
  packed/published package (no sibling path in release artifacts).

## Architecture

Grounded in [Mastra report](./research/researcher-03-openbox-mastra-sdk-tooling-and-migration-report.md)
Parts B, D + red-team contract-verification (98 public symbols across 8 barrels).

**Shared surfaces to delegate to base** (mastra paths):
`src/types/{verdict,governance-verdict-response,guardrails,errors,workflow-event-type}.ts`,
`src/client/openbox-client.ts`, `src/config/openbox-config.ts` (⚠ config
divergence below), `src/identity/agent-identity.ts`,
`src/governance/{approval-registry,context}.ts`.

**Stays in Mastra:** `src/mastra/{with-openbox,wrap-agent,wrap-tool,wrap-workflow,
event-metadata,a2a-peer}.ts`, `src/governance/activity-runtime.ts`,
`src/otel/setup-openbox-opentelemetry.ts`, `src/span/openbox-span-processor.ts`,
and **`src/types/workflow-span-buffer.ts`** (public export at `types/index.ts:7`,
consumed only by retained files `wrap-agent.ts`/`activity-runtime.ts`/
`openbox-span-processor.ts`). **Cross-boundary note:** `workflow-span-buffer.ts`
imports `Verdict`, which MOVES to base — after migration it must import `Verdict`
from `@openbox-ai/openbox-sdk`, not the deleted local `./verdict.js`.

**Contract-verify before starting:** do a symbol-level diff of all 98 public
exports (`src/index.ts` `export *` across `client, config, identity, types, mastra,
otel, span, governance`) against the delegate/stays lists — "update the type files"
is not a complete contract.

**Re-verify vs Python/Core BEFORE trusting Mastra logic** (5 flagged surfaces):
error retry/fail-open; verdict priority + application; config defaults; approval
wire format; guardrails redaction. Base wins on conflict; document the change.

**Config divergence:** Mastra's `OpenBoxConfigInput` has `multiAgent`/
`multiAgentSessionId` (copilotkit omits). Base exports the generic type; Mastra
keeps its resolver in `src/mastra/`.

## Related Code Files

Modify (in `openbox-mastra-sdk`):
- `package.json` — add `@openbox-ai/openbox-sdk` (dev `file:`/`link:` to
  `../openbox-sdk-ts`; release: packed/published).
- `src/types/*`, `src/client/*`, `src/config/*`, `src/identity/*`,
  `src/governance/{approval-registry,context}.ts` — delegate to base via compat
  wrappers/re-exports.
- `src/types/workflow-span-buffer.ts` — retain; repoint its `Verdict` import to base.
- `src/mastra/*` — keep; adapt to a Mastra `FrameworkAdapter` over base
  `OpenBoxRuntime` where they used local governance internals.
- `src/otel/setup-openbox-opentelemetry.ts` — **when the base pg wrapper is active,
  disable Mastra's OTel-pg governance** (`instrumentDatabases:false` / drop pg from
  `dbLibraries`) so pg is not double-governed.
- `src/index.ts` — keep public export surface stable.
- `test/**` — fixture updates for intentional wire changes; adapter conformance
  tests importing the base kit; a "one governance event per pg query" invariant test.

## Implementation Steps

1. Symbol-level public-export diff (98 symbols) → confirm delegate/stays coverage.
2. Add base dependency (local dev resolution).
3. Mastra `FrameworkAdapter` mapping BLOCK/HALT/approval to Mastra-native errors;
   wire Mastra wrappers to base `OpenBoxRuntime`.
4. Replace shared primitives behind compat wrappers, one surface at a time
   (config → identity/signing → client → results/approval → events → spans →
   runtime), running Mastra tests after each. **Make instrumentation swaps atomic
   per driver** — installing the base pg wrapper and disabling Mastra OTel-pg
   governance happen in the same step; add a feature flag to toggle base-vs-legacy
   per surface for rollback.
5. Re-verify the 5 flagged surfaces vs base; adopt base where Mastra was wrong;
   record intentional changes in migration notes.
6. Keep Mastra lifecycle interpretation (boundaries, A2A, metadata→context).
7. Run the base conformance kit inside Mastra.
8. Remove duplicated internals only after base-backed replacements pass tests.

## Success Criteria

- [x] Mastra tests pass after expected fixture updates (195/195; +48 tests).
- [x] Public exports stable — 81→91 additive (0 removed/renamed); the export diff
      shows full coverage (incl. `workflow-span-buffer` repointed to base `Verdict`).
- [x] Mastra no longer owns shared signing/result/event/config/error BEHAVIOR
      (delegated to base). The `OpenBoxClient` API *shell* is retained (surgical
      patch) for wire/response-shape compat, but its signing + verdict-parsing
      delegate to base transitively — no divergent copy.
- [x] Exactly one governance event per instrumented pg query (asserted `.toBe(1)`;
      base DB blocking NOT enabled — Mastra keeps its OTel-pg telemetry).
- [x] Base conformance kit runs green inside Mastra (non-no-op assertions).
- [~] Rollback path: per-file `git revert` (each delegated surface is an isolated
      file/hunk) rather than a runtime base-vs-legacy flag — accepted deviation
      (YAGNI; documented in migration notes).

**Review-hardened (Phase 6 code review):** the fail-open-on-auth fix (red-team
Critical #4) was initially only at the client boundary — the production evaluate
WRAPPERS re-swallowed the thrown `OpenBoxAuthError` and fail-opened under the
default `fail_open`. Fixed: Started/pre-op/resume events now fail CLOSED on
auth/signing/contract/governance-API errors (mirroring base `isFailClosedCondition`),
completed events stay telemetry-fail-open. Also aligned approval empty-action
parsing to base, dropped dead code, added base-drift-parity + signing-error tests.
**Config divergence** kept in Mastra (multiAgent resolver). **Kept-local** (validated):
`guardrails.ts` (base null vs Mastra undefined contract), `governance/{context,
approval-registry}.ts` (no base equivalent). **Base dep** = dev `file:../openbox-sdk-ts`;
Phase 7 swaps to published.

## Risk Assessment

- Public API break → compat wrappers + parity tests + the 98-symbol diff.
- pg double-governance (base wrapper + Mastra OTel-pg) → atomic per-driver swap +
  one-event invariant test.
- `workflow-span-buffer` compile break when `verdict.ts` moves → repoint import.
- Trusting wrong Mastra logic → 5-surface re-verify; base wins.
- Dev/release resolution mismatch → Phase 7 artifact scan.

## Explicit Non-Goals

- No CopilotKit/Cloudflare/LangChain migration; no unnecessary Mastra API rewrite;
  do not delete Mastra modules before base-backed replacements are tested.
