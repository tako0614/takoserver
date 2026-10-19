import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  DockerContainerCreateCustodyError,
  type DockerContainerCreateSession,
} from "./docker-container-create-custody.ts";
import {
  type DockerImageSourcePort,
  type DockerImageSupplyLimits,
  type DockerRetainedImageArchive,
  withDockerRetainedImageArchive,
} from "./docker-container-image-supplier.ts";

export interface DockerImageAcquisitionTarget {
  readonly image: string;
  readonly installationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly revision: string;
  readonly identityLabel: string;
  readonly revisionLabel: string;
}

/** An archive handle belongs to one original claim. It is private Host state,
 * never a Form field, acceptance grant, secret loan, or readiness receipt. */
export interface DockerStoredImageArchive {
  readonly claimId: string;
  readonly target: DockerImageAcquisitionTarget;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly archiveDigest: string;
  readonly archiveBytes: number;
  readonly limitsDigest: string;
  open(): ReadableStream<Uint8Array>;
}

export interface DockerImageArchiveOwner {
  /** Must retain and verify bytes durably before returning; callback-local Blobs
   * alone cannot implement this port. The private file owner is supplied below. */
  retain(
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
    archive: DockerRetainedImageArchive,
    limitsDigest: string,
  ): Promise<DockerStoredImageArchive>;
  find(
    target: DockerImageAcquisitionTarget,
    claimId: string,
  ): Promise<DockerStoredImageArchive | null>;
  /** A durable, exclusive BEFORE-POST transition. Existing/uncertain attempts
   * only permit readback; they never authorize another image-load request. */
  beginImport(
    session: DockerContainerCreateSession,
    archive: DockerStoredImageArchive,
  ): Promise<"first" | "readback">;
}

export interface DockerImageImportTransport {
  inspect(
    archive: DockerStoredImageArchive,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<unknown | null>;
  load(
    archive: DockerStoredImageArchive,
    session: DockerContainerCreateSession,
    deadline: number,
  ): Promise<void>;
}

export class DockerImageAcquisitionError extends DockerContainerCreateCustodyError {
  constructor(code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerImageAcquisitionError";
  }
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const LIMIT_KEYS = [
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
function fail(code: "invalid_request" | "conflict" | "unavailable" = "unavailable"): never {
  throw new DockerImageAcquisitionError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function targetSnapshot(value: DockerImageAcquisitionTarget): DockerImageAcquisitionTarget {
  const keys = [
    "image",
    "installationId",
    "resourceUid",
    "incarnationId",
    "revision",
    "identityLabel",
    "revisionLabel",
  ] as const;
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length)
    return fail("invalid_request");
  const result: Record<string, string> = {};
  for (const key of keys) {
    const text = value[key];
    if (
      !Object.hasOwn(value, key) ||
      typeof text !== "string" ||
      text.length < 1 ||
      text.length > 1024
    )
      return fail("invalid_request");
    result[key] = text;
  }
  if (!DIGEST.test(value.identityLabel) || !DIGEST.test(value.revisionLabel))
    return fail("invalid_request");
  return Object.freeze(result) as unknown as DockerImageAcquisitionTarget;
}
function bound(session: DockerContainerCreateSession, target: DockerImageAcquisitionTarget) {
  const intent = session.record.intent;
  for (const key of [
    "installationId",
    "resourceUid",
    "incarnationId",
    "revision",
    "identityLabel",
    "revisionLabel",
  ] as const) {
    if (intent[key] !== target[key]) return fail("conflict");
  }
}
function verifyArchive(
  archive: DockerStoredImageArchive,
  target: DockerImageAcquisitionTarget,
  claimId: string,
  limitsDigest: string,
) {
  if (
    archive.claimId !== claimId ||
    JSON.stringify(targetSnapshot(archive.target)) !== JSON.stringify(target) ||
    archive.limitsDigest !== limitsDigest ||
    archive.sourceDigest !== target.image.slice(target.image.lastIndexOf("@") + 1) ||
    ![
      archive.sourceDigest,
      archive.manifestDigest,
      archive.configDigest,
      archive.archiveDigest,
    ].every((value) => DIGEST.test(value)) ||
    !Number.isSafeInteger(archive.archiveBytes) ||
    archive.archiveBytes < 1
  )
    return fail("conflict");
}
function verifyNative(image: unknown, archive: DockerStoredImageArchive): string {
  if (
    !record(image) ||
    image.Id !== archive.manifestDigest ||
    image.Os !== "linux" ||
    image.Architecture !== "amd64" ||
    (image.Variant !== undefined && image.Variant !== "") ||
    !record(image.Descriptor) ||
    image.Descriptor.digest !== archive.manifestDigest ||
    !MANIFEST_TYPES.includes(String(image.Descriptor.mediaType))
  )
    return fail("conflict");
  return archive.manifestDigest;
}

/** Archive mode is connected to the real CREATE custody callback. The source
 * supplier verifies the selected graph before the first binary Engine effect.
 * A missing/uncertain native image after an attempt is a retained HOLD. */
export class DockerImageAcquisition {
  readonly #limits: DockerImageSupplyLimits;
  readonly #source: (
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
  ) => DockerImageSourcePort;
  readonly #archives: DockerImageArchiveOwner;
  readonly #native: DockerImageImportTransport;
  readonly #limitsDigest: string;
  constructor(options: {
    readonly limits: DockerImageSupplyLimits;
    readonly source: (
      session: DockerContainerCreateSession,
      target: DockerImageAcquisitionTarget,
    ) => DockerImageSourcePort;
    readonly archives: DockerImageArchiveOwner;
    readonly native: DockerImageImportTransport;
  }) {
    this.#limits = Object.freeze({ ...options.limits });
    if (
      Reflect.ownKeys(this.#limits).length !== LIMIT_KEYS.length ||
      !LIMIT_KEYS.every(
        (key) =>
          Object.hasOwn(this.#limits, key) &&
          Number.isSafeInteger(this.#limits[key]) &&
          this.#limits[key] > 0,
      ) ||
      !Number.isSafeInteger(this.#limits.maxDurationMs) ||
      this.#limits.maxDurationMs > 2_147_483_647
    )
      fail("invalid_request");
    this.#limitsDigest = `sha256:${createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(this.#limits).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      )
      .digest("hex")}`;
    this.#source = options.source;
    this.#archives = options.archives;
    this.#native = options.native;
  }
  async acquire(
    session: DockerContainerCreateSession,
    input: DockerImageAcquisitionTarget,
  ): Promise<string> {
    const target = targetSnapshot(input);
    const deadline = performance.now() + this.#limits.maxDurationMs;
    bound(session, target);
    await session.guard();
    const existing = await this.#archives.find(target, session.record.claimId);
    await session.guard();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) return fail();
    if (existing) return this.#finish(session, target, existing, deadline);
    const source = this.#source(session, target);
    return withDockerRetainedImageArchive(
      session,
      { image: target.image, source, limits: { ...this.#limits, maxDurationMs: remaining } },
      async (archive) => {
        await session.guard();
        if (performance.now() >= deadline) return fail();
        const retained = await this.#archives.retain(session, target, archive, this.#limitsDigest);
        await session.guard();
        return this.#finish(session, target, retained, deadline);
      },
    );
  }
  async #finish(
    session: DockerContainerCreateSession,
    target: DockerImageAcquisitionTarget,
    archive: DockerStoredImageArchive,
    deadline: number,
  ) {
    const check = () => {
      if (performance.now() >= deadline) return fail();
    };
    check();
    verifyArchive(archive, target, session.record.claimId, this.#limitsDigest);
    await session.guard();
    const turn = await this.#archives.beginImport(session, archive);
    await session.guard();
    check();
    if (turn === "first") await this.#native.load(archive, session, deadline);
    else if (turn !== "readback") return fail("conflict");
    await session.guard();
    check();
    const image = await this.#native.inspect(archive, session.signal, deadline);
    await session.guard();
    check();
    if (image === null) return fail();
    return verifyNative(image, archive);
  }
  /** Read-only observation. It reads the exact original claim's retained
   * binding; no absence result or caller DTO can trigger an import here. */
  async inspect(
    input: DockerImageAcquisitionTarget,
    claimId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const target = targetSnapshot(input);
    const deadline = performance.now() + this.#limits.maxDurationMs;
    if (signal?.aborted || !/^[a-f0-9]{64}$/u.test(claimId)) return fail();
    const archive = await this.#archives.find(target, claimId);
    if (!archive || signal?.aborted || performance.now() >= deadline) return fail();
    verifyArchive(archive, target, claimId, this.#limitsDigest);
    const image = await this.#native.inspect(archive, signal, deadline);
    if (signal?.aborted || image === null || performance.now() >= deadline) return fail();
    return verifyNative(image, archive);
  }
}

/** Read the daemon's exported OCI graph without extracting files or retaining
 * layer payloads. Every blob is rehashed; only bounded config/manifest metadata
 * is kept. This proves config binding separately from ImageInspect.Id, which
 * is a manifest target in the explicit containerd/API1.51 profile. */
function nativeExportVerifier(
  archive: DockerStoredImageArchive,
  image: unknown,
  limits: { maxManifestBytes: number; maxConfigBytes: number; maxLayers: number },
) {
  const header = new Uint8Array(512);
  const blobs = new Map<string, number>();
  let headerUsed = 0,
    remaining = 0,
    padding = 0,
    zeroHeaders = 0;
  let ended = false,
    layout = false;
  let name = "",
    type = "",
    entrySize = 0,
    used = 0;
  let collected: Uint8Array | undefined;
  let hash: ReturnType<typeof createHash> | undefined;
  let manifest: Uint8Array | undefined, config: Uint8Array | undefined;
  let paxSize: number | undefined, paxPath: string | undefined;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const text = (bytes: Uint8Array) => utf8.decode(bytes).replace(/\0.*$/u, "");
  const octal = (bytes: Uint8Array) => {
    const value = text(bytes).trim();
    if (!/^[0-7]+$/u.test(value)) return fail("conflict");
    const result = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(result)) return fail("conflict");
    return result;
  };
  const sizeOf = (bytes: Uint8Array) => {
    if (!(bytes[0]! & 0x80)) return octal(bytes);
    if (bytes[0]! & 0x40) return fail("conflict");
    let value = BigInt(bytes[0]! & 0x7f);
    for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail("conflict");
    return Number(value);
  };
  function complete() {
    if (type === "x") {
      let offset = 0;
      const body = collected!;
      while (offset < body.byteLength) {
        const space = body.indexOf(32, offset);
        if (space < 0) return fail("conflict");
        const prefix = utf8.decode(body.subarray(offset, space));
        const length = Number(prefix);
        if (
          !/^[1-9][0-9]*$/u.test(prefix) ||
          !Number.isSafeInteger(length) ||
          length <= space - offset + 2 ||
          length > body.byteLength - offset ||
          body[offset + length - 1] !== 10
        )
          return fail("conflict");
        const recordText = utf8.decode(body.subarray(space + 1, offset + length - 1));
        const equals = recordText.indexOf("=");
        if (equals < 1) return fail("conflict");
        const key = recordText.slice(0, equals),
          value = recordText.slice(equals + 1);
        if (key === "size") {
          const size = Number(value);
          if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(size)) return fail("conflict");
          paxSize = size;
        } else if (key === "path") {
          if (value.length < 1 || value.length > 512 || /[\0\r\n]/u.test(value))
            return fail("conflict");
          paxPath = value;
        }
        offset += length;
      }
    } else if (hash) {
      const actual = `sha256:${hash.digest("hex")}`;
      if (name !== `blobs/sha256/${actual.slice(7)}` || blobs.has(actual)) return fail("conflict");
      if (blobs.size >= Math.min(limits.maxLayers, Number.MAX_SAFE_INTEGER - 4) + 4)
        return fail("conflict");
      blobs.set(actual, entrySize);
      if (actual === archive.manifestDigest) {
        if (manifest) return fail("conflict");
        manifest = collected;
      }
      if (actual === archive.configDigest) {
        if (config) return fail("conflict");
        config = collected;
      }
    } else if (name === "oci-layout") {
      if (layout) return fail("conflict");
      const value: unknown = JSON.parse(utf8.decode(collected));
      if (!record(value) || value.imageLayoutVersion !== "1.0.0") return fail("conflict");
      layout = true;
    }
    hash = undefined;
    collected = undefined;
    used = 0;
  }
  return {
    push(bytes: Uint8Array) {
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (ended) {
          for (const byte of bytes.subarray(offset)) if (byte !== 0) return fail("conflict");
          return;
        }
        if (remaining > 0) {
          const length = Math.min(remaining, bytes.byteLength - offset),
            part = bytes.subarray(offset, offset + length);
          hash?.update(part);
          collected?.set(part, used);
          used += length;
          remaining -= length;
          offset += length;
          if (remaining === 0) complete();
          continue;
        }
        if (padding > 0) {
          const length = Math.min(padding, bytes.byteLength - offset);
          for (const byte of bytes.subarray(offset, offset + length))
            if (byte !== 0) return fail("conflict");
          offset += length;
          padding -= length;
          continue;
        }
        const length = Math.min(512 - headerUsed, bytes.byteLength - offset);
        header.set(bytes.subarray(offset, offset + length), headerUsed);
        headerUsed += length;
        offset += length;
        if (headerUsed !== 512) continue;
        headerUsed = 0;
        if (header.every((byte) => byte === 0)) {
          if (++zeroHeaders === 2) ended = true;
          continue;
        }
        if (zeroHeaders) return fail("conflict");
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
        if (
          octal(header.subarray(148, 156)) !== checksum ||
          text(header.subarray(257, 263)) !== "ustar"
        )
          return fail("conflict");
        type = String.fromCharCode(header[156]!);
        if (!["0", "\0", "x", "5"].includes(type)) return fail("conflict");
        const prefix = text(header.subarray(345, 500));
        name = (prefix ? `${prefix}/` : "") + text(header.subarray(0, 100));
        entrySize = sizeOf(header.subarray(124, 136));
        if (type !== "x") {
          entrySize = paxSize ?? entrySize;
          name = paxPath ?? name;
          paxSize = undefined;
          paxPath = undefined;
        }
        if (type === "5" && entrySize !== 0) return fail("conflict");
        const blob = /^blobs\/sha256\/[a-f0-9]{64}$/u.test(name);
        if (blob && type !== "0" && type !== "\0") return fail("conflict");
        let cap = 0;
        if (type === "x") cap = 16_384;
        else if (name === "oci-layout") cap = 1024;
        else if (name === `blobs/sha256/${archive.manifestDigest.slice(7)}`)
          cap = limits.maxManifestBytes;
        else if (name === `blobs/sha256/${archive.configDigest.slice(7)}`)
          cap = limits.maxConfigBytes;
        if (cap) {
          if (entrySize > cap) return fail("conflict");
          collected = new Uint8Array(entrySize);
        }
        hash = blob && type !== "x" ? createHash("sha256") : undefined;
        remaining = entrySize;
        padding = (512 - (entrySize % 512)) % 512;
        used = 0;
        if (remaining === 0) complete();
      }
    },
    finish() {
      if (
        !ended ||
        remaining ||
        padding ||
        headerUsed ||
        !layout ||
        !manifest ||
        !config ||
        paxSize !== undefined ||
        paxPath !== undefined
      )
        return fail("conflict");
      const selected: unknown = JSON.parse(utf8.decode(manifest)),
        configuration: unknown = JSON.parse(utf8.decode(config));
      if (
        !record(selected) ||
        !record(selected.config) ||
        selected.config.digest !== archive.configDigest ||
        selected.config.size !== config.byteLength ||
        !Array.isArray(selected.layers) ||
        selected.layers.length > limits.maxLayers ||
        selected.layers.some(
          (layer) =>
            !record(layer) ||
            typeof layer.digest !== "string" ||
            blobs.get(layer.digest) !== layer.size,
        ) ||
        !record(configuration) ||
        configuration.os !== "linux" ||
        configuration.architecture !== "amd64" ||
        !record(configuration.rootfs) ||
        configuration.rootfs.type !== "layers" ||
        !Array.isArray(configuration.rootfs.diff_ids) ||
        configuration.rootfs.diff_ids.length !== selected.layers.length ||
        !record(image) ||
        !record(image.RootFS) ||
        image.RootFS.Type !== "layers" ||
        JSON.stringify(image.RootFS.Layers) !== JSON.stringify(configuration.rootfs.diff_ids)
      )
        return fail("conflict");
    },
  };
}

/** Linux Docker Engine transport. OCI-layout support and Descriptor readback
 * require the containerd image store; a classic store is not silently accepted.
 * No registry pull, alias/tag creation, transparent retry or credentials. */
export function createDockerImageImportTransport(options: {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly maxMetadataBytes: number;
  readonly maxLineBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxManifestBytes: number;
  readonly maxConfigBytes: number;
  readonly maxLayers: number;
}): DockerImageImportTransport {
  const {
    socketPath,
    timeoutMs,
    maxMetadataBytes,
    maxLineBytes,
    maxArchiveBytes,
    maxManifestBytes,
    maxConfigBytes,
    maxLayers,
  } = options;
  if (
    !socketPath.startsWith("/") ||
    ![
      timeoutMs,
      maxMetadataBytes,
      maxLineBytes,
      maxArchiveBytes,
      maxManifestBytes,
      maxConfigBytes,
      maxLayers,
    ].every((n) => Number.isSafeInteger(n) && n > 0) ||
    timeoutMs > 2_147_483_647 ||
    maxLineBytes > maxMetadataBytes
  )
    return fail("invalid_request");
  async function request(
    path: string,
    signal?: AbortSignal,
    archive?: DockerStoredImageArchive,
    session?: DockerContainerCreateSession,
    deadline?: number,
    binary?: { push(bytes: Uint8Array): void; finish(): void },
  ) {
    if (
      archive &&
      (!Number.isSafeInteger(archive.archiveBytes) ||
        archive.archiveBytes < 1 ||
        archive.archiveBytes > maxArchiveBytes)
    )
      return fail("invalid_request");
    if (signal?.aborted) return fail();
    if (session) await session.guard();
    const remaining =
      deadline === undefined
        ? timeoutMs
        : Math.min(timeoutMs, Math.floor(deadline - performance.now()));
    if (!Number.isSafeInteger(remaining) || remaining < 1) return fail();
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      let settled = false;
      let requestClosed = false;
      let result: { status: number; body: string } | undefined;
      let failure: unknown;
      let pumping: Promise<void> = Promise.resolve();
      const began = performance.now();
      let total = 0;
      const parts: string[] = [];
      let pending = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const finish = () => {
        if (settled || !requestClosed) return;
        settled = true;
        void pumping.then(
          () =>
            failure
              ? reject(failure)
              : result
                ? resolve(result)
                : reject(new DockerImageAcquisitionError("unavailable")),
          reject,
        );
      };
      const check = () => {
        if (signal?.aborted || performance.now() - began >= remaining) return fail();
      };
      const req = httpRequest(
        {
          socketPath,
          path: `/v1.51${path}`,
          method: archive ? "POST" : "GET",
          headers: archive
            ? {
                "content-type": "application/x-tar",
                "content-length": String(archive.archiveBytes),
              }
            : { accept: binary ? "application/x-tar" : "application/json" },
        },
        (response) => {
          response.on("data", (chunk: Buffer) => {
            try {
              check();
              if (chunk.byteLength > (binary ? maxArchiveBytes : maxMetadataBytes) - total)
                return fail();
              total += chunk.byteLength;
              if (binary) {
                binary.push(chunk);
                return;
              }
              const text = decoder.decode(chunk, { stream: true });
              if (!archive) parts.push(text);
              else {
                pending += text;
                for (;;) {
                  const end = pending.indexOf("\n");
                  if (end < 0) break;
                  const line = pending.slice(0, end);
                  if (new TextEncoder().encode(line).byteLength > maxLineBytes) return fail();
                  pending = pending.slice(end + 1);
                  if (!line.trim()) continue;
                  const value: unknown = JSON.parse(line);
                  if (
                    !record(value) ||
                    value.error !== undefined ||
                    value.errorDetail !== undefined
                  )
                    return fail();
                }
                if (new TextEncoder().encode(pending).byteLength > maxLineBytes) return fail();
              }
            } catch (error) {
              failure =
                error instanceof DockerImageAcquisitionError
                  ? error
                  : new DockerImageAcquisitionError("unavailable");
              req.destroy();
            }
          });
          response.on("aborted", () => {
            failure ??= new DockerImageAcquisitionError("unavailable");
            req.destroy();
          });
          response.on("error", () => {
            failure ??= new DockerImageAcquisitionError("unavailable");
            req.destroy();
          });
          response.on("end", () => {
            try {
              check();
              if (binary) {
                binary.finish();
                result = { status: response.statusCode ?? 0, body: "" };
                return;
              }
              const tail = decoder.decode();
              if (archive && (tail.length || pending.trim())) return fail();
              result = {
                status: response.statusCode ?? 0,
                body: archive ? "" : parts.join("") + tail,
              };
            } catch (error) {
              failure =
                error instanceof DockerImageAcquisitionError
                  ? error
                  : new DockerImageAcquisitionError("unavailable");
            }
          });
        },
      );
      const abort = () => {
        failure ??= new DockerImageAcquisitionError("unavailable");
        req.destroy(new DockerImageAcquisitionError("unavailable"));
      };
      const timer = setTimeout(abort, remaining);
      signal?.addEventListener("abort", abort, { once: true });
      req.on("error", () => {
        failure ??= new DockerImageAcquisitionError("unavailable");
      });
      req.on("close", () => {
        requestClosed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        finish();
      });
      if (!archive) req.end();
      else
        pumping = (async () => {
          const reader = archive.open().getReader();
          let sent = 0;
          try {
            for (;;) {
              check();
              await session!.guard();
              const next = await reader.read();
              check();
              await session!.guard();
              if (next.done) break;
              const length = next.value.byteLength;
              if (length > archive.archiveBytes - sent || length > maxArchiveBytes - sent)
                return fail("conflict");
              sent += length;
              if (!req.write(next.value))
                await new Promise<void>((resolveDrain, rejectDrain) => {
                  const clean = () => {
                    req.off("drain", drained);
                    req.off("close", closed);
                    req.off("error", errored);
                  };
                  const drained = () => {
                    clean();
                    resolveDrain();
                  };
                  const closed = () => {
                    clean();
                    rejectDrain(new DockerImageAcquisitionError("unavailable"));
                  };
                  const errored = () => {
                    clean();
                    rejectDrain(new DockerImageAcquisitionError("unavailable"));
                  };
                  req.once("drain", drained);
                  req.once("close", closed);
                  req.once("error", errored);
                  if (req.destroyed) closed();
                });
            }
            if (sent !== archive.archiveBytes) return fail("conflict");
            check();
            await session!.guard();
            req.end();
          } catch (error) {
            failure = error;
            req.destroy(new DockerImageAcquisitionError("unavailable"));
            throw error;
          } finally {
            try {
              await reader.cancel();
            } finally {
              reader.releaseLock();
            }
          }
        })();
      void pumping.catch((error) => {
        failure = error;
        req.destroy();
      });
      if (signal?.aborted) abort();
    });
  }
  return {
    async inspect(archive, signal, deadline) {
      if (!DIGEST.test(archive.manifestDigest) || !DIGEST.test(archive.configDigest))
        return fail("invalid_request");
      const nativeRef = encodeURIComponent(archive.manifestDigest);
      const response = await request(
        `/images/${nativeRef}/json?platform=linux%2Famd64`,
        signal,
        undefined,
        undefined,
        deadline,
      );
      if (response.status === 404) return null;
      if (response.status !== 200) return fail();
      let image: unknown;
      try {
        image = JSON.parse(response.body) as unknown;
      } catch {
        return fail();
      }
      verifyNative(image, archive);
      const exported = nativeExportVerifier(archive, image, {
        maxManifestBytes,
        maxConfigBytes,
        maxLayers,
      });
      const readback = await request(
        `/images/${nativeRef}/get?platform=linux%2Famd64`,
        signal,
        undefined,
        undefined,
        deadline,
        exported,
      );
      if (readback.status !== 200) return fail();
      return image;
    },
    async load(archive, session, deadline) {
      const response = await request(
        "/images/load?quiet=false&platform=linux%2Famd64",
        session.signal,
        archive,
        session,
        deadline,
      );
      if (response.status !== 200) return fail();
    },
  };
}
