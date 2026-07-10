import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { OpenBoxClient, type ClientLogger } from "../src/client/index.js";
import { OpenBoxConfig, type PrivacyConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { GovernanceBlockedError, GovernanceHaltError } from "../src/errors/index.js";
import { installNodeHttpGovernancePatch } from "../src/instrumentation/node-http-governance-patch.js";
import { runAsInternal } from "../src/instrumentation/recursion-guard.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({ workflowId: "wf-1", activityId: "act-1", activityType: "charge" });

interface BuildOptions {
  readonly apiUrl?: string;
  readonly privacy?: PrivacyConfig;
}

function buildRuntime(fakeCore: FakeCore, options: BuildOptions = {}) {
  const config = OpenBoxConfig.resolve({
    apiUrl: options.apiUrl ?? "https://core.test",
    apiKey: "obx_test_http",
    ...(options.privacy ? { privacy: options.privacy } : {})
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
  const contextStore = new ContextStore();
  const adapter = new FakeAdapter();
  const runtime = new OpenBoxRuntime(config, { client, adapter, contextStore, logger: silentLogger });
  return { runtime, contextStore };
}

interface LoopbackServer {
  readonly port: number;
  readonly received: { method: string | undefined; url: string | undefined; body: string }[];
  hits(): number;
  close(): Promise<void>;
}

/** A real loopback HTTP origin so blocking can be proven by hit-count === 0. */
function startServer(): Promise<LoopbackServer> {
  const received: LoopbackServer["received"] = [];
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body });
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("A".repeat(5000));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        received,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

/** Drive the (patched) global http.request and resolve the full response body. */
function httpText(url: string, options: RequestOptions = {}): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function firstSpan(request: { bodyJson: unknown }): Record<string, unknown> {
  const spans = (request.bodyJson as { spans?: unknown[] }).spans;
  return (spans?.[0] ?? {}) as Record<string, unknown>;
}

const servers: LoopbackServer[] = [];
const restores: (() => void)[] = [];

afterEach(async () => {
  while (restores.length) restores.pop()!();
  while (servers.length) await servers.pop()!.close();
});

function install(runtime: OpenBoxRuntime, moduleName: "http" | "https", logger: ClientLogger = silentLogger) {
  const handle = installNodeHttpGovernancePatch({ runtime, module: moduleName, logger });
  restores.push(() => handle.restore());
  return handle;
}

describe("installNodeHttpGovernancePatch (node:http) — op did not run on BLOCK/HALT", () => {
  it("BLOCK: the origin server is NEVER hit; the request errors with GovernanceBlockedError", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "denied" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    await expect(
      contextStore.activityScope(BOUND_CTX, () => httpText(`http://127.0.0.1:${server.port}/pay`, { method: "POST", body: "{}" }))
    ).rejects.toBeInstanceOf(GovernanceBlockedError);

    expect(server.hits()).toBe(0);
  });

  it("HALT: the origin server is NEVER hit", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "halt", reason: "kill" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    await expect(
      contextStore.activityScope(BOUND_CTX, () => httpText(`http://127.0.0.1:${server.port}/pay`))
    ).rejects.toBeInstanceOf(GovernanceHaltError);

    expect(server.hits()).toBe(0);
  });
});

describe("installNodeHttpGovernancePatch (node:http) — ALLOW proceeds, wire-correct spans", () => {
  it("GET: started + completed spans sent, response delivered intact", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    const handle = install(runtime, "http");

    const res = await contextStore.activityScope(BOUND_CTX, () => httpText(`http://127.0.0.1:${server.port}/data`));
    await handle.flush();

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(server.hits()).toBe(1);

    expect(fakeCore.startedRequests).toHaveLength(1);
    const started = firstSpan(fakeCore.startedRequests[0]!);
    expect(started.http_method).toBe("GET");
    expect(started.http_url).toContain("/data");

    expect(fakeCore.completedRequests).toHaveLength(1);
    const completed = firstSpan(fakeCore.completedRequests[0]!);
    expect(completed.http_status_code).toBe(200);
    expect(completed.response_body).toBe('{"ok":true}');
    expect(typeof completed.duration_ns).toBe("number");
  });

  it("POST: request body captured + credential headers redacted; server receives exact body", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    const handle = install(runtime, "http");

    await contextStore.activityScope(BOUND_CTX, () =>
      httpText(`http://127.0.0.1:${server.port}/charge`, {
        method: "POST",
        body: '{"amount":10}',
        headers: { "content-type": "application/json", authorization: "Bearer secret" }
      })
    );
    await handle.flush();

    expect(server.received[0]?.body).toBe('{"amount":10}');
    const started = firstSpan(fakeCore.startedRequests[0]!);
    expect(started.request_body).toBe('{"amount":10}');
    const headers = started.request_headers as Record<string, string>;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("http.get: auto-end path is governed (blocks and allows)", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    await expect(
      contextStore.activityScope(
        BOUND_CTX,
        () =>
          new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${server.port}/g`, (res) => {
              res.resume();
              res.on("end", () => {
                resolve(undefined);
              });
            });
            req.on("error", reject);
          })
      )
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect(server.hits()).toBe(0);
  });
});

describe("installNodeHttpGovernancePatch (node:http) — response teeing + body cap", () => {
  it("caller receives the FULL response body while the span body is capped at maxBodySize", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore, {
      privacy: { redactKeys: new Set(), maxBodySize: 100 }
    });
    const server = await startServer();
    servers.push(server);
    const handle = install(runtime, "http");

    const res = await contextStore.activityScope(BOUND_CTX, () => httpText(`http://127.0.0.1:${server.port}/big`));
    await handle.flush();

    expect(res.body.length).toBe(5000); // caller's stream is NOT truncated by the tee
    const completed = firstSpan(fakeCore.completedRequests[0]!);
    expect((completed.response_body as string).length).toBeLessThanOrEqual(100);
  });
});

describe("installNodeHttpGovernancePatch (node:http) — recursion / same-origin bypass", () => {
  it("same-origin (api_url) requests pass through ungoverned", async () => {
    const fakeCore = new FakeCore();
    const server = await startServer();
    servers.push(server);
    const { runtime, contextStore } = buildRuntime(fakeCore, { apiUrl: `http://127.0.0.1:${server.port}` });
    install(runtime, "http");

    const res = await contextStore.activityScope(BOUND_CTX, () => httpText(`http://127.0.0.1:${server.port}/self`));
    expect(res.status).toBe(200);
    expect(server.hits()).toBe(1);
    expect(fakeCore.evaluateRequests).toHaveLength(0);
  });

  it("isInternalCall() requests pass through ungoverned", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    const res = await contextStore.activityScope(BOUND_CTX, () =>
      runAsInternal(() => httpText(`http://127.0.0.1:${server.port}/internal`))
    );
    expect(res.status).toBe(200);
    expect(server.hits()).toBe(1);
    expect(fakeCore.evaluateRequests).toHaveLength(0);
  });
});

describe("installNodeHttpGovernancePatch (node:http) — spanless + flush + restore", () => {
  it("no bound context: warns + counts, request proceeds unblocked, no evaluate sent", async () => {
    const warnings: string[] = [];
    const logger: ClientLogger = {
      warn: (message: string) => {
        warnings.push(message);
      },
      error() {},
      info() {}
    };
    const fakeCore = new FakeCore();
    const { runtime } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    const handle = install(runtime, "http", logger);

    const res = await httpText(`http://127.0.0.1:${server.port}/nospan`);
    await handle.flush();

    expect(res.status).toBe(200);
    expect(server.hits()).toBe(1);
    expect(handle.getSpanlessGovernedRequestCount()).toBe(1);
    expect(warnings.some((w) => w.includes("no bound ActivityContext"))).toBe(true);
    expect(fakeCore.evaluateRequests).toHaveLength(0);
  });

  it("restore() puts the original request/get back", async () => {
    const before = http.request;
    const beforeGet = http.get;
    const { runtime } = buildRuntime(new FakeCore());
    const handle = installNodeHttpGovernancePatch({ runtime, module: "http", logger: silentLogger });
    expect(http.request).not.toBe(before);
    expect(http.get).not.toBe(beforeGet);
    handle.restore();
    expect(http.request).toBe(before);
    expect(http.get).toBe(beforeGet);
  });
});

describe("installNodeHttpGovernancePatch (node:http) — dispatch/abort/deferred-read hardening", () => {
  it("a synchronous throw from the real request (invalid header) surfaces as 'error', not a crash or hang", async () => {
    const fakeCore = new FakeCore(); // ALLOW — the throw is on dispatch, after preflight
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    // `http.request` throws ERR_INVALID_HTTP_TOKEN synchronously for this header
    // name. It must reach the caller as an 'error' event (test completing at all
    // proves there is no unhandled rejection), and the request must not dispatch.
    await expect(
      contextStore.activityScope(BOUND_CTX, () =>
        httpText(`http://127.0.0.1:${server.port}/x`, { headers: { "bad header name": "v" } })
      )
    ).rejects.toThrow();
    expect(server.hits()).toBe(0);
  });

  it("destroy() before dispatch emits a terminal 'close' (no hang) and never dispatches", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    const closed = await contextStore.activityScope(
      BOUND_CTX,
      () =>
        new Promise<boolean>((resolve) => {
          const req = http.request(`http://127.0.0.1:${server.port}/x`);
          req.on("close", () => {
            resolve(true);
          });
          req.destroy();
        })
    );
    expect(closed).toBe(true);
    expect(server.hits()).toBe(0);
  });

  it("destroy(error) before dispatch emits 'error' then 'close'", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    install(runtime, "http");

    const seen: string[] = [];
    await contextStore.activityScope(
      BOUND_CTX,
      () =>
        new Promise<void>((resolve) => {
          const req = http.request(`http://127.0.0.1:${server.port}/x`);
          req.on("error", () => seen.push("error"));
          req.on("close", () => {
            seen.push("close");
            resolve();
          });
          req.destroy(new Error("caller destroyed"));
        })
    );
    expect(seen).toStrictEqual(["error", "close"]);
    expect(server.hits()).toBe(0);
  });

  it("a DEFERRED response reader is not corrupted: the tap is skipped, caller still gets the full body", async () => {
    const fakeCore = new FakeCore();
    const { runtime, contextStore } = buildRuntime(fakeCore);
    const server = await startServer();
    servers.push(server);
    const handle = install(runtime, "http");

    const body = await contextStore.activityScope(
      BOUND_CTX,
      () =>
        new Promise<string>((resolve, reject) => {
          const req = http.request(`http://127.0.0.1:${server.port}/big`, (res) => {
            // Defer consumption to a later tick. If the body tap had switched the
            // stream to flowing mode, these bytes would be lost — so this asserts
            // the tap is skipped when no consumer is present at response time.
            setImmediate(() => {
              let data = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                resolve(data);
              });
            });
          });
          req.on("error", reject);
          req.end();
        })
    );
    await handle.flush();

    expect(body.length).toBe(5000); // caller's full body intact despite deferred read
    const completed = firstSpan(fakeCore.completedRequests[0]!);
    expect(completed.response_body).toBeNull(); // tap skipped → no capture (documented trade-off)
  });
});

describe("installNodeHttpGovernancePatch (node:https)", () => {
  it("install swaps request/get and restore puts them back", () => {
    const beforeReq = https.request;
    const beforeGet = https.get;
    const { runtime } = buildRuntime(new FakeCore());
    const handle = installNodeHttpGovernancePatch({ runtime, module: "https", logger: silentLogger });
    expect(https.request).not.toBe(beforeReq);
    expect(https.get).not.toBe(beforeGet);
    handle.restore();
    expect(https.request).toBe(beforeReq);
    expect(https.get).toBe(beforeGet);
  });

  it("BLOCK over https rejects before any socket/TLS handshake is attempted", async () => {
    // No live TLS server needed: on BLOCK the real request is never created, so no
    // socket opens. An unroutable port would surface ECONNREFUSED (not the
    // governance error) if the block path ever dispatched — so this also proves it.
    const fakeCore = new FakeCore().queueEvaluate({ status: 200, body: { verdict: "block", reason: "no" } });
    const { runtime, contextStore } = buildRuntime(fakeCore);
    install(runtime, "https");

    await expect(
      contextStore.activityScope(
        BOUND_CTX,
        () =>
          new Promise((resolve, reject) => {
            const req = https.request("https://127.0.0.1:1/blocked", (res) => {
              res.resume();
              resolve(undefined);
            });
            req.on("error", reject);
            req.end();
          })
      )
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
  });
});
