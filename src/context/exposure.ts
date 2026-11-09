/**
 * What an action touches and who it reaches, for exposure barriers.
 *
 * Core's barrier check needs four facts about every governed action: which
 * matter or tenant the agent is working for (`scope`), what the action does
 * (`action_class`), which labelled objects it touches (`resources`) and who it
 * reaches (`participants`). Set the scope once per session and describe each
 * action as it happens:
 *
 * ```ts
 * import { withExposureScope, withGovernedAction } from "@openbox-ai/openbox-sdk-ts/context";
 *
 * await withExposureScope("matter:2026-0417", undefined, () =>
 *   withGovernedAction(
 *     {
 *       actionClass: "send",
 *       resources: [{ uri: "dms://doc/17", labels: ["client:coke"], labelSource: "source_system" }],
 *       participants: [{ kind: "destination", id: "mailbox:r1@firm.example" }],
 *     },
 *     () => sendEmail(),
 *   ),
 * );
 * ```
 *
 * Every governance event sent inside carries the fields. Values the caller
 * already put on a payload win. Labels are opaque `namespace:value` strings
 * from the source system; Core treats a resource with no labels as Unknown.
 * The agent is never told which label caused a refusal. Mirrors the Python
 * SDK's `openbox_core.exposure` field for field (PROD-1109).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/results.js";

/** Action classes Core understands. Anything else is refused. */
export const ACTION_CLASSES = [
  "retrieve",
  "read",
  "generate",
  "send",
  "file",
  "write",
  "external_call",
  "memory_write",
  "memory_read",
  "handoff",
  "handoff_return"
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Principal kinds a participant may claim; Core trusts them only where the registry agrees. */
export const PARTICIPANT_KINDS = [
  "person",
  "agent_session",
  "memory_store",
  "store",
  "hub",
  "destination",
  "stateless_processor",
  "trusted_sink"
] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** Where a resource's labels came from. */
export const LABEL_SOURCES = [
  "source_system",
  "executor_metadata",
  "sdk_declared",
  "cast"
] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export interface ResourceInput {
  readonly uri: string;
  readonly labels?: readonly string[];
  readonly labelSource?: LabelSource;
}

export interface ParticipantInput {
  readonly kind: ParticipantKind;
  readonly id: string;
}

export interface GovernedActionInput {
  readonly actionClass: ActionClass;
  readonly resources?: readonly ResourceInput[];
  readonly participants?: readonly ParticipantInput[];
  /** `sha256:<hex>` of the outbound call body; see {@link hashPayload}. */
  readonly payloadHash?: string;
}

type Wire = Record<string, JsonValue>;

/** A resource as it goes on the wire, validated: uri required, labels trimmed and de-duplicated. */
export function resourceToWire(r: ResourceInput): Wire {
  const uri = (r.uri ?? "").trim();
  if (!uri) throw new Error("resource uri is required");
  const labelSource = r.labelSource ?? "sdk_declared";
  if (!(LABEL_SOURCES as readonly string[]).includes(labelSource)) {
    throw new Error(`unknown label_source ${JSON.stringify(labelSource)}`);
  }
  const labels: string[] = [];
  for (const raw of r.labels ?? []) {
    const label = (raw ?? "").trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  const out: Wire = { uri, label_source: labelSource };
  if (labels.length) out.labels = labels;
  return out;
}

/** A participant as it goes on the wire, validated. */
export function participantToWire(p: ParticipantInput): Wire {
  if (!(PARTICIPANT_KINDS as readonly string[]).includes(p.kind)) {
    throw new Error(`unknown participant kind ${JSON.stringify(p.kind)}`);
  }
  const id = (p.id ?? "").trim();
  if (!id) throw new Error("participant id is required");
  return { kind: p.kind, id };
}

const scopeStorage = new AsyncLocalStorage<Wire | null>();
const actionStorage = new AsyncLocalStorage<Wire | null>();

/**
 * Runs `fn` scoped to one matter or tenant. Core keeps one exposure history
 * per agent and scope, so an agent working two matters in two scopes is two
 * principals. `purpose` is checked against the purposes registered for the
 * agent, never trusted as declared. `instanceId` runs as a clean instance
 * Core issued.
 */
export function withExposureScope<T>(
  scope: string | null | undefined,
  purpose: string | null | undefined,
  fn: () => T,
  instanceId?: string | null
): T {
  const value: Wire = {};
  if ((scope ?? "").trim()) value.scope = scope!.trim();
  if ((purpose ?? "").trim()) value.purpose = purpose!.trim();
  if ((instanceId ?? "").trim()) value.instance_id = instanceId!.trim();
  return scopeStorage.run(Object.keys(value).length ? value : null, fn);
}

/** Runs `fn` with the governance events inside it gating this action. */
export function withGovernedAction<T>(
  action: GovernedActionInput,
  fn: () => T
): T {
  if (!(ACTION_CLASSES as readonly string[]).includes(action.actionClass)) {
    throw new Error(
      `unknown action_class ${JSON.stringify(action.actionClass)}`
    );
  }
  const value: Wire = {
    action_class: action.actionClass,
    resources: (action.resources ?? []).map(resourceToWire),
    participants: (action.participants ?? []).map(participantToWire)
  };
  if ((action.payloadHash ?? "").trim())
    value.payload_hash = action.payloadHash!.trim();
  return actionStorage.run(value, fn);
}

/** The `payload_hash` of an outbound call body: `sha256:<hex>`. */
export function hashPayload(data: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** The exposure fields for the current async call chain (possibly empty). */
export function currentExposureFields(): Wire {
  const out: Wire = {};
  const scope = scopeStorage.getStore();
  if (scope) Object.assign(out, scope);
  const action = actionStorage.getStore();
  if (action) {
    const { action_class, resources, participants, payload_hash } = action;
    if (action_class !== undefined) out.action_class = action_class;
    if (Array.isArray(resources) && resources.length) out.resources = resources;
    if (Array.isArray(participants) && participants.length)
      out.participants = participants;
    if (payload_hash) out.payload_hash = payload_hash;
  }
  return out;
}

/**
 * The action class an event of a given activity type has when nothing
 * declared one. A model call is `generate`: without it, an organisation with
 * an enforced barrier refuses every model call as an action of unknown class.
 */
export const DEFAULT_ACTION_CLASS: Readonly<Record<string, ActionClass>> = {
  llm_call: "generate"
};

/**
 * Adds the context's exposure fields to an evaluate payload. Fields the caller
 * already set win, one by one, then the context's, then the activity type's
 * default action class. Non-object payloads pass through.
 */
export function applyExposure(payload: JsonValue): JsonValue {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const record = payload;
  const fields = currentExposureFields();
  if (!("action_class" in fields)) {
    const activityType =
      typeof record.activity_type === "string" ? record.activity_type : "";
    const fallback = DEFAULT_ACTION_CLASS[activityType];
    if (fallback) fields.action_class = fallback;
  }
  const missing: Wire = {};
  for (const [k, v] of Object.entries(fields)) {
    const have = record[k];
    if (
      have === undefined ||
      have === null ||
      have === "" ||
      (Array.isArray(have) && have.length === 0)
    ) {
      missing[k] = v;
    }
  }
  return Object.keys(missing).length ? { ...record, ...missing } : payload;
}
