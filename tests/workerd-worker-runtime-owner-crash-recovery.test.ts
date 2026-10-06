import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";

const WORKER_UID = "worker-crash-reopen";
const CREATE_ID = "8f068b66-a849-4d9c-aa5a-ed4823101fc9";
const DELETE_ID = "8fd4c347-bacf-4d91-9453-70566b5959e5";
const HOST_FIXTURE = new URL("./fixtures/workerd-runtime-owner-crash-host.ts", import.meta.url)
  .pathname;
const CHILD_SOURCE = `
import { readFileSync } from "node:fs";
const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("unexpected command");
function identity() {
  const config = readFileSync(configPath, "utf8");
  const port = /address = "\\*:(\\d+)"/u.exec(config)?.[1];
  const generation = /\\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  const token = /\\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  if (!port || !generation || !token) throw new Error("invalid rendered config");
  return { port: Number(port), generation, token };
}
const initial = identity();
const server = Bun.serve({ hostname: "127.0.0.1", port: initial.port, fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserve"),
  });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

type HostProcess = ReturnType<typeof Bun.spawn>;

async function readJsonLine(child: HostProcess): Promise<Record<string, unknown>> {
  const stdout = child.stdout;
  if (!stdout || typeof stdout === "number") throw new Error("host fixture stdout is unavailable");
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done)
      throw new Error(`host fixture exited before readiness (${await child.exited})`);
    text += decoder.decode(result.value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
  }
}

async function startHost(
  mode: "retire" | "empty-delete" | "replay",
  root: string,
  binary: string,
  port: number,
): Promise<HostProcess> {
  return Bun.spawn(
    [
      process.execPath,
      HOST_FIXTURE,
      mode,
      join(root, "owners"),
      WORKER_UID,
      binary,
      String(port),
      CREATE_ID,
      DELETE_ID,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
}

type TestChild = ReturnType<typeof spawnWorkerdWithParentDeath>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-worker-owner-crash-recovery-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const children: TestChild[] = [];
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return {
    root,
    binary,
    children,
    spawn(command: readonly string[]): WorkerdProcess {
      const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
      children.push(child);
      return child;
    },
    async cleanup() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function terminateHost(child: HostProcess): Promise<void> {
  child.kill("SIGKILL");
  await child.exited;
}

async function waitForVacant(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await workerPortOwnership(port, undefined)) === "vacant") return;
    await Bun.sleep(10);
  }
  throw new Error("foreign listener did not become vacant");
}

function ownerDirectory(root: string): string {
  const uidHash = createHash("sha256").update(WORKER_UID, "utf8").digest("hex");
  return join(root, "owners", uidHash);
}

test("a new host process replays the exact DELETE proof after the old host crashes", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successorA: HostProcess | undefined;
  let successorB: HostProcess | undefined;
  try {
    oldHost = await startHost("empty-delete", owned.root, owned.binary, port);
    const retired = await readJsonLine(oldHost);
    expect(retired).toMatchObject({ kind: "empty-retired", port });
    const oldPid = retired.pid;
    await terminateHost(oldHost);
    oldHost = undefined;

    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
    successorA = await startHost("replay", owned.root, owned.binary, port);
    successorB = await startHost("replay", owned.root, owned.binary, port);
    const [resultA, resultB] = await Promise.all([
      readJsonLine(successorA),
      readJsonLine(successorB),
    ]);
    const successes = [resultA, resultB].filter((result) => result.kind === "replayed");
    const refusals = [resultA, resultB].filter((result) => result.kind === "error");
    expect(successes).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: "ownership_uncertain" });
    expect(successes[0]?.pid).not.toBe(oldPid);
    expect(successes[0]?.port).toBe(port);
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successorA) await terminateHost(successorA);
    if (successorB) await terminateHost(successorB);
    await owned.cleanup();
  }
});

test("a foreign listener blocks retired-owner replay after host crash", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    oldHost = await startHost("retire", owned.root, owned.binary, port);
    expect(await readJsonLine(oldHost)).toMatchObject({ kind: "retired", port });
    await terminateHost(oldHost);
    oldHost = undefined;

    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign") });
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await successor.exited;
    successor = undefined;
    expect(await fetch(`http://127.0.0.1:${port}/`)).toBeInstanceOf(Response);
    foreign.stop(true);
    foreign = undefined;
    await waitForVacant(port);
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "replayed", port });
  } finally {
    foreign?.stop(true);
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a substituted lock inode is not accepted as the stale owner's receipt authority", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    oldHost = await startHost("retire", owned.root, owned.binary, port);
    expect(await readJsonLine(oldHost)).toMatchObject({ kind: "retired", port });
    await terminateHost(oldHost);
    oldHost = undefined;

    const lockPath = join(ownerDirectory(owned.root), "runtime-owner.lock");
    const original = await readFile(lockPath);
    const originalInodePath = `${lockPath}.original`;
    const replacement = `${lockPath}.replacement`;
    await rename(lockPath, originalInodePath);
    await writeFile(replacement, original, { mode: 0o600 });
    await rename(replacement, lockPath);

    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await successor.exited;
    successor = undefined;
    await rm(lockPath);
    await rename(originalInodePath, lockPath);
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "replayed", port });
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("an old PID-only owner lock remains an unknown manual-recovery boundary", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    oldHost = await startHost("empty-delete", owned.root, owned.binary, port);
    expect(await readJsonLine(oldHost)).toMatchObject({ kind: "empty-retired", port });
    await terminateHost(oldHost);
    oldHost = undefined;

    const lockPath = join(ownerDirectory(owned.root), "runtime-owner.lock");
    const legacyRecord = `${JSON.stringify({ pid: 12345 })}\n`;
    await writeFile(lockPath, legacyRecord, { mode: 0o600 });
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await successor.exited;
    successor = undefined;
    expect(await readFile(lockPath, "utf8")).toBe(legacyRecord);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a lock from a different PID namespace is refused without rewriting its state", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    oldHost = await startHost("empty-delete", owned.root, owned.binary, port);
    expect(await readJsonLine(oldHost)).toMatchObject({ kind: "empty-retired", port });
    await terminateHost(oldHost);
    oldHost = undefined;

    const directory = ownerDirectory(owned.root);
    const lockPath = join(directory, "runtime-owner.lock");
    const statePath = join(directory, "runtime-owner.json");
    const originalLock = await readFile(lockPath, "utf8");
    const stateBefore = await readFile(statePath, "utf8");
    const lockRecord = JSON.parse(originalLock) as {
      process: { bootId: string; pidNamespace: string };
    };
    lockRecord.process.pidNamespace = "1:1";
    const otherNamespaceLock = `${JSON.stringify(lockRecord)}\n`;
    await writeFile(lockPath, otherNamespaceLock, { mode: 0o600 });

    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await successor.exited;
    successor = undefined;
    expect(await readFile(lockPath, "utf8")).toBe(otherNamespaceLock);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");

    await writeFile(lockPath, originalLock, { mode: 0o600 });
    lockRecord.process.bootId = "00000000-0000-4000-8000-000000000000";
    const otherBootLock = `${JSON.stringify(lockRecord)}\n`;
    await writeFile(lockPath, otherBootLock, { mode: 0o600 });
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await successor.exited;
    successor = undefined;
    expect(await readFile(lockPath, "utf8")).toBe(otherBootLock);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);

    await writeFile(lockPath, originalLock, { mode: 0o600 });
    successor = await startHost("replay", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "replayed", port });
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});
