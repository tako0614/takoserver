import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";

test("two Node store instances serialize one invocation without blocking the event loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-invocation-lock-"));
  const options = {
    root: join(root, "native"),
    targetKey: "sqlite-target",
    proofs: {
      async currentClaim() {
        return null;
      },
      async acceptedCreate() {
        return null;
      },
    },
  };
  try {
    const first = createSelfhostV2SQLiteStore(options);
    const second = createSelfhostV2SQLiteStore(options);
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const leading = first.withInvocationLock("invocation-one", async () => {
      acquired();
      await held;
    });
    await ready;
    let followerRan = false;
    const follower = second.withInvocationLock("invocation-one", async () => {
      followerRan = true;
    });
    await Bun.sleep(30);
    expect(followerRan).toBe(false);
    await expect(
      second.withInvocationLock("invocation-one", () => "must not run", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "busy" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      second.withInvocationLock("invocation-one", () => "must not run", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    release();
    await Promise.all([leading, follower]);
    expect(followerRan).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second OS process inherits the same lock realm and process death releases it", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-invocation-process-"));
  const nativeRoot = join(root, "native");
  const source = new URL("../src/providers/selfhost-v2-sqlite-store.ts", import.meta.url).href;
  const childCode = `
    const { createSelfhostV2SQLiteStore } = await import(${JSON.stringify(source)});
    const store = createSelfhostV2SQLiteStore({
      root: ${JSON.stringify(nativeRoot)}, targetKey: "sqlite-target",
      proofs: { currentClaim: async () => null, acceptedCreate: async () => null }
    });
    await store.withInvocationLock("invocation-across-processes", async () => {
      console.log("held");
      await new Promise(() => {});
    });
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childCode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    const store = createSelfhostV2SQLiteStore({
      root: nativeRoot,
      targetKey: "sqlite-target",
      proofs: { currentClaim: async () => null, acceptedCreate: async () => null },
    });
    let acquired = false;
    const waiting = store.withInvocationLock("invocation-across-processes", async () => {
      acquired = true;
    });
    await Bun.sleep(30);
    expect(acquired).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    await waiting;
    expect(acquired).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
