import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type {
  TakoformArtifactManifest,
  TakoformArtifactTransport,
} from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "../src/takoform/types.ts";
import { TakoformHostError } from "../src/takoform/types.ts";
import {
  type ConfiguredHistoricalHostOptions,
  createConfiguredHistoricalTakoformHost,
} from "./helpers/historical-takoform-host.ts";

const LANE = "/apis/forms.takoform.com/v1";
const TENANT_ID = "tenant-sqlite-saga";
const PRINCIPAL_ID = "principal-sqlite-saga";
const SQL = new TextEncoder().encode("CREATE TABLE saga_probe (id TEXT PRIMARY KEY);");
const SQL_DIGEST = `sha256:${createHash("sha256").update(SQL).digest("hex")}` as const;
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}` as const;
const MANIFEST: TakoformArtifactManifest = {
  apiVersion: "artifacts.takoform.com/v1alpha1",
  kind: "MigrationBundle",
  files: [
    {
      path: "0001_saga_probe.sql",
      mediaType: "application/sql",
      size: SQL.byteLength,
      digest: SQL_DIGEST,
    },
  ],
};
const catalog = currentTakoformCandidates();
const forms = requiredForms(
  "SQLiteDatabase",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
  "AtLeastOnceQueue",
);
const databaseForm = form("SQLiteDatabase");
const setForm = form("SQLiteMigrationSet");
const applicationForm = form("SQLiteMigrationApplication");
const queueForm = form("AtLeastOnceQueue");
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SQLiteMigrationApplication provider saga", () => {
  test("consumes final create authority before dispatching a migration suffix", async () => {
    const events: string[] = [];
    const memory = new InMemoryTakoformResourceDriver();
    const driver = migrationDriver(memory, {
      async applySuffix(input) {
        events.push("applySuffix");
        await memory.sqliteMigrations.applySuffix(input);
      },
    });
    const { host } = harness(driver, async (token) =>
      token === "Bearer provision"
        ? {
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            scope: {
              space: "main",
              formRef: applicationForm.identity.formRef,
              resourceName: "schema",
              mode: "provision" as const,
              claimCreate: async () => {
                events.push("beforeCreate");
                throw new TakoformHostError("form_unavailable", 503);
              },
            },
          }
        : principal(token),
    );
    await seedDatabaseAndSet(host);
    const desired = applicationDesired("schema");
    const review = await prepare(host, desired, "admin");

    const response = await apply(host, desired, review, "claim-before-sql", "provision");

    expect(response?.status).toBe(503);
    expect(events).toEqual(["beforeCreate"]);
  });

  test("refreshes revocation authority after planning and before dispatching a suffix", async () => {
    const events: string[] = [];
    const memory = new InMemoryTakoformResourceDriver();
    const driver = migrationDriver(memory, {
      async applySuffix(input) {
        events.push("applySuffix");
        await memory.sqliteMigrations.applySuffix(input);
      },
    });
    let applicationAuthorityReads = 0;
    const { host } = harness(driver, undefined, {
      async resolve({ form: checkedForm }) {
        if (checkedForm.identity.formRef.kind === "SQLiteMigrationApplication") {
          applicationAuthorityReads += 1;
          events.push(`authority:${applicationAuthorityReads}`);
          if (applicationAuthorityReads === 3) {
            return { executable: false, activated: false, availableToPrincipal: false };
          }
        }
        return { executable: true, activated: true, availableToPrincipal: true };
      },
    });
    await seedDatabaseAndSet(host);
    const desired = applicationDesired("revoked-schema");
    const review = await prepare(host, desired, "admin");

    const response = await apply(host, desired, review, "revoked-before-sql", "admin");

    expect(response?.status).toBe(503);
    expect(events).toEqual(["authority:1", "authority:2", "authority:3"]);
  });

  test("retains one dispatched saga after lost acknowledgement and recovers from the ledger without rerunning SQL", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const suffixInputs: Array<Parameters<typeof memory.sqliteMigrations.applySuffix>[0]> = [];
    const applicationCalls: Array<{
      readonly operationId: string;
      readonly operationMode: "initial" | "recovery" | undefined;
      readonly executionAuthority: Parameters<
        TakoformResourceDriver["apply"]
      >[0]["executionAuthority"];
    }> = [];
    let loseAcknowledgement = true;
    let failRecoveryRead = true;
    let applicationDispatched = false;
    const driver = migrationDriver(memory, {
      async readLedger(input) {
        if (applicationDispatched && failRecoveryRead) {
          failRecoveryRead = false;
          throw new TakoformHostError("backend_unavailable", 503);
        }
        return await memory.sqliteMigrations.readLedger(input);
      },
      async applySuffix(input) {
        suffixInputs.push(input);
        await memory.sqliteMigrations.applySuffix(input);
        applicationDispatched = true;
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new TakoformHostError("backend_unavailable", 503);
        }
      },
      async apply(input) {
        if (input.form.identity.formRef.kind === "SQLiteMigrationApplication") {
          applicationCalls.push({
            operationId: input.operationId,
            operationMode: input.operationMode,
            executionAuthority: input.executionAuthority,
          });
        }
        return await memory.apply(input);
      },
    });
    const { host, database } = harness(driver);
    await seedDatabaseAndSet(host);
    const desired = applicationDesired("schema");
    const review = await prepare(host, desired, "admin");

    const lost = await apply(host, desired, review, "lost-ack-initial", "admin");
    expect(lost?.status).toBe(503);
    expect(suffixInputs).toHaveLength(1);
    expect(database.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas").get()).toEqual({
      n: 1,
    });
    const sagaAfterLost = dispatchedSaga(database);
    expect(sagaAfterLost).toMatchObject({
      phase: "planned",
      provider_outcome: "indeterminate",
      receipt_json: null,
    });
    expect(suffixInputs[0]).toMatchObject({
      operationId: sagaAfterLost?.operation_id,
      operationMode: "initial",
      executionAuthority: {
        tenantId: TENANT_ID,
        resourceUid: sagaAfterLost?.resource_uid,
        fingerprint: sagaAfterLost?.fingerprint,
      },
    });
    expect(
      database
        .query("SELECT phase FROM tf_resource_provider_effects WHERE resource_uid = ?")
        .all(String(dispatchedSaga(database)?.resource_uid)),
    ).toContainEqual({ phase: "dispatched" });

    const unreadable = await apply(host, desired, review, "lost-ack-unreadable", "admin");
    expect(unreadable?.status).toBe(503);
    expect(suffixInputs).toHaveLength(1);
    expect(dispatchedSaga(database)).toMatchObject({
      phase: "planned",
      provider_outcome: "indeterminate",
      receipt_json: null,
    });

    const recovered = await apply(host, desired, review, "lost-ack-recovery", "admin");
    expect(recovered?.status).toBe(201);
    expect(suffixInputs).toHaveLength(1);
    expect(applicationCalls).toHaveLength(1);
    expect(applicationCalls[0]).toMatchObject({
      operationId: sagaAfterLost?.operation_id,
      operationMode: "recovery",
      executionAuthority: {
        tenantId: TENANT_ID,
        resourceUid: sagaAfterLost?.resource_uid,
      },
    });
    expect(applicationCalls[0]?.executionAuthority.leaseToken).not.toBe(
      suffixInputs[0]?.executionAuthority.leaseToken,
    );
    expect(database.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas").get()).toEqual({
      n: 0,
    });
  });

  test("one live saga lease fences a concurrent suffix dispatch", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let releaseSuffix!: () => void;
    const suffixReleased = new Promise<void>((resolve) => {
      releaseSuffix = resolve;
    });
    let suffixEntered!: () => void;
    const enteredSuffix = new Promise<void>((resolve) => {
      suffixEntered = resolve;
    });
    const suffixAuthorities: Array<
      Parameters<typeof memory.sqliteMigrations.applySuffix>[0]["executionAuthority"]
    > = [];
    const driver = migrationDriver(memory, {
      async applySuffix(input) {
        suffixAuthorities.push(input.executionAuthority);
        suffixEntered();
        await suffixReleased;
        await memory.sqliteMigrations.applySuffix(input);
      },
    });
    const { host } = harness(driver);
    await seedDatabaseAndSet(host);
    const desired = applicationDesired("lease-fenced");
    const review = await prepare(host, desired, "admin");

    const first = apply(host, desired, review, "lease-fenced", "admin");
    await enteredSuffix;
    const contended = await apply(host, desired, review, "lease-fenced", "admin");
    expect(contended?.status).toBe(503);
    expect(suffixAuthorities).toHaveLength(1);

    releaseSuffix();
    expect((await first)?.status).toBe(201);
    expect(suffixAuthorities).toHaveLength(1);
  });

  test("import recovery preserves one saga operation and switches only its execution mode", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const suffixInputs: Array<Parameters<typeof memory.sqliteMigrations.applySuffix>[0]> = [];
    const importInputs: Array<Parameters<NonNullable<TakoformResourceDriver["import"]>>[0]> = [];
    let loseAcknowledgement = true;
    const driver = migrationDriver(memory, {
      async applySuffix(input) {
        suffixInputs.push(input);
        await memory.sqliteMigrations.applySuffix(input);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new TakoformHostError("backend_unavailable", 503);
        }
      },
      async import(input) {
        importInputs.push(input);
        return await memory.import(input);
      },
    });
    const { host, database } = harness(driver);
    await seedDatabaseAndSet(host);
    const desired = {
      ...applicationDesired("imported-schema"),
      nativeId: "native-imported-schema",
    };

    const lost = await importResource(host, desired, "import-recovery", "admin");
    expect(lost?.status).toBe(503);
    const saga = dispatchedSaga(database);
    expect(saga).toMatchObject({ provider_outcome: "indeterminate" });

    const recovered = await importResource(host, desired, "import-recovery", "admin");
    expect(recovered?.status).toBe(201);
    expect(suffixInputs).toHaveLength(1);
    expect(suffixInputs[0]).toMatchObject({
      operationId: saga?.operation_id,
      operationMode: "initial",
    });
    expect(importInputs).toHaveLength(1);
    expect(importInputs[0]).toMatchObject({
      operationId: saga?.operation_id,
      operationMode: "recovery",
    });
  });

  test("update recovery forwards one operation id with initial then recovery authority", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    const updateInputs: Array<Parameters<TakoformResourceDriver["apply"]>[0]> = [];
    let loseAcknowledgement = true;
    const driver = migrationDriver(memory, {
      async apply(input) {
        if (input.previous) {
          updateInputs.push(input);
          if (loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new TakoformHostError("backend_unavailable", 503);
          }
        }
        return await memory.apply(input);
      },
    });
    const { host, database } = harness(driver);
    const created = await create(
      host,
      queueForm,
      "updates",
      { messageRetentionSeconds: 3_600 },
      "create-update-target",
    );
    const desired = desiredResource(queueForm, "updates", { messageRetentionSeconds: 7_200 });
    const review = await prepare(host, desired, "admin", "1");

    const lost = await update(host, desired, review, "update-recovery", "admin", "1");
    expect(lost?.status).toBe(503);
    const saga = dispatchedSaga(database);
    expect(saga).toMatchObject({
      resource_uid: created.metadata.uid,
      provider_outcome: "indeterminate",
    });
    if (!saga) throw new Error("update saga was not retained");
    const sagaOperationId = String(saga.operation_id);

    const recovered = await update(host, desired, review, "update-recovery", "admin", "1");
    expect(recovered?.status).toBe(200);
    expect(updateInputs).toHaveLength(2);
    expect(
      updateInputs.map(({ operationId, operationMode }) => ({ operationId, operationMode })),
    ).toEqual([
      { operationId: sagaOperationId, operationMode: "initial" },
      { operationId: sagaOperationId, operationMode: "recovery" },
    ]);
    expect(updateInputs[0]?.executionAuthority.resourceUid).toBe(created.metadata.uid);
    expect(updateInputs[1]?.executionAuthority.resourceUid).toBe(created.metadata.uid);
    expect(updateInputs[0]?.executionAuthority.leaseToken).not.toBe(
      updateInputs[1]?.executionAuthority.leaseToken,
    );
  });
});

function harness(
  driver: TakoformResourceDriver,
  authenticate: (authorization: string | null) => Promise<ReturnType<typeof principal>> = async (
    authorization,
  ) => principal(authorization),
  availability?: ConfiguredHistoricalHostOptions["availability"],
) {
  const database = new Database(":memory:");
  databases.push(database);
  migrateSqlite(database);
  let ids = 0;
  return {
    database,
    host: createConfiguredHistoricalTakoformHost({
      sql: createSqliteSql(database),
      objects: createMemoryObjectStore(),
      forms,
      bindings: catalog.bindings,
      driver,
      artifacts,
      authenticate: async (request) => await authenticate(request.headers.get("authorization")),
      ...(availability ? { availability } : {}),
      routes: {
        hostApiVersion: "forms.takoform.com/v1",
        apiPath: LANE,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        bodyGenerationFence: true,
        reviewSpecDigest: true,
        omitObservedStatus: true,
      },
      randomId: () => `sqlite-saga-${++ids}`,
    }),
  };
}

function migrationDriver(
  memory: InMemoryTakoformResourceDriver,
  overrides: {
    readonly readLedger?: typeof memory.sqliteMigrations.readLedger;
    readonly applySuffix?: typeof memory.sqliteMigrations.applySuffix;
    readonly apply?: TakoformResourceDriver["apply"];
    readonly import?: NonNullable<TakoformResourceDriver["import"]>;
  },
): TakoformResourceDriver {
  return {
    apply: overrides.apply ?? ((input) => memory.apply(input)),
    observe: (input) => memory.observe(input),
    delete: (input) => memory.delete(input),
    import: overrides.import ?? ((input) => memory.import(input)),
    sqliteMigrations: {
      readLedger: overrides.readLedger ?? memory.sqliteMigrations.readLedger,
      applySuffix: overrides.applySuffix ?? memory.sqliteMigrations.applySuffix,
    },
  };
}

async function seedDatabaseAndSet(host: { handle(request: Request): Promise<Response | null> }) {
  await create(host, databaseForm, "database", {}, "create-database");
  await create(
    host,
    setForm,
    "migrations",
    { manifestDigest: MANIFEST_DIGEST },
    "create-migration-set",
  );
}

function applicationDesired(name: string) {
  return desiredResource(applicationForm, name, {
    database: reference(databaseForm, "database"),
    migrationSet: reference(setForm, "migrations"),
  });
}

async function create(
  host: { handle(request: Request): Promise<Response | null> },
  resourceForm: InstalledTakoformForm,
  name: string,
  spec: JsonObject,
  key: string,
): Promise<TakoformStoredResource> {
  const body = desiredResource(resourceForm, name, spec);
  const review = await prepare(host, body, "admin");
  const response = await apply(host, body, review, key, "admin");
  expect(response?.status).toBe(201);
  return (await response?.json()) as TakoformStoredResource;
}

async function prepare(
  host: { handle(request: Request): Promise<Response | null> },
  body: ReturnType<typeof desiredResource>,
  token: string,
  expectedGeneration?: string,
) {
  const response = await host.handle(
    request(`${LANE}/resources/prepare`, token, {
      method: "POST",
      ...(expectedGeneration
        ? { headers: { "takoform-expected-generation": expectedGeneration } }
        : {}),
      body: JSON.stringify(body),
    }),
  );
  expect(response?.status).toBe(200);
  if (!response) throw new Error("prepare returned no response");
  return ((await response.json()) as { review: Record<string, string> }).review;
}

async function apply(
  host: { handle(request: Request): Promise<Response | null> },
  body: ReturnType<typeof desiredResource>,
  review: Record<string, string>,
  key: string,
  token: string,
) {
  return await host.handle(
    request(
      `${LANE}/resources/${body.form.formRef.apiVersion}/${body.kind}/${body.metadata.name}`,
      token,
      {
        method: "PUT",
        headers: { "idempotency-key": key, "if-none-match": "*" },
        body: JSON.stringify({ ...body, review }),
      },
    ),
  );
}

async function update(
  host: { handle(request: Request): Promise<Response | null> },
  body: ReturnType<typeof desiredResource>,
  review: Record<string, string>,
  key: string,
  token: string,
  expectedGeneration: string,
) {
  return await host.handle(
    request(
      `${LANE}/resources/${body.form.formRef.apiVersion}/${body.kind}/${body.metadata.name}`,
      token,
      {
        method: "PUT",
        headers: {
          "idempotency-key": key,
          "takoform-expected-generation": expectedGeneration,
        },
        body: JSON.stringify({ ...body, review }),
      },
    ),
  );
}

async function importResource(
  host: { handle(request: Request): Promise<Response | null> },
  body: ReturnType<typeof desiredResource> & { readonly nativeId: string },
  key: string,
  token: string,
) {
  return await host.handle(
    request(
      `${LANE}/resources/${body.form.formRef.apiVersion}/${body.kind}/${body.metadata.name}/import`,
      token,
      {
        method: "POST",
        headers: { "idempotency-key": key, "if-none-match": "*" },
        body: JSON.stringify(body),
      },
    ),
  );
}

function desiredResource(resourceForm: InstalledTakoformForm, name: string, spec: JsonObject) {
  return {
    apiVersion: resourceForm.identity.formRef.apiVersion,
    kind: resourceForm.identity.formRef.kind,
    form: { formRef: resourceForm.identity.formRef },
    metadata: { name, space: "main" },
    spec,
  };
}

function reference(resourceForm: InstalledTakoformForm, name: string) {
  return {
    apiVersion: resourceForm.identity.formRef.apiVersion,
    kind: resourceForm.identity.formRef.kind,
    name,
  };
}

function request(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://host.invalid${path}`, { ...init, headers });
}

function principal(authorization: string | null) {
  return authorization === "Bearer admin"
    ? { tenantId: TENANT_ID, principalId: PRINCIPAL_ID }
    : null;
}

function form(kind: string): InstalledTakoformForm {
  const installed = forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!installed) throw new Error(`missing ${kind} Form`);
  return installed;
}

function requiredForms(...kinds: readonly string[]): readonly InstalledTakoformForm[] {
  return kinds.map((kind) => {
    const installed = catalog.forms.find((candidate) => candidate.identity.formRef.kind === kind);
    if (!installed) throw new Error(`missing ${kind} Form`);
    return installed;
  });
}

const artifacts: TakoformArtifactTransport = {
  async handle() {
    return null;
  },
  async resolveManifest(_tenantId, digest) {
    return digest === MANIFEST_DIGEST ? MANIFEST : null;
  },
  async resolveBlob(_tenantId, digest) {
    return digest === SQL_DIGEST ? SQL : null;
  },
};

function dispatchedSaga(database: Database): Record<string, unknown> | null {
  return database
    .query(
      `SELECT operation_id, resource_uid, fingerprint, phase, provider_outcome, receipt_json
       FROM tf_provider_mutation_sagas`,
    )
    .get() as Record<string, unknown> | null;
}
