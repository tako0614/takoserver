import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type ObjectListPage,
  type ObjectStore,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

/**
 * Objects on a disk.
 *
 * The in-memory store is for tests and the R2 stores need an account. Neither
 * is what somebody running this on their own machine needs: a self-hosted
 * deployment has to survive a restart, and losing every customer's files to a
 * process exit is not a storage layer.
 *
 * A key becomes a path, which is where this kind of code goes wrong. Keys come
 * from customers, `..` means something to a filesystem, and a store that joins
 * strings hands out the machine. So a key is checked before it is joined and
 * the result is checked again after — the second check is what catches the
 * encoding nobody thought of.
 *
 * Writes land through an internal temporary file and a rename, because a
 * rename within a filesystem is atomic and a partial write is not: a reader
 * during a crash finds the old bytes or the new ones, never half of either.
 * Staging is outside the user object namespace, so a key that happens to look
 * like an old staging suffix remains an ordinary object throughout a write.
 *
 * On one host, with one JS runtime per OS process, one live runtime owns
 * mutations for a root. The claim is published with an atomic hard link, all
 * adapters in that runtime share the same collision mutexes, and a later
 * runtime can recover a claim after its PID is dead or its Linux boot/start
 * fingerprint proves that PID was reused. A same-PID claim with another
 * runtime token is necessarily from a prior incarnation and is recovered too.
 * Reads remain available in other processes while that writer is alive.
 *
 * The configured root and its parents are an operator-owned boundary. Below
 * that root every directory component is checked with lstat, regular files
 * are opened with O_NOFOLLOW, and directory/file identities are checked again
 * after pathname operations. Node and Bun do not expose openat-style relative
 * rename/link/unlink calls, so a hostile local actor that can swap an ancestor
 * and restore the same inode entirely between those checks is outside the
 * race-free guarantee. Detectable symlinks and identity changes fail closed.
 */

export interface FileObjectStoreOptions {
  /** Directory that holds everything. Created if absent. */
  readonly root: string;
}

const FILE_READ_CHUNK_BYTES = 64 * 1024;
const METADATA_MAX_BYTES = 16 * 1024;
// A valid package may contain 1,024 payload objects plus its index. Every
// logical object has one body and one metadata sidecar, and each package path
// is schema-bounded to 512 bytes, so at most 512 directory entries can be
// introduced per logical object. Keep a generous derived raw-entry fence while
// still refusing an unbounded hostile directory traversal.
const LIST_LOGICAL_OBJECT_LIMIT = 1_024 + 1;
const LIST_MAX_PACKAGE_PATH_SEGMENTS = 512;
const LIST_TRAVERSAL_ENTRY_LIMIT = LIST_LOGICAL_OBJECT_LIMIT * (LIST_MAX_PACKAGE_PATH_SEGMENTS + 2);
const WRITER_CLAIM_NAME = ".object-store-writer.json";
const WRITER_ARTIFACT_PREFIX = ".object-store-writer.";
const WRITER_CLAIM_PREFIX = `${WRITER_ARTIFACT_PREFIX}claim.`;
const WRITER_RECOVERY_PREFIX = `${WRITER_ARTIFACT_PREFIX}recover.`;
const WRITER_AUTHORITY_ATTEMPTS = 4;
const WRITER_OWNER_MAX_BYTES = 1_024;
const PROC_BOOT_ID_MAX_BYTES = 128;
const PROC_STAT_MAX_BYTES = 4 * 1_024;
const PROCESS_MUTEXES = new Map<string, Promise<void>>();
// Symbol.for keeps separately loaded copies in one JS realm on the same
// process token, so reopening the adapter does not reject its own PID claim.
const PROCESS_WRITER_TOKEN_SYMBOL = Symbol.for("@takoserver/core.file-object-store-writer-token");
const processTokenHolder = globalThis as unknown as Record<symbol, unknown>;
const existingProcessWriterToken = processTokenHolder[PROCESS_WRITER_TOKEN_SYMBOL];
const PROCESS_WRITER_TOKEN =
  typeof existingProcessWriterToken === "string" ? existingProcessWriterToken : randomUUID();
processTokenHolder[PROCESS_WRITER_TOKEN_SYMBOL] = PROCESS_WRITER_TOKEN;

interface NumericFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function createFileObjectStore(options: FileObjectStoreOptions): ObjectStore {
  const root = resolve(options.root);

  /**
   * The path a key lives at, or a refusal.
   *
   * Content type is kept beside the bytes rather than in a database: a store
   * that needs a second system to answer `get` is a store that can be half
   * available.
   */
  const pathFor = (
    key: string,
  ): {
    readonly body: string;
    readonly meta: string;
    readonly legacyMeta: string;
  } => {
    if (!validKey(key)) throw new ObjectStoreError("invalid", "unusable object key");
    const body = join(root, "objects", key);
    // Checked after joining too so normalisation cannot cross the lexical
    // boundary. The filesystem helpers separately reject symlinked components
    // before and after each pathname operation.
    const inside = relative(join(root, "objects"), body);
    if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
      throw new ObjectStoreError("invalid", "unusable object key");
    }
    return {
      body,
      meta: metadataPath(root, key),
      legacyMeta: `${body}.meta`,
    };
  };

  return {
    async create(key, body, opts): Promise<StoredObject | null> {
      const { body: path, meta, legacyMeta } = pathFor(key);
      const bytes = await collect(body);
      return await withWriterCollision(root, collisionDomain(key), async () => {
        await prepareLegacyKeyCollision(root, key, path, meta);
        const staging = stagingPath(root, key);
        try {
          const staged = await writeExclusiveFile(root, staging, bytes);
          // A hard link publishes the complete staging inode without replacing
          // an existing key. Both paths are on the same filesystem.
          if (!(await publishCreateOnly(root, staged, path))) return null;
          const contentType = opts?.contentType;
          await writeMetadata(root, key, meta, legacyMeta, contentType, digest(bytes));
          return {
            key,
            size: bytes.byteLength,
            etag: digest(bytes),
            ...(contentType ? { contentType } : {}),
          };
        } catch (error) {
          if (isAlreadyExists(error)) return null;
          throw new ObjectStoreError(
            "unavailable",
            `the disk refused the create: ${String(error)}`,
          );
        } finally {
          await removeSafeRegularFile(root, staging).catch(() => undefined);
        }
      });
    },

    async put(key, body, opts): Promise<StoredObject> {
      const { body: path, meta, legacyMeta } = pathFor(key);
      const bytes = await collect(body);
      return await withWriterCollision(root, collisionDomain(key), async () => {
        await prepareLegacyKeyCollision(root, key, path, meta);
        const staging = stagingPath(root, key);
        try {
          const staged = await writeExclusiveFile(root, staging, bytes);
          await publishReplace(root, staged, path);
        } catch (error) {
          await removeSafeRegularFile(root, staging).catch(() => undefined);
          throw new ObjectStoreError("unavailable", `the disk refused the write: ${String(error)}`);
        }
        const contentType = opts?.contentType;
        await writeMetadata(root, key, meta, legacyMeta, contentType, digest(bytes));

        return {
          key,
          size: bytes.byteLength,
          etag: digest(bytes),
          ...(contentType ? { contentType } : {}),
        };
      });
    },

    async get(key): Promise<StoredObjectBody | null> {
      const { body: path, meta, legacyMeta } = pathFor(key);
      try {
        // A terminal `.meta` body without new-namespace metadata may still be
        // the legacy sidecar for its sibling. Old staging suffixes were never
        // logical objects either. Keep reads in parity with list: only a
        // primary metadata record proves a newly accepted suffix key exists.
        if (await isLegacyStoragePath(root, key, path, meta)) return null;
        const opened = await openSafeRegularFile(root, path);
        if (!opened) return null;
        const metadata = await readMetadata(root, meta, legacyMeta);
        if (!(await verifyOpenedFile(opened))) {
          await opened.handle.close().catch(() => undefined);
          return null;
        }
        return {
          key,
          size: opened.stat.size,
          etag: metadata.etag ?? "",
          ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
          body: streamFromFile(opened),
        };
      } catch {
        return null;
      }
    },

    async head(key): Promise<StoredObject | null> {
      const { body: path, meta, legacyMeta } = pathFor(key);
      try {
        if (await isLegacyStoragePath(root, key, path, meta)) return null;
        const opened = await openSafeRegularFile(root, path);
        if (!opened) return null;
        try {
          const metadata = await readMetadata(root, meta, legacyMeta);
          if (!(await verifyOpenedFile(opened))) return null;
          return {
            key,
            size: opened.stat.size,
            etag: metadata.etag ?? "",
            ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
          };
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
      } catch {
        return null;
      }
    },

    async delete(key): Promise<boolean> {
      const { body: path, meta, legacyMeta } = pathFor(key);
      return await withWriterCollision(root, collisionDomain(key), async () => {
        // Migration/cleanup must happen before deciding whether the requested
        // key exists. In particular, an old `thing.meta` sidecar is not a
        // logical terminal object, while its sibling's metadata must survive.
        await prepareLegacyKeyCollision(root, key, path, meta);
        const found = await safeFileSnapshot(root, path);
        const hasBody = found?.stat.isFile() === true;
        const hiddenLegacy = await isLegacyStoragePath(root, key, path, meta);
        const existed = hasBody && !hiddenLegacy;
        await removeSafeRegularFile(root, path, found?.stat);
        await removeSafeRegularFile(root, meta);
        await removeLegacyMetadata(root, key, legacyMeta);
        return existed;
      });
    },

    async list(options): Promise<ObjectListPage> {
      if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
        throw new ObjectStoreError("invalid", "list limit must be a positive integer");
      }
      const prefix = options.prefix;
      const limit = Math.min(options.limit, 1_000);
      const base = join(root, "objects");
      const after = options.cursor ?? null;
      // Walk only the requested prefix and stop after one extra key. The
      // extra key is enough to answer `truncated` without inventorying or
      // sorting the whole object store. A lexical heap keeps nested paths in
      // the same order as the old global sort even when a directory and a
      // sibling file share a prefix (for example `a/x` and `a-file`).
      const keys = await walkPrefix(base, root, prefix, after, limit + 1);
      const truncated = keys.length > limit;
      const window = truncated ? keys.slice(0, limit) : keys;
      const objects: StoredObject[] = [];
      for (const key of window) {
        const found = await openSafeRegularFile(root, join(base, key));
        if (!found) continue;
        const metadataPaths = pathFor(key);
        try {
          const metadata = await readMetadata(root, metadataPaths.meta, metadataPaths.legacyMeta);
          if (!(await verifyOpenedFile(found))) {
            throw new ObjectStoreError("unavailable", "object changed while listing");
          }
          objects.push({
            key,
            size: found.stat.size,
            etag: metadata.etag ?? "",
            ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
          });
        } finally {
          await found.handle.close().catch(() => undefined);
        }
      }
      const last = window[window.length - 1];
      return {
        objects,
        truncated,
        ...(truncated && last ? { cursor: last } : {}),
      };
    },
  };
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function unsafeFilesystem(message: string): ObjectStoreError {
  return new ObjectStoreError("unavailable", message);
}

interface DirectoryEntrySnapshot {
  readonly path: string;
  readonly stat: NumericFileStat;
}

interface SafeDirectorySnapshot {
  readonly entries: readonly DirectoryEntrySnapshot[];
}

interface SafePathSnapshot {
  readonly path: string;
  readonly stat: NumericFileStat;
  readonly parent: SafeDirectorySnapshot;
}

interface OpenedSafeFile extends SafePathSnapshot {
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface WriterOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token?: string;
  readonly linuxProcess?: LinuxProcessFingerprint;
}

interface LinuxProcessFingerprint {
  readonly bootId: string;
  readonly startTimeTicks: string;
}

interface WriterClaim {
  readonly owner: WriterOwner;
  readonly file: SafePathSnapshot;
}

type WriterOwnerState = "same" | "stale" | "live" | "unknown";

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = PROCESS_MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  PROCESS_MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (PROCESS_MUTEXES.get(key) === current) PROCESS_MUTEXES.delete(key);
  }
}

async function withWriterCollision<T>(
  root: string,
  domain: string,
  operation: () => Promise<T>,
): Promise<T> {
  const initialRoot = await ensureWriterAuthority(root);
  const rootEntry = initialRoot.entries[0];
  if (!rootEntry) throw unsafeFilesystem("object store root is unavailable");
  const collisionKey = `collision:${rootEntry.stat.dev}:${rootEntry.stat.ino}:${domain}`;
  return await withProcessMutex(collisionKey, async () => {
    const currentRoot = await ensureWriterAuthority(root);
    const currentEntry = currentRoot.entries[0];
    if (!currentEntry || !sameFile(rootEntry.stat, currentEntry.stat)) {
      throw unsafeFilesystem("object store root changed before a mutation");
    }
    try {
      return await operation();
    } finally {
      await assertWriterAuthority(root, rootEntry.stat);
    }
  });
}

async function ensureWriterAuthority(root: string): Promise<SafeDirectorySnapshot> {
  return await withProcessMutex(`writer-authority:${root}`, async () => {
    for (let attempt = 0; attempt < WRITER_AUTHORITY_ATTEMPTS; attempt += 1) {
      const rootSnapshot = await ensureSafeDirectory(root, root, true);
      if (!rootSnapshot) throw unsafeFilesystem("object store root is unavailable");
      const claim = await readWriterClaim(root);
      if (claim) {
        const ownerState = await writerOwnerState(claim.owner);
        if (ownerState === "same") {
          if (!(await verifyDirectorySnapshot(rootSnapshot))) {
            throw unsafeFilesystem("object store root changed while checking writer authority");
          }
          return rootSnapshot;
        }
        if (ownerState !== "stale") {
          throw unsafeFilesystem(
            `object store root already has live or unverifiable writer pid ${claim.owner.pid}`,
          );
        }
        await recoverStaleWriterClaim(root, claim);
        continue;
      }
      if (!(await publishWriterClaim(root))) continue;
      const published = await readWriterClaim(root);
      if (
        !published ||
        published.owner.pid !== process.pid ||
        published.owner.token !== PROCESS_WRITER_TOKEN
      ) {
        throw unsafeFilesystem("writer authority claim changed during publication");
      }
      const currentRoot = await ensureSafeDirectory(root, root, false);
      if (!currentRoot) throw unsafeFilesystem("object store root disappeared");
      return currentRoot;
    }
    throw unsafeFilesystem("writer authority contention exceeded the bounded retry limit");
  });
}

async function assertWriterAuthority(root: string, expectedRoot: NumericFileStat): Promise<void> {
  const currentRoot = await ensureSafeDirectory(root, root, false);
  const rootEntry = currentRoot?.entries[0];
  if (!rootEntry || !sameFile(expectedRoot, rootEntry.stat)) {
    throw unsafeFilesystem("object store root changed during a mutation");
  }
  const claim = await readWriterClaim(root);
  if (!claim || claim.owner.pid !== process.pid || claim.owner.token !== PROCESS_WRITER_TOKEN) {
    throw unsafeFilesystem("writer authority changed during a mutation");
  }
}

async function publishWriterClaim(root: string): Promise<boolean> {
  const linuxProcess = await readLinuxProcessFingerprint(process.pid);
  const owner: WriterOwner = {
    version: 1,
    pid: process.pid,
    token: PROCESS_WRITER_TOKEN,
    ...(linuxProcess ? { linuxProcess } : {}),
  };
  const artifact = writerArtifactPath(root, WRITER_CLAIM_PREFIX, process.pid);
  let staged: SafePathSnapshot | null = null;
  try {
    staged = await writeExclusiveFile(
      root,
      artifact,
      new TextEncoder().encode(JSON.stringify(owner)),
    );
    return await publishCreateOnly(root, staged, join(root, WRITER_CLAIM_NAME));
  } finally {
    await removeSafeRegularFile(root, artifact, staged?.stat).catch(() => undefined);
  }
}

async function readWriterClaim(root: string): Promise<WriterClaim | null> {
  const pathname = join(root, WRITER_CLAIM_NAME);
  const opened = await openSafeRegularFile(root, pathname);
  if (!opened) return null;
  try {
    if (opened.stat.size > WRITER_OWNER_MAX_BYTES) {
      throw unsafeFilesystem("writer authority claim is oversized");
    }
    const bytes = await readWholeOpenedFile(opened, WRITER_OWNER_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unsafeFilesystem("writer authority claim is malformed");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw unsafeFilesystem("writer authority claim is malformed");
    }
    const value = parsed as {
      readonly version?: unknown;
      readonly pid?: unknown;
      readonly token?: unknown;
      readonly linuxProcess?: unknown;
    };
    if (
      (value.version !== undefined && value.version !== 1) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      (value.token !== undefined &&
        (typeof value.token !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.token)))
    ) {
      throw unsafeFilesystem("writer authority claim is malformed");
    }
    let linuxProcess: LinuxProcessFingerprint | undefined;
    if (value.linuxProcess !== undefined) {
      if (
        typeof value.linuxProcess !== "object" ||
        value.linuxProcess === null ||
        Array.isArray(value.linuxProcess)
      ) {
        throw unsafeFilesystem("writer authority claim is malformed");
      }
      const fingerprint = value.linuxProcess as {
        readonly bootId?: unknown;
        readonly startTimeTicks?: unknown;
      };
      if (
        typeof fingerprint.bootId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          fingerprint.bootId,
        ) ||
        typeof fingerprint.startTimeTicks !== "string" ||
        !/^\d{1,32}$/u.test(fingerprint.startTimeTicks)
      ) {
        throw unsafeFilesystem("writer authority claim is malformed");
      }
      linuxProcess = {
        bootId: fingerprint.bootId.toLowerCase(),
        startTimeTicks: fingerprint.startTimeTicks,
      };
    }
    return {
      owner: {
        version: 1,
        pid: value.pid as number,
        ...(typeof value.token === "string" ? { token: value.token } : {}),
        ...(linuxProcess ? { linuxProcess } : {}),
      },
      file: { path: opened.path, stat: opened.stat, parent: opened.parent },
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function processIsAlive(pid: number): Promise<boolean | null> {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return null;
  }
}

async function writerOwnerState(owner: WriterOwner): Promise<WriterOwnerState> {
  if (owner.pid === process.pid) {
    return owner.token === PROCESS_WRITER_TOKEN ? "same" : "stale";
  }
  const alive = await processIsAlive(owner.pid);
  if (alive === false) return "stale";
  if (owner.linuxProcess) {
    const actual = await readLinuxProcessFingerprint(owner.pid);
    if (!actual) return "unknown";
    return sameLinuxProcess(owner.linuxProcess, actual) ? "live" : "stale";
  }
  return alive === true ? "live" : "unknown";
}

function sameLinuxProcess(left: LinuxProcessFingerprint, right: LinuxProcessFingerprint): boolean {
  return left.bootId === right.bootId && left.startTimeTicks === right.startTimeTicks;
}

function sameWriterOwner(left: WriterOwner, right: WriterOwner): boolean {
  return (
    left.pid === right.pid &&
    left.token === right.token &&
    ((!left.linuxProcess && !right.linuxProcess) ||
      Boolean(
        left.linuxProcess &&
          right.linuxProcess &&
          sameLinuxProcess(left.linuxProcess, right.linuxProcess),
      ))
  );
}

async function readLinuxProcessFingerprint(pid: number): Promise<LinuxProcessFingerprint | null> {
  if (process.platform !== "linux") return null;
  const [bootIdRaw, statRaw] = await Promise.all([
    readVirtualFileBounded("/proc/sys/kernel/random/boot_id", PROC_BOOT_ID_MAX_BYTES),
    readVirtualFileBounded(`/proc/${pid}/stat`, PROC_STAT_MAX_BYTES),
  ]);
  const bootId = bootIdRaw?.trim().toLowerCase();
  if (
    !bootId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId) ||
    !statRaw
  ) {
    return null;
  }
  const commandEnd = statRaw.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // The tokens after the command begin at proc field 3 (state), so field 22
  // (process start time in clock ticks since boot) is zero-based index 19.
  const fields = statRaw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTimeTicks = fields[19];
  if (!startTimeTicks || !/^\d{1,32}$/u.test(startTimeTicks)) return null;
  return { bootId, startTimeTicks };
}

async function readVirtualFileBounded(pathname: string, maximum: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead <= 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximum) return null;
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function recoverStaleWriterClaim(root: string, expected: WriterClaim): Promise<void> {
  await removeStaleWriterArtifacts(root, expected.owner);
  const current = await readWriterClaim(root);
  if (
    !current ||
    !sameFile(expected.file.stat, current.file.stat) ||
    !sameWriterOwner(expected.owner, current.owner)
  ) {
    return;
  }
  if ((await writerOwnerState(current.owner)) !== "stale") {
    throw unsafeFilesystem("writer authority owner became live during stale recovery");
  }

  const recoveryPath = writerArtifactPath(root, WRITER_RECOVERY_PREFIX, process.pid);
  let linked = false;
  try {
    // Node has no compare-and-unlink. A hard link pins the exact stale inode;
    // nlink === 2 proves that the main name plus this recovery name are its
    // only links. A concurrent cooperative recoverer raises nlink and causes
    // bounded refusal instead of letting either process unlink a new claim.
    linked = await publishCreateOnly(root, current.file, recoveryPath);
    if (!linked) throw unsafeFilesystem("writer recovery artifact collided");
    const main = await safeFileSnapshot(root, join(root, WRITER_CLAIM_NAME));
    const recovery = await safeFileSnapshot(root, recoveryPath);
    if (
      !main ||
      !recovery ||
      !sameFile(current.file.stat, main.stat) ||
      !sameFile(main.stat, recovery.stat) ||
      main.stat.nlink !== 2
    ) {
      throw unsafeFilesystem("writer recovery could not establish sole stale-claim ownership");
    }
    const checked = await readWriterClaim(root);
    if (
      !checked ||
      !sameFile(main.stat, checked.file.stat) ||
      !sameWriterOwner(current.owner, checked.owner) ||
      (await writerOwnerState(checked.owner)) !== "stale"
    ) {
      throw unsafeFilesystem("writer authority changed during stale recovery");
    }
    await removeSafeRegularFile(root, join(root, WRITER_CLAIM_NAME), main.stat);
  } finally {
    if (linked) await removeSafeRegularFile(root, recoveryPath).catch(() => undefined);
  }
}

async function removeStaleWriterArtifacts(root: string, staleOwner: WriterOwner): Promise<void> {
  const rootSnapshot = await ensureSafeDirectory(root, root, false);
  if (!rootSnapshot) return;
  const directory = await opendir(root);
  let inspected = 0;
  try {
    for await (const entry of directory) {
      if (!entry.name.startsWith(WRITER_ARTIFACT_PREFIX)) continue;
      inspected += 1;
      if (inspected > 64) {
        throw unsafeFilesystem("writer recovery artifact scan exceeded its bounded limit");
      }
      const match = /^\.object-store-writer\.(?:claim|recover)\.(\d+)\.([0-9a-f-]{36})\./iu.exec(
        entry.name,
      );
      if (!match?.[1] || !match[2]) continue;
      const pid = Number(match[1]);
      const token = match[2];
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const exactStaleOwner =
        staleOwner.token !== undefined && pid === staleOwner.pid && token === staleOwner.token;
      const priorSamePid = pid === process.pid && token !== PROCESS_WRITER_TOKEN;
      const deadPid = (await processIsAlive(pid)) === false;
      if (!exactStaleOwner && !priorSamePid && !deadPid) continue;
      await removeSafeRegularFile(root, join(root, entry.name));
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // The async iterator normally closes it.
    }
  }
  if (!(await verifyDirectorySnapshot(rootSnapshot))) {
    throw unsafeFilesystem("object store root changed during writer recovery");
  }
}

function writerArtifactPath(root: string, prefix: string, pid: number): string {
  return join(root, `${prefix}${pid}.${PROCESS_WRITER_TOKEN}.${randomUUID()}`);
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
  create: boolean,
): Promise<SafeDirectorySnapshot | null> {
  const inside = relative(root, directory);
  if (inside.startsWith("..") || inside.startsWith(sep)) {
    throw unsafeFilesystem("filesystem path left the object store root");
  }
  if (create) await mkdir(root, { recursive: true });
  let rootStat: NumericFileStat | null;
  try {
    rootStat = (await lstat(root)) as unknown as NumericFileStat;
  } catch (error) {
    if (isMissing(error) && !create) return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafeFilesystem("object store root is not a real directory");
  }
  const entries: DirectoryEntrySnapshot[] = [{ path: root, stat: rootStat }];
  let current = root;
  for (const segment of inside === "" ? [] : inside.split(sep)) {
    if (!safePathSegment(segment)) throw unsafeFilesystem("unsafe internal directory segment");
    if (!(await verifyDirectoryEntry(entries[entries.length - 1] as DirectoryEntrySnapshot))) {
      throw unsafeFilesystem("object store directory changed during traversal");
    }
    current = join(current, segment);
    let found: NumericFileStat | null = null;
    try {
      found = (await lstat(current)) as unknown as NumericFileStat;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return null;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      found = (await lstat(current)) as unknown as NumericFileStat;
    }
    if (!found.isDirectory() || found.isSymbolicLink()) {
      throw unsafeFilesystem("object store path contains a symlink or non-directory component");
    }
    entries.push({ path: current, stat: found });
  }
  const snapshot = { entries };
  if (!(await verifyDirectorySnapshot(snapshot))) {
    throw unsafeFilesystem("object store directory changed during traversal");
  }
  return snapshot;
}

async function verifyDirectoryEntry(entry: DirectoryEntrySnapshot): Promise<boolean> {
  const found = (await lstat(entry.path).catch(() => null)) as NumericFileStat | null;
  return Boolean(
    found?.isDirectory() &&
      !found.isSymbolicLink() &&
      sameFile(entry.stat, found) &&
      entry.stat.mode === found.mode,
  );
}

async function verifyDirectorySnapshot(snapshot: SafeDirectorySnapshot): Promise<boolean> {
  for (const entry of snapshot.entries) {
    if (!(await verifyDirectoryEntry(entry))) return false;
  }
  return true;
}

async function safePathSnapshot(root: string, pathname: string): Promise<SafePathSnapshot | null> {
  const parent = await ensureSafeDirectory(root, dirname(pathname), false);
  if (!parent) return null;
  let found: NumericFileStat;
  try {
    found = (await lstat(pathname)) as unknown as NumericFileStat;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (found.isSymbolicLink()) {
    throw unsafeFilesystem("object store path contains a symlink");
  }
  if (!(await verifyDirectorySnapshot(parent))) {
    throw unsafeFilesystem("object store directory changed while inspecting a path");
  }
  return { path: pathname, stat: found, parent };
}

async function safeFileSnapshot(root: string, pathname: string): Promise<SafePathSnapshot | null> {
  const found = await safePathSnapshot(root, pathname);
  if (!found) return null;
  if (!found.stat.isFile() || !Number.isSafeInteger(found.stat.size) || found.stat.size < 0) {
    throw unsafeFilesystem("object store file path is not a regular file");
  }
  return found;
}

async function openSafeRegularFile(root: string, pathname: string): Promise<OpenedSafeFile | null> {
  const parent = await ensureSafeDirectory(root, dirname(pathname), false);
  if (!parent) return null;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return null;
    throw unsafeFilesystem("object store refused a symlinked or unreadable file");
  }
  try {
    const opened = (await handle.stat()) as unknown as NumericFileStat;
    const pathnameStat = (await lstat(pathname)) as unknown as NumericFileStat;
    if (
      !opened.isFile() ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      !pathnameStat.isFile() ||
      pathnameStat.isSymbolicLink() ||
      !sameFile(opened, pathnameStat) ||
      !sameStableMetadata(opened, pathnameStat) ||
      !(await verifyDirectorySnapshot(parent))
    ) {
      throw unsafeFilesystem("object store file changed while opening");
    }
    return { path: pathname, stat: opened, parent, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyOpenedFile(opened: OpenedSafeFile): Promise<boolean> {
  const current = (await opened.handle.stat().catch(() => null)) as NumericFileStat | null;
  const pathname = (await lstat(opened.path).catch(() => null)) as NumericFileStat | null;
  return Boolean(
    current?.isFile() &&
      pathname?.isFile() &&
      !pathname.isSymbolicLink() &&
      sameFile(opened.stat, current) &&
      sameFile(opened.stat, pathname) &&
      sameStableMetadata(opened.stat, current) &&
      sameStableMetadata(opened.stat, pathname) &&
      (await verifyDirectorySnapshot(opened.parent)),
  );
}

async function readWholeOpenedFile(opened: OpenedSafeFile, maximum: number): Promise<Uint8Array> {
  if (opened.stat.size > maximum) throw unsafeFilesystem("internal file exceeded its size limit");
  const bytes = new Uint8Array(opened.stat.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await opened.handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead <= 0) throw unsafeFilesystem("internal file ended while reading");
    offset += result.bytesRead;
  }
  if (!(await verifyOpenedFile(opened))) {
    throw unsafeFilesystem("internal file changed while reading");
  }
  return bytes;
}

async function writeExclusiveFile(
  root: string,
  pathname: string,
  bytes: Uint8Array,
): Promise<SafePathSnapshot> {
  const parent = await ensureSafeDirectory(root, dirname(pathname), true);
  if (!parent) throw unsafeFilesystem("object store write directory is unavailable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      pathname,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = (await handle.stat()) as unknown as NumericFileStat;
    const pathnameStat = (await lstat(pathname)) as unknown as NumericFileStat;
    if (
      !opened.isFile() ||
      !pathnameStat.isFile() ||
      pathnameStat.isSymbolicLink() ||
      !sameFile(opened, pathnameStat) ||
      !sameStableMetadata(opened, pathnameStat) ||
      !(await verifyDirectorySnapshot(parent))
    ) {
      throw unsafeFilesystem("object store staging file changed while writing");
    }
    return { path: pathname, stat: opened, parent };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifySafePath(snapshot: SafePathSnapshot): Promise<boolean> {
  const found = (await lstat(snapshot.path).catch(() => null)) as NumericFileStat | null;
  return Boolean(
    found?.isFile() &&
      !found.isSymbolicLink() &&
      sameFile(snapshot.stat, found) &&
      sameStableMetadata(snapshot.stat, found) &&
      (await verifyDirectorySnapshot(snapshot.parent)),
  );
}

async function publishCreateOnly(
  root: string,
  source: SafePathSnapshot,
  destination: string,
): Promise<boolean> {
  if (!(await verifySafePath(source))) {
    throw unsafeFilesystem("object store staging file changed before publication");
  }
  const parent = await ensureSafeDirectory(root, dirname(destination), true);
  if (!parent) throw unsafeFilesystem("object store destination is unavailable");
  const existing = await safePathSnapshot(root, destination);
  if (existing) {
    if (!existing.stat.isFile()) throw unsafeFilesystem("object destination is not a regular file");
    return false;
  }
  try {
    await link(source.path, destination);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const raced = await safePathSnapshot(root, destination);
    if (!raced?.stat.isFile()) {
      throw unsafeFilesystem("object destination changed to an unsafe path");
    }
    return false;
  }
  const published = await safeFileSnapshot(root, destination);
  if (
    !published ||
    !sameFile(source.stat, published.stat) ||
    !(await verifySafePath(source)) ||
    !(await verifyDirectorySnapshot(parent))
  ) {
    throw unsafeFilesystem("object destination changed during create-only publication");
  }
  return true;
}

async function publishReplace(
  root: string,
  source: SafePathSnapshot,
  destination: string,
): Promise<void> {
  if (!(await verifySafePath(source))) {
    throw unsafeFilesystem("object store staging file changed before publication");
  }
  const parent = await ensureSafeDirectory(root, dirname(destination), true);
  if (!parent) throw unsafeFilesystem("object store destination is unavailable");
  const existing = await safePathSnapshot(root, destination);
  if (existing && !existing.stat.isFile()) {
    throw unsafeFilesystem("object destination is not a regular file");
  }
  await rename(source.path, destination);
  const published = await safeFileSnapshot(root, destination);
  if (
    !published ||
    !sameFile(source.stat, published.stat) ||
    !sameStableMetadata(source.stat, published.stat) ||
    !(await verifyDirectorySnapshot(source.parent)) ||
    !(await verifyDirectorySnapshot(parent))
  ) {
    throw unsafeFilesystem("object destination changed during replacement");
  }
}

async function removeSafeRegularFile(
  root: string,
  pathname: string,
  expected?: NumericFileStat,
): Promise<void> {
  const found = await safeFileSnapshot(root, pathname);
  if (!found) return;
  if (expected && (!sameFile(expected, found.stat) || !sameStableMetadata(expected, found.stat))) {
    throw unsafeFilesystem("object store file changed before removal");
  }
  if (!(await verifySafePath(found))) {
    throw unsafeFilesystem("object store file changed before removal");
  }
  await unlink(pathname);
  if (!(await verifyDirectorySnapshot(found.parent))) {
    throw unsafeFilesystem("object store directory changed during removal");
  }
}

function collisionDomain(key: string): string {
  let domain = key;
  while (domain.endsWith(".meta")) {
    const sibling = domain.slice(0, -".meta".length);
    if (!validKey(sibling)) break;
    domain = sibling;
  }
  return domain;
}

interface WalkCandidate {
  readonly path: string;
  readonly key: string;
  readonly directory: boolean;
}

/**
 * Enumerate a bounded lexical prefix without collecting the whole store.
 * Directory entries are expanded lazily through a min-heap; unrelated
 * branches are pruned before they are opened.
 */
async function walkPrefix(
  base: string,
  root: string,
  prefix: string,
  after: string | null,
  maximum: number,
): Promise<string[]> {
  const descended = await descendPrefixDirectory(base, root, prefix);
  if (!descended) return [];
  const queue: WalkCandidate[] = [{ path: descended.path, key: descended.key, directory: true }];
  const found: string[] = [];
  let traversedEntries = 0;
  let logicalObjects = 0;
  let sidecars = 0;
  while (queue.length > 0 && found.length < maximum) {
    const candidate = heapPop(queue);
    if (!candidate) break;
    if (candidate.directory) {
      const directorySnapshot = await ensureSafeDirectory(root, candidate.path, false);
      if (!directorySnapshot) continue;
      const directory = await opendir(candidate.path);
      try {
        if (!(await verifyDirectorySnapshot(directorySnapshot))) {
          throw unsafeFilesystem("object listing directory changed while opening");
        }
        for await (const entry of directory) {
          traversedEntries += 1;
          if (traversedEntries > LIST_TRAVERSAL_ENTRY_LIMIT) {
            throw new ObjectStoreError(
              "unavailable",
              "object listing exceeded the bounded traversal entry limit",
            );
          }
          const key = candidate.key ? `${candidate.key}/${entry.name}` : entry.name;
          const pathname = join(candidate.path, entry.name);
          const pathSnapshot = await safePathSnapshot(root, pathname);
          if (!pathSnapshot) continue;
          const matches = key.startsWith(prefix) && (after === null || key > after);
          // `.meta` sidecars are storage, not objects. A directory with one of
          // those suffixes is still a valid key path.
          if (
            pathSnapshot.stat.isFile() &&
            (await isStorageSidecar(root, candidate.path, key, entry.name))
          ) {
            if (matches) {
              sidecars += 1;
              if (sidecars > LIST_LOGICAL_OBJECT_LIMIT) {
                throw new ObjectStoreError(
                  "unavailable",
                  "object listing exceeded the bounded sidecar limit",
                );
              }
            }
            continue;
          }
          if (pathSnapshot.stat.isDirectory()) {
            if (canDescend(key, prefix)) {
              heapPush(queue, { path: pathname, key, directory: true });
            }
            continue;
          }
          if (!pathSnapshot.stat.isFile()) {
            throw unsafeFilesystem("object listing encountered a non-regular filesystem entry");
          }
          if (matches) {
            logicalObjects += 1;
            if (logicalObjects > LIST_LOGICAL_OBJECT_LIMIT) {
              throw new ObjectStoreError(
                "unavailable",
                "object listing exceeded the bounded logical object limit",
              );
            }
            heapPush(queue, { path: pathname, key, directory: false });
          }
        }
      } finally {
        try {
          await directory.close();
        } catch {
          // The async iterator may have closed the directory already.
        }
      }
      if (!(await verifyDirectorySnapshot(directorySnapshot))) {
        throw unsafeFilesystem("object listing directory changed during traversal");
      }
      continue;
    }
    found.push(candidate.key);
  }
  return found;
}

interface PrefixDirectory {
  readonly path: string;
  readonly key: string;
}

/**
 * Follow only complete path segments from the requested prefix. A final
 * partial segment is left for `walkPrefix` to filter with ordinary
 * `startsWith` semantics, while an exact trailing slash can descend all the
 * way to that directory without opening any sibling branches.
 */
async function descendPrefixDirectory(
  base: string,
  root: string,
  prefix: string,
): Promise<PrefixDirectory | null> {
  const segments = prefix.split("/");
  const completeCount = prefix.endsWith("/")
    ? segments.length - 1
    : Math.max(segments.length - 1, 0);
  const complete = segments.slice(0, completeCount);
  if (complete.some((segment) => !safePathSegment(segment))) return null;

  const baseSnapshot = await ensureSafeDirectory(root, base, false);
  if (!baseSnapshot) return null;
  let path = base;
  let key = "";
  for (const segment of complete) {
    path = join(path, segment);
    const found = await ensureSafeDirectory(root, path, false);
    if (!found) return null;
    key = key ? `${key}/${segment}` : segment;
  }
  return { path, key };
}

async function isStorageSidecar(
  root: string,
  directory: string,
  key: string,
  name: string,
): Promise<boolean> {
  if (!name.endsWith(".meta") && !LEGACY_STAGING_KEY.test(key)) return false;
  return isLegacyStoragePath(root, key, join(directory, name), metadataPath(root, key));
}

/**
 * Identify a pathname that belongs to the pre-metadata namespace rather than
 * a logical object accepted by the current API. A primary metadata record is
 * the proof for every suffix-shaped key: the current writer always records
 * an etag, even when no content type was supplied.
 */
async function isLegacyStoragePath(
  root: string,
  key: string,
  pathname: string,
  primaryMetadata: string,
): Promise<boolean> {
  if (await isRegularFile(root, primaryMetadata)) return false;

  // The old filesystem writer rejected terminal `.partial` keys. Without a
  // new metadata record, a matching pathname can only be an interrupted old
  // staging write and must not leak through get/head/list.
  if (LEGACY_STAGING_KEY.test(key)) return true;

  // The old writer also rejected terminal `.meta` keys. If the sibling body
  // and sidecar are both present, this pathname is that sidecar, not a new
  // terminal object. Keep the sibling's metadata available for migration.
  if (!key.endsWith(".meta")) return false;
  const siblingKey = key.slice(0, -".meta".length);
  if (!validKey(siblingKey)) return false;
  const siblingPath = join(root, "objects", siblingKey);
  const sibling = await safeFileSnapshot(root, siblingPath);
  const legacy = await safeFileSnapshot(root, pathname);
  return Boolean(sibling && legacy);
}

function stagingPath(root: string, key: string): string {
  const keyDigest = createHash("sha256").update(key).digest("hex");
  return join(
    root,
    ".object-staging",
    `${keyDigest}.${process.pid}.${Date.now()}.${randomUUID()}.partial`,
  );
}

async function prepareLegacyKeyCollision(
  root: string,
  key: string,
  path: string,
  metadata: string,
): Promise<void> {
  if (key.endsWith(".meta")) {
    await migrateLegacyMetadataCollision(root, key, path, metadata);
    return;
  }
  if (LEGACY_STAGING_KEY.test(key)) {
    await removeLegacyStagingCollision(root, path, metadata);
  }
}

const LEGACY_STAGING_KEY = /\.\d+\.\d+\.partial$/u;

async function migrateLegacyMetadataCollision(
  root: string,
  key: string,
  path: string,
  metadata: string,
): Promise<void> {
  // Once a new-namespace metadata file exists, this exact terminal `.meta`
  // path is already a real object. Never reinterpret or remove it.
  if (await isRegularFile(root, metadata)) return;

  const siblingKey = key.slice(0, -".meta".length);
  if (!validKey(siblingKey)) return;
  const siblingPath = join(root, "objects", siblingKey);
  const sibling = await safeFileSnapshot(root, siblingPath);
  const legacy = await safeFileSnapshot(root, path);
  if (!sibling || !legacy) return;

  const normalized = await readMetadataFile(root, path);
  if (normalized === null) {
    throw new ObjectStoreError("unavailable", "legacy object metadata is unreadable");
  }
  const normalizedWithEtag = normalized.etag
    ? normalized
    : { ...normalized, etag: await digestFile(root, siblingPath, sibling.stat) };
  const siblingMetadata = metadataPath(root, siblingKey);
  await writeMigratedMetadata(root, siblingMetadata, normalizedWithEtag);
  await removeLegacyPathIfUnchanged(root, path, legacy.stat);
}

async function writeMigratedMetadata(
  root: string,
  metadataPathname: string,
  metadata: FileMetadata,
): Promise<void> {
  if (!metadata.contentType && !metadata.etag) return;
  if (await isRegularFile(root, metadataPathname)) return;
  const staging = stagingPath(root, `metadata:${metadataPathname}`);
  try {
    const staged = await writeExclusiveFile(
      root,
      staging,
      new TextEncoder().encode(
        JSON.stringify({
          ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
          ...(metadata.etag ? { etag: metadata.etag } : {}),
        }),
      ),
    );
    // A hard link makes the normalized metadata visible atomically and
    // leaves a concurrently-created primary metadata file untouched.
    await publishCreateOnly(root, staged, metadataPathname);
  } finally {
    await removeSafeRegularFile(root, staging).catch(() => undefined);
  }
}

async function removeLegacyPathIfUnchanged(
  root: string,
  pathname: string,
  before: NumericFileStat,
): Promise<void> {
  const current = await safeFileSnapshot(root, pathname);
  if (!current || !sameFile(before, current.stat) || !sameStableMetadata(before, current.stat)) {
    return;
  }
  await removeSafeRegularFile(root, pathname, before);
}

async function removeLegacyStagingCollision(
  root: string,
  pathname: string,
  metadataPathname: string,
): Promise<void> {
  // A primary metadata file proves that this suffix-shaped key is a valid
  // object from the new format. An old staging file never had one.
  if (await isRegularFile(root, metadataPathname)) return;
  const stale = await safeFileSnapshot(root, pathname);
  if (!stale) return;
  await removeSafeRegularFile(root, pathname, stale.stat);
}

async function isRegularFile(root: string, pathname: string): Promise<boolean> {
  return (await safeFileSnapshot(root, pathname)) !== null;
}

async function digestFile(
  root: string,
  pathname: string,
  expected: NumericFileStat,
): Promise<string> {
  let opened: OpenedSafeFile | null = null;
  try {
    opened = await openSafeRegularFile(root, pathname);
    if (!opened || !sameFile(expected, opened.stat) || !sameStableMetadata(expected, opened.stat)) {
      throw new Error("legacy object changed while migrating");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(FILE_READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.stat.size) {
      const length = Math.min(chunk.byteLength, opened.stat.size - offset);
      const result = await opened.handle.read(chunk, 0, length, offset);
      if (result.bytesRead <= 0) throw new Error("legacy object ended while migrating");
      hash.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (!(await verifyOpenedFile(opened))) {
      throw new Error("legacy object changed while migrating");
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError("unavailable", "legacy object changed while migrating");
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}

function metadataPath(root: string, key: string): string {
  const encoded = Buffer.from(key, "utf8").toString("hex");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 200) {
    chunks.push(encoded.slice(offset, offset + 200));
  }
  const last = chunks.pop();
  if (!last) throw new ObjectStoreError("invalid", "unusable object key");
  chunks.push(`${last}.json`);
  return join(root, ".object-metadata", ...chunks);
}

function safePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function canDescend(key: string, prefix: string): boolean {
  return prefix === "" || key === prefix || key.startsWith(prefix) || prefix.startsWith(`${key}/`);
}

function heapPush(queue: WalkCandidate[], value: WalkCandidate): void {
  queue.push(value);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if ((queue[parent]?.key ?? "") <= value.key) break;
    queue[index] = queue[parent] as WalkCandidate;
    index = parent;
  }
  queue[index] = value;
}

function heapPop(queue: WalkCandidate[]): WalkCandidate | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (!first || !last || queue.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= queue.length) break;
    const right = left + 1;
    const child =
      right < queue.length && (queue[right]?.key ?? "") < (queue[left]?.key ?? "") ? right : left;
    if ((queue[child]?.key ?? "") >= last.key) break;
    queue[index] = queue[child] as WalkCandidate;
    index = child;
  }
  queue[index] = last;
  return first;
}

/**
 * A key that may become a path.
 *
 * Refused rather than sanitised: sanitising invents a key the caller did not
 * write, and two different keys that sanitise alike become one object.
 */
function validKey(key: string): boolean {
  if (key === "" || key.length > 1_024) return false;
  if (key.startsWith("/") || key.includes("//") || key.includes("\0")) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function collect(
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as unknown as BodyInit).arrayBuffer());
}

interface FileMetadata {
  readonly contentType?: string;
  readonly etag?: string;
}

async function writeMetadata(
  root: string,
  key: string,
  path: string,
  legacyPath: string,
  contentType: string | undefined,
  etag: string,
): Promise<void> {
  if (!contentType && !etag) {
    await removeSafeRegularFile(root, path);
    await removeLegacyMetadata(root, key, legacyPath);
    return;
  }
  const staging = stagingPath(root, `metadata:${key}`);
  try {
    const staged = await writeExclusiveFile(
      root,
      staging,
      new TextEncoder().encode(JSON.stringify({ ...(contentType ? { contentType } : {}), etag })),
    );
    await publishReplace(root, staged, path);
  } finally {
    await removeSafeRegularFile(root, staging).catch(() => undefined);
  }
  await removeLegacyMetadata(root, key, legacyPath);
}

async function removeLegacyMetadata(root: string, key: string, legacyPath: string): Promise<void> {
  // A safe object key may itself end in `.meta`; never remove that body while
  // cleaning the legacy sidecar for its sibling key.
  if (await isRegularFile(root, metadataPath(root, `${key}.meta`))) return;
  await removeSafeRegularFile(root, legacyPath);
}

async function readMetadata(
  root: string,
  path: string,
  legacyPath?: string,
): Promise<FileMetadata> {
  const current = await readMetadataFile(root, path);
  if (current !== null) return current;
  if (legacyPath) return (await readMetadataFile(root, legacyPath)) ?? {};
  return {};
}

async function readMetadataFile(root: string, path: string): Promise<FileMetadata | null> {
  let opened: OpenedSafeFile | null = null;
  let raw: string | null = null;
  try {
    opened = await openSafeRegularFile(root, path);
    if (!opened) return null;
    // Sidecars are tiny internal metadata. Refuse a malformed/hostile sidecar
    // before allocating proportional to its declared file size.
    if (opened.stat.size > METADATA_MAX_BYTES) return null;
    const bytes = await readWholeOpenedFile(opened, METADATA_MAX_BYTES);
    raw = new TextDecoder().decode(bytes);
  } catch {
    return null;
  } finally {
    if (opened) {
      try {
        await opened.handle.close();
      } catch {
        // The metadata handle may already be closed after a short read.
      }
    }
  }
  if (raw === null || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as { readonly contentType?: unknown; readonly etag?: unknown };
      return {
        ...(typeof value.contentType === "string" && value.contentType
          ? { contentType: value.contentType }
          : {}),
        ...(typeof value.etag === "string" && value.etag ? { etag: value.etag } : {}),
      };
    }
  } catch {
    // Existing stores used the sidecar as a plain content-type string.
  }
  return { contentType: raw };
}

function streamFromFile(opened: OpenedSafeFile): ReadableStream<Uint8Array> {
  const { handle } = opened;
  const size = opened.stat.size;
  let offset = 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  const finish = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      if (!(await verifyOpenedFile(opened))) {
        await close();
        controller.error(new Error("object changed while reading"));
        return;
      }
      await close();
      controller.close();
    } catch (error) {
      await close();
      controller.error(error);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) {
        await finish(controller);
        return;
      }
      const length = Math.min(FILE_READ_CHUNK_BYTES, size - offset);
      const chunk = new Uint8Array(length);
      try {
        const result = await handle.read(chunk, 0, length, offset);
        if (result.bytesRead !== length) {
          await close();
          controller.error(new Error("object changed while reading"));
          return;
        }
        offset += result.bytesRead;
        controller.enqueue(chunk);
        if (offset >= size) {
          await finish(controller);
        }
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
}

function sameFile(left: NumericFileStat, right: NumericFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left: NumericFileStat, right: NumericFileStat): boolean {
  return left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
