import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesDigest, canonicalJson } from "../../src/json.ts";
import {
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../../src/takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "../../src/takoform-v2/worker-publication-state.ts";
import { spawnWorkerdWithParentDeath } from "../../src/workerd-linux-process.ts";
import {
  type OpenWorkerdWorkerRuntimeOwnerOptions,
  openWorkerdWorkerRuntimeOwner,
} from "../../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-worker-runtime-owner-crash";
const [
  mode,
  rootDirectory,
  workerResourceUid,
  workerdBinary,
  portText,
  createId,
  updateId,
  deleteId,
] = process.argv.slice(2);
if (!mode || !rootDirectory || !workerResourceUid || !workerdBinary || !portText || !deleteId)
  throw new Error("fixture arguments missing");
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid port");
async function sparePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserve"),
  });
  const selected = Number(server.port);
  await server.stop(true);
  return selected;
}
const operationUid = createId ?? "";
const servingPath = join(rootDirectory, "current-serving.json");
type CurrentServing = {
  sourceOperationId: string;
  identity: {
    generation: string;
    workerResourceUid: string;
    hostnames: string[];
    versions: { workerVersionUid: string; weight: number }[];
  };
  configIdentity: string;
  spec: unknown;
};
async function readCurrentServing(): Promise<CurrentServing | null> {
  const text = await readFile(servingPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : (JSON.parse(text) as CurrentServing);
}
let lastOperationId: string | undefined;
const assetBytes = new TextEncoder().encode("crash-reopen fixture asset");
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

const publicationState: OpenWorkerdWorkerRuntimeOwnerOptions["publicationState"] = {
  async resolve({ execution, incumbentSourceOperationId }) {
    if (
      execution.action === "delete" &&
      incumbentSourceOperationId !== undefined &&
      incumbentSourceOperationId !==
        ((await readCurrentServing())?.sourceOperationId ?? lastOperationId)
    ) {
      return {
        kind: "unresolved",
        code: "incumbent_unresolved",
        message: "fixture incumbent mismatch",
      };
    }
    const parsedSpec = parseWorkerDeploymentSpec(execution.spec);
    const versionUid = parsedSpec.versions[0]?.workerVersion.resourceUid;
    if (!versionUid && execution.action !== "delete") throw new Error("fixture version missing");
    const deployment =
      execution.action === "delete"
        ? null
        : {
            uid: `deployment-${workerResourceUid}`,
            generation: execution.generation,
            spec: parsedSpec,
            versions: [
              {
                uid: versionUid as string,
                generation: execution.generation,
                weight: 10_000,
                spec: {
                  worker: { resourceUid: workerResourceUid },
                  handlers: [],
                  assets: {
                    bundle: { resourceUid: `assets-${operationUid}` },
                    runWorkerFirst: false,
                    notFoundHandling: "none",
                  },
                } as never,
              },
            ],
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
        deployment,
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
        return true;
      },
      async readVersionMaterials() {
        return { bundle: null, assets: heldAssets };
      },
    } as V2WorkerPublicationResolution;
  },
  async resolveCurrentServing(input) {
    const current = await readCurrentServing();
    if (
      !current ||
      current.sourceOperationId !== input.sourceOperationId ||
      canonicalJson(current.identity) !== canonicalJson(input.expectedIdentity)
    ) {
      return {
        kind: "unresolved",
        code: "fixture_source_mismatch",
        message: "fixture source changed",
      };
    }
    const parsedSpec = parseWorkerDeploymentSpec(current.spec);
    const snapshot = {
      sourceOperationId: current.sourceOperationId,
      worker: {
        uid: workerResourceUid,
        principal: "org-runtime-owner",
        space: "production",
        generation: 1,
      },
      deployment: {
        uid: `deployment-${workerResourceUid}`,
        generation: 1,
        spec: parsedSpec,
        versions: current.identity.versions.map(({ workerVersionUid, weight }) => ({
          uid: workerVersionUid,
          generation: 1,
          weight,
          spec: {
            worker: { resourceUid: workerResourceUid },
            handlers: [],
            assets: {
              bundle: { resourceUid: `assets-${operationUid}` },
              runWorkerFirst: false,
              notFoundHandling: "none",
            },
          } as never,
        })),
      },
      endpoint: {
        uid: `endpoint-${workerResourceUid}`,
        generation: 1,
        spec: { worker: { resourceUid: workerResourceUid } },
        output: {
          hostname: current.identity.hostnames[0] ?? "",
          url: `https://${current.identity.hostnames[0] ?? ""}/`,
        },
      },
    };
    const stillCurrent = async () => {
      const reread = await readCurrentServing();
      return canonicalJson(reread) === canonicalJson(current);
    };
    return {
      kind: "ready" as const,
      snapshot,
      stillCurrent,
    };
  },
};

function execution(operationId: string, action: V2Execution["action"]): V2Execution {
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
    name: "crash-reopen-fixture",
    spec: {
      worker: { resourceUid: workerResourceUid as string },
      versions: [{ workerVersion: { resourceUid: `version-${operationId}` }, weight: 10_000 }],
    },
    previousObserved: {},
    previousOutput: {},
  };
}

let owner: Awaited<ReturnType<typeof openWorkerdWorkerRuntimeOwner>> | undefined;
let phase = "open-owner";
try {
  owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory,
    workerResourceUid,
    targetKey: TARGET_KEY,
    publicationState,
    workerdBinary,
    listenerPortForOperation: async (operationId) =>
      operationId === createId ? port : await sparePort(),
    spawn: (command) =>
      spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }),
  });
  phase = "owner-opened";
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "fixture_failed";
  const detail = error instanceof Error ? error.message : "non-error rejection";
  process.stdout.write(
    `${JSON.stringify({ kind: "error", code, detail, phase, pid: process.pid, port })}\n`,
  );
  process.exitCode = 2;
}

if (owner)
  try {
    if (mode === "retire" || mode === "empty-delete" || mode === "active-create") {
      if (mode === "retire") {
        if (!createId) throw new Error("create operation ID missing");
        const created = await owner.execute(execution(createId, "create"));
        if (created.kind !== "confirmed")
          throw new Error(`fixture create was not confirmed: ${JSON.stringify(created)}`);
        lastOperationId = createId;
      }
      if (mode === "active-create") {
        if (!createId) throw new Error("create operation ID missing");
        const created = await owner.execute(execution(createId, "create"));
        if (created.kind !== "confirmed" || created.identity === null)
          throw new Error(`fixture create was not confirmed: ${JSON.stringify(created)}`);
        const initialResponse = await owner.fetch(new Request("http://worker.fixture.test/"));
        const configIdentity = await initialResponse.text();
        await writeFile(
          servingPath,
          canonicalJson({
            sourceOperationId: createId,
            identity: created.identity,
            configIdentity,
            spec: execution(createId, "create").spec,
          }),
          { mode: 0o600 },
        );
      }
      if (mode !== "active-create") {
        const deleted = await owner.execute(execution(deleteId, "delete"));
        if (deleted.kind !== "confirmed" || deleted.identity !== null)
          throw new Error("fixture delete was not confirmed");
      }
      process.stdout.write(
        `${JSON.stringify({ kind: mode === "retire" ? "retired" : mode === "active-create" ? "active-created" : "empty-retired", pid: process.pid, port })}\n`,
      );
    } else if (mode === "active-recover") {
      phase = "recover-fetch";
      const current = await readCurrentServing();
      if (!current) throw new Error("current serving fixture missing");
      const response = await owner.fetch(new Request("http://worker.fixture.test/"));
      const body = await response.text();
      if (body !== current.configIdentity) throw new Error(`recovered fetch mismatch: ${body}`);
      if (!updateId) throw new Error("update operation ID missing");
      phase = "recover-update";
      const updated = await owner.execute(execution(updateId, "update"));
      if (updated.kind !== "confirmed" || updated.identity === null)
        throw new Error(`fixture update was not confirmed: ${JSON.stringify(updated)}`);
      await writeFile(
        servingPath,
        canonicalJson({
          sourceOperationId: updateId,
          identity: updated.identity,
          configIdentity: body,
          spec: execution(updateId, "update").spec,
        }),
        { mode: 0o600 },
      );
      if (!deleteId) throw new Error("delete operation ID missing");
      phase = "recover-delete";
      const deleted = await owner.execute(execution(deleteId, "delete"));
      if (deleted.kind !== "confirmed" || deleted.identity !== null)
        throw new Error("fixture delete was not confirmed");
      process.stdout.write(
        `${JSON.stringify({ kind: "recovered-updated-deleted", body, pid: process.pid, port })}\n`,
      );
    } else if (mode === "replay") {
      const replayed = await owner.execute(execution(deleteId, "delete"));
      if (replayed.kind !== "confirmed" || replayed.identity !== null)
        throw new Error("fixture DELETE replay was not confirmed");
      process.stdout.write(`${JSON.stringify({ kind: "replayed", pid: process.pid, port })}\n`);
    } else if (mode === "claim") {
      process.stdout.write(`${JSON.stringify({ kind: "claimed", pid: process.pid, port })}\n`);
    } else {
      throw new Error("unknown fixture mode");
    }
    setInterval(() => undefined, 60_000);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "fixture_failed";
    const detail = error instanceof Error ? error.message : "non-error rejection";
    process.stdout.write(
      `${JSON.stringify({ kind: "error", code, detail, phase, pid: process.pid, port })}\n`,
    );
    process.exitCode = 2;
    await owner.close().catch(() => undefined);
  }
