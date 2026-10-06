import { canonicalJson } from "../../json.ts";
import type { JsonValue } from "../../ports.ts";

export const MODULE_WORKER_FORM_URL =
  "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/" as const;
export const WORKER_VERSION_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/" as const;
export const WORKER_DEPLOYMENT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/" as const;
export const WORKER_ENDPOINT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/" as const;

const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VAR_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const HANDLERS = new Set<string>(["fetch", "scheduled", "queue"]);
const BINDING_ARRAY_KEYS = [
  "kvBindings",
  "sqliteBindings",
  "bucketBindings",
  "queueProducerBindings",
  "serviceBindings",
  "actorBindings",
  "workflowBindings",
] as const;

export class WorkerFormValidationError extends Error {
  constructor(readonly code = "invalid_spec") {
    super(code);
    this.name = "WorkerFormValidationError";
  }
}

export type ModuleWorkerSpec = Record<string, never>;

export interface V2ResourceReference {
  readonly resourceUid: string;
}

export interface WorkerDeploymentVersion {
  readonly workerVersion: V2ResourceReference;
  readonly weight: number;
}

export interface WorkerDeploymentSpec {
  readonly worker: V2ResourceReference;
  readonly versions: readonly WorkerDeploymentVersion[];
}

export interface WorkerEndpointSpec {
  readonly worker: V2ResourceReference;
}

export type WorkerVersionHandler = "fetch" | "scheduled" | "queue";

export interface WorkerVersionBinding {
  readonly name: string;
  readonly resource: V2ResourceReference;
}

export interface WorkerVersionAssets {
  readonly bundle: V2ResourceReference;
  readonly runWorkerFirst: boolean;
  readonly notFoundHandling: "none" | "single_page_application";
}

export interface WorkerVersionSpec {
  readonly worker: V2ResourceReference;
  readonly bundle?: V2ResourceReference;
  readonly handlers: readonly WorkerVersionHandler[];
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly requiredSensitiveVars: readonly string[];
  readonly kvBindings: readonly WorkerVersionBinding[];
  readonly sqliteBindings: readonly WorkerVersionBinding[];
  readonly bucketBindings: readonly WorkerVersionBinding[];
  readonly queueProducerBindings: readonly WorkerVersionBinding[];
  readonly serviceBindings: readonly WorkerVersionBinding[];
  readonly actorBindings: readonly WorkerVersionBinding[];
  readonly workflowBindings: readonly WorkerVersionBinding[];
  readonly assets?: WorkerVersionAssets;
}

export function parseModuleWorkerSpec(input: unknown): ModuleWorkerSpec {
  const spec = record(input);
  exactKeys(spec, []);
  return {};
}

export function validateModuleWorkerUpdate(
  previousInput: unknown,
  nextInput: unknown,
): ModuleWorkerSpec {
  parseModuleWorkerSpec(previousInput);
  return parseModuleWorkerSpec(nextInput);
}

export function parseWorkerDeploymentSpec(input: unknown): WorkerDeploymentSpec {
  const spec = record(input);
  exactKeys(spec, ["worker", "versions"]);
  const worker = parseReference(spec.worker);
  const versionValues = arrayValues(spec.versions, 8);
  if (versionValues.length < 1) {
    throw invalid();
  }
  const versionUids = new Set<string>();
  let weightSum = 0;
  const versions = versionValues.map((value): WorkerDeploymentVersion => {
    const version = record(value);
    exactKeys(version, ["workerVersion", "weight"]);
    const workerVersion = parseReference(version.workerVersion);
    const weight = version.weight;
    if (
      !Number.isInteger(weight) ||
      (weight as number) < 1 ||
      (weight as number) > 10_000 ||
      versionUids.has(workerVersion.resourceUid)
    ) {
      throw invalid();
    }
    versionUids.add(workerVersion.resourceUid);
    weightSum += weight as number;
    return { workerVersion, weight: weight as number };
  });
  if (weightSum !== 10_000) throw invalid();
  versions.sort((left, right) =>
    compareStrings(left.workerVersion.resourceUid, right.workerVersion.resourceUid),
  );
  return { worker, versions };
}

export function validateWorkerDeploymentUpdate(
  previousInput: unknown,
  nextInput: unknown,
): WorkerDeploymentSpec {
  const previous = parseWorkerDeploymentSpec(previousInput);
  const next = parseWorkerDeploymentSpec(nextInput);
  if (previous.worker.resourceUid !== next.worker.resourceUid) throw invalid();
  return next;
}

export function parseWorkerEndpointSpec(input: unknown): WorkerEndpointSpec {
  const spec = record(input);
  exactKeys(spec, ["worker"]);
  return { worker: parseReference(spec.worker) };
}

export function validateWorkerEndpointUpdate(
  previousInput: unknown,
  nextInput: unknown,
): WorkerEndpointSpec {
  const previous = parseWorkerEndpointSpec(previousInput);
  const next = parseWorkerEndpointSpec(nextInput);
  if (previous.worker.resourceUid !== next.worker.resourceUid) throw invalid();
  return next;
}

export function parseWorkerVersionSpec(input: unknown): WorkerVersionSpec {
  const spec = record(input);
  exactKeys(
    spec,
    [
      "worker",
      "bundle",
      "handlers",
      "vars",
      "requiredSensitiveVars",
      ...BINDING_ARRAY_KEYS,
      "assets",
    ],
    ["bundle", "vars", "requiredSensitiveVars", ...BINDING_ARRAY_KEYS, "assets"],
  );
  const worker = parseReference(spec.worker);
  const bundle = Object.hasOwn(spec, "bundle") ? parseReference(spec.bundle) : undefined;
  const handlers = parseUniqueStringSet(spec.handlers, HANDLERS, 3) as WorkerVersionHandler[];
  const vars = parseVars(Object.hasOwn(spec, "vars") ? spec.vars : {});
  const requiredSensitiveVars = parseUniqueStringSet(
    Object.hasOwn(spec, "requiredSensitiveVars") ? spec.requiredSensitiveVars : [],
    SECRET_NAME,
    64,
  );
  const allNames = new Set<string>(Object.keys(vars));
  for (const name of requiredSensitiveVars) {
    if (allNames.has(name)) throw invalid();
    allNames.add(name);
  }
  const bindingArrays = {} as Record<(typeof BINDING_ARRAY_KEYS)[number], WorkerVersionBinding[]>;
  for (const key of BINDING_ARRAY_KEYS) {
    bindingArrays[key] = parseBindings(Object.hasOwn(spec, key) ? spec[key] : [], allNames);
  }
  const assets = Object.hasOwn(spec, "assets") ? parseAssets(spec.assets) : undefined;
  if (assets?.runWorkerFirst && !handlers.includes("fetch")) throw invalid();

  if (
    !bundle &&
    (!assets ||
      handlers.length !== 0 ||
      assets.runWorkerFirst ||
      Object.keys(vars).length !== 0 ||
      requiredSensitiveVars.length !== 0 ||
      BINDING_ARRAY_KEYS.some((key) => bindingArrays[key].length !== 0))
  ) {
    throw invalid();
  }

  const sortedBindings = {
    kvBindings: sortBindings(bindingArrays.kvBindings),
    sqliteBindings: sortBindings(bindingArrays.sqliteBindings),
    bucketBindings: sortBindings(bindingArrays.bucketBindings),
    queueProducerBindings: sortBindings(bindingArrays.queueProducerBindings),
    serviceBindings: sortBindings(bindingArrays.serviceBindings),
    actorBindings: sortBindings(bindingArrays.actorBindings),
    workflowBindings: sortBindings(bindingArrays.workflowBindings),
  };
  return {
    worker,
    ...(bundle ? { bundle } : {}),
    handlers: handlers.sort(compareStrings),
    vars,
    requiredSensitiveVars: requiredSensitiveVars.sort(compareStrings),
    ...sortedBindings,
    ...(assets ? { assets } : {}),
  };
}

export function validateWorkerVersionUpdate(
  previousInput: unknown,
  nextInput: unknown,
): WorkerVersionSpec {
  const previous = parseWorkerVersionSpec(previousInput);
  const next = parseWorkerVersionSpec(nextInput);
  if (canonicalJson(previous) !== canonicalJson(next)) throw invalid();
  return next;
}

function parseReference(value: unknown): V2ResourceReference {
  const reference = record(value);
  exactKeys(reference, ["resourceUid"]);
  if (typeof reference.resourceUid !== "string" || !RESOURCE_UID.test(reference.resourceUid)) {
    throw invalid();
  }
  return { resourceUid: reference.resourceUid };
}

function parseVars(value: unknown): Record<string, JsonValue> {
  const vars = record(value);
  const entries = ownDataEntries(vars);
  if (entries.length > 64) throw invalid();
  const normalized: Record<string, JsonValue> = {};
  for (const [key, entry] of entries.sort(([left], [right]) => compareStrings(left, right))) {
    if (!VAR_NAME.test(key)) throw invalid();
    normalized[key] = parseJsonValue(entry, 1);
  }
  return normalized;
}

function parseJsonValue(value: unknown, depth: number, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (!isUnicodeScalarStringWithin(value, 8_192)) throw invalid();
    return value;
  }
  if (depth > 8) throw invalid();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalid();
    ancestors.add(value);
    try {
      return arrayValues(value, 64).map((entry) => parseJsonValue(entry, depth + 1, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") throw invalid();
  if (ancestors.has(value)) throw invalid();
  ancestors.add(value);
  try {
    const entries = ownDataEntries(record(value));
    if (entries.length > 64) throw invalid();
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of entries.sort(([left], [right]) => compareStrings(left, right))) {
      if (!VAR_NAME.test(key)) throw invalid();
      result[key] = parseJsonValue(entry, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function parseUniqueStringSet(
  input: unknown,
  pattern: RegExp | ReadonlySet<string>,
  maxItems: number,
): string[] {
  const valuesArray = arrayValues(input, maxItems);
  const values = new Set<string>();
  for (const value of valuesArray) {
    if (
      typeof value !== "string" ||
      !(pattern instanceof RegExp ? pattern.test(value) : pattern.has(value)) ||
      values.has(value)
    ) {
      throw invalid();
    }
    values.add(value);
  }
  return [...values];
}

function parseBindings(value: unknown, allNames: Set<string>): WorkerVersionBinding[] {
  const entries = arrayValues(value, 64);
  const localNames = new Set<string>();
  return entries.map((entry): WorkerVersionBinding => {
    const binding = record(entry);
    exactKeys(binding, ["name", "resource"]);
    if (
      typeof binding.name !== "string" ||
      !BINDING_NAME.test(binding.name) ||
      localNames.has(binding.name) ||
      allNames.has(binding.name)
    ) {
      throw invalid();
    }
    localNames.add(binding.name);
    allNames.add(binding.name);
    return { name: binding.name, resource: parseReference(binding.resource) };
  });
}

function sortBindings(bindings: WorkerVersionBinding[]): WorkerVersionBinding[] {
  return bindings.sort((left, right) => compareStrings(left.name, right.name));
}

function parseAssets(value: unknown): WorkerVersionAssets {
  const assets = record(value);
  exactKeys(assets, ["bundle", "runWorkerFirst", "notFoundHandling"]);
  if (
    typeof assets.runWorkerFirst !== "boolean" ||
    (assets.notFoundHandling !== "none" && assets.notFoundHandling !== "single_page_application")
  ) {
    throw invalid();
  }
  return {
    bundle: parseReference(assets.bundle),
    runWorkerFirst: assets.runWorkerFirst,
    notFoundHandling: assets.notFoundHandling,
  };
}

function ownDataEntries(value: Record<string, unknown>): [string, unknown][] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw invalid();
  return (keys as string[]).map((key): [string, unknown] => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    return [key, descriptor.value];
  });
}

function arrayValues(value: unknown, maxItems: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxItems
  ) {
    throw invalid();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && !isArrayIndex(key, value.length))
  ) {
    throw invalid();
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    values.push(descriptor.value);
  }
  return values;
}

function isUnicodeScalarStringWithin(value: string, maxScalars: number): boolean {
  let scalarCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
    scalarCount += 1;
    if (scalarCount > maxScalars) return false;
  }
  return true;
}

function isArrayIndex(value: PropertyKey, length: number): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < length;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const actual = Object.keys(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !actual.includes(key) && !optionalKeys.includes(key))
  ) {
    throw invalid();
  }
  ownDataEntries(value);
}

function invalid(): WorkerFormValidationError {
  return new WorkerFormValidationError();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
