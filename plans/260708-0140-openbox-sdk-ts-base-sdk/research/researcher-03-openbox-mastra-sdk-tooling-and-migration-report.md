# OpenBox TS SDK: Tooling & Migration Inventory Report

**Date:** 2026-07-08 | **Status:** DONE

---

## Part A: TS Tooling to Mirror (Canonical Source)

### A.1 Recommended Configuration Stack

Based on analysis of 3 TS SDKs (mastra=primary, copilotkit, cloudflare), **mastra is the canonical tooling reference**. Copilotkit mirrors mastra's tooling exactly; cloudflare is older/stricter (tsc-only, ES2022). **Recommend adopting mastra's stack for the base SDK.**

#### Copy-Paste Ready Skeleton

**package.json** (`openbox-mastra-sdk:package.json` 1-143)
```json
{
  "name": "@openbox-ai/openbox-sdk",
  "version": "0.1.0",
  "description": "OpenBox governance and observability base SDK",
  "license": "MIT",
  "author": "OpenBox Team",
  "homepage": "https://github.com/OpenBox-AI/openbox-sdk#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OpenBox-AI/openbox-sdk.git"
  },
  "bugs": {
    "url": "https://github.com/OpenBox-AI/openbox-sdk/issues"
  },
  "keywords": ["openbox", "governance", "observability", "base-sdk"],
  "type": "module",
  "sideEffects": false,
  "engines": {
    "node": ">=24.10.0"
  },
  "files": [
    "dist",
    "docs",
    "CHANGELOG.md",
    "README.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./client": {
      "types": "./dist/client/index.d.ts",
      "import": "./dist/client/index.js",
      "default": "./dist/client/index.js"
    },
    "./config": {
      "types": "./dist/config/index.d.ts",
      "import": "./dist/config/index.js",
      "default": "./dist/config/index.js"
    },
    "./governance": {
      "types": "./dist/governance/index.d.ts",
      "import": "./dist/governance/index.js",
      "default": "./dist/governance/index.js"
    },
    "./identity": {
      "types": "./dist/identity/index.d.ts",
      "import": "./dist/identity/index.js",
      "default": "./dist/identity/index.js"
    },
    "./types": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/types/index.js",
      "default": "./dist/types/index.js"
    },
    "./package.json": "./package.json"
  },
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "ci:check": "npm run lint && npm run typecheck && npm run test && npm run build",
    "clean": "rm -rf coverage dist",
    "format": "prettier --write .",
    "lint": "eslint .",
    "pack:check": "npm pack --dry-run",
    "prepack": "npm run clean && npm run build",
    "prepublishOnly": "npm run lint && npm run typecheck && npm run test",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {},
  "dependencies": {
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/resources": "^2.7.1",
    "@opentelemetry/sdk-trace-base": "^2.7.1",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@typescript-eslint/eslint-plugin": "^8.42.0",
    "@typescript-eslint/parser": "^8.42.0",
    "@vitest/coverage-v8": "^3.2.4",
    "eslint": "^9.34.0",
    "eslint-config-prettier": "^10.1.8",
    "prettier": "^3.6.2",
    "tsup": "^8.5.0",
    "typescript": "^5.9.2",
    "typescript-eslint": "^8.42.0",
    "vitest": "^3.2.4"
  }
}
```

**Changes from mastra's package.json:**
- Removed `@mastra/core` from peerDependencies (base SDK is runtime-agnostic)
- Removed all framework-specific OTel instrumentations (http, db libs, etc.) — these move to framework SDKs
- Kept core OTel deps: `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base`

---

### A.2 Build Configuration

**tsup.config.ts** (identical to mastra): `openbox-mastra-sdk:tsup.config.ts` 1-14
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  bundle: false,
  clean: true,
  dts: true,
  entry: ["src/**/*.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,        // Include sourcemap for production debugging
  splitting: false,
  target: "node24"
});
```

**Divergence note:** Copilotkit has `sourcemap: false`. Mastra's `true` is better for observability SDKs. Keep `true`.

---

### A.3 TypeScript Configuration

**tsconfig.json** (identical across mastra & copilotkit): `openbox-mastra-sdk:tsconfig.json` 1-28
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node", "vitest/globals"],
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "tsup.config.ts"],
  "exclude": ["dist", "coverage", "node_modules"]
}
```

**Note:** Cloudflare uses ES2022 + `module: "ES2022"` instead of ESNext — older style. Mastra's ES2023/ESNext is modern. Keep mastra's settings.

---

### A.4 Test Configuration

**vitest.config.ts** (identical across mastra & copilotkit): `openbox-mastra-sdk:vitest.config.ts` 1-30
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: false,
      exclude: [
        ".reference/**",
        "dist/**",
        "examples/**",
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
    include: ["test/**/*.test.ts"]
  }
});
```

---

### A.5 Lint Configuration

**eslint.config.js** (migrate mastra's flat config): `openbox-mastra-sdk:eslint.config.js` 1-79

Use mastra's eslint config **exactly**, but remove framework-specific rules. Mastra has special linting for:
- `src/governance/activity-runtime.ts` (needs relaxed rules)
- `src/mastra/wrap-*.ts` (needs relaxed rules for dynamic wrapping)
- `src/otel/setup-openbox-opentelemetry.ts` (needs relaxed rules)

**For base SDK**, create a minimal version:
```javascript
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".reference/**",
      "coverage/**",
      "dist/**",
      "eslint.config.js",
      "node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" }
      ],
      "@typescript-eslint/no-confusing-void-expression": "error"
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unused-vars": "off"
    }
  }
);
```

---

### A.6 Prettier Configuration

**prettierrc.json** (identical): `openbox-mastra-sdk:.prettierrc.json` 1-5
```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "none"
}
```

---

### A.7 CI/CD Configuration

**GitHub Actions** (`openbox-mastra-sdk:.github/workflows/pr-quality.yml`):
- Uses Node 24.10.0 (matches `engines.node` in package.json)
- Runs: `npm ci` → lint → typecheck → test → build → SonarQube
- Coverage thresholds enforced: 70% branches, 90% functions, 75% lines
- Codecov integration (if token provided)

**Recommended for base SDK:** Copy mastra's PR quality workflow, but remove SonarQube if not using (SQ is optional; Codecov is good).

---

### A.8 Import Alias Configuration

All 3 SDKs use `@/*` → `src/*` alias in tsconfig. **Keep this.**

---

## Part B: Migration Inventory (Mastra SDK)

### B.1 Shared Surfaces Across Mastra & Copilotkit

These modules exist in **both** mastra and copilotkit with minimal/identical implementation. **Candidate for extraction to base SDK.**

| Module | Mastra Path | Copilotkit Path | Status | Re-verify? |
|--------|-------------|-----------------|--------|-----------|
| **Verdict Types** | `src/types/verdict.ts` | `src/types/verdict.ts` | ✅ Identical | No (enum logic, safe) |
| **GovernanceVerdictResponse** | `src/types/governance-verdict-response.ts` | `src/types/governance-verdict-response.ts` | ✅ Identical | No (data struct, safe) |
| **Guardrails Types** | `src/types/guardrails.ts` | `src/types/guardrails.ts` | ✅ Identical | No (data struct, safe) |
| **Error Types** | `src/types/errors.ts` | `src/types/errors.ts` | ✅ Identical | No (error classes, safe) |
| **WorkflowEventType** | `src/types/workflow-event-type.ts` | `src/types/workflow-event-type.ts` | ✅ Identical | No (enum, safe) |
| **OpenBoxClient** | `src/client/openbox-client.ts` | `src/client/openbox-client.ts` | ✅ Identical API | No (API contract, safe) |
| **OpenBoxConfig** | `src/config/openbox-config.ts` | `src/config/openbox-config.ts` | ⚠️ Similar | **Yes** (see B.3) |
| **AgentIdentity** | `src/identity/agent-identity.ts` | `src/identity/agent-identity.ts` | ✅ Identical | No (crypto helpers, safe) |
| **ApprovalRegistry** | `src/governance/approval-registry.ts` | `src/governance/approval-registry.ts` | ✅ Identical | No (in-memory cache, safe) |
| **ExecutionContext** | `src/governance/context.ts` | `src/governance/context.ts` | ✅ Identical | No (context storage, safe) |

---

### B.2 Mastra-Specific Surfaces (Stays in Framework SDK)

These modules wrap Mastra-native concepts and should **not** be in the base SDK.

| Module | File(s) | Purpose | Mastra-Specific? |
|--------|---------|---------|------------------|
| **Mastra Wrappers** | `src/mastra/with-openbox.ts` | Entry point: patching Mastra instance w/ OpenBox runtime | ✅ Yes—Mastra-only |
| **Wrap Agent** | `src/mastra/wrap-agent.ts` | Intercept agent execution; signal streaming; approval polling | ✅ Yes—Mastra agent API |
| **Wrap Tool** | `src/mastra/wrap-tool.ts` | Intercept tool execution; input/output validation | ✅ Yes—Mastra tool registry |
| **Wrap Workflow** | `src/mastra/wrap-workflow.ts` | Lifecycle hooks: start, activity, complete | ✅ Yes—Mastra workflow model |
| **Event Metadata** | `src/mastra/event-metadata.ts` | Mastra-specific event serialization | ✅ Yes—Mastra event shape |
| **A2A Peer** | `src/mastra/a2a-peer.ts` | Mastra agent-to-agent signaling | ✅ Yes—Mastra feature |
| **Activity Runtime** | `src/governance/activity-runtime.ts` | Governed activity execution; approval logic | ⚠️ Mixed—shared algo, Mastra-specific error classes |
| **OTel Setup** | `src/otel/setup-openbox-opentelemetry.ts` | Mastra + OTel tracer provider patching | ✅ Yes—Mastra instrumentation |
| **Span Processor** | `src/span/openbox-span-processor.ts` | OpenBox-specific span buffering & verdict capture | ⚠️ Mixed—reusable logic, Mastra-native field mapping |

---

### B.3 Config Divergence Alert

**Mastra's `OpenBoxConfigInput`** includes:
- `multiAgent` / `multiAgentSessionId` (lines 51-52 in mastra's config)

**Copilotkit's `OpenBoxConfigInput`** omits this entirely.

**Impact:** Base SDK should include multi-agent config (generic), but Mastra's specific resolver will live in `src/mastra/`. Base SDK exports the type, Mastra SDK provides the integration.

---

### B.4 Public API Surface to Preserve

**Exports from mastra's `src/index.ts`** (all 8 modules re-exported):
```typescript
export * from "./client/index.js";           // OpenBoxClient, OpenBoxClientOptions, ApprovalPollRequest/Response
export * from "./config/index.js";           // OpenBoxConfig, OpenBoxConfigInput, parseOpenBoxConfig, setOpenBoxConfig
export * from "./governance/index.js";       // (deprecated: activity runtime exports)
export * from "./identity/index.js";         // AgentIdentity headers, functions
export * from "./mastra/index.js";           // withOpenBox, wrap{Agent,Tool,Workflow}
export * from "./otel/index.js";             // setupOpenBoxOpenTelemetry, OpenBoxTelemetryController
export * from "./span/index.js";             // OpenBoxSpanProcessor
export * from "./types/index.js";            // Verdict, GovernanceVerdictResponse, errors
```

**What base SDK exports** (no `./mastra/`, no `./otel/`):
```typescript
export * from "./client/index.js";
export * from "./config/index.js";
export * from "./governance/index.js";       // Only shared types/registry
export * from "./identity/index.js";
export * from "./types/index.js";
```

---

### B.5 Mastra-Specific Error Classes (Must Re-verify)

Mastra SDK uses custom errors that encode approval/governance behavior:
- `ApprovalPendingError` (`src/types/errors.ts:line ~30`)
- `ApprovalExpiredError` (`src/types/errors.ts:line ~40`)
- `ApprovalRejectedError` (`src/types/errors.ts:line ~50`)
- `GovernanceHaltError` (`src/types/errors.ts:line ~60`)
- `GuardrailsValidationError` (`src/types/errors.ts:line ~70`)

**⚠️ Re-verify against Python/Core:** These errors encode BEHAVIOR (e.g., fail_open vs fail_closed, retry semantics). Check Python SDK's error definitions to ensure Mastra's error class hierarchy doesn't diverge from the true governance model.

---

### B.6 Test Fixture & Contract Structure

**Mastra's test layout** (`openbox-mastra-sdk:test/`):
```
test/
├── unit/               # Isolated unit tests
│   ├── errors.test.ts
│   ├── agent-identity.test.ts
│   ├── config.test.ts
│   ├── otel-setup.test.ts
│   └── span-processor.test.ts
├── contract/           # API contract tests (mocked OpenBox server)
│   ├── openbox-client.test.ts
│   └── wrap-tool.test.ts
├── integration/        # Full Mastra + OpenBox integration tests
│   ├── with-openbox.test.ts
│   ├── wrap-agent.test.ts
│   └── wrap-workflow.test.ts
├── privacy/            # Privacy/PII redaction tests
│   └── otel-privacy.test.ts
└── helpers/
    └── openbox-server.ts  # Mock OpenBox API server
```

**Action:** Base SDK tests should mirror `unit/` + `contract/` structure; framework-specific integration tests live in framework SDKs.

---

### B.7 Node Instrumentation / OTel Strategy

**Mastra's OTel integration** (`src/otel/setup-openbox-opentelemetry.ts`):
1. Creates `NodeTracerProvider` (OTel SDK native)
2. Dynamically loads DB + HTTP instrumentations based on config flags
3. Registers custom `OpenBoxSpanProcessor` as trace processor
4. Patches Node's `require()` to inject traced modules

**Framework-SDK specific:** The setup function patches Mastra workflows/agents/tools to emit spans. **Base SDK exports reusable `OpenBoxSpanProcessor` only; OTel setup lives in framework SDKs.**

---

## Part C: Recommended Canonical Tooling Source

**Winner: mastra SDK**
- Modern: ES2023, ESNext, node24
- Complete: tsup, eslint (flat config), prettier, vitest with coverage
- CI: PR quality workflow w/ codecov + SonarQube

**Secondary check (copilotkit):** Validates tooling (identical copies). ✅

**Ignore (cloudflare):** Old baseline (tsc-only, ES2022).

---

## Part D: Surfaces Requiring Re-Verification vs Python/Core

Before extracting to base SDK, **verify these against the Python SDK** to ensure governance semantics are correct:

1. **Error Behavior**: `ApprovalPendingError`, `ApprovalExpiredError`, `GovernanceHaltError`
   - Confirm retry/fail_open/fail_closed logic matches Python SDK
   - Check if error recovery timing is consistent

2. **Verdict Priority & Application**: `Verdict.highestPriority()`, `Verdict.shouldStop()`
   - Ensure priority hierarchy (ALLOW < CONSTRAIN < REQUIRE_APPROVAL < BLOCK < HALT) is canonical
   - Verify "stop" verdict maps to HALT correctly

3. **Config Defaults**: `evaluateMaxRetries: 2`, `governanceTimeout: 30s`, `maxEvaluatePayloadBytes: 256_000`
   - Check if these match Python SDK defaults
   - Confirm network/timeout behavior in fail_open mode

4. **MultiAgent Session ID Resolver**: Mastra-specific logic but uses generic config
   - Verify session ID calculation doesn't encode Mastra-specific assumptions

5. **Approval Poll Response Shape**: `approval_expiration_time`, `expired` field interpretation
   - Ensure wire format matches API spec exactly (not Mastra-specific encoding)

---

## Part E: Unresolved Questions

1. **OTel SDK vs Custom Patching**: Should base SDK bundle `@opentelemetry/sdk-node` or let framework SDKs decide? (Mastra bundles it; copilotkit may not.)

2. **Span Buffer Lifecycle**: `OpenBoxSpanProcessor`'s internal buffers — is the current buffering strategy (in-memory, flushed on verdict) correct for all frameworks, or does it need framework-specific tweaks?

3. **Approval Registry Thread Safety**: Current implementation uses `Map<string, T>` for approval state. Is this safe for concurrent Mastra workers, or does it need distributed state?

4. **PII Redaction Logic**: Mastra's guardrails redaction happens in `activity-runtime.ts` (normalize redacted input). Should this logic move to base SDK, or stay framework-specific?

5. **HTTP Capture Default**: Config has `httpCapture: boolean` (default `true`). Does this apply uniformly to all frameworks (Copilotkit's HTTP model may differ from Mastra's)?

---

## Summary

**TS SDK Tooling (Canonical):**
- Use mastra's `package.json` (framework-agnostic deps), `tsup.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js` (simplified), `prettier.json`
- Node ≥24.10.0, ES2023, ESM, tsup, vitest, eslint flat config

**Base SDK Exports (8 modules):**
```
client, config, governance/approval-registry, governance/context, identity, types
(omit: mastra, otel, span)
```

**Shared Surfaces to Extract:**
- Verdict, GovernanceVerdictResponse, Guardrails, Errors, WorkflowEventType (types)
- OpenBoxClient, OpenBoxConfig, AgentIdentity (implementations)
- ApprovalRegistry, ExecutionContext (in-memory governance state)

**Mastra-Specific (Stays):**
- Wrappers: `with-openbox`, `wrap-{agent,tool,workflow}`, `event-metadata`, `a2a-peer`
- Instrumentation: `otel/setup-openbox-opentelemetry.ts`, `span/openbox-span-processor.ts`, `governance/activity-runtime.ts` (Mastra-flavored)

**Re-verify vs Python/Core:**
- Error class retry/fail semantics
- Verdict priority & application logic
- Config defaults (retries, timeout, payload size)
- Approval response wire format
- Guardrails redaction strategy

---

**Report Status: DONE**

All TS SDK tooling extracted, migration surfaces inventoried, divergences noted, re-verification points flagged.
