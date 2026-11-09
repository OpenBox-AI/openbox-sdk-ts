/**
 * The end user an agent is acting for.
 *
 * OpenBox information barriers check every principal behind an action: the
 * agent and the person it acts on behalf of. Run a request inside
 * `withOnBehalfOf` and every governance event sent in that async call chain
 * carries `on_behalf_of: { user, source }`:
 *
 * ```ts
 * import { withOnBehalfOf } from "@openbox-ai/openbox-sdk-ts/context";
 *
 * await withOnBehalfOf("amy@firm.example", () => graph.invoke(input));
 * ```
 *
 * The value must be the user's directory identity (email or IdP subject) as it
 * appears in the organisation's barrier memberships. It can only narrow what
 * an agent may touch.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "../contracts/results.js";

export interface OnBehalfOf {
  readonly user: string;
  readonly source: string;
}

const DEFAULT_SOURCE = "sdk";

const storage = new AsyncLocalStorage<OnBehalfOf | null>();

/** Runs `fn` with `user` as the on-behalf-of principal. An empty user clears it. */
export function withOnBehalfOf<T>(user: string | null | undefined, fn: () => T, source = DEFAULT_SOURCE): T {
  const value = (user ?? "").trim();
  return storage.run(value ? { user: value, source } : null, fn);
}

/** The on-behalf-of principal for the current async call chain, if any. */
export function currentOnBehalfOf(): OnBehalfOf | undefined {
  return storage.getStore() ?? undefined;
}

/**
 * Adds the current on-behalf-of to an evaluate payload. A value the caller
 * already put on the payload wins; non-object payloads pass through.
 */
export function applyOnBehalfOf(payload: JsonValue): JsonValue {
  const current = currentOnBehalfOf();
  if (!current || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload;
  if (record["on_behalf_of"]) return payload;
  return { ...record, on_behalf_of: { user: current.user, source: current.source } };
}
