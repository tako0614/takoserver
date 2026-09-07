/**
 * Provider-side worker.runtime@1.1.0 module-load inspection.
 *
 * Source syntax is not the contract here. A Host has to evaluate the exact
 * module graph, observe the default export's runtime value, and inspect its
 * own callable handler properties without invoking them. The generated
 * prelude performs that work inside the tenant isolate; this TypeScript module
 * never evaluates tenant JavaScript in control-plane authority.
 */

export const WORKER_MODULE_HANDLER_NAMES = ["fetch", "scheduled", "queue"] as const;

export type WorkerModuleHandlerName = (typeof WORKER_MODULE_HANDLER_NAMES)[number];

export const WORKER_MODULE_IMPORTABLE_MEDIA_TYPES = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
] as const;

export const WORKER_MODULE_AUXILIARY_MEDIA_TYPES = ["application/source-map+json"] as const;

export type WorkerModuleImportableMediaType = (typeof WORKER_MODULE_IMPORTABLE_MEDIA_TYPES)[number];
export type WorkerModuleAuxiliaryMediaType = (typeof WORKER_MODULE_AUXILIARY_MEDIA_TYPES)[number];
export type WorkerModuleMediaType =
  | WorkerModuleImportableMediaType
  | WorkerModuleAuxiliaryMediaType;

export interface WorkerModuleInspectionModule {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  /** Untrusted materialized metadata; the inspector admits the closed media set. */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface WorkerModuleInspectionInput {
  readonly mainModule: string;
  /** Importable modules and carried auxiliary source maps in one exact snapshot. */
  readonly modules: readonly WorkerModuleInspectionModule[];
  readonly declaredHandlers: readonly WorkerModuleHandlerName[];
}

export type WorkerModuleLoadError =
  | "module_not_found"
  | "unsupported_media_type"
  | "module_syntax_error"
  | "handler_not_exported";

/** Host-internal evaluation refusals are deliberately not public ABI errors. */
export type WorkerModuleInspectionError =
  | WorkerModuleLoadError
  | "module_evaluation_failed"
  | "module_evaluation_limit_exceeded";

export type WorkerModuleInspectionResult =
  | {
      readonly outcome: "valid";
      readonly exportedHandlers: readonly WorkerModuleHandlerName[];
    }
  | {
      readonly outcome: "invalid";
      readonly error: WorkerModuleInspectionError;
    }
  | {
      readonly outcome: "unavailable";
      readonly retryable: true;
    };

export interface WorkerModuleSemanticInspector {
  inspect(input: WorkerModuleInspectionInput): Promise<WorkerModuleInspectionResult>;
}

/**
 * Detach mutable artifact bytes before the first asynchronous runtime step.
 *
 * The returned byte views are private copies. Callers should pass the snapshot
 * onward rather than expose it again; JavaScript cannot freeze a non-empty
 * typed array, so ownership rather than a misleading `Object.freeze()` is the
 * immutability boundary for those views.
 */
export function snapshotWorkerModuleInspectionInput(
  input: WorkerModuleInspectionInput,
): WorkerModuleInspectionInput {
  if (!Array.isArray(input.modules) || input.modules.length > 1_024) {
    throw new TypeError("worker module inspection snapshot is too large");
  }
  let totalBytes = 0;
  const modules = input.modules.map((entry) => {
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new TypeError("worker module inspection bytes are invalid");
    }
    totalBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 10_485_760) {
      throw new TypeError("worker module inspection snapshot is too large");
    }
    return Object.freeze({
      name: entry.name,
      digest: entry.digest,
      mediaType: entry.mediaType,
      bytes: new Uint8Array(entry.bytes),
    });
  });
  return Object.freeze({
    mainModule: input.mainModule,
    modules: Object.freeze(modules),
    declaredHandlers: Object.freeze([...input.declaredHandlers]),
  });
}

export interface SemanticInspectionPreludeSourceInput {
  /** One-shot workerd only: an unguessable Host nonce used for a pre-tenant marker. */
  readonly startupReportNonce?: string;
}

/**
 * Build the Host prelude that MUST be imported before a tenant namespace.
 *
 * The generated module exports:
 *
 * - `inspectWorkerModuleNamespace(namespace, declaredHandlers)`; and
 * - `createWorkerModuleInspectionTestEntry(nonce, result)` for the one-shot
 *   workerd adapter only. It closes over the report nonce and immutable result.
 *
 * A valid isolate-local result additionally carries non-enumerable `target`
 * and `handlerFunctions` fields. Serving adapters use those captured callable
 * values instead of executing a getter twice. Only `exportedHandlers` crosses
 * the provider inspection boundary.
 */
export function semanticInspectionPreludeSource(
  input: SemanticInspectionPreludeSourceInput = {},
): string {
  const startupReportNonce = input.startupReportNonce;
  if (startupReportNonce !== undefined && !isReportNonce(startupReportNonce)) {
    throw new TypeError("worker module inspection report nonce is invalid");
  }
  const startupMarker =
    startupReportNonce === undefined
      ? ""
      : `SafeApply(SafeConsoleLog, SafeConsole, [${JSON.stringify(`${startupReportNonce}start`)}]);\n`;

  return `// Evaluated before the tenant module: do not reorder the wrapper imports.
const SafeApply = Reflect.apply;
const SafeReflect = Reflect;
const SafeReflectGet = Reflect.get;
const SafeArray = Array;
const SafeArrayIsArray = Array.isArray;
const SafeConsole = console;
const SafeConsoleLog = console.log;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectPrototype = Object.prototype;
const SafeObjectSetPrototypeOf = Object.setPrototypeOf;

const HandlerNames = SafeApply(SafeObjectFreeze, SafeObject, [["fetch", "scheduled", "queue"]]);
const InvalidHandlerResult = SafeApply(SafeObjectFreeze, SafeObject, [{
  outcome: "invalid",
  error: "handler_not_exported",
}]);
const InvalidEvaluationResult = SafeApply(SafeObjectFreeze, SafeObject, [{
  outcome: "invalid",
  error: "module_evaluation_failed",
}]);

${startupMarker}export function inspectWorkerModuleNamespace(namespace, declaredHandlers) {
  try {
    if (
      namespace === null ||
      (typeof namespace !== "object" && typeof namespace !== "function") ||
      !SafeApply(SafeObjectHasOwn, SafeObject, [namespace, "default"])
    ) {
      return InvalidHandlerResult;
    }
    const target = SafeApply(SafeReflectGet, SafeReflect, [namespace, "default", namespace]);
    if (
      target === null ||
      typeof target !== "object" ||
      SafeApply(SafeArrayIsArray, SafeArray, [target])
    ) {
      return InvalidHandlerResult;
    }
    const prototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [target]);
    if (prototype !== SafeObjectPrototype && prototype !== null) return InvalidHandlerResult;
    if (
      !SafeApply(SafeArrayIsArray, SafeArray, [declaredHandlers]) ||
      declaredHandlers.length > HandlerNames.length
    ) {
      return InvalidHandlerResult;
    }

    let declaredMask = 0;
    for (let index = 0; index < declaredHandlers.length; index += 1) {
      const bit = handlerBit(declaredHandlers[index]);
      if (bit === 0 || (declaredMask & bit) !== 0) return InvalidHandlerResult;
      declaredMask |= bit;
    }

    const exportedHandlers = SafeApply(SafeObjectSetPrototypeOf, SafeObject, [[], null]);
    const handlerFunctions = SafeApply(SafeObjectCreate, SafeObject, [null]);
    let exportedMask = 0;
    let exportedCount = 0;
    for (let index = 0; index < HandlerNames.length; index += 1) {
      const name = HandlerNames[index];
      const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [target, name]);
      if (descriptor === undefined) continue;
      const value = SafeApply(SafeReflectGet, SafeReflect, [target, name, target]);
      if (typeof value !== "function") continue;
      exportedHandlers[exportedCount] = name;
      exportedCount += 1;
      exportedMask |= 1 << index;
      handlerFunctions[name] = value;
    }
    if ((exportedMask & declaredMask) !== declaredMask) return InvalidHandlerResult;
    const finalPrototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [target]);
    if (finalPrototype !== SafeObjectPrototype && finalPrototype !== null) {
      return InvalidHandlerResult;
    }

    SafeApply(SafeObjectFreeze, SafeObject, [exportedHandlers]);
    SafeApply(SafeObjectFreeze, SafeObject, [handlerFunctions]);
    const result = SafeApply(SafeObjectCreate, SafeObject, [null]);
    result.outcome = "valid";
    result.exportedHandlers = exportedHandlers;
    SafeApply(SafeObjectDefineProperty, SafeObject, [result, "target", { value: target }]);
    SafeApply(SafeObjectDefineProperty, SafeObject, [result, "handlerFunctions", {
      value: handlerFunctions,
    }]);
    return SafeApply(SafeObjectFreeze, SafeObject, [result]);
  } catch {
    return InvalidEvaluationResult;
  }
}

export function createWorkerModuleInspectionTestEntry(nonce, result) {
  // A tenant can discover generated module names through a getter's stack and
  // dynamically import their namespaces. Neither a writable test property nor
  // an embedded nonce in Function#toString may cross that boundary.
  const entry = SafeApply(SafeObjectCreate, SafeObject, [SafeObjectPrototype]);
  SafeApply(SafeObjectDefineProperty, SafeObject, [entry, "test", {
    value() { emitWorkerModuleInspectionReport(nonce, result); },
    enumerable: true,
  }]);
  return SafeApply(SafeObjectFreeze, SafeObject, [entry]);
}

function emitWorkerModuleInspectionReport(nonce, result) {
  let report;
  if (result === null || typeof result !== "object") {
    report = "invalid:module_evaluation_failed";
  } else if (result.outcome === "invalid") {
    report = "invalid:" + result.error;
  } else if (result.outcome === "valid") {
    let mask = 0;
    const handlers = result.exportedHandlers;
    for (let index = 0; index < handlers.length; index += 1) mask |= handlerBit(handlers[index]);
    report = "valid:" + mask;
  } else {
    report = "invalid:module_evaluation_failed";
  }
  SafeApply(SafeConsoleLog, SafeConsole, [nonce + report]);
}

function handlerBit(name) {
  if (name === "fetch") return 1;
  if (name === "scheduled") return 2;
  if (name === "queue") return 4;
  return 0;
}
`;
}

export interface SemanticInspectionTestWrapperSourceInput {
  readonly preludeModuleSpecifier: string;
  readonly tenantModuleSpecifier: string;
  readonly declaredHandlers: readonly WorkerModuleHandlerName[];
  readonly reportNonce: string;
}

/** Generate the workerd test entrypoint; prelude import order is security-significant. */
export function semanticInspectionTestWrapperSource(
  input: SemanticInspectionTestWrapperSourceInput,
): string {
  if (
    !moduleSpecifier(input.preludeModuleSpecifier) ||
    !moduleSpecifier(input.tenantModuleSpecifier)
  ) {
    throw new TypeError("worker module inspection specifier is invalid");
  }
  if (!isReportNonce(input.reportNonce)) {
    throw new TypeError("worker module inspection report nonce is invalid");
  }
  const seen = new Set<WorkerModuleHandlerName>();
  for (const handler of input.declaredHandlers) {
    if (!WORKER_MODULE_HANDLER_NAMES.includes(handler) || seen.has(handler)) {
      throw new TypeError("worker module inspection declared handler is invalid");
    }
    seen.add(handler);
  }

  return `import {
  createWorkerModuleInspectionTestEntry,
  inspectWorkerModuleNamespace,
} from ${JSON.stringify(input.preludeModuleSpecifier)};
import * as workerModuleNamespace from ${JSON.stringify(input.tenantModuleSpecifier)};

const inspection = inspectWorkerModuleNamespace(
  workerModuleNamespace,
  ${JSON.stringify(input.declaredHandlers)},
);

export default createWorkerModuleInspectionTestEntry(${JSON.stringify(input.reportNonce)}, inspection);
`;
}

function isReportNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,160}:$/u.test(value);
}

function moduleSpecifier(value: string): boolean {
  return value.length > 0 && value.length <= 1_100 && !value.includes("\0");
}
