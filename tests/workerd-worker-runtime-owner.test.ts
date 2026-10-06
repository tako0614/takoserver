import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import {
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import {
  createSerializedWorkerdOwnerStateWriter,
  openWorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-worker-runtime-owner";
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
  if (url.pathname === "/hold") {
    let timer;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(current.generation)); timer = setInterval(() => controller.enqueue(new Uint8Array([46])), 20); },
      cancel() { clearInterval(timer); },
    }));
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
`;

type TestChild = ReturnType<typeof spawnWorkerdWithParentDeath>;

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

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("runtime-owner child observation timed out");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-worker-runtime-owner-"));
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

function staticPublicationState(workerResourceUid: string) {
  const assetBytes = new TextEncoder().encode("owner fixture asset");
  let lastOperationId: string | undefined;
  let fenceCurrent = true;
  const source = {
    async resolve({
      execution,
      incumbentSourceOperationId,
    }: {
      execution: V2Execution;
      incumbentSourceOperationId?: string;
    }): Promise<V2WorkerPublicationResolution> {
      if (
        (execution.action === "update" || execution.action === "delete") &&
        incumbentSourceOperationId !== undefined
      ) {
        if (lastOperationId !== incumbentSourceOperationId)
          return {
            kind: "unresolved",
            code: "incumbent_unresolved",
            message: "fixture did not observe the exact current Deployment",
          };
      }
      const parsed = parseWorkerDeploymentSpec(execution.spec);
      const versionUid = parsed.versions[0]?.workerVersion.resourceUid;
      if (!versionUid && execution.action !== "delete") throw new Error("version missing");
      const spec = {
        worker: { resourceUid: workerResourceUid },
        handlers: [],
        assets: {
          bundle: { resourceUid: `assets-${execution.operationId}` },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      };
      const fileSha256 = (await bytesDigest(assetBytes)).slice("sha256:".length);
      const manifest = {
        files: [
          {
            path: "index.html",
            url: "https://artifacts.example.test/index.html",
            sha256: fileSha256,
            mediaType: "text/html",
          },
        ],
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
      const heldAssets = {
        manifest,
        manifestBytes,
        files: [assetBytes],
        observed: {
          manifestSha256,
          fileCount: 1,
          totalBytes: assetBytes.byteLength,
          files: [
            {
              path: "index.html",
              sha256: fileSha256,
              mediaType: "text/html",
              byteSize: assetBytes.byteLength,
            },
          ],
        },
      };
      return {
        kind: "ready",
        snapshot: {
          sourceOperationId: execution.operationId,
          worker: {
            uid: workerResourceUid,
            principal: execution.principal,
            space: execution.space,
            generation: 1,
          },
          deployment:
            execution.action === "delete"
              ? null
              : {
                  uid: execution.resourceUid,
                  generation: execution.generation,
                  spec: parsed,
                  versions: [
                    {
                      uid: versionUid as string,
                      generation: execution.generation,
                      weight: 10_000,
                      spec,
                    },
                  ],
                },
          endpoint: {
            uid: `endpoint-${workerResourceUid}`,
            generation: 1,
            spec: { worker: { resourceUid: workerResourceUid } },
            output: {
              hostname: `${workerResourceUid}.example.test`,
              url: `https://${workerResourceUid}.example.test/`,
            },
          },
        },
        sqlGuard: { sql: "SELECT 1", params: [] },
        async stillCurrent() {
          return fenceCurrent;
        },
        async readVersionMaterials() {
          return { bundle: null, assets: heldAssets };
        },
      } as V2WorkerPublicationResolution;
    },
  };
  return {
    source,
    setCurrent(operationId: string) {
      lastOperationId = operationId;
    },
    setFenceCurrent(value: boolean) {
      fenceCurrent = value;
    },
  };
}

function execution(
  workerResourceUid: string,
  operationId: string,
  action: V2Execution["action"],
  versionUid = `version-${operationId}`,
): V2Execution {
  return {
    operationId,
    leaseToken: `lease-${operationId}`,
    backendKey: `backend-${operationId}`,
    backendId: "fixture-worker-deployment-backend",
    targetKey: TARGET_KEY,
    resourceUid: `deployment-${workerResourceUid}`,
    principal: "org-runtime-owner",
    action,
    generation: action === "create" ? 1 : action === "update" ? 2 : 3,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "production",
    name: "static-runtime-owner",
    spec: {
      worker: { resourceUid: workerResourceUid },
      versions:
        action === "delete"
          ? [{ workerVersion: { resourceUid: "version-current" }, weight: 10_000 }]
          : [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
    },
    previousObserved: {},
    previousOutput: {},
  };
}

test("serialized owner state transitions rebase after a delayed durable write", async () => {
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstCommit = true;
  const writer = createSerializedWorkerdOwnerStateWriter(
    { incarnation: "active", admissionClosedBy: null as string | null },
    async (next) => {
      if (firstCommit) {
        firstCommit = false;
        announceFirst();
        await firstGate;
      }
      return next;
    },
  );
  const retiring = writer.transition((current) => ({ ...current, incarnation: "retiring" }));
  await firstStarted;
  const closing = writer.transition((current) => ({ ...current, admissionClosedBy: "delete-op" }));
  releaseFirst();
  await Promise.all([retiring, closing]);
  expect(writer.current()).toEqual({ incarnation: "retiring", admissionClosedBy: "delete-op" });
});

test("an ambiguous durable state commit poisons later writes instead of overwriting possible disk state", async () => {
  const initial = { incarnation: "active", admissionClosedBy: null as string | null };
  let possibleDiskState = initial;
  const writer = createSerializedWorkerdOwnerStateWriter(initial, async (next) => {
    possibleDiskState = next;
    throw new Error("directory fsync failed after rename");
  });
  await expect(
    writer.transition((current) => ({ ...current, admissionClosedBy: "delete-op" })),
  ).rejects.toThrow("directory fsync failed after rename");
  await expect(
    writer.transition((current) => ({ ...current, incarnation: "retired" })),
  ).rejects.toThrow("directory fsync failed after rename");
  expect(possibleDiskState).toEqual({ incarnation: "active", admissionClosedBy: "delete-op" });
  expect(writer.current()).toEqual(initial);
});

test("owner close waits for an in-flight start before releasing its UID lock", async () => {
  const owned = await fixture();
  const publication = staticPublicationState("worker-close-race");
  let releasePort!: (port: number) => void;
  let portRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    portRequested = resolve;
  });
  const deferredPort = new Promise<number>((resolve) => {
    releasePort = resolve;
  });
  const ownerOptions = {
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: "worker-close-race",
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: async () => {
      portRequested();
      return await deferredPort;
    },
    spawn: owned.spawn,
  };
  const owner = await openWorkerdWorkerRuntimeOwner(ownerOptions);
  const createId = "a0b4c792-f853-4964-85f4-7159e54b0ed1";
  try {
    const creating = owner.execute(execution("worker-close-race", createId, "create"));
    await requested;
    const closing = owner.close();
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    releasePort(await unusedPort());
    expect(await creating).toMatchObject({ kind: "confirmed" });
    await expect(closing).rejects.toMatchObject({ code: "ownership_uncertain" });
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });

    publication.setCurrent(createId);
    const deleteId = "2a67dd0d-66c9-4cda-a6bd-e7df68e0922c";
    expect(await owner.execute(execution("worker-close-race", deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    await owner.close();
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

test("the same accepted DELETE can retry retirement after the sealed config is restored", async () => {
  const owned = await fixture();
  const workerUid = "worker-retirement-retry";
  const publication = staticPublicationState(workerUid);
  const createId = "e4a08814-3879-4a79-ad1f-4dabce9ea0b3";
  const deleteId = "a5b1276e-4110-45e8-88ad-6c6f2db1430a";
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
  });
  const key = createHash("sha256").update(workerUid, "utf8").digest("hex");
  const configurationPath = join(
    owned.root,
    "owners",
    key,
    "incarnations",
    createId,
    "groups",
    key,
    "workers",
    "workerd.capnp",
  );
  try {
    expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(createId);
    const exactBytes = await Bun.file(configurationPath).arrayBuffer();
    await writeFile(configurationPath, "tampered after the sealed publication");
    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "unknown",
    });
    const child = owned.children[0];
    if (!child) throw new Error("retirement retry child missing");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    await writeFile(configurationPath, new Uint8Array(exactBytes), { mode: 0o600 });
    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    await until(() => child.exitCode !== null || child.signalCode !== null);
    expect(owned.children).toHaveLength(1);
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

test("one Worker update switches only its child, pins an open stream, and replays its exact operation", async () => {
  const owned = await fixture();
  const stateA = staticPublicationState("worker-a");
  const stateB = staticPublicationState("worker-b");
  const portsA = new Set<number>();
  const portsB = new Set<number>();
  const ownerA = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: "worker-a",
    targetKey: TARGET_KEY,
    publicationState: stateA.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: async () => {
      const port = await unusedPort();
      portsA.add(port);
      return port;
    },
    spawn: owned.spawn,
  });
  const ownerB = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: "worker-b",
    targetKey: TARGET_KEY,
    publicationState: stateB.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: async () => {
      const port = await unusedPort();
      portsB.add(port);
      return port;
    },
    spawn: owned.spawn,
  });

  const createA = "8dd887ae-47b3-4ee5-8c26-53a0d63cfc21";
  const createB = "d9961166-ce13-4b6c-b387-55d1392ed454";
  const updateA = "85dc7fd7-07f5-40da-8d2d-253e0eea18c3";
  const deleteA = "6f71ca2a-15a8-47cd-86b2-fc66b3d47df5";
  let oldReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(await ownerA.execute(execution("worker-a", createA, "create"))).toMatchObject({
      kind: "confirmed",
    });
    stateA.setCurrent(createA);
    expect(await ownerB.execute(execution("worker-b", createB, "create"))).toMatchObject({
      kind: "confirmed",
    });
    stateB.setCurrent(createB);
    expect(owned.children).toHaveLength(2);

    const oldResponse = await ownerA.fetch(new Request("https://worker-a.example.test/hold"));
    oldReader = oldResponse.body?.getReader();
    if (!oldReader) throw new Error("stream response body missing");
    const oldFirst = await oldReader.read();
    const oldIdentity = new TextDecoder().decode(oldFirst.value);
    const childAOld = owned.children[0];
    const childB = owned.children[1];
    if (!childAOld || !childB) throw new Error("initial Worker children missing");

    expect(await ownerA.execute(execution("worker-a", updateA, "update"))).toMatchObject({
      kind: "confirmed",
    });
    stateA.setCurrent(updateA);
    expect(owned.children).toHaveLength(3);
    expect(childAOld.exitCode).toBeNull();
    const newIdentity = await (
      await ownerA.fetch(new Request("https://worker-a.example.test/"))
    ).text();
    expect(newIdentity).not.toBe(oldIdentity);
    const identityBBefore = await (
      await ownerB.fetch(new Request("https://worker-b.example.test/"))
    ).text();
    const identityBAfter = await (
      await ownerB.fetch(new Request("https://worker-b.example.test/"))
    ).text();
    expect(identityBAfter).toBe(identityBBefore);
    expect(childB.exitCode).toBeNull();

    const replay = await ownerA.execute(execution("worker-a", updateA, "update"));
    expect(replay).toMatchObject({ kind: "confirmed" });
    expect(owned.children).toHaveLength(3);
    await oldReader.cancel();
    oldReader = undefined;
    await until(() => childAOld.exitCode !== null || childAOld.signalCode !== null);

    const deleteReader = (
      await ownerA.fetch(new Request("https://worker-a.example.test/hold"))
    ).body?.getReader();
    if (!deleteReader) throw new Error("DELETE stream response body missing");
    await deleteReader.read();
    stateA.setFenceCurrent(false);
    const unknownDelete = await ownerA.execute(execution("worker-a", deleteA, "delete"));
    expect(unknownDelete).toMatchObject({ kind: "unknown" });
    await expect(deleteReader.read()).rejects.toBeDefined();
    await until(() => childAOld.exitCode !== null || childAOld.signalCode !== null);
    const activeA = owned.children[2];
    if (!activeA) throw new Error("updated Worker child missing");
    await until(() => activeA.exitCode !== null || activeA.signalCode !== null);
    stateA.setFenceCurrent(true);
    const deleted = await ownerA.execute(execution("worker-a", deleteA, "delete"));
    expect(deleted).toMatchObject({ kind: "confirmed", identity: null });
    stateA.setCurrent(deleteA);
    await expect(
      ownerA.fetch(new Request("https://worker-a.example.test/late")),
    ).rejects.toMatchObject({
      code: "admission_closed",
    });
    expect(childB.exitCode).toBeNull();
    expect(
      await (await ownerB.fetch(new Request("https://worker-b.example.test/still-serving"))).text(),
    ).toBeTruthy();

    await ownerA.close();
    const replayOwner = await openWorkerdWorkerRuntimeOwner({
      rootDirectory: join(owned.root, "owners"),
      workerResourceUid: "worker-a",
      targetKey: TARGET_KEY,
      publicationState: stateA.source,
      workerdBinary: owned.binary,
      listenerPortForOperation: async () => await unusedPort(),
      spawn: owned.spawn,
    });
    expect(await replayOwner.execute(execution("worker-a", deleteA, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    expect(owned.children).toHaveLength(3);
    await replayOwner.close();
  } finally {
    await oldReader?.cancel().catch(() => undefined);
    await ownerA.close().catch(() => undefined);
    await ownerB
      .execute(execution("worker-b", "c7b001f1-2fe7-42a2-aa33-e6fd8c97bd5e", "delete"))
      .catch(() => undefined);
    await ownerB.close().catch(() => undefined);
    await owned.cleanup();
  }
});
