import { describe, expect, it } from "vitest";

import {
  ApprovalResult,
  EvaluationResult,
  GuardrailsResult,
  Verdict,
  highestPriorityVerdict,
  verdictFromString,
  verdictPriority,
  verdictRequiresApproval,
  verdictShouldStop
} from "../src/contracts/results.js";

describe("Verdict helpers", () => {
  it("parses with v1.0 compat aliases and defaults unknown → ALLOW", () => {
    expect(verdictFromString("continue")).toBe(Verdict.ALLOW);
    expect(verdictFromString("stop")).toBe(Verdict.HALT);
    expect(verdictFromString("require-approval")).toBe(Verdict.REQUIRE_APPROVAL);
    expect(verdictFromString("request_approval")).toBe(Verdict.REQUIRE_APPROVAL);
    expect(verdictFromString("BLOCK")).toBe(Verdict.BLOCK);
    expect(verdictFromString(null)).toBe(Verdict.ALLOW);
    expect(verdictFromString("nonsense")).toBe(Verdict.ALLOW);
  });

  it("orders by priority and stops on BLOCK/HALT", () => {
    expect(verdictPriority(Verdict.HALT)).toBeGreaterThan(verdictPriority(Verdict.BLOCK));
    expect(highestPriorityVerdict([])).toBe(Verdict.ALLOW);
    expect(highestPriorityVerdict([Verdict.ALLOW, Verdict.HALT, Verdict.BLOCK])).toBe(Verdict.HALT);
    expect(verdictShouldStop(Verdict.BLOCK)).toBe(true);
    expect(verdictShouldStop(Verdict.ALLOW)).toBe(false);
    expect(verdictRequiresApproval(Verdict.REQUIRE_APPROVAL)).toBe(true);
  });
});

describe("EvaluationResult.fromDict — lenient", () => {
  it("preserves unknown keys in raw and never throws", () => {
    const r = EvaluationResult.fromDict({ verdict: "block", reason: "no", surprise_field: 42 });
    expect(r.verdict).toBe(Verdict.BLOCK);
    expect(r.raw["surprise_field"]).toBe(42);
  });

  it("falls back to the v1.0 action when verdict is absent", () => {
    expect(EvaluationResult.fromDict({ action: "stop" }).verdict).toBe(Verdict.HALT);
    expect(EvaluationResult.fromDict({}).verdict).toBe(Verdict.ALLOW);
  });

  it("an empty/blank verdict does not shadow the action fallback (no fail-open)", () => {
    expect(EvaluationResult.fromDict({ verdict: "", action: "stop" }).verdict).toBe(Verdict.HALT);
    expect(EvaluationResult.fromDict({ verdict: "   " }).verdict).toBe(Verdict.ALLOW);
  });

  it("guardrails ≡ guardrailsResult (same object)", () => {
    const r = EvaluationResult.fromDict({
      verdict: "allow",
      guardrails_result: { validation_passed: false, reasons: [{ reason: "pii" }] }
    });
    expect(r.guardrails).toBe(r.guardrailsResult);
    expect(r.guardrails).toBeInstanceOf(GuardrailsResult);
    expect(r.guardrails?.getReasonStrings()).toEqual(["pii"]);
  });

  it("derives the compat action string and marks fail-open fallbacks", () => {
    expect(EvaluationResult.fromDict({ verdict: "allow" }).action).toBe("continue");
    expect(EvaluationResult.fromDict({ verdict: "require_approval" }).action).toBe("require-approval");
    const fb = EvaluationResult.fallbackAllow("offline");
    expect(fb.verdict).toBe(Verdict.ALLOW);
    expect(fb.fallbackUsed).toBe(true);
  });
});

describe("ApprovalResult.fromDict — STRICT", () => {
  it("unknown/empty decision → null (pending), never auto-ALLOW", () => {
    expect(ApprovalResult.fromDict({}).verdict).toBeNull();
    expect(ApprovalResult.fromDict({ verdict: "mystery" }).verdict).toBeNull();
    expect(ApprovalResult.fromDict({}).isPending()).toBe(true);
  });

  it("action wins over verdict; empty action does not shadow verdict", () => {
    expect(ApprovalResult.fromDict({ action: "allow", verdict: "block" }).verdict).toBe(Verdict.ALLOW);
    expect(ApprovalResult.fromDict({ action: "  ", verdict: "block" }).verdict).toBe(Verdict.BLOCK);
  });

  it("classifies blocking / allow-shaped / expired", () => {
    expect(ApprovalResult.fromDict({ verdict: "allow" }).allowShaped).toBe(true);
    expect(ApprovalResult.fromDict({ verdict: "block" }).isBlocking()).toBe(true);
    expect(ApprovalResult.fromDict({ verdict: "allow", expired: true }).isBlocking()).toBe(false);
    expect(ApprovalResult.fromDict({ expired: true }).isBlocking()).toBe(true);
    expect(ApprovalResult.fromDict({ verdict: "require_approval" }).isPending()).toBe(true);
  });

  it("normalizes id → approvalId", () => {
    expect(ApprovalResult.fromDict({ id: "appr-1" }).approvalId).toBe("appr-1");
  });
});

describe("GuardrailsResult.fromDict", () => {
  it("defaults validationPassed true and extracts reason strings", () => {
    const g = GuardrailsResult.fromDict({ reasons: [{ reason: "a" }, { reason: "" }, { reason: "b" }] });
    expect(g.validationPassed).toBe(true);
    expect(g.getReasonStrings()).toEqual(["a", "b"]);
  });
});
