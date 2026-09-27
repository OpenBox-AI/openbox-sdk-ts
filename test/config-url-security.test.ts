/**
 * Core URL helpers: trailing-slash trimming (a linear scan standing in for a
 * backtracking regex) and the HTTPS-or-exact-loopback transport rule.
 */
import { describe, expect, it } from "vitest";

import { OpenBoxConfigError, OpenBoxInsecureURLError } from "../src/errors/index.js";
import { trimTrailingSlashes, validateUrlSecurity } from "../src/config/url-security.js";

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
