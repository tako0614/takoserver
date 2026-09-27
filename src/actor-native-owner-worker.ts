/** Host-private native owner. No public admission or namespace API is installed here. */
interface NativeActorWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

type NativePair = { readonly 0: NativeActorWebSocket; readonly 1: NativeActorWebSocket };
const NativeWebSocketPair = (
  globalThis as typeof globalThis & {
    WebSocketPair?: new () => NativePair;
  }
).WebSocketPair;
interface NativeState {
  readonly facets: {
    get(
      name: string,
      create: () => { readonly class: unknown; readonly id: string },
    ): { fetch(request: Request): Promise<Response> };
    abort?(name: string, reason: string): void;
  };
  readonly storage?: {
    readonly sql: {
      exec(sql: string, ...params: (string | number | null)[]): Iterable<Record<string, unknown>>;
    };
    setAlarm(at: number): void | Promise<void>;
    deleteAlarm(): void | Promise<void>;
  };
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  acceptWebSocket?(socket: NativeActorWebSocket): void;
  getWebSockets?(): NativeActorWebSocket[];
}

const ID_HEADER = "x-takoserver-private-actor-id";
const TOKEN_HEADER = "x-takoserver-private-actor-token";
const ALARM_ACTION_HEADER = "x-takoserver-private-alarm-action";
const ALARM_AT_HEADER = "x-takoserver-private-alarm-at";
const DELIVERY_HEADER = "x-takoserver-private-actor-delivery";
const VARIANT_HEADER = "x-takoserver-private-actor-variant";
const SOCKET_ACTION_HEADER = "x-takoserver-private-actor-socket-action";
const SOCKET_NONCE_HEADER = "x-takoserver-private-actor-socket-nonce";
const SOCKET_ID_HEADER = "x-takoserver-private-actor-socket-id";
const SOCKET_KIND_HEADER = "x-takoserver-private-actor-socket-kind";
const UPGRADE_NONCE_HEADER = "x-takoserver-private-actor-upgrade-nonce";
const UPGRADE_DECISION_HEADER = "x-takoserver-private-actor-upgrade-decision";
const UPGRADE_SOCKET_ID_HEADER = "x-takoserver-private-actor-upgrade-socket-id";
const EVENT_SECRET_HEADER = "x-takoserver-private-actor-event-secret";
const RESERVATION_HEADER = "x-takoserver-private-actor-reservation";
const RESERVATION_ACTION_HEADER = "x-takoserver-private-actor-reservation-action";
const RESERVATION_MS = 30_000;
const SOCKET_MESSAGE_LIMIT = 8 * 1024 * 1024;
// Host-owned inbound policy, not portable capacity or a native transport bound.
// Count empty messages too, and retain charges through callback settlement.
const SOCKET_INBOUND_COUNT = 64;
const SOCKET_INBOUND_BYTES = 8 * 1024 * 1024;
const ACTOR_INBOUND_COUNT = 256;
const ACTOR_INBOUND_BYTES = 16 * 1024 * 1024;
const SOCKET_ATTACHMENT_LIMIT = 8_192;
const SOCKET_ID_LIMIT = 10_000;
const ALARM_RETRY_MS = 1_000;
const ALARM_WATCHDOG_MS = 35_000;
const ALARM_HANDLER_MS = 30_000;
const HTTP_HANDLER_MS = 30_000;
const HTTP_PRODUCER_MS = 300_000;
// The child imports this Host-private bundle before importing application
// modules. Capture every primitive used to construct the capability-bearing
// request now: application top-level code may replace globals and prototypes.
const SafeHeaders = Headers;
const SafeRequest = Request;
const SafeReflectApply = Reflect.apply;
const SafeHeadersSet = Headers.prototype.set;
const SafeResponseJson = Response.prototype.json;
const SafeResponseOk = Object.getOwnPropertyDescriptor(Response.prototype, "ok")?.get;
const SafeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const SafeEncodeURIComponent = encodeURIComponent;
const SafeString = String;
const SafeHasOwn = Object.hasOwn;
const SafeArrayIsArray = Array.isArray;
const SafeArrayIndexOf = Array.prototype.indexOf;
const SafeObjectFreeze = Object.freeze;
const SafeIsSafeInteger = Number.isSafeInteger;
const SafeSubtle = crypto.subtle;
const SafeSubtleImportKey = crypto.subtle.importKey;
const SafeSubtleSign = crypto.subtle.sign;
const SafeSubtleVerify = crypto.subtle.verify;
const SafeCrypto = crypto;
const SafeCryptoRandomUUID = crypto.randomUUID;
const SafeCryptoGetRandomValues = crypto.getRandomValues;
const SafeNow = Date.now;
const SafeMathMin = Math.min;
const SafeJsonStringify = JSON.stringify;
const SafeEncoder = new TextEncoder();
const SafeEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const HEX = "0123456789abcdef";

function randomBearer(): string {
  const bytes = new SafeUint8Array(32);
  SafeReflectApply(SafeCryptoGetRandomValues, SafeCrypto, [bytes]);
  let bearer = "";
  for (const byte of bytes) bearer += (HEX[byte >> 4] as string) + (HEX[byte & 15] as string);
  return bearer;
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/u.test(value)) return null;
  const bytes = new SafeUint8Array(32);
  for (let index = 0; index < 32; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function upgradeDecisionMessage(
  nonce: string,
  encodedId: string,
  socketId: string,
  protocol: string,
): string {
  return `actor-socket-v1\n${nonce}\n${encodedId}\n${socketId}\n${protocol}`;
}

/** Child-only Host shim signs a decision; application code never receives this key. */
export async function signActorNativeUpgradeDecision(
  deliveryToken: string,
  nonce: string,
  encodedId: string,
  socketId: string,
  protocol = "",
): Promise<string> {
  const key = await SafeReflectApply(SafeSubtleImportKey, SafeSubtle, [
    "raw",
    SafeReflectApply(SafeEncode, SafeEncoder, [deliveryToken]),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  ]);
  const signed = (await SafeReflectApply(SafeSubtleSign, SafeSubtle, [
    "HMAC",
    key,
    SafeReflectApply(SafeEncode, SafeEncoder, [
      upgradeDecisionMessage(nonce, encodedId, socketId, protocol),
    ]),
  ])) as ArrayBuffer;
  let result = "";
  for (const byte of new SafeUint8Array(signed))
    result += (HEX[byte >> 4] as string) + (HEX[byte & 15] as string);
  return result;
}

async function verifyUpgradeDecision(
  deliveryToken: string,
  nonce: string,
  encodedId: string,
  socketId: string,
  protocol: string,
  signature: string | null,
): Promise<boolean> {
  const signatureBytes = signature === null ? null : hexBytes(signature);
  if (!signatureBytes) return false;
  const key = await SafeReflectApply(SafeSubtleImportKey, SafeSubtle, [
    "raw",
    SafeReflectApply(SafeEncode, SafeEncoder, [deliveryToken]),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  ]);
  return SafeReflectApply(SafeSubtleVerify, SafeSubtle, [
    "HMAC",
    key,
    signatureBytes,
    SafeReflectApply(SafeEncode, SafeEncoder, [
      upgradeDecisionMessage(nonce, encodedId, socketId, protocol),
    ]),
  ]) as Promise<boolean>;
}

function actorAlarmBearer(secret: string): (encodedId: string) => Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Actor alarm capability unavailable");
  const key = SafeReflectApply(SafeSubtleImportKey, SafeSubtle, [
    "raw",
    SafeReflectApply(SafeEncode, SafeEncoder, [secret]),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  ]) as Promise<CryptoKey>;
  return async (encodedId: string): Promise<string> => {
    const bytes = SafeReflectApply(SafeEncode, SafeEncoder, [encodedId]) as Uint8Array;
    const signed = (await SafeReflectApply(SafeSubtleSign, SafeSubtle, [
      "HMAC",
      await key,
      bytes,
    ])) as ArrayBuffer;
    let bearer = "";
    for (const byte of new SafeUint8Array(signed))
      bearer += (HEX[byte >> 4] as string) + (HEX[byte & 15] as string);
    return bearer;
  };
}

interface AlarmState {
  readonly actorId: string | null;
  readonly pending: number | null;
  readonly obligation: boolean;
  readonly retryAt: number | null;
}

interface ActorOwnerGraph {
  readonly generationKey: string;
  readonly epoch: string;
  readonly variantKeys: readonly string[];
}

function validActorOwnerGraph(value: ActorOwnerGraph | undefined): value is ActorOwnerGraph {
  if (
    !value ||
    !/^[a-f0-9]{64}$/u.test(value.generationKey) ||
    typeof value.epoch !== "string" ||
    value.epoch.length === 0 ||
    !SafeArrayIsArray(value.variantKeys) ||
    value.variantKeys.length === 0
  )
    return false;
  for (let index = 0; index < value.variantKeys.length; index += 1) {
    const key = value.variantKeys[index];
    if (typeof key !== "string" || key.length === 0) return false;
    for (let previous = 0; previous < index; previous += 1)
      if (value.variantKeys[previous] === key) return false;
  }
  return true;
}

type SocketEvent =
  | { readonly kind: "message"; readonly data: string | ArrayBuffer }
  | {
      readonly kind: "close";
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    };

interface InboundSocketEvent {
  readonly socket: NativeActorWebSocket;
  event: SocketEvent | undefined;
  readonly bytes: number;
  readonly batch: Set<InboundSocketEvent>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface SocketRecord {
  readonly socketId: string;
  readonly actorId: string;
  readonly nonce: string;
  readonly protocol: string;
  attachment: Uint8Array | null;
  readonly queued: (string | Uint8Array)[];
  queuedBytes: number;
  status: "provisional" | "transport-pending" | "live" | "closed";
  reservationBearer?: string | undefined;
  reservationExpiresAt?: number | undefined;
  reservationGenerationKey?: string | undefined;
  reservationEpoch?: string | undefined;
  reservationVariantKey?: string | undefined;
  socket?: NativeActorWebSocket;
}

interface SocketAttachment {
  readonly socketId: string;
  readonly actorId: string;
  readonly attachment: string | null;
  readonly reservationBearer?: string | undefined;
  readonly reservationExpiresAt?: number | undefined;
  readonly reservationGenerationKey?: string | undefined;
  readonly reservationEpoch?: string | undefined;
  readonly reservationVariantKey?: string | undefined;
}

function socketMetadata(socket: NativeActorWebSocket): SocketAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<SocketAttachment>;
  if (
    typeof record.socketId !== "string" ||
    typeof record.actorId !== "string" ||
    (record.attachment !== null && typeof record.attachment !== "string") ||
    (record.reservationBearer !== undefined &&
      (typeof record.reservationBearer !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.reservationBearer))) ||
    (record.reservationExpiresAt !== undefined && !alarmTime(record.reservationExpiresAt)) ||
    (record.reservationGenerationKey !== undefined &&
      !/^[a-f0-9]{64}$/u.test(record.reservationGenerationKey)) ||
    (record.reservationEpoch !== undefined &&
      (typeof record.reservationEpoch !== "string" || record.reservationEpoch.length === 0)) ||
    (record.reservationVariantKey !== undefined &&
      (typeof record.reservationVariantKey !== "string" ||
        record.reservationVariantKey.length === 0)) ||
    (record.reservationBearer === undefined) !== (record.reservationExpiresAt === undefined) ||
    (record.reservationBearer === undefined) !== (record.reservationGenerationKey === undefined) ||
    (record.reservationBearer === undefined) !== (record.reservationEpoch === undefined) ||
    (record.reservationBearer === undefined) !== (record.reservationVariantKey === undefined)
  )
    return null;
  return record as SocketAttachment;
}

function encodeAttachment(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeAttachment(value: string | null): Uint8Array | null {
  if (value === null) return null;
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

type SocketPortErrorCode =
  | "invalid_upgrade"
  | "socket_limit_exceeded"
  | "attachment_too_large"
  | "socket_overloaded"
  | "socket_closed"
  | "message_too_large"
  | "backend_unavailable";

function socketPortError(
  code: SocketPortErrorCode,
): Error & { readonly code: SocketPortErrorCode } {
  const error = new Error(code) as Error & { readonly code: SocketPortErrorCode };
  Object.defineProperties(error, { name: { value: code }, code: { value: code } });
  return error;
}

function alarmTime(value: unknown): value is number {
  return typeof value === "number" && SafeIsSafeInteger(value) && value >= 0;
}

/** Private owner transport; the actor cannot choose another namespace or ID. */
export function createActorNativeAlarmPort(
  service: { fetch(request: Request): Promise<Response> },
  /** Undefined only for a route-less, Host-owned structural control binding. */
  secret: string | undefined,
  id: string,
) {
  const fetch = service.fetch;
  const encodedId = SafeEncodeURIComponent(id);
  const bearer = secret === undefined ? undefined : actorAlarmBearer(secret)(encodedId);
  const call = async (action: "set" | "get" | "clear", at?: number): Promise<number | null> => {
    const headers = new SafeHeaders({
      [ID_HEADER]: encodedId,
      [ALARM_ACTION_HEADER]: action,
    });
    if (bearer !== undefined)
      SafeReflectApply(SafeHeadersSet, headers, [TOKEN_HEADER, await bearer]);
    if (at !== undefined)
      SafeReflectApply(SafeHeadersSet, headers, [ALARM_AT_HEADER, SafeString(at)]);
    const response = await SafeReflectApply(fetch, service, [
      new SafeRequest("http://actor.invalid/", { headers }),
    ]);
    if (!SafeResponseOk || !SafeReflectApply(SafeResponseOk, response, []))
      throw new Error("Actor alarm owner unavailable");
    const value: unknown = await SafeReflectApply(SafeResponseJson, response, []);
    if (typeof value !== "object" || value === null || !SafeHasOwn(value, "at"))
      throw new Error("Actor alarm owner unavailable");
    const result = (value as { at?: unknown }).at;
    if (result !== null && !alarmTime(result)) throw new Error("Actor alarm owner unavailable");
    return result;
  };
  return Object.freeze({
    async set(at: number): Promise<void> {
      await call("set", at);
    },
    get(): Promise<number | null> {
      return call("get");
    },
    async clear(): Promise<void> {
      await call("clear");
    },
  });
}

/** Invocation-bound private socket RPC; never hand this object to application code. */
export function createActorNativeSocketPort(
  service: { fetch(request: Request): Promise<Response> },
  /** Undefined only for a route-less, Host-owned structural control binding. */
  secret: string | undefined,
  id: string,
  nonce: string,
) {
  const fetch = service.fetch;
  const encodedId = SafeEncodeURIComponent(id);
  const bearer = secret === undefined ? undefined : actorAlarmBearer(secret)(encodedId);
  const call = async (
    action: "accept" | "get" | "list" | "send" | "close" | "set-attachment" | "get-attachment",
    socketId?: string,
    body?: string | Uint8Array,
    kind?: "text" | "binary" | "null",
  ): Promise<Response> => {
    const headers = new SafeHeaders({
      [ID_HEADER]: encodedId,
      [SOCKET_ACTION_HEADER]: action,
      [SOCKET_NONCE_HEADER]: nonce,
    });
    if (bearer !== undefined)
      SafeReflectApply(SafeHeadersSet, headers, [TOKEN_HEADER, await bearer]);
    if (socketId) SafeReflectApply(SafeHeadersSet, headers, [SOCKET_ID_HEADER, socketId]);
    if (kind) SafeReflectApply(SafeHeadersSet, headers, [SOCKET_KIND_HEADER, kind]);
    const response = await SafeReflectApply(fetch, service, [
      new SafeRequest("http://actor.invalid/", {
        method: "POST",
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : body.slice().buffer }),
      }),
    ]);
    if (!SafeResponseOk || !SafeReflectApply(SafeResponseOk, response, [])) {
      const status = SafeResponseStatus ? SafeReflectApply(SafeResponseStatus, response, []) : 503;
      if (status === 404 && action !== "accept") throw socketPortError("socket_closed");
      if (status === 429)
        throw socketPortError(action === "accept" ? "socket_limit_exceeded" : "socket_overloaded");
      if (status === 413)
        throw socketPortError(action === "send" ? "message_too_large" : "attachment_too_large");
      if (status === 400 && action === "accept") throw socketPortError("invalid_upgrade");
      throw socketPortError("backend_unavailable");
    }
    return response;
  };
  return Object.freeze({
    async accept(protocol?: string, attachment?: Uint8Array): Promise<string> {
      if (attachment && attachment.byteLength > SOCKET_ATTACHMENT_LIMIT)
        throw socketPortError("attachment_too_large");
      const response = await call(
        "accept",
        undefined,
        SafeJsonStringify({
          protocol,
          attachment: attachment ? encodeAttachment(attachment) : null,
        }),
      );
      const value: unknown = await SafeReflectApply(SafeResponseJson, response, []);
      if (
        typeof value !== "object" ||
        value === null ||
        !SafeHasOwn(value, "socketId") ||
        typeof (value as { socketId?: unknown }).socketId !== "string"
      )
        throw socketPortError("backend_unavailable");
      return (value as { socketId: string }).socketId;
    },
    async get(socketId: string): Promise<boolean> {
      const response = await call("get", socketId);
      const value: unknown = await SafeReflectApply(SafeResponseJson, response, []);
      if (typeof value !== "object" || value === null || !SafeHasOwn(value, "exists"))
        throw socketPortError("backend_unavailable");
      return (value as { exists: unknown }).exists === true;
    },
    async list(): Promise<readonly string[]> {
      const response = await call("list");
      const value: unknown = await SafeReflectApply(SafeResponseJson, response, []);
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw socketPortError("backend_unavailable");
      return value;
    },
    async send(socketId: string, data: string | Uint8Array): Promise<void> {
      const kind = typeof data === "string" ? "text" : "binary";
      await call("send", socketId, data, kind);
    },
    async close(socketId: string, code?: number, reason?: string): Promise<void> {
      await call("close", socketId, SafeJsonStringify({ code, reason }));
    },
    async setAttachment(socketId: string, bytes: Uint8Array | null): Promise<void> {
      await call(
        "set-attachment",
        socketId,
        bytes ?? undefined,
        bytes === null ? "null" : undefined,
      );
    },
    async getAttachment(socketId: string): Promise<Uint8Array | null> {
      const response = await call("get-attachment", socketId);
      if (response.status === 204) return null;
      return new SafeUint8Array(await response.arrayBuffer());
    },
  });
}

// Bun currently retains the original headers when cloning a Request with an
// empty replacement Headers. Rebuild from the URL so the private hop headers
// cannot reach the application even when they were the only headers present.
function withHeaders(request: Request, headers: Headers, signal = request.signal): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal,
    redirect: "manual",
  });
}

/**
 * One native Durable Object per namespace/opaque ID, with one private facet.
 * The per-ID owner reserves an invocation through response-body completion.
 * This does not qualify crash recovery or native request lifetime limits;
 * the self-host Actor admission refusal remains in force.
 */
export function createActorNativeOwner(
  deliveryToken: string | undefined,
  admissionToken: string | undefined,
  graph: ActorOwnerGraph | undefined,
  // Host-private timing seam for focused qualification; public admission does
  // not accept or forward deadline values.
  deadlines: { readonly handlerMs: number; readonly producerMs: number } = {
    handlerMs: HTTP_HANDLER_MS,
    producerMs: HTTP_PRODUCER_MS,
  },
  loadVariantClass?: (
    env: Record<string, unknown>,
    variantKey: string,
    selection: {
      readonly actorId: string;
      readonly generationKey: string;
      readonly epoch: string;
    },
  ) => Promise<unknown>,
  readCurrentGraph?: (env: Record<string, unknown>) => Promise<ActorOwnerGraph>,
) {
  if (
    (deliveryToken !== undefined && !/^[a-f0-9]{64}$/u.test(deliveryToken)) ||
    (admissionToken !== undefined && !/^[a-f0-9]{64}$/u.test(admissionToken))
  )
    throw new Error("Actor delivery capability unavailable");
  // Undefined is only for a route-less, structurally Host-owned facet loader:
  // no static secret may be embedded in immutable/recoverable WfP WorkerCode.
  const deliveryForEvent = (): string => deliveryToken ?? randomBearer();
  if (
    (graph !== undefined && !validActorOwnerGraph(graph)) ||
    (graph === undefined && (!readCurrentGraph || !loadVariantClass)) ||
    (graph !== undefined && readCurrentGraph !== undefined) ||
    (admissionToken === undefined && graph !== undefined)
  )
    throw new Error("Actor alarm graph bindings unavailable");
  // Dynamic WfP owner only: a route-less Host-owned ADMISSION binding supplies
  // authority, while self-host retains its mandatory static bearer.
  const admissionHeaders = (): Headers =>
    admissionToken === undefined
      ? new SafeHeaders()
      : new SafeHeaders({ "x-takoserver-private-alarm-admission": admissionToken });
  if (
    !SafeIsSafeInteger(deadlines.handlerMs) ||
    deadlines.handlerMs <= 0 ||
    !SafeIsSafeInteger(deadlines.producerMs) ||
    deadlines.producerMs <= 0
  )
    throw new Error("Actor HTTP deadlines unavailable");
  const staticGraph =
    graph === undefined
      ? undefined
      : Object.freeze({ ...graph, variantKeys: Object.freeze([...graph.variantKeys]) });
  return class ActorOwner {
    readonly state: NativeState;
    readonly env: {
      readonly CLASS: unknown;
      readonly [name: string]: unknown;
      readonly ADMISSION?: { fetch(request: Request): Promise<Response> };
    };
    private tail: Promise<void> = Promise.resolve();
    private alarmTail: Promise<void> = Promise.resolve();
    private poisoned = false;
    private readonly ready: Promise<void>;
    private activeSocketInvocation:
      | {
          readonly actorId: string;
          readonly nonce: string;
          readonly kind: "fetch" | "callback";
          readonly request?: Request;
          accepting: boolean;
        }
      | undefined;
    private readonly sockets = new Map<string, SocketRecord>();
    private readonly suppressedCloses = new WeakSet<NativeActorWebSocket>();
    private readonly stoppedInbound = new WeakSet<NativeActorWebSocket>();
    private readonly closingInbound = new WeakSet<NativeActorWebSocket>();
    private readonly inbound = new Map<
      NativeActorWebSocket,
      { bytes: number; events: Set<InboundSocketEvent> }
    >();
    private inboundCount = 0;
    private inboundBytes = 0;
    private socketBatch: Set<InboundSocketEvent> | undefined;
    constructor(
      state: NativeState,
      env: {
        readonly CLASS: unknown;
        readonly [name: string]: unknown;
        readonly ADMISSION?: { fetch(request: Request): Promise<Response> };
      },
    ) {
      this.state = state;
      this.env = env;
      const initialize = async (): Promise<void> => {
        const storage = this.requireStorage();
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS actor_alarm_state (id INTEGER PRIMARY KEY CHECK(id = 1), actor_id TEXT, pending_at INTEGER, obligation INTEGER NOT NULL DEFAULT 0, retry_at INTEGER)",
        );
        storage.sql.exec(
          "INSERT OR IGNORE INTO actor_alarm_state (id, actor_id, pending_at, obligation, retry_at) VALUES (1, NULL, NULL, 0, NULL)",
        );
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS actor_socket_reservations (socket_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, bearer TEXT NOT NULL, expires_at INTEGER NOT NULL)",
        );
        const recoveredSockets = state.getWebSockets?.() ?? [];
        for (let index = 0; index < recoveredSockets.length; index += 1) {
          const socket = recoveredSockets[index] as NativeActorWebSocket;
          const metadata = socketMetadata(socket);
          if (metadata?.reservationBearer === undefined) continue;
          const row = storage.sql
            .exec(
              "SELECT bearer, expires_at AS expiresAt FROM actor_socket_reservations WHERE socket_id = ? AND actor_id = ?",
              metadata.socketId,
              metadata.actorId,
            )
            [Symbol.iterator]()
            .next().value;
          if (
            row?.bearer === metadata.reservationBearer &&
            row.expiresAt === metadata.reservationExpiresAt &&
            alarmTime(row.expiresAt) &&
            row.expiresAt > (SafeReflectApply(SafeNow, Date, []) as number)
          )
            continue;
          this.suppressedCloses.add(socket);
          socket.close(1008, "upgrade not committed");
          storage.sql.exec(
            "DELETE FROM actor_socket_reservations WHERE socket_id = ?",
            metadata.socketId,
          );
        }
        await this.reconcile();
      };
      // Native storage, not a timer in this process, reconstructs the wake.
      this.ready = state.storage
        ? (state.blockConcurrencyWhile?.(initialize) ?? initialize())
        : Promise.resolve();
    }
    private requireStorage(): NonNullable<NativeState["storage"]> {
      if (!this.state.storage) throw new Error("Actor alarm storage unavailable");
      return this.state.storage;
    }
    private async currentGraph(): Promise<ActorOwnerGraph> {
      if (staticGraph) return staticGraph;
      const selected = await readCurrentGraph?.(this.env);
      if (!validActorOwnerGraph(selected)) throw new Error("Actor graph unavailable");
      // The Host reader may reuse mutable storage across awaits. Keep this
      // event's comparison independent of later graph updates.
      const variantKeys: string[] = [];
      for (let index = 0; index < selected.variantKeys.length; index += 1)
        variantKeys[index] = selected.variantKeys[index] as string;
      return { generationKey: selected.generationKey, epoch: selected.epoch, variantKeys };
    }
    private async selectedChild(
      actorId: string,
      key: string,
      variantIndex: number,
      graph: ActorOwnerGraph,
    ) {
      const bindingName = `CLASS_${variantIndex}`;
      const selectedClass = loadVariantClass
        ? await loadVariantClass(
            this.env,
            key,
            SafeObjectFreeze({
              actorId,
              generationKey: graph.generationKey,
              epoch: graph.epoch,
            }),
          )
        : SafeHasOwn(this.env, bindingName)
          ? this.env[bindingName]
          : undefined;
      if (selectedClass === undefined || selectedClass === null)
        throw new Error("Actor variant unavailable");
      return this.state.facets.get("actor", () => ({ class: selectedClass, id: actorId }));
    }
    private readAlarm(): AlarmState {
      const rows = this.requireStorage().sql.exec(
        "SELECT actor_id AS actorId, pending_at AS pending, obligation, retry_at AS retryAt FROM actor_alarm_state WHERE id = 1",
      );
      const row = rows[Symbol.iterator]().next().value;
      if (!row) throw new Error("Actor alarm state unavailable");
      const pending = row.pending;
      const retryAt = row.retryAt;
      if (
        (pending !== null && !alarmTime(pending)) ||
        (retryAt !== null && !alarmTime(retryAt)) ||
        (row.obligation !== 0 && row.obligation !== 1)
      )
        throw new Error("Actor alarm state corrupt");
      if (row.actorId !== null && (typeof row.actorId !== "string" || !row.actorId))
        throw new Error("Actor alarm identity corrupt");
      return {
        actorId: row.actorId as string | null,
        pending: pending as number | null,
        obligation: row.obligation === 1,
        retryAt: retryAt as number | null,
      };
    }
    private async reconcile(): Promise<void> {
      const alarm = this.readAlarm();
      const actorWake = alarm.obligation ? alarm.retryAt : alarm.pending;
      const pending = this.requireStorage()
        .sql.exec("SELECT MIN(expires_at) AS expiresAt FROM actor_socket_reservations")
        [Symbol.iterator]()
        .next().value;
      const pendingWake = pending?.expiresAt;
      if (pendingWake !== null && pendingWake !== undefined && !alarmTime(pendingWake))
        throw new Error("Actor socket reservation state corrupt");
      const wake =
        actorWake === null
          ? (pendingWake ?? null)
          : pendingWake === null || pendingWake === undefined
            ? actorWake
            : (SafeReflectApply(SafeMathMin, Math, [actorWake, pendingWake]) as number);
      if (wake === null) await this.requireStorage().deleteAlarm();
      else await this.requireStorage().setAlarm(wake);
    }
    private control<T>(callback: () => Promise<T>): Promise<T> {
      const result = this.alarmTail.then(async () => {
        await this.ready;
        return callback();
      });
      this.alarmTail = result.then(
        () => {},
        () => {},
      );
      return result;
    }
    private async alarmControl(request: Request): Promise<Response> {
      const action = request.headers.get(ALARM_ACTION_HEADER);
      if (action !== "set" && action !== "get" && action !== "clear")
        return new Response(null, { status: 400 });
      return this.control(async () => {
        const storage = this.requireStorage();
        const encodedId = request.headers.get(ID_HEADER);
        if (!encodedId || this.readAlarm().actorId !== decodeURIComponent(encodedId))
          return new Response(null, { status: 404 });
        if (action === "set") {
          const raw = request.headers.get(ALARM_AT_HEADER);
          const at = raw === null || !/^(0|[1-9][0-9]*)$/u.test(raw) ? NaN : Number(raw);
          if (!alarmTime(at)) return new Response(null, { status: 400 });
          const before = this.readAlarm();
          // Arm a newly-earlier wake before committing the slot. A crash in
          // either direction leaves a harmless early wake, not a lost slot.
          if (!before.obligation && (before.pending === null || at < before.pending))
            await storage.setAlarm(at);
          storage.sql.exec("UPDATE actor_alarm_state SET pending_at = ? WHERE id = 1", at);
          await this.reconcile();
        } else if (action === "clear") {
          storage.sql.exec("UPDATE actor_alarm_state SET pending_at = NULL WHERE id = 1");
          await this.reconcile();
        }
        return Response.json({ at: this.readAlarm().pending });
      });
    }
    private liveSocket(socketId: string): SocketRecord | undefined {
      const cached = this.sockets.get(socketId);
      if ((cached?.status === "live" || cached?.status === "transport-pending") && cached.socket)
        return cached;
      for (const socket of this.state.getWebSockets?.() ?? []) {
        if (this.suppressedCloses.has(socket)) continue;
        const metadata = socketMetadata(socket);
        if (!metadata || metadata.socketId !== socketId) continue;
        const record: SocketRecord = {
          socketId,
          actorId: metadata.actorId,
          nonce: "",
          protocol: "",
          attachment: decodeAttachment(metadata.attachment),
          queued: [],
          queuedBytes: 0,
          status: metadata.reservationBearer === undefined ? "live" : "transport-pending",
          reservationBearer: metadata.reservationBearer,
          reservationExpiresAt: metadata.reservationExpiresAt,
          reservationGenerationKey: metadata.reservationGenerationKey,
          reservationEpoch: metadata.reservationEpoch,
          reservationVariantKey: metadata.reservationVariantKey,
          socket,
        };
        this.sockets.set(socketId, record);
        return record;
      }
      return undefined;
    }
    private persistSocket(record: SocketRecord): void {
      record.socket?.serializeAttachment({
        socketId: record.socketId,
        actorId: record.actorId,
        attachment: encodeAttachment(record.attachment),
        ...(record.status === "transport-pending"
          ? {
              reservationBearer: record.reservationBearer,
              reservationExpiresAt: record.reservationExpiresAt,
              reservationGenerationKey: record.reservationGenerationKey,
              reservationEpoch: record.reservationEpoch,
              reservationVariantKey: record.reservationVariantKey,
            }
          : {}),
      } satisfies SocketAttachment);
    }
    private discardProvisional(nonce: string, except?: string): void {
      for (const [socketId, record] of this.sockets) {
        if (record.status === "provisional" && record.nonce === nonce && socketId !== except)
          this.sockets.delete(socketId);
      }
    }
    private discardPending(record: SocketRecord): void {
      record.status = "closed";
      this.sockets.delete(record.socketId);
      this.requireStorage().sql.exec(
        "DELETE FROM actor_socket_reservations WHERE socket_id = ?",
        record.socketId,
      );
      if (record.socket) {
        this.suppressedCloses.add(record.socket);
        try {
          record.socket.close(1008, "upgrade not committed");
        } catch {
          /* The peer may already be gone. */
        }
      }
    }
    private async expirePending(): Promise<void> {
      const rows = this.requireStorage().sql.exec(
        "SELECT socket_id AS socketId FROM actor_socket_reservations WHERE expires_at <= ?",
        SafeReflectApply(SafeNow, Date, []) as number,
      );
      const socketIds: string[] = [];
      for (const row of rows) {
        const socketId = row.socketId;
        if (typeof socketId !== "string") throw new Error("Actor socket reservation state corrupt");
        socketIds[socketIds.length] = socketId;
      }
      for (let index = 0; index < socketIds.length; index += 1) {
        const socketId = socketIds[index] as string;
        const record = this.liveSocket(socketId);
        if (record?.status === "transport-pending") this.discardPending(record);
        else
          this.requireStorage().sql.exec(
            "DELETE FROM actor_socket_reservations WHERE socket_id = ?",
            socketId,
          );
      }
      await this.reconcile();
    }
    private reservationControl(request: Request): Promise<Response> {
      const action = request.headers.get(RESERVATION_ACTION_HEADER);
      const encodedId = request.headers.get(ID_HEADER);
      const bearer = request.headers.get(RESERVATION_HEADER);
      if (
        request.method !== "POST" ||
        (action !== "commit" && action !== "abandon") ||
        !encodedId ||
        !bearer ||
        !/^[a-f0-9]{64}$/u.test(bearer)
      )
        return Promise.resolve(new Response(null, { status: 404 }));
      let actorId: string;
      try {
        actorId = decodeURIComponent(encodedId);
      } catch {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      this.socketBatch = undefined;
      const turn = this.tail.then(async () => {
        await this.ready;
        if (this.poisoned) return new Response(null, { status: 503 });
        const row = this.requireStorage()
          .sql.exec(
            "SELECT socket_id AS socketId, expires_at AS expiresAt FROM actor_socket_reservations WHERE actor_id = ? AND bearer = ?",
            actorId,
            bearer,
          )
          [Symbol.iterator]()
          .next().value;
        if (!row || typeof row.socketId !== "string" || !alarmTime(row.expiresAt))
          return new Response(null, { status: 404 });
        const record = this.liveSocket(row.socketId);
        if (
          record?.status !== "transport-pending" ||
          record.actorId !== actorId ||
          record.reservationBearer !== bearer ||
          record.reservationExpiresAt !== row.expiresAt
        )
          return new Response(null, { status: 404 });
        if (
          (SafeReflectApply(SafeNow, Date, []) as number) >= row.expiresAt ||
          action === "abandon"
        ) {
          this.discardPending(record);
          await this.reconcile();
          return new Response(null, { status: action === "abandon" ? 204 : 404 });
        }
        // The Host may have replaced or revoked this Actor graph while the
        // outer Worker was deciding whether to hand off its native 101. A
        // provisional socket is never promoted under a different graph.
        let graph: ActorOwnerGraph;
        try {
          graph = await this.currentGraph();
        } catch {
          this.discardPending(record);
          await this.reconcile();
          return new Response(null, { status: 503 });
        }
        if (
          record.reservationGenerationKey !== graph.generationKey ||
          record.reservationEpoch !== graph.epoch ||
          SafeReflectApply(SafeArrayIndexOf, graph.variantKeys, [record.reservationVariantKey]) < 0
        ) {
          this.discardPending(record);
          await this.reconcile();
          return new Response(null, { status: 404 });
        }
        try {
          this.requireStorage().sql.exec(
            "DELETE FROM actor_socket_reservations WHERE socket_id = ? AND bearer = ?",
            record.socketId,
            bearer,
          );
          record.status = "live";
          record.reservationBearer = undefined;
          record.reservationExpiresAt = undefined;
          record.reservationGenerationKey = undefined;
          record.reservationEpoch = undefined;
          record.reservationVariantKey = undefined;
          this.persistSocket(record);
          await this.reconcile();
          for (let index = 0; index < record.queued.length; index += 1)
            record.socket?.send(record.queued[index] as string | Uint8Array);
          record.queued.length = 0;
          record.queuedBytes = 0;
        } catch {
          this.discardPending(record);
          await this.reconcile();
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      });
      this.tail = turn.then(
        () => {},
        () => {},
      );
      this.state.waitUntil(this.tail);
      return turn;
    }
    private async socketControl(request: Request): Promise<Response> {
      const action = request.headers.get(SOCKET_ACTION_HEADER);
      const encodedId = request.headers.get(ID_HEADER);
      const nonce = request.headers.get(SOCKET_NONCE_HEADER);
      const active = this.activeSocketInvocation;
      if (
        request.method !== "POST" ||
        !encodedId ||
        !active ||
        nonce !== active.nonce ||
        decodeURIComponent(encodedId) !== active.actorId
      )
        return new Response(null, { status: 404 });
      const socketId = request.headers.get(SOCKET_ID_HEADER);
      if (action === "accept") {
        if (active.kind !== "fetch" || !active.accepting || !active.request)
          return new Response(null, { status: 409 });
        const handshake = active.request.headers;
        if (
          active.request.method !== "GET" ||
          handshake.get("upgrade")?.toLowerCase() !== "websocket" ||
          !handshake
            .get("connection")
            ?.toLowerCase()
            .split(",")
            .some((part) => part.trim() === "upgrade") ||
          !handshake.get("sec-websocket-key") ||
          handshake.get("sec-websocket-version") !== "13"
        )
          return new Response(null, { status: 400 });
        const openIds = new Set(this.sockets.keys());
        for (const socket of this.state.getWebSockets?.() ?? []) {
          const metadata = socketMetadata(socket);
          if (metadata) openIds.add(metadata.socketId);
        }
        if (openIds.size >= SOCKET_ID_LIMIT) return new Response(null, { status: 429 });
        const body = await request.text();
        if (body.length > 12_000) return new Response(null, { status: 413 });
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          return new Response(null, { status: 400 });
        }
        if (typeof value !== "object" || value === null) return new Response(null, { status: 400 });
        const options = value as { protocol?: unknown; attachment?: unknown };
        const protocol = options.protocol === undefined ? "" : options.protocol;
        if (typeof protocol !== "string" || protocol.length > 256)
          return new Response(null, { status: 400 });
        if (
          protocol &&
          !handshake
            .get("sec-websocket-protocol")
            ?.split(",")
            .some((part) => part.trim() === protocol)
        )
          return new Response(null, { status: 400 });
        let attachment: Uint8Array | null = null;
        if (options.attachment !== undefined && options.attachment !== null) {
          if (typeof options.attachment !== "string" || options.attachment.length > 11_000)
            return new Response(null, { status: 413 });
          try {
            attachment = decodeAttachment(options.attachment);
          } catch {
            return new Response(null, { status: 400 });
          }
          if (!attachment || attachment.byteLength > SOCKET_ATTACHMENT_LIMIT)
            return new Response(null, { status: 413 });
        }
        if (this.activeSocketInvocation !== active || !active.accepting)
          return new Response(null, { status: 409 });
        const createdId = SafeReflectApply(SafeCryptoRandomUUID, SafeCrypto, []) as string;
        this.sockets.set(createdId, {
          socketId: createdId,
          actorId: active.actorId,
          nonce: active.nonce,
          protocol,
          attachment,
          queued: [],
          queuedBytes: 0,
          status: "provisional",
        });
        return Response.json({ socketId: createdId });
      }
      if (action === "list") {
        const ids = new Set<string>();
        for (const socket of this.state.getWebSockets?.() ?? []) {
          const metadata = socketMetadata(socket);
          if (metadata?.actorId === active.actorId) ids.add(metadata.socketId);
        }
        for (const record of this.sockets.values())
          if (record.status === "live" && record.actorId === active.actorId)
            ids.add(record.socketId);
        return Response.json([...ids]);
      }
      if (!socketId) return new Response(null, { status: 400 });
      const record = this.sockets.get(socketId) ?? this.liveSocket(socketId);
      if (!record || record.actorId !== active.actorId || record.status === "closed")
        return action === "get"
          ? Response.json({ exists: false })
          : new Response(null, { status: 404 });
      if (record.status === "transport-pending")
        return action === "get"
          ? Response.json({ exists: false })
          : new Response(null, { status: 404 });
      if (record.status === "provisional" && (active.kind !== "fetch" || record.nonce !== nonce))
        return new Response(null, { status: 404 });
      if (action === "get") return Response.json({ exists: record.status === "live" });
      if (action === "get-attachment")
        return record.attachment === null
          ? new Response(null, { status: 204 })
          : new Response(record.attachment.slice());
      if (action === "set-attachment") {
        if (request.headers.get(SOCKET_KIND_HEADER) === "null") {
          record.attachment = null;
        } else {
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > SOCKET_ATTACHMENT_LIMIT)
            return new Response(null, { status: 413 });
          if (this.activeSocketInvocation !== active) return new Response(null, { status: 404 });
          record.attachment = bytes;
        }
        if (record.status === "live") this.persistSocket(record);
        return new Response(null, { status: 204 });
      }
      if (action === "send") {
        const kind = request.headers.get(SOCKET_KIND_HEADER);
        if (kind !== "text" && kind !== "binary") return new Response(null, { status: 400 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > SOCKET_MESSAGE_LIMIT) return new Response(null, { status: 413 });
        if (this.activeSocketInvocation !== active) return new Response(null, { status: 404 });
        const data =
          kind === "text" ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes;
        if (record.status === "provisional") {
          let pendingForActor = 0;
          for (const pending of this.sockets.values())
            if (pending.actorId === active.actorId && pending.status === "provisional")
              pendingForActor += pending.queuedBytes;
          if (
            record.queuedBytes + bytes.byteLength > SOCKET_MESSAGE_LIMIT ||
            pendingForActor + bytes.byteLength > 64 * 1024 * 1024
          ) {
            record.status = "closed";
            this.sockets.delete(socketId);
            return new Response(null, { status: 429 });
          }
          record.queued.push(data);
          record.queuedBytes += bytes.byteLength;
        } else {
          record.socket?.send(data);
        }
        return new Response(null, { status: 204 });
      }
      if (action === "close") {
        const body = await request.text();
        if (body.length > 1_000) return new Response(null, { status: 400 });
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          return new Response(null, { status: 400 });
        }
        if (this.activeSocketInvocation !== active) return new Response(null, { status: 404 });
        const close = value as { code?: unknown; reason?: unknown };
        if (
          close.code !== undefined &&
          (typeof close.code !== "number" || !Number.isInteger(close.code))
        )
          return new Response(null, { status: 400 });
        if (close.reason !== undefined && typeof close.reason !== "string")
          return new Response(null, { status: 400 });
        if (record.status === "live")
          record.socket?.close(
            close.code as number | undefined,
            close.reason as string | undefined,
          );
        record.status = "closed";
        this.sockets.delete(socketId);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 400 });
    }
    alarm(): Promise<void> {
      // Native wake joins the same per-ID actor-event queue as HTTP. Control
      // requests from a running child use the separate short storage queue.
      // Arm a durable watchdog *before* waiting behind a long HTTP producer:
      // native retry count is finite and a queued callback can itself expire.
      const queuedWake = this.control(async () => {
        const state = this.readAlarm();
        const pending = this.requireStorage()
          .sql.exec("SELECT MIN(expires_at) AS expiresAt FROM actor_socket_reservations")
          [Symbol.iterator]()
          .next().value;
        const now = SafeReflectApply(SafeNow, Date, []) as number;
        if (
          state.obligation ||
          (state.pending !== null && state.pending <= now) ||
          (alarmTime(pending?.expiresAt) && pending.expiresAt <= now)
        )
          await this.requireStorage().setAlarm(Date.now() + ALARM_WATCHDOG_MS);
        else await this.reconcile();
      });
      void queuedWake.catch(() => {});
      this.socketBatch = undefined;
      const turn = this.tail.then(async () => {
        await queuedWake;
        if (this.poisoned) throw new Error("Actor facet retirement failed");
        await this.expirePending();
        const claimed = await this.control(async () => {
          const state = this.readAlarm();
          const now = Date.now();
          if (!state.obligation && (state.pending === null || state.pending > now)) {
            await this.reconcile();
            return null;
          }
          if (state.obligation && state.retryAt !== null && state.retryAt > now) {
            await this.reconcile();
            return null;
          }
          if (state.actorId === null) throw new Error("Actor alarm identity unavailable");
          const watchdog = now + ALARM_WATCHDOG_MS;
          // Durable watchdog is armed before the admitted obligation is run.
          // It survives a process loss, independent of native retry count.
          await this.requireStorage().setAlarm(watchdog);
          this.requireStorage().sql.exec(
            "UPDATE actor_alarm_state SET pending_at = ?, obligation = 1, retry_at = ? WHERE id = 1",
            state.obligation ? state.pending : null,
            watchdog,
          );
          return state.actorId;
        });
        if (claimed === null) return;
        let succeeded = false;
        const attemptNonce = SafeReflectApply(SafeCryptoRandomUUID, SafeCrypto, []);
        const grantDeadlineAt = Date.now() + 5_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new AbortController();
        try {
          const admission = this.env.ADMISSION;
          if (!admission || !SafeResponseStatus)
            throw new Error("Actor alarm admission unavailable");
          const selection: unknown = await Promise.race([
            (async () => {
              const admit = await (SafeReflectApply(admission.fetch, admission, [
                new SafeRequest("http://actor.invalid/", {
                  method: "POST",
                  headers: admissionHeaders(),
                  body: SafeReflectApply(SafeJsonStringify, JSON, [
                    { id: claimed, attemptNonce, deadlineAt: grantDeadlineAt },
                  ]),
                  signal: deadline.signal,
                }),
              ]) as Promise<Response>);
              if (SafeReflectApply(SafeResponseStatus, admit, []) !== 200)
                throw new Error("Actor alarm admission denied");
              return SafeReflectApply(SafeResponseJson, admit, []) as Promise<unknown>;
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                deadline.abort();
                reject(new Error("Actor alarm admission deadline"));
              }, 5_000);
            }),
          ]);
          if (typeof selection !== "object" || selection === null)
            throw new Error("Actor alarm admission denied");
          const selected = selection as {
            variantKey?: unknown;
            generationKey?: unknown;
            epoch?: unknown;
            leaseId?: unknown;
            id?: unknown;
            attemptNonce?: unknown;
          };
          if (
            typeof selected.variantKey !== "string" ||
            typeof selected.generationKey !== "string" ||
            typeof selected.epoch !== "string" ||
            typeof selected.leaseId !== "string" ||
            !selected.leaseId ||
            typeof selected.id !== "string" ||
            typeof selected.attemptNonce !== "string" ||
            !SafeHasOwn(selection, "variantKey") ||
            !SafeHasOwn(selection, "generationKey") ||
            !SafeHasOwn(selection, "epoch") ||
            !SafeHasOwn(selection, "leaseId")
          )
            throw new Error("Actor alarm admission denied");
          const currentGraph = await this.currentGraph();
          if (
            selected.generationKey !== currentGraph.generationKey ||
            selected.epoch !== currentGraph.epoch ||
            selected.id !== claimed ||
            selected.attemptNonce !== attemptNonce
          )
            throw new Error("Actor alarm admission denied");
          if (Date.now() >= grantDeadlineAt) throw new Error("Actor alarm admission deadline");
          const variantIndex = currentGraph.variantKeys.indexOf(selected.variantKey);
          if (variantIndex < 0) throw new Error("Actor alarm admission denied");
          if (timer) clearTimeout(timer);
          timer = undefined;
          const child = await this.selectedChild(
            claimed,
            selected.variantKey,
            variantIndex,
            currentGraph,
          );
          const graphBeforeDelivery = await this.currentGraph();
          if (
            graphBeforeDelivery.generationKey !== currentGraph.generationKey ||
            graphBeforeDelivery.epoch !== currentGraph.epoch ||
            graphBeforeDelivery.variantKeys[variantIndex] !== selected.variantKey
          )
            throw new Error("Actor alarm graph changed before delivery");
          const request = new Request("http://actor.invalid/", {
            headers: { [DELIVERY_HEADER]: deliveryForEvent() },
            signal: deadline.signal,
          });
          const response = await Promise.race([
            child.fetch(request),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                deadline.abort();
                reject(new Error("Actor alarm deadline"));
              }, ALARM_HANDLER_MS);
            }),
          ]);
          if (response.status !== 204) throw new Error("Actor alarm delivery unavailable");
          await response.body?.cancel();
          succeeded = true;
        } catch {
          // The durable obligation survives, including any pending successor.
        } finally {
          if (timer) clearTimeout(timer);
        }
        let retirementFailed = false;
        const abortFacet = this.state.facets.abort;
        if (!abortFacet) {
          retirementFailed = true;
        } else {
          try {
            SafeReflectApply(abortFacet, this.state.facets, ["actor", "actor-alarm-retirement"]);
          } catch {
            retirementFailed = true;
          }
        }
        if (retirementFailed) this.poisoned = true;
        let settlementFailure: unknown;
        try {
          await this.control(async () => {
            const state = this.readAlarm();
            if (succeeded && !retirementFailed) {
              // Arm a successor before retiring its predecessor. If the owner
              // dies after settlement, the successor still has a native wake.
              if (state.pending !== null) await this.requireStorage().setAlarm(state.pending);
              this.requireStorage().sql.exec(
                "UPDATE actor_alarm_state SET obligation = 0, retry_at = NULL WHERE id = 1",
              );
            } else {
              const retryAt = Date.now() + ALARM_RETRY_MS;
              // An early wake before this write sees the old watchdog and
              // reconciles; a crash after it retains the short retry timer.
              await this.requireStorage().setAlarm(retryAt);
              this.requireStorage().sql.exec(
                "UPDATE actor_alarm_state SET retry_at = ? WHERE id = 1",
                retryAt,
              );
            }
            await this.reconcile();
          });
        } catch (error) {
          settlementFailure = error;
        }
        const admission = this.env.ADMISSION;
        if (!admission || !SafeResponseStatus)
          throw new Error("Actor alarm completion unavailable");
        let completed = false;
        for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
          const completionDeadline = new AbortController();
          let completionTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const completion = await Promise.race([
              SafeReflectApply(admission.fetch, admission, [
                new SafeRequest("http://actor.invalid/", {
                  method: "POST",
                  headers: admissionHeaders(),
                  body: SafeReflectApply(SafeJsonStringify, JSON, [
                    { action: "complete", attemptNonce, deadlineAt: grantDeadlineAt },
                  ]),
                  signal: completionDeadline.signal,
                }),
              ]) as Promise<Response>,
              new Promise<never>((_resolve, reject) => {
                completionTimer = setTimeout(() => {
                  completionDeadline.abort();
                  reject(new Error("Actor alarm completion deadline"));
                }, 1_000);
              }),
            ]);
            if (SafeReflectApply(SafeResponseStatus, completion, []) === 204) {
              completed = true;
            }
          } catch {
            // The attempt UUID makes a retry an idempotent release, not a replay.
          } finally {
            if (completionTimer) clearTimeout(completionTimer);
          }
        }
        if (!completed) {
          this.poisoned = true;
          throw new Error("Actor alarm completion unavailable");
        }
        if (settlementFailure !== undefined) throw settlementFailure;
      });
      this.tail = turn.catch(() => {});
      this.state.waitUntil(this.tail);
      return turn;
    }
    private async socketAdmission(actorId: string): Promise<{
      readonly variantIndex: number;
      readonly variantKey: string;
      readonly generationKey: string;
      readonly epoch: string;
      readonly attemptNonce: string;
      readonly deadlineAt: number;
    }> {
      const admission = this.env.ADMISSION;
      if (!admission || !SafeResponseStatus) throw new Error("Actor socket admission unavailable");
      const attemptNonce = SafeReflectApply(SafeCryptoRandomUUID, SafeCrypto, []) as string;
      const deadlineAt = Date.now() + 5_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = (await SafeReflectApply(admission.fetch, admission, [
          new SafeRequest("http://actor.invalid/", {
            method: "POST",
            headers: admissionHeaders(),
            body: SafeJsonStringify({ action: "socket", id: actorId, attemptNonce, deadlineAt }),
            signal: controller.signal,
          }),
        ])) as Response;
        if (SafeReflectApply(SafeResponseStatus, response, []) !== 200 || Date.now() >= deadlineAt)
          throw new Error("Actor socket admission denied");
        const selection: unknown = await SafeReflectApply(SafeResponseJson, response, []);
        if (typeof selection !== "object" || selection === null)
          throw new Error("Actor socket admission denied");
        const selected = selection as Record<string, unknown>;
        const currentGraph = await this.currentGraph();
        const variantIndex =
          typeof selected.variantKey === "string"
            ? currentGraph.variantKeys.indexOf(selected.variantKey)
            : -1;
        if (
          selected.id !== actorId ||
          selected.attemptNonce !== attemptNonce ||
          selected.generationKey !== currentGraph.generationKey ||
          selected.epoch !== currentGraph.epoch ||
          typeof selected.leaseId !== "string" ||
          !selected.leaseId ||
          variantIndex < 0
        )
          throw new Error("Actor socket admission denied");
        return {
          variantIndex,
          variantKey: selected.variantKey as string,
          generationKey: currentGraph.generationKey,
          epoch: currentGraph.epoch,
          attemptNonce,
          deadlineAt,
        };
      } finally {
        clearTimeout(timer);
      }
    }
    private async completeSocketAdmission(attemptNonce: string, deadlineAt: number): Promise<void> {
      const admission = this.env.ADMISSION;
      if (!admission || !SafeResponseStatus) throw new Error("Actor socket completion unavailable");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1_000);
        try {
          const response = (await SafeReflectApply(admission.fetch, admission, [
            new SafeRequest("http://actor.invalid/", {
              method: "POST",
              headers: admissionHeaders(),
              body: SafeJsonStringify({ action: "socket-complete", attemptNonce, deadlineAt }),
              signal: controller.signal,
            }),
          ])) as Response;
          if (SafeReflectApply(SafeResponseStatus, response, []) === 204) return;
        } catch {
          // The nonce makes a completion retry idempotent.
        } finally {
          clearTimeout(timer);
        }
      }
      this.poisoned = true;
      throw new Error("Actor socket completion unavailable");
    }
    private releaseInbound(entry: InboundSocketEvent): void {
      const connection = this.inbound.get(entry.socket);
      if (!connection?.events.delete(entry)) return;
      entry.event = undefined;
      entry.batch.delete(entry);
      connection.bytes -= entry.bytes;
      this.inboundBytes -= entry.bytes;
      this.inboundCount -= 1;
      if (connection.events.size === 0) this.inbound.delete(entry.socket);
    }
    private discardInbound(socket: NativeActorWebSocket): void {
      this.stoppedInbound.add(socket);
      for (const entry of this.inbound.get(socket)?.events ?? []) {
        // A delivered callback keeps its charge until it actually settles.
        if (!entry.batch.has(entry)) continue;
        this.releaseInbound(entry);
        entry.resolve();
      }
    }
    private socketEvent(
      socket: NativeActorWebSocket,
      event: SocketEvent,
      bytes = 0,
    ): Promise<void> {
      if (
        this.suppressedCloses.has(socket) ||
        this.closingInbound.has(socket) ||
        (event.kind === "message" && this.stoppedInbound.has(socket))
      )
        return Promise.resolve();
      const connection = this.inbound.get(socket) ?? {
        bytes: 0,
        events: new Set<InboundSocketEvent>(),
      };
      if (
        connection.events.size >= SOCKET_INBOUND_COUNT ||
        connection.bytes + bytes > SOCKET_INBOUND_BYTES ||
        this.inboundCount >= ACTOR_INBOUND_COUNT ||
        this.inboundBytes + bytes > ACTOR_INBOUND_BYTES
      ) {
        this.discardInbound(socket);
        if (event.kind === "close") {
          this.suppressedCloses.add(socket);
          // No later callback will retire this observed terminal connection.
          // Keep the separate in-flight inbound charge until settlement.
          for (const [socketId, record] of this.sockets) {
            if (record.socket !== socket) continue;
            record.status = "closed";
            this.sockets.delete(socketId);
          }
        }
        try {
          socket.close(1013, "inbound queue overloaded");
        } catch {
          /* peer already gone */
        }
        return Promise.resolve();
      }
      if (event.kind === "close") this.closingInbound.add(socket);
      if (!this.socketBatch) {
        const batch = new Set<InboundSocketEvent>();
        this.socketBatch = batch;
        const turn = this.tail.then(async () => {
          // One tail closure per consecutive socket batch, never per payload.
          // HTTP/alarm/reservation insertion seals this batch to preserve FIFO.
          for (const entry of batch) {
            batch.delete(entry);
            try {
              if (entry.event) await this.deliverSocketEvent(entry.socket, entry.event);
              entry.resolve();
            } catch (error) {
              this.discardInbound(entry.socket);
              entry.reject(error);
            } finally {
              this.releaseInbound(entry);
            }
          }
          if (this.socketBatch === batch) this.socketBatch = undefined;
        });
        this.tail = turn.catch(() => {});
        this.state.waitUntil(this.tail);
      }
      const batch = this.socketBatch;
      const promise = new Promise<void>((resolve, reject) => {
        const entry: InboundSocketEvent = { socket, event, bytes, batch, resolve, reject };
        connection.events.add(entry);
        batch.add(entry);
      });
      this.inbound.set(socket, connection);
      connection.bytes += bytes;
      this.inboundBytes += bytes;
      this.inboundCount += 1;
      return promise;
    }
    private async deliverSocketEvent(
      socket: NativeActorWebSocket,
      event: SocketEvent,
    ): Promise<void> {
      await this.ready;
      if (this.poisoned) throw new Error("Actor facet retirement failed");
      const metadata = socketMetadata(socket);
      if (!metadata) throw new Error("Actor socket metadata unavailable");
      const socketId = metadata.socketId;
      const actorId = metadata.actorId;
      if (event.kind === "close" && this.suppressedCloses.has(socket)) return;
      if (metadata.reservationBearer !== undefined) {
        const pending = this.liveSocket(socketId);
        if (pending?.status === "transport-pending") this.discardPending(pending);
        await this.reconcile();
        return;
      }
      let record = this.liveSocket(socketId);
      if (!record && event.kind === "close") {
        record = {
          socketId,
          actorId,
          nonce: "",
          protocol: "",
          attachment: decodeAttachment(metadata.attachment),
          queued: [],
          queuedBytes: 0,
          status: "live",
          socket,
        };
        this.sockets.set(socketId, record);
      }
      if (!record || record.socket !== socket) throw new Error("Actor socket unavailable");
      let admission: Awaited<ReturnType<typeof this.socketAdmission>> | undefined;
      let failed = false;
      let retired = false;
      let completionError: unknown;
      try {
        admission = await this.socketAdmission(actorId);
        const graphNow = await this.currentGraph();
        const key = graphNow.variantKeys[admission.variantIndex];
        if (
          key !== admission.variantKey ||
          graphNow.generationKey !== admission.generationKey ||
          graphNow.epoch !== admission.epoch
        )
          throw new Error("Actor socket variant unavailable");
        const child = await this.selectedChild(actorId, key, admission.variantIndex, graphNow);
        const graphBeforeDelivery = await this.currentGraph();
        if (
          graphBeforeDelivery.generationKey !== admission.generationKey ||
          graphBeforeDelivery.epoch !== admission.epoch ||
          graphBeforeDelivery.variantKeys[admission.variantIndex] !== admission.variantKey
        )
          throw new Error("Actor socket graph changed before delivery");
        const nonce = SafeReflectApply(SafeCryptoRandomUUID, SafeCrypto, []) as string;
        const controller = new AbortController();
        const body =
          event.kind === "message"
            ? event.data
            : SafeJsonStringify({
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
              });
        const headers = new SafeHeaders({
          [DELIVERY_HEADER]: deliveryForEvent(),
          [SOCKET_ACTION_HEADER]: event.kind === "message" ? "callback-message" : "callback-close",
          [SOCKET_NONCE_HEADER]: nonce,
          [SOCKET_ID_HEADER]: socketId,
        });
        if (event.kind === "message")
          headers.set(SOCKET_KIND_HEADER, typeof event.data === "string" ? "text" : "binary");
        this.activeSocketInvocation = { actorId, nonce, kind: "callback", accepting: false };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let retirementError: unknown;
        try {
          const response = await Promise.race([
            child.fetch(
              new SafeRequest("http://actor.invalid/", {
                method: "POST",
                headers,
                body,
                signal: controller.signal,
              }),
            ),
            new Promise<never>((_accept, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("Actor socket callback deadline"));
              }, deadlines.handlerMs);
            }),
          ]);
          if (response.status !== 204) throw new Error("Actor socket callback unavailable");
          await response.body?.cancel();
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
          this.activeSocketInvocation = undefined;
          const abortFacet = this.state.facets.abort;
          if (!abortFacet) {
            this.poisoned = true;
            retirementError = new Error("Actor facet retirement unavailable");
          } else {
            try {
              SafeReflectApply(abortFacet, this.state.facets, ["actor", "actor-socket-retirement"]);
              retired = true;
            } catch (error) {
              this.poisoned = true;
              retirementError = error;
            }
          }
        }
        if (retirementError !== undefined) throw retirementError;
      } catch {
        failed = true;
      } finally {
        if (admission && !retired) {
          const abortFacet = this.state.facets.abort;
          if (!abortFacet) this.poisoned = true;
          else {
            try {
              SafeReflectApply(abortFacet, this.state.facets, ["actor", "actor-socket-retirement"]);
              retired = true;
            } catch {
              this.poisoned = true;
            }
          }
        }
        if (admission) {
          try {
            await this.completeSocketAdmission(admission.attemptNonce, admission.deadlineAt);
          } catch (error) {
            failed = true;
            completionError = error;
          }
        }
      }
      if (failed || event.kind === "close") {
        const alreadyStopped = this.stoppedInbound.has(socket);
        this.discardInbound(socket);
        record.status = "closed";
        this.sockets.delete(socketId);
        this.suppressedCloses.add(socket);
        if (failed && event.kind !== "close" && !alreadyStopped) {
          try {
            socket.close(1011, "actor callback failed");
          } catch {
            /* peer already gone */
          }
        }
      }
      if (completionError !== undefined) throw completionError;
    }
    webSocketMessage(socket: NativeActorWebSocket, data: string | ArrayBuffer): Promise<void> {
      if (
        this.stoppedInbound.has(socket) ||
        this.suppressedCloses.has(socket) ||
        this.closingInbound.has(socket)
      )
        return Promise.resolve();
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
      if (bytes > SOCKET_MESSAGE_LIMIT) {
        this.discardInbound(socket);
        socket.close(1009, "message too large");
        return Promise.resolve();
      }
      return this.socketEvent(socket, { kind: "message", data }, bytes);
    }
    webSocketClose(
      socket: NativeActorWebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      return this.socketEvent(
        socket,
        { kind: "close", code, reason, wasClean },
        new TextEncoder().encode(reason).byteLength,
      );
    }
    webSocketError(socket: NativeActorWebSocket): Promise<void> {
      return this.webSocketClose(socket, 1006, "transport_error", false);
    }
    fetch(request: Request): Promise<Response> {
      if (request.headers.has(ALARM_ACTION_HEADER)) return this.alarmControl(request);
      if (request.headers.has(SOCKET_ACTION_HEADER)) return this.socketControl(request);
      if (request.headers.has(RESERVATION_ACTION_HEADER)) return this.reservationControl(request);
      let resolve!: (response: Response) => void;
      let reject!: (error: unknown) => void;
      const head = new Promise<Response>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      // The native input gate cannot stay closed while delivering a streaming
      // response: it defers the head and deadlocks the body pump. The owning
      // instance instead reserves the turn until the actual body terminates.
      this.socketBatch = undefined;
      const turn = this.tail.then(async () => {
        await this.ready;
        if (this.poisoned) throw new Error("Actor facet retirement failed");
        const encodedId = request.headers.get("x-takoserver-private-actor-id");
        if (!encodedId) throw new Error("Actor identity unavailable");
        const id = decodeURIComponent(encodedId);
        const variantKey = request.headers.get(VARIANT_HEADER);
        const currentGraph = await this.currentGraph();
        const variantIndex =
          variantKey === null ? -1 : currentGraph.variantKeys.indexOf(variantKey);
        if (variantIndex < 0) throw new Error("Actor variant unavailable");
        if (this.state.storage) {
          await this.control(async () => {
            const existing = this.readAlarm().actorId;
            if (existing !== null && existing !== id) throw new Error("Actor identity changed");
            if (existing === null)
              this.requireStorage().sql.exec(
                "UPDATE actor_alarm_state SET actor_id = ? WHERE id = 1",
                id,
              );
          });
        }
        const headers = new Headers(request.headers);
        headers.delete("x-takoserver-private-actor-id");
        headers.delete(VARIANT_HEADER);
        for (const name of [
          SOCKET_ACTION_HEADER,
          SOCKET_NONCE_HEADER,
          SOCKET_ID_HEADER,
          SOCKET_KIND_HEADER,
          UPGRADE_NONCE_HEADER,
          UPGRADE_DECISION_HEADER,
          UPGRADE_SOCKET_ID_HEADER,
          EVENT_SECRET_HEADER,
          RESERVATION_HEADER,
          RESERVATION_ACTION_HEADER,
        ])
          headers.delete(name);
        let childRequest: Request | undefined;
        let retirementError: unknown;
        const turnAbort = new AbortController();
        const headExpired = Symbol("actor-head-expired");
        let headTimer: ReturnType<typeof setTimeout> | undefined;
        const nonce = SafeReflectApply(SafeCryptoRandomUUID, SafeCrypto, []) as string;
        const eventDeliveryToken = deliveryForEvent();
        let upgrade: SocketRecord | undefined;
        let upgradeHeaders: Headers | undefined;
        try {
          const child = await this.selectedChild(
            id,
            variantKey as string,
            variantIndex,
            currentGraph,
          );
          const graphBeforeDelivery = await this.currentGraph();
          if (
            graphBeforeDelivery.generationKey !== currentGraph.generationKey ||
            graphBeforeDelivery.epoch !== currentGraph.epoch ||
            graphBeforeDelivery.variantKeys[variantIndex] !== variantKey
          )
            throw new Error("Actor graph changed before dispatch");
          headers.set(UPGRADE_NONCE_HEADER, nonce);
          if (deliveryToken === undefined) headers.set(EVENT_SECRET_HEADER, eventDeliveryToken);
          childRequest = withHeaders(
            request,
            headers,
            AbortSignal.any([request.signal, turnAbort.signal]),
          );
          this.activeSocketInvocation = {
            actorId: id,
            nonce,
            kind: "fetch",
            request,
            accepting: true,
          };
          // Start the admitted-event clock before invoking the child, including
          // its start hook. A non-cooperative fetch cannot retain the ID gate.
          const response = await Promise.race([
            Promise.resolve().then(() => child.fetch(childRequest as Request)),
            new Promise<never>((_accept, refuse) => {
              headTimer = setTimeout(() => refuse(headExpired), deadlines.handlerMs);
            }),
          ]);
          if (headTimer) clearTimeout(headTimer);
          headTimer = undefined;
          if (this.activeSocketInvocation) this.activeSocketInvocation.accepting = false;
          if (response.status === 204 && response.headers.has(UPGRADE_DECISION_HEADER)) {
            const socketId = response.headers.get(UPGRADE_SOCKET_ID_HEADER);
            const protocol = response.headers.get("sec-websocket-protocol") ?? "";
            const proposed = socketId ? this.sockets.get(socketId) : undefined;
            if (
              response.body !== null ||
              !proposed ||
              proposed.status !== "provisional" ||
              proposed.actorId !== id ||
              proposed.nonce !== nonce ||
              proposed.protocol !== protocol ||
              !(await verifyUpgradeDecision(
                eventDeliveryToken,
                nonce,
                encodedId,
                socketId as string,
                protocol,
                response.headers.get(UPGRADE_DECISION_HEADER),
              ))
            )
              throw new Error("Actor socket reservation unavailable");
            upgrade = proposed;
            upgradeHeaders = new Headers(response.headers);
            upgradeHeaders.delete(UPGRADE_DECISION_HEADER);
            upgradeHeaders.delete(UPGRADE_SOCKET_ID_HEADER);
          } else {
            this.discardProvisional(nonce);
            // Until a broker-owned, invocation-bound reservation is transferred,
            // a native 101 (including an application-created WebSocketPair) must
            // never escape this facet as an Actor upgrade.
            if (response.status === 101) throw new Error("Actor socket reservation unavailable");
            if (response.body === null) {
              resolve(response);
            } else {
              const source = response.body.getReader();
              let complete = false;
              let finishProducer!: () => void;
              const producerDone = new Promise<void>((accept) => {
                finishProducer = accept;
              });
              let producerTimer: ReturnType<typeof setTimeout> | undefined;
              const finish = () => {
                if (complete) return false;
                complete = true;
                if (producerTimer) clearTimeout(producerTimer);
                finishProducer();
                return true;
              };
              let bodyController!: ReadableStreamDefaultController<Uint8Array>;
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                },
                async pull(controller) {
                  try {
                    const chunk = await source.read();
                    if (complete) return;
                    if (chunk.done) {
                      if (finish()) controller.close();
                    } else {
                      controller.enqueue(chunk.value);
                    }
                  } catch (error) {
                    if (finish()) controller.error(error);
                  }
                },
                cancel(reason) {
                  if (finish()) void source.cancel(reason).catch(() => {});
                },
              });
              // This independent lease begins only once the response head exists.
              // Error the receiving stream before retiring the producer facet.
              producerTimer = setTimeout(() => {
                if (!finish()) return;
                bodyController.error(new Error("response_aborted"));
                void source.cancel("response_aborted").catch(() => {});
              }, deadlines.producerMs);
              resolve(
                new Response(body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                }),
              );
              await producerDone;
            }
          }
        } catch (error) {
          if (error === headExpired) resolve(new Response(null, { status: 504 }));
          else throw error;
        } finally {
          if (headTimer) clearTimeout(headTimer);
          this.activeSocketInvocation = undefined;
          turnAbort.abort(new Error("request_aborted"));
          try {
            if (childRequest?.body && !childRequest.body.locked)
              void childRequest.body.cancel("request_aborted").catch(() => {});
          } catch {
            /* an application-owned stream may already be locked or errored */
          }
          const abortFacet = this.state.facets.abort;
          if (!abortFacet) {
            retirementError = new Error("Actor facet retirement unavailable");
            this.poisoned = true;
          } else {
            try {
              SafeReflectApply(abortFacet, this.state.facets, ["actor", "actor-event-retirement"]);
            } catch (error) {
              retirementError = error;
              this.poisoned = true;
            }
          }
          this.discardProvisional(
            nonce,
            retirementError === undefined ? upgrade?.socketId : undefined,
          );
        }
        if (retirementError !== undefined) throw retirementError;
        if (upgrade) {
          let server: NativeActorWebSocket | undefined;
          try {
            const graphAtHandoff = await this.currentGraph();
            if (
              graphAtHandoff.generationKey !== currentGraph.generationKey ||
              graphAtHandoff.epoch !== currentGraph.epoch ||
              graphAtHandoff.variantKeys[variantIndex] !== variantKey
            )
              throw new Error("Actor graph changed before socket handoff");
            if (!this.state.acceptWebSocket || !NativeWebSocketPair)
              throw new Error("Actor socket transport unavailable");
            const pair = new NativeWebSocketPair();
            const client = pair[0];
            server = pair[1];
            const bearer = randomBearer();
            const expiresAt = (SafeReflectApply(SafeNow, Date, []) as number) + RESERVATION_MS;
            const storage = this.requireStorage();
            const actorAlarm = this.readAlarm();
            const actorWake = actorAlarm.obligation ? actorAlarm.retryAt : actorAlarm.pending;
            const otherPending = storage.sql
              .exec("SELECT MIN(expires_at) AS expiresAt FROM actor_socket_reservations")
              [Symbol.iterator]()
              .next().value?.expiresAt;
            const wake = SafeReflectApply(SafeMathMin, Math, [
              expiresAt,
              actorWake ?? expiresAt,
              alarmTime(otherPending) ? otherPending : expiresAt,
            ]) as number;
            await storage.setAlarm(wake);
            storage.sql.exec(
              "INSERT INTO actor_socket_reservations (socket_id, actor_id, bearer, expires_at) VALUES (?, ?, ?, ?)",
              upgrade.socketId,
              id,
              bearer,
              expiresAt,
            );
            this.state.acceptWebSocket(server);
            upgrade.socket = server;
            upgrade.status = "transport-pending";
            upgrade.reservationBearer = bearer;
            upgrade.reservationExpiresAt = expiresAt;
            upgrade.reservationGenerationKey = currentGraph.generationKey;
            upgrade.reservationEpoch = currentGraph.epoch;
            upgrade.reservationVariantKey = variantKey as string;
            this.persistSocket(upgrade);
            await this.reconcile();
            const transportHeaders = new Headers(upgradeHeaders);
            transportHeaders.set(RESERVATION_HEADER, bearer);
            resolve(
              new Response(null, {
                status: 101,
                webSocket: client,
                headers: transportHeaders,
              } as ResponseInit & { webSocket: NativeActorWebSocket }),
            );
          } catch (error) {
            upgrade.status = "closed";
            this.sockets.delete(upgrade.socketId);
            if (this.state.storage)
              this.requireStorage().sql.exec(
                "DELETE FROM actor_socket_reservations WHERE socket_id = ?",
                upgrade.socketId,
              );
            try {
              server?.close(1011, "socket establishment failed");
            } catch {
              /* not yet accepted */
            }
            throw error;
          }
        }
      });
      this.tail = turn.catch(reject);
      this.state.waitUntil(this.tail);
      return head;
    }
  };
}

export function createActorNativeIngress(token: string, alarmSecret?: string) {
  const expectedAlarmBearer = alarmSecret === undefined ? undefined : actorAlarmBearer(alarmSecret);
  return {
    async fetch(
      request: Request,
      env: {
        readonly NAMESPACE: {
          idFromName(name: string): unknown;
          get(id: unknown): { fetch(request: Request): Promise<Response> };
        };
      },
    ): Promise<Response> {
      const supplied = request.headers.get(TOKEN_HEADER);
      const id = request.headers.get(ID_HEADER);
      const control =
        supplied !== token &&
        supplied !== null &&
        id !== null &&
        expectedAlarmBearer !== undefined &&
        supplied === (await expectedAlarmBearer(id));
      if (supplied !== token && !control) return new Response(null, { status: 404 });
      if (!id) return new Response(null, { status: control ? 404 : 204 });
      const headers = new Headers(request.headers);
      headers.delete(TOKEN_HEADER);
      // Only the separate host-private port can carry a control action.
      if (!control) {
        headers.delete(ALARM_ACTION_HEADER);
        headers.delete(ALARM_AT_HEADER);
        headers.delete(DELIVERY_HEADER);
        for (const name of [
          SOCKET_ACTION_HEADER,
          SOCKET_NONCE_HEADER,
          SOCKET_ID_HEADER,
          SOCKET_KIND_HEADER,
          UPGRADE_NONCE_HEADER,
          UPGRADE_DECISION_HEADER,
          UPGRADE_SOCKET_ID_HEADER,
          EVENT_SECRET_HEADER,
          RESERVATION_HEADER,
          RESERVATION_ACTION_HEADER,
        ])
          headers.delete(name);
      } else {
        headers.delete(VARIANT_HEADER);
      }
      return env.NAMESPACE.get(env.NAMESPACE.idFromName(id)).fetch(withHeaders(request, headers));
    },
  };
}
