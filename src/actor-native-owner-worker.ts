/** Host-private native owner. No public admission or namespace API is installed here. */
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
}

const ID_HEADER = "x-takoserver-private-actor-id";
const TOKEN_HEADER = "x-takoserver-private-actor-token";
const ALARM_ACTION_HEADER = "x-takoserver-private-alarm-action";
const ALARM_AT_HEADER = "x-takoserver-private-alarm-at";
const DELIVERY_HEADER = "x-takoserver-private-actor-delivery";
const VARIANT_HEADER = "x-takoserver-private-actor-variant";
const ALARM_RETRY_MS = 1_000;
const ALARM_WATCHDOG_MS = 35_000;
const ALARM_HANDLER_MS = 30_000;
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
const SafeIsSafeInteger = Number.isSafeInteger;
const SafeSubtle = crypto.subtle;
const SafeSubtleImportKey = crypto.subtle.importKey;
const SafeSubtleSign = crypto.subtle.sign;
const SafeCrypto = crypto;
const SafeCryptoRandomUUID = crypto.randomUUID;
const SafeJsonStringify = JSON.stringify;
const SafeEncoder = new TextEncoder();
const SafeEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const HEX = "0123456789abcdef";

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

function alarmTime(value: unknown): value is number {
  return typeof value === "number" && SafeIsSafeInteger(value) && value >= 0;
}

/** Private owner transport; the actor cannot choose another namespace or ID. */
export function createActorNativeAlarmPort(
  service: { fetch(request: Request): Promise<Response> },
  secret: string,
  id: string,
) {
  const fetch = service.fetch;
  const encodedId = SafeEncodeURIComponent(id);
  const bearer = actorAlarmBearer(secret)(encodedId);
  const call = async (action: "set" | "get" | "clear", at?: number): Promise<number | null> => {
    const headers = new SafeHeaders({
      [TOKEN_HEADER]: await bearer,
      [ID_HEADER]: encodedId,
      [ALARM_ACTION_HEADER]: action,
    });
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

// Bun currently retains the original headers when cloning a Request with an
// empty replacement Headers. Rebuild from the URL so the private hop headers
// cannot reach the application even when they were the only headers present.
function withHeaders(request: Request, headers: Headers): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
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
  deliveryToken: string,
  admissionToken: string,
  graph: {
    readonly generationKey: string;
    readonly epoch: string;
    readonly variantKeys: readonly string[];
  },
) {
  if (!/^[a-f0-9]{64}$/u.test(deliveryToken) || !/^[a-f0-9]{64}$/u.test(admissionToken))
    throw new Error("Actor delivery capability unavailable");
  if (
    !/^[a-f0-9]{64}$/u.test(graph.generationKey) ||
    typeof graph.epoch !== "string" ||
    !graph.epoch ||
    !Array.isArray(graph.variantKeys) ||
    graph.variantKeys.length === 0 ||
    graph.variantKeys.some((key) => typeof key !== "string" || !key) ||
    new Set(graph.variantKeys).size !== graph.variantKeys.length
  )
    throw new Error("Actor alarm graph bindings unavailable");
  const variantKeys = Object.freeze([...graph.variantKeys]);
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
      const wake = alarm.obligation ? alarm.retryAt : alarm.pending;
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
    alarm(): Promise<void> {
      // Native wake joins the same per-ID actor-event queue as HTTP. Control
      // requests from a running child use the separate short storage queue.
      // Arm a durable watchdog *before* waiting behind a long HTTP producer:
      // native retry count is finite and a queued callback can itself expire.
      const queuedWake = this.control(async () => {
        const state = this.readAlarm();
        if (state.obligation || (state.pending !== null && state.pending <= Date.now()))
          await this.requireStorage().setAlarm(Date.now() + ALARM_WATCHDOG_MS);
        else await this.reconcile();
      });
      void queuedWake.catch(() => {});
      const turn = this.tail.then(async () => {
        await queuedWake;
        if (this.poisoned) throw new Error("Actor facet retirement failed");
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
                  headers: new SafeHeaders({
                    "x-takoserver-private-alarm-admission": admissionToken,
                  }),
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
          if (
            selected.generationKey !== graph.generationKey ||
            selected.epoch !== graph.epoch ||
            selected.id !== claimed ||
            selected.attemptNonce !== attemptNonce
          )
            throw new Error("Actor alarm admission denied");
          if (Date.now() >= grantDeadlineAt) throw new Error("Actor alarm admission deadline");
          const variantIndex = variantKeys.indexOf(selected.variantKey);
          if (variantIndex < 0) throw new Error("Actor alarm admission denied");
          if (timer) clearTimeout(timer);
          timer = undefined;
          const bindingName = `CLASS_${variantIndex}`;
          if (!SafeHasOwn(this.env, bindingName) || this.env[bindingName] === undefined)
            throw new Error("Actor alarm variant unavailable");
          const selectedClass = this.env[bindingName];
          const child = this.state.facets.get("actor", () => ({
            class: selectedClass,
            id: claimed,
          }));
          const request = new Request("http://actor.invalid/", {
            headers: { [DELIVERY_HEADER]: deliveryToken },
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
                  headers: new SafeHeaders({
                    "x-takoserver-private-alarm-admission": admissionToken,
                  }),
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
    fetch(request: Request): Promise<Response> {
      if (request.headers.has(ALARM_ACTION_HEADER)) return this.alarmControl(request);
      let resolve!: (response: Response) => void;
      let reject!: (error: unknown) => void;
      const head = new Promise<Response>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      // The native input gate cannot stay closed while delivering a streaming
      // response: it defers the head and deadlocks the body pump. The owning
      // instance instead reserves the turn until the actual body terminates.
      const turn = this.tail.then(async () => {
        await this.ready;
        if (this.poisoned) throw new Error("Actor facet retirement failed");
        const encodedId = request.headers.get("x-takoserver-private-actor-id");
        if (!encodedId) throw new Error("Actor identity unavailable");
        const id = decodeURIComponent(encodedId);
        const variantKey = request.headers.get(VARIANT_HEADER);
        const variantIndex = variantKey === null ? -1 : variantKeys.indexOf(variantKey);
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
        let childRequest: Request | undefined;
        let retirementError: unknown;
        try {
          const bindingName = `CLASS_${variantIndex}`;
          if (!SafeHasOwn(this.env, bindingName) || this.env[bindingName] === undefined)
            throw new Error("Actor variant unavailable");
          const child = this.state.facets.get("actor", () => ({
            class: this.env[bindingName],
            id,
          }));
          childRequest = withHeaders(request, headers);
          const response = await child.fetch(childRequest);
          if (response.body === null) {
            resolve(response);
          } else {
            const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
            resolve(
              new Response(readable, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }),
            );
            try {
              await response.body.pipeTo(writable);
            } catch {
              /* cancellation/error terminates this body, then releases the gate */
            }
          }
        } finally {
          try {
            if (childRequest?.body && !childRequest.body.locked)
              await childRequest.body.cancel("actor event retired");
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
        }
        if (retirementError !== undefined) throw retirementError;
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
      } else {
        headers.delete(VARIANT_HEADER);
      }
      return env.NAMESPACE.get(env.NAMESPACE.idFromName(id)).fetch(withHeaders(request, headers));
    },
  };
}
