import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../json.ts";
import { createFileObjectStore } from "../objects-fs.ts";
import {
  createSelfhostObjectStore,
  type SelfhostObjectBody,
  type SelfhostObjectGetOptions,
  type SelfhostObjectListOptions,
  type SelfhostObjectListResult,
  type SelfhostObjectMetadata,
  type SelfhostObjectPutOptions,
  type SelfhostObjectStore,
  type SelfhostObjectStoreOptions,
} from "../selfhost-object-store.ts";

const OWNER_SCHEMA = "takoserver.v2-object-bucket-owner@1" as const;
const OWNER_DIRECTORY = ".takoform-v2-object-bucket-owners";
const OWNER_MAX_BYTES = 16 * 1_024;
const BUCKET_ID = /^tsb-[0-9a-f]{40}$/u;
const ENCODER = new TextEncoder();

export interface SelfhostV2ObjectBucketIdentity {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
}

export type SelfhostV2ObjectBucketState = "ready" | "absent" | "conflict" | "unknown";

export interface SelfhostV2ObjectBucketAccess {
  head(key: string): Promise<SelfhostObjectMetadata | null>;
  get(key: string, options?: SelfhostObjectGetOptions): Promise<SelfhostObjectBody | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: SelfhostObjectPutOptions,
  ): Promise<{ readonly etag: string; readonly size: number }>;
  delete(key: string): Promise<void>;
  list(options?: SelfhostObjectListOptions): Promise<SelfhostObjectListResult>;
  createMultipartUpload(
    key: string,
    options?: { readonly contentType?: string },
  ): Promise<{ readonly uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream<Uint8Array>,
    options: { readonly contentLength: number },
  ): Promise<{ readonly etag: string; readonly partNumber: number }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { readonly etag: string; readonly partNumber: number }[],
  ): Promise<{ readonly etag: string; readonly size: number }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export interface SelfhostV2ObjectBucketStore {
  /** Create-only authority, bound to the accepted initial create Operation. */
  create(input: {
    readonly identity: SelfhostV2ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<SelfhostV2ObjectBucketState>;
  /** Read-only create reconciliation; never creates a missing owner marker. */
  reconcileCreate(input: {
    readonly identity: SelfhostV2ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<SelfhostV2ObjectBucketState>;
  observe(identity: SelfhostV2ObjectBucketIdentity): Promise<SelfhostV2ObjectBucketState>;
  /** Idempotently records deletion intent, destroys all rows/files, and tombstones. */
  delete(input: {
    readonly identity: SelfhostV2ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<"deleted" | "conflict" | "unknown">;
  /** Opens only an already-owned live namespace; never adopts or creates one. */
  openBucket(
    identity: SelfhostV2ObjectBucketIdentity,
  ): Promise<SelfhostV2ObjectBucketAccess | null>;
}

interface OwnerRecord {
  readonly schema: typeof OWNER_SCHEMA;
  readonly bucketId: string;
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
  readonly createOperationId: string;
  readonly state: "active" | "deleting" | "deleted";
  readonly deleteOperationId?: string;
}

type ReadOwnerResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "owner";
      readonly record: OwnerRecord;
      readonly writeOperationId: string | undefined;
    };

export type SelfhostV2ObjectBucketStoreOptions = Pick<
  SelfhostObjectStoreOptions,
  "sql" | "root" | "clock" | "identifier"
>;

export function createSelfhostV2ObjectBucketStore(
  options: SelfhostV2ObjectBucketStoreOptions,
): SelfhostV2ObjectBucketStore {
  const root = resolve(options.root);
  const objectStore = createSelfhostObjectStore(options);
  // This separate private root uses the existing filesystem store's OS writer
  // claim, exact write-operation receipt, and crash-safe replacement protocol.
  const ownerStore = createFileObjectStore({ root: join(root, OWNER_DIRECTORY) });
  if (ownerStore.writeOperationIdentity !== "exact") {
    throw new TypeError("ObjectBucket ownership requires exact filesystem write receipts");
  }

  const identityIsValid = (identity: SelfhostV2ObjectBucketIdentity): boolean =>
    Boolean(identity?.targetKey && identity.principal && identity.space && identity.resourceUid);
  const bucketIdFor = (identity: SelfhostV2ObjectBucketIdentity): string => {
    if (!identityIsValid(identity)) throw new TypeError("invalid ObjectBucket identity");
    const digest = createHash("sha256")
      .update(
        canonicalJson([
          "takoserver.v2.object-bucket-namespace@1",
          identity.targetKey,
          identity.principal,
          identity.space,
          identity.resourceUid,
        ]),
      )
      .digest("hex");
    return `tsb-${digest.slice(0, 40)}`;
  };
  const ownerKey = (bucketId: string): string => `buckets/${bucketId}.json`;
  const ownerBody = (record: OwnerRecord): Uint8Array => ENCODER.encode(JSON.stringify(record));

  const readOwner = async (bucketId: string): Promise<ReadOwnerResult> => {
    try {
      const stored = await ownerStore.get(ownerKey(bucketId));
      if (!stored) return { kind: "absent" };
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = stored.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > OWNER_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { kind: "invalid" };
          }
          chunks.push(next.value.slice());
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const record = parseOwnerRecord(parsed);
      if (!record || record.bucketId !== bucketId) return { kind: "invalid" };
      const expectedWriteId =
        record.state === "active" ? record.createOperationId : record.deleteOperationId;
      if (!expectedWriteId || stored.writeOperationId !== expectedWriteId)
        return { kind: "invalid" };
      return { kind: "owner", record, writeOperationId: stored.writeOperationId };
    } catch {
      return { kind: "invalid" };
    }
  };

  const matches = (record: OwnerRecord, identity: SelfhostV2ObjectBucketIdentity): boolean =>
    record.targetKey === identity.targetKey &&
    record.principal === identity.principal &&
    record.space === identity.space &&
    record.resourceUid === identity.resourceUid;

  const hasUnownedData = async (bucketId: string): Promise<boolean | null> => {
    try {
      const bucketPath = join(root, bucketId);
      const info = await lstat(bucketPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (info) return true;
      const occupancy = await objectStore.occupancy(bucketId);
      return occupancy.objects > 0 || occupancy.uploads > 0;
    } catch {
      return null;
    }
  };

  const ownerFromIdentity = (
    identity: SelfhostV2ObjectBucketIdentity,
    bucketId: string,
    createOperationId: string,
  ): OwnerRecord => ({
    schema: OWNER_SCHEMA,
    bucketId,
    targetKey: identity.targetKey,
    principal: identity.principal,
    space: identity.space,
    resourceUid: identity.resourceUid,
    createOperationId,
    state: "active",
  });

  const stateForActiveOwner = async (
    identity: SelfhostV2ObjectBucketIdentity,
    bucketId: string,
    owner: ReadOwnerResult,
  ): Promise<SelfhostV2ObjectBucketState> => {
    if (owner.kind === "absent") {
      const unowned = await hasUnownedData(bucketId);
      return unowned === false ? "absent" : unowned === true ? "conflict" : "unknown";
    }
    if (owner.kind !== "owner") return "unknown";
    if (!matches(owner.record, identity)) return "conflict";
    return owner.record.state === "active" ? "ready" : "conflict";
  };

  const writeOwner = async (
    bucketId: string,
    record: OwnerRecord,
    operationId: string,
  ): Promise<boolean> => {
    try {
      const result = await ownerStore.put(ownerKey(bucketId), ownerBody(record), {
        contentType: "application/json",
        writeOperationId: operationId,
      });
      if (result.writeOperationId === operationId) return true;
    } catch {
      // Re-read below: a filesystem acknowledgement can be lost after commit.
    }
    const saved = await readOwner(bucketId);
    return (
      saved.kind === "owner" &&
      saved.record.state === record.state &&
      saved.record.createOperationId === record.createOperationId &&
      saved.record.deleteOperationId === record.deleteOperationId &&
      saved.writeOperationId === operationId
    );
  };

  return {
    async create({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const bucketId = bucketIdFor(identity);
      const existing = await readOwner(bucketId);
      if (existing.kind === "owner") {
        return matches(existing.record, identity) &&
          existing.record.state === "active" &&
          existing.record.createOperationId === operationId
          ? "ready"
          : "conflict";
      }
      if (existing.kind === "invalid") return "unknown";
      const unowned = await hasUnownedData(bucketId);
      if (unowned !== false) return unowned === true ? "conflict" : "unknown";

      const record = ownerFromIdentity(identity, bucketId, operationId);
      try {
        const created = await ownerStore.create(ownerKey(bucketId), ownerBody(record), {
          contentType: "application/json",
          writeOperationId: operationId,
        });
        if (created?.writeOperationId === operationId) return "ready";
      } catch {
        // Check whether this exact accepted create marker committed before its ack was lost.
      }
      const after = await readOwner(bucketId);
      return after.kind === "owner" &&
        matches(after.record, identity) &&
        after.record.state === "active" &&
        after.record.createOperationId === operationId
        ? "ready"
        : after.kind === "absent"
          ? "unknown"
          : "conflict";
    },

    async reconcileCreate({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const bucketId = bucketIdFor(identity);
      const existing = await readOwner(bucketId);
      if (existing.kind === "owner") {
        return matches(existing.record, identity) &&
          existing.record.state === "active" &&
          existing.record.createOperationId === operationId
          ? "ready"
          : "conflict";
      }
      if (existing.kind === "invalid") return "unknown";
      const unowned = await hasUnownedData(bucketId);
      return unowned === false ? "absent" : unowned === true ? "conflict" : "unknown";
    },

    async observe(identity) {
      if (!identityIsValid(identity)) return "unknown";
      const bucketId = bucketIdFor(identity);
      return await stateForActiveOwner(identity, bucketId, await readOwner(bucketId));
    },

    async delete({ identity, operationId }) {
      if (!identityIsValid(identity) || !operationId) return "unknown";
      const bucketId = bucketIdFor(identity);
      const existing = await readOwner(bucketId);
      if (existing.kind !== "owner") return existing.kind === "absent" ? "unknown" : "unknown";
      const record = existing.record;
      if (!matches(record, identity)) return "conflict";
      if (record.state === "deleted") {
        if (record.deleteOperationId !== operationId) return "conflict";
        return (await hasUnownedData(bucketId)) === false ? "deleted" : "unknown";
      }
      if (record.state === "deleting" && record.deleteOperationId !== operationId)
        return "conflict";

      if (record.state === "active") {
        const deleting: OwnerRecord = {
          ...record,
          state: "deleting",
          deleteOperationId: operationId,
        };
        if (!(await writeOwner(bucketId, deleting, operationId))) return "unknown";
      }
      try {
        await objectStore.destroy(bucketId);
      } catch {
        return "unknown";
      }
      if ((await hasUnownedData(bucketId)) !== false) return "unknown";
      const deletingRecord: OwnerRecord = {
        ...record,
        state: "deleted",
        deleteOperationId: operationId,
      };
      return (await writeOwner(bucketId, deletingRecord, operationId)) ? "deleted" : "unknown";
    },

    async openBucket(identity) {
      if (!identityIsValid(identity)) return null;
      const bucketId = bucketIdFor(identity);
      const state = await stateForActiveOwner(identity, bucketId, await readOwner(bucketId));
      if (state !== "ready") return null;
      return boundStore(objectStore, bucketId);
    },
  };
}

function parseOwnerRecord(value: unknown): OwnerRecord | null {
  if (!isRecord(value)) return null;
  const expected = [
    "schema",
    "bucketId",
    "targetKey",
    "principal",
    "space",
    "resourceUid",
    "createOperationId",
    "state",
  ];
  const hasDeleteId = Object.hasOwn(value, "deleteOperationId");
  if (
    Reflect.ownKeys(value).length !== expected.length + (hasDeleteId ? 1 : 0) ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    (hasDeleteId && typeof value.deleteOperationId !== "string") ||
    value.schema !== OWNER_SCHEMA ||
    typeof value.bucketId !== "string" ||
    !BUCKET_ID.test(value.bucketId) ||
    typeof value.targetKey !== "string" ||
    !value.targetKey ||
    typeof value.principal !== "string" ||
    !value.principal ||
    typeof value.space !== "string" ||
    !value.space ||
    typeof value.resourceUid !== "string" ||
    !value.resourceUid ||
    typeof value.createOperationId !== "string" ||
    !value.createOperationId ||
    (value.state !== "active" && value.state !== "deleting" && value.state !== "deleted") ||
    (value.state === "active") !== !hasDeleteId
  ) {
    return null;
  }
  return value as unknown as OwnerRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundStore(store: SelfhostObjectStore, bucketId: string): SelfhostV2ObjectBucketAccess {
  return Object.freeze({
    head: (key: string) => store.head(bucketId, key),
    get: (key: string, options?: SelfhostObjectGetOptions) => store.get(bucketId, key, options),
    put: (key: string, body: ReadableStream<Uint8Array>, options: SelfhostObjectPutOptions) =>
      store.put(bucketId, key, body, options),
    delete: (key: string) => store.delete(bucketId, key),
    list: (options?: SelfhostObjectListOptions) => store.list(bucketId, options),
    createMultipartUpload: (key: string, options?: { readonly contentType?: string }) =>
      store.createMultipartUpload(bucketId, key, options),
    uploadPart: (
      key: string,
      uploadId: string,
      partNumber: number,
      body: ReadableStream<Uint8Array>,
      options: { readonly contentLength: number },
    ) => store.uploadPart(bucketId, key, uploadId, partNumber, body, options),
    completeMultipartUpload: (
      key: string,
      uploadId: string,
      parts: readonly { readonly etag: string; readonly partNumber: number }[],
    ) => store.completeMultipartUpload(bucketId, key, uploadId, parts),
    abortMultipartUpload: (key: string, uploadId: string) =>
      store.abortMultipartUpload(bucketId, key, uploadId),
  });
}
