import type { JsonObject } from "./ports.ts";

/*
 * This module is statically loaded by the isolated Workflow helper before a
 * tenant module is evaluated. Keep it dependency-light: the helper must not
 * pull the SQL coordinator into the tenant Worker merely to share its private
 * driver protocol and errors.
 */
const SafeError = Error;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafePromise = Promise;
const SafePromiseCatch = Promise.prototype.catch;
const SafePromiseFinally = Promise.prototype.finally;
const SafePromiseThen = Promise.prototype.then;
const SafeReflectApply = Reflect.apply;
const SafeSymbolSpecies = Symbol.species;
const SafeWeakSet = WeakSet;
const SafeWeakSetAdd = WeakSet.prototype.add;
const SafeWeakSetHas = WeakSet.prototype.has;

const runtimeErrors = new SafeWeakSet<object>();
const callInputErrors = new SafeWeakSet<object>();
const callInputTypeErrors = new SafeWeakSet<object>();
const stepErrors = new SafeWeakSet<object>();

function remember(set: WeakSet<object>, value: object): void {
  SafeReflectApply(SafeWeakSetAdd, set, [value]);
}

function remembers(set: WeakSet<object>, value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? SafeReflectApply(SafeWeakSetHas, set, [value])
    : false;
}

function defineOwn<T>(target: object, key: string, value: T): T {
  SafeReflectApply(SafeObjectDefineProperty, SafeObject, [
    target,
    key,
    dataDescriptor(value, true, true, true),
  ]);
  return value;
}

function defineErrorName(target: object, name: string): void {
  SafeReflectApply(SafeObjectDefineProperty, SafeObject, [
    target,
    "name",
    dataDescriptor(name, true, true, true),
  ]);
}

/*
 * Promise prototype methods and Promise[Symbol.species] are mutable. A private
 * subclass with fixed own methods keeps helper-created Promises usable after
 * tenant startup without changing or freezing the tenant's globals.
 */
class WorkflowPromise<T> extends SafePromise<T> {
  // biome-ignore lint/complexity/noUselessConstructor: Bun's synthesized constructor consults poisoned realm intrinsics; keep explicit super.
  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => void,
  ) {
    super(executor);
  }
}

function defineFixed(target: object, key: PropertyKey, value: unknown): void {
  SafeReflectApply(SafeObjectDefineProperty, SafeObject, [
    target,
    key,
    dataDescriptor(value, false, false, false),
  ]);
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

defineFixed(WorkflowPromise.prototype, "constructor", WorkflowPromise);
defineFixed(WorkflowPromise.prototype, "then", SafePromiseThen);
defineFixed(WorkflowPromise.prototype, "catch", SafePromiseCatch);
defineFixed(WorkflowPromise.prototype, "finally", SafePromiseFinally);
defineFixed(WorkflowPromise, SafeSymbolSpecies, WorkflowPromise);
SafeObjectFreeze(WorkflowPromise.prototype);
SafeObjectFreeze(WorkflowPromise);

export type WorkflowPromiseExecutor<T> = (
  resolve: (value: T) => void,
  reject: (reason?: unknown) => void,
) => void;

/**
 * Creates a Promise whose own prototype behavior was fixed before tenant
 * evaluation. Object fulfillments must have a null-prototype root or an
 * intentional own non-callable `then`; use boxed adoption for arbitrary Host
 * objects and ordinary ECMAScript assimilation for application thenables.
 */
export function createWorkflowPromise<T>(executor: WorkflowPromiseExecutor<T>): Promise<T> {
  return new WorkflowPromise<T>((resolve, reject) => {
    executor((value) => resolve(value), reject);
  });
}

/**
 * Observes a genuine Host-created native Promise without resolving another
 * Promise with its possibly object-valued result. This is the safe primitive
 * for fetch()/Response methods after tenant poisoning.
 */
export function observeTrustedWorkflowPromise<T>(
  promise: Promise<T>,
  onFulfilled: (value: T) => void,
  onRejected: (reason: unknown) => void,
): void {
  try {
    defineFixed(promise, "constructor", WorkflowPromise);
    const observed = SafeReflectApply(SafePromiseThen, promise, [
      (value: T) => {
        onFulfilled(value);
      },
      (reason: unknown) => {
        onRejected(reason);
      },
    ]) as Promise<void>;
    // Keep a throwing observer callback from becoming an unhandled rejection.
    SafeReflectApply(SafePromiseThen, observed, [undefined, () => undefined]);
  } catch (error) {
    onRejected(error);
  }
}

/**
 * Adopts a genuine Host-created native Promise after shielding its species
 * lookup with an own private constructor. The fulfilled value is boxed under
 * a fresh null-prototype root so resolving this Promise never re-assimilates
 * an exotic/non-extensible object or its inherited `then`. This mutates only
 * the supplied trusted Promise object; never pass an application thenable.
 */
export interface TrustedWorkflowPromiseValue<T> {
  readonly value: T;
}

export function adoptTrustedWorkflowPromise<T>(
  promise: Promise<T>,
): Promise<TrustedWorkflowPromiseValue<T>> {
  return createWorkflowPromise<TrustedWorkflowPromiseValue<T>>((resolve, reject) => {
    observeTrustedWorkflowPromise(
      promise,
      (value) => {
        const boxed = SafeObjectCreate(null) as { value: T };
        defineOwn(boxed, "value", value);
        resolve(boxed);
      },
      reject,
    );
  });
}

export type WorkflowApplicationOutcome =
  | { readonly kind: "complete"; readonly output?: JsonObject }
  | { readonly kind: "failed"; readonly reason: "run_threw" }
  // An isolated adapter must correlate an uncaught driver error back to the
  // original host-side object. A serialized/reconstructed Error is not proof.
  | { readonly kind: "failed"; readonly reason: "step_failed"; readonly error: WorkflowStepError };

export interface WorkflowDriver {
  do(
    prepareName: () => string | Promise<string>,
    preparePending: () =>
      | {
          readonly retryDelaysSeconds: readonly number[];
          readonly effect: () => Promise<JsonObject | undefined> | JsonObject | undefined;
        }
      | Promise<{
          readonly retryDelaysSeconds: readonly number[];
          readonly effect: () => Promise<JsonObject | undefined> | JsonObject | undefined;
        }>,
  ): Promise<JsonObject | undefined>;
  sleep(
    prepareName: () => string | Promise<string>,
    preparePending: () => number | Promise<number>,
  ): Promise<void>;
  waitForEvent(
    prepareName: () => string | Promise<string>,
    preparePending: () =>
      | { readonly type: string; readonly timeoutSeconds: number }
      | Promise<{ readonly type: string; readonly timeoutSeconds: number }>,
  ): Promise<JsonObject | undefined>;
  /** Private host control used when the application settles around a step. */
  definitionMismatch(): Promise<never>;
}

/** Infrastructure/private-protocol failures never become application run_threw. */
export class WorkflowRuntimeError extends SafeError {
  declare readonly code:
    | "backend_unavailable"
    | "host_unavailable"
    | "stale_claim"
    | "invalid_runtime_input";

  constructor(code: WorkflowRuntimeError["code"]) {
    super(code);
    defineOwn(this, "code", code);
    defineErrorName(this, "WorkflowRuntimeError");
    remember(runtimeErrors, this);
  }
}

export function isWorkflowRuntimeError(value: unknown): value is WorkflowRuntimeError {
  return remembers(runtimeErrors, value);
}

/**
 * Private bridge for application argument validators. The class lets a driver
 * distinguish a TypeError deliberately raised by the facade from one raised
 * by host code. Its identity marks both the wrapper and the exact inner error;
 * inherited Symbol.hasInstance is deliberately not an authority signal.
 */
export class WorkflowCallInputError extends SafeError {
  declare readonly error: TypeError;

  constructor(error: TypeError) {
    super("workflow call input");
    defineOwn(this, "error", error);
    defineErrorName(this, "WorkflowCallInputError");
    remember(callInputErrors, this);
    remember(callInputTypeErrors, error);
  }
}

export function isWorkflowCallInputError(value: unknown): value is WorkflowCallInputError {
  return remembers(callInputErrors, value);
}

export function isWorkflowCallInputTypeError(value: unknown): value is TypeError {
  return remembers(callInputTypeErrors, value);
}

/** Internal driver result; its app-facing JavaScript projection is separate. */
export class WorkflowStepError extends SafeError {
  declare readonly code: "step_failed" | "wait_timeout" | "invalid_duration" | "document_too_large";

  constructor(code: WorkflowStepError["code"]) {
    super(code);
    defineOwn(this, "code", code);
    defineErrorName(this, "WorkflowStepError");
    remember(stepErrors, this);
  }
}

export function isWorkflowStepError(value: unknown): value is WorkflowStepError {
  return remembers(stepErrors, value);
}
