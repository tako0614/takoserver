import { expect, test } from "bun:test";
import { linuxProcessLiveness, readLinuxProcessIdentity } from "../src/workerd-linux-process.ts";

test("captures and classifies the exact process identity across exit", async () => {
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const identity = await readLinuxProcessIdentity(child.pid);
    expect(identity.pid).toBe(child.pid);
    expect(identity.bootId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(identity.pidNamespace).toMatch(/^\d+:\d+$/u);
    expect(identity.startTimeTicks).toMatch(/^\d+$/u);
    expect(await linuxProcessLiveness(identity)).toBe("live");

    child.kill("SIGKILL");
    await child.exited;
    expect(await linuxProcessLiveness(identity)).toBe("stale");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});

test("does not interpret another boot or PID namespace as stale", async () => {
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    const identity = await readLinuxProcessIdentity(child.pid);
    expect(
      await linuxProcessLiveness({ ...identity, bootId: "00000000-0000-0000-0000-000000000000" }),
    ).toBe("unknown");
    expect(await linuxProcessLiveness({ ...identity, pidNamespace: "0:0" })).toBe("unknown");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});
