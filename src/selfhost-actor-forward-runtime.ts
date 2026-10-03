import { createActorAddressing } from "./actor-addressing.ts";
import {
  type ActorAbiProfile,
  actorAbiProfile,
  resolveActorAbiProfile,
} from "./actor-class-execution.ts";
import { createActorNamespace } from "./actor-namespace-facade.ts";
import { createActorUpgradeHandoff } from "./actor-upgrade-handoff.ts";

export { installActorResponseRuntime } from "./actor-upgrade-handoff.ts";

/** Unpublished self-host forward binding. This module evaluates before tenant code. */
const NativeRequest = Request;
const NativeHeaders = Headers;
const NativeResponse = Response;
const SafeApply = Reflect.apply;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeWeakMap = WeakMap;
const SafeWeakMapGet = WeakMap.prototype.get;
const SafeWeakMapSet = WeakMap.prototype.set;
const SafeHeadersGet = Headers.prototype.get;
const SafeHeadersSet = Headers.prototype.set;
const SafeHeadersAppend = Headers.prototype.append;
const SafeHeadersDelete = Headers.prototype.delete;
const SafeHeadersForEach = Headers.prototype.forEach;
const SafeStringStartsWith = String.prototype.startsWith;
const SafeStringToLower = String.prototype.toLowerCase;
const SafeStringSplit = String.prototype.split;
const SafeStringTrim = String.prototype.trim;
const SafeEncodeURIComponent = encodeURIComponent;
const SafePromise = Promise;
const SafePromiseResolve = Promise.resolve;
const SafeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;
const SafeResponseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const SafeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const SafeResponseWebSocket = Object.getOwnPropertyDescriptor(Response.prototype, "webSocket")?.get;

export interface SelfhostActorForwardBinding {
  readonly publicName: string;
  readonly httpService: string;
  readonly upgradeService: string;
  readonly token: string;
  /** Trusted Host metadata; absent bindings retain the released Actor ABI. */
  readonly runtimeClassRef?: unknown;
}

type NativeService = { fetch(request: Request): Promise<Response> };
type Selection = { readonly binding: SelfhostActorForwardBinding; readonly id: string };

function safeHeaders(request: Request): Headers {
  if (!SafeRequestHeaders) throw new Error("Actor binding unavailable");
  const source = SafeApply(SafeRequestHeaders, request, []) as Headers;
  const copy = new NativeHeaders(source);
  const privateNames: string[] = [];
  SafeApply(SafeHeadersForEach, copy, [
    (_value: string, name: string) => {
      if (SafeApply(SafeStringStartsWith, name, ["x-takoserver-private-"]))
        privateNames[privateNames.length] = name;
    },
  ]);
  for (let index = 0; index < privateNames.length; index += 1)
    SafeApply(SafeHeadersDelete, copy, [privateNames[index]]);
  return copy;
}

function service(rawEnv: Record<string, unknown>, name: string): NativeService {
  const selected = rawEnv[name] as Partial<NativeService> | undefined;
  if (!selected || typeof selected.fetch !== "function")
    throw new Error("Actor binding unavailable");
  return selected as NativeService;
}

function bindRequest(request: Request, id: string, token: string): Request {
  const headers = safeHeaders(request);
  SafeApply(SafeHeadersSet, headers, ["x-takoserver-private-broker-token", token]);
  SafeApply(SafeHeadersSet, headers, [
    "x-takoserver-private-broker-actor-id",
    SafeApply(SafeEncodeURIComponent, undefined, [id]),
  ]);
  return new NativeRequest(request, { headers, redirect: "manual" });
}

/** Creates request-local facades; no raw binding, bearer or native socket reaches tenant env. */
export function createSelfhostActorForwardContext(options: {
  readonly original?: Request;
  readonly rawEnv: Record<string, unknown>;
  readonly bindings: readonly SelfhostActorForwardBinding[];
}): {
  readonly rawEnv: Record<string, unknown>;
  finish(value: unknown): Promise<Response>;
  abandon(): Promise<void>;
  failure(): Response;
} {
  const selected = new SafeWeakMap<Request, Selection>();
  const bindingProfiles = new SafeWeakMap<SelfhostActorForwardBinding, ActorAbiProfile>();
  const handoff = options.original
    ? createActorUpgradeHandoff(options.original, {
        async open(request, ingress) {
          const selection = SafeApply(SafeWeakMapGet, selected, [request]) as Selection | undefined;
          const connection =
            ingress.connection === null
              ? []
              : (SafeApply(SafeStringSplit, ingress.connection, [","]) as string[]);
          let offeredUpgrade = false;
          for (let index = 0; index < connection.length; index += 1) {
            const part = SafeApply(SafeStringTrim, connection[index], []) as string;
            if (SafeApply(SafeStringToLower, part, []) === "upgrade") offeredUpgrade = true;
          }
          if (
            !selection ||
            ingress.method !== "GET" ||
            ingress.version !== "13" ||
            !ingress.key ||
            !offeredUpgrade
          )
            throw new Error("invalid_upgrade");
          const binding = selection.binding;
          const profile = SafeApply(SafeWeakMapGet, bindingProfiles, [binding]) as
            | ActorAbiProfile
            | undefined;
          if (profile === undefined) throw new Error("Actor binding unavailable");
          const actorService = service(options.rawEnv, binding.upgradeService);
          const nativeFetch = actorService.fetch;
          const native = (await SafeApply(nativeFetch, actorService, [
            bindRequest(request, selection.id, binding.token),
          ])) as Response;
          if (!SafeResponseStatus || !SafeResponseHeaders || !SafeResponseWebSocket)
            throw new Error("Actor transport unavailable");
          const status = SafeApply(SafeResponseStatus, native, []) as number;
          const headers = SafeApply(SafeResponseHeaders, native, []) as Headers;
          const reservation = SafeApply(SafeHeadersGet, headers, [
            "x-takoserver-private-broker-reservation",
          ]) as string | null;
          const ownerBearer = SafeApply(SafeHeadersGet, headers, [
            "x-takoserver-private-actor-reservation",
          ]) as string | null;
          const socket = SafeApply(SafeResponseWebSocket, native, []) as WebSocket | null;
          if (
            status !== 101 ||
            !socket ||
            ownerBearer !== null ||
            !reservation ||
            !/^[a-f0-9-]{36}$/u.test(reservation)
          )
            throw new Error("Actor transport unavailable");
          const publicHeaders = new NativeHeaders();
          SafeApply(SafeHeadersForEach, headers, [
            (value: string, name: string) => {
              if (!SafeApply(SafeStringStartsWith, name, ["x-takoserver-private-"]))
                SafeApply(SafeHeadersAppend, publicHeaders, [name, value]);
            },
          ]);
          const response = new NativeResponse(null, {
            status: 101,
            webSocket: socket,
            headers: publicHeaders,
          } as ResponseInit & { webSocket: WebSocket });
          const control = async (action: "commit" | "abandon"): Promise<void> => {
            const controlRequest = new NativeRequest(
              `http://actor.invalid/__broker/${action}/${reservation}`,
              {
                method: "POST",
                headers: { "x-takoserver-private-broker-token": binding.token },
              },
            );
            const result = (await SafeApply(nativeFetch, actorService, [
              controlRequest,
            ])) as Response;
            if (SafeApply(SafeResponseStatus, result, []) !== 204)
              throw new Error("Actor transport control unavailable");
          };
          return SafeObjectFreeze({
            response,
            profile,
            commit: () => control("commit"),
            abandon: () => control("abandon"),
          });
        },
      })
    : undefined;
  const rawEnv = SafeObjectCreate(options.rawEnv) as Record<string, unknown>;
  for (let index = 0; index < options.bindings.length; index += 1) {
    const binding = options.bindings[index] as SelfhostActorForwardBinding;
    const runtimeClassRef = binding.runtimeClassRef;
    const profile =
      runtimeClassRef === undefined
        ? actorAbiProfile(undefined)
        : resolveActorAbiProfile(runtimeClassRef);
    SafeApply(SafeWeakMapSet, bindingProfiles, [binding, profile]);
    const addressing = createActorAddressing();
    const namespace = createActorNamespace({
      addressing,
      async invoke(id, request) {
        const requestHeaders = SafeApply(
          SafeRequestHeaders as NonNullable<typeof SafeRequestHeaders>,
          request,
          [],
        ) as Headers;
        const upgrade = SafeApply(SafeHeadersGet, requestHeaders, ["upgrade"]) as string | null;
        if (upgrade !== null && SafeApply(SafeStringToLower, upgrade, []) === "websocket") {
          if (!handoff) throw new Error("invalid_upgrade");
          SafeApply(SafeWeakMapSet, selected, [request, { binding, id }]);
          return handoff.actor.fetch(request);
        }
        const actorService = service(options.rawEnv, binding.httpService);
        const nativeFetch = actorService.fetch;
        const response = (await SafeApply(nativeFetch, actorService, [
          bindRequest(request, id, binding.token),
        ])) as Response;
        if (SafeResponseStatus && SafeApply(SafeResponseStatus, response, []) === 101)
          throw new Error("Actor HTTP transport unavailable");
        return response;
      },
    });
    SafeObjectDefineProperty(rawEnv, binding.publicName, {
      value: namespace,
      configurable: false,
      enumerable: true,
      writable: false,
    });
  }
  return SafeObjectFreeze({
    rawEnv,
    async finish(value: unknown): Promise<Response> {
      if (handoff) return handoff.finish(value);
      if (!(value instanceof NativeResponse)) return new NativeResponse(null, { status: 503 });
      return value;
    },
    abandon: (): Promise<void> =>
      handoff?.abandon() ?? (SafeApply(SafePromiseResolve, SafePromise, []) as Promise<void>),
    failure: (): Response => new NativeResponse(null, { status: 500 }),
  });
}
