/**
 * `@openbox-ai/openbox-sdk` — TypeScript base SDK root.
 *
 * The package root is intentionally IMPORT-LIGHT: it re-exports only types,
 * contracts, and errors. It MUST NOT transitively pull in crypto, network
 * (`fetch`), OpenTelemetry, or database-driver modules, so that
 * `import "@openbox-ai/openbox-sdk"` runs with zero side effects (no global
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

// Error hierarchy (pure).
export * from "./errors/index.js";
