# Phase 7: Release Readiness

## Goal

Prepare the TypeScript base SDK and Mastra adapter migration for review,
publishing, and future SDK adoption.

## Work

1. Base SDK release prep:
   - README
   - installation docs
   - framework adapter guide
   - API reference
   - changelog
   - package exports check
   - npm pack dry run
   - CI workflow

2. Mastra migration release prep:
   - migration notes
   - changelog
   - peer/dependency updates
   - local dependency scan for `file:`, `link:`, `workspace:`, and
     `../openbox-sdk-ts`
   - package exports check
   - npm pack dry run
   - clean temp-app install against the packed or published base SDK
   - CI workflow

3. Cross-SDK adoption guidance:
   - identify CopilotKit duplicated surfaces
   - identify Cloudflare/edge gaps
   - identify LangChain TS starting point
   - define adapter checklist for future SDKs

4. Review gates:
   - code review with findings-first format
   - contract review against Python/Core
   - package review
   - security review for signing and secret handling

## Acceptance Criteria

- Base SDK can be published as a standalone npm package.
- Mastra migration can be released without undocumented public API breaks.
- Documentation explains that Mastra was the first consumer, not the source of
  base behavior.
- Future TS framework SDKs have a clear adapter checklist.
- CI covers lint, typecheck, test, build, and pack checks.
- Mastra release artifacts contain no local base-SDK dependency references in
  `package.json` or `package-lock.json`.
- A clean temporary app can install the packed Mastra SDK against the packed or
  published base SDK without using sibling paths.

## Release Gates

Base SDK:

```text
npm run lint
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

Mastra SDK:

```text
npm run lint
npm run typecheck
npm run test
npm run build
npm pack --dry-run
scan package.json and package-lock.json for file:, link:, workspace:, ../openbox-sdk-ts
install packed Mastra SDK plus packed/published base SDK in a clean temp app
```

## Follow-Up Candidates

- CopilotKit migration to base SDK.
- Cloudflare/edge-compatible base runtime or adapter.
- LangChain TS SDK implementation.
- Broader DB/file/LLM instrumentation coverage.
- Shared conformance fixture package for all TS SDK repos.
