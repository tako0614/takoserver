import { sha256 } from "@noble/hashes/sha2.js";
import {
  DockerContainerCreateCustodyError,
  type DockerContainerCreateSession,
} from "./docker-container-create-custody.ts";

/** Host-private budgets. These are not Container Form fields or an authority grant. */
export interface DockerImageSupplyLimits {
  readonly maxManifestBytes: number;
  readonly maxConfigBytes: number;
  readonly maxLayerCompressedBytes: number;
  readonly maxTotalCompressedBytes: number;
  readonly maxLayerExpandedBytes: number;
  readonly maxTotalExpandedBytes: number;
  readonly maxExpansionRatio: number;
  readonly maxLayers: number;
  readonly maxIndexEntries: number;
  readonly maxArchiveBytes: number;
  /** Logical retained payload, not an assertion about allocator RSS or disk capacity. */
  readonly maxRetainedBytes: number;
  readonly maxDurationMs: number;
}

/** The Host supplies a concrete origin/peer/TLS-controlled transport. There is no
 * global fetch fallback, credential field, redirect-following or tenant header.
 * The supplier checks actual returned bytes; this port does not attest admission.
 */
export interface DockerImageSourcePort {
  readonly origin: string;
  read(request: Request): Promise<Response>;
  /** Consume all compressed bytes and emit actual expanded bytes. A concrete
   * gzip/zstd codec must be qualified separately; no codec-success boolean exists.
   */
  expand(
    codec: "gzip" | "zstd",
    compressed: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array>;
}

export interface DockerRetainedImageArchive {
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly archiveDigest: string;
  readonly archiveBytes: number;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  /** OCI-layout tar; available only while the ORIGINAL custody callback is held.
   * This is verified image data, never a native CREATE/START or support receipt.
   */
  open(): ReadableStream<Uint8Array>;
}

export class DockerImageSupplyError extends DockerContainerCreateCustodyError {
  constructor(code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerImageSupplyError";
  }
}

const MANIFESTS = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const INDEXES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const CONFIGS = [
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
];
const LAYERS: Readonly<Record<string, "tar" | "gzip" | "zstd">> = {
  "application/vnd.oci.image.layer.v1.tar": "tar",
  "application/vnd.oci.image.layer.v1.tar+gzip": "gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd": "zstd",
  "application/vnd.oci.image.layer.nondistributable.v1.tar": "tar",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip": "gzip",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd": "zstd",
  "application/vnd.docker.image.rootfs.diff.tar.gzip": "gzip",
  "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip": "gzip",
};
const LIMIT_NAMES = [
  "maxManifestBytes",
  "maxConfigBytes",
  "maxLayerCompressedBytes",
  "maxTotalCompressedBytes",
  "maxLayerExpandedBytes",
  "maxTotalExpandedBytes",
  "maxExpansionRatio",
  "maxLayers",
  "maxIndexEntries",
  "maxArchiveBytes",
  "maxRetainedBytes",
  "maxDurationMs",
] as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const utf8 = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const chunkLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const chunkOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const chunkBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const chunkKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const MAX_EMPTY_READS = 64;

function fail(code: "invalid_request" | "conflict" | "unavailable" = "conflict"): never {
  throw new DockerImageSupplyError(code);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sum(a: number, b: number, limit: number): number {
  if (!integer(a) || !integer(b) || a > limit || b > limit - a) return fail();
  return a + b;
}
function digest(bytes: Uint8Array): string {
  return `sha256:${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
function limitsSnapshot(source: DockerImageSupplyLimits): DockerImageSupplyLimits {
  if (!object(source) || Reflect.ownKeys(source).length !== LIMIT_NAMES.length)
    return fail("invalid_request");
  const values: Record<string, number> = {};
  for (const key of LIMIT_NAMES) {
    if (!Object.hasOwn(source, key)) return fail("invalid_request");
    const value = source[key];
    if (!integer(value) || value < 1) return fail("invalid_request");
    values[key] = value;
  }
  if (values.maxDurationMs! > 2_147_483_647) return fail("invalid_request");
  return Object.freeze(values) as unknown as DockerImageSupplyLimits;
}

/** I-JSON reader: fatal UTF-8, bounded nesting/nodes, duplicate-key rejection.
 * It never prints source image JSON (which may contain baked-in configuration).
 */
function json(bytes: ArrayBuffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/^[\t\n\r ]$/u.test(text[offset] ?? "")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        const decoded = JSON.parse(text.slice(start, offset)) as string;
        for (const scalar of decoded) {
          const point = scalar.codePointAt(0)!;
          if (point >= 0xd800 && point <= 0xdfff) return fail();
        }
        return decoded;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64 || ++nodes > 100_000) return fail();
    whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      offset++;
      const map: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const list: unknown[] = [];
      const keys = new Set<string>();
      const close = char === "{" ? "}" : "]";
      whitespace();
      if (text[offset] === close) {
        offset++;
        return char === "{" ? map : list;
      }
      for (;;) {
        whitespace();
        if (char === "{") {
          if (text[offset] !== '"') return fail();
          const key = string();
          if (keys.has(key)) return fail();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ":") return fail();
          map[key] = value(depth + 1);
        } else list.push(value(depth + 1));
        whitespace();
        const end = text[offset++];
        if (end === close) return char === "{" ? map : list;
        if (end !== ",") return fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      text.slice(offset),
    );
    if (!token) return fail();
    offset += token[0].length;
    const parsed = JSON.parse(token[0]) as unknown;
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return fail();
    return parsed;
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) return fail();
  return result;
}

interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}
function descriptor(input: unknown, cap: number): Descriptor {
  if (
    !object(input) ||
    typeof input.mediaType !== "string" ||
    typeof input.digest !== "string" ||
    input.digest.length !== 71 ||
    !DIGEST.test(input.digest) ||
    !integer(input.size) ||
    input.size > cap ||
    (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length !== 0))
  )
    return fail();
  return Object.freeze({ mediaType: input.mediaType, digest: input.digest, size: input.size });
}
function reference(image: string, selectedOrigin: string) {
  const match =
    /^([a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?)\/([a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/u.exec(
      image,
    );
  if (!match || image.length > 512) return fail("invalid_request");
  const origin = new URL(`https://${match[1]}`).origin;
  if (origin !== selectedOrigin || new URL(selectedOrigin).origin !== selectedOrigin)
    return fail("invalid_request");
  return { origin, repository: match[2]!, sourceDigest: match[3]! };
}

/** Callback-scoped, bounded verified source. Initial unit only: no Docker request,
 * accepted-owner minting, durable archive store, public Form wiring or native
 * compatibility claim. The next driver hook must keep this ORIGINAL session
 * through import/unknown-ACK reconciliation and persist retained custody.
 */
export async function withDockerRetainedImageArchive<T>(
  session: DockerContainerCreateSession,
  options: {
    readonly image: string;
    readonly limits: DockerImageSupplyLimits;
    readonly source: DockerImageSourcePort;
  },
  use: (archive: DockerRetainedImageArchive) => Promise<T>,
): Promise<T> {
  const originalGuard = session.guard.bind(session);
  const originalSignal = session.signal;
  const image = options.image;
  const limits = limitsSnapshot(options.limits);
  const port = options.source;
  const origin = port.origin;
  const read = port.read.bind(port);
  const expand = port.expand.bind(port);
  const selected = reference(image, origin);
  if (!(originalSignal instanceof AbortSignal) || typeof use !== "function")
    return fail("invalid_request");
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  originalSignal.addEventListener("abort", abort, { once: true });
  if (originalSignal.aborted) abort();
  const now = performance.now.bind(performance);
  const began = now();
  const timer = setTimeout(abort, limits.maxDurationMs);
  let active = true;
  let compressedBytes = 0;
  let expandedBytes = 0;
  let retainedBytes = 0;
  const openReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const outputTasks = new Set<Promise<void>>();
  let outputFailed = false;
  const trackOutput = (task: Promise<void>) => {
    outputTasks.add(task);
    void task.finally(() => outputTasks.delete(task)).catch(() => undefined);
    return task;
  };
  const checkLifetime = () => {
    if (!active || cancellation.signal.aborted) return fail("unavailable");
    const elapsed = now() - began;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= limits.maxDurationMs) {
      cancellation.abort();
      return fail("unavailable");
    }
  };
  const guard = async () => {
    checkLifetime();
    await originalGuard();
    checkLifetime();
  };
  async function consume(
    stream: ReadableStream<Uint8Array>,
    cap: number,
    retain: boolean,
    expectedSize?: number,
    expectedDigest?: string,
    expandedCompressedSize?: number,
  ) {
    const reader = stream.getReader();
    const hash = sha256.create();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    let emptyReads = 0;
    let cancelled: Promise<void> | undefined;
    const cancel = () => {
      cancelled ??= reader.cancel();
      void cancelled.catch(() => undefined);
    };
    openReaders.add(reader);
    cancellation.signal.addEventListener("abort", cancel, { once: true });
    if (cancellation.signal.aborted) cancel();
    try {
      for (;;) {
        await guard();
        const next = await reader.read();
        await guard();
        if (next.done) break;
        const chunk = next.value;
        if (chunkKind.call(chunk) !== "Uint8Array") return fail();
        const length = chunkLength.call(chunk) as number;
        if (length === 0) {
          if (++emptyReads > MAX_EMPTY_READS) return fail();
          continue;
        }
        emptyReads = 0;
        const nextSize = sum(size, length, Math.min(cap, expectedSize ?? cap));
        if (retain) {
          sum(compressedBytes, length, limits.maxTotalCompressedBytes);
          sum(retainedBytes, length, limits.maxRetainedBytes);
        } else {
          sum(expandedBytes, length, limits.maxTotalExpandedBytes);
          if (nextSize / Math.max(1, expandedCompressedSize ?? nextSize) > limits.maxExpansionRatio)
            return fail();
        }
        // Check all budgets before copying. The fixed-length view avoids reading
        // an overridden length/iterator or copying a later-grown source view.
        const buffer = chunkBuffer.call(chunk) as ArrayBufferLike;
        const offset = chunkOffset.call(chunk) as number;
        const bytes = new Uint8Array(new Uint8Array(buffer, offset, length));
        checkLifetime();
        size = nextSize;
        if (retain) {
          compressedBytes += length;
          retainedBytes += length;
          chunks.push(bytes);
        } else expandedBytes += length;
        hash.update(bytes);
      }
      const actualDigest = digest(hash.digest());
      if (
        (expectedSize !== undefined && size !== expectedSize) ||
        (expectedDigest !== undefined && actualDigest !== expectedDigest)
      )
        return fail();
      return { blob: new Blob(chunks), size, digest: actualDigest };
    } catch (error) {
      cancel();
      throw error;
    } finally {
      cancellation.signal.removeEventListener("abort", cancel);
      if (cancelled) await cancelled;
      reader.releaseLock();
      openReaders.delete(reader);
    }
  }
  const blobs = new Map<string, Blob>();
  async function acquire(
    kind: "manifests" | "blobs",
    expected: { digest: string; size?: number },
    cap: number,
  ) {
    const prior = blobs.get(expected.digest);
    if (prior) {
      if (expected.size !== undefined && prior.size !== expected.size) return fail();
      return prior;
    }
    await guard();
    const url = `${selected.origin}/v2/${selected.repository}/${kind}/${expected.digest}`;
    const response = await read(
      new Request(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: cancellation.signal,
        headers: {
          accept: [...MANIFESTS, ...INDEXES, ...CONFIGS, "application/octet-stream"].join(", "),
        },
      }),
    );
    try {
      await guard();
      if (response.status !== 200 || response.redirected || response.url !== url || !response.body)
        return fail();
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^[0-9]+$/u.test(length) ||
          !integer(Number(length)) ||
          Number(length) > cap ||
          (expected.size !== undefined && Number(length) !== expected.size))
      )
        return fail();
      const result = await consume(response.body, cap, true, expected.size, expected.digest);
      blobs.set(expected.digest, result.blob);
      return result.blob;
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }
  let completedResult: T;
  let cleanupFailed = false;
  try {
    await guard();
    const rootBlob = await acquire(
      "manifests",
      { digest: selected.sourceDigest },
      limits.maxManifestBytes,
    );
    let manifestBlob = rootBlob;
    let manifestDigest = selected.sourceDigest;
    let manifest = json(await rootBlob.arrayBuffer());
    await guard();
    if (!object(manifest) || manifest.schemaVersion !== 2 || typeof manifest.mediaType !== "string")
      return fail();
    if (INDEXES.includes(manifest.mediaType)) {
      if (!Array.isArray(manifest.manifests) || manifest.manifests.length > limits.maxIndexEntries)
        return fail();
      const candidates: Descriptor[] = [];
      for (const item of manifest.manifests) {
        const entry = descriptor(item, limits.maxManifestBytes);
        if (!object(item) || !object(item.platform)) continue;
        if (
          item.platform.os === "linux" &&
          item.platform.architecture === "amd64" &&
          item.platform.variant === undefined
        ) {
          if (!MANIFESTS.includes(entry.mediaType)) return fail();
          candidates.push(entry);
        }
      }
      if (candidates.length !== 1) return fail();
      const entry = candidates[0]!;
      manifestDigest = entry.digest;
      manifestBlob = await acquire("manifests", entry, limits.maxManifestBytes);
      manifest = json(await manifestBlob.arrayBuffer());
      await guard();
      if (
        !object(manifest) ||
        manifest.schemaVersion !== 2 ||
        manifest.mediaType !== entry.mediaType
      )
        return fail();
    }
    if (
      !object(manifest) ||
      typeof manifest.mediaType !== "string" ||
      !MANIFESTS.includes(manifest.mediaType) ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length > limits.maxLayers
    )
      return fail();
    const config = descriptor(manifest.config, limits.maxConfigBytes);
    if (!CONFIGS.includes(config.mediaType)) return fail();
    const layers = manifest.layers.map((entry) =>
      descriptor(entry, limits.maxLayerCompressedBytes),
    );
    let declared = sum(compressedBytes, config.size, limits.maxTotalCompressedBytes);
    for (const layer of layers) {
      if (!Object.hasOwn(LAYERS, layer.mediaType)) return fail();
      declared = sum(declared, layer.size, limits.maxTotalCompressedBytes);
    }
    const configBlob = await acquire("blobs", config, limits.maxConfigBytes);
    const configuration = json(await configBlob.arrayBuffer());
    await guard();
    if (
      !object(configuration) ||
      configuration.os !== "linux" ||
      configuration.architecture !== "amd64" ||
      !object(configuration.rootfs) ||
      configuration.rootfs.type !== "layers" ||
      !Array.isArray(configuration.rootfs.diff_ids) ||
      configuration.rootfs.diff_ids.length !== layers.length ||
      configuration.rootfs.diff_ids.some(
        (id) => typeof id !== "string" || id.length !== 71 || !DIGEST.test(id),
      )
    )
      return fail();
    for (const [index, layer] of layers.entries()) {
      const compressed = await acquire("blobs", layer, limits.maxLayerCompressedBytes);
      await guard();
      const codec = LAYERS[layer.mediaType];
      const stream =
        codec === "tar"
          ? compressed.stream()
          : expand(codec === "gzip" ? "gzip" : "zstd", compressed.stream(), cancellation.signal);
      await consume(
        stream,
        limits.maxLayerExpandedBytes,
        false,
        undefined,
        configuration.rootfs.diff_ids[index] as string,
        compressed.size,
      );
    }
    await guard();
    const index = utf8.encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: INDEXES[0],
        manifests: [
          {
            mediaType: manifest.mediaType,
            digest: manifestDigest,
            size: manifestBlob.size,
            platform: { os: "linux", architecture: "amd64" },
          },
        ],
      }),
    );
    const entries: [string, Blob][] = [
      ["oci-layout", new Blob([utf8.encode('{"imageLayoutVersion":"1.0.0"}')])],
      ["index.json", new Blob([index])],
      ...[...blobs].map(([id, blob]): [string, Blob] => [`blobs/sha256/${id.slice(7)}`, blob]),
    ];
    const parts: BlobPart[] = [];
    let archiveBytes = 0;
    const append = (part: BlobPart, size: number) => {
      archiveBytes = sum(archiveBytes, size, limits.maxArchiveBytes);
      sum(retainedBytes, archiveBytes, limits.maxRetainedBytes);
      parts.push(part);
    };
    for (const [name, blob] of entries) {
      if (blob.size > 0o77777777777) {
        let record = ` size=${blob.size}\n`;
        let length = record.length + 1;
        while (String(length).length + record.length !== length)
          length = String(length).length + record.length;
        record = `${length}${record}`;
        const bytes = utf8.encode(record);
        append(tarHeader("PaxHeaders/size", bytes.length, "x"), 512);
        append(bytes, bytes.length);
        const padding = new Uint8Array((512 - (bytes.length % 512)) % 512);
        append(padding, padding.length);
      }
      append(tarHeader(name, blob.size > 0o77777777777 ? 0 : blob.size, "0"), 512);
      append(blob, blob.size);
      const padding = new Uint8Array((512 - (blob.size % 512)) % 512);
      append(padding, padding.length);
    }
    append(new Uint8Array(1024), 1024);
    const archive = new Blob(parts, { type: "application/x-tar" });
    const archiveHash = sha256.create();
    const verifier = archive.stream().getReader();
    try {
      for (;;) {
        await guard();
        const next = await verifier.read();
        await guard();
        if (next.done) break;
        archiveHash.update(next.value);
      }
    } finally {
      await verifier.cancel();
      verifier.releaseLock();
    }
    const archiveDigest = digest(archiveHash.digest());
    await guard();
    const retained: DockerRetainedImageArchive = Object.freeze({
      sourceDigest: selected.sourceDigest,
      manifestDigest,
      configDigest: config.digest,
      archiveDigest,
      archiveBytes,
      compressedBytes,
      expandedBytes,
      open() {
        checkLifetime();
        const reader = archive.stream().getReader();
        openReaders.add(reader);
        return new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              return trackOutput(
                (async () => {
                  try {
                    await guard();
                    const next = await reader.read();
                    await guard();
                    if (next.done) {
                      openReaders.delete(reader);
                      reader.releaseLock();
                      controller.close();
                    } else controller.enqueue(next.value);
                  } catch {
                    outputFailed = true;
                    await reader.cancel();
                    openReaders.delete(reader);
                    reader.releaseLock();
                    controller.error(new DockerImageSupplyError("unavailable"));
                  }
                })(),
              );
            },
            cancel() {
              return trackOutput(
                (async () => {
                  await reader.cancel();
                  openReaders.delete(reader);
                  reader.releaseLock();
                })(),
              );
            },
          },
          { highWaterMark: 0 },
        );
      },
    });
    completedResult = await use(retained);
    await guard();
  } catch (error) {
    if (error instanceof DockerContainerCreateCustodyError) throw error;
    return fail("unavailable");
  } finally {
    active = false;
    cancellation.abort();
    clearTimeout(timer);
    originalSignal.removeEventListener("abort", abort);
    const cleanup = await Promise.allSettled(
      [...openReaders].map(async (reader) => {
        await reader.cancel();
        reader.releaseLock();
      }),
    );
    openReaders.clear();
    while (outputTasks.size) await Promise.allSettled([...outputTasks]);
    cleanupFailed = outputFailed || cleanup.some((result) => result.status === "rejected");
  }
  if (cleanupFailed) throw new DockerImageSupplyError("unavailable");
  return completedResult;
}

function tarHeader(name: string, size: number, type: "0" | "x"): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  const put = (offset: number, length: number, text: string) => {
    const bytes = utf8.encode(text);
    if (bytes.length > length) return fail();
    header.set(bytes, offset);
  };
  put(0, 100, name);
  put(100, 8, "0000600\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, 12, "00000000000\0");
  put(148, 8, "        ");
  put(156, 1, type);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  const checksum = header.reduce((total, value) => total + value, 0);
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}
