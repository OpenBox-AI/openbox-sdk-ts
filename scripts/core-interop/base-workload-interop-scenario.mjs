// IAM v3 interop scenario for @openbox-ai/openbox-sdk-ts, run by the Go gate
// (typescript_workload_interop_test.go) against Core's real v3 router and
// verifiers plus a controlled Keycloak issuer. Prints one `INTEROP_RESULT`
// JSON line; the Go test asserts every step.
//
// Imports the SDK by package name, so it exercises either the repo build
// (package self-reference) or an installed packed tarball.

import { randomUUID } from "node:crypto";

import { OpenBoxWorkloadAuthError, workflowStarted } from "@openbox-ai/openbox-sdk-ts";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

const env = process.env;
const steps = [];
const silent = { info() {}, warn() {}, error() {} };
const recorded = [];
const recordingFetch = (input, init) => {
  recorded.push({ url: typeof input === "string" ? input : input.url, init });
  return fetch(input, init);
};
const payload = (activityType) => ({
  event_type: "ActivityStarted",
  workflow_id: "wf-interop",
  run_id: "run-interop",
  activity_id: `act-${randomUUID()}`,
  activity_type: activityType
});

async function step(name, fn) {
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, detail: String(detail ?? "") });
  } catch (error) {
    steps.push({ step: name, ok: false, detail: `${error?.name}: ${error?.message}` });
  }
}

async function expectRejection(promise, predicate, label) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) throw new Error(`${label}: expected a rejection`);
  if (!predicate(error)) {
    throw new Error(`${label}: unexpected rejection ${error?.name} stage=${error?.stage} status=${error?.httpStatus}: ${error?.message}`);
  }
  return `${error.name} stage=${error.stage ?? "-"} status=${error.httpStatus ?? "-"}`;
}

async function control(action) {
  const response = await fetch(`${env.INTEROP_CONTROL_URL}?action=${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`control ${action} failed: HTTP ${response.status}`);
  return response.json();
}

const pathOf = (url) => new URL(url).pathname;
const isWorkloadError = (stage, status) => (error) =>
  error instanceof OpenBoxWorkloadAuthError && error.stage === stage && (status === undefined || error.httpStatus === status);

const client = new OpenBoxClient(env.INTEROP_CORE_URL, env.INTEROP_API_KEY, {
  workloadPrivateKey: env.INTEROP_WORKLOAD_PRIVATE_KEY,
  fetchImpl: recordingFetch,
  logger: silent,
  onApiError: "fail_open"
});

await step("validate-as-first-operation", async () => {
  if ((await client.validateApiKey()) !== true) throw new Error("validate did not return true");
  const metadata = client.workloadIdentityMetadata();
  if (!metadata || metadata.contractVersion !== 3) throw new Error("no v3 metadata after validate");
  return `activation ${metadata.activationVersion}, source ${metadata.identitySource}`;
});

await step("evaluate-allow", async () => {
  const result = await client.evaluate(payload("safe"));
  if (result.verdict !== "allow" || result.fallbackUsed) throw new Error(`verdict=${result.verdict} fallback=${result.fallbackUsed}`);
  return result.verdict;
});

await step("evaluate-block", async () => {
  const result = await client.evaluate(payload("danger"));
  if (result.verdict !== "block") throw new Error(`verdict=${result.verdict}`);
  return result.verdict;
});

await step("approval-poll", async () => {
  const result = await client.pollApproval("wf-interop", "run-interop", "act-1");
  if (!result?.allowShaped) throw new Error(`approval=${JSON.stringify(result)}`);
  return "allow";
});

await step("handoff", async () => {
  const result = await client.sendHandoff(randomUUID());
  if (result.fromAgentId !== env.INTEROP_AGENT_ID) throw new Error(`from=${result.fromAgentId}`);
  return `from ${result.fromAgentId}`;
});

await step("one-acquisition-for-all-operations", () => {
  const exchanges = recorded.filter((r) => r.url === env.INTEROP_TOKEN_ENDPOINT).length;
  const bootstraps = recorded.filter((r) => pathOf(r.url) === "/api/v3/auth/bootstrap").length;
  if (exchanges !== 1 || bootstraps !== 1) throw new Error(`exchanges=${exchanges} bootstraps=${bootstraps}`);
  return "1 bootstrap, 1 token exchange";
});

await step("runtime-via-fromConfig", async () => {
  const config = OpenBoxConfig.resolve({
    environ: {},
    apiUrl: env.INTEROP_CORE_URL,
    apiKey: env.INTEROP_API_KEY,
    identityMethod: "keycloak_workload",
    workloadPrivateKey: env.INTEROP_WORKLOAD_PRIVATE_KEY
  });
  const runtime = new OpenBoxRuntime(config, { logger: silent });
  const result = await runtime.evaluateLifecycle(workflowStarted({ workflowId: "wf-rt", runId: "run-rt", workflowType: "interop" }));
  runtime.close();
  return result.verdict;
});

let rotatedActivation = "";
await step("activation-change-rejects-held-token", async () => {
  rotatedActivation = (await control("rotate-activation")).activation_version;
  return expectRejection(client.evaluate(payload("safe")), isWorkloadError("runtime", 401), "held token after activation change");
});

await step("next-operation-acquires-current-authority", async () => {
  const result = await client.evaluate(payload("safe"));
  const metadata = client.workloadIdentityMetadata();
  if (result.verdict !== "allow" || metadata?.activationVersion !== rotatedActivation) {
    throw new Error(`verdict=${result.verdict} activation=${metadata?.activationVersion} expected=${rotatedActivation}`);
  }
  return `activation ${metadata.activationVersion}`;
});

// Each defect is minted by the controlled Keycloak; Core's real verifier must
// reject the token, and the SDK must stop the operation without falling back.
for (const defect of [
  "wrong-audience",
  "wrong-issuer",
  "expired",
  "wrong-source",
  "wrong-agent",
  "wrong-organization",
  "wrong-activation",
  "wrong-subject"
]) {
  await step(`core-rejects-token-with-${defect}`, async () => {
    await control(`token-defect&defect=${defect}`);
    await client.refreshWorkloadIdentity(); // Keycloak issues the defective token
    return expectRejection(client.evaluate(payload("safe")), isWorkloadError("runtime", 401), defect);
  });
}

await step("valid-token-accepted-again", async () => {
  await control("token-defect&defect=none");
  const result = await client.evaluate(payload("safe"));
  if (result.verdict !== "allow") throw new Error(`verdict=${result.verdict}`);
  return "re-acquired after invalidation";
});

await step("unprojected-realm-key-rejected", async () => {
  await control("rotate-realm-key");
  await client.refreshWorkloadIdentity();
  return expectRejection(client.evaluate(payload("safe")), isWorkloadError("runtime", 401), "unprojected realm key");
});

await step("projected-realm-key-accepted", async () => {
  await control("project-realm-key");
  const result = await client.evaluate(payload("safe"));
  if (result.verdict !== "allow") throw new Error(`verdict=${result.verdict}`);
  return "accepted after projection";
});

await step("no-jwks-or-discovery-fallback", () => {
  const discovery = recorded.filter((r) => /certs|jwks|well-known/.test(r.url));
  if (discovery.length) throw new Error(`unexpected key discovery requests: ${discovery.map((r) => r.url).join(", ")}`);
  return "token treated as opaque";
});

await step("candidate-proof-accepted-by-core", async () => {
  const exchangesBefore = recorded.filter((r) => r.url === env.INTEROP_TOKEN_ENDPOINT).length;
  const before = client.workloadIdentityMetadata();
  const result = await client.proveWorkloadIdentityTransition({
    transitionId: env.INTEROP_TRANSITION_ID,
    candidatePrivateKey: env.INTEROP_CANDIDATE_PRIVATE_KEY
  });
  const exchangesAfter = recorded.filter((r) => r.url === env.INTEROP_TOKEN_ENDPOINT).length;
  if (result.proofVerified !== true) throw new Error("proofVerified was not true");
  if (exchangesAfter !== exchangesBefore) throw new Error("candidate proof performed a token exchange");
  if (client.workloadIdentityMetadata() !== before) throw new Error("candidate proof changed active state");
  return "proof_verified";
});

await step("replayed-proof-rejected-by-core", async () => {
  const proof = recorded.filter((r) => pathOf(r.url) === "/api/v3/auth/workload-transition/proof").at(-1);
  const response = await fetch(proof.url, { method: "POST", headers: proof.init.headers, body: proof.init.body });
  const body = await response.json();
  if (response.status !== 401 || body.reason_code !== "proof_replayed") throw new Error(`HTTP ${response.status} ${body.reason_code}`);
  return body.reason_code;
});

await step("proof-with-active-key-rejected", () =>
  expectRejection(
    client.proveWorkloadIdentityTransition({
      transitionId: env.INTEROP_TRANSITION_ID,
      candidatePrivateKey: env.INTEROP_WORKLOAD_PRIVATE_KEY
    }),
    isWorkloadError("transition_proof", 401),
    "active key as candidate"
  )
);

await step("mismatched-transition-rejected", () =>
  expectRejection(
    client.proveWorkloadIdentityTransition({ transitionId: randomUUID(), candidatePrivateKey: env.INTEROP_CANDIDATE_PRIVATE_KEY }),
    isWorkloadError("transition_bootstrap", 409),
    "unknown transition"
  )
);

await step("expired-candidate-rejected", async () => {
  await control("expire-candidate");
  return expectRejection(
    client.proveWorkloadIdentityTransition({
      transitionId: env.INTEROP_TRANSITION_ID,
      candidatePrivateKey: env.INTEROP_CANDIDATE_PRIVATE_KEY
    }),
    isWorkloadError("transition_bootstrap", 409),
    "expired candidate"
  );
});

await step("wrong-local-key-blocks", async () => {
  await control("register-other-key");
  await expectRejection(client.refreshWorkloadIdentity(), isWorkloadError("token", 401), "refresh with an unregistered key");
  if (client.workloadIdentityMetadata() !== null) throw new Error("stale metadata survived a failed refresh");
  return expectRejection(client.evaluate(payload("safe")), isWorkloadError("token", 401), "evaluate after key change");
});

await step("revoked-api-key-blocks", async () => {
  await control("revoke-api-key");
  const fresh = new OpenBoxClient(env.INTEROP_CORE_URL, env.INTEROP_API_KEY, {
    workloadPrivateKey: env.INTEROP_WORKLOAD_PRIVATE_KEY,
    fetchImpl: recordingFetch,
    logger: silent,
    onApiError: "fail_open"
  });
  return expectRejection(fresh.evaluate(payload("safe")), isWorkloadError("bootstrap", 401), "revoked API key");
});

await step("never-downgraded", () => {
  const legacy = recorded.filter((r) => /^\/api\/v[12]\//.test(pathOf(r.url)));
  const unsignedRuntime = recorded.filter((r) => {
    const path = pathOf(r.url);
    const runtime = ["/api/v3/auth/validate", "/api/v3/governance/evaluate", "/api/v3/governance/approval", "/api/v3/handoffs"];
    return runtime.includes(path) && !new Headers(r.init?.headers).get("x-openbox-workload-token");
  });
  if (legacy.length || unsignedRuntime.length) throw new Error(`legacy=${legacy.length} unsignedRuntime=${unsignedRuntime.length}`);
  return `${recorded.length} requests, all v3`;
});

client.close();
console.log(`INTEROP_RESULT ${JSON.stringify(steps)}`);
