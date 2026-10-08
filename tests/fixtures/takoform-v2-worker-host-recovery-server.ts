// Test-only subprocess composition: real v2 HTTP, SQL 0077 current-serving
// recovery and held artifact custody. The default mode uses a Bun child
// standing in for workerd; opt-in native-code mode uses the pinned binary.
// Neither mode publishes a normal application Form map or qualifies a frontend.
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../../src/takoform-v2/configured-private-inputs.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import { createTakoformV2Host } from "../../src/takoform-v2/host.ts";
import { createWorkerCronTriggerAdmissionReader } from "../../src/takoform-v2/worker-cron-trigger-backend.ts";
import { createWorkerDeploymentForm } from "../../src/takoform-v2/worker-deployment-backend.ts";
import { createWorkerEndpointForm } from "../../src/takoform-v2/worker-endpoint-backend.ts";
import {
  createInternalV2ModuleWorkerForm,
  createInternalV2StaticWorkerVersionForm,
  createInternalV2WorkerVersionForm,
  createV2CodeConfiguredInputReader,
} from "../../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerdWorkerRuntimeReaders } from "../../src/takoform-v2/worker-runtime-readers.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../../src/takoform-v2/worker-version-configured-inputs.ts";
import { spawnWorkerdWithParentDeath } from "../../src/workerd-linux-process.ts";
import type { WorkerdProcess } from "../../src/workerd-supervisor.ts";
import { createWorkerdWorkerModuleInspector } from "../../src/workerd-worker-module-inspector.ts";
import { openWorkerdWorkerRuntimeOwner } from "../../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-worker-host-recovery";
const PUBLIC_HOST = "fixture.example.test";
const MANIFEST_URL = "https://artifacts.example.test/host-recovery/manifest.json";
const FILE_URL = "https://artifacts.example.test/host-recovery/index.html";
const MANIFEST_KEY = "host-recovery/manifest";
const FILE_KEY = "host-recovery/index.html";
const CODE_MANIFEST_URL = "https://artifacts.example.test/host-recovery/code.json";
const CODE_FILE_URL = "https://artifacts.example.test/host-recovery/index.mjs";
const CODE_MANIFEST_KEY = "host-recovery/code-manifest";
const CODE_FILE_KEY = "host-recovery/code-file";
const args = process.argv.slice(2);
if (args.length < 5 || args.slice(0, 5).some((value) => !value)) {
  throw new Error("worker host recovery fixture arguments missing");
}
const [root, binary, startupWorkerUid, manifestSha256, fileSha256] = args as [
  string,
  string,
  string,
  string,
  string,
];
const nativeCode = args[5] === "native-code";
if (args.length !== (nativeCode ? 8 : 5)) {
  throw new Error("invalid worker host recovery fixture mode");
}
const codeManifestSha256 = args[6];
const codeFileSha256 = args[7];

async function fixtureKeys() {
  const aes = (byte: number) =>
    crypto.subtle.importKey("raw", new Uint8Array(32).fill(byte), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  const [configured, transfer, comparison] = await Promise.all([
    aes(0x61),
    aes(0x62),
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(0x63),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  ]);
  return { configured, transfer, comparison };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const selected = Number(reservation.port);
  await reservation.stop(true);
  return selected;
}

async function main(): Promise<void> {
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createFileObjectStore({ root: join(root, "objects") });
  const source = createV2HeldArtifactSource({
    objects,
    entries: [
      {
        url: MANIFEST_URL,
        sha256: manifestSha256,
        objectKey: MANIFEST_KEY,
        grants: [{ principal: "host-recovery-owner", space: "production" }],
      },
      {
        url: FILE_URL,
        sha256: fileSha256,
        objectKey: FILE_KEY,
        grants: [{ principal: "host-recovery-owner", space: "production" }],
      },
      ...(nativeCode && codeManifestSha256 && codeFileSha256
        ? [
            {
              url: CODE_MANIFEST_URL,
              sha256: codeManifestSha256,
              objectKey: CODE_MANIFEST_KEY,
              grants: [{ principal: "host-recovery-owner", space: "production" }],
            },
            {
              url: CODE_FILE_URL,
              sha256: codeFileSha256,
              objectKey: CODE_FILE_KEY,
              grants: [{ principal: "host-recovery-owner", space: "production" }],
            },
          ]
        : []),
    ],
  });
  const assetHost = createStaticAssetBundleHost({ sql, source, targetKey: TARGET_KEY });
  const bundleHost = nativeCode
    ? createWorkerBundleHost({ sql, source, targetKey: TARGET_KEY })
    : null;
  const publicationState = createV2WorkerPublicationState({
    sql,
    assetCustody: assetHost.custody,
    ...(bundleHost ? { bundleCustody: bundleHost.custody } : {}),
  });
  const keys = nativeCode ? await fixtureKeys() : null;
  const sealer = keys
    ? createV2WorkerVersionConfiguredInputSealer({
        current: { keyId: "native-host-recovery", key: keys.configured },
        keyForDecryption: (id) => (id === "native-host-recovery" ? keys.configured : undefined),
      })
    : null;
  const configuredInputs = sealer
    ? createV2CodeConfiguredInputReader({
        sql,
        sealer,
        custody: { read: (identity) => readV2ConfiguredPrivateInputs(sql, identity) },
      })
    : null;
  const inspector = nativeCode
    ? createWorkerdWorkerModuleInspector({
        repositoryRoot: resolve(import.meta.dir, "../.."),
        binary,
      })
    : null;
  type RuntimeOwner = Awaited<ReturnType<typeof openWorkerdWorkerRuntimeOwner>>;
  const owners = new Map<string, RuntimeOwner>();
  const children: { readonly pid: number; active: boolean }[] = [];
  // Test-only gate: the child may have exited while the fixture census has not
  // yet observed it. This makes the post-Operation retirement window repeatable.
  let holdChildExitCensus = false;
  const heldChildExits = new Map<number, () => void>();
  const routeAbsenceReads: {
    endpointUid: string;
    workerUid: string;
    hostname: string;
    url: string;
  }[] = [];

  async function ensureOwner(uid: string): Promise<RuntimeOwner> {
    const existing = owners.get(uid);
    if (existing) return existing;
    const owner = await openWorkerdWorkerRuntimeOwner({
      rootDirectory: join(root, "worker-owners"),
      workerResourceUid: uid,
      targetKey: TARGET_KEY,
      publicationState,
      ...(configuredInputs ? { configuredInputs } : {}),
      workerdBinary: binary,
      ...(inspector ? { inspectModule: inspector.inspect.bind(inspector) } : {}),
      listenerPortForOperation: unusedPort,
      spawn(command: readonly string[]): WorkerdProcess {
        const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
        if (child.pid === undefined) {
          child.kill();
          throw new Error("worker child PID is unavailable");
        }
        const tracked = { pid: child.pid, active: true };
        children.push(tracked);
        const observeExit = () => {
          if (holdChildExitCensus) {
            heldChildExits.set(tracked.pid, () => {
              tracked.active = false;
            });
          } else {
            tracked.active = false;
          }
        };
        void child.exited?.then(observeExit, observeExit);
        return child;
      },
    });
    owners.set(uid, owner);
    return owner;
  }

  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async (uid) => owners.get(uid) ?? null,
  });
  const forms = {
    [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
      sql,
      targetKey: TARGET_KEY,
      ...readers,
    }),
    [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
    ...(bundleHost ? { [WORKER_BUNDLE_FORM_URL]: bundleHost.form } : {}),
    [WORKER_VERSION_FORM_URL]:
      sealer && inspector
        ? createInternalV2WorkerVersionForm({
            sql,
            targetKey: TARGET_KEY,
            publicationState,
            retirement: readers.retirement,
            inspectModule: inspector.inspect.bind(inspector),
            configuredInputSealer: sealer,
            configuredInputCustody: {
              read: (identity) => readV2ConfiguredPrivateInputs(sql, identity),
            },
          })
        : createInternalV2StaticWorkerVersionForm({
            sql,
            targetKey: TARGET_KEY,
            publicationState,
            retirement: readers.retirement,
          }),
    [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
      targetKey: TARGET_KEY,
      publicationState,
      scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql }),
      ownerForWorker: ensureOwner,
    }),
    [WORKER_ENDPOINT_FORM_URL]: createWorkerEndpointForm({
      targetKey: TARGET_KEY,
      publicationState,
      ownerForWorker: ensureOwner,
      assignHostname({ resourceUid }) {
        return `endpoint-${resourceUid.slice(0, 8)}.example.test`;
      },
      async observeTls(input) {
        const owner = owners.get(input.workerUid);
        const serving = owner
          ? await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET_KEY,
            })
          : { kind: "unknown" as const };
        return {
          ...input,
          ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
        };
      },
      async observeRouteAbsent(input) {
        routeAbsenceReads.push({ ...input });
        const owner = owners.get(input.workerUid);
        const serving = owner
          ? await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET_KEY,
            })
          : { kind: "unknown" as const };
        return {
          ...input,
          absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
        };
      },
    }),
  };

  if (startupWorkerUid !== "-") await ensureOwner(startupWorkerUid);

  const host = createTakoformV2Host({
    sql,
    ...(keys
      ? {
          privateInputCustody: {
            transfer: { current: { id: "native-transfer", key: keys.transfer } },
            comparison: { current: { id: "native-comparison", key: keys.comparison } },
            transferTtlSeconds: 300,
          },
        }
      : {}),
    now: () => new Date(),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 30_000,
    authorize: async (principal, space) =>
      principal === "host-recovery-owner" && space === "production",
    forms,
    baseUrl: `https://${PUBLIC_HOST}/apis/forms.takoform.com/v2`,
    documentation: "https://docs.example.test/takoform-v2",
    authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    authenticationSchemes: ["Bearer"],
    cursorSigningKey: new Uint8Array(32).fill(0x67),
    maxRequestBytes: 65_536,
    maxPageSize: 20,
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer test-only"
        ? { principal: "host-recovery-owner", access: "write" }
        : null,
  });

  let running = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/__fixture/hold-child-exit-census") {
        holdChildExitCensus = true;
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/__fixture/release-child-exit-census") {
        holdChildExitCensus = false;
        for (const release of heldChildExits.values()) release();
        heldChildExits.clear();
        return new Response(null, { status: 204 });
      }
      const fixture = /^\/__fixture\/(status|serve)\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (fixture) {
        const mode = fixture[1];
        const uid = fixture[2];
        if (!mode || !uid) return new Response(null, { status: 404 });
        const owner = owners.get(uid);
        if (!owner) return Response.json({ error: "owner_unavailable" }, { status: 503 });
        if (mode === "status") {
          return Response.json({
            pid: process.pid,
            childPids: children.filter((child) => child.active).map((child) => child.pid),
            heldChildExitPids: [...heldChildExits.keys()],
            serving: await owner.observeServing({ workerResourceUid: uid, targetKey: TARGET_KEY }),
            routeAbsenceReads,
          });
        }
        const serving = await owner.observeServing({
          workerResourceUid: uid,
          targetKey: TARGET_KEY,
        });
        const hostname = serving.kind === "serving" ? serving.hostnames[0] : undefined;
        const path = url.searchParams.get("path") ?? "/index.html";
        if (path !== "/index.html" && path !== "/" && path !== "/api")
          return new Response(null, { status: 400 });
        const response = await owner.fetch(
          new Request(`https://${hostname ?? "worker.fixture.test"}${path}`),
        );
        return Response.json({
          status: response.status,
          body: await response.text(),
          sourceOperationId: serving.kind === "serving" ? serving.sourceOperationId : null,
        });
      }
      const routed = new Request(`https://${PUBLIC_HOST}${url.pathname}${url.search}`, request);
      return (await host.fetch(routed)) ?? new Response(null, { status: 404 });
    },
  });

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await host.runNext();
    } catch {
      emit({ stage: "executor_error" });
    } finally {
      running = false;
    }
  }, 10);
  emit({ stage: "listening", port: server.port });
}

try {
  await main();
} catch (error) {
  emit({ stage: "startup_error", error: error instanceof Error ? error.message : "unknown error" });
  process.exitCode = 1;
}
