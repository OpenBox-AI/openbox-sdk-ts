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
  OpenBoxConfigError,
  OpenBoxNetworkError,
  mapSigningError
} from "../errors/index.js";
import { mapAssertionError } from "../errors/assertion.js";
import { AgentIdentity, prepareSignedRequest } from "../identity/index.js";
import { OktaAgentIdentity, prepareOktaSignedRequest } from "../identity/okta.js";
import type { OktaTransitionClaims } from "../identity/okta.js";
import type {
  OktaAiAgentIdentityConfig,
  OpenBoxDidIdentityConfig
} from "../identity/types.js";
import type { OnApiError } from "../config/index.js";
import { buildHandoffRequestBody, parseHandoffResponse } from "./handoff.js";
import type { HandoffOptions, HandoffResult } from "./handoff.js";
import {
  assertCandidateMatchesExpectedTarget,
  parseTransitionProofResponse
} from "./transition-preflight.js";
import type {
  TransitionExpectedTarget,
  TransitionPreflightResult
} from "./transition-preflight.js";
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
import {
  assertPrivateKeyMatchesDocument,
  fetchBootstrapDocument,
  type IdentityBootstrapDocument
} from "../config/bootstrap.js";
import { loadRsaPkcs8PrivateKey } from "../identity/okta.js";

// v1 (openbox_did / legacy_unsigned) — unchanged, byte-compatible.
export const EVALUATE_PATH = "/api/v1/governance/evaluate";
export const APPROVAL_PATH = "/api/v1/governance/approval";
export const AUTH_VALIDATE_PATH = "/api/v1/auth/validate";
export const HANDOFF_PATH_V1 = "/api/v1/handoffs";
export const TRANSITION_PROOF_PATH_V1 = "/api/v1/auth/transition-proof";

// v2 (okta_ai_agent) — contract §2.2. No cross-version retry (proposal §13.3).
export const EVALUATE_PATH_V2 = "/api/v2/governance/evaluate";
export const APPROVAL_PATH_V2 = "/api/v2/governance/approval";
export const AUTH_VALIDATE_PATH_V2 = "/api/v2/auth/validate";
export const HANDOFF_PATH_V2 = "/api/v2/handoffs";
export const TRANSITION_PROOF_PATH_V2 = "/api/v2/auth/transition-proof";

export interface ClientLogger {
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export interface OpenBoxClientOptions {
  timeoutSeconds?: number;
  onApiError?: OnApiError;
  /** v1 (`openbox_did`) identity. Mutually exclusive with `oktaIdentity`. */
  identity?: AgentIdentity | null;
  /**
   * v2 (`okta_ai_agent`) identity. When set, EVERY route this client calls
   * (evaluate/approval/validate/handoff) selects the `/api/v2/*` equivalent
   * and signs `X-OpenBox-Agent-Assertion` instead of v1's DID headers —
   * mutually exclusive with `identity` (contract §1, proposal §13.3).
   */
  oktaIdentity?: OktaAgentIdentity | null;
  /**
   * PKCS8 PEM RSA private key for BOOTSTRAP mode: the client fetches the
   * agent's non-secret identity metadata from
   * `GET /api/v2/auth/bootstrap` and builds its `oktaIdentity` from the result.
   *
   * Mutually exclusive with `oktaIdentity` (that is already-resolved metadata)
   * and with `identity` (a different method entirely). Supplying this makes the
   * client a v2 client IMMEDIATELY — before the fetch completes — so a bootstrap
   * failure can never be mistaken for "no v2 identity configured" and silently
   * downgrade the request to v1.
   */
  oktaBootstrapPrivateKey?: string | null;
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
  // Not `readonly`: in bootstrap mode this starts null and is populated once
  // Core's metadata arrives, and is replaced by refreshIdentityMetadata().
  private oktaIdentity: OktaAgentIdentity | null;
  private readonly oktaBootstrapPrivateKey: string | null;
  /**
   * In-flight bootstrap, shared by concurrent first requests so N simultaneous
   * calls perform ONE fetch rather than N. Cleared on failure so a later request
   * can retry a transient outage; never cleared-and-retried automatically within
   * a single failed attempt.
   */
  private bootstrapInFlight: Promise<IdentityBootstrapDocument> | null = null;
  /** The validated document backing `oktaIdentity`, for `identityMetadata()`. */
  private bootstrapDocument: IdentityBootstrapDocument | null = null;
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
    if (options.identity && options.oktaIdentity) {
      throw new OpenBoxConfigError(
        "OpenBoxClient received both a v1 identity and a v2 oktaIdentity; exactly one (or neither) is allowed."
      );
    }
    if (options.oktaBootstrapPrivateKey && options.oktaIdentity) {
      throw new OpenBoxConfigError(
        "OpenBoxClient received both oktaBootstrapPrivateKey and a fully resolved oktaIdentity; " +
          "supply exactly one — bootstrap mode fetches the metadata that oktaIdentity already carries."
      );
    }
    if (options.oktaBootstrapPrivateKey && options.identity) {
      throw new OpenBoxConfigError(
        "OpenBoxClient received both oktaBootstrapPrivateKey (okta_ai_agent) and a v1 identity " +
          "(openbox_did); exactly one identity method is allowed."
      );
    }
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = Math.round((options.timeoutSeconds ?? 30.0) * 1000);
    this.onApiError = onApiError;
    this.identity = options.identity ?? null;
    this.oktaIdentity = options.oktaIdentity ?? null;
    this.oktaBootstrapPrivateKey = options.oktaBootstrapPrivateKey ?? null;
    this.sdkVersion = options.sdkVersion ?? null;
    this.sdkEngine = options.sdkEngine;
    this.sdkLanguage = options.sdkLanguage;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? console;
  }

  /**
   * True when this client is configured for the v2 (`okta_ai_agent`) method.
   *
   * Deliberately true while a bootstrap is still pending. Route selection must
   * not depend on whether the metadata has ARRIVED yet — otherwise an
   * unreachable Core would turn a v2 client into a v1 one and send an unsigned
   * request, which no failure is ever permitted to cause.
   */
  private get isV2(): boolean {
    return this.oktaIdentity !== null || this.oktaBootstrapPrivateKey !== null;
  }

  /**
   * The validated bootstrap document, or null when this client is not in
   * bootstrap mode or has not bootstrapped yet. Non-secret; safe to log.
   */
  identityMetadata(): IdentityBootstrapDocument | null {
    return this.bootstrapDocument;
  }

  /**
   * Re-fetch identity metadata from Core and replace the cached copy.
   *
   * For long-running agents whose selected credential changed. The private-key
   * thumbprint is re-verified BEFORE anything is replaced, so a refresh that
   * discovers a rotated-away credential throws and leaves the client on its
   * previous (still self-consistent) identity rather than adopting metadata this
   * runtime cannot sign for.
   *
   * This is explicit on purpose. The client never refreshes automatically after a
   * signature, binding, or credential error: rotation may have selected a new
   * public key while this process still holds the old private key, so a blind
   * refresh-and-replay would hide the real problem and could not repair it.
   */
  async refreshIdentityMetadata(): Promise<IdentityBootstrapDocument> {
    if (this.oktaBootstrapPrivateKey === null) {
      throw new OpenBoxConfigError(
        "refreshIdentityMetadata() requires identity bootstrap mode; this client was constructed " +
          "with explicit Okta identity configuration."
      );
    }
    // Any in-flight first bootstrap is superseded by this explicit refresh.
    this.bootstrapInFlight = null;
    // runBootstrap publishes the identity AND the document together, only after
    // the thumbprint check passes — so there is no window in which
    // identityMetadata() reports one credential while requests sign with another.
    const document = await this.runBootstrap(this.oktaBootstrapPrivateKey);
    return document;
  }

  /**
   * Resolve the v2 identity, bootstrapping once if needed.
   *
   * Concurrent callers share one in-flight fetch. On failure the shared promise
   * is cleared so a subsequent request may retry a transient outage — but the
   * failure itself always propagates to this caller.
   */
  private async ensureOktaIdentity(): Promise<OktaAgentIdentity> {
    if (this.oktaIdentity) return this.oktaIdentity;

    const privateKey = this.oktaBootstrapPrivateKey;
    if (privateKey === null) {
      // Unreachable via prepared(), which only calls this when isV2 is true and
      // oktaIdentity is null — i.e. bootstrap mode.
      throw new OpenBoxConfigError("No Okta identity is configured for this client.");
    }

    this.bootstrapInFlight ??= this.runBootstrap(privateKey).catch((e: unknown) => {
      this.bootstrapInFlight = null;
      throw e;
    });

    await this.bootstrapInFlight;
    // runBootstrap published the identity itself. Re-reading the field rather
    // than using the resolved value matters when an explicit refresh completed
    // while this call was waiting: the caller must sign with whatever is current,
    // never with a superseded identity this promise happens to carry.
    if (!this.oktaIdentity) {
      throw new OpenBoxConfigError("Identity bootstrap completed without an identity.");
    }
    return this.oktaIdentity;
  }

  /**
   * Fetch, validate, thumbprint-check, build the identity, and publish it.
   *
   * Order matters: the local key is parsed and size-checked first (a malformed
   * or undersized key fails without a network round trip), then the document is
   * fetched and structurally validated, then the thumbprint is compared. Only
   * after ALL of that are `oktaIdentity` and `bootstrapDocument` published —
   * together, in one synchronous step, so no observer can ever see the document
   * from one credential alongside the signing key of another.
   */
  private async runBootstrap(privateKeyPem: string): Promise<IdentityBootstrapDocument> {
    // Fails locally, before any request, on a malformed / non-RSA / undersized key.
    loadRsaPkcs8PrivateKey(privateKeyPem);

    const document = await runAsInternal(() =>
      fetchBootstrapDocument({
        apiUrl: this.apiUrl,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        sdkVersion: this.sdkVersion,
        ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
        ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
      })
    );

    // Throws on mismatch — no governed request is ever sent after this point.
    assertPrivateKeyMatchesDocument(privateKeyPem, document);

    const identity = OktaAgentIdentity.fromConfig({
      method: "okta_ai_agent",
      openboxAgentId: document.openboxAgentId,
      organizationId: document.organizationId,
      deploymentId: document.deploymentId,
      externalAgentId: document.okta.externalAgentId,
      keyId: document.okta.credentialKid,
      algorithm: "RS256",
      privateKey: privateKeyPem,
      audience: document.assertionAudience
    });

    // Published together — see this method's doc comment.
    this.oktaIdentity = identity;
    this.bootstrapDocument = document;
    this.logger.info(
      `OpenBox identity bootstrap succeeded (version ${document.bootstrapVersion}, ` +
        `agent ${document.openboxAgentId}, kid ${document.okta.credentialKid}, thumbprint matched)`
    );
    return document;
  }

  private async prepared(
    method: string,
    path: string,
    payload: unknown
  ): Promise<{ url: string; headers: Record<string, string>; body: Buffer }> {
    const sdkOptions = {
      apiKey: this.apiKey,
      sdkVersion: this.sdkVersion,
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    };
    // In bootstrap mode the identity is resolved here, on the first request that
    // needs it. This await is the only thing standing between an unresolved v2
    // client and a request; it throws rather than proceeding unsigned.
    const oktaIdentity = this.isV2 ? await this.ensureOktaIdentity() : null;
    // v2 sends ONLY X-OpenBox-Agent-Assertion + the base auth headers — never
    // v1 DID identity headers as a fallback (contract §2.1, proposal §13.4
    // step 11). Selecting `prepareOktaSignedRequest` here instead of
    // `prepareSignedRequest` is what guarantees that: the two functions build
    // disjoint header sets and this branch calls exactly one.
    const { headers, body } = oktaIdentity
      ? prepareOktaSignedRequest(method, path, payload, { ...sdkOptions, identity: oktaIdentity })
      : prepareSignedRequest(method, path, payload, { ...sdkOptions, identity: this.identity });
    return { url: `${this.apiUrl}${path}`, headers, body };
  }

  // ── Evaluate ────────────────────────────────────────────────────────────

  /**
   * POST a governance event; parse the verdict. Under fail_open, network/outage
   * failures return a `fallbackUsed=true` ALLOW. An auth/signing 401/403 throws
   * (never fail-opens) — see the class docstring.
   */
  async evaluate(payload: JsonValue): Promise<EvaluationResult> {
    const { url, headers, body } = await this.prepared(
      "POST",
      this.isV2 ? EVALUATE_PATH_V2 : EVALUATE_PATH,
      payload
    );
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
    if (this.identity !== null || this.isV2) {
      const text = await safeText(response);
      reasonCode = extractReasonCode(text);
    }
    this.logger.error(
      `OpenBox ${op} rejected with HTTP ${response.status} (auth/signing). ` +
        `Governance is NOT failing open on an auth rejection ` +
        `(consecutive=${this.consecutiveAuthFailures}) — check API key, signing key, and clock skew.` +
        (reasonCode ? ` reason=${reasonCode}` : "")
    );
    // v1 and v2 reason-code vocabularies are disjoint (Core's Phase 6
    // compatibility refactor kept v1's external codes byte-stable) — select
    // the mapper that matches the method actually in use.
    if (reasonCode) throw this.isV2 ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
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
    const { url, headers, body } = await this.prepared(
      "POST",
      this.isV2 ? APPROVAL_PATH_V2 : APPROVAL_PATH,
      payload
    );
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
    // An auth/signing rejection is never "still pending" — proposal §13.6:
    // never convert an approval authentication failure into null. This
    // mirrors evaluate()'s 401/403 handling exactly (previously only evaluate
    // had this fix; approval polling treated EVERY non-200, including
    // 401/403, as a retryable "still pending" failure).
    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("approval", response);
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
    const { url, headers } = await this.prepared(
      "GET",
      this.isV2 ? AUTH_VALIDATE_PATH_V2 : AUTH_VALIDATE_PATH,
      null
    );
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
        this.identity !== null || this.isV2 ? extractReasonCode(await safeText(response)) : null;
      if (reasonCode) throw this.isV2 ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
      throw new OpenBoxAuthError("Invalid API key. Check your API key at dashboard.openbox.ai");
    }
    throw new OpenBoxNetworkError(
      `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
    );
  }

  // ── Handoff (source-authenticated) ────────────────────────────────────────

  /**
   * `POST /api/{v1,v2}/handoffs` — proves the SOURCE agent via the configured
   * identity (never a caller-supplied source, contract §17.22). Unsigned
   * (`legacy_unsigned`) mode has no source-authenticated identity to prove
   * and must provision one first (proposal §13.3): "An updated unsigned
   * client must not call /api/v1/handoffs."
   */
  async sendHandoff(toAgentId: string, options: HandoffOptions = {}): Promise<HandoffResult> {
    // `!this.isV2`, never `this.oktaIdentity === null`: in bootstrap mode the
    // Okta identity is not resolved until the first request needs it, so
    // testing the resolved field here would reject a correctly configured
    // okta_ai_agent client whose first call happens to be a handoff — and
    // would tell the operator to provision an identity they already have.
    // Route selection on the next line already uses isV2 for exactly this reason.
    if (this.identity === null && !this.isV2) {
      throw new OpenBoxConfigError(
        "Cannot send a source-authenticated handoff in unsigned (legacy_unsigned) mode: " +
          "provision an OpenBox DID or Okta AI Agent identity first."
      );
    }
    const path = this.isV2 ? HANDOFF_PATH_V2 : HANDOFF_PATH_V1;
    const { url, headers, body } = await this.prepared("POST", path, buildHandoffRequestBody(toAgentId, options));
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("handoff", response);
    }
    if (response.status !== 200) {
      throw new GovernanceAPIError(`Handoff request failed: HTTP ${response.status}`);
    }
    return parseHandoffResponse((await response.json()) as Record<string, unknown>);
  }

  // ── Transition preflight ──────────────────────────────────────────────────

  /**
   * `POST /api/v2/auth/transition-proof` — proves possession of an EXPLICIT
   * candidate Okta identity (never this client's active identity, even if
   * one is configured). Proposal §13.5 / §17.28: omitting the candidate is a
   * local configuration error, and the helper never falls back to the active
   * signer, searches local keys by `kid`, or mutates the client's active
   * identity.
   */
  async validateOktaIdentityTransition(options: {
    transitionId: string;
    challenge: string;
    candidateIdentity: OktaAiAgentIdentityConfig;
    /** Optional local convenience check against prepare's non-secret metadata. */
    expectedTarget?: TransitionExpectedTarget;
  }): Promise<TransitionPreflightResult> {
    if (!options.candidateIdentity) {
      throw new OpenBoxConfigError(
        "validateOktaIdentityTransition requires an explicit candidateIdentity; it never falls " +
          "back to the client's active identity (proposal §17.28)."
      );
    }
    assertCandidateMatchesExpectedTarget(options.candidateIdentity, options.expectedTarget);

    const candidate = OktaAgentIdentity.fromConfig(options.candidateIdentity);
    const transition: OktaTransitionClaims = {
      transitionId: options.transitionId,
      transitionChallenge: options.challenge
    };
    const { headers, body } = prepareOktaSignedRequest(
      "POST",
      TRANSITION_PROOF_PATH_V2,
      { transition_id: options.transitionId },
      {
        apiKey: this.apiKey,
        identity: candidate, // EXPLICIT candidate — never this.oktaIdentity
        sdkVersion: this.sdkVersion,
        transition,
        ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
        ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
      }
    );
    return this.postTransitionProof(TRANSITION_PROOF_PATH_V2, headers, body);
  }

  /**
   * `POST /api/v1/auth/transition-proof` — proves possession of an EXPLICIT
   * candidate OpenBox DID identity (the fresh one-time key returned by
   * reverse prepare), never this client's active identity. Same
   * non-negotiable as the Okta helper above (proposal §13.5 / §17.28).
   */
  async validateOpenBoxDidIdentityTransition(options: {
    transitionId: string;
    challenge: string;
    candidateIdentity: OpenBoxDidIdentityConfig;
    /** Optional local convenience check against prepare's non-secret metadata. */
    expectedTarget?: TransitionExpectedTarget;
  }): Promise<TransitionPreflightResult> {
    if (!options.candidateIdentity) {
      throw new OpenBoxConfigError(
        "validateOpenBoxDidIdentityTransition requires an explicit candidateIdentity; it never " +
          "falls back to the client's active identity (proposal §17.28)."
      );
    }
    assertCandidateMatchesExpectedTarget(options.candidateIdentity, options.expectedTarget);

    const candidate = AgentIdentity.fromPrivateKey(
      options.candidateIdentity.did,
      options.candidateIdentity.privateKey
    );
    const body = { transition_id: options.transitionId, challenge: options.challenge };
    const { headers, body: bytes } = prepareSignedRequest("POST", TRANSITION_PROOF_PATH_V1, body, {
      apiKey: this.apiKey,
      identity: candidate, // EXPLICIT candidate — never this.identity
      sdkVersion: this.sdkVersion,
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    });
    return this.postTransitionProof(TRANSITION_PROOF_PATH_V1, headers, bytes);
  }

  private async postTransitionProof(
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<TransitionPreflightResult> {
    const url = `${this.apiUrl}${path}`;
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 401 || response.status === 403) {
      const reasonCode = extractReasonCode(await safeText(response));
      const isV2Route = path === TRANSITION_PROOF_PATH_V2;
      if (reasonCode) throw isV2Route ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
      throw new OpenBoxAuthError(
        "Transition proof rejected (invalid candidate identity, transition ID, or challenge)."
      );
    }
    if (response.status !== 200) {
      throw new GovernanceAPIError(`Transition proof request failed: HTTP ${response.status}`);
    }
    return parseTransitionProofResponse((await response.json()) as Record<string, unknown>);
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
