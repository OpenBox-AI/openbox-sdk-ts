/**
 * Result contracts — Verdict, GuardrailsResult, EvaluationResult, ApprovalResult.
 *
 * Pure, import-safe module: no crypto, network, OTel, logging, wall-clock, or
 * random. Strict constructors AND lenient `fromDict` parsers are both public.
 *
 * Parsing preserves `raw` so nothing the backend sent is ever lost, and stays
 * tolerant of unknown keys — field-shape drift from Core must not crash SDKs.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 5-tier graduated response.
 * Priority: HALT > BLOCK > REQUIRE_APPROVAL > CONSTRAIN > ALLOW.
 *
 * Modeled as a const object + union type (not a TS `enum`) so it doubles as
 * value and type while satisfying `isolatedModules`. Behavior lives in the
 * standalone `verdict*` helpers below.
 */
export const Verdict = {
  ALLOW: "allow",
  CONSTRAIN: "constrain",
  REQUIRE_APPROVAL: "require_approval",
  BLOCK: "block",
  HALT: "halt"
} as const;

export type Verdict = (typeof Verdict)[keyof typeof Verdict];

const VERDICT_PRIORITY: Record<Verdict, number> = {
  [Verdict.ALLOW]: 1,
  [Verdict.CONSTRAIN]: 2,
  [Verdict.REQUIRE_APPROVAL]: 3,
  [Verdict.BLOCK]: 4,
  [Verdict.HALT]: 5
};

const VERDICT_VALUES = new Set<string>(Object.values(Verdict));

/**
 * Parse with v1.0 compat: `continue`→ALLOW, `stop`→HALT,
 * `require-approval`/`request_approval`→REQUIRE_APPROVAL. Unknown → ALLOW.
 *
 * This leniency is for the EVALUATE path only. The human-approval trust
 * boundary uses a strict decision parser (see `ApprovalResult`).
 */
export function verdictFromString(value: string | null | undefined): Verdict {
  if (value === null || value === undefined) return Verdict.ALLOW;
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "continue") return Verdict.ALLOW;
  if (normalized === "stop") return Verdict.HALT;
  if (normalized === "require_approval" || normalized === "request_approval") {
    return Verdict.REQUIRE_APPROVAL;
  }
  return VERDICT_VALUES.has(normalized) ? (normalized as Verdict) : Verdict.ALLOW;
}

/** Priority for aggregation: HALT=5, BLOCK=4, REQUIRE_APPROVAL=3, CONSTRAIN=2, ALLOW=1. */
export function verdictPriority(verdict: Verdict): number {
  return VERDICT_PRIORITY[verdict];
}

/** Highest-priority verdict from a list; ALLOW if empty. */
export function highestPriorityVerdict(verdicts: readonly Verdict[]): Verdict {
  let highest: Verdict = Verdict.ALLOW;
  for (const v of verdicts) {
    if (verdictPriority(v) > verdictPriority(highest)) highest = v;
  }
  return highest;
}

/** True if BLOCK or HALT. */
export function verdictShouldStop(verdict: Verdict): boolean {
  return verdict === Verdict.BLOCK || verdict === Verdict.HALT;
}

/** True if REQUIRE_APPROVAL. */
export function verdictRequiresApproval(verdict: Verdict): boolean {
  return verdict === Verdict.REQUIRE_APPROVAL;
}

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

/** Guardrails check result from the governance API. */
export class GuardrailsResult {
  redactedInput: unknown = null;
  inputType = "";
  rawLogs: Dict | null = null;
  validationPassed = true;
  reasons: Array<Record<string, string>> = [];

  static fromDict(data: Dict): GuardrailsResult {
    const result = new GuardrailsResult();
    result.redactedInput = data["redacted_input"] ?? null;
    result.inputType = typeof data["input_type"] === "string" ? data["input_type"] : "";
    result.rawLogs = (data["raw_logs"] as Dict | null | undefined) ?? null;
    result.validationPassed =
      data["validation_passed"] === undefined ? true : Boolean(data["validation_passed"]);
    result.reasons = Array.isArray(data["reasons"])
      ? (data["reasons"] as Array<Record<string, string>>)
      : [];
    return result;
  }

  /** Extract just the `reason` field from each reason object. */
  getReasonStrings(): string[] {
    return this.reasons.map((r) => r["reason"]).filter((r): r is string => Boolean(r));
  }
}

/**
 * Response from a governance evaluation.
 *
 * `guardrails` and `guardrailsResult` are the SAME object — `guardrailsResult`
 * is a read-only alias; there is no way for the two to diverge.
 */
export class EvaluationResult {
  verdict: Verdict = Verdict.ALLOW;
  reason: string | null = null;
  policyId: string | null = null;
  riskScore = 0.0;
  metadata: Dict | null = null;
  governanceEventId: string | null = null;
  guardrails: GuardrailsResult | null = null;
  approvalId: string | null = null;
  approvalExpirationTime: string | null = null;
  trustTier: string | null = null;
  alignmentScore: number | null = null;
  behavioralViolations: string[] | null = null;
  constraints: Dict[] | null = null;
  /** True when a fail-open network fallback produced this result. */
  fallbackUsed = false;
  diagnostics: unknown[] = [];
  raw: Dict = {};

  /** Alias of `guardrails` (same object). */
  get guardrailsResult(): GuardrailsResult | null {
    return this.guardrails;
  }

  /** Backward compat: the v1.0 action string derived from the verdict. */
  get action(): string {
    if (this.verdict === Verdict.ALLOW) return "continue";
    if (this.verdict === Verdict.HALT) return "stop";
    if (this.verdict === Verdict.REQUIRE_APPROVAL) return "require-approval";
    return this.verdict;
  }

  /**
   * Parse a governance response (v1.0 + v1.1 compatible). Verdict-first with a
   * v1.0 `action` fallback (approval action-precedence applies to
   * `ApprovalResult` only). Unknown keys are preserved in `raw`, never an error.
   */
  static fromDict(data: Dict): EvaluationResult {
    const result = new EvaluationResult();
    const guardrailsRaw = data["guardrails_result"] ?? data["guardrails"];
    result.guardrails =
      guardrailsRaw && typeof guardrailsRaw === "object"
        ? GuardrailsResult.fromDict(asDict(guardrailsRaw))
        : null;

    // An empty/blank verdict must not shadow the v1.0 `action` fallback (Python
    // uses `or`, i.e. truthiness) — otherwise `{verdict:"", action:"stop"}` would
    // wrongly resolve to ALLOW (a fail-open at the governance boundary).
    const verdictRaw = data["verdict"];
    const verdictStr =
      typeof verdictRaw === "string" && verdictRaw.trim() ? verdictRaw : undefined;
    const actionStr = data["action"] as string | undefined;
    result.verdict = verdictFromString(verdictStr ?? actionStr ?? "continue");

    result.reason = (data["reason"] as string | null | undefined) ?? null;
    result.policyId = (data["policy_id"] as string | null | undefined) ?? null;
    result.riskScore = typeof data["risk_score"] === "number" ? data["risk_score"] : 0.0;
    result.metadata = (data["metadata"] as Dict | null | undefined) ?? null;
    result.governanceEventId =
      (data["governance_event_id"] as string | null | undefined) ?? null;
    result.approvalId = (data["approval_id"] as string | null | undefined) ?? null;
    result.approvalExpirationTime =
      (data["approval_expiration_time"] as string | null | undefined) ?? null;
    result.trustTier = (data["trust_tier"] as string | null | undefined) ?? null;
    result.alignmentScore = (data["alignment_score"] as number | null | undefined) ?? null;
    result.behavioralViolations =
      (data["behavioral_violations"] as string[] | null | undefined) ?? null;
    result.constraints = (data["constraints"] as Dict[] | null | undefined) ?? null;
    result.fallbackUsed = Boolean(data["fallback_used"] ?? false);
    result.diagnostics = Array.isArray(data["diagnostics"]) ? data["diagnostics"] : [];
    result.raw = { ...data };
    return result;
  }

  /**
   * Allow-shaped result for fail-open network-error paths. `fallbackUsed=true`
   * marks it so callers can tell a policy ALLOW from an unreachable-Core ALLOW.
   */
  static fallbackAllow(reason: string): EvaluationResult {
    const result = new EvaluationResult();
    result.verdict = Verdict.ALLOW;
    result.reason = reason;
    result.fallbackUsed = true;
    return result;
  }
}

// Strict approval decision vocabulary (current values + accepted aliases).
// Anything OUTSIDE this set parses to null (pending). The evaluate-path
// leniency (unknown → ALLOW) is too loose at the human-approval trust boundary.
const APPROVAL_DECISION_VOCABULARY = new Set<string>([
  "allow",
  "constrain",
  "require_approval",
  "request_approval",
  "block",
  "halt",
  "continue",
  "stop"
]);

/**
 * Normalized HITL approval-poll response.
 *
 * Decision-source precedence: `action` wins over `verdict` when both present.
 * When NEITHER is present, `verdict` is `null` (pending-unknown) — never
 * auto-ALLOW. Expired approvals block unless the backend explicitly returned an
 * allow-shaped verdict/action.
 */
export class ApprovalResult {
  verdict: Verdict | null = null;
  action: string | null = null;
  reason: string | null = null;
  approvalId: string | null = null;
  approvalExpirationTime: string | null = null;
  expired = false;
  raw: Dict = {};

  /** Strict, fail-safe decision parsing: empty/unknown → null (pending). */
  private static parseDecision(value: unknown): Verdict | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const normalized = value.trim().toLowerCase().replace(/-/g, "_");
    if (!APPROVAL_DECISION_VOCABULARY.has(normalized)) return null;
    return verdictFromString(normalized);
  }

  static fromDict(data: Dict): ApprovalResult {
    const result = new ApprovalResult();
    let action = data["action"];
    // Empty/whitespace action is absent; it must not shadow `verdict`.
    if (typeof action !== "string" || !action.trim()) action = undefined;
    const verdictSource = action !== undefined ? action : data["verdict"];
    result.verdict = ApprovalResult.parseDecision(verdictSource);
    result.action = typeof action === "string" ? action : null;
    result.reason = (data["reason"] as string | null | undefined) ?? null;
    result.approvalId =
      (data["approval_id"] as string | null | undefined) ??
      (data["id"] as string | null | undefined) ??
      null;
    result.approvalExpirationTime =
      (data["approval_expiration_time"] as string | null | undefined) ?? null;
    result.expired = Boolean(data["expired"] ?? false);
    result.raw = { ...data };
    return result;
  }

  /** True when the backend explicitly returned an allow verdict/action. */
  get allowShaped(): boolean {
    return this.verdict === Verdict.ALLOW;
  }

  /**
   * True when this response must stop the operation. Expired approvals are
   * blocking unless explicitly allow-shaped; an explicit BLOCK/HALT is blocking
   * regardless of expiry.
   */
  isBlocking(): boolean {
    if (this.expired) return !this.allowShaped;
    return this.verdict !== null && verdictShouldStop(this.verdict);
  }

  /**
   * True while the decision is still outstanding. Absent verdict/action (null)
   * is pending — never auto-ALLOW. REQUIRE_APPROVAL and CONSTRAIN keep polling.
   */
  isPending(): boolean {
    if (this.expired) return false;
    if (this.verdict === null) return true;
    return this.verdict === Verdict.REQUIRE_APPROVAL || this.verdict === Verdict.CONSTRAIN;
  }
}
