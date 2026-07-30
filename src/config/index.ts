/**
 * OpenBoxConfig and nested config groups with layered env resolution.
 *
 * Resolution order (highest wins):
 *   1. explicit arguments
 *   2. SDK-specific env vars via `envPrefix` (e.g. `OPENBOX_FRAMEWORK_API_KEY`)
 *   3. global `OPENBOX_*` env vars
 *   4. defaults
 *   5. validation + normalization
 *
 * Env access happens only inside `resolve()`, never at import time.
 */

import {
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError
} from "../errors/index.js";
import { AgentIdentity, validateAgentDid } from "../identity/index.js";
import { OktaAgentIdentity } from "../identity/okta.js";
import { DEFAULT_SDK_ENGINE, DEFAULT_SDK_LANGUAGE } from "../identity/sdk-identifier.js";
import type { AgentIdentityMethod } from "../identity/types.js";
import {
  describeMutualExclusionConflict,
  listMissingOktaFields,
  resolveIdentityMethod,
  type ResolvedIdentityMethod
} from "./identity-resolution.js";

// API key format (obx_live_... or obx_test_...). `\w` == [A-Za-z0-9_], matching Python.
const API_KEY_PATTERN = /^obx_(live|test)_\w+$/;
const GLOBAL_ENV_PREFIX = "OPENBOX";

/**
 * Outage policy for a Core NETWORK/5xx failure. (Auth 401/403 ALWAYS fails closed,
 * independent of this setting — a signing break never fail-opens.)
 * - `fail_open` (default): proceed with a `fallbackUsed` flag on any outage.
 * - `fail_closed`: block every governed op on an outage.
 * - `fail_closed_destructive`: block only DESTRUCTIVE ops on an outage — db writes,
 *   file writes, non-idempotent HTTP (POST/PUT/PATCH/DELETE) — while reads /
 *   idempotent ops and lifecycle events (no spans) stay available.
 */
export type OnApiError = "fail_open" | "fail_closed" | "fail_closed_destructive";

export interface HitlConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxWaitMs: number | null; // null = poll indefinitely (framework decides)
  skipActivityTypes: Set<string>;
}

export interface TelemetryConfig {
  enabled: boolean;
}

export interface InstrumentationConfig {
  enabled: boolean;
  httpEnabled: boolean;
  dbEnabled: boolean;
  fileEnabled: boolean;
  functionEnabled: boolean;
  llmEnabled: boolean; // reserved; disabled until provider hooks exist
  installOpenTelemetry: boolean;
  preflightEnabled: boolean;
  completedTelemetryEnabled: boolean;
}

export interface GateConfig {
  skipWorkflowTypes: Set<string>;
  skipSignals: Set<string>;
  skipActivityTypes: Set<string>;
  enforceTaskQueues: Set<string> | null; // null = all
  sendStartEvent: boolean;
  sendActivityStartEvent: boolean;
}

export interface PrivacyConfig {
  redactKeys: Set<string>;
  maxBodySize: number; // chars
}

export function defaultHitlConfig(): HitlConfig {
  return {
    enabled: true,
    pollIntervalMs: 5000,
    maxWaitMs: null,
    skipActivityTypes: new Set(["send_governance_event"])
  };
}

export function defaultInstrumentationConfig(): InstrumentationConfig {
  return {
    enabled: true,
    httpEnabled: true,
    dbEnabled: true,
    // Safe to default-on: interpreter-owned paths bypass governance and a
    // re-entrancy guard passes through evaluation-time opens.
    fileEnabled: true,
    functionEnabled: true,
    llmEnabled: false,
    installOpenTelemetry: true,
    preflightEnabled: true,
    completedTelemetryEnabled: true
  };
}

export function defaultGateConfig(): GateConfig {
  return {
    skipWorkflowTypes: new Set(),
    skipSignals: new Set(),
    // Skip the governance-event activity itself to avoid loops.
    skipActivityTypes: new Set(["send_governance_event"]),
    enforceTaskQueues: null,
    sendStartEvent: true,
    sendActivityStartEvent: true
  };
}

export function defaultPrivacyConfig(): PrivacyConfig {
  return { redactKeys: new Set(), maxBodySize: 65536 };
}

/** Fields resolvable from the environment (config field → env suffix). */
const ENV_FIELDS: Record<string, string> = {
  apiUrl: "API_URL",
  apiKey: "API_KEY",
  timeoutSeconds: "TIMEOUT_SECONDS",
  onApiError: "ON_API_ERROR",
  agentName: "AGENT_NAME",
  agentDid: "AGENT_DID",
  agentPrivateKey: "AGENT_PRIVATE_KEY",
  // Explicit method override (proposal §13.1). Never `legacy_unsigned` — that
  // remains an inferred-only compatibility classification (rule 6).
  identityMethod: "AGENT_IDENTITY_METHOD",
  // New v2 (okta_ai_agent) fields — see identity/types.ts's
  // OktaAiAgentIdentityConfig for what each maps to.
  agentId: "AGENT_ID",
  organizationId: "ORGANIZATION_ID",
  deploymentId: "DEPLOYMENT_ID",
  agentProofAudience: "AGENT_PROOF_AUDIENCE",
  oktaAgentId: "OKTA_AGENT_ID",
  oktaAgentKeyId: "OKTA_AGENT_KEY_ID",
  oktaAgentPrivateKey: "OKTA_AGENT_PRIVATE_KEY",
  oktaAgentAlgorithm: "OKTA_AGENT_ALGORITHM"
};

/** Settable fields for `resolve()` (excludes the nested-config defaults). */
export interface OpenBoxConfigInput {
  apiUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number | string;
  onApiError?: OnApiError;
  agentName?: string | null;
  agentDid?: string | null;
  agentPrivateKey?: string | null;
  /** Explicit method override. Never `legacy_unsigned` (inferred-only). */
  identityMethod?: AgentIdentityMethod | null;
  /** OpenBox agent UUID — required for `okta_ai_agent` (`obx_agent_id`). */
  agentId?: string | null;
  /** OpenBox organization UUID — required for `okta_ai_agent` (`obx_organization_id`). */
  organizationId?: string | null;
  /** Stable deployment identifier — required for `okta_ai_agent` (`obx_deployment_id`). */
  deploymentId?: string | null;
  /** Deployment-scoped audience `urn:openbox:<deployment-id>:core` — required for `okta_ai_agent`. */
  agentProofAudience?: string | null;
  /** Linked Okta AI Agent's external ID — required for `okta_ai_agent` (`iss`/`sub`). */
  oktaAgentId?: string | null;
  /** Selected public credential's `kid` — required for `okta_ai_agent`. */
  oktaAgentKeyId?: string | null;
  /** PKCS8 PEM RSA private key — required for `okta_ai_agent`. Never logged. */
  oktaAgentPrivateKey?: string | null;
  /** Allowlisted at `"RS256"` only for this release — required for `okta_ai_agent`. */
  oktaAgentAlgorithm?: string | null;
  sdkVersion?: string | null;
  sdkEngine?: string;
  sdkLanguage?: string;
  hitl?: HitlConfig;
  telemetry?: TelemetryConfig;
  instrumentation?: InstrumentationConfig;
  gate?: GateConfig;
  privacy?: PrivacyConfig;
  metadata?: Record<string, unknown>;
}

export interface ResolveOptions extends OpenBoxConfigInput {
  envPrefix?: string;
  environ?: Record<string, string | undefined>;
  validate?: boolean;
}

/** Resolved base-SDK configuration. */
export class OpenBoxConfig {
  apiUrl = "";
  apiKey = "";
  timeoutSeconds = 30.0;
  onApiError: OnApiError = "fail_open"; // fail_open | fail_closed | fail_closed_destructive
  agentName: string | null = null;
  agentDid: string | null = null;
  agentPrivateKey: string | null = null; // never logged
  // Explicit method override; null lets DID/Okta field presence infer it.
  identityMethod: AgentIdentityMethod | null = null;
  // New v2 (okta_ai_agent) fields — see identity/types.ts's OktaAiAgentIdentityConfig.
  agentId: string | null = null;
  organizationId: string | null = null;
  deploymentId: string | null = null;
  agentProofAudience: string | null = null;
  oktaAgentId: string | null = null;
  oktaAgentKeyId: string | null = null;
  oktaAgentPrivateKey: string | null = null; // never logged
  oktaAgentAlgorithm: string | null = null;
  sdkVersion: string | null = null;
  sdkEngine: string = DEFAULT_SDK_ENGINE;
  sdkLanguage: string = DEFAULT_SDK_LANGUAGE;
  envPrefix: string | null = null;
  hitl: HitlConfig = defaultHitlConfig();
  telemetry: TelemetryConfig = { enabled: true };
  instrumentation: InstrumentationConfig = defaultInstrumentationConfig();
  gate: GateConfig = defaultGateConfig();
  privacy: PrivacyConfig = defaultPrivacyConfig();
  metadata: Record<string, unknown> = {};

  /** Layered resolution: explicit > envPrefix > OPENBOX_* > defaults. */
  static resolve(options: ResolveOptions = {}): OpenBoxConfig {
    const { envPrefix, environ, validate = true, ...explicit } = options;
    const env = environ ?? process.env;

    const config = new OpenBoxConfig();
    config.envPrefix = envPrefix ?? null;

    // Env-resolvable fields: explicit > prefixed env > global env.
    const explicitValues = new Map<string, unknown>(Object.entries(explicit));
    for (const [field, suffix] of Object.entries(ENV_FIELDS)) {
      let value: unknown = explicitValues.get(field);
      if ((value === undefined || value === null) && envPrefix) {
        value = env[`${envPrefix}_${suffix}`];
      }
      if (value === undefined || value === null) {
        value = env[`${GLOBAL_ENV_PREFIX}_${suffix}`];
      }
      if (value !== undefined && value !== null) {
        (config as unknown as Record<string, unknown>)[field] = value;
      }
    }

    // Non-env fields pass through explicitly only.
    for (const [field, value] of Object.entries(explicit)) {
      if (!(field in ENV_FIELDS) && value !== undefined && value !== null) {
        (config as unknown as Record<string, unknown>)[field] = value;
      }
    }

    return validate ? config.normalized() : config;
  }

  /** Validate + normalize in place (step 5). Returns self for chaining. */
  normalized(): this {
    if (!this.apiUrl) throw new OpenBoxConfigError("apiUrl is required");
    if (!this.apiKey) throw new OpenBoxConfigError("apiKey is required");

    this.apiUrl = String(this.apiUrl).replace(/\/+$/, "");
    validateUrlSecurity(this.apiUrl);

    if (!API_KEY_PATTERN.test(this.apiKey)) {
      throw new OpenBoxAuthError(
        `Invalid API key format. Expected 'obx_live_*' or 'obx_test_*', got: '${this.apiKey.slice(0, 15)}...' (showing first 15 chars)`
      );
    }

    // Typed as number, but env resolution can assign a raw string here.
    const rawTimeout: unknown = this.timeoutSeconds;
    // Number("") and Number("  ") are 0 — an empty env var must NOT silently
    // become a 0ms timeout that aborts every request. Treat blank as invalid.
    const timeout =
      typeof rawTimeout === "string" && rawTimeout.trim() === "" ? NaN : Number(rawTimeout);
    if (Number.isNaN(timeout)) {
      throw new OpenBoxConfigError(
        `timeoutSeconds must be numeric, got ${JSON.stringify(this.timeoutSeconds)}`
      );
    }
    this.timeoutSeconds = timeout;

    if (
      this.onApiError !== "fail_open" &&
      this.onApiError !== "fail_closed" &&
      this.onApiError !== "fail_closed_destructive"
    ) {
      throw new OpenBoxConfigError(
        `onApiError must be 'fail_open', 'fail_closed', or 'fail_closed_destructive', got ${JSON.stringify(this.onApiError)}`
      );
    }

    // DID + private key: both-or-neither; format-validate the DID eagerly.
    if (Boolean(this.agentDid) !== Boolean(this.agentPrivateKey)) {
      throw new OpenBoxConfigError(
        "agentDid and agentPrivateKey must be provided together (got only one). " +
          "Provide both to enable signed requests, or neither."
      );
    }
    if (this.agentDid) validateAgentDid(this.agentDid);

    if (
      this.identityMethod !== null &&
      this.identityMethod !== "openbox_did" &&
      this.identityMethod !== "okta_ai_agent"
    ) {
      throw new OpenBoxConfigError(
        `identityMethod must be 'openbox_did' or 'okta_ai_agent' (got ${JSON.stringify(this.identityMethod)}). ` +
          "'legacy_unsigned' is inferred only, never selectable."
      );
    }

    const conflict = describeMutualExclusionConflict(this);
    if (conflict) throw new OpenBoxConfigError(conflict);

    const method = resolveIdentityMethod(this);
    if (method === "openbox_did" && !(this.agentDid && this.agentPrivateKey)) {
      throw new OpenBoxConfigError(
        "identityMethod is 'openbox_did' but agentDid/agentPrivateKey are not configured."
      );
    }
    if (method === "okta_ai_agent") {
      const missing = listMissingOktaFields(this);
      if (missing.length > 0) {
        throw new OpenBoxConfigError(`Okta agent identity is missing required field(s): ${missing.join(", ")}.`);
      }
      if (this.oktaAgentAlgorithm !== "RS256") {
        throw new OpenBoxConfigError(
          `oktaAgentAlgorithm must be 'RS256' (got ${JSON.stringify(this.oktaAgentAlgorithm)}); only RS256 is allowlisted.`
        );
      }
    }

    return this;
  }

  /** Load an `AgentIdentity` (or null). Decodes the seed exactly once. */
  loadIdentity(): AgentIdentity | null {
    if (!this.agentDid || !this.agentPrivateKey) return null;
    return AgentIdentity.fromPrivateKey(this.agentDid, this.agentPrivateKey);
  }

  /** The active method: explicit override, else inferred from DID/Okta field presence. */
  resolvedIdentityMethod(): ResolvedIdentityMethod {
    return resolveIdentityMethod(this);
  }

  /** Load an `OktaAgentIdentity` (or null when the resolved method isn't `okta_ai_agent`). */
  loadOktaIdentity(): OktaAgentIdentity | null {
    if (this.resolvedIdentityMethod() !== "okta_ai_agent") return null;
    // `normalized()` already guaranteed every field below is non-null for this method.
    return OktaAgentIdentity.fromConfig({
      method: "okta_ai_agent",
      openboxAgentId: this.agentId!,
      organizationId: this.organizationId!,
      deploymentId: this.deploymentId!,
      externalAgentId: this.oktaAgentId!,
      keyId: this.oktaAgentKeyId!,
      algorithm: "RS256",
      privateKey: this.oktaAgentPrivateKey!,
      audience: this.agentProofAudience!
    });
  }

  // Redact secrets from structured logging / JSON.stringify. The Ed25519 seed and
  // the Okta RSA private key are non-repudiation key material; a routine
  // `console.log(config)` must not dump either.
  private redactedView(): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) view[key] = value;
    view["apiKey"] = this.apiKey ? "[REDACTED]" : this.apiKey;
    view["agentPrivateKey"] = this.agentPrivateKey ? "[REDACTED]" : this.agentPrivateKey;
    view["oktaAgentPrivateKey"] = this.oktaAgentPrivateKey ? "[REDACTED]" : this.oktaAgentPrivateKey;
    return view;
  }

  toJSON(): Record<string, unknown> {
    return this.redactedView();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.redactedView();
  }
}

/**
 * HTTPS required for non-localhost URLs (protects API keys in transit).
 *
 * Parses with the WHATWG URL, reads `hostname`, strips IPv6 brackets
 * (`[::1]`→`::1`), and exact-matches the localhost set. Never uses
 * substring/startsWith — `localhost.evil.com` / `127.0.0.1.evil` are NOT local.
 */
function validateUrlSecurity(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new OpenBoxConfigError(`Invalid api_url: ${apiUrl}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol === "http:" && !isLocalhost) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}
