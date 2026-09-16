/**
 * Pure validation and canonicalisation for the internal VectorIndex boundary.
 *
 * This module deliberately does not own storage, visibility, ANN selection, or
 * serving.  It turns one closed JSON operation object into an immutable value
 * that a provider adapter can consume after the complete request has passed
 * validation.
 */

import { canonicalJson } from "./json.ts";

const MAX_DIMENSION = 1_536;
const MAX_ID_LENGTH = 128;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_BATCH = 100;
const MAX_TOP_K = 100;
const MAX_METADATA_BYTES = 8_192;
const MAX_METADATA_PROPERTIES = 64;
const MAX_METADATA_STRING_LENGTH = 8_192;
const MAX_FILTER_KEYS = 8;
const SIMPLE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

const EMPTY_METADATA: VectorIndexMetadata = Object.freeze({});

export type VectorIndexMetric = "cosine";

/** The canonical immutable configuration used by a provider adapter. */
export interface VectorIndexConfig {
  readonly dimension: number;
  readonly metric: VectorIndexMetric;
  /** Sorted, unique declared metadata filter keys. */
  readonly filterKeys: readonly string[];
}

/** Input shape accepted by {@link parseVectorIndexConfig}. */
export interface VectorIndexConfigInput {
  readonly dimension: number;
  readonly metric: VectorIndexMetric;
  readonly filterKeys?: readonly string[];
}

export type VectorIndexMetadataScalar = string | number | boolean | null;

/** Flat, canonical metadata object. */
export type VectorIndexMetadata = Readonly<Record<string, VectorIndexMetadataScalar>>;

export interface VectorIndexRecord {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: VectorIndexMetadata;
}

export interface VectorIndexUpsertInput {
  readonly namespace: string;
  readonly vectors: readonly VectorIndexRecord[];
}

export interface VectorIndexGetInput {
  readonly namespace: string;
  readonly ids: readonly string[];
}

export interface VectorIndexDeleteInput {
  readonly namespace: string;
  readonly ids: readonly string[];
}

export interface VectorIndexQueryInput {
  readonly namespace: string;
  readonly values: readonly number[];
  readonly topK: number;
  /** Empty when omitted; terms are exact, type-sensitive AND predicates. */
  readonly filter: VectorIndexMetadata;
  readonly returnMetadata: boolean;
  readonly returnValues: boolean;
}

export type VectorIndexOperation = "upsert" | "get" | "delete" | "query";

export type VectorIndexInput =
  | VectorIndexUpsertInput
  | VectorIndexGetInput
  | VectorIndexDeleteInput
  | VectorIndexQueryInput;

type VectorIndexInputForOperation = {
  readonly upsert: VectorIndexUpsertInput;
  readonly get: VectorIndexGetInput;
  readonly delete: VectorIndexDeleteInput;
  readonly query: VectorIndexQueryInput;
};

/** Stable codec failure. Runtime operation failures such as quota are outside this module. */
export class VectorIndexInvalidSpecError extends Error {
  readonly code = "invalid_spec" as const;

  constructor(message = "invalid VectorIndex specification") {
    super(message);
    this.name = "VectorIndexInvalidSpecError";
  }
}

/**
 * Validate and canonicalise the immutable resource configuration.
 *
 * Omitted filterKeys become a frozen empty array.  Declared keys are sorted in
 * lexical order so equivalent sets have one representation.
 */
export function parseVectorIndexConfig(value: unknown): VectorIndexConfig {
  const record = closedObject(value, "config", ["dimension", "metric", "filterKeys"]);

  const dimension = integer(record.dimension, 1, MAX_DIMENSION, "config.dimension");
  if (record.metric !== "cosine") {
    invalid("config.metric", "must be the literal cosine");
  }

  const rawFilterKeys = Object.hasOwn(record, "filterKeys")
    ? stringArray(record.filterKeys, "config.filterKeys")
    : [];
  if (rawFilterKeys.length > MAX_FILTER_KEYS) {
    invalid("config.filterKeys", `must contain at most ${MAX_FILTER_KEYS} keys`);
  }

  const filterKeys = rawFilterKeys.map((key, index) => {
    identifier(key, `config.filterKeys[${index}]`);
    return key;
  });
  assertUnique(filterKeys, "config.filterKeys");
  filterKeys.sort();

  return Object.freeze({
    dimension,
    metric: "cosine" as const,
    filterKeys: Object.freeze(filterKeys),
  });
}

/**
 * Validate and canonicalise one closed operation object.
 *
 * The entire upsert batch is traversed and canonicalised before this function
 * returns.  An invalid record therefore cannot be observed as a partial
 * provider mutation: this function has no effects and returns no value until
 * every record is valid.
 */
export function parseVectorIndexInput(
  operation: "upsert",
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexUpsertInput;
export function parseVectorIndexInput(
  operation: "get",
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexGetInput;
export function parseVectorIndexInput(
  operation: "delete",
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexDeleteInput;
export function parseVectorIndexInput(
  operation: "query",
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexQueryInput;
export function parseVectorIndexInput<TOperation extends VectorIndexOperation>(
  operation: TOperation,
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexInputForOperation[TOperation];
export function parseVectorIndexInput(
  operation: VectorIndexOperation,
  input: unknown,
  config: VectorIndexConfig | VectorIndexConfigInput,
): VectorIndexInput {
  const canonicalConfig = parseVectorIndexConfig(config);

  switch (operation) {
    case "upsert":
      return parseUpsert(input, canonicalConfig);
    case "get":
      return parseGetOrDelete(input, "get");
    case "delete":
      return parseGetOrDelete(input, "delete");
    case "query":
      return parseQuery(input, canonicalConfig);
    default:
      invalid("operation", "must be upsert, get, delete, or query");
  }
}

function parseUpsert(input: unknown, config: VectorIndexConfig): VectorIndexUpsertInput {
  const record = closedObject(input, "upsert", ["namespace", "vectors"]);
  const namespace = Object.hasOwn(record, "namespace")
    ? parseNamespace(record.namespace, "upsert.namespace")
    : "";
  const rawVectors = boundedArray(record.vectors, "upsert.vectors", 1, MAX_BATCH);

  const ids = new Set<string>();
  const vectors: VectorIndexRecord[] = [];
  for (let index = 0; index < rawVectors.length; index += 1) {
    const raw = closedObject(rawVectors[index], `upsert.vectors[${index}]`, [
      "id",
      "values",
      "metadata",
    ]);
    const id = parseId(raw.id, `upsert.vectors[${index}].id`);
    if (ids.has(id)) {
      invalid(`upsert.vectors[${index}].id`, "duplicates another ID in this batch");
    }
    ids.add(id);

    const values = parseValues(raw.values, config.dimension, `upsert.vectors[${index}].values`);
    const metadata = Object.hasOwn(raw, "metadata")
      ? parseMetadata(raw.metadata, `upsert.vectors[${index}].metadata`)
      : EMPTY_METADATA;
    vectors.push(Object.freeze({ id, values, metadata }));
  }

  return Object.freeze({ namespace, vectors: Object.freeze(vectors) });
}

function parseGetOrDelete(
  input: unknown,
  operation: "get" | "delete",
): VectorIndexGetInput | VectorIndexDeleteInput {
  const record = closedObject(input, operation, ["namespace", "ids"]);
  const namespace = Object.hasOwn(record, "namespace")
    ? parseNamespace(record.namespace, `${operation}.namespace`)
    : "";
  const ids = parseIds(record.ids, `${operation}.ids`);
  const result = Object.freeze({ namespace, ids });
  return result as VectorIndexGetInput | VectorIndexDeleteInput;
}

function parseQuery(input: unknown, config: VectorIndexConfig): VectorIndexQueryInput {
  const record = closedObject(input, "query", [
    "namespace",
    "values",
    "topK",
    "filter",
    "returnMetadata",
    "returnValues",
  ]);
  const namespace = Object.hasOwn(record, "namespace")
    ? parseNamespace(record.namespace, "query.namespace")
    : "";
  const values = parseValues(record.values, config.dimension, "query.values");
  const topK = integer(record.topK, 1, MAX_TOP_K, "query.topK");
  const filter = Object.hasOwn(record, "filter")
    ? parseFilter(record.filter, config, "query.filter")
    : EMPTY_METADATA;
  const returnMetadata = Object.hasOwn(record, "returnMetadata")
    ? parseBoolean(record.returnMetadata, "query.returnMetadata")
    : false;
  const returnValues = Object.hasOwn(record, "returnValues")
    ? parseBoolean(record.returnValues, "query.returnValues")
    : false;

  return Object.freeze({ namespace, values, topK, filter, returnMetadata, returnValues });
}

function parseNamespace(value: unknown, path: string): string {
  const namespace = boundedString(value, path, 0, MAX_NAMESPACE_LENGTH);
  if (namespace.includes("\u0000")) invalid(path, "must not contain NUL");
  if (namespace.includes("*")) invalid(path, "must not contain *");
  return namespace;
}

function parseId(value: unknown, path: string): string {
  const id = boundedString(value, path, 1, MAX_ID_LENGTH);
  if (id.includes("\u0000")) invalid(path, "must not contain NUL");
  return id;
}

function parseIds(value: unknown, path: string): readonly string[] {
  const rawIds = boundedArray(value, path, 1, MAX_BATCH);
  const ids: string[] = [];
  for (let index = 0; index < rawIds.length; index += 1) {
    ids.push(parseId(rawIds[index], `${path}[${index}]`));
  }
  assertUnique(ids, path);
  return Object.freeze(ids);
}

function parseValues(value: unknown, dimension: number, path: string): readonly number[] {
  const rawValues = boundedArray(value, path, 1, MAX_DIMENSION);
  if (rawValues.length !== dimension) {
    invalid(path, `must contain exactly ${dimension} components`);
  }

  const values: number[] = [];
  let hasNonZero = false;
  for (let index = 0; index < rawValues.length; index += 1) {
    const raw = rawValues[index];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      invalid(`${path}[${index}]`, "must be a finite number");
    }
    const value32 = Math.fround(raw);
    if (!Number.isFinite(value32)) {
      invalid(`${path}[${index}]`, "must remain finite after binary32 conversion");
    }
    if (value32 !== 0) hasNonZero = true;
    values.push(value32);
  }
  if (!hasNonZero) invalid(path, "must have a non-zero binary32 cosine norm");
  return Object.freeze(values);
}

function parseMetadata(
  value: unknown,
  path: string,
  options: { readonly enforceByteLimit?: boolean; readonly maxProperties?: number } = {},
): VectorIndexMetadata {
  const record = closedObject(value, path, null);
  const keys = Object.keys(record);
  const maxProperties = options.maxProperties ?? MAX_METADATA_PROPERTIES;
  if (keys.length > maxProperties) {
    invalid(path, `must contain at most ${maxProperties} properties`);
  }
  keys.sort();

  const metadata: Record<string, VectorIndexMetadataScalar> = {};
  for (const key of keys) {
    identifier(key, `${path}.${key}`);
    const scalar = parseMetadataScalar(record[key], `${path}.${key}`);
    // defineProperty handles the valid identifier "__proto__" without
    // invoking Object.prototype's legacy setter.
    Object.defineProperty(metadata, key, {
      configurable: false,
      enumerable: true,
      value: scalar,
      writable: false,
    });
  }

  if (options.enforceByteLimit ?? true) {
    const bytes = new TextEncoder().encode(canonicalJson(metadata)).byteLength;
    if (bytes > MAX_METADATA_BYTES) {
      invalid(path, `canonical JSON must be at most ${MAX_METADATA_BYTES} UTF-8 bytes`);
    }
  }
  return Object.freeze(metadata);
}

function parseFilter(value: unknown, config: VectorIndexConfig, path: string): VectorIndexMetadata {
  const filter = parseMetadata(value, path, {
    enforceByteLimit: false,
    maxProperties: MAX_FILTER_KEYS,
  });
  for (const key of Object.keys(filter)) {
    if (!config.filterKeys.includes(key)) {
      invalid(`${path}.${key}`, "is not declared by the Resource filterKeys");
    }
  }
  return filter;
}

function parseMetadataScalar(value: unknown, path: string): VectorIndexMetadataScalar {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "must be a finite number");
    // JCS serialises negative zero as 0; materialise the same number so the
    // in-memory canonical form has the same value semantics.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    if (codePointLength(value) > MAX_METADATA_STRING_LENGTH) {
      invalid(path, `must contain at most ${MAX_METADATA_STRING_LENGTH} Unicode code points`);
    }
    return value;
  }
  invalid(path, "must be a string, finite number, boolean, or null");
}

function boundedString(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  assertUnicodeScalarString(value, path);
  const length = codePointLength(value);
  if (length < minimum || length > maximum) {
    invalid(path, `must contain ${minimum}..${maximum} Unicode code points`);
  }
  return value;
}

function identifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SIMPLE_IDENTIFIER.test(value)) {
    invalid(path, "must match [A-Za-z][A-Za-z0-9_]{0,63}");
  }
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  const array = boundedArray(value, path, 0, MAX_FILTER_KEYS);
  const values: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const entry = array[index];
    if (typeof entry !== "string") invalid(`${path}[${index}]`, "must be a string");
    assertUnicodeScalarString(entry, `${path}[${index}]`);
    values.push(entry);
  }
  return values;
}

function boundedArray(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(path, "must not contain symbol members");
  }
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (name === "length") continue;
    const index = Number(name);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== name) {
      invalid(path, "must be a JSON array without extra members");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      invalid(`${path}[${index}]`, "must be an enumerable JSON member");
    }
  }
  if (value.length < minimum || value.length > maximum) {
    invalid(path, `must contain ${minimum}..${maximum} items`);
  }
  // JSON arrays have every index present.  A sparse JavaScript array is not a
  // closed JSON value and must not turn a hole into an implicit undefined.
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path}[${index}]`, "is missing");
  }
  return value;
}

function closedObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[] | null,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be a JSON object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, "must be a plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(path, "must not contain symbol members");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (allowedKeys !== null && !allowedKeys.includes(key)) {
      invalid(`${path}.${key}`, "is not an allowed member");
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      invalid(`${path}.${key}`, "must be an enumerable JSON member");
    }
  }
  return record;
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(path, "must not contain duplicate values");
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) invalid(path, "must not contain an unpaired UTF-16 surrogate");
    const trailing = value.charCodeAt(index + 1);
    if (!Number.isInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) {
      invalid(path, "must not contain an unpaired UTF-16 surrogate");
    }
    index += 1;
  }
}

function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

function invalid(path: string, reason: string): never {
  throw new VectorIndexInvalidSpecError(`${path}: ${reason}`);
}
