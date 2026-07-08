/**
 * `FakeAdapter` — a recording `FrameworkAdapter` for tests.
 *
 * Records every delegation (in call order) and drives the approval matrix
 * (allow / reject / expire) synchronously, so tests can exercise
 * `OpenBoxRuntime`'s adapter wiring without a real `ApprovalPoller`. Mirrors
 * `openbox-sdk-python` `conformance/hook_preflight.RecordingHookAdapter`.
 */

import type { FrameworkAdapter } from "../adapters/base.js";
import type { ActivityContext } from "../contracts/context.js";
import { Verdict, type EvaluationResult } from "../contracts/results.js";
import { ApprovalExpiredError, ApprovalRejectedError, GovernanceBlockedError, GovernanceHaltError } from "../errors/index.js";

export type FakeAdapterCall =
  | { readonly kind: "handleApproval"; readonly result: EvaluationResult }
  | { readonly kind: "raiseLifecycleBlocked"; readonly result: EvaluationResult }
  | { readonly kind: "raiseHookBlocked"; readonly result: EvaluationResult }
  | {
      readonly kind: "onCompletedHookResult";
      readonly result: EvaluationResult;
      readonly context: ActivityContext | null;
    };

export type ApprovalOutcome = "allow" | "reject" | "expire";

export interface FakeAdapterOptions {
  /** Outcome `handleApproval` simulates. Default `"allow"`. */
  approvalOutcome?: ApprovalOutcome;
  approvalReason?: string;
}

function raiseNative(result: EvaluationResult): never {
  if (result.verdict === Verdict.HALT) {
    throw new GovernanceHaltError(result.reason ?? "halted by FakeAdapter");
  }
  throw new GovernanceBlockedError(result.verdict, result.reason ?? "blocked by FakeAdapter");
}

export class FakeAdapter implements FrameworkAdapter {
  readonly name = "fake";
  readonly calls: FakeAdapterCall[] = [];
  approvalOutcome: ApprovalOutcome;
  approvalReason: string;

  constructor(options: FakeAdapterOptions = {}) {
    this.approvalOutcome = options.approvalOutcome ?? "allow";
    this.approvalReason = options.approvalReason ?? "";
  }

  // Genuinely `async` (not just Promise-returning): callers commonly write
  // `expect(adapter.handleApproval(result)).rejects.toThrow()`, which needs
  // an actual REJECTED promise, not a synchronous throw from evaluating the
  // call expression — only an `async` function guarantees every throw in its
  // body (even before any await) becomes a promise rejection rather than a
  // synchronous exception from the call site itself. The `await` below is
  // genuine (not a no-op): it also makes this fake behave more like a real
  // adapter driving an async approval flow, one microtask later.
  async handleApproval(result: EvaluationResult): Promise<void> {
    this.calls.push({ kind: "handleApproval", result });
    await Promise.resolve();
    if (this.approvalOutcome === "allow") return;
    if (this.approvalOutcome === "expire") {
      throw new ApprovalExpiredError(this.approvalReason || "Approval window expired");
    }
    throw new ApprovalRejectedError(this.approvalReason || "rejected by FakeAdapter");
  }

  raiseLifecycleBlocked(result: EvaluationResult): never {
    this.calls.push({ kind: "raiseLifecycleBlocked", result });
    raiseNative(result);
  }

  raiseHookBlocked(result: EvaluationResult): never {
    this.calls.push({ kind: "raiseHookBlocked", result });
    raiseNative(result);
  }

  onCompletedHookResult(result: EvaluationResult, context: ActivityContext | null = null): void {
    this.calls.push({ kind: "onCompletedHookResult", result, context });
  }

  /** Reset call history (keeps the configured approval outcome). */
  reset(): void {
    this.calls.length = 0;
  }
}
