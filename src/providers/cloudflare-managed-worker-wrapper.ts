import {
  TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
  TAKOSERVER_MANAGED_WORKER_EVENT_PATH,
  TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
  TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP,
  TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA,
} from "./cloudflare-managed-worker-gateway.ts";

/** Closed handler vocabulary of worker.runtime@1.0.0. */
export const MANAGED_WORKER_HANDLER_NAMES = ["fetch", "queue", "scheduled"] as const;

export type ManagedWorkerHandlerName = (typeof MANAGED_WORKER_HANDLER_NAMES)[number];

/** Cloudflare upload kinds that have an exact portable projection. */
export const MANAGED_WORKER_NATIVE_BINDING_TYPES = [
  "plain_text",
  "json",
  "secret_text",
  "kv_namespace",
  "queue",
  "service",
] as const;

export type ManagedWorkerNativeBindingType = (typeof MANAGED_WORKER_NATIVE_BINDING_TYPES)[number];

export const MANAGED_WORKER_EDGE_SQL_BINDING_KIND = "edge.sql@1.0.0" as const;
export const MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND = "edge.objects@1.0.0" as const;
export const MANAGED_WORKER_INTERNAL_BINDING_PREFIX = "__TAKOSERVER_" as const;
export const MANAGED_WORKER_READINESS_PATH =
  "/.well-known/takoserver/managed-worker-readiness/v1" as const;
export const MANAGED_WORKER_READINESS_PROPS_SCHEMA =
  "takoserver.managed-worker-readiness@v1" as const;
export const MANAGED_WORKER_READINESS_RESULT_SCHEMA =
  "takoserver.managed-worker-readiness-result@v1" as const;

export interface ManagedWorkerReadinessProps {
  readonly schema: typeof MANAGED_WORKER_READINESS_PROPS_SCHEMA;
  readonly operationId: string;
  readonly descriptorDigest: string;
}

export interface ManagedWorkerReadinessResult {
  readonly schema: typeof MANAGED_WORKER_READINESS_RESULT_SCHEMA;
  readonly operationId: string;
  readonly descriptorDigest: string;
  readonly handlers: readonly ManagedWorkerHandlerName[];
}

export interface ManagedWorkerNativeBindingDescriptor {
  readonly name: string;
  readonly type: ManagedWorkerNativeBindingType;
}

/**
 * Provider-authored bridge to the exact edge.sql@1.0.0 implementation.
 * `nativeName` and `instanceName` are deliberately not customer-controlled.
 */
export interface ManagedWorkerEdgeSqlBindingDescriptor {
  readonly kind: typeof MANAGED_WORKER_EDGE_SQL_BINDING_KIND;
  readonly publicName: string;
  readonly nativeName: string;
  readonly instanceName: string;
}

/** Provider-private R2 projected only as the exact edge.objects capability. */
export interface ManagedWorkerEdgeObjectsBindingDescriptor {
  readonly kind: typeof MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND;
  readonly publicName: string;
  readonly nativeName: string;
}

export type ManagedWorkerBindingDescriptor =
  | ManagedWorkerNativeBindingDescriptor
  | ManagedWorkerEdgeSqlBindingDescriptor
  | ManagedWorkerEdgeObjectsBindingDescriptor;

export interface ManagedWorkerEntrypointSourceInput {
  readonly originalMainModule: string;
  readonly declaredHandlers: readonly ManagedWorkerHandlerName[];
  readonly bindings: readonly ManagedWorkerBindingDescriptor[];
}

const ARTIFACT_PART_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const RESERVED_PUBLIC_BINDINGS = new Set([
  "TAKOSERVER_INTERNAL_OPERATION_MARKER",
  "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT",
]);
const NATIVE_BINDING_TYPES = new Set<string>(MANAGED_WORKER_NATIVE_BINDING_TYPES);
const HANDLER_NAMES = new Set<string>(MANAGED_WORKER_HANDLER_NAMES);

/**
 * Generate the only WfP module allowed to import a customer's original main
 * module. Input is a closed object so an unvalidated string can never become
 * an import specifier.
 */
export function managedWorkerEntrypointSource(input: ManagedWorkerEntrypointSourceInput): string {
  const normalizedInput = normalizeSourceInput(input);
  const moduleSpecifier = `./${normalizedInput.originalMainModule}`;
  const configuration = {
    declaredHandlers: [...normalizedInput.declaredHandlers].sort(),
    bindings: normalizedInput.bindings,
  };

  return `const RAW_CONFIGURATION = ${JSON.stringify(configuration)};
const EVENT_PATH = ${JSON.stringify(TAKOSERVER_MANAGED_WORKER_EVENT_PATH)};
const EVENT_PROTOCOL = ${JSON.stringify(TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL)};
const EVENT_CONTENT_TYPE = ${JSON.stringify(TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE)};
const PROPS_NAME = ${JSON.stringify(TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP)};
const PROPS_SCHEMA = ${JSON.stringify(TAKOSERVER_MANAGED_WORKER_GATEWAY_PROPS_SCHEMA)};
const READINESS_PATH = ${JSON.stringify(MANAGED_WORKER_READINESS_PATH)};
const READINESS_PROPS_SCHEMA = ${JSON.stringify(MANAGED_WORKER_READINESS_PROPS_SCHEMA)};
const READINESS_RESULT_SCHEMA = ${JSON.stringify(MANAGED_WORKER_READINESS_RESULT_SCHEMA)};

// Capture every mutable intrinsic used below before evaluating customer code.
const SafeApply = Reflect.apply;
const SafeOwnKeys = Reflect.ownKeys;
const SafeArrayIsArray = Array.isArray;
const SafeArrayBufferIsView = ArrayBuffer.isView;
const SafeArrayBufferSlice = ArrayBuffer.prototype.slice;
const SafeAtob = atob;
const SafeBtoa = btoa;
const SafeCrypto = crypto;
const SafeCryptoRandomUUID = crypto.randomUUID;
const SafeDateGetTime = Date.prototype.getTime;
const SafeError = Error;
const SafeTypeError = TypeError;
const SafeHeadersGet = Headers.prototype.get;
const SafeHeadersForEach = Headers.prototype.forEach;
const SafeJSONParse = JSON.parse;
const SafeJSONStringify = JSON.stringify;
const SafeMap = Map;
const SafeMapDelete = Map.prototype.delete;
const SafeMapGet = Map.prototype.get;
const SafeMapHas = Map.prototype.has;
const SafeMapSet = Map.prototype.set;
const SafeMathAbs = Math.abs;
const SafeMathMin = Math.min;
const SafeNumber = Number;
const SafeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const SafeNumberIsFinite = Number.isFinite;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectKeys = Object.keys;
const SafeObjectPrototype = Object.prototype;
const SafeObjectSetPrototypeOf = Object.setPrototypeOf;
const SafeDataViewBufferGet = captureGetter(DataView.prototype, "buffer");
const SafeDataViewByteLengthGet = captureGetter(DataView.prototype, "byteLength");
const SafeDataViewByteOffsetGet = captureGetter(DataView.prototype, "byteOffset");
const SafeDecodeURIComponent = decodeURIComponent;
const SafePromise = Promise;
const SafePromiseResolve = Promise.resolve;
const SafePromiseThen = Promise.prototype.then;
const SafeReadableStream = ReadableStream;
const SafeReadableStreamGetReader = ReadableStream.prototype.getReader;
const SafeReadableStreamPipeTo = ReadableStream.prototype.pipeTo;
const SafeReadableStreamControllerClose = ReadableStreamDefaultController.prototype.close;
const SafeReadableStreamControllerEnqueue = ReadableStreamDefaultController.prototype.enqueue;
const SafeFixedLengthStream = typeof FixedLengthStream === "function" ? FixedLengthStream : undefined;
const SafeFixedLengthStreamReadableGet = SafeFixedLengthStream ? captureGetter(SafeFixedLengthStream.prototype, "readable") : undefined;
const SafeFixedLengthStreamWritableGet = SafeFixedLengthStream ? captureGetter(SafeFixedLengthStream.prototype, "writable") : undefined;
const SafeRegExpTest = RegExp.prototype.test;
const SafeRequest = Request;
const SafeRequestBodyGet = captureGetter(Request.prototype, "body");
const SafeRequestHeadersGet = captureGetter(Request.prototype, "headers");
const SafeRequestMethodGet = captureGetter(Request.prototype, "method");
const SafeRequestUrlGet = captureGetter(Request.prototype, "url");
const SafeResponse = Response;
const SafeResponseJson = Response.json;
const SafeResponseHeadersGet = captureGetter(Response.prototype, "headers");
const SafeResponseStatusGet = captureGetter(Response.prototype, "status");
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeStringSlice = String.prototype.slice;
const SafeTextDecoder = TextDecoder;
const SafeTextDecoderDecode = TextDecoder.prototype.decode;
const SafeTextEncoder = TextEncoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const SafeUint8ArraySet = Uint8Array.prototype.set;
const SafeTypedArrayBufferGet = captureGetter(Uint8Array.prototype, "buffer");
const SafeTypedArrayByteLengthGet = captureGetter(Uint8Array.prototype, "byteLength");
const SafeTypedArrayByteOffsetGet = captureGetter(Uint8Array.prototype, "byteOffset");
const SafeURL = URL;
const SafeURLHashGet = captureGetter(URL.prototype, "hash");
const SafeURLOriginGet = captureGetter(URL.prototype, "origin");
const SafeURLPathnameGet = captureGetter(URL.prototype, "pathname");
const SafeURLSearchGet = captureGetter(URL.prototype, "search");
const SafeReader = new SafeReadableStream().getReader();
const SafeReaderRead = SafeReader.read;
const SafeReaderCancel = SafeReader.cancel;
const SafeReaderReleaseLock = SafeReader.releaseLock;
SafeApply(SafeReaderReleaseLock, SafeReader, []);
const CONFIGURATION = sealGeneratedConfiguration(RAW_CONFIGURATION);

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_MESSAGES = 100;
const MAX_QUEUE_DELAY_SECONDS = 43200;
const MAX_QUEUE_MESSAGE_BYTES = 127000;
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
const MAX_SERVICE_BYTES = 104857600;
const MAX_SERVICE_HEADERS = 64;
const MAX_SERVICE_HEADER_BYTES = 16384;
const MAX_OBJECT_KEY_BYTES = 979;
const MAX_OBJECT_BYTES = 5368709120;
const MAX_OBJECT_SINGLE_PUT_BYTES = 314572800;
const MAX_OBJECT_PARTS = 10000;
const MIN_OBJECT_NON_FINAL_PART_BYTES = 5242880;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const R2_INVALID_PART_PATTERN = /[(](?:10011|10025)[)]$/u;
const SQL_ERROR_CODES = ["sql_error", "numeric_out_of_range", "busy", "backend_unavailable"];
const encoder = new SafeTextEncoder();
let originalPromise;

function captureGetter(prototype, name) {
  let current = prototype;
  while (current) {
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [current, name]);
    if (descriptor && typeof descriptor.get === "function") return descriptor.get;
    current = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [current]);
  }
  throw new SafeTypeError("managed Worker intrinsic is unavailable");
}

export default SafeApply(SafeObjectFreeze, SafeObject, [{
  async fetch(request, rawEnv, rawContext) {
    const url = new SafeURL(SafeApply(SafeRequestUrlGet, request, []));
    const pathname = SafeApply(SafeURLPathnameGet, url, []);
    const readiness = trustedReadinessProps(rawContext, pathname);
    if (readiness) {
      try {
        await loadOriginal();
        const result = SafeObjectCreate(null);
        result.schema = READINESS_RESULT_SCHEMA;
        result.operationId = readiness.operationId;
        result.descriptorDigest = readiness.descriptorDigest;
        result.handlers = CONFIGURATION.declaredHandlers;
        return SafeApply(SafeResponseJson, SafeResponse, [result]);
      } catch {
        return statusResponse(500);
      }
    }
    const entrypoint = trustedEntrypoint(rawContext);
    if (pathname !== EVENT_PATH || SafeApply(SafeRequestMethodGet, request, []) !== "POST" || entrypoint === "fetch") {
      if (!declares("fetch")) return statusResponse(404);
      const env = projectEnv(rawEnv);
      const context = createPortableContext(rawContext);
      const original = await loadOriginal();
      return await SafeApply(original.handlers.fetch, original.target, [request, env, context]);
    }
    try {
      if (!eventHeadersAreValid(request)) throw new SafeTypeError("managed Worker event headers are invalid");
      const event = await boundedEvent(request);
      const props = trustedProps(rawContext, event);
      if (event.kind === "queue") {
        if (props.entrypoint !== "queue" || !declares("queue")) return statusResponse(404);
        return await invokeQueue(event, rawEnv, rawContext);
      }
      if (props.entrypoint !== "scheduled" || !declares("scheduled")) return statusResponse(404);
      return await invokeScheduled(event, rawEnv, rawContext);
    } catch {
      return statusResponse(500);
    }
  },
}]);

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
      descriptor.nativeName = source.nativeName;
      if (source.kind === "edge.sql@1.0.0") descriptor.instanceName = source.instanceName;
    } else {
      descriptor.name = source.name;
      descriptor.type = source.type;
    }
    bindings[index] = SafeApply(SafeObjectFreeze, SafeObject, [descriptor]);
  }
  SafeApply(SafeObjectFreeze, SafeObject, [bindings]);
  const configuration = SafeObjectCreate(null);
  configuration.declaredHandlers = declaredHandlers;
  configuration.bindings = bindings;
  return SafeApply(SafeObjectFreeze, SafeObject, [configuration]);
}

function internalArray() {
  return SafeApply(SafeObjectSetPrototypeOf, SafeObject, [[], null]);
}

function statusResponse(status) {
  const init = SafeObjectCreate(null);
  init.status = status;
  return new SafeResponse(null, init);
}

function declares(name) {
  for (let index = 0; index < CONFIGURATION.declaredHandlers.length; index += 1) {
    if (CONFIGURATION.declaredHandlers[index] === name) return true;
  }
  return false;
}

function loadOriginal() {
  if (!originalPromise) {
    const loading = import(${JSON.stringify(moduleSpecifier)});
    originalPromise = SafeApply(SafePromiseThen, loading, [validateOriginal]);
  }
  return originalPromise;
}

function validateOriginal(loaded) {
  if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function") || !SafeObjectHasOwn(loaded, "default")) {
    throw new SafeTypeError("managed Worker must have a default export");
  }
  const original = loaded.default;
  if (!original || typeof original !== "object" || SafeArrayIsArray(original)) {
    throw new SafeTypeError("managed Worker default export must be a plain object");
  }
  const prototype = SafeObjectGetPrototypeOf(original);
  if (prototype !== SafeObjectPrototype && prototype !== null) {
    throw new SafeTypeError("managed Worker default export must be a plain object");
  }
  const handlers = SafeObjectCreate(null);
  for (let index = 0; index < CONFIGURATION.declaredHandlers.length; index += 1) {
    const handler = CONFIGURATION.declaredHandlers[index];
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [original, handler]);
    if (!descriptor || !SafeObjectHasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new SafeTypeError("managed Worker declared handler is missing");
    }
    handlers[handler] = descriptor.value;
  }
  return { target: original, handlers };
}

function projectEnv(rawEnv) {
  if (!rawEnv || (typeof rawEnv !== "object" && typeof rawEnv !== "function")) {
    throw portableError("backend_unavailable");
  }
  const projected = SafeObjectCreate(null);
  for (let index = 0; index < CONFIGURATION.bindings.length; index += 1) {
    const descriptor = CONFIGURATION.bindings[index];
    if (descriptor.kind === "edge.sql@1.0.0") {
      projected[descriptor.publicName] = createSqlAdapter(rawEnv, descriptor);
      continue;
    }
    if (descriptor.kind === "edge.objects@1.0.0") {
      projected[descriptor.publicName] = createEdgeObjectsR2Adapter(rawEnv[descriptor.nativeName]);
      continue;
    }
    const raw = rawEnv[descriptor.name];
    if (descriptor.type === "plain_text" || descriptor.type === "json" || descriptor.type === "secret_text") {
      projected[descriptor.name] = raw;
    } else if (descriptor.type === "kv_namespace") {
      projected[descriptor.name] = createKvAdapter(raw);
    } else if (descriptor.type === "queue") {
      projected[descriptor.name] = createQueueAdapter(raw);
    } else if (descriptor.type === "service") {
      projected[descriptor.name] = createServiceAdapter(raw);
    } else {
      throw portableError("backend_unavailable");
    }
  }
  return projected;
}

function createPortableContext(rawContext, scheduledTasks) {
  const portable = SafeObjectCreate(null);
  const nativeWaitUntil = rawContext && typeof rawContext.waitUntil === "function"
    ? rawContext.waitUntil
    : undefined;
  portable.waitUntil = (value) => {
    const promise = SafeApply(SafePromiseResolve, SafePromise, [value]);
    if (scheduledTasks) scheduledTasks[scheduledTasks.length] = promise;
    try { SafeApply(SafePromiseThen, promise, [undefined, () => undefined]); } catch {}
    if (nativeWaitUntil) {
      try { SafeApply(nativeWaitUntil, rawContext, [promise]); } catch {}
    }
  };
  return portable;
}

async function drainScheduledTasks(tasks) {
  let offset = 0;
  while (offset < tasks.length) {
    const end = tasks.length;
    while (offset < end) {
      try { await tasks[offset]; } catch {}
      offset += 1;
    }
  }
}

function trustedEntrypoint(rawContext) {
  try {
    const props = rawContext && rawContext.props && rawContext.props[PROPS_NAME];
    if (!props || typeof props !== "object" || SafeArrayIsArray(props)) return "fetch";
    return props.entrypoint === "queue" || props.entrypoint === "scheduled" ? props.entrypoint : "fetch";
  } catch {
    return "fetch";
  }
}

function trustedReadinessProps(rawContext, pathname) {
  if (pathname !== READINESS_PATH) return undefined;
  try {
    const props = rawContext && rawContext.props;
    if (!isRecord(props) || !exactKeys(props, ["schema", "operationId", "descriptorDigest"])) return undefined;
    if (props.schema !== READINESS_PROPS_SCHEMA || !token(props.operationId) || !digest(props.descriptorDigest)) return undefined;
    return props;
  } catch {
    return undefined;
  }
}

function trustedProps(rawContext, event) {
  const props = rawContext && rawContext.props && rawContext.props[PROPS_NAME];
  if (!isRecord(props) || !exactKeys(props, ["schema", "gatewayId", "environment", "logicalWorkerId", "deploymentId", "entrypoint"])) {
    throw new SafeTypeError("managed Worker trusted props are malformed");
  }
  if (
    props.schema !== PROPS_SCHEMA ||
    !token(props.gatewayId) ||
    !token(props.environment) ||
    !token(props.logicalWorkerId) ||
    !token(props.deploymentId) ||
    (props.entrypoint !== "queue" && props.entrypoint !== "scheduled") ||
    props.logicalWorkerId !== event.logicalWorkerId ||
    props.deploymentId !== event.deploymentId
  ) throw new SafeTypeError("managed Worker trusted props are inconsistent");
  return props;
}

function eventHeadersAreValid(request) {
  const headers = SafeApply(SafeRequestHeadersGet, request, []);
  return SafeApply(SafeHeadersGet, headers, ["content-type"]) === EVENT_CONTENT_TYPE &&
    SafeApply(SafeHeadersGet, headers, ["x-takoserver-managed-worker-event"]) === EVENT_PROTOCOL;
}

async function invokeQueue(event, rawEnv, rawContext) {
  if (!SafeArrayIsArray(event.messages) || event.messages.length < 1 || event.messages.length > MAX_QUEUE_MESSAGES) {
    throw new SafeTypeError("managed Worker Queue event is invalid");
  }
  const env = projectEnv(rawEnv);
  const context = createPortableContext(rawContext);
  const original = await loadOriginal();
  const messages = [];
  const messageIds = [];
  const decisions = new SafeMap();
  const seenMessageIds = new SafeMap();
  for (let index = 0; index < event.messages.length; index += 1) {
    const input = event.messages[index];
    if (!isRecord(input) || !exactKeys(input, ["messageId", "timestampMillis", "attempts", "body"]) ||
      !boundedText(input.messageId, 256) || !nonNegativeInteger(input.timestampMillis) ||
      !SafeNumberIsSafeInteger(input.attempts) || input.attempts < 1) {
      throw new SafeTypeError("managed Worker Queue message is invalid");
    }
    const body = projectEncodedBody(input.body, MAX_QUEUE_MESSAGE_BYTES);
    const id = input.messageId;
    if (SafeApply(SafeMapHas, seenMessageIds, [id])) {
      throw new SafeTypeError("managed Worker Queue message id is duplicated");
    }
    SafeApply(SafeMapSet, seenMessageIds, [id, true]);
    messageIds[index] = id;
    const message = SafeObjectCreate(null);
    message.id = id;
    message.timestampMillis = input.timestampMillis;
    message.attempts = input.attempts;
    message.body = body;
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
    output[index] = SafeApply(SafeMapGet, decisions, [messageId]) || decision(messageId, failed ? "retry" : "ack");
  }
  const result = SafeObjectCreate(null);
  result.protocol = EVENT_PROTOCOL;
  result.kind = "queue";
  result.decisions = output;
  return SafeApply(SafeResponseJson, SafeResponse, [result]);
}

function settleOne(decisions, messageId, outcome, options) {
  if (SafeApply(SafeMapHas, decisions, [messageId])) throw portableError("already_settled");
  let delaySeconds;
  if (outcome === "retry") {
    if (options !== undefined && (!isRecord(options) || !onlyKeys(options, ["delaySeconds"]))) throw portableError("invalid_argument");
    delaySeconds = options && options.delaySeconds;
    if (delaySeconds !== undefined && (!SafeNumberIsSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > MAX_QUEUE_DELAY_SECONDS)) {
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
  const tasks = [];
  const env = projectEnv(rawEnv);
  const context = createPortableContext(rawContext, tasks);
  const original = await loadOriginal();
  const scheduled = SafeObjectCreate(null);
  scheduled.cron = event.cron;
  scheduled.scheduledTime = event.scheduledTime;
  let failed = false;
  let failure;
  try {
    await SafeApply(original.handlers.scheduled, original.target, [scheduled, env, context]);
  } catch (error) {
    failed = true;
    failure = error;
  }
  await drainScheduledTasks(tasks);
  if (failed) throw failure;
  const result = SafeObjectCreate(null);
  result.protocol = EVENT_PROTOCOL;
  result.kind = "schedule";
  result.outcome = "ack";
  return SafeApply(SafeResponseJson, SafeResponse, [result]);
}

function createKvAdapter(raw) {
  const get = captureMethod(raw, "get");
  const getWithMetadata = captureMethod(raw, "getWithMetadata");
  const put = captureMethod(raw, "put");
  const remove = captureMethod(raw, "delete");
  const list = captureMethod(raw, "list");
  const portable = SafeObjectCreate(null);
  portable.get = async (key) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    try {
      const value = await SafeApply(get, raw, [key, "arrayBuffer"]);
      if (value === null) return null;
      if (!isArrayBuffer(value)) throw portableError("backend_unavailable");
      return value;
    } catch (error) { throw mapNativeError(error, ["invalid_key", "backend_unavailable"]); }
  };
  portable.getWithMetadata = async (key) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    try {
      const output = await SafeApply(getWithMetadata, raw, [key, "arrayBuffer"]);
      if (!isRecord(output) || (output.value !== null && !isArrayBuffer(output.value))) throw portableError("backend_unavailable");
      if (output.value === null) return null;
      const result = SafeObjectCreate(null);
      result.value = output.value;
      if (output.metadata !== null && output.metadata !== undefined) result.metadata = projectStringRecord(output.metadata);
      return result;
    } catch (error) { throw mapNativeError(error, ["invalid_key", "backend_unavailable"]); }
  };
  portable.put = async (key, value, options) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    const bytes = runtimeBytes(value, "invalid_value");
    if (viewByteLength(bytes) > MAX_KV_VALUE_BYTES) throw portableError("value_too_large");
    const normalized = validateKvPutOptions(options);
    const nativeOptions = SafeObjectCreate(null);
    if (normalized.expirationTtlSeconds !== undefined) nativeOptions.expirationTtl = normalized.expirationTtlSeconds;
    if (normalized.metadata !== undefined) nativeOptions.metadata = normalized.metadata;
    try { await SafeApply(put, raw, [key, bytes, nativeOptions]); }
    catch (error) { throw mapNativeError(error, ["invalid_key", "invalid_value", "value_too_large", "metadata_too_large", "backend_unavailable"]); }
  };
  portable.delete = async (key) => {
    validateKey(key, MAX_KV_KEY_BYTES);
    try { await SafeApply(remove, raw, [key]); }
    catch (error) { throw mapNativeError(error, ["invalid_key", "backend_unavailable"]); }
  };
  portable.list = async (options) => {
    const normalized = validateKvListOptions(options);
    try {
      const output = await SafeApply(list, raw, [normalized]);
      if (!isRecord(output) || !SafeArrayIsArray(output.keys) || output.keys.length > 1000 || typeof output.list_complete !== "boolean") throw portableError("backend_unavailable");
      const result = SafeObjectCreate(null);
      result.keys = mapArray(output.keys, (entry) => {
        if (!isRecord(entry) || !boundedUtf8(entry.name, MAX_KV_KEY_BYTES)) throw portableError("backend_unavailable");
        const key = SafeObjectCreate(null); key.name = entry.name; return key;
      });
      result.listComplete = output.list_complete;
      if (output.cursor !== undefined && output.cursor !== "") {
        if (!boundedText(output.cursor, 4096)) throw portableError("backend_unavailable"); result.cursor = output.cursor;
      }
      if (!output.list_complete && result.cursor === undefined) throw portableError("backend_unavailable");
      return result;
    } catch (error) { throw mapNativeError(error, ["invalid_cursor", "backend_unavailable"]); }
  };
  return portable;
}

function createQueueAdapter(raw) {
  const send = captureMethod(raw, "send");
  const sendBatch = captureMethod(raw, "sendBatch");
  const portable = SafeObjectCreate(null);
  portable.send = async (body, options) => {
    const value = queueBody(body);
    const normalized = validateQueueSendOptions(options);
    const acceptanceId = SafeApply(SafeCryptoRandomUUID, SafeCrypto, []);
    const nativeOptions = SafeObjectCreate(null);
    nativeOptions.contentType = "bytes";
    if (normalized.delaySeconds !== undefined) nativeOptions.delaySeconds = normalized.delaySeconds;
    try {
      await SafeApply(send, raw, [value, nativeOptions]);
      // This is the wrapper's acceptance identity. Cloudflare does not return
      // its delivery id, so it is intentionally not a provider dedupe id.
      return acceptanceId;
    } catch (error) { throw mapNativeError(error, ["invalid_body", "message_too_large", "backend_unavailable"]); }
  };
  portable.sendBatch = async (messages) => {
    if (!SafeArrayIsArray(messages) || messages.length < 1 || messages.length > MAX_QUEUE_MESSAGES) throw portableError("batch_too_large");
    const native = [];
    const acceptanceIds = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isRecord(message) || !onlyKeys(message, ["body", "delaySeconds"]) || !SafeObjectHasOwn(message, "body")) throw portableError("invalid_body");
      const optionInput = SafeObjectCreate(null);
      if (message.delaySeconds !== undefined) optionInput.delaySeconds = message.delaySeconds;
      const normalized = validateQueueSendOptions(message.delaySeconds === undefined ? undefined : optionInput);
      const entry = SafeObjectCreate(null);
      entry.body = queueBody(message.body);
      entry.contentType = "bytes";
      if (normalized.delaySeconds !== undefined) entry.delaySeconds = normalized.delaySeconds;
      native[index] = entry;
      acceptanceIds[index] = SafeApply(SafeCryptoRandomUUID, SafeCrypto, []);
    }
    try { await SafeApply(sendBatch, raw, [native]); return acceptanceIds; }
    catch (error) { throw mapNativeError(error, ["invalid_body", "message_too_large", "batch_too_large", "backend_unavailable"]); }
  };
  return portable;
}

function createServiceAdapter(raw) {
  const fetch = captureMethod(raw, "fetch");
  const portable = SafeObjectCreate(null);
  portable.fetch = async (input, init) => {
    let request;
    if (init === undefined && isRequest(input)) request = input;
    else {
      try { request = new SafeRequest(input, init); }
      catch { throw portableError("invalid_argument"); }
    }
    validateServiceRequest(request);
    let response;
    try { response = await SafeApply(fetch, raw, [request]); }
    catch { throw portableError("backend_unavailable"); }
    validateServiceResponse(response);
    return response;
  };
  return portable;
}

function createEdgeObjectsR2Adapter(raw) {
  const head = captureMethod(raw, "head");
  const get = captureMethod(raw, "get");
  const put = captureMethod(raw, "put");
  const remove = captureMethod(raw, "delete");
  const list = captureMethod(raw, "list");
  const createMultipartUpload = captureMethod(raw, "createMultipartUpload");
  const resumeMultipartUpload = captureMethod(raw, "resumeMultipartUpload");
  const multipart = new SafeMap();
  const portable = SafeObjectCreate(null);
  portable.head = async function (key) {
    exactObjectArgumentCount(arguments.length, 1);
    objectKey(key);
    try {
      const found = await SafeApply(head, raw, [key]);
      if (found === null) return null;
      return objectMetadata(found);
    } catch (error) {
      const mapped = mapObjectError(error, ["invalid_key", "not_found", "backend_unavailable"]);
      if (mapped.name === "not_found") return null;
      throw mapped;
    }
  };
  portable.get = async function (key, rawOptions) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    const options = objectGetOptions(rawOptions);
    try {
      if (options.range) {
        const current = await SafeApply(head, raw, [key]);
        if (current === null) return null;
        const currentMetadata = objectMetadata(current);
        if (options.range.offset >= currentMetadata.size) throw portableError("range_not_satisfiable");
      }
      const found = await SafeApply(get, raw, [key, nativeObjectGetOptions(options)]);
      if (found === null) return null;
      if (!isReadableStream(found.body)) throw portableError("precondition_failed");
      const metadata = objectMetadata(found);
      const range = found.range === undefined
        ? servedObjectRange(options.range, metadata.size)
        : objectResultRange(found.range, metadata.size);
      const result = copyObjectGetMetadata(metadata);
      result.body = found.body;
      result.partial = range !== undefined;
      if (range !== undefined) result.range = range;
      return freezeObject(result);
    } catch (error) {
      const mapped = mapObjectError(error, ["invalid_key", "not_found", "precondition_failed", "range_not_satisfiable", "backend_unavailable"]);
      if (mapped.name === "not_found") return null;
      throw mapped;
    }
  };
  portable.put = async function (key, body, rawOptions) {
    exactObjectArgumentCount(arguments.length, 3);
    objectKey(key);
    const options = objectPutOptions(rawOptions);
    const source = objectBodySource(body, MAX_OBJECT_SINGLE_PUT_BYTES, options.contentLength);
    const nativeOptions = SafeObjectCreate(null);
    if (options.contentType !== undefined) {
      const httpMetadata = SafeObjectCreate(null);
      httpMetadata.contentType = options.contentType;
      nativeOptions.httpMetadata = httpMetadata;
    }
    addNativeObjectCondition(nativeOptions, options);
    try {
      const pending = SafeApply(put, raw, [key, source.body, nativeOptions]);
      const written = await finishObjectBody(pending, source.completion);
      if (written === null) throw portableError("precondition_failed");
      const metadata = objectMetadata(written);
      if (metadata.size !== source.length) throw portableError("invalid_body");
      const result = SafeObjectCreate(null);
      result.etag = metadata.etag;
      result.size = metadata.size;
      return freezeObject(result);
    } catch (error) {
      throw mapObjectError(error, ["invalid_key", "invalid_body", "value_too_large", "precondition_failed", "backend_unavailable"]);
    }
  };
  portable.delete = async function (key) {
    exactObjectArgumentCount(arguments.length, 1);
    objectKey(key);
    try { await SafeApply(remove, raw, [key]); }
    catch (error) { throw mapObjectError(error, ["invalid_key", "backend_unavailable"]); }
  };
  portable.list = async function (rawOptions) {
    exactObjectArgumentCount(arguments.length, 1);
    const options = objectListOptions(rawOptions);
    try {
      const page = await SafeApply(list, raw, [options]);
      if (!isRecord(page) || !SafeArrayIsArray(page.objects) || typeof page.truncated !== "boolean") {
        throw portableError("backend_unavailable");
      }
      const objects = [];
      if (page.objects.length > (options.limit === undefined ? 1000 : options.limit)) {
        throw portableError("backend_unavailable");
      }
      for (let index = 0; index < page.objects.length; index += 1) {
        const item = page.objects[index];
        objectProviderKey(item && item.key);
        const projected = copyObjectMetadata(objectMetadata(item));
        projected.key = item.key;
        objects[index] = freezeObject(projected);
      }
      const result = SafeObjectCreate(null);
      result.objects = freezeObject(objects);
      const prefixes = [];
      if (page.delimitedPrefixes !== undefined) {
        if (!SafeArrayIsArray(page.delimitedPrefixes) || page.delimitedPrefixes.length > 1000) throw portableError("backend_unavailable");
        for (let index = 0; index < page.delimitedPrefixes.length; index += 1) {
          objectProviderPrefix(page.delimitedPrefixes[index]);
          if (!includes(prefixes, page.delimitedPrefixes[index])) {
            prefixes[prefixes.length] = page.delimitedPrefixes[index];
          }
        }
      }
      result.prefixes = freezeObject(prefixes);
      result.truncated = page.truncated;
      if (page.truncated) {
        objectCursor(page.cursor);
        result.cursor = page.cursor;
      }
      return freezeObject(result);
    } catch (error) {
      throw mapObjectError(error, ["invalid_cursor", "backend_unavailable"]);
    }
  };
  portable.createMultipartUpload = async function (key, rawOptions) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    const contentType = objectMultipartOptions(rawOptions);
    const nativeOptions = SafeObjectCreate(null);
    if (contentType !== undefined) {
      const httpMetadata = SafeObjectCreate(null);
      httpMetadata.contentType = contentType;
      nativeOptions.httpMetadata = httpMetadata;
    }
    try {
      const upload = await SafeApply(createMultipartUpload, raw, [key, nativeOptions]);
      objectUploadId(upload && upload.uploadId);
      SafeApply(SafeMapSet, multipart, [objectUploadIdentity(key, upload.uploadId), new SafeMap()]);
      const result = SafeObjectCreate(null);
      result.uploadId = upload.uploadId;
      return freezeObject(result);
    } catch (error) {
      throw mapObjectError(error, ["invalid_key", "backend_unavailable"]);
    }
  };
  portable.uploadPart = async function (key, uploadId, partNumber, body, rawOptions) {
    exactObjectArgumentCount(arguments.length, 5);
    objectKey(key);
    objectUploadId(uploadId);
    objectPartNumber(partNumber);
    const options = objectUploadPartOptions(rawOptions);
    const source = objectBodySource(body, MAX_OBJECT_BYTES, options.contentLength, "invalid_body");
    try {
      const upload = SafeApply(resumeMultipartUpload, raw, [key, uploadId]);
      const uploadPart = captureMethod(upload, "uploadPart");
      const pending = SafeApply(uploadPart, upload, [partNumber, source.body]);
      const part = await finishObjectBody(pending, source.completion);
      const etag = objectEtag(part && part.etag);
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
    } catch (error) {
      throw mapObjectError(error, ["invalid_key", "invalid_body", "upload_not_found", "backend_unavailable"]);
    }
  };
  portable.completeMultipartUpload = async function (key, uploadId, rawParts) {
    exactObjectArgumentCount(arguments.length, 3);
    objectKey(key);
    objectUploadId(uploadId);
    const parts = objectParts(rawParts);
    validateKnownObjectParts(multipart, key, uploadId, parts);
    try {
      const upload = SafeApply(resumeMultipartUpload, raw, [key, uploadId]);
      const complete = captureMethod(upload, "complete");
      const completed = await SafeApply(complete, upload, [parts]);
      const metadata = objectMetadata(completed);
      const result = SafeObjectCreate(null);
      result.etag = metadata.etag;
      result.size = metadata.size;
      SafeApply(SafeMapDelete, multipart, [objectUploadIdentity(key, uploadId)]);
      return freezeObject(result);
    } catch (error) {
      throw mapObjectCompleteError(error);
    }
  };
  portable.abortMultipartUpload = async function (key, uploadId) {
    exactObjectArgumentCount(arguments.length, 2);
    objectKey(key);
    objectUploadId(uploadId);
    try {
      const upload = SafeApply(resumeMultipartUpload, raw, [key, uploadId]);
      const abort = captureMethod(upload, "abort");
      await SafeApply(abort, upload, []);
      SafeApply(SafeMapDelete, multipart, [objectUploadIdentity(key, uploadId)]);
    } catch (error) {
      throw mapObjectError(error, ["invalid_key", "upload_not_found", "backend_unavailable"]);
    }
  };
  return portable;
}

function objectMetadata(value) {
  if (!isRecord(value)) throw portableError("backend_unavailable");
  const result = SafeObjectCreate(null);
  result.etag = objectEtag(value.httpEtag);
  result.size = objectSize(value.size);
  if (value.httpMetadata !== undefined && value.httpMetadata !== null) {
    if (!isRecord(value.httpMetadata)) throw portableError("backend_unavailable");
    if (value.httpMetadata.contentType !== undefined) {
      result.contentType = objectContentType(value.httpMetadata.contentType);
    }
  }
  if (value.uploaded !== undefined) {
    let uploadedAtMillis;
    try { uploadedAtMillis = SafeApply(SafeDateGetTime, value.uploaded, []); }
    catch { throw portableError("backend_unavailable"); }
    if (!nonNegativeInteger(uploadedAtMillis)) throw portableError("backend_unavailable");
    result.uploadedAtMillis = uploadedAtMillis;
  }
  return freezeObject(result);
}

function copyObjectMetadata(value) {
  const result = SafeObjectCreate(null);
  result.etag = value.etag;
  result.size = value.size;
  if (value.uploadedAtMillis !== undefined) result.uploadedAtMillis = value.uploadedAtMillis;
  return result;
}

function copyObjectGetMetadata(value) {
  const result = SafeObjectCreate(null);
  result.etag = value.etag;
  result.size = value.size;
  if (value.contentType !== undefined) result.contentType = value.contentType;
  return result;
}

function objectGetOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["range", "ifMatch", "ifNoneMatch"]);
  if (value.ifMatch !== undefined && value.ifNoneMatch !== undefined) objectBindingTypeError();
  const result = SafeObjectCreate(null);
  if (value.range !== undefined) {
    objectOptions(value.range, ["offset", "length"]);
    if (typeof value.range.offset !== "number" || (value.range.length !== undefined && typeof value.range.length !== "number")) {
      objectBindingTypeError();
    }
    if (!nonNegativeInteger(value.range.offset) || value.range.offset > MAX_OBJECT_BYTES) {
      objectBindingTypeError();
    }
    if (value.range.length !== undefined && (!nonNegativeInteger(value.range.length) || value.range.length < 1 || value.range.length > MAX_OBJECT_BYTES)) {
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
  if (value.ifNoneMatch !== undefined && typeof value.ifNoneMatch !== "string") objectBindingTypeError();
  if (value.ifNoneMatch !== undefined && value.ifNoneMatch !== "*") objectBindingTypeError();
  const result = SafeObjectCreate(null);
  if (SafeObjectHasOwn(value, "contentLength")) result.contentLength = objectContentLength(value.contentLength);
  if (value.contentType !== undefined) result.contentType = objectInputContentType(value.contentType);
  if (value.ifMatch !== undefined) result.ifMatch = objectConditionEtag(value.ifMatch);
  if (value.ifNoneMatch !== undefined) result.ifNoneMatch = "*";
  return freezeObject(result);
}

function objectUploadPartOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["contentLength"]);
  const result = SafeObjectCreate(null);
  if (SafeObjectHasOwn(value, "contentLength")) result.contentLength = objectContentLength(value.contentLength);
  return freezeObject(result);
}

function objectListOptions(value) {
  if (value === undefined) return freezeObject(SafeObjectCreate(null));
  objectOptions(value, ["prefix", "delimiter", "cursor", "limit"]);
  const result = SafeObjectCreate(null);
  if (value.prefix !== undefined) { objectPrefix(value.prefix); result.prefix = value.prefix; }
  if (value.delimiter !== undefined) {
    if (typeof value.delimiter !== "string") objectBindingTypeError();
    if (unicodeCodePointLength(value.delimiter) < 1 || unicodeCodePointLength(value.delimiter) > 16) {
      objectBindingTypeError();
    }
    result.delimiter = value.delimiter;
  }
  if (value.cursor !== undefined) { objectInputCursor(value.cursor); result.cursor = value.cursor; }
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number") objectBindingTypeError();
    if (!nonNegativeInteger(value.limit) || value.limit < 1 || value.limit > 1000) objectBindingTypeError();
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

function nativeObjectGetOptions(options) {
  const result = SafeObjectCreate(null);
  if (options.range !== undefined) result.range = options.range;
  if (options.ifMatch !== undefined || options.ifNoneMatch !== undefined) {
    const onlyIf = SafeObjectCreate(null);
    if (options.ifMatch !== undefined) onlyIf.etagMatches = options.ifMatch;
    if (options.ifNoneMatch !== undefined) onlyIf.etagDoesNotMatch = options.ifNoneMatch;
    result.onlyIf = onlyIf;
  }
  return result;
}

function addNativeObjectCondition(result, options) {
  if (options.ifMatch === undefined && options.ifNoneMatch === undefined) return;
  const onlyIf = SafeObjectCreate(null);
  if (options.ifMatch !== undefined) onlyIf.etagMatches = options.ifMatch;
  if (options.ifNoneMatch !== undefined) onlyIf.etagDoesNotMatch = "*";
  result.onlyIf = onlyIf;
}

function objectBodySource(value, maximum, declaredLength, intrinsicTooLargeError = "value_too_large") {
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
    objectBindingTypeError();
  }
  if (declaredLength !== undefined) objectContentLength(declaredLength);
  const length = declaredLength === undefined ? known : declaredLength;
  if (length === undefined || (known !== undefined && length !== known)) {
    throw portableError("invalid_body");
  }
  if (length > maximum) throw portableError(known === undefined ? "value_too_large" : intrinsicTooLargeError);
  if (!SafeFixedLengthStream) throw portableError("backend_unavailable");
  const fixed = new SafeFixedLengthStream(length);
  const exactBody = SafeApply(SafeFixedLengthStreamReadableGet, fixed, []);
  const writable = SafeApply(SafeFixedLengthStreamWritableGet, fixed, []);
  const completion = SafeApply(SafeReadableStreamPipeTo, body, [writable]);
  const result = SafeObjectCreate(null);
  result.body = exactBody;
  result.length = length;
  result.completion = completion;
  return freezeObject(result);
}

async function finishObjectBody(pending, completion) {
  try {
    const result = await pending;
    try { await completion; }
    catch { throw portableError("invalid_body"); }
    return result;
  } catch (error) {
    try { await completion; }
    catch { throw portableError("invalid_body"); }
    throw error;
  }
}

function readableObjectBytes(bytes) {
  let sent = false;
  return new SafeReadableStream({
    pull(controller) {
      if (sent) { SafeApply(SafeReadableStreamControllerClose, controller, []); return; }
      sent = true;
      SafeApply(SafeReadableStreamControllerEnqueue, controller, [bytes]);
    },
  });
}

function objectParts(value) {
  if (!SafeArrayIsArray(value)) objectBindingTypeError();
  if (value.length < 1 || value.length > MAX_OBJECT_PARTS) objectBindingTypeError();
  const result = internalArray();
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
  return key + "\0" + uploadId;
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

function servedObjectRange(range, size) {
  if (range === undefined) return undefined;
  const result = SafeObjectCreate(null);
  result.offset = range.offset;
  result.length = SafeApply(SafeMathMin, Math, [range.length === undefined ? size : range.length, size - range.offset]);
  return freezeObject(result);
}

function objectResultRange(value, size) {
  if (!isRecord(value) || !onlyKeys(value, ["offset", "length", "suffix"]) || !SafeObjectHasOwn(value, "offset") || !SafeObjectHasOwn(value, "length") || value.suffix !== undefined || !nonNegativeInteger(value.offset) || !nonNegativeInteger(value.length) || value.length < 1 || value.offset + value.length > size) {
    throw portableError("backend_unavailable");
  }
  const result = SafeObjectCreate(null);
  result.offset = value.offset;
  result.length = value.length;
  return freezeObject(result);
}

function objectKey(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (!boundedUtf8(value, MAX_OBJECT_KEY_BYTES) || hasControlCharacters(value)) throw portableError("invalid_key");
}

function objectPrefix(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (utf8Length(value) > MAX_OBJECT_KEY_BYTES || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
}

function objectProviderKey(value) {
  if (typeof value !== "string" || !boundedUtf8(value, MAX_OBJECT_KEY_BYTES) || hasControlCharacters(value)) {
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

function objectSize(value) {
  if (!nonNegativeInteger(value) || value > MAX_OBJECT_BYTES) throw portableError("backend_unavailable");
  return value;
}

function objectEtag(value) {
  if (typeof value !== "string" || unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 256 || hasControlCharacters(value)) {
    throw portableError("backend_unavailable");
  }
  return value;
}

function objectConditionEtag(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 256 || hasControlCharacters(value)) objectBindingTypeError();
  return value;
}

function objectPartEtag(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 256 || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
  return value;
}

function objectContentType(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 256 || hasControlCharacters(value)) {
    throw portableError("backend_unavailable");
  }
  return value;
}

function objectInputContentType(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 256 || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
  return value;
}

function objectContentLength(value) {
  if (typeof value !== "number") objectBindingTypeError();
  if (!nonNegativeInteger(value) || value > MAX_OBJECT_BYTES) {
    throw portableError("invalid_body");
  }
  return value;
}

function objectCursor(value) {
  if (typeof value !== "string" || unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 4096) {
    throw portableError("backend_unavailable");
  }
}

function objectInputCursor(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (unicodeCodePointLength(value) < 1 || unicodeCodePointLength(value) > 4096) objectBindingTypeError();
}

function objectUploadId(value) {
  if (typeof value !== "string") objectBindingTypeError();
  if (value.length < 1 || value.length > 256 || hasControlCharacters(value)) {
    objectBindingTypeError();
  }
}

function objectPartNumber(value) {
  if (typeof value !== "number") objectBindingTypeError();
  if (!nonNegativeInteger(value) || value < 1 || value > MAX_OBJECT_PARTS) objectBindingTypeError();
}

function mapObjectError(error, allowed) {
  try { if (error && includes(allowed, error.name)) return portableError(error.name); } catch {}
  return portableError("backend_unavailable");
}

function mapObjectCompleteError(error) {
  try {
    if (
      error &&
      includes(["invalid_part", "upload_not_found", "value_too_large", "backend_unavailable"], error.name)
    ) {
      return portableError(error.name);
    }
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [error, "message"]);
    if (
      descriptor &&
      typeof descriptor.value === "string" &&
      SafeApply(SafeRegExpTest, R2_INVALID_PART_PATTERN, [descriptor.value])
    ) {
      return portableError("invalid_part");
    }
  } catch {}
  return portableError("backend_unavailable");
}

function freezeObject(value) {
  return SafeApply(SafeObjectFreeze, SafeObject, [value]);
}

function createSqlAdapter(rawEnv, descriptor) {
  const namespace = rawEnv[descriptor.nativeName];
  const getByName = captureMethod(namespace, "getByName");
  const stub = SafeApply(getByName, namespace, [descriptor.instanceName]);
  const execute = captureMethod(stub, "edgeSqlExecute");
  const query = captureMethod(stub, "edgeSqlQuery");
  const transaction = captureMethod(stub, "edgeSqlTransaction");
  const portable = SafeObjectCreate(null);
  portable.execute = async (sql, params) => {
    const input = sqlInput(sql, params);
    const value = await sqlRpc(stub, execute, input);
    return projectSqlResult(value);
  };
  portable.query = async (sql, params) => {
    const input = sqlInput(sql, params);
    const value = await sqlRpc(stub, query, input);
    const result = projectSqlResult(value);
    if (result.rowsWritten !== 0) throw portableError("backend_unavailable");
    return result;
  };
  portable.transaction = async (statements) => {
    if (!SafeArrayIsArray(statements) || statements.length < 1 || statements.length > MAX_SQL_STATEMENTS) throw portableError("sql_error");
    const normalized = mapArray(statements, normalizeSqlStatement);
    const input = SafeObjectCreate(null); input.statements = normalized;
    const value = await sqlRpc(stub, transaction, input);
    if (!isRecord(value) || !exactKeys(value, ["results"]) || !SafeArrayIsArray(value.results) || value.results.length !== normalized.length) throw portableError("backend_unavailable");
    const results = mapArray(value.results, projectSqlResult);
    const envelope = SafeObjectCreate(null); envelope.results = results;
    if (utf8Length(SafeJSONStringify(envelope)) > MAX_SQL_RESULT_BYTES) throw portableError("backend_unavailable");
    return results;
  };
  return portable;
}

async function sqlRpc(stub, method, input) {
  let envelope;
  try { envelope = await SafeApply(method, stub, [input]); }
  catch { throw portableError("backend_unavailable"); }
  if (!isRecord(envelope)) throw portableError("backend_unavailable");
  if (envelope.ok === true && exactKeys(envelope, ["ok", "value"])) return envelope.value;
  if (envelope.ok === false && exactKeys(envelope, ["ok", "error"]) && isRecord(envelope.error) && exactKeys(envelope.error, ["code"]) && includes(SQL_ERROR_CODES, envelope.error.code)) {
    throw portableError(envelope.error.code);
  }
  throw portableError("backend_unavailable");
}

function sqlInput(sql, params) {
  if (!boundedUtf8(sql, MAX_SQL_BYTES)) throw portableError("sql_error");
  const input = SafeObjectCreate(null); input.sql = sql;
  if (params !== undefined) {
    if (!SafeArrayIsArray(params) || params.length > MAX_SQL_PARAMETERS) throw portableError("sql_error");
    input.params = mapArray(params, projectSqlValue);
  }
  return input;
}

function normalizeSqlStatement(statement) {
  if (!isRecord(statement) || !onlyKeys(statement, ["sql", "params"]) || !SafeObjectHasOwn(statement, "sql")) throw portableError("sql_error");
  return sqlInput(statement.sql, statement.params);
}

function projectSqlResult(value) {
  if (!isRecord(value) || !exactKeys(value, ["rows", "rowsWritten"]) || !SafeArrayIsArray(value.rows) || value.rows.length > MAX_SQL_ROWS || !nonNegativeInteger(value.rowsWritten)) throw portableError("backend_unavailable");
  const result = SafeObjectCreate(null);
  result.rows = mapArray(value.rows, (row) => {
    if (!isRecord(row)) throw portableError("backend_unavailable");
    const keys = SafeObjectKeys(row);
    if (SafeOwnKeys(row).length !== keys.length || keys.length > MAX_SQL_COLUMNS) throw portableError("backend_unavailable");
    const projected = SafeObjectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (utf8Length(key) > MAX_SQL_COLUMN_NAME_BYTES) throw portableError("backend_unavailable");
      projected[key] = projectSqlValue(row[key], true);
    }
    if (utf8Length(SafeJSONStringify(projected)) > MAX_SQL_ROW_BYTES) throw portableError("backend_unavailable");
    return projected;
  });
  result.rowsWritten = value.rowsWritten;
  if (utf8Length(SafeJSONStringify(result)) > MAX_SQL_RESULT_BYTES) throw portableError("backend_unavailable");
  return result;
}

function projectSqlValue(value, output) {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!SafeNumberIsFinite(value) || SafeMathAbs(value) > SafeNumberMaxSafeInteger) throw portableError("numeric_out_of_range");
    return value;
  }
  if (typeof value === "string") {
    if (utf8Length(value) > MAX_SQL_VALUE_BYTES) throw portableError(output ? "backend_unavailable" : "sql_error");
    return value;
  }
  if (isRecord(value) && exactKeys(value, ["encoding", "data"]) && value.encoding === "base64" && isCanonicalBase64(value.data, MAX_SQL_VALUE_BYTES)) {
    const projected = SafeObjectCreate(null); projected.encoding = "base64"; projected.data = value.data; return projected;
  }
  throw portableError(output ? "backend_unavailable" : "sql_error");
}

function validateKvPutOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["expirationTtlSeconds", "metadata"])) throw portableError("invalid_value");
  const result = SafeObjectCreate(null);
  if (options.expirationTtlSeconds !== undefined) {
    if (!SafeNumberIsSafeInteger(options.expirationTtlSeconds) || options.expirationTtlSeconds < 60 || options.expirationTtlSeconds > 315360000) throw portableError("invalid_value");
    result.expirationTtlSeconds = options.expirationTtlSeconds;
  }
  if (options.metadata !== undefined) {
    if (!isRecord(options.metadata)) throw portableError("invalid_value");
    const metadata = projectStringRecord(options.metadata);
    if (utf8Length(SafeJSONStringify(metadata)) > MAX_KV_METADATA_BYTES) throw portableError("metadata_too_large");
    result.metadata = metadata;
  }
  return result;
}

function validateKvListOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["prefix", "cursor", "limit"])) throw portableError("invalid_argument");
  const result = SafeObjectCreate(null);
  if (options.prefix !== undefined) { if (typeof options.prefix !== "string" || utf8Length(options.prefix) > MAX_KV_KEY_BYTES) throw portableError("invalid_key"); result.prefix = options.prefix; }
  if (options.cursor !== undefined) { if (!boundedText(options.cursor, 4096)) throw portableError("invalid_cursor"); result.cursor = options.cursor; }
  if (options.limit !== undefined) { if (!SafeNumberIsSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw portableError("invalid_argument"); result.limit = options.limit; }
  return result;
}

function validateQueueSendOptions(options) {
  if (options === undefined) return SafeObjectCreate(null);
  if (!isRecord(options) || !onlyKeys(options, ["delaySeconds"])) throw portableError("invalid_argument");
  if (options.delaySeconds === undefined) return SafeObjectCreate(null);
  if (!SafeNumberIsSafeInteger(options.delaySeconds) || options.delaySeconds < 0 || options.delaySeconds > MAX_QUEUE_DELAY_SECONDS) throw portableError("invalid_argument");
  const result = SafeObjectCreate(null); result.delaySeconds = options.delaySeconds; return result;
}

function queueBody(value) {
  const bytes = runtimeBytes(value, "invalid_body");
  if (viewByteLength(bytes) > MAX_QUEUE_MESSAGE_BYTES) throw portableError("message_too_large");
  return bytes;
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

function viewByteLength(value) {
  try { return SafeApply(SafeTypedArrayByteLengthGet, value, []); }
  catch {
    try { return SafeApply(SafeDataViewByteLengthGet, value, []); }
    catch { throw portableError("backend_unavailable"); }
  }
}

function isArrayBuffer(value) {
  try { SafeApply(SafeArrayBufferSlice, value, [0, 0]); return true; } catch { return false; }
}

function isReadableStream(value) {
  let reader;
  try {
    reader = SafeApply(SafeReadableStreamGetReader, value, []);
    SafeApply(SafeReaderReleaseLock, reader, []);
    return true;
  } catch {
    if (reader) { try { SafeApply(SafeReaderReleaseLock, reader, []); } catch {} }
    return false;
  }
}

// The wrong kind of thing is invalid_value; only too much of it is
// metadata_too_large. Kept identical to the self-host facade: one Binding, one
// vocabulary, whichever backend a Worker landed on.
function projectStringRecord(value) {
  if (!isRecord(value)) throw portableError("invalid_value");
  const keys = SafeObjectKeys(value);
  sortStrings(keys);
  if (SafeOwnKeys(value).length !== keys.length) throw portableError("invalid_value");
  if (keys.length > 64) throw portableError("metadata_too_large");
  const result = SafeObjectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]; const item = value[key];
    if (typeof item !== "string") throw portableError("invalid_value");
    if (key.length > 256 || item.length > 8192) throw portableError("metadata_too_large");
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
  if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function")) throw portableError("backend_unavailable");
  let method;
  try { method = receiver[name]; } catch { throw portableError("backend_unavailable"); }
  if (typeof method !== "function") throw portableError("backend_unavailable");
  return method;
}

function mapNativeError(error, allowed) {
  try { if (error && includes(allowed, error.name)) return portableError(error.name); } catch {}
  return portableError("backend_unavailable");
}

function isRequest(value) {
  try { SafeApply(SafeRequestUrlGet, value, []); return true; } catch { return false; }
}

function validateServiceRequest(request) {
  const method = SafeApply(SafeRequestMethodGet, request, []);
  if (!includes(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"], method)) throw portableError("invalid_argument");
  const url = new SafeURL(SafeApply(SafeRequestUrlGet, request, []));
  const path = SafeApply(SafeURLPathnameGet, url, []) + SafeApply(SafeURLSearchGet, url, []);
  if (utf8Length(path) > 8192) throw portableError("invalid_argument");
  const headers = SafeApply(SafeRequestHeadersGet, request, []);
  validateServiceHeaders(headers, "request_too_large");
  const length = SafeApply(SafeHeadersGet, headers, ["content-length"]);
  if (length !== null) {
    const parsed = parseServiceLength(length, "request_too_large");
    if (SafeApply(SafeRequestBodyGet, request, []) === null && parsed !== 0) throw portableError("request_too_large");
  }
}

function validateServiceResponse(response) {
  try { SafeApply(SafeResponseStatusGet, response, []); }
  catch { throw portableError("backend_unavailable"); }
  const headers = SafeApply(SafeResponseHeadersGet, response, []);
  validateServiceHeaders(headers, "response_aborted");
  const length = SafeApply(SafeHeadersGet, headers, ["content-length"]);
  if (length !== null) parseServiceLength(length, "response_aborted");
}

function validateServiceHeaders(headers, errorCode) {
  let count = 0; let bytes = 0; let invalid = false;
  try {
    SafeApply(SafeHeadersForEach, headers, [(value, name) => {
      count += 1; bytes += utf8Length(name) + utf8Length(value);
      if (name.length > 256 || value.length > 8192) invalid = true;
    }]);
  } catch { throw portableError(errorCode); }
  if (invalid || count > MAX_SERVICE_HEADERS || bytes > MAX_SERVICE_HEADER_BYTES) throw portableError(errorCode);
}

function parseServiceLength(value, errorCode) {
  if (!SafeApply(SafeRegExpTest, DECIMAL_PATTERN, [value])) throw portableError(errorCode);
  const parsed = SafeNumber(value);
  if (!nonNegativeInteger(parsed) || parsed > MAX_SERVICE_BYTES) throw portableError(errorCode);
  return parsed;
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

async function boundedEvent(request) {
  const headers = SafeApply(SafeRequestHeadersGet, request, []);
  const declared = SafeApply(SafeHeadersGet, headers, ["content-length"]);
  if (declared !== null && (!SafeApply(SafeRegExpTest, DECIMAL_PATTERN, [declared]) || SafeNumber(declared) > MAX_EVENT_BYTES)) throw new SafeTypeError("managed Worker event is too large");
  const body = SafeApply(SafeRequestBodyGet, request, []);
  const reader = body && SafeApply(SafeReadableStreamGetReader, body, []);
  if (!reader) throw new SafeTypeError("managed Worker event body is missing");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const next = await SafeApply(SafeReaderRead, reader, []);
      if (next.done) break;
      size += viewByteLength(next.value);
      if (size > MAX_EVENT_BYTES) { try { await SafeApply(SafeReaderCancel, reader, ["event_too_large"]); } catch {} throw new SafeTypeError("managed Worker event is too large"); }
      chunks[chunks.length] = next.value;
    }
  } finally { try { SafeApply(SafeReaderReleaseLock, reader, []); } catch {} }
  const bytes = new SafeUint8Array(size); let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) { SafeApply(SafeUint8ArraySet, bytes, [chunks[index], offset]); offset += viewByteLength(chunks[index]); }
  const decoder = new SafeTextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const event = SafeJSONParse(SafeApply(SafeTextDecoderDecode, decoder, [bytes]));
  if (!isRecord(event) || event.protocol !== EVENT_PROTOCOL || !token(event.logicalWorkerId) || !token(event.deploymentId)) throw new SafeTypeError("managed Worker event is invalid");
  if (event.kind === "queue") {
    if (!exactKeys(event, ["protocol", "kind", "batchId", "logicalWorkerId", "deploymentId", "queue", "messages"]) || !boundedText(event.batchId, 256) || !boundedText(event.queue, 256)) throw new SafeTypeError("managed Worker Queue event is invalid");
  } else if (event.kind === "schedule") {
    if (!exactKeys(event, ["protocol", "kind", "logicalWorkerId", "deploymentId", "cron", "scheduledTime"]) || !boundedText(event.cron, 512) || !nonNegativeInteger(event.scheduledTime)) throw new SafeTypeError("managed Worker Schedule event is invalid");
  } else throw new SafeTypeError("managed Worker event is invalid");
  return event;
}

function projectEncodedBody(value, maximum) {
  if (!isRecord(value) || !exactKeys(value, ["encoding", "data"]) || value.encoding !== "base64" || !isCanonicalBase64(value.data, maximum)) throw new SafeTypeError("managed Worker Queue body is invalid");
  const projected = SafeObjectCreate(null); projected.encoding = "base64"; projected.data = value.data; return projected;
}

function isCanonicalBase64(value, maximumBytes) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !SafeApply(SafeRegExpTest, BASE64_PATTERN, [value])) return false;
  try {
    const decoded = SafeAtob(value);
    return decoded.length <= maximumBytes && SafeBtoa(decoded) === value;
  } catch { return false; }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !SafeArrayIsArray(value);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  try {
    const prototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [value]);
    return prototype === SafeObjectPrototype || prototype === null;
  } catch { return false; }
}

function exactKeys(value, expected) {
  const keys = SafeObjectKeys(value);
  if (SafeOwnKeys(value).length !== keys.length || keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) if (!SafeObjectHasOwn(value, expected[index])) return false;
  return true;
}

function onlyKeys(value, allowed) {
  const keys = SafeObjectKeys(value);
  if (SafeOwnKeys(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) if (!includes(allowed, keys[index])) return false;
  return true;
}

function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && SafeApply(SafeRegExpTest, TOKEN_PATTERN, [value]);
}

function digest(value) {
  if (typeof value !== "string" || value.length !== 71 || SafeApply(SafeStringSlice, value, [0, 7]) !== "sha256:") return false;
  for (let index = 7; index < value.length; index += 1) {
    const code = SafeApply(SafeStringCharCodeAt, value, [index]);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
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

function nonNegativeInteger(value) {
  return SafeNumberIsSafeInteger(value) && value >= 0;
}

function exactObjectArgumentCount(actual, maximum) {
  if (actual > maximum) objectBindingTypeError();
}

function objectBindingTypeError() {
  throw new SafeTypeError("invalid module-worker.object-bucket arguments");
}
`;
}

function normalizeSourceInput(input: ManagedWorkerEntrypointSourceInput): {
  readonly originalMainModule: string;
  readonly declaredHandlers: ManagedWorkerHandlerName[];
  readonly bindings: ManagedWorkerBindingDescriptor[];
} {
  const fields = dataProperties(input, "input");
  exactNormalizedKeys(fields, ["originalMainModule", "declaredHandlers", "bindings"], "input");
  validateArtifactPartName(fields.originalMainModule);
  const declaredHandlersInput = dataArray(fields.declaredHandlers, "declaredHandlers");
  if (declaredHandlersInput.length < 1) {
    invalid("declaredHandlers");
  }
  const declaredHandlers: ManagedWorkerHandlerName[] = [];
  const handlerSet = new Set<string>();
  for (const handler of declaredHandlersInput) {
    if (typeof handler !== "string" || !HANDLER_NAMES.has(handler) || handlerSet.has(handler)) {
      invalid("declaredHandlers");
    }
    handlerSet.add(handler);
    declaredHandlers.push(handler as ManagedWorkerHandlerName);
  }
  const bindingInputs = dataArray(fields.bindings, "bindings");
  const bindings: ManagedWorkerBindingDescriptor[] = [];
  const publicNames = new Set<string>();
  const nativeNames = new Set<string>();
  for (const bindingInput of bindingInputs) {
    const binding = dataProperties(bindingInput, "bindings");
    if (Object.hasOwn(binding, "kind")) {
      if (binding.kind === MANAGED_WORKER_EDGE_SQL_BINDING_KIND) {
        exactNormalizedKeys(
          binding,
          ["kind", "publicName", "nativeName", "instanceName"],
          "bindings",
        );
      } else if (binding.kind === MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND) {
        exactNormalizedKeys(binding, ["kind", "publicName", "nativeName"], "bindings");
      } else {
        invalid("bindings");
      }
      validatePublicName(binding.publicName, publicNames, false);
      if (
        typeof binding.nativeName !== "string" ||
        !BINDING_NAME.test(binding.nativeName) ||
        !binding.nativeName.startsWith(MANAGED_WORKER_INTERNAL_BINDING_PREFIX) ||
        nativeNames.has(binding.nativeName)
      ) {
        invalid("bindings");
      }
      nativeNames.add(binding.nativeName);
      if (binding.kind === MANAGED_WORKER_EDGE_SQL_BINDING_KIND) {
        const instanceName = binding.instanceName;
        if (
          typeof instanceName !== "string" ||
          instanceName.length < 1 ||
          instanceName.length > 512 ||
          hasControlCharacters(instanceName)
        ) {
          invalid("bindings");
        }
        bindings.push({
          kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
          publicName: binding.publicName as string,
          nativeName: binding.nativeName,
          instanceName,
        });
      } else {
        bindings.push({
          kind: MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND,
          publicName: binding.publicName as string,
          nativeName: binding.nativeName,
        });
      }
      continue;
    }
    exactNormalizedKeys(binding, ["name", "type"], "bindings");
    if (typeof binding.type !== "string" || !NATIVE_BINDING_TYPES.has(binding.type)) {
      invalid("bindings");
    }
    validatePublicName(
      binding.name,
      publicNames,
      binding.type === "plain_text" || binding.type === "json" || binding.type === "secret_text",
    );
    bindings.push({
      name: binding.name as string,
      type: binding.type as ManagedWorkerNativeBindingType,
    });
  }
  for (const nativeName of nativeNames) {
    if (publicNames.has(nativeName)) invalid("bindings");
  }
  return {
    originalMainModule: fields.originalMainModule,
    declaredHandlers,
    bindings,
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
    value.startsWith(MANAGED_WORKER_INTERNAL_BINDING_PREFIX) ||
    RESERVED_PUBLIC_BINDINGS.has(value) ||
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

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalid(field: string): never {
  throw new TypeError(`managed Worker wrapper ${field} is invalid`);
}
