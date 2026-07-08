/**
 * `ActivityContext` — the framework-agnostic activity/task execution context.
 *
 * Pure, import-safe module: no network, crypto, OTel, or `node:async_hooks`
 * imports (that belongs to `context/index.ts`, the ContextStore). The base
 * SDK owns THIS shape; framework adapters populate it — they never define a
 * competing context type.
 *
 * Immutable: every field is `readonly` and the instance is frozen in the
 * constructor. Per-operation deltas go in `metadata` or a freshly constructed
 * context, never mutation.
 */

import type { JsonValue } from "./results.js";

export interface ActivityContextInit {
  workflowId?: string | null;
  runId?: string | null;
  workflowType?: string | null;
  taskQueue?: string | null;
  activityId?: string | null;
  activityType?: string | null;
  activityInput?: JsonValue | null;
  agentName?: string | null;
  agentRole?: string | null;
  sessionId?: string | null;
  multiAgentSessionId?: string | null;
  metadata?: Readonly<Record<string, JsonValue>> | null;
}

export class ActivityContext {
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly workflowType: string | null;
  readonly taskQueue: string | null;
  readonly activityId: string | null;
  readonly activityType: string | null;
  readonly activityInput: JsonValue | null;
  readonly agentName: string | null;
  readonly agentRole: string | null;
  readonly sessionId: string | null;
  readonly multiAgentSessionId: string | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;

  constructor(init: ActivityContextInit = {}) {
    this.workflowId = init.workflowId ?? null;
    this.runId = init.runId ?? null;
    this.workflowType = init.workflowType ?? null;
    this.taskQueue = init.taskQueue ?? null;
    this.activityId = init.activityId ?? null;
    this.activityType = init.activityType ?? null;
    this.activityInput = init.activityInput ?? null;
    this.agentName = init.agentName ?? null;
    this.agentRole = init.agentRole ?? null;
    this.sessionId = init.sessionId ?? null;
    this.multiAgentSessionId = init.multiAgentSessionId ?? null;
    this.metadata = Object.freeze({ ...(init.metadata ?? {}) });
    Object.freeze(this);
  }

  /**
   * Flat wire fields for hook/lifecycle payload assembly (omit-when-absent).
   *
   * `metadata` entries merge at the top level LAST via setdefault semantics —
   * they never overwrite a first-class field, matching the Python base SDK.
   */
  toPayloadFields(): Record<string, JsonValue> {
    const firstClass: Record<string, JsonValue | null> = {
      workflow_id: this.workflowId,
      run_id: this.runId,
      workflow_type: this.workflowType,
      task_queue: this.taskQueue,
      activity_id: this.activityId,
      activity_type: this.activityType,
      activity_input: this.activityInput,
      agent_name: this.agentName,
      agent_role: this.agentRole,
      session_id: this.sessionId,
      multi_agent_session_id: this.multiAgentSessionId
    };

    const payload: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(firstClass)) {
      if (value !== null) payload[key] = value;
    }
    for (const [key, value] of Object.entries(this.metadata)) {
      if (!(key in payload)) payload[key] = value;
    }
    return payload;
  }
}
