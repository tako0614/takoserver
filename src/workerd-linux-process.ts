import { readdir, readFile, readlink, stat } from "node:fs/promises";

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

export interface LinuxProcessIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly pidNamespace: string;
  readonly startTimeTicks: string;
}

export type LinuxProcessLiveness = "live" | "stale" | "unknown";

function validLinuxProcessIdentity(value: LinuxProcessIdentity): boolean {
  return (
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.bootId) &&
    /^\d{1,32}:\d{1,32}$/u.test(value.pidNamespace) &&
    /^\d{1,32}$/u.test(value.startTimeTicks)
  );
}

function namespaceIdentity(info: { dev: bigint; ino: bigint }): string {
  return `${info.dev}:${info.ino}`;
}

function startTime(statText: string, expectedPid: number): string | null {
  const pidSeparator = statText.indexOf(" (");
  const commandEnd = statText.lastIndexOf(")");
  if (pidSeparator <= 0 || commandEnd <= pidSeparator) return null;
  if (statText.slice(0, pidSeparator) !== String(expectedPid)) return null;
  const fields = statText
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const ticks = fields[19];
  return ticks && /^\d{1,32}$/u.test(ticks) ? ticks : null;
}

/** Captures one exact live PID in this Linux boot and PID namespace. */
export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("Linux process identity is unavailable");
  try {
    const [bootIdText, currentNamespace, targetNamespace, statText] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      stat("/proc/self/ns/pid", { bigint: true }),
      stat(`/proc/${pid}/ns/pid`, { bigint: true }),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const bootId = bootIdText.trim().toLowerCase();
    const pidNamespace = namespaceIdentity(currentNamespace);
    const startTimeTicks = startTime(statText, pid);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId) ||
      pidNamespace !== namespaceIdentity(targetNamespace) ||
      startTimeTicks === null
    ) {
      throw new Error();
    }
    return Object.freeze({ pid, bootId, pidNamespace, startTimeTicks });
  } catch {
    throw new Error("Linux process identity is unavailable");
  }
}

/** Same-boot, same-PID-namespace proof for one recorded process identity. */
export async function linuxProcessLiveness(
  identity: LinuxProcessIdentity,
): Promise<LinuxProcessLiveness> {
  if (process.platform !== "linux" || !identity || !validLinuxProcessIdentity(identity))
    return "unknown";
  try {
    const [bootIdText, namespace] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      stat("/proc/self/ns/pid", { bigint: true }),
    ]);
    if (
      bootIdText.trim().toLowerCase() !== identity.bootId ||
      namespaceIdentity(namespace) !== identity.pidNamespace
    ) {
      return "unknown";
    }
  } catch {
    return "unknown";
  }

  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stale";
    return "unknown";
  }
  let statText: string;
  try {
    statText = await readFile(`/proc/${identity.pid}/stat`, "utf8");
  } catch (error) {
    // A child can be reaped after kill(pid, 0) succeeded but before procfs
    // opens its stat file. ENOENT alone is not absence: the PID may also have
    // been reused, so require a fresh kernel ESRCH result before saying stale.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    try {
      process.kill(identity.pid, 0);
      return "unknown";
    } catch (recheckError) {
      return (recheckError as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "unknown";
    }
  }
  try {
    const actualStartTime = startTime(statText, identity.pid);
    if (actualStartTime === null) return "unknown";
    if (actualStartTime !== identity.startTimeTicks) return "stale";
    const commandEnd = statText.lastIndexOf(")");
    const state = statText
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)[0];
    if (!state) return "unknown";
    return state === "Z" || state === "X" ? "stale" : "live";
  } catch {
    return "unknown";
  }
}

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
