import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  acquireSingleHostLease,
  assertSingleHostFilesystem,
  parseSingleHostConfiguration,
} from "../src/selfhost-single-host-lease.ts";
import {
  linuxProcessLiveness,
  linuxProcessLivenessInSingleHost,
  readLinuxProcessIdentity,
} from "../src/workerd-linux-process.ts";

const input = (dataRoot: string) => ({
  dataRoot,
  hostId: "test-host",
  databasePath: join(dataRoot, "control.sqlite"),
});

test("previous-boot absence requires a held lease for the exact state root", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-boot-proof-"));
  const foreign = mkdtempSync(join(import.meta.dir, "../.test-host-foreign-proof-"));
  const identity = {
    ...(await readLinuxProcessIdentity(process.pid)),
    bootId: "11111111-1111-4111-8111-111111111111",
  };
  const lease = acquireSingleHostLease(input(root));
  try {
    expect(await linuxProcessLiveness(identity)).toBe("unknown");
    expect(await linuxProcessLivenessInSingleHost(identity, root)).toBe("stale");
    expect(await linuxProcessLivenessInSingleHost(identity, foreign)).toBe("unknown");
    expect(() => acquireSingleHostLease(input(root))).toThrow("held or unavailable");
    expect(await linuxProcessLivenessInSingleHost(identity, root)).toBe("stale");
    const current = await readLinuxProcessIdentity(process.pid);
    expect(await linuxProcessLivenessInSingleHost(current, root)).toBe("live");
    expect(await linuxProcessLivenessInSingleHost(current, join(root, "missing"))).toBe("live");
    expect(await linuxProcessLivenessInSingleHost({ ...current, pidNamespace: "0:1" }, root)).toBe(
      "unknown",
    );
    lease.release();
    expect(await linuxProcessLivenessInSingleHost(identity, root)).toBe("unknown");
  } finally {
    lease.release();
    rmSync(root, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("kernel ownership excludes peers, survives a killed process and preserves the lock inode", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-flock-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/single-host-lease.ts"),
      root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error("lease fixture timeout");
      }),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain('"epoch":1');
    const inode = statSync(join(root, ".host.lock")).ino;
    expect(() => acquireSingleHostLease(input(root))).toThrow("held or unavailable");
    expect(JSON.parse(readFileSync(join(root, ".host-epoch.json"), "utf8")).epoch).toBe(1);
    child.kill("SIGKILL");
    await child.exited;
    const second = acquireSingleHostLease(input(root));
    expect(second.epoch).toBe(2);
    expect(statSync(join(root, ".host.lock")).ino).toBe(inode);
    second.release();
    const third = acquireSingleHostLease(input(root));
    expect(third.epoch).toBe(3);
    third.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("epoch cross-check refuses another host/machine and malformed durable records", () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-epoch-"));
  try {
    acquireSingleHostLease(input(root)).release();
    const path = join(root, ".host-epoch.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const record of [
      { ...original, hostId: "other-host" },
      { ...original, machineId: "0".repeat(32) },
      { ...original, epoch: -1 },
    ]) {
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      expect(() => acquireSingleHostLease(input(root))).toThrow();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
    }
    writeFileSync(
      path,
      JSON.stringify({ ...original, bootId: "11111111-1111-4111-8111-111111111111" }),
    );
    const recovery = acquireSingleHostLease(input(root));
    expect(recovery.epoch).toBe(2);
    expect(recovery.previousBootId).toBe("11111111-1111-4111-8111-111111111111");
    recovery.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custody rejects aliases and unqualified filesystems, and configuration is explicit", () => {
  expect(parseSingleHostConfiguration(undefined)).toBeUndefined();
  expect(parseSingleHostConfiguration('{"hostId":"host-1"}')).toBe("host-1");
  for (const value of [
    "1",
    "{}",
    '{"hostId":""}',
    '{"hostId":"h","extra":1}',
    '{"hostId":"h","hostId":"other"}',
  ])
    expect(() => parseSingleHostConfiguration(value)).toThrow();
  expect(() => assertSingleHostFilesystem("/proc")).toThrow("network or unqualified");
  for (const alias of ["hardlink", "symlink"]) {
    const root = mkdtempSync(join(import.meta.dir, "../.test-host-alias-"));
    try {
      const target = join(root, "target");
      writeFileSync(target, "", { mode: 0o600 });
      if (alias === "hardlink") linkSync(target, join(root, ".host.lock"));
      else symlinkSync(target, join(root, ".host.lock"));
      expect(() => acquireSingleHostLease(input(root))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

for (const name of ["control.sqlite", "external.sqlite"]) {
  test(`the ${name} control database is fenced across distinct data roots`, () => {
    const first = mkdtempSync(join(import.meta.dir, "../.test-host-external-"));
    const second = mkdtempSync(join(import.meta.dir, "../.test-host-external-"));
    const databasePath = join(first, name);
    const owner = acquireSingleHostLease({ ...input(first), databasePath });
    try {
      expect(() => acquireSingleHostLease({ ...input(second), databasePath })).toThrow(
        "held or unavailable",
      );
      expect(() => statSync(join(second, ".host-epoch.json"))).toThrow();
      owner.release();
      const successor = acquireSingleHostLease({ ...input(second), databasePath });
      successor.release();
    } finally {
      owner.release();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
}

test("an external database's lock cannot live in a directory another user can replace", () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-external-"));
  const unsafe = mkdtempSync(join(import.meta.dir, "../.test-host-unsafe-"));
  try {
    chmodSync(unsafe, 0o777);
    expect(() =>
      acquireSingleHostLease({ ...input(root), databasePath: join(unsafe, "control.sqlite") }),
    ).toThrow("unsafe writable ancestor");
    expect(() => statSync(join(root, ".host-epoch.json"))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(unsafe, { recursive: true, force: true });
  }
});
