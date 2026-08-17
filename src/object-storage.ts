import type { RuntimeGrantVerifier } from "./runtime-grants.ts";
import { executionIntentDigest } from "./runtime-grants.ts";

export type ObjectStorageOperation = "put" | "get" | "head" | "delete" | "list";

export type ObjectStorageBody = ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;

export interface ObjectStorageObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
}

export interface ObjectStorageMetadata {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ObjectStorageListPage {
  readonly objects: readonly ObjectStorageMetadata[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface ObjectStorageAdapter {
  put(input: {
    readonly key: string;
    readonly body: ArrayBuffer;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<ObjectStorageMetadata>;
  get(key: string): Promise<ObjectStorageObject | null>;
  head(key: string): Promise<ObjectStorageMetadata | null>;
  delete(key: string): Promise<boolean>;
  list(input: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<ObjectStorageListPage>;
}

export interface ObjectStorageBaseCommand {
  readonly grantToken: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  /** Optional explicit intent for callers that persist a signed request plan. */
  readonly intent?: unknown;
}

export type ObjectStorageCommand =
  | (ObjectStorageBaseCommand & {
      readonly kind: "put";
      readonly key: string;
      readonly body: ObjectStorageBody;
      readonly contentType?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    })
  | (ObjectStorageBaseCommand & {
      readonly kind: "get" | "head" | "delete";
      readonly key: string;
    })
  | (ObjectStorageBaseCommand & {
      readonly kind: "list";
      readonly prefix?: string;
      readonly limit?: number;
      readonly cursor?: string;
    });

export type ObjectStorageResult =
  | {
      readonly kind: "put";
      readonly key: string;
      readonly size: number;
      readonly etag: string;
    }
  | {
      readonly kind: "get";
      readonly key: string;
      readonly object: ObjectStorageObject | null;
    }
  | {
      readonly kind: "head";
      readonly key: string;
      readonly object: ObjectStorageMetadata | null;
    }
  | {
      readonly kind: "delete";
      readonly key: string;
      readonly deleted: boolean;
    }
  | {
      readonly kind: "list";
      readonly prefix: string;
      readonly keys: readonly string[];
      readonly truncated: boolean;
      readonly cursor?: string;
    };

export interface ObjectStorageModule {
  execute(command: ObjectStorageCommand): Promise<ObjectStorageResult>;
}

export type ObjectStorageErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "provider_unavailable"
  | "provider_invalid_response";

export class ObjectStorageError extends Error {
  constructor(
    readonly code: ObjectStorageErrorCode,
    readonly status: number = statusFor(code),
  ) {
    super(code);
    this.name = "ObjectStorageError";
  }
}

export interface CreateObjectStorageModuleOptions {
  readonly verifier: RuntimeGrantVerifier;
  readonly adapter: ObjectStorageAdapter;
  readonly maxObjectBytes?: number;
  readonly maxKeyBytes?: number;
  readonly maxMetadataEntries?: number;
  readonly maxMetadataValueBytes?: number;
  readonly maxListEntries?: number;
  readonly maxRequestBytes?: number;
}

export interface ObjectStorageIntentInput {
  readonly operation: ObjectStorageOperation;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly key?: string;
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly bodyDigest?: `sha256:${string}`;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function objectStorageIntent(input: ObjectStorageIntentInput): Record<string, unknown> {
  const operation = operationValue(input.operation);
  const tenantRef = reference(input.tenantRef, "tenant reference");
  const resourceRef = reference(input.resourceRef, "resource reference");
  const intent: Record<string, unknown> = { operation, tenantRef, resourceRef };
  if (input.key !== undefined) intent.key = objectKey(input.key, "object key");
  if (input.prefix !== undefined) intent.prefix = objectPrefix(input.prefix);
  if (input.limit !== undefined) intent.limit = listLimit(input.limit, 1_000);
  if (input.cursor !== undefined) intent.cursor = cursorValue(input.cursor);
  if (input.bodyDigest !== undefined) intent.bodyDigest = digestValue(input.bodyDigest);
  if (input.contentType !== undefined) intent.contentType = contentType(input.contentType);
  if (input.metadata !== undefined) intent.metadata = metadata(input.metadata, 64, 4_096);
  return intent;
}

export async function objectStorageBodyDigest(
  body: ArrayBuffer | Uint8Array,
): Promise<`sha256:${string}`> {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

export function createObjectStorageModule(
  options: CreateObjectStorageModuleOptions,
): ObjectStorageModule {
  if (!options.verifier || typeof options.verifier.verifyAndConsume !== "function") {
    throw new TypeError("runtime grant verifier is required");
  }
  if (!options.adapter || typeof options.adapter.put !== "function") {
    throw new TypeError("object storage adapter is required");
  }
  const limits = storageLimits(options);

  return {
    async execute(command): Promise<ObjectStorageResult> {
      const normalized = await normalizeCommand(command, limits);
      const intent = intentForCommand(normalized);
      if (byteLength(canonicalJson(intent)) > limits.maxRequestBytes) {
        throw new ObjectStorageError("request_too_large");
      }
      const intentDigest = await executionIntentDigest(intent);
      await options.verifier.verifyAndConsume(normalized.grantToken, {
        operation: "s3.access",
        tenantRef: normalized.tenantRef,
        intentDigest,
      });

      const scoped =
        normalized.kind === "list"
          ? scopedPrefix(normalized.tenantRef, normalized.resourceRef, normalized.prefix)
          : scopedKey(normalized.tenantRef, normalized.resourceRef, normalized.key);
      switch (normalized.kind) {
        case "put": {
          const receipt = await adapterCall(() =>
            options.adapter.put({
              key: scoped,
              body: normalized.body,
              ...(normalized.contentType ? { contentType: normalized.contentType } : {}),
              ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
            }),
          );
          return { kind: "put", key: normalized.key, size: receipt.size, etag: receipt.etag };
        }
        case "get": {
          const object = await adapterCall(() => options.adapter.get(scoped));
          return {
            kind: "get",
            key: normalized.key,
            object: object
              ? {
                  ...metadataResult(object, normalized.key),
                  body: boundedStream(object.body, limits.maxObjectBytes),
                }
              : null,
          };
        }
        case "head": {
          const object = await adapterCall(() => options.adapter.head(scoped));
          return {
            kind: "head",
            key: normalized.key,
            object: object ? metadataResult(object, normalized.key) : null,
          };
        }
        case "delete": {
          const deleted = await adapterCall(() => options.adapter.delete(scoped));
          return { kind: "delete", key: normalized.key, deleted };
        }
        case "list": {
          const page = await adapterCall(() =>
            options.adapter.list({
              prefix: scopedPrefix(normalized.tenantRef, normalized.resourceRef, normalized.prefix),
              limit: normalized.limit,
              ...(normalized.cursor ? { cursor: normalized.cursor } : {}),
            }),
          );
          const scope = `${normalized.tenantRef}/${normalized.resourceRef}/`;
          const keys = page.objects
            .map((object) => object.key)
            .filter((key) => key.startsWith(scope))
            .map((key) => key.slice(scope.length));
          return {
            kind: "list",
            prefix: normalized.prefix,
            keys,
            truncated: page.truncated,
            ...(page.cursor ? { cursor: page.cursor } : {}),
          };
        }
      }
    },
  };
}

interface NormalizedPutCommand {
  readonly kind: "put";
  readonly grantToken: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly key: string;
  readonly body: ArrayBuffer;
  readonly bodyDigest: `sha256:${string}`;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface NormalizedKeyCommand {
  readonly kind: "get" | "head" | "delete";
  readonly grantToken: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly key: string;
}

interface NormalizedListCommand {
  readonly kind: "list";
  readonly grantToken: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly prefix: string;
  readonly limit: number;
  readonly cursor?: string;
}

type NormalizedCommand = NormalizedPutCommand | NormalizedKeyCommand | NormalizedListCommand;

async function normalizeCommand(
  command: ObjectStorageCommand,
  limits: StorageLimits,
): Promise<NormalizedCommand> {
  const grantToken = nonEmpty(command.grantToken, "grant token", 16_384);
  const tenantRef = reference(command.tenantRef, "tenant reference");
  const resourceRef = reference(command.resourceRef, "resource reference");
  if (command.kind === "put") {
    const key = objectKey(command.key, "object key", limits.maxKeyBytes);
    const contentType =
      command.contentType === undefined ? undefined : contentTypeValue(command.contentType);
    const metadataValue =
      command.metadata === undefined
        ? undefined
        : metadata(command.metadata, limits.maxMetadataEntries, limits.maxMetadataValueBytes);
    const body = await bodyBytes(command.body, limits.maxObjectBytes);
    const bodyDigest = await objectStorageBodyDigest(body);
    const expected = objectStorageIntent({
      operation: "put",
      tenantRef,
      resourceRef,
      key,
      bodyDigest,
      ...(contentType ? { contentType } : {}),
      ...(metadataValue ? { metadata: metadataValue } : {}),
    });
    assertExplicitIntent(command.intent, expected);
    return {
      kind: "put",
      grantToken,
      tenantRef,
      resourceRef,
      key,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      bodyDigest,
      ...(contentType ? { contentType } : {}),
      ...(metadataValue ? { metadata: metadataValue } : {}),
    };
  }
  if (command.kind === "list") {
    const prefix =
      command.prefix === undefined ? "" : objectPrefix(command.prefix, limits.maxKeyBytes);
    const limit = listLimit(command.limit ?? limits.maxListEntries, limits.maxListEntries);
    const cursor = command.cursor === undefined ? undefined : cursorValue(command.cursor);
    const expected = objectStorageIntent({
      operation: "list",
      tenantRef,
      resourceRef,
      prefix,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    assertExplicitIntent(command.intent, expected);
    return {
      kind: "list",
      grantToken,
      tenantRef,
      resourceRef,
      prefix,
      limit,
      ...(cursor ? { cursor } : {}),
    };
  }
  const key = objectKey(command.key, "object key", limits.maxKeyBytes);
  const expected = objectStorageIntent({ operation: command.kind, tenantRef, resourceRef, key });
  assertExplicitIntent(command.intent, expected);
  return { kind: command.kind, grantToken, tenantRef, resourceRef, key };
}

function intentForCommand(command: NormalizedCommand): Record<string, unknown> {
  if (command.kind === "put") {
    return objectStorageIntent({
      operation: "put",
      tenantRef: command.tenantRef,
      resourceRef: command.resourceRef,
      key: command.key,
      bodyDigest: command.bodyDigest,
      ...(command.contentType ? { contentType: command.contentType } : {}),
      ...(command.metadata ? { metadata: command.metadata } : {}),
    });
  }
  if (command.kind === "list") {
    return objectStorageIntent({
      operation: "list",
      tenantRef: command.tenantRef,
      resourceRef: command.resourceRef,
      prefix: command.prefix,
      limit: command.limit,
      ...(command.cursor ? { cursor: command.cursor } : {}),
    });
  }
  return objectStorageIntent({
    operation: command.kind,
    tenantRef: command.tenantRef,
    resourceRef: command.resourceRef,
    key: command.key,
  });
}

function assertExplicitIntent(value: unknown, expected: Record<string, unknown>): void {
  if (value === undefined) return;
  if (!isRecord(value) || canonicalJson(value) !== canonicalJson(expected)) {
    throw new ObjectStorageError("invalid_request");
  }
}

interface StorageLimits {
  readonly maxObjectBytes: number;
  readonly maxKeyBytes: number;
  readonly maxMetadataEntries: number;
  readonly maxMetadataValueBytes: number;
  readonly maxListEntries: number;
  readonly maxRequestBytes: number;
}

function storageLimits(options: CreateObjectStorageModuleOptions): StorageLimits {
  const maxObjectBytes = positiveLimit(options.maxObjectBytes ?? 8 * 1024 * 1024, "object bytes");
  const maxKeyBytes = positiveLimit(options.maxKeyBytes ?? 1_024, "key bytes");
  const maxMetadataEntries = positiveLimit(options.maxMetadataEntries ?? 64, "metadata entries");
  const maxMetadataValueBytes = positiveLimit(
    options.maxMetadataValueBytes ?? 4_096,
    "metadata value bytes",
  );
  const maxListEntries = positiveLimit(options.maxListEntries ?? 1_000, "list entries");
  const maxRequestBytes = positiveLimit(
    options.maxRequestBytes ?? maxObjectBytes + 16_384,
    "request bytes",
  );
  return {
    maxObjectBytes,
    maxKeyBytes,
    maxMetadataEntries,
    maxMetadataValueBytes,
    maxListEntries,
    maxRequestBytes,
  };
}

async function bodyBytes(body: ObjectStorageBody, maxBytes: number): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) throw new ObjectStorageError("request_too_large");
    return new Uint8Array(body.slice(0));
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new ObjectStorageError("request_too_large");
    return body.slice();
  }
  if (!isReadableStream(body)) throw new ObjectStorageError("invalid_request");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new ObjectStorageError("invalid_request");
      total += next.value.byteLength;
      if (total > maxBytes) throw new ObjectStorageError("request_too_large");
      chunks.push(next.value.slice());
    }
  } catch (error) {
    if (error instanceof ObjectStorageError) throw error;
    throw new ObjectStorageError("provider_unavailable");
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function boundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  if (!isReadableStream(stream)) throw new ObjectStorageError("provider_invalid_response");
  let total = 0;
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          reader.releaseLock();
          controller.error(new ObjectStorageError("provider_invalid_response"));
          return;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
          reader.releaseLock();
          controller.error(new ObjectStorageError("request_too_large"));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        try {
          reader.releaseLock();
        } catch {
          // The stream may already be unlocked after an upstream failure.
        }
        controller.error(new ObjectStorageError("provider_unavailable"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function metadataResult(
  value: ObjectStorageMetadata | ObjectStorageObject,
  keyOverride = value.key,
): ObjectStorageMetadata {
  return {
    key: keyOverride,
    size: value.size,
    etag: value.etag,
    ...(value.contentType ? { contentType: value.contentType } : {}),
    metadata: { ...value.metadata },
  };
}

async function adapterCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ObjectStorageError) throw error;
    throw new ObjectStorageError("provider_unavailable");
  }
}

function scopedKey(tenantRef: string, resourceRef: string, key: string): string {
  return `${tenantRef}/${resourceRef}/${key}`;
}

function scopedPrefix(tenantRef: string, resourceRef: string, prefix: string): string {
  return `${tenantRef}/${resourceRef}/${prefix}`;
}

function statusFor(code: ObjectStorageErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "request_too_large":
      return 413;
    case "provider_invalid_response":
      return 502;
    case "provider_unavailable":
      return 503;
  }
}

function operationValue(value: string): ObjectStorageOperation {
  if (
    value === "put" ||
    value === "get" ||
    value === "head" ||
    value === "delete" ||
    value === "list"
  ) {
    return value;
  }
  throw new ObjectStorageError("invalid_request");
}

function reference(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) {
    throw new ObjectStorageError("invalid_request");
  }
  void label;
  return value;
}

function nonEmpty(value: string, _label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function objectKey(value: string, _label: string, maxBytes = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > maxBytes ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function objectPrefix(value: string, maxBytes = 1_024): string {
  if (
    typeof value !== "string" ||
    byteLength(value) > maxBytes ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    throw new ObjectStorageError("invalid_request");
  }
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function cursorValue(value: string): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > 1_024) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function listLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new ObjectStorageError("invalid_request");
  return value;
}

function contentTypeValue(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > 256 ||
    /[\r\n]/u.test(value)
  ) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function metadata(
  value: Readonly<Record<string, string>>,
  maxEntries: number,
  maxValueBytes: number,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new ObjectStorageError("invalid_request");
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw new ObjectStorageError("request_too_large");
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(key) || typeof entry !== "string") {
      throw new ObjectStorageError("invalid_request");
    }
    if (byteLength(entry) > maxValueBytes || /[\r\n]/u.test(entry)) {
      throw new ObjectStorageError("request_too_large");
    }
    result[key] = entry;
  }
  return result;
}

function contentType(value: string): string {
  return contentTypeValue(value);
}

function digestValue(value: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new ObjectStorageError("invalid_request");
  }
  return value as `sha256:${string}`;
}

function positiveLimit(value: number, _label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("storage limit is invalid");
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === "function"
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly metadata: ObjectStorageMetadata;
}

export class InMemoryObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #objects = new Map<string, StoredObject>();

  async put(input: {
    readonly key: string;
    readonly body: ArrayBuffer;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<ObjectStorageMetadata> {
    const bytes = new Uint8Array(input.body.slice(0));
    const etag = await objectStorageBodyDigest(bytes);
    const value: ObjectStorageMetadata = {
      key: input.key,
      size: bytes.byteLength,
      etag,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      metadata: { ...(input.metadata ?? {}) },
    };
    this.#objects.set(input.key, { bytes, metadata: value });
    return metadataResult(value);
  }

  async get(key: string): Promise<ObjectStorageObject | null> {
    const stored = this.#objects.get(key);
    if (!stored) return null;
    return {
      ...metadataResult(stored.metadata),
      body: streamFromBytes(stored.bytes),
    };
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    const stored = this.#objects.get(key);
    return stored ? metadataResult(stored.metadata) : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.#objects.delete(key);
  }

  async list(input: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<ObjectStorageListPage> {
    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(input.prefix)).sort();
    const start = input.cursor === undefined ? 0 : cursorIndex(input.cursor, keys.length);
    const selected = keys.slice(start, start + input.limit);
    const next =
      start + selected.length < keys.length ? String(start + selected.length) : undefined;
    return {
      objects: selected.map((key) => {
        const stored = this.#objects.get(key);
        if (!stored) throw new ObjectStorageError("provider_invalid_response");
        return metadataResult(stored.metadata);
      }),
      truncated: next !== undefined,
      ...(next ? { cursor: next } : {}),
    };
  }

  size(): number {
    return this.#objects.size;
  }
}

function cursorIndex(value: string, length: number): number {
  if (!/^\d+$/u.test(value)) throw new ObjectStorageError("invalid_request");
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > length)
    throw new ObjectStorageError("invalid_request");
  return index;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = bytes.slice();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

export interface CloudflareR2BucketBinding {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
    },
  ): Promise<CloudflareR2ObjectLike>;
  get(key: string): Promise<CloudflareR2ObjectBodyLike | null>;
  head(key: string): Promise<CloudflareR2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<CloudflareR2ListResult>;
}

export interface CloudflareR2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface CloudflareR2ObjectBodyLike extends CloudflareR2ObjectLike {
  readonly body: ReadableStream<Uint8Array>;
}

export interface CloudflareR2ListResult {
  readonly objects: readonly CloudflareR2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export class CloudflareR2ObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #binding: CloudflareR2BucketBinding;

  constructor(binding: CloudflareR2BucketBinding) {
    if (
      !binding ||
      typeof binding.put !== "function" ||
      typeof binding.get !== "function" ||
      typeof binding.head !== "function" ||
      typeof binding.delete !== "function" ||
      typeof binding.list !== "function"
    ) {
      throw new TypeError("Cloudflare R2 binding is required");
    }
    this.#binding = binding;
  }

  async put(input: {
    readonly key: string;
    readonly body: ArrayBuffer;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<ObjectStorageMetadata> {
    try {
      const object = await this.#binding.put(input.key, input.body, {
        ...(input.contentType ? { httpMetadata: { contentType: input.contentType } } : {}),
        ...(input.metadata ? { customMetadata: input.metadata } : {}),
      });
      return r2Metadata(
        object,
        input.key,
        input.body.byteLength,
        input.contentType,
        input.metadata,
      );
    } catch {
      throw new ObjectStorageError("provider_unavailable");
    }
  }

  async get(key: string): Promise<ObjectStorageObject | null> {
    try {
      const object = await this.#binding.get(key);
      if (object === null) return null;
      if (!isReadableStream(object.body)) throw new ObjectStorageError("provider_invalid_response");
      return {
        ...r2Metadata(object, key, object.size),
        body: object.body,
      };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw new ObjectStorageError("provider_unavailable");
    }
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    try {
      const object = await this.#binding.head(key);
      return object ? r2Metadata(object, key, object.size) : null;
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw new ObjectStorageError("provider_unavailable");
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const existing = await this.#binding.head(key);
      await this.#binding.delete(key);
      return existing !== null;
    } catch {
      throw new ObjectStorageError("provider_unavailable");
    }
  }

  async list(input: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<ObjectStorageListPage> {
    try {
      const page = await this.#binding.list({
        prefix: input.prefix,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        objects: page.objects.map((object) => r2Metadata(object, object.key, object.size)),
        truncated: page.truncated,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw new ObjectStorageError("provider_unavailable");
    }
  }
}

function r2Metadata(
  object: CloudflareR2ObjectLike,
  fallbackKey: string,
  _fallbackSize: number,
  fallbackContentType?: string,
  fallbackMetadata?: Readonly<Record<string, string>>,
): ObjectStorageMetadata {
  if (
    typeof object.key !== "string" ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    typeof object.etag !== "string" ||
    object.etag.length === 0
  ) {
    throw new ObjectStorageError("provider_invalid_response");
  }
  const objectContentType = object.httpMetadata?.contentType ?? fallbackContentType;
  return {
    key: object.key || fallbackKey,
    size: object.size,
    etag: object.etag,
    ...(objectContentType ? { contentType: objectContentType } : {}),
    metadata: { ...(object.customMetadata ?? fallbackMetadata ?? {}) },
  };
}
