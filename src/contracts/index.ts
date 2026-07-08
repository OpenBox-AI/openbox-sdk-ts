/**
 * Typed result/event/context primitives: Verdict, EvaluationResult, ApprovalResult, EventEnvelope, ActivityContext (Phase 2-4).
 *
 * Barrel for the contracts layer. Everything re-exported here is pure (no
 * crypto/network/OTel) so the package root stays import-light (see
 * test/root-import-safety.test.ts).
 */
export * from "./results.js";
export * from "./diagnostics.js";
export * from "./otel-spans.js";
export * from "./events.js";
export * from "./event-factories.js";
export * from "./context.js";
