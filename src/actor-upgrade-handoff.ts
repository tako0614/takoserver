/**
 * Host-private, request-local handoff for an unpublished opaque Actor upgrade.
 * This module must load before untrusted Worker code. It never projects the
 * native 101 Response, WebSocket, reservation ID, or broker control methods.
 */
const NativeResponse = Response;
const NativeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const NativeRequestMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
const NativeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;
const NativeRequestSignal = Object.getOwnPropertyDescriptor(Request.prototype, "signal")?.get;
const NativeHeadersGet = Headers.prototype.get;
const NativeAbortAdd = AbortSignal.prototype.addEventListener;
const NativeAbortRemove = AbortSignal.prototype.removeEventListener;
const NativeAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const NativeReflectApply = Reflect.apply;
const NativeObjectCreate = Object.create;
const NativeObjectFreeze = Object.freeze;
const NativeWeakMap = WeakMap;
const NativeWeakMapGet = WeakMap.prototype.get;
const NativeWeakMapSet = WeakMap.prototype.set;
const NativeWeakMapDelete = WeakMap.prototype.delete;
const NativeSet = Set;
const NativeSetAdd = Set.prototype.add;
const NativeSetDelete = Set.prototype.delete;
const NativeSetValues = Set.prototype.values;
const NativeSetClear = Set.prototype.clear;
const NativeStringLower = String.prototype.toLowerCase;
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
  readonly outcome: object;
  readonly reservation: NativeActorUpgradeReservation;
  timer: ReturnType<typeof setTimeout> | undefined;
  state: "provisional" | "committing" | "committed" | "abandoned";
};

/** One scope per original incoming client request; never reuse across fetches. */
export function createActorUpgradeHandoff(
  original: Request,
  transport: NativeActorUpgradeTransport,
  reservationMs = 30_000,
): {
  readonly actor: Readonly<{ fetch(request: Request): Promise<object> }>;
  finish(value: unknown): Promise<Response>;
  abandon(): Promise<void>;
} {
  if (
    !NativeResponseStatus ||
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
  const slots = new NativeWeakMap<object, Slot>();
  const open = new NativeSet<Slot>();
  let closed = false;
  const unavailable = (): Response => new NativeResponse(null, { status: 503 });

  const settleAbandoned = async (slot: Slot): Promise<void> => {
    if (slot.state === "committed" || slot.state === "abandoned") return;
    slot.state = "abandoned";
    if (slot.timer !== undefined) NativeClearTimeout(slot.timer);
    NativeReflectApply(NativeSetDelete, open, [slot]);
    NativeReflectApply(NativeWeakMapDelete, slots, [slot.outcome]);
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
    async fetch(request: Request): Promise<object> {
      if (closed || aborted()) throw new Error("request_aborted");
      if (
        ingress.method !== "GET" ||
        typeof ingress.upgrade !== "string" ||
        NativeReflectApply(NativeStringLower, ingress.upgrade, []) !== "websocket"
      )
        throw new Error("invalid_upgrade");
      const reservation = await transport.open(request, ingress);
      const status = NativeReflectApply(NativeResponseStatus, reservation.response, []);
      if (status !== 101) {
        await reservation.abandon();
        throw new Error("backend_unavailable");
      }
      if (closed || aborted()) {
        await reservation.abandon();
        throw new Error("request_aborted");
      }
      const outcome = NativeObjectFreeze(NativeObjectCreate(null)) as object;
      const slot: Slot = { outcome, reservation, state: "provisional", timer: undefined };
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
      closed = true;
      NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
      const slot =
        (typeof value === "object" && value !== null) || typeof value === "function"
          ? (NativeReflectApply(NativeWeakMapGet, slots, [value]) as Slot | undefined)
          : undefined;
      if (slot?.state !== "provisional" || aborted()) {
        await abandonOpen();
        if (aborted()) return unavailable();
        try {
          // An app-created native 101 is not an Actor reservation. This new
          // Actor path does not yet contract unrelated ordinary Worker WS.
          const status = NativeReflectApply(NativeResponseStatus, value, []);
          return status === 101 ? unavailable() : (value as Response);
        } catch {
          return unavailable();
        }
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
        await slot.reservation.commit();
      } catch {
        await settleAbandoned(slot);
        return unavailable();
      }
      if (wasAbandoned() || aborted()) {
        await settleAbandoned(slot);
        return unavailable();
      }
      slot.state = "committed";
      NativeReflectApply(NativeSetDelete, open, [slot]);
      NativeReflectApply(NativeWeakMapDelete, slots, [slot.outcome]);
      return slot.reservation.response;
    },
    async abandon(): Promise<void> {
      closed = true;
      NativeReflectApply(NativeAbortRemove, signal, ["abort", abortListener]);
      await abandonOpen();
      NativeReflectApply(NativeSetClear, open, []);
    },
  });
}
