import { type ActorClassInspection, ActorRuntimeError } from "./actor-class-execution.ts";

type ActorClassHandler = (...args: never[]) => unknown;

export type ActorClassInspectionV2Candidate = Omit<ActorClassInspection, "handlers"> & {
  readonly handlers: ActorClassInspection["handlers"] & {
    readonly socketError: ActorClassHandler;
  };
};

const SafeArrayIsArray = Array.isArray;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeReflectApply = Reflect.apply;
const SafeReflectConstruct = Reflect.construct;
const SafeWeakSet = WeakSet;
const SafeWeakSetAdd = WeakSet.prototype.add;
const SafeWeakSetHas = WeakSet.prototype.has;

const HANDLER_NAMES = [
  "fetch",
  "alarm",
  "socketMessage",
  "socketClose",
  "socketError",
  "start",
] as const;
const REQUIRED_HANDLER_COUNT = 5;

function inertConstructTarget(): object {
  return SafeObjectCreate(null);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Static inspection for the selected, unpublished worker.actor@2 source
 * candidate. This module is intentionally not imported by a runtime entrypoint.
 * The legacy inspector is not called: a preflight followed by its unbounded
 * second walk would be unsafe for a changing Proxy prototype chain.
 * A fresh unbounded chain or non-returning Proxy trap requires an OS-killable
 * inspection child; this synchronous function makes no timeout claim.
 */
export function inspectActorClassV2Candidate(
  namespace: unknown,
  exportName: string,
): ActorClassInspectionV2Candidate {
  try {
    if (!isObject(namespace) || SafeArrayIsArray(namespace)) throw unavailable();
    if (typeof exportName !== "string" || exportName.length === 0) throw unavailable();

    const exportDescriptor = SafeObjectGetOwnPropertyDescriptor(namespace, exportName);
    if (exportDescriptor === undefined || !SafeObjectHasOwn(exportDescriptor, "value")) {
      throw unavailable();
    }
    const exported = exportDescriptor.value;
    if (typeof exported !== "function") throw unavailable();

    const prototypeDescriptor = SafeObjectGetOwnPropertyDescriptor(exported, "prototype");
    if (
      prototypeDescriptor === undefined ||
      !SafeObjectHasOwn(prototypeDescriptor, "value") ||
      !isObject(prototypeDescriptor.value)
    ) {
      throw unavailable();
    }
    const prototype = prototypeDescriptor.value;

    // The exported class is only the newTarget; its constructor body never runs.
    SafeReflectConstruct(inertConstructTarget, [], exported);

    const handlers = SafeObjectCreate(null) as Record<string, ActorClassHandler>;
    const seen = new SafeWeakSet<object>();
    let current: object | null = prototype;
    while (current !== null) {
      if (SafeReflectApply(SafeWeakSetHas, seen, [current])) throw unavailable();
      SafeReflectApply(SafeWeakSetAdd, seen, [current]);

      for (let index = 0; index < HANDLER_NAMES.length; index += 1) {
        const name = HANDLER_NAMES[index];
        if (name === undefined) throw unavailable();
        if (SafeObjectHasOwn(handlers, name)) continue;
        const descriptor = SafeObjectGetOwnPropertyDescriptor(current, name);
        if (descriptor === undefined) continue;
        if (!SafeObjectHasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
          throw unavailable();
        }
        defineFixed(handlers, name, descriptor.value);
      }
      let complete = true;
      for (let index = 0; index < HANDLER_NAMES.length; index += 1) {
        const name = HANDLER_NAMES[index];
        if (name === undefined || !SafeObjectHasOwn(handlers, name)) complete = false;
      }
      if (complete) break;
      current = SafeObjectGetPrototypeOf(current) as object | null;
    }

    for (let index = 0; index < REQUIRED_HANDLER_COUNT; index += 1) {
      const name = HANDLER_NAMES[index];
      if (name === undefined || !SafeObjectHasOwn(handlers, name)) throw unavailable();
    }
    SafeObjectFreeze(handlers);

    const candidate = SafeObjectCreate(null) as {
      exportName: string;
      constructor: ActorClassInspection["constructor"];
      prototype: object;
      handlers: typeof handlers;
    };
    defineFixed(candidate, "exportName", exportName);
    defineFixed(candidate, "constructor", exported);
    defineFixed(candidate, "prototype", prototype);
    defineFixed(candidate, "handlers", handlers);
    SafeObjectFreeze(candidate);
    return candidate as ActorClassInspectionV2Candidate;
  } catch {
    throw unavailable();
  }
}

function defineFixed(target: object, key: PropertyKey, value: unknown): void {
  SafeObjectDefineProperty(target, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

function unavailable(): ActorRuntimeError {
  return new ActorRuntimeError("backend_unavailable");
}
