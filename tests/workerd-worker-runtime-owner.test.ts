import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import {
  createWorkerEndpointForm,
  WORKER_ENDPOINT_BACKEND_ID,
} from "../src/takoform-v2/worker-endpoint-backend.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "../src/workerd-linux-process.ts";
import type { WorkerdPublicationIdentity } from "../src/workerd-runtime.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import {
  inspectWorkerdWorkerExecutionCopies,
  releaseRetiredWorkerdWorkerExecutionCopies,
} from "../src/workerd-worker-execution-group.ts";
import {
  createSerializedWorkerdOwnerStateWriter,
  openWorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET_KEY = "fixture-v2-worker-runtime-owner";
const CHILD_SOURCE = `
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
const startServer = () => Bun.serve({ hostname: "127.0.0.1", port: initial.port, async fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  if (request.method === "POST" && request.headers.get("host")?.endsWith(".selfhost-events.invalid") &&
      url.pathname === "/.well-known/takoserver/managed-worker-events/v1") {
    const config = readFileSync(configPath, "utf8");
    const eventToken = /name = "__TAKOSERVER_SELFHOST_EVENT_TOKEN", text = "([0-9a-f]{64})"/u.exec(config)?.[1];
    if (!eventToken || request.headers.get("x-takoserver-selfhost-event-token") !== eventToken)
      return new Response(null, { status: 404 });
    const event = await request.json();
    writeFileSync(join(dirname(process.argv[1]), "last-schedule.json"), JSON.stringify({ pid: process.pid, event }));
    if (event.cron === "2 * * * *") await Bun.sleep(50);
    if (event.cron === "0 * * * *")
      return Response.json({ protocol: "takoserver.managed-worker-event@v1", kind: "schedule", outcome: "rejected" }, { status: 500 });
    if (event.cron === "3 * * * *") return Response.json({ ok: true });
    return Response.json({ protocol: "takoserver.managed-worker-event@v1", kind: "schedule", outcome: "ack" });
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
let server = startServer();
let heldOpen;
process.on("SIGTERM", () => { server.stop(true); if (heldOpen) clearInterval(heldOpen); });
process.on("SIGUSR1", () => { server.stop(true); heldOpen = setInterval(() => {}, 1000); });
process.on("SIGUSR2", () => { server = startServer(); if (heldOpen) clearInterval(heldOpen); heldOpen = undefined; });
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

async function heldCodeBundle(
  scheduled = false,
): Promise<SqlArtifactCustodyRead<WorkerBundleManifest>> {
  const manifestUrl = "https://artifacts.example.test/runtime/manifest.json";
  const moduleUrl = "https://artifacts.example.test/runtime/index.mjs";
  const moduleBytes = new TextEncoder().encode(
    scheduled
      ? "export default { fetch() { return new Response('ok'); }, scheduled() {} };\n"
      : "export default { fetch() { return new Response('ok'); } };\n",
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

function staticPublicationState(
  workerResourceUid: string,
  withCode = false,
  withScheduled = false,
) {
  const assetBytes = new TextEncoder().encode("owner fixture asset");
  let lastOperationId: string | undefined;
  let fenceCurrent = true;
  let fenceChecks = 0;
  let fenceFailureAfter: number | null = null;
  let lastExecution: V2Execution | null = null;
  const source = {
    async resolve({
      execution,
      incumbentSourceOperationId,
    }: {
      execution: V2Execution;
      incumbentSourceOperationId?: string;
    }): Promise<V2WorkerPublicationResolution> {
      lastExecution = execution;
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
            handlers: withScheduled ? ["fetch", "scheduled"] : ["fetch"],
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
          fenceChecks += 1;
          return fenceCurrent && (fenceFailureAfter === null || fenceChecks <= fenceFailureAfter);
        },
        async readVersionMaterials() {
          return {
            bundle: withCode ? await heldCodeBundle(withScheduled) : null,
            assets: withCode ? null : heldAssets,
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
        input.workerUid !== workerResourceUid ||
        input.targetKey !== TARGET_KEY ||
        lastExecution.operationId !== input.sourceOperationId ||
        input.expectedIdentity.generation !== `takoserver-v2-operation:${input.sourceOperationId}`
      ) {
        return {
          kind: "unresolved" as const,
          code: "stale",
          message: "fixture serving graph changed",
        };
      }
      return await source.resolve({ execution: lastExecution });
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
    failAfterFenceChecks(limit: number | null) {
      fenceChecks = 0;
      fenceFailureAfter = limit;
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

function endpointExecution(
  workerResourceUid: string,
  operationId: string,
  action: "create" | "update" | "delete",
): V2Execution {
  return {
    operationId,
    leaseToken: `lease-${operationId}`,
    backendKey: `backend-${operationId}`,
    backendId: WORKER_ENDPOINT_BACKEND_ID,
    targetKey: TARGET_KEY,
    resourceUid: `endpoint-${workerResourceUid}`,
    principal: "org-runtime-owner",
    action,
    generation: action === "create" ? 1 : action === "update" ? 2 : 3,
    form: WORKER_ENDPOINT_FORM_URL,
    space: "production",
    name: "assigned-runtime-endpoint",
    spec: { worker: { resourceUid: workerResourceUid } },
    previousObserved: {},
    previousOutput: {},
  };
}

async function endpointPublicationState(workerResourceUid: string) {
  const codeUid = `version-code-${workerResourceUid}`;
  const staticUid = `version-static-${workerResourceUid}`;
  const codeSpec = parseWorkerVersionSpec({
    worker: { resourceUid: workerResourceUid },
    bundle: { resourceUid: `bundle-${workerResourceUid}` },
    handlers: ["fetch"],
    vars: { SETTINGS: { mode: "endpoint-test" } },
  });
  const staticSpec = parseWorkerVersionSpec({
    worker: { resourceUid: workerResourceUid },
    handlers: [],
    assets: {
      bundle: { resourceUid: `assets-${workerResourceUid}` },
      runWorkerFirst: false,
      notFoundHandling: "none",
    },
  });
  const deploymentSpec = parseWorkerDeploymentSpec({
    worker: { resourceUid: workerResourceUid },
    versions: [
      { workerVersion: { resourceUid: codeUid }, weight: 4_000 },
      { workerVersion: { resourceUid: staticUid }, weight: 6_000 },
    ],
  });
  const assetBytes = new TextEncoder().encode("endpoint fixture asset");
  const assetSha256 = (await bytesDigest(assetBytes)).slice("sha256:".length);
  const assetsManifest = {
    files: [
      {
        path: "index.html",
        url: "https://artifacts.example.test/endpoint-index.html",
        sha256: assetSha256,
        mediaType: "text/html",
      },
    ],
  };
  const assetsManifestBytes = new TextEncoder().encode(JSON.stringify(assetsManifest));
  const assetsManifestSha256 = (await bytesDigest(assetsManifestBytes)).slice("sha256:".length);
  const assets = {
    manifest: assetsManifest,
    manifestBytes: assetsManifestBytes,
    files: [assetBytes],
    observed: {
      manifestSha256: assetsManifestSha256,
      fileCount: 1,
      totalBytes: assetBytes.byteLength,
      files: [
        {
          path: "index.html",
          sha256: assetSha256,
          mediaType: "text/html",
          byteSize: assetBytes.byteLength,
        },
      ],
    },
  };
  const codeBundle = await heldCodeBundle();
  const endpointResourceUid = `endpoint-${workerResourceUid}`;
  const hostname = `${endpointResourceUid}.assigned.example.test`;
  const output = { hostname, url: `https://${hostname}/` };
  let currentOperationId: string | undefined;
  let deploymentPresent = true;
  let fenceCurrent = true;
  let namespaceMutationAfterSecondFence: (() => Promise<void>) | undefined;
  const source = {
    async resolve({
      execution: candidateExecution,
      incumbentSourceOperationId,
    }: {
      execution: V2Execution;
      incumbentSourceOperationId?: string;
    }): Promise<V2WorkerPublicationResolution> {
      if (
        incumbentSourceOperationId !== undefined &&
        incumbentSourceOperationId !== candidateExecution.operationId &&
        currentOperationId !== incumbentSourceOperationId
      ) {
        return {
          kind: "unresolved",
          code: "incumbent_unresolved",
          message: "fixture did not observe the exact published owner identity",
        };
      }
      const endpointOperation = candidateExecution.form === WORKER_ENDPOINT_FORM_URL;
      let fenceChecks = 0;
      const workerDelete =
        candidateExecution.form === WORKER_DEPLOYMENT_FORM_URL &&
        candidateExecution.action === "delete";
      const endpoint =
        endpointOperation && candidateExecution.action !== "delete"
          ? {
              uid: endpointResourceUid,
              generation: candidateExecution.generation,
              spec: parseWorkerEndpointSpec(candidateExecution.spec),
              output: {
                hostname: `${endpointResourceUid}.assigned.example.test`,
                url: `https://${endpointResourceUid}.assigned.example.test/`,
              },
            }
          : null;
      return {
        kind: "ready",
        snapshot: {
          sourceOperationId: candidateExecution.operationId,
          ...(endpointOperation
            ? {
                acceptedEndpointOutput: {
                  hostname: `${endpointResourceUid}.assigned.example.test`,
                  url: `https://${endpointResourceUid}.assigned.example.test/`,
                },
              }
            : {}),
          worker: {
            uid: workerResourceUid,
            principal: candidateExecution.principal,
            space: candidateExecution.space,
            generation: 1,
          },
          deployment:
            workerDelete || !deploymentPresent
              ? null
              : {
                  uid: `deployment-${workerResourceUid}`,
                  generation: 1,
                  spec: deploymentSpec,
                  versions: [
                    {
                      uid: codeUid,
                      generation: 1,
                      weight: 4_000,
                      spec: codeSpec,
                    },
                    {
                      uid: staticUid,
                      generation: 1,
                      weight: 6_000,
                      spec: staticSpec,
                    },
                  ],
                },
          endpoint,
        },
        sqlGuard: { sql: "SELECT 1", params: [] },
        async stillCurrent() {
          fenceChecks += 1;
          if (fenceChecks === 2 && namespaceMutationAfterSecondFence) {
            const mutate = namespaceMutationAfterSecondFence;
            namespaceMutationAfterSecondFence = undefined;
            await mutate();
          }
          return fenceCurrent;
        },
        async readVersionMaterials(versionUid: string) {
          if (versionUid === codeUid) return { bundle: codeBundle, assets: null };
          if (versionUid === staticUid) return { bundle: null, assets };
          throw new Error("unexpected fixture WorkerVersion UID");
        },
      } as V2WorkerPublicationResolution;
    },
  };
  return {
    source,
    setCurrent(operationId: string) {
      currentOperationId = operationId;
    },
    setFenceCurrent(value: boolean) {
      fenceCurrent = value;
    },
    setDeploymentPresent(value: boolean) {
      deploymentPresent = value;
    },
    mutateNamespaceAfterSecondFence(mutate: () => Promise<void>) {
      namespaceMutationAfterSecondFence = mutate;
    },
    output,
    deploymentSpec,
    versions: [
      { workerVersionUid: codeUid, weight: 4_000 },
      { workerVersionUid: staticUid, weight: 6_000 },
    ],
  };
}

test("Endpoint create/update/delete publish only its route through the same weighted Worker owner", async () => {
  const owned = await fixture();
  const workerUid = "worker-endpoint-route-owner";
  const publication = await endpointPublicationState(workerUid);
  const ownerOptions = {
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
  };
  const owner = await openWorkerdWorkerRuntimeOwner(ownerOptions);
  const endpointCreate = endpointExecution(
    workerUid,
    "96d53f6b-14b6-4415-8bf9-2ab9ef07e052",
    "create",
  );
  const endpointUpdate = endpointExecution(
    workerUid,
    "b50345a2-f742-4b64-8e9c-cf172986e1f0",
    "update",
  );
  const endpointDelete = endpointExecution(
    workerUid,
    "c67f84e1-cda2-49ae-8f25-f9befd10ee33",
    "delete",
  );
  const deploymentCreate = execution(workerUid, "1a2105fc-41f4-4865-b160-8e72fcdb1fc4", "create");
  const deploymentDelete = execution(workerUid, "fe2f26df-2b6f-4f30-a29c-3e6d9859fbc8", "delete");
  const endpointDeleteAfterDeployment = endpointExecution(
    workerUid,
    "71d7a92e-551c-4978-9708-20c5af433720",
    "delete",
  );
  const endpointForm = createWorkerEndpointForm({
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    ownerForWorker: () => owner,
    assignHostname: ({ resourceUid }) => `${resourceUid}.assigned.example.test`,
    observeTls: async (input) => ({ ...input, ready: true }),
    // Frontend readback is an explicit fixture; native route retirement alone
    // must not settle Endpoint deletion or imply shared TLS teardown.
    observeRouteAbsent: async (input) => ({ ...input, absent: true }),
  });

  try {
    const deployed = await owner.execute(deploymentCreate);
    expect(deployed).toMatchObject({
      kind: "confirmed",
      identity: { hostnames: [], versions: publication.versions },
      deferRetirementUntilDeadline: true,
    });
    publication.setCurrent(deploymentCreate.operationId);

    // TLS may lag after the Workerd route has been published. This first
    // caller result is intentionally unknown; retrying the same accepted
    // Operation must observe the exact existing owner identity.
    let firstTlsObservation = true;
    const reconcileForm = createWorkerEndpointForm({
      targetKey: TARGET_KEY,
      publicationState: publication.source,
      ownerForWorker: () => owner,
      assignHostname: ({ resourceUid }) => `${resourceUid}.assigned.example.test`,
      observeTls: async (input) => {
        const ready = !firstTlsObservation;
        firstTlsObservation = false;
        return { ...input, ready };
      },
    });
    expect(await reconcileForm.backend.execute(endpointCreate)).toMatchObject({
      kind: "unknown",
    });
    const afterUnknownAck = owned.children.length;
    publication.setCurrent(endpointCreate.operationId);
    expect(await reconcileForm.backend.reconcile(endpointCreate)).toMatchObject({
      kind: "complete",
      observed: { tlsReady: true, activeDeploymentRouteReady: true },
      output: publication.output,
    });
    expect(owned.children).toHaveLength(afterUnknownAck);

    publication.setCurrent(endpointCreate.operationId);
    expect(await endpointForm.backend.execute(endpointUpdate)).toMatchObject({
      kind: "complete",
      observed: { tlsReady: true, activeDeploymentRouteReady: true },
      output: publication.output,
    });
    publication.setCurrent(endpointUpdate.operationId);

    expect(await endpointForm.backend.execute(endpointDelete)).toMatchObject({
      kind: "complete",
      observed: { activeDeploymentRouteReady: false },
      output: publication.output,
    });
    publication.setCurrent(endpointDelete.operationId);
    expect(
      await owner.observeServing({ workerResourceUid: workerUid, targetKey: TARGET_KEY }),
    ).toMatchObject({
      kind: "serving",
      sourceOperationId: endpointDelete.operationId,
      generation: `takoserver-v2-operation:${endpointDelete.operationId}`,
      hostnames: [],
      versions: publication.versions,
    });
    const stillServing = await (
      await owner.fetch(new Request(`https://${workerUid}.example.test/`))
    ).text();
    expect(stillServing).toMatch(/^[0-9a-f]{64}$/u);

    // Endpoint DELETE is route-only. The Worker continues serving the same
    // weighted Deployment until an explicit WorkerDeployment DELETE follows.
    expect(await owner.execute(deploymentDelete)).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    await owner.close();

    const workerKey = createHash("sha256").update(workerUid, "utf8").digest("hex");
    const groupDirectory = join(
      ownerOptions.rootDirectory,
      workerKey,
      "incarnations",
      deploymentCreate.operationId,
      "groups",
      workerKey,
    );
    const unexpectedEntry = join(groupDirectory, "unknown-owner-entry");
    await writeFile(unexpectedEntry, "preserve unknown entry");
    await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    expect(await Bun.file(unexpectedEntry).text()).toBe("preserve unknown entry");
    await rm(unexpectedEntry);

    const reopened = await openWorkerdWorkerRuntimeOwner(ownerOptions);
    try {
      expect(await reopened.execute(deploymentDelete)).toMatchObject({
        kind: "confirmed",
        identity: null,
      });
      const versionUid = publication.versions[0]?.workerVersionUid;
      if (!versionUid) throw new Error("fixture WorkerVersion UID missing");
      expect(await reopened.observeRetirement({ workerVersionUid: versionUid })).toMatchObject({
        kind: "confirmed_absent",
        workerVersionUid: versionUid,
      });
      publication.setCurrent(endpointDeleteAfterDeployment.operationId);
      publication.setDeploymentPresent(false);
      const routeAbsent = await reopened.execute(endpointDeleteAfterDeployment);
      expect(routeAbsent).toEqual({
        kind: "confirmed_route_absent",
        sourceOperationId: endpointDeleteAfterDeployment.operationId,
        endpointResourceUid: endpointDeleteAfterDeployment.resourceUid,
        workerResourceUid: workerUid,
        targetKey: TARGET_KEY,
        assignedHostname: publication.output.hostname,
      });
      const childCountAfterDeploymentDelete = owned.children.length;
      expect(await reopened.execute(endpointDeleteAfterDeployment)).toEqual(routeAbsent);
      expect(owned.children).toHaveLength(childCountAfterDeploymentDelete);
      const workerKey = createHash("sha256").update(workerUid, "utf8").digest("hex");
      const persistedOwnerState = JSON.parse(
        await Bun.file(join(ownerOptions.rootDirectory, workerKey, "runtime-owner.json")).text(),
      ) as { endpointRouteAbsence: unknown };
      expect(persistedOwnerState.endpointRouteAbsence).toEqual(routeAbsent);
      const staleRouteDelete = endpointExecution(
        workerUid,
        "5d8cc6bf-51b0-42d9-87af-5d9a75f0c4a2",
        "delete",
      );
      publication.setCurrent(staleRouteDelete.operationId);
      publication.setFenceCurrent(false);
      expect(await reopened.execute(staleRouteDelete)).toEqual({ kind: "unknown" });
      expect(
        JSON.parse(
          await Bun.file(join(ownerOptions.rootDirectory, workerKey, "runtime-owner.json")).text(),
        ).endpointRouteAbsence,
      ).toEqual(routeAbsent);
      publication.setFenceCurrent(true);
      const retriedRouteAbsent = await reopened.execute(staleRouteDelete);
      expect(retriedRouteAbsent).toMatchObject({
        kind: "confirmed_route_absent",
        sourceOperationId: staleRouteDelete.operationId,
      });
      expect(await reopened.execute(staleRouteDelete)).toEqual(retriedRouteAbsent);
    } finally {
      await reopened.close();
    }
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

test("no-Deployment Endpoint delete proves a complete empty owner namespace and refuses orphans", async () => {
  const owned = await fixture();
  const workerUid = "worker-endpoint-empty-owner";
  const publication = await endpointPublicationState(workerUid);
  publication.setDeploymentPresent(false);
  const workerKey = createHash("sha256").update(workerUid, "utf8").digest("hex");
  const ownerDirectory = join(owned.root, "owners", workerKey);
  let routeAbsenceAtSpawn: unknown = "not-observed";
  const ownerOptions = {
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn(command: readonly string[]) {
      routeAbsenceAtSpawn = JSON.parse(
        readFileSync(join(ownerDirectory, "runtime-owner.json"), "utf8"),
      ).endpointRouteAbsence;
      return owned.spawn(command);
    },
  };
  const endpointDelete = endpointExecution(
    workerUid,
    "30d5ff3d-d20d-42e3-86bc-d3cff6a1ba35",
    "delete",
  );
  publication.setCurrent(endpointDelete.operationId);
  const owner = await openWorkerdWorkerRuntimeOwner(ownerOptions);
  try {
    const first = await owner.execute(endpointDelete);
    expect(first).toEqual({
      kind: "confirmed_route_absent",
      sourceOperationId: endpointDelete.operationId,
      endpointResourceUid: endpointDelete.resourceUid,
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
      assignedHostname: publication.output.hostname,
    });
    expect(owned.children).toHaveLength(0);
    await owner.close();

    const reopened = await openWorkerdWorkerRuntimeOwner(ownerOptions);
    try {
      expect(await reopened.execute(endpointDelete)).toEqual(first);
      const incarnationRoot = join(ownerDirectory, "incarnations");
      const orphanId = "a2b12db3-3e26-489a-b6f6-0844e88a1158";
      const orphanPath = join(incarnationRoot, orphanId);
      await mkdir(orphanPath, { recursive: true, mode: 0o700 });
      expect(await reopened.execute(endpointDelete)).toEqual({ kind: "unknown" });
      expect((await lstat(orphanPath)).isDirectory()).toBe(true);
      await rm(incarnationRoot, { recursive: true });

      const foreign = join(owned.root, "foreign-incarnation-root");
      await mkdir(foreign, { mode: 0o700 });
      await writeFile(join(foreign, "untouched"), "foreign");
      await symlink(foreign, incarnationRoot);
      expect(await reopened.execute(endpointDelete)).toEqual({ kind: "unknown" });
      expect(await Bun.file(join(foreign, "untouched")).text()).toBe("foreign");
      await unlink(incarnationRoot);
      await rm(foreign, { recursive: true });

      expect(await reopened.execute(endpointDelete)).toEqual(first);
      expect(owned.children).toHaveLength(0);

      const postPersistOrphanId = "d72f799c-04bb-4c2b-95ce-96af11412f3c";
      const racedRouteDelete = endpointExecution(
        workerUid,
        "3a6c3bde-537d-425d-8b97-689ae1fbb5f1",
        "delete",
      );
      publication.setCurrent(racedRouteDelete.operationId);
      publication.mutateNamespaceAfterSecondFence(async () => {
        await mkdir(join(incarnationRoot, postPersistOrphanId), {
          recursive: true,
          mode: 0o700,
        });
      });
      expect(await reopened.execute(racedRouteDelete)).toEqual({ kind: "unknown" });
      expect(await pathExists(join(incarnationRoot, postPersistOrphanId))).toBe(true);
      await rm(incarnationRoot, { recursive: true });
      await reopened.close();
      const afterInventoryRace = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      try {
        expect(await afterInventoryRace.execute(racedRouteDelete)).toMatchObject({
          kind: "confirmed_route_absent",
          sourceOperationId: racedRouteDelete.operationId,
        });
      } finally {
        await afterInventoryRace.close();
      }

      // A later publication clears the historical receipt in the same
      // durable transition that stages its candidate incarnation.
      const candidatePublication = staticPublicationState(workerUid);
      const candidateOwner = await openWorkerdWorkerRuntimeOwner({
        ...ownerOptions,
        publicationState: candidatePublication.source,
      });
      try {
        const deploymentCreate = execution(
          workerUid,
          "68231ca5-c3a0-460b-974f-c89ca69358d2",
          "create",
        );
        expect(await candidateOwner.execute(deploymentCreate)).toMatchObject({ kind: "confirmed" });
        expect(routeAbsenceAtSpawn).toBeNull();
        candidatePublication.setCurrent(deploymentCreate.operationId);
        expect(
          await candidateOwner.execute(
            execution(workerUid, "d148c455-1910-4c9d-9869-451a8768f635", "delete"),
          ),
        ).toMatchObject({ kind: "confirmed", identity: null });
      } finally {
        await candidateOwner.close();
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

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
          processIdentity: {
            pid: number;
            bootId: string;
            pidNamespace: string;
            startTimeTicks: string;
          } | null;
          configurationSha256: string | null;
        }>;
      };
      expect(finalState.schema).toBe("takoserver.v2-worker-runtime-owner@9");
      expect(
        finalState.incarnations.every(
          (record) =>
            record.executionCopiesReleased &&
            record.executionCopiesCleanupStarted &&
            record.processIdentity !== null &&
            record.configurationSha256 !== null &&
            /^[0-9a-f]{64}$/u.test(record.configurationSha256),
        ),
      ).toBe(true);
      expect(owned.children).toHaveLength(1);
      await reopened.close();

      const previousV8 = JSON.parse(await Bun.file(statePath).text()) as Record<string, unknown>;
      previousV8.schema = "takoserver.v2-worker-runtime-owner@8";
      delete previousV8.suspended;
      delete previousV8.physicalAbsences;
      await writeFile(statePath, `${JSON.stringify(previousV8)}\n`, { mode: 0o600 });
      const migratedV8 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV8.close();

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
      delete (previousV2 as Record<string, unknown>).endpointRouteAbsence;
      delete (previousV2 as Record<string, unknown>).suspended;
      delete (previousV2 as Record<string, unknown>).physicalAbsences;
      for (const record of previousV2.incarnations) {
        delete record.executionCopiesReleased;
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
        delete record.processIdentity;
        delete record.configurationSha256;
        delete record.configurationRefreshPending;
        delete record.eventToken;
      }
      await rm(join(groupRoot, ".retired-execution-copies"), { recursive: true, force: true });
      await writeFile(statePath, `${JSON.stringify(previousV2)}\n`, { mode: 0o600 });
      const migratedV2 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV2.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@9",
      );

      const previousV7 = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<Record<string, unknown>>;
      };
      previousV7.schema = "takoserver.v2-worker-runtime-owner@7";
      delete (previousV7 as Record<string, unknown>).suspended;
      delete (previousV7 as Record<string, unknown>).physicalAbsences;
      await writeFile(statePath, `${JSON.stringify(previousV7)}\n`, { mode: 0o600 });
      await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
        code: "ownership_uncertain",
      });
      for (const record of previousV7.incarnations) delete record.eventToken;
      const incompleteV7 = structuredClone(previousV7);
      const incompleteCopy = incompleteV7.incarnations[0];
      if (!incompleteCopy) throw new Error("retired v7 incarnation missing");
      (incompleteV7 as typeof incompleteV7 & Record<string, unknown>).activeOperationId = null;
      (incompleteV7 as typeof incompleteV7 & Record<string, unknown>).admissionClosedBy = deleteId;
      (incompleteV7 as typeof incompleteV7 & Record<string, unknown>).deletionPublicationConfirmed =
        true;
      (incompleteV7 as typeof incompleteV7 & Record<string, unknown>).endpointRouteAbsence = null;
      incompleteCopy.executionCopiesReleased = false;
      await writeFile(statePath, `${JSON.stringify(incompleteV7)}\n`, { mode: 0o600 });
      await expect(openWorkerdWorkerRuntimeOwner(ownerOptions)).rejects.toMatchObject({
        code: "ownership_uncertain",
      });
      await writeFile(statePath, `${JSON.stringify(previousV7)}\n`, { mode: 0o600 });
      const migratedV7 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV7.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@7",
      );

      const previousV4 = JSON.parse(await Bun.file(statePath).text()) as Record<string, unknown>;
      previousV4.schema = "takoserver.v2-worker-runtime-owner@4";
      delete previousV4.endpointRouteAbsence;
      for (const record of previousV4.incarnations as Array<Record<string, unknown>>) {
        delete record.processIdentity;
        delete record.configurationSha256;
        delete record.configurationRefreshPending;
        delete record.eventToken;
      }
      await writeFile(statePath, `${JSON.stringify(previousV4)}\n`, { mode: 0o600 });
      const migratedV4 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV4.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@4",
      );

      const previousV3 = JSON.parse(await Bun.file(statePath).text()) as {
        schema: string;
        incarnations: Array<Record<string, unknown>>;
      };
      previousV3.schema = "takoserver.v2-worker-runtime-owner@3";
      delete (previousV3 as Record<string, unknown>).endpointRouteAbsence;
      for (const record of previousV3.incarnations) {
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
        delete record.processIdentity;
        delete record.configurationSha256;
        delete record.configurationRefreshPending;
        delete record.eventToken;
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
      delete (previousV1 as Record<string, unknown>).endpointRouteAbsence;
      for (const record of previousV1.incarnations) {
        delete record.executionCopiesReleased;
        delete record.executionCopiesCleanupStarted;
        delete record.executionCopiesCleanupManifestSha256;
        delete record.deferRetirementUntilDeadline;
        delete record.processIdentity;
        delete record.configurationSha256;
        delete record.configurationRefreshPending;
        delete record.eventToken;
      }
      await writeFile(statePath, `${JSON.stringify(previousV1)}\n`, { mode: 0o600 });
      const migratedV1 = await openWorkerdWorkerRuntimeOwner(ownerOptions);
      await migratedV1.close();
      expect(JSON.parse(await Bun.file(statePath).text()).schema).toBe(
        "takoserver.v2-worker-runtime-owner@9",
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

test("Actor graph readback is pinned to current SQL and the live native incarnation", async () => {
  const owned = await fixture();
  const workerUid = "worker-actor-readback";
  const createId = "0cfebc3b-3b9a-4a5b-a897-6713df09120e";
  const deleteId = "f1840189-4a30-41c2-bae2-9c086a5327c3";
  const publication = staticPublicationState(workerUid, true);
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
    inspectModule: async (): Promise<WorkerModuleInspectionResult> => ({
      outcome: "valid",
      exportedHandlers: ["fetch"],
    }),
  });
  const read = () =>
    owner.observeActorGraph({
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
      sourceOperationId: createId,
    });
  try {
    expect(await read()).toEqual({ kind: "unknown" });
    expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(createId);
    const exact = await read();
    expect(exact).toMatchObject({
      kind: "ready",
      sourceOperationId: createId,
      graph: {
        workerResourceUid: workerUid,
        generation: `takoserver-v2-operation:${createId}`,
        versions: [{ workerVersionUid: `version-${createId}`, weight: 10_000 }],
      },
    });
    if (exact.kind !== "ready") throw new Error("native Actor graph not observed");
    expect(exact.graph.versions[0]?.modules.get("index.mjs")).toBeInstanceOf(Uint8Array);
    expect(
      await owner.observeActorGraph({
        workerResourceUid: workerUid,
        targetKey: TARGET_KEY,
        sourceOperationId: deleteId,
      }),
    ).toEqual({ kind: "unknown" });
    const mutable = {
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
      sourceOperationId: deleteId,
    };
    const staleRequest = owner.observeActorGraph(mutable);
    mutable.sourceOperationId = createId;
    expect(await staleRequest).toEqual({ kind: "unknown" });
    publication.setFenceCurrent(false);
    expect(await read()).toEqual({ kind: "unknown" });
    publication.setFenceCurrent(true);
    publication.failAfterFenceChecks(2);
    expect(await read()).toEqual({ kind: "unknown" });
    publication.failAfterFenceChecks(null);
    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    expect(await read()).toEqual({ kind: "unknown" });
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

test("Workflow selection returns only the exact live SQL-held code Version and a bounded private lease", async () => {
  const owned = await fixture();
  const workerUid = "worker-workflow-selection";
  const createId = "0cfebc3b-3b9a-4a5b-a897-6713df09121e";
  const deleteId = "f1840189-4a30-41c2-bae2-9c086a5327c4";
  const publication = staticPublicationState(workerUid, true);
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
    inspectModule: async (): Promise<WorkerModuleInspectionResult> => ({
      outcome: "valid",
      exportedHandlers: ["fetch"],
    }),
  });
  const request = {
    workerUid,
    targetKey: TARGET_KEY,
    servingSourceOperationId: createId,
    basisPoint: 0,
  };
  try {
    expect(await owner.selectWorkflowExecution(request)).toEqual({ kind: "unknown" });
    expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(createId);
    const selection = await owner.selectWorkflowExecution(request);
    expect(selection).toMatchObject({
      kind: "selected",
      sourceOperationId: createId,
      selected: {
        workerResourceUid: workerUid,
        workerVersionUid: `version-${createId}`,
      },
    });
    if (selection.kind !== "selected") throw new Error("Workflow Version was not selected");
    expect(selection.selected.modules.get("index.mjs")).toEqual((await heldCodeBundle()).files[0]);
    expect(selection.selected.hostModules.size).toBeGreaterThan(0);
    expect(await selection.stillCurrent()).toBe(true);
    const lease = await selection.acquirePrivateServiceBindings(new AbortController().signal);
    expect(lease.services).toEqual([]);
    const mutable = { ...request };
    const pending = owner.selectWorkflowExecution(mutable);
    mutable.servingSourceOperationId = deleteId;
    expect((await pending).kind).toBe("selected");
    expect(await owner.selectWorkflowExecution({ ...request, basisPoint: 10_000 })).toEqual({
      kind: "unknown",
    });
    publication.setFenceCurrent(false);
    expect(await selection.stillCurrent()).toBe(false);
    expect(await owner.selectWorkflowExecution(request)).toEqual({ kind: "unknown" });
    publication.setFenceCurrent(true);
    let deleteFinished = false;
    const deletion = owner.execute(execution(workerUid, deleteId, "delete")).then((result) => {
      deleteFinished = true;
      return result;
    });
    await Bun.sleep(30);
    expect(deleteFinished).toBe(false);
    expect(await selection.stillCurrent()).toBe(false);
    await lease.release();
    expect(await deletion).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    expect(await selection.stillCurrent()).toBe(false);
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});

const nativeWorkerd = nativeEvidenceBinary("workerd-artifact");
test.skipIf(nativeWorkerd === undefined)(
  "pinned native owner selects the serving Workflow code Version and acquires its private bridge",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-workflow-owner-native-"));
    const artifact = await selectClosedGraphWorkerd({
      binary: nativeWorkerd as string,
      privateRoot: join(root, "artifact"),
    });
    if (!artifact.binary) throw new Error(artifact.diagnostic ?? "pinned workerd unavailable");
    const workerUid = "worker-workflow-native";
    const createId = "0cfebc3b-3b9a-4a5b-a897-6713df09122e";
    const deleteId = "f1840189-4a30-41c2-bae2-9c086a5327d4";
    const publication = staticPublicationState(workerUid, true);
    const owner = await openWorkerdWorkerRuntimeOwner({
      rootDirectory: join(root, "owners"),
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
      publicationState: publication.source,
      workerdBinary: artifact.binary,
      listenerPortForOperation: unusedPort,
      inspectModule: async (): Promise<WorkerModuleInspectionResult> => ({
        outcome: "valid",
        exportedHandlers: ["fetch"],
      }),
    });
    try {
      expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
        kind: "confirmed",
      });
      publication.setCurrent(createId);
      const selection = await owner.selectWorkflowExecution({
        workerUid,
        targetKey: TARGET_KEY,
        servingSourceOperationId: createId,
        basisPoint: 0,
      });
      expect(selection.kind).toBe("selected");
      if (selection.kind !== "selected") throw new Error("native Workflow Version unavailable");
      const lease = await selection.acquirePrivateServiceBindings(new AbortController().signal);
      expect(lease.services).toEqual([]);
      await lease.release();
      expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
        kind: "confirmed",
        identity: null,
      });
    } finally {
      await owner.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Actor graph readback refuses a foreign listener while native bytes remain", async () => {
  const owned = await fixture();
  const workerUid = "worker-actor-lost-listener";
  const createId = "03448a40-4525-4d4b-8da0-8cebfcedaf88";
  const deleteId = "e43fb7dd-b1f3-41b5-8a9e-ecbb38c64069";
  const publication = staticPublicationState(workerUid, true);
  const ownerRoot = join(owned.root, "owners");
  const owner = await openWorkerdWorkerRuntimeOwner({
    rootDirectory: ownerRoot,
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
    inspectModule: async (): Promise<WorkerModuleInspectionResult> => ({
      outcome: "valid",
      exportedHandlers: ["fetch"],
    }),
  });
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  let child: TestChild | undefined;
  let listenerPort: number | undefined;
  try {
    expect(await owner.execute(execution(workerUid, createId, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(createId);
    const request = {
      workerResourceUid: workerUid,
      targetKey: TARGET_KEY,
      sourceOperationId: createId,
    };
    expect((await owner.observeActorGraph(request)).kind).toBe("ready");
    const workerKey = createHash("sha256").update(workerUid).digest("hex");
    const groupRoot = join(ownerRoot, workerKey, "incarnations", createId, "groups", workerKey);
    const group = JSON.parse(await Bun.file(join(groupRoot, "group.json")).text()) as {
      listenerPort: number;
    };
    child = owned.children[0];
    if (!child?.pid) throw new Error("native child PID missing");
    listenerPort = group.listenerPort;
    child.kill("SIGUSR1");
    let listener = await workerPortOwnership(group.listenerPort, child.pid);
    for (let attempt = 0; listener === "owned" && attempt < 150; attempt += 1) {
      await Bun.sleep(20);
      listener = await workerPortOwnership(group.listenerPort, child.pid);
    }
    expect(listener).not.toBe("owned");
    foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: group.listenerPort,
      fetch: () => new Response("foreign"),
    });
    expect(await owner.observeActorGraph(request)).toEqual({ kind: "unknown" });
  } finally {
    await foreign?.stop(true);
    try {
      if (child?.pid && listenerPort !== undefined) {
        child.kill("SIGUSR2");
        let listener = await workerPortOwnership(listenerPort, child.pid);
        for (let attempt = 0; listener !== "owned" && attempt < 150; attempt += 1) {
          await Bun.sleep(20);
          listener = await workerPortOwnership(listenerPort, child.pid);
        }
        expect(listener).toBe("owned");
        expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
          kind: "confirmed",
          identity: null,
        });
      }
      await owner.close();
    } finally {
      await owned.cleanup();
    }
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
    expect(
      await owner.observeScheduledCapability({
        workerUid,
        principal: "org-runtime-owner",
        space: "production",
        targetKey: TARGET_KEY,
      }),
    ).toEqual({ kind: "unknown" });
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

test("scheduled port delivers the exact match through the current private Version gate", async () => {
  const owned = await fixture();
  const workerUid = "worker-scheduled-gate";
  const publication = staticPublicationState(workerUid, true, true);
  const createId = "7502b0fd-177f-45e7-aee0-09579856016d";
  const deleteId = "4fb3f262-7b20-4af7-a79d-c06d921544e9";
  const options = {
    rootDirectory: join(owned.root, "owners"),
    workerResourceUid: workerUid,
    targetKey: TARGET_KEY,
    publicationState: publication.source,
    workerdBinary: owned.binary,
    listenerPortForOperation: unusedPort,
    spawn: owned.spawn,
    inspectModule: async (): Promise<WorkerModuleInspectionResult> => ({
      outcome: "valid",
      exportedHandlers: ["fetch", "scheduled"],
    }),
  };
  const owner = await openWorkerdWorkerRuntimeOwner(options);
  try {
    const created = await owner.execute(execution(workerUid, createId, "create"));
    expect(created.kind).toBe("confirmed");
    if (created.kind !== "confirmed" || !created.identity)
      throw new Error("scheduled publication identity missing");
    publication.setCurrent(createId);
    const capability = await owner.observeScheduledCapability({
      workerUid,
      principal: "org-runtime-owner",
      space: "production",
      targetKey: TARGET_KEY,
    });
    expect(capability).toMatchObject({
      kind: "confirmed",
      servingSourceOperationId: createId,
      deploymentUid: `deployment-${workerUid}`,
      deploymentGeneration: 1,
      versions: [{ workerVersionUid: `version-${createId}`, generation: 1, weight: 10_000 }],
    });
    if (capability.kind !== "confirmed") throw new Error("scheduled capability missing");
    expect(await capability.stillCurrent()).toBe(true);
    expect(await pathExists(join(owned.root, "last-schedule.json"))).toBe(false);
    const match = {
      triggerUid: "cron-001",
      workerUid,
      cron: "17 */2 * * 1-5",
      scheduledTime: 1_700_000_000_000,
      matchId: "cron-001:1700000000000",
    };
    expect(await owner.invokeScheduled(match)).toEqual({
      kind: "handler_resolved",
      workerVersionUid: `version-${createId}`,
    });
    const observed = JSON.parse(await Bun.file(join(owned.root, "last-schedule.json")).text()) as {
      pid: number;
      event: Record<string, unknown>;
    };
    const child = owned.children[0];
    if (!child) throw new Error("scheduled child missing");
    expect(observed.pid).toBe(child.pid);
    expect(observed.event).toMatchObject({
      protocol: "takoserver.managed-worker-event@v1",
      kind: "schedule",
      deploymentId: created.identity.versions[0]?.versionId,
      cron: match.cron,
      scheduledTime: match.scheduledTime,
    });
    expect(await owner.invokeScheduled({ ...match, cron: "0 * * * *" })).toEqual({
      kind: "handler_rejected",
      workerVersionUid: `version-${createId}`,
    });
    expect(await owner.invokeScheduled({ ...match, cron: "3 * * * *" })).toEqual({
      kind: "unknown",
    });
    const inflight = owner.invokeScheduled({ ...match, cron: "2 * * * *" });
    await until(() => {
      try {
        const seen = JSON.parse(readFileSync(join(owned.root, "last-schedule.json"), "utf8")) as {
          event?: { cron?: string };
        };
        return seen.event?.cron === "2 * * * *";
      } catch {
        return false;
      }
    });
    publication.setFenceCurrent(false);
    expect(await capability.stillCurrent()).toBe(false);
    expect(await inflight).toEqual({ kind: "unknown" });
    expect(await owner.invokeScheduled(match)).toEqual({ kind: "unknown" });
    publication.setFenceCurrent(true);
    await expect(openWorkerdWorkerRuntimeOwner(options)).rejects.toMatchObject({
      code: "ownership_uncertain",
    });
    expect(await owner.execute(execution(workerUid, deleteId, "delete"))).toMatchObject({
      kind: "confirmed",
      identity: null,
    });
    await owner.close();
  } finally {
    await owner.close().catch(() => undefined);
    await owned.cleanup();
  }
});
