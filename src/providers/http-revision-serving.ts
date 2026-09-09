import { canonicalJson, type JsonObject } from "../json.ts";

/** The logical identity shared by all provider-local HTTP revision services. */
export interface HttpRevisionServingIdentity {
  readonly resourceUid: string;
  readonly incarnationId: string;
}

/**
 * The only revision fields understood by the coordinator.  Provider-owned
 * configuration is carried by an extending type and is validated by the
 * caller at composition time.
 */
export interface HttpRevisionServingRevision extends HttpRevisionServingIdentity {
  readonly generation: number;
  readonly revision: string;
}

export interface HttpRevisionServingObservation {
  readonly state:
    | "absent"
    | "starting"
    | "updating"
    | "ready"
    | "unavailable"
    | "deleting"
    | "deleted";
  readonly desiredGeneration?: number;
  readonly servingGeneration?: number;
  readonly retiringGenerations?: readonly number[];
}

/** One backend readback.  The context is ephemeral invocation evidence. */
export interface HttpRevisionBackendObservation<NativeId extends string, Context = unknown> {
  readonly state: string;
  readonly nativeId?: NativeId;
  readonly context?: Context;
}

/**
 * Provider invocation operations.  The coordinator owns ordering and
 * authority; adapters own native transport and configuration interpretation.
 */
export interface HttpRevisionServingBackend<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context = unknown,
> {
  observe(revision: Revision): Promise<HttpRevisionBackendObservation<NativeId, Context>>;
  reconcile(revision: Revision): Promise<HttpRevisionBackendObservation<NativeId, Context>>;
  invoke(
    revision: Revision,
    request: Request,
    options: {
      readonly nativeId: NativeId;
      readonly context: Context | undefined;
      readonly signal: AbortSignal;
    },
  ): Promise<Response>;
  retire(revision: Revision, nativeId: NativeId): Promise<void>;
}

export interface HttpRevisionServingRevisionRecord<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
> {
  input: Revision;
  nativeId: NativeId | null;
  retireAt: number | null;
  absent: boolean;
  creating: boolean;
}

/** This is the durable shape consumed and written by a state port. */
export interface HttpRevisionServingSnapshot<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
> {
  version: 1;
  desired: number;
  serving: number | null;
  deleting: boolean;
  deleted: boolean;
  revisions: Array<HttpRevisionServingRevisionRecord<Revision, NativeId>>;
}

export interface HttpRevisionServingStatePort<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
> {
  load(
    identity: HttpRevisionServingIdentity,
  ): Promise<HttpRevisionServingSnapshot<Revision, NativeId> | null>;
  persist(
    identity: HttpRevisionServingIdentity,
    snapshot: HttpRevisionServingSnapshot<Revision, NativeId>,
  ): Promise<void>;
}

export type HttpRevisionServingErrorCode =
  | "invalid_request"
  | "conflict"
  | "unavailable"
  | "corrupt"
  | "closed";

export class HttpRevisionServingError extends Error {
  constructor(readonly code: HttpRevisionServingErrorCode) {
    super(`http_revision_serving_${code}`);
    this.name = "HttpRevisionServingError";
  }
}

export interface HttpRevisionServingOptions<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context = unknown,
> {
  readonly backend: HttpRevisionServingBackend<Revision, NativeId, Context>;
  readonly state: HttpRevisionServingStatePort<Revision, NativeId>;
  readonly drainTimeoutMs: number;
  /** Full Host-owned validation, including opaque provider configuration. */
  readonly validateRevision?: (revision: Revision) => Revision;
  /** Validation that must complete before invoking the durable state port. */
  readonly validateSnapshot?: (snapshot: HttpRevisionServingSnapshot<Revision, NativeId>) => void;
  readonly createError?: (code: HttpRevisionServingErrorCode) => Error;
}

export interface HttpRevisionServingHandle<Revision extends HttpRevisionServingRevision> {
  reconcile(revision: Revision): Promise<HttpRevisionServingObservation>;
  observe(identity: HttpRevisionServingIdentity): Promise<HttpRevisionServingObservation>;
  invoke(identity: HttpRevisionServingIdentity, request: Request): Promise<Response>;
  remove(identity: HttpRevisionServingIdentity): Promise<HttpRevisionServingObservation>;
  close(): Promise<void>;
}

export interface HttpRevisionServingCoordinator<Revision extends HttpRevisionServingRevision> {
  open(): HttpRevisionServingHandle<Revision>;
}

interface Call {
  owner: symbol;
  generation: number;
  abort: AbortController;
  finish(): void;
}

interface Service<Revision extends HttpRevisionServingRevision, NativeId extends string> {
  identity: HttpRevisionServingIdentity;
  state: HttpRevisionServingSnapshot<Revision, NativeId> | null;
  tail: Promise<void>;
  calls: Set<Call>;
  timer: ReturnType<typeof setTimeout> | null;
  failed: boolean;
  isStopping: () => boolean;
}

/**
 * Shared provider-internal lifecycle coordinator for immutable HTTP
 * revisions.  It has no filesystem, runtime, Docker, or URL assumptions:
 * adapters supply exact native operations and a durable state port.
 */
export function createHttpRevisionServing<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context = unknown,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
): HttpRevisionServingCoordinator<Revision> {
  if (!positive(options.drainTimeoutMs) || options.drainTimeoutMs > 60_000)
    fail(options, "invalid_request");

  const createError = options.createError ?? ((code) => new HttpRevisionServingError(code));
  const services = new Map<string, Promise<Service<Revision, NativeId>>>();
  let references = 0;
  let stopping = false;

  function open(): HttpRevisionServingHandle<Revision> {
    if (stopping) fail(options, "closed");
    references++;
    const owner = Symbol("http-revision-serving-handle");
    const closed = new AbortController();
    const operations = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;

    function run<T>(operation: () => Promise<T>): Promise<T> {
      if (closed.signal.aborted) return Promise.reject(createError("closed"));
      let result: Promise<T>;
      try {
        result = operation();
      } catch (error) {
        result = Promise.reject(error);
      }
      operations.add(result);
      void result.then(
        () => operations.delete(result),
        () => operations.delete(result),
      );
      return result;
    }

    function close(): Promise<void> {
      if (closing) return closing;
      closed.abort();
      references--;
      if (references === 0) stopping = true;
      closing = (async () => {
        for (const pending of services.values()) {
          const current = await pending.catch(() => null);
          if (current)
            for (const call of current.calls)
              if (call.owner === owner) {
                call.abort.abort();
                call.finish();
              }
        }
        await Promise.allSettled([...operations]);
        if (references === 0) {
          stopping = true;
          for (const pending of services.values()) {
            const current = await pending.catch(() => null);
            if (current) {
              if (current.timer !== null) clearTimeout(current.timer);
              await current.tail;
            }
          }
          services.clear();
        }
      })();
      return closing;
    }

    return {
      reconcile(input) {
        return run(async () => {
          const desired = validateInput(options, structuredCloneSafe(input));
          const current = await serviceFor(options, services, desired, () => stopping);
          return locked(options, current, async () => {
            if (closed.signal.aborted) fail(options, "closed");
            const previous = current.state;
            if (previous?.deleting) fail(options, "conflict");
            if (previous && desired.generation < previous.desired) fail(options, "conflict");
            const existing = previous?.revisions.find(
              (revision) => revision.input.generation === desired.generation,
            );
            if (
              existing &&
              canonicalJson(existing.input as unknown as JsonObject) !==
                canonicalJson(desired as unknown as JsonObject)
            )
              fail(options, "conflict");
            if (!existing) {
              if (
                previous?.revisions.some((revision) => revision.input.revision === desired.revision)
              )
                fail(options, "conflict");
              const next: HttpRevisionServingSnapshot<Revision, NativeId> = previous
                ? structuredCloneSafe(previous)
                : {
                    version: 1,
                    desired: desired.generation,
                    serving: null,
                    deleting: false,
                    deleted: false,
                    revisions: [],
                  };
              for (const revision of next.revisions) {
                if (
                  revision.input.generation !== next.serving &&
                  !revision.absent &&
                  revision.retireAt === null
                )
                  revision.retireAt = Date.now() + options.drainTimeoutMs;
              }
              next.desired = desired.generation;
              next.revisions.push({
                input: desired,
                nativeId: null,
                retireAt: null,
                absent: false,
                creating: true,
              });
              await persist(options, current, next, createError);
            }
            const known = revisionOf(options, cloneState(options, current), desired.generation);
            let recovered: HttpRevisionBackendObservation<NativeId, Context> | null = null;
            if (known.nativeId !== null || (existing && known.creating)) {
              const readback = await options.backend.observe(desired);
              if (readback.state === "absent") {
                // A timed-out backend call may still create after this read.
                // Only exact presence can settle that uncertainty.
                if (known.creating) fail(options, "unavailable");
                const repair = cloneState(options, current);
                revisionOf(options, repair, desired.generation).nativeId = null;
                if (repair.serving === desired.generation) repair.serving = null;
                await persist(options, current, repair, createError);
                for (const call of current.calls)
                  if (call.generation === desired.generation) {
                    call.abort.abort();
                    call.finish();
                  }
              } else {
                const nativeId = requireNative(options, readback);
                checkNative(options, known, nativeId);
                const resolved = cloneState(options, current);
                const revision = revisionOf(options, resolved, desired.generation);
                revision.nativeId = nativeId;
                revision.creating = false;
                await persist(options, current, resolved, createError);
                if (readback.state === "ready") recovered = readback;
              }
            }
            // An uncertain native response leaves intent durable for recovery.
            if (!recovered) {
              const pending = cloneState(options, current);
              revisionOf(options, pending, desired.generation).creating = true;
              await persist(options, current, pending, createError);
            }
            const observed = recovered ?? (await options.backend.reconcile(desired));
            const observedNative =
              observed.state === "absent" ? null : requireNative(options, observed);
            const next = cloneState(options, current);
            const candidate = revisionOf(options, next, desired.generation);
            if (observedNative !== null) {
              checkNative(options, candidate, observedNative);
              candidate.nativeId = observedNative;
            }
            candidate.creating = false;
            await persist(options, current, next, createError);
            if (observed.state === "ready") {
              // Native identity is durable before serving authority changes.
              const serving = cloneState(options, current);
              if (serving.serving !== desired.generation) {
                if (serving.serving !== null)
                  revisionOf(options, serving, serving.serving).retireAt =
                    Date.now() + options.drainTimeoutMs;
                serving.serving = desired.generation;
                await persist(options, current, serving, createError);
              }
            }
            schedule(options, current);
            return observation(options, current);
          });
        });
      },

      observe(identity) {
        return run(async () => {
          const current = await serviceFor(options, services, identity, () => stopping);
          schedule(options, current);
          return observation(options, current);
        });
      },

      invoke(identity, request) {
        return run(async () => {
          const current = await serviceFor(options, services, identity, () => stopping);
          if (closed.signal.aborted) fail(options, "closed");
          const state = current.state;
          if (!state || state.deleting || state.serving === null) fail(options, "unavailable");
          const selected = structuredCloneSafe(revisionOf(options, state, state.serving));
          const abort = new AbortController();
          const abortRequest = () => abort.abort();
          const call: Call = {
            owner,
            generation: selected.input.generation,
            abort,
            finish() {
              current.calls.delete(call);
              request.signal.removeEventListener("abort", abortRequest);
            },
          };
          // Selection and lease acquisition contain no await. Lifecycle awaits
          // never block admission to the still-serving revision.
          current.calls.add(call);
          request.signal.addEventListener("abort", abortRequest, { once: true });
          if (request.signal.aborted) abort.abort();
          try {
            const native = await options.backend.observe(selected.input);
            if (native.state !== "ready") fail(options, "unavailable");
            const nativeId = requireNative(options, native);
            checkNative(options, selected, nativeId);
            // Delete/drain/close may have fenced this call during readback.
            if (
              abort.signal.aborted ||
              closed.signal.aborted ||
              current.failed ||
              current.state?.deleting
            )
              fail(options, "unavailable");
            const response = await options.backend.invoke(selected.input, request, {
              nativeId,
              context: native.context,
              signal: abort.signal,
            });
            if (abort.signal.aborted) {
              await response.body?.cancel();
              fail(options, "unavailable");
            }
            return leasedResponse(options, response, call);
          } catch (error) {
            abort.abort();
            call.finish();
            throw error;
          }
        });
      },

      remove(identity) {
        return run(async () => {
          const current = await serviceFor(options, services, identity, () => stopping);
          return locked(options, current, async () => {
            if (closed.signal.aborted) fail(options, "closed");
            if (!current.state) return { state: "absent" };
            if (!current.state.deleting) {
              const next = cloneState(options, current);
              next.deleting = true;
              next.serving = null;
              for (const revision of next.revisions)
                if (!revision.absent && revision.retireAt === null)
                  revision.retireAt = Date.now() + options.drainTimeoutMs;
              await persist(options, current, next, createError);
            }
            const deadline = Math.max(
              0,
              ...current.state.revisions
                .filter((revision) => !revision.absent)
                .map((revision) => revision.retireAt ?? 0),
            );
            await waitUntil(options, deadline, closed.signal);
            await retire(options, current, createError);
            return observation(options, current);
          });
        });
      },

      close,
    };
  }

  return { open };
}

async function serviceFor<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  services: Map<string, Promise<Service<Revision, NativeId>>>,
  identity: HttpRevisionServingIdentity,
  isStopping: () => boolean,
): Promise<Service<Revision, NativeId>> {
  const key = identityKey(options, identity);
  let pending = services.get(key);
  if (!pending) {
    const stableIdentity = structuredCloneSafe({
      resourceUid: identity.resourceUid,
      incarnationId: identity.incarnationId,
    });
    pending = (async () => {
      const state: HttpRevisionServingSnapshot<Revision, NativeId> | null =
        await options.state.load(stableIdentity);
      const result: Service<Revision, NativeId> = {
        identity: stableIdentity,
        state: state ? validateSnapshot(options, state, key) : null,
        tail: Promise.resolve(),
        calls: new Set(),
        timer: null,
        failed: false,
        isStopping,
      };
      schedule(options, result);
      return result;
    })();
    services.set(key, pending);
    void pending.catch(() => services.delete(key));
  }
  const result = await pending;
  if (result.failed) fail(options, "unavailable");
  return result;
}

async function persist<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
  state: HttpRevisionServingSnapshot<Revision, NativeId>,
  createError: (code: HttpRevisionServingErrorCode) => Error,
): Promise<void> {
  options.validateSnapshot?.(state);
  try {
    await options.state.persist(service.identity, structuredCloneSafe(state));
  } catch (error) {
    service.failed = true;
    for (const call of service.calls) {
      call.abort.abort();
      call.finish();
    }
    if (isKnownServingError(error)) throw error;
    throw createError("unavailable");
  }
  service.state = state;
}

function locked<Revision extends HttpRevisionServingRevision, NativeId extends string, Context, T>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
  operation: () => Promise<T>,
): Promise<T> {
  const result = service.tail.then(() => {
    if (service.failed) fail(options, "unavailable");
    return operation();
  });
  service.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function schedule<Revision extends HttpRevisionServingRevision, NativeId extends string, Context>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
  futureOnly = false,
): void {
  if (service.isStopping() || service.failed || service.timer !== null || !service.state) return;
  const deadlines = service.state.revisions
    .filter(
      (revision) =>
        !revision.absent &&
        revision.retireAt !== null &&
        (!futureOnly || revision.retireAt > Date.now()),
    )
    .map((revision) => revision.retireAt as number);
  if (!deadlines.length) return;
  service.timer = setTimeout(
    () => {
      service.timer = null;
      if (!service.isStopping() && !service.failed) {
        // HTTP deadlines cannot wait behind a slow native candidate call.
        abortExpired(service);
        schedule(options, service, true);
        void locked(options, service, () =>
          retire(
            options,
            service,
            options.createError ?? ((code) => new HttpRevisionServingError(code)),
          ),
        ).catch(() => undefined);
      }
    },
    Math.max(0, Math.min(...deadlines) - Date.now()),
  );
}

function abortExpired<Revision extends HttpRevisionServingRevision, NativeId extends string>(
  service: Service<Revision, NativeId>,
): void {
  const expired = new Set(
    service.state?.revisions
      .filter((revision) => revision.retireAt !== null && revision.retireAt <= Date.now())
      .map((revision) => revision.input.generation),
  );
  for (const call of service.calls)
    if (expired.has(call.generation)) {
      call.abort.abort();
      call.finish();
    }
}

async function retire<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
  createError: (code: HttpRevisionServingErrorCode) => Error,
): Promise<void> {
  if (service.isStopping() || service.failed || !service.state) return;
  for (const revision of service.state.revisions) {
    if (revision.absent || revision.retireAt === null || revision.retireAt > Date.now()) continue;
    if (
      !service.state.deleting &&
      (revision.input.generation === service.state.serving ||
        revision.input.generation === service.state.desired)
    )
      fail(options, "corrupt");
    for (const call of service.calls)
      if (call.generation === revision.input.generation) {
        call.abort.abort();
        call.finish();
      }
    const observed = await options.backend.observe(revision.input);
    if (observed.state === "absent" && revision.creating) fail(options, "unavailable");
    if (observed.state !== "absent") {
      const nativeId = requireNative(options, observed);
      checkNative(options, revision, nativeId);
      const pinned = cloneState(options, service);
      revisionOf(options, pinned, revision.input.generation).nativeId = nativeId;
      revisionOf(options, pinned, revision.input.generation).creating = false;
      await persist(options, service, pinned, createError);
      await options.backend.retire(revision.input, nativeId);
      if ((await options.backend.observe(revision.input)).state !== "absent")
        fail(options, "conflict");
    }
    const next = cloneState(options, service);
    revisionOf(options, next, revision.input.generation).absent = true;
    await persist(options, service, next, createError);
  }
  if (
    service.state.deleting &&
    service.state.revisions.every((revision) => revision.absent) &&
    !service.state.deleted
  ) {
    const next = cloneState(options, service);
    next.deleted = true;
    await persist(options, service, next, createError);
  }
  schedule(options, service);
}

async function observation<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
): Promise<HttpRevisionServingObservation> {
  if (service.failed) fail(options, "unavailable");
  const snapshot = service.state;
  if (!snapshot) return { state: "absent" };
  const common = {
    desiredGeneration: snapshot.desired,
    ...(snapshot.serving === null ? {} : { servingGeneration: snapshot.serving }),
    retiringGenerations: snapshot.revisions
      .filter((revision) => revision.retireAt !== null && !revision.absent)
      .map((revision) => revision.input.generation),
  };
  if (snapshot.deleting) {
    if (snapshot.deleted)
      for (const revision of snapshot.revisions) {
        if ((await options.backend.observe(revision.input)).state !== "absent")
          fail(options, "conflict");
      }
    return { ...common, state: snapshot.deleted ? "deleted" : "deleting" };
  }
  if (snapshot.serving === null) return { ...common, state: "starting" };
  const serving = revisionOf(options, snapshot, snapshot.serving);
  const native = await options.backend.observe(serving.input);
  if (native.state !== "absent") checkNative(options, serving, requireNative(options, native));
  if (service.state !== snapshot) return observation(options, service);
  return {
    ...common,
    state:
      native.state === "ready"
        ? snapshot.desired === snapshot.serving
          ? "ready"
          : "updating"
        : "unavailable",
  };
}

function leasedResponse<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  response: Response,
  call: Call,
): Response {
  const headers = new Headers(response.headers);
  if (!response.body) {
    call.finish();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const reader = response.body.getReader();
  let complete = false;
  let abortBody: () => void;
  const finish = () => {
    if (!complete) {
      complete = true;
      call.abort.signal.removeEventListener("abort", abortBody);
      call.finish();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abortBody = () => {
        if (complete) return;
        controller.error(newError(options, "unavailable"));
        finish();
        void reader.cancel().catch(() => undefined);
      };
      call.abort.signal.addEventListener("abort", abortBody, { once: true });
      if (call.abort.signal.aborted) abortBody();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (complete) return;
        if (chunk.done) {
          finish();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        if (!complete) {
          finish();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      finish();
      const cancellation = reader.cancel(reason);
      call.abort.abort();
      await cancellation.catch(() => undefined);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function validateInput<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(options: HttpRevisionServingOptions<Revision, NativeId, Context>, input: Revision): Revision {
  assertBaseRevision(options, input);
  const validated = options.validateRevision ? options.validateRevision(input) : input;
  assertBaseRevision(options, validated);
  return validated;
}

function validateSnapshot<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  value: HttpRevisionServingSnapshot<Revision, NativeId>,
  key: string,
): HttpRevisionServingSnapshot<Revision, NativeId> {
  try {
    if (
      value.version !== 1 ||
      !positive(value.desired) ||
      (value.serving !== null && !positive(value.serving)) ||
      typeof value.deleting !== "boolean" ||
      typeof value.deleted !== "boolean" ||
      !Array.isArray(value.revisions) ||
      !value.revisions.length
    )
      fail(options, "corrupt");
    const snapshot = structuredCloneSafe(value);
    let generation = 0;
    const names = new Set<string>();
    for (const revision of snapshot.revisions) {
      if (
        !revision ||
        typeof revision !== "object" ||
        !("input" in revision) ||
        !("nativeId" in revision) ||
        !("retireAt" in revision) ||
        !("absent" in revision) ||
        !("creating" in revision) ||
        typeof revision.absent !== "boolean" ||
        typeof revision.creating !== "boolean" ||
        (revision.absent && revision.creating) ||
        (revision.nativeId !== null && typeof revision.nativeId !== "string") ||
        (revision.retireAt !== null &&
          (!Number.isSafeInteger(revision.retireAt) || revision.retireAt < 0))
      )
        fail(options, "corrupt");
      const input = validateInput(options, structuredCloneSafe(revision.input));
      if (
        identityKey(options, input) !== key ||
        input.generation <= generation ||
        names.has(input.revision)
      )
        fail(options, "corrupt");
      revision.input = input;
      generation = input.generation;
      names.add(input.revision);
    }
    if (
      snapshot.desired !== generation ||
      (snapshot.deleting && snapshot.serving !== null) ||
      (snapshot.deleted &&
        (!snapshot.deleting || snapshot.revisions.some((revision) => !revision.absent)))
    )
      fail(options, "corrupt");
    if (snapshot.serving !== null) {
      const serving = revisionOf(options, snapshot, snapshot.serving);
      if (serving.absent || serving.nativeId === null || serving.retireAt !== null)
        fail(options, "corrupt");
    }
    for (const revision of snapshot.revisions) {
      if (
        (revision.absent ||
          snapshot.deleting ||
          (revision.input.generation !== snapshot.desired &&
            revision.input.generation !== snapshot.serving)) &&
        revision.retireAt === null
      )
        fail(options, "corrupt");
    }
    if (!snapshot.deleting) {
      const desired = revisionOf(options, snapshot, snapshot.desired);
      if (desired.absent || desired.retireAt !== null) fail(options, "corrupt");
    }
    return snapshot;
  } catch {
    fail(options, "corrupt");
  }
}

function assertBaseRevision<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(options: HttpRevisionServingOptions<Revision, NativeId, Context>, input: Revision): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.resourceUid !== "string" ||
    input.resourceUid.length < 1 ||
    input.resourceUid.length > 256 ||
    typeof input.incarnationId !== "string" ||
    input.incarnationId.length < 1 ||
    input.incarnationId.length > 256 ||
    !positive(input.generation) ||
    typeof input.revision !== "string" ||
    input.revision.length < 1 ||
    input.revision.length > 256
  )
    fail(options, "invalid_request");
}

function cloneState<Revision extends HttpRevisionServingRevision, NativeId extends string, Context>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  service: Service<Revision, NativeId>,
): HttpRevisionServingSnapshot<Revision, NativeId> {
  if (!service.state) fail(options, "corrupt");
  return structuredCloneSafe(service.state);
}

function revisionOf<Revision extends HttpRevisionServingRevision, NativeId extends string, Context>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  snapshot: HttpRevisionServingSnapshot<Revision, NativeId>,
  generation: number,
): HttpRevisionServingRevisionRecord<Revision, NativeId> {
  const revision = snapshot.revisions.find((entry) => entry.input.generation === generation);
  if (!revision) fail(options, "corrupt");
  return revision;
}

function identityKey<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  identity: HttpRevisionServingIdentity,
): string {
  if (
    !identity ||
    typeof identity.resourceUid !== "string" ||
    identity.resourceUid.length < 1 ||
    identity.resourceUid.length > 256 ||
    typeof identity.incarnationId !== "string" ||
    identity.incarnationId.length < 1 ||
    identity.incarnationId.length > 256
  )
    fail(options, "invalid_request");
  return JSON.stringify([identity.resourceUid, identity.incarnationId]);
}

function requireNative<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  observation: HttpRevisionBackendObservation<NativeId, Context>,
): NativeId {
  if (observation.nativeId === undefined || typeof observation.nativeId !== "string")
    fail(options, "unavailable");
  return observation.nativeId;
}

function checkNative<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  revision: HttpRevisionServingRevisionRecord<Revision, NativeId>,
  nativeId: NativeId,
): void {
  if (revision.nativeId !== null && revision.nativeId !== nativeId) fail(options, "conflict");
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function structuredCloneSafe<T>(value: T): T {
  return structuredClone(value);
}

function newError<Revision extends HttpRevisionServingRevision, NativeId extends string, Context>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  code: HttpRevisionServingErrorCode,
): Error {
  return (options.createError ?? ((errorCode) => new HttpRevisionServingError(errorCode)))(code);
}

function fail<Revision extends HttpRevisionServingRevision, NativeId extends string, Context>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  code: HttpRevisionServingErrorCode,
): never {
  throw newError(options, code);
}

function isKnownServingError(error: unknown): boolean {
  return (
    error instanceof HttpRevisionServingError ||
    (error instanceof Error &&
      "code" in error &&
      ["invalid_request", "conflict", "unavailable", "corrupt", "closed"].includes(
        (error as { code?: unknown }).code as string,
      ))
  );
}

async function waitUntil<
  Revision extends HttpRevisionServingRevision,
  NativeId extends string,
  Context,
>(
  options: HttpRevisionServingOptions<Revision, NativeId, Context>,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) fail(options, "closed");
  if (deadline <= Date.now()) return;
  await new Promise<void>((resolvePromise, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(newError(options, "closed"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }, deadline - Date.now());
    signal.addEventListener("abort", abort, { once: true });
  });
}
