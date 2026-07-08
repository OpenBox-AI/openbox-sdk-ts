# Phase 2: Contracts Config Identity Client

## Goal

Port the core typed primitives that do not depend on framework lifecycle:
contracts, result parsing, config, identity/signing, serialization, and HTTP
client behavior.

## Work

1. Implement error classes:
   - `OpenBoxError`
   - `OpenBoxConfigError`
   - `OpenBoxAuthError`
   - `OpenBoxNetworkError`
   - `OpenBoxAPIError`
   - `ContractError`
   - `OpenBoxInsecureURLError`

2. Implement result contracts:
   - `Verdict`
   - `GuardrailsResult`
   - `EvaluationResult`
   - `ApprovalResult`

3. Implement config:
   - `OpenBoxConfig`
   - `HitlConfig`
   - `TelemetryConfig`
   - `InstrumentationConfig`
   - `GateConfig`
   - `PrivacyConfig`
   - layered resolution: explicit > SDK prefix env > global `OPENBOX_*` >
     defaults > validation

4. Implement serialization:
   - stable JSON body bytes
   - redaction and truncation helpers
   - byte equality tests between hashed body and transmitted body

5. Implement identity/signing:
   - DID validation: `did:aip:<uuid>`
   - base64 raw 32-byte Ed25519 seed validation
   - canonical string:

     ```text
     UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
     ```

   - signed request header preparation

6. Implement client:
   - validate auth
   - evaluate
   - approval poll
   - timeout handling
   - retry policy where appropriate
   - fail-open/fail-closed behavior matching Python base SDK
   - raw response preservation

## Acceptance Criteria

- Golden signing tests prove byte-level compatibility with the Python/Core
  contract.
- Unknown evaluate response fields are preserved in `raw`.
- Unknown approval decisions do not become implicit ALLOW.
- `guardrails` and `guardrailsResult` compatibility surfaces cannot diverge.
- Config validation rejects invalid API key format and insecure non-local HTTP
  URLs.
- Missing only one of `agentDid` and `agentPrivateKey` is a config error.
- No runtime-heavy dependencies are imported from the package root.

## Explicit Non-Goals

- Do not implement framework adapter behavior yet.
- Do not implement OTel or hook instrumentation yet.
- Do not depend on Mastra.

## Test Focus

- `Verdict.fromString`
- approval action precedence
- fail-open fallback marker
- stable body serialization
- signed headers for empty and non-empty bodies
- path includes `/api/v1`
- config precedence
- local HTTP URL allowance
- non-local HTTP URL rejection
