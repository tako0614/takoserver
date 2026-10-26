import { expect, test } from "bun:test";

// Bun's POSIX spawnSync loop used to receive finalizers belonging to the
// thread's loop. Releasing three pollable writers could consume the three
// polls of the next child, losing its output even after it exited normally.
// Reproduces the mechanism fixed by oven-sh/bun#44581 in an owned child only.
test.skipIf(process.platform === "win32")(
  "a writer finalized during spawnSync cannot consume the next child's exit and output",
  async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "-e",
        `
globalThis.heldWriters = [];
const references = [];
for (let index = 0; index < 3; index++) {
  const writer = Bun.stderr.writer();
  writer.write("");
  writer.flush();
  globalThis.heldWriters.push(writer);
  references.push(new WeakRef(writer));
}
await Bun.sleep(0);
Bun.spawnSync({
  cmd: ["true"], stdout: "pipe", stderr: "ignore",
  get maxBuffer() { Bun.gc(true); globalThis.heldWriters = null; },
});
const collected = references.filter((reference) => reference.deref() === undefined).length;
const result = Bun.spawnSync({
  cmd: ["sh", "-c", "sleep 0.1; echo polled"],
  stdout: "pipe", stderr: "pipe", timeout: 2000,
});
console.log(JSON.stringify({
  collected, output: result.stdout.toString(), exitCode: result.exitCode,
  timedOut: result.exitedDueToTimeout,
}));
`,
      ],
      env: { ...process.env, BUN_JSC_slowPathAllocsBetweenGCs: "3" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        collected: 3,
        output: "polled\n",
        exitCode: 0,
        timedOut: false,
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  },
  15_000,
);
