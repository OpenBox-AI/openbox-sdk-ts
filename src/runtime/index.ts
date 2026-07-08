/**
 * OpenBoxRuntime composition root — wires config/client/gate/context/adapter; drives approvals (Phase 4).
 *
 * Off the import-light root by design (transitively pulls in `node:crypto`
 * via identity/client and `node:async_hooks` via context).
 */
export * from "./openbox-runtime.js";
export { HookEvaluator, type HookEvaluatorDeps } from "./hook-evaluator.js";
