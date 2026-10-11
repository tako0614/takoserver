import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The variable an operator sets; named by every data-root diagnostic. */
export const SELFHOST_DATA_ROOT_VARIABLE = "TAKOSERVER_DATA_ROOT";
/** The documented default, relative to the process working directory. */
export const SELFHOST_DEFAULT_DATA_ROOT = ".takoserver";
/** Test-only control state; never a filesystem path, and passed through unchanged. */
export const SELFHOST_MEMORY_DATA_ROOT = ":memory:";

/**
 * The data root every other self-host module receives: absolute and canonical.
 *
 * The default is relative, while the Actor, Workflow and private-plane owners
 * accept only an absolute directory whose realpath is the path itself. Read
 * once, here, the setting is resolved against the working directory and its
 * existing prefix is canonicalized, so a relative or symlinked root no longer
 * becomes an opaque refusal inside one of those owners. Canonicalizing at boot
 * is what the operator would get by writing the real path; every later
 * private-directory check (owner, 0700, no symlink, realpath equality) still
 * runs against it. Components that do not exist yet cannot be symlinks, so
 * nothing is created here.
 */
export function resolveSelfhostDataRoot(
  configured: string | undefined,
  cwd: string = process.cwd(),
): string {
  const value = configured ?? SELFHOST_DEFAULT_DATA_ROOT;
  if (value === SELFHOST_MEMORY_DATA_ROOT) return value;
  if (value.trim() === "" || value.includes("\u0000")) {
    throw new TypeError(
      `${SELFHOST_DATA_ROOT_VARIABLE} must name a directory (or ${SELFHOST_MEMORY_DATA_ROOT}); it is ${JSON.stringify(value)}`,
    );
  }
  const absolute = resolve(cwd, value);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // ENOENT for an entry that exists is a dangling symlink, not a component
      // still to be created; carrying it forward would hide where state goes.
      if (code !== "ENOENT" || lstatSync(current, { throwIfNoEntry: false }) !== undefined) {
        throw new TypeError(
          `${SELFHOST_DATA_ROOT_VARIABLE} ${absolute} cannot be resolved (${code ?? "unknown error"})`,
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
}

/**
 * Create the data root private (0700, with any missing parents) when it does
 * not exist yet, and report whether it did. An existing directory is used
 * exactly as it is: its permissions are the operator's, and the v2 private
 * planes say by name when they require it to be private.
 *
 * Without this, the first writer created it with the default 0755 although it
 * holds signing keys, tenant data and sockets.
 */
export function createSelfhostDataRootIfAbsent(dataRoot: string): boolean {
  if (dataRoot === SELFHOST_MEMORY_DATA_ROOT) return false;
  if (lstatSync(dataRoot, { throwIfNoEntry: false }) !== undefined) return false;
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  // The mode above is filtered by umask; the root itself is exactly 0700.
  chmodSync(dataRoot, 0o700);
  return true;
}

/**
 * The ancestor rule of {@link privateDirectoryChainProblem}: owned by root or
 * by this user, and writable by no other user unless it is sticky and
 * root-owned.
 */
export function unsafeAncestorProblem(
  metadata: { readonly uid: number; readonly mode: number },
  uid: number,
  current: string,
  name: string,
): string | undefined {
  if (metadata.uid !== 0 && metadata.uid !== uid) {
    return `${name} has an ancestor owned by another user: ${current} has owner uid ${metadata.uid}, but needs owner uid 0 or ${uid}`;
  }
  if ((metadata.mode & 0o022) !== 0 && !((metadata.mode & 0o1000) !== 0 && metadata.uid === 0)) {
    const mode = (metadata.mode & 0o7777).toString(8).padStart(4, "0");
    return `${name} has an unsafe writable ancestor: ${current} has mode ${mode} and owner uid ${metadata.uid}`;
  }
  return undefined;
}

/**
 * Why `path` is not a directory this user can trust with private state, or
 * `undefined` when it is.
 *
 * The leaf must be a real directory owned by this user and closed to group and
 * other (0700). Every ancestor must be a real directory owned by root or by
 * this user that no other user can write, except a sticky root-owned one such
 * as `/tmp`: otherwise another user (its owner, or one with write access)
 * could rename the leaf away and put their own directory in its place. The
 * same rule guards the v2 private planes and the socket directory.
 */
export function privateDirectoryChainProblem(path: string, name: string): string | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return `${name} must be an absolute canonical private directory`;
  }
  const uid = process.getuid?.();
  if (uid === undefined) return `${name} requires local owner identity`;
  let current = path;
  let leaf = true;
  while (true) {
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(current);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        realpathSync(current) !== current
      ) {
        throw new Error("not a real directory");
      }
    } catch {
      return `${name} must use real directories: ${current} is not one`;
    }
    const mode = (metadata.mode & 0o7777).toString(8).padStart(4, "0");
    if (leaf) {
      if (metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
        return (
          `${name} must be owned and private: ${current} has mode ${mode} and owner uid ` +
          `${metadata.uid}, but needs mode 0700 and owner uid ${uid}`
        );
      }
      leaf = false;
    } else {
      const problem = unsafeAncestorProblem(
        { uid: Number(metadata.uid), mode: Number(metadata.mode) },
        uid,
        current,
        name,
      );
      if (problem) return problem;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
