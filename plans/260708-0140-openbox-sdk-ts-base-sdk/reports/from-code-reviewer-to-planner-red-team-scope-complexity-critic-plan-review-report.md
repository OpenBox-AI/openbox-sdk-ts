# Red-Team Plan Review — Scope & Complexity Critic (YAGNI)

**Reviewer role:** Scope & Complexity Critic + Contract Verifier (hostile).
**Plan:** `plans/260708-0140-openbox-sdk-ts-base-sdk/` (plan.md + phase-01..07).
**Verdict:** Plan is well-grounded on contracts (golden fixture real, wire decisions
sourced) but **materially over-scoped for its stated goal**. The stated goal is
"unblock the Mastra migration" — verified evidence shows ~half of Phase 5 builds
preflight capability no existing consumer uses, one v1 module (`otel`) has zero
in-plan consumer, and two public API surfaces are committed before a second
consumer exists. Two findings challenge user-confirmed decisions (labeled).

Severity for a YAGNI critic: **Critical = scope that likely blows the schedule /
sinks the release**; High = wasted build + risk; Medium = surface/contract drift.

---

## Finding 1: DB preflight targets (pg/redis/mysql/mongodb) are NOT on the critical path to the plan's own goal — Mastra never preflight-blocks databases

**Severity:** Critical — *challenges the user-confirmed "broader instrumentation" decision (surface to user, do not auto-apply).*

**Location:** phase-05 lines 18-19, 37-47 (all 7 targets in v1); phase-06 line 7
(`dependencies: [4, 5]`); plan.md lines 42-45 (locked broader scope).

**Flaw:** The plan's Definition of Done is "unblock the Mastra migration" (plan.md
line 40, 209-218). Phase 6 is the only consumer in-plan. But the one consumer
**does not preflight-block databases at all** — it only emits DB telemetry via
OTel hooks (post-queue). Mastra's sole custom *blocking* patches are `patchFetch`,
`patchFileIo`, and the `traced` function wrapper. Every DB driver (pg/mysql/
mysql2/mongodb/mongoose/redis/ioredis/knex/oracledb/cassandra/tedious) is wired
through OTel instrumentors that emit a hook span *after the op is queued*. So to
reach Mastra parity, the base SDK needs preflight for exactly **3 targets**
(fetch, fs, function) — not 7. The 4 DB preflight wrappers are speculative
capability with no consumer.

Compounding: Phase 6 declares a hard `dependencies: [4, 5]` (needs Phase 5), yet
plan.md line 170-172 says Tier B "may lag Phase 6 without blocking it." The Phase
6→Phase 5 coupling is unjustified: Mastra consumes none of Phase 5's DB preflight.

**Failure scenario:** Team spends the back half of the release building bespoke,
per-driver prototype patches (pg/redis/mysql/mongodb) that Mastra will not call.
The Mastra migration — the actual deliverable — waits behind instrumentation it
does not use, and the release slips on gold-plating.

**Evidence:**
- `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:814` `patchFetch` (custom block), `:1133` `patchFileIo` (custom block), `:276` `traced` (function wrapper). These are the ONLY custom blocking patches.
- Same file `:457` `selectDatabaseInstrumentations`, `:535` `createDatabaseInstrumentationConfig`, `:735` `emitDatabaseHookGovernance` — DB path emits a hook span from OTel request/response hooks; no custom pre-execution patch.
- `research/researcher-04-node-instrumentation-preflight-report.md:47`: "mastra-sdk uses OTel's createDatabaseInstrumentationConfig() ... to **emit telemetry**, NOT to block ... databases use OTel-only observe pattern."
- `phase-06-mastra-adapter-migration.md:7` `dependencies: [4, 5]` vs `plan.md:170-172` (Tier B may lag).

**Suggested fix:** v1 base instrumentation = **fetch + fs + function preflight**
(Mastra parity) + **DB as OTel-telemetry-only** (Mastra parity). Defer *true* DB
preflight (pg/redis/mysql/mongodb custom wrappers) to a fast-follow gated on a
consumer that actually needs blocking DB governance. Drop `[5]` from Phase 6's
dependency; Phase 6 needs only Phases 1-4 + the 3 Tier-A wrappers.

---

## Finding 2: Phase 5 pulls researcher-04's explicitly-DEFERRED targets into v1, overriding the research it cites

**Severity:** High — *challenges the user-confirmed "broader instrumentation" decision (surface to user).*

**Location:** phase-05 lines 37-47 (Tier A = fetch/function/fs/redis/pg; Tier B =
mysql/mongodb, both in v1).

**Flaw:** Phase 5 cites researcher-04 as its grounding, but researcher-04's own
recommendation is v1 = **5 targets** (fetch, function, fs, redis, pg) with
**mysql + mongodb + streaming DEFERRED to v1.1/v2**. The plan re-tiers the
researcher's Tier-3 (deferred) items into "Tier B" *inside v1*. mongodb in
particular needs a hand-rolled `wrapt`-equivalent (Node has no `wrapt`), which the
researcher flagged as "optional if pymongo complexity not wanted in v1." The plan
adds the exact complexity the research said to avoid ("avoid complexity sprawl").

**Failure scenario:** mongodb Collection-CRUD wrapping (no `wrapt` in Node) and
mysql2 prototype patching consume days of the highest-variance phase to ship
capability the researcher recommended shipping later — for zero current consumer
(see Finding 1).

**Evidence:**
- `research/researcher-04-...report.md:93-94`: "Definite v1: fetch/undici, function wrappers, fs (promises only), redis ... Tricky v1: pg, mysql, mongodb (need custom wrappers)."
- `:305-307`: Tier 3 (DEFERRED, v2+) = "mysql / mysql2", "mongodb — wrapt Collection CRUD wrapper (**optional if pymongo complexity not wanted in v1**)", streaming.
- `:314-315`: "Tier 3 complexity ... can land in v2 without breaking v1 API ... **Avoid complexity sprawl: v1 ships 5 targets ... v2 adds streaming + full db suite**."
- Plan overrides this at `phase-05-...md:45-47` (Tier B mysql/mongodb in scope).

**Suggested fix:** Adopt researcher-04's tiering verbatim: v1 = fetch/function/fs
(+pg/redis only if Finding 1's cut is rejected). mysql + mongodb → fast-follow
`0.x`. If the user keeps all 7, add a schedule buffer to Phase 5 and split it into
5a (Tier A) / 5b (Tier B) so Tier B genuinely cannot block Phase 6.

---

## Finding 3: redis preflight self-contradicts the plan's own OTel principle and is unverified for Node

**Severity:** High

**Location:** plan.md line 151-152 (decision 15); phase-05 lines 32-34 ("Key
truth"), 41-43 (Tier A redis "OTel request_hook that can raise"), 73
(`redis-governance-wrapper.ts — OTel request_hook preflight`).

**Flaw:** The plan states as a blanket law that **OTel hooks cannot block**
("OTel hooks are observe-only (post-queue)"; "OTel requestHook fires after the op
is queued → cannot block"). It then lists redis as a *straightforward* Tier-A
preflight target implemented **via an OTel request_hook that raises**. That is a
direct internal contradiction. The supporting claim (Node's
`@opentelemetry/instrumentation-redis` `request_hook` fires pre-execution and can
abort) is asserted **by analogy to Python's** `RedisInstrumentor` request_hook —
it is not empirically verified for the Node instrumentor, and the same report says
the Node pg OTel `requestHook` is post-queue and cannot block. There is no reason
given why Node redis's hook is pre-execution while pg's is post-queue.

**Failure scenario:** If the Node redis OTel `request_hook` is post-queue (like
pg), redis has *no* blocking path. It either silently degrades to telemetry-only
(a governance hole — commands reach redis before BLOCK) or needs a bespoke
`redis`/`ioredis` client wrapper, adding surface the plan did not budget. Either
way "Tier A, solid v1" is false for redis.

**Evidence:**
- `plan.md:151-152` decision 15 (OTel observe-only).
- `phase-05-...md:32-34` "Key truth ... cannot block"; `:41-43` redis "(OTel request_hook that can raise)"; `:73` "OTel request_hook preflight".
- `research/researcher-04-...report.md:43` pg OTel requestHook "fires AFTER query queued; cannot block" vs `:89`/`:301` redis "✅ YES (via OTel hook)" — asymmetry unexplained/unverified.
- Python analog only: `openbox-sdk-python/openbox_core/instrumentation/db.py:400` `_redis_request_hook`, `:452` `request_hook=...`.

**Suggested fix:** Before counting redis as v1: write a 20-line spike asserting the
Node redis instrumentor `request_hook` runs *before* the command hits the socket
and that throwing aborts it. If not, either add a custom `redis`/`ioredis` wrapper
(budget it) or move redis to telemetry-only + fast-follow. Remove the blanket
"OTel cannot block" law or carve an explicit, verified exception.

---

## Finding 4: base `otel/` module (OpenBoxSpanProcessor) has zero in-plan consumer — gold-plating

**Severity:** High

**Location:** phase-05 lines 80-81 (`src/otel/index.ts` — "optional
`OpenBoxSpanProcessor` ... observe-only; NOT used for blocking"); phase-06 line 46
(Mastra "Stays in Mastra": `src/otel/setup-openbox-opentelemetry.ts`).

**Flaw:** The base `otel` module is explicitly *optional* and *not used for
blocking*. The base preflight/completed path runs through
`runtime.completed()`→gate→client (phase-05 step 2, line 96), not through the OTel
SpanProcessor. Meanwhile the only migrating consumer (Mastra) **keeps its own**
3,275-LOC OTel setup and span processor. So base `otel/` is a module built for a
consumer that doesn't adopt it, delivering the one capability (completed
telemetry) the core value prop (preflight) explicitly bypasses.

**Failure scenario:** Effort spent porting/maintaining an OTel SpanProcessor +
exports subpath that ships in the tarball, carries backwards-compat obligations,
and is imported by nobody in the release.

**Evidence:**
- `phase-05-...md:80-81` (optional, observe-only, not for blocking); `:96` completed() via finally/runtime.
- `phase-06-...md:46` Mastra keeps `src/otel/setup-openbox-opentelemetry.ts`.
- `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts` = 3,275 LOC (Mastra's own OTel, retained).

**Suggested fix:** Cut `otel/` from v1 scope and its `./otel` export. Reintroduce
when a consumer needs base-provided completed telemetry. Python having an `otel/`
module is not justification — Python's is internal wiring, not a shipped API a TS
consumer here adopts.

---

## Finding 5: Phase 5 & 6 effort estimates (4-6d each) are optimistic to the point of schedule risk

**Severity:** High

**Location:** phase-05 line 6 (`effort: "4-6d"`); phase-06 line 7 (`effort: "4-6d"`).

**Flaw:** Phase 5 (4-6d) proposes bespoke prototype preflight for **7 targets**
(more blocking coverage than Mastra has today) + 4 family span builders + privacy
redaction/truncation + an OTel processor + recursion guard + idempotent
install/teardown + per-target "op did not run on BLOCK" tests. Ground-truth
volume: Python's instrumentation is ~2,024 LOC (`http 840 + db 689 + file 239 +
function 121 + manager 135`) **while leveraging OTel instrumentors**; Mastra's
single instrumentation file is 3,275 LOC. The plan proposes to *exceed* both (true
DB blocking that neither fully has) in 4-6 days, without OTel instrumentor reuse
for the DB targets (decision 15 forbids it). Phase 6 (4-6d) rewires
`wrap-agent.ts` (2,495+ LOC) and `activity-runtime.ts` (890+ LOC) onto the base
runtime while keeping **98 public symbols** stable and re-verifying 5 flagged
surfaces.

**Failure scenario:** The two largest phases overrun, and because Phase 6 is
hard-gated behind Phase 4 *and* coupled to Phase 5 (Finding 1), slippage
cascades into the release.

**Evidence:**
- Python LOC: `openbox_core/instrumentation/{http.py:840, db.py:689, file.py:239, function.py:121, manager.py:135}`.
- `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts` 3,275 LOC.
- `openbox-mastra-sdk/src/mastra/wrap-agent.ts` (WorkflowSpanBuffer used at `:2495`), `src/governance/activity-runtime.ts` (`:890`).
- Mastra public surface = 98 exported symbols (8 barrels, `src/index.ts` `export *`).

**Suggested fix:** Split Phase 5 into 5a (Tier A) / 5b (Tier B) with independent
efforts; treat "4-6d" as Tier-A-only. Re-estimate Phase 6 against the real LOC of
`wrap-agent.ts` + `activity-runtime.ts`. If Findings 1-2 land, Phase 5 shrinks to
3 targets and the estimate becomes credible.

---

## Finding 6: Contract Verifier — Phase 6 "shared surfaces" enumeration DROPS a public export (`workflow-span-buffer`)

**Severity:** Medium

**Location:** phase-06 lines 38-42 (delegate list), 44-46 (stays-in-Mastra list).

**Flaw:** Phase 6 claims to enumerate the shared surface, but the enumeration is by
file and is incomplete. Mastra's public surface is **98 symbols across 8 barrels**
(`src/index.ts` does `export *`). The `types` barrel re-exports **6** files; the
plan's delegate list names only **5** (`verdict, governance-verdict-response,
guardrails, errors, workflow-event-type`) and **silently omits
`types/workflow-span-buffer.ts`** (exports `WorkflowSpanBufferInit` +
`WorkflowSpanBuffer`, publicly re-exported at `types/index.ts:7`). It appears in
neither the "delegate" nor the "stays in Mastra" list. It is consumed only by
Mastra-retained files, so it legitimately *stays* — but it imports `Verdict` from
`verdict.ts`, which the plan **moves to base**. So post-migration, a retained
Mastra file must import `Verdict` from the base package: an unstated
cross-boundary dependency the enumeration should have surfaced.

**Failure scenario:** During migration, `verdict.ts` is deleted/relocated to base;
`workflow-span-buffer.ts` (still in Mastra, unlisted, forgotten) fails to compile
on its `import { Verdict } from "./verdict.js"`, or a stale local `Verdict` copy
silently diverges from the base enum.

**Contract Verifier output — Mastra public surface (`export *` from `src/index.ts`):**
98 symbols across `client, config, identity, types, mastra, otel, span, governance`
(governance barrel is `export {}` — internals not public). Plan coverage:
- delegate: client/openbox-client, config/openbox-config, identity/agent-identity, types/{verdict, governance-verdict-response, guardrails, errors, workflow-event-type} — **covered**.
- stays: mastra/{a2a-peer, event-metadata, wrap-tool, wrap-agent, wrap-workflow, with-openbox}, otel/setup-openbox-opentelemetry, span/openbox-span-processor — **covered**.
- **MISSING:** `types/workflow-span-buffer.ts` (`WorkflowSpanBuffer`, `WorkflowSpanBufferInit`).

**Evidence:**
- `openbox-mastra-sdk/src/types/index.ts:7` `export * from "./workflow-span-buffer.js";`.
- `openbox-mastra-sdk/src/types/workflow-span-buffer.ts:3` `WorkflowSpanBufferInit`, `:17` `class WorkflowSpanBuffer`, `:1` `import type { Verdict } from "./verdict.js"`.
- Consumers (all Mastra-retained): `src/mastra/wrap-agent.ts:25`, `src/governance/activity-runtime.ts:21`, `src/span/openbox-span-processor.ts:7`.
- Plan delegate list `phase-06-...md:39-40` (5 type files, buffer absent).

**Suggested fix:** Add `types/workflow-span-buffer.ts` to "stays in Mastra" and
note it must import `Verdict` from `@openbox-ai/openbox-sdk` post-migration. Do a
symbol-level diff of all 98 exports against the delegate/stays lists before Phase 6
starts; "update the type files" is not a complete contract.

---

## Finding 7: Conformance kit as a PUBLIC exported subpath is speculative generality (no 2nd consumer exists)

**Severity:** Medium

**Location:** phase-04 lines 62, 81, 93 (build `src/conformance`, export
`./conformance`, "importable by an external test file"); plan.md line 214 (DoD
"importable conformance kit"); phase-07 line 82-83 (follow-up "shared conformance
fixture package across all TS SDK repos").

**Flaw:** The conformance kit is designed and shipped as a **public package export**
(in the exports map, in the tarball, with backwards-compat obligations) whose value
proposition is cross-SDK reuse. But the only in-plan consumer is Mastra (Phase 6
step 6). CopilotKit and LangChain are explicitly deferred, and CopilotKit today
consumes **zero** base packages — its only dependency is `zod`, and it uses its own
local `../types`, `../client`, `../spans/span-buffer`, `../governance/context`.
Building an importable/publishable kit for consumers that do not exist is textbook
speculative generality. A single same-repo consumer (Mastra) is served by internal
test fixtures, not a public API.

**Failure scenario:** The `./conformance` subpath + `FakeCore`/`FakeAdapter` API is
frozen into the public contract in v1, then reshaped when the *real* second
consumer finally lands — a breaking change to an API that never needed to be public.

**Evidence:**
- `phase-04-...md:62,81,93` (kit built, exported, external-import smoke test).
- `plan.md:214` DoD; `phase-07-...md:82-83` follow-up (future cross-repo package).
- `openbox-copilotkit-sdk/package.json` dependencies = `{ "zod" }` only; imports are local (`src/copilotkit/types.ts:2` `../spans/span-buffer.js`, `src/config/openbox-config.ts:3` `../client/index.js`, etc.) — not a base consumer.

**Suggested fix:** Keep the conformance kit as an **internal** test utility that
Mastra imports via a test-only path / devDependency in v1. Promote it to a public
`./conformance` export (and a shared package) only when a second consumer is
actually being migrated. Python having a `conformance/` module is internal-support
precedent, not justification for a public TS API.

---

## Finding 8: 16 public subpath exports committed in v1 for a single consumer; "mirrors Python's 15-module layout" is imprecise

**Severity:** Medium

**Location:** phase-01 lines 67-70 (exports map); plan.md lines 79-81 ("Module/
export layout mirrors Python ... contracts, wire, spans, gate, hooks, runtime,
context, adapters, errors, client, config, identity, instrumentation, otel,
conformance").

**Flaw:** Phase 1 commits **16 public subpath exports** (`.`, `./adapters`,
`./client`, `./config`, `./conformance`, `./context`, `./contracts`, `./errors`,
`./gate`, `./hooks`, `./identity`, `./instrumentation`, `./otel`, `./runtime`,
`./spans`, `./wire`). Every subpath is a public API surface with a backwards-compat
burden, committed *before* any consumer proves it needs that granularity. The one
planned consumer (Mastra) imports a handful; CopilotKit imports none. Additionally,
the "mirrors Python" claim is loose: Python has **no** top-level `spans/` (span
projection lives in `wire/core_span.py`), and Python's real top level includes
`approvals.py`, `serialization.py`, `sdk_version.py`, and `validation/` — which the
15-item list folds away or drops. So it is neither a faithful mirror nor a
consumer-driven surface; it is a pre-committed 16-door API.

**Failure scenario:** Subpaths like `./gate`, `./hooks`, `./context`, `./spans`,
`./wire` ship as public entry points, get imported by no one, yet must be kept
stable across versions or broken with a major bump — API-maintenance tax for unused
doors.

**Evidence:**
- `phase-01-...md:67-70` (16 code subpaths + `./package.json`).
- `plan.md:79-81` "mirrors Python" claim.
- Python top level (`ls openbox-sdk-python/openbox_core/`): includes `approvals.py`, `serialization.py`, `sdk_version.py`, `validation/`, and `wire/` (holds `core_span`); **no** top-level `spans/`. Plan adds `spans`, drops the four above from its 15-list.

**Suggested fix:** Export `.` plus only the subpaths Mastra actually imports in
Phase 6; add subpaths on demand as consumers appear. Internal `src/` module
granularity can mirror Python freely — that is free; **public `exports` entries are
not**. Correct the "mirrors Python" wording to "internal modules inspired by
Python; public exports are consumer-driven."

---

## What the smallest viable base SDK is (MVP cut)

To unblock the Mastra migration (the DoD), v1 needs:
- Phases 1-4 (scaffold, contracts/config/identity/client, event/wire/span/gate,
  runtime/adapter/conformance-as-internal-fixtures). **Keep.**
- Phase 5 reduced to **fetch + fs + function preflight** (exact Mastra blocking
  parity) + DB-as-OTel-telemetry (Mastra parity). **Cut pg/redis/mysql/mongodb
  custom preflight, `otel/` module, and streaming to fast-follow.**
- Phase 6 depends on Phases 1-4 + Tier-A only (drop the `[5]` DB coupling).
- Phase 7 unchanged.

Everything cut is a clean fast-follow that does not break the v1 public API if
Finding 8's export-trimming is applied.

## Fairly acknowledged (not attacked)

- The signing golden fixture is **real** (`openbox-sdk-python/tests/signing/
  golden_temporal_signed_request.json` + `test_golden_signing.py` + generator).
  Phase 2's byte-exact de-risking is grounded; not flagged.
- Python *does* instrument redis + pymongo + sqlalchemy + dbapi + asyncpg (via OTel
  instrumentors), so "TS is broader than Python" is **false** at the target level —
  the real scope gap is that TS cannot reuse OTel instrumentors for *blocking*
  (decision 15) and must hand-roll each DB wrapper, and that the *consumer* (Mastra)
  blocks on none of them (Findings 1-2).
- `adapters/` (FrameworkAdapter + CoreAdapter) is the genuine migration seam Mastra
  uses; **not** gold-plating.
- The plan already hedges streaming (out of preflight) and Tier-B lag — but that
  hedges *timing*, not *scope*; it still commits to building all of it.

## Unresolved questions (for planner/user)

1. Findings 1 & 2 challenge the user-confirmed "broader instrumentation" decision.
   Keep all 7 preflight targets in v1 (accept schedule risk + no current consumer),
   or adopt the fetch/fs/function MVP + DB-telemetry and fast-follow the rest?
2. Is there a *known* near-term consumer that needs blocking DB governance
   (pg/redis/mysql/mongodb)? If yes, Findings 1-2 soften. If no, they stand.
3. Redis (Finding 3): accept a spike to verify Node OTel `request_hook` timing
   before committing redis to v1, or move it to fast-follow now?
