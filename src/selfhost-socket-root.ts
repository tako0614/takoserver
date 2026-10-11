import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { privateDirectoryChainProblem } from "./selfhost-data-root.ts";
import {
  SELFHOST_SOCKET_DIRECTORY_PREFIX,
  selfhostPrivateSocketRoot,
} from "./selfhost-socket-layout.ts";

/**
 * Create `<data root>/s` private when it is absent and say why it cannot be
 * trusted, or `undefined` when it can: the same owner, 0700 and no-writable-
 * ancestor rule as the v2 private planes. An existing directory is never
 * re-permissioned; it holds only per-start listener directories, so the
 * diagnostic says it may be deleted while the Host is stopped.
 */
export function prepareSelfhostSocketRoot(dataRoot: string): string | undefined {
  const root = selfhostPrivateSocketRoot(dataRoot);
  if (lstatSync(root, { throwIfNoEntry: false }) === undefined) {
    try {
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return `the socket directory ${root} cannot be created (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
      }
    }
  }
  const problem = privateDirectoryChainProblem(
    root,
    "the socket directory (TAKOSERVER_DATA_ROOT/s)",
  );
  return problem
    ? `${problem}; it holds only per-start listener directories and may be deleted while the Host is stopped`
    : undefined;
}

/** A per-incarnation broker directory: one layout prefix plus six `mkdtemp` characters. */
const BROKER_DIRECTORY = new RegExp(
  `^(?:${SELFHOST_SOCKET_DIRECTORY_PREFIX.actorBrokers}|${SELFHOST_SOCKET_DIRECTORY_PREFIX.workflowBrokers})[A-Za-z0-9]{6}$`,
  "u",
);
/** A directory written this recently may belong to a listener that is binding now. */
const SETTLED_MS = 5_000;

type SocketState = "refused" | "live" | "unknown";

/** Whether anything accepts on a socket pathname; only a refusal proves nothing does. */
function socketState(path: string): Promise<SocketState> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (state: SocketState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1_000, () => done("unknown"));
    socket.once("connect", () => done("live"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" ? "refused" : "unknown"),
    );
  });
}

/** Wall-clock time this machine booted, or 0 when it cannot be read. */
function machineBootTimeMs(): number {
  try {
    const line = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("btime "));
    const seconds = Number(line?.slice("btime ".length));
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1_000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Remove broker directories in `<data root>/s` that a previous Host process
 * left behind when it was killed, and only those whose abandonment is proved.
 *
 * There is no Host-wide lock on a data root, so nothing here assumes this is
 * the only Host. A directory is removed only when it is a broker directory
 * this user created privately (real, 0700, canonical), has not been written
 * for a while, and is either
 *
 * - holding only socket files that refuse connections: no process accepts on
 *   any of them, as a killed Host leaves them (a Host that closes a broker
 *   also unlinks its socket), or
 * - empty and last written before this machine booted, so no running process
 *   can have created it.
 *
 * Anything else, including Workflow execution directories, which also hold
 * configuration and modules, is retained. Each removal re-reads the directory
 * and `rmdir` refuses one that gained an entry.
 */
export async function sweepSelfhostSocketRoot(
  dataRoot: string,
  options: {
    readonly now?: number;
    readonly machineBootTimeMs?: number;
    readonly socketState?: (path: string) => Promise<SocketState>;
  } = {},
): Promise<{ readonly removed: readonly string[]; readonly retained: number }> {
  const removed: string[] = [];
  let retained = 0;
  if (dataRoot === ":memory:") return { removed, retained };
  const root = selfhostPrivateSocketRoot(dataRoot);
  const uid = process.getuid?.();
  const now = options.now ?? Date.now();
  const bootTimeMs = options.machineBootTimeMs ?? machineBootTimeMs();
  const probe = options.socketState ?? socketState;
  const privateDirectory = async (path: string) => {
    const info = await lstat(path).catch(() => null);
    return info?.isDirectory() &&
      !info.isSymbolicLink() &&
      uid !== undefined &&
      info.uid === uid &&
      (info.mode & 0o777) === 0o700 &&
      (await realpath(path).catch(() => null)) === path
      ? info
      : null;
  };
  if (!(await privateDirectory(root))) return { removed, retained };
  for (const name of await readdir(root)) {
    if (!BROKER_DIRECTORY.test(name)) continue;
    const directory = join(root, name);
    const info = await privateDirectory(directory);
    if (!info || info.mtimeMs > now - SETTLED_MS) {
      retained += 1;
      continue;
    }
    const children = await readdir(directory);
    let abandoned = children.length === 0 ? info.mtimeMs < bootTimeMs : true;
    for (const child of children) {
      if (!abandoned) break;
      const path = join(directory, child);
      const entry = await lstat(path).catch(() => null);
      abandoned =
        entry !== null &&
        entry.isSocket() &&
        entry.uid === uid &&
        (await probe(path)) === "refused";
    }
    // A listener binding into this directory since it was examined changes
    // its mtime; then nothing here is proved abandoned any more.
    if (!abandoned || (await privateDirectory(directory))?.mtimeMs !== info.mtimeMs) {
      retained += 1;
      continue;
    }
    try {
      for (const child of children) await unlink(join(directory, child));
      await rmdir(directory);
      removed.push(directory);
    } catch {
      retained += 1;
    }
  }
  return { removed, retained };
}
