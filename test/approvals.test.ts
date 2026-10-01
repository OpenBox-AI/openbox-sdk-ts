import { describe, expect, it } from "vitest";

import { ApprovalPoller } from "../src/approvals/index.js";
import type { OpenBoxClient } from "../src/client/index.js";
import { ApprovalResult } from "../src/contracts/results.js";
import { ApprovalRejectedError, ApprovalTimeoutError } from "../src/errors/index.js";

/** Fake client exposing only pollApproval — the sole surface ApprovalPoller uses. */
function fakeClient(
  pollApproval: (
    workflowId: string,
    runId: string,
    activityId: string,
    signal?: AbortSignal
  ) => Promise<ApprovalResult | null>
): OpenBoxClient {
  return { pollApproval } as unknown as OpenBoxClient;
}

const PENDING = ApprovalResult.fromDict({ verdict: "require_approval" });

describe("ApprovalPoller.waitForDecision", () => {
  it("returns the result once a terminal decision arrives", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "allow" }))),
      { pollIntervalMs: 1 }
    );
    const result = await poller.waitForDecision("wf", "run", "act");
    expect(result.allowShaped).toBe(true);
  });

  it("raises ApprovalTimeoutError after N consecutive poll failures (Core unreachable)", async () => {
    const poller = new ApprovalPoller(fakeClient(() => Promise.resolve(null)), {
      pollIntervalMs: 1,
      maxConsecutiveFailures: 3
    });
    await expect(poller.waitForDecision("wf", "run", "act")).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
  });

  it("raises ApprovalTimeoutError when the max-wait budget is exceeded while pending", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ verdict: "require_approval" }))),
      { pollIntervalMs: 2, maxWaitMs: 8 }
    );
    await expect(poller.waitForDecision("wf", "run", "act")).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
  });
});

describe("ApprovalPoller.waitForDecision — abortSignal (shutdown cancellation)", () => {
  it("rejects immediately with the fail-safe ApprovalRejectedError when already aborted before the wait starts — no poll at all", async () => {
    const controller = new AbortController();
    controller.abort();
    let pollCount = 0;
    const poller = new ApprovalPoller(
      fakeClient(() => {
        pollCount += 1;
        return Promise.resolve(PENDING);
      }),
      { pollIntervalMs: 1, abortSignal: controller.signal }
    );

    await expect(poller.waitForDecision("wf", "run", "act")).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
    expect(pollCount).toBe(0);
  });

  it("aborts mid-wait (during sleep) and rejects promptly — the tool must not run", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const poller = new ApprovalPoller(
      // Always pending — the wait never settles on its own, so the only way
      // this promise resolves/rejects is the abort below (or a hang, if buggy).
      fakeClient(() => {
        pollCount += 1;
        return Promise.resolve(PENDING);
      }),
      { pollIntervalMs: 1000, abortSignal: controller.signal } // long interval: still asleep when we abort
    );

    const pending = poller.waitForDecision("wf", "run", "act");
    // Give the loop a moment to finish its first poll and settle into
    // `sleep(1000)` — 10ms is well inside that window, so the abort below
    // lands mid-sleep, not before the first poll.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(pending).rejects.toThrow(/aborted \(shutdown\)/);
    expect(pollCount).toBe(1); // no further poll is issued after the abort
  });
});
