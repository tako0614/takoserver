/**
 * Host-private, request-local handoff for an unpublished Actor Response upgrade.
 * This module must load before untrusted Worker code. It never projects the
 * native 101 Response, WebSocket, reservation ID, or broker control methods.
 */
const NativeResponse = Response;
const NativeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const NativeResponseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const NativeResponseOk = Object.getOwnPropertyDescriptor(Response.prototype, "ok")?.get;
const NativeResponseStatusText = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "statusText",
)?.get;
const NativeResponseClone = Response.prototype.clone;
const NativeResponseWebSocket = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "webSocket",
)?.get;
const NativeHeaders = Headers;
const NativeHeadersAppend = Headers.prototype.append;
const NativeHeadersForEach = Headers.prototype.forEach;
const NativeObjectDefineProperty = Object.defineProperty;
const NativeTypeError = TypeError;
const NativeRequestMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
const NativeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;
const NativeRequestSignal = Object.getOwnPropertyDescriptor(Request.prototype, "signal")?.get;
const NativeHeadersGet = Headers.prototype.get;
const NativeAbortAdd = AbortSignal.prototype.addEventListener;
const NativeAbortRemove = AbortSignal.prototype.removeEventListener;
const NativeAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const NativeReflectApply = Reflect.apply;
const NativeObjectFreeze = Object.freeze;
const NativeWeakMap = WeakMap;
const NativeWeakMapGet = WeakMap.prototype.get;
const NativeWeakMapSet = WeakMap.prototype.set;
const NativeSet = Set;
const NativeSetAdd = Set.prototype.add;
const NativeSetDelete = Set.prototype.delete;
const NativeSetValues = Set.prototype.values;
const NativeSetClear = Set.prototype.clear;
const NativeStringLower = String.prototype.toLowerCase;
const NativeStringSplit = String.prototype.split;
const NativeStringTrim = String.prototype.trim;
const NativeStringStartsWith = String.prototype.startsWith;
const NativeNumberIsSafeInteger = Number.isSafeInteger;
const NativeSetTimeout = setTimeout;
const NativeClearTimeout = clearTimeout;

export interface NativeActorUpgradeReservation {
  /** Native 101 stays only in the Host-private wrapper. */
  readonly response: Response;
  /** Marks Host transport acceptance, not network receipt of the client head. */
  commit(): void | Promise<void>;
  /** Idempotently discards a provisional connection. */
  abandon(): void | Promise<void>;
}

/** Immutable evidence captured at the Host ingress, before app code runs. */
export interface NativeClientUpgradeEvidence {
  readonly method: string;
  readonly upgrade: string | null;
  readonly connection: string | null;
  readonly key: string | null;
  readonly version: string | null;
  readonly protocols: string | null;
  readonly origin: string | null;
}

export interface NativeActorUpgradeTransport {
  /**
   * Revalidate that ingress was a genuine client handshake, that the actor
   * request belongs to this invocation/tenant/incarnation, and that the
   * selected protocol is one offered by the client. A header snapshot alone
   * does not attest a connection. The broker owns its own one-shot expiry.
   */
  open(
    request: Request,
    ingress: NativeClientUpgradeEvidence,
  ): Promise<NativeActorUpgradeReservation>;
}

type Slot = {
  readonly owner: object;
  readonly reservation: NativeActorUpgradeReservation;
  readonly handshake: Headers;
  timer: ReturnType<typeof setTimeout> | undefined;
  state: "provisional" | "committing" | "committed" | "abandoned";
};

// Never expose this map, its values or a constructor parameter that can mint a slot.
const responseSlots = new NativeWeakMap<object, Response>();
/** Host-only alias resolution. Application modules cannot import this module. */
export function actorUpgradeResponseSource(value: unknown): Response | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? (NativeReflectApply(NativeWeakMapGet, responseSlots, [value]) as Response | undefined)
    : undefined;
}
function copyHeaders(source: Headers): Headers {
  const result = new NativeHeaders();
  NativeReflectApply(NativeHeadersForEach, source, [
    (value: string, name: string) => {
      NativeReflectApply(NativeHeadersAppend, result, [name, value]);
    },
  ]);
  return result;
}
function responseHeaders(response: Response): Headers {
  return NativeReflectApply(
    NativeResponseHeaders as NonNullable<typeof NativeResponseHeaders>,
    response,
    [],
  ) as Headers;
}

/**
 * Forward app ABI only. Native workerd disallows a socket-free native 101, so
 * the Response subclass holds a null-body 200 backing and exposes logical 101.
 * Its native backing never holds a socket. Only finish() emits the native 101.
 */
class ActorResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    const slot = actorUpgradeResponseSource(init);
    if (slot) {
      if (body != null || init?.status !== 101)
        throw new NativeTypeError("Actor upgrade requires status 101 and null body");
      super(null, {
        status: 200,
        statusText: "Switching Protocols",
        headers: copyHeaders(responseHeaders(init as Response)),
      });
      NativeReflectApply(NativeWeakMapSet, responseSlots, [this, slot]);
    } else {
      super(body, init);
      // Let the native constructor perform WebIDL coercion/getter reads once.
      // Reject even a string/coercing status or a native webSocket initializer.
      if (
        NativeReflectApply(
          NativeResponseStatus as NonNullable<typeof NativeResponseStatus>,
          this,
          [],
        ) === 101
      )
        throw new NativeTypeError("Actor upgrade reservation required");
    }
  }
  static override [Symbol.hasInstance](value: unknown): boolean {
    try {
      NativeReflectApply(
        NativeResponseStatus as NonNullable<typeof NativeResponseStatus>,
        value,
        [],
      );
      return true;
    } catch {
      return false;
    }
  }
  override get status(): number {
    return actorUpgradeResponseSource(this)
      ? 101
      : (NativeReflectApply(
          NativeResponseStatus as NonNullable<typeof NativeResponseStatus>,
          this,
          [],
        ) as number);
  }
  override get ok(): boolean {
    return actorUpgradeResponseSource(this)
      ? false
      : (NativeReflectApply(
          NativeResponseOk as NonNullable<typeof NativeResponseOk>,
          this,
          [],
        ) as boolean);
  }
  override get statusText(): string {
    return actorUpgradeResponseSource(this)
      ? "Switching Protocols"
      : (NativeReflectApply(
          NativeResponseStatusText as NonNullable<typeof NativeResponseStatusText>,
          this,
          [],
        ) as string);
  }
  override clone(): Response {
    return actorUpgradeResponseSource(this)
      ? new ActorResponse(null, this)
      : (NativeReflectApply(NativeResponseClone, this, []) as Response);
  }
}

/** Host-only mint, called only after the broker accepts. No token is stored on the Response. */
export function createActorUpgradeResponse(headers: Headers): Response {
  const response = new ActorResponse(null, { headers: copyHeaders(headers) });
  NativeReflectApply(NativeWeakMapSet, responseSlots, [response, response]);
  return response;
}

/** Call at forward Host-module evaluation, before importing/evaluating application modules. */
export function installActorResponseRuntime(): void {
  NativeObjectDefineProperty(globalThis, "Response", {
    value: ActorResponse,
    writable: true,
    configurable: true,
  });
}

const RESERVED_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "content-length",
  "transfer-encoding",
];
export function validActorUpgradeHeaders(headers: Headers, handshake: Headers): boolean {
  for (let index = 0; index < RESERVED_HEADERS.length; index += 1) {
    const name = RESERVED_HEADERS[index];
    if (
      NativeReflectApply(NativeHeadersGet, headers, [name]) !==
      NativeReflectApply(NativeHeadersGet, handshake, [name])
    )
      return false;
  }
  let valid = true;
  NativeReflectApply(NativeHeadersForEach, headers, [
    (_value: string, name: string) => {
      if (NativeReflectApply(NativeStringStartsWith, name, ["x-takoserver-private-"]))
        valid = false;
    },
  ]);
  return valid;
}

/** One scope per original incoming client request; never reuse across fetches. */
export function createActorUpgradeHandoff(
  original: Request,
  transport: NativeActorUpgradeTransport,
  reservationMs = 30_000,
): {
  readonly actor: Readonly<{ fetch(request: Request): Promise<Response> }>;
  finish(value: unknown): Promise<Response>;
  abandon(): Promise<void>;
} {
  if (
    !NativeResponseStatus ||
    !NativeResponseHeaders ||
    !NativeRequestMethod ||
    !NativeRequestHeaders ||
    !NativeRequestSignal ||
    !NativeAbortAborted ||
    !NativeNumberIsSafeInteger(reservationMs) ||
    reservationMs <= 0
  )
    throw new Error("Actor upgrade handoff unavailable");
  const signal = NativeReflectApply(NativeRequestSignal, original, []) as AbortSignal;
  const ingressHeaders = NativeReflectApply(NativeRequestHeaders, original, []) as Headers;
  const ingressGet = (name: string): string | null =>
    NativeReflectApply(NativeHeadersGet, ingressHeaders, [name]) as string | null;
  const ingress: NativeClientUpgradeEvidence = NativeObjectFreeze({
    method: NativeReflectApply(NativeRequestMethod, original, []) as string,
    upgrade: ingressGet("upgrade"),
    connection: ingressGet("connection"),
    key: ingressGet("sec-websocket-key"),
    version: ingressGet("sec-websocket-version"),
    protocols: ingressGet("sec-websocket-protocol"),
    origin: ingressGet("origin"),
  });
  const aborted = (): boolean => NativeReflectApply(NativeAbortAborted, signal, []) as boolean;
  const owner = NativeObjectFreeze({});
  const slots = new NativeWeakMap<Response, Slot>();
  const open = new NativeSet<Slot>();
  let closed = false;
  const unavailable = (): Response => new NativeResponse(null, { status: 503 });

  const settleAbandoned = async (slot: Slot): Promise<void> => {
    if (slot.state === "committed" || slot.state === "abandoned") return;
    slot.state = "abandoned";
    if (slot.timer !== undefined) NativeClearTimeout(slot.timer);
    NativeReflectApply(NativeSetDelete, open, [slot]);
    try {
      await slot.reservation.abandon();
    } catch {
      // Abandonment is best effort after the broker's independent expiry.
    }
  };
  const abandonOpen = async (except?: Slot): Promise<void> => {
    for (const slot of NativeReflectApply(NativeSetValues, open, []) as Iterable<Slot>) {
      if (slot !== except) await settleAbandoned(slot);
    }
  };
  const abortListener = (): void => {
    closed = true;
    void abandonOpen();
  };
  NativeReflectApply(NativeAbortAdd, signal, ["abort", abortListener, { once: true }]);
  if (aborted()) abortListener();

  const actor = NativeObjectFreeze({
    async fetch(request: Request): Promise<Response> {
      if (closed || aborted()) throw new Error("request_aborted");
      if (
        ingress.method !== "GET" ||
        typeof ingress.upgrade !== "string" ||
        NativeReflectApply(NativeStringLower, ingress.upgrade, []) !== "websocket"
      )
        throw new Error("invalid_upgrade");
      const reservation = await transport.open(request, ingress);
      let status: number;
      let selected: string | null;
      try {
        status = NativeReflectApply(NativeResponseStatus, reservation.response, []) as number;
        const responseHeaders = NativeReflectApply(
          NativeResponseHeaders,
          reservation.response,
          [],
        ) as Headers;
        selected = NativeReflectApply(NativeHeadersGet, responseHeaders, [
          "sec-websocket-protocol",
        ]) as string | null;
      } catch {
        await reservation.abandon();
        throw new Error("backend_unavailable");
      }
      if (status !== 101) {
        await reservation.abandon();
        throw new Error("backend_unavailable");
      }
      if (selected !== null) {
        const offered =
          ingress.protocols === null
            ? []
            : (NativeReflectApply(NativeStringSplit, ingress.protocols, [","]) as string[]);
        let matched = false;
        for (let i = 0; i < offered.length; i += 1) {
          if (NativeReflectApply(NativeStringTrim, offered[i], []) === selected) matched = true;
        }
        if (!matched) {
          await reservation.abandon();
          throw new Error("invalid_upgrade");
        }
      }
      if (closed || aborted()) {
        await reservation.abandon();
        throw new Error("request_aborted");
      }
      const handshake = copyHeaders(responseHeaders(reservation.response));
      const outcome = createActorUpgradeResponse(handshake);
      const slot: Slot = { owner, handshake, reservation, state: "provisional", timer: undefined };
      NativeReflectApply(NativeWeakMapSet, slots, [outcome, slot]);
      NativeReflectApply(NativeSetAdd, open, [slot]);
      slot.timer = NativeSetTimeout(() => {
        void settleAbandoned(slot);
      }, reservationMs);
      return outcome;
    },
  });

  return NativeObjectFreeze({
    actor,
    async finish(value: unknown): Promise<Response> {
      const alreadyClosed = closed;
      closed = true;
      const source = actorUpgradeResponseSource(value);
      const slot = source
        ? (NativeReflectApply(NativeWeakMapGet, slots, [source]) as Slot | undefined)
        : undefined;
      if (alreadyClosed || slot?.owner !== owner || slot.state !== "provisional" || aborted()) {
        await abandonOpen();
        NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
        if (alreadyClosed || source || aborted()) return unavailable();
        try {
          // An app-created native 101 is not an Actor reservation. This new
          // Actor path does not yet contract unrelated ordinary Worker WS.
          const status = NativeReflectApply(NativeResponseStatus, value, []);
          return status === 101 ? unavailable() : (value as Response);
        } catch {
          return unavailable();
        }
      }
      // Snapshot once, before any await. Later app mutation cannot alter the head.
      const headers = copyHeaders(responseHeaders(value as Response));
      if (!validActorUpgradeHeaders(headers, slot.handshake)) {
        await abandonOpen();
        NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
        return unavailable();
      }
      await abandonOpen(slot);
      if (slot.state !== "provisional" || aborted()) {
        await settleAbandoned(slot);
        return unavailable();
      }
      // Expiry and handoff are mutually exclusive in this isolate. The broker
      // must independently fence its own commit/abandon race by reservation ID.
      slot.state = "committing";
      if (slot.timer !== undefined) NativeClearTimeout(slot.timer);
      const wasAbandoned = (): boolean => slot.state === "abandoned";
      try {
        // Use captured native getters, not app-mutable ResponseInit accessors.
        // This response and its native socket never enter application code.
        const socket = NativeResponseWebSocket
          ? NativeReflectApply(NativeResponseWebSocket, slot.reservation.response, [])
          : undefined;
        const response = new NativeResponse(null, {
          status: 101,
          headers,
          webSocket: socket,
        } as ResponseInit);
        await slot.reservation.commit();
        if (wasAbandoned() || aborted()) {
          await settleAbandoned(slot);
          return unavailable();
        }
        slot.state = "committed";
        NativeReflectApply(NativeSetDelete, open, [slot]);
        return response;
      } catch {
        await settleAbandoned(slot);
        return unavailable();
      } finally {
        NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
      }
    },
    async abandon(): Promise<void> {
      closed = true;
      NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
      await abandonOpen();
      NativeReflectApply(NativeSetClear, open, []);
    },
  });
}
