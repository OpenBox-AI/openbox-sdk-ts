/**
 * Transport-security rule for the OpenBox Core URL, shared by config
 * normalization and the v3 client (which enforces it even for configs
 * resolved with `validate: false`, since it sends a reusable workload token).
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
