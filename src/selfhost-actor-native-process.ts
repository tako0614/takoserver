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
  /** Callback admission is a fresh Host decision, never an alarm retry grant. */
  readonly admitSocket: WorkerdActorNamespaceOptions["admitAlarm"];
  readonly completeSocket: (leaseId: string) => void;
  /** Native negative-test seam only; production uses owner defaults. */
  readonly ownerDeadlines?: { readonly handlerMs: number; readonly producerMs: number };
}

export interface WorkerdActorNamespace {
  fetch(id: string, request: Request, variantKey: string): Promise<Response>;
  /** Private workerd-to-workerd duplex socket; never an untrusted URL or binding. */
  readonly actorProxySocketPath: string;
  /** Host-private target after live Resource and Version admission. */
  duplexTarget(
    id: string,
    variantKey: string,
  ): {
    readonly socketPath: string;
    readonly headers: Readonly<Record<string, string>>;
  };
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
  if (
    options.ownerDeadlines &&
    (!Number.isSafeInteger(options.ownerDeadlines.handlerMs) ||
      options.ownerDeadlines.handlerMs <= 0 ||
      !Number.isSafeInteger(options.ownerDeadlines.producerMs) ||
      options.ownerDeadlines.producerMs <= 0)
  )
    throw new Error("unusable Actor owner test deadline");
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
    const inspectionToken = randomBytes(32).toString("hex");
    hostModules.set(helper, encoder.encode(ACTOR_NATIVE_BOOTSTRAP_SOURCE));
    hostModules.set(
      entry,
      encoder.encode(`import { createNativeActorExecution, createActorNativeAlarmPort, createActorNativeSocketPort, signActorNativeUpgradeDecision, inspectActorClass } from ${literal(`./${helper}`)};
const SafeHeaders = Headers;
const SafeRequest = Request;
const SafeResponse = Response;
const SafeApply = Reflect.apply;
const SafeHeadersGet = Headers.prototype.get;
const SafeHeadersDelete = Headers.prototype.delete;
const SafeHeadersSet = Headers.prototype.set;
const SafeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers").get;
const SafeRequestSignal = Object.getOwnPropertyDescriptor(Request.prototype, "signal").get;
const SafeRequestMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method").get;
const SafeRequestUrl = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get;
const SafeRequestBody = Object.getOwnPropertyDescriptor(Request.prototype, "body")?.get;
const SafeRequestArrayBuffer = Request.prototype.arrayBuffer;
const SafeRequestJson = Request.prototype.json;
const SafeTextDecoder = TextDecoder;
const SafeTextDecode = TextDecoder.prototype.decode;
const SafeUint8Array = Uint8Array;
const SafeEncodeURIComponent = encodeURIComponent;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const INSPECTION_HEADER = "x-takoserver-private-actor-class-inspection";
const INSPECTION_TOKEN = ${literal(inspectionToken)};
const DELIVERY_TOKEN = ${literal(deliveryToken)};
const UPGRADE_NONCE = "x-takoserver-private-actor-upgrade-nonce";
const UPGRADE_DECISION = "x-takoserver-private-actor-upgrade-decision";
const UPGRADE_SOCKET_ID = "x-takoserver-private-actor-upgrade-socket-id";
const SOCKET_ACTION = "x-takoserver-private-actor-socket-action";
const SOCKET_NONCE = "x-takoserver-private-actor-socket-nonce";
const SOCKET_ID = "x-takoserver-private-actor-socket-id";
const SOCKET_KIND = "x-takoserver-private-actor-socket-kind";
let inspection;
async function inspectVersion(request) {
  const headers = SafeApply(SafeRequestHeaders, request, []);
  const method = SafeApply(SafeRequestMethod, request, []);
  const url = request.url;
  const authorized = SafeApply(SafeHeadersGet, headers, [INSPECTION_HEADER]) === INSPECTION_TOKEN;
  if (method !== "POST" || url !== "http://actor.invalid/__actor_class_inspection__" || !authorized)
    return new SafeResponse(null, { status: 404 });
  inspection ??= (async () => {
    try {
      const namespace = await import(${literal(`./${site.mainModule}`)});
      inspectActorClass(namespace, ${literal(options.className)});
      return 204;
    } catch {
      return 422;
    }
  })();
  return new SafeResponse(null, { status: await inspection });
}
export class ActorChild {
  constructor(state, env) {
    const id = state.id.toString();
    const alarm = createActorNativeAlarmPort(env.__TAKOSERVER_ACTOR_ALARM_OWNER, ${literal(alarmToken)}, id);
    this.id = id;
    this.execution = Promise.all([import(${literal(`./${wrapper}`)}), import(${literal(`./${site.mainModule}`)})]).then(([wrapper, namespace]) => createNativeActorExecution({ namespace, exportName: ${literal(options.className)}, id, env: wrapper.${SELFHOST_WORKER_PROJECT_ENV_EXPORT}(env), storage: state.storage, alarm, socketPort: nonce => createActorNativeSocketPort(env.__TAKOSERVER_ACTOR_ALARM_OWNER, ${literal(alarmToken)}, id, nonce) }));
  }
  async fetch(request) {
    const incoming = SafeApply(SafeRequestHeaders, request, []);
    if (SafeApply(SafeHeadersGet, incoming, ["x-takoserver-private-actor-delivery"]) === DELIVERY_TOKEN) {
      const action = SafeApply(SafeHeadersGet, incoming, [SOCKET_ACTION]);
      const execution = await this.execution;
      if (action === null) {
        await execution.alarm(SafeApply(SafeRequestSignal, request, []));
      } else {
        const nonce = SafeApply(SafeHeadersGet, incoming, [SOCKET_NONCE]);
        const socketId = SafeApply(SafeHeadersGet, incoming, [SOCKET_ID]);
        if (!nonce || !socketId || SafeApply(SafeRequestMethod, request, []) !== "POST")
          return new SafeResponse(null, { status: 503 });
        if (action === "callback-message") {
          const kind = SafeApply(SafeHeadersGet, incoming, [SOCKET_KIND]);
          if (kind !== "text" && kind !== "binary") return new SafeResponse(null, { status: 503 });
          const bytes = new SafeUint8Array(await SafeApply(SafeRequestArrayBuffer, request, []));
          if (bytes.byteLength > 8388608) return new SafeResponse(null, { status: 503 });
          const data = kind === "text" ? SafeApply(SafeTextDecode, new SafeTextDecoder("utf-8", { fatal: true }), [bytes]) : bytes;
          await execution.socketMessage(socketId, data, SafeApply(SafeRequestSignal, request, []), nonce);
        } else if (action === "callback-close") {
          const event = await SafeApply(SafeRequestJson, request, []);
          if (!event || typeof event !== "object" || !SafeNumberIsSafeInteger(event.code) || typeof event.reason !== "string" || typeof event.wasClean !== "boolean")
            return new SafeResponse(null, { status: 503 });
          await execution.socketClose(socketId, { code: event.code, reason: event.reason, wasClean: event.wasClean }, SafeApply(SafeRequestSignal, request, []), nonce);
        } else return new SafeResponse(null, { status: 503 });
      }
      return new SafeResponse(null, { status: 204 });
    }
    const headers = new SafeHeaders(incoming);
    const nonce = SafeApply(SafeHeadersGet, headers, [UPGRADE_NONCE]);
    const privateNames = ["x-takoserver-private-actor-delivery", "x-takoserver-private-actor-variant", UPGRADE_NONCE, UPGRADE_DECISION, UPGRADE_SOCKET_ID, SOCKET_ACTION, SOCKET_NONCE, SOCKET_ID, SOCKET_KIND];
    for (let index = 0; index < privateNames.length; index += 1)
      SafeApply(SafeHeadersDelete, headers, [privateNames[index]]);
    const appRequest = new SafeRequest(SafeRequestUrl ? SafeApply(SafeRequestUrl, request, []) : request.url, { method: SafeApply(SafeRequestMethod, request, []), headers, body: SafeRequestBody ? SafeApply(SafeRequestBody, request, []) : request.body, signal: SafeApply(SafeRequestSignal, request, []), redirect: "manual" });
    const execution = await this.execution;
    const result = await execution.fetch(appRequest, nonce ?? undefined);
    const upgrade = nonce ? execution.takeUpgrade(result, nonce) : null;
    if (!upgrade) return result;
    const decision = await signActorNativeUpgradeDecision(DELIVERY_TOKEN, nonce, SafeEncodeURIComponent(this.id), upgrade.socketId, upgrade.protocol ?? "");
    const responseHeaders = new SafeHeaders({ [UPGRADE_DECISION]: decision, [UPGRADE_SOCKET_ID]: upgrade.socketId });
    if (upgrade.protocol) SafeApply(SafeHeadersSet, responseHeaders, ["sec-websocket-protocol", upgrade.protocol]);
    return new SafeResponse(null, { status: 204, headers: responseHeaders });
  }
}
export default { fetch(request) { return inspectVersion(request); } };`),
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
      inspectionToken,
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
  const inspectionTokens = nativeVariants.map((variant) => variant.inspectionToken);
  ownerModules.set(
    owner,
    encoder.encode(`import { createActorNativeOwner, createActorNativeIngress } from ${literal(`./${first.helper}`)};
export const ActorOwner = createActorNativeOwner(${literal(deliveryToken)}, ${literal(admissionToken)}, ${JSON.stringify({ generationKey: graph.generationKey, epoch, variantKeys })}${options.ownerDeadlines ? `, ${JSON.stringify(options.ownerDeadlines)}` : ""});
const ingress = createActorNativeIngress(${literal(token)}, ${literal(alarmToken)});
const inspectionTokens = ${JSON.stringify(inspectionTokens)};
let inspections;
function inspectVersions(env) {
  inspections ??= Promise.all(inspectionTokens.map(async (inspectionToken, index) => {
    try {
      const binding = env[${literal("INSPECT_")} + index];
      const response = await binding.fetch(new Request("http://actor.invalid/__actor_class_inspection__", {
        method: "POST",
        headers: { "x-takoserver-private-actor-class-inspection": inspectionToken }
      }));
      return response.status;
    } catch {
      return 503;
    }
  })).then((statuses) => {
    return statuses.includes(422) ? 422 : statuses.every((status) => status === 204) ? 204 : 503;
  }).then((status) => {
    if (status === 503) inspections = undefined;
    return status;
  });
  return inspections;
}
export default {
  async fetch(request, env) {
    if (request.method === "GET" && request.url === "http://actor.invalid/" && request.headers.get("x-takoserver-private-actor-token") === ${literal(token)} && !request.headers.has("x-takoserver-private-actor-id")) {
      return new Response(null, { status: await inspectVersions(env) });
    }
    return ingress.fetch(request, env);
  }
};`),
  );
  const root = await mkdtemp(join(tmpdir(), "tactor-"));
  await chmod(root, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let closing: Promise<void> | undefined;
  let verified = false;
  const attempts = createActorAlarmAttemptRegistry(options.completeAlarm);
  const socketAttempts = createActorAlarmAttemptRegistry(options.completeSocket);
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
          (record.action === "complete" || record.action === "socket-complete") &&
          validAttemptNonce(record.attemptNonce) &&
          typeof record.deadlineAt === "number" &&
          Number.isSafeInteger(record.deadlineAt)
        ) {
          (record.action === "complete" ? attempts : socketAttempts).complete(
            record.attemptNonce,
            record.deadlineAt,
          );
          return new Response(null, { status: 204 });
        }
        if (!verified) return new Response(null, { status: 503 });
        if (
          (record.action !== undefined && record.action !== "socket") ||
          typeof record.id !== "string" ||
          !record.id ||
          !validAttemptNonce(record.attemptNonce) ||
          typeof record.deadlineAt !== "number" ||
          !Number.isSafeInteger(record.deadlineAt)
        ) {
          return new Response(null, { status: 503 });
        }
        const registry = record.action === "socket" ? socketAttempts : attempts;
        const admitEvent = record.action === "socket" ? options.admitSocket : options.admitAlarm;
        const admissionResult = await registry.begin(
          record.id,
          record.attemptNonce,
          record.deadlineAt,
          (signal) => admitEvent(record.id as string, record.attemptNonce as string, signal),
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
          registry.complete(record.attemptNonce, record.deadlineAt);
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
    const actorProxySocketPath = join(root, "upgrade.sock");
    const config = await writeWorkerdPrivateExecution({
      root,
      site: {
        ...first.site,
        hostModules: [...ownerModules.keys()].filter((name) => name !== first.site.hostEntrypoint),
      },
      modules: first.modules,
      hostModules: ownerModules,
      runSocketPath: socket,
      actorProxySocketPath,
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
    let lastReadinessStatus: number | undefined;
    const startupDeadlineAt = Date.now() + 20_000;
    for (let attempt = 0; attempt < 200 && Date.now() < startupDeadlineAt; attempt += 1) {
      options.signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Actor native child exited during startup");
      let response: Response;
      try {
        response = await fetch("http://actor.invalid/", {
          unix: socket,
          headers: { "x-takoserver-private-actor-token": token },
          signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, startupDeadlineAt - Date.now()))),
        });
        lastReadinessStatus = response.status;
      } catch {
        /* startup socket is not ready yet */
        await Bun.sleep(10);
        continue;
      }
      if (response.status === 204) {
        ready = true;
        break;
      }
      await response.body?.cancel();
      if (response.status === 422) throw new Error("Actor Version class inspection failed");
      await Bun.sleep(10);
    }
    if (!ready)
      throw new Error(
        `Actor native child readiness unavailable${lastReadinessStatus === undefined ? "" : ` (${lastReadinessStatus})`}`,
      );
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
      duplexTarget(id, variantKey) {
        if (closing || child?.exitCode !== null) throw new Error("Actor namespace unavailable");
        if (!id || id.includes("\u0000") || !variantKeys.includes(variantKey))
          throw new Error("Actor Version selection unavailable");
        return Object.freeze({
          socketPath: actorProxySocketPath,
          headers: Object.freeze({
            "x-takoserver-private-actor-token": token,
            "x-takoserver-private-actor-id": encodeURIComponent(id),
            "x-takoserver-private-actor-variant": variantKey,
          }),
        });
      },
      epoch,
      actorProxySocketPath,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
