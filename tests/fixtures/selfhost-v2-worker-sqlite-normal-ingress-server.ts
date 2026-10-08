// Test-only buildApp Host. Management uses the normal v2 ingress; tenant SQL
// uses the production Endpoint boot/frontend/owner against loopback TLS.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createSelfhostV2SQLiteStore } from "../../src/providers/selfhost-v2-sqlite-store.ts";
import { createSelfhostTakoformV2Ingress } from "../../src/selfhost-takoform-v2-ingress.ts";
import { createSelfhostV2WorkerComposition } from "../../src/selfhost-v2-worker-composition.ts";
import { createSelfhostV2WorkerEndpointBoot } from "../../src/selfhost-v2-worker-endpoint-boot.ts";
import { verifySelfhostV2WorkerEndpointHttpsSni } from "../../src/selfhost-v2-worker-endpoint-https.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_DATABASE_FORM_URL } from "../../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../../src/takoform-v2/forms/sqlite-database-backend.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationForm } from "../../src/takoform-v2/forms/sqlite-migration-application-backend.ts";
import { createSQLiteMigrationApplicationNativePort } from "../../src/takoform-v2/forms/sqlite-migration-application-native.ts";
import { createSQLiteMigrationSetCustody } from "../../src/takoform-v2/forms/sqlite-migration-set-backend.ts";

const [
  root,
  binary,
  organizationId,
  manifestSha256,
  codeSha256,
  migrationManifestSha256,
  migrationSha256,
  privatePortText,
  certPath,
  keyPath,
] = process.argv.slice(2);
const privatePort = Number(privatePortText);
if (
  !root ||
  !binary ||
  !organizationId ||
  !manifestSha256 ||
  !codeSha256 ||
  !migrationManifestSha256 ||
  !migrationSha256 ||
  !certPath ||
  !keyPath ||
  !Number.isSafeInteger(privatePort) ||
  privatePort < 1 ||
  privatePort > 65_535
)
  throw new Error("normal SQLite ingress fixture arguments are missing");

const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const SUFFIX = "workers.native.test";
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
  const stagingRoot = join(root, "sql-input-staging");
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const migrationCustody = createSQLiteMigrationSetCustody({
    sql,
    source: createV2HeldArtifactSource({
      objects,
      entries: config.sqliteMigrationSet.heldArtifacts,
    }),
    now: clock,
  });
  let endpointBoot: Awaited<ReturnType<typeof createSelfhostV2WorkerEndpointBoot>> | undefined;
  const composition = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "v2-worker-owners"),
    targetKey: TARGET,
    workerdBinary: binary,
    sqliteBinding: {
      store,
      stagingRoot,
      signingKey: new Uint8Array(32).fill(0x58),
      privatePort,
    },
    endpoint: {
      assignHostname(input) {
        if (!endpointBoot) throw new Error("Endpoint boot unavailable");
        return endpointBoot.endpoint.assignHostname(input);
      },
      observeTls(input, execution) {
        if (!endpointBoot) throw new Error("Endpoint boot unavailable");
        return endpointBoot.endpoint.observeTls(input, execution);
      },
      observeRouteAbsent(input, execution) {
        if (!endpointBoot) throw new Error("Endpoint boot unavailable");
        const observe = endpointBoot.endpoint.observeRouteAbsent;
        if (!observe) throw new Error("Endpoint route-absence witness unavailable");
        return observe(input, execution);
      },
    },
  });
  const restored = await composition.restoreOwners();
  let httpsPort: number | undefined;
  endpointBoot = await createSelfhostV2WorkerEndpointBoot({
    sql,
    targetKey: TARGET,
    publicOrigin: ORIGIN,
    configuration: { workerEndpointSuffix: SUFFIX, port: 443 },
    certificateChain: readFileSync(certPath, "utf8"),
    privateKey: readFileSync(keyPath, "utf8"),
    publicationState: composition.endpointPublicationState,
    ownerForWorkerUid: (uid) => composition.ownerForWorkerUid(uid),
    factories: {
      serve(options) {
        const actual = Bun.serve({ ...options, hostname: "127.0.0.1", port: 0 });
        httpsPort = actual.port;
        return { port: 443, stop: (force) => actual.stop(force) };
      },
      async proveSni(input) {
        if (!httpsPort) throw new Error("loopback TLS listener unavailable");
        await verifySelfhostV2WorkerEndpointHttpsSni({
          ...input,
          host: "127.0.0.1",
          port: httpsPort,
        });
      },
    },
  });
  if (!httpsPort) throw new Error("loopback TLS listener did not bind");
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
          migrationPort: createSQLiteMigrationApplicationNativePort(store),
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
  const management = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => ingress(request),
  });
  setInterval(() => {
    void app.tickTakoformV2().catch(() => {
      process.stdout.write(`${JSON.stringify({ stage: "tick_error" })}\n`);
    });
  }, 10);
  process.stdout.write(
    `${JSON.stringify({
      stage: "listening",
      port: management.port,
      httpsPort,
      pid: process.pid,
      restored,
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      stage: "startup_error",
      code: error instanceof Error ? error.message : "unknown",
    })}\n`,
  );
  database.close();
  process.exitCode = 1;
}
