# Installation

## Install

```bash
npm install @openbox-ai/openbox-sdk
```

Works the same with `pnpm add` / `yarn add` — the package has no install-time
scripts and ships a plain ESM `dist/`.

## Node engine requirement

`>=24.10.0`. `package.json#engines.node` enforces this; the build targets
Node 24 (`tsup` `target: "node24"`) and the SDK assumes Node's current
`node:crypto` (Ed25519 via `createPrivateKey`) and `node:async_hooks`
(`AsyncLocalStorage`) APIs are present without polyfills.

## Optional database peers

`pg`, `redis`, `mysql2`, and `mongodb` are **never dependencies of this
package** — not even declared as optional peer dependencies in
`package.json`. The base SDK only reaches for one of them when both of these
are true:

1. you already have it installed in your own application, **and**
2. you explicitly opt it into `initOpenBoxInstrumentation({ databases: [...] })`.

`initOpenBoxInstrumentation` lazy-`require()`s a named driver at call time —
never at import time, and never for a driver you didn't name.
`instrumentation.dbEnabled` (default `true`) is only the master kill switch;
`databases: [...]` (default empty) selects which specific drivers to attempt,
and nothing is auto-detected from `node_modules`. If a named driver isn't
installed, that one target fails to patch (a hard diagnostic, or a thrown
`OpenBoxInstrumentationError` under `{ strict: true }`) without affecting the
other targets. Install whichever of these your app actually uses and opts in:

```bash
npm install pg       # only if you opt "pg" into databases: [...]
npm install redis    # only if you opt "redis" into databases: [...]
npm install mysql2   # only if you opt "mysql2" into databases: [...]
npm install mongodb  # only if you opt "mongodb" into databases: [...]
```

See [`instrumentation-coverage.md`](instrumentation-coverage.md) for exactly
what each driver's governance wrapper blocks vs. passes through unblocked —
coverage is intentionally partial for some drivers (notably `redis`, where
only `client.sendCommand([...])` is governed, not typed commands like
`.get()`/`.set()`).

## Import-light root

`import "@openbox-ai/openbox-sdk"` (the root/default export) is safe to add to
any module graph: it pulls in only pure contracts and the error hierarchy — no
`node:crypto`, no `fetch` wrapping, no OpenTelemetry, no database driver, and
no global side effects. Everything with a side effect (signing, the HTTP
client, config env resolution, instrumentation, the runtime) lives behind an
explicit subpath (`@openbox-ai/openbox-sdk/client`,
`@openbox-ai/openbox-sdk/identity`, ...) — see the
[export map in the README](../README.md#public-exports).

This is enforced in CI, not just documented: `npm run import:check` imports
the *built* `dist/index.js` in a clean Node process, spies on module loads for
heavy patterns (db drivers, the OpenTelemetry Node SDK), and diffs
`globalThis.fetch` and the OpenTelemetry global-registration symbol before and
after the import. If you're building your own SDK on top of this one and want
the same guarantee for your own root, see
[`adapter-checklist.md`](adapter-checklist.md).
