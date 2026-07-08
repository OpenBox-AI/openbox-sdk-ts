/**
 * Core SpanData normalization + flat hook-span assertions + family span builders (Phase 3/5).
 *
 * `toCoreSpanData` (Phase 3) normalizes a flat span dict against the Core
 * `SpanData` field matrix. Real OTel-span-to-flat-dict conversion (Node
 * instrumentation) lands in a later phase. Import-light (no crypto/network).
 */
export * from "./core-span.js";
