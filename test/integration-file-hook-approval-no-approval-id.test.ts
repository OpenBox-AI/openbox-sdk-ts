// End-to-end (FakeCore) proof of the two wire contracts this SDK must honor:
//
// 1. A file-read started hook answered REQUIRE_APPROVAL *without* an
//    `approval_id` still drives the real approval poll — Core keys the poll on
//    (workflow_id, run_id, activity_id), and `approval_id` is optional
//    response metadata. The governed fs op runs ONLY after the ALLOW decision.
// 2. No request this flow emits carries a top-level string `error` — Core
//    accepts only the structured `{type, message, ...}` object (else 400).

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CoreAdapter } from "../src/adapters/base.js";
import { ApprovalPoller } from "../src/approvals/index.js";
import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeCore, type CapturedRequest } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { installFileIoPromisesWrapper } from "../src/instrumentation/file-io-promises-wrapper.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

// Real (unpatched) mkdtempSync — runs before any wrapper is installed, so
// creating the scratch dir never flows through governance.
const SCRATCH_DIR = mkdtempSync(path.join(os.tmpdir(), "openbox-approval-int-"));

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

const silentLogger = { warn() {}, error() {}, info() {} };
const BOUND_CTX = new ActivityContext({
  workflowId: "wf-int",
  runId: "run-int",
  activityId: "act-int",
  activityType: "report_job"
});

/** The SAME CJS `fs.promises` object the wrapper patches (see the file-io wrapper suite). */
function fsPromisesCjs(): typeof NodeFsPromisesModule {
  const require = createRequire(import.meta.url);
  return require("node:fs/promises") as typeof NodeFsPromisesModule;
}

function topLevelError(request: CapturedRequest): unknown {
  const body = request.bodyJson;
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)["error"];
}

describe("file-read hook -> REQUIRE_APPROVAL without approval_id -> ALLOW -> read runs", () => {
  it("polls on (workflow_id, run_id, activity_id), runs the read only after ALLOW, and never sends a string error", async () => {
    const testFilePath = path.join(SCRATCH_DIR, "governed-read.txt");
    await fsWriteFile(testFilePath, "approved contents"); // pre-create before governance installs

    const fakeCore = new FakeCore()
      // Started hook: REQUIRE_APPROVAL with NO approval_id — exactly what Core sends.
      .queueEvaluate({ status: 200, body: { verdict: "require_approval", reason: "file read needs a human" } })
      // Approval decision: one genuine pending poll, then ALLOW.
      .queueApproval(
        { status: 200, body: { action: "require_approval" } },
        { status: 200, body: { action: "allow" } }
      );
    // Completed-hook evaluate falls through to FakeCore's default {verdict: "allow"}.

    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_integration" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
      fetchImpl: fakeCore.fetchImpl,
      logger: silentLogger
    });
    const adapter = new CoreAdapter({ approvalPoller: new ApprovalPoller(client, { pollIntervalMs: 1 }) });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, { client, adapter, contextStore, logger: silentLogger });

    // Spy BEFORE installing the wrapper, so the spy is the "original" the
    // wrapper captures — its invocation marks the moment the REAL read runs.
    let approvalPollsWhenReadRan = -1;
    const realReadFile = fsPromisesCjs().readFile;
    const readSpy = vi
      .spyOn(fsPromisesCjs(), "readFile")
      .mockImplementation((...args: Parameters<typeof realReadFile>) => {
        approvalPollsWhenReadRan = fakeCore.approvalRequests.length;
        return realReadFile(...args);
      });

    const handle = installFileIoPromisesWrapper({ runtime, logger: silentLogger });
    try {
      const content = await contextStore.activityScope(BOUND_CTX, () =>
        fsReadFile(testFilePath, "utf-8")
      );
      expect(content).toBe("approved contents");
      // Asserted before mockRestore() — restoring wipes the spy's call log.
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle.restore();
      readSpy.mockRestore();
    }

    // The read ran only AFTER both approval polls (pending -> ALLOW).
    expect(fakeCore.approvalRequests).toHaveLength(2);
    expect(approvalPollsWhenReadRan).toBe(2);

    // Every poll was keyed on the correlation IDs — never on an approval_id.
    for (const poll of fakeCore.approvalRequests) {
      expect(poll.bodyJson).toMatchObject({
        workflow_id: "wf-int",
        run_id: "run-int",
        activity_id: "act-int"
      });
      expect(poll.bodyJson).not.toHaveProperty("approval_id");
    }

    // started + completed hook evaluations both went out.
    expect(fakeCore.startedRequests).toHaveLength(1);
    expect(fakeCore.completedRequests).toHaveLength(1);

    // No request in the whole flow carried a top-level string `error`.
    for (const request of [...fakeCore.evaluateRequests, ...fakeCore.approvalRequests]) {
      const error = topLevelError(request);
      if (error !== undefined) {
        expect(typeof error).not.toBe("string");
      }
    }
  });
});
