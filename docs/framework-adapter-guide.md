# Framework Adapter Guide

How to build a framework adapter (Mastra-style, or your own) on top of
`@openbox-ai/openbox-sdk-ts`. An adapter's job is to map the base SDK's verdicts
onto your framework's native lifecycle (throwing framework-native errors,
pausing a workflow, resuming after approval, ...) — it should never
reimplement signing, validation, or verdict priority itself.

## Fail-closed-on-auth must be enforced at the adapter wrapper layer

**Read this section before writing any adapter code.** This is the single
most important lesson from building the first (Mastra) adapter on this SDK,
and it is easy to silently reintroduce.

`OpenBoxClient` (`@openbox-ai/openbox-sdk-ts/client`) already does the right
thing: an auth/signing rejection (HTTP 401/403) THROWS
(`OpenBoxAuthError`/`OpenBoxSigningError`) — it never fails open into an
ALLOW, regardless of the configured `onApiError` policy. Network/outage
failures (unreachable Core, 5xx, timeouts) are the only condition
`onApiError: "fail_open"` applies to.

That guarantee is worthless if your adapter's evaluate wrapper swallows it.
This pattern **defeats the client's fix and silently disables governance**:

```ts
// DO NOT DO THIS — re-opens the fail-closed-on-auth hole the client just closed.
async function evaluateAndGate(payload: JsonValue) {
  try {
    const result = await client.evaluate(payload);
    if (result.verdict === "block" || result.verdict === "halt") {
      throw new MyFrameworkGovernanceError(result);
    }
  } catch {
    return; // "fail open" on error — but this also swallows OpenBoxAuthError!
  }
}
```

Under a persistent auth failure — a revoked API key, a signing-key rotation
that didn't propagate, clock skew pushing signatures outside Core's replay
window — this wrapper now runs **every** governed operation ungoverned and
skips `REQUIRE_APPROVAL` entirely, silently, for as long as the auth failure
persists. That is exactly the fleet-wide silent-bypass failure mode the base
client was built to prevent, reintroduced one layer up.

**The rule:** at the pre-operation gating boundary (STARTED / preflight /
before-resume — anywhere a verdict decides whether the real operation runs),
your wrapper's `catch` must **rethrow** fail-closed conditions and may fail
open **only** for a genuine network/outage error:

- Rethrow (fail closed) — `OpenBoxAuthError` (this also covers its
  `OpenBoxSigningError` subclass), `GovernanceAPIError`, `ContractError`.
- May fail open under `onApiError: "fail_open"` — `OpenBoxNetworkError` only.

```ts
import { ContractError, GovernanceAPIError, OpenBoxAuthError } from "@openbox-ai/openbox-sdk-ts";

function isFailClosedCondition(error: unknown): boolean {
  return (
    error instanceof ContractError ||
    error instanceof GovernanceAPIError ||
    error instanceof OpenBoxAuthError // covers OpenBoxSigningError too
  );
}
```

The COMPLETED / post-operation path is different: the real operation already
ran, so a completed-hook evaluation failure there is telemetry-only and may be
logged and swallowed (it can only affect FUTURE execution, never undo work
that already happened).

**The easiest way to get this right: don't wire `OpenBoxClient` directly.**
Drive the base `OpenBoxRuntime` instead — `runtime.evaluateLifecycle`,
`runtime.preflight`, and `runtime.completed` already implement this rule (the
internal hook evaluator fails closed with a synthetic HALT via
`adapter.raiseHookBlocked` on exactly this error set). An adapter that
delegates to `OpenBoxRuntime` gets this behavior for free; an adapter that
re-implements its own evaluate wrapper around the raw client has to get it
right by hand — a review of the first (Mastra) adapter found
`try { ... } catch { return ALLOW }` as a real, shipped instance of this bug,
not a theoretical one.

## Building an adapter

1. **Resolve config once.**

   ```ts
   import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";

   // Resolves MYFRAMEWORK_API_URL / MYFRAMEWORK_API_KEY (falling back to
   // OPENBOX_API_URL / OPENBOX_API_KEY when unset or blank) from the environment.
   const config = OpenBoxConfig.resolve({ envPrefix: "MYFRAMEWORK" });
   ```

2. **Implement `FrameworkAdapter`** (`@openbox-ai/openbox-sdk-ts/adapters`) — the
   one seam where a verdict becomes a framework-native effect:

   ```ts
   import type { FrameworkAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
   import type { EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

   class MyFrameworkAdapter implements FrameworkAdapter {
     readonly name = "my-framework";

     async handleApproval(result: EvaluationResult): Promise<void> {
       // Drive your framework's HITL UX; resolve on approve, reject/throw on
       // reject or expiry. Called BEFORE the real operation runs. Consider
       // building this on `ApprovalPoller` (`@openbox-ai/openbox-sdk-ts/approvals`)
       // rather than hand-rolling a poll loop.
     }

     raiseLifecycleBlocked(result: EvaluationResult): never {
       throw new MyFrameworkGovernanceError(result.verdict, result.reason);
     }

     raiseHookBlocked(result: EvaluationResult): never {
       throw new MyFrameworkGovernanceError(result.verdict, result.reason);
     }

     onCompletedHookResult(result: EvaluationResult): void {
       // Telemetry only — the operation already ran. Mark future work if the
       // verdict stops it; never try to undo what already happened.
     }
   }
   ```

   Reuse the default `CoreAdapter` (`@openbox-ai/openbox-sdk-ts/adapters`) if you
   don't need framework-native error types yet — it raises the base
   `GovernanceBlockedError`/`GovernanceHaltError`/`ApprovalRejectedError`
   directly and fails safe (REJECTED, not silently allowed) when no
   `ApprovalPoller` is configured.

3. **Construct one `OpenBoxRuntime` and drive everything through it.**

   ```ts
   import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

   const runtime = new OpenBoxRuntime(config, { adapter: new MyFrameworkAdapter() });
   ```

   - Lifecycle events (workflow/activity/signal/handoff) — build them with the
     event factories from the package root (`workflowStarted`,
     `activityCompleted`, `handoff`, ...) and call
     `runtime.evaluateLifecycle(event)`. BLOCK/HALT throw; REQUIRE_APPROVAL
     awaits `adapter.handleApproval`.
   - Hook (span-bearing) events — call `runtime.preflight({ spans })` BEFORE
     the real operation and `runtime.completed({ spans })` AFTER, from inside
     a bound activity scope (next step). A `null` return means the hook was
     skipped (preflight disabled, or no bound activity) — not an error.

4. **Bind the `ActivityContext` for the duration of the governed operation**
   using `runtime.contextStore.activityScope` — hook evaluation resolves the
   current activity from this binding (`AsyncLocalStorage`, with a bounded
   trace-id map fallback for detached callbacks):

   ```ts
   import { ActivityContext } from "@openbox-ai/openbox-sdk-ts";

   await runtime.contextStore.activityScope(
     new ActivityContext({ workflowId, runId, activityId, activityType }),
     async () => {
       await runtime.preflight({ spans: [mySpan] });
       const output = await theRealOperation();
       await runtime.completed({ spans: [mySpan] });
       return output;
     }
   );
   ```

5. **Optionally opt into Node instrumentation** instead of hand-building spans
   for `fetch`/`fs`/DB calls — see the README's instrumentation example and
   [`instrumentation-coverage.md`](instrumentation-coverage.md) for exactly
   what gets blocked per target.

6. **Close the runtime** (`runtime.close()`) on shutdown to clear correlation
   state and close its client (cached workload tokens, identity metadata, key
   references) — an injected client too, so consumers sharing one client must
   coordinate shutdown. If you also called `initOpenBoxInstrumentation`, call
   its `shutdown()` too (restores the patched globals).

If your adapter builds its own client (e.g. to wire an `ApprovalPoller` before
the runtime exists), build it with `OpenBoxClient.fromConfig(config, { fetchImpl })`
rather than assembling identity options by hand: it maps every identity mode —
DID, Okta (explicit or bootstrap), Keycloak workload (IAM v3), or unsigned — to
exactly one client configuration, carries your SDK branding from the config, and
re-validates identity exclusivity even when the config was resolved with
`validate: false`. Forward framework options such as `workloadPrivateKey` into
`OpenBoxConfig.resolve` with your `envPrefix`; never mint tokens or assertions in
the adapter.

## What not to do

- Don't call `OpenBoxClient.evaluate()` directly and interpret the verdict
  yourself in application/adapter code — you will eventually reimplement (and
  risk getting wrong) verdict priority, guardrails-failure precedence, and the
  fail-closed-on-auth rule above. Use `OpenBoxRuntime`.
- Don't add a `mode` / `sanitize` / `observe-only` toggle around the
  validation gate. It is deliberately always-strict; contract violations must
  raise before any network send, regardless of the fail-open/fail-closed
  network policy.
- Don't treat privacy redaction as optional polish applied after the fact —
  it runs BEFORE signing. Anything redacted after signing is either already
  sent unredacted or invalidates the signature.
- Don't assume OpenTelemetry can block anything. Spans are for completed
  telemetry; preflight blocking in this SDK is always a custom wrapper around
  the driver call, never an OTel hook.

## See also

- [`adapter-checklist.md`](adapter-checklist.md) — a broader checklist for a
  brand-new TS SDK adopting this base (signing byte-parity, import-light
  root, the Core-parity gate, and more).
- [`instrumentation-coverage.md`](instrumentation-coverage.md) — Node
  instrumentation coverage and limitations per target.
- [`contract-conflict-ledger.md`](contract-conflict-ledger.md) — the open
  `on_api_error` fail-open-vs-fail-closed product decision referenced above.
