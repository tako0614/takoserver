/**
 * Retained-Container request origin on a structural first-primary binding over
 * local SQLite. This is not native D1, a real catalog, Root composition or a
 * DELETE grant; every database is ephemeral.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { createAuth103SourceClock } from "../src/auth103-source-clock.ts";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { captureWorkerRetainedContainerFormSelection } from "../src/entry-worker.ts";
import {
  createWorkerRequestConsumersWithFinancialAuthSourceClock,
  FinancialAuthConsumerUnavailable,
  readWorkerRequestFinancialAuthConsumerPort,
} from "../src/financial-auth-consumer.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { assertMoneyCutoverSqlOrigin } from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlParam, type SqlStatement } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  createV2ContainerHostAcceptance,
  V2_CONTAINER_OWNER_RECIPE as recipe,
  V2_CONTAINER_F2_FORM,
} from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  redeemV2HostAcceptance,
  type V2HostDeleteAcceptanceContext,
} from "../src/takoform-v2/host-acceptance.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";
import {
  assertWorkerRequestBackingOrigin,
  assertWorkerRequestFinancialSqlOrigin,
  captureWorkerSharedAuthStaging,
  createWorkerOrdinaryPrimaryRequestSql,
  createWorkerRequestConsumers,
  createWorkerRetainedContainerRequestSql,
  initializeWorkerRequestNativeInputs,
  queryWorkerRequestFinancialCurrentConsentOriginal,
  queryWorkerRequestOrdinaryAuth103CurrentRegistration,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestNativeInitializationInputs,
  readWorkerRequestWriterEpochOrigin,
  type WorkerRequestDatabase,
  type WorkerRequestSql,
} from "../src/worker-request-composition.ts";
import { currentAuditedSchemaMigrations } from "./helpers/audited-schema-fixture.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const ACCOUNT = "acct_retainedContainerRequest";
const AUTHORITY = "retained-container-request-component";
const PRICE = "price_retainedContainerRequest";

const closers = new Set<() => void>();
afterEach(() => {
  for (const close of closers) close();
  closers.clear();
});

function track(db: Database): Database {
  closers.add(() => db.close());
  return db;
}

/** Structural first-primary binding: every session statement runs on this local SQLite. */
function primaryBinding(
  sql: Sql,
  shape: (
    statements: readonly SqlStatement[],
    results: readonly D1ResultLike[],
  ) => readonly D1ResultLike[] = (_statements, results) => results,
) {
  const sessions: {
    readonly constraint: "first-primary";
    readonly session: D1DatabaseLike;
    readonly queries: string[];
    readonly batches: (readonly SqlStatement[])[];
  }[] = [];
  const ack = (rows: readonly Record<string, unknown>[], changes: number): D1ResultLike => ({
    success: true,
    results: rows,
    meta: { changes },
  });
  const binding: WorkerRequestDatabase = {
    prepare() {
      throw new Error("request used the root binding instead of its primary session");
    },
    async batch() {
      throw new Error("request batched on the root binding");
    },
    withSession(constraint) {
      const queries: string[] = [];
      const batches: (readonly SqlStatement[])[] = [];
      const originals = new WeakMap<D1StatementLike, SqlStatement>();
      const session: D1DatabaseLike = {
        prepare(text) {
          const statement: D1StatementLike = {
            bind(...params: readonly SqlParam[]) {
              originals.set(statement, { sql: text, params });
              return statement;
            },
            async all() {
              const original = originals.get(statement);
              if (!original) throw new Error("fixture statement ownership differs");
              queries.push(original.sql);
              const result = await sql.run(original.sql, original.params);
              return ack(result.rows, result.changes);
            },
          };
          originals.set(statement, { sql: text });
          return statement;
        },
        async batch(statements) {
          const inputs = statements.map((statement) => {
            const original = originals.get(statement);
            if (!original) throw new Error("fixture batch crossed primary sessions");
            return original;
          });
          queries.push(...inputs.map((input) => input.sql));
          batches.push(inputs);
          const results = (await sql.batch(inputs)).map((result) =>
            ack(result.rows, result.changes),
          );
          return [...shape(inputs, results)];
        },
      };
      sessions.push({ constraint, session, queries, batches });
      return session;
    },
  };
  return { binding, sessions };
}

async function realmFixture() {
  const database = await createHostedBillingRealmTestDatabase();
  closers.add(() => database.db.close());
  await seedHostedBillingRealmTestPin(database.sql, {
    accountId: ACCOUNT,
    billingAuthority: AUTHORITY,
  });
  const primary = primaryBinding(database.sql);
  const client = createStripeBillingClient({
    secretKey: "sk_test_retained_container_request_fixture",
    mode: "test",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") throw new Error("unexpected processor mutation");
      if (path === "/v1/account") return Response.json({ object: "account", id: ACCOUNT });
      if (path !== `/v1/prices/${PRICE}`) throw new Error("unexpected processor read");
      return Response.json({
        object: "price",
        id: PRICE,
        livemode: false,
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: 1000,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      });
    },
  });
  const sharedAuth = captureWorkerSharedAuthStaging({
    kind: "shared-auth-staging-v1",
    clientSecret: "test-only-retained-container-rp-secret",
    encryptionKey: new Uint8Array(32).fill(9),
    principals: {
      async resolve() {
        throw new Error("test grants no principal authority");
      },
    },
    async fetch() {
      throw new Error("test permits no Accounts transport");
    },
  });
  /** Otherwise-valid native/consumer inputs, so only the purpose can refuse. */
  async function consumerOptions(connection: WorkerRequestSql) {
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: { accountId: ACCOUNT, billingAuthority: AUTHORITY, mode: "test" },
      prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
    });
    return {
      connection,
      sql: connection.sql,
      realm,
      client,
      sharedAuth,
      identity: {
        async verify(): Promise<never> {
          throw new Error("test grants no identity");
        },
      },
      clock: createAuth103SourceClock(),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
  }
  return { ...database, ...primary, consumerOptions };
}

test("retained Container origin owns one first-primary without Money custody or construction IO", async () => {
  const f = await realmFixture();
  const connection = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  expect(f.sessions).toHaveLength(1);
  expect(f.sessions[0]?.constraint).toBe("first-primary");
  expect(f.sessions[0]?.queries).toEqual([]);
  expect(connection.moneyGuard).toBe("not-selected");
  expect(Object.isFrozen(connection)).toBe(true);
  expect(Object.isFrozen(connection.sql)).toBe(true);
  expect(readWorkerRequestWriterEpochOrigin(connection)).toBeUndefined();
  expect(() => assertWorkerRequestBackingOrigin(connection)).not.toThrow();
  expect(() => assertMoneyCutoverSqlOrigin(connection.sql, { writerEpoch: "x" })).toThrow();
  const { withSession: _withSession, ...withoutPrimary } = f.binding;
  await expect(
    createWorkerRetainedContainerRequestSql({ database: withoutPrimary }),
  ).rejects.toThrow("Worker requires a native primary D1 session");
  expect(f.sessions).toHaveLength(1);
});

test("only the retained purpose selects the retained grammar; ordinary keeps its refusal", async () => {
  const f = await realmFixture();
  f.db.exec("CREATE TABLE retained_probe(id TEXT PRIMARY KEY, name TEXT)");
  const ordinary = await createWorkerOrdinaryPrimaryRequestSql({ database: f.binding });
  const retained = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  const statement = {
    sql: "INSERT OR ABORT INTO main.retained_probe(id,name) VALUES(?,?) RETURNING id,name",
    params: ["one", "kept"],
  };
  await expect(ordinary.sql.batch([statement])).rejects.toThrow("INSERT conflict mode");
  const ordinaryQueries = f.sessions[0]?.queries.length;
  expect(ordinaryQueries).toBe(0);
  const result = await retained.sql.batch([statement]);
  expect(result).toEqual([{ rows: [{ id: "one", name: "kept" }], changes: 1 }]);
  // The original statement and params reach the primary, followed only by the catalog guard.
  const body = f.sessions[1]?.batches.at(-1);
  expect(body).toHaveLength(2);
  expect(body?.[0]).toEqual(statement);
  expect(body?.[1]?.sql).toContain("main.sqlite_schema");
  // The engine's fixed admission wrapper is likewise retained-only grammar.
  const wrapped = {
    sql: "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT OR ABORT INTO main.retained_probe(id,name) VALUES(?,?)",
    params: ["wrapped", "kept"],
  };
  await expect(ordinary.sql.batch([wrapped])).rejects.toThrow("ordinary public SQL refused");
  expect(await retained.sql.batch([wrapped])).toEqual([{ rows: [], changes: 1 }]);
  // An explicit ABORT failure aborts the original atomic batch.
  await expect(
    retained.sql.batch([
      { sql: "INSERT OR ABORT INTO main.retained_probe(id,name) VALUES('two','x')" },
      { sql: "INSERT OR ABORT INTO main.retained_probe(id,name) VALUES('one','dup')" },
    ]),
  ).rejects.toThrow();
  expect(f.db.query("SELECT id, name FROM retained_probe ORDER BY id").all()).toEqual([
    { id: "one", name: "kept" },
    { id: "wrapped", name: "kept" },
  ]);
});

test("retained origin keeps Financial protected, Money-control, trigger, FK and syntax refusals", async () => {
  const f = await realmFixture();
  f.db.exec(`CREATE TABLE retained_parent(id TEXT PRIMARY KEY);
    CREATE TABLE financial_source_events(id TEXT PRIMARY KEY,
      parent TEXT REFERENCES retained_parent(id) ON DELETE CASCADE);
    CREATE TABLE retained_trigger_source(id TEXT PRIMARY KEY);
    CREATE TRIGGER retained_into_protected AFTER INSERT ON retained_trigger_source BEGIN
      INSERT INTO financial_source_events(id) VALUES (NEW.id);
    END;`);
  const connection = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  const before = f.db.query("SELECT count(*) AS n FROM financial_source_events").get();
  await expect(
    connection.sql.run("INSERT OR ABORT INTO main.financial_source_events(id) VALUES('p')"),
  ).rejects.toThrow("ordinary public SQL refused");
  await expect(
    connection.sql.run(
      "INSERT INTO retained_parent(id) SELECT writer_epoch FROM money_cutover_writer_permit",
    ),
  ).rejects.toThrow("Money cutover control reference");
  await expect(
    connection.sql.run("INSERT OR ABORT INTO main.retained_trigger_source(id) VALUES('t')"),
  ).rejects.toThrow("ordinary public SQL refused");
  await expect(connection.sql.run("DELETE FROM retained_parent")).rejects.toThrow(
    "ordinary public SQL refused",
  );
  for (const refused of [
    "INSERT OR REPLACE INTO main.retained_parent(id) VALUES('r')",
    "INSERT OR ABORT INTO temp.retained_parent(id) VALUES('r')",
    "INSERT OR ABORT INTO main.main.retained_parent(id) VALUES('r')",
    "INSERT OR ABORT INTO \"main\".retained_parent(id) VALUES('r')",
    "WITH x AS (SELECT 1) INSERT OR ABORT INTO main.retained_parent(id) VALUES('r')",
  ])
    await expect(connection.sql.run(refused)).rejects.toThrow("ordinary public SQL refused");
  expect(f.db.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual(before);
  expect(f.db.query("SELECT count(*) AS n FROM retained_parent").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) AS n FROM retained_trigger_source").get()).toEqual({ n: 0 });
});

test("catalog drift during the guarded batch refuses and rolls back the original body", async () => {
  const db = track(new Database(":memory:"));
  db.exec("CREATE TABLE retained_parent(id TEXT PRIMARY KEY)");
  const base = createSqliteSql(db);
  let armed = false;
  const drifting: Sql = {
    query: (text, params) => base.query(text, params),
    run: (text, params) => base.run(text, params),
    async batch(statements) {
      if (armed && statements.some((statement) => statement.sql.startsWith("INSERT OR ABORT"))) {
        armed = false;
        db.exec("CREATE INDEX retained_drift ON retained_parent(id)");
      }
      return base.batch(statements);
    },
  };
  const primary = primaryBinding(drifting);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  armed = true;
  await expect(
    connection.sql.batch([{ sql: "INSERT OR ABORT INTO main.retained_parent(id) VALUES('d')" }]),
  ).rejects.toThrow();
  expect(armed).toBe(false);
  expect(
    db.query("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'retained_drift'").get(),
  ).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) AS n FROM retained_parent").get()).toEqual({ n: 0 });
});

test("retained origin cannot reach Auth, Financial, native initialization or selected-Money ports", async () => {
  const f = await realmFixture();
  const connection = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  const options = await f.consumerOptions(connection);
  expect(() => readWorkerRequestConsumers(connection)).toThrow(
    "Worker request consumers have not been constructed",
  );
  expect(() => readWorkerRequestFinancialInputs(connection)).toThrow(
    "Worker request consumers have not been constructed",
  );
  expect(() => initializeWorkerRequestNativeInputs(options)).toThrow(
    "Worker request native initialization differs",
  );
  expect(() => readWorkerRequestNativeInitializationInputs(connection)).toThrow(
    "Worker request native initialization origin differs",
  );
  expect(() => createWorkerRequestConsumers(options)).toThrow(
    "shared-login Worker request composition differs",
  );
  const { clock: _clock, ...withoutClock } = options;
  await expect(
    // The purpose refusal precedes any use of this identity stub.
    createWorkerRequestConsumersWithFinancialAuthSourceClock(
      withoutClock as unknown as Parameters<
        typeof createWorkerRequestConsumersWithFinancialAuthSourceClock
      >[0],
      createAuth103SourceClock(),
    ),
  ).rejects.toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect(readWorkerRequestFinancialAuthConsumerPort(connection)).toBeNull();
  expect(() => assertWorkerRequestFinancialSqlOrigin(connection, connection.sql)).toThrow(
    "Money Financial origin is not ready",
  );
  await expect(
    queryWorkerRequestOrdinaryAuth103CurrentRegistration(
      connection,
      Array.from({ length: 10 }, (_, index) => `param-${index}`),
    ),
  ).rejects.toThrow("Worker request ordinary currentness input differs");
  await expect(
    queryWorkerRequestFinancialCurrentConsentOriginal(connection, {} as never),
  ).rejects.toThrow("Financial current consent requires the selected Money writer");
  // The same otherwise-valid inputs still initialize on the ordinary Auth purpose.
  const ordinary = await createWorkerOrdinaryPrimaryRequestSql({ database: f.binding });
  const ordinaryOptions = await f.consumerOptions(ordinary);
  expect(() => initializeWorkerRequestNativeInputs(ordinaryOptions)).not.toThrow();
  expect(() => assertWorkerRequestBackingOrigin(connection)).not.toThrow();
});

test("copied, substituted and foreign connections or changed binding methods refuse", async () => {
  const f = await realmFixture();
  const connection = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  const other = await createWorkerRetainedContainerRequestSql({ database: f.binding });
  expect(() => assertWorkerRequestBackingOrigin({ ...connection })).toThrow(
    "Worker request backing has not been constructed",
  );
  expect(() =>
    assertWorkerRequestBackingOrigin(
      Object.freeze({ sql: other.sql, moneyGuard: "not-selected" as const }),
    ),
  ).toThrow("Worker request backing has not been constructed");
  expect(() => assertWorkerRequestFinancialSqlOrigin(connection, other.sql)).toThrow(
    "Worker request Financial Sql differs",
  );
  const open = f.binding.withSession;
  if (!open) throw new Error("fixture primary constructor is missing");
  f.binding.withSession = (constraint) => Reflect.apply(open, f.binding, [constraint]);
  expect(() => assertWorkerRequestBackingOrigin(connection)).toThrow(
    "Worker request primary session methods differ",
  );
  f.binding.withSession = open;
  const session = f.sessions[0]?.session;
  if (!session) throw new Error("fixture primary session is missing");
  const prepare = session.prepare;
  session.prepare = () => {
    throw new Error("replacement must not be called");
  };
  expect(() => assertWorkerRequestBackingOrigin(connection)).toThrow(
    "Worker request primary session methods differ",
  );
  session.prepare = prepare;
  expect(() => assertWorkerRequestBackingOrigin(connection)).not.toThrow();
  expect(() => assertWorkerRequestBackingOrigin(other)).not.toThrow();
});

const containerSpec = (workloadRevision: string) => ({
  image: `registry.example/image@sha256:${"d".repeat(64)}`,
  httpPort: 8080,
  healthPath: "/",
  workloadRevision,
  requiredSensitiveVars: [],
  outboundInternet: true,
});

function containerForm(): V2Form {
  const backend: V2Backend = {
    id: "test-container-backend",
    targetKey: "test-container-target",
    async execute() {
      return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
    },
    async reconcile() {
      return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
    },
  };
  return { validateCreate() {}, validateUpdate() {}, backend };
}

function engineFor(
  sql: Sql,
  forms: "admitted" | "retained",
  issuer: "selected" | "none" = "selected",
  observeDelete?: (context: V2HostDeleteAcceptanceContext) => void,
) {
  const actual = createV2ContainerHostAcceptance({
    sql,
    installationId: "test-installation",
    backendId: "test-container-backend",
    targetKey: "test-container-target",
  });
  const prepareDelete = actual.prepareDelete;
  if (!prepareDelete) throw new Error("owning DELETE method unavailable");
  // Own methods delegate to the actual issuer; the original context object passes through.
  const host = Object.freeze({
    assertSql: (value: Sql) => actual.assertSql(value),
    initialOutput: (scope: Parameters<typeof actual.initialOutput>[0]) =>
      actual.initialOutput(scope),
    prepare: (context: Parameters<typeof actual.prepare>[0]) => actual.prepare(context),
    prepareDelete: (context: V2HostDeleteAcceptanceContext) => {
      observeDelete?.(context);
      return Reflect.apply(prepareDelete, actual, [context]);
    },
  });
  const form = containerForm();
  return createTakoformV2Engine(
    {
      sql,
      replayWindowSeconds: 120,
      now: () => new Date("2026-10-16T00:00:00.000Z"),
      async authorize(principal, space) {
        return principal === "container-owner-test" && space === "default";
      },
      forms: forms === "admitted" ? { [C.formUrl]: form } : {},
      ...(forms === "retained" ? { retainedForms: { [C.formUrl]: form } } : {}),
    },
    issuer === "selected" ? host : undefined,
  );
}

function snapshot(db: Database) {
  const catalog = db
    .query("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name")
    .all();
  const rows = (name: string) =>
    db.query<Record<string, unknown>, []>(`SELECT * FROM main.${name} ORDER BY 1`).all();
  return {
    catalog: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    resources: rows("tf_v2_resources"),
    operations: rows("tf_v2_operations"),
    owner: recipe.tables.map(({ name }) => rows(name)),
  };
}

/** Audited full100 + owner candidate catalog, with one settled Container from setup only. */
async function retainedContainerCatalog(owner: "original" | "missing" = "original") {
  const db = track(new Database(":memory:"));
  db.exec("PRAGMA foreign_keys=ON");
  expect(currentAuditedSchemaMigrations()).toHaveLength(100);
  migrateSqlite(db);
  const setupSql = createSqliteSql(db);
  await setupSql.batch(v2ContainerOwnerMigrationCandidate());
  // Pre-existing state is written by an unfenced setup engine, never by the retained origin.
  const setup = engineFor(setupSql, "admitted", owner === "original" ? "selected" : "none");
  const created = await setup.acceptCreate({
    principal: "container-owner-test",
    key: "container-retained-create",
    input: { form: C.formUrl, space: "default", name: "retained", spec: containerSpec("r1") },
  });
  expect((await setup.runNext())?.status).toBe("failed");
  return { db, setupSql, created };
}

test("retained Forms keep fresh Container CREATE/UPDATE at 422 on the retained origin", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog();
  const primary = primaryBinding(setupSql);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const engine = engineFor(connection.sql, "retained");
  const before = snapshot(db);
  await expect(
    engine.acceptCreate({
      principal: "container-owner-test",
      key: "retained-fresh-create",
      input: { form: C.formUrl, space: "default", name: "fresh", spec: containerSpec("r1") },
    }),
  ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
  await expect(
    engine.acceptUpdate({
      principal: "container-owner-test",
      key: "retained-fresh-update",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: containerSpec("r2"),
    }),
  ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
  expect(snapshot(db)).toEqual(before);
  expect(primary.sessions[0]?.batches).toEqual([]);
});

const normalized = (statements: readonly SqlStatement[]) =>
  statements.map(({ sql, params }) => ({ sql, params: [...(params ?? [])] }));

/** Retained engine whose Store/issuer Sql forwards to the retained origin and records submissions. */
function observedRetainedEngine(connection: WorkerRequestSql) {
  const submitted: (readonly SqlStatement[])[] = [];
  const contexts: V2HostDeleteAcceptanceContext[] = [];
  const observed: Sql = Object.freeze({
    query: (text: string, params?: readonly SqlParam[]) => connection.sql.query(text, params),
    run: (text: string, params?: readonly SqlParam[]) => connection.sql.run(text, params),
    async batch(statements: readonly SqlStatement[]) {
      submitted.push(normalized(statements));
      return await connection.sql.batch(statements);
    },
  });
  const engine = engineFor(observed, "retained", "selected", (context) => contexts.push(context));
  return { engine, submitted, contexts };
}

const isWrappedContainerTerminal = (statement: SqlStatement | undefined) =>
  statement?.sql.startsWith(
    "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT OR ABORT INTO main.tf_v2_container_acceptances ",
  ) === true;

test("exact engine-wrapped DELETE batch commits on the retained origin with its original statements", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog();
  const primary = primaryBinding(setupSql);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const { engine, submitted, contexts } = observedRetainedEngine(connection);
  const before = snapshot(db);
  expect(before.owner[0]).toHaveLength(1);
  const deleted = await engine.acceptDelete({
    principal: "container-owner-test",
    key: "container-retained-delete",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  expect(deleted).toMatchObject({
    action: "delete",
    generation: 2,
    resourceUid: created.resourceUid,
    status: "queued",
  });
  // The issuer saw the Store's original DELETE context once.
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({
    action: "delete",
    operationId: deleted.id,
    resourceUid: created.resourceUid,
    generation: 2,
    form: C.formUrl,
    backendId: "test-container-backend",
    targetKey: "test-container-target",
    referencesJson: null,
  });
  // One acceptance batch; its last statement is the Store's wrapped Host terminal.
  expect(submitted).toHaveLength(1);
  const original = submitted[0] ?? [];
  const terminal = original.at(-1);
  expect(isWrappedContainerTerminal(terminal)).toBe(true);
  expect(terminal?.params?.[0]).toBe(deleted.id);
  expect(terminal?.params?.[10]).toBe("delete");
  expect(terminal?.params?.[12]).toBe(deleted.id);
  // Backing: one catalog/metadata snapshot, then exactly the original body plus one guard.
  const backing = primary.sessions[0]?.batches ?? [];
  expect(backing).toHaveLength(2);
  expect(backing[0]?.[0]?.sql).toContain("main.sqlite_schema");
  expect(normalized(backing[1] ?? []).slice(0, -1)).toEqual(normalized(original));
  expect(backing[1]).toHaveLength(original.length + 1);
  expect(backing[1]?.at(-1)?.sql).toContain("main.sqlite_schema");
  expect(primary.sessions).toHaveLength(1);
  expect(primary.sessions[0]?.queries.some((query) => /money_cutover/iu.test(query))).toBe(false);
  // The acknowledged batch committed Core and owner state together.
  const after = snapshot(db);
  expect(after.catalog).toBe(before.catalog);
  expect(after.resources).toHaveLength(1);
  expect(after.resources[0]).toMatchObject({
    uid: created.resourceUid,
    generation: 2,
    phase: "deleting",
    busy_operation: deleted.id,
  });
  expect(after.operations.find((row) => row.id === deleted.id)).toMatchObject({
    action: "delete",
    generation: 2,
    status: "queued",
  });
  expect(after.owner[1]?.find((row) => row.operation_id === deleted.id)).toMatchObject({
    action: "delete",
    generation: 2,
  });
  expect(after.owner[0]?.[0]).toMatchObject({
    resource_uid: created.resourceUid,
    retire_operation_id: deleted.id,
  });
});

test("catalog drift during the engine-wrapped DELETE body rolls back Core and owner state", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog();
  let armed = true;
  const drifting: Sql = {
    query: (text, params) => setupSql.query(text, params),
    run: (text, params) => setupSql.run(text, params),
    async batch(statements) {
      if (armed && isWrappedContainerTerminal(statements.at(-2))) {
        armed = false;
        db.exec("CREATE INDEX retained_engine_drift ON tf_v2_resources(uid)");
      }
      return setupSql.batch(statements);
    },
  };
  const primary = primaryBinding(drifting);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const { engine, submitted } = observedRetainedEngine(connection);
  const before = snapshot(db);
  await expect(
    engine.acceptDelete({
      principal: "container-owner-test",
      key: "container-retained-drift",
      uid: created.resourceUid,
      expectedGeneration: 1,
    }),
  ).rejects.toThrow();
  expect(armed).toBe(false);
  expect(submitted).toHaveLength(1);
  const after = snapshot(db);
  expect(after.catalog).not.toBe(before.catalog);
  expect({ ...after, catalog: before.catalog }).toEqual(before);
});

test("missing owner original refuses the engine-wrapped DELETE and rolls back", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog("missing");
  const primary = primaryBinding(setupSql);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const { engine, submitted } = observedRetainedEngine(connection);
  const before = snapshot(db);
  // Missing-original precondition: the Core Resource exists, its owner instance does not.
  expect(before.resources).toHaveLength(1);
  expect(before.owner[0]).toEqual([]);
  expect(
    db
      .query(`SELECT count(*) AS n FROM main.${recipe.tables[0].name} WHERE resource_uid = ?`)
      .get(created.resourceUid),
  ).toEqual({ n: 0 });
  const refused: unknown = await engine
    .acceptDelete({
      principal: "container-owner-test",
      key: "container-retained-missing",
      uid: created.resourceUid,
      expectedGeneration: 1,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(refused).toBeInstanceOf(SqlError);
  expect(String((refused as Error).message)).toMatch(
    /container_owner_invariant|NOT NULL constraint failed/u,
  );
  expect(submitted).toHaveLength(1);
  expect(isWrappedContainerTerminal(submitted[0]?.at(-1))).toBe(true);
  expect(primary.sessions[0]?.batches).toHaveLength(2);
  expect(snapshot(db)).toEqual(before);
});

test("a lost DELETE acknowledgement is never resent; the engine reads back the committed Operation", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog();
  let dropped = 0;
  const primary = primaryBinding(setupSql, (statements, results) => {
    if (!isWrappedContainerTerminal(statements.at(-2))) return results;
    dropped++;
    // The body committed, but its explicit D1 acknowledgement is incomplete.
    return results.map(
      ({ success, results: rows }) => ({ success, results: rows }) as D1ResultLike,
    );
  });
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const { engine, submitted } = observedRetainedEngine(connection);
  const request = {
    principal: "container-owner-test",
    key: "container-retained-unknown",
    uid: created.resourceUid,
    expectedGeneration: 1,
  };
  const recovered = await engine.acceptDelete(request);
  expect(dropped).toBe(1);
  expect(recovered).toMatchObject({ action: "delete", generation: 2, status: "queued" });
  expect(submitted).toHaveLength(1);
  expect(primary.sessions[0]?.batches).toHaveLength(2);
  const committed = snapshot(db);
  expect(committed.resources[0]).toMatchObject({
    generation: 2,
    phase: "deleting",
    busy_operation: recovered.id,
  });
  // The same idempotency key replays the committed Operation without another batch.
  expect(await engine.acceptDelete(request)).toMatchObject({ id: recovered.id, generation: 2 });
  expect(submitted).toHaveLength(1);
  expect(primary.sessions[0]?.batches).toHaveLength(2);
  expect(snapshot(db)).toEqual(committed);
});

for (const [label, form] of [
  ["F1", C.formUrl],
  ["F2", V2_CONTAINER_F2_FORM],
] as const) {
  test(`unchanged ${label} issuer terminal passes the catalog fence and its ABORT rolls back`, async () => {
    const { db, setupSql } = await retainedContainerCatalog();
    const primary = primaryBinding(setupSql);
    const connection = await createWorkerRetainedContainerRequestSql({
      database: primary.binding,
    });
    const host = createV2ContainerHostAcceptance({
      sql: connection.sql,
      installationId: "synthetic-installation",
      backendId: "synthetic-backend",
      targetKey: "synthetic-target",
    });
    const context: V2HostDeleteAcceptanceContext = Object.freeze({
      action: "delete",
      principal: "synthetic-principal",
      key: "synthetic-original-key",
      fingerprint: "synthetic-fingerprint",
      operationId: "synthetic-operation",
      resourceUid: "synthetic-resource",
      generation: 2,
      at: "2026-11-06T00:00:00.000Z",
      retainUntil: "2026-11-07T00:00:00.000Z",
      form,
      space: "synthetic-space",
      name: "synthetic-name",
      backendId: "synthetic-backend",
      targetKey: "synthetic-target",
      specJson: JSON.stringify(containerSpec("v1")),
      outputJson: "{}",
      referencesJson: null,
    });
    const prepareDelete = host.prepareDelete;
    if (!prepareDelete) throw new Error("owning DELETE method unavailable");
    const prepared = await prepareDelete.call(host, context);
    if (!prepared) throw new Error("owning DELETE preparation unavailable");
    const original = redeemV2HostAcceptance(prepared, connection.sql, context);
    const originalDigest = createHash("sha256")
      .update(JSON.stringify(original.terminal))
      .digest("hex");
    // Missing-original precondition: no Core Resource/Operation or owner row for this context.
    for (const [table, column, value] of [
      ["tf_v2_operations", "id", context.operationId],
      ["tf_v2_resources", "uid", context.resourceUid],
      [recipe.tables[0].name, "resource_uid", context.resourceUid],
      [recipe.tables[1].name, "operation_id", context.operationId],
    ] as const)
      expect(
        db.query(`SELECT count(*) AS n FROM main.${table} WHERE ${column} = ?`).get(value),
      ).toEqual({ n: 0 });
    const before = snapshot(db);
    // The missing original makes the owner graph abort inside the guarded body batch.
    const refused: unknown = await connection.sql.batch([original.terminal]).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The structural D1 adapter re-derives SqlError.code from the message; the owner
    // invariant text is the operative oracle here, not an arbitrary failure.
    expect(refused).toBeInstanceOf(SqlError);
    expect(String((refused as Error).message)).toMatch(
      /container_owner_invariant|NOT NULL constraint failed/u,
    );
    const batches = primary.sessions[0]?.batches ?? [];
    expect(batches).toHaveLength(2);
    expect(batches[0]?.[0]?.sql).toContain("main.sqlite_schema");
    expect(batches[1]).toHaveLength(2);
    expect(batches[1]?.[0]).toEqual(original.terminal);
    expect(batches[1]?.[1]?.sql).toContain("main.sqlite_schema");
    expect(createHash("sha256").update(JSON.stringify(original.terminal)).digest("hex")).toBe(
      originalDigest,
    );
    expect(snapshot(db)).toEqual(before);
    expect(primary.sessions[0]?.queries.some((query) => /money_cutover/iu.test(query))).toBe(false);
  });
}

const fakeForm = () => containerForm();

test("retained Form selection snapshot keeps every canonical Container out of the admitted map", () => {
  const unrelated = "https://forms.example.test/fixture/Unrelated/1.0.0";
  const retained = fakeForm();
  const other = fakeForm();
  const selected = captureWorkerRetainedContainerFormSelection({
    forms: { [unrelated]: other },
    retainedForms: { [V2_CONTAINER_F2_FORM]: retained },
  });
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.forms)).toBe(true);
  expect(Object.isFrozen(selected.retainedForms)).toBe(true);
  expect(Object.keys(selected.forms)).toEqual([unrelated]);
  expect(selected.forms[unrelated]).toBe(other);
  expect(selected.retainedForms[V2_CONTAINER_F2_FORM]).toBe(retained);
  const refusal =
    "retained Container Worker requires canonical Container Forms only in retainedForms";
  let getterCalls = 0;
  for (const selection of [
    undefined,
    { [C.formUrl]: retained },
    { forms: {}, retainedForms: {} },
    { forms: { [unrelated]: other }, retainedForms: { [unrelated]: other } },
    { forms: { [C.formUrl]: retained }, retainedForms: { [V2_CONTAINER_F2_FORM]: retained } },
    { forms: { [V2_CONTAINER_F2_FORM]: retained }, retainedForms: { [C.formUrl]: retained } },
    { forms: {}, retainedForms: { [C.formUrl]: retained }, extra: {} },
    {
      forms: Object.defineProperty({}, V2_CONTAINER_F2_FORM, {
        enumerable: true,
        get() {
          getterCalls++;
          return retained;
        },
      }),
      retainedForms: { [C.formUrl]: retained },
    },
    {
      forms: {},
      get retainedForms() {
        getterCalls++;
        return { [C.formUrl]: retained };
      },
    },
    { forms: new Map(), retainedForms: { [C.formUrl]: retained } },
  ])
    expect(() => captureWorkerRetainedContainerFormSelection(selection)).toThrow(refusal);
  expect(getterCalls).toBe(0);
  // The snapshot is what the application reads; a later mutation cannot admit a Container.
  const mutable: { forms: Record<string, V2Form>; retainedForms: Record<string, V2Form> } = {
    forms: {},
    retainedForms: { [C.formUrl]: retained },
  };
  const captured = captureWorkerRetainedContainerFormSelection(mutable);
  mutable.forms[C.formUrl] = retained;
  expect(Object.hasOwn(captured.forms, C.formUrl)).toBe(false);
});
