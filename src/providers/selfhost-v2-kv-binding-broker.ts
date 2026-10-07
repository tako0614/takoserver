import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  EdgeKVBinding,
  EdgeKVListOptions,
  EdgeKVNamespaceIdentity,
  EdgeKVPutOptions,
  SelfhostV2KvStore,
} from "./selfhost-v2-kv-store.ts";
import {
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
} from "./selfhost-worker-wrapper.ts";

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const MAX_TOKEN_LENGTH = 32_768;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_VALUE_BYTES = 26_214_400;
const KV_ERROR_CODES = new Set([
  "invalid_key",
  "invalid_value",
  "invalid_argument",
  "invalid_cursor",
  "value_too_large",
  "metadata_too_large",
  "backend_unavailable",
]);

/** Structural grant shape shared with Core without an adapter-to-Form import. */
export interface V2KvBindingGrant {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface V2KvBindingResolution {
  readonly identity: EdgeKVNamespaceIdentity;
  readonly vector: string;
}

export interface V2KvSelectedVersionObservation {
  readonly kind: "confirmed";
  readonly workerUid: string;
  readonly versionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly status: "active" | "draining";
}

export interface SelfhostV2KvBindingBrokerOptions {
  readonly store: SelfhostV2KvStore;
  readonly targetKey: string;
  /** Stable Host-private key. It is never included in Worker configuration. */
  readonly signingKey: Uint8Array;
  readonly observeVersionTarget: (input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }) => Promise<V2KvSelectedVersionObservation | { readonly kind: "unknown" }>;
  readonly resolveCurrentBinding: (
    grant: V2KvBindingGrant,
    binding: string,
  ) => Promise<V2KvBindingResolution | null>;
}

/** Host-private edge.kv transport; callers mount it only on the private listener. */
export function createSelfhostV2KvBindingBroker(options: SelfhostV2KvBindingBrokerOptions) {
  if (
    !options?.store ||
    !options.targetKey ||
    !(options.signingKey instanceof Uint8Array) ||
    options.signingKey.byteLength < 32 ||
    typeof options.observeVersionTarget !== "function" ||
    typeof options.resolveCurrentBinding !== "function"
  ) {
    throw new TypeError("private KV binding authority is required");
  }
  const key = Buffer.from(options.signingKey);
  const targetKey = options.targetKey;

  function issueGrant(input: V2KvBindingGrant): string {
    const grant = checkedGrant(input, targetKey);
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function authenticate(request: Request): V2KvBindingGrant | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ") || header.length > MAX_TOKEN_LENGTH) return null;
    const [payload, offered, ...extra] = header.slice(7).split(".");
    if (!payload || !offered || extra.length || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) return null;
      signature = Buffer.from(offered, "base64url");
    } catch {
      return null;
    }
    const expected = createHmac("sha256", key).update(payload).digest();
    if (
      signature.length !== expected.length ||
      signature.toString("base64url") !== offered ||
      !timingSafeEqual(signature, expected)
    ) {
      return null;
    }
    try {
      return checkedGrant(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        targetKey,
      );
    } catch {
      return null;
    }
  }

  async function resolveCurrent(
    grant: V2KvBindingGrant,
    binding: string,
  ): Promise<V2KvBindingResolution | null> {
    if (!grant.bindings.some((item) => item.name === binding)) return null;
    const native = await options.observeVersionTarget({
      workerUid: grant.workerUid,
      versionId: grant.nativeVersionId,
      incarnationId: grant.incarnationId,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    if (
      native.kind !== "confirmed" ||
      native.workerUid !== grant.workerUid ||
      native.versionId !== grant.nativeVersionId ||
      native.incarnationId !== grant.incarnationId ||
      native.servingSourceOperationId !== grant.servingSourceOperationId ||
      (native.status !== "active" && native.status !== "draining")
    ) {
      return null;
    }
    const current = await options.resolveCurrentBinding(grant, binding);
    return current && validResolution(current, grant, binding) ? current : null;
  }

  async function stillCurrent(
    grant: V2KvBindingGrant,
    binding: string,
    captured: V2KvBindingResolution,
  ): Promise<boolean> {
    try {
      const current = await resolveCurrent(grant, binding);
      return Boolean(
        current &&
          current.vector === captured.vector &&
          sameIdentity(current.identity, captured.identity),
      );
    } catch {
      return false;
    }
  }

  async function handle(request: Request): Promise<Response | null> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.pathname !== SELFHOST_DATA_PLANE_KV_PATH) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);
    const grant = authenticate(request);
    if (!grant) return refusal("backend_unavailable", 401);

    let payload: Record<string, unknown>;
    try {
      const bytes = await boundedBody(request);
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(payload) || payload.protocol !== SELFHOST_DATA_PLANE_PROTOCOL) throw new Error();
    } catch {
      return refusal("backend_unavailable", 400);
    }
    if (typeof payload.binding !== "string" || typeof payload.op !== "string") {
      return refusal("backend_unavailable", 400);
    }
    const binding = payload.binding;
    const input = kvInput(payload);
    if (!input) return refusal("backend_unavailable", 400);

    try {
      const captured = await resolveCurrent(grant, binding);
      if (!captured) return refusal("backend_unavailable", 200);
      const identity: EdgeKVNamespaceIdentity = captured.identity;
      const namespace = await options.store.openNamespace(identity);
      if (!namespace || !(await stillCurrent(grant, binding, captured))) {
        return refusal("backend_unavailable", 200);
      }
      const value = await operate(namespace, payload.op, input);
      if (!(await stillCurrent(grant, binding, captured)))
        return refusal("backend_unavailable", 200);
      return success(value);
    } catch (error) {
      const code =
        error instanceof Error && KV_ERROR_CODES.has(error.name)
          ? error.name
          : "backend_unavailable";
      return refusal(code, 200);
    }
  }

  return Object.freeze({ issueGrant, handle });
}

function checkedGrant(input: unknown, targetKey: string): V2KvBindingGrant {
  if (
    !record(input) ||
    Object.keys(input).sort().join(",") !==
      "bindings,incarnationId,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionOperationId,workerVersionUid"
  ) {
    throw new TypeError("invalid KV binding grant");
  }
  for (const field of [
    "principal",
    "space",
    "targetKey",
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "nativeVersionId",
    "incarnationId",
    "servingSourceOperationId",
  ] as const) {
    if (
      typeof input[field] !== "string" ||
      input[field].length === 0 ||
      input[field].length > 256
    ) {
      throw new TypeError("invalid KV binding grant identity");
    }
  }
  for (const field of [
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "servingSourceOperationId",
  ] as const) {
    if (!UID.test(input[field] as string)) throw new TypeError("invalid KV binding grant UID");
  }
  if (
    input.targetKey !== targetKey ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 64
  ) {
    throw new TypeError("invalid KV binding grant target");
  }
  const names = new Set<string>();
  const bindings = input.bindings.map((value) => {
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !== "name,resourceUid" ||
      typeof value.name !== "string" ||
      !BINDING.test(value.name) ||
      typeof value.resourceUid !== "string" ||
      !UID.test(value.resourceUid) ||
      names.has(value.name)
    ) {
      throw new TypeError("invalid KV binding grant entry");
    }
    names.add(value.name);
    return { name: value.name, resourceUid: value.resourceUid };
  });
  bindings.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    principal: input.principal as string,
    space: input.space as string,
    targetKey: input.targetKey as string,
    workerUid: input.workerUid as string,
    workerVersionUid: input.workerVersionUid as string,
    workerVersionOperationId: input.workerVersionOperationId as string,
    nativeVersionId: input.nativeVersionId as string,
    incarnationId: input.incarnationId as string,
    servingSourceOperationId: input.servingSourceOperationId as string,
    bindings,
  };
}

function kvInput(payload: Record<string, unknown>): Record<string, unknown> | null {
  const operationFields: Readonly<Record<string, readonly string[]>> = {
    get: ["key"],
    getWithMetadata: ["key"],
    put: ["key", "value", "metadata", "expirationTtlSeconds"],
    delete: ["key"],
    list: ["prefix", "cursor", "limit"],
  };
  const allowed = operationFields[payload.op as string];
  if (
    !allowed ||
    Object.keys(payload).some((field) => !["protocol", "binding", "op", ...allowed].includes(field))
  ) {
    return null;
  }
  return payload;
}

async function operate(
  namespace: EdgeKVBinding,
  operation: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (operation) {
    case "get": {
      const value = await namespace.get(input.key as string);
      return { found: value !== null, ...(value === null ? {} : { value: encodeBase64(value) }) };
    }
    case "getWithMetadata": {
      const value = await namespace.getWithMetadata(input.key as string);
      return value === null
        ? { found: false }
        : {
            found: true,
            value: encodeBase64(value.value),
            ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
          };
    }
    case "put": {
      const bytes = decodeBase64(input.value);
      if (!bytes) throw namedError("invalid_value");
      const options: EdgeKVPutOptions = {
        ...(Object.hasOwn(input, "metadata")
          ? { metadata: input.metadata as NonNullable<EdgeKVPutOptions["metadata"]> }
          : {}),
        ...(Object.hasOwn(input, "expirationTtlSeconds")
          ? { expirationTtlSeconds: input.expirationTtlSeconds as number }
          : {}),
      };
      await namespace.put(input.key as string, bytes, options);
      return {};
    }
    case "delete":
      await namespace.delete(input.key as string);
      return {};
    case "list": {
      const listOptions: EdgeKVListOptions = {
        ...(Object.hasOwn(input, "prefix") ? { prefix: input.prefix as string } : {}),
        ...(Object.hasOwn(input, "cursor") ? { cursor: input.cursor as string } : {}),
        ...(Object.hasOwn(input, "limit") ? { limit: input.limit as number } : {}),
      };
      return await namespace.list(listOptions);
    }
    default:
      return refusal("backend_unavailable", 200);
  }
}

function validResolution(
  resolution: V2KvBindingResolution,
  grant: V2KvBindingGrant,
  binding: string,
): boolean {
  const selected = grant.bindings.find((item) => item.name === binding);
  const identity = resolution.identity;
  return Boolean(
    selected &&
      identity.targetKey === grant.targetKey &&
      identity.principal === grant.principal &&
      identity.space === grant.space &&
      identity.resourceUid === selected.resourceUid &&
      typeof resolution.vector === "string" &&
      resolution.vector.length > 0,
  );
}

function sameIdentity(left: EdgeKVNamespaceIdentity, right: EdgeKVNamespaceIdentity): boolean {
  return (
    left.targetKey === right.targetKey &&
    left.principal === right.principal &&
    left.space === right.space &&
    left.resourceUid === right.resourceUid
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_VALUE_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= MAX_VALUE_BYTES && bytes.toString("base64") === value
    ? Uint8Array.from(bytes)
    : null;
}

function encodeBase64(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64");
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new TypeError("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new TypeError("body too large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function success(value: unknown): Response {
  const body = JSON.stringify({ ok: true, value });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    return refusal("backend_unavailable", 200);
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
  });
}

function refusal(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), {
    status,
    headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
