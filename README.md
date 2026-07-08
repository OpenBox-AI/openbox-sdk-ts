# @openbox-ai/openbox-sdk

The OpenBox TypeScript **base SDK** — a contract-driven governance client for
Node/TS agent frameworks. It signs and sends governance events to OpenBox
Core, enforces verdicts (`allow` / `constrain` / `require_approval` / `block`
/ `halt`), and gives framework SDKs (Mastra, and future adapters) a shared,
hardened foundation instead of each reimplementing signing, validation, and
instrumentation. It plays the same role for the TypeScript SDK family that
`openbox-sdk-python` plays for Python.

## Status

Contract-driven, not framework-driven: behavior is reproduced from the
canonical OpenBox Core wire contract and the hardened Python base SDK, then
verified against ported golden fixtures **and** a real Core-parity gate — a Go
harness that unmarshals TS-emitted payloads into Core's own `SpanData` struct
and independently verifies Ed25519 signatures. See
[`docs/source-of-truth.md`](docs/source-of-truth.md) and
[`docs/contract-conflict-ledger.md`](docs/contract-conflict-ledger.md) for the
full source hierarchy and every documented conflict + resolution.

This is a `0.1.x` release: the wire contract, signing, config, client,
runtime, and Tier A1 Node instrumentation (fetch/fs/functions) are
implemented and tested. Database instrumentation (Tier A2/B) has
[documented coverage gaps](docs/instrumentation-coverage.md) — most notably,
`redis` blocking covers `client.sendCommand([...])` only; normal typed usage
(`.get()`, `.set()`, ...) is neither blocked nor observed. Read the
limitations before relying on this for defense-in-depth blocking.

## What it owns

Contracts, layered config, identity/signing, an HTTP client, an always-strict
validation gate, a runtime/context composition root, span builders and wire
projection, hook evaluation, Node instrumentation, and a conformance kit for
testing adapters built on top of it. A framework SDK consumes this package and
keeps only its own lifecycle mapping (a thin adapter) — see
[`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md).

## Install

```bash
npm install @openbox-ai/openbox-sdk
```

Requires Node.js `>=24.10.0`. See [`docs/installation.md`](docs/installation.md)
for optional peer drivers (`pg`, `redis`, `mysql2`, `mongodb`) and the
import-light root guarantee.

## Quick start

### Config → runtime → evaluate

`OpenBoxRuntime` is the recommended entry point: it owns the low-level
`OpenBoxClient`, the always-strict validation gate, and your
`FrameworkAdapter`, and it enforces the verdict for you (throws on
BLOCK/HALT, drives approval on REQUIRE_APPROVAL). See
[why the client alone isn't enough](docs/framework-adapter-guide.md#fail-closed-on-auth-must-be-enforced-at-the-adapter-wrapper-layer)
before wiring `OpenBoxClient` directly in your own code.

```ts
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";
import { Verdict, workflowStarted } from "@openbox-ai/openbox-sdk";

const config = OpenBoxConfig.resolve({
  apiUrl: "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY! // "obx_live_..." or "obx_test_..."
});

const runtime = new OpenBoxRuntime(config);

// Throws GovernanceBlockedError/GovernanceHaltError on BLOCK/HALT; awaits the
// adapter's approval flow on REQUIRE_APPROVAL. Reaching the next line means
// governance let the workflow proceed.
const result = await runtime.evaluateLifecycle(
  workflowStarted({ workflowId: "wf-1", runId: "run-1", workflowType: "order-fulfillment" })
);
console.log(result.verdict); // e.g. Verdict.ALLOW

runtime.close();
```

Building a framework adapter rather than calling the SDK directly? Read
[`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md) first —
it covers implementing `FrameworkAdapter`, driving hooks via
`ContextStore.activityScope`, and a fail-closed pitfall that is easy to
reintroduce at the wrapper layer.

### Opt-in Node instrumentation

`initOpenBoxInstrumentation` installs governance patches for `fetch`,
`fs.promises`, `traced()`-wrapped functions, and (opt-in per driver) `pg`,
`redis`, `mysql2`, `mongodb`. Nothing is patched on import — only inside this
call, and only for drivers you name:

```ts
import { initOpenBoxInstrumentation } from "@openbox-ai/openbox-sdk/instrumentation";

const instrumentation = initOpenBoxInstrumentation({
  runtime,
  databases: ["pg"] // explicit opt-in — never auto-detected
});

// later, on shutdown
instrumentation.shutdown();
```

See [`docs/instrumentation-coverage.md`](docs/instrumentation-coverage.md) for
exactly what each target blocks vs. passes through unblocked (the `redis` and
`mongodb` gaps in particular).

## Public exports

The package root is intentionally **import-light**: it re-exports only pure
contracts and errors (no crypto, network, or OpenTelemetry), so
`import "@openbox-ai/openbox-sdk"` has zero side effects. Everything else is a
subpath, added as real consumers need it.

| Import | Contents |
|---|---|
| `@openbox-ai/openbox-sdk` | `SDK_VERSION`; `Verdict` + verdict helpers; `EvaluationResult`/`ApprovalResult`/`GuardrailsResult`; `EventEnvelope`/`EventType` + event factories (`workflowStarted`, `activityStarted`, `hook`, `handoff`, ...); span field matrices + diagnostics; `ActivityContext`; the full error hierarchy; strict gate helpers (`prepareLifecyclePayload`, `prepareHookPayload`, ...) |
| `@openbox-ai/openbox-sdk/adapters` | `FrameworkAdapter` interface + the default `CoreAdapter` |
| `@openbox-ai/openbox-sdk/approvals` | `ApprovalPoller` — HITL poll-loop orchestration |
| `@openbox-ai/openbox-sdk/client` | `OpenBoxClient` — the governance HTTP client (`evaluate`/`pollApproval`/`validateApiKey`) |
| `@openbox-ai/openbox-sdk/config` | `OpenBoxConfig` — layered env resolution + validation |
| `@openbox-ai/openbox-sdk/conformance` | `FakeCore`/`FakeAdapter`, scenario matrices, wire-shape assertions (test utility, not a frozen API) |
| `@openbox-ai/openbox-sdk/context` | `ContextStore` — per-runtime `AsyncLocalStorage` activity binding |
| `@openbox-ai/openbox-sdk/identity` | `AgentIdentity` + Ed25519 signing primitives |
| `@openbox-ai/openbox-sdk/instrumentation` | `initOpenBoxInstrumentation`, `traced()`, recursion-guard helpers |
| `@openbox-ai/openbox-sdk/runtime` | `OpenBoxRuntime` composition root + `HookEvaluator` |
| `@openbox-ai/openbox-sdk/package.json` | Raw package metadata (for tooling) |

## Documentation

- [`docs/installation.md`](docs/installation.md) — install, engine
  requirement, optional DB peers.
- [`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md) — how
  to build a framework adapter on top of this SDK.
- [`docs/adapter-checklist.md`](docs/adapter-checklist.md) — a checklist for
  future TS SDKs adopting this base.
- [`docs/instrumentation-coverage.md`](docs/instrumentation-coverage.md) —
  exactly what Node instrumentation blocks vs. passes through.
- [`docs/source-of-truth.md`](docs/source-of-truth.md) and
  [`docs/contract-conflict-ledger.md`](docs/contract-conflict-ledger.md) — the
  source hierarchy this SDK is verified against, and every documented
  contract conflict + resolution.
- [`CHANGELOG.md`](CHANGELOG.md).

## Development

```bash
npm install
npm run lint         # eslint (flat, type-checked)
npm run typecheck    # tsc --noEmit
npm run test         # vitest + v8 coverage
npm run build        # tsup (ESM, bundle:false, dts)
npm run pack:check   # npm pack --dry-run
npm run import:check # asserts the built root stays import-light
```

## License

MIT — see [`LICENSE`](LICENSE).
