/**
 * Core SpanData normalization + flat hook-span assertions + family span builders (Phase 3/5).
 *
 * `toCoreSpanData` (Phase 3) normalizes a flat span dict against the Core
 * `SpanData` field matrix. The family builders (http/file/function — Tier A1;
 * db — Tier A2/B) assemble the family-specific fields instrumentation
 * wrappers feed into that normalizer. Import-light (no crypto/network —
 * `node:crypto` random-id minting lives in the instrumentation wrappers, not
 * here).
 */
export * from "./core-span.js";
export * from "./http-span-builder.js";
export * from "./file-span-builder.js";
export * from "./function-span-builder.js";
export * from "./db-span-builder.js";
