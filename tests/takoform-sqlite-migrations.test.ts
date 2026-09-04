import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createCatalog,
  createEphemeralSql,
  createLedger,
  createResourceDeploymentStore,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
  TakoformHostError,
  type TakoformResourceDriver,
  type TakoformStoredResource,
} from "../src/index.ts";
import type { JsonObject } from "../src/ports.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type { Provider } from "../src/provider-port.ts";
import type { TakoformArtifactManifest } from "../src/takoform/artifacts.ts";
import {
  applySqliteMigrationApplication,
  prepareSqliteMigrationApplication,
  sqliteMigrationCondition,
} from "../src/takoform/sqlite-migrations.ts";

const apiVersion = "edge.forms.takoform.com/v1beta1";
const applicationForm: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion,
      kind: "SQLiteMigrationApplication",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"1".repeat(64)}`,
    },
  },
  role: "attachment",
  desiredSchema: {},
  operations: ["create", "read", "delete"],
};
const database = resource("SQLiteDatabase", "database", "uid_database", {});
const firstSet = resource("SQLiteMigrationSet", "first", "uid_first", {
  manifestDigest: `sha256:${"a".repeat(64)}`,
});
const secondSet = resource("SQLiteMigrationSet", "second", "uid_second", {
  manifestDigest: `sha256:${"b".repeat(64)}`,
});
const firstSqlBytes = new TextEncoder().encode("CREATE TABLE first_migration (id TEXT);");
const secondSqlBytes = new TextEncoder().encode("CREATE TABLE second_migration (id TEXT);");
const firstSql = digest(firstSqlBytes);
const secondSql = digest(secondSqlBytes);
const manifests = new Map<string, TakoformArtifactManifest>([
  [
    String(firstSet.spec.manifestDigest),
    migrationManifest([{ path: "0001.sql", digest: firstSql }]),
  ],
  [
    String(secondSet.spec.manifestDigest),
    migrationManifest([
      { path: "0001.sql", digest: firstSql },
      { path: "0002.sql", digest: secondSql },
    ]),
  ],
]);

test("SQLite migration applications append a durable prefix and render older sets Reconciling", async () => {
  const driver = new InMemoryTakoformResourceDriver();
  const first = context(firstSet, driver);
  await execute(first, "op-first", "initial");
  expect(await sqliteMigrationCondition(first)).toBeNull();

  const second = context(secondSet, driver);
  const applied: Array<Parameters<typeof driver.sqliteMigrations.applySuffix>[0]> = [];
  const originalApply = driver.sqliteMigrations.applySuffix;
  driver.sqliteMigrations.applySuffix = async (input) => {
    applied.push(input);
    await originalApply(input);
  };
  await execute(second, "op-second", "recovery");
  expect(applied).toHaveLength(1);
  expect(applied[0]).toMatchObject({
    operationId: "op-second",
    operationMode: "recovery",
    expectedPrefix: [{ path: "0001.sql", digest: firstSql }],
    migrations: [{ path: "0002.sql", digest: secondSql }],
  });
  expect(await sqliteMigrationCondition(second)).toBeNull();
  expect(await sqliteMigrationCondition(first)).toMatchObject({
    type: "Ready",
    status: "False",
    reason: "Reconciling",
  });

  const rewritten = resource("SQLiteMigrationSet", "rewritten", "uid_rewritten", {
    manifestDigest: `sha256:${"e".repeat(64)}`,
  });
  manifests.set(
    String(rewritten.spec.manifestDigest),
    migrationManifest([{ path: "renamed.sql", digest: firstSql }]),
  );
  await expect(
    execute(context(rewritten, driver), "op-rewritten", "initial"),
  ).rejects.toMatchObject({
    code: "migration_required",
    status: 409,
  });
});

test("recovery keeps the full intent while deriving a new remainder from an advanced exact prefix", async () => {
  const memory = new InMemoryTakoformResourceDriver();
  let ledger: readonly { readonly path: string; readonly digest: `sha256:${string}` }[] = [];
  let loseFirstAcknowledgement = true;
  const calls: Array<Parameters<typeof memory.sqliteMigrations.applySuffix>[0]> = [];
  const driver: TakoformResourceDriver = {
    apply: (input) => memory.apply(input),
    observe: (input) => memory.observe(input),
    delete: (input) => memory.delete(input),
    import: (input) => memory.import(input),
    sqliteMigrations: {
      async readLedger() {
        return structuredClone(ledger);
      },
      async applySuffix(input) {
        calls.push(input);
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false;
          throw new TakoformHostError("backend_unavailable", 503);
        }
        ledger = [
          ...input.expectedPrefix,
          ...input.migrations.map(({ path, digest }) => ({ path, digest })),
        ];
      },
    },
  };
  const value = context(secondSet, driver);
  const prepared = await prepareSqliteMigrationApplication(value);
  const executionAuthority = {
    tenantId: value.tenantId,
    resourceUid: "uid_application_a",
    leaseToken: "pmlease-a-initial",
    fingerprint: "application-a-fingerprint",
  };

  await expect(
    applySqliteMigrationApplication({
      tenantId: value.tenantId,
      operationId: "op-application-a",
      operationMode: "initial",
      executionAuthority,
      prepared,
      driver,
    }),
  ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });

  // Another completed application may legitimately advance the retained DB
  // history while A has no lease or claim. A's stable intent remains [m1,m2].
  ledger = [{ path: "0001.sql", digest: firstSql }];
  await applySqliteMigrationApplication({
    tenantId: value.tenantId,
    operationId: "op-application-a",
    operationMode: "recovery",
    executionAuthority: { ...executionAuthority, leaseToken: "pmlease-a-recovery" },
    prepared,
    driver,
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    operationId: "op-application-a",
    operationMode: "initial",
    expectedPrefix: [],
    migrations: [
      { path: "0001.sql", digest: firstSql },
      { path: "0002.sql", digest: secondSql },
    ],
  });
  expect(calls[1]).toMatchObject({
    operationId: "op-application-a",
    operationMode: "recovery",
    expectedPrefix: [{ path: "0001.sql", digest: firstSql }],
    migrations: [{ path: "0002.sql", digest: secondSql }],
  });
  expect(calls[0]?.desired).toEqual(calls[1]?.desired);
  expect(ledger).toEqual([
    { path: "0001.sql", digest: firstSql },
    { path: "0002.sql", digest: secondSql },
  ]);
});

test("the Provider driver binds ledger IO to the exact active database realization", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-04T00:00:00.000Z");
  const deployments = createResourceDeploymentStore(sql, clock);
  await deployments.create({
    tenantId: "tenant-a",
    id: "dep-database-a",
    resourceUid: database.metadata.uid,
    offeringId: "provider-a.sqlite",
    providerPackRef: "provider-a",
    providerInstallationRef: "provider-a.primary",
    nativeId: "sqlite:database-a",
    state: "active",
    observed: {},
    outputs: {},
  });
  const readCalls: Array<Parameters<NonNullable<Provider["sqliteMigrations"]>["readLedger"]>[0]> =
    [];
  const applyCalls: Array<Parameters<NonNullable<Provider["sqliteMigrations"]>["applySuffix"]>[0]> =
    [];
  const provider: Provider = {
    id: "provider-a",
    offerings: [
      {
        id: "provider-a.sqlite",
        kind: "sqlite_database",
        displayName: "SQLite database",
        form: database.form.formRef,
        providedInterfaces: [],
        bindingRefs: [],
        capabilities: ["create", "delete", "import", "observe"],
      },
    ],
    async apply() {
      throw new Error("not used");
    },
    async observe() {
      throw new Error("not used");
    },
    async delete() {
      throw new Error("not used");
    },
    sqliteMigrations: {
      async readLedger(input) {
        readCalls.push(input);
        return { ok: true, value: [] };
      },
      async applySuffix(input) {
        applyCalls.push(input);
        return { ok: true, value: undefined };
      },
    },
  };
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([]),
    ledger: createLedger(sql, clock),
    deployments,
  });
  const sqlite = driver.sqliteMigrations;
  if (!sqlite) throw new Error("Provider driver must expose SQLite migrations");
  const executionAuthority = {
    tenantId: "tenant-a",
    resourceUid: "uid-application-a",
    leaseToken: "pmlease-application-a",
    fingerprint: "application-a-fingerprint",
  };
  const desired = [{ path: "0001.sql", digest: firstSql, sql: firstSqlBytes }];

  expect(await sqlite.readLedger({ tenantId: "tenant-a", database })).toEqual([]);
  await sqlite.applySuffix({
    operationId: "op-application-a",
    operationMode: "recovery",
    executionAuthority,
    tenantId: "tenant-a",
    database,
    desired,
    expectedPrefix: [],
    migrations: desired,
  });

  expect(readCalls).toEqual([
    {
      nativeId: "sqlite:database-a",
      target: {
        tenantId: "tenant-a",
        resourceUid: database.metadata.uid,
        incarnationId: "dep-database-a",
        generation: database.metadata.generation,
      },
    },
  ]);
  expect(applyCalls).toEqual([
    {
      operationId: "op-application-a",
      operationMode: "recovery",
      executionAuthority,
      nativeId: "sqlite:database-a",
      target: {
        resourceUid: database.metadata.uid,
        incarnationId: "dep-database-a",
        generation: database.metadata.generation,
      },
      desired,
      expectedPrefix: [],
      migrations: desired,
    },
  ]);
});

async function execute(
  value: ReturnType<typeof context>,
  operationId: string,
  operationMode: "initial" | "recovery",
) {
  const prepared = await prepareSqliteMigrationApplication(value);
  await applySqliteMigrationApplication({
    tenantId: value.tenantId,
    operationId,
    operationMode,
    executionAuthority: {
      tenantId: value.tenantId,
      resourceUid: "uid_application",
      leaseToken: "pmlease-test",
      fingerprint: "test-fingerprint",
    },
    prepared,
    driver: value.driver,
  });
}

function context(set: TakoformStoredResource, driver: TakoformResourceDriver) {
  return {
    tenantId: "tenant-a",
    space: "conformance",
    form: applicationForm,
    relations: [relation("/database", database), relation("/migrationSet", set)],
    store: {
      async readResource(address: { readonly kind: string; readonly name: string }) {
        return (
          [database, set].find(
            (candidate) =>
              candidate.kind === address.kind && candidate.metadata.name === address.name,
          ) ?? null
        );
      },
    },
    artifacts: {
      async resolveManifest(_tenantId: string, digest: string) {
        return manifests.get(digest) ?? null;
      },
      async resolveBlob(_tenantId: string, digest: string) {
        if (digest === firstSql) return firstSqlBytes;
        if (digest === secondSql) return secondSqlBytes;
        return null;
      },
    },
    driver,
  };
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function relation(pointer: string, target: TakoformStoredResource) {
  return {
    pointer,
    relation: pointer,
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.metadata.name,
    targetUid: target.metadata.uid,
    targetFormRef: target.form.formRef,
  };
}

function migrationManifest(
  files: readonly { readonly path: string; readonly digest: `sha256:${string}` }[],
): TakoformArtifactManifest {
  return {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "MigrationBundle",
    files: files.map((file) => ({
      ...file,
      mediaType: "application/sql",
      size: 9,
    })),
  };
}

function resource(
  kind: string,
  name: string,
  uid: string,
  spec: JsonObject,
): TakoformStoredResource {
  return {
    apiVersion,
    kind,
    form: {
      formRef: {
        apiVersion,
        kind,
        definitionVersion: "0.1.0",
        schemaDigest: `sha256:${"2".repeat(64)}`,
      },
    },
    metadata: { name, space: "conformance", uid, generation: "1", revision: "1" },
    spec,
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-08-19T00:00:00.000Z",
        },
      ],
    },
  };
}
