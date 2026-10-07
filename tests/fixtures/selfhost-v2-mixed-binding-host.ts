// Test-only normal Host process for the mixed-binding SIGKILL/reopen journey.
// All keys and ports are fixed test inputs; this does not mount Worker Forms
// into the normal application registry or claim public Support.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostV2KvStore } from "../../src/providers/selfhost-v2-kv-store.ts";
import { createSelfhostV2ObjectBucketStore } from "../../src/providers/selfhost-v2-object-bucket-store.ts";
import { createSelfhostV2SQLiteStore } from "../../src/providers/selfhost-v2-sqlite-store.ts";
import {
  runSelfhostKvOperation,
  selfhostKvOperationErrorCode,
} from "../../src/selfhost-data-planes.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../../src/takoform-v2/forms/edge-kv-namespace.ts";
import { createEdgeKVNamespaceForm } from "../../src/takoform-v2/forms/edge-kv-namespace-backend.ts";
import { OBJECT_BUCKET_FORM_URL } from "../../src/takoform-v2/forms/object-bucket.ts";
import { createObjectBucketForm } from "../../src/takoform-v2/forms/object-bucket-backend.ts";
import { SQLITE_DATABASE_FORM_URL } from "../../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../../src/takoform-v2/forms/sqlite-database-backend.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [
  root,
  binary,
  organizationId,
  manifestSha,
  moduleSha,
  sqlitePortText,
  kvPortText,
  objectPortText,
] = process.argv.slice(2);
const sqlitePort = Number(sqlitePortText);
const kvPort = Number(kvPortText);
const objectPort = Number(objectPortText);
if (
  !root ||
  !binary ||
  !organizationId ||
  !manifestSha ||
  !moduleSha ||
  !Number.isSafeInteger(sqlitePort) ||
  sqlitePort < 1 ||
  !Number.isSafeInteger(kvPort) ||
  kvPort < 1 ||
  !Number.isSafeInteger(objectPort) ||
  objectPort < 1 ||
  new Set([sqlitePort, kvPort, objectPort]).size !== 3
) {
  throw new Error("mixed-binding Host fixture arguments are invalid");
}

const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const database = new Database(join(root, "control.sqlite"));
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: join(root, "objects") });
const clock = () => new Date();
const grants = [{ principal: `org:${organizationId}`, space: organizationId }];
const config = {
  cursorSigningKey: new Uint8Array(32).fill(0x71),
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  workerBundle: {
    targetKey: TARGET,
    heldArtifacts: [
      {
        url: "https://artifacts.example.test/mixed-worker/manifest.json",
        sha256: manifestSha,
        objectKey: "mixed-worker/manifest",
        grants,
      },
      {
        url: "https://artifacts.example.test/mixed-worker/index.mjs",
        sha256: moduleSha,
        objectKey: "mixed-worker/module",
        grants,
      },
    ],
  },
};
const sqliteStore = createSelfhostV2SQLiteStore({
  root: join(root, "sqlite-custody"),
  sql,
  targetKey: TARGET,
  now: clock,
});
const kvStore = createSelfhostV2KvStore({
  root: join(root, "kv-custody"),
  sql,
  clock,
  runOperation: runSelfhostKvOperation,
  operationErrorCode: selfhostKvOperationErrorCode,
});
const objectBucketStore = createSelfhostV2ObjectBucketStore({
  root: join(root, "object-buckets"),
  sql,
  clock,
});

let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
try {
  composition = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "worker-owners"),
    targetKey: TARGET,
    workerdBinary: binary,
    sqliteBinding: {
      store: sqliteStore,
      signingKey: new Uint8Array(32).fill(0x72),
      privatePort: sqlitePort,
    },
    v2KvBinding: {
      store: kvStore,
      signingKey: new Uint8Array(32).fill(0x73),
      privatePort: kvPort,
    },
    v2ObjectBucketBinding: {
      store: objectBucketStore,
      signingKey: new Uint8Array(32).fill(0x74),
      privatePort: objectPort,
    },
    endpoint: {
      assignHostname({ resourceUid }) {
        return `worker-${resourceUid.slice(0, 8)}.example.test`;
      },
      async observeTls(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
        };
      },
      async observeRouteAbsent(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
        };
      },
    },
  });
  const restored = await composition.restoreOwners();
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
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory(context) {
      return {
        ...composition.internalFormFactory(context),
        [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store: sqliteStore }),
        [EDGE_KV_NAMESPACE_FORM_URL]: createEdgeKVNamespaceForm({
          store: kvStore,
          targetKey: TARGET,
        }),
        [OBJECT_BUCKET_FORM_URL]: createObjectBucketForm({
          store: objectBucketStore,
          targetKey: TARGET,
        }),
      };
    },
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: ORIGIN,
    appFetch: (request) => app.fetch(request),
  });
  let acceptedResponseHeld = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__fixture/accepted-response-held") {
        return Response.json({ held: acceptedResponseHeld });
      }
      if (url.pathname === "/__fixture/prepare-database" && request.method === "POST") {
        try {
          const input = (await request.json()) as { resourceUid?: string };
          if (typeof input.resourceUid !== "string") return new Response(null, { status: 400 });
          await sqliteStore.withAuthorizedDatabase({
            resourceUid: input.resourceUid,
            stillAuthorized: async () => true,
            use(databaseForResource) {
              databaseForResource.exec(
                "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
              );
            },
          });
          return new Response(null, { status: 204 });
        } catch {
          return new Response(null, { status: 409 });
        }
      }
      const serve = /^\/__fixture\/serve\/([A-Za-z0-9._-]{1,128})(\/.*)?$/u.exec(url.pathname);
      if (serve) {
        const workerUid = serve[1] as string;
        const owner = await composition.ownerForWorkerUid(workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: workerUid,
          targetKey: TARGET,
        });
        if (serving.kind !== "serving" || serving.hostnames.length !== 1) {
          return new Response(null, { status: 503 });
        }
        return await owner.fetch(
          new Request(`https://${serving.hostnames[0]}${serve[2] ?? "/"}${url.search}`),
        );
      }
      const response = await ingress(request);
      // The operation/resource has already been durably accepted by buildApp.
      // Holding this fixture-only response lets the test abort the client after
      // acceptance but before it can receive the Operation acknowledgement.
      if (
        request.headers.get("x-fixture-hold-accepted-response") === "yes" &&
        response.status === 202
      ) {
        acceptedResponseHeld = true;
        const body = await response.arrayBuffer();
        await Bun.sleep(2_000);
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    },
  });
  setInterval(() => {
    void app.tickTakoformV2().catch(() => {});
  }, 10);
  process.stdout.write(
    `${JSON.stringify({ stage: "listening", port: server.port, pid: process.pid, restored })}\n`,
  );
} catch (error) {
  const code = error instanceof WorkerdWorkerRuntimeOwnerError ? error.code : "startup_refused";
  process.stdout.write(`${JSON.stringify({ stage: "startup_error", code })}\n`);
  database.close();
  process.exitCode = 1;
}
