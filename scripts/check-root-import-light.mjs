// Authoritative import-light guard for the package root.
//
// Runs in a CLEAN Node process (unlike the vitest side-effect test, which runs
// in vitest's virtualized module graph) so that Module._load reliably captures
// CommonJS module loads. Heavy drivers (pg, mysql2, mongodb, redis clients) and
// the OpenTelemetry Node SDK are CJS, so importing them transitively from the
// root is caught here. It also re-checks the two global side-effect vectors.
//
// Wired into `ci:check` AFTER `build` (it imports the built dist/). Run directly:
//   npm run import:check

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");

// Modules that must never be pulled in merely by importing the package root.
const HEAVY =
  /(^|[\\/])(pg|mysql2?|mongodb|ioredis|redis|@opentelemetry[\\/](sdk-node|sdk-trace-node|instrumentation))([\\/]|$)/;

const requested = [];
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  requested.push(request);
  return originalLoad.call(this, request, ...rest);
};

const fetchBefore = globalThis.fetch;
const distRoot = new URL("../dist/index.js", import.meta.url);

try {
  await import(distRoot.href);
} finally {
  Module._load = originalLoad;
}

const problems = [];

const heavy = [...new Set(requested.filter((r) => HEAVY.test(r)))];
if (heavy.length > 0) {
  problems.push(`heavy modules loaded on root import: ${heavy.join(", ")}`);
}
if (globalThis.fetch !== fetchBefore) {
  problems.push("global fetch was monkey-patched on root import");
}
if (globalThis[Symbol.for("opentelemetry.js.api.1")] !== undefined) {
  problems.push("OpenTelemetry global provider was registered on root import");
}

if (problems.length > 0) {
  console.error("Root import-light check FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  "Root import-light check passed: no heavy modules or global patches on import."
);
