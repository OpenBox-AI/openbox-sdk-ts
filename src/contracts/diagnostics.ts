/**
 * Structured diagnostic records attached to evaluation results.
 *
 * Diagnostics are the NON-FAIL half of validation: they record best-effort
 * degradations (missing semantic attributes, compat-noise removal, redaction,
 * truncation) without rejecting anything. Strict failures raise `ContractError`
 * instead (see `gate/event-rules.ts`) — there is no diagnostic for a contract
 * violation.
 *
 * Leaf module (mirrors Python `validation/diagnostics.py`): no imports besides
 * the pure `JsonValue` type, so both `spans/core-span.ts` and `gate/index.ts`
 * can depend on it without any layering inversion.
 */

import type { JsonValue } from "./results.js";

/** Severity — never an error (errors raise `ContractError` instead). */
export const DiagnosticLevel = {
  INFO: "INFO",
  WARNING: "WARNING"
} as const;

export type DiagnosticLevel = (typeof DiagnosticLevel)[keyof typeof DiagnosticLevel];

// Stable machine diagnostic codes.
export const SPAN_ATTR_MISSING = "SPAN_ATTR_MISSING";
export const COMPAT_NOISE_REMOVED = "COMPAT_NOISE_REMOVED";
export const ATTR_REDACTED = "ATTR_REDACTED";
export const ATTR_TRUNCATED = "ATTR_TRUNCATED";

/** One structured diagnostic record. */
export interface Diagnostic {
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, JsonValue>>;
}

/** Build a `Diagnostic`. `detail` defaults to `{}` (never omitted). */
export function makeDiagnostic(
  level: DiagnosticLevel,
  code: string,
  message: string,
  detail: Readonly<Record<string, JsonValue>> = {}
): Diagnostic {
  return { level, code, message, detail };
}

/** Diagnostics identifying exactly what redaction changed. Empty when nothing changed. */
export function redactionDiagnostics(changedPaths: readonly string[]): Diagnostic[] {
  if (changedPaths.length === 0) return [];
  return [
    makeDiagnostic(
      DiagnosticLevel.INFO,
      ATTR_REDACTED,
      `Redacted ${changedPaths.length} value(s) before send`,
      { paths: [...changedPaths] }
    )
  ];
}

/** Diagnostic identifying a truncated value. */
export function truncationDiagnostic(
  fieldName: string,
  originalSize: number,
  maxSize: number
): Diagnostic {
  return makeDiagnostic(
    DiagnosticLevel.INFO,
    ATTR_TRUNCATED,
    `Truncated ${fieldName} from ${originalSize} to ${maxSize} chars`,
    { field: fieldName, original_size: originalSize, max_size: maxSize }
  );
}
