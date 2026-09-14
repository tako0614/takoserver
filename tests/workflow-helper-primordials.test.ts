import { expect, test } from "bun:test";

test("Workflow class helper retains its captured primordials after tenant poisoning", async () => {
  const classHelper = new URL("../src/workflow-class-execution.ts", import.meta.url).href;
  const dataHelper = new URL("../src/workflow-data.ts", import.meta.url).href;
  const driverHelper = new URL("../src/workflow-driver.ts", import.meta.url).href;
  const script = `
const { executeWorkflowClass } = await import(${JSON.stringify(classHelper)});
const { encodeDocument, parseDocument } = await import(${JSON.stringify(dataHelper)});
const {
  WorkflowStepError,
  createWorkflowPromise,
  isWorkflowCallInputError,
} = await import(${JSON.stringify(driverHelper)});

const OriginalArray = Array;
const OriginalError = Error;
const OriginalMap = Map;
const OriginalObject = Object;
const OriginalPromise = Promise;
const OriginalSet = Set;
const OriginalSymbol = Symbol;
const OriginalTypeError = TypeError;
const OriginalWeakMap = WeakMap;
const OriginalWeakSet = WeakSet;
const create = Object.create;
const defineProperty = Object.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const stdout = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);

function descriptor(value, enumerable = false, writable = true, configurable = true) {
  const result = create(null);
  result.value = value;
  result.enumerable = enumerable;
  result.writable = writable;
  result.configurable = configurable;
  return result;
}

function poison() {
  throw new OriginalError("poisoned primordial was called");
}

function check(condition, message) {
  if (!condition) throw new OriginalError(message);
}

defineProperty(WorkflowStepError, OriginalSymbol.hasInstance, descriptor(poison));
defineProperty(OriginalTypeError, OriginalSymbol.hasInstance, descriptor(poison));
defineProperty(OriginalPromise.prototype, "constructor", descriptor(poison));
defineProperty(OriginalPromise.prototype, "then", descriptor(poison));
defineProperty(OriginalPromise.prototype, "catch", descriptor(poison));
defineProperty(OriginalPromise.prototype, "finally", descriptor(poison));
defineProperty(OriginalPromise, OriginalSymbol.species, descriptor(poison));
defineProperty(OriginalArray.prototype, "push", descriptor(poison));
defineProperty(OriginalArray.prototype, "pop", descriptor(poison));
defineProperty(OriginalArray.prototype, "sort", descriptor(poison));
defineProperty(OriginalArray.prototype, "join", descriptor(poison));
defineProperty(OriginalArray.prototype, "some", descriptor(poison));
defineProperty(OriginalArray.prototype, "includes", descriptor(poison));
defineProperty(OriginalArray.prototype, OriginalSymbol.iterator, descriptor(poison));
defineProperty(OriginalSet.prototype, "add", descriptor(poison));
defineProperty(OriginalSet.prototype, "has", descriptor(poison));
defineProperty(OriginalSet.prototype, "delete", descriptor(poison));
defineProperty(OriginalMap.prototype, "get", descriptor(poison));
defineProperty(OriginalMap.prototype, "set", descriptor(poison));
defineProperty(OriginalMap.prototype, "has", descriptor(poison));
defineProperty(OriginalWeakMap.prototype, "get", descriptor(poison));
defineProperty(OriginalWeakMap.prototype, "set", descriptor(poison));
defineProperty(OriginalWeakSet.prototype, "add", descriptor(poison));
defineProperty(OriginalWeakSet.prototype, "has", descriptor(poison));
defineProperty(String.prototype, "charCodeAt", descriptor(poison));
defineProperty(String.prototype, "slice", descriptor(poison));
defineProperty(String.prototype, "padStart", descriptor(poison));
defineProperty(Number.prototype, "toString", descriptor(poison));
defineProperty(TextEncoder.prototype, "encode", descriptor(poison));
defineProperty(OriginalObject.prototype, "then", descriptor(poison));
defineProperty(OriginalObject.prototype, "get", descriptor(poison));
defineProperty(OriginalObject.prototype, "set", descriptor(poison));
defineProperty(OriginalObject.prototype, "value", descriptor(poison));
defineProperty(OriginalObject.prototype, "writable", descriptor(poison));
defineProperty(OriginalObject.prototype, "enumerable", descriptor(poison));
defineProperty(OriginalObject.prototype, "configurable", descriptor(poison));

Object.keys = poison;
Object.create = poison;
Object.defineProperty = poison;
Object.getOwnPropertyDescriptor = poison;
Object.getOwnPropertyDescriptors = poison;
Object.getPrototypeOf = poison;
Object.hasOwn = poison;
Array.isArray = poison;
Reflect.apply = poison;
Reflect.construct = poison;
Reflect.get = poison;
Reflect.ownKeys = poison;
JSON.parse = poison;
JSON.stringify = poison;
Number.isFinite = poison;
Number.isInteger = poison;
Number.isSafeInteger = poison;
Math.min = poison;

globalThis.Array = poison;
globalThis.Error = poison;
globalThis.JSON = descriptor(poison);
globalThis.Map = poison;
globalThis.Math = descriptor(poison);
globalThis.Number = poison;
globalThis.Object = poison;
globalThis.Promise = poison;
globalThis.Reflect = descriptor(poison);
globalThis.Set = poison;
globalThis.String = poison;
globalThis.Symbol = poison;
globalThis.TextEncoder = poison;
globalThis.TypeError = poison;
globalThis.WeakMap = poison;
globalThis.WeakSet = poison;

let invalidEffectCalls = 0;
let inputCaughtMessage;
const driver = {
  do(prepareName, preparePending) {
    return createWorkflowPromise((resolve, reject) => {
      try {
        const name = prepareName();
        const pending = preparePending();
        if (name === "invalid") invalidEffectCalls += 1;
        if (name === "failed") {
          reject(new WorkflowStepError("step_failed"));
          return;
        }
        const delays = pending.retryDelaysSeconds;
        check(delays.length === 3, "retry length");
        check(delays[0] === 2 && delays[1] === 3 && delays[2] === 3, "retry values");
        const value = pending.effect();
        resolve(value === undefined ? undefined : parseDocument(encodeDocument(value)));
      } catch (error) {
        reject(isWorkflowCallInputError(error) ? error.error : error);
      }
    });
  },
  sleep() {
    return createWorkflowPromise((resolve) => resolve(undefined));
  },
  waitForEvent() {
    return createWorkflowPromise((resolve) => resolve(undefined));
  },
  definitionMismatch() {
    return createWorkflowPromise(() => undefined);
  },
};

class Workflow {
  constructor(env) {
    this.env = env;
  }

  run(event, step) {
    check(this.env.TOKEN === "selected", "constructor env");
    check(event.instanceId === "instance", "event id");
    check(event.params.nested.value === "input", "event params");
    if (this.env.MODE === "success") {
      return step.do(
        "success",
        () => ({ nested: { value: "output" }, list: [3, 1], special: "\\u0001😀" }),
        {
          maxAttempts: 4,
          initialDelaySeconds: 2,
          backoff: "exponential",
          maxDelaySeconds: 3,
        },
      );
    }
    if (this.env.MODE === "input") {
      return step.do("", () => {
        invalidEffectCalls += 1;
      }).catch((error) => {
        inputCaughtMessage = error.message;
      });
    }
    return step.do("failed", () => ({}), { maxAttempts: 1 }).catch((error) => {
      const name = getOwnPropertyDescriptor(error, "name");
      check(name !== undefined && name.value === "step_failed", "projected name");
      check(name.writable === false && name.enumerable === false, "projected descriptor");
      throw error;
    });
  }
}

function execute(mode) {
  return executeWorkflowClass({
    namespace: { Workflow },
    className: "Workflow",
    env: { MODE: mode, TOKEN: "selected" },
    instanceId: "instance",
    params: { nested: { value: "input" }, list: [2, 1] },
    driver,
  });
}

execute("success").then(
  (success) => {
    check(success.kind === "complete", "success outcome");
    check(success.output.nested.value === "output", "success clone");
    execute("input").then(
      (input) => {
        check(input.kind === "complete", "input outcome");
        check(inputCaughtMessage === "invalid workflow step arguments", "input TypeError");
        check(invalidEffectCalls === 0, "invalid effect stayed lazy");
        execute("failure").then(
          (failure) => {
            check(failure.kind === "failed" && failure.reason === "step_failed", "provenance");
            stdout("workflow-helper-primordials:ok\\n");
            exit(0);
          },
          (error) => {
            stdout("workflow-helper-primordials:failure rejection " + error.message + "\\n");
            exit(1);
          },
        );
      },
      (error) => {
        stdout("workflow-helper-primordials:input rejection " + error.message + "\\n");
        exit(1);
      },
    );
  },
  (error) => {
    stdout("workflow-helper-primordials:success rejection " + error.message + "\\n");
    exit(1);
  },
);
`;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "workflow-helper-primordials:ok\n",
    stderr: "",
  });
});
