import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { privateDirectoryChainProblem, unsafeAncestorProblem } from "./selfhost-data-root.ts";
import { parseStrictJson } from "./strict-json.ts";

export const SINGLE_HOST_VARIABLE = "TAKOSERVER_SINGLE_HOST";
const LOCK_NAME = ".host.lock";
const EPOCH_NAME = ".host-epoch.json";

/** Explicit operator assertion: all state stays on this one physical Host. */
export function parseSingleHostConfiguration(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = parseStrictJson(new TextEncoder().encode(raw), 4096);
  } catch {
    throw new Error(`${SINGLE_HOST_VARIABLE} requires JSON with one stable hostId`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "hostId" ||
    typeof (value as { hostId?: unknown }).hostId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test((value as { hostId: string }).hostId)
  ) {
    throw new Error(`${SINGLE_HOST_VARIABLE} requires JSON with one stable hostId`);
  }
  return (value as { hostId: string }).hostId;
}

// Fail closed for unknown filesystem types, including NFS, CIFS, 9p, Ceph and
// FUSE. Overlay is needed for a local container's private data root; the
// operator assertion still excludes network-backed overlay storage.
const LOCAL_FILESYSTEMS = new Set([
  0xef53n, // ext2/3/4
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0x2fc12fc1n, // ZFS
  0xf2f52010n, // F2FS
  0x794c7630n, // overlay
]);

const heldRoots = new Map<string, string>();

/** Previous-boot absence is valid only beneath currently kernel-held custody. */
export function singleHostPreviousBootIsGone(bootId: string, storageRoot: string): boolean {
  if (heldRoots.size === 0) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId)) return false;
  let canonical: string;
  try {
    canonical = realpathSync(storageRoot);
  } catch {
    // No scoped proof is available; the original kernel process checks still apply.
    return false;
  }
  for (const [root, currentBootId] of heldRoots) {
    if ((canonical === root || canonical.startsWith(`${root}/`)) && bootId !== currentBootId)
      return true;
  }
  return false;
}

export function assertSingleHostFilesystem(path: string): void {
  const type = BigInt.asUintN(32, statfsSync(path, { bigint: true }).type);
  if (!LOCAL_FILESYSTEMS.has(type)) {
    throw new Error(
      `single-host refuses network or unqualified filesystem at ${path} (0x${type.toString(16)})`,
    );
  }
}

interface Epoch {
  readonly schema: "takoserver.single-host-epoch@1";
  readonly hostId: string;
  readonly machineId: string;
  readonly bootId: string;
  readonly epoch: number;
}

export interface SingleHostLease {
  readonly epoch: number;
  readonly bootId: string;
  readonly previousBootId: string | undefined;
  /** Only after every dependent and writer has stopped. Never unlinks the lock. */
  release(): void;
}

function privateFile(fd: number, path: string): void {
  const held = fstatSync(fd);
  const named = lstatSync(path);
  if (
    !held.isFile() ||
    held.uid !== process.getuid?.() ||
    (held.mode & 0o077) !== 0 ||
    held.nlink !== 1 ||
    held.dev !== named.dev ||
    held.ino !== named.ino
  ) {
    throw new Error(`single-host custody file is not private and stable: ${path}`);
  }
}

function safeControlDirectory(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("single-host requires local owner identity");
  let current = path;
  while (true) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(current) !== current) {
      throw new Error(`TAKOSERVER_DB requires stable real directories: ${current}`);
    }
    const problem = unsafeAncestorProblem(metadata, uid, current, "TAKOSERVER_DB");
    if (problem) throw new Error(problem);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Kernel ownership, not recorded PID or machine-id, decides who may write.
 * The lock inode is permanent. Only the epoch is atomically replaced, and it
 * is fsynced before the caller can open SQL or start any children/listeners.
 */
export function acquireSingleHostLease(input: {
  readonly dataRoot: string;
  readonly hostId: string;
  readonly databasePath: string;
}): SingleHostLease {
  if (process.platform !== "linux") throw new Error("single-host lease requires Linux");
  const problem = privateDirectoryChainProblem(input.dataRoot, SINGLE_HOST_VARIABLE);
  if (problem) throw new Error(problem);
  assertSingleHostFilesystem(input.dataRoot);
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f]{32}$/u.test(machineId) || !/^[0-9a-f-]{36}$/u.test(bootId)) {
    throw new Error("single-host machine-id/boot_id cross-check is unavailable");
  }
  const library = dlopen("libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
  });
  const descriptors: number[] = [];
  let registered = false;
  const lock = (path: string): void => {
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    descriptors.push(fd);
    if (library.symbols.fcntl(fd, 2, 1) !== 0)
      throw new Error("single-host could not set close-on-exec");
    privateFile(fd, path);
    if (library.symbols.flock(fd, 2 | 4) !== 0) {
      throw new Error(`single-host lease is held or unavailable: ${path}`);
    }
    privateFile(fd, path);
    fsyncSync(fd);
  };
  let closed = false;
  const release = (): void => {
    if (closed) return;
    closed = true;
    if (registered) heldRoots.delete(input.dataRoot);
    for (const fd of descriptors.reverse()) closeSync(fd);
    library.close();
  };
  let temporary: string | undefined;
  try {
    lock(join(input.dataRoot, LOCK_NAME));
    if (input.databasePath !== ":memory:") {
      const database = existsSync(input.databasePath)
        ? realpathSync(input.databasePath)
        : join(
            realpathSync(dirname(resolve(input.databasePath))),
            basename(resolve(input.databasePath)),
          );
      assertSingleHostFilesystem(dirname(database));
      safeControlDirectory(dirname(database));
      // Lock default databases too: a peer may name this same DB from another root.
      lock(`${database}.host.lock`);
    }
    const path = join(input.dataRoot, EPOCH_NAME);
    let previous: Epoch | undefined;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        privateFile(fd, path);
        if (fstatSync(fd).size > 2048) throw new Error("single-host epoch is malformed");
        const value = JSON.parse(readFileSync(fd, "utf8")) as Epoch;
        if (
          Object.keys(value).sort().join(",") !== "bootId,epoch,hostId,machineId,schema" ||
          value.schema !== "takoserver.single-host-epoch@1" ||
          !Number.isSafeInteger(value.epoch) ||
          value.epoch < 1 ||
          value.epoch >= Number.MAX_SAFE_INTEGER ||
          !/^[0-9a-f-]{36}$/u.test(value.bootId)
        )
          throw new Error("single-host epoch is malformed");
        if (value.hostId !== input.hostId || value.machineId !== machineId) {
          throw new Error("single-host hostId/machine-id cross-check mismatch; refusing takeover");
        }
        previous = value;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const epoch = (previous?.epoch ?? 0) + 1;
    temporary = join(input.dataRoot, `.host-epoch-${randomUUID()}`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          schema: "takoserver.single-host-epoch@1",
          hostId: input.hostId,
          machineId,
          bootId,
          epoch,
        } satisfies Epoch),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    temporary = undefined;
    const directory = openSync(
      input.dataRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    heldRoots.set(input.dataRoot, bootId);
    registered = true;
    return { epoch, bootId, previousBootId: previous?.bootId, release };
  } catch (error) {
    if (temporary) unlinkSync(temporary);
    release();
    throw error;
  }
}
