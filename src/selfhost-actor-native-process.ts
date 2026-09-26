import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ACTOR_NATIVE_BOOTSTRAP_SOURCE } from "./generated/actor-native-bootstrap.ts";
import { SELFHOST_WORKER_PROJECT_ENV_EXPORT } from "./providers/selfhost-worker-wrapper.ts";
import { type WorkerdActiveActorGraph, writeWorkerdPrivateExecution } from "./workerd-runtime.ts";

/** Internal, selected bytes only. Never accepted as provider desired state. */
export interface WorkerdActorNamespaceOptions {
  readonly namespaceKey: string;
  readonly storagePath: string;
  readonly className: string;
  readonly graph: WorkerdActiveActorGraph;
  readonly signal: AbortSignal;
  /** Host authority callbacks; neither is exposed to application modules. */
  readonly admitAlarm: (
    id: string,
    attemptNonce: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly variantKey: string;
    readonly generationKey: string;
    readonly epoch: string;
    readonly leaseId: string;
  } | null>;
  readonly completeAlarm: (leaseId: string) => void;
}

export interface WorkerdActorNamespace {
  fetch(id: string, request: Request, variantKey: string): Promise<Response>;
  /** Settles when the native child exits, including an intentional close. */
  readonly exited: Promise<void>;
  readonly epoch: string;
  enableAlarmAdmission(): void;
  disableAlarmAdmission(): void;
  /** Ordinary retirement drains responses; a dead child can be reaped immediately. */
  close(): Promise<void>;
}

type AlarmGrant = NonNullable<Awaited<ReturnType<WorkerdActorNamespaceOptions["admitAlarm"]>>>;

/** Process-local bridge bookkeeping, never a second durable alarm authority. */
export function createActorAlarmAttemptRegistry(completeAlarm: (leaseId: string) => void) {
  type Attempt = {
    phase: "pending" | "granted" | "closed";
    leaseId?: string;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    expire?: () => void;
  };
  const attempts = new Map<string, Attempt>();
  const validDeadline = (deadlineAt: number): boolean =>
    Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now() && deadlineAt <= Date.now() + 5_000;
  const tombstone = (nonce: string, deadlineAt: number): void => {
    if (!validDeadline(deadlineAt)) return;
    const controller = new AbortController();
    const state: Attempt = {
      phase: "closed",
      controller,
      timer: setTimeout(
        () => {
          if (attempts.get(nonce) === state) attempts.delete(nonce);
        },
        Math.max(1, deadlineAt - Date.now()),
      ),
    };
    attempts.set(nonce, state);
  };
  return {
    async begin(
      _id: string,
      nonce: string,
      deadlineAt: number,
      admit: (signal: AbortSignal) => Promise<AlarmGrant | null>,
    ): Promise<AlarmGrant | null> {
      if (!validDeadline(deadlineAt) || attempts.has(nonce)) return null;
      const controller = new AbortController();
      let expire!: (value: null) => void;
      const expired = new Promise<null>((resolve) => {
        expire = resolve;
      });
      const state: Attempt = {
        phase: "pending",
        controller,
        expire: () => expire(null),
        timer: setTimeout(
          () => {
            if (state.phase !== "pending") return;
            state.phase = "closed";
            state.controller.abort();
            if (attempts.get(nonce) === state) attempts.delete(nonce);
            state.expire?.();
          },
          Math.max(1, deadlineAt - Date.now()),
        ),
      };
      attempts.set(nonce, state);
      const result = Promise.resolve()
        .then(() => admit(controller.signal))
        .then((grant) => {
          if (!grant) return null;
          if (state.phase !== "pending" || Date.now() >= deadlineAt) {
            completeAlarm(grant.leaseId);
            return null;
          }
          state.phase = "granted";
          state.leaseId = grant.leaseId;
          return grant;
        });
      return Promise.race([result, expired]);
    },
    complete(nonce: string, deadlineAt: number): void {
      const state = attempts.get(nonce);
      if (state) {
        if (state.phase === "closed") return;
        state.phase = "closed";
        state.controller.abort();
        clearTimeout(state.timer);
        state.expire?.();
        if (state.leaseId !== undefined) completeAlarm(state.leaseId);
        attempts.delete(nonce);
      }
      tombstone(nonce, deadlineAt);
    },
  };
}

/**
 * Private native namespace lifetime. Called only by HostedWorkerdRuntime using
 * the same operator-selected executable as its other children. No route,
 * provider capability or accepted-artifact selection is installed here.
 * Service/data bindings fail closed until their retained leases are composed.
 */
export async function openWorkerdActorNamespace(
  binary: string,
  options: WorkerdActorNamespaceOptions,
): Promise<WorkerdActorNamespace> {
  options.signal.throwIfAborted();
  if (
    !binary ||
    !isAbsolute(options.storagePath) ||
    !/^[a-f0-9]{64}$/u.test(options.namespaceKey) ||
    !options.className ||
    options.className.includes("\u0000")
  )
    throw new Error("unusable Actor namespace selection");
  const graph = structuredClone(options.graph);
  if (
    !/^[a-f0-9]{64}$/u.test(graph.generationKey) ||
    !graph.generation ||
    graph.versions.length === 0 ||
    graph.versions.length > 100 ||
    graph.workerResourceUid !== graph.versions[0]?.site.workerResourceUid
  )
    throw new Error("unusable Actor active graph");
  const epoch = randomBytes(32).toString("hex");
  const variantKeys = graph.versions.map((version) => version.variantKey);
  const token = randomBytes(32).toString("hex");
  const alarmToken = randomBytes(32).toString("hex");
  const deliveryToken = randomBytes(32).toString("hex");
  const admissionToken = randomBytes(32).toString("hex");
  const literal = JSON.stringify;
  const encoder = new TextEncoder();
  const nativeVariants = graph.versions.map((version, index) => {
    const site = structuredClone(version.site);
    const modules = new Map(
      [...version.modules].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
    );
    const hostModules = new Map(
      [...version.hostModules].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
    );
    if ((site.serviceBindings?.length ?? 0) > 0 || site.dataPlane) {
      throw new Error("Actor retained service/data binding composition unavailable");
    }
    const wrapper = site.hostEntrypoint;
    if (!wrapper || wrapper === site.mainModule || !hostModules.has(wrapper)) {
      throw new Error("Actor Version has no private environment projector");
    }
    const occupied = new Set([...modules.keys(), ...hostModules.keys(), site.mainModule]);
    const allocate = (stem: string): string => {
      let name = `${stem}.js`;
      for (let suffix = 1; occupied.has(name); suffix += 1) name = `${stem}-${suffix}.js`;
      occupied.add(name);
      return name;
    };
    const helper = allocate("__actor_bootstrap");
    const entry = allocate("__actor_entry");
    hostModules.set(helper, encoder.encode(ACTOR_NATIVE_BOOTSTRAP_SOURCE));
    hostModules.set(
      entry,
      encoder.encode(`import { createNativeActorExecution, createActorNativeAlarmPort } from ${literal(`./${helper}`)};
const SafeHeaders = Headers;
const SafeRequest = Request;
const SafeResponse = Response;
const SafeApply = Reflect.apply;
const SafeHeadersGet = Headers.prototype.get;
const SafeHeadersDelete = Headers.prototype.delete;
const SafeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers").get;
const SafeRequestSignal = Object.getOwnPropertyDescriptor(Request.prototype, "signal").get;
export class ActorChild {
  constructor(state, env) {
    const id = state.id.toString();
    const alarm = createActorNativeAlarmPort(env.__TAKOSERVER_ACTOR_ALARM_OWNER, ${literal(alarmToken)}, id);
    this.execution = Promise.all([import(${literal(`./${wrapper}`)}), import(${literal(`./${site.mainModule}`)})]).then(([wrapper, namespace]) => createNativeActorExecution({ namespace, exportName: ${literal(options.className)}, id, env: wrapper.${SELFHOST_WORKER_PROJECT_ENV_EXPORT}(env), storage: state.storage, alarm }));
  }
  async fetch(request) {
    const incoming = SafeApply(SafeRequestHeaders, request, []);
    if (SafeApply(SafeHeadersGet, incoming, ["x-takoserver-private-actor-delivery"]) === ${literal(deliveryToken)}) {
      await (await this.execution).alarm(SafeApply(SafeRequestSignal, request, []));
      return new SafeResponse(null, { status: 204 });
    }
    const headers = new SafeHeaders(incoming);
    SafeApply(SafeHeadersDelete, headers, ["x-takoserver-private-actor-delivery"]);
    SafeApply(SafeHeadersDelete, headers, ["x-takoserver-private-actor-variant"]);
    return (await this.execution).fetch(new SafeRequest(request, { headers }));
  }
}
export default { fetch() { return new Response(null, { status: 404 }); } };`),
    );
    return {
      site: {
        ...site,
        hostEntrypoint: entry,
        hostModules: [...hostModules.keys()].filter((name) => name !== entry),
      },
      modules,
      hostModules,
      className: "ActorChild",
      variantKey: version.variantKey,
      index,
      helper,
      entry,
    };
  });
  const first = nativeVariants[0];
  if (!first) throw new Error("unusable Actor active graph");
  const occupied = new Set([
    ...first.modules.keys(),
    ...first.hostModules.keys(),
    first.site.mainModule,
  ]);
  const allocateOwner = (): string => {
    let name = "__actor_owner.js";
    for (let suffix = 1; occupied.has(name); suffix += 1) name = `__actor_owner-${suffix}.js`;
    occupied.add(name);
    return name;
  };
  const owner = allocateOwner();
  const ownerModules = new Map(first.hostModules);
  ownerModules.set(
    owner,
    encoder.encode(`import { createActorNativeOwner, createActorNativeIngress } from ${literal(`./${first.helper}`)};
export const ActorOwner = createActorNativeOwner(${literal(deliveryToken)}, ${literal(admissionToken)}, ${JSON.stringify({ generationKey: graph.generationKey, epoch, variantKeys })});
export default createActorNativeIngress(${literal(token)}, ${literal(alarmToken)});`),
  );
  const root = await mkdtemp(join(tmpdir(), "tactor-"));
  await chmod(root, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let closing: Promise<void> | undefined;
  let verified = false;
  const attempts = createActorAlarmAttemptRegistry(options.completeAlarm);
  const validAttemptNonce = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  const admission = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        closing ||
        request.method !== "POST" ||
        request.headers.get("x-takoserver-private-alarm-admission") !== admissionToken
      )
        return new Response(null, { status: 503 });
      try {
        const body = await request.text();
        if (body.length > 4_096) return new Response(null, { status: 503 });
        const value: unknown = JSON.parse(body);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return new Response(null, { status: 503 });
        }
        const record = value as Record<string, unknown>;
        if (
          record.action === "complete" &&
          validAttemptNonce(record.attemptNonce) &&
          typeof record.deadlineAt === "number" &&
          Number.isSafeInteger(record.deadlineAt)
        ) {
          attempts.complete(record.attemptNonce, record.deadlineAt);
          return new Response(null, { status: 204 });
        }
        if (!verified) return new Response(null, { status: 503 });
        if (
          record.action !== undefined ||
          typeof record.id !== "string" ||
          !record.id ||
          !validAttemptNonce(record.attemptNonce) ||
          typeof record.deadlineAt !== "number" ||
          !Number.isSafeInteger(record.deadlineAt)
        ) {
          return new Response(null, { status: 503 });
        }
        const admissionResult = await attempts.begin(
          record.id,
          record.attemptNonce,
          record.deadlineAt,
          (signal) =>
            options.admitAlarm(record.id as string, record.attemptNonce as string, signal),
        );
        if (!admissionResult) return new Response(null, { status: 503 });
        if (
          !verified ||
          closing ||
          admissionResult.generationKey !== graph.generationKey ||
          admissionResult.epoch !== epoch ||
          !variantKeys.includes(admissionResult.variantKey) ||
          !admissionResult.leaseId
        ) {
          attempts.complete(record.attemptNonce, record.deadlineAt);
          return new Response(null, { status: 503 });
        }
        return Response.json(
          {
            id: record.id,
            attemptNonce: record.attemptNonce,
            ...admissionResult,
          },
          { status: 200 },
        );
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      verified = false;
      admission.stop(true);
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
      }
      // Retained namespace storage is deliberately outside this directory.
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    await mkdir(options.storagePath, { recursive: true, mode: 0o700 });
    const socket = join(root, "run.sock");
    const config = await writeWorkerdPrivateExecution({
      root,
      site: {
        ...first.site,
        hostModules: [...ownerModules.keys()].filter((name) => name !== first.site.hostEntrypoint),
      },
      modules: first.modules,
      hostModules: ownerModules,
      runSocketPath: socket,
      actor: {
        namespaceKey: options.namespaceKey,
        storagePath: options.storagePath,
        ownerModule: owner,
        className: "ActorChild",
        alarmAdmissionAddress: `127.0.0.1:${admission.port}`,
        variants: nativeVariants.map(
          ({
            site: variantSite,
            modules: variantModules,
            hostModules: variantHostModules,
            className,
          }) => ({
            site: {
              ...variantSite,
              hostModules: [...variantHostModules.keys()].filter(
                (name) => name !== variantSite.hostEntrypoint,
              ),
            },
            modules: variantModules,
            hostModules: variantHostModules,
            className,
          }),
        ),
      },
    });
    options.signal.throwIfAborted();
    child = Bun.spawn([binary, "serve", config, "--experimental"], {
      env: {},
      stdout: "ignore",
      stderr: "ignore",
    });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      options.signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Actor native child exited during startup");
      try {
        const response = await fetch("http://actor.invalid/", {
          unix: socket,
          headers: { "x-takoserver-private-actor-token": token },
          signal: AbortSignal.timeout(100),
        });
        if (response.status === 204) {
          ready = true;
          break;
        }
        await response.body?.cancel();
      } catch {
        /* startup socket is not ready yet */
      }
      await Bun.sleep(10);
    }
    if (!ready) throw new Error("Actor native child readiness unavailable");
    options.signal.throwIfAborted();
    const runningChild = child;
    return {
      exited: runningChild.exited.then(() => {
        verified = false;
      }),
      enableAlarmAdmission() {
        if (!closing && runningChild.exitCode === null) verified = true;
      },
      disableAlarmAdmission() {
        verified = false;
      },
      async fetch(id, request, variantKey) {
        if (closing || child?.exitCode !== null) throw new Error("Actor namespace unavailable");
        if (!variantKeys.includes(variantKey))
          throw new Error("Actor Version selection unavailable");
        const headers = new Headers(request.headers);
        headers.set("x-takoserver-private-actor-token", token);
        headers.set("x-takoserver-private-actor-id", encodeURIComponent(id));
        headers.set("x-takoserver-private-actor-variant", variantKey);
        // This private hop returns application redirects as response heads.
        // Following one here could escape the Unix socket with hop credentials.
        return fetch(new Request(request, { headers, redirect: "manual" }), {
          unix: socket,
          redirect: "manual",
        });
      },
      epoch,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
