/**
 * Source-authenticated handoff — pure request/response shaping for
 * `POST /api/{v1,v2}/handoffs` (proposal §13.2, §13.3, §15.1).
 *
 * Kept separate from client/index.ts (which owns the actual network call and
 * identity-based path selection) so the wire shape is independently testable
 * and the client class stays focused on orchestration.
 *
 * No crypto/network imports.
 */

export interface HandoffOptions {
  reason?: string;
  multiAgentSessionId?: string;
}

export interface HandoffResult {
  handoffId: string;
  fromAgentId: string;
  toAgentId: string;
}

/** Build the `POST /api/{v1,v2}/handoffs` body — matches Core's `handoffRequest` shape exactly. */
export function buildHandoffRequestBody(
  toAgentId: string,
  options: HandoffOptions = {}
): Record<string, string> {
  const body: Record<string, string> = { target_agent_id: toAgentId };
  if (options.reason) body["reason"] = options.reason;
  if (options.multiAgentSessionId) body["multi_agent_session_id"] = options.multiAgentSessionId;
  return body;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

/** Parse Core's `handoffResponse` JSON body into the SDK's camelCase result shape. */
export function parseHandoffResponse(data: Record<string, unknown>): HandoffResult {
  return {
    handoffId: stringField(data, "handoff_id"),
    fromAgentId: stringField(data, "from_agent_id"),
    toAgentId: stringField(data, "to_agent_id")
  };
}
