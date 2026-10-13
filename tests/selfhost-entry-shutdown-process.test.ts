import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readiness(stream: ReadableStream<Uint8Array>): Promise<{
  ingressPort: number;
  dependentPort: number;
}> {
  const reader = stream.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("shutdown fixture exited before readiness");
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 1024) throw new Error("invalid shutdown fixture readiness");
    }
    return JSON.parse(text.trim());
  } finally {
    reader.releaseLock();
  }
}

const ordered = [
  "ingress",
  "workerd-reap",
  "v2-worker-suspend",
  "actor-close",
  "data-plane-close",
  "control-database-close",
] as const;

for (const failure of [
  "v2-worker-suspend",
  ...ordered.filter((name) => name !== "v2-worker-suspend"),
  "success",
]) {
  test(`Host process exits after ${failure} without closing unproved dependents`, async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-shutdown-failure-"));
    const custodyPath = join(root, "custody.json");
    const custody = '{"state":"active","identity":"synthetic-retained-custody"}\n';
    await writeFile(custodyPath, custody, { mode: 0o600 });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/selfhost-entry-shutdown-process.ts"),
        failure,
        root,
      ],
      { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const ports = await bounded(readiness(child.stdout), 10_000, "Host readiness timed out");
      const plane = await fetch(`http://127.0.0.1:${ports.dependentPort}`);
      expect(await plane.text()).toBe("dependent plane");
      child.kill("SIGTERM");
      const code = await bounded(
        child.exited,
        5_000,
        "Host stayed alive after a settled shutdown failure",
      );
      expect(code).toBe(failure === "success" ? 0 : 1);
      const calls = (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n");
      const expected: string[] =
        failure === "success"
          ? [...ordered]
          : [...ordered.slice(0, ordered.indexOf(failure as (typeof ordered)[number]) + 1)];
      if (failure !== "success" && failure !== "ingress") expected.push(`failed:${failure}`);
      expect(calls).toEqual(expected);
      expect(await readFile(custodyPath, "utf8")).toBe(custody);
      const diagnostic = await new Response(child.stderr).text();
      expect(diagnostic).toBe(
        failure === "success"
          ? ""
          : `${failure === "ingress" ? "" : `self-host shutdown failed at ${failure}\n`}self-host shutdown incomplete at ${failure === "ingress" ? "ingress" : "cleanup"}\n`,
      );
      for (const port of [ports.ingressPort, ports.dependentPort]) {
        await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await bounded(child.exited, 5_000, "fixture Host exit unconfirmed during cleanup");
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}
