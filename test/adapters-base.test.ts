import { describe, expect, it } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { ApprovalPoller } from "../src/approvals/index.js";
import type { OpenBoxClient } from "../src/client/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { ApprovalResult, EvaluationResult, Verdict } from "../src/contracts/results.js";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  GovernanceBlockedError,
  GovernanceHaltError
} from "../src/errors/index.js";

/** Fake client exposing only pollApproval — the sole surface ApprovalPoller uses (mirrors test/approvals.test.ts). */
function fakeClient(pollApproval: () => Promise<ApprovalResult | null>): OpenBoxClient {
  return { pollApproval } as unknown as OpenBoxClient;
}

/** Fake client that records the (workflowId, runId, activityId) each poll is called with, then allows. */
function idRecordingClient(seen: [string, string, string][]): OpenBoxClient {
  return {
    pollApproval: (w: string, r: string, a: string) => {
      seen.push([w, r, a]);
      return Promise.resolve(ApprovalResult.fromDict({ action: "allow" }));
    }
  } as unknown as OpenBoxClient;
}

function requireApproval(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  const result = new EvaluationResult();
  result.verdict = Verdict.REQUIRE_APPROVAL;
  Object.assign(result, overrides);
  return result;
}

/** Full poll correlation — what the runtime threads in on every real approval. */
const POLL_CTX = new ActivityContext({ workflowId: "wf-1", runId: "run-1", activityId: "act-1" });

describe("CoreAdapter.name", () => {
  it("is 'core'", () => {
    expect(new CoreAdapter().name).toBe("core");
  });
});

describe("CoreAdapter.handleApproval — no poller configured", () => {
  it("REJECTS outright (fail-safe): does not pend, does not allow", async () => {
    const adapter = new CoreAdapter();
    await expect(adapter.handleApproval(requireApproval({ approvalId: "appr-1" }))).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
  });

  it("rejects even when the verdict carries no approvalId", async () => {
    const adapter = new CoreAdapter();
    await expect(adapter.handleApproval(requireApproval())).rejects.toBeInstanceOf(ApprovalRejectedError);
  });
});

describe("CoreAdapter.handleApproval — approval_id is never required to poll", () => {
  it("without an approval_id: polls on the correlation IDs and proceeds after ALLOW", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(idRecordingClient(seen), { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });
    // approvalId stays null — exactly what Core's evaluate response sends today.
    await expect(adapter.handleApproval(requireApproval(), POLL_CTX)).resolves.toBeUndefined();
    expect(seen).toStrictEqual([["wf-1", "run-1", "act-1"]]);
  });

  it("without an approval_id: rejects after a BLOCK decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "block", reason: "human said no" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval(), POLL_CTX);
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow("human said no");
  });

  it("without an approval_id: rejects after a HALT decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "halt" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval(), POLL_CTX)).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
  });

  it("an approval_id, when present, is harmless optional metadata (same allow path)", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(idRecordingClient(seen), { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(
      adapter.handleApproval(requireApproval({ approvalId: "appr-1" }), POLL_CTX)
    ).resolves.toBeUndefined();
    expect(seen).toStrictEqual([["wf-1", "run-1", "act-1"]]);
  });
});

describe("CoreAdapter.handleApproval — missing correlation fails safe (never polls)", () => {
  function countingPoller(): { poller: ApprovalPoller; polls: () => number } {
    let pollCalls = 0;
    const poller = new ApprovalPoller(
      fakeClient(() => {
        pollCalls += 1;
        return Promise.resolve(ApprovalResult.fromDict({ action: "allow" }));
      }),
      { pollIntervalMs: 1 }
    );
    return { poller, polls: () => pollCalls };
  }

  it("no context and an empty raw: rejects naming all three IDs, zero polls", async () => {
    const { poller, polls } = countingPoller();
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval());
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow(/missing workflowId, runId, activityId/);
    expect(polls()).toBe(0);
  });

  it.each([
    ["workflowId", new ActivityContext({ runId: "run-1", activityId: "act-1" })],
    ["runId", new ActivityContext({ workflowId: "wf-1", activityId: "act-1" })],
    ["activityId", new ActivityContext({ workflowId: "wf-1", runId: "run-1" })]
  ] as const)("context missing %s: rejects naming exactly it, zero polls", async (missingKey, context) => {
    const { poller, polls } = countingPoller();
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval(), context);
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow(new RegExp(`missing ${missingKey}\\)`));
    expect(polls()).toBe(0);
  });
});

describe("CoreAdapter.handleApproval — with a poller configured", () => {
  it("resolves normally on an allow-shaped decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "allow" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval(), POLL_CTX)).resolves.toBeUndefined();
  });

  it("throws ApprovalRejectedError on a block decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "block", reason: "no" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval(), POLL_CTX);
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow("no");
  });

  it("throws ApprovalExpiredError when the decision is expired", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ expired: true, reason: "too late" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval(), POLL_CTX);
    await expect(promise).rejects.toBeInstanceOf(ApprovalExpiredError);
    await expect(promise).rejects.toThrow("too late");
  });

  it("falls back to a default message when an expired decision carries no reason", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ expired: true }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval(), POLL_CTX)).rejects.toThrow(
      /Approval window expired/
    );
  });

  it("a pending decision that exhausts the wait budget still times out (ApprovalTimeoutError)", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "require_approval" }))),
      { pollIntervalMs: 1, maxWaitMs: 0 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval(), POLL_CTX)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
  });

  it("polls with the IDs from the passed context — NOT result.raw (Core omits them)", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(idRecordingClient(seen), { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });
    // raw is EMPTY, exactly as a real Core evaluate response is — the poll IDs
    // must come from the context the runtime threads in.
    const result = requireApproval({ approvalId: "appr-1" });
    const context = new ActivityContext({ workflowId: "wf-1", runId: "run-1", activityId: "act-1" });
    await adapter.handleApproval(result, context);
    expect(seen).toStrictEqual([["wf-1", "run-1", "act-1"]]);
  });

  it("falls back to result.raw when no context is passed (backward compat)", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(idRecordingClient(seen), { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const result = requireApproval({
      approvalId: "appr-1",
      raw: { workflow_id: "wf-raw", run_id: "run-raw", activity_id: "act-raw" }
    });
    await adapter.handleApproval(result);
    expect(seen).toStrictEqual([["wf-raw", "run-raw", "act-raw"]]);
  });

  it("prefers context IDs over any stale result.raw echo", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(idRecordingClient(seen), { pollIntervalMs: 1 });
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const result = requireApproval({
      approvalId: "appr-1",
      raw: { workflow_id: "wf-stale", run_id: "run-stale", activity_id: "act-stale" }
    });
    const context = new ActivityContext({ workflowId: "wf-ctx", runId: "run-ctx", activityId: "act-ctx" });
    await adapter.handleApproval(result, context);
    expect(seen).toStrictEqual([["wf-ctx", "run-ctx", "act-ctx"]]);
  });
});

describe("CoreAdapter.raiseLifecycleBlocked / raiseHookBlocked", () => {
  it("BLOCK verdict throws GovernanceBlockedError carrying the verdict", () => {
    const adapter = new CoreAdapter();
    const result = new EvaluationResult();
    result.verdict = Verdict.BLOCK;
    result.reason = "policy denied";
    try {
      adapter.raiseLifecycleBlocked(result);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceBlockedError);
      expect((error as GovernanceBlockedError).verdict).toBe(Verdict.BLOCK);
      expect((error as Error).message).toContain("policy denied");
    }
  });

  it("HALT verdict throws GovernanceHaltError (same mapping for hook blocking)", () => {
    const adapter = new CoreAdapter();
    const result = new EvaluationResult();
    result.verdict = Verdict.HALT;
    result.reason = "kill switch";
    expect(() => adapter.raiseHookBlocked(result)).toThrow(GovernanceHaltError);
  });

  it("falls back to a default reason when none is given (BLOCK)", () => {
    const adapter = new CoreAdapter();
    const result = new EvaluationResult();
    result.verdict = Verdict.BLOCK;
    expect(() => adapter.raiseHookBlocked(result)).toThrow(/Blocked by governance policy/);
  });

  it("falls back to a default reason when none is given (HALT)", () => {
    const adapter = new CoreAdapter();
    const result = new EvaluationResult();
    result.verdict = Verdict.HALT;
    expect(() => adapter.raiseHookBlocked(result)).toThrow(/Halted by governance policy/);
  });
});

describe("CoreAdapter.onCompletedHookResult", () => {
  it("is a no-op — never throws, never returns a value (completed telemetry never undoes work)", () => {
    const adapter = new CoreAdapter();
    const result = new EvaluationResult();
    result.verdict = Verdict.BLOCK;
    expect(adapter.onCompletedHookResult(result)).toBeUndefined();
    expect(adapter.onCompletedHookResult(result, null)).toBeUndefined();
  });
});
