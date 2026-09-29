/**
 * `FakeCore` — a programmable fake OpenBox Core backend for tests.
 *
 * No live network: it is a `fetchImpl` compatible with
 * `OpenBoxClientOptions.fetchImpl`, so it plugs directly into `OpenBoxClient`
 * (and therefore `OpenBoxRuntime`). It captures every outgoing request — full
 * body bytes AND every header (including all `X-OpenBox-Agent-*` signing
 * headers) — so tests can assert exactly what was signed and sent, and
 * scripts per-endpoint responses (or a persistent network error) FIFO.
 */

const EVALUATE_SUFFIX = "/governance/evaluate";
const APPROVAL_SUFFIX = "/governance/approval";
const AUTH_VALIDATE_SUFFIX = "/auth/validate";
const AUTH_BOOTSTRAP_SUFFIX = "/auth/bootstrap";
// Keycloak realm token endpoint (IAM v3 workload token exchange). The SDK sends
// it through the same fetchImpl as Core traffic, so the fake answers it too.
const WORKLOAD_TOKEN_SUFFIX = "/protocol/openid-connect/token";

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  /** `JSON.parse(bodyText)`, or `undefined` when the body is empty/not JSON. */
  readonly bodyJson: unknown;
}

/** A scripted response: either an HTTP response body, or a network failure. */
export type ScriptedResponse =
  | { readonly status?: number; readonly body: Record<string, unknown> }
  | { readonly networkError: string };

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function requestMethod(input: string | URL | Request, init: RequestInit | undefined): string {
  if (init?.method) return init.method;
  return input instanceof Request ? input.method : "GET";
}

// `HeadersInit`/`BodyInit` are not exposed as standalone global type names by
// @types/node (only `Headers`/`Request`/`Response`/`RequestInit`/`fetch`
// are) — indexing off `RequestInit` gets the same types without hardcoding a
// duplicate shape or reaching into the transitive `undici-types` package.
function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Bodies the SDK's own client ever sends: `Buffer`/`Uint8Array`, `string`, or `null`. */
function readBodyText(body: RequestInit["body"]): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf-8");
  // Test utility: the SDK's own client only ever sends string/Buffer bodies.
  // This branch exists so the function is total over BodyInit's other
  // (Blob/FormData/ReadableStream/...) variants without relying on their
  // (often useless, e.g. "[object ReadableStream]") default stringification.
  return "[unsupported body type in FakeCore]";
}

function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export class FakeCore {
  readonly evaluateRequests: CapturedRequest[] = [];
  readonly approvalRequests: CapturedRequest[] = [];
  readonly authRequests: CapturedRequest[] = [];
  readonly bootstrapRequests: CapturedRequest[] = [];
  /** Keycloak token-endpoint requests (form-encoded bodies; `bodyJson` is undefined). */
  readonly tokenRequests: CapturedRequest[] = [];

  private readonly evaluateQueue: ScriptedResponse[] = [];
  private readonly approvalQueue: ScriptedResponse[] = [];
  private readonly authQueue: ScriptedResponse[] = [];
  private readonly bootstrapQueue: ScriptedResponse[] = [];
  private readonly tokenQueue: ScriptedResponse[] = [];
  private approvalNetworkErrorMessage: string | null = null;

  /** Queue evaluate responses, popped FIFO; an empty queue answers `{verdict:"allow"}`. */
  queueEvaluate(...responses: readonly ScriptedResponse[]): this {
    this.evaluateQueue.push(...responses);
    return this;
  }

  /** Queue approval-poll responses, popped FIFO; an empty queue answers `{action:"allow"}`. */
  queueApproval(...responses: readonly ScriptedResponse[]): this {
    this.approvalQueue.push(...responses);
    return this;
  }

  queueAuth(...responses: readonly ScriptedResponse[]): this {
    this.authQueue.push(...responses);
    return this;
  }

  /**
   * Queue `GET /api/v{2,3}/auth/bootstrap` responses, popped FIFO.
   *
   * An empty queue answers 404, matching a Core deployment that predates the
   * bootstrap endpoint — the conservative default, since it makes a scenario that
   * forgot to script bootstrap fail loudly instead of silently succeeding with
   * metadata no real Core returned.
   */
  queueBootstrap(...responses: readonly ScriptedResponse[]): this {
    this.bootstrapQueue.push(...responses);
    return this;
  }

  /**
   * Queue Keycloak token-endpoint responses (IAM v3), popped FIFO. An empty
   * queue answers `400 invalid_client`, so a scenario that forgot to script the
   * exchange fails loudly instead of receiving a token no Keycloak issued.
   */
  queueWorkloadToken(...responses: readonly ScriptedResponse[]): this {
    this.tokenQueue.push(...responses);
    return this;
  }

  /**
   * Make every subsequent approval poll fail with a network error — simulates
   * a persistently unreachable Core so `ApprovalPoller`'s
   * `maxConsecutiveFailures` budget is exercised (Core-unreachable ⇒
   * `ApprovalTimeoutError`, never an infinite poll).
   */
  failAllApprovals(message = "core unreachable (conformance)"): this {
    this.approvalNetworkErrorMessage = message;
    return this;
  }

  /** Hook (span-bearing) evaluate requests whose first span is started-stage. */
  get startedRequests(): CapturedRequest[] {
    return this.evaluateRequests.filter((r) => firstSpanStage(r) === "started");
  }

  /** Hook (span-bearing) evaluate requests whose first span is completed-stage. */
  get completedRequests(): CapturedRequest[] {
    return this.evaluateRequests.filter((r) => firstSpanStage(r) === "completed");
  }

  /** Evaluate requests with no `hook_trigger` (lifecycle/signal/handoff). */
  get lifecycleRequests(): CapturedRequest[] {
    return this.evaluateRequests.filter((r) => {
      const body = r.bodyJson;
      return typeof body === "object" && body !== null && !("hook_trigger" in body);
    });
  }

  /**
   * `fetchImpl` compatible with `OpenBoxClientOptions.fetchImpl`.
   *
   * Not `async`: every branch either builds a `Response` synchronously or
   * throws (simulating a network failure) — wrapping in `Promise.resolve`
   * satisfies `typeof fetch`'s `Promise<Response>` return without an
   * `async` function that never actually awaits anything. A synchronous
   * throw here is still caught correctly by a caller doing
   * `await fetchImpl(...)`, since the throw happens while evaluating that
   * awaited expression.
   */
  readonly fetchImpl: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    const bodyText = readBodyText(init?.body ?? null);
    const captured: CapturedRequest = {
      method: requestMethod(input, init),
      path: url.pathname,
      headers: normalizeHeaders(init?.headers),
      bodyText,
      bodyJson: safeJsonParse(bodyText)
    };

    if (url.pathname.endsWith(WORKLOAD_TOKEN_SUFFIX)) {
      this.tokenRequests.push(captured);
      return Promise.resolve(
        this.respond(this.tokenQueue, { status: 400, body: { error: "invalid_client" } })
      );
    }
    if (url.pathname.endsWith(EVALUATE_SUFFIX)) {
      this.evaluateRequests.push(captured);
      return Promise.resolve(
        this.respond(this.evaluateQueue, { status: 200, body: { verdict: "allow" } })
      );
    }
    if (url.pathname.endsWith(APPROVAL_SUFFIX)) {
      this.approvalRequests.push(captured);
      if (this.approvalNetworkErrorMessage !== null) {
        throw new Error(this.approvalNetworkErrorMessage);
      }
      return Promise.resolve(
        this.respond(this.approvalQueue, { status: 200, body: { action: "allow" } })
      );
    }
    // Checked BEFORE /auth/validate: both live under /auth/, and an
    // endsWith test on the wrong one first would misroute.
    if (url.pathname.endsWith(AUTH_BOOTSTRAP_SUFFIX)) {
      this.bootstrapRequests.push(captured);
      return Promise.resolve(
        this.respond(this.bootstrapQueue, {
          status: 404,
          body: { code: 404, message: "not found" }
        })
      );
    }
    if (url.pathname.endsWith(AUTH_VALIDATE_SUFFIX)) {
      this.authRequests.push(captured);
      return Promise.resolve(this.respond(this.authQueue, { status: 200, body: {} }));
    }
    return Promise.resolve(jsonResponse(200, {}));
  };

  private respond(queue: ScriptedResponse[], fallback: ScriptedResponse): Response {
    const scripted = queue.shift() ?? fallback;
    if ("networkError" in scripted) throw new Error(scripted.networkError);
    return jsonResponse(scripted.status ?? 200, scripted.body);
  }
}

function firstSpanStage(request: CapturedRequest): unknown {
  const body = request.bodyJson;
  if (typeof body !== "object" || body === null) return undefined;
  const spans = (body as Record<string, unknown>)["spans"];
  if (!Array.isArray(spans) || spans.length === 0) return undefined;
  const first: unknown = spans[0];
  if (typeof first !== "object" || first === null) return undefined;
  return (first as Record<string, unknown>)["stage"];
}
