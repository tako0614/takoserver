import type { JsonObject } from "./ports.ts";
import {
  encodeDocument,
  inputIdentifier,
  parseDocument,
  plainInputRecord,
} from "./workflow-data.ts";
import {
  type WorkflowApplicationOutcome,
  WorkflowCallInputError,
  type WorkflowDriver,
  WorkflowStepError,
} from "./workflow-execution.ts";

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
export async function executeWorkflowClass(
  options: WorkflowClassExecution,
): Promise<WorkflowApplicationOutcome> {
  // Copy host input before any application code. Invalid host input is an
  // infrastructure rejection, not an application run_threw outcome.
  const event =
    options.params === undefined
      ? { instanceId: options.instanceId }
      : { instanceId: options.instanceId, params: parseDocument(encodeDocument(options.params)) };
  const provenance = new WeakMap<object, WorkflowStepError>();
  let appStepInFlight = false;
  let mismatched = false;
  let rejectInfrastructure!: (error: unknown) => void;
  const infrastructure = new Promise<never>((_resolve, reject) => {
    rejectInfrastructure = reject;
  });
  // Observe failure even if a malformed host calls a driver synchronously
  // before the application promise has been installed in the race below.
  void infrastructure.catch(() => undefined);

  function mismatch(): Promise<never> {
    if (!mismatched) {
      mismatched = true;
      try {
        void options.driver.definitionMismatch().catch(rejectInfrastructure);
      } catch (error) {
        rejectInfrastructure(error);
      }
    }
    return new Promise<never>(() => undefined);
  }

  function project<T>(operation: () => Promise<T>): Promise<T> {
    if (appStepInFlight || mismatched) return mismatch();
    appStepInFlight = true;
    return new Promise<T>((resolve, reject) => {
      void Promise.resolve()
        .then(() => {
          if (mismatched) return new Promise<T>(() => undefined);
          return operation();
        })
        .then(
          (value) => {
            if (mismatched) return;
            resolve(value);
            appStepInFlight = false;
          },
          (error: unknown) => {
            if (mismatched) return;
            if (error instanceof TypeError) {
              // Only the private driver's checked input path may emit a TypeError.
              reject(error);
              appStepInFlight = false;
            } else if (
              error instanceof WorkflowStepError &&
              (error.code === "step_failed" || error.code === "wait_timeout")
            ) {
              const projected = new Error(error.code);
              Object.defineProperty(projected, "name", {
                value: error.code,
                enumerable: false,
                writable: false,
                configurable: false,
              });
              provenance.set(projected, error);
              reject(projected);
              appStepInFlight = false;
            } else {
              // Do not give app catch/finally a controller-loss or park sentinel.
              // The host observes this rejection and stops the context; this
              // app-facing promise deliberately remains unsettled.
              rejectInfrastructure(error);
            }
          },
        );
    });
  }

  const step: WorkflowClassStep = {
    do(name, effect, retryPolicy) {
      return project(() =>
        options.driver.do(
          () => checked(() => inputIdentifier(name, "step name")),
          () =>
            checked(() => {
              if (typeof effect !== "function") throw new TypeError("effect must be callable");
              return {
                retryDelaysSeconds: retryDelays(retryPolicy),
                // The durable driver, not this projection, encodes the result
                // once and commits it before returning the persisted clone.
                effect: () =>
                  Reflect.apply(effect, undefined, []) as
                    | JsonObject
                    | undefined
                    | Promise<JsonObject | undefined>,
              };
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
              return {
                type: inputIdentifier(record.type, "event type"),
                timeoutSeconds: integer(record.timeoutSeconds, 1, 31_536_000, "timeoutSeconds"),
              };
            }),
        ),
      );
    },
  };

  const application = (async (): Promise<WorkflowApplicationOutcome> => {
    try {
      const exported = options.namespace[options.className];
      if (typeof exported !== "function")
        throw new TypeError("workflow export is not constructible");
      const instance: object = Reflect.construct(exported, [options.env]);
      const run: unknown = Reflect.get(instance, "run");
      if (typeof run !== "function") throw new TypeError("workflow run is not callable");
      const output: unknown = await Reflect.apply(run, instance, [event, step]);
      if (appStepInFlight || mismatched) return mismatch();
      return output === undefined
        ? { kind: "complete" }
        : { kind: "complete", output: parseDocument(encodeDocument(output)) };
    } catch (error) {
      if (appStepInFlight || mismatched) return mismatch();
      const original =
        typeof error === "object" && error !== null ? provenance.get(error) : undefined;
      return original?.code === "step_failed"
        ? { kind: "failed", reason: "step_failed", error: original }
        : { kind: "failed", reason: "run_threw" };
    }
  })();
  return Promise.race([application, infrastructure]);
}

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    // App object inspection can itself throw; neither diagnostics nor an
    // arbitrary app-thrown object becomes a private protocol error.
    throw new WorkflowCallInputError(new TypeError("invalid workflow step arguments"));
  }
}

function closedOptions(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = plainInputRecord(value, "step options");
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new TypeError("unknown workflow step option");
  }
  return record;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid ${label}`);
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
  const initial = Object.hasOwn(record, "initialDelaySeconds")
    ? integer(record.initialDelaySeconds, 0, 43_200, "initialDelaySeconds")
    : 0;
  const maximum = Object.hasOwn(record, "maxDelaySeconds")
    ? integer(record.maxDelaySeconds, 0, 43_200, "maxDelaySeconds")
    : 43_200;
  const backoff = Object.hasOwn(record, "backoff") ? record.backoff : "constant";
  if (backoff !== "constant" && backoff !== "exponential") throw new TypeError("invalid backoff");
  const delays: number[] = [];
  let delay = Math.min(initial, maximum);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    delays.push(delay);
    // The running delay is capped before multiplication; it never grows with
    // the number of attempts or overflows before applying the ceiling.
    if (backoff === "exponential") delay = Math.min(maximum, delay * 2);
  }
  return delays;
}
