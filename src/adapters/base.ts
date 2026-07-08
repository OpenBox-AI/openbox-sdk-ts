/**
 * `FrameworkAdapter` — the ONE seam where governance verdicts become
 * framework-native effects. There is exactly one path:
 * wrapper -> `OpenBoxRuntime` -> adapter. Framework SDKs implement the
 * callbacks; the default `CoreAdapter` raises the base error types directly.
 *
 * Depends on `../approvals` (network-adjacent) and `../errors`, so this
 * module is off the import-light root by design (the root only re-exports
 * pure contracts/errors).
 */

import type { ApprovalPoller } from "../approvals/index.js";
import type { ActivityContext } from "../contracts/context.js";
import { Verdict, type EvaluationResult } from "../contracts/results.js";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  GovernanceBlockedError,
  GovernanceHaltError
} from "../errors/index.js";

/** Native-enforcement callbacks implemented by framework SDKs. */
export interface FrameworkAdapter {
  readonly name: string;

  /**
   * Drive the framework's approval flow for REQUIRE_APPROVAL.
   *
   * Resolve normally when approved; reject with the framework's native
   * rejection/expiry error otherwise. Called BEFORE the real operation runs.
   */
  handleApproval(result: EvaluationResult): Promise<void>;

  /**
   * Optional synchronous approval seam for frameworks/wrappers that cannot
   * `await` (e.g. a genuinely sync driver call). Not required by the base
   * runtime in this phase — a future sync hook-wrapping phase may call it
   * directly instead of `handleApproval`.
   */
  handleApprovalSync?(result: EvaluationResult, context: ActivityContext | null): void;

  /** Produce the framework-native effect for a BLOCK/HALT lifecycle verdict. */
  raiseLifecycleBlocked(result: EvaluationResult): never;

  /**
   * Produce the framework-native effect for a BLOCK/HALT started-hook
   * verdict. The real operation has NOT run.
   */
  raiseHookBlocked(result: EvaluationResult): never;

  /**
   * React to a completed-hook verdict. The operation ALREADY ran —
   * implementations may only affect FUTURE execution (e.g. mark the
   * activity/session blocked); they must never pretend to undo work.
   *
   * `context` is the resolved `ActivityContext` (may be absent).
   */
  onCompletedHookResult(result: EvaluationResult, context?: ActivityContext | null): void;
}

/** Map a stop-shaped (BLOCK/HALT) result to the matching base error type. Never returns. */
function raiseStop(result: EvaluationResult): never {
  if (result.verdict === Verdict.HALT) {
    throw new GovernanceHaltError(result.reason ?? "Halted by governance policy");
  }
  throw new GovernanceBlockedError(result.verdict, result.reason ?? "Blocked by governance policy");
}

/** Read a string field out of a raw `Record<string, unknown>`, defaulting to `""`. */
function readRawString(raw: Readonly<Record<string, unknown>>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

export interface CoreAdapterOptions {
  /**
   * Enables a real HITL wait for REQUIRE_APPROVAL. Without one, approval is
   * fail-safe: REJECTED (the operation does not run) rather than silently
   * allowed — matches `openbox-sdk-python` `adapters/base.py`.
   */
  approvalPoller?: ApprovalPoller | null;
}

/**
 * Default adapter — raises the base error types (framework-agnostic).
 *
 * With NO poller configured, REQUIRE_APPROVAL is REJECTED outright (it does
 * not pend, and it never silently allows). Completed-hook telemetry is a
 * no-op: completed evaluation never undoes an operation that already ran.
 */
export class CoreAdapter implements FrameworkAdapter {
  readonly name = "core";
  private readonly poller: ApprovalPoller | null;

  constructor(options: CoreAdapterOptions = {}) {
    this.poller = options.approvalPoller ?? null;
  }

  async handleApproval(result: EvaluationResult): Promise<void> {
    if (this.poller === null || !result.approvalId) {
      throw new ApprovalRejectedError(
        "REQUIRE_APPROVAL verdict but no approval flow is configured — failing safe (operation not run)"
      );
    }
    const approval = await this.poller.waitForDecision(
      readRawString(result.raw, "workflow_id"),
      readRawString(result.raw, "run_id"),
      readRawString(result.raw, "activity_id")
    );
    if (approval.allowShaped) return;
    if (approval.expired) {
      throw new ApprovalExpiredError(approval.reason ?? "Approval window expired");
    }
    throw new ApprovalRejectedError(approval.reason ?? "Approval rejected");
  }

  raiseLifecycleBlocked(result: EvaluationResult): never {
    raiseStop(result);
  }

  raiseHookBlocked(result: EvaluationResult): never {
    raiseStop(result);
  }

  // Declared with the full interface signature (even though unused) so
  // callers holding a `CoreAdapter` reference directly — not just typed as
  // `FrameworkAdapter` — can call it the normal way.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional no-op; params kept to match the FrameworkAdapter call signature
  onCompletedHookResult(_result: EvaluationResult, _context?: ActivityContext | null): void {
    // Completed telemetry never undoes the operation; nothing to do here —
    // the runtime already records abort/halt flags for FUTURE execution.
  }
}
