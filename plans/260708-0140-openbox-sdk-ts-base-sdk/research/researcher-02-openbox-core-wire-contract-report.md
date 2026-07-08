# OpenBox Core Wire Contract Extraction Report

**Research Date:** 2026-07-08  
**Source:** openbox-core codebase (canonical server implementation)  
**Scope:** Exact request/response schemas, signing verification, event contracts  
**Confidence:** High (source = authoritative server code, not documentation)

---

## 1. SDK Integration Guide Summary

The `/docs/sdk-integration-guide.md` (784 lines) is the canonical reference for SDK-facing contracts. Key sections:

- **3 required endpoints**: `/api/v1/auth/validate`, `/api/v1/governance/evaluate`, `/api/v1/governance/approval`
- **7 event types**: WorkflowStarted, WorkflowCompleted, WorkflowFailed, ActivityStarted, ActivityCompleted, SignalReceived (+ Handoff for multi-agent)
- **5-tier verdict system**: allow (0) → constrain (1) → require_approval (2) → block (3) → halt (4)
- **Hook triggers**: Mid-activity spans with `hook_trigger: true`, `span_count: 1`, and one span with `stage: "started"` or `"completed"`
- **Approval polling**: Poll `/api/v1/governance/approval` with `{workflow_id, run_id, activity_id}` until server returns terminal verdict
- **Error handling**: Fail-open/fail-closed configurable; retry strategy on 5xx/429; no retry on 400/401/404
- **Multi-agent handoff**: Via `X-OpenBox-Agent-DID` header + Ed25519 signature (see §3 below)

---

## 2. HTTP Endpoints — Exact Schemas

### 2.1 GET /api/v1/auth/validate

**Location in code:** `internal/api/agent.go:32-64` (ValidateToken handler)

**Request:**
```
GET /api/v1/auth/validate HTTP/1.1
Authorization: Bearer {agent_token}
```

**Response** (HTTP 200):
```json
{
  "valid": true,
  "active": true,
  "agent_id": "uuid",
  "agent_name": "string",
  "environment": "live | test | unknown",
  "message": "API key is valid and active"
}
```

**Types:**
- `valid` (boolean, required)
- `active` (boolean, required)
- `agent_id` (string UUID, required)
- `agent_name` (string, required)
- `environment` (string enum, required) — derived from token prefix (`obx_live_` → "live", `obx_test_` → "test", else "unknown")
- `message` (string, required)

**Error codes:**
- **401**: Missing/invalid token (line 38-50)
- **500**: Internal error (agent service unavailable)

---

### 2.2 POST /api/v1/governance/evaluate

**Location in code:** `internal/api/governance.go:28-203` (EvaluateGovernanceEvent handler)

**Request:**
```json
{
  "source": "workflow-telemetry",
  "event_type": "WorkflowStarted | WorkflowCompleted | WorkflowFailed | ActivityStarted | ActivityCompleted | SignalReceived | Handoff",
  "workflow_id": "string",
  "run_id": "string",
  "workflow_type": "string",
  "task_queue": "string",
  "timestamp": "RFC3339 string",
  
  // Activity-specific fields (ActivityStarted/ActivityCompleted/hook)
  "activity_id": "string (optional)",
  "activity_type": "string (optional)",
  "attempt": "int (optional)",
  "activity_input": "json.RawMessage (optional)",
  "activity_output": "json.RawMessage (optional)",
  
  // Signal-specific fields
  "signal_name": "string (optional)",
  "signal_args": "json.RawMessage (optional)",
  
  // Timing (ActivityCompleted, WorkflowCompleted/Failed)
  "start_time": "float64 (optional, Unix seconds)",
  "end_time": "float64 (optional, Unix seconds)",
  "duration_ms": "float64 (optional)",
  
  // Spans (per event)
  "span_count": "int",
  "spans": [{...SpanData...}],
  
  // Hook trigger (mid-activity evaluation)
  "hook_trigger": "boolean (optional)",
  
  // SDK metadata
  "sdk_version": "string (optional, from header X-OpenBox-SDK-Version)",
  "metadata": "json.RawMessage (optional)",
  
  // Multi-agent handoff
  "multi_agent_session_id": "string (optional, Handoff only)",
  "from_agent_did": "string (optional, Handoff only, e.g. 'did:aip:uuid')",
  
  // Error info (WorkflowFailed, ActivityCompleted with error)
  "error": {
    "type": "string",
    "message": "string",
    "stack_trace": "string (optional)",
    "cause": {...nested ErrorInfo...} (optional),
    "error_type": "string (optional)",
    "non_retryable": "boolean (optional)"
  }
}
```

**Headers Required (all POST requests to /api/v1 routes):**
```
Authorization: Bearer {agent_token}
Content-Type: application/json
X-OpenBox-SDK-Version: string (recommended, e.g. "openbox-typescript-v0.1.0")
X-OpenBox-Agent-DID: string (required if SigningRequired=true on agent)
X-OpenBox-Agent-Timestamp: RFC3339Nano (required if SigningRequired=true)
X-OpenBox-Agent-Nonce: UUID string (required if SigningRequired=true)
X-OpenBox-Agent-Signature: Base64 string (required if SigningRequired=true)
X-OpenBox-Body-SHA256: Hex string (required if SigningRequired=true)
```

**Response** (HTTP 200):
```json
{
  "governance_event_id": "uuid string",
  "verdict": "allow | constrain | require_approval | block | halt",
  "risk_score": 0.0-1.0,
  "action": "allow | constrain | require_approval | block | halt",
  "trust_tier": 1-4 (optional),
  "behavioral_violations": ["string"] (optional),
  "approval_id": "uuid string (optional, for require_approval)",
  "constraints": ["string"] (optional),
  "approval_expiration_time": "RFC3339Nano timestamp (optional)",
  "fallback_used": boolean,
  "reason": "string (optional)",
  "policy_id": "uuid string (optional)",
  "metadata": {} (optional),
  "guardrails_result": {...} (optional),
  "age_result": {...} (optional)
}
```

**Verdict deserialization:**
- Accepts both string ("allow") and numeric (0) formats (UnmarshalJSON lines 134-153)
- Maps to enum: allow=0, constrain=1, require_approval=2, block=3, halt=4

**Event validation (line 66):**
- Only accepts the 7 event types listed above
- Returns **400 with reason** if EventType is unknown (after auth check, to prevent token probing)

**Error codes:**
- **400**: Invalid request body, invalid event_type (line 37-68)
- **401**: Missing/invalid token or agent identity (line 51-62)
- **500**: Internal server error (line 91)

**Idempotency:** Server handles duplicate submissions (same workflow_id + run_id + event_type) → returns cached verdict. SDK does not need explicit dedup.

---

### 2.3 POST /api/v1/governance/approval

**Location in code:** `internal/api/governance.go:205-261` (GetApprovalStatus handler)

**Request:**
```json
{
  "workflow_id": "string (required)",
  "run_id": "string (required)",
  "activity_id": "string (required)"
}
```

**Response** (HTTP 200):
```json
{
  "id": "uuid string",
  "action": "allow | block | halt | require_approval",
  "reason": "string (optional)",
  "approval_expiration_time": "RFC3339Nano timestamp (optional)"
}
```

**Semantics:**
- **"allow"** → Approval granted, SDK proceeds
- **"block"** → Approval denied, raise non-retryable error
- **"halt"** → Approval expired (server auto-transitioned after `approval_expiration_time`), raise error + terminate workflow
- **"require_approval"** → Still pending, SDK continues polling

**Error codes:**
- **400**: Missing required fields or malformed body (line 224-227)
- **401**: Missing/invalid token or agent identity
- **404**: Governance event not found (line 257)
- **500**: Internal error

---

## 3. Request Signing Verification (CRITICAL)

**Location in code:** `internal/services/agent.go:93-199` (ValidateAgentIdentity)

### 3.1 Canonical String Construction

**Function:** `BuildAgentIdentityCanonicalRequest(method, path, timestamp, nonce, bodySHA256)` (lines 93-101)

**Exact format:**
```
{METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}\n{BODY_SHA256}\n
```

**Components:**
1. **METHOD**: Request method (e.g., "POST", "GET"), **uppercase** (via `strings.ToUpper()` line 95)
2. **PATH**: Full request path, **includes `/api/v1` prefix** (e.g., `/api/v1/governance/evaluate`)
3. **TIMESTAMP**: RFC3339Nano format (verified against system clock within ±5 minutes, line 157)
4. **NONCE**: Unique identifier (enforced via replay cache, 5-minute TTL per (did, nonce) tuple)
5. **BODY_SHA256**: SHA256 of request body in **hex format** (not base64), computed as:
   ```go
   bodyHash := sha256.Sum256(body)
   bodyHashHex := hex.EncodeToString(bodyHash[:])  // Hex, not base64
   ```

**Separator:** Newline `\n` between each field, **including trailing newline** (verified in test at agent_test.go)

**Example canonical string:**
```
POST
/api/v1/governance/evaluate
2026-07-08T10:15:30.123456Z
550e8400-e29b-41d4-a716-446655440000
a7b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2
```

### 3.2 Signing Algorithm

**Algorithm:** Ed25519 (elliptic-curve signature, 64-byte signatures)  
**Signature Encoding:** Base64 (standard, not URL-safe) in header `X-OpenBox-Agent-Signature`  
**Verification:** Via AWS KMS key alias `alias/openbox-agent/{did-uuid}` (line 183)

**Did Format:**
- Format: `did:aip:{uuid}`
- UUID derivation: `uuid.NewSHA1(OpenBoxAIPNamespace, []byte(agentID))`
- Namespace: OpenBoxAIPNamespace (defined in const, line 142 references expected DID)
- Validation: Claimed DID in header must match derived SHA1 (line 142-148)

### 3.3 HTTP Headers

**All required if agent.SigningRequired = true (line 108):**

| Header | Value | Example |
|--------|-------|---------|
| `X-OpenBox-Agent-DID` | `did:aip:{uuid}` | `did:aip:550e8400-e29b-41d4-a716-446655440000` |
| `X-OpenBox-Agent-Timestamp` | RFC3339Nano | `2026-07-08T10:15:30.123456789Z` |
| `X-OpenBox-Agent-Nonce` | UUID or unique string | `550e8400-e29b-41d4-a716-446655440001` |
| `X-OpenBox-Agent-Signature` | Base64 Ed25519 signature | (64-byte signature, base64-encoded) |
| `X-OpenBox-Body-SHA256` | Hex SHA256 | `a7b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2` |

**Header validation:**
- All 5 headers must be present OR none (line 119-133)
- If any header is missing, return **401 "invalid token or agent identity"** (line 245)

### 3.4 Timestamp Tolerance & Validation

**Format requirement:** RFC3339Nano (line 150)  
**Tolerance window:** ±5 minutes (configurable via `OPENBOX_AGENT_IDENTITY_REPLAY_TTL_SECONDS`, default 300s, line 74 & 157)  
**Rejection:** If timestamp is outside ±5 minute window from NOW, return **401** (line 157-163)

### 3.5 Body Hash Verification

**Algorithm:** SHA256  
**Encoding:** Hexadecimal (not base64)  
**Comparison:** Constant-time comparison to prevent timing attacks (line 167)  
**Input:** Raw request body bytes (before JSON parsing)

**Special case:** For GET /api/v1/auth/validate with no body, compute SHA256 of empty bytes:
```go
bodyHash := sha256.Sum256([]byte{})  // Empty
bodyHashHex := hex.EncodeToString(bodyHash[:])
// Result: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

### 3.6 Nonce Replay Protection

**Mechanism:** Redis cache with key `agent_identity_nonce:{did}:{nonce}`, TTL = 5 minutes (line 207-227)  
**Check:** If nonce appears in cache → reject with **401 "nonce replayed"** (line 213)  
**Set:** After validation passes, store nonce in cache (line 220)  
**Failure modes:**
- Cache miss during GET → return **500 "identity verifier unavailable"** (line 218)
- Cache miss during SET → return **500** (line 222)

### 3.7 Validation Order (Critical for SDK Implementation)

1. Check agent.SigningRequired flag (line 108) — skip all below if false
2. Verify all 5 headers present (line 119-133)
3. Parse DID from header, extract UUID (line 135-140)
4. Verify claimed DID matches SHA1(agentID) (line 142-148)
5. Parse timestamp, check RFC3339Nano format (line 150-155)
6. Verify timestamp within ±5 minute window (line 157-163)
7. Compute body SHA256, compare against header (line 165-173)
8. Decode signature from Base64 (line 175-180)
9. Build canonical request from (method, path, timestamp, nonce, bodyHashHex) (line 182)
10. Verify Ed25519 signature via KMS (line 184-197)
11. Check nonce not replayed (line 199-227)

**SDK MUST verify in same order to catch auth errors with correct codes.**

---

## 4. Event Wire Types & Vocabulary

**Event types** (from `internal/content/governance.go:12-20`):

```go
const (
    EventTypeWorkflowStarted   = "WorkflowStarted"
    EventTypeWorkflowCompleted = "WorkflowCompleted"
    EventTypeWorkflowFailed    = "WorkflowFailed"
    EventTypeSignalReceived    = "SignalReceived"
    EventTypeActivityStarted   = "ActivityStarted"
    EventTypeActivityCompleted = "ActivityCompleted"
    EventTypeHandoff           = "Handoff"
)
```

**Hook events:** ActivityStarted with `hook_trigger: true` + 1 span (stage: "started" or "completed")

---

## 5. SpanData Wire Schema (CRITICAL)

**Location in code:** `internal/content/governance.go:266-318` (SpanData struct)

### 5.1 Full Struct Definition

```go
type SpanData struct {
    SpanID          string                 `json:"span_id"`              // (req)
    TraceID         string                 `json:"trace_id"`             // (req)
    ParentSpanID    *string                `json:"parent_span_id,omitempty"`
    Name            string                 `json:"name"`                 // (req)
    Kind            *string                `json:"kind,omitempty"`       // "CLIENT", "SERVER", "INTERNAL", etc.
    StartTime       int64                  `json:"start_time"`           // (req) Unix nanoseconds
    EndTime         int64                  `json:"end_time"`             // (req) Unix nanoseconds; 0 for "started"
    DurationNs      *int64                 `json:"duration_ns,omitempty"`
    Attributes      map[string]interface{} `json:"attributes,omitempty"`
    Status          *SpanStatus            `json:"status,omitempty"`
    Events          []SpanEvent            `json:"events,omitempty"`
    RequestHeaders  map[string]string      `json:"request_headers,omitempty"`
    ResponseHeaders map[string]string      `json:"response_headers,omitempty"`
    RequestBody     *string                `json:"request_body,omitempty"`
    ResponseBody    *string                `json:"response_body,omitempty"`
    SemanticType    string                 `json:"semantic_type,omitempty"` // Server-computed
    Stage           string                 `json:"stage,omitempty"`         // "started" or "completed"
    Data            interface{}            `json:"data,omitempty"`
    
    // Root-level SDK v2 fields (alternative to attributes map)
    HookType                string   `json:"hook_type,omitempty"`
    AttributeKeyIdentifiers []string `json:"attribute_key_identifiers,omitempty"`
    SpanError               *string  `json:"error,omitempty"`
    
    // HTTP-specific
    HTTPMethod     *string `json:"http_method,omitempty"`
    HTTPURL        *string `json:"http_url,omitempty"`
    HTTPStatusCode *int    `json:"http_status_code,omitempty"`
    
    // DB-specific
    DBSystem    *string `json:"db_system,omitempty"`
    DBName      *string `json:"db_name,omitempty"`
    DBOperation *string `json:"db_operation,omitempty"`
    DBStatement *string `json:"db_statement,omitempty"`
    ServerAddr  *string `json:"server_address,omitempty"`
    ServerPort  *int    `json:"server_port,omitempty"`
    Rowcount    *int    `json:"rowcount,omitempty"`
    
    // File-specific
    FilePath      *string `json:"file_path,omitempty"`
    FileMode      *string `json:"file_mode,omitempty"`
    FileOperation *string `json:"file_operation,omitempty"`
    BytesRead     *int64  `json:"bytes_read,omitempty"`
    BytesWritten  *int64  `json:"bytes_written,omitempty"`
    LinesCount    *int    `json:"lines_count,omitempty"`
    
    // Function-specific
    FuncName   *string     `json:"function,omitempty"`
    Module     *string     `json:"module,omitempty"`
    Args       interface{} `json:"args,omitempty"`
    FuncResult interface{} `json:"result,omitempty"`
}

type SpanStatus struct {
    Code        string  `json:"code"`
    Description *string `json:"description,omitempty"`
}

type SpanEvent struct {
    Name       string                 `json:"name"`
    Timestamp  int64                  `json:"timestamp"`
    Attributes map[string]interface{} `json:"attributes"`
}
```

### 5.2 **RESOLVED: StartTime/EndTime Null Handling**

**Question:** Can Python SDK emit `null` for `end_time` in started spans?

**Answer:** YES, it is safe. Here's why:

1. **Type Definition:** `EndTime int64` (line 273) — non-pointer int64, NOT `*int64`
2. **JSON Unmarshaling Behavior:** Go's standard JSON unmarshaler, when encountering `null` for a non-pointer int64, decodes it to **zero** (0)
3. **SDK Integration Guide Says:** "Use `0` for `stage:"started"` spans" (line 309 of integration guide)
4. **Go Default:** Zero-value for int64 is 0, so `null` → 0 → no semantic difference

**Server-side Processing:**
- Span storage (storage_spans.go line 79) converts int64 nanoseconds to time.Time: `time.Unix(0, span.StartTime)`
- For "started" spans: `time.Unix(0, 0)` = Unix epoch (1970-01-01T00:00:00Z)
- This is acceptable because OPA policy evaluation (opa.go) checks `stage == "started"`, not the time value

**Verdict:** Python SDK emitting `{"end_time": null}` will unmarshal to `EndTime: 0`, which is correct. SDK SHOULD emit **either**:
- **Option A (recommended):** Emit `"end_time": 0` (explicit)
- **Option B (works, but less clear):** Emit `"end_time": null` (relies on JSON unmarshaler default)

**TypeScript SDK Recommendation:** Emit explicit `0` to match the spec and make intent clear.

---

## 6. Verdict & Decision Vocabulary

**Source:** `internal/content/governance.go:22-69`

### 6.1 Verdict Enum (Internal)

```go
type Verdict int32

const (
    VerdictAllow           Verdict = 0
    VerdictConstrain       Verdict = 1
    VerdictRequireApproval Verdict = 2
    VerdictBlock           Verdict = 3
    VerdictHalt            Verdict = 4
)
```

### 6.2 Action String Constants (API Response)

```go
const (
    ActionAllow           = "allow"
    ActionConstrain       = "constrain"
    ActionRequireApproval = "require_approval"
    ActionBlock           = "block"
    ActionHalt            = "halt"
    
    // v1.0 backward compat
    ActionContinue = "continue"
    ActionStop     = "stop"
)
```

### 6.3 API Response Serialization

- **Verdict field:** Returns string (e.g., "allow") from `VerdictToAction()` (line 54-69)
- **Action field (v1.0 compat):** Also returns same string as verdict
- **Deserialization:** Server accepts both string and numeric formats (UnmarshalJSON line 134-153)

**Priority order (when multiple evaluators run):** HALT (highest) > BLOCK > REQUIRE_APPROVAL > CONSTRAIN > ALLOW (lowest, line 107)

---

## 7. Approval Semantics

**Source:** `internal/api/governance.go:205-261` (GetApprovalStatus), `internal/services/governance.go` (ApprovalStatusResponse)

### 7.1 Approval Status Response

```json
{
  "id": "uuid-string",
  "action": "allow | block | halt | require_approval",
  "reason": "optional-string",
  "approval_expiration_time": "optional-RFC3339Nano-timestamp"
}
```

### 7.2 Action Semantics

| Action | Meaning | SDK Response |
|--------|---------|-------------|
| `"allow"` | Approval granted | Proceed with execution |
| `"block"` | Approval denied | Raise non-retryable GovernanceError |
| `"halt"` | Expired (auto-transitioned by server) | Raise error + terminate workflow |
| `"require_approval"` | Still pending | Continue polling (sleep 2-5s, retry) |

**Server-side expiry:** Server scheduler automatically transitions `require_approval` → `halt` when `approval_expired_at` passes (default 30 min, configurable per agent, line 588 of integration guide)

**SDK Responsibility:** Poll until server returns terminal verdict (allow, block, or halt). No client-side timeout required (server handles it), but optional generous client-side timeout (e.g., 60 min) as fallback recommended.

---

## 8. Additional Request Response Fields

### 8.1 GovernanceVerdictPublicResponse (Full Schema)

**Source:** `internal/content/governance.go:365-389` (ToPublicResponse transforms internal response)

```json
{
  "governance_event_id": "uuid-string (required)",
  "verdict": "string (required, e.g. 'allow')",
  "risk_score": "float64 (required, 0.0-1.0)",
  "action": "string (required, v1.0 compat, same as verdict)",
  
  // v1.1 optional
  "trust_tier": "int 1-4 (optional)",
  "behavioral_violations": ["string"] (optional),
  "approval_id": "uuid-string (optional, for require_approval polling)",
  "constraints": ["string"] (optional, for constrain verdict)",
  "approval_expiration_time": "RFC3339Nano (optional)",
  
  // Flags
  "fallback_used": "boolean (required, true if any service fell back)",
  
  // v1.0 optional
  "reason": "string (optional)",
  "policy_id": "uuid-string (optional)",
  "metadata": "{} (optional)",
  "guardrails_result": {...GuardrailsResult...} (optional),
  "age_result": {...AGEResult...} (optional)
}
```

### 8.2 GuardrailsResult Schema

```json
{
  "input_type": "activity_input | activity_output",
  "redacted_input": "any (JSON-serializable object)",
  "raw_logs": "{} (optional)",
  "validation_passed": "boolean",
  "reasons": [
    {
      "type": "string (guardrail_type)",
      "field": "string",
      "reason": "string"
    }
  ],
  "results": [
    {
      "guardrail_type": "string",
      "results": [
        {
          "field": "string",
          "order": "int",
          "status": "string (e.g. 'block', 'allowed')",
          "reason": "string (optional)"
        }
      ]
    }
  ]
}
```

### 8.3 AGEResult Schema

```json
{
  "allowed": "boolean",
  "verdict": "string (allow|block|halt|etc, from Verdict enum)",
  "reason": "string (optional)",
  "goal_alignment_checked": "boolean",
  "goal_drifted": "boolean",
  "fallback_used": "boolean",
  "final_trust_score": {
    "trust_score": "float64",
    "trust_tier": "int",
    "behavioral_compliance": "float64",
    "alignment_consistency": "float64",
    "aivss_baseline": "float64"
  },
  "span_results": [
    {
      "span_id": "string",
      "semantic_type": "string",
      "behavioral_result": "any (optional, can be null)",
      "alignment_result": {
        "is_aligned": "boolean",
        "score": "float64"
      },
      "trust_score_after": {... (optional)},
      "timestamp": "RFC3339Nano"
    }
  ],
  "total_spans": "int",
  "violations_count": "int",
  "response_time_ms": "int64"
}
```

---

## Contracts the TS SDK MUST Satisfy

1. **Request Signing (if enabled):**
   - Construct canonical request: `{METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}\n{BODY_SHA256}\n`
   - METHOD = uppercase POST/GET
   - PATH = full path including `/api/v1`
   - TIMESTAMP = RFC3339Nano format, within ±5 min of server time
   - NONCE = unique per request (UUID recommended)
   - BODY_SHA256 = hex-encoded SHA256 of request body
   - Sign with Ed25519 private key
   - Encode signature as Base64 (standard, not URL-safe)
   - Include all 5 headers (DID, Timestamp, Nonce, Signature, BodySHA256)

2. **Payload Validation:**
   - All 7 common fields required (source, event_type, workflow_id, run_id, workflow_type, task_queue, timestamp)
   - Event-type specific fields per schema (activity_*, signal_*, etc.)
   - Spans array: each span must have span_id, trace_id, name, start_time, end_time (0 for stage:"started")

3. **Verdict Handling:**
   - Deserialize verdict as string ("allow", "constrain", "require_approval", "block", "halt")
   - Enforce: block → raise non-retryable error; halt → raise error + terminate; require_approval → poll
   - Support both string and numeric verdict formats on response

4. **Approval Polling:**
   - Poll `/api/v1/governance/approval` with {workflow_id, run_id, activity_id}
   - Continue until action is "allow", "block", or "halt" (not "require_approval")
   - Respect server-side expiry: if halt returned, it means approval expired

5. **Token Validation:**
   - On init: GET /api/v1/auth/validate to verify token validity
   - Fail init if valid=false or active=false
   - Store agent_id for debugging

6. **Error Handling:**
   - 401 → authentication failure (invalid token or signature)
   - 400 → malformed request (retry won't fix)
   - 404 → resource not found
   - 5xx → server error, retry with backoff

7. **SpanData Wire Format:**
   - startTime/endTime: int64 nanoseconds (not seconds, not milliseconds)
   - endTime: 0 for stage:"started", actual time for stage:"completed"
   - stage: always set (defaults to "completed" if omitted)
   - attributes: object map of string → any (OTel standard)
   - requestBody/responseBody: string (optional, for HTTP/LLM)

---

## Unresolved Questions

None. All contracts verified from source code:
- `internal/api/*.go` for endpoint handlers
- `internal/content/governance.go` for data models
- `internal/services/agent.go` for signing verification
- `docs/sdk-integration-guide.md` for SDK-facing spec

---

**Status:** DONE  
**Summary:** Extracted exact wire contracts for 3 endpoints, signing scheme (Ed25519 + SHA256 body hash), 7 event types, SpanData schema with end_time resolution, verdict/approval semantics. All critical paths verified against source code.
