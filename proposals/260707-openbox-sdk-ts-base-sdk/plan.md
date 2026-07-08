---
title: "OpenBox TypeScript Base SDK + Mastra Adapter Migration"
description: "Build openbox-sdk-ts as the TypeScript base SDK equivalent of openbox-sdk-python, grounded in OpenBox Core wire contracts and Python base-SDK behavior, then migrate openbox-mastra-sdk to consume it as a thin adapter."
status: proposed
priority: P1
branch: "TBD"
tags: [sdk, governance, typescript, node, signing, instrumentation, mastra, migration]
blockedBy: []
blocks: ["openbox-mastra-sdk shared-runtime migration"]
created: "2026-07-07"
createdBy: "codex"
---

# OpenBox TypeScript Base SDK + Mastra Adapter Migration

## Purpose

Create a TypeScript base SDK, `openbox-sdk-ts`, that plays the same role for
Node/TypeScript framework SDKs that `openbox-sdk-python` plays for Python
framework SDKs.

The base SDK must own shared OpenBox behavior:

- contracts and result parsing
- always-strict event/runtime validation
- config resolution
- AIP DID validation and Ed25519 request signing
- evaluate, approval, and auth client primitives
- context/runtime/adapter interfaces
- Core `SpanData` wire serialization
- hook preflight/completed runtime
- reusable conformance fixtures

`openbox-mastra-sdk` is the first intended integration target, but it is not the
source of truth. It should be used only as:

- a reference for existing TS package/tooling conventions
- a map of duplicated surfaces that should move to the base SDK
- a migration target that proves the base SDK adapter story
- a cautionary source for behavior that must be re-verified against Python/Core

The base SDK should be contract-driven, not Mastra-driven.

## Source Of Truth Order

1. `openbox-core` current HTTP API and stored wire contract.
2. `openbox-core/docs/sdk-integration-guide.md` for SDK-facing Core behavior.
3. `openbox-sdk-python` for base-SDK architecture and hardened behavior.
4. Existing TS SDKs, including `openbox-mastra-sdk`, only as implementation
   references and migration targets.

When these disagree, the implementation must stop and document the conflict.
Do not silently copy TypeScript SDK behavior into the base package.

Conflict handling:

- Phase 1 must create a contract conflict ledger before implementation.
- If Core docs disagree with current Python base-SDK conformance, record the
  conflict with links to both sources and choose the wire form that is accepted
  by Core and already enforced by Python conformance.
- The known started-span conflict is resolved explicitly in this plan: Core docs
  describe `end_time` as int64/`0` for started spans, while the current Python
  base SDK emits explicit `end_time: null` and Core accepts that as zero. The TS
  base SDK must emit the Python-compatible explicit null form and test it.

## Current State

Python base SDK:

- `openbox-sdk-python` exists and is the proven base-SDK shape.
- It owns common contracts, config, identity/signing, clients, strict gates,
  runtime/context, hook wire payloads, instrumentation, and conformance tests.
- Framework SDKs are supposed to be thin adapters over it.
- Its hook span contract is flat-at-creation and rejects old nested
  `otel`/`openbox`/`data` hook-span shapes.

TypeScript SDKs:

- `openbox-mastra-sdk` duplicates client, config, identity, governance,
  OTel/span, and framework-runtime behavior.
- `openbox-copilotkit-sdk` duplicates some of the same shared surfaces.
- `openbox-cloudflare-agents-sdk` has separate environment-specific governance
  helpers that may inform future edge/runtime support.
- There is an `openbox-langchain-sdk-ts` folder, but it is effectively empty in
  the current checkout.

Main problem:

- TS framework SDKs have no shared OpenBox base package, so logic drifts.
- Mastra has useful code and tests, but its governance/runtime behavior is not
  trusted enough to become base-SDK behavior by copying.

## Non-Goals

- Do not clone `openbox-mastra-sdk` into the base SDK.
- Do not treat current Mastra behavior as correct without proving it against
  `openbox-sdk-python` and `openbox-core`.
- Do not change OpenBox Core's API or database schema.
- Do not change the Python base SDK as part of this work.
- Do not migrate CopilotKit, Cloudflare Agents, LangChain TS, or other SDKs in
  the first implementation pass.
- Do not implement browser/client-side SDK support in v1. The first base SDK is
  server-side Node only.
- Do not preserve broken compatibility just because an existing TS SDK exposes
  it. Preserve public APIs through adapter shims where possible, but make shared
  base behavior correct.
- Do not introduce configurable gate modes. Runtime and wire contracts are
  always strict.

## Proposed Package

Repository:

```text
/Users/tino/code/openbox-sdk-ts
```

NPM package name:

```text
@openbox-ai/openbox-sdk
```

Naming decision:

- Use `openbox-sdk-ts` for the repository/check-out name so local workspace
  intent is obvious.
- Use `@openbox-ai/openbox-sdk` for the published npm package because this is
  the canonical TypeScript base SDK, not a framework adapter.
- Do not publish as `@openbox-ai/openbox-sdk-ts` unless package ownership or
  registry constraints block `@openbox-ai/openbox-sdk` and the user explicitly
  approves the fallback.

Initial runtime:

- Node ESM only.
- Align first-cut engine with current TS SDKs: `node >=24.10.0`.
- Revisit lowering to Node 20 only after signing, fetch timeout, OTel, and CI
  compatibility are proven.

Proposed exports:

```text
.
./adapters
./client
./config
./conformance
./context
./contracts
./errors
./gate
./hooks
./identity
./instrumentation
./otel
./runtime
./spans
./wire
./package.json
```

## Architecture Boundary

Base SDK owns:

- `OpenBoxConfig` and layered env resolution.
- `AgentIdentity` and signed request preparation.
- `OpenBoxClient` for `/api/v1/auth/validate`,
  `/api/v1/governance/evaluate`, and `/api/v1/governance/approval`.
- `Verdict`, `EvaluationResult`, `ApprovalResult`, guardrails parsing, and raw
  response preservation.
- `EventEnvelope`, lifecycle factories, signal factories, handoff factories,
  hook factories, and wire event type projection.
- strict gate validation before sends and before hook preflight.
- `ActivityContext`, context store, trace correlation, and runtime binding.
- `FrameworkAdapter` interface for native framework effects.
- Core `SpanData` normalization and flat hook-span assertions.
- hook runtime for started/completed operation governance.
- reusable fake Core and conformance fixtures.
- generic Node instrumentation only where behavior is proven.

Mastra SDK owns:

- Mastra-specific workflow, agent, tool, and A2A lifecycle mapping.
- Mastra-native error classes and user-facing API compatibility.
- Mastra-specific approval/block/halt behavior.
- Mastra metadata mapping into `ActivityContext`.
- Mastra public exports such as `withOpenBox`, workflow wrappers, and tool
  wrappers.

Rule:

```text
openbox-sdk-ts handles OpenBox contracts and governance runtime.
openbox-mastra-sdk handles Mastra lifecycle mapping and native enforcement.
```

## Contract Decisions To Port

The TypeScript base SDK must match these Python/Core decisions:

1. Signing canonical string:

   ```text
   UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
   ```

   `PATH` includes `/api/v1`. The signed body bytes must be exactly the bytes
   sent over the network. Do not use a second serialization path after hashing.

2. Request signing timestamp keeps timezone offset style, matching the Python
   base SDK and Core signer expectations. Event payload timestamps are separate
   RFC3339 `Z` strings.

3. API auth headers include bearer auth and SDK identity headers. DID headers
   are added only when `agentDid` and `agentPrivateKey` are both configured.

4. Verdict vocabulary is:

   ```text
   allow, constrain, require_approval, block, halt
   ```

   Compatibility aliases are accepted only where the Python base SDK accepts
   them.

5. Evaluate response parsing is lenient for backend drift and preserves `raw`.
   Approval response parsing is strict at the human-approval boundary:
   unknown or empty approval decisions must not become implicit allow.

6. `guardrails` and `guardrails_result` must refer to the same parsed object
   when both compatibility surfaces are exposed.

7. Hook events are wire-level `ActivityStarted` with:

   ```text
   hook_trigger: true
   spans: [flat Core SpanData]
   span_count: spans.length
   ```

   `span_count` is required for hook payloads and must equal `spans.length`.
   Non-hook lifecycle events should omit `span_count`; a legacy
   `span_count: 0` on non-hook events is compatibility noise to strip or ignore.
   `ActivityCompleted` must not carry non-empty hook spans.

8. Hook spans are flat. Do not emit nested `otel`, `openbox`, `metadata`, or
   `data` hook-span envelopes.

9. Hook spans must have `stage` and `hook_type` before send:
   - `stage` must be exactly `started` or `completed`.
   - `hook_type` must be a non-empty string.
   - preflight/started hook evaluation rejects `completed` and stageless spans.
   - completed hook evaluation rejects `started` and stageless spans.

10. Started-stage spans emit explicit `end_time: null` and
   `duration_ns: null`. This deliberately follows Python base-SDK conformance
   even though Core docs still describe the started value as `0`; Core accepts
   JSON null into its non-pointer integer field as zero.

11. Missing semantic fields are diagnostics, not automatic validation failures.

12. No bound activity context means hook governance is skipped, not treated as a
    contract error.

13. Framework adapters, not wrappers, turn BLOCK/HALT/approval decisions into
    native framework effects.

## Phase Plan

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Repo Scaffolding And Source Audit](./phase-01-repo-scaffolding-and-source-audit.md) | Proposed |
| 2 | [Contracts Config Identity Client](./phase-02-contracts-config-identity-client.md) | Proposed |
| 3 | [Event Wire Span Gate](./phase-03-event-wire-span-gate.md) | Proposed |
| 4 | [Runtime Adapter Conformance](./phase-04-runtime-adapter-conformance.md) | Proposed |
| 5 | [Node Instrumentation Hook Runtime](./phase-05-node-instrumentation-hook-runtime.md) | Proposed |
| 6 | [Mastra Adapter Migration](./phase-06-mastra-adapter-migration.md) | Proposed |
| 7 | [Release Readiness](./phase-07-release-readiness.md) | Proposed |

Dependency chain:

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
```

Phase 5 may start with only fetch/function instrumentation if DB/file coverage
needs more research. Phase 6 must not begin until Phase 4 conformance proves
that core contracts, client behavior, signing, approval parsing, and hook wire
shape match Python/Core.

## Mastra Migration Strategy

Mastra is the first adapter migration, not the base implementation source.

Migration approach:

1. Add the base package to `openbox-mastra-sdk` as
   `@openbox-ai/openbox-sdk`, sourced locally from `../openbox-sdk-ts` during
   development and from a packed/published package for release validation.
2. Keep Mastra public APIs stable.
3. Replace shared primitives behind compatibility wrappers:
   - config parsing
   - identity headers and signing
   - `OpenBoxClient`
   - result/verdict/approval parsing
   - event envelope creation
   - span wire normalization
   - context/runtime binding
4. Keep Mastra lifecycle interpretation in Mastra.
5. Remove duplicated Mastra internals only after parity tests pass.
6. Add tests that compare old public behavior where it was intentional and new
   base behavior where old behavior was wrong.

Specific caution:

- Do not copy `openbox-mastra-sdk/src/governance/*` into base without review.
- Do not copy Mastra OTel/span processing into base without checking the flat
  Python hook-span contract.
- Do not copy Mastra fail-open/fail-closed behavior without comparing
  `openbox-sdk-python` fallback semantics.
- Do not copy Mastra approval handling unless strict approval parsing is
  already proven.

## Verification Gates

Base SDK must pass:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm pack --dry-run`

Contract tests must cover:

- golden signed request fixture compatible with Python/Core
- body hash bytes equal transmitted bytes
- API key and URL validation
- config resolution precedence
- evaluate parsing and raw preservation
- approval action precedence and unknown-action pending behavior
- event factory payload shapes
- hook `ActivityStarted` wire projection
- hook `span_count == spans.length`
- non-hook lifecycle `span_count=0` treated only as compatibility noise
- hook span `stage` in `started|completed`
- hook span non-empty `hook_type`
- preflight rejects `completed` and stageless hook spans
- completion rejects `started` and stageless hook spans
- rejection of nested hook-span shapes
- flat `SpanData` defaults and null semantics
- full common/family `SpanData` field matrix
- no heavy imports from package root
- fake Core conformance matrix

Mastra migration must pass:

- existing Mastra public export tests
- existing Mastra contract tests after expected fixture updates
- new adapter conformance tests through `@openbox-ai/openbox-sdk`
- representative workflow, agent, tool, approval, and A2A tests
- build and pack checks

## Risks

- Signing byte drift between TS, Python, and Core.
- Accidentally trusting Mastra logic that was already wrong.
- Event timestamp and signing timestamp confusion.
- Node OTel attribute/time formats not matching Python/Core `SpanData`.
- Hook instrumentation that blocks too late or cannot prevent real operations.
- Approval parsing that turns unknown states into ALLOW.
- Public API break in Mastra during the dependency migration.
- Import side effects from package root pulling in OTel, network, or crypto
  unexpectedly.
- Node version target too high for downstream users.

## Open Questions

- Initial Node engine: keep `>=24.10.0` for parity with current TS SDKs, or
  support Node 20 from day one.
- Which Node instrumentation targets are required for v1:
  fetch/undici/http, function wrappers, fs, pg, mysql, redis, mongodb, or only a
  smaller safe subset.
- Whether Cloudflare/edge support belongs in this package or a later
  environment-specific adapter.
- Whether the first Mastra migration should update fixtures in place or keep a
  side-by-side legacy/base parity suite for one release.

## Definition Of Done

Base SDK is done when:

- `openbox-sdk-ts` exists as a standalone repository/package workspace.
- Its npm package name is `@openbox-ai/openbox-sdk`.
- It implements the shared contracts and runtime listed above.
- Its contract fixtures prove parity with `openbox-sdk-python` and
  `openbox-core`.
- It has a conformance kit that framework SDKs can import.
- Its package root is import-light.
- It can be packed for npm without shipping test or build debris.

Mastra migration is done when:

- `openbox-mastra-sdk` depends on the base SDK for shared OpenBox behavior.
- Mastra-specific code is reduced to adapter/lifecycle mapping.
- Existing public APIs remain compatible or documented as intentional breaks.
- Tests prove workflow/tool/agent/approval/A2A paths still behave correctly.
- Duplicated shared code has been removed or marked for removal with a follow-up
  issue.

## Dev Agent Prompt

Use this prompt when handing implementation to another agent:

```text
Implement the OpenBox TypeScript base SDK from the current implementation plan:
/Users/tino/code/openbox-sdk-ts/plans/260708-0140-openbox-sdk-ts-base-sdk/plan.md
(this proposal is the design input; that plan — hardened by research + red-team —
supersedes it and carries the authoritative phases, contract decisions, and scope).

Important: openbox-mastra-sdk is only a reference and the first integration
target. Do not copy Mastra governance/runtime logic into the base SDK unless it
has been verified against openbox-sdk-python and openbox-core. Treat
openbox-sdk-python and openbox-core as the behavioral source of truth.

Start with Phase 1 and Phase 2 only unless explicitly approved to continue:
create /Users/tino/code/openbox-sdk-ts, scaffold a Node ESM TypeScript package,
port contracts/config/identity/signing/client/result parsing from
openbox-sdk-python behavior, and add golden/parity tests. Do not modify
openbox-mastra-sdk until the base SDK contracts pass.

Before editing code or configuration, propose the exact intended logic and wait
for approval.
```
