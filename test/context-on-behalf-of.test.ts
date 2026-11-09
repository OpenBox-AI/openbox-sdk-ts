import { describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { applyOnBehalfOf, currentOnBehalfOf, withOnBehalfOf } from "../src/context/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };

function recordingClient(sent: Record<string, unknown>[]): OpenBoxClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")));
    return new Response(JSON.stringify({ verdict: "allow" }), { status: 200 });
  }) as typeof fetch;
  return new OpenBoxClient("https://core.example.com", "obx_test_k", { fetchImpl, logger: silentLogger });
}

describe("withOnBehalfOf", () => {
  it("is absent by default", () => {
    expect(currentOnBehalfOf()).toBeUndefined();
    expect(applyOnBehalfOf({ a: 1 })).toEqual({ a: 1 });
  });

  it("is scoped to the callback", () => {
    withOnBehalfOf("amy@firm.example", () => {
      expect(currentOnBehalfOf()).toEqual({ user: "amy@firm.example", source: "sdk" });
    });
    expect(currentOnBehalfOf()).toBeUndefined();
  });

  it("restores the outer user after a nested scope", () => {
    withOnBehalfOf("amy@firm.example", () => {
      withOnBehalfOf(
        "barry@firm.example",
        () => expect(currentOnBehalfOf()).toEqual({ user: "barry@firm.example", source: "session" }),
        "session"
      );
      expect(currentOnBehalfOf()?.user).toBe("amy@firm.example");
    });
  });

  it("clears it for a blank user and trims a padded one", () => {
    withOnBehalfOf("amy@firm.example", () => {
      withOnBehalfOf("   ", () => expect(currentOnBehalfOf()).toBeUndefined());
      withOnBehalfOf("  barry@firm.example ", () => expect(currentOnBehalfOf()?.user).toBe("barry@firm.example"));
    });
  });

  it("returns the callback's value, including a promise", async () => {
    expect(withOnBehalfOf("amy@firm.example", () => 7)).toBe(7);
    await expect(withOnBehalfOf("amy@firm.example", async () => 8)).resolves.toBe(8);
  });
});

describe("applyOnBehalfOf", () => {
  it("lets a value already on the payload win", () => {
    const explicit = { user: "colin@firm.example", source: "caller" };
    withOnBehalfOf("amy@firm.example", () => {
      expect(applyOnBehalfOf({ on_behalf_of: explicit })).toEqual({ on_behalf_of: explicit });
    });
  });

  it("does not mutate the caller's payload and passes non-objects through", () => {
    const payload = { a: 1 };
    withOnBehalfOf("amy@firm.example", () => {
      expect(applyOnBehalfOf(payload)).toEqual({ a: 1, on_behalf_of: { user: "amy@firm.example", source: "sdk" } });
      expect(applyOnBehalfOf([1, 2])).toEqual([1, 2]);
      expect(applyOnBehalfOf(null)).toBeNull();
    });
    expect(payload).toEqual({ a: 1 });
  });
});

describe("OpenBoxClient.evaluate", () => {
  it("carries the on-behalf-of user only inside the scope", async () => {
    const sent: Record<string, unknown>[] = [];
    const c = recordingClient(sent);
    await withOnBehalfOf("amy@firm.example", () => c.evaluate({ event_type: "ActivityStarted" }));
    await c.evaluate({ event_type: "ActivityStarted" });
    expect(sent[0]?.["on_behalf_of"]).toEqual({ user: "amy@firm.example", source: "sdk" });
    expect(sent[1]).not.toHaveProperty("on_behalf_of");
  });

  it("keeps it across awaits and timers in the same call chain", async () => {
    const sent: Record<string, unknown>[] = [];
    const c = recordingClient(sent);
    await withOnBehalfOf("amy@firm.example", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await c.evaluate({ event_type: "ActivityStarted" });
    });
    expect(sent[0]?.["on_behalf_of"]).toEqual({ user: "amy@firm.example", source: "sdk" });
  });

  it("keeps concurrent requests apart", async () => {
    const sent: Record<string, unknown>[] = [];
    const c = recordingClient(sent);
    const run = (user: string) =>
      withOnBehalfOf(user, async () => {
        await Promise.resolve();
        await c.evaluate({ event_type: "ActivityStarted", who: user });
      });
    await Promise.all([run("amy@firm.example"), run("barry@firm.example")]);
    const pairs = sent.map((p) => [p["who"], (p["on_behalf_of"] as { user: string }).user]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["amy@firm.example", "amy@firm.example"],
        ["barry@firm.example", "barry@firm.example"]
      ])
    );
  });
});
