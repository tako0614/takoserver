import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  selectClosedGraphWorkerd,
  WORKERD_CLOSED_GRAPH_ARTIFACT,
} from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";

test("does not select an implicit package runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
  try {
    expect(await selectClosedGraphWorkerd({ binary: undefined, privateRoot: root })).toEqual({
      binary: null,
      diagnostic: "TAKOSERVER_WORKERD_BINARY is not configured; Worker execution is disabled",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a runnable binary whose immutable digest is not the owner pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
  try {
    const selected = await selectClosedGraphWorkerd({ binary: "/bin/bash", privateRoot: root });
    expect(selected.binary).toBeNull();
    expect(selected.diagnostic).toContain(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256);
    expect(selected.diagnostic).toContain("digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.TAKOSERVER_WORKERD_BINARY === undefined)(
  "selects the pinned artifact only after its real closed-graph capability executes",
  async () => {
    const binary = process.env.TAKOSERVER_WORKERD_BINARY as string;
    const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-"));
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: root,
      });
      expect(selected.diagnostic).toBeNull();
      expect(selected.binary).not.toBe(binary);
      expect(selected.binary?.startsWith(root)).toBe(true);
      const selectedBytes = await Bun.file(selected.binary as string).arrayBuffer();
      expect(createHash("sha256").update(new Uint8Array(selectedBytes)).digest("hex")).toBe(
        WORKERD_CLOSED_GRAPH_ARTIFACT.sha256,
      );
      expect((await stat(selected.binary as string)).mode & 0o777).toBe(0o500);
      expect((await stat(dirname(selected.binary as string))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.env.TAKOSERVER_WORKERD_BINARY === undefined)(
  "later inspection executes the selected byte identity after the configured path is replaced",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-artifact-replacement-"));
    const configured = join(root, "configured-workerd");
    const marker = join(root, "substituted-binary-ran");
    let running: ReturnType<typeof Bun.spawn> | undefined;
    let supervisor: ReturnType<typeof createWorkerdSupervisor> | undefined;
    try {
      await copyFile(process.env.TAKOSERVER_WORKERD_BINARY as string, configured);
      await chmod(configured, 0o700);
      const selected = await selectClosedGraphWorkerd({
        binary: configured,
        privateRoot: join(root, "private"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "workerd was not selected");

      const replacement = join(root, "replacement");
      await writeFile(replacement, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 97\n`, {
        encoding: "utf8",
        mode: 0o700,
      });
      await rename(replacement, configured);

      const bytes = new TextEncoder().encode(
        `export default { fetch() { return new Response("artifact snapshot served"); } };`,
      );
      const result = await createWorkerdWorkerModuleInspector({
        repositoryRoot: resolve(import.meta.dir, ".."),
        binary: selected.binary,
      }).inspect({
        mainModule: "worker.mjs",
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript+module",
            bytes,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        ],
        declaredHandlers: ["fetch"],
      });
      expect(result).toEqual({ outcome: "valid", exportedHandlers: ["fetch"] });

      const reserved = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const port = Number(reserved.port);
      reserved.stop(true);
      supervisor = createWorkerdSupervisor({
        binary: selected.binary,
        spawn: (command) => {
          running = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
          return running;
        },
        readiness: async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/`, {
                headers: { host: "artifact.localhost" },
                signal: AbortSignal.timeout(250),
              });
              if (response.status >= 100) return true;
            } catch {
              await new Promise<void>((wake) => setTimeout(wake, 50));
            }
          }
          return false;
        },
      });
      const runtime = createWorkerdRuntime({
        root: join(root, "runtime"),
        binary: selected.binary,
        port,
        isReady: () => supervisor?.isReady() === true,
        onReload: (configPath) => supervisor?.ensure(configPath) ?? Promise.resolve(),
      });
      await runtime.write(
        "artifact",
        {
          directory: "artifact",
          mainModule: "worker.mjs",
          hostnames: ["artifact.localhost"],
        },
        new Map([["worker.mjs", bytes]]),
      );
      await runtime.reload();
      expect(
        await (
          await fetch(`http://127.0.0.1:${port}/`, {
            headers: { host: "artifact.localhost" },
          })
        ).text(),
      ).toBe("artifact snapshot served");
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(selected.binary).not.toBe(configured);
    } finally {
      supervisor?.stop();
      await running?.exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
