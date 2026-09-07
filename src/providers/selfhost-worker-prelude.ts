/** Host-private module that captures serving intrinsics before tenant startup. */
export const SELFHOST_WORKER_PRELUDE_MODULE = "__takoserver-selfhost-prelude.js" as const;

/**
 * Second Host-private identity used only when the application main has the
 * ordinary prelude's logical name.
 *
 * Application and Host-private modules occupy different runtime namespaces,
 * so either spelling remains a valid tenant module name. The alternate exists
 * because a Host-private import of the one designated application main is the
 * intentional bridge between those namespaces; importing that exact spelling
 * must therefore not also be how the wrapper finds its prelude.
 */
export const SELFHOST_WORKER_ALTERNATE_PRELUDE_MODULE =
  "__takoserver-selfhost-prelude-alternate.js" as const;

/** Selects a Host-private prelude identity without reserving either tenant name. */
export function selfhostWorkerPreludeModuleName(applicationMain: string): string {
  return applicationMain === SELFHOST_WORKER_PRELUDE_MODULE
    ? SELFHOST_WORKER_ALTERNATE_PRELUDE_MODULE
    : SELFHOST_WORKER_PRELUDE_MODULE;
}

/**
 * Capture every intrinsic the self-host entrypoint uses in a dependency that
 * evaluates before the application main. The entrypoint can therefore import
 * the tenant statically, preserving native startup evaluation, without letting
 * tenant top-level code replace an intrinsic used with Host authority.
 */
export function selfhostWorkerPreludeSource(): string {
  return `const SafeApply = Reflect.apply;
const SafeReflect = Reflect;
const SafeReflectGet = Reflect.get;
const SafeOwnKeys = Reflect.ownKeys;
const SafeArrayIsArray = Array.isArray;
const SafeArrayBufferIsView = ArrayBuffer.isView;
const SafeArrayBufferSlice = ArrayBuffer.prototype.slice;
const SafeAtob = atob;
const SafeBtoa = btoa;
const SafeError = Error;
const SafeTypeError = TypeError;
const SafeJSONParse = JSON.parse;
const SafeJSONStringify = JSON.stringify;
const SafeMap = Map;
const SafeMapGet = Map.prototype.get;
const SafeMapHas = Map.prototype.has;
const SafeMapSet = Map.prototype.set;
const SafeMapDelete = Map.prototype.delete;
const SafeMathAbs = Math.abs;
const SafeMathMin = Math.min;
const SafeNumberIsFinite = Number.isFinite;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const SafeObject = Object;
const SafeObjectCreate = Object.create;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeObjectHasOwn = Object.hasOwn;
const SafeObjectKeys = Object.keys;
const SafeObjectPrototype = Object.prototype;
const SafeObjectSetPrototypeOf = Object.setPrototypeOf;
const SafePromise = Promise;
const SafePromiseResolve = Promise.resolve;
const SafePromiseThen = Promise.prototype.then;
const SafeRegExpTest = RegExp.prototype.test;
const SafeReadableStream = ReadableStream;
const SafeReadableStreamLockedGet = captureGetter(ReadableStream.prototype, "locked");
const SafeReadableStreamControllerClose = ReadableStreamDefaultController.prototype.close;
const SafeReadableStreamControllerEnqueue = ReadableStreamDefaultController.prototype.enqueue;
const SafeResponse = Response;
const SafeResponseText = Response.prototype.text;
const SafeResponseBodyGet = captureGetter(Response.prototype, "body");
const SafeResponseHeadersGet = captureGetter(Response.prototype, "headers");
const SafeResponseStatusGet = captureGetter(Response.prototype, "status");
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeSymbol = Symbol;
const SafeURL = URL;
const SafeHeadersGet = Headers.prototype.get;
const SafeRequestText = Request.prototype.text;
const SafeRequestUrlGet = captureGetter(Request.prototype, "url");
const SafeRequestMethodGet = captureGetter(Request.prototype, "method");
const SafeRequestHeadersGet = captureGetter(Request.prototype, "headers");
const SafeURLPathnameGet = captureGetter(URL.prototype, "pathname");
const SafeURLHostnameGet = captureGetter(URL.prototype, "hostname");
const SafeStringFromCharCode = String.fromCharCode;
const SafeTextDecoder = TextDecoder;
const SafeTextDecoderDecode = TextDecoder.prototype.decode;
const SafeTextEncoder = TextEncoder;
const SafeTextEncoderEncode = TextEncoder.prototype.encode;
const SafeUint8Array = Uint8Array;
const SafeUint8ArraySet = Uint8Array.prototype.set;
const SafeDataViewBufferGet = captureGetter(DataView.prototype, "buffer");
const SafeDataViewByteLengthGet = captureGetter(DataView.prototype, "byteLength");
const SafeDataViewByteOffsetGet = captureGetter(DataView.prototype, "byteOffset");
const SafeTypedArrayBufferGet = captureGetter(Uint8Array.prototype, "buffer");
const SafeTypedArrayByteLengthGet = captureGetter(Uint8Array.prototype, "byteLength");
const SafeTypedArrayByteOffsetGet = captureGetter(Uint8Array.prototype, "byteOffset");

function captureGetter(prototype, name) {
  let current = prototype;
  while (current) {
    const descriptor = SafeApply(SafeObjectGetOwnPropertyDescriptor, SafeObject, [current, name]);
    if (descriptor && typeof descriptor.get === "function") return descriptor.get;
    current = SafeApply(SafeObjectGetPrototypeOf, SafeObject, [current]);
  }
  throw new SafeTypeError("self-host Worker intrinsic is unavailable");
}

export {
  SafeApply,
  SafeReflect,
  SafeReflectGet,
  SafeOwnKeys,
  SafeArrayIsArray,
  SafeArrayBufferIsView,
  SafeArrayBufferSlice,
  SafeAtob,
  SafeBtoa,
  SafeError,
  SafeTypeError,
  SafeJSONParse,
  SafeJSONStringify,
  SafeMap,
  SafeMapGet,
  SafeMapHas,
  SafeMapSet,
  SafeMapDelete,
  SafeMathAbs,
  SafeMathMin,
  SafeNumberIsFinite,
  SafeNumberIsSafeInteger,
  SafeNumberMaxSafeInteger,
  SafeObject,
  SafeObjectCreate,
  SafeObjectFreeze,
  SafeObjectGetOwnPropertyDescriptor,
  SafeObjectGetPrototypeOf,
  SafeObjectHasOwn,
  SafeObjectKeys,
  SafeObjectPrototype,
  SafeObjectSetPrototypeOf,
  SafePromise,
  SafePromiseResolve,
  SafePromiseThen,
  SafeRegExpTest,
  SafeReadableStream,
  SafeReadableStreamLockedGet,
  SafeReadableStreamControllerClose,
  SafeReadableStreamControllerEnqueue,
  SafeResponse,
  SafeResponseText,
  SafeResponseBodyGet,
  SafeResponseHeadersGet,
  SafeResponseStatusGet,
  SafeStringCharCodeAt,
  SafeSymbol,
  SafeURL,
  SafeHeadersGet,
  SafeRequestText,
  SafeRequestUrlGet,
  SafeRequestMethodGet,
  SafeRequestHeadersGet,
  SafeURLPathnameGet,
  SafeURLHostnameGet,
  SafeStringFromCharCode,
  SafeTextDecoder,
  SafeTextDecoderDecode,
  SafeTextEncoder,
  SafeTextEncoderEncode,
  SafeUint8Array,
  SafeUint8ArraySet,
  SafeDataViewBufferGet,
  SafeDataViewByteLengthGet,
  SafeDataViewByteOffsetGet,
  SafeTypedArrayBufferGet,
  SafeTypedArrayByteLengthGet,
  SafeTypedArrayByteOffsetGet,
};
`;
}
