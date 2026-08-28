/**
 * Portable Form Package bounds copied from Takoform Core's verifier.
 *
 * These are format limits, not a product-specific admission policy. Keep the
 * values in one package-scoped module so every package reader/import path uses
 * the same contract.
 */
export const FORM_PACKAGE_LIMITS = {
  indexBytes: 4 << 20,
  definitionBytes: 4 << 20,
  jsonPayloadBytes: 16 << 20,
  payloadBytes: 64 << 20,
  packagePayloadBytes: 256 << 20,
  files: 1024,
} as const;

export const FORM_DEFINITION_MEDIA_TYPE =
  "application/vnd.takoform.form-definition.v1+json" as const;

/** Core treats all JSON media types as JSON payloads before the definition override. */
export function isFormPackageJsonMediaType(mediaType: string | undefined): boolean {
  return (
    mediaType === "application/json" ||
    mediaType === "application/schema+json" ||
    mediaType?.endsWith("+json") === true
  );
}

/** Return the exact Core payload cap for a declared media type. */
export function formPackagePayloadLimit(mediaType: string | undefined): number {
  if (mediaType === FORM_DEFINITION_MEDIA_TYPE) return FORM_PACKAGE_LIMITS.definitionBytes;
  if (isFormPackageJsonMediaType(mediaType)) return FORM_PACKAGE_LIMITS.jsonPayloadBytes;
  return FORM_PACKAGE_LIMITS.payloadBytes;
}

/**
 * Validate all numeric file declarations before any payload object is opened.
 * A null result means a count, per-file, total, or declaration bound failed.
 */
export function formPackagePayloadTotal(files: readonly unknown[]): number | null {
  if (files.length > FORM_PACKAGE_LIMITS.files) return null;
  let total = 0;
  for (const value of files) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const declaration = value as { readonly size?: unknown; readonly mediaType?: unknown };
    if (
      typeof declaration.size !== "number" ||
      !Number.isSafeInteger(declaration.size) ||
      declaration.size < 0
    ) {
      return null;
    }
    if (declaration.mediaType !== undefined && typeof declaration.mediaType !== "string") {
      return null;
    }
    const limit = formPackagePayloadLimit(
      typeof declaration.mediaType === "string" ? declaration.mediaType : undefined,
    );
    if (
      declaration.size > limit ||
      declaration.size > FORM_PACKAGE_LIMITS.packagePayloadBytes - total
    ) {
      return null;
    }
    total += declaration.size;
  }
  return total;
}

export class FormPackageStreamLimitError extends Error {
  constructor(
    readonly kind: "overrun" | "underrun",
    message: string,
  ) {
    super(message);
    this.name = "FormPackageStreamLimitError";
  }
}

/** Cancel an untrusted body without allowing a broken source to delay refusal. */
export function cancelFormPackageStream(
  stream: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void stream.cancel("Form Package byte bound exceeded").catch(() => undefined);
  } catch {
    // The caller's bound decision is authoritative even if cancellation fails.
  }
}

export interface FormPackageObjectListPage {
  readonly objects: readonly { readonly key: string }[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/**
 * Verify the complete object closure for one runtime package prefix.
 *
 * Object stores are allowed to paginate, but a malformed page, a repeated
 * cursor/object, an extra object, or a missing terminal cursor is a package
 * failure. The bound on pages keeps a broken cursor implementation from
 * turning verification into an unbounded loop.
 */
export async function hasExactFormPackageObjectClosure(
  list: (input: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }) => Promise<FormPackageObjectListPage>,
  prefix: string,
  expectedKeys: ReadonlySet<string>,
): Promise<boolean> {
  if (expectedKeys.size === 0 || expectedKeys.size > FORM_PACKAGE_LIMITS.files + 1) return false;

  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  const maxPages = expectedKeys.size + 1;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (
      !page ||
      !Array.isArray(page.objects) ||
      typeof page.truncated !== "boolean" ||
      page.objects.length > 1_000
    ) {
      return false;
    }
    for (const object of page.objects) {
      if (
        !object ||
        typeof object !== "object" ||
        typeof object.key !== "string" ||
        seenKeys.has(object.key) ||
        !expectedKeys.has(object.key)
      ) {
        return false;
      }
      seenKeys.add(object.key);
    }
    if (!page.truncated) {
      return page.cursor === undefined && seenKeys.size === expectedKeys.size;
    }
    if (typeof page.cursor !== "string" || page.cursor.length === 0) return false;
    if (seenCursors.has(page.cursor)) return false;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  return false;
}

/**
 * Read a package body with a hard byte cap and optional declared-size fence.
 * The reader consumes at most one overrun chunk, never copies that chunk, and
 * cancels the source before returning an error. A declared size is checked at
 * EOF as well, so short streams cannot be accepted as exact payloads.
 */
export async function readBoundedFormPackageStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const size = await boundedFormPackageStreamSize(stream, maxBytes, expectedBytes, (chunk) =>
    chunks.push(chunk),
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Consume a bounded package stream without retaining its bytes. This is used
 * by adapters/tests that need to prove a hard byte fence on a large lazy
 * stream while keeping memory proportional to one source chunk.
 */
export async function drainBoundedFormPackageStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes?: number,
): Promise<number> {
  return await boundedFormPackageStreamSize(stream, maxBytes, expectedBytes);
}

async function boundedFormPackageStreamSize(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes: number | undefined,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<number> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0))
  ) {
    throw new FormPackageStreamLimitError("overrun", "invalid Form Package byte bound");
  }
  if (expectedBytes !== undefined && expectedBytes > maxBytes) {
    throw new FormPackageStreamLimitError(
      "overrun",
      `declared Form Package payload exceeds ${maxBytes} bytes`,
    );
  }

  const reader = stream.getReader();
  const streamLimit = expectedBytes === undefined ? maxBytes : expectedBytes;
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new FormPackageStreamLimitError("overrun", "Form Package stream chunk is invalid");
      }
      if (value.byteLength > streamLimit - size) {
        // Cancellation is best effort. A hostile or broken stream may never
        // settle its cancel promise; the byte-bound failure is authoritative
        // and must be returned without waiting for that promise.
        cancelFormPackageStream(reader);
        throw new FormPackageStreamLimitError(
          "overrun",
          `Form Package stream exceeds ${maxBytes} bytes`,
        );
      }
      onChunk?.(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (expectedBytes !== undefined && size !== expectedBytes) {
    throw new FormPackageStreamLimitError(
      "underrun",
      `Form Package stream ended at ${size} bytes; declared ${expectedBytes}`,
    );
  }

  return size;
}
