---
phase: 1
title: "Repo Scaffolding And Source Audit"
status: complete
priority: P1
effort: "1-2d"
dependencies: []
---

# Phase 1: Repo Scaffolding And Source Audit

## Overview

Create a clean Node ESM TypeScript package `@openbox-ai/openbox-sdk` and pin the
source-of-truth contracts + conflict ledger **before** implementing behavior.
This phase exists to stop the implementation from becoming a Mastra copy.

## Requirements

- Functional: empty-but-typed package builds, lints, typechecks, tests, packs.
- Functional: source-audit + contract-conflict-ledger docs committed before any
  behavior code.
- Non-functional: package root is import-light (no crypto/network/OTel/driver
  side effects); Node engine `>=24.10.0`.

## Architecture

- **Tooling mirrors `openbox-mastra-sdk`** (canonical TS SDK; copilotkit mirrors
  it, cloudflare is older). See
  [tooling report](./research/researcher-03-openbox-mastra-sdk-tooling-and-migration-report.md) Part A.
- **Internal `src/` modules are inspired by `openbox-sdk-python`** (contract-driven;
  not a literal mirror — Python has no top-level `spans/` and does have `approvals`/
  `serialization`/`validation`). See
  [Python report](./research/researcher-01-openbox-sdk-python-contracts-report.md) §1.
  Public `exports` are **consumer-driven**, not one-per-module (see below).
- Crypto via Node built-in `node:crypto` (Ed25519) — no external crypto dep.

## Related Code Files

Create (repo root):
- `package.json` — name `@openbox-ai/openbox-sdk`, `type:module`,
  `sideEffects:false`, `engines.node >=24.10.0`, exports map (see below),
  scripts (`build`/`lint`/`typecheck`/`test`/`pack:check`/`ci:check`),
  deps `@opentelemetry/api ^1.9`, `@opentelemetry/resources ^2.7`,
  `@opentelemetry/sdk-trace-base ^2.7`, `zod ^4.1`; devDeps `typescript ^5.9`,
  `tsup ^8.5`, `vitest ^3.2` + `@vitest/coverage-v8`, `eslint ^9` +
  `typescript-eslint ^8.42` + `eslint-config-prettier`, `prettier ^3.6`,
  `@types/node ^24`. **Remove** `@mastra/core` and framework OTel instrumentations.
- `tsconfig.json` — `target ES2023`, `module ESNext`, `moduleResolution Bundler`,
  `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`, `noEmit`, `@/* → src/*`.
- `tsup.config.ts` — `bundle:false`, `clean:true`, `dts:true`,
  `entry:["src/**/*.ts"]`, `format:["esm"]`, `platform:node`, `sourcemap:true`,
  `splitting:false`, `target:node24`.
- `vitest.config.ts` — node env, globals, coverage v8, thresholds
  (branches 70 / functions 90 / lines 75 / statements 75), include `src/**/*.ts`.
- `eslint.config.js` (flat) — `recommendedTypeChecked` + prettier; relaxed rules
  for `test/**`. `.prettierrc.json` (`semi:true`, `singleQuote:false`,
  `trailingComma:none`).
- `.github/workflows/pr-quality.yml` — Node 24.10.0, `npm ci` → lint → typecheck
  → test → build (drop SonarQube; keep optional codecov).
- `src/` folders (inspired by Python): `adapters/ approvals/ client/ config/
  conformance/ context/ contracts/ errors/ gate/ hooks/ identity/ instrumentation/
  otel/ runtime/ serialization/ spans/ wire/` and top-level `src/index.ts`.
- `src/index.ts` — import-light root re-exporting only types/contracts/errors +
  light factory names; NO transitive crypto/network/OTel/driver imports.
- `docs/source-of-truth.md`, `docs/contract-conflict-ledger.md`.
- `test/root-import-safety.test.ts`.

Exports map (**consumer-driven, not one-per-module** — public subpaths carry a
backwards-compat burden). Start with `.` + `./package.json` and add only the
subpaths the Mastra migration (Phase 6) actually imports; grow on demand as
consumers appear. Internal `src/` granularity may be finer than the public surface.
`./conformance` ships as a test utility in v1; `./otel` is optional (no current
consumer). Do NOT pre-commit all 16 subpaths.

## Implementation Steps

1. `npm init` the package; write `package.json` per above (copy Mastra's shape,
   strip framework deps, set exports map).
2. Add `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`,
   `.prettierrc.json`, `.gitignore` (dist, coverage, node_modules).
3. Create the `src/` folder tree with placeholder `index.ts` per folder that
   export nothing heavy yet. Add a minimal typed `src/index.ts`.
4. Add CI workflow.
5. Write `docs/source-of-truth.md`: Core endpoint contract summary; Python
   base-SDK source files to mirror (map each Python module → TS module); Mastra
   duplicated surfaces to replace later; explicit "Mastra NOT trusted" areas
   (governance/otel/approval/fail-open — the 5 re-verify surfaces).
6. Write `docs/contract-conflict-ledger.md` recording every Core-docs-vs-Python
   conflict, each with links to both sources and the chosen wire form:
   - **Started-span `end_time`/`duration_ns`:** Core docs say `0`/int64; Python
     emits explicit `null`. Resolution: emit `null` (Core unmarshals `null`→`0`;
     `duration_ns` is `*int64,omitempty`). Cross-SDK parity with Python.
   - **Canonical string trailing newline:** RESOLVED by source — **no trailing
     newline**. Core uses `strings.Join([5 fields],"\n")`
     (`openbox-core/internal/services/agent.go:94-100`); Python matches. The
     earlier "disagreement" was a research-report error, not a real conflict.
   - **Golden fixture scope:** it is Python-generated and self-checked, so it is a
     **Python-parity regression anchor, not a Core tiebreaker**. Record that
     TS≡Core is proven separately by the Phase 4 Core-parity gate (Go harness /
     round-trip), not by the fixture.
   - **Non-ASCII body escaping:** Python `json.dumps` defaults to
     `ensure_ascii=True` (`\uXXXX`); JS `JSON.stringify` emits raw UTF-8 → different
     hash → Core 401. Resolution: TS `serializeBody` must ascii-escape (Phase 2 D3).
   - **Signing timestamp `+00:00` vs `Z`:** signing uses `+00:00` offset; event
     payloads use `Z`. Two formatters. (Affects Python byte-parity only — Core
     rebuilds canonical from the literal timestamp header.)
7. Write `test/root-import-safety.test.ts`: import the package root and assert no
   heavy modules were loaded (e.g. assert `require.cache`/loaded-module probe has
   no `pg`/`@opentelemetry/sdk-node`/network); assert importing root does not
   install global fetch patches.
8. Confirm `npm run typecheck && npm run test && npm run build && npm pack --dry-run`.

## Success Criteria

- [x] Repository builds an empty typed package; all five gates pass (+ a 6th
      `import:check` guard in a clean Node process).
- [x] `package.json` name is `@openbox-ai/openbox-sdk`, engine `>=24.10.0`.
- [x] Package root exports only import-light surfaces (root import-safety test +
      `import:check` green).
- [x] `docs/source-of-truth.md` maps Core contract + Python modules→TS modules +
      Mastra surfaces to replace + untrusted areas.
- [x] `docs/contract-conflict-ledger.md` records the conflicts above (started-span
      nulls, canonical/fixture scope, non-ASCII escaping, timestamp formats) with
      links and chosen resolutions.
- [x] No Mastra behavior code copied into base SDK.

**Deferred to Phase 7 (release):** `LICENSE` file (package declares MIT +
`publishConfig.access:public` but ships no license text yet).

## Risk Assessment

- Starting from Mastra imports latent bugs → mitigate by scaffolding fresh and
  keeping Mastra reference-only.
- Over-scaffolding locks wrong export boundaries → keep folder placeholders
  minimal; finalize exports as modules land.
- Node engine may need revisiting before publish → recorded as ledger note.
