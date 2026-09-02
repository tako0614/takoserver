/**
 * Takoserver's Cloudflare Workers for Platforms dispatch gateway.
 *
 * The SQL-backed provider is the routing authority.  This module reads the
 * same state database through a first-primary session and uses the Cloudflare
 * dispatch namespace to invoke an immutable customer script.  It deliberately
 * does not derive a public origin, call workers.dev, or know any Takosumi
 * contract.
 */

export const TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL =
  "takoserver.managed-worker-event@v1" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_PATH =
  "/.well-known/takoserver/managed-worker-events/v1" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE =
  "application/vnd.takoserver.managed-worker-event.v1+json" as const;
export const TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE =
  "application/vnd.takoserver.managed-worker-event-response.v1+json" as const;

export const TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA =
  "takoserver.managed-worker-gateway-props@v1" as const;
/** Property name delivered as `ctx.props` to a WfP customer Worker. */
export const TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP = "takoserverManagedWorkerGateway" as const;

export const TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS = Object.freeze({
  host: "takoserver.managed-worker-host-route@v1",
  worker: "takoserver.managed-worker-release-route@v1",
  queue: "takoserver.managed-worker-queue-route@v1",
  schedule: "takoserver.managed-worker-schedule-route@v1",
  tombstone: "takoserver.managed-worker-route-tombstone@v1",
} as const);
export const TAKOSERVER_MANAGED_WORKER_ROUTE_TOMBSTONE_SCHEMA =
  TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone;

const HOST_ROUTE_PREFIX = "host/v1/";
const WORKER_ROUTE_PREFIX = "worker/v1/";
const QUEUE_ROUTE_PREFIX = "queue/v1/";
const SCHEDULE_ROUTE_PREFIX = "schedule/v1/";
export type ManagedWorkerRouteKind = "host" | "worker" | "queue" | "schedule";
const MAX_TOKEN_BYTES = 512;
const MAX_HOSTNAME_BYTES = 253;
const MAX_RELEASES = 32;
const MAX_SCHEDULE_WORKERS = 128;
const MAX_QUEUE_MESSAGES = 100;
const MAX_EVENT_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_SECONDS = 86_400;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const textEncoder = new TextEncoder();

export interface ManagedWorkerHostRoute {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.host;
  readonly generation: number;
  readonly logicalWorkerId: string;
}

export interface ManagedWorkerRelease {
  readonly scriptName: string;
  readonly percentage: number;
}

export interface ManagedWorkerReleaseRoute {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.worker;
  readonly generation: number;
  readonly deploymentId: string;
  readonly releases: readonly ManagedWorkerRelease[];
}

export interface ManagedWorkerQueueRoute {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue;
  readonly generation: number;
  readonly logicalWorkerId: string;
}

export interface ManagedWorkerScheduleRoute {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.schedule;
  readonly generation: number;
  readonly logicalWorkerIds: readonly string[];
}

export interface ManagedWorkerRouteTombstone {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone;
  readonly generation: number;
}

/** Build the exact host replica key. Hostnames are canonicalized to lowercase. */
export function managedWorkerHostRouteKey(hostname: string): string {
  return `${HOST_ROUTE_PREFIX}${canonicalHostname(hostname)}`;
}

/** Build the exact logical-worker release replica key. */
export function managedWorkerReleaseRouteKey(logicalWorkerId: string): string {
  return `${WORKER_ROUTE_PREFIX}${routeToken(logicalWorkerId, "logicalWorkerId")}`;
}

/** Build the exact Queue replica key. */
export function managedWorkerQueueRouteKey(queueName: string): string {
  if (!isQueueName(queueName)) throw new TypeError("queue name is invalid");
  return `${QUEUE_ROUTE_PREFIX}${queueName}`;
}

/** Build the exact Schedule replica key, preserving the encoded cron token. */
export function managedWorkerScheduleRouteKey(cron: string): string {
  const normalized = canonicalCron(cron);
  return `${SCHEDULE_ROUTE_PREFIX}${encodeURIComponent(normalized)}`;
}

/** Parse and validate one provider-authored host route document. */
export function parseManagedWorkerHostRoute(value: unknown): ManagedWorkerHostRoute {
  if (!isRecord(value)) throw new TypeError("managed Worker host route is invalid");
  exactKeys(value, ["schema", "generation", "logicalWorkerId"]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.host ||
    !isGeneration(value.generation) ||
    !isRouteToken(value.logicalWorkerId)
  ) {
    throw new TypeError("managed Worker host route is invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.host,
    generation: value.generation,
    logicalWorkerId: value.logicalWorkerId,
  });
}

/** Parse and validate one provider-authored release route document. */
export function parseManagedWorkerReleaseRoute(value: unknown): ManagedWorkerReleaseRoute {
  if (!isRecord(value)) throw new TypeError("managed Worker release route is invalid");
  exactKeys(value, ["schema", "generation", "deploymentId", "releases"]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.worker ||
    !isGeneration(value.generation) ||
    !isRouteToken(value.deploymentId) ||
    !Array.isArray(value.releases) ||
    value.releases.length < 1 ||
    value.releases.length > MAX_RELEASES
  ) {
    throw new TypeError("managed Worker release route is invalid");
  }
  const releases = value.releases.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("managed Worker release is invalid");
    exactKeys(entry, ["scriptName", "percentage"]);
    const scriptName = entry.scriptName;
    const percentage = entry.percentage;
    if (
      !isRouteToken(scriptName) ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      !Number.isSafeInteger(percentage * 100) ||
      percentage <= 0 ||
      percentage > 100
    ) {
      throw new TypeError("managed Worker release is invalid");
    }
    return Object.freeze({
      scriptName,
      percentage,
    });
  });
  if (
    new Set(releases.map(({ scriptName }) => scriptName)).size !== releases.length ||
    releases.reduce((sum, release) => sum + release.percentage * 100, 0) !== 10_000
  ) {
    throw new TypeError("managed Worker release percentages are invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.worker,
    generation: value.generation,
    deploymentId: value.deploymentId,
    releases: Object.freeze(releases),
  });
}

/** Parse and validate one provider-authored Queue route document. */
export function parseManagedWorkerQueueRoute(value: unknown): ManagedWorkerQueueRoute {
  if (!isRecord(value)) throw new TypeError("managed Worker Queue route is invalid");
  exactKeys(value, ["schema", "generation", "logicalWorkerId"]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue ||
    !isGeneration(value.generation) ||
    !isRouteToken(value.logicalWorkerId)
  ) {
    throw new TypeError("managed Worker Queue route is invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue,
    generation: value.generation,
    logicalWorkerId: value.logicalWorkerId,
  });
}

/** Parse and validate one provider-authored Schedule route document. */
export function parseManagedWorkerScheduleRoute(value: unknown): ManagedWorkerScheduleRoute {
  if (!isRecord(value)) throw new TypeError("managed Worker Schedule route is invalid");
  exactKeys(value, ["schema", "generation", "logicalWorkerIds"]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.schedule ||
    !isGeneration(value.generation) ||
    !Array.isArray(value.logicalWorkerIds) ||
    value.logicalWorkerIds.length < 1 ||
    value.logicalWorkerIds.length > MAX_SCHEDULE_WORKERS
  ) {
    throw new TypeError("managed Worker Schedule route is invalid");
  }
  const logicalWorkerIds = value.logicalWorkerIds.map((entry) => {
    if (!isRouteToken(entry)) throw new TypeError("managed Worker Schedule worker is invalid");
    return entry;
  });
  const sorted = [...logicalWorkerIds].sort();
  if (
    new Set(logicalWorkerIds).size !== logicalWorkerIds.length ||
    !sameStrings(logicalWorkerIds, sorted)
  ) {
    throw new TypeError("managed Worker Schedule workers are not canonical");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.schedule,
    generation: value.generation,
    logicalWorkerIds: Object.freeze(logicalWorkerIds),
  });
}

/** Parse the fail-closed marker written while a provider route is absent. */
export function parseManagedWorkerRouteTombstone(value: unknown): ManagedWorkerRouteTombstone {
  if (!isRecord(value)) throw new TypeError("managed Worker route tombstone is invalid");
  exactKeys(value, ["schema", "generation"]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone ||
    !isGeneration(value.generation)
  ) {
    throw new TypeError("managed Worker route tombstone is invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone,
    generation: value.generation,
  });
}

export interface ManagedWorkerGatewayIdentity {
  /** Operator-selected gateway identity; it is not Cloudflare account state. */
  readonly gatewayId: string;
  /** Environment label used only for trusted execution props. */
  readonly environment: string;
}

export type ManagedWorkerGatewayEntrypoint = "fetch" | "queue" | "scheduled";

export interface ManagedWorkerGatewayProps {
  readonly schema: typeof TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA;
  readonly gatewayId: string;
  readonly environment: string;
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly entrypoint: ManagedWorkerGatewayEntrypoint;
}

/** Build the only object passed to a WfP DispatchNamespace as `ctx.props`. */
export function managedWorkerGatewayProps(input: {
  readonly identity?: ManagedWorkerGatewayIdentity | string;
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly entrypoint: ManagedWorkerGatewayEntrypoint;
}): ManagedWorkerGatewayProps {
  const identity = normalizeIdentity(input.identity);
  const logicalWorkerId = routeToken(input.logicalWorkerId, "logicalWorkerId");
  const deploymentId = routeToken(input.deploymentId, "deploymentId");
  if (
    input.entrypoint !== "fetch" &&
    input.entrypoint !== "queue" &&
    input.entrypoint !== "scheduled"
  ) {
    throw new TypeError("managed Worker gateway entrypoint is invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA,
    gatewayId: identity.gatewayId,
    environment: identity.environment,
    logicalWorkerId,
    deploymentId,
    entrypoint: input.entrypoint,
  });
}

/** Strictly parse trusted WfP props before forwarding them to user code. */
export function parseManagedWorkerGatewayProps(value: unknown): ManagedWorkerGatewayProps {
  if (!isRecord(value)) throw new TypeError("managed Worker gateway props are invalid");
  exactKeys(value, [
    "schema",
    "gatewayId",
    "environment",
    "logicalWorkerId",
    "deploymentId",
    "entrypoint",
  ]);
  if (
    value.schema !== TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA ||
    !isRouteToken(value.gatewayId) ||
    !isRouteToken(value.environment) ||
    !isRouteToken(value.logicalWorkerId) ||
    !isRouteToken(value.deploymentId) ||
    (value.entrypoint !== "fetch" &&
      value.entrypoint !== "queue" &&
      value.entrypoint !== "scheduled")
  ) {
    throw new TypeError("managed Worker gateway props are invalid");
  }
  return Object.freeze({
    schema: TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA,
    gatewayId: value.gatewayId,
    environment: value.environment,
    logicalWorkerId: value.logicalWorkerId,
    deploymentId: value.deploymentId,
    entrypoint: value.entrypoint,
  });
}

export interface ManagedWorkerQueueMessage {
  readonly messageId: string;
  readonly timestampMillis: number;
  readonly attempts: number;
  /** Family-wide encoded-bytes shape; binary values never cross as `{}`. */
  readonly body: ManagedWorkerQueueBody;
}

export interface ManagedWorkerQueueBody {
  readonly encoding: "base64";
  readonly data: string;
}

export interface ManagedWorkerQueueEvent {
  readonly protocol: typeof TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL;
  readonly kind: "queue";
  readonly batchId: string;
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly queue: string;
  readonly messages: readonly ManagedWorkerQueueMessage[];
}

export interface ManagedWorkerScheduleEvent {
  readonly protocol: typeof TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL;
  readonly kind: "schedule";
  readonly logicalWorkerId: string;
  readonly deploymentId: string;
  readonly cron: string;
  readonly scheduledTime: number;
}

export type ManagedWorkerEvent = ManagedWorkerQueueEvent | ManagedWorkerScheduleEvent;

export type ManagedWorkerQueueDecision =
  | { readonly messageId: string; readonly outcome: "ack" }
  | { readonly messageId: string; readonly outcome: "retry"; readonly delaySeconds?: number };

export interface ManagedWorkerQueueEventResponse {
  readonly protocol: typeof TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL;
  readonly kind: "queue";
  readonly decisions: readonly ManagedWorkerQueueDecision[];
}

export interface ManagedWorkerScheduleEventResponse {
  readonly protocol: typeof TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL;
  readonly kind: "schedule";
  readonly outcome: "ack";
}

export type ManagedWorkerEventResponse =
  | ManagedWorkerQueueEventResponse
  | ManagedWorkerScheduleEventResponse;

export interface ManagedWorkerDispatchFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ManagedWorkerDispatchNamespace {
  get(scriptName: string, props?: Readonly<Record<string, unknown>>): ManagedWorkerDispatchFetcher;
}

export interface ManagedWorkerMessage {
  readonly id: string;
  readonly timestamp: Date;
  readonly attempts: number;
  readonly body: unknown;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface ManagedWorkerMessageBatch {
  readonly batchId: string;
  readonly queue: string;
  readonly messages: readonly ManagedWorkerMessage[];
}

export interface ManagedWorkerScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

/** Strong per-key lease supplied by a Durable Object or conditional D1 owner. */
export interface ManagedWorkerScheduleLease {
  acquire(
    cron: string,
    logicalWorkerId: string,
    nowMillis: number,
  ): Promise<{ readonly token: string } | null>;
  release(cron: string, logicalWorkerId: string, token: string): Promise<void>;
}

export type ManagedWorkerRouteRead =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "tombstone"; readonly generation: number }
  | {
      readonly kind: "valid";
      readonly value:
        | ManagedWorkerHostRoute
        | ManagedWorkerReleaseRoute
        | ManagedWorkerQueueRoute
        | ManagedWorkerScheduleRoute;
    };

export interface ManagedWorkerGatewayState {
  readRoute(kind: ManagedWorkerRouteKind, key: string): Promise<ManagedWorkerRouteRead>;
  readonly scheduleLease: ManagedWorkerScheduleLease;
  /** Reuse one first-primary session for all route reads in an event. */
  readonly withPrimarySession?: <T>(
    run: (state: ManagedWorkerGatewayState) => Promise<T>,
  ) => Promise<T>;
}

export interface ManagedWorkerD1Statement {
  bind(...values: readonly unknown[]): ManagedWorkerD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<_T = Record<string, unknown>>(): Promise<{ readonly meta?: { readonly changes?: number } }>;
}

export interface ManagedWorkerD1Session {
  prepare(query: string): ManagedWorkerD1Statement;
}

export interface ManagedWorkerD1Database {
  withSession(constraint: "first-primary"): ManagedWorkerD1Session;
}

// Longer than the platform's maximum scheduled invocation window plus skew;
// the exact-token release still fences a delayed completion.
export const MANAGED_WORKER_SCHEDULE_LEASE_TTL_MILLIS = 1_200_000;

export interface ManagedWorkerD1StateOptions {
  readonly database: ManagedWorkerD1Database;
  readonly providerId: string;
  readonly leaseTtlMillis?: number;
}

/**
 * Adapt the provider's D1 state tables to the gateway runtime.  A route read
 * is always performed through a first-primary session; the event wrapper
 * below reuses one such session for host/queue/schedule -> release lookups.
 */
export function createD1ManagedWorkerGatewayState(
  input: ManagedWorkerD1StateOptions,
): ManagedWorkerGatewayState {
  if (!input?.database || typeof input.database.withSession !== "function") {
    throw new TypeError("managed Worker STATE_DB binding is required");
  }
  const providerId = routeToken(input.providerId, "providerId");
  const leaseTtlMillis = input.leaseTtlMillis ?? MANAGED_WORKER_SCHEDULE_LEASE_TTL_MILLIS;
  if (!Number.isSafeInteger(leaseTtlMillis) || leaseTtlMillis <= 0) {
    throw new TypeError("managed Worker lease TTL is invalid");
  }

  const scheduleLease = createD1ScheduleLease(input.database, providerId, leaseTtlMillis);

  const readRoute = async (
    kind: ManagedWorkerRouteKind,
    key: string,
  ): Promise<ManagedWorkerRouteRead> => {
    const session = input.database.withSession("first-primary");
    return readRouteFromSession(session, providerId, kind, key);
  };

  const state: ManagedWorkerGatewayState = {
    readRoute,
    scheduleLease,
    withPrimarySession: async <T>(run: (state: ManagedWorkerGatewayState) => Promise<T>) => {
      const session = input.database.withSession("first-primary");
      const scoped: ManagedWorkerGatewayState = {
        readRoute: (kind, key) => readRouteFromSession(session, providerId, kind, key),
        scheduleLease,
      };
      return run(scoped);
    },
  };
  return state;
}

export interface CloudflareManagedWorkerGatewayOptions {
  readonly state: ManagedWorkerGatewayState;
  readonly dispatcher: ManagedWorkerDispatchNamespace;
  readonly identity?: ManagedWorkerGatewayIdentity | string;
}

export interface CloudflareManagedWorkerGateway {
  fetch(request: Request): Promise<Response>;
  queue(batch: ManagedWorkerMessageBatch): Promise<void>;
  scheduled(controller: ManagedWorkerScheduledController): Promise<void>;
}

/**
 * Compose the Cloudflare WfP gateway.  All route reads and dispatch calls are
 * awaited; a missing or malformed replica is a non-delivery, never a fallback.
 */
export function createCloudflareManagedWorkerGateway(
  input: CloudflareManagedWorkerGatewayOptions,
): CloudflareManagedWorkerGateway {
  const state = input?.state;
  const dispatcher = input?.dispatcher;
  if (!input || !state || typeof state.readRoute !== "function") {
    throw new TypeError("managed Worker STATE_DB route state is required");
  }
  if (!dispatcher || typeof dispatcher.get !== "function") {
    throw new TypeError("managed Worker DISPATCHER binding is required");
  }
  const identity = normalizeIdentity(input.identity);

  return {
    fetch: (request) =>
      withPrimarySession(state, (scoped) => dispatchHttp(request, scoped, dispatcher, identity)),
    queue: (batch) =>
      withPrimarySession(state, (scoped) => dispatchQueue(batch, scoped, dispatcher, identity)),
    scheduled: (controller) =>
      withPrimarySession(state, (scoped) =>
        dispatchSchedule(controller, scoped, dispatcher, identity),
      ),
  };
}

function withPrimarySession<T>(
  state: ManagedWorkerGatewayState,
  run: (state: ManagedWorkerGatewayState) => Promise<T>,
): Promise<T> {
  return state.withPrimarySession ? state.withPrimarySession(run) : run(state);
}

export { managedWorkerEntrypointSource } from "./cloudflare-managed-worker-wrapper.ts";

async function dispatchHttp(
  request: Request,
  state: ManagedWorkerGatewayState,
  dispatcher: ManagedWorkerDispatchNamespace,
  identity: ManagedWorkerGatewayIdentity,
): Promise<Response> {
  let hostname: string;
  try {
    hostname = canonicalHostname(new URL(request.url).hostname);
  } catch {
    return notFound();
  }
  let hostRoute: ManagedWorkerHostRoute;
  try {
    const hostRead = await readStateRoute(state, "host", managedWorkerHostRouteKey(hostname));
    if (hostRead.kind === "missing" || hostRead.kind === "tombstone") return notFound();
    if (hostRead.kind === "malformed") return unavailable();
    hostRoute = hostRead.value;
  } catch {
    return unavailable();
  }
  let release: ManagedWorkerReleaseRoute;
  try {
    const releaseRead = await readStateRoute(
      state,
      "worker",
      managedWorkerReleaseRouteKey(hostRoute.logicalWorkerId),
    );
    if (releaseRead.kind === "missing" || releaseRead.kind === "tombstone") return notFound();
    if (releaseRead.kind === "malformed") return unavailable();
    release = releaseRead.value;
  } catch {
    return unavailable();
  }
  const selected = selectHttpRelease(
    release.releases,
    `fetch|${hostname}|${request.method}|${new URL(request.url).pathname}${new URL(request.url).search}`,
  );
  if (!selected) return notFound();
  try {
    const props = {
      [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
        identity,
        logicalWorkerId: hostRoute.logicalWorkerId,
        deploymentId: release.deploymentId,
        entrypoint: "fetch",
      }),
    };
    return await dispatcher.get(selected.scriptName, props).fetch(request);
  } catch {
    return unavailable();
  }
}

async function dispatchQueue(
  batch: ManagedWorkerMessageBatch,
  state: ManagedWorkerGatewayState,
  dispatcher: ManagedWorkerDispatchNamespace,
  identity: ManagedWorkerGatewayIdentity,
): Promise<void> {
  if (!isRouteToken(batch.batchId) || !isQueueName(batch.queue) || batch.messages.length === 0) {
    settleRetry(batch.messages);
    return;
  }
  let routeRead: ManagedWorkerRouteReadFor<"queue">;
  try {
    routeRead = await readStateRoute(state, "queue", managedWorkerQueueRouteKey(batch.queue));
  } catch {
    settleRetry(batch.messages);
    return;
  }
  if (routeRead.kind !== "valid") {
    settleRetry(batch.messages);
    return;
  }
  const route = routeRead.value;
  const release = await safeRelease(state, route.logicalWorkerId);
  if (!release) {
    settleRetry(batch.messages);
    return;
  }
  // Queues hands this gateway the batch; it cannot ask for a smaller one. What
  // it can do is take the batch apart. A batch over the message ceiling, or one
  // whose bodies do not fit the 2 MiB envelope, used to be settled with a
  // whole-batch `retry()` — so a consumer with a large `maxBatchSize` and large
  // bodies retried itself into the dead-letter queue without the Worker ever
  // being invoked. Each chunk below is an envelope this gateway can actually
  // send, and each is settled on its own answer.
  const chunks = splitQueueBatch(batch, route.logicalWorkerId, release.deploymentId);
  let settlementError: unknown;
  for (const chunk of chunks) {
    try {
      await dispatchQueueChunk(chunk, route, release, dispatcher, identity);
    } catch (error) {
      settlementError ??= error;
    }
  }
  if (settlementError !== undefined) {
    throw settlementError instanceof Error
      ? settlementError
      : new Error("managed Worker Queue settlement failed");
  }
}

interface ManagedWorkerQueueChunk {
  readonly event: ManagedWorkerQueueEvent | null;
  readonly messages: readonly ManagedWorkerMessage[];
}

async function dispatchQueueChunk(
  chunk: ManagedWorkerQueueChunk,
  route: ManagedWorkerQueueRoute,
  release: ManagedWorkerReleaseRoute,
  dispatcher: ManagedWorkerDispatchNamespace,
  identity: ManagedWorkerGatewayIdentity,
): Promise<void> {
  const event = chunk.event;
  // One message larger than the whole envelope is undeliverable by any split.
  // It is left unsettled here, which is what a redelivery and, eventually, the
  // dead-letter queue are for; the messages beside it are unaffected.
  if (!event) {
    settleRetry(chunk.messages);
    return;
  }
  const selected = selectRelease(
    release.releases,
    `queue|${event.queue}|${event.messages.map(({ messageId }) => messageId).join("|")}`,
  );
  if (!selected) {
    settleRetry(chunk.messages);
    return;
  }
  let response: Response;
  try {
    const props = {
      [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
        identity,
        logicalWorkerId: route.logicalWorkerId,
        deploymentId: release.deploymentId,
        entrypoint: "queue",
      }),
    };
    response = await dispatcher.get(selected.scriptName, props).fetch(eventRequest(event));
  } catch {
    settleRetry(chunk.messages);
    return;
  }
  if (!response.ok) {
    settleRetry(chunk.messages);
    return;
  }
  const decisions = await readQueueDecisions(
    response,
    event.messages.map(({ messageId }) => messageId),
  );
  if (!decisions) {
    settleRetry(chunk.messages);
    return;
  }
  const byId = new Map(decisions.map((decision) => [decision.messageId, decision]));
  let settlementError: unknown;
  for (const message of chunk.messages) {
    try {
      const decision = byId.get(message.id);
      if (!decision || decision.outcome === "retry") {
        if (decision?.delaySeconds === undefined) message.retry();
        else message.retry({ delaySeconds: decision.delaySeconds });
      } else {
        message.ack();
      }
    } catch (error) {
      // Continue settling the remaining messages. A partial native failure
      // must be surfaced after every best-effort settlement attempt.
      settlementError ??= error;
    }
  }
  if (settlementError !== undefined) {
    throw new Error("managed Worker Queue settlement failed");
  }
}

/**
 * Cuts one native batch into envelopes this gateway can send.
 *
 * A chunk holds at most `MAX_QUEUE_MESSAGES` messages and serializes to at most
 * `MAX_EVENT_REQUEST_BYTES`. The sizes are measured on the projected message
 * objects rather than by re-serializing the whole event per candidate, and the
 * envelope's own overhead is measured with the longest batch id any chunk can
 * be given — so a chunk is never packed to a size the final `queueEvent` call
 * would refuse. A message this Host cannot project, or one that alone exceeds
 * the envelope, becomes its own chunk with no event.
 */
function splitQueueBatch(
  batch: ManagedWorkerMessageBatch,
  logicalWorkerId: string,
  deploymentId: string,
): readonly ManagedWorkerQueueChunk[] {
  const projected = batch.messages.map((message) => {
    try {
      const value = queueEventMessage(message);
      return { message, value, bytes: utf8Length(JSON.stringify(value)) };
    } catch {
      return { message, value: null, bytes: Number.POSITIVE_INFINITY };
    }
  });
  const maximumChunks = Math.max(
    1,
    Math.ceil(batch.messages.length / MAX_QUEUE_MESSAGES),
    batch.messages.length,
  );
  const idSuffixBytes = `-${maximumChunks}`.length;
  let overhead: number;
  try {
    overhead =
      utf8Length(
        JSON.stringify(
          queueEnvelope(batch.batchId, batch.queue, logicalWorkerId, deploymentId, []),
        ),
      ) + idSuffixBytes;
  } catch {
    return [{ event: null, messages: batch.messages }];
  }
  const groups: { message: ManagedWorkerMessage; value: ManagedWorkerQueueMessage | null }[][] = [];
  let current: { message: ManagedWorkerMessage; value: ManagedWorkerQueueMessage | null }[] = [];
  let currentBytes = 0;
  for (const entry of projected) {
    if (entry.value === null || overhead + entry.bytes > MAX_EVENT_REQUEST_BYTES) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentBytes = 0;
      groups.push([{ message: entry.message, value: null }]);
      continue;
    }
    const separator = current.length === 0 ? 0 : 1;
    if (
      current.length === MAX_QUEUE_MESSAGES ||
      overhead + currentBytes + separator + entry.bytes > MAX_EVENT_REQUEST_BYTES
    ) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentBytes = 0;
    }
    currentBytes += (current.length === 0 ? 0 : 1) + entry.bytes;
    current.push({ message: entry.message, value: entry.value });
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => {
    const messages = group.map(({ message }) => message);
    const values = group.map(({ value }) => value);
    if (values.some((value) => value === null)) return { event: null, messages };
    const batchId = groups.length === 1 ? batch.batchId : `${batch.batchId}-${index + 1}`;
    try {
      return {
        event: queueEnvelope(
          batchId,
          batch.queue,
          logicalWorkerId,
          deploymentId,
          values as readonly ManagedWorkerQueueMessage[],
        ),
        messages,
      };
    } catch {
      return { event: null, messages };
    }
  });
}

async function dispatchSchedule(
  controller: ManagedWorkerScheduledController,
  state: ManagedWorkerGatewayState,
  dispatcher: ManagedWorkerDispatchNamespace,
  identity: ManagedWorkerGatewayIdentity,
): Promise<void> {
  let cron: string;
  try {
    cron = canonicalCron(controller.cron);
  } catch {
    throw new Error("managed Worker Schedule is invalid");
  }
  if (!Number.isSafeInteger(controller.scheduledTime) || controller.scheduledTime < 0) {
    throw new Error("managed Worker Schedule time is invalid");
  }
  let route: ManagedWorkerScheduleRoute;
  try {
    const routeRead = await readStateRoute(state, "schedule", managedWorkerScheduleRouteKey(cron));
    if (routeRead.kind === "missing" || routeRead.kind === "tombstone") return;
    if (routeRead.kind === "malformed") {
      throw new Error("managed Worker Schedule route is malformed");
    }
    route = routeRead.value;
  } catch {
    throw new Error("managed Worker Schedule route is unavailable");
  }
  let firstError: unknown;
  for (const logicalWorkerId of route.logicalWorkerIds) {
    let lease: { readonly token: string } | null;
    try {
      lease = await state.scheduleLease.acquire(cron, logicalWorkerId, Date.now());
    } catch (error) {
      firstError ??= error;
      continue;
    }
    if (!lease) continue;
    let releaseError: unknown;
    try {
      const release = await safeReleaseOrThrow(state, logicalWorkerId);
      const selected = selectRelease(
        release.releases,
        `scheduled|${cron}|${controller.scheduledTime}|${logicalWorkerId}`,
      );
      if (!selected) throw new Error("managed Worker release is unavailable");
      const event: ManagedWorkerScheduleEvent = {
        protocol: TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
        kind: "schedule",
        logicalWorkerId,
        deploymentId: release.deploymentId,
        cron,
        scheduledTime: controller.scheduledTime,
      };
      const props = {
        [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
          identity,
          logicalWorkerId,
          deploymentId: release.deploymentId,
          entrypoint: "scheduled",
        }),
      };
      const response = await dispatcher.get(selected.scriptName, props).fetch(eventRequest(event));
      if (!response.ok) throw new Error("managed Worker Schedule dispatch failed");
    } catch (error) {
      releaseError = error;
    } finally {
      try {
        await state.scheduleLease.release(cron, logicalWorkerId, lease.token);
      } catch (error) {
        releaseError ??= error;
      }
    }
    firstError ??= releaseError;
  }
  if (firstError !== undefined) throw firstError;
}

function queueEventMessage(message: ManagedWorkerMessage): ManagedWorkerQueueMessage {
  if (
    !isRouteToken(message.id) ||
    !Number.isSafeInteger(message.attempts) ||
    message.attempts < 1 ||
    message.attempts > 101 ||
    !(message.timestamp instanceof Date) ||
    !Number.isFinite(message.timestamp.getTime())
  ) {
    throw new TypeError("managed Worker Queue message is invalid");
  }
  return {
    messageId: message.id,
    timestampMillis: message.timestamp.getTime(),
    attempts: message.attempts,
    body: encodeQueueBody(message.body),
  };
}

function queueEnvelope(
  batchId: string,
  queue: string,
  logicalWorkerId: string,
  deploymentId: string,
  messages: readonly ManagedWorkerQueueMessage[],
): ManagedWorkerQueueEvent {
  if (!isRouteToken(batchId)) {
    throw new TypeError("managed Worker Queue batch id is invalid");
  }
  if (messages.length > MAX_QUEUE_MESSAGES) {
    throw new TypeError("managed Worker Queue event holds too many messages");
  }
  const event: ManagedWorkerQueueEvent = {
    protocol: TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
    kind: "queue",
    batchId,
    logicalWorkerId: routeToken(logicalWorkerId, "logicalWorkerId"),
    deploymentId: routeToken(deploymentId, "deploymentId"),
    queue,
    messages,
  };
  if (utf8Length(JSON.stringify(event)) > MAX_EVENT_REQUEST_BYTES) {
    throw new TypeError("managed Worker Queue event is too large");
  }
  return event;
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function encodeQueueBody(value: unknown): ManagedWorkerQueueBody {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    bytes = textEncoder.encode(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError("managed Worker Queue body must be bytes or string");
  }
  return { encoding: "base64", data: base64(bytes) };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function eventRequest(event: ManagedWorkerEvent): Request {
  return new Request(
    `https://takoserver-managed-worker.internal${TAKOSERVER_MANAGED_WORKER_EVENT_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
        accept: TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
        "x-takoserver-managed-worker-event": TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
      },
      body: JSON.stringify(event),
    },
  );
}

async function readQueueDecisions(
  response: Response,
  expectedIds: readonly string[],
): Promise<readonly ManagedWorkerQueueDecision[] | undefined> {
  const parsed = await readBoundedJson(response, MAX_EVENT_RESPONSE_BYTES);
  if (!parsed || !isRecord(parsed)) return undefined;
  try {
    exactKeys(parsed, ["protocol", "kind", "decisions"]);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL ||
    parsed.kind !== "queue" ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length !== expectedIds.length
  ) {
    return undefined;
  }
  const decisions: ManagedWorkerQueueDecision[] = [];
  for (const value of parsed.decisions) {
    if (!isRecord(value)) return undefined;
    if (value.outcome === "ack") {
      try {
        exactKeys(value, ["messageId", "outcome"]);
      } catch {
        return undefined;
      }
      if (!isRouteToken(value.messageId)) return undefined;
      decisions.push({ messageId: value.messageId, outcome: "ack" });
      continue;
    }
    if (value.outcome === "retry") {
      const ownKeys = Reflect.ownKeys(value);
      if (!ownKeys.every((key): key is string => typeof key === "string")) return undefined;
      const keys = ownKeys;
      const messageId = value.messageId;
      const delaySeconds = value.delaySeconds;
      let parsedDelay: number | undefined;
      if (delaySeconds !== undefined) {
        if (
          typeof delaySeconds !== "number" ||
          !Number.isSafeInteger(delaySeconds) ||
          delaySeconds <= 0 ||
          delaySeconds > MAX_RETRY_DELAY_SECONDS
        ) {
          return undefined;
        }
        parsedDelay = delaySeconds;
      }
      if (
        !keys.every((key) => key === "messageId" || key === "outcome" || key === "delaySeconds") ||
        !isRouteToken(messageId) ||
        delaySeconds === null
      ) {
        return undefined;
      }
      decisions.push({
        messageId,
        outcome: "retry",
        ...(parsedDelay === undefined ? {} : { delaySeconds: parsedDelay }),
      });
      continue;
    }
    return undefined;
  }
  if (
    new Set(decisions.map(({ messageId }) => messageId)).size !== decisions.length ||
    !sameStrings(
      decisions.map(({ messageId }) => messageId),
      expectedIds,
    )
  ) {
    return undefined;
  }
  return decisions;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response_too_large").catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel("response_read_failed").catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

type ManagedWorkerRouteForKind = {
  readonly host: ManagedWorkerHostRoute;
  readonly worker: ManagedWorkerReleaseRoute;
  readonly queue: ManagedWorkerQueueRoute;
  readonly schedule: ManagedWorkerScheduleRoute;
};

type ManagedWorkerRouteReadFor<K extends ManagedWorkerRouteKind> =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "tombstone"; readonly generation: number }
  | { readonly kind: "valid"; readonly value: ManagedWorkerRouteForKind[K] };

async function readStateRoute<K extends ManagedWorkerRouteKind>(
  state: ManagedWorkerGatewayState,
  kind: K,
  key: string,
): Promise<ManagedWorkerRouteReadFor<K>> {
  // The state adapter is responsible for parsing the route for its requested
  // kind.  The cast only narrows the discriminated value for callers; no
  // untrusted data crosses this boundary without validation in the adapter.
  return (await state.readRoute(kind, key)) as ManagedWorkerRouteReadFor<K>;
}

async function readRouteFromSession(
  session: ManagedWorkerD1Session,
  providerId: string,
  kind: ManagedWorkerRouteKind,
  key: string,
): Promise<ManagedWorkerRouteRead> {
  const row = await session
    .prepare(
      `SELECT owner_native_id, generation, operation_id, state, value_json
       FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind = ? AND route_key = ?`,
    )
    .bind(providerId, kind, key)
    .first<{
      readonly owner_native_id?: unknown;
      readonly generation?: unknown;
      readonly operation_id?: unknown;
      readonly state?: unknown;
      readonly value_json?: unknown;
    }>();
  if (row === null) return { kind: "missing" };
  if (
    typeof row.owner_native_id !== "string" ||
    !isRouteToken(row.owner_native_id) ||
    typeof row.generation !== "number" ||
    !isGeneration(row.generation) ||
    typeof row.operation_id !== "string" ||
    !isRouteToken(row.operation_id) ||
    (row.state !== "active" && row.state !== "tombstone") ||
    typeof row.value_json !== "string"
  ) {
    return { kind: "malformed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return { kind: "malformed" };
  }
  if (row.state === "tombstone") {
    try {
      const tombstone = parseManagedWorkerRouteTombstone(value);
      return tombstone.generation === row.generation
        ? { kind: "tombstone", generation: row.generation }
        : { kind: "malformed" };
    } catch {
      return { kind: "malformed" };
    }
  }
  try {
    const route = parseRouteForKind(kind, value);
    return route.generation === row.generation
      ? { kind: "valid", value: route }
      : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

function parseRouteForKind(
  kind: ManagedWorkerRouteKind,
  value: unknown,
):
  | ManagedWorkerHostRoute
  | ManagedWorkerReleaseRoute
  | ManagedWorkerQueueRoute
  | ManagedWorkerScheduleRoute {
  if (kind === "host") return parseManagedWorkerHostRoute(value);
  if (kind === "worker") return parseManagedWorkerReleaseRoute(value);
  if (kind === "queue") return parseManagedWorkerQueueRoute(value);
  return parseManagedWorkerScheduleRoute(value);
}

function createD1ScheduleLease(
  database: ManagedWorkerD1Database,
  providerId: string,
  leaseTtlMillis: number,
): ManagedWorkerScheduleLease {
  return {
    async acquire(cron, logicalWorkerId, nowMillis) {
      const normalizedCron = canonicalCron(cron);
      const normalizedWorker = routeToken(logicalWorkerId, "logicalWorkerId");
      if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) {
        throw new TypeError("managed Worker lease time is invalid");
      }
      const expiresAt = nowMillis + leaseTtlMillis;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new TypeError("managed Worker lease expiry is invalid");
      }
      const token = newLeaseToken();
      const session = database.withSession("first-primary");
      const row = await session
        .prepare(
          `INSERT INTO cloudflare_managed_worker_cron_leases (
             provider_id, cron, logical_worker_id, lease_token, lease_expires_at_ms
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, cron, logical_worker_id)
           DO UPDATE SET lease_token = excluded.lease_token,
                         lease_expires_at_ms = excluded.lease_expires_at_ms
           WHERE cloudflare_managed_worker_cron_leases.lease_expires_at_ms <= ?
           RETURNING lease_token`,
        )
        .bind(providerId, normalizedCron, normalizedWorker, token, expiresAt, nowMillis)
        .first<{ readonly lease_token?: unknown }>();
      if (row === null) return null;
      if (row === undefined || row.lease_token !== token) {
        throw new Error("managed Worker lease response is malformed");
      }
      return { token };
    },
    async release(cron, logicalWorkerId, token) {
      const normalizedCron = canonicalCron(cron);
      const normalizedWorker = routeToken(logicalWorkerId, "logicalWorkerId");
      const normalizedToken = routeToken(token, "leaseToken");
      const session = database.withSession("first-primary");
      const result = await session
        .prepare(
          `DELETE FROM cloudflare_managed_worker_cron_leases
           WHERE provider_id = ? AND cron = ? AND logical_worker_id = ? AND lease_token = ?`,
        )
        .bind(providerId, normalizedCron, normalizedWorker, normalizedToken)
        .run();
      if (result.meta?.changes !== undefined && result.meta.changes !== 1) {
        throw new Error("managed Worker lease release lost ownership");
      }
    },
  };
}

function newLeaseToken(): string {
  const randomUuid = crypto.randomUUID;
  if (typeof randomUuid === "function") {
    return routeToken(randomUuid.call(crypto), "leaseToken");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return routeToken(base64(bytes).replace(/=+$/u, ""), "leaseToken");
}

async function safeRelease(
  state: ManagedWorkerGatewayState,
  logicalWorkerId: string,
): Promise<ManagedWorkerReleaseRoute | undefined> {
  try {
    const result = await readStateRoute(
      state,
      "worker",
      managedWorkerReleaseRouteKey(logicalWorkerId),
    );
    return result.kind === "valid" ? result.value : undefined;
  } catch {
    return undefined;
  }
}

async function safeReleaseOrThrow(
  state: ManagedWorkerGatewayState,
  logicalWorkerId: string,
): Promise<ManagedWorkerReleaseRoute> {
  const release = await safeRelease(state, logicalWorkerId);
  if (!release) throw new Error("managed Worker release route is unavailable");
  return release;
}

function selectRelease(
  releases: readonly ManagedWorkerRelease[],
  selectionKey: string,
): ManagedWorkerRelease | undefined {
  let point = deterministicBasisPoint(selectionKey);
  for (const release of releases) {
    const width = release.percentage * 100;
    if (point < width) return release;
    point -= width;
  }
  return undefined;
}

function selectHttpRelease(
  releases: readonly ManagedWorkerRelease[],
  selectionKey: string,
): ManagedWorkerRelease | undefined {
  let point: number;
  try {
    const entropy = new Uint32Array(1);
    crypto.getRandomValues(entropy);
    point = (entropy[0] ?? 0) % 10_000;
  } catch {
    // Environments without Web Crypto still get a per-request fallback. The
    // request key prevents identical failures from collapsing to one release.
    point = deterministicBasisPoint(`${selectionKey}|${Date.now()}|${Math.random()}`);
  }
  for (const release of releases) {
    const width = release.percentage * 100;
    if (point < width) return release;
    point -= width;
  }
  return undefined;
}

/** Stable hundredth-percent point in [0, 9_999], independent of random state. */
export function deterministicBasisPoint(value: string): number {
  if (!value || hasControlCharacters(value)) {
    throw new TypeError("selection key is invalid");
  }
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 10_000;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function settleRetry(messages: readonly ManagedWorkerMessage[]): void {
  let firstError: unknown;
  for (const message of messages) {
    try {
      message.retry();
    } catch (error) {
      // Continue attempting every message, then surface the failure so the
      // queue runtime cannot treat a partially settled batch as acknowledged.
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw new Error("managed Worker Queue retry settlement failed");
  }
}

function normalizeIdentity(
  value: ManagedWorkerGatewayIdentity | string | undefined,
): ManagedWorkerGatewayIdentity {
  if (value === undefined) {
    return { gatewayId: "unconfigured", environment: "unconfigured" };
  }
  if (typeof value === "string") {
    return {
      gatewayId: routeToken(value, "gatewayId"),
      environment: "unconfigured",
    };
  }
  if (!value || typeof value !== "object")
    throw new TypeError("managed Worker gateway identity is invalid");
  return {
    gatewayId: routeToken(value.gatewayId, "gatewayId"),
    environment: routeToken(value.environment, "environment"),
  };
}

function canonicalHostname(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_HOSTNAME_BYTES) {
    throw new TypeError("hostname is invalid");
  }
  const withoutRootDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const hostname = withoutRootDot.toLowerCase();
  if (!HOSTNAME.test(hostname)) throw new TypeError("hostname is invalid");
  return hostname;
}

function canonicalCron(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TOKEN_BYTES ||
    hasControlCharacters(value) ||
    value.trim() !== value
  ) {
    throw new TypeError("cron is invalid");
  }
  return value;
}

function isQueueName(value: unknown): value is string {
  return typeof value === "string" && QUEUE_NAME.test(value);
}

function routeToken(value: string, label: string): string {
  if (!isRouteToken(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function isRouteToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TOKEN_BYTES && TOKEN.test(value);
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key): key is string => typeof key === "string")) {
    throw new TypeError("managed Worker document has unexpected keys");
  }
  const keys = ownKeys.sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length || !keys.every((key, index) => key === canonical[index])) {
    throw new TypeError("managed Worker document has unexpected keys");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}

function unavailable(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "1" },
  });
}
