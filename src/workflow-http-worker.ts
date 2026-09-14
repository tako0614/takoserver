import type { JsonObject } from "./ports.ts";
import { executeWorkflowClass } from "./workflow-class-execution.ts";
import { encodeDocument, parseDocument, plainInputRecord } from "./workflow-data.ts";
import {
  adoptTrustedWorkflowPromise,
  isWorkflowCallInputError,
  WorkflowCallInputError,
  type WorkflowDriver,
  WorkflowRuntimeError,
  WorkflowStepError,
} from "./workflow-driver.ts";

// This module is bundled into the host-private bootstrap, evaluated BEFORE
// the dynamic application import. None of these capabilities are app env.
const apply = Reflect.apply;
const get = Reflect.get;
const keys = Object.keys;
const hasOwn = Object.hasOwn;
const create = Object.create;
const define = Object.defineProperty;
const jsonParse = JSON.parse;
const quote = JSON.stringify;
const isArray = Array.isArray;
const isInteger = Number.isSafeInteger;
const NativeResponse = Response;
const NativeURL = URL;
const responseStatus = captureNativeGetter(Response.prototype, "status");
const responseBody = captureNativeGetter(Response.prototype, "body");
const getReader = ReadableStream.prototype.getReader;
const read = ReadableStreamDefaultReader.prototype.read;
const cancel = ReadableStreamDefaultReader.prototype.cancel;
const NativeTextDecoder = TextDecoder;
const decode = TextDecoder.prototype.decode;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const NativeTypeError = TypeError;
const NativeWeakMap = WeakMap;
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const NativeMap = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const logReceiver = console;
const log = console.error;

const trusted = adoptTrustedWorkflowPromise;

/** Called only during trusted bootstrap, before any application evaluation. */
function captureNativeGetter(prototype: object, name: string): (() => unknown) | undefined {
  // workerd exposes Body's accessors on an inherited native prototype, unlike
  // runtimes that flatten its mixin onto Response.prototype. Capture the
  // original getter now; never fall back to tenant-mutable property lookup.
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor.get;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function response(body: string | null, status = 200): Response {
  const init = create(null) as ResponseInit;
  init.status = status;
  const result = new NativeResponse(body, init);
  // This fresh native object is private transport, never a data document.
  // Prevent async return assimilation through a poisoned Object.prototype.
  const descriptor = create(null) as PropertyDescriptor;
  descriptor.value = undefined;
  descriptor.enumerable = false;
  descriptor.writable = false;
  descriptor.configurable = false;
  define(result, "then", descriptor);
  return result;
}

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

async function readCommand(response: Response): Promise<Record<string, unknown>> {
  if (!responseBody) throw unavailable();
  const body = apply(responseBody, response, []) as ReadableStream<Uint8Array> | null;
  if (!body) throw unavailable();
  const reader = apply(getReader, body, []) as ReadableStreamDefaultReader<Uint8Array>;
  const decoderOptions = create(null) as TextDecoderOptions;
  decoderOptions.fatal = true;
  const decoder = new NativeTextDecoder("utf-8", decoderOptions);
  const streamOptions = create(null) as TextDecodeOptions;
  streamOptions.stream = true;
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const part = (
        await trusted(apply(read, reader, []) as Promise<ReadableStreamReadResult<Uint8Array>>)
      ).value;
      if (part.done) break;
      if (!typedArrayByteLength) throw unavailable();
      size += apply(typedArrayByteLength, part.value, []) as number;
      if (size > 2 * 1024 * 1024) throw unavailable();
      text += apply(decode, decoder, [part.value, streamOptions]);
    }
    text += apply(decode, decoder, []);
    return commandFrom(text);
  } finally {
    await trusted(apply(cancel, reader, []) as Promise<void>);
  }
}

function unavailable(): WorkflowRuntimeError {
  return new WorkflowRuntimeError("host_unavailable");
}

function valueEnvelope(value: JsonObject | undefined): string {
  return value === undefined
    ? '"present":false'
    : `"present":true,"value":${encodeDocument(value)}`;
}

/** Host-private bootstrap inputs, never serialized as application bindings. */
export interface WorkflowHttpWorkerOptions {
  readonly token: string;
  readonly className: string;
  readonly instanceId: string;
  readonly params?: JsonObject;
  /** Dynamic closed-graph import; the generated env wrapper must load first. */
  readonly load: () => Promise<{
    readonly namespace: Readonly<Record<string, unknown>>;
    readonly projectEnv: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  }>;
}

/**
 * Concrete private HTTP callee for the dormant Workflow candidate. Export only
 * its default fetch object from a host-private entry, with importable env
 * disabled. The companion service is a private controller capability, not a
 * public fetch handler or a user-supplied endpoint.
 */
export function createWorkflowHttpWorker(options: WorkflowHttpWorkerOptions): {
  fetch(request: Request, rawEnv: Readonly<Record<string, unknown>>): Promise<Response>;
} {
  const { token, className, instanceId, load } = options;
  // workerd lazily loads its native console formatter on the first call.
  // Initialize that backing module before tenant startup as well as capturing
  // the entry function. This ordinary empty line is discarded by the guard.
  apply(log, logReceiver, [""]);
  const params =
    options.params === undefined ? undefined : parseDocument(encodeDocument(options.params));
  let started = false;
  let sequence = 0;
  let callCounter = 0;
  const originals = new NativeMap<string, WorkflowStepError>();
  const originTokens = new NativeWeakMap<object, string>();
  let companion: unknown;
  let companionFetch: unknown;

  async function exchange(payload: string): Promise<Record<string, unknown>> {
    sequence += 1;
    if (!isInteger(sequence)) throw unavailable();
    // Marker emission MUST remain synchronous and precede the network enqueue.
    apply(log, logReceiver, [`TAKOSERVER_WORKFLOW_JOURNAL:${token}:${sequence}`]);
    try {
      const init = create(null) as RequestInit;
      init.method = "POST";
      init.body = payload;
      const request = apply(companionFetch as (...args: never[]) => unknown, companion, [
        `http://workflow-companion/${token}/${sequence}`,
        init,
      ]) as Promise<Response>;
      const response = (await trusted(request)).value;
      if (!responseStatus || apply(responseStatus, response, []) !== 200) throw unavailable();
      return (await trusted(readCommand(response))).value;
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
    fetch(request, rawEnv) {
      return (async () => {
        // All request inspection precedes tenant import. Subsequent requests
        // cannot run a second class or expose raw bindings.
        if (started) return response(null, 409);
        const path = new NativeURL(request.url).pathname;
        if (request.method === "GET" && path === `/${token}/ready`) {
          return response("ready");
        }
        if (request.method !== "POST" || path !== `/${token}/run`) {
          return response(null, 404);
        }
        started = true;
        companion = rawEnv.__TAKOSERVER_WORKFLOW_COMPANION;
        if (!companion || typeof companion !== "object") throw unavailable();
        companionFetch = get(companion, "fetch");
        if (typeof companionFetch !== "function") throw unavailable();
        // Never move this import to module scope or the controller process.
        const loaded = (await trusted(load())).value;
        const env = loaded.projectEnv(rawEnv);
        const outcome = (
          await trusted(
            executeWorkflowClass({
              namespace: loaded.namespace,
              className,
              env,
              instanceId,
              ...(params === undefined ? {} : { params }),
              driver,
            }),
          )
        ).value;
        let payload: string;
        if (outcome.kind === "complete") {
          payload = `{"kind":"complete",${valueEnvelope(outcome.output)}}`;
        } else if (outcome.reason === "step_failed") {
          const origin = apply(weakGet, originTokens, [outcome.error]) as string | undefined;
          if (origin === undefined) throw unavailable();
          payload = `{"kind":"failed","reason":"step_failed","token":${quote(origin)}}`;
        } else payload = '{"kind":"failed","reason":"run_threw"}';
        return response(payload);
      })();
    },
  };
}
