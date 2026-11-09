import { describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import {
  applyExposure,
  currentExposureFields,
  hashPayload,
  withExposureScope,
  withGovernedAction
} from "../src/context/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };

function client(
  sent: Record<string, unknown>[],
  reply: () => Response
): OpenBoxClient {
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    sent.push(
      JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"))
    );
    return reply();
  }) as typeof fetch;
  return new OpenBoxClient("https://core.example.com", "obx_test_k", {
    fetchImpl,
    logger: silentLogger
  });
}

const ACTION = {
  actionClass: "send" as const,
  resources: [
    {
      uri: " dms://doc/17 ",
      labels: ["client:coke", " client:coke ", "", "matter:0417"],
      labelSource: "source_system" as const
    }
  ],
  participants: [
    { kind: "destination" as const, id: " mailbox:r1@firm.example " }
  ],
  payloadHash: "sha256:abc"
};

describe("exposure fields (PROD-1109)", () => {
  it("are absent by default and scoped to the callback", () => {
    expect(currentExposureFields()).toEqual({});
    withExposureScope("matter:0417", "pricing_review", () => {
      expect(currentExposureFields()).toEqual({
        scope: "matter:0417",
        purpose: "pricing_review"
      });
    });
    expect(currentExposureFields()).toEqual({});
  });

  // The same wire fields the Python SDK sends for the same input
  // (openbox_core.exposure.current_exposure_fields), byte for byte.
  it("put the same fields on the wire as the Python SDK", () => {
    const fields = withExposureScope(
      "matter:0417",
      undefined,
      () => withGovernedAction(ACTION, () => currentExposureFields()),
      "inst_1"
    );
    expect(JSON.stringify(fields)).toBe(
      '{"scope":"matter:0417","instance_id":"inst_1","action_class":"send",' +
        '"resources":[{"uri":"dms://doc/17","label_source":"source_system","labels":["client:coke","matter:0417"]}],' +
        '"participants":[{"kind":"destination","id":"mailbox:r1@firm.example"}],"payload_hash":"sha256:abc"}'
    );
  });

  it("refuse unknown classes, kinds, sources and empty ids", () => {
    expect(() =>
      withGovernedAction({ actionClass: "delete" as never }, () => 0)
    ).toThrow(/action_class/);
    expect(() =>
      withGovernedAction(
        {
          actionClass: "send",
          participants: [{ kind: "robot" as never, id: "x" }]
        },
        () => 0
      )
    ).toThrow(/kind/);
    expect(() =>
      withGovernedAction(
        {
          actionClass: "send",
          resources: [{ uri: "x", labelSource: "guess" as never }]
        },
        () => 0
      )
    ).toThrow(/label_source/);
    expect(() =>
      withGovernedAction(
        { actionClass: "send", resources: [{ uri: "  " }] },
        () => 0
      )
    ).toThrow(/uri/);
  });

  it("let fields already on the payload win, and default model calls to generate", () => {
    withExposureScope("matter:0417", undefined, () =>
      withGovernedAction({ actionClass: "retrieve" }, () => {
        expect(applyExposure({ action_class: "send", scope: "" })).toEqual({
          action_class: "send",
          scope: "matter:0417"
        });
      })
    );
    expect(applyExposure({ activity_type: "llm_call" })).toEqual({
      activity_type: "llm_call",
      action_class: "generate"
    });
    expect(applyExposure({ activity_type: "search" })).toEqual({
      activity_type: "search"
    });
    expect(applyExposure([1, 2] as never)).toEqual([1, 2]);
  });

  it("hash a payload as sha256:<hex>, like the Executor", () => {
    expect(hashPayload('{"q":1}')).toBe(
      hashPayload(new TextEncoder().encode('{"q":1}'))
    );
    expect(hashPayload("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("are sent on evaluate inside the scope and action", async () => {
    const sent: Record<string, unknown>[] = [];
    const c = client(
      sent,
      () => new Response(JSON.stringify({ verdict: "allow" }), { status: 200 })
    );
    await withExposureScope("matter:0417", undefined, () =>
      withGovernedAction(
        {
          actionClass: "retrieve",
          resources: [{ uri: "dms://doc/1", labels: ["client:coke"] }]
        },
        () => c.evaluate({ event_type: "ActivityStarted" })
      )
    );
    expect(sent[0]).toMatchObject({
      scope: "matter:0417",
      action_class: "retrieve",
      resources: [
        {
          uri: "dms://doc/1",
          label_source: "sdk_declared",
          labels: ["client:coke"]
        }
      ]
    });
  });

  it("fail closed on an outage once the server says the agent is governed", async () => {
    const sent: Record<string, unknown>[] = [];
    let up = true;
    const c = client(sent, () => {
      if (!up) throw new Error("connection refused");
      return new Response(
        JSON.stringify({
          verdict: "allow",
          settings: { on_api_error: "fail_closed" }
        }),
        { status: 200 }
      );
    });
    expect(c.serverPushedOnApiError).toBeNull();
    await c.evaluate({ event_type: "WorkflowStarted" });
    expect(c.serverPushedOnApiError).toBe("fail_closed");
    up = false;
    await expect(c.evaluate({ event_type: "ActivityStarted" })).rejects.toThrow(
      /unreachable/
    );
  });
});
