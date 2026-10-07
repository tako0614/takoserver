import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../json.ts";
import { createFileObjectStore } from "../objects-fs.ts";
import type { Clock, Sql } from "../ports.ts";

const OWNER_SCHEMA = "takoserver.v2-edge-kv-namespace-owner@1" as const;
const OWNER_DIRECTORY = ".takoform-v2-edge-kv-owners";
const OWNER_MAX_BYTES = 16 * 1_024;
const NAMESPACE_ID = /^tskv-[0-9a-f]{40}$/u;
const CURSOR_KEY = /^[0-9a-f]{64}$/u;
const WRITER_AUTHORITY_KEY = "_host/edge-kv-writer-authority.json";
const WRITER_AUTHORITY_BODY = Buffer.from(
  JSON.stringify({ schema: "takoserver.v2-edge-kv-writer-authority@1" }),
);
const MUTEX_SYMBOL = Symbol.for("@takoserver/v2-edge-kv-lifecycle-mutexes");
const globalState = globalThis as unknown as Record<symbol, unknown>;
const existingMutexes = globalState[MUTEX_SYMBOL];
const MUTEXES =
  existingMutexes instanceof Map ? (existingMutexes as Map<string, Promise<void>>) : new Map();
if (!(existingMutexes instanceof Map)) globalState[MUTEX_SYMBOL] = MUTEXES;

export interface SelfhostV2KvStoreOptions {
  readonly sql: Sql;
  readonly root: string;
  readonly clock?: Clock;
  readonly runOperation: SelfhostKvOperationRunner;
  readonly operationErrorCode: (error: unknown) => string | null;
}

export interface EdgeKVNamespaceIdentity {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
}

export type SelfhostKvOperation = "get" | "getWithMetadata" | "put" | "delete" | "list";
export type SelfhostKvOperationRunner = (
  sql: Sql,
  clock: () => Date,
  namespace: string,
  operation: SelfhostKvOperation,
  payload: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

export interface EdgeKVMetadata {
  readonly [key: string]: string;
}

export interface EdgeKVPutOptions {
  readonly metadata?: EdgeKVMetadata;
  readonly expirationTtlSeconds?: number;
}

export interface EdgeKVListOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EdgeKVNamespaceStore {
  create(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  reconcileCreate(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  observe(identity: EdgeKVNamespaceIdentity): Promise<"ready" | "absent" | "conflict" | "unknown">;
  delete(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"deleted" | "conflict" | "unknown">;
}

export interface EdgeKVBinding {
  get(key: string): Promise<ArrayBuffer | null>;
  getWithMetadata(key: string): Promise<{ value: ArrayBuffer; metadata?: EdgeKVMetadata } | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: EdgeKVPutOptions,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: EdgeKVListOptions): Promise<{
    keys: { name: string }[];
    listComplete: boolean;
    cursor?: string;
  }>;
}

export interface SelfhostV2KvStore extends EdgeKVNamespaceStore {
  openNamespace(identity: EdgeKVNamespaceIdentity): Promise<EdgeKVBinding | null>;
}

interface OwnerRecord {
  readonly schema: typeof OWNER_SCHEMA;
  readonly namespaceId: string;
  readonly cursorKey: string;
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
  readonly createOperationId: string;
  readonly state: "active" | "deleting" | "deleted";
  readonly deleteOperationId?: string;
}

type OwnerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "owner";
      readonly record: OwnerRecord;
      readonly writeOperationId: string | undefined;
    };

export function createSelfhostV2KvStore(options: SelfhostV2KvStoreOptions): SelfhostV2KvStore {
  const root = resolve(options.root);
  const ownerStore = createFileObjectStore({ root: join(root, OWNER_DIRECTORY) });
  if (ownerStore.writeOperationIdentity !== "exact") {
    throw new TypeError("EdgeKVNamespace ownership requires exact filesystem write receipts");
  }
  const clock = options.clock ?? (() => new Date());

  const identityIsValid = (identity: EdgeKVNamespaceIdentity): boolean =>
    Boolean(identity?.targetKey && identity.principal && identity.space && identity.resourceUid);
  const namespaceIdFor = (identity: EdgeKVNamespaceIdentity): string => {
    if (!identityIsValid(identity)) throw new TypeError("invalid EdgeKVNamespace identity");
    const digest = createHash("sha256")
      .update(
        canonicalJson([
          "takoserver.v2.edge-kv-namespace@1",
          identity.targetKey,
          identity.principal,
          identity.space,
          identity.resourceUid,
        ]),
      )
      .digest("hex");
    return `tskv-${digest.slice(0, 40)}`;
  };
  const ownerKey = (namespaceId: string): string => `namespaces/${namespaceId}.json`;
  const ownerBody = (record: OwnerRecord): Uint8Array => Buffer.from(JSON.stringify(record));

  const claimProcessWriter = async (): Promise<boolean> => {
    const operationId = randomUUID();
    try {
      const saved = await ownerStore.put(WRITER_AUTHORITY_KEY, WRITER_AUTHORITY_BODY, {
        contentType: "application/json",
        writeOperationId: operationId,
      });
      if (saved.writeOperationId === operationId) return true;
    } catch {
      // The exact operation receipt below handles an acknowledgement lost after commit.
    }
    try {
      const saved = await ownerStore.get(WRITER_AUTHORITY_KEY);
      return saved?.writeOperationId === operationId;
    } catch {
      return false;
    }
  };

  const withLifecycle = async <T>(namespaceId: string, operation: () => Promise<T>): Promise<T> => {
    if (!(await claimProcessWriter())) throw namedError("backend_unavailable");
    const ownerRoot = await lstat(join(root, OWNER_DIRECTORY)).catch(() => null);
    if (!ownerRoot?.isDirectory() || ownerRoot.isSymbolicLink()) {
      throw namedError("backend_unavailable");
    }
    const lockKey = `${ownerRoot.dev}:${ownerRoot.ino}\0${namespaceId}`;
    return await withMutex(lockKey, operation);
  };

  const readOwner = async (namespaceId: string): Promise<OwnerRead> => {
    try {
      const stored = await ownerStore.get(ownerKey(namespaceId));
      if (!stored) return { kind: "absent" };
      const bytes = await readBoundedBody(stored.body, OWNER_MAX_BYTES);
      if (!bytes) return { kind: "invalid" };
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const record = parseOwnerRecord(parsed);
      if (!record || record.namespaceId !== namespaceId) return { kind: "invalid" };
      const expected =
        record.state === "active" ? record.createOperationId : record.deleteOperationId;
      if (!expected || stored.writeOperationId !== expected) return { kind: "invalid" };
      return { kind: "owner", record, writeOperationId: stored.writeOperationId };
    } catch {
      return { kind: "invalid" };
    }
  };

  const matches = (record: OwnerRecord, identity: EdgeKVNamespaceIdentity): boolean =>
    record.targetKey === identity.targetKey &&
    record.principal === identity.principal &&
    record.space === identity.space &&
    record.resourceUid === identity.resourceUid;

  const unownedRows = async (namespaceId: string): Promise<boolean | null> => {
    try {
      const rows = await options.sql.query(
        "SELECT 1 AS present FROM selfhost_kv_entries WHERE namespace_id = ? LIMIT 1",
        [namespaceId],
      );
      return rows.length > 0;
    } catch {
      return null;
    }
  };

  const writeOwner = async (record: OwnerRecord, operationId: string): Promise<boolean> => {
    try {
      const saved = await ownerStore.put(ownerKey(record.namespaceId), ownerBody(record), {
        contentType: "application/json",
        writeOperationId: operationId,
      });
      if (saved.writeOperationId === operationId) return true;
    } catch {
      // Read back the exact state/receipt after a possibly lost acknowledgement.
    }
    const saved = await readOwner(record.namespaceId);
    return (
      saved.kind === "owner" &&
      saved.record.state === record.state &&
      saved.record.createOperationId === record.createOperationId &&
      saved.record.deleteOperationId === record.deleteOperationId &&
      saved.writeOperationId === operationId
    );
  };

  const ownerState = async (
    identity: EdgeKVNamespaceIdentity,
    namespaceId: string,
  ): Promise<"ready" | "absent" | "conflict" | "unknown"> => {
    const owner = await readOwner(namespaceId);
    if (owner.kind === "absent") {
      const rows = await unownedRows(namespaceId);
      return rows === false ? "absent" : rows === true ? "conflict" : "unknown";
    }
    if (owner.kind !== "owner") return "unknown";
    if (!matches(owner.record, identity)) return "conflict";
    return owner.record.state === "active" ? "ready" : "conflict";
  };

  const call = async (
    identity: EdgeKVNamespaceIdentity,
    operation: "get" | "getWithMetadata" | "put" | "delete" | "list",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const namespaceId = namespaceIdFor(identity);
    return await withLifecycle(namespaceId, async () => {
      if ((await ownerState(identity, namespaceId)) !== "ready") {
        throw namedError("backend_unavailable");
      }
      try {
        return await options.runOperation(options.sql, clock, namespaceId, operation, payload);
      } catch (error) {
        throw namedError(options.operationErrorCode(error) ?? "backend_unavailable");
      }
    });
  };

  return {
    async create({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const namespaceId = namespaceIdFor(identity);
      return await withLifecycle(namespaceId, async () => {
        const existing = await readOwner(namespaceId);
        if (existing.kind === "owner") {
          return matches(existing.record, identity) &&
            existing.record.state === "active" &&
            existing.record.createOperationId === operationId
            ? "ready"
            : "conflict";
        }
        if (existing.kind === "invalid") return "unknown";
        const rows = await unownedRows(namespaceId);
        if (rows !== false) return rows === true ? "conflict" : "unknown";
        const record: OwnerRecord = {
          schema: OWNER_SCHEMA,
          namespaceId,
          cursorKey: randomBytes(32).toString("hex"),
          targetKey: identity.targetKey,
          principal: identity.principal,
          space: identity.space,
          resourceUid: identity.resourceUid,
          createOperationId: operationId,
          state: "active",
        };
        try {
          const created = await ownerStore.create(ownerKey(namespaceId), ownerBody(record), {
            contentType: "application/json",
            writeOperationId: operationId,
          });
          if (created?.writeOperationId === operationId) return "ready";
        } catch {
          // The create receipt is authoritative if the reply was lost.
        }
        const after = await readOwner(namespaceId);
        return after.kind === "owner" &&
          matches(after.record, identity) &&
          after.record.state === "active" &&
          after.record.createOperationId === operationId
          ? "ready"
          : after.kind === "absent"
            ? "unknown"
            : "conflict";
      }).catch(() => "unknown" as const);
    },

    async reconcileCreate({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const namespaceId = namespaceIdFor(identity);
      return await withLifecycle(namespaceId, async () => {
        const existing = await readOwner(namespaceId);
        if (existing.kind === "owner") {
          return matches(existing.record, identity) &&
            existing.record.state === "active" &&
            existing.record.createOperationId === operationId
            ? "ready"
            : "conflict";
        }
        if (existing.kind === "invalid") return "unknown";
        const rows = await unownedRows(namespaceId);
        return rows === false ? "absent" : rows === true ? "conflict" : "unknown";
      }).catch(() => "unknown" as const);
    },

    async observe(identity) {
      if (!identityIsValid(identity)) return "unknown";
      const namespaceId = namespaceIdFor(identity);
      return await withLifecycle(namespaceId, () => ownerState(identity, namespaceId)).catch(
        () => "unknown" as const,
      );
    },

    async delete({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const namespaceId = namespaceIdFor(identity);
      return await withLifecycle(namespaceId, async () => {
        const existing = await readOwner(namespaceId);
        if (existing.kind !== "owner") return "unknown";
        const current = existing.record;
        if (!matches(current, identity)) return "conflict";
        if (current.state === "deleted") {
          if (current.deleteOperationId !== operationId) return "conflict";
          return (await unownedRows(namespaceId)) === false ? "deleted" : "unknown";
        }
        if (current.state === "deleting" && current.deleteOperationId !== operationId)
          return "conflict";
        if (current.state === "active") {
          const deleting: OwnerRecord = {
            ...current,
            state: "deleting",
            deleteOperationId: operationId,
          };
          if (!(await writeOwner(deleting, operationId))) return "unknown";
        }
        try {
          await options.sql.run("DELETE FROM selfhost_kv_entries WHERE namespace_id = ?", [
            namespaceId,
          ]);
        } catch {
          return "unknown";
        }
        if ((await unownedRows(namespaceId)) !== false) return "unknown";
        const tombstone: OwnerRecord = {
          ...current,
          state: "deleted",
          deleteOperationId: operationId,
        };
        return (await writeOwner(tombstone, operationId)) ? "deleted" : "unknown";
      }).catch(() => "unknown" as const);
    },

    async openNamespace(identity) {
      if (!identityIsValid(identity)) return null;
      const namespaceId = namespaceIdFor(identity);
      const state = await withLifecycle(namespaceId, () => ownerState(identity, namespaceId)).catch(
        () => "unknown" as const,
      );
      if (state !== "ready") return null;
      const invoke = <T extends Record<string, unknown>>(
        operation: "get" | "getWithMetadata" | "put" | "delete" | "list",
        payload: T,
      ) => call(identity, operation, payload);

      return Object.freeze({
        async get(key: string) {
          validateKey(key);
          const result = await invoke("get", { key });
          if (result.found !== true || typeof result.value !== "string") return null;
          const bytes = Buffer.from(result.value, "base64");
          return Uint8Array.from(bytes).buffer;
        },
        async getWithMetadata(key: string) {
          validateKey(key);
          const result = await invoke("getWithMetadata", { key });
          if (result.found !== true || typeof result.value !== "string") return null;
          const bytes = Buffer.from(result.value, "base64");
          const value = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          const metadata = metadataResult(result.metadata);
          return { value, ...(metadata === undefined ? {} : { metadata }) };
        },
        async put(
          key: string,
          value: ArrayBuffer | ArrayBufferView | string,
          rawOptions?: EdgeKVPutOptions,
        ) {
          validateKey(key);
          const bytes = putValue(value);
          const putOptions = putOptionsFrom(rawOptions);
          await invoke("put", {
            key,
            value: Buffer.from(bytes).toString("base64"),
            ...(putOptions.metadata === undefined ? {} : { metadata: putOptions.metadata }),
            ...(putOptions.expirationTtlSeconds === undefined
              ? {}
              : { expirationTtlSeconds: putOptions.expirationTtlSeconds }),
          });
        },
        async delete(key: string) {
          validateKey(key);
          await invoke("delete", { key });
        },
        async list(rawOptions?: EdgeKVListOptions) {
          const listOptions = listOptionsFrom(rawOptions);
          const engineCursor =
            listOptions.cursor === undefined
              ? undefined
              : decodeCursor(
                  listOptions.cursor,
                  namespaceId,
                  (await currentOwner(identity, namespaceId)).cursorKey,
                );
          const result = await invoke("list", {
            ...(listOptions.prefix === undefined ? {} : { prefix: listOptions.prefix }),
            limit: listOptions.limit ?? 100,
            ...(engineCursor === undefined ? {} : { cursor: engineCursor }),
          });
          if (!Array.isArray(result.keys) || typeof result.listComplete !== "boolean") {
            throw namedError("backend_unavailable");
          }
          const owner = await currentOwner(identity, namespaceId);
          const cursor =
            typeof result.cursor === "string"
              ? encodeCursor(result.cursor, namespaceId, owner.cursorKey)
              : undefined;
          return {
            keys: result.keys as { name: string }[],
            listComplete: result.listComplete,
            ...(cursor === undefined ? {} : { cursor }),
          };
        },
      });
    },
  };

  async function currentOwner(
    identity: EdgeKVNamespaceIdentity,
    namespaceId: string,
  ): Promise<OwnerRecord> {
    return await withLifecycle(namespaceId, async () => {
      const value = await readOwner(namespaceId);
      if (
        value.kind !== "owner" ||
        value.record.state !== "active" ||
        !matches(value.record, identity)
      ) {
        throw namedError("backend_unavailable");
      }
      return value.record;
    });
  }
}

function parseOwnerRecord(value: unknown): OwnerRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hasDeleteId = Object.hasOwn(record, "deleteOperationId");
  const expectedKeys = [
    "schema",
    "namespaceId",
    "cursorKey",
    "targetKey",
    "principal",
    "space",
    "resourceUid",
    "createOperationId",
    "state",
  ];
  if (
    Reflect.ownKeys(record).length !== expectedKeys.length + (hasDeleteId ? 1 : 0) ||
    expectedKeys.some((key) => !Object.hasOwn(record, key)) ||
    (hasDeleteId && typeof record.deleteOperationId !== "string") ||
    record.schema !== OWNER_SCHEMA ||
    typeof record.namespaceId !== "string" ||
    !NAMESPACE_ID.test(record.namespaceId) ||
    typeof record.cursorKey !== "string" ||
    !CURSOR_KEY.test(record.cursorKey) ||
    typeof record.targetKey !== "string" ||
    !record.targetKey ||
    typeof record.principal !== "string" ||
    !record.principal ||
    typeof record.space !== "string" ||
    !record.space ||
    typeof record.resourceUid !== "string" ||
    !record.resourceUid ||
    typeof record.createOperationId !== "string" ||
    !record.createOperationId ||
    (record.state !== "active" && record.state !== "deleting" && record.state !== "deleted") ||
    (record.state === "active") !== !hasDeleteId
  )
    return null;
  return value as OwnerRecord;
}

function encodeCursor(engineCursor: string, namespaceId: string, cursorKey: string): string {
  const body = Buffer.from(engineCursor, "utf8").toString("base64url");
  const tag = createHmac("sha256", Buffer.from(cursorKey, "hex"))
    .update(`takoserver.v2.edge-kv.cursor@1\0${namespaceId}\0${body}`)
    .digest("base64url");
  return `${body}.${tag}`;
}

function decodeCursor(cursor: string, namespaceId: string, cursorKey: string): string {
  const [body, tag, extra] = cursor.split(".");
  if (!body || !tag || extra !== undefined || cursor.length > 4_096) {
    throw namedError("invalid_cursor");
  }
  const expected = createHmac("sha256", Buffer.from(cursorKey, "hex"))
    .update(`takoserver.v2.edge-kv.cursor@1\0${namespaceId}\0${body}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(tag, "base64url");
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("bad cursor mac");
    }
    return decoded;
  } catch {
    throw namedError("invalid_cursor");
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function withMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (MUTEXES.get(key) === current) MUTEXES.delete(key);
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function validateKey(key: unknown, allowEmpty = false): asserts key is string {
  if (typeof key !== "string") throw new TypeError("key must be a string");
  if ((!allowEmpty && key.length === 0) || Buffer.byteLength(key, "utf8") > 467) {
    throw namedError("invalid_key");
  }
}

function plainRecord(input: unknown, label: string): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return input as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new TypeError(`${label} has unknown fields`);
  }
}

function metadata(input: unknown): EdgeKVMetadata {
  const value = plainRecord(input, "metadata");
  const output: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    const item = typeof key === "string" ? value[key] : undefined;
    if (typeof key !== "string" || typeof item !== "string") {
      throw new TypeError("metadata must be a string map");
    }
    if (Buffer.byteLength(key, "utf8") > 256 || [...item].length > 8_192) {
      throw namedError("metadata_too_large");
    }
    output[key] = item;
  }
  if (Buffer.byteLength(canonicalJson(output), "utf8") > 1_024) {
    throw namedError("metadata_too_large");
  }
  return output;
}

function metadataResult(input: unknown): EdgeKVMetadata | undefined {
  if (input === undefined) return undefined;
  const value = plainRecord(input, "metadata result");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw namedError("backend_unavailable");
    result[key] = item;
  }
  return result;
}

function putOptionsFrom(input: unknown): EdgeKVPutOptions {
  if (input === undefined) return {};
  const value = plainRecord(input, "put options");
  onlyKeys(value, ["metadata", "expirationTtlSeconds"], "put options");
  const result: { metadata?: EdgeKVMetadata; expirationTtlSeconds?: number } = {};
  if (Object.hasOwn(value, "metadata")) result.metadata = metadata(value.metadata);
  if (Object.hasOwn(value, "expirationTtlSeconds")) {
    const ttl = value.expirationTtlSeconds;
    if (typeof ttl !== "number" || !Number.isInteger(ttl)) {
      throw new TypeError("expirationTtlSeconds must be an integer");
    }
    // Out-of-range integer TTL is safely rejected by the shared engine as
    // invalid_value, but that name is absent from EdgeKVNamespace 0.2's table.
    result.expirationTtlSeconds = ttl;
  }
  return result;
}

function listOptionsFrom(input: unknown): EdgeKVListOptions {
  if (input === undefined) return {};
  const value = plainRecord(input, "list options");
  onlyKeys(value, ["prefix", "limit", "cursor"], "list options");
  const result: { prefix?: string; limit?: number; cursor?: string } = {};
  if (Object.hasOwn(value, "prefix")) {
    if (typeof value.prefix !== "string") throw new TypeError("prefix must be a string");
    validateKey(value.prefix, true);
    result.prefix = value.prefix;
  }
  if (Object.hasOwn(value, "limit")) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit)) {
      throw new TypeError("limit must be an integer");
    }
    // Out-of-range limit's safe shared-engine error is not in Form 0.2's table.
    result.limit = value.limit;
  }
  if (Object.hasOwn(value, "cursor")) {
    if (typeof value.cursor !== "string") throw new TypeError("cursor must be a string");
    result.cursor = value.cursor;
  }
  return result;
}

function putValue(value: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "string") bytes = Buffer.from(value, "utf8");
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  } else {
    throw new TypeError("value must be a string, ArrayBuffer, or ArrayBufferView");
  }
  if (bytes.byteLength > 26_214_400) throw namedError("value_too_large");
  return bytes;
}
