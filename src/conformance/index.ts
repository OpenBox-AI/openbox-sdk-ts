/**
 * Conformance kit (test utility) — FakeCore, FakeAdapter, scenario matrices, assertHookWireShape (Phase 4).
 *
 * Importable by any external test file (this SDK's own tests, and later
 * Phase 6's Mastra migration tests) to prove signing/client/approval/hook
 * wire-shape behavior without a live Core. Ships as a test utility in v1 —
 * not a frozen public API (see plan.md).
 */
export * from "./fake-core.js";
export * from "./fake-adapter.js";
export * from "./wire-shape.js";
export * from "./scenarios.js";
