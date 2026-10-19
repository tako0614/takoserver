import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DockerImageAcquisitionError,
  type DockerImageAcquisitionTarget,
  type DockerImageArchiveOwner,
  type DockerStoredImageArchive,
} from "./docker-container-image-acquisition.ts";

type Session = Parameters<DockerImageArchiveOwner["retain"]>[0];
type Archive = Parameters<DockerImageArchiveOwner["retain"]>[2];
interface Metadata {
  readonly claimId: string;
  readonly target: DockerImageAcquisitionTarget;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly archiveDigest: string;
  readonly archiveBytes: number;
  readonly limitsDigest: string;
}
const METADATA_LIMIT = 16_384;
function fail(code: "conflict" | "unavailable" = "unavailable"): never {
  throw new DockerImageAcquisitionError(code);
}
function exists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const keyOf = (target: DockerImageAcquisitionTarget, claimId: string) =>
  digest(JSON.stringify({ claimId, target }));
const metadataOf = (
  session: Session,
  target: DockerImageAcquisitionTarget,
  archive: Archive,
  limitsDigest: string,
): Metadata =>
  Object.freeze({
    claimId: session.record.claimId,
    target,
    sourceDigest: archive.sourceDigest,
    manifestDigest: archive.manifestDigest,
    configDigest: archive.configDigest,
    archiveDigest: archive.archiveDigest,
    archiveBytes: archive.archiveBytes,
    limitsDigest,
  });
async function directory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    return fail("conflict");
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readMetadata(path: string): Promise<Metadata> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > METADATA_LIMIT
    )
      return fail("conflict");
    const bytes = Buffer.alloc(METADATA_LIMIT + 1);
    let total = 0;
    while (total <= METADATA_LIMIT) {
      const read = await file.read(bytes, total, bytes.byteLength - total, total);
      total += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    if (total > METADATA_LIMIT) return fail("conflict");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return fail("conflict");
    const result = value as Metadata;
    if (
      !/^[a-f0-9]{64}$/u.test(result.claimId) ||
      !Number.isSafeInteger(result.archiveBytes) ||
      result.archiveBytes < 1 ||
      ![
        result.sourceDigest,
        result.manifestDigest,
        result.configDigest,
        result.archiveDigest,
        result.limitsDigest,
      ].every((x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/u.test(x))
    )
      return fail("conflict");
    return result;
  } finally {
    await file.close();
  }
}
async function writeExclusive(path: string, bytes: Uint8Array) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const write = await file.write(bytes, offset, bytes.byteLength - offset);
      if (write.bytesWritten < 1) return fail();
      offset += write.bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Operator-private retained archive store. Reservations count every uncertain
 * import until explicit owner recovery/removal; there is no automatic pruning.
 * A crash while holding the quota directory is fail-closed and requires an
 * operator recovery procedure, never a PID/age guess or automatic lock theft. */
export async function createFileDockerImageArchiveOwner(options: {
  readonly root: string;
  readonly maxArchiveBytes: number;
  readonly maxTotalBytes: number;
  readonly maxArchives: number;
}): Promise<DockerImageArchiveOwner> {
  const root = resolve(options.root);
  const { maxArchiveBytes, maxTotalBytes, maxArchives } = options;
  if (
    !options.root.startsWith("/") ||
    ![maxArchiveBytes, maxTotalBytes, maxArchives].every((n) => Number.isSafeInteger(n) && n > 0) ||
    maxArchiveBytes > maxTotalBytes
  )
    return fail("conflict");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await directory(root);
  async function verified(meta: Metadata, folder: string): Promise<DockerStoredImageArchive> {
    if (meta.archiveBytes > maxArchiveBytes) return fail("conflict");
    await directory(folder);
    const path = join(folder, "archive.tar");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size !== meta.archiveBytes
      )
        return fail("conflict");
      const hash = createHash("sha256");
      const bytes = Buffer.alloc(65_536);
      let offset = 0;
      for (;;) {
        const read = await file.read(
          bytes,
          0,
          Math.min(bytes.byteLength, meta.archiveBytes - offset + 1),
          offset,
        );
        if (read.bytesRead === 0) break;
        if (read.bytesRead > meta.archiveBytes - offset) return fail("conflict");
        offset += read.bytesRead;
        hash.update(bytes.subarray(0, read.bytesRead));
      }
      if (offset !== meta.archiveBytes || `sha256:${hash.digest("hex")}` !== meta.archiveDigest)
        return fail("conflict");
    } finally {
      await file.close();
    }
    return Object.freeze({
      ...meta,
      open() {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let opening: Promise<Awaited<ReturnType<typeof open>>> | undefined;
        let closing: Promise<void> | undefined;
        let position = 0;
        let closed = false;
        const hash = createHash("sha256");
        const close = () => {
          closed = true;
          closing ??= (async () => {
            const current = handle ?? (await opening);
            await current?.close();
          })();
          return closing;
        };
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                if (closed) return;
                opening ??= open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                handle ??= await opening;
                if (closed) {
                  await close();
                  return;
                }
                const stat = await handle.stat();
                if (
                  !stat.isFile() ||
                  stat.nlink !== 1 ||
                  (stat.mode & 0o077) !== 0 ||
                  stat.size !== meta.archiveBytes
                )
                  return fail("conflict");
                if (position === meta.archiveBytes) {
                  if (`sha256:${hash.digest("hex")}` !== meta.archiveDigest)
                    return fail("conflict");
                  await close();
                  controller.close();
                  return;
                }
                const bytes = new Uint8Array(Math.min(65_536, meta.archiveBytes - position));
                const read = await handle.read(bytes, 0, bytes.byteLength, position);
                if (closed) {
                  await close();
                  return;
                }
                if (read.bytesRead < 1) return fail("conflict");
                const chunk = bytes.subarray(0, read.bytesRead);
                position += read.bytesRead;
                hash.update(chunk);
                controller.enqueue(chunk);
              } catch (error) {
                await close();
                controller.error(error);
              }
            },
            cancel: close,
          },
          { highWaterMark: 0 },
        );
      },
    });
  }
  async function find(target: DockerImageAcquisitionTarget, claimId: string) {
    const folder = join(root, keyOf(target, claimId));
    try {
      await directory(folder);
      const meta = await readMetadata(join(folder, "archive.json"));
      if (meta.claimId !== claimId || JSON.stringify(meta.target) !== JSON.stringify(target))
        return fail("conflict");
      return verified(meta, folder);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  return {
    find,
    async retain(session, target, archive, limitsDigest) {
      await session.guard();
      const meta = metadataOf(session, target, archive, limitsDigest);
      const folder = join(root, keyOf(target, meta.claimId));
      const lock = join(root, ".quota-admission");
      const metadata = new TextEncoder().encode(JSON.stringify(meta));
      if (meta.archiveBytes > maxArchiveBytes || metadata.byteLength > METADATA_LIMIT)
        return fail("conflict");
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch {
        return fail();
      }
      try {
        await session.guard();
        const entries = await readdir(root, { withFileTypes: true });
        const reservations = entries.filter((entry) => /^[a-f0-9]{64}$/u.test(entry.name));
        if (reservations.length >= maxArchives) return fail();
        let reserved = 0;
        for (const entry of reservations) {
          const priorFolder = join(root, entry.name);
          await directory(priorFolder);
          const prior = await readMetadata(join(priorFolder, "reservation.json"));
          if (prior.archiveBytes > maxTotalBytes - reserved) return fail("conflict");
          reserved += prior.archiveBytes;
        }
        if (meta.archiveBytes > maxTotalBytes - reserved) return fail();
        await mkdir(folder, { mode: 0o700 });
        await writeExclusive(join(folder, "reservation.json"), metadata);
        await syncDirectory(folder);
        await syncDirectory(root);
      } finally {
        await rmdir(lock);
        await syncDirectory(root);
      }
      await session.guard();
      const temporary = join(folder, `archive-${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const hash = createHash("sha256");
      let size = 0;
      try {
        const input = archive.open().getReader();
        reader = input;
        for (;;) {
          await session.guard();
          const next = await input.read();
          await session.guard();
          if (next.done) break;
          if (next.value.byteLength > meta.archiveBytes - size) return fail("conflict");
          hash.update(next.value);
          let offset = 0;
          while (offset < next.value.byteLength) {
            await session.guard();
            const write = await file.write(next.value, offset, next.value.byteLength - offset);
            if (write.bytesWritten < 1) return fail();
            offset += write.bytesWritten;
          }
          size += next.value.byteLength;
        }
        if (size !== meta.archiveBytes || `sha256:${hash.digest("hex")}` !== meta.archiveDigest)
          return fail("conflict");
        await file.sync();
      } finally {
        const cleanup = await Promise.allSettled([reader?.cancel(), file.close()]);
        reader?.releaseLock();
        if (cleanup.some((result) => result.status === "rejected")) fail();
      }
      await session.guard();
      await rename(temporary, join(folder, "archive.tar"));
      await syncDirectory(folder);
      await writeExclusive(join(folder, "archive.json"), metadata);
      await syncDirectory(folder);
      await session.guard();
      return verified(meta, folder);
    },
    async beginImport(session, archive) {
      await session.guard();
      if (archive.claimId !== session.record.claimId) return fail("conflict");
      const folder = join(root, keyOf(archive.target, archive.claimId));
      await directory(folder);
      const stored = await find(archive.target, archive.claimId);
      if (!stored || stored.archiveDigest !== archive.archiveDigest) return fail("conflict");
      const bytes = new TextEncoder().encode(JSON.stringify({ ...stored, open: undefined }));
      const attempt = join(folder, "import-attempt.json");
      try {
        await session.guard();
        await writeExclusive(attempt, bytes);
        await syncDirectory(folder);
        await session.guard();
        return "first";
      } catch (error) {
        if (!exists(error)) throw error;
        const prior = await readMetadata(attempt);
        if (
          prior.archiveDigest !== stored.archiveDigest ||
          prior.claimId !== stored.claimId ||
          JSON.stringify(prior.target) !== JSON.stringify(stored.target)
        )
          return fail("conflict");
        await session.guard();
        return "readback";
      }
    },
  };
}
