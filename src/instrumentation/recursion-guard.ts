/**
 * Recursion / self-governance guard for Node operation instrumentation.
 *
 * LEAF MODULE — imports nothing but `node:async_hooks`. Every instrumentation
 * wrapper (fetch, fs.promises, future DB drivers) imports FROM here, and
 * `client/index.ts` imports FROM here too (to mark the SDK's own governance
 * calls). This file must never import FROM `runtime`/`instrumentation` — doing
 * so would create `client -> recursion-guard -> runtime -> client` (or
 * similar) cycles, since `client/index.ts` needs this module on its hot path.
 *
 * Two INDEPENDENT layers guard against the SDK governing its own traffic to
 * OpenBox Core (an unguarded self-governance loop would recurse until a stack
 * overflow, and a naive guard is a documented SSRF/exfiltration bypass — see
 * both docstrings below):
 *
 *  1. PRIMARY — `runAsInternal`/`isInternalCall`: an explicit AsyncLocalStorage
 *     boolean flag. The SDK's OWN governance HTTP calls (evaluate/approval/
 *     auth-validate — see `client/index.ts`) run wrapped in `runAsInternal`.
 *     A governed wrapper (e.g. the fetch patch) checks `isInternalCall()`
 *     FIRST and skips governance unconditionally when true. This is
 *     authoritative: it is correct even if the destination URL happens to
 *     collide with something else, and it covers non-HTTP internal work too.
 *
 *  2. SECONDARY — `isSameOrigin`: an EXACT `URL.origin` equality check, used
 *     as defense-in-depth for any call that reaches the configured api_url
 *     WITHOUT going through `runAsInternal` (e.g. a future code path that
 *     forgets the wrapper). This MUST be exact-origin equality, never a
 *     prefix/substring test: `url.startsWith(apiUrl)` is host-unanchored and
 *     lets `https://api.openbox.ai.evil.com` or `https://api.openbox.ai@evil.com`
 *     (userinfo trick — everything before `@` is credentials, not host) slip
 *     through as if they were the real origin. `URL.origin` normalizes
 *     scheme+host+port and ignores path/userinfo entirely, so both examples
 *     above resolve to an origin that does NOT equal the configured one.
 *
 * What this module deliberately does NOT provide: an "no active
 * span/context ⇒ skip" escape hatch. That pattern (used by at least one prior
 * Node implementation this SDK's instrumentation is informed by) is too broad
 * — a detached/background call with no bound governance context would skip
 * silently, which is indistinguishable from a legitimate exfiltration path
 * riding on top of "nothing is watching this request". Callers that find no
 * bound context must still route the call through the runtime (which already
 * skips per-hook when nothing is bound — see `HookEvaluator`) and separately
 * surface a diagnostic; they must never treat "no context" as a reason to
 * bypass this module's guards.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const internalCallStorage = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` (and its entire async continuation — every `await`/`.then` inside
 * it, however many ticks later) marked as an SDK-internal call. Any governed
 * wrapper invoked from within `fn`'s causal async chain must observe
 * `isInternalCall() === true` and skip governance unconditionally.
 */
export function runAsInternal<T>(fn: () => T): T {
  return internalCallStorage.run(true, fn);
}

/** True while executing inside `runAsInternal` (including nested awaits). */
export function isInternalCall(): boolean {
  return internalCallStorage.getStore() === true;
}

/**
 * Exact-origin equality between `candidateUrl` and `referenceUrl` (e.g. the
 * configured OpenBox `api_url`). `URL.origin` is `scheme://host:port` only —
 * no path, no userinfo, no query/fragment — so this is immune to the
 * `startsWith`/`includes` host-unanchoring bypasses described above.
 *
 * A malformed URL on EITHER side never matches (returns `false`): a parse
 * failure must never be treated as "safe to ignore" — that would fail OPEN on
 * the guard itself. Callers that need "is this URL ignorable" semantics treat
 * a `false` result as "not ignorable, run governance as normal", never as an
 * error.
 */
export function isSameOrigin(candidateUrl: string, referenceUrl: string): boolean {
  try {
    return new URL(candidateUrl).origin === new URL(referenceUrl).origin;
  } catch {
    return false;
  }
}
