/**
 * Approval polling orchestration on top of `OpenBoxClient.pollApproval`.
 *
 * Owns the poll loop (interval/backoff), timeout budget, and a consecutive-
 * failure ceiling — but imposes NO framework retry strategy: adapters that drive
 * their own approval UX call `client.pollApproval` directly and skip this module.
 *
 * Terminal semantics:
 * - allow-shaped        → return the ApprovalResult (approved)
 * - blocking / expired  → return the ApprovalResult (caller inspects isBlocking/expired)
 * - budget exhausted    → throw ApprovalTimeoutError (client-side condition)
 * - poll failure (null) → still pending; keep polling
 */

import type { OpenBoxClient } from "../client/index.js";
import type { ApprovalResult } from "../contracts/results.js";
import { ApprovalRejectedError, ApprovalTimeoutError } from "../errors/index.js";

export interface ApprovalPollerOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number | null; // null = poll indefinitely (bounded only by failures)
  backoffMultiplier?: number; // 1.0 = constant interval
  maxIntervalMs?: number;
  maxConsecutiveFailures?: number;
  /**
   * Abort an in-flight wait (e.g., controller shutdown). Constructor option
   * only, not a `waitForDecision` param — the stock `CoreAdapter` (which calls
   * `waitForDecision(wf, run, act)`) stays unchanged. Checked at the top of
   * each poll loop iteration and threaded into both `sleep` (interrupts a
   * parked wait instead of waiting it out) and `client.pollApproval` (aborts
   * the in-flight fetch). Fails SAFE on abort — throws `ApprovalRejectedError`,
   * never treats the abort as a transient poll failure to retry.
   */
  abortSignal?: AbortSignal;
}

/**
 * Abort-aware, unref'd delay. `unref()` so a pending sleep during a parked
 * approval wait never keeps the process alive on its own; an abort rejects
 * immediately instead of waiting out the full interval.
 */
function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("sleep aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("sleep aborted"));
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ApprovalPoller {
  private readonly client: OpenBoxClient;
  private readonly intervalMs: number;
  private readonly maxWaitMs: number | null;
  private readonly backoff: number;
  private readonly maxIntervalMs: number;
  // A genuine PENDING may legitimately wait forever (maxWaitMs bounds it), but
  // an UNREACHABLE Core must not hang the governed thread indefinitely: N
  // consecutive poll failures raise ApprovalTimeoutError (fail-safe — the
  // operation does not run).
  private readonly maxConsecutiveFailures: number;
  private readonly abortSignal: AbortSignal | undefined;

  constructor(client: OpenBoxClient, options: ApprovalPollerOptions = {}) {
    this.client = client;
    this.intervalMs = options.pollIntervalMs ?? 5000;
    this.maxWaitMs = options.maxWaitMs ?? null;
    this.backoff = options.backoffMultiplier ?? 1.0;
    this.maxIntervalMs = options.maxIntervalMs ?? 60000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 60;
    this.abortSignal = options.abortSignal;
  }

  private nextInterval(attempt: number): number {
    return Math.min(this.intervalMs * this.backoff ** attempt, this.maxIntervalMs);
  }

  private timedOut(startedAt: number): boolean {
    return this.maxWaitMs !== null && performance.now() - startedAt >= this.maxWaitMs;
  }

  private static isTerminal(result: ApprovalResult | null): boolean {
    return result !== null && !result.isPending();
  }

  /** Fail-safe rejection distinct from the poll-error→null→retry path — the operation must not run. */
  private static abortRejection(): ApprovalRejectedError {
    return new ApprovalRejectedError("approval wait aborted (shutdown) — failing safe");
  }

  /** Throw the fail-safe abort rejection if `abortSignal` has already fired. */
  private throwIfAborted(): void {
    if (this.abortSignal?.aborted) throw ApprovalPoller.abortRejection();
  }

  /** Convert an abort-caused rejection to the fail-safe error; rethrow anything else unchanged. */
  private rejectIfAborted(error: unknown): never {
    if (this.abortSignal?.aborted) throw ApprovalPoller.abortRejection();
    throw error;
  }

  /** Block until the approval is decided/expired, or the budget runs out. */
  async waitForDecision(
    workflowId: string,
    runId: string,
    activityId: string
  ): Promise<ApprovalResult> {
    const startedAt = performance.now();
    let attempt = 0;
    let consecutiveFailures = 0;
    for (;;) {
      this.throwIfAborted();
      let result: ApprovalResult | null;
      try {
        result = await this.client.pollApproval(workflowId, runId, activityId, this.abortSignal);
      } catch (error) {
        this.rejectIfAborted(error);
      }
      if (ApprovalPoller.isTerminal(result)) return result as ApprovalResult;
      consecutiveFailures = result === null ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        throw new ApprovalTimeoutError();
      }
      if (this.timedOut(startedAt)) {
        throw new ApprovalTimeoutError(this.maxWaitMs !== null ? Math.round(this.maxWaitMs) : null);
      }
      try {
        await sleep(this.nextInterval(attempt), this.abortSignal);
      } catch (error) {
        this.rejectIfAborted(error);
      }
      attempt += 1;
    }
  }
}
