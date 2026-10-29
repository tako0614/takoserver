import {
  type BigIntStats,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DeployError, preflightError } from "./errors.ts";

const OUTPUTS = [".wrangler", "dist", "console/dist", "site/dist"] as const;

function metadata(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw preflightError("owner gate output metadata is unavailable");
  }
}

function directory(path: string): BigIntStats {
  const stat = metadata(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink())
    throw preflightError("owner gate paths must be physical directories");
  try {
    if (realpathSync(path) === path) return stat;
  } catch {
    // A disappearing or replaced directory is never owned output.
  }
  throw preflightError("owner gate paths must be physical directories");
}

function sameDirectory(path: string, before: BigIntStats): void {
  const after = directory(path);
  // Creating the gate's own child directories legitimately changes parent
  // timestamps and link counts. The directory itself must stay the same.
  if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode)
    throw preflightError("owner gate parent directory changed");
}

function assertLinkFree(path: string): void {
  const stat = metadata(path);
  if (stat === null || stat.isSymbolicLink())
    throw preflightError("owner gate outputs must be link-free");
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertLinkFree(join(path, name));
  } else if (!stat.isFile() || stat.nlink !== 1n) {
    // The workspace's existing finalizer unseals regular files. A retained
    // hard link must never let that operation change another owner's file.
    throw preflightError("owner gate outputs must be link-free");
  }
}

/**
 * Keep one real owner gate's generated outputs outside its subsequent closed
 * native build. Pre-existing data is never adopted, and the native source and
 * dependency inspectors still decide whether the resulting input is closed.
 */
export async function runOwnerGateWithTransientOutputs(
  ownerRoot: string,
  workspaceRoot: string,
  gate: () => Promise<unknown>,
): Promise<void> {
  if (
    !isAbsolute(ownerRoot) ||
    resolve(ownerRoot) !== ownerRoot ||
    !isAbsolute(workspaceRoot) ||
    resolve(workspaceRoot) !== workspaceRoot
  )
    throw preflightError("owner gate paths must be absolute physical directories");
  const workspace = directory(workspaceRoot);
  const local = relative(ownerRoot, workspaceRoot);
  if (local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)))
    throw preflightError("owner gate workspace must be outside its source tree");
  const parents = new Map(
    [ownerRoot, join(ownerRoot, "console"), join(ownerRoot, "site")].map(
      (path) => [path, directory(path)] as const,
    ),
  );
  for (const name of OUTPUTS) {
    if (metadata(join(ownerRoot, name)) !== null)
      throw preflightError("owner gate output already exists; it is not owned by this gate", name);
  }

  let failed = false;
  let originalError: unknown;
  try {
    await gate();
  } catch (error) {
    failed = true;
    originalError = error;
  }

  let retentionError: unknown;
  try {
    for (const [path, before] of parents) sameDirectory(path, before);
    sameDirectory(workspaceRoot, workspace);
    const outputs = OUTPUTS.flatMap((name) => {
      const path = join(ownerRoot, name);
      const stat = metadata(path);
      if (stat === null) return [];
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw preflightError("owner gate output is not an owned directory", name);
      return [{ name, path, stat }];
    });
    for (const output of outputs) assertLinkFree(output.path);
    if (outputs.length > 0) {
      const retained = mkdtempSync(join(workspaceRoot, "owner-gate-outputs-"));
      for (const output of outputs) {
        for (const [path, before] of parents) sameDirectory(path, before);
        sameDirectory(workspaceRoot, workspace);
        sameDirectory(output.path, output.stat);
        const destination = join(retained, output.name);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        // No copy/delete fallback: a different filesystem or a changed path
        // refuses the build, retaining the gate's data for its owner.
        renameSync(output.path, destination);
        sameDirectory(destination, output.stat);
        assertLinkFree(destination);
      }
    }
    for (const [path, before] of parents) sameDirectory(path, before);
    sameDirectory(workspaceRoot, workspace);
  } catch (error) {
    retentionError =
      error instanceof DeployError
        ? error
        : preflightError(
            "owner gate outputs could not be retained",
            error instanceof Error ? error.message : undefined,
          );
  }
  // A secondary filesystem refusal must not replace the original gate RED.
  if (failed) throw originalError;
  if (retentionError !== undefined) throw retentionError;
}
