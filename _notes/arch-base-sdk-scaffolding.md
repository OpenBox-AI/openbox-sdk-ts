---
type: arch
date: 2026-07-08
tags: [scaffolding, tooling, node, ci, phase-1]
status: active
---

# Base SDK scaffolding + tooling (Phase 1)

`@openbox-ai/openbox-sdk` — the TS base SDK. Phase 1 = empty-but-typed package
that builds/lints/typechecks/tests/packs, plus the source-audit docs that keep
later phases contract-driven (not a Mastra copy).

## Tooling provenance

Config is mirrored from `openbox-mastra-sdk` (the canonical, most-modern TS SDK)
— `tsconfig.json` + `tsup.config.ts` are byte-identical; `vitest`/`eslint` match
minus Mastra-specific overrides. **Intentional strips:** `@mastra/core`, all
`@opentelemetry/instrumentation-*`, `@opentelemetry/sdk-node`,
`@opentelemetry/sdk-trace-node`. **Kept:** `@opentelemetry/{api,resources,sdk-trace-base}`,
`zod`. Added `@eslint/js` explicitly (Mastra relied on a transitive hoist).

`exports` is **consumer-driven**: only `.` + `./package.json` today. Add subpaths
only when a real consumer (Phase 6 Mastra migration) imports them — public
subpaths carry a backwards-compat burden. Do NOT pre-commit all 16.

## Sharp edges (would waste a future session an hour)

1. **npm global cache is root-owned on this machine** → `npm install` fails with
   `EACCES` on `~/.npm/_cacache`. Workaround used: `npm install --cache <tmp>`.
   Permanent fix (user action): `sudo chown -R 501:20 ~/.npm`.
2. **`process.moduleLoadList` was removed in Node 25** (`not a function` on
   v25.8.2). The reviewer's suggested import-weight probe using it does not work
   here. Also, **vitest virtualizes the module graph**, so an in-test
   "which modules loaded" probe is unreliable. → Import-light is enforced two
   ways: (a) vitest `test/root-import-safety.test.ts` checks the real side-effect
   vectors (global `fetch` unpatched, no OTel global provider); (b)
   `scripts/check-root-import-light.mjs` (`npm run import:check`, wired into
   `ci:check` AFTER build) runs in a CLEAN Node process and patches `Module._load`
   to catch heavy CJS driver / OTel-SDK loads against the built `dist/`.

## Contract facts

Do NOT restate here — they live in and are verified by
[`docs/source-of-truth.md`](../docs/source-of-truth.md) and
[`docs/contract-conflict-ledger.md`](../docs/contract-conflict-ledger.md).
Highest-risk one re-verified against source: canonical signing string has **no
trailing newline** (`openbox-core internal/services/agent.go:92-100`,
`strings.Join([5 fields],"\n")`). Core verifies via a KMS-style
`identityVerifier.Verify(alias,...)`, not a bare `ed25519.Verify`.

## Status

Phase 1 complete; all gates green. Next: Phase 2 (contracts/config/identity/
client) — the highest-risk phase (byte-exact Ed25519 signing parity). Repo is
**not yet a git repository**.

See [[decision-openbox-ts-base-sdk-not-mastra-driven]] for why base leads Mastra.
