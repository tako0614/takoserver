import { adoptTrustedWorkflowPromise, WorkflowRuntimeError } from "./workflow-driver.ts";

/** The only two private bindings the outer worker may consume itself. */
export const WORKFLOW_LOADER_BINDING = "__TAKOSERVER_WORKFLOW_LOADER" as const;
export const WORKFLOW_COMPANION_BINDING = "__TAKOSERVER_WORKFLOW_COMPANION" as const;
/** The one capability projected into a dynamically loaded tenant child. */
export const WORKFLOW_HOST_BINDING = "__TAKOSERVER_WORKFLOW_HOST" as const;

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const apply = Reflect.apply;
const get = Reflect.get;
const hasOwn = Object.hasOwn;
const keys = Object.keys;
const create = Object.create;
const define = Object.defineProperty;
const nativeResponse = Response;
const nativeURL = URL;
const nativeTextEncoder = TextEncoder;
const nativeTextDecoder = TextDecoder;
const read = ReadableStreamDefaultReader.prototype.read;
const cancel = ReadableStreamDefaultReader.prototype.cancel;
const getReader = ReadableStream.prototype.getReader;
const responseBody = captureNativeGetter(Response.prototype, "body");
const responseStatus = captureNativeGetter(Response.prototype, "status");
const typedArrayByteLength = captureNativeGetter(Uint8Array.prototype, "byteLength");
const trusted = adoptTrustedWorkflowPromise;

export interface WorkflowLoaderModule {
  readonly js?: string;
  readonly cjs?: string;
  readonly text?: string;
  readonly data?: Uint8Array;
  readonly json?: string;
  readonly py?: string;
  readonly wasm?: Uint8Array;
}

export interface WorkflowLoaderWorkerCode {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly mainModule: string;
  readonly mainModuleRole: "hostPrivate";
  readonly modulePolicy: { readonly applicationMain: string };
  readonly modules: Readonly<Record<string, WorkflowLoaderModule>>;
  readonly hostPrivateModules: Readonly<Record<string, WorkflowLoaderModule>>;
  readonly env: Readonly<Record<string, unknown>>;
  readonly globalOutbound: null;
}

export interface WorkflowLoaderEntrypoint {
  run(request: null): Promise<unknown> | unknown;
}

export interface WorkflowLoaderWorker {
  getEntrypoint(): WorkflowLoaderEntrypoint;
}

export interface WorkflowLoaderBinding {
  load(code: WorkflowLoaderWorkerCode): WorkflowLoaderWorker | Promise<WorkflowLoaderWorker>;
}

export interface WorkflowLoaderOuterWorkerOptions {
  readonly token: string;
  /** Generated host-private main module used by WorkerLoader. */
  readonly mainModule: string;
  /** Exact application module selected by the Host's immutable Version. */
  readonly applicationMain: string;
  readonly modules: Readonly<Record<string, WorkflowLoaderModule>>;
  readonly hostPrivateModules: Readonly<Record<string, WorkflowLoaderModule>>;
  /** Names copied from the outer env into the dynamic child. */
  readonly childBindingNames: readonly string[];
}

export interface WorkflowLoaderOuterContext {
  readonly exports: Readonly<Record<string, unknown>>;
}

export interface WorkflowLoaderOuterWorker {
  fetch(
    request: Request,
    rawEnv: Readonly<Record<string, unknown>>,
    context: WorkflowLoaderOuterContext,
  ): Promise<Response>;
  /** Called by the ctx.exports.WorkflowHost() RPC stub in the child. */
  exchange(payload: string): Promise<string>;
}

/**
 * Trusted outer runner for one private Workflow execution.
 *
 * The outer runner owns HTTP admission, the one-shot latch, journal ordering,
 * companion transport and failure redaction. Tenant modules are supplied to
 * WorkerLoader as inert data and are not statically reachable from this
 * module's graph.
 */
export function createWorkflowLoaderOuterWorker(
  options: WorkflowLoaderOuterWorkerOptions,
): WorkflowLoaderOuterWorker {
  validateOptions(options);
  const modules = cloneModuleDictionary(options.modules);
  const hostPrivateModules = cloneModuleDictionary(options.hostPrivateModules);
  const childBindingNames = [...new Set(options.childBindingNames)];
  let started = false;
  let sequence = 0;
  let activeCompanion: unknown;

  function unavailable(): WorkflowRuntimeError {
    return new WorkflowRuntimeError("host_unavailable");
  }

  async function exchange(payload: string): Promise<string> {
    if (typeof payload !== "string" || utf8Size(payload) > MAX_FRAME_BYTES) {
      throw unavailable();
    }
    // Companion authority is scoped to the one live RUN epoch. A retained
    // WorkflowHost stub, or a direct named-entrypoint call before RUN, cannot
    // re-open the journal or post frames after that epoch is sealed.
    const companion = activeCompanion;
    if (!companion || (typeof companion !== "object" && typeof companion !== "function")) {
      throw unavailable();
    }
    const companionFetch = get(companion, "fetch");
    if (typeof companionFetch !== "function") throw unavailable();
    sequence += 1;
    if (!Number.isSafeInteger(sequence)) throw unavailable();

    // This call is intentionally synchronous and appears before constructing
    // or enqueueing the companion request. The transport journal relies on
    // that happens-before relationship for every frame.
    const logger = get(console, "error");
    if (typeof logger !== "function") throw unavailable();
    apply(logger, console, [`TAKOSERVER_WORKFLOW_JOURNAL:${options.token}:${sequence}`]);

    try {
      const init = create(null) as RequestInit;
      init.method = "POST";
      init.body = payload;
      const request = apply(companionFetch, companion, [
        `http://workflow-companion/${options.token}/${sequence}`,
        init,
      ]) as Response | Promise<Response>;
      const companionResponse = await resolveMaybe(request);
      return await readCompanionResponse(companionResponse);
    } catch {
      // Transport failures are typed infrastructure failures. The outer HTTP
      // path turns them into a redacted response; callers of this method see
      // the original retry/close signal rather than fabricated success.
      throw unavailable();
    }
  }

  async function run(
    rawEnv: Readonly<Record<string, unknown>>,
    context: WorkflowLoaderOuterContext,
  ) {
    const loader = get(rawEnv, WORKFLOW_LOADER_BINDING);
    if (!loader || (typeof loader !== "object" && typeof loader !== "function")) {
      throw unavailable();
    }
    const load = get(loader, "load");
    if (typeof load !== "function") throw unavailable();

    const workflowHostFactory = get(context?.exports, "WorkflowHost");
    if (typeof workflowHostFactory !== "function") throw unavailable();
    const workflowHost = await resolveMaybe(
      apply(workflowHostFactory, context.exports, [create(null)]) as object | Promise<object>,
    );
    if (!workflowHost || (typeof workflowHost !== "object" && typeof workflowHost !== "function")) {
      throw unavailable();
    }
    if (typeof get(workflowHost, "exchange") !== "function") throw unavailable();

    const childEnv: Record<string, unknown> = {};
    for (const name of childBindingNames) {
      if (hasOwn(rawEnv, name))
        define(childEnv, name, {
          value: get(rawEnv, name),
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    // The RPC stub is the sole Host authority visible to the child. Loader,
    // companion, journal and every other outer binding stay out of this map.
    define(childEnv, WORKFLOW_HOST_BINDING, { value: workflowHost, enumerable: true });

    const code: WorkflowLoaderWorkerCode = {
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["disallow_importable_env"],
      mainModule: options.mainModule,
      mainModuleRole: "hostPrivate",
      modulePolicy: { applicationMain: options.applicationMain },
      modules: cloneModuleDictionary(modules),
      hostPrivateModules: cloneModuleDictionary(hostPrivateModules),
      env: childEnv,
      globalOutbound: null,
    };
    const worker = await resolveMaybe(
      apply(load, loader, [code]) as WorkflowLoaderWorker | Promise<WorkflowLoaderWorker>,
    );
    if (!worker || (typeof worker !== "object" && typeof worker !== "function")) {
      throw unavailable();
    }
    const getEntrypoint = get(worker, "getEntrypoint");
    if (typeof getEntrypoint !== "function") throw unavailable();
    const entrypoint = await resolveMaybe(
      apply(getEntrypoint, worker, []) as
        | WorkflowLoaderEntrypoint
        | Promise<WorkflowLoaderEntrypoint>,
    );
    if (!entrypoint || (typeof entrypoint !== "object" && typeof entrypoint !== "function")) {
      throw unavailable();
    }
    const runMethod = get(entrypoint, "run");
    if (typeof runMethod !== "function") throw unavailable();
    const result = await resolveMaybe(
      apply(runMethod, entrypoint, [null]) as string | Promise<string>,
    );
    if (typeof result !== "string" || utf8Size(result) > MAX_FRAME_BYTES) throw unavailable();
    return result;
  }

  return {
    async fetch(request, rawEnv, context) {
      let path: string;
      try {
        path = new nativeURL(request.url).pathname;
      } catch {
        return response(null, 404);
      }
      if (request.method === "GET" && path === `/${options.token}/ready`) {
        // Readiness never touches the loader and remains available before RUN.
        return response("ready");
      }
      if (request.method !== "POST" || path !== `/${options.token}/run`) {
        return response(null, 404);
      }
      // Latch before the first await so repeated and concurrent RUN requests
      // cannot trigger another dynamic load or another tenant instance.
      if (started) return response(null, 409);
      started = true;
      activeCompanion = get(rawEnv, WORKFLOW_COMPANION_BINDING);
      try {
        const result = await run(rawEnv, context);
        return response(result);
      } catch {
        return response(null, 500);
      } finally {
        activeCompanion = undefined;
      }
    },
    exchange,
  };
}

function response(body: string | null, status = 200): Response {
  const init = create(null) as ResponseInit;
  init.status = status;
  const result = new nativeResponse(body, init);
  const descriptor = create(null) as PropertyDescriptor;
  descriptor.value = undefined;
  descriptor.enumerable = false;
  descriptor.writable = false;
  descriptor.configurable = false;
  define(result, "then", descriptor);
  return result;
}

async function readCompanionResponse(message: Response): Promise<string> {
  if (!responseStatus || apply(responseStatus, message, []) !== 200 || !responseBody) {
    throw new Error("workflow companion response unavailable");
  }
  const body = apply(responseBody, message, []) as ReadableStream<Uint8Array> | null;
  if (!body) throw new Error("workflow companion response body unavailable");
  const reader = apply(getReader, body, []) as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new nativeTextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const part = (
        await trusted(apply(read, reader, []) as Promise<ReadableStreamReadResult<Uint8Array>>)
      ).value;
      if (part.done) break;
      if (!typedArrayByteLength) throw new Error("workflow companion response is invalid");
      size += apply(typedArrayByteLength, part.value, []) as number;
      if (size > MAX_FRAME_BYTES) throw new Error("workflow companion response is too large");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await trusted(apply(cancel, reader, []) as Promise<void>);
  }
}

function utf8Size(value: string): number {
  return new nativeTextEncoder().encode(value).byteLength;
}

async function resolveMaybe<T>(value: T | Promise<T>): Promise<T> {
  // Native RPC returns RpcPromise, not a genuine JS Promise. This trusted
  // outer isolate never evaluates tenant code, so use normal thenable adoption
  // rather than applying Promise.prototype.then to an incompatible receiver.
  return await value;
}

function captureNativeGetter(prototype: object, name: string): (() => unknown) | undefined {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor?.get) return descriptor.get;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function validateOptions(options: WorkflowLoaderOuterWorkerOptions): void {
  if (
    !options ||
    typeof options.token !== "string" ||
    options.token.length === 0 ||
    typeof options.mainModule !== "string" ||
    options.mainModule.length === 0 ||
    typeof options.applicationMain !== "string" ||
    options.applicationMain.length === 0 ||
    !options.modules ||
    !options.hostPrivateModules ||
    !Array.isArray(options.childBindingNames)
  ) {
    throw new TypeError("invalid workflow loader outer options");
  }
  const names = new Set<string>();
  for (const name of options.childBindingNames) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      names.has(name) ||
      name === WORKFLOW_LOADER_BINDING ||
      name === WORKFLOW_COMPANION_BINDING ||
      name === WORKFLOW_HOST_BINDING
    ) {
      throw new TypeError("workflow loader child binding collision");
    }
    names.add(name);
  }
  if (hasOwn(options.modules, options.applicationMain) === false) {
    throw new TypeError("workflow loader application main is undeclared");
  }
  if (hasOwn(options.hostPrivateModules, options.mainModule) === false) {
    throw new TypeError("workflow loader host main is undeclared");
  }
}

function cloneModuleDictionary(
  source: Readonly<Record<string, WorkflowLoaderModule>>,
): Readonly<Record<string, WorkflowLoaderModule>> {
  const target = create(null) as Record<string, WorkflowLoaderModule>;
  for (const name of keys(source)) {
    if (name.length === 0 || name.includes("\u0000")) {
      throw new TypeError("invalid workflow loader module name");
    }
    const module = source[name];
    if (!module || typeof module !== "object" || Array.isArray(module)) {
      throw new TypeError("invalid workflow loader module");
    }
    const copy = create(null) as Record<string, unknown>;
    const allowedKeys = ["js", "cjs", "text", "data", "json", "py", "wasm"] as const;
    for (const key of keys(module)) {
      if (!(allowedKeys as readonly string[]).includes(key)) {
        throw new TypeError("invalid workflow loader module media");
      }
    }
    for (const key of allowedKeys) {
      if (!hasOwn(module, key)) continue;
      const value = module[key];
      if ((key === "data" || key === "wasm") && value instanceof Uint8Array) {
        copy[key] = new Uint8Array(value);
      } else if (key !== "data" && key !== "wasm" && typeof value === "string") {
        copy[key] = value;
      } else {
        throw new TypeError("invalid workflow loader module media");
      }
    }
    if (keys(copy).length !== 1) throw new TypeError("invalid workflow loader module media");
    target[name] = copy as WorkflowLoaderModule;
  }
  return target;
}
