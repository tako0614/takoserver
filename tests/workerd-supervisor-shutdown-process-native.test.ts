import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "../src/workerd-linux-process.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

// This is a Bun HTTP stand-in exercising the real Linux PID and socket seam,
// not the accepted workerd artifact or a restarted Host entry process.
const nativeParentLifetime = nativeEvidenceBinary("workerd-parent-lifetime");
const STAND_IN_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) {
  throw new Error("stand-in received an unexpected supervisor command");
}
const { port, signalledPath, releasePath } = JSON.parse(readFileSync(configPath, "utf8"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () => new Response("stand-in child"),
});
process.on("SIGTERM", () => {
  writeFileSync(signalledPath, "SIGTERM", { mode: 0o600 });
});
setInterval(() => {
  if (!existsSync(releasePath)) return;
  server.stop(true);
  process.exit(0);
}, 10);
`;

type Child = ReturnType<typeof spawnWorkerdWithParentDeath>;
type Fixture = {
  readonly root: string;
  readonly binary: string;
  readonly configPath: string;
  readonly signalledPath: string;
  readonly releasePath: string;
  readonly port: number;
  readonly children: Child[];
};

async function fixture(): Promise<Fixture> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = Number(reservation.port);
  await reservation.stop(true);
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-shutdown-process-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const configPath = join(root, "stand-in-config.json");
  const signalledPath = join(root, "signalled");
  const releasePath = join(root, "release");
  try {
    await writeFile(binary, `#!${process.execPath}\n${STAND_IN_SOURCE}`, { mode: 0o700 });
    await chmod(binary, 0o700);
    await writeFile(configPath, JSON.stringify({ port, signalledPath, releasePath }), {
      mode: 0o600,
    });
    return { root, binary, configPath, signalledPath, releasePath, port, children: [] };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup({ root, children }: Fixture): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const timeout = Symbol("child exit timeout");
  const exits = await Promise.all(
    children.map((child) => Promise.race([child.exited, Bun.sleep(2_000).then(() => timeout)])),
  );
  // Retain the fixture and fail instead of claiming safe cleanup after an
  // unconfirmed child exit. Never signal an unrelated process by PID or port.
  if (exits.includes(timeout)) throw new Error("stand-in child exit was not confirmed in cleanup");
  await rm(root, { recursive: true, force: true });
}

async function confirmedExit(child: Child): Promise<number> {
  const result = await Promise.race([
    child.exited.then((code) => ({ kind: "exit" as const, code })),
    Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
  ]);
  if (result.kind === "timeout") throw new Error("stand-in child exit was not confirmed");
  return result.code;
}

async function until(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("stand-in process observation timed out");
}

async function signalled(path: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === "SIGTERM";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function identity(
  pid: number,
): Promise<{ readonly birth: string; readonly state: string } | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const birth = fields[19]; // /proc stat field 22, relative to field 3.
  const state = fields[0];
  if (!birth || !state) throw new Error("stand-in process identity is malformed");
  return { birth, state };
}

async function servingReadiness(port: number, pid: number | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await workerPortOwnership(port, pid)) === "owned") {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(100),
        });
        await response.arrayBuffer();
        if (response.status === 200 && (await workerPortOwnership(port, pid)) === "owned") {
          return true;
        }
      } catch {
        // The exact child may have opened its socket before accepting HTTP.
      }
    }
    await Bun.sleep(20);
  }
  return false;
}

test.skipIf(nativeParentLifetime === undefined)(
  "awaited shutdown of an actual child waits for its exit and port vacancy without respawning",
  async () => {
    const owned = await fixture();
    try {
      const supervisor = createWorkerdSupervisor({
        binary: owned.binary,
        listenerPort: owned.port,
        spawn: (command) => {
          expect(command).toEqual([owned.binary, "serve", "--watch", owned.configPath]);
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          owned.children.push(child);
          return child;
        },
        readiness: async (_configPath, child) => servingReadiness(owned.port, child.pid),
      });
      await supervisor.ensure(owned.configPath);
      const child = owned.children[0];
      if (!child) throw new Error("stand-in child was not spawned");
      const before = await identity(child.pid);
      if (!before) throw new Error("stand-in child identity was not observed");
      expect(before.state).not.toMatch(/[ZX]/u);
      expect(await workerPortOwnership(owned.port, child.pid)).toBe("owned");

      let settled = false;
      const shutdown = supervisor.shutdown();
      void shutdown.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const observation = (async () => {
        await until(() => signalled(owned.signalledPath), 300);
        const [during, ownership] = await Promise.all([
          identity(child.pid),
          workerPortOwnership(owned.port, child.pid),
        ]);
        return { kind: "observed" as const, during, ownership };
      })();
      let live: Awaited<typeof observation> | { readonly kind: "timeout" } | undefined;
      let pendingBeforeRelease = false;
      let spawnedBeforeRelease = 0;
      try {
        live = await Promise.race([
          observation,
          Bun.sleep(500).then(() => ({ kind: "timeout" as const })),
        ]);
      } finally {
        pendingBeforeRelease = !settled;
        spawnedBeforeRelease = owned.children.length;
        // Do not spend the supervisor's one-second exit deadline on assertions.
        await writeFile(owned.releasePath, "release", { mode: 0o600 });
      }
      if (!live || live.kind === "timeout" || !live.during) {
        throw new Error("signalled stand-in child identity was not observed in time");
      }
      expect(live.during.birth).toBe(before.birth);
      expect(live.during.state).not.toMatch(/[ZX]/u);
      expect(live.ownership).toBe("owned");
      expect(pendingBeforeRelease).toBe(true);
      expect(spawnedBeforeRelease).toBe(1);
      expect(await confirmedExit(child)).toBe(0);
      await shutdown;
      const after = await identity(child.pid);
      expect(after === null || after.birth !== before.birth || /[ZX]/u.test(after.state)).toBe(
        true,
      );
      expect(await workerPortOwnership(owned.port, undefined)).toBe("vacant");
      expect(owned.children).toHaveLength(1);
      await expect(supervisor.ensure(owned.configPath)).rejects.toThrow("shut down");
    } finally {
      await cleanup(owned);
    }
  },
  10_000,
);

test.skipIf(nativeParentLifetime === undefined)(
  "awaited shutdown retains uncertainty when the actual child's exit promise is unavailable",
  async () => {
    const owned = await fixture();
    try {
      const supervisor = createWorkerdSupervisor({
        binary: owned.binary,
        listenerPort: owned.port,
        spawn: (command) => {
          expect(command).toEqual([owned.binary, "serve", "--watch", owned.configPath]);
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          owned.children.push(child);
          // Simulate a missing process-exit observation without faking the OS
          // process or listener. Cleanup still owns the real Bun handle.
          return { pid: child.pid, kill: () => child.kill() };
        },
        readiness: async (_configPath, child) => servingReadiness(owned.port, child.pid),
      });
      await supervisor.ensure(owned.configPath);
      const child = owned.children[0];
      if (!child) throw new Error("stand-in child was not spawned");
      const before = await identity(child.pid);
      if (!before) throw new Error("stand-in child identity was not observed");
      expect(await workerPortOwnership(owned.port, child.pid)).toBe("owned");

      await expect(supervisor.shutdown()).rejects.toThrow("exit cannot be confirmed");
      await until(() => signalled(owned.signalledPath), 700);
      const during = await identity(child.pid);
      if (!during) throw new Error("signalled stand-in child identity disappeared");
      expect(during.birth).toBe(before.birth);
      expect(await workerPortOwnership(owned.port, child.pid)).toBe("owned");
      expect(supervisor.snapshot()).toEqual({ state: "unavailable" });

      await writeFile(owned.releasePath, "release", { mode: 0o600 });
      expect(await confirmedExit(child)).toBe(0);
      expect(await workerPortOwnership(owned.port, undefined)).toBe("vacant");
      await expect(supervisor.shutdown()).rejects.toThrow("exit cannot be confirmed");
      await expect(supervisor.ensure(owned.configPath)).rejects.toThrow("shut down");
      expect(owned.children).toHaveLength(1);
    } finally {
      await cleanup(owned);
    }
  },
  10_000,
);
