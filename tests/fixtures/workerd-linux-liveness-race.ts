import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import type { LinuxProcessIdentity } from "../../src/workerd-linux-process.ts";

const [identityJson, gateDirectory, mode] = process.argv.slice(-3);
if (
  !identityJson ||
  !gateDirectory ||
  !["reaped", "still-live", "permission-denied", "malformed-after-reap"].includes(mode ?? "")
)
  throw new Error("liveness race fixture arguments invalid");
const identity = JSON.parse(identityJson) as LinuxProcessIdentity;
const statPath = `/proc/${identity.pid}/stat`;
const originalReadFile = filesystem.readFile;
let injected = false;

// This whole module runs in a separate Bun process. It intercepts only the
// second proc read, after production liveness has already passed kill(pid, 0).
mock.module("node:fs/promises", () => ({
  ...filesystem,
  async readFile(...args: Parameters<typeof originalReadFile>) {
    if (args[0] === statPath && !injected) {
      injected = true;
      await filesystem.writeFile(join(gateDirectory, "reached-stat-read"), "");
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (
          await filesystem.access(join(gateDirectory, "continue")).then(
            () => true,
            () => false,
          )
        )
          break;
        await Bun.sleep(5);
      }
      if (
        !(await filesystem.access(join(gateDirectory, "continue")).then(
          () => true,
          () => false,
        ))
      )
        throw new Error("liveness race fixture gate timed out");
      if (mode === "malformed-after-reap") return "malformed process stat";
      const error = new Error("process stat unavailable") as NodeJS.ErrnoException;
      error.code = mode === "permission-denied" ? "EACCES" : "ENOENT";
      throw error;
    }
    return originalReadFile(...args);
  },
}));

const { linuxProcessLiveness } = await import("../../src/workerd-linux-process.ts");
const result = await linuxProcessLiveness(identity);
process.stdout.write(`${JSON.stringify({ result, injected, mode })}\n`);
