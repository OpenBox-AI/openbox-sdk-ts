/**
 * `node:http` / `node:https` governance patch — Tier A1, preflight-BLOCKING
 * (parity with the global `fetch` patch). Node's `fetch` is undici and does NOT
 * traverse `node:http`, so libraries built on `node:http`/`node:https` directly
 * (axios, got, node-fetch@2, superagent, aws-sdk v2, …) bypass the fetch patch
 * entirely — this closes that gap.
 *
 * Blocking cannot happen "in place": `http.request()` must return a
 * `ClientRequest` synchronously, so the wrapper returns a `DeferredClientRequest`
 * that buffers the request, runs `await runtime.preflight(...)` on `end()`, and
 * only creates the real request on ALLOW (see that class for why deferral is the
 * only shape that guarantees zero bytes on BLOCK). A BLOCK/HALT throws out of
 * `runtime.preflight` and the real request is never created.
 *
 * Recursion guard — identical two layers to the fetch patch:
 *   1. `isInternalCall()` — SDK's own governance traffic bypasses unconditionally.
 *   2. `isSameOrigin(url, apiUrl)` — exact-origin defense-in-depth backstop.
 *
 * `http.get`/`https.get` call their module-local `request`, so reassigning
 * `request` alone does NOT cover them — `get` is patched separately (it is just
 * `request(...)` + `.end()`).
 *
 * The COMPLETED hook fires detached (after the response ends, long after the
 * caller got its stand-in), so its promise is tracked in `PendingTelemetry` and
 * drained by the controller's `flush()`, exactly like the sync-fs wrapper.
 */

import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";

import type { ClientLogger } from "../client/index.js";
import type { ActivityContext } from "../contracts/context.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedHttpSpan, buildStartedHttpSpan } from "../spans/http-span-builder.js";
import { DeferredClientRequest } from "./node-http-deferred-client-request.js";
import {
  headersRecordFromNodeHeaders,
  headerValueCI,
  isTextContentType,
  mintSpanId,
  mintTraceId,
  nowEpochNs,
  PendingTelemetry
} from "./http-governance-shared.js";
import { metaFromUrl, normalizeArgs, type HttpModuleName, type NormalizedRequest } from "./node-http-request-args.js";
import { isInternalCall, isSameOrigin } from "./recursion-guard.js";

/** Minimal shape of the node:http/node:https module we patch (request + get). */
interface HttpLikeModule {
  request: (...args: unknown[]) => ClientRequest;
  get: (...args: unknown[]) => ClientRequest;
}

export interface NodeHttpGovernancePatchOptions {
  readonly runtime: OpenBoxRuntime;
  readonly module: HttpModuleName;
  readonly logger?: ClientLogger;
}

export interface NodeHttpGovernancePatchHandle {
  /** Restore the true original `request`/`get`. Idempotent. */
  restore(): void;
  /** Await in-flight completed-telemetry promises to settle. Never throws. */
  flush(): Promise<void>;
  /** Governed requests observed with no bound ActivityContext. */
  getSpanlessGovernedRequestCount(): number;
}

/**
 * Install governed `request`/`get` on `node:http` or `node:https`. Throws a plain
 * `Error` if either target is missing/not a function — the strict-vs-diagnostic
 * fail-loud POLICY belongs to the caller (`src/instrumentation/index.ts`).
 */
export function installNodeHttpGovernancePatch(
  options: NodeHttpGovernancePatchOptions
): NodeHttpGovernancePatchHandle {
  const { runtime, module: moduleName } = options;
  const logger = options.logger ?? console;
  const require = createRequire(import.meta.url);
  const httpModule = require(`node:${moduleName}`) as HttpLikeModule;

  const originalRequest = httpModule.request;
  const originalGet = httpModule.get;
  if (typeof originalRequest !== "function" || typeof originalGet !== "function") {
    throw new Error(`node:${moduleName}.request/get are missing or not functions — cannot install HTTP governance`);
  }

  const pending = new PendingTelemetry();
  const maxBody = runtime.config.privacy.maxBodySize;
  let spanlessCount = 0;
  let restored = false;

  function decodeRequestBody(deferred: DeferredClientRequest, requestHeaders: Record<string, string> | null): string | null {
    const body = deferred.bufferedBody();
    if (body.length === 0) return null;
    if (!isTextContentType(headerValueCI(requestHeaders, "content-type"))) return null;
    // Slice the buffer BEFORE decoding so a large body is never fully stringified.
    return body.subarray(0, maxBody).toString("utf8");
  }

  /**
   * Attach a completed-hook emitter that fires exactly once (response end OR
   * error). The completed hook is emitted from socket events — a DETACHED async
   * context that, for a reused keep-alive socket, is NOT the caller's
   * `activityScope`. So the bound context captured at commit is re-bound via
   * `activityScope` around the `runtime.completed(...)` invocation, guaranteeing
   * `HookEvaluator` resolves it (its `resolveBoundContext` reads the ALS store
   * synchronously at invocation). Skipped entirely when unbound (spanless).
   */
  function completeOnce(
    span: { spanId: string; traceId: string; method: string; url: string; startTimeNs: number },
    requestHeaders: Record<string, string> | null,
    requestBody: string | null,
    boundContext: ActivityContext
  ): {
    onResponse: (res: IncomingMessage) => void;
    onRequestError: (error: Error) => void;
  } {
    let settled = false;
    // `error` is OMITTED (not undefined) when absent so buildCompletedHttpSpan's
    // deriveHttpError() can synthesize "HTTP 4xx" from the status code — matching
    // the fetch patch. An explicit null would suppress that derivation.
    const emit = (fields: {
      statusCode?: number | null;
      responseHeaders?: Record<string, string> | null;
      responseBody?: string | null;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      const endTimeNs = nowEpochNs();
      const spanInput = {
        spanId: span.spanId,
        traceId: span.traceId,
        method: span.method,
        url: span.url,
        startTimeNs: span.startTimeNs,
        endTimeNs,
        durationNs: endTimeNs - span.startTimeNs,
        statusCode: fields.statusCode ?? null,
        requestHeaders,
        requestBody,
        responseHeaders: fields.responseHeaders ?? null,
        responseBody: fields.responseBody ?? null
      };
      const completedInput = {
        spans: [buildCompletedHttpSpan(fields.error !== undefined ? { ...spanInput, error: fields.error } : spanInput)]
      };
      pending.track(runtime.contextStore.activityScope(boundContext, () => runtime.completed(completedInput)));
    };

    return {
      onResponse: (res: IncomingMessage): void => {
        // node:http has no `response.clone()`. Adding our own `data` listener
        // would switch the stream to flowing mode; if the caller reads the
        // response later (a deferred `.on('data')`/`for await`) or via paused
        // `.read()`, that would make them LOSE bytes. So capture the body ONLY
        // when the caller has ALREADY put the stream in flowing mode
        // (`.on('data')`/`.pipe()`, present because this tap runs AFTER the
        // caller's 'response' listener). Otherwise skip capture — a telemetry
        // gap is acceptable; corrupting the caller's data is not.
        const wantBody =
          res.listenerCount("data") > 0 &&
          isTextContentType(headerValueCI(headersRecordFromNodeHeaders(res.headers), "content-type"));
        const chunks: Buffer[] = [];
        let captured = 0;
        if (wantBody) {
          res.on("data", (chunk: Buffer | string) => {
            if (captured >= maxBody) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buf);
            captured += buf.length;
          });
        }
        const finish = (error?: string): void => {
          const responseBody = chunks.length ? Buffer.concat(chunks).toString("utf8").slice(0, maxBody) : null;
          emit({
            statusCode: res.statusCode ?? null,
            responseHeaders: headersRecordFromNodeHeaders(res.headers),
            responseBody,
            ...(error !== undefined ? { error } : {})
          });
        };
        res.on("end", () => {
          finish();
        });
        res.on("error", (err: Error) => {
          finish(err.message);
        });
        res.on("aborted", () => {
          finish("aborted");
        });
      },
      onRequestError: (error: Error): void => {
        emit({ error: error.message });
      }
    };
  }

  async function governCommit(deferred: DeferredClientRequest, normalized: NormalizedRequest): Promise<void> {
    // Aborted/destroyed before end() committed — never send an evaluate or dispatch.
    if (deferred.isCanceledBeforeDispatch()) return;
    // Captured here (still inside the caller's activityScope) — the detached
    // completed hook re-binds it, since socket events may run in another context.
    const boundContext = runtime.contextStore.currentActivityContext();
    if (boundContext === null) {
      spanlessCount += 1;
      logger.warn(
        `OpenBox: outbound node:${moduleName} request to ${normalized.url} has no bound ActivityContext — hook ` +
          "governance for this request is skipped, not blocked (Decision 14). If this is unexpected, verify the " +
          "call happens inside an activityScope()."
      );
    }

    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();
    const requestHeaders = headersRecordFromNodeHeaders(deferred.requestHeaders());
    const requestBody = decodeRequestBody(deferred, requestHeaders);

    try {
      // BLOCK/HALT throws here — the real request below is provably never created.
      await runtime.preflight({
        spans: [
          buildStartedHttpSpan({
            spanId,
            traceId,
            method: normalized.method,
            url: normalized.url,
            startTimeNs,
            requestHeaders,
            requestBody
          })
        ]
      });
    } catch (error) {
      deferred.rejectGovernance(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (deferred.isCanceledBeforeDispatch()) return; // caller aborted during preflight — never dispatch

    // Pass the ORIGINAL options through (agent, auth, TLS opts, socketPath, …) with
    // only headers replaced by the merged set (opts.headers + any setHeader calls).
    const mergedOptions: Record<string, unknown> = {
      ...normalized.options,
      headers: deferred.requestHeaders()
    };

    // `http.request()` throws SYNCHRONOUSLY for an invalid header/method/URL. That
    // throw would otherwise reject this detached (`void`-ed) promise → an unhandled
    // rejection (process crash on Node's default) AND a hung caller (no 'error'
    // ever emitted). Convert it to the stand-in's 'error' event instead.
    let real: ClientRequest;
    try {
      real = normalized.urlArg != null ? originalRequest(normalized.urlArg, mergedOptions) : originalRequest(mergedOptions);
    } catch (error) {
      deferred.rejectGovernance(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const taps =
      boundContext !== null
        ? completeOnce(
            { spanId, traceId, method: normalized.method, url: normalized.url, startTimeNs },
            requestHeaders,
            requestBody,
            boundContext
          )
        : {};
    deferred.attachReal(real, taps);
  }

  function governedRequest(...args: unknown[]): ClientRequest {
    // Unconditional bypass FIRST, before any parsing — parity with the fetch patch.
    if (isInternalCall()) return originalRequest(...args);
    const normalized = normalizeArgs(moduleName, args);
    if (isSameOrigin(normalized.url, runtime.config.apiUrl)) return originalRequest(...args);

    const deferred = new DeferredClientRequest(
      metaFromUrl(normalized.url, normalized.method, moduleName),
      (normalized.options.headers as OutgoingHttpHeaders) ?? {},
      (self) => {
        // Backstop: governCommit converts preflight + dispatch throws to the
        // stand-in's 'error' itself; this catches any UNEXPECTED throw so a
        // fire-and-forget rejection can never crash the process.
        governCommit(self, normalized).catch((error: unknown) => {
          logger.error(
            `OpenBox node:${moduleName} governance error: ${error instanceof Error ? error.message : String(error)}`
          );
          self.rejectGovernance(error instanceof Error ? error : new Error(String(error)));
        });
      }
    );
    if (normalized.callback) deferred.on("response", normalized.callback);
    return deferred as unknown as ClientRequest;
  }

  function governedGet(...args: unknown[]): ClientRequest {
    const req = governedRequest(...args);
    req.end();
    return req;
  }

  httpModule.request = governedRequest;
  httpModule.get = governedGet;
  syncBuiltinESMExports();

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      httpModule.request = originalRequest;
      httpModule.get = originalGet;
      syncBuiltinESMExports();
    },
    flush(): Promise<void> {
      return pending.flush();
    },
    getSpanlessGovernedRequestCount(): number {
      return spanlessCount;
    }
  };
}
