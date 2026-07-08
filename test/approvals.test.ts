import { describe, expect, it } from "vitest";

import { ApprovalPoller } from "../src/approvals/index.js";
import type { OpenBoxClient } from "../src/client/index.js";
import { ApprovalResult } from "../src/contracts/results.js";
import { ApprovalTimeoutError } from "../src/errors/index.js";

/** Fake client exposing only pollApproval — the sole surface ApprovalPoller uses. */
function fakeClient(pollApproval: () => Promise<ApprovalResult | null>): OpenBoxClient {
  return { pollApproval } as unknown as OpenBoxClient;
}

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
