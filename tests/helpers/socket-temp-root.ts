import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh private temporary root no longer than `maximumBytes`, for a test that
 * binds Unix sockets below it.
 *
 * It is created under `TMPDIR` when that leaves room and under `/tmp`
 * otherwise, so whether a socket-bearing test passes does not depend on how
 * long the runner's `TMPDIR` happens to be. The six random `mkdtemp`
 * characters are counted.
 */
export async function mkdtempForSockets(prefix: string, maximumBytes: number): Promise<string> {
  for (const parent of [tmpdir(), "/tmp"]) {
    if (Buffer.byteLength(join(parent, `${prefix}XXXXXX`)) <= maximumBytes) {
      return await mkdtemp(join(parent, prefix));
    }
  }
  throw new Error(`no temporary directory leaves room for a ${maximumBytes}-byte socket root`);
}
