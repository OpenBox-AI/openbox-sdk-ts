/**
 * `ErrorInfo` — the structured lifecycle error Core accepts on the wire.
 *
 * Core's lifecycle endpoints require top-level `error` to be an OBJECT
 * (`{type, message, stack_trace?}`), never a bare string — a string is
 * rejected with HTTP 400. `WorkflowFailed` and `ActivityCompleted` factories
 * take this shape and serialize it unchanged.
 *
 * Pure, import-safe module: types only.
 *
 * Deliberately a `type` alias, NOT an `interface`: only object-literal types
 * get an implicit index signature, which is what makes `ErrorInfo` assignable
 * to `JsonValue` (so factories can place it in an event payload without
 * casts). An interface here would fail to typecheck at every assignment site.
 */

export type ErrorInfo = {
  /** Error class/name on the wire, e.g. `"ApprovalRejectedError"`. */
  type: string;
  message: string;
  stack_trace?: string;
  /** Nested causal chain, innermost last. */
  cause?: ErrorInfo;
  /** Framework-specific error taxonomy tag (e.g. Temporal's error type). */
  error_type?: string;
  non_retryable?: boolean;
};
