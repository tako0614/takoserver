import type { JsonObject } from "./ports.ts";
import { executeWorkflowClass } from "./workflow-class-execution.ts";
import { encodeDocument, parseDocument, plainInputRecord } from "./workflow-data.ts";
import {
  adoptTrustedWorkflowPromise,
  createWorkflowPromise,
  isWorkflowCallInputError,
  WorkflowCallInputError,
  type WorkflowDriver,
  WorkflowRuntimeError,
  WorkflowStepError,
} from "./workflow-driver.ts";

// This module is bundled into the dynamic tenant bootstrap. It is evaluated
// before the tenant application module, but all Host authority remains behind
// the one-method WorkflowHost RPC passed by the outer worker.
const apply = Reflect.apply;
const get = Reflect.get;
const keys = Object.keys;
const hasOwn = Object.hasOwn;
const jsonParse = JSON.parse;
const quote = JSON.stringify;
const isArray = Array.isArray;
const isInteger = Number.isSafeInteger;
const NativeTypeError = TypeError;
const NativeWeakMap = WeakMap;
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const NativeMap = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;

const trusted = adoptTrustedWorkflowPromise;

function closed(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw unavailable();
  const record = plainInputRecord(value, "private Workflow command");
  const names = keys(record);
  for (let i = 0; i < names.length; i += 1) {
    let found = false;
    for (let j = 0; j < allowed.length; j += 1) if (names[i] === allowed[j]) found = true;
    if (!found) throw unavailable();
  }
  return record;
}

function commandFrom(text: string): Record<string, unknown> {
  const value = closed(jsonParse(text), ["kind", "present", "value", "code", "token"]);
  const expected =
    value.kind === "settled"
      ? value.present === true
        ? ["kind", "present", "value"]
        : ["kind", "present"]
      : value.kind === "step_error"
        ? ["kind", "code", "token"]
        : ["kind"];
  if (keys(value).length !== expected.length) throw unavailable();
  for (let i = 0; i < expected.length; i += 1)
    if (!hasOwn(value, expected[i] as string)) throw unavailable();
  return value;
}

function unavailable(): WorkflowRuntimeError {
  return new WorkflowRuntimeError("host_unavailable");
}

function valueEnvelope(value: JsonObject | undefined): string {
  return value === undefined
    ? '"present":false'
    : `"present":true,"value":${encodeDocument(value)}`;
}

/** Dynamic tenant bootstrap inputs, never serialized as outer bindings. */
export interface WorkflowLoaderTenantWorkerOptions {
  readonly className: string;
  readonly instanceId: string;
  readonly params?: JsonObject;
  /** Complete relative module specifier for the Host-generated env wrapper. */
  readonly wrapperModule: string;
  /** Complete relative module specifier for the tenant application module. */
  readonly applicationModule: string;
}

/**
 * Runs one dynamically loaded tenant class. HTTP routing and the companion
 * socket belong to the outer worker; this child sees only a one-method RPC.
 */
export function createWorkflowLoaderTenantWorker(options: WorkflowLoaderTenantWorkerOptions): {
  run(rawEnv: Readonly<Record<string, unknown>>): Promise<string>;
} {
  const { className, instanceId, wrapperModule, applicationModule } = options;
  const params =
    options.params === undefined ? undefined : parseDocument(encodeDocument(options.params));
  let callCounter = 0;
  const originals = new NativeMap<string, WorkflowStepError>();
  const originTokens = new NativeWeakMap<object, string>();
  let hostExchange: ((payload: string) => Promise<string>) | undefined;
  let started = false;

  async function exchange(payload: string): Promise<Record<string, unknown>> {
    if (!hostExchange || typeof payload !== "string") throw unavailable();
    const reply = await trusted(hostExchange(payload));
    if (typeof reply.value !== "string") throw unavailable();
    try {
      return commandFrom(reply.value);
    } catch {
      throw unavailable();
    }
  }

  function result(command: Record<string, unknown>): JsonObject | undefined {
    if (command.kind === "input_error") {
      throw new WorkflowCallInputError(new NativeTypeError("invalid workflow step arguments"))
        .error;
    }
    if (command.kind === "step_error") {
      if (
        (command.code !== "step_failed" && command.code !== "wait_timeout") ||
        typeof command.token !== "string" ||
        command.token.length > 128 ||
        command.token.length === 0
      )
        throw unavailable();
      let original = apply(mapGet, originals, [command.token]) as WorkflowStepError | undefined;
      if (!original) {
        original = new WorkflowStepError(command.code);
        apply(mapSet, originals, [command.token, original]);
        apply(weakSet, originTokens, [original, command.token]);
      } else if (original.code !== command.code) throw unavailable();
      throw original;
    }
    if (command.kind !== "settled") throw unavailable();
    if (command.present === false && !hasOwn(command, "value")) return undefined;
    if (command.present === true && hasOwn(command, "value")) {
      return parseDocument(encodeDocument(command.value));
    }
    throw unavailable();
  }

  async function operation(
    kind: "do" | "sleep" | "wait",
    prepareName: Parameters<WorkflowDriver["do"]>[0],
    preparePending:
      | Parameters<WorkflowDriver["do"]>[1]
      | Parameters<WorkflowDriver["sleep"]>[1]
      | Parameters<WorkflowDriver["waitForEvent"]>[1],
  ): Promise<JsonObject | undefined> {
    callCounter += 1;
    const call = callCounter;
    if (!isInteger(call)) throw unavailable();
    let command = (
      await trusted(exchange(`{"kind":"call","call":${call},"operation":${quote(kind)}}`))
    ).value;
    if (command.kind !== "need_name") throw unavailable();
    let name: string;
    try {
      name = await prepareName();
    } catch (error) {
      if (!isWorkflowCallInputError(error)) throw unavailable();
      return result((await trusted(exchange(`{"kind":"input_error","call":${call}}`))).value);
    }
    command = (await trusted(exchange(`{"kind":"name","call":${call},"name":${quote(name)}}`)))
      .value;
    if (command.kind !== "need_pending") return result(command);
    let pending: Awaited<ReturnType<typeof preparePending>>;
    try {
      pending = await preparePending();
    } catch (error) {
      if (!isWorkflowCallInputError(error)) throw unavailable();
      return result((await trusted(exchange(`{"kind":"input_error","call":${call}}`))).value);
    }
    let effect: (() => JsonObject | undefined | Promise<JsonObject | undefined>) | undefined;
    let fields: string;
    if (kind === "do") {
      const value = pending as Awaited<ReturnType<Parameters<WorkflowDriver["do"]>[1]>>;
      effect = value.effect;
      let delays = "";
      for (let i = 0; i < value.retryDelaysSeconds.length; i += 1) {
        delays += `${i === 0 ? "" : ","}${value.retryDelaysSeconds[i]}`;
      }
      fields = `"retryDelaysSeconds":[${delays}]`;
    } else if (kind === "sleep") {
      fields = `"seconds":${pending as number}`;
    } else {
      const value = pending as { readonly type: string; readonly timeoutSeconds: number };
      fields = `"type":${quote(value.type)},"timeoutSeconds":${value.timeoutSeconds}`;
    }
    command = (await trusted(exchange(`{"kind":"pending","call":${call},${fields}}`))).value;
    if (command.kind === "invoke_effect") {
      if (!effect) throw unavailable();
      let payload: string;
      try {
        // Application failures, including invalid/oversize data, consume an
        // attempt. Transport failures occur outside this application catch.
        const value = await effect();
        payload = `{"kind":"effect","call":${call},${valueEnvelope(value)}}`;
      } catch {
        payload = `{"kind":"effect_failed","call":${call}}`;
      }
      command = (await trusted(exchange(payload))).value;
    }
    return result(command);
  }

  const driver: WorkflowDriver = {
    do: (name, pending) => operation("do", name, pending),
    async sleep(name, pending) {
      await trusted(operation("sleep", name, pending));
    },
    waitForEvent: (name, pending) => operation("wait", name, pending),
    definitionMismatch() {
      return (async (): Promise<never> => {
        await trusted(exchange('{"kind":"mismatch"}'));
        throw unavailable();
      })();
    },
  };

  return {
    async run(rawEnv) {
      if (started) throw unavailable();
      started = true;
      if (!rawEnv || (typeof rawEnv !== "object" && typeof rawEnv !== "function")) {
        throw unavailable();
      }
      const host = get(rawEnv, "__TAKOSERVER_WORKFLOW_HOST");
      if (!host || (typeof host !== "object" && typeof host !== "function")) {
        throw unavailable();
      }
      const exchangeMethod = get(host, "exchange");
      if (typeof exchangeMethod !== "function") throw unavailable();
      hostExchange = (payload) =>
        createWorkflowPromise<string>((resolve, reject) => {
          // The retained Host stub returns workerd's RpcPromise, not a genuine
          // JS Promise. Observe its native then without exposing it to tenant
          // code or passing it to the genuine-Promise-only adoption helper.
          const pending = apply(exchangeMethod, host, [payload]) as object;
          const then = get(pending, "then");
          if (typeof then !== "function") throw unavailable();
          apply(then, pending, [
            (value: unknown) => {
              if (typeof value === "string") resolve(value);
              else reject(unavailable());
            },
            reject,
          ]);
        });

      // The wrapper is loaded before the tenant namespace. Both imports happen
      // in this child only after the outer worker's one-shot RUN latch.
      const wrapper = (await trusted(import(wrapperModule))).value as Record<string, unknown>;
      const projectEnv = get(wrapper, "__takoserverSelfhostProjectEnv");
      if (typeof projectEnv !== "function") {
        throw new Error("workflow loader project environment export is invalid");
      }
      const namespace = (await trusted(import(applicationModule))).value;
      if (typeof namespace !== "object" || namespace === null || isArray(namespace)) {
        throw new Error("workflow loader application namespace is invalid");
      }
      const env = apply(projectEnv, wrapper, [rawEnv]) as Record<string, unknown>;
      const outcome = (
        await trusted(
          executeWorkflowClass({
            namespace: namespace as Readonly<Record<string, unknown>>,
            className,
            env,
            instanceId,
            ...(params === undefined ? {} : { params }),
            driver,
          }),
        )
      ).value;
      if (outcome.kind === "complete") {
        return `{"kind":"complete",${valueEnvelope(outcome.output)}}`;
      }
      if (outcome.reason === "step_failed") {
        const origin = apply(weakGet, originTokens, [outcome.error]) as string | undefined;
        if (origin === undefined) throw unavailable();
        return `{"kind":"failed","reason":"step_failed","token":${quote(origin)}}`;
      }
      return '{"kind":"failed","reason":"run_threw"}';
    },
  };
}
