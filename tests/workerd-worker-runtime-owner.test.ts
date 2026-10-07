import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import type {
  WorkerModuleInspectionInput,
  WorkerModuleInspectionResult,
} from "../src/providers/worker-module-semantic-inspection.ts";
import type { SqlArtifactCustodyRead } from "../src/takoform-v2/forms/artifact-custody.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
  type WorkerBundleManifest,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import {
  inspectWorkerdWorkerExecutionCopies,
  releaseRetiredWorkerdWorkerExecutionCopies,
} from "../src/workerd-worker-execution-group.ts";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

async function heldCodeBundle(): Promise<SqlArtifactCustodyRead<WorkerBundleManifest>> {
  const manifestUrl = "https://artifacts.example.test/runtime/manifest.json";
  const moduleUrl = "https://artifacts.example.test/runtime/index.mjs";
  const moduleBytes = new TextEncoder().encode(
    "export default { fetch() { return new Response('ok'); } };\n",
  );
  const moduleSha256 = (await bytesDigest(moduleBytes)).slice("sha256:".length);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.mjs",
      files: [
        {
          path: "index.mjs",
          url: moduleUrl,
          sha256: moduleSha256,
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const manifest = parseWorkerBundleManifest(manifestBytes);
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
  const verified = await validateWorkerBundlePayload({
    spec: { artifact: { url: manifestUrl, sha256: manifestSha256 } },
    manifestBytes,
    fileBytes: [moduleBytes],
  });
  return {
    manifest,
    manifestBytes,
    files: [moduleBytes],
    observed: verified.observed as unknown as import("../src/ports.ts").JsonObject,
  };
}

function staticPublicationState(workerResourceUid: string, withCode = false) {
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
      const spec = withCode
        ? {
            worker: { resourceUid: workerResourceUid },
            bundle: { resourceUid: `code-${execution.operationId}` },
            handlers: ["fetch"],
            vars: { SETTINGS: { label: "owner fixture" } },
          }
        : {
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
          return {
            bundle: withCode ? await heldCodeBundle() : null,
            assets: withCode ? null : heldAssets,
          };
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

test("owner serving observation is exact and restart resumes interrupted copy cleanup", async () => {
  const owned = await fixture();
  const workerUid = "worker-copy-retirement";
  const createId = "b7b35f4f-48cb-4d43-b99d-f852c3308e1f";
  const deleteId = "20b516a8-e7e7-48bd-8f8e-5f527dfab06a";
  const versionUid = `version-${createId}`;
  const publication = staticPublicationState(workerUid);
  const ownerRoot = join(owned.root, "owners");
  const ownerOptions = {
    rootDirectory: ownerRoot,
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
  };
  const owner = await openWorkerdWorkerRuntimeOwner(ownerOptions);
  const workerKey = createHash("sha256").update(workerUid, "utf8").digest("hex");
  const script = `v2-worker-${workerKey}`;
  const groupRoot = join(ownerRoot, workerKey, "incarnations", createId, "groups", workerKey);
  const scriptCopy = join(groupRoot, "workers", script);
  const publicationsCopy = join(groupRoot, "workers", ".publications", script);
  const backup = join(owned.root, "retired-workers-backup");
  const statePath = join(ownerRoot, workerKey, "runtime-owner.json");
  try {
    expect(await owner.execute(execution(workerUid, createId, "create", versionUid))).toMatchObject(
      {
        kind: "confirmed",
      },
    );
    publication.setCurrent(createId);
    const debugCopies = await inspectWorkerdWorkerExecutionCopies({
      groupDirectory: groupRoot,
      workerResourceUid: workerUid,
      listenerPort: Number(
        (await Bun.file(join(groupRoot, "group.json")).text()).match(/"listenerPort":(\d+)/u)?.[1],
      ),
      scriptName: script,
    });
    expect(debugCopies.versionUids).toContain(versionUid);
    const serving = await owner.observeServing({
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
    });
    expect(serving).toMatchObject({
      kind: "serving",
      sourceOperationId: createId,
      generation: `takoserver-v2-operation:${createId}`,
      versions: [{ workerVersionUid: versionUid, weight: 10_000 }],
    });
    expect(
      await owner.observeServing({ workerResourceUid: "different-worker", targetKey: TARGET_KEY }),
    ).toEqual({
      kind: "unknown",
    });
    expect(
      await owner.observeRetirement({ workerVersionUid: "version-never-published" }),
    ).toMatchObject({
      kind: "confirmed_absent",
      workerResourceUid: workerUid,
      workerVersionUid: "version-never-published",
    });
    expect(await owner.observeRetirement({ workerVersionUid: versionUid })).toEqual({
      kind: "unknown",
    });
    expect(await owner.observeRetirement({})).toEqual({ kind: "unknown" });
    const generationKey = (await readdir(publicationsCopy))[0];
    if (!generationKey) throw new Error("weighted publication generation missing");
    const deploymentPath = join(publicationsCopy, generationKey, "deployment.json");
    const deployment = JSON.parse(await Bun.file(deploymentPath).text()) as {
      versions: Array<{
        storageKey: string;
        manifest: { assets: { files: Record<string, { key: string }> } };
      }>;
    };
    const version = deployment.versions[0];
    const asset = version && Object.values(version.manifest.assets.files)[0];
    if (!version || !asset) throw new Error("weighted asset manifest missing");
    const assetPath = join(
      publicationsCopy,
      generationKey,
      version.storageKey,
      "assets",
      asset.key,
    );
    const exactAsset = await Bun.file(assetPath).arrayBuffer();
    await writeFile(assetPath, "tampered execution asset");
    expect(
      await owner.observeServing({ workerResourceUid: workerUid, targetKey: TARGET_KEY }),
    ).toEqual({ kind: "unknown" });
    await writeFile(assetPath, new Uint8Array(exactAsset), { mode: 0o600 });
    const exactManifest = await Bun.file(deploymentPath).arrayBuffer();
    await writeFile(deploymentPath, "tampered deployment manifest");
    expect(
      await owner.observeServing({ workerResourceUid: workerUid, targetKey: TARGET_KEY }),
    ).toEqual({
      kind: "unknown",
    });
    await writeFile(deploymentPath, new Uint8Array(exactManifest), { mode: 0o600 });
    await cp(join(groupRoot, "workers"), backup, { recursive: true });
    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    await owner.close();

    const persisted = JSON.parse(await Bun.file(statePath).text()) as {
      deletionPublicationConfirmed: boolean;
      incarnations: Array<Record<string, unknown>>;
    };
    persisted.deletionPublicationConfirmed = false;
    for (const record of persisted.incarnations) {
      record.executionCopiesReleased = false;
      record.executionCopiesCleanupStarted = true;
    }
    const cleanupManifestSha256 = persisted.incarnations[0]?.executionCopiesCleanupManifestSha256;
    if (typeof cleanupManifestSha256 !== "string")
      throw new Error("cleanup inventory digest missing");
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    await cp(backup, join(groupRoot, "workers"), { recursive: true, force: true });

    const foreignRoot = join(owned.root, "foreign-copy-root");
    await mkdir(foreignRoot, { recursive: true });
    await Bun.write(join(foreignRoot, "untouched"), "foreign");
    await rm(scriptCopy, { recursive: true, force: true });
    await symlink(foreignRoot, scriptCopy);
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    expect(await Bun.file(join(foreignRoot, "untouched")).text()).toBe("foreign");
    await unlink(scriptCopy);
    await cp(join(backup, script), scriptCopy, { recursive: true });

    const groupManifest = JSON.parse(await Bun.file(join(groupRoot, "group.json")).text()) as {
      listenerPort: number;
    };
    await expect(
      releaseRetiredWorkerdWorkerExecutionCopies({
        groupDirectory: groupRoot,
        workerResourceUid: workerUid,
        operationId: deleteId,
        listenerPort: groupManifest.listenerPort,
        scriptName: script,
        cleanupIntentPersisted: true,
        cleanupManifestSha256,
        // Inject a recursive I/O interruption; this is not an OS-process-kill proof.
        afterEntryRemoved: () => {
          throw new Error("simulated process interruption during recursive removal");
        },
      }),
    ).rejects.toThrow();
    expect(await pathExists(scriptCopy)).toBe(false);
    expect(await pathExists(publicationsCopy)).toBe(false);
    expect(await pathExists(join(groupRoot, ".retired-execution-copies", deleteId, "direct"))).toBe(
      true,
    );
    expect(
      await pathExists(join(groupRoot, ".retired-execution-copies", deleteId, "publications")),
    ).toBe(true);
    const cleanupPublications = join(
      groupRoot,
      ".retired-execution-copies",
      deleteId,
      "publications",
    );
    const cleanupGeneration = (await readdir(cleanupPublications))[0];
    if (!cleanupGeneration) throw new Error("quarantined publication missing");
    const cleanupManifest = join(cleanupPublications, cleanupGeneration, "deployment.json");
    const expectedCleanupManifest = await Bun.file(
      join(backup, ".publications", script, cleanupGeneration, "deployment.json"),
    ).arrayBuffer();
    await writeFile(cleanupManifest, "tampered quarantined manifest");
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    expect(await Bun.file(cleanupManifest).text()).toBe("tampered quarantined manifest");
    await writeFile(cleanupManifest, new Uint8Array(expectedCleanupManifest), { mode: 0o600 });
    const cleanupDirect = join(groupRoot, ".retired-execution-copies", deleteId, "direct");
    await symlink(foreignRoot, join(cleanupDirect, "foreign-link"));
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    expect(await Bun.file(join(foreignRoot, "untouched")).text()).toBe("foreign");
    await unlink(join(cleanupDirect, "foreign-link"));
    const interruptedState = JSON.parse(await Bun.file(statePath).text()) as {
      incarnations: Array<{
        executionCopiesReleased: boolean;
        executionCopiesCleanupStarted: boolean;
      }>;
    };
    expect(
      interruptedState.incarnations.every(
        (record) => !record.executionCopiesReleased && record.executionCopiesCleanupStarted,
      ),
    ).toBe(true);

    const reopened = await openWorkerdWorkerRuntimeOwner(ownerOptions);
    try {
      expect(await pathExists(scriptCopy)).toBe(false);
      expect(await pathExists(publicationsCopy)).toBe(false);
      expect(await reopened.observeRetirement({ workerVersionUid: versionUid })).toMatchObject({
        kind: "confirmed_absent",
        workerResourceUid: workerUid,
        targetKey: TARGET_KEY,
        workerVersionUid: versionUid,
        incarnationOperationIds: [createId],
      });
      expect(await reopened.observeRetirement({})).toMatchObject({
        kind: "confirmed_absent",
        workerResourceUid: workerUid,
        targetKey: TARGET_KEY,
        incarnationOperationIds: [createId],
      });
      expect(await reopened.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
        kind: "confirmed",
        identity: null,
      });
      const finalState = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<{
          executionCopiesReleased: boolean;
          executionCopiesCleanupStarted: boolean;
        }>;
      };
      expect(finalState.schema).toBe("takoserver.v2-worker-runtime-owner@4");
      expect(
        finalState.incarnations.every(
          (record) => record.executionCopiesReleased && record.executionCopiesCleanupStarted,
        ),
      ).toBe(true);
      expect(owned.children).toHaveLength(1);
      await reopened.close();

      await cp(backup, join(groupRoot, "workers"), { recursive: true, force: true });
      expect(await pathExists(scriptCopy)).toBe(true);
      await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
        code: "ownership_uncertain",
      });
      expect(await pathExists(scriptCopy)).toBe(true);
      await rm(scriptCopy, { recursive: true, force: true });
      await rm(publicationsCopy, { recursive: true, force: true });

      const previousV2 = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<Record<string, unknown>>;
      };
      previousV2.schema = "takoserver.v2-worker-runtime-owner@2";
      for (const record of previousV2.incarnations) {
        delete record.executionCopiesReleased;
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
      }
      await rm(join(groupRoot, ".retired-execution-copies"), { recursive: true, force: true });
      await writeFile(statePath, `${JSON.stringify(previousV2)}\n`, { mode: 0o600 });
      const migratedV2 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV2.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@4",
      );

      const previousV3 = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<Record<string, unknown>>;
      };
      previousV3.schema = "takoserver.v2-worker-runtime-owner@3";
      for (const record of previousV3.incarnations) {
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
      }
      await rm(join(groupRoot, ".retired-execution-copies"), { recursive: true, force: true });
      await writeFile(statePath, `${JSON.stringify(previousV3)}\n`, { mode: 0o600 });
      const migratedV3 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV3.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@3",
      );

      const previousV1 = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<Record<string, unknown>>;
      };
      previousV1.schema = "takoserver.v2-worker-runtime-owner@1";
      for (const record of previousV1.incarnations) {
        delete record.executionCopiesReleased;
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
        delete record.deferRetirementUntilDeadline;
      }
      await writeFile(statePath, `${JSON.stringify(previousV1)}\n`, { mode: 0o600 });
      const migratedV1 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV1.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@4",
      );
      expect(owned.children).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

test("code incarnation retirement waits for its persisted grace deadline after response completion", async () => {
  const owned = await fixture();
  const workerUid = "worker-code-grace";
  const publication = staticPublicationState(workerUid, true);
  const createId = "c06561c1-f4b3-4dcc-9aca-dfc7cfb80c71";
  const updateId = "1fc775ab-3b7b-4a6d-93f1-1232fdbca648";
  const deleteId = "e7b5b5c5-bd5e-4cec-aa14-6d6a8557815b";
  let scheduled: { run: () => void; delayMs: number } | undefined;
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
    inspectModule: async (
      _input: WorkerModuleInspectionInput,
    ): Promise<WorkerModuleInspectionResult> => ({
      outcome: "valid",
      exportedHandlers: ["fetch"],
    }),
    scheduleRetirement(run, delayMs) {
      scheduled = { run, delayMs };
      return () => {
        scheduled = undefined;
      };
    },
  });
  try {
    expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
      kind: "confirmed",
      deferRetirementUntilDeadline: true,
    });
    publication.setCurrent(createId);
    const oldChild = owned.children[0];
    if (!oldChild) throw new Error("initial code Worker child missing");

    expect(
      await (await owner.fetch(new Request(`https://${workerUid}.example.test/`))).text(),
    ).toBeTruthy();
    expect(await owner.execute(execution(workerUid, updateId, "update"))).toMatchObject({
      kind: "confirmed",
      deferRetirementUntilDeadline: true,
    });
    publication.setCurrent(updateId);

    expect(oldChild.exitCode).toBeNull();
    expect(oldChild.signalCode).toBeNull();
    expect(scheduled?.delayMs).toBeGreaterThan(899_000);
    expect(scheduled?.delayMs).toBeLessThanOrEqual(900_000);
    const deadlineRetirement = scheduled?.run;
    if (!deadlineRetirement) throw new Error("code retirement deadline was not scheduled");
    deadlineRetirement();
    await until(() => oldChild.exitCode !== null || oldChild.signalCode !== null);

    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    publication.setCurrent(deleteId);
    await owner.close();
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});
