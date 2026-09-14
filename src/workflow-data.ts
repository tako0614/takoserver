import type { JsonObject, Row } from "./ports.ts";

/** Internal data boundary shared by instance storage and durable execution. */

/*
 * This module is also loaded into a tenant Worker as part of the private class
 * helper. Capture every mutable intrinsic it uses before tenant evaluation;
 * application code may replace globals and prototype methods afterwards.
 */
const SafeArrayIsArray = Array.isArray;
const SafeArrayJoin = Array.prototype.join;
const SafeArrayPop = Array.prototype.pop;
const SafeArrayPrototype = Array.prototype;
const SafeArraySort = Array.prototype.sort;
const SafeError = Error;
const SafeJSONParse = JSON.parse;
const SafeJSONStringify = JSON.stringify;
const SafeNumber = Number;
const SafeNumberIsFinite = Number.isFinite;
const SafeNumberIsInteger = Number.isInteger;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeNumberToString = Number.prototype.toString;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectKeys = Object.keys;
const SafeObjectPrototype = Object.prototype;
const SafeReflectApply = Reflect.apply;
const SafeReflectOwnKeys = Reflect.ownKeys;
const SafeSet = Set;
const SafeSetAdd = Set.prototype.add;
const SafeSetDelete = Set.prototype.delete;
const SafeSetHas = Set.prototype.has;
const SafeString = String;
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeStringPadStart = String.prototype.padStart;
const SafeStringSlice = String.prototype.slice;
const SafeTextEncoder = TextEncoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeTypeError = TypeError;
const SafeWeakSet = WeakSet;
const SafeWeakSetAdd = WeakSet.prototype.add;
const SafeWeakSetHas = WeakSet.prototype.has;

function captureGetter(prototype: object, name: string): (this: unknown) => unknown {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = SafeObjectGetOwnPropertyDescriptor(current, name);
    if (
      descriptor !== undefined &&
      SafeObjectHasOwn(descriptor, "get") &&
      typeof descriptor.get === "function"
    ) {
      return descriptor.get;
    }
    current = SafeObjectGetPrototypeOf(current) as object | null;
  }
  throw new SafeTypeError("workflow intrinsic getter is unavailable");
}

const SafeTypedArrayByteLengthGet = captureGetter(Uint8Array.prototype, "byteLength");
const documentValidationErrors = new SafeWeakSet<object>();
const workflowInputErrors = new SafeWeakSet<object>();

function arrayPush<T>(values: T[], value: T): void {
  // Define rather than assign/push: an application may install a numeric
  // setter on Array.prototype after this module has loaded.
  SafeObjectDefineProperty(
    values,
    SafeString(values.length),
    dataDescriptor(value, true, true, true),
  );
}

function arraySort(values: string[]): string[] {
  SafeReflectApply(SafeArraySort, values, []);
  return values;
}

function setAdd(values: Set<object>, value: object): void {
  SafeReflectApply(SafeSetAdd, values, [value]);
}

function setDelete(values: Set<object>, value: object): void {
  SafeReflectApply(SafeSetDelete, values, [value]);
}

function setHas(values: Set<object>, value: object): boolean {
  return SafeReflectApply(SafeSetHas, values, [value]);
}

function weakSetAdd(values: WeakSet<object>, value: object): void {
  SafeReflectApply(SafeWeakSetAdd, values, [value]);
}

function weakSetHas(values: WeakSet<object>, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return SafeReflectApply(SafeWeakSetHas, values, [value]);
}

function defineEnumerableOwn(target: object, key: string, value: unknown): void {
  SafeObjectDefineProperty(target, key, dataDescriptor(value, true, true, true));
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

/** Largest data-only document accepted by params and event payloads. */
export const WORKFLOW_MAX_DOCUMENT_BYTES = 1_048_576;

/** Maximum number of top-level object properties in a data-only document. */
export const WORKFLOW_MAX_TOP_PROPERTIES = 1_024;

export function normalizeScope(value: unknown): {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
} {
  const record = plainInputRecord(value, "workflow scope");
  const keys = arraySort(SafeObjectKeys(record));
  if (keys.length !== 2 || keys[0] !== "tenantId" || keys[1] !== "workflowResourceUid") {
    throw new WorkflowInputError("workflow scope must contain tenantId and workflowResourceUid");
  }
  return {
    tenantId: scopeIdentifier(record.tenantId, "tenant id"),
    workflowResourceUid: scopeIdentifier(record.workflowResourceUid, "workflow resource uid"),
  };
}

function scopeIdentifier(value: unknown, label: string): string {
  return inputIdentifier(value, label, 4_096);
}

export function inputIdentifier(value: unknown, label: string, maxCharacters = 256): string {
  if (typeof value !== "string") {
    throw new WorkflowInputError(`${label} must be a Unicode string`);
  }
  const length = unicodeScalarLength(value);
  if (length < 0) throw new WorkflowInputError(`${label} must be a Unicode string`);
  if (length < 1 || length > maxCharacters) {
    throw new WorkflowInputError(`${label} must contain 1-${maxCharacters} Unicode characters`);
  }
  return value;
}

export function generatedIdentifier(value: unknown, label: string): string {
  try {
    return inputIdentifier(value, label, 256);
  } catch {
    // A malformed injected id is a host/storage failure, not caller input.
    throw new SafeError(`the workflow ${label} generator returned an invalid id`);
  }
}

export function addDuration(timestamp: number, duration: number, label: string): number {
  const result = timestamp + duration;
  if (!SafeNumberIsSafeInteger(result)) {
    throw new SafeError(`the workflow ${label} exceeds the safe timestamp range`);
  }
  return result;
}

export function parseDocument(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = SafeJSONParse(value);
  } catch {
    throw new SafeError("workflow document is not valid JSON");
  }
  try {
    encodeDocument(parsed);
  } catch {
    throw new SafeError("workflow document is not data-only JSON");
  }
  if (!isPlainObjectValue(parsed)) throw new SafeError("workflow document is not an object");
  // Promise resolution consults an inherited `then`. A fresh null-prototype
  // root keeps decoded durable data inert even if tenant code poisons
  // Object.prototype, while nested values retain the exact JSON data shape.
  return plainInputRecord(parsed, "workflow document") as JsonObject;
}

export function rowValue(row: Row, key: string): unknown {
  const descriptor = SafeObjectGetOwnPropertyDescriptor(row, key);
  return descriptor !== undefined && SafeObjectHasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function nullableString(row: Row, key: string): string | null {
  const value = rowValue(row, key);
  if (value === null) return null;
  if (typeof value !== "string") throw new SafeError(`workflow row ${key} is invalid`);
  return value;
}

export function plainInputRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || SafeArrayIsArray(value)) {
    throw new WorkflowInputError(`${label} must be a plain object`);
  }
  try {
    const prototype = SafeObjectGetPrototypeOf(value);
    if (prototype !== SafeObjectPrototype && prototype !== null) {
      throw new WorkflowInputError(`${label} must be a plain object`);
    }
    const descriptors = SafeObjectGetOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = SafeObjectCreate(null) as Record<string, unknown>;
    const ownKeys = SafeReflectOwnKeys(value);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key !== "string") {
        throw new WorkflowInputError(`${label} has a symbol property`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !SafeObjectHasOwn(descriptor, "value")
      ) {
        throw new WorkflowInputError(`${label} contains an accessor or hidden property`);
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch (error) {
    if (weakSetHas(workflowInputErrors, error)) throw error;
    throw new WorkflowInputError(`${label} could not be inspected`);
  }
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || SafeArrayIsArray(value)) return false;
  try {
    const prototype = SafeObjectGetPrototypeOf(value);
    return prototype === SafeObjectPrototype || prototype === null;
  } catch {
    return false;
  }
}

type DocumentValidationKind = "invalid" | "too_large";

export class DocumentValidationError extends SafeError {
  declare readonly kind: DocumentValidationKind;

  constructor(kind: DocumentValidationKind) {
    super(kind);
    defineEnumerableOwn(this, "kind", kind);
    weakSetAdd(documentValidationErrors, this);
  }
}

/**
 * Encodes data without ever calling a user `toJSON` method or reading a user
 * getter.  An explicit stack keeps nesting independent from the JavaScript
 * call stack, while chunks are counted against the UTF-8 bound before they are
 * retained.  The final join therefore never needs to build an over-limit
 * document.
 */
export function encodeDocument(value: unknown): string {
  if (!isPlainDataObject(value)) throw new DocumentValidationError("invalid");
  const keys = ownDataKeys(value);
  if (keys.length > WORKFLOW_MAX_TOP_PROPERTIES) {
    throw new DocumentValidationError("invalid");
  }
  const chunks: string[] = [];
  let encodedBytes = 0;
  const encoder = new SafeTextEncoder();
  const append: DocumentChunkAppender = (chunk) => {
    if (chunk.length === 0) return;
    const remaining = WORKFLOW_MAX_DOCUMENT_BYTES - encodedBytes;
    // UTF-16 code-unit length is a safe lower bound for a JSON string chunk;
    // this avoids allocating a huge scalar before the byte guard can reject it.
    if (chunk.length > remaining) throw new DocumentValidationError("too_large");
    const encoded = SafeReflectApply(SafeTextEncoderEncode, encoder, [chunk]);
    const bytes = SafeReflectApply(SafeTypedArrayByteLengthGet, encoded, []) as number;
    if (bytes > remaining) throw new DocumentValidationError("too_large");
    encodedBytes += bytes;
    arrayPush(chunks, chunk);
  };
  try {
    encodeNode(value, new SafeSet<object>(), append);
  } catch (error) {
    if (weakSetHas(documentValidationErrors, error)) throw error;
    throw new DocumentValidationError("invalid");
  }
  return SafeReflectApply(SafeArrayJoin, chunks, [""]) as string;
}

type DocumentChunkAppender = (chunk: string) => void;

type DocumentEncodingTask =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "array";
      readonly value: readonly unknown[];
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly kind: "object";
      readonly value: Record<string, unknown>;
      readonly keys: readonly string[];
      readonly index: number;
    }
  | { readonly kind: "leave"; readonly value: object };

function encodeNode(value: unknown, seen: Set<object>, append: DocumentChunkAppender): void {
  const stack: DocumentEncodingTask[] = [{ kind: "value", value }];
  while (stack.length > 0) {
    const task = SafeReflectApply(SafeArrayPop, stack, []) as DocumentEncodingTask | undefined;
    if (task === undefined) continue;
    if (task.kind === "leave") {
      setDelete(seen, task.value);
      continue;
    }
    if (task.kind === "array") {
      if (task.index >= task.length) {
        append("]");
        continue;
      }
      if (task.index > 0) append(",");
      const descriptor = SafeObjectGetOwnPropertyDescriptor(task.value, SafeString(task.index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !SafeObjectHasOwn(descriptor, "value")
      ) {
        throw new DocumentValidationError("invalid");
      }
      arrayPush(stack, {
        kind: "array",
        value: task.value,
        index: task.index + 1,
        length: task.length,
      });
      arrayPush(stack, { kind: "value", value: descriptor.value });
      continue;
    }
    if (task.kind === "object") {
      if (task.index >= task.keys.length) {
        append("}");
        continue;
      }
      if (task.index > 0) append(",");
      const key = task.keys[task.index];
      if (key === undefined) throw new DocumentValidationError("invalid");
      const descriptor = SafeObjectGetOwnPropertyDescriptor(task.value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !SafeObjectHasOwn(descriptor, "value")
      ) {
        throw new DocumentValidationError("invalid");
      }
      appendJsonString(key, append);
      append(":");
      arrayPush(stack, {
        kind: "object",
        value: task.value,
        keys: task.keys,
        index: task.index + 1,
      });
      arrayPush(stack, { kind: "value", value: descriptor.value });
      continue;
    }

    const current = task.value;
    if (current === null) {
      append("null");
      continue;
    }
    switch (typeof current) {
      case "string":
        appendJsonString(current, append);
        continue;
      case "boolean":
        append(current ? "true" : "false");
        continue;
      case "number": {
        if (!SafeNumberIsFinite(current)) throw new DocumentValidationError("invalid");
        const encoded = SafeJSONStringify(current);
        if (encoded === undefined) throw new DocumentValidationError("invalid");
        append(encoded);
        continue;
      }
      case "object":
        break;
      default:
        // In particular, undefined, bigint, symbol and functions are refused;
        // JSON.stringify's silent omission/coercion is not a data contract.
        throw new DocumentValidationError("invalid");
    }
    if (typeof current !== "object") throw new DocumentValidationError("invalid");
    if (setHas(seen, current)) throw new DocumentValidationError("invalid");
    setAdd(seen, current);
    if (SafeArrayIsArray(current)) {
      if (!isPlainDataArray(current)) throw new DocumentValidationError("invalid");
      append("[");
      arrayPush(stack, { kind: "leave", value: current });
      arrayPush(stack, { kind: "array", value: current, index: 0, length: arrayLength(current) });
      continue;
    }
    if (!isPlainDataObject(current)) throw new DocumentValidationError("invalid");
    append("{");
    arrayPush(stack, { kind: "leave", value: current });
    arrayPush(stack, {
      kind: "object",
      value: current,
      keys: arraySort(ownDataKeys(current)),
      index: 0,
    });
  }
}

function appendJsonString(value: string, append: DocumentChunkAppender): void {
  if (!isUnicodeScalarString(value)) throw new DocumentValidationError("invalid");
  append('"');
  let literalStart = 0;
  let escapedRun = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeReflectApply(SafeStringCharCodeAt, value, [index]) as number;
    let escaped: string | undefined;
    switch (code) {
      case 0x08:
        escaped = "\\b";
        break;
      case 0x09:
        escaped = "\\t";
        break;
      case 0x0a:
        escaped = "\\n";
        break;
      case 0x0c:
        escaped = "\\f";
        break;
      case 0x0d:
        escaped = "\\r";
        break;
      case 0x22:
        escaped = '\\"';
        break;
      case 0x5c:
        escaped = "\\\\";
        break;
      default:
        if (code < 0x20) {
          const hexadecimal = SafeReflectApply(SafeNumberToString, code, [16]) as string;
          escaped = `\\u${SafeReflectApply(SafeStringPadStart, hexadecimal, [4, "0"])}`;
        }
    }
    if (escaped === undefined) {
      if (escapedRun.length > 0) {
        append(escapedRun);
        escapedRun = "";
      }
      continue;
    }
    if (index > literalStart) {
      if (escapedRun.length > 0) {
        append(escapedRun);
        escapedRun = "";
      }
      append(SafeReflectApply(SafeStringSlice, value, [literalStart, index]) as string);
    }
    escapedRun += escaped;
    if (escapedRun.length >= 4_096) {
      append(escapedRun);
      escapedRun = "";
    }
    literalStart = index + 1;
  }
  if (escapedRun.length > 0) append(escapedRun);
  if (literalStart < value.length) {
    append(SafeReflectApply(SafeStringSlice, value, [literalStart]) as string);
  }
  append('"');
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObjectValue(value)) return false;
  try {
    const descriptors = SafeObjectGetOwnPropertyDescriptors(value);
    const ownKeys = SafeReflectOwnKeys(value);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !SafeObjectHasOwn(descriptor, "value")
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPlainDataArray(value: readonly unknown[]): value is readonly unknown[] {
  try {
    if (SafeObjectGetPrototypeOf(value) !== SafeArrayPrototype) return false;
    const length = arrayLength(value);
    const ownKeys = SafeReflectOwnKeys(value);
    if (ownKeys.length !== length + 1) return false;
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (key === "length") continue;
      if (typeof key !== "string" || !isDecimalIndexBelow(key, length)) return false;
      const descriptor = SafeObjectGetOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !SafeObjectHasOwn(descriptor, "value")
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function arrayLength(value: readonly unknown[]): number {
  const descriptor = SafeObjectGetOwnPropertyDescriptor(value, "length");
  const length =
    descriptor !== undefined && SafeObjectHasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  if (!SafeNumberIsSafeInteger(length) || (length as number) < 0) {
    throw new DocumentValidationError("invalid");
  }
  return length as number;
}

function ownDataKeys(value: object): string[] {
  const keys = SafeReflectOwnKeys(value);
  const result: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw new DocumentValidationError("invalid");
    arrayPush(result, key);
  }
  return result;
}

export function isUnicodeScalarString(value: string): boolean {
  return unicodeScalarLength(value) >= 0;
}

function unicodeScalarLength(value: string): number {
  let scalars = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeReflectApply(SafeStringCharCodeAt, value, [index]) as number;
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return -1;
    const trailing = SafeReflectApply(SafeStringCharCodeAt, value, [index + 1]) as number;
    if (!SafeNumberIsInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) return -1;
    index += 1;
    scalars -= 1;
  }
  return value.length + scalars;
}

function isDecimalIndexBelow(value: string, length: number): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeReflectApply(SafeStringCharCodeAt, value, [index]) as number;
    if (code < 0x30 || code > 0x39) return false;
  }
  return SafeNumber(value) < length;
}

export class WorkflowInputError extends SafeTypeError {
  constructor(message?: string) {
    super(message);
    weakSetAdd(workflowInputErrors, this);
  }
}
