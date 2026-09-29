/**
 * Provider-neutral RSA private-key loading, shared by the Okta v2 assertion
 * signer and the IAM v3 workload client assertion.
 *
 * Errors name the configuration field the key came from (`keyLabel`) and state
 * only shape/size facts — never key bytes.
 *
 * `node:crypto` is imported here; this module is off the import-light root.
 */

import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { OpenBoxConfigError } from "../errors/index.js";

/** Minimum RSA modulus size Core and Keycloak flows accept — rejected locally below it. */
export const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Load a PEM-encoded RSA private key into a `KeyObject`, rejecting non-RSA keys
 * and RSA keys below `MIN_RSA_MODULUS_BITS` before any network request.
 *
 * PKCS8 PEM is the documented encoding. Node's PEM parser is self-describing
 * (the `-----BEGIN ... -----` label selects PKCS1 vs PKCS8), so the `type` hint
 * does not hard-reject PKCS1; the RSA-type and modulus checks are what matter.
 */
export function loadRsaPrivateKey(pem: unknown, keyLabel: string): KeyObject {
  if (typeof pem !== "string" || !pem.includes("PRIVATE KEY")) {
    throw new OpenBoxConfigError(
      `Invalid ${keyLabel}: expected a PKCS8 PEM-encoded RSA private key (key bytes not shown).`
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    throw new OpenBoxConfigError(
      `Invalid ${keyLabel}: could not load a PKCS8 PEM RSA key (key bytes not shown).`
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new OpenBoxConfigError(
      `Invalid ${keyLabel}: expected an RSA key, got '${String(key.asymmetricKeyType)}' (key bytes not shown).`
    );
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_RSA_MODULUS_BITS) {
    throw new OpenBoxConfigError(
      `Invalid ${keyLabel}: RSA modulus must be at least ${MIN_RSA_MODULUS_BITS} bits, got ${modulusBits} (key bytes not shown).`
    );
  }
  return key;
}
