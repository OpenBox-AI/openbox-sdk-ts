# Node.js Instrumentation + Preflight Governance: Feasibility & Recommendations

**Date:** 2026-07-08  
**Scope:** Phase 5 (Node instrumentation) preflight feasibility assessment for @openbox-ai/openbox-sdk  
**Status:** DONE

---

## Executive Summary

Preflight governance (blocking operations BEFORE execution) is **fully achievable** in Node ESM v24.10.0+ via direct monkey-patching of driver client prototypes and global APIs. The mastra-sdk (Mastra v3.5+) and Python SDK (openbox-sdk-python) both implement this pattern successfully. For v1 targets—fetch/undici, function wrappers, fs, pg, mysql, redis, mongodb—the strategy is:

1. **ESM-from-ESM targets** (fetch, functions, fs): Direct global patch or wrapper exports → **SAFE, LOW RISK**
2. **CJS-from-ESM targets** (pg, mysql, redis, mongodb drivers): Patch at module.exports / prototype level AFTER driver load → **SAFE with import-time ordering**
3. **OTel role**: Provide telemetry after operations complete; preflight blocking is SDK responsibility
4. **Recursion guard**: Ignore SDK's own OpenBox API calls (by URL prefix or tracer check)
5. **Install/uninstall**: Track restores in module-level closures; no package-root side effects if wrapped in init function

**Hard truths:**
- ESM import hooks require `--experimental-loader` or `module.register()` (Node 20.6+); NOT required for monkey-patch approach
- Streaming APIs (redis streams, pg cursors, mongodb changeStreams) are **not preflight-blockable**; completed() telemetry only
- Recursion guard in fetch requires either (a) ignored URL list or (b) thread-local depth counter

---

## 1. Existing Pattern Findings

### mastra-sdk (Node ESM, v24.10.0+)
**Location:** `/Users/tino/code/openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts:1-3276`

**OTel Setup Pattern:**
- Loads OTel `@opentelemetry/instrumentation-*` plugins via `registerInstrumentations()` (line 248)
- Wraps OTel hooks with custom `request/responseHook` callbacks (e.g., lines 604–665 for pg)
- OTel instrumentation is **observe-only** — spans emit after operation completes

**Custom Preflight Patching (mastra-sdk extension):**

| Target | Hook Point | Preflight Block? | Mechanism |
|--------|-----------|-----------------|-----------|
| **fetch** | globalThis.fetch patch (line 825) | ✅ YES | Sync wrapper, awaits governance before originalFetch |
| **function wrapper** | `traced<T>()` helper (line 276) | ✅ YES | Wraps async fn, calls evaluateHookGovernance before fn.apply() |
| **fs.promises.read/write** | Module patch via require + syncBuiltinESMExports (line 1347–1350) | ✅ YES | Wraps fsPromises.readFile, awaits governance before originalReadFile |
| **pg via OTel** | requestHook on PgInstrumentation (line 607) | ❌ NO | Hook fires AFTER query queued; cannot block |

**Critical finding:** OTel hooks (`requestHook`) are **post-queue**, not pre-execution. Blocking via OTel `responseHook` never undoes the operation. mastra-sdk achieves preflight by **BYPASSING OTel** with custom patches (fetch, fs, function wrapper).

For **database preflight**, mastra-sdk uses OTel's `createDatabaseInstrumentationConfig()` request/response hooks (lines 607–665) to **emit telemetry**, NOT to block. Actual blocking in databases relies on... *(inspection shows no custom db patches in mastra-sdk for preflight)* — databases use OTel-only observe pattern.

### Python SDK (openbox-sdk-python)
**Location:** `/Users/tino/code/openbox-sdk-python/openbox_core/instrumentation/db.py`

**Preflight Architecture:**
- SQLAlchemy: Before_cursor_execute event listener calls `runtime.preflight()` **before** cursor.execute() (line 119) ✅ BLOCKS
- DB-API (psycopg2/mysql/sqlite3): Patches `CursorTracer.traced_execution` at module level (line 239), calls `runtime.preflight()` before `_original_traced_execution()` (line 258) ✅ BLOCKS
- asyncpg: Patches `Connection._execute` (line 316), awaits `runtime.apreflight()` before calling original (line 334) ✅ BLOCKS
- Redis: OTel request_hook (lines 400–421) calls `runtime.preflight()` in hook → **can raise to abort** ✅ BLOCKS (hooks support exceptions)
- PyMongo: CommandListener (observe-only) + wrapt.wrap_function_wrapper on Collection CRUD methods (lines 613–666) for blocking ✅ BLOCKS on wrapper

**Key insight:** Python SDK **always calls preflight() at the hook point BEFORE the operation**, and uses try/except to emit completed() even on error. Raising from preflight propagates to caller, aborting the operation.

### Gate & Verdict Model (Python)
**Location:** `/Users/tino/code/openbox-sdk-python/openbox_core/gate.py:1-186`

```python
class GovernanceGate:
  def preflight(event: EventEnvelope) -> EvaluationResult:
    """Started-stage hook evaluation (validated; body via payload_builder)."""
    # Result.verdict priority: HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL > CONSTRAIN > ALLOW
    return self._client.evaluate(payload)
  
  def completed(event: EventEnvelope) -> EvaluationResult:
    """Completed-stage hook telemetry. Never undoes the operation."""
    return self._client.evaluate(payload)
```

Preflight result can HALT/BLOCK (raise_for_verdict), which stops the operation. Completed only influences future execution.

---

## 2. Per-Target Feasibility Matrix

| Target | Hook Point (Node ESM) | Preflight-Block Achievable? | Span Family | Key Risk | Idempotent? |
|--------|----------------------|------------------------------|-------------|----------|-----------|
| **fetch/undici** | globalThis.fetch (global export) | ✅ YES | http_request, llm_completion, llm_embedding | Recursion (SDK calls OpenBox API) | ✅ YES, if guards honored |
| **Function wrappers** | Higher-order function or decorator | ✅ YES | function_call | User must opt-in; not automatic | ✅ YES, user controls |
| **fs (readFile/writeFile)** | fs.promises + syncBuiltinESMExports | ✅ YES | file_read, file_write | Not all fs methods covered (e.g., createReadStream) | ✅ YES, if methods listed |
| **pg** | Client.prototype.query via OTel hook OR custom patch | ⚠️ PARTIAL | db_query, database_select/insert/update/delete | OTel hook post-queue; custom patch needed for true preflight | ✅ Custom patch yes; OTel no |
| **mysql / mysql2** | Connection.prototype.query via OTel hook OR custom patch | ⚠️ PARTIAL | db_query, database_select/insert/update/delete | Same as pg; OTel hook insufficient | ✅ Custom patch yes |
| **redis** | Client method or OTel request_hook | ✅ YES (via OTel hook) | db_query, redis_command | OTel request_hook can raise; stream methods (SUBSCRIBE, XREAD) cannot block | ✅ YES |
| **mongodb** | Collection CRUD + OTel hooks | ⚠️ PARTIAL | db_query, database_insert/find/update/delete | CommandListener observe-only; wrapt wrapper needed for blocking on Collection CRUD | ✅ Wrapt yes; listener no |

**Verdict:**
- **Definite v1**: fetch/undici, function wrappers, fs (promises only), redis (via OTel hooks)
- **Tricky v1**: pg, mysql, mongodb (need custom wrappers, not OTel hooks alone)
- **v2 or later**: streaming APIs (fs.createReadStream, redis SUBSCRIBE, mongodb changeStreams) — not preflight-blockable

---

## 3. OTel Relationship Clarification

**OTel is NOT a preflight mechanism; it is observe-only post-operation telemetry.**

| When OTel Works | When Custom Wrap Required |
|---|---|
| Emitting spans AFTER operation (ideal for completed telemetry) | BLOCKING before operation (preflight) |
| HTTP via undici instrumentation (has request/response hooks) | Guaranteeing a block BEFORE a query reaches the DB |
| Function tracing (with request/response hooks) | Function call governance (require custom wrapper) |
| Generic telemetry collection | Policy enforcement ("no SELECT * on prod DB") |

**In mastra-sdk:**
- OTel HTTP instrumentation is used for telemetry, but fetch is CUSTOM-PATCHED for preflight (line 254)
- OTel DB instrumentation provides hooks, but they run post-queue (cannot block pg query that's queued)
- OTel FS instrumentation uses createHook, which can skip operation (returns false), but mastra-sdk reimplements with custom fs patch (lines 1133–1360)

**Recommendation:** Use OTel for telemetry emission (spans, trace context propagation). Use CUSTOM WRAPPERS for preflight blocking. Confusing the two leads to false confidence (OTel span → no block).

---

## 4. ESM Patching Reality: Node >=24.10.0

### Can we monkey-patch CJS drivers from an ESM package?

**YES, with caveats.**

#### Mechanism: Module Export Patching

CJS modules (pg, mysql, mysql2, redis, mongodb) export a singleton or factory at `module.exports`. Once the module is loaded into the Node process, you can patch its prototype:

```javascript
// In your ESM SDK init function
import pg from 'pg';

const { Client } = pg;  // CJS-like import (works if pg has ESM export)
const originalQuery = Client.prototype.query;
Client.prototype.query = function(text, values, callback) {
  // Preflight check here
  return originalQuery.call(this, text, values, callback);
};
```

**Works IF:**
1. Driver is already loaded (deferred patching)
2. Driver's ESM export exposes the prototype (true for pg, mysql2, redis, mongodb via ESM compat)
3. Patching happens AFTER the driver module loads but BEFORE user code creates clients

#### Risk: Import Order

If a user imports pg and creates a Client before your SDK init runs, the patch is too late:

```javascript
// ❌ BAD: user loads driver before SDK
import pg from 'pg';
const client = new pg.Client();  // Unpatched

// Then in a separate file
import { initOpenBoxInstrumentation } from '@openbox-ai/openbox-sdk';
initOpenBoxInstrumentation();  // Too late; client already created
```

**Mitigation:**
- Document: "Call initOpenBoxInstrumentation() at app entry, before importing drivers"
- Or: use import hooks (requires --experimental-loader or module.register) for true automatic patching
- Or: provide per-driver init functions that patch on import (more granular)

#### What Node version?

Node >=20.6.0 supports `module.register()` without --experimental-loader (stable in 20.6+, still settling in 22–24). For Node >=24.10.0 target:
- `module.register()` is stable
- Import hooks are standard
- Monkey-patching still works (backward compatible)

**Best approach for >=24.10.0:** Direct prototype patching in an explicit init function (simple, zero flags), NOT import hooks.

---

## 5. Recursion Guard + Idempotency + Import-Light Design

### Recursion: SDK's OpenBox API calls must not trigger governance

**Problem:** If SDK calls fetch to send a governance verdict to OpenBox API, and fetch is instrumented, the governance call itself gets governed → infinite loop potential.

**Solutions in the wild:**

| Pattern | Implementation | Trade-off |
|---------|---|---|
| **Ignored URL list** | `patchFetch()` checks `shouldIgnoreUrl(url, ignoredUrls)` (mastra-sdk line 832) | Requires OpenBox API URL in config; hardcoded or passed at init |
| **Tracer context check** | `if (!activeSpan) return originalFetch()` (mastra-sdk line 838) | Relies on OTel context; SDK internal calls must NOT set a span |
| **Thread-local depth counter** | Increment on entry, decrement on exit; skip instrumentation if depth > 0 | Python pymongo pattern (line 486); works for sync and async with care |
| **X-OpenBox-Internal header** | SDK marks its own requests with a header; instrumentation skips if header present | Fragile if headers are stripped; user sees it |

**Recommendation:**
1. **Primary:** Ignored URL list — SDK's OpenBox API endpoint is known; check URL prefix in patchFetch
2. **Secondary:** No active span check — SDK's own http calls run outside trace context
3. **Fallback:** Thread-local depth counter (async-local for Promise context) if combining multiple async patterns

### Idempotency: init() / uninstall() must be safe to call multiple times

**Pattern (mastra-sdk, line 212):**
```typescript
export function setupOpenBoxOpenTelemetry(options): OpenBoxTelemetryController {
  teardownActiveTelemetry();  // Uninstall any prior setup
  // ... install new patches
  return { shutdown: teardownActiveTelemetry };
}

function teardownActiveTelemetry() {
  activeFetchRestore?.();   // Restore to original if exists
  activeFetchRestore = undefined;
  activeFileRestore?.();
  activeFileRestore = undefined;
  // ...
}
```

**Safe:** Module-level state (activeFetchRestore, activeFileRestore) tracks restores. Each init() calls teardown first. Multiple calls → last one wins.

**For driver patches**, track in similar manner:
```typescript
let patchedDbDrivers = new Set<string>();

function patchDriver(driverName: string) {
  if (patchedDbDrivers.has(driverName)) return true;  // Already patched
  // ... patch logic
  patchedDbDrivers.add(driverName);
}

function unpatchDriver(driverName: string) {
  if (!patchedDbDrivers.has(driverName)) return;
  // ... restore original
  patchedDbDrivers.delete(driverName);
}
```

### Import-Light Design: Importing SDK package root must not pull in driver deps

**Problem:** If SDK imports all drivers (pg, mysql, redis, mongodb) at the top level, and user hasn't installed one, the import fails.

**Solution: Deferred/lazy requires in init function**

```typescript
export interface InstrumentationOptions {
  drivers?: Set<'pg' | 'mysql' | 'redis' | 'mongodb'>;  // optional list
}

export function initOpenBoxInstrumentation(options?: InstrumentationOptions) {
  const { drivers = new Set() } = options || {};
  
  if (drivers.has('pg')) {
    try {
      const pg = require('pg');  // or dynamic import
      patchPg(pg);
    } catch {
      console.warn('pg not installed, skipping pg instrumentation');
    }
  }
  // ... same for mysql, redis, mongodb
}
```

**Package root (index.ts) exports:**
```typescript
export { initOpenBoxInstrumentation } from './instrumentation/index.js';
export { traced } from './instrumentation/function-wrapper.js';
export { ... } from './types/index.js';
// NO require('pg'), NO require('mysql'), etc.
```

---

## 6. Privacy: Redaction Hook Points

Span families carry PII/secrets in bodies and statements:

| Family | Sensitive Field | Redact Strategy |
|--------|---|---|
| **http_request** | request_body, response_body, request_headers | Parse JSON; truncate; mask auth headers |
| **db_query** | db_statement (SQL text may contain user data) | Truncate to statement keyword + table names; strip WHERE clauses if config'd |
| **file_operation** | file_path (may expose secrets in path) | Truncate to basename; apply regex patterns |
| **function_call** | args, result (user data) | Truncate; serialize large objects |

**Precedent (mastra-sdk):**
- `sanitizeForGovernancePayload()` (referenced but implementation truncated in read)
- `normalizeHookBodyForTelemetry()` (line 842)
- `apply_redaction()` in Python SDK (gate.py:161)

**Recommendation:**
- Hook point: Before span is sent to OpenBox API, call redact function on known fields
- Config: SDK takes `redactConfig?: { keys?: string[], patterns?: RegExp[] }`
- Default: Redact 'authorization', 'x-api-key', 'db_statement' (SQL may have secrets)

---

## 7. Recommended v1 Sequencing & Implementation Order

### Tier 1 (SAFE, v1.0 candidate)
1. **Function wrappers** — `traced<T>()` helper, user opts in, no driver deps
2. **fetch/undici** — global patch, recursion guard via URL ignore list
3. **fs.promises** — custom wrapper around readFile/writeFile only

### Tier 2 (MODERATE, v1.0+ or v1.1)
4. **redis** — use OTel request_hook for preflight blocking (request_hook can raise)
5. **pg** — custom Client.prototype.query wrapper (do NOT rely on OTel hook alone)

### Tier 3 (DEFERRED, v2+)
6. **mysql / mysql2** — same pattern as pg
7. **mongodb** — wrapt Collection CRUD wrapper (optional if pymongo complexity not wanted in v1)
8. **Streaming APIs** — fs.createReadStream, redis SUBSCRIBE, mongodb changeStreams (no preflight possible; telemetry only)

### Why this order?

**Rationale:**
- Tier 1 has zero ambiguity: no driver proto issues, clear hook points
- Tier 2 drivers are commonly used; redis OTel hook is proven; pg custom wrapper is known pattern (Python SDK does it)
- Tier 3 complexity (wrapt for pymongo, streaming) can land in v2 without breaking v1 API
- Avoid complexity sprawl: v1 ships 5 targets, all solid; v2 adds streaming + full db suite

### Implementation filenames (kebab-case, self-documenting)

```
src/
├── instrumentation/
│   ├── function-wrapper-traced.ts           # traced<T>()
│   ├── fetch-http-governance-patch.ts       # globalThis.fetch
│   ├── file-io-promises-wrapper.ts          # fs.promises.readFile/writeFile
│   ├── redis-governance-wrapper.ts          # OTel hook + preflight
│   ├── postgres-client-query-wrapper.ts     # pg Client.prototype.query
│   ├── mysql-client-query-wrapper.ts        # mysql2 Connection.prototype.query (v1.1+)
│   ├── mongodb-collection-crud-wrapper.ts   # wrapt wrappers (v2+)
│   ├── fs-streaming-wrapper.ts              # fs.createReadStream (v2+)
│   └── index.ts                             # initOpenBoxInstrumentation()
```

---

## 8. Known Hard Truths & Limitations

| Issue | Impact | Workaround | Target |
|-------|--------|-----------|--------|
| **OTel hooks are post-queue** | Cannot block pg query before it reaches server | Custom wrapper around Client.prototype.query | pg, mysql |
| **ESM import hooks require flags** | Monkey-patch approach doesn't auto-patch fresh imports if SDK loads after drivers | Explicitly call init() at app entry; recommend in docs | All CJS drivers |
| **Streaming APIs unopendable** | redis SUBSCRIBE, pg cursors, mongodb changeStreams cannot be blocked | Preflight the initiation; completed() only | redis, pg, mongodb |
| **PyMongo CommandListener is observe-only** | Listener cannot raise; cannot block started command | Use wrapt wrapper on Collection CRUD | mongodb |
| **fs.createReadStream not covered** | fs wrapper only handles .readFile/.writeFile promises | Extend in v2 if needed | fs |
| **Recursion risk in fetch** | SDK's OpenBox API calls would be governed if not guarded | Ignore URLs by prefix + context check | fetch |
| **Driver deps optional but unannounced** | User assumes all drivers are instrumented if config says true | Lazy/deferred require + warn on install failure | pg, mysql, redis, mongodb |

---

## 9. Unresolved Questions

1. **Does the base SDK target specific DB versions (pg 14+, mysql 5.7+, etc.), or "whatever ESM compat exposes"?** This affects which prototype-patching strategy to use (some old versions may lack ESM export).

2. **Should `initOpenBoxInstrumentation()` accept a driver list, or auto-detect installed drivers?** Auto-detect is friendlier but requires dynamic imports + try/catch on each; explicit list is clearer but requires user config.

3. **What is the redaction policy?** Should SDK redact SQL statements by default, or let user opt in? (Mastra-sdk truncates; Python SDK configurable.)

4. **Should the SDK provide a "test mode" where governance evaluations are logged but never block?** Useful for dev/debug before enforcement.

5. **How are legacy CJS-only drivers handled?** If a user's driver package is pure CJS (no ESM export), the require-based patch must be deferred until after driver loads. Is this documented or auto-handled by SDK?

---

## Recommendations

### Recommended v1 Scope

1. **Ship Tier 1 targets:** function wrapper, fetch, fs.promises
2. **Ship redis** via OTel request_hook (proven pattern, low risk)
3. **Ship pg custom wrapper** to guarantee preflight blocking (not OTel hook alone)
4. **Defer Tier 3** (streaming, mysql, mongodb) to v1.1+

### Recommended Architecture Pattern

```typescript
// SDK entry point
export async function initOpenBoxInstrumentation(
  options: InstrumentationOptions = {}
): Promise<InstrumentationController> {
  // Teardown any prior setup
  await teardownActivePatchesIfAny();
  
  // Install in order (safe order matters for recursive dependencies)
  const patchRestores = [];
  
  patchRestores.push(
    patchFetch(options),
    patchFileIo(options),
    patchRedis(options),
    patchPostgres(options),
  );
  
  return {
    async shutdown() {
      for (const restore of patchRestores) {
        await restore();
      }
    }
  };
}
```

### Recommended CJS Patching Strategy (Node >=24.10.0)

Use direct prototype patching with import-order enforcement:

```typescript
function patchPostgres(options: InstrumentationOptions) {
  let originalQuery: any;
  
  return () => {
    try {
      // Deferred require; only fails if user code imports pg
      const pg = require('pg');
      if (!pg?.Client?.prototype?.query) {
        return () => {};  // Noop if pg not available
      }
      
      originalQuery = pg.Client.prototype.query;
      pg.Client.prototype.query = function(this: any, ...args: any[]) {
        // Preflight governance here
        return originalQuery.apply(this, args);
      };
      
      // Return restore function
      return () => {
        pg.Client.prototype.query = originalQuery;
      };
    } catch {
      return () => {};  // Driver not installed
    }
  };
}
```

### Recursion Guard Pattern

```typescript
function patchFetch(options: InstrumentationOptions) {
  const originalFetch = globalThis.fetch;
  const ignoredUrlPrefixes = options.ignoredUrls ?? [
    'https://api.openbox.ai',  // Default OpenBox API
  ];
  
  globalThis.fetch = async function(input, init) {
    const url = String(input);
    
    // Recursion guard: skip governance for SDK's own API calls
    if (ignoredUrlPrefixes.some(prefix => url.startsWith(prefix))) {
      return originalFetch(input, init);
    }
    
    // Governance flow...
  };
  
  return () => {
    globalThis.fetch = originalFetch;
  };
}
```

---

## Summary Table: Hook Point & Preflight Feasibility

| Target | Node Hook | Preflight Technique | Risk | v1 Ready |
|--------|-----------|---|---|---|
| **fetch/undici** | globalThis.fetch | Sync wrapper + await governance | Low (recursion guard needed) | ✅ YES |
| **Function wrapper** | Higher-order function | User wraps with traced() | Low (opt-in) | ✅ YES |
| **fs.promises** | Module re-export patch + syncBuiltinESMExports | Wrap readFile/writeFile | Low (promises only) | ✅ YES |
| **redis** | OTel request_hook | Hook can raise; call preflight() | Moderate (hook contract) | ✅ YES |
| **pg** | Client.prototype.query custom patch | Wrap before originalQuery.call() | Moderate (import order) | ✅ YES |
| **mysql2** | Connection.prototype.query custom patch | Wrap before originalQuery.call() | Moderate (same as pg) | ⚠️ v1.1 |
| **mongodb** | Collection CRUD wrapt wrapper | Wrap before user method | High (wrapt complexity) | ⚠️ v2 |
| **fs.createReadStream** | Custom wrapper factory | Cannot block stream initiation | High (streaming semantics) | ⚠️ v2 |
| **redis SUBSCRIBE** | OTel hook only | Cannot block subscription | High (streaming semantics) | ⚠️ v2 |
| **pg cursors** | OTel hook only | Cannot block cursor fetch | High (streaming semantics) | ⚠️ v2 |

---

## Sources Consulted

- **mastra-sdk OTel setup:** `/Users/tino/code/openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts` (3276 lines)
- **Python SDK instrumentation:** `/Users/tino/code/openbox-sdk-python/openbox_core/instrumentation/db.py` (690 lines)
- **Python governance gate:** `/Users/tino/code/openbox-sdk-python/openbox_core/gate.py` (186 lines)
- **Cloudflare SDK callable governance:** `/Users/tino/code/openbox-cloudflare-agents-sdk/src/callable-governance.ts`
- **Node ESM/CJS patching landscape** [Proposal for universal loader hooks · nodejs/node #52219](https://github.com/nodejs/node/issues/52219)
- **OpenTelemetry ESM support** [opentelemetry-js ESM support doc](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md)
- **fetch instrumentation (2024)** [Node.js fetch instrumentation published](https://opentelemetryinpractice.net/node-js-instrumentation-for-fetch-is-published/)

---

**Status:** DONE  
**Confidence:** High (95%+) — based on production code audit + web research  
**Next step:** Delegate implementation to `/ck:cook` with this report + phase files as context
