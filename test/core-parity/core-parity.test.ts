import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hook } from "../../src/contracts/event-factories.js";
import { HookType, Stage, type SpanRecord } from "../../src/contracts/otel-spans.js";
import { AgentIdentity, buildCanonicalString } from "../../src/identity/index.js";
import { serializeBody } from "../../src/serialization/index.js";
import { buildEvaluatePayload } from "../../src/wire/evaluate-payload.js";

/**
 * Core-parity gate (plan Decision 1): proves TS ≡ Core, not just TS ≡ Python.
 *
 * Runs a standalone Go program whose SpanData struct is copied verbatim from
 * Core (`DisallowUnknownFields` catches any wire drift), and uses Go's
 * `crypto/ed25519` — the same primitive Core's verifier uses — to check a
 * TS-produced signature. Skips cleanly when no Go toolchain is present.
 */

const HARNESS_DIR = fileURLToPath(new URL("./go-spandata-compat", import.meta.url));
const GOLDEN_DID = "did:aip:12345678-1234-5678-1234-567812345678";
const GOLDEN_SEED = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const goAvailable = spawnSync("go", ["version"], { encoding: "utf-8" }).status === 0;

interface HarnessOutput {
  spans: Array<Record<string, unknown>>;
  signature_valid?: boolean;
  signature_error?: string;
}

function runHarness(envelope: unknown): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("go", ["run", "main.go"], {
    cwd: HARNESS_DIR,
    input: JSON.stringify(envelope),
    encoding: "utf-8",
    timeout: 120_000
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Raw 32-byte Ed25519 public key derived from the seed (last 32 bytes of the SPKI DER). */
function rawPublicKey(seedB64: string): Buffer {
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(seedB64, "base64")]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32);
}

function wireSpans(specs: SpanRecord[]): unknown[] {
  const event = hook({
    activityContext: { workflow_id: "wf", run_id: "run", workflow_type: "W", task_queue: "q" },
    activityId: "act",
    activityType: "charge",
    spans: specs
  });
  return buildEvaluatePayload(event).payload["spans"] as unknown[];
}

const SPAN_ID = "00f067aa0ba902b7";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

describe.skipIf(!goAvailable)("Core-parity gate (real Go SpanData unmarshal + ed25519 verify)", () => {
  it(
    "Core's SpanData struct (DisallowUnknownFields) parses TS-emitted hook spans across families",
    () => {
      const spans = wireSpans([
        {
          stage: Stage.STARTED,
          hook_type: HookType.HTTP_REQUEST,
          span_id: SPAN_ID,
          trace_id: TRACE_ID,
          http_method: "GET",
          http_url: "https://api.example/x",
          request_body: '{"q":1}'
        },
        {
          stage: Stage.COMPLETED,
          hook_type: HookType.DB_QUERY,
          span_id: SPAN_ID,
          trace_id: TRACE_ID,
          db_system: "postgresql",
          db_statement: "SELECT 1",
          rowcount: 3,
          start_time: 1,
          duration_ns: 5
        },
        {
          stage: Stage.COMPLETED,
          hook_type: HookType.FILE_OPERATION,
          span_id: SPAN_ID,
          trace_id: TRACE_ID,
          file_path: "/tmp/x.txt",
          file_operation: "write",
          bytes_written: 42,
          start_time: 1,
          duration_ns: 5
        },
        {
          stage: Stage.COMPLETED,
          hook_type: HookType.FUNCTION_CALL,
          span_id: SPAN_ID,
          trace_id: TRACE_ID,
          function: "charge",
          module: "billing",
          args: { amount: 5 },
          result: "ok",
          start_time: 1,
          duration_ns: 5
        }
      ]);

      const res = runHarness({ spans });
      expect(res.status, `go rejected the payload:\n${res.stderr}`).toBe(0);
      const out = JSON.parse(res.stdout) as HarnessOutput;

      const [httpStarted, db, file, fn] = out.spans;
      // Started HTTP: explicit null end_time unmarshals to Core's non-pointer int64 0.
      expect(httpStarted?.["stage"]).toBe("started");
      expect(httpStarted?.["end_time"]).toBe(0);
      expect(httpStarted?.["has_duration_ns"]).toBe(false);
      expect(httpStarted?.["hook_type"]).toBe("http_request");
      expect(httpStarted?.["span_id"]).toBe(SPAN_ID);
      expect(httpStarted?.["trace_id"]).toBe(TRACE_ID);
      expect(httpStarted?.["http_url"]).toBe("https://api.example/x");
      expect(httpStarted?.["semantic_type"]).toBe(""); // null → Go zero value
      expect(httpStarted?.["has_data"]).toBe(false); // flat contract — no data blob

      expect(db?.["db_statement"]).toBe("SELECT 1");
      expect(db?.["end_time"]).toBe(6); // reconstructed start_time + duration_ns
      expect(db?.["has_duration_ns"]).toBe(true);
      expect(file?.["file_path"]).toBe("/tmp/x.txt");
      expect(fn?.["function"]).toBe("charge");
      for (const span of out.spans) {
        expect(span["has_data"]).toBe(false);
      }
    },
    120_000
  );

  it(
    "Go crypto/ed25519 verifies a TS-produced signature over a non-ASCII payload (TS ≡ Core signing)",
    () => {
      const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
      const body = serializeBody({ note: "café☕", amount: 5 });
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const canonical = buildCanonicalString(
        "POST",
        "/api/v1/governance/evaluate",
        "2026-07-02T00:00:00.123456+00:00",
        "nonce-core-parity",
        bodyHash
      );
      const signature = identity.sign(canonical);
      const publicKey = rawPublicKey(GOLDEN_SEED).toString("base64");

      const res = runHarness({ signature: { canonical, signature_b64: signature, public_key_b64: publicKey } });
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as HarnessOutput;
      expect(out.signature_error ?? "").toBe("");
      expect(out.signature_valid).toBe(true);
    },
    120_000
  );

  it(
    "Go rejects a tampered canonical (negative control)",
    () => {
      const identity = AgentIdentity.fromPrivateKey(GOLDEN_DID, GOLDEN_SEED);
      const canonical = buildCanonicalString("POST", "/api/v1/x", "ts", "nonce", "hash");
      const signature = identity.sign(canonical);
      const publicKey = rawPublicKey(GOLDEN_SEED).toString("base64");

      const res = runHarness({
        signature: { canonical: canonical + "-tampered", signature_b64: signature, public_key_b64: publicKey }
      });
      expect(res.status, res.stderr).toBe(0);
      expect((JSON.parse(res.stdout) as HarnessOutput).signature_valid).toBe(false);
    },
    120_000
  );
});
