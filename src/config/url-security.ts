/**
 * Core URL helpers shared by config normalization and the client: the
 * transport-security rule (which the v3 client enforces even for configs
 * resolved with `validate: false`, since it sends a reusable workload token),
 * the exact loopback-host match it and the v3 document parsers share, and
 * trailing-slash trimming.
 *
 * Pure leaf module: no crypto/network imports.
 */

import { OpenBoxConfigError, OpenBoxInsecureURLError } from "../errors/index.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * True only for exactly `localhost`, `127.0.0.1`, or `::1`, given a WHATWG
 * `URL#hostname` (whose IPv6 form is bracketed: `[::1]`→`::1`). Never a
 * substring/prefix match — `localhost.evil.com` / `127.0.0.1.evil` are NOT local.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return LOOPBACK_HOSTNAMES.has(bare);
}

/**
 * HTTPS required for non-localhost URLs (protects API keys in transit).
 *
 * Parses with the WHATWG URL and exact-matches its `hostname` against the
 * loopback set (see `isLoopbackHostname`).
 */
export function validateUrlSecurity(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new OpenBoxConfigError(`Invalid api_url: ${apiUrl}`);
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}

/**
 * Remove every trailing `/` — the same result as `value.replace(/\/+$/, "")`,
 * computed with a linear scan instead of a backtracking regex.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
