import { lstatSync, mkdtempSync, readdirSync, rmSync, type Stats, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const MAX_BYTES = 64 * 1024 * 1024;
const POLL_MS = 250;

/** Opt-in disposable resource state, for a fixture that does not test disk
 * crash durability. Does not move TMPDIR, caches, sources or other fixtures.
 * The 64 MiB bound is sampled, not a filesystem quota. */
export function createBoundedMiniflareState<T extends { dispose(): Promise<void> }>(
  create: (options: { resourcePersistencePath?: string }) => T,
  root: string | undefined,
  // A regression may lower the bound without needing a >64 MiB tmpfs mount.
  maxBytes = MAX_BYTES,
): { runtime: T; dispose(): Promise<void> } {
  if (!root) {
    const runtime = create({});
    return { runtime, dispose: () => runtime.dispose() };
  }
  if (!isAbsolute(root) || !lstatSync(root).isDirectory() || statfsSync(root).type !== TMPFS_MAGIC)
    throw new Error("fixture state root must be an existing absolute directory on tmpfs");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw new Error("fixture state bound must be a positive integer at most 64 MiB");
  const directory = mkdtempSync(join(root, "artifact-resume-"));
  process.stderr.write(`artifact-resume fixture state: ${directory}\n`);
  let runtime: T;
  try {
    runtime = create({ resourcePersistencePath: directory });
  } catch (error) {
    try {
      rmSync(directory, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture creation and cleanup failed");
    }
    throw error;
  }
  let peak = 0;
  let failure: unknown;
  let stopping: Promise<void> | undefined;
  let finished: Promise<void> | undefined;
  const stop = () => {
    stopping ??= Promise.resolve().then(() => runtime.dispose());
    return stopping;
  };
  const measure = () => {
    try {
      peak = Math.max(peak, allocatedBytes(directory));
      if (peak > maxBytes)
        throw new Error(`fixture resource state exceeded the ${maxBytes}-byte bound`);
    } catch (error) {
      failure ??= error;
      // Only this fixture's runtime is disposed. Keep the failure for the
      // caller even if disposal itself succeeds or the body catches errors.
      void stop().catch(() => {});
    }
  };
  const timer = setInterval(measure, POLL_MS);
  timer.unref();
  return {
    runtime,
    dispose() {
      finished ??= (async () => {
        try {
          await stop();
        } finally {
          clearInterval(timer);
        }
        // A rejected dispose leaves custody intact: an unsettled runtime may
        // still own it. Successful disposal must precede measurement/removal.
        measure();
        rmSync(directory, { recursive: true });
        process.stderr.write(`artifact-resume fixture state peaked at ${peak} bytes\n`);
        if (failure !== undefined) throw failure;
      })();
      return finished;
    },
  };
}

function allocatedBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    total += stat.blocks * 512;
    if (stat.isDirectory()) {
      try {
        total += allocatedBytes(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}
