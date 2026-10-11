import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workerdWorkerPrivateSocketDirectory } from "../../src/workerd-worker-runtime-owner.ts";

const STATE_NAME = "runtime-owner.json";

async function ownerStateFiles(directory: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === STATE_NAME) found.push(path);
    else if (entry.isDirectory()) found.push(...(await ownerStateFiles(path, depth - 1)));
  }
  return found;
}

/**
 * Remove the `/tmp` private Service socket namespaces recorded by every Worker
 * runtime owner below `root`, before a test discards `root`.
 *
 * A Host that is killed keeps its incarnation's namespace on purpose, for the
 * next owner to recover; a test that then deletes its data root leaves that
 * namespace behind forever, because it lives outside the data root. Only the
 * exact paths derived from this root's own owner records are touched, and only
 * when they are real directories owned by this user, so a concurrent test or
 * Host is never affected. Call it before removing `root`.
 */
export async function removeOwnerPrivateSocketDirectories(root: string): Promise<void> {
  for (const stateFile of await ownerStateFiles(root, 4)) {
    let state: { workerResourceUid?: unknown; incarnations?: unknown };
    try {
      state = JSON.parse(await readFile(stateFile, "utf8")) as typeof state;
    } catch {
      continue;
    }
    if (typeof state.workerResourceUid !== "string" || !Array.isArray(state.incarnations)) continue;
    const ownerRoot = await realpath(dirname(dirname(stateFile))).catch(() => null);
    if (!ownerRoot) continue;
    for (const incarnation of state.incarnations as { operationId?: unknown }[]) {
      if (typeof incarnation?.operationId !== "string") continue;
      const path = workerdWorkerPrivateSocketDirectory(
        ownerRoot,
        state.workerResourceUid,
        incarnation.operationId,
      );
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        continue;
      await rm(path, { recursive: true, force: true });
    }
  }
}
