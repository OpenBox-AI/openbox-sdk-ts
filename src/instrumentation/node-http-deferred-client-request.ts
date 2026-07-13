/**
 * `DeferredClientRequest` — the stand-in `http.ClientRequest` returned to the
 * caller by the node:http/node:https governance patch so a preflight verdict can
 * run BEFORE any byte reaches the network.
 *
 * `http.request()` must return a `ClientRequest` synchronously, so the wrapper
 * cannot `await runtime.preflight(...)` in place. Instead it returns this
 * stand-in, which:
 *   1. buffers the caller's header mutations + written body chunks,
 *   2. on `end()`, hands them to the patch via `onCommit` (which runs preflight),
 *   3. then either `attachReal(realReq)` (verdict ALLOW — replay the buffered body
 *      to a real request created only now) or `rejectGovernance(err)` (BLOCK/HALT —
 *      no real request is ever created, so the socket is provably never written).
 *
 * This is the ONLY interception shape that guarantees zero bytes on a BLOCK: a
 * custom-Agent `createConnection` hook would miss keep-alive socket reuse (a
 * reused socket skips `createConnection`) and would clobber a caller's own
 * agent/proxy — see the decision note. The cost is that the request body is
 * buffered in memory (backpressure/`'drain'` timing differs from an unwrapped
 * request); acceptable for governed agent traffic, documented in the coverage doc.
 *
 * SURFACE SCOPE: the common client path — `write`/`end`, header methods,
 * `setTimeout`/`setNoDelay`/`setSocketKeepAlive`, `abort`/`destroy`, and event
 * relay for `response`/`error`/`socket`/`drain`/`finish`/`close`/`timeout`/
 * `continue`/`information`/`connect`/`upgrade`. Exotic usage (reading `req.socket`
 * before `end()`, `CONNECT`/`upgrade` tunnels) is best-effort, documented as a gap.
 */

import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

/** Immutable request identity resolved from the http.request(...) arguments. */
export interface DeferredRequestMeta {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly protocol: string;
}

/** Telemetry taps invoked by the relay AFTER the caller's own listener has run, so
 *  observing the response never causes the caller to miss data (see `attachReal`). */
export interface DeferredRealTaps {
  /** Called right after the caller's `'response'` listeners run for this response. */
  readonly onResponse?: (res: IncomingMessage) => void;
  /** Called right after the caller's `'error'` listeners run for a request error. */
  readonly onRequestError?: (error: Error) => void;
}

/** Events relayed verbatim from the real request to the stand-in (response/error
 *  are relayed specially so telemetry taps fire after the caller — see below). */
const RELAYED_EVENTS = [
  "socket",
  "connect",
  "upgrade",
  "continue",
  "information",
  "drain",
  "timeout",
  "close",
  "finish",
  "abort"
] as const;

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

type WriteCallback = (error?: Error | null) => void;

export class DeferredClientRequest extends EventEmitter {
  // ClientRequest-shaped public properties some client libs read.
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly protocol: string;

  readonly #headers: OutgoingHttpHeaders;
  readonly #bodyChunks: Buffer[] = [];
  readonly #onCommit: (self: DeferredClientRequest) => void;

  #ended = false;
  #canceled = false;
  #terminated = false;
  #cancelError: Error | null = null;
  #real: ClientRequest | null = null;
  #queuedTimeout: { msecs: number; callback: (() => void) | undefined } | null = null;

  constructor(meta: DeferredRequestMeta, initialHeaders: OutgoingHttpHeaders, onCommit: (self: DeferredClientRequest) => void) {
    super();
    this.method = meta.method;
    this.path = meta.path;
    this.host = meta.host;
    this.protocol = meta.protocol;
    this.#headers = { ...initialHeaders };
    this.#onCommit = onCommit;
  }

  // ── Writable-side surface (buffer pre-commit, forward post-commit) ──────────

  write(chunk: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const cb = typeof encoding === "function" ? encoding : callback;
    const enc = typeof encoding === "function" ? undefined : encoding;
    if (chunk !== undefined && chunk !== null) {
      const buffered = toBuffer(chunk, enc);
      if (this.#real) this.#real.write(buffered);
      else this.#bodyChunks.push(buffered);
    }
    cb?.(null);
    return true; // no backpressure while buffering — bodies are held in memory
  }

  end(chunk?: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): this {
    let resolvedChunk: unknown = chunk;
    let enc: BufferEncoding | undefined;
    let cb: WriteCallback | undefined;
    if (typeof chunk === "function") {
      cb = chunk as WriteCallback;
      resolvedChunk = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
    } else {
      enc = encoding;
      cb = callback;
    }
    if (resolvedChunk !== undefined && resolvedChunk !== null) this.write(resolvedChunk, enc);
    if (cb) this.once("finish", cb);
    if (this.#ended) return this;
    this.#ended = true;
    this.#onCommit(this); // hands off to the patch's async preflight; returns immediately
    return this;
  }

  // ── Header surface (operate on the buffered header map pre-commit) ──────────

  setHeader(name: string, value: number | string | readonly string[]): this {
    if (this.#real) this.#real.setHeader(name, value);
    else this.#headers[name] = value as OutgoingHttpHeaders[string];
    return this;
  }

  getHeader(name: string): number | string | string[] | undefined {
    return this.#real ? this.#real.getHeader(name) : (this.#headers[name.toLowerCase()] ?? this.#headers[name]);
  }

  removeHeader(name: string): void {
    if (this.#real) this.#real.removeHeader(name);
    else delete this.#headers[name];
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  getHeaderNames(): string[] {
    return Object.keys(this.#headers);
  }

  getHeaders(): OutgoingHttpHeaders {
    return { ...this.#headers };
  }

  flushHeaders(): void {
    this.#real?.flushHeaders();
  }

  // ── Control surface ─────────────────────────────────────────────────────────

  setTimeout(msecs: number, callback?: () => void): this {
    if (this.#real) this.#real.setTimeout(msecs, callback);
    else this.#queuedTimeout = { msecs, callback };
    return this;
  }

  setNoDelay(noDelay?: boolean): void {
    this.#real?.setNoDelay(noDelay);
  }

  setSocketKeepAlive(enable?: boolean, initialDelay?: number): void {
    this.#real?.setSocketKeepAlive(enable, initialDelay);
  }

  abort(): void {
    if (this.#canceled) return;
    this.#cancel();
    // A real request drives its own 'abort'/'close'; before dispatch the stand-in
    // must emit them itself so a caller awaiting 'close' after abort() never hangs.
    if (this.#real) this.#real.abort();
    else this.#scheduleTerminal(["abort", "close"]);
  }

  destroy(error?: Error): this {
    if (this.#canceled) return this;
    this.#cancel(error);
    if (this.#real) this.#real.destroy(error);
    else this.#scheduleTerminal(error ? ["error", "close"] : ["close"], error);
    return this;
  }

  get aborted(): boolean {
    return this.#canceled;
  }

  get destroyed(): boolean {
    return this.#canceled;
  }

  get writableEnded(): boolean {
    return this.#ended;
  }

  get socket(): Socket | null {
    return this.#real?.socket ?? null;
  }

  // ── Patch-facing internals (not part of the ClientRequest surface) ──────────

  /** Buffered outbound body as a single Buffer (for replay + span capture). */
  bufferedBody(): Buffer {
    return Buffer.concat(this.#bodyChunks);
  }

  /** Current outbound headers (opts.headers + any setHeader mutations). */
  requestHeaders(): OutgoingHttpHeaders {
    return this.#headers;
  }

  /** True if the caller aborted/destroyed before dispatch — do NOT create a real request. */
  isCanceledBeforeDispatch(): boolean {
    return this.#canceled;
  }

  /**
   * Verdict ALLOW: wire the stand-in to a freshly created real request. Replays
   * the buffered body, forwards events, and relays `response`/`error` so the
   * telemetry taps fire immediately AFTER the caller's own listeners have run.
   * That ordering lets the response tap observe the caller's consumption state
   * (see the tap in `node-http-governance-patch.ts`) and only tee when doing so
   * cannot steal the caller's data — node:http has no `response.clone()`.
   */
  attachReal(real: ClientRequest, taps: DeferredRealTaps): void {
    if (this.#canceled) {
      real.destroy(this.#cancelError ?? undefined);
      return;
    }
    this.#real = real;

    for (const event of RELAYED_EVENTS) {
      real.on(event, (...args: unknown[]) => {
        this.emit(event, ...args);
      });
    }
    real.on("response", (res: IncomingMessage) => {
      this.emit("response", res); // caller's consumers attach synchronously here…
      taps.onResponse?.(res); // …then the tap observes, never stealing data
    });
    real.on("error", (error: Error) => {
      this.emit("error", error);
      taps.onRequestError?.(error);
    });

    if (this.#queuedTimeout) real.setTimeout(this.#queuedTimeout.msecs, this.#queuedTimeout.callback);
    for (const chunk of this.#bodyChunks) real.write(chunk);
    real.end();
  }

  /**
   * Verdict BLOCK/HALT (or a synchronous throw from the real request factory on
   * the ALLOW path): no real request is ever created. Emit the error then
   * `close` on the next tick so a synchronously-attached `'error'` listener
   * fires — matching a real ClientRequest's async error semantics.
   */
  rejectGovernance(error: Error): void {
    this.#canceled = true;
    this.#cancelError = error;
    this.#scheduleTerminal(["error", "close"], error);
  }

  #cancel(error?: Error): void {
    if (this.#canceled) return;
    this.#canceled = true;
    if (error) this.#cancelError = error;
  }

  /**
   * Emit terminal events on the next tick, at most once per stand-in (an
   * abort-then-block race must not double-emit `close`). Only used before a real
   * request exists; once attached, the real request drives its own terminals.
   */
  #scheduleTerminal(events: readonly string[], error?: Error): void {
    if (this.#terminated) return;
    this.#terminated = true;
    process.nextTick(() => {
      for (const event of events) {
        if (event === "error" && error) this.emit("error", error);
        else this.emit(event);
      }
    });
  }
}
