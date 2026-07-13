/**
 * `@openbox-ai/openbox-sdk-ts` — TypeScript base SDK root.
 *
 * The package root is intentionally IMPORT-LIGHT: it re-exports only types,
 * contracts, and errors. It MUST NOT transitively pull in crypto, network
 * (`fetch`), OpenTelemetry, or database-driver modules, so that
 * `import "@openbox-ai/openbox-sdk-ts"` runs with zero side effects (no global
 * patches, no OTel provider registration). This invariant is enforced by
 * `test/root-import-safety.test.ts` and `npm run import:check`.
 *
 * Heavy subsystems are reached via their own modules (identity/signing, client,
 * config, approvals, instrumentation, otel), added to the public `exports` map
 * on demand as real consumers appear (exports are consumer-driven).
 */

export { SDK_VERSION } from "./version.js";

// Result contracts (pure — no crypto/network).
export * from "./contracts/results.js";

// Structured lifecycle error wire shape (pure — types only).
export * from "./contracts/error-info.js";

// Event contracts, span field matrices, and diagnostics (pure — no
// crypto/network; hook/OTel span capture itself is a later phase).
export * from "./contracts/otel-spans.js";
export * from "./contracts/events.js";
export * from "./contracts/event-factories.js";
export * from "./contracts/diagnostics.js";

// ActivityContext (pure — no crypto/network/node:async_hooks; the
// AsyncLocalStorage-backed ContextStore itself lives at "./context" and is
// NOT re-exported here, to keep the root import-light).
export * from "./contracts/context.js";

// Error hierarchy (pure).
export * from "./errors/index.js";

// Always-strict validation gate helpers (pure — validate/stamp/strip/finalize
// + raiseForVerdict; does NOT call the network client itself — see
// src/gate/index.ts and the future OpenBoxRuntime composition root).
export * from "./gate/index.js";
