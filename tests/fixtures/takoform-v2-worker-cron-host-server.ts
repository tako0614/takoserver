// Test-only v2 Host composition. The original mode is a Bun stand-in; the
// opt-in native mode uses the normal internal Form factory and pinned Workerd.
// Neither mode adds a public scheduled-delivery endpoint.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { bytesDigest } from "../../src/json.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../../src/takoform-v2/forms/worker-bundle-backend.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import { createTakoformV2Host } from "../../src/takoform-v2/host.ts";
import {
  createWorkerCronTriggerAdmissionReader,
  createWorkerCronTriggerForm,
} from "../../src/takoform-v2/worker-cron-trigger-backend.ts";
import { runWorkerCronTriggerTick } from "../../src/takoform-v2/worker-cron-trigger-scheduler.ts";
import { createWorkerDeploymentForm } from "../../src/takoform-v2/worker-deployment-backend.ts";
import {
  createInternalV2CodeWorkerVersionForm,
  createInternalV2ModuleWorkerForm,
} from "../../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerdWorkerRuntimeReaders } from "../../src/takoform-v2/worker-runtime-readers.ts";
import { v2ServiceTargetName } from "../../src/takoform-v2/worker-service-resolution.ts";
import { spawnWorkerdWithParentDeath } from "../../src/workerd-linux-process.ts";
import { internalHostname } from "../../src/workerd-runtime.ts";
import type { WorkerdProcess } from "../../src/workerd-supervisor.ts";
import { openWorkerdWorkerRuntimeOwner } from "../../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-cron-host";
const PUBLIC_HOST = "fixture.example.test";
const MANIFEST_URL = "https://artifacts.example.test/cron/manifest.json";
const MODULE_URL = "https://artifacts.example.test/cron/index.js";
const args = process.argv.slice(2);
const nativeMode = args.length === 7 && args[5] === "native" && !!args[6];
if ((args.length !== 5 && !nativeMode) || args.some((value) => !value))
  throw new Error("cron fixture arguments missing");
const [root, binary, startupWorkerUid, manifestSha256, moduleSha256] = args as [
  string,
  string,
  string,
  string,
  string,
];
const nativeOrganizationId = args[6];

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function unusedPort(): Promise<number> {
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(reserved.port);
  await reserved.stop(true);
  return port;
}

async function main(): Promise<void> {
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const source = createV2HeldArtifactSource({
    objects: createFileObjectStore({ root: join(root, "objects") }),
    entries: [
      {
        url: MANIFEST_URL,
        sha256: manifestSha256,
        objectKey: "cron/manifest",
        grants: [{ principal: "cron-owner", space: "production" }],
      },
      {
        url: MODULE_URL,
        sha256: moduleSha256,
        objectKey: "cron/index.js",
        grants: [{ principal: "cron-owner", space: "production" }],
      },
    ],
  });
  const bundle = createWorkerBundleHost({ sql, source, targetKey: TARGET_KEY });
  const publicationState = createV2WorkerPublicationState({ sql, bundleCustody: bundle.custody });
  type Owner = Awaited<ReturnType<typeof openWorkerdWorkerRuntimeOwner>>;
  const owners = new Map<string, Owner>();

  // The fixture inspector recognizes only the exact held module digest. The
  // subprocess below independently executes that module from verified active
  // publication bytes; neither part qualifies production semantic inspection.
  const inspectModule = async (input: {
    readonly mainModule: string;
    readonly modules: readonly { readonly name: string; readonly bytes: Uint8Array }[];
    readonly declaredHandlers: readonly string[];
  }) => {
    const module = input.modules.find((item) => item.name === input.mainModule);
    return input.declaredHandlers.length === 1 &&
      input.declaredHandlers[0] === "scheduled" &&
      module !== undefined &&
      (await bytesDigest(module.bytes)) === `sha256:${moduleSha256}`
      ? { outcome: "valid" as const, exportedHandlers: ["scheduled" as const] }
      : { outcome: "invalid" as const, error: "handler_not_exported" as const };
  };

  async function ensureOwner(uid: string): Promise<Owner> {
    const existing = owners.get(uid);
    if (existing) return existing;
    const owner = await openWorkerdWorkerRuntimeOwner({
      rootDirectory: join(root, "worker-owners"),
      workerResourceUid: uid,
      targetKey: TARGET_KEY,
      publicationState,
      workerdBinary: binary,
      listenerPortForOperation: unusedPort,
      inspectModule,
      spawn(command: readonly string[]): WorkerdProcess {
        return spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" });
      },
    });
    owners.set(uid, owner);
    return owner;
  }

  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async (uid) => owners.get(uid) ?? null,
  });
  if (startupWorkerUid !== "-") await ensureOwner(startupWorkerUid);
  let hostNowMs = Date.now();
  const host = createTakoformV2Host({
    sql,
    now: () => new Date(hostNowMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 30_000,
    authorize: async (principal, space) => principal === "cron-owner" && space === "production",
    forms: {
      [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
        sql,
        targetKey: TARGET_KEY,
        ...readers,
      }),
      [WORKER_BUNDLE_FORM_URL]: bundle.form,
      [WORKER_VERSION_FORM_URL]: createInternalV2CodeWorkerVersionForm({
        sql,
        targetKey: TARGET_KEY,
        publicationState,
        retirement: readers.retirement,
        inspectModule,
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
        targetKey: TARGET_KEY,
        publicationState,
        scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql }),
        ownerForWorker: ensureOwner,
      }),
      [WORKER_CRON_TRIGGER_FORM_URL]: createWorkerCronTriggerForm({
        sql,
        targetKey: TARGET_KEY,
        capability: {
          observeScheduledCapability: async (input) =>
            (await ensureOwner(input.workerUid)).observeScheduledCapability(input),
        },
      }),
    },
    baseUrl: `https://${PUBLIC_HOST}/apis/forms.takoform.com/v2`,
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/authentication",
    authenticationSchemes: ["Bearer"],
    cursorSigningKey: new Uint8Array(32).fill(0x69),
    maxRequestBytes: 65_536,
    maxPageSize: 20,
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { principal: "cron-owner", access: "write" }
        : null,
  });

  let running = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__fixture/tick") {
        const at = Number(url.searchParams.get("at"));
        if (!Number.isSafeInteger(at)) return new Response(null, { status: 400 });
        return Response.json(
          await runWorkerCronTriggerTick({
            sql,
            now: () => new Date(at),
            targetKey: TARGET_KEY,
            delivery: {
              invokeScheduled: async (input) =>
                (await ensureOwner(input.workerUid)).invokeScheduled(input),
            },
            leaseMilliseconds: 1_000,
            retryMilliseconds: 1_000,
          }),
        );
      }
      if (url.pathname === "/__fixture/advance-host-clock") {
        const at = Number(url.searchParams.get("at"));
        if (!Number.isSafeInteger(at) || at < hostNowMs) return new Response(null, { status: 400 });
        hostNowMs = at;
        return Response.json({ now: hostNowMs });
      }
      if (url.pathname === "/__fixture/matches") {
        return Response.json(
          await sql.query(
            "SELECT match_id, trigger_uid, cron, scheduled_time_ms, state, attempts, result_version_uid FROM tf_v2_worker_cron_matches ORDER BY scheduled_time_ms, match_id",
          ),
        );
      }
      if (url.pathname === "/__fixture/pid") return Response.json({ pid: process.pid });
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

/** Opt-in real Workerd mode; the older Bun stand-in journey is unchanged. */
async function mainNative(): Promise<void> {
  if (!nativeOrganizationId) throw new Error("native Cron organization is missing");
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createFileObjectStore({ root: join(root, "objects") });
  let hostNowMs = Date.now();
  const clock = () => new Date(hostNowMs);
  const config = {
    cursorSigningKey: new Uint8Array(32).fill(0x69),
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/authentication",
    workerBundle: {
      targetKey: TARGET_KEY,
      heldArtifacts: [
        {
          url: MANIFEST_URL,
          sha256: manifestSha256,
          objectKey: "cron/manifest",
          grants: [{ principal: `org:${nativeOrganizationId}`, space: nativeOrganizationId }],
        },
        {
          url: MODULE_URL,
          sha256: moduleSha256,
          objectKey: "cron/index.js",
          grants: [{ principal: `org:${nativeOrganizationId}`, space: nativeOrganizationId }],
        },
      ],
    },
  };
  const workers = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "native-worker-owners"),
    targetKey: TARGET_KEY,
    workerdBinary: binary,
  });
  const restored = await workers.restoreOwners();
  if (startupWorkerUid !== "-" && !restored.includes(startupWorkerUid))
    throw new Error("expected native Worker owner was not restored");
  const app = buildApp({
    sql,
    objects,
    clock,
    identity: {
      async verify() {
        throw new Error("fixture external identity unavailable");
      },
    },
    settlement: {
      async verify() {
        throw new Error("fixture settlement unavailable");
      },
    },
    publicOrigin: `https://${PUBLIC_HOST}`,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory: workers.internalFormFactory,
  });
  let running = false;
  const executorTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await app.tickTakoformV2();
    } catch {
      emit({ stage: "executor_error" });
    } finally {
      running = false;
    }
  }, 10);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__fixture/tick") {
        const at = Number(url.searchParams.get("at"));
        if (!Number.isSafeInteger(at) || at < hostNowMs) return new Response(null, { status: 400 });
        hostNowMs = at;
        return Response.json(await workers.pollScheduledDue());
      }
      if (url.pathname === "/__fixture/advance-host-clock") {
        const at = Number(url.searchParams.get("at"));
        if (!Number.isSafeInteger(at) || at < hostNowMs) return new Response(null, { status: 400 });
        hostNowMs = at;
        return Response.json({ now: hostNowMs });
      }
      if (url.pathname === "/__fixture/matches") {
        return Response.json(
          await sql.query(
            "SELECT match_id, trigger_uid, cron, scheduled_time_ms, state, attempts, result_version_uid FROM tf_v2_worker_cron_matches ORDER BY scheduled_time_ms, match_id",
          ),
        );
      }
      const serve = /^\/__fixture\/serve\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (serve) {
        const uid = serve[1] as string;
        const owner = await workers.ownerForWorkerUid(uid);
        const hostname = internalHostname(await v2ServiceTargetName(uid));
        return await owner.fetch(new Request(`https://${hostname}/`));
      }
      if (url.pathname === "/__fixture/pid") return Response.json({ pid: process.pid });
      if (url.pathname === "/__fixture/shutdown" && request.method === "POST") {
        setTimeout(async () => {
          try {
            clearInterval(executorTimer);
            await workers.closeScheduledHost();
            await workers.suspendOwnersRetainingCustody();
            await workers.closePrivateBindingServices();
            await server.stop(true);
            database.close();
            emit({ stage: "stopped" });
          } catch (error) {
            emit({
              stage: "shutdown_error",
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        }, 0);
        return new Response(null, { status: 202 });
      }
      const routed = new Request(`https://${PUBLIC_HOST}${url.pathname}${url.search}`, request);
      return await app.fetch(routed);
    },
  });
  emit({ stage: "listening", port: server.port });
}

try {
  await (nativeMode ? mainNative() : main());
} catch (error) {
  emit({ stage: "startup_error", error: error instanceof Error ? error.message : "unknown error" });
  process.exitCode = 1;
}
