import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import {
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import {
  linuxProcessLiveness,
  spawnWorkerdWithParentDeath,
  workerPortOwnership,
} from "../src/workerd-linux-process.ts";
import { openWorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const WORKER_UID = "worker-graceful-suspend";
const OPERATION_ID = "a5323426-8e22-4b4c-a362-f34ae3525f76";
const TARGET_KEY = "fixture-worker-graceful-suspend";
type StoredState = {
  suspended: boolean;
  incarnations: Array<{
    status: string;
    processIdentity: Parameters<typeof linuxProcessLiveness>[0];
  }>;
  physicalAbsences: Array<{ incarnationId: string; receiptDigest: string }>;
};

function physicalId(
  operationId: string,
  identity: Parameters<typeof linuxProcessLiveness>[0],
): string {
  const bytes = createHash("sha256")
    .update("takoserver.v2-worker-physical-incarnation@1\0")
    .update(
      JSON.stringify([
        operationId,
        identity.pid,
        identity.bootId,
        identity.pidNamespace,
        identity.startTimeTicks,
      ]),
    )
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const CHILD_SOURCE = `
import { readFileSync } from "node:fs";
const [verb, watch, path] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !path) throw new Error("bad command");
function current() {
  const config = readFileSync(path, "utf8");
  const port = /address = "\\*:(\\d+)"/u.exec(config)?.[1];
  const identity = /\\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  const token = /\\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  if (!port || !identity || !token) throw new Error("bad config");
  return { port: Number(port), identity, token };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: current().port, fetch(request) {
  const state = current();
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      new URL(request.url).pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === state.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": state.identity } });
  }
  return new Response(state.identity);
} });
process.on("SIGTERM", () => server.stop(true));
`;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test("graceful suspend retains one graph, releases the lock only after old PID absence, and reopens with a new physical Queue identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-owner-suspend-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
  await writeFile(binary, `#!${process.execPath}\n${CHILD_SOURCE}`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const port = await unusedPort();
  const asset = new TextEncoder().encode("suspend fixture asset");
  const assetSha256 = (await bytesDigest(asset)).slice(7);
  const manifest = {
    files: [
      {
        path: "index.html",
        url: "https://artifacts.example.test/index.html",
        sha256: assetSha256,
        mediaType: "text/html",
      },
    ],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
  const specInput = {
    worker: { resourceUid: WORKER_UID },
    versions: [{ workerVersion: { resourceUid: "version-suspend" }, weight: 10_000 }],
  };
  const spec = parseWorkerDeploymentSpec(specInput);
  const versionSpec = parseWorkerVersionSpec({
    worker: { resourceUid: WORKER_UID },
    handlers: [],
    assets: {
      bundle: { resourceUid: "assets-suspend" },
      runWorkerFirst: false,
      notFoundHandling: "none",
    },
  });
  const execution: V2Execution = {
    operationId: OPERATION_ID,
    leaseToken: `lease-${OPERATION_ID}`,
    backendKey: `backend-${OPERATION_ID}`,
    backendId: "fixture-worker-deployment-backend",
    targetKey: TARGET_KEY,
    resourceUid: "deployment-suspend",
    principal: "org-suspend",
    action: "create",
    generation: 1,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "production",
    name: "suspend",
    spec: specInput,
    previousObserved: {},
    previousOutput: {},
  };
  const snapshot = {
    sourceOperationId: OPERATION_ID,
    worker: { uid: WORKER_UID, principal: "org-suspend", space: "production", generation: 1 },
    deployment: {
      uid: "deployment-suspend",
      generation: 1,
      spec,
      versions: [
        {
          uid: "version-suspend",
          generation: 1,
          weight: 10_000,
          spec: versionSpec,
        },
      ],
    },
    endpoint: {
      uid: "endpoint-suspend",
      generation: 1,
      spec: { worker: { resourceUid: WORKER_UID } },
      output: { hostname: "suspend.example.test", url: "https://suspend.example.test/" },
    },
  };
  const resolution = {
    kind: "ready" as const,
    snapshot,
    sqlGuard: { sql: "SELECT 1", params: [] },
    async stillCurrent() {
      return true;
    },
    async readVersionMaterials() {
      return {
        bundle: null,
        assets: {
          manifest,
          manifestBytes,
          files: [asset],
          observed: {
            manifestSha256,
            fileCount: 1,
            totalBytes: asset.byteLength,
            files: [
              {
                path: "index.html",
                sha256: assetSha256,
                mediaType: "text/html",
                byteSize: asset.byteLength,
              },
            ],
          },
        },
      };
    },
  } as V2WorkerPublicationResolution;
  const options = {
    rootDirectory: join(root, "owners"),
    workerResourceUid: WORKER_UID,
    targetKey: TARGET_KEY,
    publicationState: {
      async resolve() {
        return resolution;
      },
      async resolveCurrentServing(input: {
        sourceOperationId: string;
        expectedIdentity: { generation: string };
      }) {
        return input.sourceOperationId === OPERATION_ID &&
          input.expectedIdentity.generation === `takoserver-v2-operation:${OPERATION_ID}`
          ? resolution
          : { kind: "unresolved" as const, code: "stale", message: "fixture graph changed" };
      },
    },
    workerdBinary: binary,
    listenerPortForOperation: async () => port,
    spawn(command: readonly string[]) {
      const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
      children.push(child);
      return child;
    },
  };
  const statePath = join(
    root,
    "owners",
    createHash("sha256").update(WORKER_UID).digest("hex"),
    "runtime-owner.json",
  );
  let owner = await openWorkerdWorkerRuntimeOwner(options);
  try {
    expect(await owner.execute(execution)).toMatchObject({ kind: "confirmed" });
    await expect(openWorkerdWorkerRuntimeOwner(options)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    const before = JSON.parse(await readFile(statePath, "utf8")) as StoredState;
    const oldRecord = before.incarnations[0];
    if (!oldRecord) throw new Error("active record missing");
    const oldProcess = oldRecord.processIdentity;
    const oldIdentity = await (
      await owner.fetch(new Request("https://suspend.example.test/"))
    ).text();
    await expect(owner.close()).rejects.toMatchObject({ code: "ownership_uncertain" });
    await owner.suspend();
    expect(await linuxProcessLiveness(oldProcess)).toBe("stale");
    expect(await workerPortOwnership(port, undefined)).toBe("vacant");
    const suspendedBytes = await readFile(statePath, "utf8");
    const suspended = JSON.parse(suspendedBytes) as StoredState;
    const suspendedRecord = suspended.incarnations[0];
    const absence = suspended.physicalAbsences[0];
    if (!suspendedRecord || !absence) throw new Error("suspend evidence missing");
    expect(suspended.suspended).toBe(true);
    expect(suspendedRecord.status).toBe("active");
    expect(suspended.physicalAbsences).toHaveLength(1);
    const tampered = structuredClone(suspended);
    const tamperedAbsence = tampered.physicalAbsences[0];
    if (!tamperedAbsence) throw new Error("tamper target missing");
    tamperedAbsence.receiptDigest = "0".repeat(64);
    await writeFile(statePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await expect(openWorkerdWorkerRuntimeOwner(options)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    await writeFile(statePath, suspendedBytes, { mode: 0o600 });
    owner = await openWorkerdWorkerRuntimeOwner(options);
    const after = JSON.parse(await readFile(statePath, "utf8")) as StoredState;
    const afterRecord = after.incarnations[0];
    if (!afterRecord) throw new Error("restored active record missing");
    expect(after.suspended).toBe(false);
    expect(afterRecord.processIdentity.pid).not.toBe(oldProcess.pid);
    expect(await (await owner.fetch(new Request("https://suspend.example.test/"))).text()).toBe(
      oldIdentity,
    );
    const versionId = `v2-${createHash("sha256")
      .update("version-suspend\0" + "1")
      .digest("hex")}`;
    const queueTarget = {
      workerUid: WORKER_UID,
      versionId,
      servingSourceOperationId: OPERATION_ID,
    };
    expect(
      await owner.observeQueueTarget({
        ...queueTarget,
        incarnationId: absence.incarnationId,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await owner.observeQueueTarget({
        ...queueTarget,
        incarnationId: physicalId(OPERATION_ID, afterRecord.processIdentity),
      }),
    ).toMatchObject({ kind: "confirmed", status: "active" });
    expect(
      await owner.observeQueuePhysicalAbsence({
        workerUid: WORKER_UID,
        incarnationId: absence.incarnationId,
        servingSourceOperationId: OPERATION_ID,
      }),
    ).toMatchObject({ kind: "confirmed_absent", receiptDigest: absence.receiptDigest });
    expect(
      await owner.observeQueuePhysicalAbsence({
        workerUid: WORKER_UID,
        incarnationId: OPERATION_ID,
        servingSourceOperationId: OPERATION_ID,
      }),
    ).toEqual({ kind: "unknown" });
    await owner.suspend();
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
});
