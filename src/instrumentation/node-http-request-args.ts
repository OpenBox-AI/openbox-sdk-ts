/**
 * Pure argument interpretation for the node:http/node:https governance patch —
 * turning the several overloaded `http.request(...)` / `http.get(...)` call
 * shapes into the fields the patch needs (full URL, method, options, callback)
 * without any patching, governance, or I/O.
 *
 * `http.request` accepts `(options[, cb])`, `(url[, options][, cb])` with `url`
 * as `string | URL`; `get` has the same shapes. These helpers normalize all of
 * them and best-effort-reconstruct the full URL (for the span + same-origin /
 * internal recursion checks) from either the url argument or the options fields.
 */

import type { IncomingMessage } from "node:http";

import type { DeferredRequestMeta } from "./node-http-deferred-client-request.js";

export type HttpModuleName = "http" | "https";

export interface NormalizedRequest {
  /** Full request URL — for the span and the same-origin / internal guards. */
  readonly url: string;
  readonly method: string;
  /** The url string/URL argument if the caller passed one (else null). */
  readonly urlArg: string | URL | null;
  /** The options object the caller passed (or a synthesized empty one). */
  readonly options: Record<string, unknown>;
  /** The caller's response callback (last function arg), relayed via the stand-in. */
  readonly callback: ((res: IncomingMessage) => void) | undefined;
}

function computeUrl(protocol: HttpModuleName, urlArg: string | URL | null, options: Record<string, unknown>): string {
  try {
    if (urlArg instanceof URL) return urlArg.href;
    if (typeof urlArg === "string") return new URL(urlArg).href;
    const scheme = typeof options.protocol === "string" ? options.protocol : `${protocol}:`;
    const path = typeof options.path === "string" ? options.path : "/";
    const port = typeof options.port === "number" || typeof options.port === "string" ? String(options.port) : "";
    const hostname = typeof options.hostname === "string" ? options.hostname : undefined;
    let authority: string;
    if (hostname !== undefined) {
      // `hostname` never carries a port, so a bare IPv6 literal must be bracketed.
      const bracketed = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
      authority = port ? `${bracketed}:${port}` : bracketed;
    } else if (typeof options.host === "string") {
      // `host` may already embed a port — only append one when it clearly doesn't.
      authority = port && !options.host.includes(":") ? `${options.host}:${port}` : options.host;
    } else {
      authority = port ? `localhost:${port}` : "localhost";
    }
    return new URL(path, `${scheme}//${authority}`).href;
  } catch {
    return urlArg ? String(urlArg) : `${protocol}://unknown`;
  }
}

/** Interpret the overloaded request/get argument list into a NormalizedRequest. */
export function normalizeArgs(protocol: HttpModuleName, args: unknown[]): NormalizedRequest {
  const rest = [...args];
  const callback = typeof rest[rest.length - 1] === "function" ? (rest.pop() as NormalizedRequest["callback"]) : undefined;
  let urlArg: string | URL | null = null;
  let options: Record<string, unknown> = {};
  const first = rest[0];
  if (typeof first === "string" || first instanceof URL) {
    urlArg = first;
    if (rest[1] && typeof rest[1] === "object") options = rest[1] as Record<string, unknown>;
  } else if (first && typeof first === "object") {
    options = first as Record<string, unknown>;
  }
  const url = computeUrl(protocol, urlArg, options);
  const method = (typeof options.method === "string" ? options.method : "GET").toUpperCase();
  return { url, method, urlArg, options, callback };
}

/** Derive the stand-in's ClientRequest-shaped identity fields from the full URL. */
export function metaFromUrl(url: string, method: string, protocol: HttpModuleName): DeferredRequestMeta {
  try {
    const parsed = new URL(url);
    return { method, path: `${parsed.pathname}${parsed.search}`, host: parsed.host, protocol: parsed.protocol };
  } catch {
    return { method, path: "/", host: "unknown", protocol: `${protocol}:` };
  }
}
