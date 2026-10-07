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
import {
  linuxProcessLiveness,
  spawnWorkerdWithParentDeath,
  workerPortOwnership,
} from "../src/workerd-linux-process.ts";
import type { WorkerdPublicationIdentity } from "../src/workerd-runtime.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import { openWorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-queue-target-owner";
const WORKER_UID = "worker-queue-target";
const CREATE_ID = "0f2e9831-691d-41d8-b5ce-983e052a14c3";
const UPDATE_ID = "6cb38324-f2ad-4acc-acd8-b314e891dc54";
const DELETE_ID = "84ed6745-0688-4201-8372-0c26ddcce0f4";

// A real child/listener and exact on-disk publication, but no tenant handler execution.
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
const server = Bun.serve({ hostname: "127.0.0.1", port: initial.port, async fetch(request) {
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
      start(controller) {
        controller.enqueue(new TextEncoder().encode(current.generation));
        timer = setInterval(() => controller.enqueue(new Uint8Array([46])), 20);
      },
      cancel() { clearInterval(timer); },
    }));
  }
  return new Response(current.generation);
} });
process.on("SIGTERM", () => server.stop(true));
process.on("SIGUSR1", () => { server.stop(true); setInterval(() => {}, 1000); });
`;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

function execution(operationId: string, action: V2Execution["action"]): V2Execution {
  return {
    operationId,
    leaseToken: `lease-${operationId}`,
    backendKey: `backend-${operationId}`,
    backendId: "fixture-deployment-backend",
    targetKey: TARGET_KEY,
    resourceUid: `deployment-${WORKER_UID}`,
    principal: "org-queue-owner",
    action,
    generation: action === "create" ? 1 : action === "update" ? 2 : 3,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "production",
    name: "queue-target-owner",
    spec: {
      worker: { resourceUid: WORKER_UID },
      versions: [{ workerVersion: { resourceUid: `version-${operationId}` }, weight: 10_000 }],
    },
    previousObserved: {},
    previousOutput: {},
  };
}

function publicationState() {
  let incumbentId: string | undefined;
  let lastExecution: V2Execution | null = null;
  let current = true;
  const assetBytes = new TextEncoder().encode("queue-owner-publication");
  const source = {
    async resolve({
      execution: candidate,
      incumbentSourceOperationId,
    }: {
      execution: V2Execution;
      incumbentSourceOperationId?: string;
    }): Promise<V2WorkerPublicationResolution> {
      if (incumbentSourceOperationId !== undefined && incumbentSourceOperationId !== incumbentId) {
        return { kind: "unresolved", code: "incumbent_unresolved", message: "incumbent changed" };
      }
      lastExecution = candidate;
      const deploymentSpec = parseWorkerDeploymentSpec(candidate.spec);
      const versionUid = deploymentSpec.versions[0]?.workerVersion.resourceUid;
      if (!versionUid) throw new Error("fixture Version missing");
      const hash = (await bytesDigest(assetBytes)).slice("sha256:".length);
      const manifest = {
        files: [
          {
            path: "index.html",
            url: "https://artifacts.example.test/index.html",
            sha256: hash,
            mediaType: "text/html",
          },
        ],
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
      return {
        kind: "ready",
        snapshot: {
          sourceOperationId: candidate.operationId,
          worker: {
            uid: WORKER_UID,
            principal: candidate.principal,
            space: candidate.space,
            generation: 1,
          },
          deployment:
            candidate.action === "delete"
              ? null
              : {
                  uid: candidate.resourceUid,
                  generation: candidate.generation,
                  spec: deploymentSpec,
                  versions: [
                    {
                      uid: versionUid,
                      generation: candidate.generation,
                      weight: 10_000,
                      spec: {
                        worker: { resourceUid: WORKER_UID },
                        handlers: [],
                        assets: {
                          bundle: { resourceUid: `assets-${candidate.operationId}` },
                          runWorkerFirst: false,
                          notFoundHandling: "none",
                        },
                      },
                    },
                  ],
                },
          endpoint: {
            uid: `endpoint-${WORKER_UID}`,
            generation: 1,
            spec: { worker: { resourceUid: WORKER_UID } },
            output: {
              hostname: `${WORKER_UID}.example.test`,
              url: `https://${WORKER_UID}.example.test/`,
            },
          },
        },
        sqlGuard: { sql: "SELECT 1", params: [] },
        async stillCurrent() {
          return current;
        },
        async readVersionMaterials() {
          return {
            bundle: null,
            assets: {
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
                    sha256: hash,
                    mediaType: "text/html",
                    byteSize: assetBytes.byteLength,
                  },
                ],
              },
            },
          };
        },
      } as V2WorkerPublicationResolution;
    },
    async resolveCurrentServing(input: {
      workerUid: string;
      targetKey: string;
      sourceOperationId: string;
      expectedIdentity: WorkerdPublicationIdentity;
    }) {
      if (
        !lastExecution ||
        input.workerUid !== WORKER_UID ||
        input.targetKey !== TARGET_KEY ||
        input.sourceOperationId !== lastExecution.operationId ||
        input.expectedIdentity.generation !==
          `takoserver-v2-operation:${input.sourceOperationId}` ||
        !current
      ) {
        return { kind: "unresolved" as const, code: "stale", message: "current graph changed" };
      }
      return await source.resolve({ execution: lastExecution });
    },
  };
  return {
    source,
    setCurrent(operationId: string) {
      incumbentId = operationId;
    },
    setFence(value: boolean) {
      current = value;
    },
  };
}

test("Queue target observation confirms only the exact live active or draining native incarnation", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-queue-owner-target-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
  const publication = publicationState();
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(root, "owners"),
    workerResourceUid: WORKER_UID,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: binary,
    listenerPortForOperation: unusedPort,
    spawn(command): WorkerdProcess {
      const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
      children.push(child);
      return child;
    },
  });
  let heldReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(await owner.execute(execution(CREATE_ID, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(CREATE_ID);
    const oldTarget = {
      workerUid: WORKER_UID,
      versionId: `version-${CREATE_ID}`,
      incarnationId: CREATE_ID,
      servingSourceOperationId: CREATE_ID,
    };
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({
      kind: "confirmed",
      ...oldTarget,
      status: "active",
    });
    const mutableTarget = { ...oldTarget };
    const capturedObservation = owner.observeQueueTarget(mutableTarget);
    mutableTarget.versionId = "version-not-selected";
    expect(await capturedObservation).toEqual({
      kind: "confirmed",
      ...oldTarget,
      status: "active",
    });
    expect(await owner.observeQueueTarget({ ...oldTarget, workerUid: "other-worker" })).toEqual({
      kind: "unknown",
    });
    expect(
      await owner.observeQueueTarget({ ...oldTarget, versionId: "version-not-selected" }),
    ).toEqual({ kind: "unknown" });
    expect(
      await owner.observeQueueTarget({ ...oldTarget, servingSourceOperationId: UPDATE_ID }),
    ).toEqual({ kind: "unknown" });
    const workerKey = createHash("sha256").update(WORKER_UID).digest("hex");
    const configPath = join(
      root,
      "owners",
      workerKey,
      "incarnations",
      CREATE_ID,
      "groups",
      workerKey,
      "workers",
      "workerd.capnp",
    );
    const originalConfig = new Uint8Array(await Bun.file(configPath).arrayBuffer());
    await writeFile(configPath, "tampered native configuration");
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({ kind: "unknown" });
    await writeFile(configPath, originalConfig, { mode: 0o600 });
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({
      kind: "confirmed",
      ...oldTarget,
      status: "active",
    });
    // Owner observation alone never authorizes a Queue receipt; Core must
    // reject a stale SQL serving/lease fence independently.
    publication.setFence(false);
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({
      kind: "confirmed",
      ...oldTarget,
      status: "active",
    });
    publication.setFence(true);
    heldReader = (
      await owner.fetch(new Request(`https://${WORKER_UID}.example.test/hold`))
    ).body?.getReader();
    if (!heldReader) throw new Error("held response missing");
    await heldReader.read();
    expect(await owner.execute(execution(UPDATE_ID, "update"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(UPDATE_ID);
    const newTarget = {
      workerUid: WORKER_UID,
      versionId: `version-${UPDATE_ID}`,
      incarnationId: UPDATE_ID,
      servingSourceOperationId: UPDATE_ID,
    };
    expect(await owner.observeQueueTarget(newTarget)).toEqual({
      kind: "confirmed",
      ...newTarget,
      status: "active",
    });
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({
      kind: "confirmed",
      ...oldTarget,
      status: "draining",
    });
    await heldReader.cancel();
    heldReader = undefined;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await owner.observeQueueTarget(oldTarget)).kind !== "unknown")
      await Bun.sleep(20);
    expect(await owner.observeQueueTarget(oldTarget)).toEqual({ kind: "unknown" });
    expect(await owner.execute(execution(DELETE_ID, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    expect(await owner.observeQueueTarget(newTarget)).toEqual({ kind: "unknown" });
  } finally {
    await heldReader?.cancel().catch(() => undefined);
    await owner.close().catch(() => undefined);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
});

test("Queue target observation refuses a live child that lost its listener and a stale child birth", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-queue-owner-port-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const publication = publicationState();
  let listenerPort = 0;
  let child: ReturnType<typeof spawnWorkerdWithParentDeath> | undefined;
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(root, "owners"),
    workerResourceUid: WORKER_UID,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: binary,
    async listenerPortForOperation() {
      listenerPort = await unusedPort();
      return listenerPort;
    },
    spawn(command): WorkerdProcess {
      child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
      return child;
    },
  });
  try {
    expect(await owner.execute(execution(CREATE_ID, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(CREATE_ID);
    const target = {
      workerUid: WORKER_UID,
      versionId: `version-${CREATE_ID}`,
      incarnationId: CREATE_ID,
      servingSourceOperationId: CREATE_ID,
    };
    expect(await owner.observeQueueTarget(target)).toMatchObject({
      kind: "confirmed",
      status: "active",
    });
    if (!child?.pid) throw new Error("native child PID missing");
    const workerKey = createHash("sha256").update(WORKER_UID).digest("hex");
    const state = JSON.parse(
      await Bun.file(join(root, "owners", workerKey, "runtime-owner.json")).text(),
    ) as {
      incarnations: Array<{ processIdentity: Parameters<typeof linuxProcessLiveness>[0] }>;
    };
    const identity = state.incarnations[0]?.processIdentity;
    if (!identity) throw new Error("persisted child birth identity missing");
    child.kill("SIGUSR1");
    const deadline = Date.now() + 3_000;
    while (
      Date.now() < deadline &&
      (await workerPortOwnership(listenerPort, child.pid)) !== "vacant"
    )
      await Bun.sleep(20);
    expect(await linuxProcessLiveness(identity)).toBe("live");
    expect(await workerPortOwnership(listenerPort, child.pid)).toBe("vacant");
    expect(await owner.observeQueueTarget(target)).toEqual({ kind: "unknown" });
    child.kill("SIGKILL");
    await child.exited;
    expect(await linuxProcessLiveness(identity)).toBe("stale");
    expect(await owner.observeQueueTarget(target)).toEqual({ kind: "unknown" });
  } finally {
    await owner.close().catch(() => undefined);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
