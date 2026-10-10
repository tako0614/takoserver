import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
