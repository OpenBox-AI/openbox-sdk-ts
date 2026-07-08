# Phase 1: Repo Scaffolding And Source Audit

## Goal

Create a clean TypeScript base-SDK repository and pin the source-of-truth
contracts before implementing behavior.

This phase prevents the implementation from becoming a Mastra copy.

## Inputs

- `openbox-sdk-python`
- `openbox-core`
- `openbox-core/docs/sdk-integration-guide.md`
- `openbox-mastra-sdk`
- `openbox-copilotkit-sdk`
- `openbox-cloudflare-agents-sdk`

## Work

1. Create `/Users/tino/code/openbox-sdk-ts`.
2. Scaffold a Node ESM TypeScript package named `@openbox-ai/openbox-sdk`.
3. Use npm, TypeScript, tsup, Vitest, ESLint, and package exports consistent
   with current OpenBox TS SDKs.
4. Add initial source folders:

   ```text
   src/adapters
   src/client
   src/config
   src/conformance
   src/context
   src/contracts
   src/errors
   src/gate
   src/hooks
   src/identity
   src/instrumentation
   src/otel
   src/runtime
   src/spans
   src/wire
   test
   ```

5. Add a source audit document under `docs/source-of-truth.md`.
6. Add a contract conflict ledger under `docs/contract-conflict-ledger.md`.
7. Record the known started-span conflict:
   - Core docs describe started hook spans with integer `end_time`/`0`.
   - Python base-SDK conformance emits explicit `end_time: null` and
     `duration_ns: null`.
   - TS must emit Python-compatible nulls because Core accepts null as zero.
8. Inventory duplicated shared behavior in `openbox-mastra-sdk`, but mark it as
   reference-only.
9. Add root import-safety tests before runtime-heavy modules are added.

## Acceptance Criteria

- Repository exists and builds an empty typed package.
- `package.json` uses `"name": "@openbox-ai/openbox-sdk"`.
- `npm run typecheck`, `npm run test`, and `npm run build` pass.
- Package root exports only import-light surfaces.
- `docs/source-of-truth.md` records:
  - Core endpoint contract
  - Python base-SDK source files to mirror
  - Mastra duplicated surfaces to replace later
  - known areas where Mastra is not trusted
- `docs/contract-conflict-ledger.md` records every Core-docs-vs-Python
  conformance conflict before implementation begins.
- The ledger explicitly resolves started hook spans as
  `end_time: null` / `duration_ns: null` for TypeScript.
- No Mastra code has been copied into base SDK behavior.

## Risks

- Starting from Mastra would import existing behavioral bugs.
- Over-scaffolding may lock in incorrect export boundaries.
- Node engine decision may need revisiting before publish.

## Notes

Initial Node target should match the current TS SDK family (`>=24.10.0`) unless
the user explicitly asks to support Node 20 immediately.
