/*
 * Private Actor class ABI seam.
 *
 * This module is CHILD-ONLY.  It is not an isolation boundary, a readiness
 * validator, a retirement/quiescence proof, or a socket broker.  The caller
 * owns the qualified child context, deployment/version selection, admission,
 * stream lifetime, and broker reservation.  It must never load a tenant
 * module in the controller process and must pass an already-loaded namespace
 * here.
 *
 * A constructor is required to be synchronous.  JavaScript cannot reveal
 * asynchronous work started by a constructor; the owner must enforce that
 * prohibition with its future carrier/child lifetime mechanism.  This helper
 * does not claim to prove it.
 */

import { inspectActorClassV2Candidate } from "./actor-class-candidate-inspection.ts";

const SafeArrayIsArray = Array.isArray;
const SafeError = Error;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const SafeObjectHasOwn = Object.hasOwn;
const SafeReflectApply = Reflect.apply;
const SafeReflectConstruct = Reflect.construct;
const SafeReflectOwnKeys = Reflect.ownKeys;
const SafeNumberIsInteger = Number.isInteger;
const SafeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const SafeRequest = Request;
const SafeResponse = Response;
const SafeTypeError = TypeError;
const SafeUint8Array = Uint8Array;

// A statically declared inert target lets Reflect.construct validate the
// export's [[Construct]] slot without invoking the tenant constructor or
// evaluating the dynamic Function constructor. The export is supplied only
// as `newTarget`, so its prototype is inspected but its body never runs.
function inertConstructTarget(): object {
  return SafeObjectCreate(null);
}
const SafeWeakSet = WeakSet;
const SafeWeakSetAdd = WeakSet.prototype.add;
const SafeWeakSetHas = WeakSet.prototype.has;
const SafeWeakMap = WeakMap;
const SafeWeakMapGet = WeakMap.prototype.get;
const SafeWeakMapSet = WeakMap.prototype.set;

const runtimeErrors = new SafeWeakSet<object>();

function remember<T extends object>(set: WeakSet<object>, value: T): T {
  SafeReflectApply(SafeWeakSetAdd, set, [value]);
  return value;
}

function remembered(set: WeakSet<object>, value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? SafeReflectApply(SafeWeakSetHas, set, [value])
    : false;
}

function dataDescriptor(
  value: unknown,
  enumerable: boolean,
  writable: boolean,
  configurable: boolean,
): PropertyDescriptor {
  const descriptor = SafeObjectCreate(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = enumerable;
  descriptor.writable = writable;
  descriptor.configurable = configurable;
  return descriptor;
}

function defineFixed(target: object, key: PropertyKey, value: unknown, enumerable = true): void {
  SafeObjectDefineProperty(target, key, dataDescriptor(value, enumerable, false, false));
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function unavailable(message: string): ActorRuntimeError {
  return new ActorRuntimeError("backend_unavailable", message);
}

export type ActorRuntimeErrorCode =
  | "backend_unavailable"
  | "request_too_large"
  | "invalid_upgrade"
  | "connection_limit_exceeded"
  | "message_too_large"
  | "attachment_too_large"
  | "transport_overloaded"
  | "socket_closed"
  | "invalid_close"
  | "request_aborted"
  | "response_aborted";

/** Stable private/runtime error. `name` and `code` intentionally share a value. */
export class ActorRuntimeError extends SafeError {
  declare readonly name: ActorRuntimeErrorCode;
  declare readonly code: ActorRuntimeErrorCode;

  constructor(code: ActorRuntimeErrorCode, message: string = code) {
    super(message);
    SafeObjectDefineProperty(this, "name", dataDescriptor(code, false, false, false));
    SafeObjectDefineProperty(this, "code", dataDescriptor(code, false, false, false));
    remember(runtimeErrors, this);
  }
}

export function isActorRuntimeError(value: unknown): value is ActorRuntimeError {
  return remembered(runtimeErrors, value);
}

/** Host-owned SQL/alarm/socket facades. Their concrete methods stay opaque here. */
export type ActorStorage = Readonly<Record<string, unknown>>;
export type ActorAlarm = Readonly<Record<string, unknown>>;
export type ActorSockets = Readonly<Record<string, unknown>>;
export type ActorSocket = object;

export interface ActorContext {
  readonly id: string;
  readonly storage: ActorStorage;
  readonly alarm: ActorAlarm;
  readonly sockets: ActorSockets;
}

export interface ActorContextInput {
  readonly id: string;
  readonly storage: ActorStorage;
  readonly alarm: ActorAlarm;
  readonly sockets: ActorSockets;
}

export interface ActorTurn {
  readonly signal: AbortSignal;
}

const actorContexts = new SafeWeakSet<object>();
const actorTurns = new SafeWeakSet<object>();

/**
 * Creates the closed context which the Host gives to a class constructor.
 * Facade objects are references owned by the Host; this helper does not
 * inspect, clone, or manufacture any storage/native/socket capability.
 */
export function createActorContext(input: ActorContextInput): ActorContext {
  try {
    const record = closedRecord(input, ["id", "storage", "alarm", "sockets"], "ActorContext");
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new SafeTypeError("ActorContext.id is invalid");
    }
    requireFacade(record.storage, "ActorContext.storage");
    requireFacade(record.alarm, "ActorContext.alarm");
    requireFacade(record.sockets, "ActorContext.sockets");
    const context = SafeObjectCreate(null) as ActorContext;
    defineFixed(context, "id", record.id);
    defineFixed(context, "storage", record.storage);
    defineFixed(context, "alarm", record.alarm);
    defineFixed(context, "sockets", record.sockets);
    SafeObjectFreeze(context);
    return remember(actorContexts, context);
  } catch (error) {
    if (isActorRuntimeError(error)) throw error;
    throw unavailable("ActorContext is not a Host-created closed context");
  }
}

/** Creates the one-field, immutable turn passed to start and event handlers. */
export function createActorTurn(signal: AbortSignal): ActorTurn {
  if (!isAbortSignal(signal)) throw unavailable("ActorTurn.signal is unavailable");
  const turn = SafeObjectCreate(null) as ActorTurn;
  defineFixed(turn, "signal", signal);
  SafeObjectFreeze(turn);
  return remember(actorTurns, turn);
}

export interface ActorSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type ActorEvent =
  | { readonly kind: "fetch"; readonly request: Request }
  | { readonly kind: "alarm" }
  | {
      readonly kind: "socketMessage";
      readonly socket: ActorSocket;
      readonly data: string | Uint8Array;
    }
  | {
      readonly kind: "socketClose";
      readonly socket: ActorSocket;
      readonly event: ActorSocketCloseEvent;
    };

/** Private native carrier event; never passed to Actor application code. */
type ActorTransportFailureEvent = {
  readonly kind: "socketError";
  readonly socket: ActorSocket;
  readonly event: { readonly code: "transport_error" };
};

export interface ActorInstance {
  start?(turn: ActorTurn): void | Promise<void>;
  fetch(request: Request, turn: ActorTurn): Response | Promise<Response>;
  alarm(turn: ActorTurn): void | Promise<void>;
  socketMessage(
    socket: ActorSocket,
    data: string | Uint8Array,
    turn: ActorTurn,
  ): void | Promise<void>;
  socketClose(
    socket: ActorSocket,
    event: ActorSocketCloseEvent,
    turn: ActorTurn,
  ): void | Promise<void>;
}

type HandlerName = "fetch" | "alarm" | "socketMessage" | "socketClose";
type Handler = (...args: never[]) => unknown;
type ActorConstructor = new (...args: never[]) => object;

export interface ActorClassInspection {
  readonly exportName: string;
  readonly constructor: ActorConstructor;
  readonly prototype: object;
  readonly handlers: Readonly<{
    readonly fetch: Handler;
    readonly alarm: Handler;
    readonly socketMessage: Handler;
    readonly socketClose: Handler;
    readonly socketError?: Handler;
    readonly start?: Handler;
  }>;
}

/** Internal executable profile, selected only by a complete publisher InterfaceRef. */
export interface ActorAbiProfile {
  readonly kind: "legacy" | "v2";
  readonly schemaDigest: string;
  readonly socketMessageBytes: number;
  readonly socketAttachmentBytes: number;
  readonly socketOutboundQueueBytes: number;
  readonly socketInboundBytes: number;
  readonly actorInboundBytes: number;
}

const LEGACY_PROFILE: ActorAbiProfile = SafeObjectFreeze({
  kind: "legacy",
  schemaDigest: "sha256:f5428fb587de80261dd7363dc5b8a3f4aab7e469fa1b5fce8441ad9acbec8218",
  socketMessageBytes: 8_388_608,
  socketAttachmentBytes: 8_192,
  socketOutboundQueueBytes: 8_388_608,
  socketInboundBytes: 8_388_608,
  actorInboundBytes: 16_777_216,
});
const V2_PROFILE: ActorAbiProfile = SafeObjectFreeze({
  kind: "v2",
  schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
  socketMessageBytes: 33_554_432,
  socketAttachmentBytes: 16_384,
  socketOutboundQueueBytes: 33_554_432,
  socketInboundBytes: 33_554_432,
  actorInboundBytes: 67_108_864,
});
const actorProfiles = new SafeWeakSet<object>();
remember(actorProfiles, LEGACY_PROFILE);
remember(actorProfiles, V2_PROFILE);

export function actorAbiProfile(value: ActorAbiProfile | undefined): ActorAbiProfile {
  const selected = value ?? LEGACY_PROFILE;
  if (!remembered(actorProfiles, selected)) throw unavailable("Actor ABI profile is unavailable");
  return selected;
}

/** No name-only, version-only or unknown-digest fallback. */
export function resolveActorAbiProfile(ref: unknown): ActorAbiProfile {
  try {
    const value = closedRecord(
      ref,
      ["apiVersion", "name", "version", "schemaDigest"],
      "Actor runtime InterfaceRef",
    );
    if (value.apiVersion === "interfaces.takoform.com/v1alpha1" && value.name === "worker.actor") {
      if (value.version === "1.0.0" && value.schemaDigest === LEGACY_PROFILE.schemaDigest)
        return LEGACY_PROFILE;
      if (value.version === "2.0.0" && value.schemaDigest === V2_PROFILE.schemaDigest)
        return V2_PROFILE;
    }
  } catch {
    // An accessor or malformed ref cannot select an ABI.
  }
  throw unavailable("Actor runtime InterfaceRef is unavailable");
}

type PreparedInspection = {
  readonly namespace: object;
  readonly exportName: string;
  readonly constructor: ActorClassInspection["constructor"];
  readonly profile: ActorAbiProfile;
};
const preparedInspections = new SafeWeakMap<object, PreparedInspection>();

/** Runs only in an OS-killable child; the returned object is branded to its exact input. */
export function prepareActorClassInspection(options: {
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly exportName: string;
  readonly profile: ActorAbiProfile;
}): ActorClassInspection {
  if (actorAbiProfile(options.profile) !== V2_PROFILE)
    throw unavailable("forward Actor inspection needs its exact ABI profile");
  const inspection = inspectActorClassV2Candidate(options.namespace, options.exportName);
  const prepared: PreparedInspection = {
    namespace: options.namespace,
    exportName: options.exportName,
    constructor: inspection.constructor,
    profile: options.profile,
  };
  SafeReflectApply(SafeWeakMapSet, preparedInspections, [inspection, prepared]);
  return inspection;
}

const REQUIRED_HANDLERS: readonly HandlerName[] = [
  "fetch",
  "alarm",
  "socketMessage",
  "socketClose",
];

/**
 * Purely inspects one exact named export. It never invokes the tenant
 * constructor, a method, or an accessor. Inherited prototype data methods are
 * accepted; accessors and non-callable replacements are refused.
 */
export function inspectActorClass(namespace: unknown, exportName: string): ActorClassInspection {
  try {
    if (!isObject(namespace) || SafeArrayIsArray(namespace)) {
      throw new SafeTypeError("Actor namespace is unavailable");
    }
    if (typeof exportName !== "string" || exportName.length === 0) {
      throw new SafeTypeError("Actor export name is invalid");
    }
    const namespaceDescriptor = SafeObjectGetOwnPropertyDescriptor(namespace, exportName);
    if (namespaceDescriptor === undefined || !SafeObjectHasOwn(namespaceDescriptor, "value")) {
      throw new SafeTypeError("Actor export is missing or accessor-backed");
    }
    const exported = namespaceDescriptor.value;
    if (typeof exported !== "function") {
      throw new SafeTypeError("Actor export is not constructable");
    }
    const prototypeDescriptor = SafeObjectGetOwnPropertyDescriptor(exported, "prototype");
    if (
      prototypeDescriptor === undefined ||
      !SafeObjectHasOwn(prototypeDescriptor, "value") ||
      !isObject(prototypeDescriptor.value)
    ) {
      throw new SafeTypeError("Actor export has no ordinary prototype");
    }
    const prototype = prototypeDescriptor.value;

    // This checks [[Construct]] without invoking the tenant constructor. The
    // prototype descriptor was checked above, so no prototype accessor runs.
    SafeReflectConstruct(inertConstructTarget, [], exported);

    const handlers = SafeObjectCreate(null) as {
      fetch: Handler;
      alarm: Handler;
      socketMessage: Handler;
      socketClose: Handler;
      start?: Handler;
    };
    for (const name of REQUIRED_HANDLERS) {
      const method = findPrototypeMethod(prototype, name);
      if (method === undefined) throw new SafeTypeError(`Actor handler ${name} is unavailable`);
      defineFixed(handlers, name, method);
    }
    const start = findOptionalPrototypeMethod(prototype, "start");
    if (start !== undefined) defineFixed(handlers, "start", start);
    SafeObjectFreeze(handlers);

    const inspection = SafeObjectCreate(null) as {
      exportName: string;
      constructor: ActorConstructor;
      prototype: object;
      handlers: typeof handlers;
    };
    defineFixed(inspection, "exportName", exportName);
    defineFixed(inspection, "constructor", exported as ActorConstructor);
    defineFixed(inspection, "prototype", prototype);
    defineFixed(inspection, "handlers", handlers);
    SafeObjectFreeze(inspection);
    return inspection;
  } catch (error) {
    if (isActorRuntimeError(error)) throw error;
    throw unavailable("Actor class is unavailable before execution");
  }
}

export interface ActorClassExecutionOptions {
  /** Already-loaded, deployment-qualified module namespace. No loader runs here. */
  readonly namespace: Readonly<Record<string, unknown>>;
  /** Exact named class export selected by the Host. */
  readonly exportName: string;
  /** Selected Version environment only. */
  readonly env: Readonly<Record<string, unknown>>;
  /** Host-created closed context for this fresh child execution. */
  readonly context: ActorContext;
  /** Omitted means the exact existing four-handler behavior. */
  readonly profile?: ActorAbiProfile;
  /** Required for v2; must come from prepareActorClassInspection in this child. */
  readonly inspection?: ActorClassInspection;
}

export interface ActorClassExecution {
  readonly inspection: ActorClassInspection;
  readonly context: ActorContext;
  readonly env: Readonly<Record<string, unknown>>;
  /** Initializes the constructor and optional `start` hook without an event. */
  initialize(turn: ActorTurn): Promise<void>;
  /** Dispatches one Host-admitted event. The caller owns per-id serialization. */
  dispatch(
    event: ActorEvent | ActorTransportFailureEvent,
    turn: ActorTurn,
  ): Promise<Response | undefined>;
}

/**
 * Creates one fresh class execution context. The constructor and optional
 * `start` run on the first explicit initialization or dispatch only; a new
 * session is required after eviction. Every later handler uses the same
 * instance receiver.
 */
export function createActorClassExecution(
  options: ActorClassExecutionOptions,
): ActorClassExecution {
  const profile = actorAbiProfile(options.profile);
  let inspection: ActorClassInspection;
  if (profile === V2_PROFILE) {
    const supplied = options.inspection;
    const prepared =
      supplied && isObject(supplied)
        ? (SafeReflectApply(SafeWeakMapGet, preparedInspections, [supplied]) as
            | PreparedInspection
            | undefined)
        : undefined;
    if (
      !supplied ||
      !prepared ||
      prepared.profile !== profile ||
      prepared.namespace !== options.namespace ||
      prepared.exportName !== options.exportName ||
      prepared.constructor !== supplied.constructor
    )
      throw unavailable("forward Actor inspection is unavailable");
    inspection = supplied;
  } else {
    if (options.inspection !== undefined) throw unavailable("legacy Actor inspection mismatch");
    inspection = inspectActorClass(options.namespace, options.exportName);
  }
  const context = normalizeContext(options.context);
  const env = normalizeEnvironment(options.env);

  let instance: object | undefined;
  let initialization: Promise<void> | undefined;
  let initializationFailure: unknown;
  let failed = false;

  async function initializeActor(turn: ActorTurn): Promise<void> {
    // The constructor call and start invocation occur before this function's
    // first await, preserving the synchronous construction requirement.
    let created: unknown;
    try {
      created = SafeReflectConstruct(inspection.constructor, [context, env]);
      validateInstance(created, inspection.prototype, profile);
      instance = created;
      const start = inspection.handlers.start;
      if (start !== undefined) {
        await SafeReflectApply(start, instance, [turn]);
      }
    } catch (error) {
      failed = true;
      initializationFailure = applicationFailure(error, "constructor/start");
      throw initializationFailure;
    }
  }

  function ensureInitialized(turn: ActorTurn): Promise<void> {
    if (initialization === undefined) {
      // Assignment happens before initializeActor's first await. The owner
      // must serialize calls; this helper does not provide an admission gate.
      initialization = initializeActor(turn);
    }
    return initialization;
  }

  async function initialize(turnInput: ActorTurn): Promise<void> {
    const turn = normalizeTurn(turnInput);
    if (failed) throw initializationFailure;
    await ensureInitialized(turn);
    if (failed) throw initializationFailure;
  }

  async function dispatch(
    event: ActorEvent | ActorTransportFailureEvent,
    turnInput: ActorTurn,
  ): Promise<Response | undefined> {
    const normalizedEvent = normalizeEvent(event, profile);
    const turn = normalizeTurn(turnInput);
    const handlerName = normalizedEvent.kind;

    if (failed) return failureResult(handlerName, initializationFailure);
    try {
      await ensureInitialized(turn);
    } catch (error) {
      return failureResult(handlerName, error);
    }
    if (failed || instance === undefined) {
      return failureResult(handlerName, initializationFailure);
    }

    const args = eventArguments(normalizedEvent, turn);
    try {
      const handler = inspection.handlers[handlerName];
      if (typeof handler !== "function") throw unavailable("Actor handler is unavailable");
      const result = await SafeReflectApply(handler, instance, args);
      if (handlerName === "fetch") {
        if (result instanceof SafeResponse) return result;
        throw new SafeTypeError("Actor fetch must return a Response");
      }
      return undefined;
    } catch (error) {
      failed = true;
      const failure = applicationFailure(error, handlerName);
      initializationFailure = failure;
      return failureResult(handlerName, failure);
    }
  }

  const execution = SafeObjectCreate(null) as ActorClassExecution;
  defineFixed(execution, "inspection", inspection);
  defineFixed(execution, "context", context);
  defineFixed(execution, "env", env);
  defineFixed(execution, "initialize", initialize);
  defineFixed(execution, "dispatch", dispatch);
  SafeObjectFreeze(execution);
  return execution;
}

function findPrototypeMethod(prototype: object, name: HandlerName): Handler | undefined {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = SafeObjectGetOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      // Checking `value` on the descriptor avoids invoking a getter. An
      // accessor is an explicit ABI refusal, even if its getter would return a
      // callable method.
      if (!SafeObjectHasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        throw new SafeTypeError(`Actor handler ${name} must be a prototype method`);
      }
      return descriptor.value as Handler;
    }
    current = SafeObjectGetPrototypeOf(current) as object | null;
  }
  return undefined;
}

function findOptionalPrototypeMethod(prototype: object, name: "start"): Handler | undefined {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = SafeObjectGetOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!SafeObjectHasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        throw new SafeTypeError("Actor start must be a prototype method");
      }
      return descriptor.value as Handler;
    }
    current = SafeObjectGetPrototypeOf(current) as object | null;
  }
  return undefined;
}

function validateInstance(
  value: unknown,
  prototype: object,
  profile: ActorAbiProfile,
): asserts value is object {
  if (!isObject(value)) throw new SafeTypeError("Actor constructor did not create an object");
  let current: object | null = value;
  let hasExpectedPrototype = false;
  while (current !== null) {
    if (current === prototype) {
      hasExpectedPrototype = true;
      break;
    }
    current = SafeObjectGetPrototypeOf(current) as object | null;
  }
  if (!hasExpectedPrototype) {
    throw new SafeTypeError("Actor constructor returned an incompatible object");
  }
  for (const name of profile === V2_PROFILE
    ? ["start", ...REQUIRED_HANDLERS, "socketError"]
    : ["start", ...REQUIRED_HANDLERS]) {
    const descriptor = SafeObjectGetOwnPropertyDescriptor(value, name);
    if (descriptor !== undefined) {
      // A per-instance replacement is rejected without reading an accessor.
      throw new SafeTypeError(`Actor handler ${name} cannot be replaced per instance`);
    }
  }
}

function applicationFailure(error: unknown, phase: string): unknown {
  // Preserve Host/runtime typed errors for non-HTTP callers. Primitive app
  // throws still become a typed Error rather than an untyped rejection.
  if (error instanceof SafeError || isActorRuntimeError(error)) return error;
  return new ActorExecutionError(phase, error);
}

/** Internal typed non-HTTP failure; HTTP callers receive only generic 500. */
export class ActorExecutionError extends SafeError {
  declare readonly name: "ActorExecutionError";
  declare readonly phase: string;
  override readonly cause: unknown;

  constructor(phase: string, cause: unknown) {
    super("actor execution failed");
    SafeObjectDefineProperty(
      this,
      "name",
      dataDescriptor("ActorExecutionError", false, false, false),
    );
    SafeObjectDefineProperty(this, "phase", dataDescriptor(phase, false, false, false));
    SafeObjectDefineProperty(this, "cause", dataDescriptor(cause, false, false, false));
  }
}

function failureResult(
  kind: ActorEvent["kind"] | "socketError",
  failure: unknown,
): Response | undefined {
  if (kind === "fetch") return new SafeResponse("Internal Server Error", { status: 500 });
  throw failure;
}

function normalizeContext(value: unknown): ActorContext {
  if (remembered(actorContexts, value)) return value as ActorContext;
  try {
    return createActorContext(value as ActorContextInput);
  } catch {
    throw unavailable("ActorContext is not available before execution");
  }
}

function normalizeTurn(value: unknown): ActorTurn {
  if (remembered(actorTurns, value)) return value as ActorTurn;
  try {
    const record = closedRecord(value, ["signal"], "ActorTurn");
    if (!isAbortSignal(record.signal)) throw new SafeTypeError("ActorTurn.signal is invalid");
    const turn = SafeObjectCreate(null) as ActorTurn;
    defineFixed(turn, "signal", record.signal);
    SafeObjectFreeze(turn);
    return remember(actorTurns, turn);
  } catch {
    throw unavailable("ActorTurn is not available before execution");
  }
}

function normalizeEvent(
  value: unknown,
  profile: ActorAbiProfile,
): ActorEvent | ActorTransportFailureEvent {
  try {
    if (!isObject(value) || SafeArrayIsArray(value)) throw new SafeTypeError("Actor event invalid");
    const kindDescriptor = SafeObjectGetOwnPropertyDescriptor(value, "kind");
    if (kindDescriptor === undefined || !SafeObjectHasOwn(kindDescriptor, "value")) {
      throw new SafeTypeError("Actor event kind invalid");
    }
    switch (kindDescriptor.value) {
      case "fetch": {
        const record = closedRecord(value, ["kind", "request"], "Actor fetch event");
        if (!(record.request instanceof SafeRequest))
          throw new SafeTypeError("Actor request invalid");
        return { kind: "fetch", request: record.request };
      }
      case "alarm":
        closedRecord(value, ["kind"], "Actor alarm event");
        return { kind: "alarm" };
      case "socketMessage": {
        const record = closedRecord(value, ["kind", "socket", "data"], "Actor message event");
        if (!isObject(record.socket)) throw new SafeTypeError("Actor socket invalid");
        if (typeof record.data !== "string" && !(record.data instanceof SafeUint8Array)) {
          throw new SafeTypeError("Actor message data invalid");
        }
        return {
          kind: "socketMessage",
          socket: record.socket,
          data: record.data,
        };
      }
      case "socketClose": {
        const record = closedRecord(value, ["kind", "socket", "event"], "Actor close event");
        if (!isObject(record.socket)) throw new SafeTypeError("Actor socket invalid");
        const closeEvent = normalizeCloseEvent(record.event);
        return {
          kind: "socketClose",
          socket: record.socket,
          // Preserve the Host-created event object after descriptor-only
          // validation; no facade or transport object is synthesized here.
          event: closeEvent,
        };
      }
      case "socketError": {
        const record = closedRecord(value, ["kind", "socket", "event"], "Actor error event");
        if (!isObject(record.socket)) throw new SafeTypeError("Actor socket invalid");
        const event = closedRecord(record.event, ["code"], "Actor socket error event");
        if (event.code !== "transport_error") throw new SafeTypeError("Actor socket error invalid");
        if (profile === V2_PROFILE) {
          return {
            kind: "socketError",
            socket: record.socket,
            event: record.event as { code: "transport_error" },
          };
        }
        return {
          kind: "socketClose",
          socket: record.socket,
          event: {
            code: 1006,
            reason: "transport_error",
            wasClean: false,
          },
        };
      }
      default:
        throw new SafeTypeError("Actor event kind invalid");
    }
  } catch (error) {
    if (isActorRuntimeError(error)) throw error;
    throw unavailable("Actor event is unavailable before execution");
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!isObject(value) || SafeAbortSignalAbortedGetter === undefined) return false;
  try {
    // The native getter performs the internal-slot brand check without
    // trusting a tenant-supplied `aborted` property or Symbol.hasInstance.
    SafeReflectApply(SafeAbortSignalAbortedGetter, value, []);
    return true;
  } catch {
    return false;
  }
}

function normalizeCloseEvent(value: unknown): ActorSocketCloseEvent {
  const record = closedRecord(value, ["code", "reason", "wasClean"], "Actor socket close event");
  if (typeof record.code !== "number" || !SafeNumberIsInteger(record.code)) {
    throw new SafeTypeError("Actor close code invalid");
  }
  if (typeof record.reason !== "string" || typeof record.wasClean !== "boolean") {
    throw new SafeTypeError("Actor close event invalid");
  }
  // The event is Host-created; retain its identity after descriptor-only
  // validation so handlers receive the transport's opaque event object.
  return value as ActorSocketCloseEvent;
}

function eventArguments(
  event: ActorEvent | ActorTransportFailureEvent,
  turn: ActorTurn,
): readonly unknown[] {
  switch (event.kind) {
    case "fetch":
      return [event.request, turn];
    case "alarm":
      return [turn];
    case "socketMessage":
      return [event.socket, event.data, turn];
    case "socketClose":
      return [event.socket, event.event, turn];
    case "socketError":
      return [event.socket, event.event, turn];
  }
}

function normalizeEnvironment(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (!isObject(value) || SafeArrayIsArray(value)) throw new SafeTypeError("Actor env invalid");
    const keys = SafeReflectOwnKeys(value);
    const env = SafeObjectCreate(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new SafeTypeError("Actor env has a symbol property");
      const descriptor = SafeObjectGetOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !SafeObjectHasOwn(descriptor, "value") ||
        !descriptor.enumerable
      ) {
        throw new SafeTypeError("Actor env contains an accessor or hidden property");
      }
      defineFixed(env, key, descriptor.value);
    }
    SafeObjectFreeze(env);
    return env;
  } catch (error) {
    if (isActorRuntimeError(error)) throw error;
    throw unavailable("Actor environment is unavailable before execution");
  }
}

function closedRecord(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value) || SafeArrayIsArray(value))
    throw new SafeTypeError(`${label} is not an object`);
  const names = SafeObjectGetOwnPropertyNames(value);
  const ownKeys = SafeReflectOwnKeys(value);
  if (ownKeys.length !== names.length) throw new SafeTypeError(`${label} has a symbol property`);
  if (names.length !== expected.length)
    throw new SafeTypeError(`${label} has unexpected properties`);
  const record = SafeObjectCreate(null) as Record<string, unknown>;
  for (const name of names) {
    let allowed = false;
    for (const key of expected) {
      if (name === key) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw new SafeTypeError(`${label} has an unexpected property`);
    const descriptor = SafeObjectGetOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !SafeObjectHasOwn(descriptor, "value")) {
      throw new SafeTypeError(`${label} contains an accessor`);
    }
    record[name] = descriptor.value;
  }
  for (const key of expected) {
    if (!SafeObjectHasOwn(record, key)) throw new SafeTypeError(`${label} is missing ${key}`);
  }
  return record;
}

function requireFacade(value: unknown, label: string): void {
  if (!isObject(value) || SafeArrayIsArray(value)) throw new SafeTypeError(`${label} is invalid`);
}
