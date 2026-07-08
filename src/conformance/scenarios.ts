/**
 * Reusable conformance scenario data + a ready-wired `OpenBoxRuntime` factory.
 *
 * Mirrors `openbox-sdk-python` `conformance/hook_preflight.py`
 * (`CONFORMANCE_CONTEXT`, `build_conformance_runtime`) so the same reference
 * fixtures are available on both SDKs.
 */

import { CoreAdapter, type FrameworkAdapter } from "../adapters/base.js";
import { OpenBoxClient } from "../client/index.js";
import { OpenBoxConfig } from "../config/index.js";
import { ContextStore } from "../context/index.js";
import { ActivityContext } from "../contracts/context.js";
import { HookType } from "../contracts/otel-spans.js";
import { OpenBoxRuntime, type OpenBoxRuntimeOptions } from "../runtime/index.js";
import type { FakeCore } from "./fake-core.js";

/** The reference activity context every conformance case binds. */
export const CONFORMANCE_ACTIVITY_CONTEXT: ActivityContext = new ActivityContext({
  workflowId: "wf-conformance",
  runId: "run-conformance",
  workflowType: "ConformanceWorkflow",
  taskQueue: "conformance-queue",
  activityId: "act-conformance",
  activityType: "conformance_activity"
});

/** One sample field set per hook type — enough to populate the semantic-field diagnostics. */
export interface HookTypeScenario {
  readonly hookType: string;
  readonly sampleFields: Readonly<Record<string, unknown>>;
}

export const CONFORMANCE_HOOK_TYPE_SCENARIOS: readonly HookTypeScenario[] = [
  {
    hookType: HookType.HTTP_REQUEST,
    sampleFields: { http_method: "GET", http_url: "https://governed.example/x" }
  },
  {
    hookType: HookType.DB_QUERY,
    sampleFields: { db_system: "postgresql", db_statement: "SELECT 1" }
  },
  {
    hookType: HookType.FILE_OPERATION,
    sampleFields: { file_path: "/tmp/conformance.txt", file_operation: "read" }
  },
  {
    hookType: HookType.FUNCTION_CALL,
    sampleFields: { function: "charge", module: "billing" }
  }
];

export type ApprovalScenarioExpectation = "approved" | "rejected" | "expired";

export interface ApprovalScenario {
  readonly name: string;
  /** Scripted `/governance/evaluate` response body that triggers REQUIRE_APPROVAL. */
  readonly evaluateResponse: Record<string, unknown>;
  /** Scripted `/governance/approval` poll response bodies, in poll order. */
  readonly pollResponses: readonly Record<string, unknown>[];
  readonly expected: ApprovalScenarioExpectation;
}

/**
 * The approval decision matrix (pending -> terminal) driven through a real
 * `ApprovalPoller` + `FakeCore`. "Core unreachable -> ApprovalTimeoutError" is
 * deliberately NOT a row here — it has no fixed verdict body; drive it with
 * `FakeCore.failAllApprovals()` directly (see the runtime test suite).
 */
export const APPROVAL_SCENARIOS: readonly ApprovalScenario[] = [
  {
    name: "approved-after-one-pending-poll",
    evaluateResponse: { verdict: "require_approval", approval_id: "appr-approved" },
    pollResponses: [{ action: "require_approval" }, { action: "allow" }],
    expected: "approved"
  },
  {
    name: "rejected",
    evaluateResponse: { verdict: "require_approval", approval_id: "appr-rejected" },
    pollResponses: [{ action: "block", reason: "human said no" }],
    expected: "rejected"
  },
  {
    name: "expired",
    evaluateResponse: { verdict: "require_approval", approval_id: "appr-expired" },
    pollResponses: [{ expired: true, reason: "approval window closed" }],
    expected: "expired"
  }
];

export interface ConformanceRuntimeOptions extends Omit<OpenBoxRuntimeOptions, "client"> {
  readonly apiUrl?: string;
  readonly apiKey?: string;
}

/** An `OpenBoxRuntime` wired to a `FakeCore`, with an isolated `ContextStore`. */
export function buildConformanceRuntime(
  fakeCore: FakeCore,
  options: ConformanceRuntimeOptions = {}
): OpenBoxRuntime {
  const config = OpenBoxConfig.resolve({
    apiUrl: options.apiUrl ?? "https://core.test",
    apiKey: options.apiKey ?? "obx_test_conformance"
  });
  const adapter: FrameworkAdapter = options.adapter ?? new CoreAdapter();
  const contextStore = options.contextStore ?? new ContextStore();
  const client =
    new OpenBoxClient(config.apiUrl, config.apiKey, {
      fetchImpl: fakeCore.fetchImpl,
      timeoutSeconds: config.timeoutSeconds,
      onApiError: config.onApiError
    });
  return new OpenBoxRuntime(config, {
    ...options,
    adapter,
    contextStore,
    client
  });
}
