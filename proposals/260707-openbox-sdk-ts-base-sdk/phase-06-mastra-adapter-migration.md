# Phase 6: Mastra Adapter Migration

## Goal

Refactor `openbox-mastra-sdk` to consume `openbox-sdk-ts` for shared OpenBox
behavior while keeping Mastra-specific lifecycle mapping and public APIs in the
Mastra package.

## Prerequisite

Do not start this phase until the base SDK has passed Phase 4 conformance.
If Phase 5 instrumentation is partial, the Mastra migration must explicitly
state which existing Mastra hook coverage remains local for one release.

## Work

1. Add the base SDK dependency to `openbox-mastra-sdk` under the package name
   `@openbox-ai/openbox-sdk`.
   - During development it may resolve from local `../openbox-sdk-ts`.
   - Before release it must resolve from a packed or published package, not a
     sibling path.
2. Keep public Mastra exports stable:
   - `withOpenBox`
   - workflow wrappers
   - agent wrappers
   - tool wrappers
   - public config and client import paths where possible

3. Replace shared primitives behind compatibility wrappers:
   - config parsing delegates to `OpenBoxConfig`
   - identity/signing delegates to base identity module
   - `OpenBoxClient` delegates to base client
   - verdict/result/approval parsing delegates to base contracts
   - event payload building delegates to base event/wire modules
   - span normalization delegates to base span/wire modules
   - runtime evaluation delegates to `OpenBoxRuntime`

4. Keep Mastra-owned behavior:
   - mapping Mastra workflows/agents/tools to `ActivityContext`
   - deciding workflow and activity boundaries
   - Mastra-native error classes
   - Mastra A2A lifecycle and metadata mapping
   - Mastra public ergonomics

5. Remove duplicated Mastra internals only after tests pass.
6. Document any intentional behavior changes.

## Acceptance Criteria

- Mastra tests pass after expected fixture updates.
- Mastra public exports remain stable or have documented migration notes.
- Mastra code no longer owns shared OpenBox signing/client/result/event/span
  behavior.
- Base conformance kit runs inside the Mastra repo.
- Any remaining local hook implementation is documented as temporary and has a
  follow-up phase.

## Explicit Non-Goals

- Do not migrate CopilotKit in this phase.
- Do not rewrite Mastra public API unnecessarily.
- Do not carry incorrect Mastra behavior into base SDK to preserve tests.
- Do not delete local Mastra modules until their replacement has contract tests.

## Test Focus

- existing `withOpenBox` integration
- workflow wrapper behavior
- tool wrapper behavior
- agent identity headers
- approval flow
- block/halt errors
- A2A / multi-agent metadata
- package export surface
- npm pack
