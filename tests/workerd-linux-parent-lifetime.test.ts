import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerPortOwnership } from "../src/workerd-linux-process.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const bun = process.execPath;
const nativeParentLifetime = nativeEvidenceBinary("workerd-parent-lifetime");

interface ChildIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly command: string;
  readonly parentPid: number;
  readonly running: boolean;
}

async function childIdentity(pid: number): Promise<ChildIdentity | null> {
  try {
    const [stat, status, executable, command] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    // /proc/<pid>/stat field 2 is parenthesized and can contain spaces.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const parentPid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    const startTime = fields[19]; // field 22, relative to field 3 at index 0
    if (!startTime || !Number.isSafeInteger(parentPid)) return null;
    return {
      pid,
      startTime,
      executable,
      command,
      parentPid,
      running: !/^State:\s+[ZX]/m.test(status),
    };
  } catch {
    return null;
  }
}

function sameChild(before: ChildIdentity, after: ChildIdentity): boolean {
  return (
    before.pid === after.pid &&
    before.startTime === after.startTime &&
    before.executable === after.executable &&
    before.command === after.command
  );
}

test.skipIf(nativeParentLifetime === undefined)(
  "accepts an IPv4-only proc tree but refuses a missing TCP table",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-workerd-ipv4-proc-"));
    try {
      mkdirSync(join(root, "net"));
      writeFileSync(join(root, "net", "tcp"), "sl local_address rem_address st inode\n");
      expect(await workerPortOwnership(28788, undefined, root)).toBe("vacant");
      rmSync(join(root, "net", "tcp"));
      await expect(workerPortOwnership(28788, undefined, root)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(nativeParentLifetime === undefined)(
  "an occupied Worker port is refused before a watched config can be rewritten",
  async () => {
    const foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("foreign"),
    });
    try {
      const foreignPort = foreign.port;
      if (foreignPort === undefined) throw new Error("foreign listener did not bind");
      expect(await workerPortOwnership(foreignPort, process.pid)).toBe("owned");
      expect(await workerPortOwnership(foreignPort, undefined)).toBe("foreign");
      const supervisor = createWorkerdSupervisor({
        binary: "/private/workerd",
        spawn: () => {
          throw new Error("must not spawn");
        },
        readiness: async () => true,
        listenerPort: foreignPort,
      });
      await expect(supervisor.assertMayRender()).rejects.toThrow(/occupied|owned|listener/i);
      expect(await (await fetch(`http://127.0.0.1:${foreignPort}/`)).text()).toBe("foreign");
    } finally {
      foreign.stop(true);
    }
  },
);

test.skipIf(nativeParentLifetime === undefined)(
  "foreign port rejection preserves the watched configuration bytes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-workerd-parent-"));
    try {
      const config = join(root, "workers", "workerd.capnp");
      mkdirSync(join(root, "workers"));
      writeFileSync(config, "previous private configuration");
      const foreign = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("foreign"),
      });
      try {
        const foreignPort = foreign.port;
        if (foreignPort === undefined) throw new Error("foreign listener did not bind");
        const supervisor = createWorkerdSupervisor({
          binary: "/private/workerd",
          spawn: () => {
            throw new Error("must not spawn");
          },
          readiness: async () => true,
          listenerPort: foreignPort,
        });
        const runtime = createWorkerdRuntime({
          root,
          port: foreignPort,
          beforeRender: () => supervisor.assertMayRender(),
          onReload: async () => {
            throw new Error("reload must not happen");
          },
        });
        await expect(runtime.reload()).rejects.toThrow(/activation state is unknown/);
        expect(await readFile(config, "utf8")).toBe("previous private configuration");
      } finally {
        foreign.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(nativeParentLifetime === undefined)(
  "the Linux launch child dies when its only Host parent is SIGKILLed",
  async () => {
    const host = Bun.spawn(
      [bun, "--no-env-file", "tests/fixtures/workerd-parent-lifetime-host.ts"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      },
    );
    let owned: ChildIdentity | null = null;
    let cleanupUncertain = false;
    try {
      const first = await Promise.race([
        host.stdout.getReader().read(),
        Bun.sleep(1_000).then(() => {
          throw new Error("guarded child PID was not reported");
        }),
      ]);
      const childPid = Number(new TextDecoder().decode(first.value).trim());
      expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
      for (let attempt = 0; attempt < 40; attempt++) {
        const candidate = await childIdentity(childPid);
        if (candidate?.executable.endsWith("/sleep")) {
          owned = candidate;
          break;
        }
        await Bun.sleep(25);
      }
      expect(owned?.parentPid).toBe(host.pid);
      expect(owned?.running).toBe(true);
      host.kill("SIGKILL");
      await host.exited;
      let alive = true;
      for (let attempt = 0; attempt < 40; attempt++) {
        const current = await childIdentity(childPid);
        if (!current?.running) {
          alive = false;
          break;
        }
        if (!owned || !sameChild(owned, current)) {
          throw new Error("guarded child PID identity changed; leaving it untouched");
        }
        await Bun.sleep(25);
      }
      expect(alive).toBe(false);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
      if (owned) {
        const current = await childIdentity(owned.pid);
        if (current?.running) {
          if (!sameChild(owned, current)) {
            cleanupUncertain = true;
            process.stderr.write("guarded child PID identity changed; cleanup refused\n");
          } else {
            try {
              process.kill(owned.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                cleanupUncertain = true;
                process.stderr.write("guarded child cleanup failed; process left untouched\n");
              }
            }
          }
        }
      }
    }
    expect(cleanupUncertain).toBe(false);
  },
);
