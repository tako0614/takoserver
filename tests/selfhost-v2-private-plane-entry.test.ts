import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSelfhostV2PrivatePlaneBoot } from "../src/entry-v2-private-plane-boot.ts";
import { base64UrlEncode } from "../src/json.ts";

const ORIGIN = "https://v2-private-entry.takoserver.test";

test("private plane opt-in refuses incomplete and foreign key authority before opening state", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-entry-private-config-"));
  const keyRoot = join(root, "keys");
  const key = join(keyRoot, "queue.key");
  const alias = join(keyRoot, "queue-link.key");
  try {
    await mkdir(keyRoot, { mode: 0o700 });
    await writeFile(key, new Uint8Array(32).fill(0x41), { mode: 0o600 });
    expect(parseSelfhostV2PrivatePlaneBoot(undefined, { dataRoot: "relative" })).toBeUndefined();
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(JSON.stringify({ queue: { privatePort: 23001 } }), {
        dataRoot: root,
      }),
    ).toThrow(/incomplete/);
    await chmod(key, 0o644);
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({ queue: { privatePort: 23001, signingKeyFile: key } }),
        { dataRoot: root },
      ),
    ).toThrow(/not private/);
    await chmod(key, 0o600);
    await chmod(keyRoot, 0o755);
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({ queue: { privatePort: 23001, signingKeyFile: key } }),
        { dataRoot: root },
      ),
    ).toThrow(/parent must be owned and private/);
    await chmod(keyRoot, 0o700);
    await symlink(key, alias);
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({ queue: { privatePort: 23001, signingKeyFile: alias } }),
        { dataRoot: root },
      ),
    ).toThrow(/unavailable/);
    const parsed = parseSelfhostV2PrivatePlaneBoot(
      JSON.stringify({ queue: { privatePort: 23001, signingKeyFile: key } }),
      { dataRoot: root, reservedPorts: [23002] },
    );
    expect(parsed?.queue?.privatePort).toBe(23001);
    expect(parsed?.queue?.signingKey).toEqual(new Uint8Array(32).fill(0x41));
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({ queue: { privatePort: 23002, signingKeyFile: key } }),
        { dataRoot: root, reservedPorts: [23002] },
      ),
    ).toThrow(/distinct fixed port/);
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({
          kv: { privatePort: 23003, signingKeyFile: key },
          queue: { privatePort: 23004, signingKeyFile: key },
        }),
        { dataRoot: root },
      ),
    ).toThrow(/distinct signing key/);
    await writeFile(key, new Uint8Array(4_097).fill(0x41));
    expect(() =>
      parseSelfhostV2PrivatePlaneBoot(
        JSON.stringify({ queue: { privatePort: 23001, signingKeyFile: key } }),
        { dataRoot: root },
      ),
    ).toThrow(/32 to 4096 bytes/);
    expect(existsSync(join(root, "control.sqlite"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal Bun entry refuses a partial private plane before opening control state", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-entry-private-refusal-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      PORT: "21001",
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_DB: join(root, "control.sqlite"),
      TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
      TAKOSERVER_V2_WORKER_PRIVATE_PLANES: JSON.stringify({ queue: { privatePort: 21002 } }),
    },
  });
  try {
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
    if (code === null) throw new Error("partial private boot was not refused");
    const stderr = await new Response(child.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("TAKOSERVER_V2_WORKER_PRIVATE_PLANES.queue is incomplete");
    expect(existsSync(join(root, "control.sqlite"))).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function unusedPort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = Number(server.port);
    await server.stop(true);
    if (port > 0 && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("test port allocation unavailable");
}

async function waitForEntry(child: ReturnType<typeof Bun.spawn>, port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("normal Bun entry exited during startup");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
        headers: { host: "v2-private-entry.takoserver.test" },
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // The listener may not have bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("normal Bun entry readiness deadline exceeded");
}

async function stopEntry(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (code !== null) {
    expect(code).toBe(0);
    return;
  }
  child.kill("SIGKILL");
  await child.exited;
  throw new Error("normal Bun entry did not stop gracefully");
}

test("normal Bun empty-owner opt-in reopens fixed private v2 planes and closes them after SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-entry-private-planes-"));
  const keyRoot = join(root, "operator-private-keys");
  const stagingRoot = join(root, "sql-staging");
  const chosen = new Set<number>([8788]);
  const port = await unusedPort(chosen);
  const workerdPort = await unusedPort(chosen);
  const dataPlanePort = await unusedPort(chosen);
  const sqlitePort = await unusedPort(chosen);
  const kvPort = await unusedPort(chosen);
  const objectPort = await unusedPort(chosen);
  const queuePort = await unusedPort(chosen);
  await mkdir(keyRoot, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const keys = {
    sqlite: join(keyRoot, "sqlite.key"),
    kv: join(keyRoot, "kv.key"),
    objectBucket: join(keyRoot, "object-bucket.key"),
    queue: join(keyRoot, "queue.key"),
  };
  await Promise.all(
    Object.values(keys).map((path, index) =>
      writeFile(path, new Uint8Array(32).fill(0x31 + index), { mode: 0o600 }),
    ),
  );
  const privateBoot = JSON.stringify({
    sqlite: { privatePort: sqlitePort, signingKeyFile: keys.sqlite, stagingRoot },
    kv: { privatePort: kvPort, signingKeyFile: keys.kv },
    objectBucket: { privatePort: objectPort, signingKeyFile: keys.objectBucket },
    queue: { privatePort: queuePort, signingKeyFile: keys.queue },
  });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    TMPDIR: root,
    CI: "1",
    NO_COLOR: "1",
    PORT: String(port),
    TAKOSERVER_WORKERD_PORT: String(workerdPort),
    TAKOSERVER_DATA_PLANE_PORT: String(dataPlanePort),
    TAKOSERVER_DATA_ROOT: root,
    TAKOSERVER_DB: join(root, "control.sqlite"),
    TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
    TAKOSERVER_V2_WORKER_PRIVATE_PLANES: privateBoot,
  };
  const privatePorts = [sqlitePort, kvPort, objectPort, queuePort];
  const assertPrivateListeners = async () => {
    for (const privatePort of privatePorts) {
      const response = await fetch(`http://127.0.0.1:${privatePort}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.arrayBuffer();
    }
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (let generation = 0; generation < 2; generation += 1) {
      child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
        cwd: join(import.meta.dir, ".."),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env,
      });
      await waitForEntry(child, port);
      await assertPrivateListeners();
      await stopEntry(child);
      child = undefined;
      for (const privatePort of privatePorts) {
        await expect(
          fetch(`http://127.0.0.1:${privatePort}/`, { signal: AbortSignal.timeout(500) }),
        ).rejects.toThrow();
      }
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
