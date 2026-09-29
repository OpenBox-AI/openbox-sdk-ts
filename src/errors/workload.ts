/**
 * IAM v3 (`keycloak_workload`) authentication failure.
 *
 * Pure module: no network, crypto, OTel, logging, or wall-clock imports, so it
 * is safe to re-export from the import-light package root.
 *
 * It extends `OpenBoxAuthError` on purpose. Every stage of workload
 * authentication — including an acquisition that failed only because Core or
 * Keycloak was unreachable — must keep its fail-closed meaning through runtime
 * instrumentation and framework wrappers (`isFailClosedCondition` recognizes
 * `OpenBoxAuthError`). A workload-authentication failure is never an outage
 * that `onApiError` may turn into a fallback ALLOW, and never a reason to try a
 * v1/v2 or API-key-only request instead.
 *
 * Messages and fields are sanitized: they may carry the stage, HTTP status, a
 * short machine reason code, contract version, service-account id, activation
 * version, and identity source — never an API key, private key, assertion,
 * access token, token request body, or raw provider response.
 */

import { OpenBoxAuthError } from "./index.js";

/** Where in the workload flow a failure happened. */
export type WorkloadAuthStage =
  | "bootstrap"
  | "token"
  | "runtime"
  | "transition_bootstrap"
  | "transition_proof";

export interface OpenBoxWorkloadAuthErrorDetails {
  readonly stage: WorkloadAuthStage;
  /** HTTP status of the failing response; null for local, network, or timeout failures. */
  readonly httpStatus?: number | null;
  /** Short machine code from Core (`reason_code`) or Keycloak (`error`), when present. */
  readonly reasonCode?: string | null;
}

export class OpenBoxWorkloadAuthError extends OpenBoxAuthError {
  readonly stage: WorkloadAuthStage;
  readonly httpStatus: number | null;
  readonly reasonCode: string | null;

  constructor(message: string, details: OpenBoxWorkloadAuthErrorDetails) {
    super(message);
    this.stage = details.stage;
    this.httpStatus = details.httpStatus ?? null;
    this.reasonCode = details.reasonCode ?? null;
  }
}
