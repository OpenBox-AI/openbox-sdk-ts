import { describe, expect, it } from "vitest";

import { Verdict } from "../src/contracts/results.js";
import {
  ApprovalTimeoutError,
  GovernanceBlockedError,
  GuardrailsValidationError,
  OpenBoxSigningError,
  extractGovernanceError,
  mapSigningError
} from "../src/errors/index.js";

describe("GovernanceBlockedError", () => {
  it("normalizes a string verdict and formats the message", () => {
    const e = new GovernanceBlockedError("block", "policy X", "https://x");
    expect(e.verdict).toBe(Verdict.BLOCK);
    expect(e.url).toBe("https://x");
    expect(e.message).toContain("block");
    expect(e.name).toBe("GovernanceBlockedError");
  });
});

describe("extractGovernanceError", () => {
  it("finds a GovernanceBlockedError through the cause chain", () => {
    const blocked = new GovernanceBlockedError("halt", "stop");
    const wrapped = new Error("wrapper", { cause: blocked });
    expect(extractGovernanceError(wrapped)).toBe(blocked);
    expect(extractGovernanceError(new Error("none"))).toBeNull();
  });

  it("is cycle-safe", () => {
    const a = new Error("a");
    a.cause = a;
    expect(extractGovernanceError(a)).toBeNull();
  });
});

describe("mapSigningError", () => {
  it("maps known reason codes and falls back for unknown / custom", () => {
    const known = mapSigningError("signature_invalid");
    expect(known.reasonCode).toBe("signature_invalid");
    expect(known.message).toContain("signature_invalid");

    const unknown = mapSigningError("weird_code");
    expect(unknown).toBeInstanceOf(OpenBoxSigningError);
    expect(unknown.message).toContain("weird_code");

    expect(mapSigningError(null, "custom fallback").message).toBe("custom fallback");
    expect(mapSigningError(null).message).toContain("rejected by OpenBox Core");
  });
});

describe("error messages", () => {
  it("ApprovalTimeoutError includes the budget when known", () => {
    expect(new ApprovalTimeoutError(5000).message).toContain("5000");
    expect(new ApprovalTimeoutError().message).toContain("timed out");
  });

  it("GuardrailsValidationError joins reasons", () => {
    expect(new GuardrailsValidationError(["a", "b"]).message).toBe("a; b");
    expect(new GuardrailsValidationError().message).toContain("failed");
  });
});
