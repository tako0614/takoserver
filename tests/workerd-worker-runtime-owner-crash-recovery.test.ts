import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxProcessLiveness,
  readLinuxProcessIdentity,
  spawnWorkerdWithParentDeath,
  workerPortOwnership,
} from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import {
  openWorkerdWorkerExecutionGroup,
  verifyRetiredWorkerdWorkerExecutionCopies,
} from "../src/workerd-worker-execution-group.ts";

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
  mode:
    | "retire"
    | "empty-delete"
    | "replay"
    | "active-create"
    | "active-recover"
    | "active-recover-only"
    | "active-recover-reject-after-spawn"
    | "active-recover-fail-before-spawn"
    | "active-recover-sql-unavailable"
    | "active-update-draining"
    | "active-update-hang-after-candidate"
    | "create-hang-after-candidate"
    | "active-recover-reexecute"
    | "active-endpoint-delete-hang-after-candidate"
    | "active-recover-reexecute-endpoint-delete"
    | "open-only",
  root: string,
  binary: string,
  port: number,
  updateId = "",
  createId = CREATE_ID,
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
      createId,
      updateId,
      DELETE_ID,
    ],
    { stdout: mode === "active-recover-sql-unavailable" ? "ignore" : "pipe", stderr: "ignore" },
  );
}

const UPDATE_ID = "8a7f7aa3-c782-44b4-8f02-201dab446c2d";

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

async function ownerState(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(ownerDirectory(root), "runtime-owner.json"), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * The owner's own state encoding: insertion-ordered JSON plus a newline. A
 * tampered state in any other encoding is refused by the parser, so a refusal
 * would prove nothing about the rule the test means to pin.
 */
function ownerStateText(state: unknown): string {
  return `${JSON.stringify(state)}\n`;
}

async function readSqlFailureMarker(root: string): Promise<{ code: string; pid: number }> {
  const path = join(root, "owners", "sql-failure-ready.json");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) return JSON.parse(text) as { code: string; pid: number };
    await Bun.sleep(10);
  }
  throw new Error("SQL failure marker was not written");
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
    if (successes.length !== 1) {
      throw new Error(`unexpected DELETE replay outcomes: ${JSON.stringify({ resultA, resultB })}`);
    }
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

test("a successor host reopens and serves the exact active incarnation before update and DELETE", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    oldHost = await startHost("active-create", owned.root, owned.binary, port);
    const created = await readJsonLine(oldHost);
    expect(created).toMatchObject({ kind: "active-created", port });
    const oldPid = created.pid;
    const before = await ownerState(owned.root);
    const beforeIncarnations = before.incarnations as Record<string, unknown>[];
    const originalIncarnation = beforeIncarnations.find((item) => item.operationId === CREATE_ID);
    expect(originalIncarnation?.processIdentity).toMatchObject({ pid: expect.any(Number) });
    await terminateHost(oldHost);
    oldHost = undefined;
    await waitForVacant(port);

    successor = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    const recovered = await readJsonLine(successor);
    expect(recovered).toMatchObject({ kind: "recovered-updated-deleted", port });
    expect(recovered.pid).not.toBe(oldPid);
    expect(typeof recovered.body).toBe("string");
    const after = await ownerState(owned.root);
    const afterIncarnations = after.incarnations as Record<string, unknown>[];
    const reopenedIncarnation = afterIncarnations.find((item) => item.operationId === CREATE_ID);
    expect(reopenedIncarnation?.status).toBe("retired");
    expect((reopenedIncarnation?.processIdentity as { pid?: number })?.pid).not.toBe(
      (originalIncarnation?.processIdentity as { pid?: number })?.pid,
    );
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a second successor reopens the same active graph after a rotated config was pinned", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let second: HostProcess | undefined;
  let third: HostProcess | undefined;
  try {
    first = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-created", port });
    const original = await ownerState(owned.root);
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    second = await startHost("active-recover-only", owned.root, owned.binary, port);
    expect(await readJsonLine(second)).toMatchObject({ kind: "recovered-active", port });
    const rotated = await ownerState(owned.root);
    const originalActive = (original.incarnations as Record<string, unknown>[]).find(
      (item) => item.operationId === CREATE_ID,
    );
    const rotatedActive = (rotated.incarnations as Record<string, unknown>[]).find(
      (item) => item.operationId === CREATE_ID,
    );
    expect(rotatedActive?.configurationSha256).not.toBe(originalActive?.configurationSha256);
    expect(rotatedActive?.configurationRefreshPending).toBe(false);
    await terminateHost(second);
    second = undefined;
    await waitForVacant(port);

    third = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(third)).toMatchObject({ kind: "recovered-updated-deleted", port });
  } finally {
    if (first) await terminateHost(first);
    if (second) await terminateHost(second);
    if (third) await terminateHost(third);
    await owned.cleanup();
  }
});

test("failed successor keeps its fenced lock until dead, then a third host retries", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let failed: HostProcess | undefined;
  let third: HostProcess | undefined;
  try {
    first = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-created", port });
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    failed = await startHost("active-recover-reject-after-spawn", owned.root, owned.binary, port);
    expect(await readJsonLine(failed)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
      phase: "open-owner",
    });
    const lock = JSON.parse(
      await readFile(join(ownerDirectory(owned.root), "runtime-owner.lock"), "utf8"),
    ) as { pid: number };
    expect(lock.pid).toBe(failed.pid);
    await waitForVacant(port);
    await terminateHost(failed);
    failed = undefined;

    third = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(third)).toMatchObject({ kind: "recovered-updated-deleted", port });
  } finally {
    if (first) await terminateHost(first);
    if (failed) await terminateHost(failed);
    if (third) await terminateHost(third);
    await owned.cleanup();
  }
});

test("transient current-serving lookup failure preserves a retryable active owner", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let failed: HostProcess | undefined;
  let competing: HostProcess | undefined;
  let third: HostProcess | undefined;
  try {
    first = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-created", port });
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    failed = await startHost("active-recover-sql-unavailable", owned.root, owned.binary, port);
    expect(await readSqlFailureMarker(owned.root)).toEqual({
      code: "ownership_uncertain",
      pid: failed.pid,
    });
    const lock = JSON.parse(
      await readFile(join(ownerDirectory(owned.root), "runtime-owner.lock"), "utf8"),
    ) as { pid: number };
    expect(lock.pid).toBe(failed.pid);
    expect(failed.exitCode).toBeNull();
    expect(
      (await readFile(`/proc/${failed.pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"),
    ).toBe(false);
    competing = await startHost("active-recover-only", owned.root, owned.binary, port);
    expect(await readJsonLine(competing)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
      phase: "open-owner",
    });
    await terminateHost(competing);
    competing = undefined;
    await terminateHost(failed);
    failed = undefined;

    third = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(third)).toMatchObject({ kind: "recovered-updated-deleted", port });
  } finally {
    if (first) await terminateHost(first);
    if (failed) await terminateHost(failed);
    if (competing) await terminateHost(competing);
    if (third) await terminateHost(third);
    await owned.cleanup();
  }
});

test("a third host retries a refresh checkpoint left before child spawn", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let failed: HostProcess | undefined;
  let third: HostProcess | undefined;
  try {
    first = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-created", port });
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    failed = await startHost("active-recover-fail-before-spawn", owned.root, owned.binary, port);
    expect(await readJsonLine(failed)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
      phase: "open-owner",
    });
    const checkpoint = await ownerState(owned.root);
    const active = (checkpoint.incarnations as Record<string, unknown>[]).find(
      (item) => item.operationId === CREATE_ID,
    );
    expect(active?.configurationRefreshPending).toBe(true);
    await failed.exited;
    failed = undefined;

    third = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(third)).toMatchObject({ kind: "recovered-updated-deleted", port });
  } finally {
    if (first) await terminateHost(first);
    if (failed) await terminateHost(failed);
    if (third) await terminateHost(third);
    await owned.cleanup();
  }
});

test("refresh checkpoint refuses a group manifest that no longer pins the config bytes", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let failed: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    first = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-created", port });
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    failed = await startHost("active-recover-fail-before-spawn", owned.root, owned.binary, port);
    expect(await readJsonLine(failed)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    await failed.exited;
    failed = undefined;
    const checkpoint = await ownerState(owned.root);
    const groupDirectory = join(
      ownerDirectory(owned.root),
      "incarnations",
      CREATE_ID,
      "groups",
      createHash("sha256").update(WORKER_UID).digest("hex"),
    );
    const manifestPath = join(groupDirectory, "group.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, configurationSha256: "0".repeat(64) })}\n`,
    );

    successor = await startHost("active-recover-only", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
      phase: "open-owner",
    });
    expect(await ownerState(owned.root)).toEqual(checkpoint);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    if (first) await terminateHost(first);
    if (failed) await terminateHost(failed);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("successor completes a draining receipt checkpoint left before owner-state retirement", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    first = await startHost("active-update-draining", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-updated-draining", port });
    const before = await ownerState(owned.root);
    const draining = (before.incarnations as Record<string, unknown>[]).find(
      (item) => item.operationId === CREATE_ID,
    );
    expect(draining?.status).toBe("draining");
    expect(draining?.retirementOperationId).toBe(UPDATE_ID);
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    const uidHash = createHash("sha256").update(WORKER_UID).digest("hex");
    const groupRoot = join(ownerDirectory(owned.root), "incarnations", CREATE_ID, "groups");
    const configuration = new Uint8Array(
      await readFile(join(groupRoot, uidHash, "workers", "workerd.capnp")),
    );
    const group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: groupRoot,
      workerResourceUid: WORKER_UID,
      listenerPort: port,
      configuration,
      configurationPath: "workers/workerd.capnp",
      workerdBinary: owned.binary,
      recoverExisting: true,
    });
    const receipt = await group.retire({ workerResourceUid: WORKER_UID, operationId: UPDATE_ID });
    expect(receipt.configurationSha256).toBe(draining?.configurationSha256 as string);
    expect((await ownerState(owned.root)).incarnations).toEqual(before.incarnations);

    successor = await startHost("active-recover-only", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "recovered-active", port });
    const after = await ownerState(owned.root);
    const retired = (after.incarnations as Record<string, unknown>[]).find(
      (item) => item.operationId === CREATE_ID,
    );
    expect(retired).toMatchObject({ status: "retired", executionCopiesReleased: true, receipt });
  } finally {
    if (first) await terminateHost(first);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

for (const receiptWritten of [false, true])
  test(`successor finishes an accepted retiring predecessor ${receiptWritten ? "with" : "before"} its receipt`, async () => {
    const owned = await fixture();
    const port = await unusedPort();
    let first: HostProcess | undefined;
    let successor: HostProcess | undefined;
    try {
      first = await startHost("active-update-draining", owned.root, owned.binary, port, UPDATE_ID);
      expect(await readJsonLine(first)).toMatchObject({ kind: "active-updated-draining", port });
      await terminateHost(first);
      first = undefined;
      await waitForVacant(port);

      if (receiptWritten) {
        const uidHash = createHash("sha256").update(WORKER_UID).digest("hex");
        const groupRoot = join(ownerDirectory(owned.root), "incarnations", CREATE_ID, "groups");
        const configuration = new Uint8Array(
          await readFile(join(groupRoot, uidHash, "workers", "workerd.capnp")),
        );
        const group = await openWorkerdWorkerExecutionGroup({
          rootDirectory: groupRoot,
          workerResourceUid: WORKER_UID,
          listenerPort: port,
          configuration,
          configurationPath: "workers/workerd.capnp",
          workerdBinary: owned.binary,
          recoverExisting: true,
        });
        await group.retire({ workerResourceUid: WORKER_UID, operationId: UPDATE_ID });
      }

      // The real update path persists `retiring` before group.retire writes its
      // receipt. A host crash here leaves a newer active graph and this exact
      // unfinished predecessor, not an arbitrary orphan or a completed delete.
      const statePath = join(ownerDirectory(owned.root), "runtime-owner.json");
      const checkpoint = await ownerState(owned.root);
      checkpoint.incarnations = (checkpoint.incarnations as Record<string, unknown>[]).map(
        (item) => (item.operationId === CREATE_ID ? { ...item, status: "retiring" } : item),
      );
      const predecessor = (checkpoint.incarnations as Record<string, unknown>[]).find(
        (item) => item.operationId === CREATE_ID,
      );
      expect(predecessor).toMatchObject({
        status: "retiring",
        retirementOperationId: UPDATE_ID,
        receipt: null,
        executionCopiesCleanupStarted: false,
      });
      await writeFile(statePath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });

      successor = await startHost("active-recover-only", owned.root, owned.binary, port, UPDATE_ID);
      expect(await readJsonLine(successor)).toMatchObject({ kind: "recovered-active", port });
      const after = await ownerState(owned.root);
      expect(
        (after.incarnations as Record<string, unknown>[]).find(
          (item) => item.operationId === CREATE_ID,
        ),
      ).toMatchObject({
        status: "retired",
        retirementOperationId: UPDATE_ID,
        executionCopiesReleased: true,
        receipt: { operationId: UPDATE_ID, listenerPort: port },
      });
    } finally {
      if (first) await terminateHost(first);
      if (successor) await terminateHost(successor);
      await owned.cleanup();
    }
  });

test("successor resumes a draining cleanup-intent checkpoint before copy release", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let first: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    first = await startHost("active-update-draining", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(first)).toMatchObject({ kind: "active-updated-draining", port });
    await terminateHost(first);
    first = undefined;
    await waitForVacant(port);

    const uidHash = createHash("sha256").update(WORKER_UID).digest("hex");
    const groupRoot = join(ownerDirectory(owned.root), "incarnations", CREATE_ID, "groups");
    const groupDirectory = join(groupRoot, uidHash);
    const configuration = new Uint8Array(
      await readFile(join(groupDirectory, "workers", "workerd.capnp")),
    );
    const group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: groupRoot,
      workerResourceUid: WORKER_UID,
      listenerPort: port,
      configuration,
      configurationPath: "workers/workerd.capnp",
      workerdBinary: owned.binary,
      recoverExisting: true,
    });
    await group.retire({ workerResourceUid: WORKER_UID, operationId: UPDATE_ID });
    const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
      groupDirectory,
      workerResourceUid: WORKER_UID,
      operationId: UPDATE_ID,
      listenerPort: port,
      scriptName: `v2-worker-${uidHash}`,
    });
    const statePath = join(ownerDirectory(owned.root), "runtime-owner.json");
    const checkpoint = await ownerState(owned.root);
    checkpoint.incarnations = (checkpoint.incarnations as Record<string, unknown>[]).map((item) =>
      item.operationId === CREATE_ID
        ? {
            ...item,
            receipt: verified.receipt,
            executionCopiesCleanupStarted: true,
            executionCopiesCleanupManifestSha256: verified.cleanupManifestSha256,
          }
        : item,
    );
    await writeFile(statePath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });

    successor = await startHost("active-recover-only", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "recovered-active", port });
    const after = await ownerState(owned.root);
    expect(
      (after.incarnations as Record<string, unknown>[]).find(
        (item) => item.operationId === CREATE_ID,
      ),
    ).toMatchObject({
      status: "retired",
      executionCopiesReleased: true,
      receipt: verified.receipt,
    });
  } finally {
    if (first) await terminateHost(first);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("an active record without its persisted child fingerprint remains unknown after restart", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let oldHost: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    oldHost = await startHost("active-create", owned.root, owned.binary, port);
    expect(await readJsonLine(oldHost)).toMatchObject({ kind: "active-created", port });
    await terminateHost(oldHost);
    oldHost = undefined;
    await waitForVacant(port);

    const path = join(ownerDirectory(owned.root), "runtime-owner.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      incarnations: Record<string, unknown>[];
    };
    state.incarnations = state.incarnations.map((item) =>
      item.operationId === CREATE_ID
        ? { ...item, processIdentity: null, configurationSha256: null }
        : item,
    );
    const tamperedState = ownerStateText(state);
    await writeFile(path, tamperedState, { mode: 0o600 });

    successor = await startHost("active-recover", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    expect(await readFile(path, "utf8")).toBe(tamperedState);
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    if (oldHost) await terminateHost(oldHost);
    if (successor) await terminateHost(successor);
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

type StoredIncarnation = {
  operationId: string;
  status: string;
  listenerPort: number;
  retirementOperationId: string | null;
  identity: unknown;
  receipt: unknown;
  executionCopiesReleased: boolean;
  processIdentity: { pid: number } | null;
};

async function incarnations(root: string): Promise<{
  activeOperationId: string | null;
  incarnations: StoredIncarnation[];
}> {
  return (await ownerState(root)) as never;
}

/**
 * Crash window: the owner persisted a candidate incarnation and its bootstrap
 * child is running, but the Host is killed before activation. Activation is one
 * atomic owner-state write, so the committed incumbent is still the only
 * serving incarnation and the candidate never served.
 */
test("a successor host abandons a never-activated candidate left by a killed update and serves the committed incarnation", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let host: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    host = await startHost(
      "active-update-hang-after-candidate",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    expect(await readJsonLine(host)).toMatchObject({ kind: "candidate-hung", port });
    const before = await incarnations(owned.root);
    const candidate = before.incarnations.find((item) => item.operationId === UPDATE_ID);
    // A crash that landed after activation would make this test meaningless.
    expect(candidate).toMatchObject({ status: "candidate", identity: null, receipt: null });
    expect(candidate?.processIdentity).not.toBeNull();
    expect(before.activeOperationId).toBe(CREATE_ID);
    const candidatePort = candidate?.listenerPort as number;
    const candidateIdentity = candidate?.processIdentity as never;
    await terminateHost(host);
    host = undefined;
    await waitForVacant(candidatePort);
    expect(await linuxProcessLiveness(candidateIdentity)).toBe("stale");

    successor = await startHost(
      "active-recover-reexecute",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    // The engine re-drives the dispatched Operation: the owner answers with its
    // proof instead of a second incarnation, so the backend can settle no effect.
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "recovered-active",
      port,
      reexecuted: { kind: "abandoned_before_activation", operationId: UPDATE_ID },
    });

    const after = await incarnations(owned.root);
    expect(after.activeOperationId).toBe(CREATE_ID);
    expect(after.incarnations.find((item) => item.operationId === CREATE_ID)?.status).toBe(
      "active",
    );
    // The abandoned candidate id is retired in place and never reused.
    expect(after.incarnations.find((item) => item.operationId === UPDATE_ID)).toMatchObject({
      status: "retired",
      retirementOperationId: UPDATE_ID,
      identity: null,
      executionCopiesReleased: true,
    });
    expect(after.incarnations).toHaveLength(2);
    expect(await workerPortOwnership(candidatePort, undefined)).toBe("vacant");
    // What the owner vouches for when the SQL fence meets a dispatched Operation:
    // the abandoned candidate and an Operation it never saw never served; the
    // incumbent that is serving is never vouched for.
    expect(
      JSON.parse(await readFile(join(owned.root, "owners", "never-served.json"), "utf8")),
    ).toEqual({ update: true, create: false, unknown: true });
  } finally {
    if (host) await terminateHost(host);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a successor host abandons the candidate of a killed first publication and opens without an active incarnation", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let host: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    host = await startHost("create-hang-after-candidate", owned.root, owned.binary, port);
    expect(await readJsonLine(host)).toMatchObject({ kind: "candidate-hung", port });
    const before = await incarnations(owned.root);
    expect(before.activeOperationId).toBeNull();
    expect(before.incarnations).toHaveLength(1);
    expect(before.incarnations[0]).toMatchObject({ status: "candidate", identity: null });
    await terminateHost(host);
    host = undefined;
    await waitForVacant(port);

    successor = await startHost("open-only", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "opened", port });
    const after = await incarnations(owned.root);
    expect(after.activeOperationId).toBeNull();
    expect(after.incarnations).toHaveLength(1);
    expect(after.incarnations[0]).toMatchObject({
      operationId: CREATE_ID,
      status: "retired",
      retirementOperationId: CREATE_ID,
      identity: null,
      executionCopiesReleased: true,
    });
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
  } finally {
    if (host) await terminateHost(host);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a candidate whose listener is held by a foreign process is not abandoned", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let host: HostProcess | undefined;
  let successor: HostProcess | undefined;
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    host = await startHost(
      "active-update-hang-after-candidate",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    await readJsonLine(host);
    const candidate = (await incarnations(owned.root)).incarnations.find(
      (item) => item.operationId === UPDATE_ID,
    );
    const candidatePort = candidate?.listenerPort as number;
    await terminateHost(host);
    host = undefined;
    await waitForVacant(candidatePort);
    foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: candidatePort,
      fetch: () => new Response("x"),
    });

    const path = join(ownerDirectory(owned.root), "runtime-owner.json");
    const untouched = await readFile(path, "utf8");
    successor = await startHost("active-recover-only", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    expect(await readFile(path, "utf8")).toBe(untouched);
  } finally {
    foreign?.stop(true);
    if (host) await terminateHost(host);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a candidate without its persisted child identity is not abandoned", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let host: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    host = await startHost(
      "active-update-hang-after-candidate",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    await readJsonLine(host);
    const candidate = (await incarnations(owned.root)).incarnations.find(
      (item) => item.operationId === UPDATE_ID,
    );
    await terminateHost(host);
    host = undefined;
    await waitForVacant(candidate?.listenerPort as number);

    const path = join(ownerDirectory(owned.root), "runtime-owner.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      incarnations: Record<string, unknown>[];
    };
    state.incarnations = state.incarnations.map((item) =>
      item.operationId === UPDATE_ID ? { ...item, processIdentity: null } : item,
    );
    const tampered = ownerStateText(state);
    await writeFile(path, tampered, { mode: 0o600 });
    successor = await startHost("active-recover-only", owned.root, owned.binary, port, UPDATE_ID);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    expect(await readFile(path, "utf8")).toBe(tampered);
  } finally {
    if (host) await terminateHost(host);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

const REAPPLY_ID = "8c1f5e0a-3b7d-4e2a-9f61-0d2b7a4c9e13";

/** Kill a first publication at its candidate, then boot once so it is abandoned. */
async function abandonFirstPublication(
  owned: Awaited<ReturnType<typeof fixture>>,
  port: number,
): Promise<{ readonly path: string; readonly candidateIdentity: unknown }> {
  const host = await startHost("create-hang-after-candidate", owned.root, owned.binary, port);
  try {
    expect(await readJsonLine(host)).toMatchObject({ kind: "candidate-hung", port });
  } finally {
    await terminateHost(host);
  }
  await waitForVacant(port);
  const path = join(ownerDirectory(owned.root), "runtime-owner.json");
  const before = await incarnations(owned.root);
  expect(before.incarnations[0]).toMatchObject({ status: "candidate", identity: null });
  return { path, candidateIdentity: before.incarnations[0]?.processIdentity };
}

test("a first publication abandoned at boot survives a second Host kill before any re-apply", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  const hosts: HostProcess[] = [];
  try {
    await abandonFirstPublication(owned, port);
    // Boot 1 abandons the candidate and keeps running; then the Host is
    // killed again (SIGKILL/OOM) before the user re-applies.
    const boot1 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot1);
    expect(await readJsonLine(boot1)).toMatchObject({ kind: "opened", port });
    const abandoned = await readFile(
      join(ownerDirectory(owned.root), "runtime-owner.json"),
      "utf8",
    );
    expect((await incarnations(owned.root)).incarnations[0]).toMatchObject({
      status: "retired",
      retirementOperationId: CREATE_ID,
      identity: null,
    });
    await terminateHost(boot1);
    hosts.pop();

    // Boot 2 takes over a stale lock whose state has only a retired,
    // never-activated record. That is not a DELETE replay and must boot.
    const boot2 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot2);
    expect(await readJsonLine(boot2)).toMatchObject({ kind: "opened", port });
    expect(await readFile(join(ownerDirectory(owned.root), "runtime-owner.json"), "utf8")).toBe(
      abandoned,
    );
    await terminateHost(boot2);
    hosts.pop();

    // A third boot after yet another kill can take the user's re-apply.
    const reapply = await startHost(
      "active-create",
      owned.root,
      owned.binary,
      port,
      "",
      REAPPLY_ID,
    );
    hosts.push(reapply);
    expect(await readJsonLine(reapply)).toMatchObject({ kind: "active-created", port });
    const after = await incarnations(owned.root);
    expect(after.activeOperationId).toBe(REAPPLY_ID);
    expect(after.incarnations.find((item) => item.operationId === CREATE_ID)?.status).toBe(
      "retired",
    );
  } finally {
    for (const host of hosts) await terminateHost(host);
    await owned.cleanup();
  }
});

test("a boot killed between abandoning a first publication and its retirement receipt is resumed", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let successor: HostProcess | undefined;
  try {
    const { path } = await abandonFirstPublication(owned, port);
    // Exactly the durable conversion an abandoning boot writes before it
    // writes the group's retirement receipt; that boot then dies (its lock is
    // left stale, like the original Host's).
    const state = JSON.parse(await readFile(path, "utf8")) as {
      incarnations: Record<string, unknown>[];
    };
    state.incarnations = state.incarnations.map((item) =>
      item.operationId === CREATE_ID
        ? { ...item, status: "uncertain", retirementOperationId: CREATE_ID }
        : item,
    );
    await writeFile(path, ownerStateText(state), { mode: 0o600 });

    successor = await startHost("open-only", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({ kind: "opened", port });
    const after = await incarnations(owned.root);
    expect(after.activeOperationId).toBeNull();
    expect(after.incarnations).toHaveLength(1);
    expect(after.incarnations[0]).toMatchObject({
      operationId: CREATE_ID,
      status: "retired",
      retirementOperationId: CREATE_ID,
      identity: null,
      executionCopiesReleased: true,
    });
    expect(after.incarnations[0]?.receipt).not.toBeNull();
  } finally {
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("a never-activated retirement is not resumed while its recorded child is alive", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let successor: HostProcess | undefined;
  const live = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  try {
    const { path } = await abandonFirstPublication(owned, port);
    const liveIdentity = await readLinuxProcessIdentity(live.pid);
    const state = JSON.parse(await readFile(path, "utf8")) as {
      incarnations: Record<string, unknown>[];
    };
    state.incarnations = state.incarnations.map((item) =>
      item.operationId === CREATE_ID
        ? {
            ...item,
            status: "uncertain",
            retirementOperationId: CREATE_ID,
            processIdentity: liveIdentity,
          }
        : item,
    );
    const tampered = ownerStateText(state);
    await writeFile(path, tampered, { mode: 0o600 });

    successor = await startHost("open-only", owned.root, owned.binary, port);
    expect(await readJsonLine(successor)).toMatchObject({
      kind: "error",
      code: "ownership_uncertain",
    });
    expect(await readFile(path, "utf8")).toBe(tampered);
  } finally {
    live.kill("SIGKILL");
    await live.exited;
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});

test("an abandoned first publication is not reopened while a foreign process holds its listener", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  const hosts: HostProcess[] = [];
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    await abandonFirstPublication(owned, port);
    const boot1 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot1);
    expect(await readJsonLine(boot1)).toMatchObject({ kind: "opened", port });
    await terminateHost(boot1);
    hosts.pop();
    await waitForVacant(port);
    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });

    const path = join(ownerDirectory(owned.root), "runtime-owner.json");
    const untouched = await readFile(path, "utf8");
    const boot2 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot2);
    expect(await readJsonLine(boot2)).toMatchObject({ kind: "error", code: "ownership_uncertain" });
    expect(await readFile(path, "utf8")).toBe(untouched);
  } finally {
    foreign?.stop(true);
    for (const host of hosts) await terminateHost(host);
    await owned.cleanup();
  }
});

test("a retired record that was once activated is still treated as a DELETE replay", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  const hosts: HostProcess[] = [];
  try {
    await abandonFirstPublication(owned, port);
    const boot1 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot1);
    expect(await readJsonLine(boot1)).toMatchObject({ kind: "opened", port });
    await terminateHost(boot1);
    hosts.pop();

    // Same residue, but the record carries a pinned configuration: it may have
    // been activated, so only an exact DELETE replay could take it over.
    const path = join(ownerDirectory(owned.root), "runtime-owner.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      incarnations: Record<string, unknown>[];
    };
    state.incarnations = state.incarnations.map((item) =>
      item.operationId === CREATE_ID ? { ...item, configurationSha256: "0".repeat(64) } : item,
    );
    const tampered = ownerStateText(state);
    await writeFile(path, tampered, { mode: 0o600 });
    const boot2 = await startHost("open-only", owned.root, owned.binary, port);
    hosts.push(boot2);
    expect(await readJsonLine(boot2)).toMatchObject({ kind: "error", code: "ownership_uncertain" });
    expect(await readFile(path, "utf8")).toBe(tampered);
  } finally {
    for (const host of hosts) await terminateHost(host);
    await owned.cleanup();
  }
});

test("an Endpoint DELETE killed at its candidate settles without effect and the committed incarnation keeps its hostname", async () => {
  const owned = await fixture();
  const port = await unusedPort();
  let host: HostProcess | undefined;
  let successor: HostProcess | undefined;
  try {
    // UPDATE_ID is the Endpoint DELETE here: with a Deployment present it
    // publishes the hostname-less graph through a candidate, like an update.
    host = await startHost(
      "active-endpoint-delete-hang-after-candidate",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    expect(await readJsonLine(host)).toMatchObject({ kind: "candidate-hung", port });
    const before = await incarnations(owned.root);
    const candidate = before.incarnations.find((item) => item.operationId === UPDATE_ID);
    expect(candidate).toMatchObject({ status: "candidate", identity: null, receipt: null });
    expect(candidate?.processIdentity).not.toBeNull();
    expect(before.activeOperationId).toBe(CREATE_ID);
    await terminateHost(host);
    host = undefined;
    await waitForVacant(candidate?.listenerPort as number);

    successor = await startHost(
      "active-recover-reexecute-endpoint-delete",
      owned.root,
      owned.binary,
      port,
      UPDATE_ID,
    );
    const recovered = await readJsonLine(successor);
    // The re-driven DELETE gets the owner's definitive answer, not `unknown`
    // forever, and no second incarnation is started for it.
    expect(recovered).toMatchObject({
      kind: "recovered-active",
      port,
      reexecuted: { kind: "abandoned_before_activation", operationId: UPDATE_ID },
      serving: {
        kind: "serving",
        sourceOperationId: CREATE_ID,
        hostnames: [`${WORKER_UID}.example.test`],
      },
    });
    const after = await incarnations(owned.root);
    expect(after.activeOperationId).toBe(CREATE_ID);
    expect(after.incarnations).toHaveLength(2);
    expect(after.incarnations.find((item) => item.operationId === UPDATE_ID)).toMatchObject({
      status: "retired",
      retirementOperationId: UPDATE_ID,
      identity: null,
      executionCopiesReleased: true,
    });
    expect(
      JSON.parse(await readFile(join(owned.root, "owners", "never-served.json"), "utf8")),
    ).toEqual({ update: true, create: false, unknown: true });
  } finally {
    if (host) await terminateHost(host);
    if (successor) await terminateHost(successor);
    await owned.cleanup();
  }
});
