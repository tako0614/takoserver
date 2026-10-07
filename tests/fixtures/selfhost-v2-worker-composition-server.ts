// Test-only normal buildApp HTTP registration. Production entry restores the
// same owners but deliberately does not expose the incomplete Worker Forms.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [root, binary, organizationId, manifestSha256, fileSha256] = process.argv.slice(2);
if (!root || !binary || !organizationId || !manifestSha256 || !fileSha256) {
  throw new Error("v2 Worker composition fixture arguments are missing");
}
const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const database = new Database(join(root, "control.sqlite"));
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: join(root, "objects") });
const clock = () => new Date();
const config = {
  cursorSigningKey: new Uint8Array(32).fill(0x52), // fixture-only key
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  staticAssetBundle: {
    targetKey: TARGET,
    heldArtifacts: [
      {
        url: "https://artifacts.example.test/v2-worker/manifest.json",
        sha256: manifestSha256,
        objectKey: "v2-worker/manifest",
        grants: [{ principal: `org:${organizationId}`, space: organizationId }],
      },
      {
        url: "https://artifacts.example.test/v2-worker/index.html",
        sha256: fileSha256,
        objectKey: "v2-worker/index.html",
        grants: [{ principal: `org:${organizationId}`, space: organizationId }],
      },
    ],
  },
};
let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
composition = createSelfhostV2WorkerComposition({
  sql,
  objects,
  clock,
  config,
  rootDirectory: join(root, "v2-worker-owners"),
  targetKey: TARGET,
  workerdBinary: binary,
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

try {
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
    v2FormFactory: composition.internalFormFactory,
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: ORIGIN,
    appFetch: (request) => app.fetch(request),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const serve = /^\/__fixture\/serve\/([0-9a-f-]{36})$/u.exec(path);
      if (serve) {
        const owner = await composition.ownerForWorkerUid(serve[1] as string);
        return await owner.fetch(new Request("https://worker.example.test/"));
      }
      return await ingress(request);
    },
  });
  setInterval(() => {
    void app.tickTakoformV2().catch(() => {
      process.stdout.write(`${JSON.stringify({ stage: "tick_error" })}\n`);
    });
  }, 10);
  process.stdout.write(
    `${JSON.stringify({ stage: "listening", port: server.port, pid: process.pid, restored })}\n`,
  );
} catch (error) {
  const code =
    error instanceof WorkerdWorkerRuntimeOwnerError
      ? error.code
      : error instanceof Error && error.message === "v2 Worker serving owner is missing"
        ? "missing_serving_owner"
        : "startup_refused";
  process.stdout.write(`${JSON.stringify({ stage: "startup_error", code })}\n`);
  database.close();
  process.exitCode = 1;
}
