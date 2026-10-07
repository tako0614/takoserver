import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProcessLiveness, readLinuxProcessIdentity } from "../src/workerd-linux-process.ts";

for (const mode of ["reaped", "still-live", "permission-denied", "malformed-after-reap"] as const) {
  test(`proc stat ${mode} after a live PID check has a fenced result`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workerd-liveness-race-"));
    const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    let harness: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const identity = await readLinuxProcessIdentity(child.pid);
      harness = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "fixtures/workerd-linux-liveness-race.ts"),
          JSON.stringify(identity),
          root,
          mode,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const stdoutStream = harness.stdout;
      const stderrStream = harness.stderr;
      if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream))
        throw new Error("liveness race fixture pipes unavailable");
      let reached = false;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        reached = await readFile(join(root, "reached-stat-read")).then(
          () => true,
          () => false,
        );
        if (reached || harness.exitCode !== null) break;
        await Bun.sleep(5);
      }
      expect(reached).toBe(true);
      if (mode === "reaped" || mode === "malformed-after-reap") {
        child.kill("SIGKILL");
        await child.exited;
      }
      await writeFile(join(root, "continue"), "");
      const [exitCode, stdout, stderr] = await Promise.all([
        harness.exited,
        new Response(stdoutStream).text(),
        new Response(stderrStream).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        result: mode === "reaped" ? "stale" : "unknown",
        injected: true,
        mode,
      });
    } finally {
      if (harness && harness.exitCode === null) {
        harness.kill("SIGKILL");
        await harness.exited;
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
