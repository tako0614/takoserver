import { readdir, readFile, readlink } from "node:fs/promises";

// setpriv registers the kernel signal before this shell inspects its parent.
// The shell then execs the accepted binary in the same PID. All paths and
// arguments are positional; neither a tenant value nor a config path is code.
const PARENT_GUARD = `
expected=$1
shift
while read -r key value rest; do
  if [ "$key" = "PPid:" ]; then
    [ "$value" = "$expected" ] || exit 125
    exec "$@"
  fi
done < /proc/self/status
exit 125
`;

export function spawnWorkerdWithParentDeath(
  command: readonly string[],
  stdio: { readonly stdout: "inherit" | "ignore"; readonly stderr: "inherit" | "ignore" },
): ReturnType<typeof Bun.spawn> {
  if (process.platform !== "linux") {
    throw new Error("workerd parent-bound launch requires Linux");
  }
  if (command.length === 0) throw new Error("workerd command is required");
  return Bun.spawn(
    [
      "/usr/bin/setpriv",
      "--pdeathsig",
      "SIGKILL",
      "/bin/sh",
      "-c",
      PARENT_GUARD,
      "workerd-parent-guard",
      String(process.pid),
      ...command,
    ],
    stdio,
  );
}

/** The kernel's LISTEN socket inode(s) for one TCP port, not an HTTP claim. */
async function listenerInodes(port: number, procRoot: string): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const name of ["tcp", "tcp6"]) {
    let contents: string;
    try {
      contents = await readFile(`${procRoot}/net/${name}`, "utf8");
    } catch (error) {
      // An IPv4-only Linux kernel can omit tcp6 altogether. tcp itself is
      // mandatory; all other failures remain an unavailable Worker capability.
      if (name === "tcp6" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const lines = contents.split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const address = fields[1];
      const inode = fields[9];
      if (!address || !inode || fields[3] !== "0A") continue;
      if (Number.parseInt(address.slice(address.lastIndexOf(":") + 1), 16) === port) {
        inodes.add(inode);
      }
    }
  }
  return inodes;
}

/** Fail closed if any listener on this port is not held by the exact child PID. */
export async function workerPortOwnership(
  port: number,
  childPid: number | undefined,
  procRoot = "/proc",
): Promise<"vacant" | "owned" | "foreign"> {
  if (process.platform !== "linux") throw new Error("workerd socket ownership requires Linux");
  const inodes = await listenerInodes(port, procRoot);
  if (inodes.size === 0) return "vacant";
  if (!childPid || !Number.isSafeInteger(childPid) || childPid <= 1) return "foreign";
  const descriptors = await readdir(`${procRoot}/${childPid}/fd`);
  const held = new Set<string>();
  for (const descriptor of descriptors) {
    try {
      const target = await readlink(`${procRoot}/${childPid}/fd/${descriptor}`);
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) held.add(inode);
    } catch {
      // A descriptor may close during traversal; never infer ownership from it.
    }
  }
  return [...inodes].every((inode) => held.has(inode)) ? "owned" : "foreign";
}
