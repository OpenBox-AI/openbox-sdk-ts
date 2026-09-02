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
import { DEFAULT_SDK_ENGINE, DEFAULT_SDK_LANGUAGE } from "../identity/sdk-identifier.js";

// API key format (obx_live_... or obx_test_...). `\w` == [A-Za-z0-9_], matching Python.
const API_KEY_PATTERN = /^obx_(live|test)_\w+$/;
// OpenShell deliberately exposes only this provider placeholder to the sandbox
// process. The egress proxy replaces it with the real key at the endpoint bound
// by sandbox policy. Revision-scoped placeholders use OpenShell's reserved
// `v<digits>_` namespace.
const OPENSHELL_API_KEY_PLACEHOLDER_PATTERN =
  /^openshell:resolve:env:(?:v\d+_)?OPENBOX_API_KEY$/;
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
  agentPrivateKey: "AGENT_PRIVATE_KEY"
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
    validateUrlSecurity(this.apiUrl, this.apiKey);

    if (!isValidApiKey(this.apiKey)) {
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
    return this;
  }

  /** Load an `AgentIdentity` (or null). Decodes the seed exactly once. */
  loadIdentity(): AgentIdentity | null {
    if (!this.agentDid || !this.agentPrivateKey) return null;
    return AgentIdentity.fromPrivateKey(this.agentDid, this.agentPrivateKey);
  }

  // Redact secrets from structured logging / JSON.stringify. The Ed25519 seed is
  // non-repudiation key material; a routine `console.log(config)` must not dump it.
  private redactedView(): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) view[key] = value;
    view["apiKey"] = this.apiKey ? "[REDACTED]" : this.apiKey;
    view["agentPrivateKey"] = this.agentPrivateKey ? "[REDACTED]" : this.agentPrivateKey;
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
 * HTTPS required for non-localhost URLs, except the provider-brokered local
 * OpenShell bridge (protects ordinary API keys in transit).
 *
 * Parses with the WHATWG URL, reads `hostname`, strips IPv6 brackets
 * (`[::1]`→`::1`), and exact-matches the localhost set. Never uses
 * substring/startsWith — `localhost.evil.com` / `127.0.0.1.evil` are NOT local.
 * The OpenShell exception requires both its exact internal hostname and its
 * exact OpenBox credential placeholder.
 */
function validateUrlSecurity(apiUrl: string, apiKey: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new OpenBoxConfigError(`Invalid api_url: ${apiUrl}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isOpenShellBoundEndpoint =
    hostname === "host.openshell.internal" &&
    OPENSHELL_API_KEY_PLACEHOLDER_PATTERN.test(apiKey);
  if (url.protocol === "http:" && !isLocalhost && !isOpenShellBoundEndpoint) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}

function isValidApiKey(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey) || OPENSHELL_API_KEY_PLACEHOLDER_PATTERN.test(apiKey);
}
