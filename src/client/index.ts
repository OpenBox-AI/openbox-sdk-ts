/**
 * OpenBoxClient — async HTTP client for the OpenBox Core governance API.
 *
 * Endpoints:
 *   POST /api/v1/governance/evaluate   — lifecycle + hook evaluations
 *   POST /api/v1/governance/approval   — HITL approval polling
 *   GET  /api/v1/auth/validate         — API key / signing validation
 *
 * Transport rules:
 * - Signed requests send the raw body bytes verbatim — never re-serialize (that
 *   breaks Core's body-hash verification).
 * - Uses the global `fetch` + `AbortSignal.timeout`; injectable for tests.
 * - Fail-open/closed applies to NETWORK/outage failures only. A persistent
 *   AUTH/SIGNING rejection (401/403) is NOT an outage and must never be laundered
 *   into a fail-open ALLOW — that would silently disable governance fleet-wide on
 *   a key/clock/signing break. Auth failures are loud and fail-closed regardless
 *   of `onApiError`.
 */

import {
  ApprovalResult,
  EvaluationResult,
  verdictShouldStop
} from "../contracts/results.js";
import type { JsonValue } from "../contracts/results.js";
import {
  GovernanceAPIError,
  OpenBoxAuthError,
  OpenBoxNetworkError,
  mapSigningError
} from "../errors/index.js";
import { prepareSignedRequest } from "../identity/index.js";
import type { AgentIdentity } from "../identity/index.js";
import type { OnApiError } from "../config/index.js";
// Phase 5 wiring: every fetch this client makes is the SDK's OWN governance
// traffic, never something to govern. `runAsInternal` marks the whole async
// chain of each call below so the Node instrumentation fetch patch (which may
// have replaced `globalThis.fetch` — this client's `fetchImpl` default —
// either before or after this client was constructed) sees
// `isInternalCall() === true` and skips governance unconditionally, instead
// of recursing into evaluating its own evaluate/approval/auth-validate calls.
// `recursion-guard.ts` is a dependency-free leaf (only `node:async_hooks`),
// so this import cannot create a cycle back through `runtime`/`instrumentation`.
import { runAsInternal } from "../instrumentation/recursion-guard.js";

export const EVALUATE_PATH = "/api/v1/governance/evaluate";
export const APPROVAL_PATH = "/api/v1/governance/approval";
export const AUTH_VALIDATE_PATH = "/api/v1/auth/validate";

export interface ClientLogger {
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export interface OpenBoxClientOptions {
  timeoutSeconds?: number;
  onApiError?: OnApiError;
  identity?: AgentIdentity | null;
  sdkVersion?: string | null;
  sdkEngine?: string;
  sdkLanguage?: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: ClientLogger;
}

type Dict = Record<string, unknown>;

/** Set `expired=true` on `data` if `approval_expiration_time` is in the past. */
export function checkExpiration(data: Dict): Dict {
  const raw = data["approval_expiration_time"];
  if (typeof raw !== "string" || !raw) return data;
  try {
    // Handle ISO `Z`, ISO offset, and space-separated DB formats. A tz-naive
    // timestamp is assumed UTC (matching Python) — `new Date("...T00:00:00")`
    // would otherwise parse as host-local time and mis-flag expiry by the offset.
    let normalized = raw.replace("Z", "+00:00").replace(" ", "T");
    if (!/[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += "+00:00";
    const expiration = new Date(normalized);
    if (!Number.isNaN(expiration.getTime()) && Date.now() > expiration.getTime()) {
      data["expired"] = true;
    }
  } catch {
    /* parse failures are non-fatal — never raise from expiry parsing */
  }
  return data;
}

/** Machine reason code from Core's JSON error body, if present. */
function extractReasonCode(body: string | null): string | null {
  if (!body) return null;
  try {
    const data: unknown = JSON.parse(body);
    if (typeof data !== "object" || data === null) return null;
    const dict = data as Dict;
    const code = dict["reason_code"] ?? dict["code"] ?? dict["reason"];
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export class OpenBoxClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly onApiError: OnApiError;
  private readonly identity: AgentIdentity | null;
  private readonly sdkVersion: string | null;
  private readonly sdkEngine: string | undefined;
  private readonly sdkLanguage: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ClientLogger;
  private consecutiveAuthFailures = 0;

  constructor(apiUrl: string, apiKey: string, options: OpenBoxClientOptions = {}) {
    const onApiError = options.onApiError ?? "fail_open";
    if (
      onApiError !== "fail_open" &&
      onApiError !== "fail_closed" &&
      onApiError !== "fail_closed_destructive"
    ) {
      throw new Error(
        `onApiError must be 'fail_open', 'fail_closed', or 'fail_closed_destructive', got ${String(onApiError)}`
      );
    }
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = Math.round((options.timeoutSeconds ?? 30.0) * 1000);
    this.onApiError = onApiError;
    this.identity = options.identity ?? null;
    this.sdkVersion = options.sdkVersion ?? null;
    this.sdkEngine = options.sdkEngine;
    this.sdkLanguage = options.sdkLanguage;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? console;
  }

  private prepared(
    method: string,
    path: string,
    payload: unknown
  ): { url: string; headers: Record<string, string>; body: Buffer } {
    const { headers, body } = prepareSignedRequest(method, path, payload, {
      apiKey: this.apiKey,
      identity: this.identity,
      sdkVersion: this.sdkVersion,
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    });
    return { url: `${this.apiUrl}${path}`, headers, body };
  }

  // ── Evaluate ────────────────────────────────────────────────────────────

  /**
   * POST a governance event; parse the verdict. Under fail_open, network/outage
   * failures return a `fallbackUsed=true` ALLOW. An auth/signing 401/403 throws
   * (never fail-opens) — see the class docstring.
   */
  async evaluate(payload: JsonValue): Promise<EvaluationResult> {
    const { url, headers, body } = this.prepared("POST", EVALUATE_PATH, payload);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs)
        })
      );
    } catch (e) {
      return this.networkFailure(`Governance API unreachable: ${errorMessage(e)}`, payload);
    }

    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("evaluate", response);
    }
    this.consecutiveAuthFailures = 0;
    if (response.status >= 400) {
      return this.networkFailure(`Governance API error: HTTP ${response.status}`, payload);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      return this.networkFailure(`Governance API returned unparseable body: ${errorMessage(e)}`, payload);
    }
    const result = EvaluationResult.fromDict((data ?? {}) as Dict);
    if (verdictShouldStop(result.verdict)) {
      this.logger.info(`Governance blocked: ${result.reason} (policy: ${result.policyId})`);
    }
    return result;
  }

  /**
   * Apply the onApiError policy to a NETWORK/outage failure. `fail_closed` blocks
   * everything; `fail_closed_destructive` blocks only when the payload carries a
   * destructive span (db/file write, non-idempotent HTTP) — reads/idempotent ops
   * and lifecycle events (no spans) fail open; `fail_open` always fails open.
   */
  private networkFailure(reason: string, payload: JsonValue): EvaluationResult {
    this.logger.warn(reason);
    const failClosed =
      this.onApiError === "fail_closed" ||
      (this.onApiError === "fail_closed_destructive" && payloadHasDestructiveSpan(payload));
    if (failClosed) throw new GovernanceAPIError(reason);
    return EvaluationResult.fallbackAllow(reason);
  }

  /**
   * An auth/signing rejection is never an outage. Emit a loud diagnostic and
   * fail CLOSED (throw) regardless of onApiError, so a signing break cannot
   * silently become a fleet-wide ALLOW.
   */
  private async rejectAuthFailure(op: string, response: Response): Promise<never> {
    this.consecutiveAuthFailures += 1;
    let reasonCode: string | null = null;
    if (this.identity !== null) {
      const text = await safeText(response);
      reasonCode = extractReasonCode(text);
    }
    this.logger.error(
      `OpenBox ${op} rejected with HTTP ${response.status} (auth/signing). ` +
        `Governance is NOT failing open on an auth rejection ` +
        `(consecutive=${this.consecutiveAuthFailures}) — check API key, signing key, and clock skew.` +
        (reasonCode ? ` reason=${reasonCode}` : "")
    );
    if (reasonCode) throw mapSigningError(reasonCode);
    throw new GovernanceAPIError(
      `Governance API auth rejected (HTTP ${response.status}); refusing to fail-open on an auth failure.`
    );
  }

  // ── Approval polling ──────────────────────────────────────────────────────

  /**
   * Poll HITL approval status once. Returns null on poll failure (still
   * pending). `signal` (e.g., a controller-shutdown abort) is composed with
   * the request timeout so either can cancel the in-flight fetch — but only a
   * caller-provided abort surfaces (thrown, not swallowed to null): the poller
   * must fail safe on shutdown rather than treat it as a transient failure to
   * retry. An internal-timeout-only abort keeps the existing null/retry
   * behavior.
   */
  async pollApproval(
    workflowId: string,
    runId: string,
    activityId: string,
    signal?: AbortSignal
  ): Promise<ApprovalResult | null> {
    const payload = { workflow_id: workflowId, run_id: runId, activity_id: activityId };
    const { url, headers, body } = this.prepared("POST", APPROVAL_PATH, payload);
    const composedSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: composedSignal
        })
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      this.logger.warn(`Failed to poll approval status: ${errorMessage(e)}`);
      return null;
    }
    if (response.status !== 200) {
      this.logger.warn(`Failed to get approval status: HTTP ${response.status}`);
      return null;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      this.logger.warn(`Failed to parse approval response: ${errorMessage(e)}`);
      return null;
    }
    const dict = (data ?? {}) as Dict;
    checkExpiration(dict);
    return ApprovalResult.fromDict(dict);
  }

  // ── Auth validation ───────────────────────────────────────────────────────

  /**
   * GET /api/v1/auth/validate (signed when identity is configured). Returns true
   * on success; throws OpenBoxAuthError/OpenBoxSigningError on 401/403,
   * OpenBoxNetworkError on connectivity failure.
   */
  async validateApiKey(): Promise<boolean> {
    const { url, headers } = this.prepared("GET", AUTH_VALIDATE_PATH, null);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.timeoutMs)
        })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 403) {
      // When signing is enabled, surface Core's machine reason code.
      const reasonCode =
        this.identity !== null ? extractReasonCode(await safeText(response)) : null;
      if (reasonCode) throw mapSigningError(reasonCode);
      throw new OpenBoxAuthError("Invalid API key. Check your API key at dashboard.openbox.ai");
    }
    throw new OpenBoxNetworkError(
      `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
    );
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

// Destructive-operation classification for the `fail_closed_destructive` outage
// policy. A destructive op mutates external state; a read/idempotent op does not.
const DESTRUCTIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DESTRUCTIVE_DB_OPERATIONS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "UPSERT",
  "MERGE",
  "REPLACE",
  "CREATE",
  "DROP",
  "TRUNCATE",
  "ALTER",
  "GRANT",
  "REVOKE"
]);
const DESTRUCTIVE_FILE_OPERATIONS = new Set(["write", "append"]);

/**
 * True if the evaluate payload carries a span for a destructive operation — a
 * db/file WRITE or a non-idempotent HTTP method. Lifecycle events carry no spans
 * → not destructive → they stay available under `fail_closed_destructive`.
 * `function_call` and reads (GET/SELECT) cannot be classified destructive.
 */
function payloadHasDestructiveSpan(payload: JsonValue): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const spans = payload["spans"];
  if (!Array.isArray(spans)) return false;
  return spans.some(
    (span) =>
      typeof span === "object" && span !== null && !Array.isArray(span) && isDestructiveSpan(span)
  );
}

function isDestructiveSpan(span: Record<string, JsonValue>): boolean {
  switch (span["hook_type"]) {
    case "http_request": {
      const method = span["http_method"];
      return typeof method === "string" && DESTRUCTIVE_HTTP_METHODS.has(method.toUpperCase());
    }
    case "db_query": {
      const op = span["db_operation"];
      return typeof op === "string" && DESTRUCTIVE_DB_OPERATIONS.has(op.toUpperCase());
    }
    case "file_operation": {
      const op = span["file_operation"];
      if (typeof op === "string" && DESTRUCTIVE_FILE_OPERATIONS.has(op.toLowerCase())) return true;
      // fs write/append/read-write modes: w, a, r+, w+, a+.
      const mode = span["file_mode"];
      return typeof mode === "string" && /[wa+]/i.test(mode);
    }
    default:
      return false;
  }
}
