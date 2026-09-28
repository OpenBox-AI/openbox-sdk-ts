/**
 * Core URL helpers: trailing-slash trimming (a linear scan standing in for a
 * backtracking regex), exact loopback-host matching, and the
 * HTTPS-or-exact-loopback transport rule.
 */
import { describe, expect, it } from "vitest";

import { OpenBoxConfigError, OpenBoxInsecureURLError } from "../src/errors/index.js";
import { isLoopbackHostname, trimTrailingSlashes, validateUrlSecurity } from "../src/config/url-security.js";

describe("trimTrailingSlashes", () => {
  it.each([
    ["https://core.example.com///", "https://core.example.com"],
    ["https://core.example.com/api/", "https://core.example.com/api"],
    ["https://core.example.com", "https://core.example.com"],
    ["/", ""],
    ["", ""]
  ])("%j → %j (same as replace(/\\/+$/, \"\"))", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
    expect(trimTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
  });

  it("stays linear on a long run of slashes followed by a non-slash", () => {
    const input = `${"/".repeat(200_000)}x`;
    expect(trimTrailingSlashes(input)).toBe(input);
  });
});

describe("isLoopbackHostname", () => {
  it("matches exactly localhost, 127.0.0.1, and ::1 (bracketed, as URL#hostname gives it)", () => {
    for (const url of ["http://localhost:8086", "http://127.0.0.1", "http://[::1]:8086/", "http://[0:0:0:0:0:0:0:1]/"]) {
      expect(isLoopbackHostname(new URL(url).hostname)).toBe(true);
    }
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("rejects lookalikes, other addresses, and half-bracketed input", () => {
    for (const hostname of ["localhost.evil.example", "127.0.0.1.evil", "127.0.0.2", "[::2]", "[::1", "::1]", "[]", ""]) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });
});

describe("validateUrlSecurity", () => {
  it("accepts HTTPS and exact loopback HTTP", () => {
    for (const url of ["https://core.example.com", "http://localhost:8086", "http://127.0.0.1", "http://[::1]:8086/"]) {
      expect(() => validateUrlSecurity(url)).not.toThrow();
    }
  });

  it("rejects cleartext non-loopback hosts, including lookalikes", () => {
    for (const url of ["http://core.example.com", "http://localhost.evil.example", "http://127.0.0.1.evil"]) {
      expect(() => validateUrlSecurity(url)).toThrow(OpenBoxInsecureURLError);
    }
  });

  it("rejects an unparseable URL", () => {
    expect(() => validateUrlSecurity("not a url")).toThrow(OpenBoxConfigError);
  });
});
