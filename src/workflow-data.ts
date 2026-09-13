import type { JsonObject, Row } from "./ports.ts";

/** Internal data boundary shared by instance storage and durable execution. */

/** Largest data-only document accepted by params and event payloads. */
export const WORKFLOW_MAX_DOCUMENT_BYTES = 1_048_576;

/** Maximum number of top-level object properties in a data-only document. */
export const WORKFLOW_MAX_TOP_PROPERTIES = 1_024;

export function normalizeScope(value: unknown): {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
} {
  const record = plainInputRecord(value, "workflow scope");
  const keys = Object.keys(record).sort();
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
  if (typeof value !== "string" || !isUnicodeScalarString(value)) {
    throw new WorkflowInputError(`${label} must be a Unicode string`);
  }
  const length = [...value].length;
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
    throw new Error(`the workflow ${label} generator returned an invalid id`);
  }
}

export function addDuration(timestamp: number, duration: number, label: string): number {
  const result = timestamp + duration;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`the workflow ${label} exceeds the safe timestamp range`);
  }
  return result;
}

export function parseDocument(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("workflow document is not valid JSON");
  }
  try {
    encodeDocument(parsed);
  } catch {
    throw new Error("workflow document is not data-only JSON");
  }
  if (!isPlainObjectValue(parsed)) throw new Error("workflow document is not an object");
  return parsed as JsonObject;
}

export function rowValue(row: Row, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor && descriptor.get === undefined
    ? descriptor.value
    : undefined;
}

export function nullableString(row: Row, key: string): string | null {
  const value = rowValue(row, key);
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`workflow row ${key} is invalid`);
  return value;
}

export function plainInputRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowInputError(`${label} must be a plain object`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowInputError(`${label} must be a plain object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new WorkflowInputError(`${label} has a symbol property`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new WorkflowInputError(`${label} contains an accessor or hidden property`);
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch (error) {
    if (error instanceof WorkflowInputError) throw error;
    throw new WorkflowInputError(`${label} could not be inspected`);
  }
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

type DocumentValidationKind = "invalid" | "too_large";

export class DocumentValidationError extends Error {
  constructor(readonly kind: DocumentValidationKind) {
    super(kind);
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
  const encoder = new TextEncoder();
  const append: DocumentChunkAppender = (chunk) => {
    if (chunk.length === 0) return;
    const remaining = WORKFLOW_MAX_DOCUMENT_BYTES - encodedBytes;
    // UTF-16 code-unit length is a safe lower bound for a JSON string chunk;
    // this avoids allocating a huge scalar before the byte guard can reject it.
    if (chunk.length > remaining) throw new DocumentValidationError("too_large");
    const bytes = encoder.encode(chunk).byteLength;
    if (bytes > remaining) throw new DocumentValidationError("too_large");
    encodedBytes += bytes;
    chunks.push(chunk);
  };
  try {
    encodeNode(value, new Set<object>(), append);
  } catch (error) {
    if (error instanceof DocumentValidationError) throw error;
    throw new DocumentValidationError("invalid");
  }
  return chunks.join("");
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
    const task = stack.pop();
    if (task === undefined) continue;
    if (task.kind === "leave") {
      seen.delete(task.value);
      continue;
    }
    if (task.kind === "array") {
      if (task.index >= task.length) {
        append("]");
        continue;
      }
      if (task.index > 0) append(",");
      const descriptor = Object.getOwnPropertyDescriptor(task.value, String(task.index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new DocumentValidationError("invalid");
      }
      stack.push({
        kind: "array",
        value: task.value,
        index: task.index + 1,
        length: task.length,
      });
      stack.push({ kind: "value", value: descriptor.value });
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
      const descriptor = Object.getOwnPropertyDescriptor(task.value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new DocumentValidationError("invalid");
      }
      appendJsonString(key, append);
      append(":");
      stack.push({
        kind: "object",
        value: task.value,
        keys: task.keys,
        index: task.index + 1,
      });
      stack.push({ kind: "value", value: descriptor.value });
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
        if (!Number.isFinite(current)) throw new DocumentValidationError("invalid");
        const encoded = JSON.stringify(current);
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
    if (seen.has(current)) throw new DocumentValidationError("invalid");
    seen.add(current);
    if (Array.isArray(current)) {
      if (!isPlainDataArray(current)) throw new DocumentValidationError("invalid");
      append("[");
      stack.push({ kind: "leave", value: current });
      stack.push({ kind: "array", value: current, index: 0, length: arrayLength(current) });
      continue;
    }
    if (!isPlainDataObject(current)) throw new DocumentValidationError("invalid");
    append("{");
    stack.push({ kind: "leave", value: current });
    stack.push({
      kind: "object",
      value: current,
      keys: ownDataKeys(current).sort(),
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
    const code = value.charCodeAt(index);
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
        if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
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
      append(value.slice(literalStart, index));
    }
    escapedRun += escaped;
    if (escapedRun.length >= 4_096) {
      append(escapedRun);
      escapedRun = "";
    }
    literalStart = index + 1;
  }
  if (escapedRun.length > 0) append(escapedRun);
  if (literalStart < value.length) append(value.slice(literalStart));
  append('"');
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObjectValue(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
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
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length = arrayLength(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) return false;
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= length) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function arrayLength(value: readonly unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new DocumentValidationError("invalid");
  }
  return length as number;
}

function ownDataKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") throw new DocumentValidationError("invalid");
    result.push(key);
  }
  return result;
}

export function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return false;
    const trailing = value.charCodeAt(index + 1);
    if (!Number.isInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) return false;
    index += 1;
  }
  return true;
}

export class WorkflowInputError extends TypeError {}
