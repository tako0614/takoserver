import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireActorNativeLease } from "../src/selfhost-actor-lease.ts";
import { linuxProcessLiveness, readLinuxProcessIdentity } from "../src/workerd-linux-process.ts";

const scope = { tenantId: "org:actor-lease", namespaceResourceUid: "uid-actor-lease" };
const key = createHash("sha256")
  .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
  .digest("hex");

test("Actor lease refuses a live peer and live child, then releases only its own stopped custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-lease-owned-"));
  const storageRoot = join(root, "storage");
  await mkdir(storageRoot, { mode: 0o700 });
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const lease = await acquireActorNativeLease({ storageRoot, key, scope });
    const identity = await readLinuxProcessIdentity(child.pid);
    await lease.recordNative(identity);
    await expect(acquireActorNativeLease({ storageRoot, key, scope })).rejects.toThrow("uncertain");
    await expect(lease.release()).rejects.toThrow("uncertain");
    child.kill("SIGKILL");
    await child.exited;
    expect(await linuxProcessLiveness(identity)).toBe("stale");
    await lease.release();
    expect(await Bun.file(join(storageRoot, "leases", `${key}.owner.json`)).exists()).toBe(false);
    expect(await Bun.file(join(storageRoot, "leases", `${key}.child.json`)).exists()).toBe(false);
    expect(await Bun.file(join(storageRoot, "leases", key)).exists()).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor lease retains a legacy marker and a fixed unknown recovery claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-lease-unknown-"));
  const storageRoot = join(root, "storage");
  const leases = join(storageRoot, "leases");
  await mkdir(leases, { recursive: true, mode: 0o700 });
  try {
    await mkdir(join(leases, key), { mode: 0o700 });
    await expect(acquireActorNativeLease({ storageRoot, key, scope })).rejects.toThrow("uncertain");
    expect((await lstat(join(leases, key))).isDirectory()).toBe(true);
    await rm(join(leases, key), { recursive: true });
    const lease = await acquireActorNativeLease({ storageRoot, key, scope });
    const ownerBytes = await readFile(join(leases, `${key}.owner.json`));
    await Bun.write(join(leases, `${key}.recovering`), ownerBytes);
    await expect(lease.release()).rejects.toThrow("uncertain");
    await expect(acquireActorNativeLease({ storageRoot, key, scope })).rejects.toThrow("uncertain");
    expect((await lstat(join(leases, `${key}.recovering`))).isFile()).toBe(true);
  } finally {
    // This test owns the entire temporary root and has not started a native child.
    await rm(root, { recursive: true, force: true });
  }
});
