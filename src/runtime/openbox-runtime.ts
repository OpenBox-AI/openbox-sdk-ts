/**
 * `OpenBoxRuntime` — the composition root wiring
 * config -> identity -> client -> gate -> context store -> adapter.
 *
 *     const config = OpenBoxConfig.resolve({...});
 *     const runtime = new OpenBoxRuntime(config, { adapter: myFrameworkAdapter });
 *     await runtime.evaluateLifecycle(workflowStarted({...}));
 *     await runtime.preflight({ spans: [span] });
 *     ...
 *     runtime.close();
 *
 * Lifecycle helpers evaluate through the strict gate (`../gate/index.js`) and
 * delegate every native effect (block/halt/approval) to the adapter — the
 * runtime itself never produces a framework-native effect.
 */

import type { FrameworkAdapter } from "../adapters/base.js";
import { CoreAdapter } from "../adapters/base.js";
import { OpenBoxClient, type ClientLogger } from "../client/index.js";
import type { OpenBoxConfig } from "../config/index.js";
import { ContextStore } from "../context/index.js";
import { ActivityContext } from "../contracts/context.js";
import type { EventEnvelope } from "../contracts/events.js";
import { Verdict, verdictRequiresApproval, verdictShouldStop, type EvaluationResult } from "../contracts/results.js";
import { GovernanceBlockedError, GuardrailsValidationError } from "../errors/index.js";
import { prepareLifecyclePayload } from "../gate/index.js";
import { makePayloadBuilder, type BuildEvaluatePayloadResult } from "../wire/evaluate-payload.js";
import { HookEvaluator, type HookEvaluationInput } from "./hook-evaluator.js";

export type { HookEvaluationInput } from "./hook-evaluator.js";

export interface OpenBoxRuntimeOptions {
  adapter?: FrameworkAdapter;
  client?: OpenBoxClient;
  contextStore?: ContextStore;
  /** Hook evaluate-body assembler seam; defaults to the config's privacy-bound builder. */
  payloadBuilder?: (event: EventEnvelope) => BuildEvaluatePayloadResult;
  logger?: ClientLogger;
}

export class OpenBoxRuntime {
  readonly config: OpenBoxConfig;
  readonly adapter: FrameworkAdapter;
  readonly contextStore: ContextStore;
  readonly client: OpenBoxClient;
  private readonly hooks: HookEvaluator;
  private closed = false;

  constructor(config: OpenBoxConfig, options: OpenBoxRuntimeOptions = {}) {
    this.config = config;
    this.adapter = options.adapter ?? new CoreAdapter();
    // Per-runtime, never a process-global singleton — see context/index.ts.
    this.contextStore = options.contextStore ?? new ContextStore();
    const logger = options.logger ?? console;
    this.client =
      options.client ??
      new OpenBoxClient(config.apiUrl, config.apiKey, {
        timeoutSeconds: config.timeoutSeconds,
        onApiError: config.onApiError,
        identity: config.loadIdentity(),
        oktaIdentity: config.loadOktaIdentity(),
        sdkVersion: config.sdkVersion,
        sdkEngine: config.sdkEngine,
        sdkLanguage: config.sdkLanguage,
        logger
      });
    const payloadBuilder = options.payloadBuilder ?? makePayloadBuilder(config.privacy);
    this.hooks = new HookEvaluator({
      client: this.client,
      contextStore: this.contextStore,
      adapter: this.adapter,
      payloadBuilder,
      privacy: config.privacy,
      preflightEnabled: () => this.config.instrumentation.preflightEnabled,
      completedTelemetryEnabled: () => this.config.instrumentation.completedTelemetryEnabled,
      logger
    });
  }

  // ── Lifecycle evaluation ──────────────────────────────────────────────────

  /**
   * Evaluate + enforce a lifecycle event. BLOCK/HALT delegate to
   * `adapter.raiseLifecycleBlocked`; a guardrails failure raises before (and
   * instead of) driving approval. REQUIRE_APPROVAL drives
   * `adapter.handleApproval` — resolving means approved.
   */
  async evaluateLifecycle(event: EventEnvelope): Promise<EvaluationResult> {
    const { payload } = prepareLifecyclePayload(event, { privacy: this.config.privacy });
    const result = await this.client.evaluate(payload);
    if (verdictRequiresApproval(result.verdict)) {
      this.checkGuardrails(result);
      await this.adapter.handleApproval(result, approvalContextFromEvent(event));
      return result;
    }
    const { workflowId, runId } = workflowRunIds(event);
    return this.enforceLifecycle(result, workflowId, runId);
  }

  private enforceLifecycle(
    result: EvaluationResult,
    workflowId: string | null,
    runId: string | null
  ): EvaluationResult {
    if (verdictShouldStop(result.verdict)) {
      if (result.verdict === Verdict.HALT) this.contextStore.requestHalt(workflowId, runId);
      this.adapter.raiseLifecycleBlocked(result);
      // Defense in depth: see the matching comment in HookEvaluator.preflight.
      throw new GovernanceBlockedError(result.verdict, result.reason ?? "Blocked (adapter returned)");
    }
    this.checkGuardrails(result);
    return result;
  }

  private checkGuardrails(result: EvaluationResult): void {
    if (result.guardrails && !result.guardrails.validationPassed) {
      const reasons = result.guardrails.getReasonStrings();
      throw new GuardrailsValidationError(reasons.length > 0 ? reasons : ["Guardrails validation failed"]);
    }
  }

  // ── Hook evaluation (preflight / completed) ────────────────────────────────

  /** See `HookEvaluator.preflight`. */
  preflight(input: HookEvaluationInput): Promise<EvaluationResult | null> {
    return this.hooks.preflight(input);
  }

  /** See `HookEvaluator.completed`. */
  completed(input: HookEvaluationInput): Promise<EvaluationResult | null> {
    return this.hooks.completed(input);
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────

  /** Clear correlation state (idempotent — safe to call more than once). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.contextStore.clear();
  }
}

/**
 * `workflow_id`/`run_id` from an event's flat wire `payload` — the single
 * source both `approvalContextFromEvent` and `evaluateLifecycle`'s per-run
 * HALT threading read from, so the two never drift.
 */
function workflowRunIds(event: EventEnvelope): { workflowId: string | null; runId: string | null } {
  const payload = event.payload;
  const workflowId = payload["workflow_id"];
  const runId = payload["run_id"];
  return {
    workflowId: typeof workflowId === "string" ? workflowId : null,
    runId: typeof runId === "string" ? runId : null
  };
}

/**
 * Approval context for a lifecycle event. `workflow_id`/`run_id` live in the
 * flat wire `payload`; `activity_id` is a first-class envelope field. Core's
 * evaluate response omits all three, so the poll must be built from the
 * originating event — see `CoreAdapter.handleApproval`. Core's approval poll
 * is keyed on ALL THREE ids: a workflow-level event (no `activity_id`) that
 * somehow draws REQUIRE_APPROVAL is unpollable, and the adapter fails safe
 * (rejects without polling) rather than polling with a partial key.
 */
function approvalContextFromEvent(event: EventEnvelope): ActivityContext {
  const { workflowId, runId } = workflowRunIds(event);
  const activityId = event.payload["activity_id"];
  return new ActivityContext({
    workflowId,
    runId,
    activityId: event.activityId ?? (typeof activityId === "string" ? activityId : null)
  });
}
