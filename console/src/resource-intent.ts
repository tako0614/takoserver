import { ApiError, type ResourceOperation } from "./api.ts";
import { effect } from "./reactive.ts";
import { api, currentOrganization, principal } from "./state.ts";

type IntentBody =
  | {
      readonly action: "create";
      readonly form: string;
      readonly name: string;
      readonly spec: Record<string, unknown>;
    }
  | {
      readonly action: "update";
      readonly uid: string;
      readonly generation: number;
      readonly spec: Record<string, unknown>;
    }
  | { readonly action: "delete"; readonly uid: string; readonly generation: number };

export interface ResourceIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string | null;
  readonly key: string;
  readonly body: IntentBody;
  readonly replayWindowSeconds: number;
  firstSentAt: number | null;
  operationId: string | null;
  uncertain: boolean;
  inFlight: boolean;
}

/** Browser-memory only: never write spec, key, token, or private input to storage or URL. */
const intents = new Map<string, ResourceIntent>();
let activePrincipalId = principal()?.id ?? null;
effect(() => {
  const next = principal()?.id ?? null;
  if (next !== activePrincipalId) {
    intents.clear();
    activePrincipalId = next;
  }
});

export function prepareResourceIntent(
  organizationId: string,
  body: IntentBody,
  replayWindowSeconds: number,
  key = `console-${body.action}-${crypto.randomUUID()}`,
): ResourceIntent {
  if (!Number.isSafeInteger(replayWindowSeconds) || replayWindowSeconds < 1)
    throw new TypeError("invalid Host replay window");
  const intent: ResourceIntent = {
    id: crypto.randomUUID(),
    organizationId,
    principalId: principal()?.id ?? null,
    key,
    body,
    replayWindowSeconds,
    firstSentAt: null,
    operationId: null,
    uncertain: false,
    inFlight: false,
  };
  intents.set(intent.id, intent);
  return intent;
}

export function uncertainResourceIntents(organizationId: string): readonly ResourceIntent[] {
  return [...intents.values()].filter(
    (intent) =>
      intent.organizationId === organizationId &&
      intent.principalId === (principal()?.id ?? null) &&
      intent.uncertain,
  );
}

export function canReplayResourceIntent(intent: ResourceIntent, now = performance.now()): boolean {
  if (intent.firstSentAt === null) return true;
  const windowMs = intent.replayWindowSeconds * 1_000;
  const marginMs = Math.min(30_000, Math.max(1_000, Math.ceil(windowMs / 10)));
  return now >= intent.firstSentAt && now < intent.firstSentAt + windowMs - marginMs;
}

export function resourceIntentRequestBody(intent: ResourceIntent): string | null {
  const { body, organizationId } = intent;
  if (body.action === "create")
    return JSON.stringify({
      form: body.form,
      space: organizationId,
      name: body.name,
      spec: body.spec,
    });
  if (body.action === "update") return JSON.stringify({ spec: body.spec });
  return null;
}

/** Same exact request, only inside the Host-advertised replay window. */
export async function sendResourceIntent(
  id: string,
  now = performance.now(),
): Promise<ResourceOperation> {
  const intent = intents.get(id);
  if (!intent) throw new ApiError("intent_missing", 0, "resource-intent");
  if (currentOrganization()?.id !== intent.organizationId)
    throw new ApiError("organization_changed", 0, "resource-intent");
  if (intent.principalId !== (principal()?.id ?? null))
    throw new ApiError("principal_changed", 0, "resource-intent");
  if (intent.inFlight) throw new ApiError("intent_in_flight", 0, "resource-intent");
  if (!canReplayResourceIntent(intent, now))
    throw new ApiError("replay_window_expired", 0, "resource-intent");
  if (intent.firstSentAt === null) intent.firstSentAt = now;
  intent.inFlight = true;
  try {
    const { body, organizationId, key } = intent;
    const accepted =
      body.action === "create"
        ? await api.createResource(
            organizationId,
            { form: body.form, space: organizationId, name: body.name, spec: body.spec },
            key,
          )
        : body.action === "update"
          ? await api.updateResource(organizationId, body.uid, body.generation, body.spec, key)
          : await api.deleteResource(organizationId, body.uid, body.generation, key);
    intent.operationId = accepted.id;
    intent.uncertain = false;
    if (accepted.status === "succeeded" || accepted.status === "failed") intents.delete(id);
    return accepted;
  } catch (error) {
    if (isUnknownAcceptance(error)) intent.uncertain = true;
    throw error;
  } finally {
    intent.inFlight = false;
  }
}

export function settleResourceIntent(id: string, operation: ResourceOperation): void {
  const intent = intents.get(id);
  if (
    intent?.operationId === operation.id &&
    (operation.status === "succeeded" || operation.status === "failed")
  )
    intents.delete(id);
}

export function discardResourceIntent(id: string): void {
  intents.delete(id);
}

export function isUnknownAcceptance(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "unreachable" ||
      error.code === "invalid_response" ||
      error.status >= 500 ||
      error.status === 408)
  );
}
