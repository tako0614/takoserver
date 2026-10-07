import {
  TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
  TAKOSERVER_MANAGED_WORKER_EVENT_PATH,
  TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
  TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
} from "./worker-event-protocol.ts";

/**
 * How a queue batch and a cron match reach a self-hosted Worker.
 *
 * workerd has no queue trigger and no scheduler. It has HTTP sockets, and the
 * only thing it will ever hand a module is a request — so an event has to
 * arrive as one, and the two backends may as well speak the same sentence
 * while doing it. The envelope is literally the managed one
 * (`takoserver.managed-worker-event@v1`, same path, same content types, same
 * fields), so a Worker's `queue` and `scheduled` handlers see the identical
 * portable batch on Cloudflare and on an operator's own machine.
 *
 * Two things differ, and both are named rather than hidden:
 *
 * - **Identity.** The managed backend fills `logicalWorkerId` and
 *   `deploymentId` from its routing replicas. Here they are the workerd script
 *   name and the publication digest — the two things this Host actually has —
 *   held to the same token grammar so the envelope stays one shape.
 * - **Authentication.** The managed wrapper trusts `ctx.props`, which only a
 *   Workers-for-Platforms dispatch namespace can set. workerd has no such
 *   thing: the router forwards by `Host` and anything that can reach the
 *   runtime's port can name a hostname. So a Host-owned gate service in front
 *   holds a per-version token, compares it, and rewrites the request; the
 *   tenant's own service is not on the event route at all, and the entrypoint
 *   the gate calls is a named export the customer-facing `fetch` never reaches.
 *
 * The gate is the reason the token is not readable from tenant code. A binding
 * belongs to the service it is declared on and workerd hands every binding of a
 * service to every module that service runs, so the token lives on the gate —
 * which runs this module and nothing else — exactly as the plane token lives on
 * the data facade.
 */

/** One protocol, two backends. These are the managed constants, re-exported. */
export const SELFHOST_WORKER_EVENT_PATH = TAKOSERVER_MANAGED_WORKER_EVENT_PATH;
export const SELFHOST_WORKER_EVENT_PROTOCOL = TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL;
export const SELFHOST_WORKER_EVENT_CONTENT_TYPE = TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE;
export const SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE =
  TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE;
/** The header naming the protocol, exactly as the managed gateway sends it. */
export const SELFHOST_WORKER_EVENT_HEADER = "x-takoserver-managed-worker-event" as const;
/**
 * Where the per-version token is presented.
 *
 * Its own header rather than `authorization`, because the gate is reached
 * through the same router a customer's traffic goes through and an
 * `authorization` header is a thing customers send.
 */
export const SELFHOST_WORKER_EVENT_TOKEN_HEADER = "x-takoserver-selfhost-event-token" as const;

/** Module name the generated gate service is published under. */
export const SELFHOST_WORKER_EVENT_SERVICE_MODULE = "__takoserver-selfhost-events.js" as const;
/** The per-version bearer token, declared on the gate service only. */
export const SELFHOST_WORKER_EVENT_TOKEN_BINDING = "__TAKOSERVER_SELFHOST_EVENT_TOKEN" as const;
/** The gate's service binding to the tenant script's event entrypoint. */
export const SELFHOST_WORKER_EVENT_TARGET_BINDING = "__TAKOSERVER_SELFHOST_EVENT_TARGET" as const;
/**
 * The named export the gate calls.
 *
 * A named entrypoint is the isolation: the router hands customer traffic to the
 * default export, and nothing outside this Host holds a binding that names
 * this one. A customer POSTing the event path at the Worker's own hostname
 * therefore reaches `default.fetch`, which does not know what an event is.
 */
export const SELFHOST_WORKER_EVENT_ENTRYPOINT = "takoserverSelfhostEvents" as const;

/** Separate opt-in delivery protocol; the retained v1 decision envelope is unchanged. */
export const SELFHOST_V2_QUEUE_EVENT_PATH =
  "/.well-known/takoserver/managed-worker-queue/v2" as const;
export const SELFHOST_V2_QUEUE_EVENT_PROTOCOL = "takoserver.managed-worker-queue@v2" as const;
export const SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE =
  "application/vnd.takoserver.managed-worker-queue.v2+json" as const;

/** The `edge.queue@1.0.0` producer facade, projected by the wrapper. */
export const SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND = "edge.queue@1.0.0" as const;

/** Family-wide queue ceilings, identical to the managed wrapper's. */
export const MAX_SELFHOST_QUEUE_MESSAGES = 100;
export const MAX_SELFHOST_QUEUE_MESSAGE_BYTES = 127_000;
export const MAX_SELFHOST_QUEUE_DELAY_SECONDS = 43_200;
/** The event request and the decisions answer, bounded as the gateway bounds them. */
export const MAX_SELFHOST_EVENT_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_SELFHOST_EVENT_RESPONSE_BYTES = 64 * 1024;

/** The token grammar the envelope's identity fields are held to. */
const EVENT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

export interface SelfhostQueueEventMessage {
  readonly messageId: string;
  readonly timestampMillis: number;
  readonly attempts: number;
  readonly body: { readonly encoding: "base64"; readonly data: string };
}

export interface SelfhostQueueEvent {
  readonly protocol: typeof SELFHOST_WORKER_EVENT_PROTOCOL;
  readonly kind: "queue";
  readonly batchId: string;
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly queue: string;
  readonly messages: readonly SelfhostQueueEventMessage[];
}

/** Private dispatch values never projected onto the tenant's QueueBatch/env. */
export interface SelfhostV2QueueEvent {
  readonly protocol: typeof SELFHOST_V2_QUEUE_EVENT_PROTOCOL;
  readonly kind: "queue";
  readonly batchId: string;
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly workerUid: string;
  readonly consumerUid: string;
  readonly queueUid: string;
  readonly queue: string;
  readonly messages: readonly (SelfhostQueueEventMessage & {
    readonly leaseToken: string;
    readonly invocationCapability: string;
  })[];
}

export function selfhostV2QueueEvent(input: {
  readonly batchId: string;
  readonly script: string;
  readonly publication: string;
  readonly workerUid: string;
  readonly consumerUid: string;
  readonly queueUid: string;
  readonly queue: string;
  readonly messages: SelfhostV2QueueEvent["messages"];
}): SelfhostV2QueueEvent {
  if (
    !EVENT_TOKEN.test(input.batchId) ||
    input.batchId.length > 256 ||
    !EVENT_TOKEN.test(input.script) ||
    !EVENT_TOKEN.test(input.publication) ||
    !EVENT_TOKEN.test(input.workerUid) ||
    !EVENT_TOKEN.test(input.consumerUid) ||
    !EVENT_TOKEN.test(input.queueUid) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.queue) ||
    input.messages.length < 1 ||
    input.messages.length > MAX_SELFHOST_QUEUE_MESSAGES
  )
    throw new SelfhostEventShapeError("self-host v2 queue event identity is invalid");
  const seen = new Set<string>();
  const messages: Array<SelfhostV2QueueEvent["messages"][number]> = [];
  for (const message of input.messages) {
    if (
      !EVENT_TOKEN.test(message.messageId) ||
      message.messageId.length > 256 ||
      seen.has(message.messageId) ||
      !EVENT_TOKEN.test(message.leaseToken) ||
      message.leaseToken.length > 256 ||
      typeof message.invocationCapability !== "string" ||
      message.invocationCapability.length < 32 ||
      message.invocationCapability.length > 4096 ||
      !Number.isSafeInteger(message.timestampMillis) ||
      message.timestampMillis < 0 ||
      !Number.isSafeInteger(message.attempts) ||
      message.attempts < 1 ||
      message.body.encoding !== "base64"
    )
      throw new SelfhostEventShapeError("self-host v2 queue message is invalid");
    seen.add(message.messageId);
    messages.push({
      messageId: message.messageId,
      timestampMillis: message.timestampMillis,
      attempts: message.attempts,
      body: { encoding: "base64", data: message.body.data },
      leaseToken: message.leaseToken,
      invocationCapability: message.invocationCapability,
    });
  }
  const event: SelfhostV2QueueEvent = {
    protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
    kind: "queue",
    batchId: input.batchId,
    logicalWorkerId: input.script,
    deploymentId: input.publication,
    workerUid: input.workerUid,
    consumerUid: input.consumerUid,
    queueUid: input.queueUid,
    queue: input.queue,
    messages,
  };
  if (
    new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_SELFHOST_EVENT_REQUEST_BYTES
  ) {
    throw new SelfhostEventShapeError("self-host v2 queue event is too large");
  }
  return event;
}

/**
 * Parses only the wrapper's protected completion sentence. The caller must
 * additionally prove this response came from its one-shot private event gate
 * for the exact batch; parsing an arbitrary HTTP body grants no authority.
 */
export function selfhostV2QueueCompletionAnswer(answer: {
  readonly status: number;
  readonly body: string;
}): "handler_resolved" | "handler_rejected" | null {
  if (answer.status !== 200 || answer.body.length > MAX_SELFHOST_EVENT_RESPONSE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(",") !== "completion,kind,outcome,protocol" ||
    fields.protocol !== SELFHOST_V2_QUEUE_EVENT_PROTOCOL ||
    fields.kind !== "queue" ||
    fields.completion !== "handler_and_wait_until"
  )
    return null;
  if (fields.outcome === "resolved") return "handler_resolved";
  if (fields.outcome === "rejected") return "handler_rejected";
  return null;
}

export interface SelfhostScheduleEvent {
  readonly protocol: typeof SELFHOST_WORKER_EVENT_PROTOCOL;
  readonly kind: "schedule";
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly cron: string;
  readonly scheduledTime: number;
}

export type SelfhostQueueDecision =
  | { readonly messageId: string; readonly outcome: "ack" }
  | { readonly messageId: string; readonly outcome: "retry"; readonly delaySeconds?: number };

export class SelfhostEventShapeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SelfhostEventShapeError";
  }
}

/**
 * Builds one queue event, refusing anything the wrapper would refuse.
 *
 * The size ceiling is checked here rather than after the request is sent: an
 * envelope the tenant's isolate will reject is a delivery that would come back
 * as a whole-batch retry, and the pump can split it instead.
 */
export function selfhostQueueEvent(input: {
  readonly batchId: string;
  readonly script: string;
  readonly publication: string;
  readonly queue: string;
  readonly messages: readonly SelfhostQueueEventMessage[];
}): SelfhostQueueEvent {
  if (
    !EVENT_TOKEN.test(input.batchId) ||
    !EVENT_TOKEN.test(input.script) ||
    !EVENT_TOKEN.test(input.publication) ||
    !EVENT_TOKEN.test(input.queue) ||
    input.messages.length < 1 ||
    input.messages.length > MAX_SELFHOST_QUEUE_MESSAGES
  ) {
    throw new SelfhostEventShapeError("self-host queue event identity is invalid");
  }
  const seen = new Set<string>();
  for (const message of input.messages) {
    if (
      !EVENT_TOKEN.test(message.messageId) ||
      seen.has(message.messageId) ||
      !Number.isSafeInteger(message.timestampMillis) ||
      message.timestampMillis < 0 ||
      !Number.isSafeInteger(message.attempts) ||
      message.attempts < 1 ||
      message.body.encoding !== "base64"
    ) {
      throw new SelfhostEventShapeError("self-host queue message is invalid");
    }
    seen.add(message.messageId);
  }
  const event: SelfhostQueueEvent = {
    protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
    kind: "queue",
    batchId: input.batchId,
    logicalWorkerId: input.script,
    deploymentId: input.publication,
    queue: input.queue,
    messages: input.messages,
  };
  if (
    new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_SELFHOST_EVENT_REQUEST_BYTES
  ) {
    throw new SelfhostEventShapeError("self-host queue event is too large");
  }
  return event;
}

export function selfhostScheduleEvent(input: {
  readonly script: string;
  readonly publication: string;
  readonly cron: string;
  readonly scheduledTime: number;
}): SelfhostScheduleEvent {
  if (
    !EVENT_TOKEN.test(input.script) ||
    !EVENT_TOKEN.test(input.publication) ||
    typeof input.cron !== "string" ||
    input.cron.length < 1 ||
    input.cron.length > 512 ||
    !Number.isSafeInteger(input.scheduledTime) ||
    input.scheduledTime < 0
  ) {
    throw new SelfhostEventShapeError("self-host schedule event identity is invalid");
  }
  return {
    protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
    kind: "schedule",
    logicalWorkerId: input.script,
    deploymentId: input.publication,
    cron: input.cron,
    scheduledTime: input.scheduledTime,
  };
}

/**
 * Reads the decisions answer, or null for anything that is not exactly one.
 *
 * Null is a whole-batch retry at the caller, not a partial settlement. A
 * message the tenant never decided about is one this Host must deliver again,
 * and an answer it cannot parse decides nothing.
 */
export function parseSelfhostQueueDecisions(
  body: string,
  expectedIds: readonly string[],
): readonly SelfhostQueueDecision[] | null {
  if (body.length > MAX_SELFHOST_EVENT_RESPONSE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ["protocol", "kind", "decisions"])) return null;
  if (
    parsed.protocol !== SELFHOST_WORKER_EVENT_PROTOCOL ||
    parsed.kind !== "queue" ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length !== expectedIds.length
  ) {
    return null;
  }
  const decisions: SelfhostQueueDecision[] = [];
  for (const value of parsed.decisions) {
    if (!isRecord(value) || typeof value.messageId !== "string") return null;
    if (value.outcome === "ack") {
      if (!exactKeys(value, ["messageId", "outcome"])) return null;
      decisions.push({ messageId: value.messageId, outcome: "ack" });
      continue;
    }
    if (value.outcome !== "retry") return null;
    if (
      !exactKeys(value, ["messageId", "outcome"]) &&
      !exactKeys(value, ["messageId", "outcome", "delaySeconds"])
    ) {
      return null;
    }
    const delaySeconds = value.delaySeconds;
    if (delaySeconds === undefined) {
      decisions.push({ messageId: value.messageId, outcome: "retry" });
      continue;
    }
    if (
      typeof delaySeconds !== "number" ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > MAX_SELFHOST_QUEUE_DELAY_SECONDS
    ) {
      return null;
    }
    decisions.push({ messageId: value.messageId, outcome: "retry", delaySeconds });
  }
  const answered = decisions.map((decision) => decision.messageId);
  if (new Set(answered).size !== answered.length) return null;
  if (answered.some((id, index) => id !== expectedIds[index])) return null;
  return decisions;
}

/** Whether one schedule answer is the acknowledgement the wrapper sends. */
export function selfhostScheduleAcknowledged(body: string): boolean {
  if (body.length > MAX_SELFHOST_EVENT_RESPONSE_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    isRecord(parsed) &&
    exactKeys(parsed, ["protocol", "kind", "outcome"]) &&
    parsed.protocol === SELFHOST_WORKER_EVENT_PROTOCOL &&
    parsed.kind === "schedule" &&
    parsed.outcome === "ack"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(value, key));
}

/**
 * The whole of the gate service, as bytes.
 *
 * Constant source, exactly like the data facade: nothing a tenant declares
 * reaches it, which is what makes it safe for this module to be the one holding
 * the token. It rewrites every request it forwards — fixed method, fixed URL,
 * fixed headers, the caller's JSON body and nothing more — so the tenant's
 * event entrypoint is reachable at one shape or not at all.
 */
export function selfhostEventServiceSource(): string {
  return `const EVENT_PATH = ${JSON.stringify(SELFHOST_WORKER_EVENT_PATH)};
const EVENT_URL = ${JSON.stringify(`http://takoserver-selfhost-events.invalid${SELFHOST_WORKER_EVENT_PATH}`)};
const V2_QUEUE_PATH = ${JSON.stringify(SELFHOST_V2_QUEUE_EVENT_PATH)};
const V2_QUEUE_URL = ${JSON.stringify(`http://takoserver-selfhost-events.invalid${SELFHOST_V2_QUEUE_EVENT_PATH}`)};
const CONTENT_TYPE = ${JSON.stringify(SELFHOST_WORKER_EVENT_CONTENT_TYPE)};
const V2_QUEUE_CONTENT_TYPE = ${JSON.stringify(SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE)};
const RESPONSE_CONTENT_TYPE = ${JSON.stringify(SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE)};
const PROTOCOL = ${JSON.stringify(SELFHOST_WORKER_EVENT_PROTOCOL)};
const V2_QUEUE_PROTOCOL = ${JSON.stringify(SELFHOST_V2_QUEUE_EVENT_PROTOCOL)};
const EVENT_HEADER = ${JSON.stringify(SELFHOST_WORKER_EVENT_HEADER)};
const TOKEN_HEADER = ${JSON.stringify(SELFHOST_WORKER_EVENT_TOKEN_HEADER)};
const TOKEN = ${JSON.stringify(SELFHOST_WORKER_EVENT_TOKEN_BINDING)};
const TARGET = ${JSON.stringify(SELFHOST_WORKER_EVENT_TARGET_BINDING)};
const MAX_REQUEST_BYTES = ${MAX_SELFHOST_EVENT_REQUEST_BYTES};
const MAX_RESPONSE_BYTES = ${MAX_SELFHOST_EVENT_RESPONSE_BYTES};

// One refusal shape for every reason. A caller cannot tell a wrong token from
// a missing configuration from a path that is not a route, and none of the
// answers carries a token, an address, or a diagnostic.
function refuse(status) {
  return new Response(null, { status });
}

// Length first, then every byte: an early return on the first differing
// character is a timing oracle on a bearer credential.
function sameToken(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (presented.length !== expected.length || presented.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export default {
  async fetch(request, env) {
    let path;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return refuse(404);
    }
    const v1 = path === EVENT_PATH;
    const v2Queue = path === V2_QUEUE_PATH;
    if (!v1 && !v2Queue) return refuse(404);
    if (request.method !== "POST") return refuse(404);
    if (request.headers.get("content-type") !== (v1 ? CONTENT_TYPE : V2_QUEUE_CONTENT_TYPE)) return refuse(404);
    if (request.headers.get(EVENT_HEADER) !== (v1 ? PROTOCOL : V2_QUEUE_PROTOCOL)) return refuse(404);
    if (!sameToken(request.headers.get(TOKEN_HEADER), env[TOKEN])) return refuse(404);
    const target = env[TARGET];
    if (!target) return refuse(503);
    let body;
    try {
      body = await request.arrayBuffer();
    } catch {
      return refuse(400);
    }
    if (body.byteLength > MAX_REQUEST_BYTES) return refuse(413);
    // Rebuilt, never forwarded. What crosses is the bytes and nothing else:
    // not the destination, not the method, not one header of the caller's.
    let response;
    try {
      response = await target.fetch(v1 ? EVENT_URL : V2_QUEUE_URL, {
        method: "POST",
        headers: {
          "content-type": v1 ? CONTENT_TYPE : V2_QUEUE_CONTENT_TYPE,
          accept: RESPONSE_CONTENT_TYPE,
          [EVENT_HEADER]: v1 ? PROTOCOL : V2_QUEUE_PROTOCOL,
        },
        body,
      });
    } catch {
      return refuse(502);
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return refuse(502);
    }
    if (text.length > MAX_RESPONSE_BYTES) return refuse(502);
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  },
};
`;
}
