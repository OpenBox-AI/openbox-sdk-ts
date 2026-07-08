import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: false,
      exclude: [
        "dist/**",
        "node_modules/**",
        "test/fixtures/**",
        "vitest.config.ts",
        "tsup.config.ts"
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        branches: 70,
        functions: 90,
        lines: 75,
        statements: 75
      }
    },
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // Default 5000ms is too tight for the FULL suite's parallelism: several
    // files now do a genuine first-time `require()` of a heavy native driver
    // (pg/redis/mysql2/mongodb) alongside the pre-existing Go-subprocess
    // core-parity test, all competing for CPU across concurrent worker
    // threads. Verified NOT a logic hang — every DB wrapper test completes
    // in well under 1s when run in isolation; this is solely CI/parallel-run
    // headroom.
    testTimeout: 15000
  }
});
