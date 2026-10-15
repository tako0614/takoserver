/**
 * Actual authenticated App -> Application -> Engine/Store -> Bun SQLite wiring.
 * The Form and UNALLOCATED shared/binding DDL are component fixtures only.
 * This does not adopt a migration, grant, carrier, gateway or native publisher.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type AppPorts, buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const ORIGIN = "https://api.app-origin-composition.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = "https://forms.example.test/fixture/AppOriginComposition/1.0.0";
const BACKEND = "fixture-app-origin-backend";
const TARGET = "fixture-app-origin-target";
const BINDINGS = "shared_app_staging_endpoint_bindings";
const AT = "2026-10-15T00:00:00.000Z";
type Selection = NonNullable<AppPorts["v2WorkerEndpointOrigin"]>;

// Exact existing fixture constraints; still test-owned, UNALLOCATED DDL.
function sharedSchema(db: Database, includeBindings: boolean): void {
  // Preserve the stronger original ledger fixture checks, not the relaxed route fixture.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    db.exec(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY
        CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL
        CHECK(length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
      organization_id TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
      reservation_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at),
      CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL))`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY
        CHECK(length(normalized_name) BETWEEN 3 AND 32
          AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
  }
  if (!includeBindings) return;
  // Fixture-only operation FKs: current Core retains operation rows; it has no GC DELETE.
  // A future retention/GC policy must preserve the historical create witness explicitly.
  db.exec(`CREATE TABLE ${BINDINGS} (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),
    endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
    current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
}

async function fixture(options: { shared?: boolean; bindings?: boolean } = {}) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const raw = createSqliteSql(db);
  if (options.shared !== false) sharedSchema(db, options.bindings !== false);
  const statements: SqlStatement[] = [];
  const batches: (readonly SqlStatement[])[] = [];
  let lastBatchError: unknown;
  // Observe complete typed statements, delegating every actual result/write unchanged.
  const sql: Sql = {
    async query(query, params) {
      statements.push({ sql: query, ...(params ? { params: [...params] } : {}) });
      return raw.query(query, params);
    },
    async run(query, params) {
      statements.push({ sql: query, ...(params ? { params: [...params] } : {}) });
      return raw.run(query, params);
    },
    async batch(batch) {
      const captured = batch.map((statement) => ({
        sql: statement.sql,
        ...(statement.params ? { params: [...statement.params] } : {}),
      }));
      statements.push(...captured);
      batches.push(captured);
      lastBatchError = undefined;
      try {
        return await raw.batch(batch);
      } catch (error) {
        lastBatchError = error;
        throw error;
      }
    },
  };
  const clock = () => new Date(AT);
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
  const session = await accounts.signIn({ provider: "google", assertion: "component-owner" });
  const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
  if (!actor) throw new Error("component owner did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Component owner" });
  const writer = await accounts.createApiKey({
    actor,
    organizationId: organization.id,
    name: "component writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3_600,
  });
  const owner = { organizationId: organization.id, product: "takoserver" as const };
  const ledger = createSharedAppLedger({ environment: "staging", primary: () => sql, clock });
  let originalReads = 0;
  let refuseOriginalRead = false;
  const actualForOwner = ledger.forTrustedOwner.bind(ledger);
  ledger.forTrustedOwner = (trustedOwner) => {
    const actual = actualForOwner(trustedOwner);
    return {
      ...actual,
      async readOriginal(id) {
        originalReads++;
        if (refuseOriginalRead) throw new SqlError("unavailable", "component read unavailable");
        return actual.readOriginal(id);
      },
    };
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    initialOutput({ resourceUid }) {
      return { hostname: `v2-${resourceUid.replaceAll("-", "")}.ordinary.example.test` };
    },
    backend: {
      id: BACKEND,
      targetKey: TARGET,
      async execute(input) {
        return { kind: "complete", observed: { component: true }, output: input.previousOutput };
      },
      async reconcile(input) {
        return { kind: "complete", observed: { component: true }, output: input.previousOutput };
      },
    },
  };
  const selection: Selection = { formUrl: FORM, backendId: BACKEND, targetKey: TARGET, ledger };
  const makeApp = (selected?: Selection, overrides: Partial<AppPorts> = {}) =>
    buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      clock,
      settlement: {
        async verify() {
          throw new Error("not configured");
        },
      },
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      v2: {
        cursorSigningKey: new Uint8Array(32).fill(0x5a),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      v2FormFactory: () => ({ [FORM]: form }),
      ...(selected === undefined ? {} : { v2WorkerEndpointOrigin: selected }),
      ...overrides,
    });
  const request = (app: ReturnType<typeof buildApp>, path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${writer.secret}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      }),
    );
  const create = (
    app: ReturnType<typeof buildApp>,
    name: string,
    key: string,
    space = organization.id,
  ) =>
    request(app, "/resources", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ form: FORM, space, name, spec: { value: "original" } }),
    });
  return {
    db,
    sql,
    raw,
    ledger,
    owner,
    form,
    selection,
    makeApp,
    request,
    create,
    statements,
    batches,
    reserve: (name: string) =>
      ledger.forTrustedOwner(owner).reserve({ reservationId: `claim-${name}`, name }),
    lastBatchError: () => lastBatchError,
    originalReads: () => originalReads,
    refuseOriginalReads() {
      refuseOriginalRead = true;
    },
    close() {
      db.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function assertProofFailure(f: Fixture, priorBatches: number, column: string): void {
  expect(f.batches).toHaveLength(priorBatches + 1);
  const batch = f.batches.at(-1);
  if (!batch) throw new Error("missing actual acceptance batch");
  const error = f.lastBatchError();
  expect(error).toBeInstanceOf(SqlError);
  if (!(error instanceof SqlError)) throw new Error("missing actual SQLite constraint error");
  expect(error.code).toBe("constraint");
  expect(error.message).toContain(`${BINDINGS}.${column}`);
  expect(batch.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql))).toBe(
    true,
  );
  expect(batch.at(-1)?.sql).toContain("WITH host_form_admission AS");
  expect(batch.at(-1)?.sql).toContain(`INSERT INTO ${BINDINGS}`);
  expect(batch.at(-1)?.params).toContain(f.owner.organizationId);
  expect(batch.every((statement) => (statement.params?.length ?? 0) <= 100)).toBe(true);
}

function emptyAcceptance(f: Fixture, includeBindings = true): void {
  for (const table of [
    "tf_v2_resources",
    "tf_v2_operations",
    "tf_v2_private_inputs",
    "tf_v2_configured_private_inputs",
    "tf_v2_operation_reference_sets",
    "tf_v2_operation_references",
    "tf_v2_resource_references",
    ...(includeBindings ? [BINDINGS] : []),
  ])
    expect(f.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
}

test("App binds authenticated accepted UID/Operation in its actual owning atomic SQL batch", async () => {
  const f = await fixture();
  try {
    const claim = await f.reserve("composed-name");
    const app = f.makeApp(f.selection);
    const response = await f.create(app, claim.name, "app-origin-create-0001");
    expect(response.status).toBe(202);
    const operation = (await response.json()) as { id: string; resourceUid: string };
    const originalBinding = f.db.query(`SELECT * FROM ${BINDINGS}`).get();
    if (!originalBinding || typeof originalBinding !== "object")
      throw new Error("missing actual binding");
    expect(originalBinding).toEqual({
      incarnation: claim.incarnation,
      organization_id: f.owner.organizationId,
      product: "takoserver",
      reservation_id: claim.reservationId,
      name: claim.name,
      endpoint_uid: operation.resourceUid,
      endpoint_generation: 1,
      form_url: FORM,
      backend_id: BACKEND,
      target_key: TARGET,
      create_operation_id: operation.id,
      current_operation_id: operation.id,
    });
    const accepting = f.batches.filter((batch) =>
      batch.some((s) => /INSERT INTO tf_v2_operations\b/u.test(s.sql)),
    );
    expect(accepting).toHaveLength(1);
    expect(accepting[0]?.some((s) => /INSERT INTO tf_v2_resources\b/u.test(s.sql))).toBe(true);
    expect(accepting[0]?.at(-1)?.sql).toContain(`INSERT INTO ${BINDINGS}`);
    expect(accepting[0]?.at(-1)?.params).toContain(operation.resourceUid);
    expect(accepting[0]?.at(-1)?.params).toContain(operation.id);
    expect(accepting[0]?.at(-1)?.params).toContain(f.owner.organizationId);
    expect(
      await (await f.request(app, `/resources/${operation.resourceUid}`)).json(),
    ).toMatchObject({
      space: f.owner.organizationId,
      name: claim.name,
      spec: { value: "original" },
      output: {
        hostname: `${claim.name}.app-staging.takos.jp`,
        url: `https://${claim.name}.app-staging.takos.jp/`,
      },
    });
    expect(await app.tickTakoformV2()).toMatchObject({ id: operation.id, status: "succeeded" });
    const update = await f.request(app, `/resources/${operation.resourceUid}`, {
      method: "PUT",
      headers: { "idempotency-key": "app-origin-update-0001", "takoform-expected-generation": "1" },
      body: JSON.stringify({ spec: { value: "updated" } }),
    });
    expect(update.status).toBe(202);
    const changed = (await update.json()) as { id: string };
    expect(f.db.query(`SELECT * FROM ${BINDINGS}`).get()).toEqual({
      ...originalBinding,
      endpoint_generation: 2,
      current_operation_id: changed.id,
    });
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginal(claim.reservationId)).toEqual(
      claim,
    );
    expect(await f.ledger.readCurrent(claim.name)).toBeNull();
    await f.ledger.forTrustedOwner(f.owner).release(claim);
    f.refuseOriginalReads();
    const beforeReads = f.originalReads();
    const beforeBatches = f.batches.length;
    const replay = await f.create(f.makeApp(f.selection), claim.name, "app-origin-create-0001");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: operation.id,
      resourceUid: operation.resourceUid,
    });
    expect(f.originalReads()).toBe(beforeReads);
    expect(f.batches).toHaveLength(beforeBatches);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 2 });
  } finally {
    f.close();
  }
});

test("App refuses missing, foreign, released and wrong-Space claims without acceptance artifacts", async () => {
  const f = await fixture();
  try {
    const released = await f.reserve("released-name");
    await f.ledger.forTrustedOwner(f.owner).release(released);
    await f.ledger
      .forTrustedOwner({ organizationId: "another-org", product: "takoserver" })
      .reserve({ reservationId: "foreign-claim", name: "foreign-name" });
    await f.ledger
      .forTrustedOwner({ ...f.owner, product: "takosumi-hosted" })
      .reserve({ reservationId: "foreign-product", name: "hosted-name" });
    const app = f.makeApp(f.selection);
    for (const name of ["missing-name", "released-name", "foreign-name", "hosted-name"]) {
      const priorBatches = f.batches.length;
      const refused = await f.create(app, name, `app-refused-${name}-0001`);
      // Existing unselected compiler propagation, not a promised public
      // reservation refusal class. HTTP500 alone never proves nonacceptance;
      // the actual terminal constraint and durable zeroes below do.
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({ code: "internal_error" });
      assertProofFailure(f, priorBatches, "reservation_id");
      emptyAcceptance(f);
    }
    expect((await f.create(app, "wrong-space", "app-wrong-space-0001", "another-org")).status).toBe(
      403,
    );
    emptyAcceptance(f);
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_assignments").get()).toEqual({
      n: 3,
    });
  } finally {
    f.close();
  }
});

test("App's real SQL tuple refuses an original read from a different physical SQLite database", async () => {
  const f = await fixture();
  const foreign = new Database(":memory:");
  try {
    sharedSchema(foreign, false);
    const foreignSql = createSqliteSql(foreign);
    const ledger = createSharedAppLedger({
      environment: "staging",
      primary: () => foreignSql,
      clock: () => new Date(AT),
    });
    const claim = await f.reserve("physical-name");
    const other = await ledger
      .forTrustedOwner(f.owner)
      .reserve({ reservationId: claim.reservationId, name: claim.name });
    expect(other.incarnation).not.toBe(claim.incarnation);
    const priorBatches = f.batches.length;
    const result = await f.create(
      f.makeApp({ ...f.selection, ledger }),
      claim.name,
      "app-physical-db-0001",
    );
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ code: "internal_error" });
    assertProofFailure(f, priorBatches, "endpoint_uid");
    emptyAcceptance(f);
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginal(claim.reservationId)).toEqual(
      claim,
    );
    expect(await ledger.forTrustedOwner(f.owner).readOriginal(claim.reservationId)).toEqual(other);
  } finally {
    foreign.close();
    f.close();
  }
});

test("App picks only four captured inputs, never caller SQL or general acceptance methods", async () => {
  const f = await fixture();
  try {
    await f.reserve("captured-name");
    let forbiddenReads = 0;
    let fieldReads = 0;
    const mutable = { ...f.selection };
    const selection = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.keys(mutable).map((key) => [
          key,
          {
            enumerable: true,
            get() {
              fieldReads++;
              return mutable[key as keyof Selection];
            },
          },
        ]),
      ),
    ) as Selection;
    for (const key of ["sql", "prepare", "assertSql", "initialOutput", "result"]) {
      Object.defineProperty(selection, key, {
        get() {
          forbiddenReads++;
          throw new Error("caller effect must not be read");
        },
      });
    }
    const app = f.makeApp(selection);
    expect(fieldReads).toBe(4);
    mutable.formUrl = "https://forms.example.test/changed/1.0.0";
    mutable.backendId = "changed";
    mutable.targetKey = "changed";
    const result = await f.create(app, "captured-name", "app-captured-scope-0001");
    expect(result.status).toBe(202);
    expect(fieldReads).toBe(4);
    expect(forbiddenReads).toBe(0);
    let genericCalls = 0;
    const generic = {
      assertSql() {
        genericCalls++;
      },
      prepare() {
        genericCalls++;
      },
      initialOutput() {
        genericCalls++;
      },
    };
    for (const malformed of [null, {}, generic]) {
      expect(() => f.makeApp(malformed as unknown as Selection)).toThrow();
    }
    expect(genericCalls).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("omitted selection preserves ordinary output without shared tables; retained replay stays before fresh policy", async () => {
  const f = await fixture({ shared: false });
  try {
    const app = f.makeApp();
    const result = await f.create(app, "ordinary-name", "app-ordinary-create-0001");
    expect(result.status).toBe(202);
    const operation = (await result.json()) as { id: string; resourceUid: string };
    expect(
      await (await f.request(app, `/resources/${operation.resourceUid}`)).json(),
    ).toMatchObject({
      output: { hostname: `v2-${operation.resourceUid.replaceAll("-", "")}.ordinary.example.test` },
    });
    const retained = f.makeApp(undefined, { v2AllowFreshCreateAndUpdate: false });
    const replay = await f.create(retained, "ordinary-name", "app-ordinary-create-0001");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      id: operation.id,
      resourceUid: operation.resourceUid,
    });
    expect((await f.create(retained, "fresh-name", "app-retained-fresh-0001")).status).toBe(422);
    expect(f.statements.filter((s) => /shared_app_/u.test(s.sql))).toEqual([]);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("selected compiler preserves unrelated Form behavior and cannot override retained-only policy", async () => {
  const f = await fixture({ shared: false });
  try {
    const unrelated = f.makeApp({ ...f.selection, backendId: "other-backend" });
    expect((await f.create(unrelated, "unrelated-name", "app-unrelated-create-0001")).status).toBe(
      202,
    );
    const retained = f.makeApp(f.selection, { v2AllowFreshCreateAndUpdate: false });
    expect((await f.create(retained, "fresh-name", "app-selected-retained-0001")).status).toBe(422);
    expect(f.statements.filter((s) => /shared_app_/u.test(s.sql))).toEqual([]);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("missing unallocated binding schema is not silent OFF or partial Core acceptance", async () => {
  const f = await fixture({ bindings: false });
  try {
    const claim = await f.reserve("schema-name");
    const result = await f.create(f.makeApp(f.selection), claim.name, "app-schema-missing-0001");
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ code: "internal_error" });
    emptyAcceptance(f, false);
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginal(claim.reservationId)).toEqual(
      claim,
    );
  } finally {
    f.close();
  }
});
