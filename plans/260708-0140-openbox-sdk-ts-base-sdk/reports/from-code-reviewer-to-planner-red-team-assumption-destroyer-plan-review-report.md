# Red-Team Plan Review — Assumption Destroyer / Scope Auditor

**Plan:** `plans/260708-0140-openbox-sdk-ts-base-sdk` (plan.md + phase-01..07)
**Reviewer role:** Hostile — Assumption Destroyer (unstated deps, false "will work", missing error paths) + Scope Auditor (state additions, lifetime/isolation, unverified premises).
**Method:** Every finding traced to ground-truth source in `openbox-sdk-python`, `openbox-core`, `openbox-mastra-sdk`. No-evidence findings rejected.

**Verdict:** 6 findings. 1 Critical, 3 High, 2 Medium. The plan's central risk mitigation (golden fixture) does not prove what the plan claims, and two required components/premises (ApprovalPoller, redis-blocks-via-OTel) are unscoped or contradicted by the plan's own text.

Premises verified GOOD (no finding, stated for the record): Core `end_time` non-pointer `int64` / `duration_ns *int64,omitempty` null→0 is wire-safe (`governance.go:272-274`, `storage_spans.go:104-108` duration is nil-safe, no `.rego` reads them); config env resolution `{PREFIX}_{SUFFIX} > OPENBOX_{SUFFIX} > default` matches `config.py:47,182-185` and `_ENV_FIELDS`; Mastra tooling version pins (tsup 8.5 / vitest 3.2 / ts 5.9 / eslint 9 / ts-eslint 8.42 / zod 4.1 / otel 2.7) and coverage thresholds (70/90/75/75) and tsconfig flags all match `openbox-mastra-sdk/package.json` + `tsconfig.json` + `vitest.config.ts`; `CoreAdapter` IS the runtime default (`runtime.py:53`).

---

## Finding 1: The golden fixture proves TS==Python, NOT TS==Core — it is falsely sold as the Core "empirical tiebreaker," and the plan simultaneously drops the one real Python→Go conformance test

**Severity:** Critical

**Location:** plan.md:88-99 (Contract Decision 1); phase-02:38-43; plan.md Risks + Definition Of Done ("golden fixture is the gate")

**Flaw:** The golden fixture is generated entirely inside the Python ecosystem: `generate_golden_fixture_from_temporal_signer.py:98` hand-computes the canonical string with `"\n".join([METHOD, PATH, TIMESTAMP, NONCE, body_sha256])`, and `:91-93` produces the signature via the **Temporal Python** signer using `cryptography`. `test_golden_signing.py:44-75` then checks the **base Python** SDK reproduces those bytes. Core's Go code never participates. Porting this fixture to TS proves TS reproduces Python bytes — it is structurally incapable of arbitrating the Python-vs-Core disagreement that Decision 1 invokes it to settle. The trailing-newline question is actually resolved by reading Core source (`services/agent.go:94-100` also uses `strings.Join(..., "\n")`, no trailing newline — so they agree), not by the fixture. Worse: Python's *actual* cross-language safety net is `tests/wire/test_backend_compat.py:34`, which shells out to a Go program that unmarshals the wire JSON into Core's real `SpanData` struct (`:56` asserts `end_time == 0`, `:57` `has_duration_ns is False`). The plan ports the weaker Python-only signing fixture and does **not** port the stronger Go-unmarshal test (grep for `backend_compat`/`SpanData unmarshal`/`go run` across all plan files returns nothing).

**Failure scenario:** Core changes (or already differs in) any signed-material detail the reports disagreed on — trailing newline, timestamp normalization, header casing. All three Python artifacts and the TS port agree with each other and stay green; every live request to Core fails `body_sha256`/signature verification (`services/agent.go:167,191`) in production. The plan's DoD ("golden/parity fixtures proving parity with python + core") is satisfiable while Core parity is unproven. Separately, span-wire drift vs Go (the exact thing `test_backend_compat.py` guards) is unguarded in TS.

**Evidence:**
- `openbox-sdk-python/tests/signing/generate_golden_fixture_from_temporal_signer.py:91-98` (Temporal-Python signer + hand-joined canonical)
- `openbox-sdk-python/tests/signing/test_golden_signing.py:32-41,54-62` (base-Python self-check only)
- `openbox-core/internal/services/agent.go:94-100` (Core canonical — agreement proven by source, not fixture)
- `openbox-core/internal/services/agent_test.go:871` (`ed25519.GenerateKey(rand.Reader)` — Core's only identity test generates its OWN keypair; never ingests the fixture seed `AAECA...` or signature `xLV65W0Pv...`)
- `openbox-sdk-python/tests/wire/test_backend_compat.py:34,56-57` (real Python→Go unmarshal conformance — not ported)
- plan.md:99 ("The golden fixture is the empirical tiebreaker")

**Suggested fix:** Reframe Decision 1: the golden fixture is a Python-parity **regression anchor**, not a Core tiebreaker. Add a Core-parity gate that actually involves Go — either (a) port `test_backend_compat.py` (spawn a tiny Go harness that unmarshals TS-produced payloads into `content.SpanData` and verifies a TS-produced signature via `BuildAgentIdentityCanonicalRequest` + `ed25519.Verify`), or (b) a live/dockerized Core round-trip in Phase 4 conformance. Note in the ledger that `+00:00`-vs-`Z` and trailing-newline only affect *Python byte-parity*: Core rebuilds canonical from the literal `X-OpenBox-Agent-Timestamp` header (`services/agent.go:150,182`), so it accepts any internally-consistent signer — the real Core-rejection risk is internal hash/sign/transmit inconsistency (Decision 3), not divergence from Python.

---

## Finding 2: `ApprovalPoller` is unscoped — the default `CoreAdapter` with no poller REJECTS approvals (never pends), so Phase 4's approval-matrix gate cannot pass as written

**Severity:** High (blocks the Phase 4 conformance gate that unblocks Phase 6)

**Location:** plan.md:75-81 (module layout — no `approvals`); phase-04:56-57,90-94; phase-02:79 (`pollApproval` only)

**Flaw:** Python has a dedicated top-level module `approvals.py` whose `ApprovalPoller` owns "the poll loop (interval/backoff), expiry handling, and timeout budget" (`approvals.py:1-5,28-97`). `CoreAdapter.handle_approval` raises `ApprovalRejectedError` when `self._poller is None or not result.approval_id` (`adapters/base.py:85-89`) — i.e., the default adapter **without a poller hard-rejects** a `REQUIRE_APPROVAL` verdict; it does not return pending/allow. The plan's "15-module layout mirrors Python" list (plan.md:78-80) omits `approvals` entirely; `ApprovalPoller` appears exactly once (phase-04:57 "optional `ApprovalPoller`") with zero create-list entry, implementation step, or interface spec. `HitlConfig` (poll_interval_ms/max_wait_ms, `config.py`) exists solely to configure this missing component. Phase 2 ships only the low-level single-shot `pollApproval` POST, not the orchestration loop.

**Failure scenario:** Phase 4 success criterion "approval matrix (pending/rejected/approved/expired) behaves per strict parsing" (phase-04:91) is unreachable via the base's default `CoreAdapter`: with no poller it can only reject, so "pending"/"approved"/"expired" outcomes have no code path. Because Phase 4 is the hard gate for Phase 6, the whole pipeline stalls, or the implementer improvises an out-of-plan poller. If the TS `CoreAdapter`-no-poller is instead made to return pending/null (to mimic a "stub" and satisfy Decision 6's "empty/unknown → pending, never allow"), it silently **diverges** from Python's fail-safe reject and lets a require-approval operation proceed unblocked.

**Evidence:**
- `openbox-sdk-python/openbox_core/approvals.py:1-5,28,89-97` (ApprovalPoller.await_decision loop)
- `openbox-sdk-python/openbox_core/adapters/base.py:82-100` (no poller ⇒ `raise ApprovalRejectedError`)
- `openbox-sdk-python/openbox_core/runtime.py:53,105-109` (default CoreAdapter; async path drives `adapter.handle_approval`)
- plan.md:78-80 (layout omits `approvals`); phase-04 create-list has no poller module

**Suggested fix:** Add an `approvals` module to the layout and a Phase 4 create-list entry implementing `ApprovalPoller` (interval/backoff/expiry/timeout budget over `client.pollApproval`). Explicitly document that base `CoreAdapter`-without-poller **rejects** `REQUIRE_APPROVAL` (matching `base.py:87`) and that pending/approved/expired require a poller or the `FakeAdapter`. State clearly which adapter the Phase 4 approval matrix runs against.

---

## Finding 3: The `traceId → context` map is a process-global singleton populated out-of-band by a passive span processor with no unregister path — the plan's "guaranteed reset / no leak" premise FAILS, with cross-request context-bleed risk in a long-lived Node process

**Severity:** High

**Location:** plan.md:145-149 (Decision 13); phase-04:31-36,72-73,88-89; phase-05:80-81 (`OpenBoxSpanProcessor` "observe-only")

**Flaw (Scope Auditor — state addition + lifetime/isolation):** `_default_store = ContextStore()` is a module-level singleton (`context.py:152`) holding a plain dict `_trace_to_context` (`context.py:71`). `activity_scope` guarantees reset of the ContextVar **and** `unregister_trace` for the single root `trace_id` it was handed (`context.py:202-205`). But the map's stated purpose (Decision 13; docstring `span_processor.py:34-35`) is to "additionally catch spans whose traces were minted after binding" — and that path is `OpenBoxSpanProcessor.on_start`, which calls `register_trace` for any new trace_id under a bound context (`span_processor.py:44-45`), while `on_end` is "PASSIVE by contract — never … raises" and performs **no** unregister (`span_processor.py:49-56`). So exactly the entries the map exists for have no cleanup. The plan's Phase 5 casts `OpenBoxSpanProcessor` as pure "completed telemetry (observe-only)" and never mentions trace registration or cleanup, and Phase 4's leak test only exercises the `activityScope` root trace.

**Failure scenario:** Python's per-worker/short-lived process model masks this. A Node service is one long-lived process serving many concurrent tenants. Every child span with a fresh trace_id minted during any bound activity leaks a `traceId→ActivityContext` entry that is never removed; the map grows unbounded (a slow leak of `ActivityContext` including `session_id`/`agent_name`/metadata). Worse, instrumentation resolving context via `contextForTrace` for a later request that reuses/collides a canonicalized trace key can retrieve a **stale other-tenant context**, governing an operation under the wrong identity. The plan asserts the opposite ("Context always resets after success and error; no-bound-context ⇒ hook skip", phase-04:89).

**Evidence:**
- `openbox-sdk-python/openbox_core/context.py:152` (process-global singleton), `:71` (map), `:202-205` (scope resets only its own trace_id)
- `openbox-sdk-python/openbox_core/otel/span_processor.py:44-45` (out-of-band register), `:49-56` (on_end never unregisters)
- plan.md:147-149 + phase-04:88-89 ("guaranteed reset … no leak")

**Suggested fix:** Either drop the passive registration path (accept that only `activityScope`-registered roots are correlated) or give the trace map a bounded lifetime: an LRU/TTL cap, a per-run sweep tied to `ActivityCompleted`, and mandatory unregister keyed off span/trace end. Add a Phase 4 test that mints child spans with new trace_ids, drives many "requests" through the singleton, and asserts `traceMapSize()` returns to baseline and no cross-context resolution occurs. Reconcile Phase 5's "observe-only" processor description with the fact that Python's processor mutates shared state.

---

## Finding 4: Redis preflight relies on "OTel `request_hook` can block," which contradicts the plan's own key-truth and researcher-04's Node `pg` finding — no `instrumentation-redis` dependency and no custom wrapper are scoped

**Severity:** High

**Location:** phase-05:32-33 (key truth), 42-45 (Tier A redis = OTel), 73 (`redis-governance-wrapper.ts` "OTel request_hook preflight"), 107 (success criterion)

**Flaw:** Phase 5's foundational "key truth" is "OTel `requestHook` fires after the op is queued → cannot block" (phase-05:32-33), and researcher-04:43 confirms this for Node `pg` ("Hook fires AFTER query queued; cannot block ❌"). Yet Phase 5 lists redis in **Tier A (straightforward)** delivered via "OTel `request_hook` that can raise" (phase-05:42). The only evidence for redis-can-block is researcher-04:56 — which is drawn from the **Python** SDK (`openbox_core/instrumentation/db.py` `install_redis`, using the Python `opentelemetry-instrumentation-redis` request_hook that fires pre-send). The plan is porting to Node, where the redis OTel package is a different implementation with unverified hook timing; the plan itself demonstrates Node OTel DB hooks trend post-queue (pg). Additionally, using any OTel redis hook requires `@opentelemetry/instrumentation-redis`/`-ioredis` as a dependency — but Phase 1 pins only `@opentelemetry/{api,resources,sdk-trace-base}` and explicitly "Remove … framework OTel instrumentations" (phase-01:44-45), and the Phase 1 root-import-safety test forbids heavy OTel modules. (Mastra actually ships `@opentelemetry/instrumentation-redis ^0.55.0`, which the plan drops.)

**Failure scenario:** The team builds `redis-governance-wrapper.ts` around a Node OTel redis `requestHook`, assumes it blocks, and ships. In Node the hook fires post-dispatch (as pg does); a BLOCK verdict raises *after* the command already reached the server. The Phase 5 success criterion "Started-hook BLOCK/HALT demonstrably prevents the real operation for … redis" (phase-05:107) fails late, and redis actually needs a custom `RedisClient.prototype.sendCommand`/`.multi` wrapper that was never scoped — plus a re-added `instrumentation-redis` dependency that trips the Phase 1 import-safety gate.

**Evidence:**
- phase-05:32-33 vs phase-05:42 (self-contradiction: OTel can't block / redis blocks via OTel)
- research/researcher-04-...:43 (Node pg OTel requestHook cannot block) vs :56 (redis "can raise" — Python `db.py` lines 400-421)
- `openbox-sdk-python/openbox_core/instrumentation/db.py:1-4,27` + `manager.py:94` (`install_redis` is Python-OTel-hook based)
- phase-01:41-45 (only 3 OTel deps; "Remove … OTel instrumentations"); `openbox-mastra-sdk/package.json` (`instrumentation-redis ^0.55.0` dropped)

**Suggested fix:** Verify the Node redis OTel hook's timing empirically before committing redis to Tier A; if it is post-dispatch (likely, matching Node pg), scope a custom `sendCommand` prototype wrapper like pg's. Reconcile Phase 1's dependency list with Phase 5's OTel usage: either add the specific `@opentelemetry/instrumentation-*` deps you actually use (and whitelist them in the import-safety test as lazy-loaded), or commit to custom wrappers everywhere and delete the "redis via OTel hook" language.

---

## Finding 5: Phase 5 Tier-A/B blocking depends on driver prototype shape that the plan's own Open Question #5 marks UNRESOLVED — a hard success criterion gated on an open question

**Severity:** Medium

**Location:** phase-05:41-46 (pg `Client.prototype.query`; mysql `Connection.prototype.query`; mongodb Collection CRUD), 107,111-115 (success criteria); plan.md:207 (Open Question 5)

**Flaw (Assumption Destroyer — unstated/unresolved dependency):** Preflight for pg/mysql/mongodb depends entirely on the installed driver exposing a stable, patchable prototype method at a known path (`Client.prototype.query`, etc.). researcher-04:143 asserts this is "true for pg, mysql2, redis, mongodb via ESM compat," but :148-161 immediately warns that import ordering (driver client created before `init`) silently defeats the patch. The plan lists "DB driver version support policy (e.g. `pg` 14+) for prototype patching" as **unresolved** Open Question 5 (plan.md:207), yet still classifies pg as Tier A "straightforward wrappers" (phase-05:41) with a mandatory success criterion that BLOCK "demonstrably prevents the real operation for … pg" (phase-05:107). You cannot both flag the prototype/version contract as an open question and gate a phase on it working.

**Failure scenario:** A supported `pg`/`mysql2`/`mongodb` version reshapes its export (e.g., ships native ESM with frozen exports, or moves `query` off the prototype). The patch becomes a silent no-op — governance believes it is enforcing, but every DB op runs unblocked. This is the worst failure mode: fail-open with a green test suite (which patched a pinned dev version).

**Evidence:**
- plan.md:207 (Open Question 5 unresolved) vs phase-05:41,107 (pg Tier A + hard blocking criterion)
- research/researcher-04-...:143 (prototype-exposed assumption), :148-161 (import-order breaks it)
- `openbox-sdk-python/openbox_core/instrumentation/db.py:305-358` (Python patches `asyncpg.Connection._execute` — a different, Python-specific funnel; not evidence for Node driver prototypes)

**Suggested fix:** Resolve Open Question 5 before Phase 5 sets pg/mysql/mongodb success criteria: pin exact supported major versions per driver, add a startup assertion that the target prototype method exists and is the SDK's wrapper (fail-loud, not fail-open, when patching a client created pre-init), and add a test that simulates the driver-loaded-before-init ordering to prove the diagnostic fires.

---

## Finding 6: Phase 3 "full common-field matrix" omits real Core `SpanData` fields (`request_body`/`response_body`/`request_headers`/`response_headers`/`semantic_type`), weakening body-level governance; and the canonical-builder source citation points at the wrong file

**Severity:** Medium

**Location:** phase-03:41-51 (SpanData field matrix), plan.md:140-141 (Decision 11 "Full common-field matrix"); phase-03:110,119 ("matrix tests pin exact wire keys"); plan.md:93 + phase-03:41,84 (source citation)

**Flaw:** Core's `SpanData` struct carries, as **common** (not family-specific) fields, `RequestHeaders`, `ResponseHeaders`, `RequestBody`, `ResponseBody`, `SemanticType`, `AttributeKeyIdentifiers`, plus `Data` (`governance.go:278-289`). The plan's Phase 3 common matrix lists only through `hook_type`/`error` and gives the HTTP family as just `http_method`/`http_url`/`http_status_code` (phase-03:42-48) — omitting `request_body`/`response_body`/`request_headers`/`response_headers`/`semantic_type`. These are omitempty, so omission is wire-*safe*, but Core governance/guardrails inspect request/response bodies; a TS SDK that never populates `request_body`/`response_body` silently under-reports the exact content policies act on. Meanwhile the plan claims a "Full common-field matrix" whose tests "pin exact wire keys." Corroborating the layout-fidelity problem in Finding 2: the "mirrors Python's 15 modules" list also drops `approvals`. Separately, plan.md:93 cites the canonical builder as `agent.go:93 BuildAgentIdentityCanonicalRequest`; the real builder is at `internal/services/agent.go:93`, but `internal/content/agent.go:93` (the same directory the plan's SpanData citations point to via `content/governance.go`) is `GetFlagThreshold` — an implementer will open the wrong file.

**Failure scenario:** HTTP/DB instrumentation populates only method/url/status; a Core guardrail that scans response bodies for PII or a policy keyed on `semantic_type` receives nulls from the TS SDK, so governance that works for Python silently passes traffic under TS. "Matrix tests pin exact wire keys" gives false assurance because the pinned matrix is a subset.

**Evidence:**
- `openbox-core/internal/content/governance.go:278-289` (`RequestHeaders`/`ResponseHeaders`/`RequestBody`/`ResponseBody`/`SemanticType`/`AttributeKeyIdentifiers` common fields)
- phase-03:42-48 (plan matrix omits them); plan.md:140-141 ("Full common-field matrix")
- `openbox-sdk-python/tests/wire/test_backend_compat.py:72` (Python DOES set `response_body`) — parity target the plan's matrix misses
- plan.md:93 vs `openbox-core/internal/content/agent.go:93-94` (`GetFlagThreshold`, not the builder) vs `internal/services/agent.go:93`

**Suggested fix:** Extend the Phase 3 common-field matrix to the full `SpanData` struct (add `request_body`/`response_body`/`request_headers`/`response_headers`/`semantic_type`/`attribute_key_identifiers`; keep `data` stripped per the nested-key rule but confirm against `core_span.py`), and drive the matrix test from the actual Go struct field list, not the integration guide. Fix the citation to `openbox-core/internal/services/agent.go:93` and add `approvals` to the module layout.

---

## Unresolved Questions (for planner)

1. Is a live/dockerized Core (or Go harness) round-trip acceptable in Phase 4 CI, or must conformance stay fixture-only? (Determines the fix for Finding 1.)
2. What is the intended base behavior of `CoreAdapter`-without-poller for `REQUIRE_APPROVAL` — Python's hard reject, or a new "pending stub"? These are contract-divergent. (Finding 2.)
3. Does the target Node deployment run one long-lived process across tenants (making Finding 3's leak load-bearing), or worker-per-request (mitigating it)?
4. CopilotKit claims (phase-06:54-56 config divergence; phase-07 duplicated surfaces) could not be verified — that repo is not in the provided ground truth. Confirm before relying on them.
