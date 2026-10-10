import { afterAll, expect, test } from "bun:test";
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
import type { WorkerdPublicationIdentity } from "../src/workerd-runtime.ts";
import type { WorkerdProcess } from "../src/workerd-supervisor.ts";
import { openWorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-queue-target-owner";
const WORKER_UID = "worker-queue-target";
const CREATE_ID = "0f2e9831-691d-41d8-b5ce-983e052a14c3";
const DELETE_ID = "84ed6745-0688-4201-8372-0c26ddcce0f4";

afterAll(async () => {
  // Flush FileHandle finalizers here, rather than letting a later unrelated
  // test discover that a fixture swallowed an owner.close() refusal.
  for (let turn = 0; turn < 3; turn += 1) {
    Bun.gc(true);
    await Bun.sleep(0);
  }
});

// A real child/listener and exact on-disk publication, but no tenant handler execution.
const CHILD_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
process.on("SIGTERM", () => {
  const root = dirname(process.argv[1]);
  if (!existsSync(join(root, "hold-retirement." + process.pid))) {
    server.stop(true);
    return;
  }
  writeFileSync(join(root, "retirement-entered." + process.pid), "entered");
  const timer = setInterval(() => {
    if (!existsSync(join(root, "release-retirement." + process.pid))) return;
    clearInterval(timer);
    server.stop(true);
  }, 10);
});
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

/**
 * A Deployment delete closes admission and retires every incarnation on
 * purpose. The readiness probe must not read that as a failed Worker: before
 * this, health() said "unavailable" for the whole retirement window, and kept
 * saying it if retirement needed a retry.
 */
test("a Deployment delete never reads as an unavailable owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-delete-health-"));
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
  try {
    expect(await owner.execute(execution(CREATE_ID, "create"))).toMatchObject({
      kind: "confirmed",
    });
    publication.setCurrent(CREATE_ID);
    expect(owner.health()).toBe("serving");
    const pid = children.at(-1)?.pid;
    if (!pid) throw new Error("fixture child missing");
    // Hold the child's SIGTERM so the retirement window is wide and observable.
    await writeFile(join(root, `hold-retirement.${pid}`), "hold", { mode: 0o600 });
    const seen = new Set<string>();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        seen.add(owner.health());
        await Bun.sleep(2);
      }
    })();
    const deleting = owner.execute(execution(DELETE_ID, "delete"));
    const entered = join(root, `retirement-entered.${pid}`);
    const deadline = Date.now() + 10_000;
    while (!(await Bun.file(entered).exists())) {
      if (Date.now() > deadline) throw new Error("retirement never reached the child");
      await Bun.sleep(5);
    }
    // Inside the retirement window: admission is closed, the record is retiring.
    expect(owner.health()).toBe("idle");
    await writeFile(join(root, `release-retirement.${pid}`), "release", { mode: 0o600 });
    expect(await deleting).toMatchObject({ kind: "confirmed", identity: null });
    sampling = false;
    await sampler;
    expect([...seen]).not.toContain("unavailable");
    expect(owner.health()).toBe("idle");
    expect(await owner.observeRetirement({})).toMatchObject({ kind: "confirmed_absent" });
    await owner.close();
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
