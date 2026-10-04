import {
  DocumentValidationError,
  encodeDocument,
  inputIdentifier,
  isUnicodeScalarString,
  plainInputRecord,
  WORKFLOW_MAX_DOCUMENT_BYTES,
} from "./workflow-data.ts";

export interface SelfhostWorkflowBindingRuntimeBinding {
  readonly publicName: string;
  readonly serviceName: string;
  readonly token: string;
}

const NativeRequest = Request;
const SafeJSONParse = JSON.parse;
const SafeJSONStringify = JSON.stringify;
const SafeObjectKeys = Object.keys;
const SafeApply = Reflect.apply;
const SafeOwnKeys = Reflect.ownKeys;
const SafeObjectCreate = Object.create;
const SafeObjectDefineProperty = Object.defineProperty;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectPrototype = Object.prototype;
const SafeArrayIsArray = Array.isArray;
const SafeArrayIncludes = Array.prototype.includes;
const SafeError = Error;
const SafeTypeError = TypeError;
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeTextEncoder = TextEncoder;
const SafeTextDecoder = TextDecoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const SafeUint8ArraySet = Uint8Array.prototype.set;
const SafeTypedArrayByteLengthGet = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const SafeTextDecoderDecode = TextDecoder.prototype.decode;
const SafeResponseStatusGet = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const SafeResponseHeadersGet = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const SafeResponseBodyGet = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const SafeHeadersGet = Headers.prototype.get;
const SafeReadableStreamGetReader = ReadableStream.prototype.getReader;
const SafeReaderRead = ReadableStreamDefaultReader.prototype.read;
const SafeReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const RESPONSE_FRAME_MAX_BYTES = WORKFLOW_MAX_DOCUMENT_BYTES + 16_384;
const RESULT_SCHEMA = "takoserver.selfhost-workflow-binding-result@v1";
const PATH_PREFIX = "http://workflow.invalid/__takoserver/workflow-binding/v1/";
const TOKEN_HEADER = "x-takoserver-private-workflow-binding-token";
const STATUS_VALUES = [
  "queued",
  "running",
  "sleeping",
  "waiting",
  "complete",
  "errored",
  "terminated",
] as const;
const ERROR_REASONS = [
  "run_threw",
  "step_failed",
  "step_limit_exceeded",
  "lifetime_exceeded",
  "step_definition_mismatch",
] as const;
const OPERATION_ERRORS = {
  create: [
    "instance_exists",
    "invalid_params",
    "document_too_large",
    "unsupported_capability",
    "backend_unavailable",
  ],
  get: ["unknown_instance", "backend_unavailable"],
  status: ["unknown_instance", "backend_unavailable"],
  sendEvent: [
    "unknown_instance",
    "instance_terminal",
    "document_too_large",
    "event_queue_full",
    "backend_unavailable",
  ],
  terminate: ["unknown_instance", "backend_unavailable"],
} as const;

type WorkflowOperation = keyof typeof OPERATION_ERRORS;

interface WorkflowService {
  fetch(request: Request): Promise<Response>;
}

function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: readonly unknown[]): T {
  return SafeApply(fn, receiver, args) as T;
}

function fixed(target: object, name: string, value: unknown): void {
  SafeObjectDefineProperty(target, name, {
    value,
    configurable: false,
    enumerable: true,
    writable: false,
  });
}

function hasOwn(value: object, name: string): boolean {
  return SafeObjectHasOwn(value, name);
}

function includes(values: readonly string[], value: string): boolean {
  return apply(SafeArrayIncludes, values, [value]);
}

function ownRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const record = plainInputRecord(value, "workflow binding input");
  const keys = SafeOwnKeys(record);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !includes(allowed, key)) throw new SafeTypeError("invalid");
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!hasOwn(record, required[index] as string)) throw new SafeTypeError("invalid");
  }
  return record;
}

function identifier(value: unknown): string {
  try {
    return inputIdentifier(value, "workflow binding identifier");
  } catch {
    throw localTypeError();
  }
}

function unicodeScalarLength(value: string): number {
  if (!isUnicodeScalarString(value)) return -1;
  let length = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = apply(SafeStringCharCodeAt, value, [index]) as number;
    if (code >= 0xd800 && code <= 0xdbff) {
      length -= 1;
      index += 1;
    }
  }
  return length;
}

function portableError(name: string): Error {
  const error = new SafeError(name);
  SafeObjectDefineProperty(error, "name", {
    value: name,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return error;
}

function localTypeError(): TypeError {
  const error = new SafeTypeError("invalid workflow binding input");
  SafeObjectDefineProperty(error, "name", {
    value: "TypeError",
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return error;
}

function inputDocument(
  value: unknown,
  invalidName: "invalid_params" | "TypeError",
  tooLargeName: "document_too_large",
): string {
  try {
    return encodeDocument(value);
  } catch (error) {
    throw portableError(
      error instanceof DocumentValidationError && error.kind === "too_large"
        ? tooLargeName
        : invalidName,
    );
  }
}

function scalar(value: string): string {
  return SafeJSONStringify(value) as string;
}

function frame(fields: readonly (readonly [string, string])[]): string {
  let body = "{";
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) throw portableError("backend_unavailable");
    if (index > 0) body += ",";
    body += `${scalar(field[0])}:${field[1]}`;
  }
  body += "}";
  const encoded = apply(SafeTextEncoderEncode, new SafeTextEncoder(), [body]);
  if (
    !SafeTypedArrayByteLengthGet ||
    (apply(SafeTypedArrayByteLengthGet, encoded, []) as number) > RESPONSE_FRAME_MAX_BYTES
  ) {
    throw portableError("document_too_large");
  }
  return body;
}

function plainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || SafeArrayIsArray(value)) return false;
  try {
    const prototype = SafeObjectGetPrototypeOf(value);
    return prototype === SafeObjectPrototype || prototype === null;
  } catch {
    return false;
  }
}

function closedResponseRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!plainJsonRecord(value)) throw portableError("backend_unavailable");
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = SafeObjectGetOwnPropertyDescriptors(value);
  } catch {
    throw portableError("backend_unavailable");
  }
  const keys = SafeOwnKeys(value);
  const result = SafeObjectCreate(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !includes(allowed, key))
      throw portableError("backend_unavailable");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
      throw portableError("backend_unavailable");
    }
    fixed(result, key, descriptor.value);
  }
  return result;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!SafeResponseStatusGet || !SafeResponseHeadersGet || !SafeResponseBodyGet) {
    throw portableError("backend_unavailable");
  }
  let status: number;
  let headers: Headers;
  let body: ReadableStream<Uint8Array> | null;
  try {
    status = apply(SafeResponseStatusGet, response, []);
    headers = apply(SafeResponseHeadersGet, response, []);
    body = apply(SafeResponseBodyGet, response, []);
  } catch {
    throw portableError("backend_unavailable");
  }
  if (status !== 200) {
    if (body) {
      try {
        const reader = apply(SafeReadableStreamGetReader, body, []);
        await apply(SafeReaderCancel, reader, []);
      } catch {}
    }
    throw portableError("backend_unavailable");
  }
  if (apply(SafeHeadersGet, headers, ["content-type"]) !== "application/json" || !body) {
    throw portableError("backend_unavailable");
  }
  const reader = apply(SafeReadableStreamGetReader, body, []);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = (await apply(SafeReaderRead, reader, [])) as ReadableStreamReadResult<Uint8Array>;
    if (item.done) break;
    const chunk = item.value;
    if (!(chunk instanceof SafeUint8Array) || !SafeTypedArrayByteLengthGet) {
      await apply(SafeReaderCancel, reader, []);
      throw portableError("backend_unavailable");
    }
    const byteLength = apply(SafeTypedArrayByteLengthGet, chunk, []) as number;
    if (byteLength < 0 || length + byteLength > RESPONSE_FRAME_MAX_BYTES) {
      await apply(SafeReaderCancel, reader, []);
      throw portableError("backend_unavailable");
    }
    chunks[chunks.length] = chunk;
    length += byteLength;
  }
  const bytes = new SafeUint8Array(length);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) throw portableError("backend_unavailable");
    apply(SafeUint8ArraySet, bytes, [chunk, offset]);
    offset += apply(
      SafeTypedArrayByteLengthGet as NonNullable<typeof SafeTypedArrayByteLengthGet>,
      chunk,
      [],
    ) as number;
  }
  try {
    return apply(SafeTextDecoderDecode, new SafeTextDecoder("utf-8", { fatal: true }), [bytes]);
  } catch {
    throw portableError("backend_unavailable");
  }
}

function parseEnvelope(text: string, operation: WorkflowOperation): unknown {
  let parsed: unknown;
  try {
    parsed = SafeJSONParse(text);
  } catch {
    throw portableError("backend_unavailable");
  }
  const envelope = closedResponseRecord(parsed, ["schema", "value", "error"]);
  if (envelope.schema !== RESULT_SCHEMA) throw portableError("backend_unavailable");
  if (hasOwn(envelope, "error")) {
    if (hasOwn(envelope, "value") || SafeObjectKeys(envelope).length !== 2)
      throw portableError("backend_unavailable");
    const code = envelope.error;
    if (
      typeof code !== "string" ||
      !includes(OPERATION_ERRORS[operation] as readonly string[], code)
    ) {
      throw portableError("backend_unavailable");
    }
    throw portableError(code);
  }
  if (!hasOwn(envelope, "value") || SafeObjectKeys(envelope).length !== 2)
    throw portableError("backend_unavailable");
  return envelope.value;
}

async function call(
  service: WorkflowService,
  token: string,
  operation: WorkflowOperation,
  body: string,
): Promise<unknown> {
  let response: Response;
  try {
    const request = new NativeRequest(`${PATH_PREFIX}${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TOKEN_HEADER]: token,
      },
      body,
      redirect: "manual",
    });
    const nativeFetch = service.fetch;
    response = (await apply(nativeFetch, service, [request])) as Response;
  } catch {
    throw portableError("backend_unavailable");
  }
  let text: string;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw portableError("backend_unavailable");
  }
  return parseEnvelope(text, operation);
}

function responseId(value: unknown): string {
  const result = closedResponseRecord(value, ["id"]);
  if (SafeObjectKeys(result).length !== 1 || typeof result.id !== "string")
    throw portableError("backend_unavailable");
  try {
    return inputIdentifier(result.id, "workflow instance id");
  } catch {
    throw portableError("backend_unavailable");
  }
}

function queuedCreate(value: unknown, expectedId?: string): string {
  const result = closedResponseRecord(value, ["id", "status"]);
  if (
    SafeObjectKeys(result).length !== 2 ||
    result.status !== "queued" ||
    typeof result.id !== "string"
  ) {
    throw portableError("backend_unavailable");
  }
  let id: string;
  try {
    id = inputIdentifier(result.id, "workflow instance id");
  } catch {
    throw portableError("backend_unavailable");
  }
  if (expectedId !== undefined && id !== expectedId) throw portableError("backend_unavailable");
  return id;
}

function statusResult(value: unknown): object {
  const result = closedResponseRecord(value, ["status", "output", "error"]);
  const status = result.status;
  if (typeof status !== "string" || !includes(STATUS_VALUES, status)) {
    throw portableError("backend_unavailable");
  }
  const hasOutput = hasOwn(result, "output");
  const hasError = hasOwn(result, "error");
  if ((hasOutput && status !== "complete") || (hasError && status !== "errored"))
    throw portableError("backend_unavailable");
  const projected = SafeObjectCreate(null) as Record<string, unknown>;
  fixed(projected, "status", status);
  if (hasOutput) {
    let output: Record<string, unknown>;
    try {
      output = plainInputRecord(result.output, "workflow status output");
      encodeDocument(output);
    } catch {
      throw portableError("backend_unavailable");
    }
    fixed(projected, "output", output);
  }
  if (hasError) {
    const error = closedResponseRecord(result.error, ["reason", "message"]);
    if (
      (SafeObjectKeys(error).length !== 1 && SafeObjectKeys(error).length !== 2) ||
      !(typeof error.reason === "string" && includes(ERROR_REASONS, error.reason)) ||
      (hasOwn(error, "message") &&
        (typeof error.message !== "string" ||
          unicodeScalarLength(error.message) > 8_192 ||
          unicodeScalarLength(error.message) < 0))
    ) {
      throw portableError("backend_unavailable");
    }
    fixed(projected, "error", error);
  }
  return SafeObjectFreeze(projected);
}

function assertEmptyResult(value: unknown): void {
  const result = closedResponseRecord(value, []);
  if (SafeObjectKeys(result).length !== 0) throw portableError("backend_unavailable");
}

function makeInstance(
  id: string,
  service: WorkflowService,
  token: string,
): Readonly<{
  readonly id: string;
  status(): Promise<object>;
  sendEvent(input: { readonly type: string; readonly payload?: unknown }): Promise<void>;
  terminate(): Promise<void>;
}> {
  const instance = SafeObjectCreate(null) as {
    readonly id: string;
    status(): Promise<object>;
    sendEvent(input: { readonly type: string; readonly payload?: unknown }): Promise<void>;
    terminate(): Promise<void>;
  };
  fixed(instance, "id", id);
  fixed(instance, "status", async (...args: unknown[]) => {
    if (args.length !== 0) throw localTypeError();
    const result = await call(service, token, "status", frame([["id", scalar(id)]]));
    return statusResult(result);
  });
  fixed(instance, "sendEvent", async (...args: unknown[]) => {
    if (args.length !== 1) throw localTypeError();
    const input = args[0];
    let record: Record<string, unknown>;
    try {
      record = ownRecord(input, ["type", "payload"], ["type"]);
    } catch {
      throw localTypeError();
    }
    let type: string;
    try {
      type = inputIdentifier(record.type, "workflow event type");
    } catch {
      throw localTypeError();
    }
    const fields: (readonly [string, string])[] = [
      ["id", scalar(id)],
      ["type", scalar(type)],
    ];
    if (hasOwn(record, "payload") && record.payload !== undefined) {
      fields[fields.length] = [
        "payload",
        inputDocument(record.payload, "TypeError", "document_too_large"),
      ];
    }
    const result = await call(service, token, "sendEvent", frame(fields));
    assertEmptyResult(result);
  });
  fixed(instance, "terminate", async (...args: unknown[]) => {
    if (args.length !== 0) throw localTypeError();
    const result = await call(service, token, "terminate", frame([["id", scalar(id)]]));
    assertEmptyResult(result);
  });
  return SafeObjectFreeze(instance);
}

function privateService(rawEnv: Record<string, unknown>, name: string): WorkflowService {
  const descriptor = SafeObjectGetOwnPropertyDescriptor(rawEnv, name);
  if (descriptor === undefined || !hasOwn(descriptor, "value"))
    throw new SafeTypeError("workflow binding unavailable");
  const value = descriptor.value as Partial<WorkflowService> | undefined;
  if (!value || typeof value.fetch !== "function")
    throw new SafeTypeError("workflow binding unavailable");
  return value as WorkflowService;
}

function sanitizedPrototype(source: object | null, privateNames: readonly string[]): object | null {
  if (source === null || source === SafeObjectPrototype) return null;
  const parent = SafeObjectGetPrototypeOf(source) as object | null;
  const prototype = SafeObjectCreate(sanitizedPrototype(parent, privateNames)) as object;
  const keys = SafeOwnKeys(source);
  const descriptors = SafeObjectGetOwnPropertyDescriptors(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (typeof key === "string" && includes(privateNames, key)) continue;
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor !== undefined) SafeObjectDefineProperty(prototype, key, descriptor);
  }
  return SafeObjectFreeze(prototype);
}

export function createSelfhostWorkflowBindingContext(options: {
  readonly rawEnv: Record<string, unknown>;
  readonly bindings: readonly SelfhostWorkflowBindingRuntimeBinding[];
}): { readonly rawEnv: Record<string, unknown> } {
  if (
    options === null ||
    typeof options !== "object" ||
    !options.rawEnv ||
    typeof options.rawEnv !== "object" ||
    !Array.isArray(options.bindings)
  ) {
    throw new SafeTypeError("workflow binding context unavailable");
  }
  const rawEnv = options.rawEnv;
  const descriptors = options.bindings;
  const privateNames: string[] = [];
  const services: WorkflowService[] = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const binding = descriptors[index];
    if (
      !binding ||
      typeof binding.publicName !== "string" ||
      typeof binding.serviceName !== "string" ||
      typeof binding.token !== "string"
    ) {
      throw new SafeTypeError("workflow binding context unavailable");
    }
    privateNames[index] = binding.serviceName;
    services[index] = privateService(rawEnv, binding.serviceName);
  }
  const projection = SafeObjectCreate(
    sanitizedPrototype(SafeObjectGetPrototypeOf(rawEnv) as object | null, privateNames),
  ) as Record<string, unknown>;
  const ownKeys = SafeOwnKeys(rawEnv);
  const descriptorsByKey = SafeObjectGetOwnPropertyDescriptors(rawEnv);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string" || includes(privateNames, key)) continue;
    const descriptor = descriptorsByKey[key];
    if (descriptor !== undefined) SafeObjectDefineProperty(projection, key, descriptor);
  }
  for (let index = 0; index < descriptors.length; index += 1) {
    const binding = descriptors[index] as SelfhostWorkflowBindingRuntimeBinding;
    const service = services[index] as WorkflowService;
    const namespace = SafeObjectCreate(null) as Record<string, unknown>;
    fixed(namespace, "create", async (...args: unknown[]) => {
      if (args.length !== 1) throw localTypeError();
      const input = args[0];
      let record: Record<string, unknown>;
      try {
        record = ownRecord(input, ["id", "params"], []);
      } catch {
        throw localTypeError();
      }
      const fields: (readonly [string, string])[] = [];
      let expectedId: string | undefined;
      if (hasOwn(record, "id")) {
        expectedId = identifier(record.id);
        fields[fields.length] = ["id", scalar(expectedId)];
      }
      if (hasOwn(record, "params") && record.params !== undefined) {
        fields[fields.length] = [
          "params",
          inputDocument(record.params, "invalid_params", "document_too_large"),
        ];
      }
      const result = await call(service, binding.token, "create", frame(fields));
      const id = queuedCreate(result, expectedId);
      return makeInstance(id, service, binding.token);
    });
    fixed(namespace, "get", async (...args: unknown[]) => {
      if (args.length !== 1) throw localTypeError();
      const rawId = args[0];
      const id = identifier(rawId);
      const result = await call(service, binding.token, "get", frame([["id", scalar(id)]]));
      if (responseId(result) !== id) throw portableError("backend_unavailable");
      return makeInstance(id, service, binding.token);
    });
    SafeObjectFreeze(namespace);
    SafeObjectDefineProperty(projection, binding.publicName, {
      value: namespace,
      configurable: false,
      enumerable: true,
      writable: false,
    });
  }
  return SafeObjectFreeze({ rawEnv: SafeObjectFreeze(projection) });
}
