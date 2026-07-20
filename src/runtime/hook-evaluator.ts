/**
 * `HookEvaluator` — the single decision point for hook (span-bearing)
 * verdicts: wrapper -> `OpenBoxRuntime` -> `HookEvaluator` -> adapter.
 *
 * Mirrors `openbox-sdk-python` `hooks/preflight.py` (`HookRuntime`), folded
 * into the base runtime module for this phase since TS hook wrapping is
 * async-only (no sync/async split is needed the way Python's is). Kept as
 * its own small class — constructed from explicit dependencies, not the
 * `OpenBoxRuntime` instance itself — purely to keep `openbox-runtime.ts`
 * under the project's per-file line guideline; it is not a separate public
 * concept callers need to know about.
 *
 * Decision points:
 * - started BLOCK/HALT       -> mark abort (+halt flag) -> `adapter.raiseHookBlocked`
 * - started REQUIRE_APPROVAL -> `adapter.handleApproval` (resolve = proceed)
 * - a prior abort            -> fail fast, no network call
 * - completed verdicts       -> `adapter.onCompletedHookResult` + abort/halt
 *   flags for FUTURE execution (the operation already ran; never undone)
 * - no bound activity context -> SKIP silently (not an error — Decision 14)
 * - started fail-closed condition -> synthetic HALT via `adapter.raiseHookBlocked`
 *   (see `isFailClosedCondition` in `./hook-evaluator-types.js`)
 * - completed evaluation failures -> logged, swallowed, NEVER raised/blocked
 */

import { hook } from "../contracts/event-factories.js";
import { EvaluationResult, Verdict, verdictRequiresApproval, verdictShouldStop } from "../contracts/results.js";
import { GovernanceBlockedError } from "../errors/index.js";
import { STAGE_COMPLETED, STAGE_STARTED, prepareHookPayload } from "../gate/index.js";
import {
  errorMessage,
  isFailClosedCondition,
  type BoundHookContext,
  type HookEvaluationInput,
  type HookEvaluatorDeps
} from "./hook-evaluator-types.js";
import type { ActivityContext } from "../contracts/context.js";
import type { TraceIdLike } from "../context/index.js";

export type { HookEvaluationInput, HookEvaluatorDeps } from "./hook-evaluator-types.js";

export class HookEvaluator {
  constructor(private readonly deps: HookEvaluatorDeps) {}

  /**
   * Evaluate BEFORE the real operation runs. `null` means the hook was
   * SKIPPED (preflight disabled, or no bound activity context). BLOCK/HALT
   * and a rejected/expired approval throw via the adapter.
   */
  async preflight(input: HookEvaluationInput): Promise<EvaluationResult | null> {
    if (!this.deps.preflightEnabled()) return null;
    const bound = this.resolveBoundContext(input.traceId);
    if (bound === null) return null;

    this.failFastIfAborted(bound.ctx);

    let result: EvaluationResult;
    try {
      result = await this.sendHookEvaluation(bound, input, STAGE_STARTED);
    } catch (error) {
      if (isFailClosedCondition(error)) return this.failClosedStarted(error, bound.ctx);
      throw error;
    }

    if (verdictShouldStop(result.verdict)) {
      this.markStopped(result, bound.ctx);
      this.deps.adapter.raiseHookBlocked(result);
      // Defense in depth: a misbehaving adapter that RETURNS from its
      // `never`-typed callback must not fall through to "proceed".
      throw new GovernanceBlockedError(result.verdict, result.reason ?? "Blocked (adapter returned)");
    }
    if (verdictRequiresApproval(result.verdict)) {
      // Core's evaluate response omits the workflow/run/activity IDs, so hand
      // the bound context (which carries all three) for the approval poll.
      await this.deps.adapter.handleApproval(result, bound.ctx);
    }
    return result;
  }

  /**
   * Evaluate AFTER the real operation ran. NEVER throws to the caller and
   * NEVER undoes the operation — a stop-shaped verdict only marks FUTURE
   * execution (abort/halt flags + `adapter.onCompletedHookResult`).
   */
  async completed(input: HookEvaluationInput): Promise<EvaluationResult | null> {
    if (!this.deps.completedTelemetryEnabled()) return null;
    const bound = this.resolveBoundContext(input.traceId);
    if (bound === null) return null;

    let result: EvaluationResult;
    try {
      result = await this.sendHookEvaluation(bound, input, STAGE_COMPLETED);
    } catch (error) {
      this.deps.logger.warn(`completed-hook telemetry failed: ${errorMessage(error)}`);
      return null;
    }

    if (verdictShouldStop(result.verdict)) this.markStopped(result, bound.ctx);
    try {
      this.deps.adapter.onCompletedHookResult(result, bound.ctx);
    } catch (error) {
      this.deps.logger.warn(`adapter.onCompletedHookResult failed: ${errorMessage(error)}`);
    }
    return result;
  }

  private async sendHookEvaluation(
    bound: BoundHookContext,
    input: HookEvaluationInput,
    stage: string
  ): Promise<EvaluationResult> {
    const event = hook({
      activityContext: bound.ctx.toPayloadFields(),
      activityId: bound.activityId,
      activityType: bound.activityType,
      spans: input.spans,
      timestamp: input.timestamp ?? null
    });
    const { payload, diagnostics } = prepareHookPayload(event, stage, this.deps.payloadBuilder, {
      privacy: this.deps.privacy
    });
    const result = await this.deps.client.evaluate(payload);
    result.diagnostics.push(...diagnostics);
    return result;
  }

  /** Bound context via AsyncLocalStorage first, trace-map fallback second. Requires an activity binding, not just a workflow-scoped context. */
  private resolveBoundContext(traceId?: TraceIdLike): BoundHookContext | null {
    const current = this.deps.contextStore.currentActivityContext();
    const ctx = current ?? (traceId !== undefined ? this.deps.contextStore.contextForTrace(traceId) : null);
    if (ctx === null || !ctx.activityId || !ctx.activityType) return null;
    return { ctx, activityId: ctx.activityId, activityType: ctx.activityType };
  }

  private failFastIfAborted(ctx: ActivityContext): void {
    if (!this.deps.contextStore.isActivityAborted(ctx.workflowId, ctx.runId, ctx.activityId)) return;
    const reason = "Activity aborted by a prior hook verdict";
    const blocked = new EvaluationResult();
    blocked.verdict = Verdict.BLOCK;
    blocked.reason = reason;
    this.deps.adapter.raiseHookBlocked(blocked);
    // Defense in depth: see the matching comment in `preflight()` above.
    throw new GovernanceBlockedError(blocked.verdict, reason);
  }

  private failClosedStarted(error: unknown, ctx: ActivityContext): never {
    const message = errorMessage(error);
    const halt = new EvaluationResult();
    halt.verdict = Verdict.HALT;
    halt.reason = `Governance evaluation failed closed: ${message}`;
    halt.fallbackUsed = true;
    halt.raw = {
      fail_closed_error: message,
      error_type: error instanceof Error ? error.name : typeof error
    };
    this.markStopped(halt, ctx);
    this.deps.adapter.raiseHookBlocked(halt);
    throw new GovernanceBlockedError(halt.verdict, halt.reason ?? "Blocked (adapter returned)");
  }

  private markStopped(result: EvaluationResult, ctx: ActivityContext): void {
    this.deps.contextStore.markActivityAborted(ctx.workflowId, ctx.runId, ctx.activityId);
    if (result.verdict === Verdict.HALT) this.deps.contextStore.requestHalt(ctx.workflowId, ctx.runId);
  }
}
