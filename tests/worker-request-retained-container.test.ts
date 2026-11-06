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
function primaryBinding(sql: Sql) {
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
          return (await sql.batch(inputs)).map((result) => ack(result.rows, result.changes));
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
  // An explicit ABORT failure aborts the original atomic batch.
  await expect(
    retained.sql.batch([
      { sql: "INSERT OR ABORT INTO main.retained_probe(id,name) VALUES('two','x')" },
      { sql: "INSERT OR ABORT INTO main.retained_probe(id,name) VALUES('one','dup')" },
    ]),
  ).rejects.toThrow();
  expect(f.db.query("SELECT id, name FROM retained_probe ORDER BY id").all()).toEqual([
    { id: "one", name: "kept" },
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

function engineFor(sql: Sql, forms: "admitted" | "retained") {
  const host = createV2ContainerHostAcceptance({
    sql,
    installationId: "test-installation",
    backendId: "test-container-backend",
    targetKey: "test-container-target",
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
    host,
  );
}

function snapshot(db: Database) {
  const catalog = db
    .query("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name")
    .all();
  const rows = (name: string) => db.query(`SELECT * FROM main.${name} ORDER BY 1`).all();
  return {
    catalog: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    resources: rows("tf_v2_resources"),
    operations: rows("tf_v2_operations"),
    owner: recipe.tables.map(({ name }) => rows(name)),
  };
}

/** Audited full100 + owner candidate catalog, with one settled Container from setup only. */
async function retainedContainerCatalog() {
  const db = track(new Database(":memory:"));
  db.exec("PRAGMA foreign_keys=ON");
  expect(currentAuditedSchemaMigrations()).toHaveLength(100);
  migrateSqlite(db);
  const setupSql = createSqliteSql(db);
  await setupSql.batch(v2ContainerOwnerMigrationCandidate());
  // Pre-existing state is written by an unfenced setup engine, never by the retained origin.
  const setup = engineFor(setupSql, "admitted");
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

test("exact engine DELETE batch on the retained origin: current Financial grammar boundary", async () => {
  const { db, setupSql, created } = await retainedContainerCatalog();
  const primary = primaryBinding(setupSql);
  const connection = await createWorkerRetainedContainerRequestSql({ database: primary.binding });
  const engine = engineFor(connection.sql, "retained");
  const before = snapshot(db);
  const pending = engine.acceptDelete({
    principal: "container-owner-test",
    key: "container-retained-delete",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  // bc6d55d admits only a token-zero INSERT; the Core store wraps every Host terminal in
  // `WITH host_form_admission AS (...)`, so the fence refuses before any catalog or body read.
  await expect(pending).rejects.toThrow("ordinary public SQL refused: INSERT conflict mode");
  expect(primary.sessions[0]?.batches).toEqual([]);
  expect(primary.sessions[0]?.queries.some((query) => query.includes("sqlite_schema"))).toBe(false);
  expect(primary.sessions[0]?.queries.some((query) => /money_cutover/iu.test(query))).toBe(false);
  expect(snapshot(db)).toEqual(before);
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
