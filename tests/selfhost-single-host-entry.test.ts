import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

test("normal entry refuses a second port and reopens intact control state after SIGKILL", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../.test-host-entry-"));
  const entry = join(import.meta.dir, "../src/entry-bun.ts");
  const port = async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const selected = Number(server.port);
    await server.stop(true);
    return selected;
  };
  const firstPort = await port();
  const secondPort = await port();
  const start = (selected: number) =>
    Bun.spawn([process.execPath, "--no-env-file", entry], {
      cwd: root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PORT: String(selected),
        TAKOSERVER_DATA_ROOT: root,
        TAKOSERVER_SINGLE_HOST: '{"hostId":"entry-test"}',
        TAKOSERVER_PUBLIC_ORIGIN: "https://crash.example.test",
        TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK: JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.alloc(32, 0x21).toString("base64url"),
        }),
        TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
          documentation: "https://docs.example.test",
          authenticationDocumentation: "https://docs.example.test/auth",
        }),
        TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: Buffer.alloc(32, 0x72).toString("base64url"),
      },
    });
  const children: ReturnType<typeof start>[] = [];
  const ready = async (child: ReturnType<typeof start>, selected: number) => {
    const deadline = Date.now() + 20_000;
    while (child.exitCode === null && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${selected}/_takoserver/health/ready`, {
          signal: AbortSignal.timeout(300),
        });
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        /* listener has not bound yet */
      }
      await Bun.sleep(25);
    }
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`entry not ready: ${await new Response(child.stderr).text()}`);
  };
  const epoch = () => JSON.parse(readFileSync(join(root, ".host-epoch.json"), "utf8")).epoch;
  try {
    const first = start(firstPort);
    children.push(first);
    await ready(first, firstPort);
    expect(epoch()).toBe(1);
    const peer = start(secondPort);
    children.push(peer);
    const code = await Promise.race([peer.exited, Bun.sleep(10_000).then(() => null)]);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(await new Response(peer.stderr).text()).toContain(
      "single-host lease is held or unavailable",
    );
    expect(epoch()).toBe(1);
    first.kill("SIGKILL");
    await first.exited;
    const restored = start(firstPort);
    children.push(restored);
    await ready(restored, firstPort);
    expect(epoch()).toBe(2);
    restored.kill("SIGTERM");
    expect(await restored.exited).toBe(0);
    const database = new Database(join(root, "control.sqlite"), { readonly: true });
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
