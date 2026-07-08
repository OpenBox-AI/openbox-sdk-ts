/**
 * Verdict enforcement — the default `raiseForVerdict` helper.
 *
 * Split out of `gate/index.ts` (pure modularization, no behavior change): this
 * file owns exactly the priority-ordered enforcement decision, independent of
 * envelope validation and payload preparation.
 */

import { Verdict, type EvaluationResult } from "../contracts/results.js";
import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError
} from "../errors/index.js";

/**
 * Default enforcement helper implementing the verdict priority order.
 *
 * HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW.
 *
 * Throws the core error types for stop-shaped results; returns the result for
 * REQUIRE_APPROVAL (caller drives approval) and for ALLOW/CONSTRAIN (caller
 * proceeds). Framework adapters typically translate these into native errors
 * instead of calling this helper.
 */
export function raiseForVerdict(result: EvaluationResult): EvaluationResult {
  if (result.verdict === Verdict.HALT) {
    throw new GovernanceHaltError(result.reason ?? "Halted by governance policy");
  }
  if (result.verdict === Verdict.BLOCK) {
    throw new GovernanceBlockedError(result.verdict, result.reason ?? "Blocked by governance policy");
  }
  // Guardrails failure outranks approval so it is never swallowed by a HITL flow.
  if (result.guardrails && !result.guardrails.validationPassed) {
    const reasons = result.guardrails.getReasonStrings();
    throw new GuardrailsValidationError(reasons.length > 0 ? reasons : ["Guardrails validation failed"]);
  }
  return result;
}
