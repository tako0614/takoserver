/**
 * The normal Bun entry reads `TAKOSERVER_DATA_ROOT` once and hands every owner
 * the same absolute canonical path, and it refuses at boot, by name, a root
 * too long for a selected v2 runtime capability's Unix sockets.
 */
import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES } from "../src/selfhost-socket-layout.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

const ORIGIN = "https://data-root-entry.takoserver.test";
const ENTRY = join(import.meta.dir, "..", "src", "entry-bun.ts");

function baseEnvironment(home: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    CI: "1",
    NO_COLOR: "1",
    PORT: String(port),
    TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
  };
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function exited(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (code === null) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("normal Bun entry did not exit");
  }
  return code;
}

test("the relative default data root is resolved before the private planes require a canonical root", async () => {
  // The operator runs from a checkout and leaves TAKOSERVER_DATA_ROOT unset.
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "data-root-entry-")));
  const dataRoot = join(cwd, ".takoserver");
  const port = await unusedPort();
  const queuePort = await unusedPort();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(join(dataRoot, "keys"), { recursive: true, mode: 0o700 });
    const key = join(dataRoot, "keys", "queue.key");
    await writeFile(key, new Uint8Array(32).fill(0x41), { mode: 0o600 });
    child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...baseEnvironment(cwd, port),
        TAKOSERVER_V2_WORKER_PRIVATE_PLANES: JSON.stringify({
          queue: { privatePort: queuePort, signingKeyFile: key },
        }),
      },
    });
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
          signal: AbortSignal.timeout(500),
        });
        await response.arrayBuffer();
        ready = response.status === 200;
      } catch {
        // The listener may not have bound yet.
      }
      if (!ready) await Bun.sleep(50);
    }
    if (!ready) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      throw new Error(
        `entry was not ready: ${await new Response(child.stderr as ReadableStream).text()}`,
      );
    }
    // The control database is under the absolute root the private planes used.
    expect(existsSync(join(dataRoot, "control.sqlite"))).toBe(true);
    child.kill("SIGTERM");
    expect(await exited(child)).toBe(0);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain(
      `TAKOSERVER_DATA_ROOT (default .takoserver) resolved to ${dataRoot}\n`,
    );
    child = undefined;
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a data root too long for a selected v2 Workflow runtime is refused at boot by name", async () => {
  const base = await mkdtempForSockets("dre-", SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES - 2);
  try {
    const exact = join(
      base,
      "d".repeat(SELFHOST_WORKFLOW_DATA_ROOT_MAX_BYTES - Buffer.byteLength(base) - 1),
    );
    await mkdir(exact, { mode: 0o700 });
    const over = `${exact}x`;
    await mkdir(over, { mode: 0o700 });
    const boot = async (dataRoot: string) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
        cwd: join(import.meta.dir, ".."),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...baseEnvironment(base, await unusedPort()),
          TAKOSERVER_DATA_ROOT: dataRoot,
          TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({
            workflow: { maximumRegistrations: 1 },
          }),
        },
      });
      const code = await exited(child);
      return { code, stderr: await new Response(child.stderr).text() };
    };
    const refused = await boot(over);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      `TAKOSERVER_DATA_ROOT is ${over} (62 bytes), but the v2 Workflow runtime ` +
        "(TAKOSERVER_V2_WORKER_RUNTIME_BOOT.workflow) places Unix sockets below it and allows " +
        "at most 61 bytes",
    );
    // Refused before the control database is opened or migrated.
    expect(existsSync(join(over, "control.sqlite"))).toBe(false);
    // One byte shorter passes this check; this fixture then lacks the
    // configured WorkerBundle backend, which is the next boot requirement.
    const fits = await boot(exact);
    expect(fits.code).not.toBe(0);
    expect(fits.stderr).not.toContain("TAKOSERVER_DATA_ROOT is ");
    expect(fits.stderr).toContain(
      "v2 Actor/Workflow boot requires the configured held WorkerBundle",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
