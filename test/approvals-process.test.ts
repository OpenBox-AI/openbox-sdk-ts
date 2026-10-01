import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("ApprovalPoller in a standalone Node process", () => {
  let scratchDir: string;
  let pollerUrl: string;

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "openbox-approval-process-"));
    // Build current source, so this regression does not depend on stale dist
    // files or the test runner's handles keeping the approval wait alive.
    await build({
      entry: [fileURLToPath(new URL("../src/approvals/index.ts", import.meta.url))],
      outDir: scratchDir,
      outExtension: () => ({ js: ".mjs" }),
      format: ["esm"],
      platform: "node",
      target: "node24",
      bundle: true,
      dts: false,
      config: false,
      silent: true
    });
    pollerUrl = pathToFileURL(join(scratchDir, "index.mjs")).href;
  });

  afterAll(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it.each([
    { mode: "allow", outcome: "approved:2", description: "stays alive until approval" },
    { mode: "timeout", outcome: "ApprovalTimeoutError", description: "stays alive until timeout" },
    { mode: "abort", outcome: "ApprovalRejectedError", description: "clears the timer on cancellation" }
  ])("$description and then exits cleanly", ({ mode, outcome }) => {
    const source = `
      import { ApprovalPoller } from ${JSON.stringify(pollerUrl)};

      const mode = process.argv[1];
      const controller = new AbortController();
      let polls = 0;
      const poller = new ApprovalPoller({
        async pollApproval() {
          polls += 1;
          const pending = mode !== "allow" || polls < 2;
          return { isPending: () => pending };
        }
      }, {
        pollIntervalMs: mode === "abort" ? 10_000 : 10,
        maxWaitMs: mode === "timeout" ? 25 : 10_000,
        abortSignal: controller.signal
      });

      if (mode === "abort") {
        // Only the approval timer may keep this process alive. On abort,
        // clearing that long timer must let the process exit immediately.
        setTimeout(() => controller.abort(), 25).unref();
      }

      try {
        await poller.waitForDecision("workflow", "run", "activity");
        console.log("approved:" + polls);
      } catch (error) {
        console.log(error.name);
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, mode], {
      encoding: "utf8",
      timeout: 5000
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(outcome);
    expect(result.stderr).toBe("");
  });
});
