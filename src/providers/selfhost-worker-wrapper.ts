import {
  MAX_SELFHOST_EVENT_RESPONSE_BYTES,
  MAX_SELFHOST_QUEUE_DELAY_SECONDS,
  MAX_SELFHOST_QUEUE_MESSAGE_BYTES,
  MAX_SELFHOST_QUEUE_MESSAGES,
  SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_ENTRYPOINT,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
} from "./selfhost-events.ts";

/**
 * The entrypoint a self-hosted Worker Version is actually published as.
 *
 * workerd has a binding type for a string and one for parsed JSON, and that is
 * the whole of what a Worker Version's environment could be projected into
 * until now. It has no SQLite binding at all, and its KV binding is a wire
 * protocol to a service rather than a facade — so a version that declares
 * `kvBindings` or `sqliteBindings` cannot be handed to workerd directly and
 * still receive what the Interface promises.
 *
 * So the version is published through a generated module that imports the
 * tenant's own main module, builds `env` itself, and re-exports the handlers
 * the version declared. `env.KV` and `env.DB` are the exact `edge.kv@1.0.0`
 * and `edge.sql@1.0.0` facades the managed Cloudflare backend projects — same
 * methods, same options, same error names — implemented over this Host's own
 * data planes. ADR 0005 asks for the Binding facade rather than a raw wire
 * envelope or a provider-native client, and running on the operator's own
 * machine does not make that a different contract for the Bindings a wrapper
 * host projects. It is not a claim about every backend: an ordinary-workers
 * Worker carries a native Cloudflare R2 binding, while the managed
 * Workers-for-Platforms Worker receives the provider wrapper and its private
 * receipt Durable Object. That backend divergence is what
 * [ADR 0007](../../docs/adr/0007-objectbucket-joins-the-implementation-catalog.md)
 * records for `bucketBindings`.
 *
 * No secret is on this service. The per-version plane token and the plane's
 * `externalServer` live on a separate workerd service of this Host's own
 * (`selfhost-data-service.ts`), and the only thing this module is given is a
 * plain service binding to it. That is a structural claim rather than a
 * projection one: a binding belongs to the service it is declared on, and
 * workerd hands every binding of a service to every module that service runs —
 * `import { env } from "cloudflare:workers"` included. Leaving a value out of
 * the projected object never hid it. Leaving it off the service does.
 *
 * The service binding this module does hold reaches exactly two routes, and the
 * facade behind it rewrites every request completely, so a leak of the binding
 * into tenant code buys a KV call and a SQL call against the same Version's own
 * grant — not an address, not a token, and not a path anywhere else on this
 * machine. `disallow_importable_env` is set on this service besides, so
 * `cloudflare:workers` hands the tenant an empty environment.
 *
 * The intrinsics this module uses are captured at module scope, before the
 * tenant's module is imported, for the same reason the managed wrapper captures
 * them: after the first request the tenant's code has run, and a `Headers` or a
 * `JSON.stringify` it replaced would otherwise be the one this module calls.
 */

/**
 * Closed handler vocabulary of worker.runtime@1.1.0.
 *
 * `queue` and `scheduled` are re-exported when a Version declares them, so a
 * runtime that has a native trigger for either still reaches the tenant. On
 * this Host workerd has neither, so a declared `queue` or `scheduled` handler
 * is invoked through the event entrypoint below instead: a Host-owned gate
 * hands it one `takoserver.managed-worker-event@v1` envelope, and this module
 * projects the same portable batch the managed wrapper projects — same
 * `acknowledge`/`retry`/`acknowledgeAll`/`retryAll`, same base64 body, same
 * whole-batch default — so a Worker sees one contract on both backends.
 */
export const SELFHOST_WORKER_HANDLER_NAMES = ["fetch", "queue", "scheduled"] as const;

export type SelfhostWorkerHandlerName = (typeof SELFHOST_WORKER_HANDLER_NAMES)[number];

export const SELFHOST_WORKER_EDGE_KV_BINDING_KIND = "edge.kv@1.0.0" as const;
export const SELFHOST_WORKER_EDGE_SQL_BINDING_KIND = "edge.sql@1.0.0" as const;
/**
 * The exact Binding a `bucketBindings` declaration projects.
 *
 * Byte for byte the surface the managed Cloudflare wrapper projects over a
 * native `r2_bucket`: same nine methods, same option names, same error names,
 * same ceilings. What differs is what is behind it — this Host's own durable
 * object plane rather than R2, with upload rows and bodies it can reconcile
 * locally. The managed wrapper's receipt Durable Object protects its native
 * R2 multipart lifecycle, but provider-side discovery remains a separate
 * concern; this is precisely the backend difference ADR 0005 allows a
 * Binding facade to hide.
 */
export const SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND = "edge.objects@1.0.0" as const;

/** Names reserved for this Host; a public binding may never start with it. */
export const SELFHOST_WORKER_INTERNAL_BINDING_PREFIX = "__TAKOSERVER_" as const;
/**
 * The plain service binding the tenant's service holds.
 *
 * It carries no secret and names no address: it addresses the Host-owned
 * facade service, which is where the token and the `externalServer` live.
 */
export const SELFHOST_WORKER_DATA_SERVICE_BINDING = "__TAKOSERVER_SELFHOST_DATA" as const;
/**
 * The per-version bearer token, declared on the facade service only.
 *
 * Never on the tenant's service. `disallow_importable_env` is defence in depth
 * behind that, not the reason it is safe.
 */
export const SELFHOST_WORKER_DATA_TOKEN_BINDING = "__TAKOSERVER_SELFHOST_DATA_TOKEN" as const;

/** Module name the generated entrypoint is published under. */
export const SELFHOST_WORKER_ENTRYPOINT_MODULE = "__takoserver-selfhost-entrypoint.js" as const;

/**
 * Where this Host asks a published pair whether the tenant module really loads.
 *
 * The wrapper validates the declared handlers when it first imports the tenant
 * module, and until this existed that first import was a customer's request:
 * a version declaring a handler its module does not export was published, and
 * the attachment it enabled dropped the event. So the publication asks first,
 * through the workerd router, and the answer names the publication that gave
 * it — a stale configuration cannot pass for the new one.
 */
export const SELFHOST_WORKER_READINESS_PATH =
  "/.well-known/takoserver/selfhost-worker-readiness/v1" as const;
export const SELFHOST_WORKER_READINESS_PROTOCOL =
  "takoserver.selfhost-worker-readiness@v1" as const;
export const SELFHOST_WORKER_READINESS_RESULT_SCHEMA =
  "takoserver.selfhost-worker-readiness-result@v1" as const;
/** Header naming the protocol, so an ordinary tenant request cannot be one. */
export const SELFHOST_WORKER_READINESS_HEADER = "x-takoserver-selfhost-readiness" as const;

export interface SelfhostReadinessFailure {
  readonly reason: "declaration" | "module";
  readonly name?: string;
  readonly message?: string;
}

/** The readiness envelope, or null for anything that is not exactly one. */
export function selfhostReadinessAnswer(
  body: string,
): { readonly publication: string; readonly failure?: SelfhostReadinessFailure } | null {
  if (body.length > 8_192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const answer = parsed as Record<string, unknown>;
  if (
    answer.schema !== SELFHOST_WORKER_READINESS_RESULT_SCHEMA ||
    typeof answer.publication !== "string"
  ) {
    return null;
  }
  const failure = answer.failure;
  if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
    return { publication: answer.publication };
  }
  const detail = failure as Record<string, unknown>;
  if (detail.reason !== "declaration" && detail.reason !== "module") {
    return { publication: answer.publication };
  }
  return {
    publication: answer.publication,
    failure: {
      reason: detail.reason,
      ...(typeof detail.name === "string" ? { name: detail.name } : {}),
      ...(typeof detail.message === "string" ? { message: detail.message } : {}),
    },
  };
}

/**
 * What to tell an operator when the publication's own load probe says no.
 *
 * A module that throws while being imported and a module missing a declared
 * handler are different defects in different files, and the probe could only
 * say the second. An operator following "does not export every handler it
 * declares" against a module that exports all of them looks in the wrong
 * place; the real cause — a missing built-in, a top-level throw — was visible
 * only by running the runtime by hand.
 */
export function selfhostReadinessFailureMessage(
  failure: SelfhostReadinessFailure | undefined,
): string {
  if (failure?.reason === "module") {
    const detail = [failure.name ?? "Error", failure.message].filter(Boolean).join(": ");
    return `the Worker Version's module failed to load: ${detail}`;
  }
  // "does not export every handler it declares" is one of four things the
  // wrapper can mean, and the other three are about the default export rather
  // than the handler list. Collapsing them here would re-create the
  // mis-direction one level down: an operator told the handler list is wrong
  // reads a list that is right.
  return failure?.message
    ? `the Worker Version's module is not what it declares: ${failure.message}`
    : "the Worker Version's module does not export every handler it declares";
}

export const SELFHOST_DATA_PLANE_PATH_PREFIX = "/.well-known/takoserver/selfhost-data/v1" as const;
export const SELFHOST_DATA_PLANE_KV_PATH = `${SELFHOST_DATA_PLANE_PATH_PREFIX}/kv` as const;
export const SELFHOST_DATA_PLANE_SQL_PATH = `${SELFHOST_DATA_PLANE_PATH_PREFIX}/sql` as const;
/** Where the `edge.queue` producer facade sends what a Worker accepted. */
export const SELFHOST_DATA_PLANE_QUEUE_PATH = `${SELFHOST_DATA_PLANE_PATH_PREFIX}/queue` as const;
/**
 * Where an object body crosses, and why it is not one of the three above.
 *
 * A KV value, a SQL row, and a queue message are small enough to be JSON. An
 * object is up to 5 GiB, and base64 inside a JSON envelope would mean holding
 * a third of a gigabyte in an isolate to write a hundred megabytes. So this
 * route carries the bytes as the body and the operation as one header, in both
 * directions, and nothing on it is ever buffered whole.
 */
export const SELFHOST_DATA_PLANE_OBJECTS_PATH =
  `${SELFHOST_DATA_PLANE_PATH_PREFIX}/objects` as const;
export const SELFHOST_DATA_PLANE_OBJECT_PROTOCOL = "takoserver.selfhost-object@v1" as const;
/** Base64url of the operation document, on the request. */
export const SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER = "x-takoserver-selfhost-object" as const;
/** Base64url of the object's own metadata, on a body-bearing answer. */
export const SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER =
  "x-takoserver-selfhost-object-result" as const;
export const SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE = "application/octet-stream" as const;
/**
 * The ceiling on either header.
 *
 * A key is at most 979 bytes and a content type 256 code points, so the whole
 * document fits several times over; the bound exists so a caller cannot make
 * this Host parse an arbitrary header before it has decided anything.
 */
export const MAX_SELFHOST_OBJECT_DOCUMENT_BYTES = 8_192;

export const SELFHOST_DATA_PLANE_PROTOCOL = "takoserver.selfhost-data@v1" as const;
export const SELFHOST_DATA_PLANE_CONTENT_TYPE =
  "application/vnd.takoserver.selfhost-data.v1+json" as const;

/**
 * The origin written on a data-plane request.
 *
 * It is never resolved. An `externalServer` binding delivers every `fetch` to
 * the address in the configuration whatever the URL says, so this exists only
 * to make the request well-formed and the plane's own logs readable.
 */
export const SELFHOST_DATA_PLANE_ORIGIN = "http://takoserver-selfhost-data.invalid" as const;

/**
 * Bytes a plane request or answer may carry, mirroring the managed facade's
 * SQL ceiling.
 *
 * It is also what bounds a KV value in practice. `edge.kv` permits 25 MiB and
 * values cross this seam base64-encoded, which is four bytes for every three:
 * a full 25 MiB value is about 33.3 MiB of body, so the largest value the
 * facade accepts fits inside this with room to spare rather than being refused
 * by a ceiling nobody wrote down.
 */
export const SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

/** A plain, secret, or JSON value workerd already carries as an env binding. */
export interface SelfhostWorkerNativeBindingDescriptor {
  readonly name: string;
  readonly type: "plain_text" | "json" | "secret_text";
}

/** A facade this module implements over a data plane, addressed by its name. */
export interface SelfhostWorkerDataBindingDescriptor {
  readonly kind:
    | typeof SELFHOST_WORKER_EDGE_KV_BINDING_KIND
    | typeof SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND
    | typeof SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND
    | typeof SELFHOST_WORKER_EDGE_SQL_BINDING_KIND;
  readonly publicName: string;
}

export type SelfhostWorkerBindingDescriptor =
  | SelfhostWorkerNativeBindingDescriptor
  | SelfhostWorkerDataBindingDescriptor;

export interface SelfhostWorkerEntrypointSourceInput {
  readonly originalMainModule: string;
  readonly declaredHandlers: readonly SelfhostWorkerHandlerName[];
  readonly bindings: readonly SelfhostWorkerBindingDescriptor[];
  /**
   * Which publication this module is. Echoed by the readiness route so a probe
   * can tell the configuration it asked for from the one workerd still served.
   */
  readonly publication: string;
  /**
   * The one hostname this Host's readiness probe arrives on.
   *
   * The route lives on the tenant's default `fetch`, and the runtime maps every
   * hostname the publication claims — customer custom domains included — to
   * that same service. So the route answers on the public internet, and what it
   * says has to depend on how the request got here. The probe's own address is
   * the only fact about a request the isolate can check that tenant code does
   * not supply, so the failure detail is answered on it and nowhere else.
   */
  readonly probeHostname: string;
  /**
   * Whether this publication exports the event entrypoint.
   *
   * True when the Worker has a Queue Consumer or a Cron Trigger attached, which
   * is the only reason to generate the named export at all: a version nothing
   * delivers to publishes the module it would have published anyway.
   */
  readonly events?: boolean;
  /**
   * Host-owned service bindings the tenant's own workerd service carries.
   *
   * `ASSETS` is the one today. It is declared on the tenant service by the
   * runtime rather than projected from a Version's own environment, so a module
   * published through this entrypoint would lose it unless the entrypoint hands
   * it on: the whole point of the projection is that `env` contains exactly
   * what it should, and the asset layer is part of what it should.
   *
   * The list is the caller's, derived from what the site actually renders,
   * rather than a name this module assumes. Nothing secret is ever on this
   * service, so passing one of its bindings through gives away nothing that
   * `import { env } from "cloudflare:workers"` would not have.
   */
  readonly services?: readonly string[];
}

const ARTIFACT_PART_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u;
const PUBLICATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const PROBE_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const NATIVE_BINDING_TYPES = new Set(["plain_text", "json", "secret_text"]);
const DATA_BINDING_KINDS = new Set<string>([
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
]);
const HANDLER_NAMES = new Set<string>(SELFHOST_WORKER_HANDLER_NAMES);

/**
 * Generates the only self-host module allowed to import a tenant's main module.
 *
 * The input is a closed object, validated field by field, so no unchecked
 * string can become an import specifier or a property name in the emitted
 * source.
 */
export function selfhostWorkerEntrypointSource(input: SelfhostWorkerEntrypointSourceInput): string {
  const normalized = normalizeSourceInput(input);
  const moduleSpecifier = `./${normalized.originalMainModule}`;
  const configuration = {
    declaredHandlers: [...normalized.declaredHandlers].sort(),
    bindings: normalized.bindings,
    services: normalized.services,
  };
  // `fetch` is always exported, whether or not the version declared it. The
  // readiness route lives on it, and a version that declares only `queue` must
  // answer an HTTP request the same way the managed wrapper does — with a 404,
  // not with a runtime error about a missing entrypoint.
  const handlers = [
    `  async fetch(request, rawEnv, rawContext) {
    const answered = await safeReadiness(request);
    if (answered) return answered;
${
  configuration.declaredHandlers.includes("fetch")
    ? `    return await invoke("fetch", [request], rawEnv, rawContext);`
    : `    return statusResponse(404);`
}
  },`,
    ...configuration.declaredHandlers
      .filter((handler) => handler !== "fetch")
      .map(
        (handler) => `  async ${handler}(event, rawEnv, rawContext) {
    return await invoke(${JSON.stringify(handler)}, [event], rawEnv, rawContext);
  },`,
      ),
  ].join("\n");

  // The named export exists only when something delivers to it. A Version with
  // no Consumer and no Cron Trigger publishes the module it published before
  // events were a thing this Host could carry.
  //
  // It is a named entrypoint rather than a path on `fetch` because that is the
  // isolation: the router hands customer traffic to the default export, and the
  // only binding that names this one is on a Host-owned gate service holding a
  // token no tenant can read. A customer POSTing the event path at the Worker's
  // own hostname reaches `fetch`, which does not know what an event is.
  const eventEntrypoint = normalized.events
    ? `
export const ${SELFHOST_WORKER_EVENT_ENTRYPOINT} = SafeApply(SafeObjectFreeze, SafeObject, [{
  async fetch(request, rawEnv, rawContext) {
    try {
      const url = new SafeURL(SafeApply(SafeRequestUrlGet, request, []));
      if (SafeApply(SafeURLPathnameGet, url, []) !== EVENT_PATH) return statusResponse(404);
      if (SafeApply(SafeRequestMethodGet, request, []) !== "POST") return statusResponse(404);
      const headers = SafeApply(SafeRequestHeadersGet, request, []);
      if (
        SafeApply(SafeHeadersGet, headers, ["content-type"]) !== EVENT_CONTENT_TYPE ||
        SafeApply(SafeHeadersGet, headers, [EVENT_HEADER]) !== EVENT_PROTOCOL
      ) {
        return statusResponse(404);
      }
      const event = await boundedEvent(request);
      if (event.kind === "queue") {
        if (!declares("queue")) return statusResponse(404);
        return await invokeQueue(event, rawEnv, rawContext);
      }
      if (!declares("scheduled")) return statusResponse(404);
      return await invokeScheduled(event, rawEnv, rawContext);
    } catch {
      // A status and nothing else. What the tenant threw is the tenant's, and
      // the pump reads a non-200 as "deliver this batch again".
      return statusResponse(500);
    }
  },
}]);
`
    : "";

  return `const RAW_CONFIGURATION = ${JSON.stringify(configuration)};
const DATA_SERVICE = ${JSON.stringify(SELFHOST_WORKER_DATA_SERVICE_BINDING)};
const READINESS_PATH = ${JSON.stringify(SELFHOST_WORKER_READINESS_PATH)};
const READINESS_PROTOCOL = ${JSON.stringify(SELFHOST_WORKER_READINESS_PROTOCOL)};
const READINESS_RESULT_SCHEMA = ${JSON.stringify(SELFHOST_WORKER_READINESS_RESULT_SCHEMA)};
const READINESS_HEADER = ${JSON.stringify(SELFHOST_WORKER_READINESS_HEADER)};
const PUBLICATION = ${JSON.stringify(normalized.publication)};
const PROBE_HOSTNAME = ${JSON.stringify(normalized.probeHostname)};
const KV_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_KV_PATH}`)};
const SQL_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`)};
const PROTOCOL = ${JSON.stringify(SELFHOST_DATA_PLANE_PROTOCOL)};
const CONTENT_TYPE = ${JSON.stringify(SELFHOST_DATA_PLANE_CONTENT_TYPE)};
const MAX_RESPONSE_BYTES = ${SELFHOST_DATA_PLANE_MAX_RESPONSE_BYTES};
const QUEUE_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_QUEUE_PATH}`)};
const OBJECTS_URL = ${JSON.stringify(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`)};
const OBJECT_PROTOCOL = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_PROTOCOL)};
const OBJECT_REQUEST_HEADER = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER)};
const OBJECT_RESULT_HEADER = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER)};
const OBJECT_CONTENT_TYPE = ${JSON.stringify(SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE)};
const OBJECTS_KIND = ${JSON.stringify(SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND)};
const MAX_OBJECT_DOCUMENT_BYTES = ${MAX_SELFHOST_OBJECT_DOCUMENT_BYTES};
const EVENT_PATH = ${JSON.stringify(SELFHOST_WORKER_EVENT_PATH)};
const EVENT_PROTOCOL = ${JSON.stringify(SELFHOST_WORKER_EVENT_PROTOCOL)};
const EVENT_CONTENT_TYPE = ${JSON.stringify(SELFHOST_WORKER_EVENT_CONTENT_TYPE)};
const EVENT_HEADER = ${JSON.stringify(SELFHOST_WORKER_EVENT_HEADER)};
const MAX_EVENT_BYTES = ${MAX_SELFHOST_EVENT_RESPONSE_BYTES};
const MAX_QUEUE_MESSAGES = ${MAX_SELFHOST_QUEUE_MESSAGES};
const MAX_QUEUE_MESSAGE_BYTES = ${MAX_SELFHOST_QUEUE_MESSAGE_BYTES};
const MAX_QUEUE_DELAY_SECONDS = ${MAX_SELFHOST_QUEUE_DELAY_SECONDS};

// Captured before the tenant module is imported: after its first request its
// code has run, and anything it replaced on a shared prototype would otherwise
// be what this module calls while holding the plane token.
const SafeApply = Reflect.apply;
const SafeOwnKeys = Reflect.ownKeys;
const SafeArrayIsArray = Array.isArray;
const SafeArrayBufferIsView = ArrayBuffer.isView;
const SafeArrayBufferSlice = ArrayBuffer.prototype.slice;
const SafeAtob = atob;
const SafeBtoa = btoa;
const SafeError = Error;
const SafeTypeError = TypeError;
const SafeJSONParse = JSON.parse;
const SafeJSONStringify = JSON.stringify;
const SafeMap = Map;
const SafeMapGet = Map.prototype.get;
const SafeMapHas = Map.prototype.has;
const SafeMapSet = Map.prototype.set;
const SafeMapDelete = Map.prototype.delete;
const SafeMathAbs = Math.abs;
const SafeMathMin = Math.min;
const SafeNumberIsFinite = Number.isFinite;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectKeys = Object.keys;
const SafeObjectPrototype = Object.prototype;
const SafeObjectSetPrototypeOf = Object.setPrototypeOf;
const SafePromise = Promise;
const SafePromiseResolve = Promise.resolve;
const SafePromiseThen = Promise.prototype.then;
const SafeRegExpTest = RegExp.prototype.test;
const SafeReadableStream = ReadableStream;
const SafeReadableStreamLockedGet = captureGetter(ReadableStream.prototype, "locked");
const SafeReadableStreamControllerClose = ReadableStreamDefaultController.prototype.close;
const SafeReadableStreamControllerEnqueue = ReadableStreamDefaultController.prototype.enqueue;
const SafeResponse = Response;
const SafeResponseText = Response.prototype.text;
const SafeResponseBodyGet = captureGetter(Response.prototype, "body");
const SafeResponseHeadersGet = captureGetter(Response.prototype, "headers");
const SafeResponseStatusGet = captureGetter(Response.prototype, "status");
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeSymbol = Symbol;
const SafeURL = URL;
const SafeHeadersGet = Headers.prototype.get;
const SafeRequestText = Request.prototype.text;
const SafeRequestUrlGet = captureGetter(Request.prototype, "url");
const SafeRequestMethodGet = captureGetter(Request.prototype, "method");
const SafeRequestHeadersGet = captureGetter(Request.prototype, "headers");
const SafeURLPathnameGet = captureGetter(URL.prototype, "pathname");
const SafeURLHostnameGet = captureGetter(URL.prototype, "hostname");
const SafeStringFromCharCode = String.fromCharCode;
const SafeTextDecoder = TextDecoder;
const SafeTextDecoderDecode = TextDecoder.prototype.decode;
const SafeTextEncoder = TextEncoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const SafeUint8ArraySet = Uint8Array.prototype.set;
const SafeDataViewBufferGet = captureGetter(DataView.prototype, "buffer");
const SafeDataViewByteLengthGet = captureGetter(DataView.prototype, "byteLength");
const SafeDataViewByteOffsetGet = captureGetter(DataView.prototype, "byteOffset");
const SafeTypedArrayBufferGet = captureGetter(Uint8Array.prototype, "buffer");
const SafeTypedArrayByteLengthGet = captureGetter(Uint8Array.prototype, "byteLength");
const SafeTypedArrayByteOffsetGet = captureGetter(Uint8Array.prototype, "byteOffset");

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const MAX_KV_KEY_BYTES = 467;
const MAX_KV_VALUE_BYTES = 26214400;
const MAX_KV_METADATA_BYTES = 1024;
const MAX_SQL_BYTES = 100000;
const MAX_SQL_PARAMETERS = 100;
const MAX_SQL_STATEMENTS = 100;
const MAX_SQL_ROWS = 10000;
const MAX_SQL_COLUMNS = 100;
const MAX_SQL_COLUMN_NAME_BYTES = 128;
const MAX_SQL_VALUE_BYTES = 1000000;
const MAX_SQL_ROW_BYTES = 2000000;
const MAX_SQL_RESULT_BYTES = 8388608;
const SQL_ERROR_CODES = ["sql_error", "numeric_out_of_range", "busy", "backend_unavailable"];
const KV_ERROR_CODES = [
  "invalid_key",
  "invalid_value",
  "invalid_argument",
  "invalid_cursor",
  "value_too_large",
  "metadata_too_large",
  "backend_unavailable",
];
const MAX_OBJECT_KEY_BYTES = 979;
const MAX_OBJECT_BYTES = 5368709120;
const MAX_OBJECT_SINGLE_PUT_BYTES = 314572800;
const MAX_OBJECT_PARTS = 10000;
const MIN_OBJECT_NON_FINAL_PART_BYTES = 5242880;
const OBJECT_ERROR_CODES = [
  "invalid_key",
  "invalid_body",
  "value_too_large",
  "precondition_failed",
  "range_not_satisfiable",
  "invalid_cursor",
  "invalid_part",
  "upload_not_found",
  "backend_unavailable",
];
const QUEUE_ERROR_CODES = [
  "invalid_body",
  "invalid_argument",
  "message_too_large",
  "batch_too_large",
  "backend_unavailable",
];
const encoder = new SafeTextEncoder();
const CONFIGURATION = sealGeneratedConfiguration(RAW_CONFIGURATION);
let originalPromise;

function captureGetter(prototype, name) {
  let current = prototype;
  while (current) {
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [current, name]);
    if (descriptor && typeof descriptor.get === "function") return descriptor.get;
    current = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [current]);
  }
  throw new SafeTypeError("self-host Worker intrinsic is unavailable");
}

export default SafeApply(SafeObjectFreeze, SafeObject, [{
${handlers}
}]);
${eventEntrypoint}

async function invoke(handler, args, rawEnv, rawContext) {
  const env = projectEnv(rawEnv);
  const context = createPortableContext(rawContext);
  const original = await loadOriginal();
  return await SafeApply(original.handlers[handler], original.target, [...args, env, context]);
}

function statusResponse(status) {
  return new SafeResponse(null, { status });
}

/**
 * The publication's own answer to "does the tenant module really load".
 *
 * It imports the module and validates the declared handlers — the same work the
 * first customer request would have done, moved to a moment where failing is
 * still a refusal rather than a dropped event. Nothing about the tenant crosses
 * the seam: a module that throws is a 500 and a status, never a message.
 */
/**
 * The readiness route can never take the tenant's request down with it.
 *
 * Everything it touches on a failure came out of the tenant's module, so a
 * refusal it cannot describe answers 500 with no detail rather than rejecting
 * the handler — which the Host reads as "the runtime did not answer at all",
 * waits out the deadline for, and reports as retryable.
 */
async function safeReadiness(request) {
  try {
    return await readiness(request);
  } catch {
    const answer = SafeObjectCreate(null);
    answer.schema = READINESS_RESULT_SCHEMA;
    answer.publication = PUBLICATION;
    answer.handlers = CONFIGURATION.declaredHandlers;
    answer.failure = unknownLoadFailure();
    return new SafeResponse(SafeJSONStringify(answer), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

async function readiness(request) {
  let asked = false;
  try {
    const url = new SafeURL(SafeApply(SafeRequestUrlGet, request, []));
    if (SafeApply(SafeURLPathnameGet, url, []) !== READINESS_PATH) return undefined;
    if (SafeApply(SafeRequestMethodGet, request, []) !== "POST") return undefined;
    const headers = SafeApply(SafeRequestHeadersGet, request, []);
    if (SafeApply(SafeHeadersGet, headers, [READINESS_HEADER]) !== READINESS_PROTOCOL) {
      return undefined;
    }
    // Whether this Host asked, as opposed to the internet. Every hostname the
    // publication claims reaches this same service, so the route answers
    // publicly; only the probe's own address distinguishes the Host's question,
    // and it is the one thing about a request that tenant code cannot supply.
    asked = SafeApply(SafeURLHostnameGet, url, []) === PROBE_HOSTNAME;
  } catch {
    return undefined;
  }
  const answer = SafeObjectCreate(null);
  answer.schema = READINESS_RESULT_SCHEMA;
  answer.publication = PUBLICATION;
  answer.handlers = CONFIGURATION.declaredHandlers;
  let status = 200;
  try {
    await loadOriginal();
  } catch (error) {
    status = 500;
    // Reading anything off a tenant-thrown value is tenant code: a Proxy trap
    // or a getter can throw here. A refusal this Host cannot describe is still
    // a refusal, and it must not become "the runtime did not answer", which is
    // retryable and costs the whole probe deadline on every attempt.
    // The refusal is public; what the module said about it is not. A module
    // specifier or a source path is the bundle's business and the operator's,
    // not something to hand to anyone who can reach the Worker's address.
    if (asked) {
      try {
        answer.failure = describeLoadFailure(error);
      } catch {
        answer.failure = unknownLoadFailure();
      }
    }
  }
  return new SafeResponse(SafeJSONStringify(answer), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Why the module did not load, in the two shapes that mean different things.
 *
 * A declared handler that is not exported is a defect in the Version's own
 * declaration. A module that throws while being imported is a defect in the
 * bundle — a missing built-in, a top-level assertion, an unsupported API — and
 * naming it "does not export every handler it declares" sends the operator to
 * read a list of exports that is complete. The distinction is the marker this
 * wrapper puts on its own refusals; anything else came out of the tenant's
 * module and is reported as the class and message it was, trimmed of control
 * characters and truncated.
 *
 * Nothing is read out of the module: no binding, no environment value, no
 * stack. What crosses is the text the module itself put on the error, which is
 * the tenant's own text going back to the tenant's own operator — and it is
 * still bounded and stripped, because a refusal that carries a megabyte of a
 * stranger's newlines into a Host failure message is a defect of its own.
 */
function describeLoadFailure(error) {
  const failure = SafeObjectCreate(null);
  if (error !== null && typeof error === "object" && SafeObjectHasOwn(error, DECLARATION_MARK)) {
    failure.reason = "declaration";
    failure.message = sanitizeFailureText(readFailureField(error, "message"), 200);
    return failure;
  }
  failure.reason = "module";
  failure.name = sanitizeFailureText(readFailureField(error, "name"), 64) || "Error";
  failure.message = sanitizeFailureText(readFailureField(error, "message"), 400);
  return failure;
}

function unknownLoadFailure() {
  const failure = SafeObjectCreate(null);
  failure.reason = "module";
  failure.name = "Error";
  failure.message = "";
  return failure;
}

function readFailureField(error, field) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return typeof error === "string" && field === "message" ? error : "";
  }
  try {
    const value = error[field];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function sanitizeFailureText(value, limit) {
  let text = "";
  for (let index = 0; index < value.length && text.length < limit; index += 1) {
    const code = SafeApply(SafeStringCharCodeAt, value, [index]);
    text += code < 0x20 || code === 0x7f ? " " : value[index];
  }
  return text;
}

function sealGeneratedConfiguration(raw) {
  const declaredHandlers = internalArray();
  for (let index = 0; index < raw.declaredHandlers.length; index += 1) {
    declaredHandlers[index] = raw.declaredHandlers[index];
  }
  SafeApply(SafeObjectFreeze, SafeObject, [declaredHandlers]);
  const bindings = internalArray();
  for (let index = 0; index < raw.bindings.length; index += 1) {
    const source = raw.bindings[index];
    const descriptor = SafeObjectCreate(null);
    if (SafeObjectHasOwn(source, "kind")) {
      descriptor.kind = source.kind;
      descriptor.publicName = source.publicName;
    } else {
      descriptor.name = source.name;
      descriptor.type = source.type;
    }
    bindings[index] = SafeApply(SafeObjectFreeze, SafeObject, [descriptor]);
  }
  SafeApply(SafeObjectFreeze, SafeObject, [bindings]);
  const services = internalArray();
  for (let index = 0; index < raw.services.length; index += 1) {
    services[index] = raw.services[index];
  }
  SafeApply(SafeObjectFreeze, SafeObject, [services]);
  const configuration = SafeObjectCreate(null);
  configuration.declaredHandlers = declaredHandlers;
  configuration.bindings = bindings;
  configuration.services = services;
  return SafeApply(SafeObjectFreeze, SafeObject, [configuration]);
}

function internalArray() {
  return SafeApply(SafeObjectSetPrototypeOf, SafeObject, [[], null]);
}

const DECLARATION_MARK = SafeSymbol("takoserver-selfhost-declaration-failure");

function loadOriginal() {
  if (!originalPromise) {
    const loading = import(${JSON.stringify(moduleSpecifier)});
    originalPromise = SafeApply(SafePromiseThen, loading, [validateOriginal]);
  }
  return originalPromise;
}

/**
 * A declared handler that is not there is a publication that must stop.
 *
 * The Version told this Host which events it answers, and the aggregate rules
 * upstream gate an attachment on that declaration. A module that does not
 * export one of them would accept the attachment and drop the event.
 */
function validateOriginal(loaded) {
  if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function") || !SafeObjectHasOwn(loaded, "default")) {
    throw declarationError("the module has no default export");
  }
  const original = loaded.default;
  if (!original || typeof original !== "object" || SafeArrayIsArray(original)) {
    throw declarationError("the default export is not a plain object");
  }
  const prototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [original]);
  if (prototype !== SafeObjectPrototype && prototype !== null) {
    throw declarationError("the default export is not a plain object");
  }
  const handlers = SafeObjectCreate(null);
  for (let index = 0; index < CONFIGURATION.declaredHandlers.length; index += 1) {
    const handler = CONFIGURATION.declaredHandlers[index];
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [original, handler]);
    if (!descriptor) {
      throw declarationError("declared handler " + handler + " is not exported");
    }
    if (!SafeObjectHasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw declarationError("declared handler " + handler + " is not a function");
    }
    handlers[handler] = descriptor.value;
  }
  return { target: original, handlers };
}

/**
 * This wrapper's own refusal, marked so the readiness answer can tell it apart
 * from anything the tenant's module threw. The marker is a Symbol created in
 * this module and never handed out, so nothing loaded here can forge one.
 */
function declarationError(message) {
  const error = new SafeTypeError(message);
  error[DECLARATION_MARK] = true;
  return error;
}

function projectEnv(rawEnv) {
  if (!rawEnv || (typeof rawEnv !== "object" && typeof rawEnv !== "function")) {
    throw portableError("backend_unavailable");
  }
  const projected = SafeObjectCreate(null);
  // The Host's own service bindings first, so a Version that declared a var
  // under one of these names still gets the value it declared. On this service
  // they carry no secret: the plane token and the event token live on services
  // the tenant holds no binding to at all.
  for (let index = 0; index < CONFIGURATION.services.length; index += 1) {
    const name = CONFIGURATION.services[index];
    // Absent rather than undefined when the runtime did not declare it: a
    // binding that is not there must look exactly like one that was never
    // named, or a module testing for it reads a lie.
    if (SafeObjectHasOwn(rawEnv, name)) projected[name] = rawEnv[name];
  }
  let call;
  let objectCall;
  for (let index = 0; index < CONFIGURATION.bindings.length; index += 1) {
    const descriptor = CONFIGURATION.bindings[index];
    if (SafeObjectHasOwn(descriptor, "kind")) {
      // The object facade streams, so it has a caller of its own: everything
      // else on this seam is one JSON envelope in and one out.
      if (descriptor.kind === OBJECTS_KIND) {
        if (!objectCall) objectCall = createObjectCaller(rawEnv);
        projected[descriptor.publicName] = createObjectsAdapter(objectCall, descriptor.publicName);
        continue;
      }
      if (!call) call = createPlaneCaller(rawEnv);
      projected[descriptor.publicName] =
        descriptor.kind === ${JSON.stringify(SELFHOST_WORKER_EDGE_KV_BINDING_KIND)}
          ? createKvAdapter(call, descriptor.publicName)
          : descriptor.kind === ${JSON.stringify(SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND)}
            ? createQueueAdapter(call, descriptor.publicName)
            : createSqlAdapter(call, descriptor.publicName);
      continue;
    }
    // A text, JSON, or sensitive value is already exactly what the module must
    // see; workerd has no separate secret binding, and neither does this.
    projected[descriptor.name] = rawEnv[descriptor.name];
  }
  return projected;
}

function createPortableContext(rawContext) {
  const portable = SafeObjectCreate(null);
  const nativeWaitUntil =
    rawContext && typeof rawContext.waitUntil === "function" ? rawContext.waitUntil : undefined;
  portable.waitUntil = (value) => {
    const promise = SafeApply(SafePromiseResolve, SafePromise, [value]);
    if (nativeWaitUntil) {
      try { SafeApply(nativeWaitUntil, rawContext, [promise]); } catch {}
    }
  };
  return SafeApply(SafeObjectFreeze, SafeObject, [portable]);
}

function declares(handler) {
  return includes(CONFIGURATION.declaredHandlers, handler);
}

/**
 * The event envelope, read under a ceiling and validated field by field.
 *
 * The gate in front already refused anything without the exact token, method,
 * path, and protocol headers, so what arrives here is this Host's own. It is
 * still parsed strictly: a Host bug that sent a malformed envelope must be a
 * refused delivery rather than a batch the tenant sees half of.
 */
async function boundedEvent(request) {
  let body;
  try {
    body = await SafeApply(SafeRequestText, request, []);
  } catch {
    throw new SafeTypeError("self-host Worker event body is unreadable");
  }
  if (typeof body !== "string" || body.length > MAX_EVENT_BYTES * 32) {
    throw new SafeTypeError("self-host Worker event is too large");
  }
  let event;
  try {
    event = SafeJSONParse(body);
  } catch {
    throw new SafeTypeError("self-host Worker event is not JSON");
  }
  if (!isRecord(event) || event.protocol !== EVENT_PROTOCOL) {
    throw new SafeTypeError("self-host Worker event protocol is invalid");
  }
  if (event.kind === "queue") {
    if (
      !exactKeys(event, ["protocol", "kind", "batchId", "logicalWorkerId", "deploymentId", "queue", "messages"]) ||
      !boundedText(event.batchId, 512) ||
      !boundedText(event.queue, 512)
    ) {
      throw new SafeTypeError("self-host Worker queue event is invalid");
    }
    return event;
  }
  if (event.kind === "schedule") {
    if (
      !exactKeys(event, ["protocol", "kind", "logicalWorkerId", "deploymentId", "cron", "scheduledTime"]) ||
      !boundedText(event.cron, 512) ||
      !nonNegativeInteger(event.scheduledTime)
    ) {
      throw new SafeTypeError("self-host Worker schedule event is invalid");
    }
    return event;
  }
  throw new SafeTypeError("self-host Worker event kind is invalid");
}

/**
 * The portable batch, exactly as the managed wrapper projects it.
 *
 * A handler that returns without settling anything acknowledges the whole
 * batch; one that throws retries every message it had not already settled.
 * Both are the Form's own rule, and both are decided here rather than by the
 * pump, so the two backends cannot drift on what "the handler said nothing"
 * means.
 */
async function invokeQueue(event, rawEnv, rawContext) {
  if (!SafeArrayIsArray(event.messages) || event.messages.length < 1 || event.messages.length > MAX_QUEUE_MESSAGES) {
    throw new SafeTypeError("self-host Worker queue event is invalid");
  }
  const env = projectEnv(rawEnv);
  const context = createPortableContext(rawContext);
  const original = await loadOriginal();
  // Plain arrays, deliberately: this batch is handed to tenant code, and a
  // null-prototype array is not iterable — a for-of over batch.messages, which
  // is how every consumer is written, would throw.
  const messages = [];
  const messageIds = [];
  const decisions = new SafeMap();
  const seen = new SafeMap();
  for (let index = 0; index < event.messages.length; index += 1) {
    const input = event.messages[index];
    if (
      !isRecord(input) ||
      !exactKeys(input, ["messageId", "timestampMillis", "attempts", "body"]) ||
      !boundedText(input.messageId, 512) ||
      !nonNegativeInteger(input.timestampMillis) ||
      !SafeNumberIsSafeInteger(input.attempts) ||
      input.attempts < 1
    ) {
      throw new SafeTypeError("self-host Worker queue message is invalid");
    }
    const id = input.messageId;
    if (SafeApply(SafeMapHas, seen, [id])) {
      throw new SafeTypeError("self-host Worker queue message id is duplicated");
    }
    SafeApply(SafeMapSet, seen, [id, true]);
    messageIds[index] = id;
    const message = SafeObjectCreate(null);
    message.id = id;
    message.timestampMillis = input.timestampMillis;
    message.attempts = input.attempts;
    message.body = projectEncodedBody(input.body);
    message.acknowledge = () => settleOne(decisions, id, "ack");
    message.retry = (options) => settleOne(decisions, id, "retry", options);
    messages[index] = message;
  }
  const batch = SafeObjectCreate(null);
  batch.batchId = event.batchId;
  batch.queue = event.queue;
  batch.messages = messages;
  batch.acknowledgeAll = () => settleAll(messageIds, decisions, "ack");
  batch.retryAll = (options) => settleAll(messageIds, decisions, "retry", options);
  let failed = false;
  try {
    await SafeApply(original.handlers.queue, original.target, [batch, env, context]);
  } catch {
    failed = true;
  }
  const output = internalArray();
  for (let index = 0; index < messageIds.length; index += 1) {
    const messageId = messageIds[index];
    output[index] =
      SafeApply(SafeMapGet, decisions, [messageId]) || decision(messageId, failed ? "retry" : "ack");
  }
  const result = SafeObjectCreate(null);
  result.protocol = EVENT_PROTOCOL;
  result.kind = "queue";
  result.decisions = output;
  return jsonResponse(result);
}

function settleOne(decisions, messageId, outcome, options) {
  if (SafeApply(SafeMapHas, decisions, [messageId])) throw portableError("already_settled");
  let delaySeconds;
  if (outcome === "retry") {
    if (options !== undefined && (!isRecord(options) || !onlyKeys(options, ["delaySeconds"]))) {
      throw portableError("invalid_argument");
    }
    delaySeconds = options && options.delaySeconds;
    if (
      delaySeconds !== undefined &&
      (!SafeNumberIsSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > MAX_QUEUE_DELAY_SECONDS)
    ) {
      throw portableError("invalid_argument");
    }
  } else if (options !== undefined) {
    throw portableError("invalid_argument");
  }
  SafeApply(SafeMapSet, decisions, [messageId, decision(messageId, outcome, delaySeconds)]);
}

function settleAll(messageIds, decisions, outcome, options) {
  if (outcome === "retry" && options !== undefined && (!isRecord(options) || !onlyKeys(options, ["delaySeconds"]))) {
    throw portableError("invalid_argument");
  }
  const delay = outcome === "retry" && options ? options.delaySeconds : undefined;
  if (delay !== undefined && (!SafeNumberIsSafeInteger(delay) || delay < 1 || delay > MAX_QUEUE_DELAY_SECONDS)) {
    throw portableError("invalid_argument");
  }
  for (let index = 0; index < messageIds.length; index += 1) {
    const id = messageIds[index];
    if (!SafeApply(SafeMapHas, decisions, [id])) {
      SafeApply(SafeMapSet, decisions, [id, decision(id, outcome, delay)]);
    }
  }
}

function decision(messageId, outcome, delaySeconds) {
  const value = SafeObjectCreate(null);
  value.messageId = messageId;
  value.outcome = outcome;
  if (delaySeconds !== undefined) value.delaySeconds = delaySeconds;
  return value;
}

async function invokeScheduled(event, rawEnv, rawContext) {
  const env = projectEnv(rawEnv);
  const context = createPortableContext(rawContext);
  const original = await loadOriginal();
  const scheduled = SafeObjectCreate(null);
  scheduled.cron = event.cron;
  scheduled.scheduledTime = event.scheduledTime;
  // The throw is the answer. A scheduled invocation has no per-message
  // settlement, so a handler that failed is a failed invocation and this Host
  // reports it by refusing the delivery rather than acknowledging one.
  await SafeApply(original.handlers.scheduled, original.target, [scheduled, env, context]);
  const result = SafeObjectCreate(null);
  result.protocol = EVENT_PROTOCOL;
  result.kind = "schedule";
  result.outcome = "ack";
  return jsonResponse(result);
}

function jsonResponse(value) {
  return new SafeResponse(SafeJSONStringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The family-wide encoded-bytes shape, projected as it arrived. */
function projectEncodedBody(value) {
  if (!isRecord(value) || !exactKeys(value, ["encoding", "data"]) || value.encoding !== "base64") {
    throw new SafeTypeError("self-host Worker queue body is invalid");
  }
  if (!isCanonicalBase64(value.data, MAX_QUEUE_MESSAGE_BYTES)) {
    throw new SafeTypeError("self-host Worker queue body is invalid");
  }
  const body = SafeObjectCreate(null);
  body.encoding = "base64";
  body.data = value.data;
  return SafeApply(SafeObjectFreeze, SafeObject, [body]);
}

/**
 * edge.queue@1.0.0, projecting send and sendBatch and nothing else.
 *
 * Bodies are bytes on this Interface — there is no structured clone — and the
 * acceptance id this returns is the Host's own, not a provider dedupe id, which
 * is exactly what the managed adapter promises.
 */
function createQueueAdapter(call, binding) {
  const portable = SafeObjectCreate(null);
  portable.send = async (body, options) => {
    const bytes = runtimeBytes(body, "invalid_body");
    if (viewByteLength(bytes) > MAX_QUEUE_MESSAGE_BYTES) throw portableError("message_too_large");
    const normalized = validateQueueSendOptions(options);
    const payload = planeRequest(binding, "send");
    payload.body = encodeBase64(bytes);
    if (normalized.delaySeconds !== undefined) payload.delaySeconds = normalized.delaySeconds;
    const value = await call(QUEUE_URL, payload, QUEUE_ERROR_CODES);
    if (!isRecord(value) || !exactKeys(value, ["messageId"]) || !boundedText(value.messageId, 512)) {
      throw portableError("backend_unavailable");
    }
    return value.messageId;
  };
  portable.sendBatch = async (messages) => {
    if (!SafeArrayIsArray(messages) || messages.length < 1 || messages.length > MAX_QUEUE_MESSAGES) {
      throw portableError("batch_too_large");
    }
    const entries = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isRecord(message) || !onlyKeys(message, ["body", "delaySeconds"]) || !SafeObjectHasOwn(message, "body")) {
        throw portableError("invalid_body");
      }
      const bytes = runtimeBytes(message.body, "invalid_body");
      if (viewByteLength(bytes) > MAX_QUEUE_MESSAGE_BYTES) throw portableError("message_too_large");
      const optionInput = SafeObjectCreate(null);
      if (message.delaySeconds !== undefined) optionInput.delaySeconds = message.delaySeconds;
      const normalized = validateQueueSendOptions(
        message.delaySeconds === undefined ? undefined : optionInput,
      );
      const entry = SafeObjectCreate(null);
      entry.body = encodeBase64(bytes);
      if (normalized.delaySeconds !== undefined) entry.delaySeconds = normalized.delaySeconds;
      entries[index] = entry;
    }
    const payload = planeRequest(binding, "sendBatch");
    payload.messages = entries;
    const value = await call(QUEUE_URL, payload, QUEUE_ERROR_CODES);
    if (
      !isRecord(value) ||
      !exactKeys(value, ["messageIds"]) ||
      !SafeArrayIsArray(value.messageIds) ||
      value.messageIds.length !== entries.length
    ) {
      throw portableError("backend_unavailable");
    }
    return mapArray(value.messageIds, (id) => {
      if (!boundedText(id, 512)) throw portableError("backend_unavailable");
      return id;
    });
  };
  return portable;
}

function validateQueueSendOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["delaySeconds"])) throw portableError("invalid_argument");
  if (options.delaySeconds === undefined) return SafeObjectCreate(null);
  if (
    !SafeNumberIsSafeInteger(options.delaySeconds) ||
    options.delaySeconds < 0 ||
    options.delaySeconds > MAX_QUEUE_DELAY_SECONDS
  ) {
    throw portableError("invalid_argument");
  }
  const result = SafeObjectCreate(null);
  result.delaySeconds = options.delaySeconds;
  return result;
}

/**
 * edge.objects@1.0.0, byte for byte the surface the managed wrapper projects.
 *
 * Same nine methods, same option names, same closed error vocabulary, same
 * ceilings — 979-byte keys, 5 GiB objects, 300 MiB single put, 10 000 parts, a
 * 5 MiB floor on every part but the last. What is different is only what is
 * behind it: a plane on this machine rather than a native R2 binding.
 *
 * The in-isolate part ledger is here for the same reason the managed adapter
 * has a receipt ledger, and it is deliberately NOT the authority: this Host's
 * plane records every part durably and validates a complete against those
 * rows, so an eviction between createMultipartUpload and
 * completeMultipartUpload costs nothing. The managed adapter instead keeps
 * its receipt ledger in a private Durable Object while R2 owns the native
 * upload, which is the recovery difference ADR 0007 names between runtimes.
 */
function createObjectsAdapter(call, binding) {
  const multipart = new SafeMap();
  const portable = SafeObjectCreate(null);
  portable.head = async function (key) {
    exactObjectArgumentCount(arguments.length, 1);
    objectKey(key);
    const value = objectJson(await call(objectDocument(binding, "head", key)));
    if (value.found !== true) return null;
    return objectMetadata(value);
  };
  portable.get = async function (key, rawOptions) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    const options = objectGetOptions(rawOptions);
    const document = objectDocument(binding, "get", key);
    if (options.range !== undefined) document.range = options.range;
    if (options.ifMatch !== undefined) document.ifMatch = options.ifMatch;
    if (options.ifNoneMatch !== undefined) document.ifNoneMatch = options.ifNoneMatch;
    const answer = await call(document);
    if (answer.body === undefined) {
      const value = objectJson(answer);
      if (value.found !== true) return null;
      throw portableError("backend_unavailable");
    }
    const metadata = objectMetadata(answer.metadata);
    const result = SafeObjectCreate(null);
    result.etag = metadata.etag;
    result.size = metadata.size;
    if (metadata.contentType !== undefined) result.contentType = metadata.contentType;
    result.body = answer.body;
    result.partial = answer.metadata.partial === true;
    if (result.partial) {
      result.range = objectResultRange(answer.metadata.range, metadata.size);
    } else if (answer.metadata.range !== undefined) {
      throw portableError("backend_unavailable");
    }
    return freezeObject(result);
  };
  portable.put = async function (key, body, rawOptions) {
    exactObjectArgumentCount(arguments.length, 3);
    objectKey(key);
    const options = objectPutOptions(rawOptions);
    const source = objectBodySource(body, MAX_OBJECT_SINGLE_PUT_BYTES, options.contentLength);
    const document = objectDocument(binding, "put", key);
    document.contentLength = source.length;
    if (options.contentType !== undefined) document.contentType = options.contentType;
    if (options.ifMatch !== undefined) document.ifMatch = options.ifMatch;
    if (options.ifNoneMatch !== undefined) document.ifNoneMatch = options.ifNoneMatch;
    const value = objectJson(await call(document, source.body));
    const result = SafeObjectCreate(null);
    result.etag = objectEtag(value.etag);
    result.size = objectSize(value.size);
    // The managed adapter's answer to the same disagreement: a stored size that
    // is not the length the caller declared is the body's problem, not the
    // backend's.
    if (result.size !== source.length) throw portableError("invalid_body");
    return freezeObject(result);
  };
  portable.delete = async function (key) {
    exactObjectArgumentCount(arguments.length, 1);
    objectKey(key);
    objectJson(await call(objectDocument(binding, "delete", key)));
  };
  portable.list = async function (rawOptions) {
    exactObjectArgumentCount(arguments.length, 1);
    const options = objectListOptions(rawOptions);
    const document = objectDocument(binding, "list", undefined);
    if (options.prefix !== undefined) document.prefix = options.prefix;
    if (options.delimiter !== undefined) document.delimiter = options.delimiter;
    if (options.cursor !== undefined) document.cursor = options.cursor;
    if (options.limit !== undefined) document.limit = options.limit;
    const page = objectJson(await call(document));
    if (!SafeArrayIsArray(page.objects) || typeof page.truncated !== "boolean") {
      throw portableError("backend_unavailable");
    }
    const limit = options.limit === undefined ? 1000 : options.limit;
    if (page.objects.length > limit) throw portableError("backend_unavailable");
    const objects = [];
    for (let index = 0; index < page.objects.length; index += 1) {
      const item = page.objects[index];
      if (!isRecord(item)) throw portableError("backend_unavailable");
      objectProviderKey(item.key);
      const projected = SafeObjectCreate(null);
      projected.key = item.key;
      projected.etag = objectEtag(item.etag);
      projected.size = objectSize(item.size);
      if (item.uploadedAtMillis !== undefined) {
        if (!nonNegativeInteger(item.uploadedAtMillis)) throw portableError("backend_unavailable");
        projected.uploadedAtMillis = item.uploadedAtMillis;
      }
      objects[index] = freezeObject(projected);
    }
    const prefixes = [];
    if (page.prefixes !== undefined) {
      if (!SafeArrayIsArray(page.prefixes) || page.prefixes.length > 1000) {
        throw portableError("backend_unavailable");
      }
      for (let index = 0; index < page.prefixes.length; index += 1) {
        objectProviderPrefix(page.prefixes[index]);
        if (!includes(prefixes, page.prefixes[index])) {
          prefixes[prefixes.length] = page.prefixes[index];
        }
      }
    }
    const result = SafeObjectCreate(null);
    result.objects = freezeObject(objects);
    result.prefixes = freezeObject(prefixes);
    result.truncated = page.truncated;
    if (page.truncated) {
      objectCursor(page.cursor);
      result.cursor = page.cursor;
    }
    return freezeObject(result);
  };
  portable.createMultipartUpload = async function (key, rawOptions) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    const contentType = objectMultipartOptions(rawOptions);
    const document = objectDocument(binding, "createMultipartUpload", key);
    if (contentType !== undefined) document.contentType = contentType;
    const value = objectJson(await call(document));
    objectUploadId(value.uploadId);
    SafeApply(SafeMapSet, multipart, [objectUploadIdentity(key, value.uploadId), new SafeMap()]);
    const result = SafeObjectCreate(null);
    result.uploadId = value.uploadId;
    return freezeObject(result);
  };
  portable.uploadPart = async function (key, uploadId, partNumber, body, rawOptions) {
    exactObjectArgumentCount(arguments.length, 5);
    objectKey(key);
    objectUploadId(uploadId);
    objectPartNumber(partNumber);
    const options = objectUploadPartOptions(rawOptions);
    const source = objectBodySource(body, MAX_OBJECT_BYTES, options.contentLength, "invalid_body");
    const document = objectDocument(binding, "uploadPart", key);
    document.uploadId = uploadId;
    document.partNumber = partNumber;
    document.contentLength = source.length;
    const value = objectJson(await call(document, source.body));
    const etag = objectEtag(value.etag);
    if (value.partNumber !== partNumber) throw portableError("backend_unavailable");
    const known = SafeApply(SafeMapGet, multipart, [objectUploadIdentity(key, uploadId)]);
    if (known) {
      const recorded = SafeObjectCreate(null);
      recorded.etag = etag;
      recorded.size = source.length;
      SafeApply(SafeMapSet, known, [partNumber, freezeObject(recorded)]);
    }
    const result = SafeObjectCreate(null);
    result.etag = etag;
    result.partNumber = partNumber;
    return freezeObject(result);
  };
  portable.completeMultipartUpload = async function (key, uploadId, rawParts) {
    exactObjectArgumentCount(arguments.length, 3);
    objectKey(key);
    objectUploadId(uploadId);
    const parts = objectParts(rawParts);
    validateKnownObjectParts(multipart, key, uploadId, parts);
    const document = objectDocument(binding, "completeMultipartUpload", key);
    document.uploadId = uploadId;
    document.parts = parts;
    const value = objectJson(await call(document));
    const result = SafeObjectCreate(null);
    result.etag = objectEtag(value.etag);
    result.size = objectSize(value.size);
    SafeApply(SafeMapDelete, multipart, [objectUploadIdentity(key, uploadId)]);
    return freezeObject(result);
  };
  portable.abortMultipartUpload = async function (key, uploadId) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    objectUploadId(uploadId);
    const document = objectDocument(binding, "abortMultipartUpload", key);
    document.uploadId = uploadId;
    objectJson(await call(document));
    SafeApply(SafeMapDelete, multipart, [objectUploadIdentity(key, uploadId)]);
  };
  return portable;
}

/**
 * The object half of the seam: one fixed method, one fixed URL, one header
 * carrying the operation, and the bytes as the body in both directions.
 *
 * The facade service in front rewrites everything but that header and the body,
 * so this module can name an operation and nothing else — not a destination,
 * not a token, and not a second route on this machine.
 */
function createObjectCaller(rawEnv) {
  const service = rawEnv[DATA_SERVICE];
  const send = captureMethod(service, "fetch");
  return async (document, body) => {
    const headers = SafeObjectCreate(null);
    headers[OBJECT_REQUEST_HEADER] = encodeObjectDocument(document);
    const init = SafeObjectCreate(null);
    init.method = "POST";
    init.headers = headers;
    if (body !== undefined) init.body = body;
    let response;
    try {
      response = await SafeApply(send, service, [OBJECTS_URL, init]);
    } catch {
      throw portableError("backend_unavailable");
    }
    let responseHeaders;
    let contentType;
    try {
      responseHeaders = SafeApply(SafeResponseHeadersGet, response, []);
      contentType = SafeApply(SafeHeadersGet, responseHeaders, ["content-type"]);
    } catch {
      throw portableError("backend_unavailable");
    }
    if (contentType === OBJECT_CONTENT_TYPE) {
      const status = SafeApply(SafeResponseStatusGet, response, []);
      const stream = SafeApply(SafeResponseBodyGet, response, []);
      const metadata = decodeObjectDocument(
        SafeApply(SafeHeadersGet, responseHeaders, [OBJECT_RESULT_HEADER]),
      );
      if (status !== 200 || !isResponseBodyStream(stream)) {
        throw portableError("backend_unavailable");
      }
      const answer = SafeObjectCreate(null);
      answer.metadata = metadata;
      answer.body = stream;
      return answer;
    }
    let text;
    try {
      text = await SafeApply(SafeResponseText, response, []);
    } catch {
      throw portableError("backend_unavailable");
    }
    if (typeof text !== "string" || text.length > MAX_RESPONSE_BYTES) {
      throw portableError("backend_unavailable");
    }
    let envelope;
    try {
      envelope = SafeJSONParse(text);
    } catch {
      throw portableError("backend_unavailable");
    }
    if (!isRecord(envelope)) throw portableError("backend_unavailable");
    if (envelope.ok === true && exactKeys(envelope, ["ok", "value"])) {
      const answer = SafeObjectCreate(null);
      answer.value = envelope.value;
      return answer;
    }
    if (
      envelope.ok === false &&
      exactKeys(envelope, ["ok", "error"]) &&
      isRecord(envelope.error) &&
      exactKeys(envelope.error, ["code"]) &&
      includes(OBJECT_ERROR_CODES, envelope.error.code)
    ) {
      throw portableError(envelope.error.code);
    }
    throw portableError("backend_unavailable");
  };
}

function objectDocument(binding, op, key) {
  const document = SafeObjectCreate(null);
  document.protocol = OBJECT_PROTOCOL;
  document.binding = binding;
  document.op = op;
  if (key !== undefined) document.key = key;
  return document;
}

function objectJson(answer) {
  if (answer.body !== undefined) throw portableError("backend_unavailable");
  if (!isRecord(answer.value)) throw portableError("backend_unavailable");
  return answer.value;
}

function encodeObjectDocument(document) {
  const encoded = base64Url(
    encodeBase64(SafeApply(SafeTextEncoderEncode, encoder, [SafeJSONStringify(document)])),
  );
  if (encoded.length > MAX_OBJECT_DOCUMENT_BYTES) throw portableError("invalid_key");
  return encoded;
}

function decodeObjectDocument(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OBJECT_DOCUMENT_BYTES ||
    !SafeApply(SafeRegExpTest, BASE64URL_PATTERN, [value])
  ) {
    throw portableError("backend_unavailable");
  }
  let parsed;
  try {
    const decoder = new SafeTextDecoder("utf-8", { fatal: true });
    parsed = SafeJSONParse(
      SafeApply(SafeTextDecoderDecode, decoder, [
        new SafeUint8Array(decodeBase64(base64Pad(value))),
      ]),
    );
  } catch {
    throw portableError("backend_unavailable");
  }
  if (!isRecord(parsed)) throw portableError("backend_unavailable");
  return parsed;
}

function base64Url(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    output +=
      character === "+" ? "-" : character === "/" ? "_" : character === "=" ? "" : character;
  }
  return output;
}

function base64Pad(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    output += character === "-" ? "+" : character === "_" ? "/" : character;
  }
  while (output.length % 4 !== 0) output += "=";
  return output;
}

function objectMetadata(value) {
  if (!isRecord(value)) throw portableError("backend_unavailable");
  const result = SafeObjectCreate(null);
  result.etag = objectEtag(value.etag);
  result.size = objectSize(value.size);
  if (value.contentType !== undefined) result.contentType = objectContentType(value.contentType);
  if (value.uploadedAtMillis !== undefined) {
    if (!nonNegativeInteger(value.uploadedAtMillis)) throw portableError("backend_unavailable");
    result.uploadedAtMillis = value.uploadedAtMillis;
  }
  return freezeObject(result);
}

function objectGetOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["range", "ifMatch", "ifNoneMatch"]);
  if (value.ifMatch !== undefined && value.ifNoneMatch !== undefined) objectBindingTypeError();
  const result = SafeObjectCreate(null);
  if (value.range !== undefined) {
    objectOptions(value.range, ["offset", "length"]);
    if (
      typeof value.range.offset !== "number" ||
      (value.range.length !== undefined && typeof value.range.length !== "number")
    ) {
      objectBindingTypeError();
    }
    if (!nonNegativeInteger(value.range.offset) || value.range.offset > MAX_OBJECT_BYTES) {
      objectBindingTypeError();
    }
    if (
      value.range.length !== undefined &&
      (!nonNegativeInteger(value.range.length) ||
        value.range.length < 1 ||
        value.range.length > MAX_OBJECT_BYTES)
    ) {
      objectBindingTypeError();
    }
    const range = SafeObjectCreate(null);
    range.offset = value.range.offset;
    if (value.range.length !== undefined) range.length = value.range.length;
    result.range = freezeObject(range);
  }
  if (value.ifMatch !== undefined) result.ifMatch = objectConditionEtag(value.ifMatch);
  if (value.ifNoneMatch !== undefined) result.ifNoneMatch = objectConditionEtag(value.ifNoneMatch);
  return freezeObject(result);
}

function objectPutOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["contentLength", "contentType", "ifMatch", "ifNoneMatch"]);
  if (value.ifMatch !== undefined && value.ifNoneMatch !== undefined) objectBindingTypeError();
  if (value.ifNoneMatch !== undefined && typeof value.ifNoneMatch !== "string") {
    objectBindingTypeError();
  }
  if (value.ifNoneMatch !== undefined && value.ifNoneMatch !== "*") objectBindingTypeError();
  const result = SafeObjectCreate(null);
  if (SafeObjectHasOwn(value, "contentLength")) {
    result.contentLength = objectContentLength(value.contentLength);
  }
  if (value.contentType !== undefined) {
    result.contentType = objectInputContentType(value.contentType);
  }
  if (value.ifMatch !== undefined) result.ifMatch = objectConditionEtag(value.ifMatch);
  if (value.ifNoneMatch !== undefined) result.ifNoneMatch = "*";
  return freezeObject(result);
}

function objectUploadPartOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["contentLength"]);
  const result = SafeObjectCreate(null);
  if (SafeObjectHasOwn(value, "contentLength")) {
    result.contentLength = objectContentLength(value.contentLength);
  }
  return freezeObject(result);
}

function objectListOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["prefix", "delimiter", "cursor", "limit"]);
  const result = SafeObjectCreate(null);
  if (value.prefix !== undefined) {
    objectPrefix(value.prefix);
    result.prefix = value.prefix;
  }
  if (value.delimiter !== undefined) {
    if (typeof value.delimiter !== "string") objectBindingTypeError();
    if (
      unicodeCodePointLength(value.delimiter) < 1 ||
      unicodeCodePointLength(value.delimiter) > 16
    ) {
      objectBindingTypeError();
    }
    result.delimiter = value.delimiter;
  }
  if (value.cursor !== undefined) {
    objectInputCursor(value.cursor);
    result.cursor = value.cursor;
  }
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number") objectBindingTypeError();
    if (!nonNegativeInteger(value.limit) || value.limit < 1 || value.limit > 1000) {
      objectBindingTypeError();
    }
    result.limit = value.limit;
  }
  return freezeObject(result);
}

function objectMultipartOptions(value) {
  if (value === undefined) return undefined;
  objectOptions(value, ["contentType"]);
  return value.contentType === undefined ? undefined : objectInputContentType(value.contentType);
}

function objectOptions(value, allowed) {
  if (!isPlainRecord(value) || !onlyKeys(value, allowed)) objectBindingTypeError();
}

/**
 * The body, its exact length, and nothing discovered by buffering it.
 *
 * A stream must declare its length because the ceiling has to be decided before
 * the bytes cross, and because the plane needs the count to refuse a body that
 * ran long. A string or an ArrayBuffer already knows its own, and a declared
 * length that disagrees with it is the caller's mistake rather than a silent
 * truncation.
 */
function objectBodySource(value, maximum, declaredLength, intrinsicTooLargeError) {
  const tooLarge =
    intrinsicTooLargeError === undefined ? "value_too_large" : intrinsicTooLargeError;
  let body;
  let known;
  if (typeof value === "string") {
    const bytes = SafeApply(SafeTextEncoderEncode, encoder, [value]);
    known = viewByteLength(bytes);
    body = readableObjectBytes(bytes);
  } else if (isArrayBuffer(value)) {
    const bytes = new SafeUint8Array(SafeApply(SafeArrayBufferSlice, value, [0]));
    known = viewByteLength(bytes);
    body = readableObjectBytes(bytes);
  } else if (isReadableStream(value)) {
    body = value;
  } else {
    // Naming the argument and what it accepts, because "invalid arguments" on
    // a five-argument facade sends the caller to read the whole call. The three
    // accepted shapes are the ones the Binding declares (ADR 0005); an
    // ArrayBufferView is deliberately not one of them, and saying so is the
    // difference between a caller wrapping their bytes and a caller guessing.
    objectBindingTypeError(
      SafeArrayBufferIsView(value)
        ? "body must be a string, an ArrayBuffer, or a byte ReadableStream; " +
            "pass the view's own buffer slice"
        : "body must be a string, an ArrayBuffer, or a byte ReadableStream",
    );
  }
  if (declaredLength !== undefined) objectContentLength(declaredLength);
  const length = declaredLength === undefined ? known : declaredLength;
  if (length === undefined || (known !== undefined && length !== known)) {
    throw portableError("invalid_body");
  }
  if (length > maximum) throw portableError(known === undefined ? "value_too_large" : tooLarge);
  const result = SafeObjectCreate(null);
  result.body = body;
  result.length = length;
  return freezeObject(result);
}

function readableObjectBytes(bytes) {
  let sent = false;
  return new SafeReadableStream({
    pull(controller) {
      if (sent) {
        SafeApply(SafeReadableStreamControllerClose, controller, []);
        return;
      }
      sent = true;
      SafeApply(SafeReadableStreamControllerEnqueue, controller, [bytes]);
    },
  });
}

function objectParts(value) {
  if (!SafeArrayIsArray(value)) objectBindingTypeError();
  if (value.length < 1 || value.length > MAX_OBJECT_PARTS) objectBindingTypeError();
  const result = [];
  let previous = 0;
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    if (!isPlainRecord(part) || !exactKeys(part, ["etag", "partNumber"])) objectBindingTypeError();
    objectPartNumber(part.partNumber);
    if (part.partNumber <= previous) throw portableError("invalid_part");
    previous = part.partNumber;
    const projected = SafeObjectCreate(null);
    projected.etag = objectPartEtag(part.etag);
    projected.partNumber = part.partNumber;
    result[index] = freezeObject(projected);
  }
  return freezeObject(result);
}

function objectUploadIdentity(key, uploadId) {
  // NUL, exactly as the managed wrapper joins it: a key may contain a space,
  // so a space would let two (key, uploadId) pairs share one map entry. The
  // escape is doubled because this module is emitted from a template literal;
  // what the generated source carries is the two-character escape, and what it
  // evaluates to is the separator.
  return key + "\\0" + uploadId;
}

function validateKnownObjectParts(multipart, key, uploadId, parts) {
  const known = SafeApply(SafeMapGet, multipart, [objectUploadIdentity(key, uploadId)]);
  if (!known) return;
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const recorded = SafeApply(SafeMapGet, known, [part.partNumber]);
    if (
      !recorded ||
      recorded.etag !== part.etag ||
      (index < parts.length - 1 && recorded.size < MIN_OBJECT_NON_FINAL_PART_BYTES)
    ) {
      throw portableError("invalid_part");
    }
    if (
      !nonNegativeInteger(total) ||
      !nonNegativeInteger(recorded.size) ||
      recorded.size > MAX_OBJECT_BYTES - total
    ) {
      throw portableError("value_too_large");
    }
    total += recorded.size;
  }
}

function objectResultRange(value, size) {
  // The managed adapter's exact shape check, including the two it makes that a
  // shorter one would drop: a zero-length partial answer and a suffix this
  // facade never asks for are both a backend that did not answer the question
  // it was asked.
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["offset", "length", "suffix"]) ||
    !SafeObjectHasOwn(value, "offset") ||
    !SafeObjectHasOwn(value, "length") ||
    value.suffix !== undefined ||
    !nonNegativeInteger(value.offset) ||
    !nonNegativeInteger(value.length) ||
    value.length < 1 ||
    value.offset + value.length > size
  ) {
    throw portableError("backend_unavailable");
  }
  const result = SafeObjectCreate(null);
  result.offset = value.offset;
  result.length = value.length;
  return freezeObject(result);
}

function objectKey(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (!boundedUtf8(value, MAX_OBJECT_KEY_BYTES) || hasControlCharacters(value)) {
    throw portableError("invalid_key");
  }
}

function objectPrefix(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (utf8Length(value) > MAX_OBJECT_KEY_BYTES || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
}

function objectProviderKey(value) {
  if (
    typeof value !== "string" ||
    !boundedUtf8(value, MAX_OBJECT_KEY_BYTES) ||
    hasControlCharacters(value)
  ) {
    throw portableError("backend_unavailable");
  }
}

function objectProviderPrefix(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    utf8Length(value) > MAX_OBJECT_KEY_BYTES ||
    hasControlCharacters(value)
  ) {
    throw portableError("backend_unavailable");
  }
}

function objectSize(value) {
  if (!nonNegativeInteger(value) || value > MAX_OBJECT_BYTES) {
    throw portableError("backend_unavailable");
  }
  return value;
}

function objectEtag(value) {
  if (
    typeof value !== "string" ||
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    throw portableError("backend_unavailable");
  }
  return value;
}

function objectConditionEtag(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    objectBindingTypeError();
  }
  return value;
}

function objectPartEtag(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    objectBindingTypeError();
  }
  return value;
}

function objectContentType(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    throw portableError("backend_unavailable");
  }
  return value;
}

function objectInputContentType(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    objectBindingTypeError();
  }
  return value;
}

function objectContentLength(value) {
  if (typeof value !== "number") objectBindingTypeError();
  if (!nonNegativeInteger(value) || value > MAX_OBJECT_BYTES) throw portableError("invalid_body");
  return value;
}

function objectCursor(value) {
  if (
    typeof value !== "string" ||
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 4096
  ) {
    throw portableError("backend_unavailable");
  }
}

function objectInputCursor(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 4096) {
    objectBindingTypeError();
  }
}

function objectUploadId(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (value.length < 1 || value.length > 256 || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
}

function objectPartNumber(value) {
  if (typeof value !== "number") objectBindingTypeError();
  if (!nonNegativeInteger(value) || value < 1 || value > MAX_OBJECT_PARTS) {
    objectBindingTypeError();
  }
}

function exactObjectArgumentCount(actual, maximum) {
  if (actual > maximum) objectBindingTypeError();
}

function objectBindingTypeError(detail) {
  throw new SafeTypeError(
    typeof detail === "string"
      ? "invalid module-worker.object-bucket arguments: " + detail
      : "invalid module-worker.object-bucket arguments",
  );
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeApply(SafeStringCharCodeAt, value, [index]);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function unicodeCodePointLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = SafeApply(SafeStringCharCodeAt, value, [index]);
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = SafeApply(SafeStringCharCodeAt, value, [index + 1]);
      if (second >= 0xdc00 && second <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

function isArrayBuffer(value) {
  try {
    SafeApply(SafeArrayBufferSlice, value, [0, 0]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this is a stream, asked of a value the tenant handed in.
 *
 * instanceof is not an answer here. It calls the constructor's own
 * Symbol.hasInstance, and the tenant's top-level code runs before its first put
 * on an ordinary extensible global it can define that property on — so the
 * discrimination between "a stream" and "not a BodyInit" would be the tenant's
 * to decide, where the managed wrapper's is nobody's.
 *
 * The captured "locked" accessor is the same class of answer the managed
 * wrapper's getReader probe gives — an internal-slot brand check on a
 * prototype accessor captured before tenant code runs, which no property a
 * tenant defines can satisfy — and it is the one that does not disturb the
 * value. Taking a reader and releasing it counts as using the stream on some
 * runtimes, and the value asked about here is the body this module is about to
 * hand to the plane.
 */
function isReadableStream(value) {
  try {
    SafeApply(SafeReadableStreamLockedGet, value, []);
    return true;
  } catch {
    return false;
  }
}

/** The other question: is what this plane answered with a body at all. */
function isResponseBodyStream(value) {
  try {
    return value instanceof SafeReadableStream;
  } catch {
    return false;
  }
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [value]);
  return prototype === SafeObjectPrototype || prototype === null;
}

function freezeObject(value) {
  return SafeApply(SafeObjectFreeze, SafeObject, [value]);
}

/**
 * One caller for every facade on this Worker.
 *
 * There is no credential here to protect, and that is the point: the service
 * binding addresses this Host's own facade service, which holds the token and
 * the plane address and rewrites every request it is handed. This module can
 * name one of two paths and a JSON body; it cannot name a destination.
 */
function createPlaneCaller(rawEnv) {
  const service = rawEnv[DATA_SERVICE];
  const send = captureMethod(service, "fetch");
  return async (url, payload, codes) => {
    const headers = SafeObjectCreate(null);
    headers["content-type"] = CONTENT_TYPE;
    const init = SafeObjectCreate(null);
    init.method = "POST";
    init.headers = headers;
    init.body = SafeJSONStringify(payload);
    let response;
    try {
      response = await SafeApply(send, service, [url, init]);
    } catch {
      throw portableError("backend_unavailable");
    }
    let body;
    try {
      body = await SafeApply(SafeResponseText, response, []);
    } catch {
      throw portableError("backend_unavailable");
    }
    if (typeof body !== "string" || body.length > MAX_RESPONSE_BYTES) {
      throw portableError("backend_unavailable");
    }
    let envelope;
    try {
      envelope = SafeJSONParse(body);
    } catch {
      throw portableError("backend_unavailable");
    }
    if (!isRecord(envelope)) throw portableError("backend_unavailable");
    if (envelope.ok === true && exactKeys(envelope, ["ok", "value"])) return envelope.value;
    if (
      envelope.ok === false &&
      exactKeys(envelope, ["ok", "error"]) &&
      isRecord(envelope.error) &&
      exactKeys(envelope.error, ["code"]) &&
      includes(codes, envelope.error.code)
    ) {
      throw portableError(envelope.error.code);
    }
    throw portableError("backend_unavailable");
  };
}

function planeRequest(binding, op) {
  const payload = SafeObjectCreate(null);
  payload.protocol = PROTOCOL;
  payload.binding = binding;
  payload.op = op;
  return payload;
}

function createKvAdapter(call, binding) {
  const portable = SafeObjectCreate(null);
  portable.get = async (key) => {
    const found = await kvRead(call, binding, key, "get");
    return found === null ? null : found.value;
  };
  portable.getWithMetadata = async (key) => {
    const found = await kvRead(call, binding, key, "getWithMetadata");
    if (found === null) return null;
    const result = SafeObjectCreate(null);
    result.value = found.value;
    if (found.metadata !== undefined) result.metadata = found.metadata;
    return result;
  };
  portable.put = async (key, value, options) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    const bytes = runtimeBytes(value, "invalid_value");
    if (viewByteLength(bytes) > MAX_KV_VALUE_BYTES) throw portableError("value_too_large");
    const normalized = validateKvPutOptions(options);
    const payload = planeRequest(binding, "put");
    payload.key = key;
    payload.value = encodeBase64(bytes);
    if (normalized.expirationTtlSeconds !== undefined) {
      payload.expirationTtlSeconds = normalized.expirationTtlSeconds;
    }
    if (normalized.metadata !== undefined) payload.metadata = normalized.metadata;
    const value_ = await call(KV_URL, payload, KV_ERROR_CODES);
    if (!isRecord(value_) || !exactKeys(value_, [])) throw portableError("backend_unavailable");
  };
  portable.delete = async (key) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    const payload = planeRequest(binding, "delete");
    payload.key = key;
    const value = await call(KV_URL, payload, KV_ERROR_CODES);
    if (!isRecord(value) || !exactKeys(value, [])) throw portableError("backend_unavailable");
  };
  portable.list = async (options) => {
    const normalized = validateKvListOptions(options);
    const payload = planeRequest(binding, "list");
    if (normalized.prefix !== undefined) payload.prefix = normalized.prefix;
    if (normalized.cursor !== undefined) payload.cursor = normalized.cursor;
    if (normalized.limit !== undefined) payload.limit = normalized.limit;
    const value = await call(KV_URL, payload, KV_ERROR_CODES);
    if (
      !isRecord(value) ||
      !SafeArrayIsArray(value.keys) ||
      value.keys.length > 1000 ||
      typeof value.listComplete !== "boolean"
    ) {
      throw portableError("backend_unavailable");
    }
    const result = SafeObjectCreate(null);
    result.keys = mapArray(value.keys, (entry) => {
      if (!isRecord(entry) || !boundedUtf8(entry.name, MAX_KV_KEY_BYTES)) {
        throw portableError("backend_unavailable");
      }
      const key = SafeObjectCreate(null);
      key.name = entry.name;
      return key;
    });
    result.listComplete = value.listComplete;
    if (value.cursor !== undefined && value.cursor !== "") {
      if (!boundedText(value.cursor, 4096)) throw portableError("backend_unavailable");
      result.cursor = value.cursor;
    }
    if (!value.listComplete && result.cursor === undefined) {
      throw portableError("backend_unavailable");
    }
    return result;
  };
  return portable;
}

async function kvRead(call, binding, key, op) {
  validateKey(key, MAX_KV_KEY_BYTES);
  const payload = planeRequest(binding, op);
  payload.key = key;
  const value = await call(KV_URL, payload, KV_ERROR_CODES);
  if (!isRecord(value) || typeof value.found !== "boolean") {
    throw portableError("backend_unavailable");
  }
  if (!value.found) return null;
  if (!isCanonicalBase64(value.value, MAX_KV_VALUE_BYTES)) {
    throw portableError("backend_unavailable");
  }
  const result = SafeObjectCreate(null);
  result.value = decodeBase64(value.value);
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw portableError("backend_unavailable");
    result.metadata = projectStringRecord(value.metadata);
  }
  return result;
}

function createSqlAdapter(call, binding) {
  const portable = SafeObjectCreate(null);
  portable.execute = async (sql, params) => {
    const payload = planeRequest(binding, "execute");
    payload.statement = sqlInput(sql, params);
    return projectSqlResult(await call(SQL_URL, payload, SQL_ERROR_CODES));
  };
  portable.query = async (sql, params) => {
    const payload = planeRequest(binding, "query");
    payload.statement = sqlInput(sql, params);
    const result = projectSqlResult(await call(SQL_URL, payload, SQL_ERROR_CODES));
    if (result.rowsWritten !== 0) throw portableError("backend_unavailable");
    return result;
  };
  portable.transaction = async (statements) => {
    if (!SafeArrayIsArray(statements) || statements.length < 1 || statements.length > MAX_SQL_STATEMENTS) {
      throw portableError("sql_error");
    }
    const normalized = mapArray(statements, normalizeSqlStatement);
    const payload = planeRequest(binding, "transaction");
    payload.statements = normalized;
    const value = await call(SQL_URL, payload, SQL_ERROR_CODES);
    if (
      !isRecord(value) ||
      !exactKeys(value, ["results"]) ||
      !SafeArrayIsArray(value.results) ||
      value.results.length !== normalized.length
    ) {
      throw portableError("backend_unavailable");
    }
    const results = mapArray(value.results, projectSqlResult);
    const envelope = SafeObjectCreate(null);
    envelope.results = results;
    if (utf8Length(SafeJSONStringify(envelope)) > MAX_SQL_RESULT_BYTES) {
      throw portableError("backend_unavailable");
    }
    return results;
  };
  return portable;
}

function sqlInput(sql, params) {
  if (!boundedUtf8(sql, MAX_SQL_BYTES)) throw portableError("sql_error");
  const input = SafeObjectCreate(null);
  input.sql = sql;
  if (params !== undefined) {
    if (!SafeArrayIsArray(params) || params.length > MAX_SQL_PARAMETERS) {
      throw portableError("sql_error");
    }
    input.params = mapArray(params, projectSqlValue);
  }
  return input;
}

function normalizeSqlStatement(statement) {
  if (!isRecord(statement) || !onlyKeys(statement, ["sql", "params"]) || !SafeObjectHasOwn(statement, "sql")) {
    throw portableError("sql_error");
  }
  return sqlInput(statement.sql, statement.params);
}

function projectSqlResult(value) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["rows", "rowsWritten"]) ||
    !SafeArrayIsArray(value.rows) ||
    value.rows.length > MAX_SQL_ROWS ||
    !nonNegativeInteger(value.rowsWritten)
  ) {
    throw portableError("backend_unavailable");
  }
  const result = SafeObjectCreate(null);
  result.rows = mapArray(value.rows, (row) => {
    if (!isRecord(row)) throw portableError("backend_unavailable");
    const keys = SafeObjectKeys(row);
    if (SafeOwnKeys(row).length !== keys.length || keys.length > MAX_SQL_COLUMNS) {
      throw portableError("backend_unavailable");
    }
    const projected = SafeObjectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (utf8Length(key) > MAX_SQL_COLUMN_NAME_BYTES) throw portableError("backend_unavailable");
      projected[key] = projectSqlValue(row[key], true);
    }
    if (utf8Length(SafeJSONStringify(projected)) > MAX_SQL_ROW_BYTES) {
      throw portableError("backend_unavailable");
    }
    return projected;
  });
  result.rowsWritten = value.rowsWritten;
  if (utf8Length(SafeJSONStringify(result)) > MAX_SQL_RESULT_BYTES) {
    throw portableError("backend_unavailable");
  }
  return result;
}

function projectSqlValue(value, output) {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!SafeNumberIsFinite(value) || SafeMathAbs(value) > SafeNumberMaxSafeInteger) {
      throw portableError("numeric_out_of_range");
    }
    return value;
  }
  if (typeof value === "string") {
    if (utf8Length(value) > MAX_SQL_VALUE_BYTES) {
      throw portableError(output ? "backend_unavailable" : "sql_error");
    }
    return value;
  }
  if (
    isRecord(value) &&
    exactKeys(value, ["encoding", "data"]) &&
    value.encoding === "base64" &&
    isCanonicalBase64(value.data, MAX_SQL_VALUE_BYTES)
  ) {
    const projected = SafeObjectCreate(null);
    projected.encoding = "base64";
    projected.data = value.data;
    return projected;
  }
  throw portableError(output ? "backend_unavailable" : "sql_error");
}

function validateKvPutOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["expirationTtlSeconds", "metadata"])) {
    throw portableError("invalid_value");
  }
  const result = SafeObjectCreate(null);
  if (options.expirationTtlSeconds !== undefined) {
    if (
      !SafeNumberIsSafeInteger(options.expirationTtlSeconds) ||
      options.expirationTtlSeconds < 60 ||
      options.expirationTtlSeconds > 315360000
    ) {
      throw portableError("invalid_value");
    }
    result.expirationTtlSeconds = options.expirationTtlSeconds;
  }
  if (options.metadata !== undefined) {
    if (!isRecord(options.metadata)) throw portableError("invalid_value");
    const metadata = projectStringRecord(options.metadata);
    if (utf8Length(SafeJSONStringify(metadata)) > MAX_KV_METADATA_BYTES) {
      throw portableError("metadata_too_large");
    }
    result.metadata = metadata;
  }
  return result;
}

function validateKvListOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["prefix", "cursor", "limit"])) {
    throw portableError("invalid_argument");
  }
  const result = SafeObjectCreate(null);
  if (options.prefix !== undefined) {
    if (typeof options.prefix !== "string" || utf8Length(options.prefix) > MAX_KV_KEY_BYTES) {
      throw portableError("invalid_key");
    }
    result.prefix = options.prefix;
  }
  if (options.cursor !== undefined) {
    if (!boundedText(options.cursor, 4096)) throw portableError("invalid_cursor");
    result.cursor = options.cursor;
  }
  if (options.limit !== undefined) {
    if (!SafeNumberIsSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw portableError("invalid_argument");
    }
    result.limit = options.limit;
  }
  return result;
}

function runtimeBytes(value, code) {
  if (typeof value === "string") return SafeApply(SafeTextEncoderEncode, encoder, [value]);
  try { return new SafeUint8Array(SafeApply(SafeArrayBufferSlice, value, [0])); } catch {}
  if (SafeArrayBufferIsView(value)) {
    let buffer; let byteOffset; let byteLength;
    try {
      buffer = SafeApply(SafeTypedArrayBufferGet, value, []);
      byteOffset = SafeApply(SafeTypedArrayByteOffsetGet, value, []);
      byteLength = SafeApply(SafeTypedArrayByteLengthGet, value, []);
    } catch {
      try {
        buffer = SafeApply(SafeDataViewBufferGet, value, []);
        byteOffset = SafeApply(SafeDataViewByteOffsetGet, value, []);
        byteLength = SafeApply(SafeDataViewByteLengthGet, value, []);
      } catch { throw portableError(code); }
    }
    return new SafeUint8Array(SafeApply(SafeArrayBufferSlice, buffer, [byteOffset, byteOffset + byteLength]));
  }
  throw portableError(code);
}

function encodeBase64(bytes) {
  let binary = "";
  const length = viewByteLength(bytes);
  for (let offset = 0; offset < length; offset += 4096) {
    const end = SafeMathMin(offset + 4096, length);
    for (let index = offset; index < end; index += 1) {
      binary += SafeApply(SafeStringFromCharCode, undefined, [bytes[index]]);
    }
  }
  return SafeBtoa(binary);
}

function decodeBase64(value) {
  const binary = SafeAtob(value);
  const bytes = new SafeUint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return SafeApply(SafeTypedArrayBufferGet, bytes, []);
}

function isCanonicalBase64(value, maximumBytes) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !SafeApply(SafeRegExpTest, BASE64_PATTERN, [value])) {
    return false;
  }
  try {
    const decoded = SafeAtob(value);
    return decoded.length <= maximumBytes && SafeBtoa(decoded) === value;
  } catch { return false; }
}

// Metadata that is the wrong kind of thing is invalid_value; only too much of
// it is metadata_too_large. Answering a size refusal to a one-member record
// whose value is a number sends the caller to shrink what is already small.
function projectStringRecord(value) {
  if (!isRecord(value)) throw portableError("invalid_value");
  const keys = SafeObjectKeys(value);
  sortStrings(keys);
  if (SafeOwnKeys(value).length !== keys.length) throw portableError("invalid_value");
  if (keys.length > 64) throw portableError("metadata_too_large");
  const result = SafeObjectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const item = value[key];
    if (typeof item !== "string") throw portableError("invalid_value");
    if (key.length > 256 || item.length > 8192) {
      throw portableError("metadata_too_large");
    }
    result[key] = item;
  }
  return result;
}

function sortStrings(values) {
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    let destination = index;
    while (destination > 0 && value < values[destination - 1]) {
      values[destination] = values[destination - 1];
      destination -= 1;
    }
    values[destination] = value;
  }
}

function validateKey(value, maximum) {
  if (!boundedUtf8(value, maximum)) throw portableError("invalid_key");
}

function captureMethod(receiver, name) {
  if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) {
    throw portableError("backend_unavailable");
  }
  let method;
  try { method = receiver[name]; } catch { throw portableError("backend_unavailable"); }
  if (typeof method !== "function") throw portableError("backend_unavailable");
  return method;
}

function portableError(code) {
  const error = new SafeError(code);
  error.name = code;
  return error;
}

function includes(values, value) {
  for (let index = 0; index < values.length; index += 1) if (values[index] === value) return true;
  return false;
}

function mapArray(values, mapper) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) output[index] = mapper(values[index], index);
  return output;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !SafeArrayIsArray(value);
}

function exactKeys(value, expected) {
  const keys = SafeObjectKeys(value);
  if (SafeOwnKeys(value).length !== keys.length || keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (!SafeObjectHasOwn(value, expected[index])) return false;
  }
  return true;
}

function onlyKeys(value, allowed) {
  const keys = SafeObjectKeys(value);
  if (SafeOwnKeys(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!includes(allowed, keys[index])) return false;
  }
  return true;
}

function nonNegativeInteger(value) {
  return SafeNumberIsSafeInteger(value) && value >= 0;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function boundedUtf8(value, maximum) {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= maximum;
}

function utf8Length(value) {
  return viewByteLength(SafeApply(SafeTextEncoderEncode, encoder, [value]));
}

function viewByteLength(value) {
  try { return SafeApply(SafeTypedArrayByteLengthGet, value, []); }
  catch {
    try { return SafeApply(SafeDataViewByteLengthGet, value, []); }
    catch { throw portableError("backend_unavailable"); }
  }
}
`;
}

function normalizeSourceInput(input: SelfhostWorkerEntrypointSourceInput): {
  readonly originalMainModule: string;
  readonly declaredHandlers: SelfhostWorkerHandlerName[];
  readonly bindings: SelfhostWorkerBindingDescriptor[];
  readonly publication: string;
  readonly probeHostname: string;
  readonly events: boolean;
  readonly services: string[];
} {
  const fields = dataProperties(input, "input");
  // `events` and `services` are optional, so the accepted key set is built from
  // what is present rather than one shape being a superset nothing checks.
  exactNormalizedKeys(
    fields,
    [
      "originalMainModule",
      "declaredHandlers",
      "bindings",
      "publication",
      "probeHostname",
      ...(Object.hasOwn(fields, "events") ? ["events"] : []),
      ...(Object.hasOwn(fields, "services") ? ["services"] : []),
    ],
    "input",
  );
  if (Object.hasOwn(fields, "events") && typeof fields.events !== "boolean") invalid("events");
  validateArtifactPartName(fields.originalMainModule);
  if (fields.originalMainModule === SELFHOST_WORKER_ENTRYPOINT_MODULE)
    invalid("originalMainModule");
  if (typeof fields.publication !== "string" || !PUBLICATION.test(fields.publication)) {
    invalid("publication");
  }
  if (
    typeof fields.probeHostname !== "string" ||
    fields.probeHostname.length > 255 ||
    !PROBE_HOSTNAME.test(fields.probeHostname)
  ) {
    invalid("probeHostname");
  }
  const declaredHandlersInput = dataArray(fields.declaredHandlers, "declaredHandlers");
  if (declaredHandlersInput.length < 1) invalid("declaredHandlers");
  const declaredHandlers: SelfhostWorkerHandlerName[] = [];
  const handlerSet = new Set<string>();
  for (const handler of declaredHandlersInput) {
    if (typeof handler !== "string" || !HANDLER_NAMES.has(handler) || handlerSet.has(handler)) {
      invalid("declaredHandlers");
    }
    handlerSet.add(handler);
    declaredHandlers.push(handler as SelfhostWorkerHandlerName);
  }
  const bindingInputs = dataArray(fields.bindings, "bindings");
  const bindings: SelfhostWorkerBindingDescriptor[] = [];
  const publicNames = new Set<string>();
  for (const bindingInput of bindingInputs) {
    const binding = dataProperties(bindingInput, "bindings");
    if (Object.hasOwn(binding, "kind")) {
      exactNormalizedKeys(binding, ["kind", "publicName"], "bindings");
      if (typeof binding.kind !== "string" || !DATA_BINDING_KINDS.has(binding.kind)) {
        invalid("bindings");
      }
      validatePublicName(binding.publicName, publicNames, false);
      bindings.push({
        kind: binding.kind as SelfhostWorkerDataBindingDescriptor["kind"],
        publicName: binding.publicName as string,
      });
      continue;
    }
    exactNormalizedKeys(binding, ["name", "type"], "bindings");
    if (typeof binding.type !== "string" || !NATIVE_BINDING_TYPES.has(binding.type)) {
      invalid("bindings");
    }
    validatePublicName(binding.name, publicNames, true);
    bindings.push({
      name: binding.name as string,
      type: binding.type as SelfhostWorkerNativeBindingDescriptor["type"],
    });
  }
  const events = fields.events === true;
  // The Host's own service bindings, held to the same grammar workerd will
  // accept and to this module's reserved prefix, so a caller cannot ask the
  // entrypoint to hand on a name this Host keeps for itself.
  const services: string[] = [];
  if (Object.hasOwn(fields, "services")) {
    const seen = new Set<string>();
    for (const name of dataArray(fields.services, "services")) {
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > 64 ||
        !BINDING_NAME.test(name) ||
        name.startsWith(SELFHOST_WORKER_INTERNAL_BINDING_PREFIX) ||
        seen.has(name)
      ) {
        invalid("services");
      }
      seen.add(name);
      services.push(name);
    }
  }
  // A wrapper with no data binding and no event is not a degenerate wrapper: it
  // is the load probe. The entrypoint imports the tenant module and answers
  // whether it loaded, and a publication that carried no facade used to skip
  // that entirely — so an unloadable module deployed, reported Ready, and
  // failed with a 500 on the first real request instead. Carrying a facade is
  // therefore no longer a precondition for generating one.
  return {
    originalMainModule: fields.originalMainModule,
    declaredHandlers,
    bindings,
    publication: fields.publication,
    probeHostname: fields.probeHostname,
    events,
    services,
  };
}

function validateArtifactPartName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    !ARTIFACT_PART_NAME.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    invalid("originalMainModule");
  }
}

function validatePublicName(value: unknown, seen: Set<string>, variable: boolean): void {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !(variable ? VARIABLE_NAME : BINDING_NAME).test(value) ||
    value.startsWith(SELFHOST_WORKER_INTERNAL_BINDING_PREFIX) ||
    seen.has(value)
  ) {
    invalid("bindings");
  }
  seen.add(value);
}

function dataProperties(
  value: unknown,
  field: string,
  allowArray = false,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || (!allowArray && Array.isArray(value))) {
    invalid(field);
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalid(field);
  }
  const properties = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") invalid(field);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      invalid(field);
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid(field);
    properties[key] = descriptor.value;
  }
  return properties;
}

function dataArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  const properties = dataProperties(value, field, true);
  const length = properties.length;
  if (!Number.isSafeInteger(length) || (length as number) < 0) invalid(field);
  if (Reflect.ownKeys(properties).length !== (length as number) + 1) invalid(field);
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const key = String(index);
    if (!Object.hasOwn(properties, key)) invalid(field);
    result[index] = properties[key];
  }
  return result;
}

function exactNormalizedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    invalid(field);
  }
}

function invalid(field: string): never {
  throw new TypeError(`self-host Worker wrapper ${field} is invalid`);
}
