/**
 * Core URL helpers shared by config normalization and the client: the
 * transport-security rule (which the v3 client enforces even for configs
 * resolved with `validate: false`, since it sends a reusable workload token)
 * and trailing-slash trimming.
 *
 * Pure leaf module: no crypto/network imports.
 */

import { OpenBoxConfigError, OpenBoxInsecureURLError } from "../errors/index.js";

/**
 * HTTPS required for non-localhost URLs (protects API keys in transit).
 *
 * Parses with the WHATWG URL, reads `hostname`, strips IPv6 brackets
 * (`[::1]`→`::1`), and exact-matches the localhost set. Never uses
 * substring/startsWith — `localhost.evil.com` / `127.0.0.1.evil` are NOT local.
 */
export function validateUrlSecurity(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new OpenBoxConfigError(`Invalid api_url: ${apiUrl}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol === "http:" && !isLocalhost) {
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
