// TypeScript ↔ Core IAM v3 interoperability gate.
//
// Runs the base and LangChain scenario scripts against openbox-core's REAL v3
// router and verifiers by injecting typescript_workload_interop_test.go into
// Core's internal/api package with `go test -overlay` — the Core checkout is
// never modified. Needs a Go toolchain and an IAM v3 Core checkout.
//
//   node scripts/core-interop/run-core-workload-interop.mjs            # repo builds
//   node scripts/core-interop/run-core-workload-interop.mjs --packed   # npm-packed tarballs in an isolated consumer
//
// Options: --core <dir> (default $OPENBOX_CORE_DIR or ../openbox-core),
//          --langchain <dir> (default $OPENBOX_LANGCHAIN_SDK_DIR or ../openbox-langchain-sdk-ts),
//          --work-dir <dir> (default: a fresh temp dir).
//
// This is Core interoperability evidence with controlled authority fixtures and
// a controlled Keycloak issuer — not a deployed Core/Keycloak/Backend run.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(here, "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const coreDir = resolve(option("--core", process.env.OPENBOX_CORE_DIR ?? join(baseDir, "..", "openbox-core")));
const langchainDir = resolve(
  option("--langchain", process.env.OPENBOX_LANGCHAIN_SDK_DIR ?? join(baseDir, "..", "openbox-langchain-sdk-ts"))
);
const workDir = resolve(option("--work-dir", mkdtempSync(join(tmpdir(), "openbox-ts-core-interop-"))));
const packed = args.includes("--packed");
const langchainScenario = join(langchainDir, "scripts", "core-interop", "langchain-workload-interop-scenario.mjs");
const withLangchain = existsSync(langchainScenario);

function fail(message) {
  console.error(`Core interop gate NOT RUN: ${message}`);
  process.exit(2);
}

function run(command, commandArgs, cwd, extraEnv = {}) {
  console.log(`\n$ (${cwd}) ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if (result.status !== 0) {
    console.error(`command failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (spawnSync("go", ["version"], { encoding: "utf-8" }).status !== 0) fail("no Go toolchain on PATH");
if (!existsSync(join(coreDir, "internal", "api", "keycloak_workload_bootstrap.go"))) {
  fail(`no IAM v3 openbox-core checkout at ${coreDir}`);
}
mkdirSync(workDir, { recursive: true });

let nodeCwd;
let scenarios;
if (packed) {
  const tarballs = join(workDir, "tarballs");
  const consumer = join(workDir, "consumer");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  run("npm", ["pack", "--pack-destination", tarballs], baseDir);
  if (withLangchain) run("npm", ["pack", "--pack-destination", tarballs], langchainDir);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "openbox-interop-consumer", private: true, type: "module" }, null, 2)
  );
  const installs = readdirSync(tarballs)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(tarballs, file));
  if (withLangchain) {
    const manifest = JSON.parse(readFileSync(join(langchainDir, "package.json"), "utf-8"));
    installs.push(
      `langchain@${manifest.peerDependencies.langchain}`,
      `@langchain/core@${manifest.dependencies["@langchain/core"]}`,
      `zod@${manifest.devDependencies.zod}`
    );
  }
  run("npm", ["install", "--no-audit", "--no-fund", ...installs], consumer);
  copyFileSync(join(here, "base-workload-interop-scenario.mjs"), join(consumer, "base-workload-interop-scenario.mjs"));
  scenarios = [join(consumer, "base-workload-interop-scenario.mjs")];
  if (withLangchain) {
    copyFileSync(langchainScenario, join(consumer, "langchain-workload-interop-scenario.mjs"));
    scenarios.push(join(consumer, "langchain-workload-interop-scenario.mjs"));
  }
  nodeCwd = consumer;
} else {
  run("npm", ["run", "build"], baseDir);
  if (withLangchain) run("npm", ["run", "build"], langchainDir);
  scenarios = [join(here, "base-workload-interop-scenario.mjs"), ...(withLangchain ? [langchainScenario] : [])];
  nodeCwd = baseDir;
}

const overlay = join(workDir, "overlay.json");
writeFileSync(
  overlay,
  JSON.stringify({
    Replace: {
      [join(coreDir, "internal", "api", "zz_typescript_workload_interop_test.go")]: join(
        here,
        "typescript_workload_interop_test.go"
      )
    }
  })
);
run(
  "go",
  ["test", "-overlay", overlay, "./internal/api/", "-run", "^TestTypeScriptWorkloadInterop$", "-count=1", "-v"],
  coreDir,
  { OPENBOX_TS_INTEROP_SCENARIOS: scenarios.join(delimiter), OPENBOX_TS_INTEROP_NODE_CWD: nodeCwd }
);
console.log(
  `\nCore interop gate passed (${packed ? "packed tarballs" : "repo builds"}; scenarios: ${scenarios.length}; ` +
    `Core: ${coreDir}; work dir: ${workDir}).`
);
