import type { JsonObject } from "./ports.ts";
import {
  encodeDocument,
  inputIdentifier,
  parseDocument,
  plainInputRecord,
} from "./workflow-data.ts";
import {
  adoptTrustedWorkflowPromise,
  createWorkflowPromise,
  isWorkflowCallInputError,
  isWorkflowCallInputTypeError,
  isWorkflowStepError,
  type WorkflowApplicationOutcome,
  WorkflowCallInputError,
  type WorkflowDriver,
  type WorkflowStepError,
} from "./workflow-driver.ts";

/* Captured before the dynamically imported tenant module is evaluated. */
const SafeError = Error;
const SafeMathMin = Math.min;
const SafeNumberIsInteger = Number.isInteger;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectKeys = Object.keys;
const SafeReflectApply = Reflect.apply;
const SafeReflectConstruct = Reflect.construct;
const SafeReflectGet = Reflect.get;
const SafeTypeError = TypeError;
const SafeWeakMap = WeakMap;
const SafeWeakMapGet = WeakMap.prototype.get;
const SafeWeakMapSet = WeakMap.prototype.set;

function weakMapGet<K extends object, V>(values: WeakMap<K, V>, key: K): V | undefined {
  return SafeReflectApply(SafeWeakMapGet, values, [key]);
}

function weakMapSet<K extends object, V>(values: WeakMap<K, V>, key: K, value: V): void {
  SafeReflectApply(SafeWeakMapSet, values, [key, value]);
}

function arrayPush<T>(values: T[], value: T): void {
  SafeObjectDefineProperty(values, values.length, dataDescriptor(value, true, true, true));
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

function never<T>(): Promise<T> {
  return createWorkflowPromise<T>(() => undefined);
}

function defineEnumerableOwn(target: object, key: string, value: unknown): void {
  SafeObjectDefineProperty(target, key, dataDescriptor(value, true, true, true));
}

function completeOutcome(output?: JsonObject): WorkflowApplicationOutcome {
  const outcome = SafeObjectCreate(null) as {
    kind: "complete";
    output?: JsonObject;
  };
  defineEnumerableOwn(outcome, "kind", "complete");
  if (output !== undefined) defineEnumerableOwn(outcome, "output", output);
  return outcome;
}

function runThrewOutcome(): WorkflowApplicationOutcome {
  const outcome = SafeObjectCreate(null) as {
    kind: "failed";
    reason: "run_threw";
  };
  defineEnumerableOwn(outcome, "kind", "failed");
  defineEnumerableOwn(outcome, "reason", "run_threw");
  return outcome;
}

function stepFailedOutcome(error: WorkflowStepError): WorkflowApplicationOutcome {
  const outcome = SafeObjectCreate(null) as {
    kind: "failed";
    reason: "step_failed";
    error: WorkflowStepError;
  };
  defineEnumerableOwn(outcome, "kind", "failed");
  defineEnumerableOwn(outcome, "reason", "step_failed");
  defineEnumerableOwn(outcome, "error", error);
  return outcome;
}

function doPending(
  retryDelaysSeconds: readonly number[],
  effect: () => Promise<JsonObject | undefined> | JsonObject | undefined,
): {
  readonly retryDelaysSeconds: readonly number[];
  readonly effect: () => Promise<JsonObject | undefined> | JsonObject | undefined;
} {
  const pending = SafeObjectCreate(null) as {
    retryDelaysSeconds: readonly number[];
    effect: () => Promise<JsonObject | undefined> | JsonObject | undefined;
  };
  defineEnumerableOwn(pending, "retryDelaysSeconds", retryDelaysSeconds);
  defineEnumerableOwn(pending, "effect", effect);
  return pending;
}

function waitPending(
  type: string,
  timeoutSeconds: number,
): {
  readonly type: string;
  readonly timeoutSeconds: number;
} {
  const pending = SafeObjectCreate(null) as {
    type: string;
    timeoutSeconds: number;
  };
  defineEnumerableOwn(pending, "type", type);
  defineEnumerableOwn(pending, "timeoutSeconds", timeoutSeconds);
  return pending;
}

/** Private projection of the unpublished forward Workflow callee candidate. */
export interface WorkflowClassStep {
  do(name: unknown, effect: unknown, retryPolicy?: unknown): Promise<JsonObject | undefined>;
  sleep(name: unknown, seconds: unknown): Promise<void>;
  waitForEvent(name: unknown, options: unknown): Promise<JsonObject | undefined>;
}

export interface WorkflowClassExecution {
  /** The loader owns verified modules, fresh contexts and deployment selection. */
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly className: string;
  /** Only the selected version's declared runtime environment. */
  readonly env: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
  readonly params?: JsonObject;
  readonly driver: WorkflowDriver;
}

/**
 * Runs ordinary ECMAScript class semantics and projects the private driver.
 * This function is NOT an isolation boundary, class-readiness validator or
 * WorkflowExecutionHost. A host must run it inside its qualified context; it
 * must never import tenant modules into the controller to call this helper.
 */
export function executeWorkflowClass(
  options: WorkflowClassExecution,
): Promise<WorkflowApplicationOutcome> {
  return createWorkflowPromise<WorkflowApplicationOutcome>((resolveExecution, rejectExecution) => {
    // Copy host input before any application code. Invalid host input is an
    // infrastructure rejection, not an application run_threw outcome.
    const params = SafeObjectHasOwn(options, "params") ? options.params : undefined;
    const event =
      params === undefined
        ? { instanceId: options.instanceId }
        : {
            instanceId: options.instanceId,
            params: parseDocument(encodeDocument(params)),
          };
    const provenance = new SafeWeakMap<object, WorkflowStepError>();
    let appStepInFlight = false;
    let mismatched = false;

    function rejectInfrastructure(error: unknown): void {
      rejectExecution(error);
    }

    function mismatch(): Promise<never> {
      if (!mismatched) {
        mismatched = true;
        try {
          const stopping = adoptTrustedWorkflowPromise(options.driver.definitionMismatch());
          void observeMismatch(stopping);
        } catch (error) {
          rejectInfrastructure(error);
        }
      }
      return never();
    }

    async function observeMismatch(stopping: Promise<unknown>): Promise<void> {
      try {
        await stopping;
      } catch (error) {
        rejectInfrastructure(error);
      }
    }

    function project<T>(operation: () => Promise<T>): Promise<T> {
      if (appStepInFlight || mismatched) return mismatch();
      appStepInFlight = true;
      return createWorkflowPromise<T>((resolve, reject) => {
        // Preserve the prior facade boundary: the driver starts in a later
        // Promise job, after the application has received its step Promise.
        const start = createWorkflowPromise<void>((ready) => ready(undefined));
        void runProject(start, operation, resolve, reject);
      });
    }

    async function runProject<T>(
      start: Promise<void>,
      operation: () => Promise<T>,
      resolve: (value: T) => void,
      reject: (reason?: unknown) => void,
    ): Promise<void> {
      try {
        await start;
        if (mismatched) return;
        const adopted = await adoptTrustedWorkflowPromise(operation());
        const value = adopted.value;
        if (mismatched) return;
        resolve(value);
        appStepInFlight = false;
      } catch (error) {
        if (mismatched) return;
        const inputError = isWorkflowCallInputError(error)
          ? error.error
          : isWorkflowCallInputTypeError(error)
            ? error
            : undefined;
        if (inputError !== undefined) {
          // Only the private driver's checked input path may emit a TypeError.
          reject(inputError);
          appStepInFlight = false;
        } else if (
          isWorkflowStepError(error) &&
          (error.code === "step_failed" || error.code === "wait_timeout")
        ) {
          const projected = new SafeError(error.code);
          SafeObjectDefineProperty(
            projected,
            "name",
            dataDescriptor(error.code, false, false, false),
          );
          weakMapSet(provenance, projected, error);
          reject(projected);
          appStepInFlight = false;
        } else {
          // Do not give app catch/finally a controller-loss or park sentinel.
          // The host observes this rejection and stops the context; this
          // app-facing promise deliberately remains unsettled.
          rejectInfrastructure(error);
        }
      }
    }

    const step: WorkflowClassStep = {
      do(name, effect, retryPolicy) {
        return project(() =>
          options.driver.do(
            () => checked(() => inputIdentifier(name, "step name")),
            () =>
              checked(() => {
                if (typeof effect !== "function") {
                  throw new SafeTypeError("effect must be callable");
                }
                return doPending(
                  retryDelays(retryPolicy),
                  // The durable driver, not this projection, encodes the result
                  // once and commits it before returning the persisted clone.
                  () =>
                    SafeReflectApply(effect, undefined, []) as
                      | JsonObject
                      | undefined
                      | Promise<JsonObject | undefined>,
                );
              }),
          ),
        );
      },
      sleep(name, seconds) {
        return project(() =>
          options.driver.sleep(
            () => checked(() => inputIdentifier(name, "step name")),
            () => checked(() => integer(seconds, 0, 31_536_000, "seconds")),
          ),
        );
      },
      waitForEvent(name, value) {
        return project(() =>
          options.driver.waitForEvent(
            () => checked(() => inputIdentifier(name, "step name")),
            () =>
              checked(() => {
                const record = closedOptions(value, ["type", "timeoutSeconds"]);
                return waitPending(
                  inputIdentifier(record.type, "event type"),
                  integer(record.timeoutSeconds, 1, 31_536_000, "timeoutSeconds"),
                );
              }),
          ),
        );
      },
    };

    async function runApplication(): Promise<void> {
      try {
        const exported = SafeReflectGet(options.namespace, options.className);
        if (typeof exported !== "function") {
          throw new SafeTypeError("workflow export is not constructible");
        }
        const instance = SafeReflectConstruct(exported, [options.env]) as object;
        const run: unknown = SafeReflectGet(instance, "run");
        if (typeof run !== "function") throw new SafeTypeError("workflow run is not callable");
        // Application Promises and thenables intentionally retain ordinary
        // ECMAScript await semantics. Only private driver/transport Promises
        // use adoptTrustedWorkflowPromise.
        const output: unknown = await SafeReflectApply(run, instance, [event, step]);
        if (appStepInFlight || mismatched) {
          mismatch();
          return;
        }
        resolveExecution(
          output === undefined
            ? completeOutcome()
            : completeOutcome(parseDocument(encodeDocument(output))),
        );
      } catch (error) {
        if (appStepInFlight || mismatched) {
          mismatch();
          return;
        }
        const original =
          typeof error === "object" && error !== null ? weakMapGet(provenance, error) : undefined;
        resolveExecution(
          original?.code === "step_failed" ? stepFailedOutcome(original) : runThrewOutcome(),
        );
      }
    }

    void runApplication();
  });
}

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    // App object inspection can itself throw; neither diagnostics nor an
    // arbitrary app-thrown object becomes a private protocol error.
    throw new WorkflowCallInputError(new SafeTypeError("invalid workflow step arguments"));
  }
}

function closedOptions(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = plainInputRecord(value, "step options");
  const actual = SafeObjectKeys(record);
  for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
    const key = actual[actualIndex];
    if (key === undefined) throw new SafeTypeError("unknown workflow step option");
    let known = false;
    for (let knownIndex = 0; knownIndex < keys.length; knownIndex += 1) {
      if (keys[knownIndex] === key) {
        known = true;
        break;
      }
    }
    if (!known) throw new SafeTypeError("unknown workflow step option");
  }
  return record;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== "number" ||
    !SafeNumberIsInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SafeTypeError(`invalid ${label}`);
  }
  return value;
}

function retryDelays(value: unknown): readonly number[] {
  if (value === undefined) return [];
  const record = closedOptions(value, [
    "maxAttempts",
    "initialDelaySeconds",
    "backoff",
    "maxDelaySeconds",
  ]);
  const attempts = integer(record.maxAttempts, 1, 100, "maxAttempts");
  const initial = SafeObjectHasOwn(record, "initialDelaySeconds")
    ? integer(record.initialDelaySeconds, 0, 43_200, "initialDelaySeconds")
    : 0;
  const maximum = SafeObjectHasOwn(record, "maxDelaySeconds")
    ? integer(record.maxDelaySeconds, 0, 43_200, "maxDelaySeconds")
    : 43_200;
  const backoff = SafeObjectHasOwn(record, "backoff") ? record.backoff : "constant";
  if (backoff !== "constant" && backoff !== "exponential") {
    throw new SafeTypeError("invalid backoff");
  }
  const delays: number[] = [];
  let delay = SafeMathMin(initial, maximum);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    arrayPush(delays, delay);
    // The running delay is capped before multiplication; it never grows with
    // the number of attempts or overflows before applying the ceiling.
    if (backoff === "exponential") delay = SafeMathMin(maximum, delay * 2);
  }
  return delays;
}
