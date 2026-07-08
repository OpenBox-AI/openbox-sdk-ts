/**
 * `@openbox-ai/openbox-sdk` — TypeScript base SDK root.
 *
 * The package root is intentionally IMPORT-LIGHT: it re-exports only types,
 * contracts, errors, and light factory names. It MUST NOT transitively pull in
 * crypto, network (`fetch`), OpenTelemetry, or database-driver modules, so that
 * `import "@openbox-ai/openbox-sdk"` runs with zero side effects (no global
 * patches, no OTel provider registration). This invariant is enforced by
 * `test/root-import-safety.test.ts`.
 *
 * Heavy subsystems (client, identity/signing, instrumentation, otel) are reached
 * via dedicated subpath exports, added on demand as real consumers appear
 * (exports are consumer-driven, not one-per-module).
 */

/**
 * Current SDK version. Surfaced on the `X-OpenBox-SDK-Version` header and the
 * `User-Agent: OpenBox-SDK/{version}` request header (wired in Phase 2 identity).
 *
 * Keep in sync with `package.json#version` until a build-time inject replaces it.
 */
export const SDK_VERSION = "0.1.0";
