/**
 * Candidate-only transport-neutral edge.vector@0.1.0 facade source.
 *
 * The generated fragment assumes the host has captured the Safe* intrinsics
 * listed in EDGE_VECTOR_WORKER_FACADE_SAFE_INTRINSICS. It receives transport
 * through invoke(operation, input, project); transport must call project on
 * the raw value synchronously before resolving its async result.
 */
export const EDGE_VECTOR_WORKER_FACADE_KIND = "edge.vector@0.1.0" as const;

export const EDGE_VECTOR_WORKER_FACADE_SAFE_INTRINSICS = Object.freeze([
  "SafeApply",
  "SafeArrayIsArray",
  "SafeArrayPrototype",
  "SafeError",
  "SafeMathFround",
  "SafeNumberIsFinite",
  "SafeNumberIsSafeInteger",
  "SafeObject",
  "SafeObjectCreate",
  "SafeObjectDefineProperty",
  "SafeObjectFreeze",
  "SafeObjectGetOwnPropertyDescriptor",
  "SafeObjectGetPrototypeOf",
  "SafeObjectHasOwn",
  "SafeObjectSetPrototypeOf",
  "SafeObjectPrototype",
  "SafeOwnKeys",
  "SafeReflect",
  "SafeJSONStringify",
  "SafeStringCharCodeAt",
  "SafeSymbol",
  "SafeTextEncoder",
  "SafeTextEncoderEncode",
  "SafeTypedArrayByteLengthGet",
] as const);

export type EdgeVectorWorkerFacadeSafeIntrinsic =
  (typeof EDGE_VECTOR_WORKER_FACADE_SAFE_INTRINSICS)[number];

export function renderEdgeVectorWorkerFacadeSource(): string {
  return `
/**
 * Candidate-only edge.vector@0.1.0 facade.
 *
 * The facade intentionally knows only the four Interface operations.  It
 * snapshots and closes the caller's object graph before handing it to the
 * transport, then validates the response shape before handing it back.  The
 * configured dimension and filter-key checks remain the VectorIndexStore's
 * authority; this layer enforces the transport-independent shape and method
 * arity that a Worker can observe without a provider-specific dependency.
 */
function createEdgeVectorAdapter(invoke) {
  const portable = SafeObjectCreate(null);
  portable.upsert = async function (input) {
    if (arguments.length !== 1) throw vectorInvalidError();
    const snapshot = vectorInputSnapshot(vectorUpsertInput, input);
    return await vectorInvoke(invoke, "upsert", snapshot, (value) =>
      vectorUpsertOutput(value, snapshot),
    );
  };
  portable.get = async function (input) {
    if (arguments.length !== 1) throw vectorInvalidError();
    const snapshot = vectorInputSnapshot(vectorGetInput, input);
    return await vectorInvoke(invoke, "get", snapshot, (value) =>
      vectorGetOutput(value, snapshot),
    );
  };
  portable.delete = async function (input) {
    if (arguments.length !== 1) throw vectorInvalidError();
    const snapshot = vectorInputSnapshot(vectorDeleteInput, input);
    return await vectorInvoke(invoke, "delete", snapshot, (value) =>
      vectorDeleteOutput(value, snapshot),
    );
  };
  portable.query = async function (input) {
    if (arguments.length !== 1) throw vectorInvalidError();
    const snapshot = vectorInputSnapshot(vectorQueryInput, input);
    return await vectorInvoke(invoke, "query", snapshot, (value) =>
      vectorQueryOutput(value, snapshot),
    );
  };
  return SafeApply(SafeObjectFreeze, SafeObject, [portable]);
}

const VECTOR_MISSING = SafeSymbol("takoserver-edge-vector-missing");
const VECTOR_MAX_DIMENSION = 1536;
const VECTOR_MAX_ID_CHARS = 128;
const VECTOR_MAX_NAMESPACE_CHARS = 128;
const VECTOR_MAX_BATCH = 100;
const VECTOR_MAX_TOP_K = 100;
const VECTOR_MAX_METADATA_BYTES = 8192;
const VECTOR_MAX_METADATA_PROPERTIES = 64;
const VECTOR_MAX_FILTER_KEYS = 8;
const VECTOR_METADATA_KEY_MAX_CHARS = 64;

function vectorInternalArray() {
  return SafeApply(SafeObjectSetPrototypeOf, SafeObject, [[], null]);
}

async function vectorInvoke(invoke, operation, input, project) {
  try {
    return await invoke(operation, input, project);
  } catch (error) {
    throw vectorTranslateError(error);
  }
}

function vectorInputSnapshot(factory, input) {
  try {
    return factory(input);
  } catch {
    throw vectorInvalidError();
  }
}

function vectorTranslateError(error) {
  let code;
  try {
    if (typeof error === "string") {
      code = error;
    } else if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const fields = ["code", "name", "message"];
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [error, field]);
        if (descriptor && SafeObjectHasOwn(descriptor, "value") && typeof descriptor.value === "string") {
          code = descriptor.value;
          break;
        }
      }
    }
  } catch {}
  if (code === "backend_unavailable") code = "unavailable";
  if (code !== "invalid_spec" && code !== "quota" && code !== "unavailable") code = "unavailable";
  return vectorPortableError(code);
}

function vectorInvalidError() {
  return vectorPortableError("invalid_spec");
}

function vectorUnavailableError() {
  return vectorPortableError("unavailable");
}

/** Error names are own data, even if tenant code poisoned Error.prototype. */
function vectorPortableError(code) {
  const error = new SafeError(code);
  const descriptor = SafeObjectCreate(null);
  descriptor.value = code;
  descriptor.enumerable = false;
  descriptor.configurable = true;
  descriptor.writable = true;
  SafeApply(SafeObjectDefineProperty, SafeObject, [error, "name", descriptor]);
  return error;
}

function vectorIsRecord(value) {
  return value !== null && typeof value === "object" && !SafeArrayIsArray(value);
}

function vectorIsPlainRecord(value) {
  if (!vectorIsRecord(value)) return false;
  try {
    const prototype = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [value]);
    return prototype === SafeObjectPrototype || prototype === null;
  } catch {
    return false;
  }
}

/** Copy a closed plain object without invoking getters or toJSON. */
function vectorRecord(value, allowed, required) {
  if (!vectorIsPlainRecord(value)) throw vectorInvalidError();
  const result = SafeObjectCreate(null);
  const keys = SafeApply(SafeOwnKeys, SafeReflect, [value]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !vectorContains(allowed, key)) throw vectorInvalidError();
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [value, key]);
    if (!descriptor || !SafeObjectHasOwn(descriptor, "value")) throw vectorInvalidError();
    result[key] = descriptor.value;
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!SafeObjectHasOwn(result, required[index])) throw vectorInvalidError();
  }
  return result;
}

function vectorOwnData(value, key) {
  const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [value, key]);
  if (!descriptor || !SafeObjectHasOwn(descriptor, "value")) throw vectorInvalidError();
  return descriptor.value;
}

function vectorContains(values, value) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function vectorArray(value, minimum, maximum, mapper, privateSnapshot = true) {
  if (!SafeArrayIsArray(value)) throw vectorInvalidError();
  const lengthValue = vectorOwnData(value, "length");
  if (
    typeof lengthValue !== "number" ||
    !SafeNumberIsSafeInteger(lengthValue) ||
    lengthValue < minimum ||
    lengthValue > maximum
  ) {
    throw vectorInvalidError();
  }
  const keys = SafeApply(SafeOwnKeys, SafeReflect, [value]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw vectorInvalidError();
    if (key === "length") continue;
    if (vectorArrayIndex(key, lengthValue) < 0) throw vectorInvalidError();
  }
  const result = [];
  // Populate behind a null prototype so a tenant-installed numeric setter or
  // getter on Array.prototype cannot observe or alter Host-owned output.
  SafeApply(SafeObjectSetPrototypeOf, SafeObject, [result, null]);
  for (let index = 0; index < lengthValue; index += 1) {
    if (!SafeObjectHasOwn(value, index)) throw vectorInvalidError();
    const descriptor = SafeObjectCreate(null);
    descriptor.value = mapper(vectorOwnData(value, index), index);
    descriptor.enumerable = true;
    descriptor.configurable = true;
    descriptor.writable = true;
    SafeApply(SafeObjectDefineProperty, SafeObject, [result, index, descriptor]);
  }
  if (!privateSnapshot) {
    // Keep the public result an ordinary Array. The captured prototype is
    // restored only after every indexed property exists, so no tenant setter
    // can observe Host construction.
    SafeApply(SafeObjectSetPrototypeOf, SafeObject, [result, SafeArrayPrototype]);
  }
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorArrayIndex(key, length) {
  if (key.length === 0 || (key.length > 1 && key[0] === "0")) return -1;
  let index = 0;
  for (let offset = 0; offset < key.length; offset += 1) {
    const code = SafeApply(SafeStringCharCodeAt, key, [offset]);
    if (code < 48 || code > 57) return -1;
    index = index * 10 + code - 48;
    if (!SafeNumberIsSafeInteger(index) || index >= length) return -1;
  }
  return index;
}

function vectorCodePointLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = SafeApply(SafeStringCharCodeAt, value, [index]);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= value.length) throw vectorInvalidError();
      const second = SafeApply(SafeStringCharCodeAt, value, [index + 1]);
      if (second < 0xdc00 || second > 0xdfff) throw vectorInvalidError();
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw vectorInvalidError();
    }
    length += 1;
  }
  return length;
}

function vectorNamespace(value) {
  if (typeof value !== "string") throw vectorInvalidError();
  if (vectorCodePointLength(value) > VECTOR_MAX_NAMESPACE_CHARS) throw vectorInvalidError();
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeApply(SafeStringCharCodeAt, value, [index]);
    if (code === 0 || code === 42) throw vectorInvalidError();
  }
  return value;
}

function vectorId(value) {
  if (typeof value !== "string" || value.length === 0) throw vectorInvalidError();
  if (vectorCodePointLength(value) > VECTOR_MAX_ID_CHARS) throw vectorInvalidError();
  for (let index = 0; index < value.length; index += 1) {
    if (SafeApply(SafeStringCharCodeAt, value, [index]) === 0) throw vectorInvalidError();
  }
  return value;
}

function vectorMetadataKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > VECTOR_METADATA_KEY_MAX_CHARS) {
    throw vectorInvalidError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = SafeApply(SafeStringCharCodeAt, value, [index]);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (index === 0 ? !letter : !(letter || digit || code === 95)) throw vectorInvalidError();
  }
  return value;
}

function vectorScalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!SafeNumberIsFinite(value)) throw vectorInvalidError();
    return value;
  }
  if (typeof value === "string") {
    if (vectorCodePointLength(value) > VECTOR_MAX_METADATA_BYTES) throw vectorInvalidError();
    return value;
  }
  throw vectorInvalidError();
}

function vectorUtf8Length(value) {
  const bytes = SafeApply(SafeTextEncoderEncode, new SafeTextEncoder(), [value]);
  return SafeApply(SafeTypedArrayByteLengthGet, bytes, []);
}

function vectorMetadata(value, maximumProperties, enforceByteLimit = true) {
  const result = SafeObjectCreate(null);
  if (value === VECTOR_MISSING) return SafeApply(SafeObjectFreeze, SafeObject, [result]);
  if (!vectorIsPlainRecord(value)) throw vectorInvalidError();
  const keys = SafeApply(SafeOwnKeys, SafeReflect, [value]);
  if (keys.length > maximumProperties) throw vectorInvalidError();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw vectorInvalidError();
    const safeKey = vectorMetadataKey(key);
    result[safeKey] = vectorScalar(vectorOwnData(value, key));
  }
  let encoded;
  try {
    encoded = SafeJSONStringify(result);
  } catch {
    throw vectorInvalidError();
  }
  if (
    typeof encoded !== "string" ||
    (enforceByteLimit && vectorUtf8Length(encoded) > VECTOR_MAX_METADATA_BYTES)
  ) {
    throw vectorInvalidError();
  }
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorValues(value, privateSnapshot = true, canonicalOnly = false) {
  let nonzero = false;
  const result = vectorArray(
    value,
    1,
    VECTOR_MAX_DIMENSION,
    (item) => {
      if (typeof item !== "number" || !SafeNumberIsFinite(item)) throw vectorInvalidError();
      const canonical = SafeApply(SafeMathFround, null, [item]);
      if (!SafeNumberIsFinite(canonical)) throw vectorInvalidError();
      if (canonical === 0) return canonical;
      nonzero = true;
      if (canonicalOnly && canonical !== item) throw vectorInvalidError();
      return canonicalOnly ? item : canonical;
    },
    privateSnapshot,
  );
  if (!nonzero) throw vectorInvalidError();
  return result;
}

function vectorIds(value, privateSnapshot = true) {
  const seen = vectorInternalArray();
  return vectorArray(
    value,
    1,
    VECTOR_MAX_BATCH,
    (item) => {
      const id = vectorId(item);
      if (vectorContains(seen, id)) throw vectorInvalidError();
      seen[seen.length] = id;
      return id;
    },
    privateSnapshot,
  );
}

function vectorNamespaceInput(object) {
  return SafeObjectHasOwn(object, "namespace")
    ? vectorNamespace(vectorOwnData(object, "namespace"))
    : VECTOR_MISSING;
}

function vectorUpsertInput(input) {
  const object = vectorRecord(input, ["namespace", "vectors"], ["vectors"]);
  const result = SafeObjectCreate(null);
  const namespace = vectorNamespaceInput(object);
  if (namespace !== VECTOR_MISSING) result.namespace = namespace;
  const seen = vectorInternalArray();
  result.vectors = vectorArray(
    vectorOwnData(object, "vectors"),
    1,
    VECTOR_MAX_BATCH,
    (item) => {
      const vector = vectorRecord(item, ["id", "values", "metadata"], ["id", "values"]);
      const id = vectorId(vectorOwnData(vector, "id"));
      if (vectorContains(seen, id)) throw vectorInvalidError();
      seen[seen.length] = id;
      const projected = SafeObjectCreate(null);
      projected.id = id;
      projected.values = vectorValues(vectorOwnData(vector, "values"));
      if (SafeObjectHasOwn(vector, "metadata")) {
        projected.metadata = vectorMetadata(
          vectorOwnData(vector, "metadata"),
          VECTOR_MAX_METADATA_PROPERTIES,
        );
      }
      return SafeApply(SafeObjectFreeze, SafeObject, [projected]);
    },
  );
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorGetInput(input) {
  return vectorGetOrDeleteInput(input);
}

function vectorDeleteInput(input) {
  return vectorGetOrDeleteInput(input);
}

function vectorGetOrDeleteInput(input) {
  const object = vectorRecord(input, ["namespace", "ids"], ["ids"]);
  const result = SafeObjectCreate(null);
  const namespace = vectorNamespaceInput(object);
  if (namespace !== VECTOR_MISSING) result.namespace = namespace;
  result.ids = vectorIds(vectorOwnData(object, "ids"));
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorFilter(value) {
  return vectorMetadata(value, VECTOR_MAX_FILTER_KEYS, false);
}

function vectorQueryInput(input) {
  const object = vectorRecord(
    input,
    ["namespace", "values", "topK", "filter", "returnMetadata", "returnValues"],
    ["values", "topK"],
  );
  const result = SafeObjectCreate(null);
  const namespace = vectorNamespaceInput(object);
  if (namespace !== VECTOR_MISSING) result.namespace = namespace;
  result.values = vectorValues(vectorOwnData(object, "values"));
  const topK = vectorOwnData(object, "topK");
  if (
    typeof topK !== "number" ||
    !SafeNumberIsSafeInteger(topK) ||
    topK < 1 ||
    topK > VECTOR_MAX_TOP_K
  ) {
    throw vectorInvalidError();
  }
  result.topK = topK;
  if (SafeObjectHasOwn(object, "filter")) result.filter = vectorFilter(vectorOwnData(object, "filter"));
  if (SafeObjectHasOwn(object, "returnMetadata")) {
    const returnMetadata = vectorOwnData(object, "returnMetadata");
    if (typeof returnMetadata !== "boolean") throw vectorInvalidError();
    result.returnMetadata = returnMetadata;
  }
  if (SafeObjectHasOwn(object, "returnValues")) {
    const returnValues = vectorOwnData(object, "returnValues");
    if (typeof returnValues !== "boolean") throw vectorInvalidError();
    result.returnValues = returnValues;
  }
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorCount(value, maximum, expected) {
  if (
    typeof value !== "number" ||
    !SafeNumberIsSafeInteger(value) ||
    value < 0 ||
    value > maximum ||
    (expected !== undefined && value !== expected)
  ) {
    throw vectorUnavailableError();
  }
  return value;
}

function vectorOutputRecord(value, allowed, required) {
  try {
    return vectorRecord(value, allowed, required);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorOutputIds(value) {
  try {
    return vectorIds(value, false);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorOutputId(value) {
  try {
    return vectorId(value);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorOutputNamespace(value) {
  try {
    return vectorNamespace(value);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorOutputValues(value) {
  try {
    return vectorValues(value, false, true);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorOutputMetadata(value) {
  try {
    return vectorMetadata(value, VECTOR_MAX_METADATA_PROPERTIES);
  } catch {
    throw vectorUnavailableError();
  }
}

function vectorExpectedNamespace(input) {
  return SafeObjectHasOwn(input, "namespace")
    ? vectorOutputNamespace(vectorOwnData(input, "namespace"))
    : "";
}

function vectorExpectedIds(input, field, nestedField) {
  const entries = vectorOwnData(input, field);
  const expected = vectorInternalArray();
  for (let index = 0; index < entries.length; index += 1) {
    expected[index] = nestedField === "" ? entries[index] : vectorOwnData(entries[index], nestedField);
  }
  return expected;
}

function vectorIdsEqual(actual, expected) {
  if (actual.length !== expected.length) throw vectorUnavailableError();
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) throw vectorUnavailableError();
  }
}

function vectorUpsertOutput(value, input) {
  const object = vectorOutputRecord(value, ["ids", "count"], ["ids", "count"]);
  const ids = vectorOutputIds(vectorOwnData(object, "ids"));
  const expected = vectorExpectedIds(input, "vectors", "id");
  vectorIdsEqual(ids, expected);
  const count = vectorCount(vectorOwnData(object, "count"), VECTOR_MAX_BATCH, expected.length);
  const result = SafeObjectCreate(null);
  result.ids = ids;
  result.count = count;
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorGetOutput(value, input) {
  const object = vectorOutputRecord(value, ["vectors"], ["vectors"]);
  const expectedIds = vectorExpectedIds(input, "ids", "");
  const expectedNamespace = vectorExpectedNamespace(input);
  let expectedIndex = 0;
  let vectors;
  try {
    vectors = vectorArray(
      vectorOwnData(object, "vectors"),
      0,
      VECTOR_MAX_BATCH,
      (item) => {
        const vector = vectorOutputRecord(
          item,
          ["id", "namespace", "values", "metadata"],
          ["id", "namespace", "values", "metadata"],
        );
        const projected = SafeObjectCreate(null);
        projected.id = vectorOutputId(vectorOwnData(vector, "id"));
        projected.namespace = vectorOutputNamespace(vectorOwnData(vector, "namespace"));
        if (projected.namespace !== expectedNamespace) throw vectorUnavailableError();
        while (expectedIndex < expectedIds.length && expectedIds[expectedIndex] !== projected.id) {
          expectedIndex += 1;
        }
        if (expectedIndex >= expectedIds.length) throw vectorUnavailableError();
        expectedIndex += 1;
        projected.values = vectorOutputValues(vectorOwnData(vector, "values"));
        projected.metadata = vectorOutputMetadata(vectorOwnData(vector, "metadata"));
        return SafeApply(SafeObjectFreeze, SafeObject, [projected]);
      },
      false,
    );
  } catch {
    throw vectorUnavailableError();
  }
  const result = SafeObjectCreate(null);
  result.vectors = vectors;
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorDeleteOutput(value, input) {
  const object = vectorOutputRecord(value, ["ids", "count"], ["ids", "count"]);
  const ids = vectorOutputIds(vectorOwnData(object, "ids"));
  const expected = vectorExpectedIds(input, "ids", "");
  vectorIdsEqual(ids, expected);
  const count = vectorCount(vectorOwnData(object, "count"), VECTOR_MAX_BATCH, expected.length);
  const result = SafeObjectCreate(null);
  result.ids = ids;
  result.count = count;
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}

function vectorScore(value) {
  if (!SafeNumberIsFinite(value) || typeof value !== "number" || value < -1 || value > 1) {
    throw vectorUnavailableError();
  }
  return value;
}

function vectorQueryOutput(value, input) {
  const object = vectorOutputRecord(value, ["matches", "count"], ["matches", "count"]);
  const expectedNamespace = vectorExpectedNamespace(input);
  const expectedTopK = vectorOwnData(input, "topK");
  const returnMetadata = SafeObjectHasOwn(input, "returnMetadata")
    ? vectorOwnData(input, "returnMetadata")
    : false;
  const returnValues = SafeObjectHasOwn(input, "returnValues")
    ? vectorOwnData(input, "returnValues")
    : false;
  const seen = vectorInternalArray();
  let previousScore = Infinity;
  let matches;
  try {
    matches = vectorArray(
      vectorOwnData(object, "matches"),
      0,
      VECTOR_MAX_BATCH,
      (item) => {
        const match = vectorOutputRecord(
          item,
          ["id", "namespace", "score", "metadata", "values"],
          ["id", "namespace", "score"],
        );
        const projected = SafeObjectCreate(null);
        projected.id = vectorOutputId(vectorOwnData(match, "id"));
        projected.namespace = vectorOutputNamespace(vectorOwnData(match, "namespace"));
        if (projected.namespace !== expectedNamespace || vectorContains(seen, projected.id)) {
          throw vectorUnavailableError();
        }
        seen[seen.length] = projected.id;
        projected.score = vectorScore(vectorOwnData(match, "score"));
        if (projected.score > previousScore) throw vectorUnavailableError();
        previousScore = projected.score;
        if (SafeObjectHasOwn(match, "metadata") !== returnMetadata) {
          throw vectorUnavailableError();
        }
        if (returnMetadata) {
          projected.metadata = vectorOutputMetadata(vectorOwnData(match, "metadata"));
        }
        if (SafeObjectHasOwn(match, "values") !== returnValues) {
          throw vectorUnavailableError();
        }
        if (returnValues) {
          projected.values = vectorOutputValues(vectorOwnData(match, "values"));
          if (projected.values.length !== vectorOwnData(input, "values").length) {
            throw vectorUnavailableError();
          }
        }
        return SafeApply(SafeObjectFreeze, SafeObject, [projected]);
      },
      false,
    );
  } catch {
    throw vectorUnavailableError();
  }
  const count = vectorCount(vectorOwnData(object, "count"), expectedTopK, matches.length);
  const result = SafeObjectCreate(null);
  result.matches = matches;
  result.count = count;
  return SafeApply(SafeObjectFreeze, SafeObject, [result]);
}
`;
}
