# OpenBox SDK Python → TypeScript: Behavioral Contracts Report

**Research Date:** 2026-07-08  
**Source Truth:** `/Users/tino/code/openbox-sdk-python`  
**Confidence:** High (all contracts verified against golden fixtures + test suites)

---

## 1. Package/Module Layout

**Source:** `openbox_core/` directory structure

Top-level modules (no re-exports required; TS may mirror directly):

```
openbox_core/
├── __init__.py                          (core exports)
├── errors.py                            (exception hierarchy)
├── config.py                            (layered config resolution)
├── identity.py                          (DID validation, Ed25519 signing)
├── serialization.py                     (JSON safety, body hashing)
├── client.py                            (HTTP client: evaluate, approval, auth)
├── gate.py                              (strict validation orchestrator)
├── context.py                           (ContextVar binding + trace correlation)
├── runtime.py                           (composition root)
├── approvals.py                         (HITL approval poller)
├── adapters/base.py                     (FrameworkAdapter protocol)
├── contracts/
│   ├── results.py                       (Verdict, EvaluationResult, ApprovalResult)
│   ├── events.py                        (EventType, EventKind, EventEnvelope, factories)
│   ├── context.py                       (ActivityContext dataclass)
│   └── otel_spans.py                    (Stage, HookType, OTel→SpanData projection)
├── wire/
│   ├── core_span.py                     (SpanData normalization: redaction, truncation)
│   └── evaluate_payload.py              (hook body assembly, span_count)
├── validation/
│   ├── event_rules.py                   (strict contract checks)
│   ├── registry.py                      (validate_lifecycle, validate_hook)
│   └── span_normalization.py            (truncation/redaction diagnostics)
└── instrumentation/                     (HTTP/DB/file/function hooks)
```

**Key insight:** TS must mirror this exactly; the module names are part of framework SDK expectations (e.g., `from openbox_core.contracts import Verdict`).

---

## 2. Errors — Exception Hierarchy

**Source:** `openbox_core/errors.py`

Hierarchy (lines 6–21):

```
OpenBoxError (base, line 55)
├── ContractError                         (line 64: gate violations, code + detail fields)
├── OpenBoxConfigError
│   ├── OpenBoxAuthError                  (line 91: API key validation)
│   │   └── OpenBoxSigningError           (line 103: reason_code field)
│   ├── OpenBoxNetworkError               (line 95)
│   └── OpenBoxInsecureURLError           (line 99: non-localhost HTTP rejection)
├── GovernanceBlockedError                (line 170: verdict + reason + url fields)
├── GovernanceHaltError                   (line 195)
├── GovernanceAPIError                    (line 206: fail_closed network error)
├── GuardrailsValidationError             (line 215: reasons list)
├── ApprovalExpiredError                  (line 235)
├── ApprovalRejectedError                 (line 239)
└── ApprovalTimeoutError                  (line 243: max_wait_ms field)
```

**Gotchas:**
- `ContractError` (line 76) has structured fields: `code: str`, `detail: dict | None`. TS must preserve these.
- `OpenBoxSigningError` (line 110) has `reason_code: str | None` field. Mapping table at lines 119–146.
- `GovernanceBlockedError` (line 182) lazily imports Verdict to avoid hard module dependency; TS should do same.
- `extract_governance_error` (line 261): walks `__cause__`, `__context__`, and custom `.cause` properties. TS must walk all three.

---

## 3. Result Contracts

**Source:** `openbox_core/contracts/results.py`

### Verdict (lines 25–73)

Enum with priority-ordered values (line 26):

```python
ALLOW = "allow"              # priority 1
CONSTRAIN = "constrain"      # priority 2
REQUIRE_APPROVAL = "require_approval"  # priority 3
BLOCK = "block"             # priority 4
HALT = "halt"               # priority 5
```

**Canonical parsing** (`from_string`, lines 34–49):
- Input `None` → `ALLOW` (default)
- Normalize case + replace `-` with `_`
- **Compat aliases (CRITICAL):**
  - `"continue"` → `ALLOW`
  - `"stop"` → `HALT`
  - `"require-approval"` or `"request_approval"` → `REQUIRE_APPROVAL`
- Unknown values → `ALLOW` (lenient)
- **Only used for EvaluationResult**, not ApprovalResult

Methods:
- `.priority` property (line 52): integer rank for aggregation
- `.highest_priority(verdicts)` (line 63): max or `ALLOW` if empty
- `.should_stop()` → `BLOCK or HALT` (line 67)
- `.requires_approval()` → `REQUIRE_APPROVAL` (line 71)

### EvaluationResult (lines 105–193)

Parsed with `from_dict(data)` (line 151); **lenient parsing — unknown keys preserved in `raw`**.

Fields:
- `verdict: Verdict` (line 117, **verdict-first parsing** line 164)
- `reason: str | None` (optional, line 118)
- `policy_id: str | None` (optional)
- `risk_score: float = 0.0` (line 120)
- `metadata: dict[str, Any] | None` (optional)
- `governance_event_id: str | None` (optional)
- `guardrails: GuardrailsResult | None` (line 123)
- `approval_id: str | None` (line 124)
- `approval_expiration_time: str | None` (line 125)
- `trust_tier: str | None`, `alignment_score: float | None`, `behavioral_violations: list[str] | None`, `constraints: list[dict] | None` (lines 126–129, all optional)
- `fallback_used: bool = False` (line 130: **True only on fail-open network error**)
- `diagnostics: list[Any] = []` (line 131: gate populates after evaluation)
- `raw: dict[str, Any] = {}` (line 132: **preserve entire backend response**)

**Critical alias** (line 135): `guardrails_result` property returns same object as `guardrails` — they NEVER diverge.

**Compat property** `action` (lines 140–148): maps `verdict` back to v1.0 strings:
- `ALLOW` → `"continue"`
- `HALT` → `"stop"`
- `REQUIRE_APPROVAL` → `"require-approval"`
- Others → `verdict.value`

**Parsing logic** (lines 151–183):
- Fallback: `from_dict` tries `verdict` field first, then `action` (v1.0 compat), defaults to `"continue"` (lines 164)
- Guardrails source: prefer `guardrails_result`, fallback to `guardrails` (lines 159–162)
- Both keys missing → both are `None`
- Unknown keys → preserved in `raw`, never an error

**fallback_allow factory** (line 186): creates `ALLOW` result with `fallback_used=True` for network errors under fail-open.

### GuardrailsResult (lines 76–103)

Fields:
- `redacted_input: Any = None` (line 84)
- `input_type: str = ""` (line 85: `"activity_input"` or `"activity_output"`)
- `raw_logs: dict[str, Any] | None = None` (line 86)
- `validation_passed: bool = True` (line 87: **False = execution should stop**)
- `reasons: list[dict[str, str]] = []` (line 88: list of `{type, field, reason}` objects)

**Method** `get_reason_strings()` (line 100): extracts `reason` field from each reason dict.

### ApprovalResult (lines 196–288)

**STRICT parsing — unknown/empty decision vocabulary → `None` (pending).**

Fields:
- `verdict: Verdict | None = None` (line 208: **not ALLOW on unknown**)
- `action: str | None = None` (line 209: raw backend value)
- `reason: str | None = None` (line 210)
- `approval_id: str | None = None` (line 211: also accepts `id` field as fallback line 256)
- `approval_expiration_time: str | None = None` (line 212)
- `expired: bool = False` (line 213: set by `check_expiration` in client.py line 52)
- `raw: dict[str, Any] = {}` (line 214)

**Decision vocabulary** (lines 220–231): explicit frozenset of known strings:
```python
{"allow", "constrain", "require_approval", "request_approval", 
 "block", "halt", "continue", "stop"}
```

**Parsing precedence** (lines 244–260):
- `action` field wins if present and non-empty (line 245–248)
- Otherwise use `verdict` field (line 249)
- Pass the winner through `_parse_decision` (line 250)
- **_parse_decision** (lines 233–241): 
  - Empty/whitespace/non-string → `None` (pending)
  - Unknown vocab → `None` (never ALLOW)
  - Known vocab → `Verdict.from_string(normalized)` (reuses eval parsing)

**Methods:**
- `allow_shaped` property (line 263): `verdict == ALLOW`
- `is_blocking()` (line 267): true if `expired AND NOT allow_shaped` OR `verdict in {BLOCK, HALT}`
- `is_pending()` (line 277): true if `verdict is None` OR `verdict in {REQUIRE_APPROVAL, CONSTRAIN}` (and not expired)

---

## 4. Configuration

**Source:** `openbox_core/config.py`

### Resolution order (lines 3–10, precisely line 159):
1. Explicit arguments
2. `{env_prefix}_{FIELD}` (e.g., `OPENBOX_FRAMEWORK_API_KEY`)
3. `OPENBOX_{FIELD}` (global)
4. Defaults
5. Validation (`.normalized()`)

**Global prefix:** `"OPENBOX"` (line 47)

**Resolvable fields** (lines 50–58):
- `api_url`, `api_key`, `timeout_seconds`, `on_api_error`, `agent_name`, `agent_did`, `agent_private_key`

### OpenBoxConfig (lines 122–246)

Fields:
- `api_url: str = ""` (required)
- `api_key: str = ""` (required; pattern `obx_live_*` or `obx_test_*`, line 45)
- `timeout_seconds: float = 30.0`
- `on_api_error: str = "fail_open"` (values: `"fail_open"` | `"fail_closed"`, line 132)
- `on_fallback: Any = None` (reserved passthrough)
- `agent_name: str | None = None`
- `agent_did: str | None = None`
- `agent_private_key: str | None = None` (never in repr, line 136)
- `sdk_version: str | None = None`
- `sdk_engine: str` (default from `sdk_version.py`)
- `sdk_language: str` (default from `sdk_version.py`)
- `env_prefix: str | None = None`
- `hitl: HitlConfig` (lines 141, default factory)
- `telemetry: TelemetryConfig` (line 142)
- `instrumentation: InstrumentationConfig` (line 143)
- `gate: GateConfig` (line 144)
- `privacy: PrivacyConfig` (line 145)
- `metadata: dict[str, Any]` (line 146)

### Nested configs

**HitlConfig** (lines 61–69):
- `enabled: bool = True`
- `poll_interval_ms: int = 5000`
- `max_wait_ms: int | None = None` (None = indefinite)
- `skip_activity_types: set[str] = {"send_governance_event"}` (to avoid loops)

**TelemetryConfig** (lines 72–76):
- `enabled: bool = True`

**InstrumentationConfig** (lines 79–94):
- `enabled: bool = True`
- `http_enabled: bool = True`
- `db_enabled: bool = True`
- `file_enabled: bool = True` (safe default: interpreter paths bypass governance)
- `function_enabled: bool = True`
- `llm_enabled: bool = False` (reserved, disabled)
- `install_opentelemetry: bool = True`
- `preflight_enabled: bool = True`
- `completed_telemetry_enabled: bool = True`

**GateConfig** (lines 97–110):
- `skip_workflow_types: set[str] = set()`
- `skip_signals: set[str] = set()`
- `skip_activity_types: set[str] = {"send_governance_event"}`
- `enforce_task_queues: set[str] | None = None` (None = all)
- `send_start_event: bool = True`
- `send_activity_start_event: bool = True`

**PrivacyConfig** (lines 113–119):
- `redact_keys: set[str] = set()` (case-insensitive, applied BEFORE signing)
- `max_body_size: int = 65536` (chars, applied BEFORE signing)

### Validation (`.normalized()`, lines 197–235)

Rules:
1. `api_url` required (line 200); stripped trailing `/` (line 204)
2. `api_key` required (line 202); must match `API_KEY_PATTERN` (line 207–211)
3. `timeout_seconds` coerced to float (line 214–218)
4. `on_api_error` must be `"fail_open"` or `"fail_closed"` (line 220–223)
5. **DID + private key: both-or-neither** (line 226–230)
6. If DID present, validate format via `validate_agent_did()` (lines 231–234)
7. **Insecure HTTP rejection** (line 205, via `_validate_url_security`):
   - HTTP allowed only for `localhost`, `127.0.0.1`, `::1` (line 255)
   - Non-localhost HTTP raises `OpenBoxInsecureURLError` (line 257–260)

**Factory method** `load_identity()` (line 237): decodes private key once, returns `AgentIdentity | None`.

---

## 5. Identity / Signing (CRITICAL — byte-exact)

**Source:** `openbox_core/identity.py`

### DID Format

**Prefix:** `"did:aip:"` (line 61), suffix = UUID (line 62)

**Validation** `validate_agent_did()` (lines 74–94):
- Must start with `"did:aip:"` (line 82)
- Suffix parsed via `uuid.UUID()` (line 89) — strict, rejects malformed UUIDs
- Raises `OpenBoxConfigError` on mismatch

### Ed25519 Seed Loading

**Input:** base64-encoded raw 32-byte seed (line 97)

`load_ed25519_seed()` (lines 97–127):
1. Decode base64 with validation (line 110)
2. Verify length == 32 bytes (line 116)
3. Load via `Ed25519PrivateKey.from_private_bytes(seed)` (line 123)
4. Raises `OpenBoxConfigError` on any failure; **never echoes key bytes** (lines 112, 118, 126)

### Canonical Signing String (EXACT FORMAT)

**Source:** `build_canonical_string()` (lines 155–159)

**The EXACT canonical string Core verifies** (docstring lines 3–6, agent.go:93):

```
UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
```

Five fields, newline-separated, ASCII-encoded for signing.

### Request Preparation

`prepare_signed_request()` (lines 182–231):

**Args:**
- `method: str` (case-insensitive; uppercased in canonical)
- `path: str` (must include `/api/v1` prefix, line 199)
- `payload: dict | None` (JSON-serializable or None for empty-body)
- `api_key: str` (Bearer token)
- `identity: AgentIdentity | None` (None = unsigned mode)
- `sdk_version: str | None`
- `sdk_engine: str` (default)
- `sdk_language: str` (default)
- `_timestamp: str | None` (test injection only, line 192)
- `_nonce: str | None` (test injection only)

**Return:** `(headers: dict, body_bytes: bytes)`

**Key steps:**
1. Serialize body via `serialize_body(payload)` (line 211)
2. Build bearer auth headers via `build_auth_headers()` (lines 212–217)
3. If identity is not None:
   - Body SHA-256: `hashlib.sha256(body_bytes).hexdigest()` (line 220)
   - **Signing TIMESTAMP format (line 222):** `datetime.now(UTC).isoformat()`
     - **KEEPS `+00:00` suffix, never `Z`** (comment line 221)
     - Injection point for tests (line 222)
   - **NONCE format (line 223):** `secrets.token_urlsafe(24)` or injected
   - **Canonical string** (line 224): `build_canonical_string(method.upper(), path, timestamp, nonce, body_sha256)`
   - **Signature** (line 228): `identity.sign(canonical)` → padded base64
   - **Headers added** (lines 225–229):
     - `X-OpenBox-Agent-DID`: DID value
     - `X-OpenBox-Agent-Timestamp`: signing timestamp (with `+00:00`)
     - `X-OpenBox-Agent-Nonce`: nonce
     - `X-OpenBox-Agent-Signature`: signature
     - `X-OpenBox-Body-SHA256`: hex body hash

### Auth Headers

`build_auth_headers()` (lines 162–179):

Returns dict:
- `"Authorization": f"Bearer {api_key}"`
- `"User-Agent": f"OpenBox-SDK/{sdk_identifier}"`
- `"X-OpenBox-SDK-Version": sdk_identifier`

**SDK identifier format** (line 170): built via `build_sdk_identifier(engine, language, version)` from `sdk_version.py`.

### Constants

- `EMPTY_BODY_SHA256` (line 64): `"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"` (SHA-256 of empty bytes)
- **Header names** (lines 66–71):
  - `HEADER_DID = "X-OpenBox-Agent-DID"`
  - `HEADER_TIMESTAMP = "X-OpenBox-Agent-Timestamp"`
  - `HEADER_NONCE = "X-OpenBox-Agent-Nonce"`
  - `HEADER_SIGNATURE = "X-OpenBox-Agent-Signature"`
  - `HEADER_BODY_SHA256 = "X-OpenBox-Body-SHA256"`

### Golden Fixture Proof

**Source:** `tests/signing/golden_temporal_signed_request.json`

Canonical string (lines 31):
```
POST
/api/v1/governance/evaluate
2026-07-02T00:00:00.123456+00:00
Zm9vYmFyLWdvbGRlbi1ub25jZS1mixed
7a49e279b410d4e53187f5a52a4227bf167f4f681306370db6cb74564aaa3ab9
```

**Timestamp invariant** (line 29): `"2026-07-02T00:00:00.123456+00:00"` — **ends in `+00:00`, NEVER `Z`**.

---

## 6. Serialization

**Source:** `openbox_core/serialization.py`

### Body bytes (CRITICAL for signing)

`serialize_body(payload)` (lines 75–85):
- `None` → `b""`
- `dict` → compact JSON: `json.dumps(payload, separators=(",", ":")).encode("utf-8")`
- **NO spaces, single pass** — the bytes hashed are identical to bytes sent

### JSON Safety

`to_json_safe(obj, exclude_none=True)` (lines 44–72):
- Handles dataclasses (→ dict), Enums (→ `.value`), datetimes (→ RFC3339 Z), sets/tuples (→ lists)
- **Dict keys coerced via `str()`** (line 64)
- **Datetime format** (lines 58–61): RFC3339 with millisecond precision + trailing `Z` (event-payload format, NOT signing timestamp format)
- Unknown objects → `str(obj)` fallback
- `exclude_none=True` drops None values (but gate overrides to `False` for started-stage spans, line 158 in gate.py)

### Redaction & Truncation (applied BEFORE signing)

**Redaction** `apply_redaction(obj, redact_keys, replacement="[REDACTED]")` (lines 99–129):
- Case-insensitive key matching (line 111)
- Walks dict/list recursively (lines 114–127)
- Returns `(redacted_copy, changed_paths)` — paths identify what changed for diagnostics
- **Applied BEFORE signing** (docstring line 107)

**Truncation** `truncate_string(value, max_size)` (lines 88–96):
- Returns `(truncated_value, was_truncated: bool)`
- Non-positive max_size disables
- **Applied BEFORE signing** (docstring line 92)

### RFC3339 formatting

`rfc3339_now()` (lines 35–41):
- Current UTC time in RFC3339, millisecond precision, trailing `Z`
- **Event-payload timestamp format** (distinct from signing timestamp format, comment lines 37–39)
- Format: `"%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"` (milliseconds via `[:-3]` on microseconds)

---

## 7. Client — HTTP & Governance API Calls

**Source:** `openbox_core/client.py`

### Endpoints

- `EVALUATE_PATH = "/api/v1/governance/evaluate"` (line 46)
- `APPROVAL_PATH = "/api/v1/governance/approval"` (line 47)
- `AUTH_VALIDATE_PATH = "/api/v1/auth/validate"` (line 48)

### EvaluationClient (lines 90–299)

Constructor (lines 97–121):
- `api_url: str` (base URL, trailing `/` stripped on line 124)
- `api_key: str`
- `timeout_seconds: float = 30.0`
- `on_api_error: str = "fail_open"` (only valid values: `"fail_open"`, `"fail_closed"`, line 122)
- `identity: AgentIdentity | None = None` (for signed requests)
- `sdk_version`, `sdk_engine`, `sdk_language`
- `transport`, `async_transport` (test injection)

**Lazy transport initialization** (lines 139–153): sync/async httpx clients created on first use.

### evaluate() / aevaluate() (lines 183–200)

**Sync:** `evaluate(payload: dict) -> EvaluationResult`
**Async:** `aevaluate(payload: dict) -> EvaluationResult`

Flow:
1. Prepare request via `prepare_signed_request()` (line 169–178)
2. POST to `{api_url}/api/v1/governance/evaluate` with `content=body_bytes` (line 188, **never `json=`**)
3. On network exception: call `_network_failure()` (line 189–190)
4. Parse response via `_parse_evaluate_response()` (line 191)

**Response parsing** (lines 202–212):
- Status >= 400: treat as network failure (line 203)
- Parse JSON (line 206)
- Return `EvaluationResult.from_dict(data)` (line 209)
- Log blocks (line 210–211)

**Network failure handling** (lines 214–219):
- If `on_api_error == "fail_closed"`: raise `GovernanceAPIError` (line 218)
- Otherwise (fail_open): return `EvaluationResult.fallback_allow(reason)` with `fallback_used=True` (line 219)

### poll_approval() / apoll_approval() (lines 223–246)

**Sync:** `poll_approval(workflow_id, run_id, activity_id) -> ApprovalResult | None`
**Async:** `apoll_approval(...) -> ApprovalResult | None`

Flow:
1. Prepare payload: `{workflow_id, run_id, activity_id}`
2. POST to `/api/v1/governance/approval` with `content=body_bytes`
3. On network exception: log & return `None` (poll fails silently, line 231)
4. Parse via `_parse_approval_response()` (line 233)

**Response parsing** (lines 248–258):
- Status != 200: log & return `None` (line 249–251)
- Parse JSON (line 253)
- Call `check_expiration(data)` to set `expired=True` if past (line 257)
- Return `ApprovalResult.from_dict(data)` (line 258)

### validate_api_key() / avalidate_api_key() (lines 262–282)

GET request (no payload). On 200: return `True`. On 401/403: extract reason code from response body (lines 290–291), raise `OpenBoxAuthError` or `OpenBoxSigningError` (line 295 or via `map_signing_error`, line 294). On other errors: raise `OpenBoxNetworkError` (line 297).

### check_expiration() (lines 51–71)

Parses `approval_expiration_time` from dict; sets `expired=True` if past. Handles ISO `Z` (replace with `+00:00`), ISO offset, and space-separated DB formats (lines 61). Parse failures logged, never raised (line 67–70).

---

## 8. Events & Wire Envelope

**Source:** `openbox_core/contracts/events.py`

### EventType enum (lines 50–59)

Backend wire types Core accepts:

```python
WORKFLOW_STARTED = "WorkflowStarted"
WORKFLOW_COMPLETED = "WorkflowCompleted"
WORKFLOW_FAILED = "WorkflowFailed"
SIGNAL_RECEIVED = "SignalReceived"
ACTIVITY_STARTED = "ActivityStarted"
ACTIVITY_COMPLETED = "ActivityCompleted"
HANDOFF = "Handoff"
```

### EventKind enum (lines 62–68)

**Internal classification** (not a wire concept):

```python
LIFECYCLE = "lifecycle"
HOOK = "hook"
SIGNAL = "signal"
HANDOFF = "handoff"
```

### EventEnvelope (lines 83–131)

Frozen dataclass (immutable). Fields:
- `event_type: EventType` (line 102: backend **wire** type)
- `payload: Mapping[str, Any]` (line 103: flat wire fields)
- `spans: tuple[Any, ...]` (line 104: Core SpanData dicts, empty for lifecycle)
- `hook_trigger: bool = False` (line 105: True only for hook evaluations)
- `activity_id: str | None = None` (line 106)
- `activity_type: str | None = None` (line 107)
- `timestamp: str | None = None` (line 108: RFC3339 Z string, or None for gate to fill)
- `source: str = SOURCE_WORKFLOW_TELEMETRY` (line 109: constant `"workflow-telemetry"`, line 47)

**Method** `to_payload_dict()` (lines 111–131):
- Returns flat dict for wire
- Omits-when-absent (never null keys), lines 123–130
- **Spans and span_count NOT emitted here** — owned by `wire/evaluate_payload.py` (comment lines 114–116)

### Classification Functions

**`classify_event(event)` (lines 134–143):**
- Returns `EventKind` derived from stored fields
- `hook_trigger=true` → `HOOK`
- `event_type=HANDOFF` → `HANDOFF`
- `event_type=SIGNAL_RECEIVED` → `SIGNAL`
- Otherwise → `LIFECYCLE`

**`wire_event_type(event)` (lines 146–151):**
- Hook events serialize as `ActivityStarted` on the wire (line 150), regardless of stored type
- Non-hooks return their stored `event_type`

### Constants

**`SOURCE_WORKFLOW_TELEMETRY = "workflow-telemetry"`** (line 47)

### Factories (lines 154–401)

All factories return `EventEnvelope`. They raise `ValueError` on programmer misuse (missing required fields); runtime contract violations are the strict gate's job.

**`workflow_started()`** (lines 184–201):
- Required: `workflow_id`, `run_id`, `workflow_type`
- Optional: `task_queue`, `multi_agent_session_id`, `timestamp`, `extra`
- Returns `WorkflowStarted` envelope

**`workflow_completed()`** (lines 204–221):
- Same fields as `workflow_started`
- Returns `WorkflowCompleted` envelope

**`workflow_failed()`** (lines 224–243):
- Same fields as `workflow_started`, plus optional `error: str | None`
- Returns `WorkflowFailed` envelope

**`activity_started()`** (lines 246–274):
- Required: workflow + activity identity (`activity_id`, `activity_type`)
- Optional: `task_queue`, `activity_input`, `attempt`, `multi_agent_session_id`, `timestamp`, `extra`
- Returns `ActivityStarted` envelope with `hook_trigger=false` (line 260: comment says NOT a hook)

**`activity_completed()`** (lines 277–313):
- Required: workflow + activity identity
- Optional: `task_queue`, `result`, `error`, `attempt`, `multi_agent_session_id`, `timestamp`, `extra`
- Returns `ActivityCompleted` envelope with **empty `spans`** (line 296: comment says never carries hook spans)

**`signal_received()`** (lines 316–334):
- Required: workflow identity + `signal_name: str`
- Optional: `task_queue`, `multi_agent_session_id`, `timestamp`, `extra`
- Returns `SignalReceived` envelope

**`handoff()`** (lines 337–362):
- **Required (both non-empty):** `from_agent_did: str`, `multi_agent_session_id: str` (lines 349–354)
- Raises `ValueError` if either missing or empty
- Optional: `timestamp: str | None`
- `to_agent_did` NOT included; derived server-side from authenticated identity (comment lines 344–346)
- Returns `Handoff` envelope

**`hook()`** (lines 365–401):
- **Required:** `activity_context: Mapping`, `activity_id: str`, `activity_type: str`, `spans: tuple | list`
  - Raises `ValueError` if activity identity missing (lines 386–390)
  - Raises `ValueError` if spans empty (lines 391–392)
- Optional: `timestamp: str | None`
- Comment (lines 375–378): callers must resolve `activity_context` from ContextStore first; no bound context ⇒ skip hook entirely
- Returns `ActivityStarted` envelope with `hook_trigger=true` (line 394), payload merged from `activity_context` (line 395), spans tuple (line 396)

### Timestamp formatting

**`rfc3339_from_datetime(ts)` (lines 71–80):**
- Event-payload timestamp format: RFC3339, UTC, millisecond precision, trailing `Z`
- Naive datetimes assumed UTC (line 79)
- Format: `"%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"` (milliseconds via `[:-3]` truncation)

---

## 9. Spans — Core SpanData Normalization

**Source:** `openbox_core/wire/core_span.py`, `openbox_core/contracts/otel_spans.py`

### Stage enum (otel_spans.py, lines 29–33)

```python
STARTED = "started"
COMPLETED = "completed"
```

### HookType enum (otel_spans.py, lines 36–44)

```python
HTTP_REQUEST = "http_request"
DB_QUERY = "db_query"
FILE_OPERATION = "file_operation"
FUNCTION_CALL = "function_call"
LLM_CALL = "llm_call"  # reserved, disabled
```

### SpanData Normalization (core_span.py)

**`to_core_span_data(span, *, privacy=None, include_otel_data=False)` (lines 61–130):**

Returns `(wire_span: dict, diagnostics: list[Diagnostic])`

**Process:**
1. Copy span dict
2. Remove forbidden nested keys: `otel`, `openbox`, `data`, `metadata` (lines 79–82)
3. Apply privacy redaction to attributes (lines 85–88)
4. Truncate `request_body` and `response_body` if privacy `max_body_size` set (lines 91–102)
5. **Fill in COMMON defaults** (lines 104–112):
   - If field missing, set default from `_COMMON_DEFAULTS` dict (lines 45–58):
     - `span_id: "0" * 16`
     - `trace_id: "0" * 32`
     - `parent_span_id: None`
     - `name: "span"`
     - `kind: "INTERNAL"`
     - `start_time: None`
     - `end_time: None`
     - `duration_ns: None`
     - `attributes: {}`
     - `status: {"code": "UNSET", "description": None}`
     - `events: []`
     - `error: None`
6. **Guarantee all family-specific root keys exist** (lines 117–118):
   - From `_ROOT_FIELDS_BY_HOOK_TYPE` (from otel_spans.py, not shown)
   - Each family-specific field gets explicit `None` if absent
7. Reconstruct missing `end_time` from `start_time + duration_ns` for completed spans (lines 123–127)
8. Emit semantic-gap diagnostics (line 129)

**Critical invariant** (lines 7–10, 13–14):
- **IDs are HEX STRINGS:** `span_id` 16 chars, `trace_id` 32 chars, `parent_span_id` 16 chars
- **Timestamps are epoch NANOSECONDS** (int)
- **Started-stage spans EMIT EXPLICIT `end_time: null` and `duration_ns: null`** (never omitted)
- **All COMMON root fields always present** — null-valued when absent, never omitted

---

## 10. Gate — Always-Strict Validation

**Source:** `openbox_core/gate.py`, `openbox_core/validation/event_rules.py`

### Validation Rules (event_rules.py)

**Strict failures raise `ContractError` BEFORE any network send** (comment lines 1–3).

**`check_lifecycle_envelope(event)` (lines 60–102):**
1. Verify `event_type` is an `EventType` (line 62–66)
2. Classify event (line 68)
3. Reject if classified as HOOK (line 69–74) — hooks route through preflight/completed
4. Reject span-bearing non-hook envelopes (lines 76–91):
   - `ActivityCompleted` with spans → error code `ACTIVITY_COMPLETED_WITH_SPANS` (lines 79–85)
   - Other `event_type` with spans but `hook_trigger=false` → error code `HOOK_TRIGGER_FALSE` (lines 86–91)
5. Handoff: require `from_agent_did` + `multi_agent_session_id` (line 94)
6. Lifecycle/signal: require workflow identity fields (line 96)
7. Signal: require `signal_name` (lines 97–102)

**`check_hook_envelope(event)` (lines 105–144):**
1. Require `hook_trigger=true` → error code `HOOK_TRIGGER_FALSE` (lines 107–111)
2. Require `event_type == ACTIVITY_STARTED` → error code `HOOK_WRONG_WIRE_TYPE` (lines 112–118)
3. Require non-empty `spans` → error code `HOOK_EMPTY_SPANS` (lines 119–124)
4. Require bound activity (`activity_id` + `activity_type`) → error code `HOOK_UNBOUND_ACTIVITY` (lines 125–134)
5. Reject forbidden nested keys in spans (`otel`, `openbox`, `data`) → error code `HOOK_SPAN_NOT_FLAT` (lines 135–144)

**`check_stage(event, expected_stage)` (lines 147–164):**
- Each span must have `stage` field (extract via `span_stage()`, lines 36–47)
- Stage must match expected (preflight=`"started"`, completed=`"completed"`)
- Error code `HOOK_SPAN_NO_STAGE` if missing (lines 152–157)
- Error code `HOOK_STAGE_MISMATCH` if mismatched (lines 158–164)

### GovernanceGate (gate.py)

**Constructor** (lines 66–75):
- `client: EvaluationClient`
- `config: OpenBoxConfig | None` (defaults to empty config if None)
- `payload_builder: PayloadBuilder | None` (hook body assembler seam)

**Lifecycle path** (lines 79–100):
- `evaluate(event) / aevaluate(event) -> EvaluationResult`
- Validates via `validate_lifecycle(event)` (line 94)
- Builds payload via `event.to_payload_dict()` (line 95)
- Stamps missing timestamp with `rfc3339_now()` (line 96)
- Strips compat noise (empty span cruft) (lines 97–99)
- Finalizes (JSON safety + redaction, line 100)
- Calls client.evaluate() / aevaluate() (lines 82, 89)
- Attaches diagnostics to result (lines 83, 90)

**Hook path — preflight (started-stage)** (lines 104–116):
- `preflight(event) / apreflight(event) -> EvaluationResult`
- Validates via `validate_hook(event, "started")` (line 134)
- Requires `payload_builder` (raises OpenBoxConfigError if None, lines 135–139)
- Calls builder (line 140)
- Stamps timestamp, finalizes (lines 142–143)
- Evaluates (line 107, 114)
- Attaches diagnostics (line 108, 115)

**Hook path — completed (telemetry only)** (lines 118–131):
- `completed(event) / acompleted(event) -> EvaluationResult`
- Same flow as preflight
- Comment (line 119): never undoes operation; may influence FUTURE execution

**Shared finalization** (lines 147–163):
- JSON coercion via `to_json_safe(payload, exclude_none=False)` (line 158)
  - **`exclude_none=False` deliberate:** started-stage spans carry explicit `end_time: null`, etc. (comment lines 152–156)
- Privacy redaction applied BEFORE signing (lines 159–162)

**Verdict enforcement** (lines 166–185):

`raise_for_verdict(result) -> EvaluationResult | None`:
- Implements priority: HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW
- HALT → raise `GovernanceHaltError` (line 177–178)
- BLOCK → raise `GovernanceBlockedError` (line 179–180)
- Guardrails fail → raise `GuardrailsValidationError` (lines 182–184)
- REQUIRE_APPROVAL, CONSTRAIN, ALLOW → return result (line 185)

---

## 11. Wire / Evaluate Payload Assembly

**Source:** `openbox_core/wire/evaluate_payload.py`

**SINGLE OWNER:** `build_evaluate_payload()` assembles the exact `/api/v1/governance/evaluate` hook body.

`build_evaluate_payload(event: EventEnvelope, *, privacy: PrivacyConfig | None = None) -> (dict, list[Diagnostic])` (lines 25–47):

**Process:**
1. Iterate `event.spans` (flat Core SpanData dicts)
2. Normalize each via `to_core_span_data()` (line 38–41)
3. Assemble `wire_spans` list (line 42)
4. Call `event.to_payload_dict()` (line 44)
5. Add `spans` and `span_count` (lines 45–46)
6. Return payload + aggregated diagnostics

**Binding factory** `make_payload_builder(privacy)` (lines 50–56):
- Captures privacy config
- Returns single-argument callable for gate's seam injection

---

## 12. Context — ActivityContext & ContextStore

**Source:** `openbox_core/contracts/context.py`, `openbox_core/context.py`

### ActivityContext (contracts/context.py, lines 17–61)

Frozen dataclass (immutable). Fields:
- `workflow_id: str | None = None`
- `run_id: str | None = None`
- `workflow_type: str | None = None`
- `task_queue: str | None = None`
- `activity_id: str | None = None`
- `activity_type: str | None = None`
- `activity_input: Any = None`
- `agent_name: str | None = None`
- `agent_role: str | None = None`
- `session_id: str | None = None`
- `multi_agent_session_id: str | None = None`
- `metadata: Mapping[str, Any]` (framework-specific extras)

**Method** `to_payload_fields()` (lines 39–61):
- Returns flat dict of non-None fields (line 58)
- Merges metadata at top level (lines 59–60)
- Metadata NEVER overwrites first-class fields (line 60: `.setdefault`)

### ContextStore (context.py, lines 63–206)

Thread-safe binding + trace correlation + governance flags.

**ContextVar binding** (lines 78–88):
- `bind(ctx: ActivityContext) -> Token`
- `reset(token: Token) -> None`
- `current_activity_context() -> ActivityContext | None`

**Trace correlation map** (lines 92–111):
- `register_trace(trace_id: int | str, ctx: ActivityContext) -> None`
- `context_for_trace(trace_id: int | str) -> ActivityContext | None`
- `unregister_trace(trace_id: int | str) -> None`
- **Canonical trace key** (line 44): raw OTel `SpanContext.trace_id` INTEGER; hex strings convert via `int(str, 16)` (line 57)

**Governance flags** (lines 115–138):
- `mark_activity_aborted(workflow_id, activity_id) -> None`
- `is_activity_aborted(workflow_id, activity_id) -> bool`
- `clear_activity_aborted(workflow_id, activity_id) -> None`
- `request_halt() -> None`
- `halt_requested: bool` property

**Cleanup** (line 142): `clear() -> None` drops all correlation + flags (runtime close)

**Module-level singleton** (line 152): `_default_store = ContextStore()`, accessible via `default_context_store()`

**Helper** `activity_scope(ctx, *, trace_id=None, store=None)` (lines 184–205):
- Context manager: binds context + optionally registers trace
- GUARANTEED reset in finally (even on exception, line 203)
- Bad trace_id inside try doesn't leak binding (comment lines 197–198)

---

## 13. Adapters — FrameworkAdapter Protocol

**Source:** `openbox_core/adapters/base.py`

### FrameworkAdapter (lines 31–68)

Runtime-checkable Protocol. Framework SDKs implement these callbacks:

**Fields:**
- `name: str` (line 34: adapter identifier)

**Methods:**

**`async handle_approval(result: EvaluationResult) -> None` (lines 36–47):**
- Drive framework's approval (HITL) flow for `REQUIRE_APPROVAL`
- Return normally when approved
- Raise framework's native rejection/expiry error otherwise
- Called BEFORE real operation runs
- Optional sync variant: `handle_approval_sync(result)` (not part of required protocol, line 42–45)
  - Sync hook paths delegate to it if present
  - Can raise framework's pending error for retry-based HITL

**`raise_lifecycle_blocked(result: EvaluationResult) -> NoReturn` (lines 49–51):**
- Framework-native effect for BLOCK/HALT lifecycle verdict

**`raise_hook_blocked(result: EvaluationResult) -> NoReturn` (lines 53–56):**
- Framework-native effect for BLOCK/HALT started-hook verdict
- Real operation has NOT run

**`on_completed_hook_result(result: EvaluationResult, context: ActivityContext | None = None) -> None` (lines 58–68):**
- React to completed-hook verdict
- Operation ALREADY ran — may only affect FUTURE execution
- `context`: span-resolved ActivityContext (may be None)
- Frameworks bridge completed BLOCK/HALT to native effects; read workflow/run/activity from context

### CoreAdapter (lines 71–123)

Default implementation (framework-agnostic). Raises core error types.

Constructor (line 82): optional `approval_poller: ApprovalPoller | None`

**`handle_approval()` (lines 85–100):**
- If no poller or no `approval_id`: raise `ApprovalRejectedError` (lines 86–90)
- Otherwise: await poller decision (lines 91–95)
- If allow-shaped: return normally (line 96)
- If expired: raise `ApprovalExpiredError` (lines 98–99)
- Otherwise: raise `ApprovalRejectedError` (line 100)

**`raise_lifecycle_blocked()` / `raise_hook_blocked()` (lines 102–106):**
- Delegate to `_raise_stop(result)` (line 103, 106)

**`_raise_stop()` (lines 115–123):**
- HALT verdict → raise `GovernanceHaltError` (lines 119–120)
- Otherwise → raise `GovernanceBlockedError` (lines 121–123)

**`on_completed_hook_result()` (lines 108–113):**
- No-op; completed telemetry never undoes the operation (comment lines 111–112)

---

## 14. Hook Runtime — Preflight/Started + Completed Evaluation

**Source:** `openbox_core/runtime.py`

### OpenBoxRuntime (lines 40–169)

Composition root. Constructor (lines 43–69):
- `config: OpenBoxConfig`
- `adapter: FrameworkAdapter | None` (defaults to `CoreAdapter()`, line 53)
- `client: EvaluationClient | None` (created from config if None, lines 55–64)
- `context_store: ContextStore | None` (defaults to module singleton, line 54)
- `payload_builder: Any | None` (hook body assembler; wired to `make_payload_builder(config.privacy)` if None, lines 65–69)

**Lifecycle evaluation** (lines 91–100):
- `evaluate_lifecycle(event) -> EvaluationResult`
- Evaluates through strict gate
- Delegates verdict enforcement to `_enforce_lifecycle(result, drive_approval=False)` (line 100)

**Hook evaluation** (implied; lifecycle_hook and instrumentation wrappers call preflight/completed):
- Preflight: `gate.preflight(event)` (started-stage evaluation)
- Completed: `gate.completed(event)` (telemetry, never undoes)
- Adapter callbacks:
  - Preflight BLOCK/HALT: `adapter.raise_hook_blocked(result)` (stops real operation)
  - Completed BLOCK/HALT: `adapter.on_completed_hook_result(result, context)` (records for future)

---

## 15. Conformance / Test Fixtures

**Source:** `tests/`

### Golden Signed Request Fixture

**Path:** `tests/signing/golden_temporal_signed_request.json`

**Contains:**
- Exact method, path, payload JSON
- API key, DID, base64 seed
- Injected timestamp (with `+00:00` suffix) and nonce
- Canonical string (exact 5-line format)
- Base64 body bytes
- Body SHA-256 hex
- Expected signed headers (all 5 AIP headers + bearer)
- EMPTY_BODY_SHA256 constant

**Test coverage** (`test_golden_signing.py`):
- Body byte parity (lines 45–47)
- Body hash = SHA-256 of transmitted bytes (lines 49–52)
- Canonical string matches (lines 54–62)
- Signature matches (lines 64–69)
- All signed headers match (lines 71–74)
- Signature is padded std base64, 64 bytes (lines 76–81)
- Signing timestamp keeps `+00:00` (lines 85–90)
- Path includes `/api/v1/` (lines 92–94)
- Empty body hash constant (lines 96–98)
- None payload → empty bytes (lines 100–111)
- Compact separators (lines 113–115)
- Unsigned mode omits AIP headers (lines 117–122)
- Z timestamp produces different signature (lines 125–142)
- Client never uses `json=` kwarg (lines 145–163)

---

## Contracts the TS SDK MUST Reproduce Byte-for-Byte

1. **Canonical signing string format** (line 6, identity.py): `UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`
2. **Signing timestamp format** (line 222, identity.py): `datetime.now(UTC).isoformat()` → keeps `+00:00`, never `Z`
3. **Event payload timestamp format** (lines 35–41, serialization.py): RFC3339 with `Z`, millisecond precision
4. **Body serialization** (lines 75–85, serialization.py): compact JSON, `separators=(",", ":")`, single pass
5. **Body hash** (line 220, identity.py): `hashlib.sha256(body_bytes).hexdigest()` of exact transmitted bytes
6. **Signature** (line 149, identity.py): `base64.b64encode(signer.sign(canonical.encode("utf-8"))).decode("ascii")` — padded std base64
7. **Header names** (lines 66–71, identity.py): exact strings for AIP headers
8. **Verdict parsing** (lines 34–49, results.py): compat aliases, lenient → `ALLOW`
9. **ApprovalResult decision parsing** (lines 233–241, results.py): STRICT vocabulary, unknown → `None`
10. **Event wire type for hooks** (lines 146–151, events.py): always `ActivityStarted` on wire, never another type
11. **Span IDs as hex strings** (core_span.py line 3): 16 for span/parent, 32 for trace
12. **Started-stage spans explicit nulls** (core_span.py lines 7–10): `end_time: null` and `duration_ns: null` always present
13. **No nested span keys** (event_rules.py lines 137–144): `otel`, `openbox`, `data` forbidden in hook spans
14. **ActivityCompleted never carries hook spans** (event_rules.py lines 79–85): strict rule
15. **Privacy redaction BEFORE signing** (identity.py line 18, serialization.py line 107): transform bytes before hash/signature

---

## Unresolved Questions

1. **Instrumentation operation targets** (lines 27–30, instrumentation/): Does Python SDK do any operation-level instrumentation (e.g., wrap function calls)? If so, which targets + how does preflight work for them?
   - Status: Mentioned in config but not fully explored in this research; recommend checking `openbox_core/instrumentation/manager.py` and target modules.

2. **OTel span attribute mapping** (contracts/otel_spans.py lines 76–92): The semantic attribute map is present but the full `from_otel_span()` implementation was not read. Confirm TS can duck-type OTel spans if needed.
   - Status: Low risk; the map is explicit, and spans are already flat by the time they reach the TS SDK.

3. **Approval poller implementation** (approvals.py not fully read): What does the real HITL approval poller do? Does TS need to reimplement or can it be a stub?
   - Status: Likely a stub for base SDK; frameworks implement real approval flows.

