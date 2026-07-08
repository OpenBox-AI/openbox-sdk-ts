---
phase: 7
title: "Release Readiness"
status: complete
priority: P2
effort: "2-3d"
dependencies: [6]
---

# Phase 7: Release Readiness

## Overview

Prepare the base SDK and the Mastra migration for review, publishing, and future
SDK adoption. Prove both can be installed from packed/published artifacts with no
sibling-path leakage.

## Requirements

- Functional: base SDK publishable standalone; Mastra installable against
  packed/published base; docs + CI + review gates complete.
- Non-functional: no `file:`/`link:`/`workspace:`/`../openbox-sdk-ts` refs in
  Mastra release artifacts.

## Architecture

Two release tracks (base SDK, Mastra adapter) + cross-SDK adoption guidance +
review gates. Grounded in proposal phase-07 and the tooling report Part A.

## Related Code Files

Create/modify (base SDK):
- `README.md`, `docs/installation.md`, `docs/framework-adapter-guide.md`,
  `docs/api-reference.md` (or typedoc), `CHANGELOG.md`.
- Verify `package.json` `exports` + `files` allowlist; ensure `dist` only.
- Ensure `.github/workflows/pr-quality.yml` covers lint/typecheck/test/build/pack.

Create/modify (Mastra):
- Migration notes + `CHANGELOG.md`; peer/dependency updates; switch base dep from
  local to packed/published; `exports` check.

Docs:
- Cross-SDK adoption: CopilotKit duplicated surfaces, Cloudflare/edge gaps,
  LangChain-TS starting point, and an **adapter checklist** for future TS SDKs.

## Implementation Steps

1. Base SDK docs (README, install, adapter guide, API ref, changelog).
2. Base release gates: `npm run lint && typecheck && test && build && npm pack --dry-run`;
   inspect the tarball for test/build debris (should contain only `dist` + docs).
3. Mastra release prep: migration notes; changelog; switch to packed/published
   base dep; run the same gates.
4. **Artifact scan:** grep Mastra `package.json` + lockfile for `file:`, `link:`,
   `workspace:`, `../openbox-sdk-ts` → must be zero.
5. **Clean temp-app install test:** in a throwaway dir, `npm i` the packed Mastra
   tarball + packed/published base, run a representative workflow/tool/agent/
   approval/A2A smoke — no sibling paths.
6. Review gates: findings-first code review; contract review vs Python/Core
   (must include the Phase 4 Core-parity gate green, not just Python fixtures);
   package review; security review for signing + secret handling (keys never
   logged; PKCS8-DER seed load; redaction before signing; **non-ASCII payload
   signs correctly**; recursion-guard bypass tests; **confirm the shipped
   `on_api_error` default and document the fail-open-vs-fail-closed posture**).
7. Write the future-SDK adapter checklist.

## Success Criteria

- [x] Base SDK publishable as a standalone npm package (clean pack — 163 files,
      dist+README+LICENSE+CHANGELOG+docs only, no debris; import-light root).
- [x] Mastra migration releasable without undocumented public API breaks
      (81→91 additive; migration notes documented).
- [x] Docs state Mastra was the first consumer, not the source of base behavior.
- [x] Future TS SDKs have a clear adapter checklist (`docs/adapter-checklist.md`).
- [x] CI covers lint/typecheck/test/build/pack (`.github/workflows/pr-quality.yml`).
- [~] Mastra release artifacts contain no local base-SDK path refs — Mastra's dev
      dep is `file:../openbox-sdk-ts`; the swap-to-published + artifact scan is a
      **publish-time** step (base must be published to npm first — user-gated).
- [x] Clean temp-app install smoke: packed BASE installs in a throwaway app; root
      + subpath exports resolve + execute (canonical string verified). Full
      packed-Mastra+base smoke is the publish-time gate ([~], with the dep swap).

**Publish is user-gated** (needs npm auth + a registry). Prepared, not executed:
`npm publish` the base SDK, then swap Mastra's `file:../openbox-sdk-ts` →
`@openbox-ai/openbox-sdk@<version>`, then run the artifact scan
(`file:`/`link:`/`workspace:`/`../openbox-sdk-ts` → zero) + the full packed-app
smoke. **Open product decisions before GA** (see `docs/adapter-checklist.md` +
ledger): OQ1 default `on_api_error` posture; redis typed-command blocking.

## Risk Assessment

- Hidden sibling-path dep in lockfile → explicit artifact scan + temp-app install.
- Shipping test/build debris → tarball inspection + `files` allowlist.
- Secret leakage in logs → security review of signing + redaction paths.

## Follow-Up Candidates

- CopilotKit migration to base; Cloudflare/edge adapter; LangChain-TS SDK; broader
  DB/file/LLM instrumentation (Phase 5 Tier B + streaming); shared conformance
  fixture package across all TS SDK repos.
