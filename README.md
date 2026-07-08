# @openbox-ai/openbox-sdk

The OpenBox TypeScript **base SDK** — shared OpenBox governance, signing, and
instrumentation behavior for Node/TS framework SDKs. It plays the same role for
the TypeScript SDK family that `openbox-sdk-python` plays for Python.

> **Status:** early scaffolding. This package is contract-driven — behavior is
> reproduced from `openbox-core` (canonical wire contract) and
> `openbox-sdk-python` (hardened base-SDK behavior), verified against ported
> golden fixtures **and** a real Core-parity gate. See
> [`docs/source-of-truth.md`](docs/source-of-truth.md) and
> [`docs/contract-conflict-ledger.md`](docs/contract-conflict-ledger.md).

## What it owns

Contracts, layered config, identity/signing, HTTP client, strict validation
gate, runtime/context, spans + wire projection, hook runtime, Node
instrumentation, and a conformance kit. Framework SDKs (Mastra first) consume it
as a thin adapter and keep only their lifecycle mapping.

## Requirements

- Node `>=24.10.0`

## Development

```bash
npm install
npm run lint       # eslint (flat, type-checked)
npm run typecheck  # tsc --noEmit
npm run test       # vitest + v8 coverage
npm run build      # tsup (ESM, bundle:false, dts)
npm run pack:check # npm pack --dry-run
```

## License

MIT
