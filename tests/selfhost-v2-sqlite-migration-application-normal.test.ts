import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { SelfhostV2KvStore } from "../src/providers/selfhost-v2-kv-store.ts";
import type { SelfhostV2ObjectBucketStore } from "../src/providers/selfhost-v2-object-bucket-store.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import {
  createSelfhostV2WorkerComposition,
  type SelfhostV2ActorBootPort,
  type SelfhostV2WorkflowBootPort,
} from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { V2ApplicationConfig } from "../src/takoform-v2/config.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "normal-sqlite-database-and-application";
const SET_TARGET = "different-immutable-set-custody";

// No Worker Resource is admitted in this test. These inert unrelated boot ports
// satisfy the ordinary complete-Worker gate without manufacturing a Worker.
const inertForm: V2Form = {
  validateCreate() {},
  validateUpdate() {},
  backend: {
    id: "fixture-unused-boot-v1",
    targetKey: TARGET,
    async execute() {
      throw new Error("unrelated Worker boot Form must not execute");
    },
    async reconcile() {
      throw new Error("unrelated Worker boot Form must not reconcile");
    },
  },
};
const actorBoot = {
  prepare() {
    return {
      namespaceForm: inertForm,
      bindingAuthority: {
        resolveTarget() {
          throw new Error("unused Actor binding");
        },
      },
      forwardBoot: {
        openIncarnation() {
          throw new Error("unused Actor incarnation");
        },
      },
    };
  },
} as unknown as SelfhostV2ActorBootPort;
const workflowBoot = {
  prepare() {
    return {
      workflowForm: inertForm,
      bindingAuthority: {
        resolveTarget() {
          throw new Error("unused Workflow binding");
        },
      },
      forwardBoot: {
        openIncarnation() {
          throw new Error("unused Workflow incarnation");
        },
      },
      async pollWorkflowDue() {
        throw new Error("unused Workflow poll");
      },
      async runWorkflowOnce() {
        throw new Error("unused Workflow run");
      },
      async close() {},
    };
  },
} as unknown as SelfhostV2WorkflowBootPort;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function fixture(withMigrationSet: boolean) {
  const root = await mkdtemp(join(tmpdir(), "v2-normal-sqlite-application-"));
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createMemoryObjectStore();
  let nowMs = Date.now();
  const clock = () => new Date(nowMs);
  const identity = {
    async verify({ assertion }: { assertion: string }) {
      return {
        providerSubject: assertion,
        email: `${assertion}@example.test`,
        displayName: assertion,
      };
    },
  };
  const accounts = createAccounts({ sql, identity, clock });
  const session = await accounts.signIn({ provider: "google", assertion: "owner" });
  const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
  if (!actor) throw new Error("authenticated fixture owner missing");
  const organization = await accounts.createOrganization({ actor, name: "SQLite migration owner" });
  const other = await accounts.createOrganization({ actor, name: "Other organization" });
  const key = await accounts.createApiKey({
    actor,
    organizationId: organization.id,
    name: "writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3600,
  });
  const otherKey = await accounts.createApiKey({
    actor,
    organizationId: other.id,
    name: "foreign writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3600,
  });
  const grants = [{ principal: `org:${organization.id}`, space: organization.id }];
  const heldArtifacts: NonNullable<
    V2ApplicationConfig["sqliteMigrationSet"]
  >["heldArtifacts"][number][] = [];
  const artifacts = new Map<string, { url: string; sha256: string }>();
  async function hold(name: string, body: Uint8Array, mediaType: string) {
    const url = `https://artifacts.example.test/normal-sqlite/${name}`;
    const sha256 = (await bytesDigest(body)).slice(7);
    const objectKey = `normal-sqlite/${name}`;
    await objects.create(objectKey, body, { contentType: mediaType });
    heldArtifacts.push({ url, sha256, objectKey, grants });
    const artifact = { url, sha256 };
    artifacts.set(name, artifact);
    return artifact;
  }
  if (withMigrationSet) {
    const first = new TextEncoder().encode(
      "CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('once');",
    );
    const bad = new TextEncoder().encode(
      "INSERT INTO item VALUES ('rolled-back'); INSERT INTO missing VALUES (1);",
    );
    const repaired = new TextEncoder().encode("INSERT INTO item VALUES ('repaired');");
    const firstRef = await hold("0001.sql", first, "application/sql");
    const badRef = await hold("0002-bad.sql", bad, "application/sql");
    const repairedRef = await hold("0002-repaired.sql", repaired, "application/sql");
    const manifest = (second: { url: string; sha256: string }) =>
      new TextEncoder().encode(
        JSON.stringify({
          files: [
            { path: "migrations/0001.sql", ...firstRef, mediaType: "application/sql" },
            { path: "migrations/0002.sql", ...second, mediaType: "application/sql" },
          ],
        }),
      );
    await hold("bad.json", manifest(badRef), "application/json");
    await hold("repaired.json", manifest(repairedRef), "application/json");
  }
  const config: V2ApplicationConfig = {
    cursorSigningKey: new Uint8Array(32).fill(0x55),
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/authentication",
    workerBundle: { targetKey: TARGET, heldArtifacts: [] },
    staticAssetBundle: { targetKey: TARGET, heldArtifacts: [] },
    ...(withMigrationSet ? { sqliteMigrationSet: { targetKey: SET_TARGET, heldArtifacts } } : {}),
  };
  const store = createSelfhostV2SQLiteStore({
    root: join(root, "sqlite"),
    sql,
    targetKey: TARGET,
    now: clock,
  });
  await mkdir(join(root, "sqlite-input"), { mode: 0o700 });
  const ports: number[] = [];
  while (ports.length < 5) {
    const port = await unusedPort();
    if (!ports.includes(port)) ports.push(port);
  }
  const [sqlitePort, bucketPort, kvPort, producerPort, settlementPort] = ports as [
    number,
    number,
    number,
    number,
    number,
  ];
  const composition = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config,
    rootDirectory: join(root, "owners"),
    targetKey: TARGET,
    workerdBinary: "/fixture/unused-workerd",
    v2Actor: actorBoot,
    v2Workflow: workflowBoot,
    queueSettlement: {
      address: `127.0.0.1:${settlementPort}`,
      queueIdForUid() {
        throw new Error("unused Queue settlement");
      },
      bindingToken() {
        throw new Error("unused Queue settlement");
      },
    },
    sqliteBinding: {
      store,
      stagingRoot: join(root, "sqlite-input"),
      signingKey: new Uint8Array(32).fill(1),
      privatePort: sqlitePort,
    },
    v2ObjectBucketBinding: {
      store: {
        create() {},
        observe() {},
        delete() {},
        openBucket() {},
      } as unknown as SelfhostV2ObjectBucketStore,
      signingKey: new Uint8Array(32).fill(2),
      privatePort: bucketPort,
    },
    v2KvBinding: {
      store: {
        create() {},
        reconcileCreate() {},
        observe() {},
        delete() {},
        openNamespace() {},
      } as unknown as SelfhostV2KvStore,
      signingKey: new Uint8Array(32).fill(3),
      privatePort: kvPort,
    },
    v2QueueProducerBinding: {
      custody: {
        async admitV2Batch() {
          throw new Error("unused Queue producer");
        },
      } as never,
      signingKey: new Uint8Array(32).fill(4),
      privatePort: producerPort,
    },
  });
  expect(await composition.restoreOwners()).toEqual([]);
  const factory = composition.secretFreeFormFactory();
  const selected = factory({ sql, objects, clock });
  const app = buildApp({
    sql,
    objects,
    clock,
    identity,
    settlement: {
      async verify() {
        throw new Error("legacy settlement unavailable");
      },
    },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: config,
    v2FormFactory: factory,
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    replayKey?: string,
    generation?: number,
    secret = key.secret,
  ) =>
    app.fetch(
      new Request(`${ORIGIN}${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(replayKey ? { "idempotency-key": replayKey } : {}),
          ...(generation === undefined
            ? {}
            : { "takoform-expected-generation": String(generation) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  async function settled(id: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await app.tickTakoformV2();
      const response = await request(`/operations/${id}`);
      expect(response.status).toBe(200);
      const operation = (await response.json()) as {
        status: string;
        effect: string;
        error?: { code: string };
      };
      if (operation.status === "succeeded" || operation.status === "failed") return operation;
      if (!next || operation.status === "reconciling") nowMs += 1001;
    }
    throw new Error(`operation ${id} did not settle`);
  }
  async function create(form: string, name: string, spec: unknown) {
    const response = await request(
      "/resources",
      "POST",
      { form, space: organization.id, name, spec },
      `normal-sqlite-create-${name}-0001`,
    );
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { id: string; resourceUid: string };
    return { ...accepted, outcome: await settled(accepted.id) };
  }
  return {
    root,
    database,
    sql,
    store,
    app,
    composition,
    organization,
    other,
    key,
    otherKey,
    artifacts,
    selected,
    request,
    settled,
    create,
    async close() {
      await composition.suspendOwnersRetainingCustody();
      await composition.closePrivateBindingServices();
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("normal public Host composes SQLite Database, Set, and Application with partial repair", async () => {
  const f = await fixture(true);
  try {
    expect(f.selected[SQLITE_MIGRATION_APPLICATION_FORM_URL]).toBeDefined();
    expect(f.selected[SQLITE_MIGRATION_APPLICATION_FORM_URL]?.backend.targetKey).toBe(TARGET);
    const anonymous = await f.app.fetch(new Request(`${ORIGIN}${API}/resources`));
    expect(anonymous.status).toBe(401);
    const unsupported = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: f.other.id,
        name: "foreign",
        spec: {},
      },
      "foreign-space-application-0001",
    );
    expect(unsupported.status).toBe(403);
    const database = await f.create(SQLITE_DATABASE_FORM_URL, "database", {});
    expect(database.outcome).toMatchObject({ status: "succeeded", effect: "complete" });
    const acceptedSet = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: f.organization.id,
        name: "bad-set",
        spec: { artifact: f.artifacts.get("bad.json") },
      },
      "normal-sqlite-create-bad-set-0001",
    );
    expect(acceptedSet.status).toBe(202);
    const badSet = (await acceptedSet.json()) as { id: string; resourceUid: string };
    const unobservedRef = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: f.organization.id,
        name: "unobserved-set-ref",
        spec: {
          database: { resourceUid: database.resourceUid },
          migrationSet: { resourceUid: badSet.resourceUid },
        },
      },
      "unobserved-set-reference-0001",
    );
    expect(unobservedRef.status).toBe(409);
    expect(await f.settled(badSet.id)).toMatchObject({ status: "succeeded", effect: "complete" });
    const foreignDatabase = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_DATABASE_FORM_URL,
        space: f.other.id,
        name: "foreign-database",
        spec: {},
      },
      "foreign-database-create-0001",
      undefined,
      f.otherKey.secret,
    );
    expect(foreignDatabase.status).toBe(202);
    const foreignAccepted = (await foreignDatabase.json()) as { id: string; resourceUid: string };
    expect(await f.app.tickTakoformV2()).toMatchObject({
      id: foreignAccepted.id,
      status: "succeeded",
    });
    const foreignRef = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: f.organization.id,
        name: "foreign-ref",
        spec: {
          database: { resourceUid: foreignAccepted.resourceUid },
          migrationSet: { resourceUid: badSet.resourceUid },
        },
      },
      "foreign-database-reference-0001",
    );
    expect(foreignRef.status).toBe(409);
    const missingRef = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: f.organization.id,
        name: "missing-ref",
        spec: {
          database: { resourceUid: database.resourceUid },
          migrationSet: { resourceUid: "missing" },
        },
      },
      "missing-reference-application-0001",
    );
    expect(missingRef.status).toBe(409);
    const spec = {
      database: { resourceUid: database.resourceUid },
      migrationSet: { resourceUid: badSet.resourceUid },
    };
    const application = await f.create(
      SQLITE_MIGRATION_APPLICATION_FORM_URL,
      "partial-application",
      spec,
    );
    expect(application.outcome).toMatchObject({
      status: "failed",
      effect: "partial",
      error: { code: "migration_sql_error" },
    });
    const afterPartial = await f.store.withAuthorizedDatabase({
      resourceUid: database.resourceUid,
      stillAuthorized: async () => true,
      use(native) {
        return {
          rows: native.prepare("SELECT value FROM item").all(),
          ledger: native
            .prepare("SELECT sequence, path FROM _takoform_sqlite_migrations ORDER BY sequence")
            .all(),
        };
      },
    });
    expect(afterPartial).toEqual({
      rows: [{ value: "once" }],
      ledger: [{ sequence: 1, path: "migrations/0001.sql" }],
    });
    const deleteResponse = await f.request(
      `/resources/${application.resourceUid}`,
      "DELETE",
      undefined,
      "delete-partial-application-0001",
      1,
    );
    expect(deleteResponse.status).toBe(202);
    expect(await f.settled(((await deleteResponse.json()) as { id: string }).id)).toMatchObject({
      status: "succeeded",
    });
    const repairedSet = await f.create(SQLITE_MIGRATION_SET_FORM_URL, "repaired-set", {
      artifact: f.artifacts.get("repaired.json"),
    });
    expect(repairedSet.outcome).toMatchObject({ status: "succeeded", effect: "complete" });
    const repairedSpec = {
      database: { resourceUid: database.resourceUid },
      migrationSet: { resourceUid: repairedSet.resourceUid },
    };
    const repaired = await f.create(
      SQLITE_MIGRATION_APPLICATION_FORM_URL,
      "repaired-application",
      repairedSpec,
    );
    expect(repaired.outcome).toMatchObject({ status: "succeeded", effect: "complete" });
    const status = await f.request(`/resources/${repaired.resourceUid}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      observed: {
        ready: true,
        databaseUid: database.resourceUid,
        migrationSetUid: repairedSet.resourceUid,
      },
    });
    const update = await f.request(
      `/resources/${repaired.resourceUid}`,
      "PUT",
      { spec: repairedSpec },
      "same-spec-update",
      1,
    );
    expect(update.status).toBe(202);
    expect(await f.settled(((await update.json()) as { id: string }).id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    const remove = await f.request(
      `/resources/${repaired.resourceUid}`,
      "DELETE",
      undefined,
      "delete-repaired-application-0001",
      2,
    );
    expect(remove.status).toBe(202);
    expect(await f.settled(((await remove.json()) as { id: string }).id)).toMatchObject({
      status: "succeeded",
    });
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: database.resourceUid,
        stillAuthorized: async () => true,
        use(native) {
          return {
            rows: native.prepare("SELECT value FROM item ORDER BY rowid").all(),
            ledger: native
              .prepare("SELECT sequence, path FROM _takoform_sqlite_migrations ORDER BY sequence")
              .all(),
          };
        },
      }),
    ).toEqual({
      rows: [{ value: "once" }, { value: "repaired" }],
      ledger: [
        { sequence: 1, path: "migrations/0001.sql" },
        { sequence: 2, path: "migrations/0002.sql" },
      ],
    });
  } finally {
    await f.close();
  }
});

test("missing migration config omits Application; incomplete Worker boot never admits it", async () => {
  const f = await fixture(false);
  try {
    expect(f.selected[SQLITE_MIGRATION_APPLICATION_FORM_URL]).toBeUndefined();
    expect(f.selected[SQLITE_DATABASE_FORM_URL]).toBeDefined();
    const response = await f.request(
      "/resources",
      "POST",
      {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: f.organization.id,
        name: "absent",
        spec: {},
      },
      "absent-application",
    );
    expect(response.status).toBe(422);
    const incomplete = createSelfhostV2WorkerComposition({
      sql: f.sql,
      objects: createMemoryObjectStore(),
      clock: () => new Date(),
      config: {
        cursorSigningKey: new Uint8Array(32).fill(5),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        sqliteMigrationSet: { targetKey: SET_TARGET, heldArtifacts: [] },
      },
      rootDirectory: join(f.root, "incomplete-owners"),
      targetKey: TARGET,
      workerdBinary: null,
    });
    expect(await incomplete.restoreOwners()).toEqual([]);
    expect(() => incomplete.secretFreeFormFactory()).toThrow(
      "complete secret-free v2 Worker Form dependencies are unavailable",
    );
  } finally {
    await f.close();
  }
});
