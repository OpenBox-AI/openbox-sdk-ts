# Notes Index

Entry point for `openbox-sdk-ts` project notes. One line per note.

## Architecture

- [arch-base-sdk-scaffolding](arch-base-sdk-scaffolding.md) — Phase 1 scaffolding, tooling provenance (mirrors Mastra), and the npm-cache / Node-25 `moduleLoadList` sharp edges.

## Decisions

- [decision-signing-parity-and-fail-closed-auth](decision-signing-parity-and-fail-closed-auth.md) — the two sticky Phase 2 decisions: ASCII-escape + PKCS8-DER signing byte-parity, and evaluate() failing CLOSED on auth 401/403 (intentional divergence from Python's fail-open).
