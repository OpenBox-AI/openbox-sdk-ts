import { describe, expect, it } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { ApprovalPoller } from "../src/approvals/index.js";
import type { OpenBoxClient } from "../src/client/index.js";
import { ApprovalResult, EvaluationResult, Verdict } from "../src/contracts/results.js";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  GovernanceBlockedError,
  GovernanceHaltError
} from "../src/errors/index.js";

/** Fake client exposing only pollApproval — the sole surface ApprovalPoller uses (mirrors test/approvals.test.ts). */
function fakeClient(pollApproval: () => Promise<ApprovalResult | null>): OpenBoxClient {
  return { pollApproval } as unknown as OpenBoxClient;
}

function requireApproval(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  const result = new EvaluationResult();
  result.verdict = Verdict.REQUIRE_APPROVAL;
  Object.assign(result, overrides);
  return result;
}

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

describe("CoreAdapter.handleApproval — with a poller configured", () => {
  it("without an approvalId still fails safe (never drives the poller)", async () => {
    let pollCalls = 0;
    const poller = new ApprovalPoller(
      fakeClient(() => {
        pollCalls += 1;
        return Promise.resolve(ApprovalResult.fromDict({ action: "allow" }));
      }),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval())).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(pollCalls).toBe(0);
  });

  it("resolves normally on an allow-shaped decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "allow" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval({ approvalId: "appr-1" }))).resolves.toBeUndefined();
  });

  it("throws ApprovalRejectedError on a block decision", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ action: "block", reason: "no" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval({ approvalId: "appr-1" }));
    await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(promise).rejects.toThrow("no");
  });

  it("throws ApprovalExpiredError when the decision is expired", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ expired: true, reason: "too late" }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const promise = adapter.handleApproval(requireApproval({ approvalId: "appr-1" }));
    await expect(promise).rejects.toBeInstanceOf(ApprovalExpiredError);
    await expect(promise).rejects.toThrow("too late");
  });

  it("falls back to a default message when an expired decision carries no reason", async () => {
    const poller = new ApprovalPoller(
      fakeClient(() => Promise.resolve(ApprovalResult.fromDict({ expired: true }))),
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    await expect(adapter.handleApproval(requireApproval({ approvalId: "appr-1" }))).rejects.toThrow(
      /Approval window expired/
    );
  });

  it("passes workflow_id/run_id/activity_id read from result.raw to the poller", async () => {
    const seen: [string, string, string][] = [];
    const poller = new ApprovalPoller(
      {
        pollApproval: (w: string, r: string, a: string) => {
          seen.push([w, r, a]);
          return Promise.resolve(ApprovalResult.fromDict({ action: "allow" }));
        }
      } as unknown as OpenBoxClient,
      { pollIntervalMs: 1 }
    );
    const adapter = new CoreAdapter({ approvalPoller: poller });
    const result = requireApproval({
      approvalId: "appr-1",
      raw: { workflow_id: "wf-1", run_id: "run-1", activity_id: "act-1" }
    });
    await adapter.handleApproval(result);
    expect(seen).toStrictEqual([["wf-1", "run-1", "act-1"]]);
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
