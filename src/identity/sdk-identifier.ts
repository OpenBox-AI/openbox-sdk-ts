/**
 * SDK identifier formatting for OpenBox request headers.
 *
 * The wire value is framework-branded (not just a package version) so Core can
 * distinguish SDK families:  `openbox-{engine}-{language}-v{version}`.
 *
 * Base defaults: engine `base`, language `typescript`. Framework adapters
 * override `engine` (e.g. `mastra`) when constructing the client/identity.
 */

import { SDK_VERSION } from "../version.js";

export const DEFAULT_SDK_ENGINE = "base";
export const DEFAULT_SDK_LANGUAGE = "typescript";

const SLUG_PART_RE = /[^a-z0-9]+/g;
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

export const SDK_IDENTIFIER_PATTERN =
  /^openbox-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+-v\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

function slug(value: string, fieldName: string): string {
  const text = String(value).trim().toLowerCase();
  const result = text.replace(SLUG_PART_RE, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error(`${fieldName} must not be empty`);
  return result;
}

/** Return a canonical `v`-prefixed SDK version component. */
export function normalizeSdkVersion(version: string): string {
  let raw = String(version).trim();
  if (raw.startsWith("v") || raw.startsWith("V")) raw = raw.slice(1);
  if (!VERSION_RE.test(raw)) {
    throw new Error(
      `sdk version must look like '1.1' or '1.2.3' (optionally with a suffix), got ${JSON.stringify(version)}`
    );
  }
  return `v${raw}`;
}

/**
 * Build `openbox-{engine}-{language}-v{version}`.
 *
 * `version` may be a raw package version (`1.2.3`), a `v`-prefixed version, or
 * an already-formatted OpenBox SDK identifier (returned verbatim if valid).
 */
export function buildSdkIdentifier(options?: {
  engine?: string;
  language?: string;
  version?: string | null;
}): string {
  const engine = options?.engine ?? DEFAULT_SDK_ENGINE;
  const language = options?.language ?? DEFAULT_SDK_LANGUAGE;
  const raw = String(options?.version ?? SDK_VERSION).trim();

  if (raw.startsWith("openbox-")) {
    if (!SDK_IDENTIFIER_PATTERN.test(raw)) {
      throw new Error(`invalid OpenBox SDK identifier: ${JSON.stringify(raw)}`);
    }
    return raw;
  }

  return `openbox-${slug(engine, "sdk engine")}-${slug(language, "sdk language")}-${normalizeSdkVersion(raw)}`;
}
