import { expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSelfhostSocketRoot, sweepSelfhostSocketRoot } from "../src/selfhost-socket-root.ts";

const HOUR = 3_600_000;

/** Socket files whose listener process was killed, as a SIGKILLed Host leaves them. */
async function deadSockets(paths: readonly string[]): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const net = require("node:net");
for (const path of ${JSON.stringify(paths)}) net.createServer().listen(path);
setInterval(() => {}, 1000);`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) throw new Error("listener fixture did not bind");
    await Bun.sleep(20);
  }
  child.kill("SIGKILL");
  await child.exited;
}

async function brokerDirectory(root: string, name: string): Promise<string> {
  const path = join(root, "s", name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function age(path: string, at: number): Promise<void> {
  await utimes(path, at / 1_000, at / 1_000);
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  // Socket pathnames must stay short; this root is private to the test.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "ssr-")));
  try {
    expect(prepareSelfhostSocketRoot(root)).toBeUndefined();
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the socket directory is created private and its trust is checked like a private plane", async () => {
  await withRoot(async (root) => {
    const socketRoot = join(root, "s");
    expect(statSync(socketRoot).mode & 0o777).toBe(0o700);
    await chmod(socketRoot, 0o755);
    expect(prepareSelfhostSocketRoot(root)).toBe(
      `the socket directory (TAKOSERVER_DATA_ROOT/s) must be owned and private: ${socketRoot} has mode 0755` +
        ` and owner uid ${process.getuid?.()}, but needs mode 0700 and owner uid ${process.getuid?.()};` +
        " it holds only per-start listener directories and may be deleted while the Host is stopped",
    );
    // An existing directory is never re-permissioned.
    expect(statSync(socketRoot).mode & 0o777).toBe(0o755);
    await chmod(socketRoot, 0o700);
    await chmod(root, 0o777);
    expect(prepareSelfhostSocketRoot(root)).toContain(
      `has an unsafe writable ancestor: ${root} has mode 0777`,
    );
    await chmod(root, 0o700);
    expect(prepareSelfhostSocketRoot(root)).toBeUndefined();
  });
});

test("only broker directories whose abandonment is proved are removed", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const old = now - HOUR;
    const dead = await brokerDirectory(root, "aDead01");
    const deadWorkflow = await brokerDirectory(root, "wDead01");
    await deadSockets([
      join(dead, "0.h.sock"),
      join(dead, "0.u.sock"),
      join(deadWorkflow, "1.sock"),
    ]);
    const live = await brokerDirectory(root, "aLive01");
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(join(live, "2.u.sock"), resolve));
    const mixed = await brokerDirectory(root, "aMixd01");
    await deadSockets([join(mixed, "3.u.sock")]);
    await writeFile(join(mixed, "note"), "not a socket");
    const emptyBeforeBoot = await brokerDirectory(root, "wEmpt01");
    const emptySinceBoot = await brokerDirectory(root, "wEmpt02");
    const fresh = await brokerDirectory(root, "aFrsh01");
    await deadSockets([join(fresh, "4.u.sock")]);
    const shared = await brokerDirectory(root, "aShrd01");
    await deadSockets([join(shared, "5.u.sock")]);
    await chmod(shared, 0o755);
    const execution = await brokerDirectory(root, "twf-Exec01");
    await deadSockets([join(execution, "run.sock")]);
    const elsewhere = await mkdtemp(join(tmpdir(), "ssr-target-"));
    await deadSockets([join(elsewhere, "6.sock")]);
    await chmod(elsewhere, 0o700);
    await symlink(elsewhere, join(root, "s", "aLink01"));
    for (const path of [dead, deadWorkflow, live, mixed, emptyBeforeBoot, shared, execution])
      await age(path, old);
    // Written after this machine booted, though not in the last few seconds.
    await age(emptySinceBoot, old + 2_000);
    try {
      const result = await sweepSelfhostSocketRoot(root, { now, machineBootTimeMs: old + 1_000 });
      expect([...result.removed].sort()).toEqual([dead, deadWorkflow, emptyBeforeBoot].sort());
      for (const path of [dead, deadWorkflow, emptyBeforeBoot])
        expect(existsSync(path)).toBe(false);
      // A live listener, a non-socket entry, a directory written moments ago,
      // one not private, an empty one from this boot, an execution directory
      // and a symlink are all left exactly as they were.
      for (const path of [live, mixed, emptySinceBoot, fresh, shared, execution])
        expect(existsSync(path)).toBe(true);
      expect(existsSync(join(live, "2.u.sock"))).toBe(true);
      expect(lstatSync(join(root, "s", "aLink01")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(elsewhere, "6.sock"))).toBe(true);
      expect(result.retained).toBe(6);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

test("a directory that changes while it is examined is retained", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const directory = await brokerDirectory(root, "aRace01");
    await deadSockets([join(directory, "0.u.sock")]);
    await age(directory, now - HOUR);
    const result = await sweepSelfhostSocketRoot(root, {
      now,
      machineBootTimeMs: 0,
      // A listener binds a new socket between the probe and the removal.
      socketState: async () => {
        await writeFile(join(directory, "late"), "");
        return "refused";
      },
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(join(directory, "0.u.sock"))).toBe(true);
  });
});

test("nothing is swept from a socket directory that is not private", async () => {
  await withRoot(async (root) => {
    const directory = await brokerDirectory(root, "aDead02");
    await deadSockets([join(directory, "0.u.sock")]);
    await age(directory, Date.now() - HOUR);
    await chmod(join(root, "s"), 0o750);
    expect(await sweepSelfhostSocketRoot(root, { machineBootTimeMs: 0 })).toEqual({
      removed: [],
      retained: 0,
    });
    expect(existsSync(directory)).toBe(true);
    expect(await sweepSelfhostSocketRoot(":memory:")).toEqual({ removed: [], retained: 0 });
  });
});
