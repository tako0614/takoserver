// Test-only normal buildApp Host. Fixed fixture key and port model operator-
// selected private custody across process replacement; no public Worker Form
// support, tenant credential, or production key is configured here.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostV2SQLiteStore } from "../../src/providers/selfhost-v2-sqlite-store.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_DATABASE_FORM_URL } from "../../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../../src/takoform-v2/forms/sqlite-database-backend.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationForm } from "../../src/takoform-v2/forms/sqlite-migration-application-backend.ts";
import { createSQLiteMigrationSetCustody } from "../../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import { WorkerdWorkerRuntimeOwnerError } from "../../src/workerd-worker-runtime-owner.ts";

const [
  root,
  binary,
  organizationId,
  manifestSha256,
  codeSha256,
  migrationManifestSha256,
  migrationSha256,
  portText,
] = process.argv.slice(2);
const privatePort = Number(portText);
if (
  !root ||
  !binary ||
  !organizationId ||
  !manifestSha256 ||
  !codeSha256 ||
  !migrationManifestSha256 ||
  !migrationSha256 ||
  !Number.isSafeInteger(privatePort) ||
  privatePort < 1 ||
  privatePort > 65_535
) {
  throw new Error("v2 Worker SQLite fixture arguments are missing");
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
  cursorSigningKey: new Uint8Array(32).fill(0x51),
  documentation: "https://docs.example.test/v2",
  authenticationDocumentation: "https://docs.example.test/v2/authentication",
  workerBundle: {
    targetKey: TARGET,
    heldArtifacts: [
      {
        url: "https://artifacts.example.test/v2-sqlite/bundle.json",
        sha256: manifestSha256,
        objectKey: "v2-sqlite/manifest",
        grants,
      },
      {
        url: "https://artifacts.example.test/v2-sqlite/index.mjs",
        sha256: codeSha256,
        objectKey: "v2-sqlite/module",
        grants,
      },
    ],
  },
  sqliteMigrationSet: {
    targetKey: TARGET,
    heldArtifacts: [
      {
        url: "https://artifacts.example.test/v2-sqlite/migrations.json",
        sha256: migrationManifestSha256,
        objectKey: "v2-sqlite/migration-manifest",
        grants,
      },
      {
        url: "https://artifacts.example.test/v2-sqlite/0001.sql",
        sha256: migrationSha256,
        objectKey: "v2-sqlite/migration-sql",
        grants,
      },
    ],
  },
};

try {
  const store = createSelfhostV2SQLiteStore({
    root: join(root, "sqlite-custody"),
    sql,
    targetKey: TARGET,
    now: clock,
  });
  const migrationSource = createV2HeldArtifactSource({
    objects,
    entries: config.sqliteMigrationSet.heldArtifacts,
  });
  const migrationCustody = createSQLiteMigrationSetCustody({
    sql,
    source: migrationSource,
    now: clock,
  });
  let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
  composition = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "v2-worker-owners"),
    targetKey: TARGET,
    workerdBinary: binary,
    sqliteBinding: {
      store,
      signingKey: new Uint8Array(32).fill(0x58),
      privatePort,
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
        [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }),
        [SQLITE_MIGRATION_APPLICATION_FORM_URL]: createSQLiteMigrationApplicationForm({
          sql,
          store,
          custody: migrationCustody,
          targetKey: TARGET,
          now: clock,
        }),
      };
    },
  });
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: ORIGIN,
    appFetch: (request) => app.fetch(request),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/__fixture/close-private-bindings") {
        try {
          await composition.closePrivateBindingServices();
          return new Response(null, { status: 204 });
        } catch {
          return new Response(null, { status: 409 });
        }
      }
      const match = /^\/__fixture\/serve\/([0-9a-f-]{36})(\/.*)?$/u.exec(
        new URL(request.url).pathname,
      );
      if (match) {
        const workerUid = match[1] as string;
        const path = match[2] ?? "/";
        const owner = await composition.ownerForWorkerUid(workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: workerUid,
          targetKey: TARGET,
        });
        if (serving.kind !== "serving" || serving.hostnames.length !== 1)
          return new Response(null, { status: 503 });
        return await owner.fetch(
          new Request(`https://${serving.hostnames[0]}${path}${new URL(request.url).search}`),
        );
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
  const code = error instanceof WorkerdWorkerRuntimeOwnerError ? error.code : "startup_refused";
  process.stdout.write(`${JSON.stringify({ stage: "startup_error", code })}\n`);
  database.close();
  process.exitCode = 1;
}
