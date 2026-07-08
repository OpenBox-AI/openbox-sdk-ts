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
import { ApprovalTimeoutError } from "../errors/index.js";

export interface ApprovalPollerOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number | null; // null = poll indefinitely (bounded only by failures)
  backoffMultiplier?: number; // 1.0 = constant interval
  maxIntervalMs?: number;
  maxConsecutiveFailures?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(client: OpenBoxClient, options: ApprovalPollerOptions = {}) {
    this.client = client;
    this.intervalMs = options.pollIntervalMs ?? 5000;
    this.maxWaitMs = options.maxWaitMs ?? null;
    this.backoff = options.backoffMultiplier ?? 1.0;
    this.maxIntervalMs = options.maxIntervalMs ?? 60000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 60;
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
      const result = await this.client.pollApproval(workflowId, runId, activityId);
      if (ApprovalPoller.isTerminal(result)) return result as ApprovalResult;
      consecutiveFailures = result === null ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        throw new ApprovalTimeoutError();
      }
      if (this.timedOut(startedAt)) {
        throw new ApprovalTimeoutError(this.maxWaitMs !== null ? Math.round(this.maxWaitMs) : null);
      }
      await sleep(this.nextInterval(attempt));
      attempt += 1;
    }
  }
}
