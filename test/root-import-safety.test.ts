import { describe, expect, it } from "vitest";

/**
 * Root import-safety invariants (plan Phase 1 / Verification Gates).
 *
 * These assertions cover the *side-effect* vectors that must never fire merely
 * by importing the package root: a global `fetch` monkey-patch and an
 * OpenTelemetry global-provider registration. They run under vitest, whose
 * module graph is virtualized — so they intentionally do NOT try to probe "which
 * modules got loaded". That transitive import-weight guard runs in a clean Node
 * process against the built output via `npm run import:check`
 * (scripts/check-root-import-light.mjs), wired into `ci:check` after `build`.
 */
describe("root import safety", () => {
  it("imports the package root without global side effects", async () => {
    const fetchBefore = globalThis.fetch;

    const mod = await import("../src/index.js");

    // 1. No global fetch monkey-patch on import (instrumentation is opt-in).
    expect(globalThis.fetch).toBe(fetchBefore);

    // 2. No OpenTelemetry global tracer provider registered on import.
    //    @opentelemetry/api stores the global provider under this symbol only
    //    when setGlobalTracerProvider() is called — merely importing must not.
    const otelGlobalKey = Symbol.for("opentelemetry.js.api.1");
    expect((globalThis as Record<symbol, unknown>)[otelGlobalKey]).toBeUndefined();

    // 3. The root surface stays light: a real value export exists and is typed.
    expect(typeof mod.SDK_VERSION).toBe("string");
    expect(mod.SDK_VERSION.length).toBeGreaterThan(0);
  });
});
