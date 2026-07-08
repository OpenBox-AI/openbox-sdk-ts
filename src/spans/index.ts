/**
 * Core SpanData normalization + flat hook-span assertions + family span builders (Phase 3/5).
 *
 * `toCoreSpanData` (Phase 3) normalizes a flat span dict against the Core
 * `SpanData` field matrix. The Tier A1 family builders (http/file/function —
 * Phase 5) assemble the family-specific fields instrumentation wrappers feed
 * into that normalizer; the `db` family is Tier A2 and not part of this
 * barrel yet. Import-light (no crypto/network — `node:crypto` random-id
 * minting lives in the instrumentation wrappers, not here).
 */
export * from "./core-span.js";
export * from "./http-span-builder.js";
export * from "./file-span-builder.js";
export * from "./function-span-builder.js";
