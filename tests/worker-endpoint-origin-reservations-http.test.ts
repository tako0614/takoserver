import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import type { Accounts } from "../src/auth.ts";
import { createAccounts } from "../src/auth.ts";
import type { Offering } from "../src/catalog.ts";
import { createControlRoutes } from "../src/control.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import { createFakeProviderState, FakeProvider } from "../src/providers/fake.ts";
import { createRouter } from "../src/router.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import {
  WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
  WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
  WorkerEndpointOriginReservationError,
  type WorkerEndpointOriginReservations,
} from "../src/worker-endpoint-origin-reservations.ts";

const PROJECTION = {
  format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
  reservationId: "reservation_01",
  requestedSubdomain: "community-public",
  canonicalPublicOrigin: "https://community-public.workers.test",
  revision: "1",
  expiresAt: "2026-08-31T12:10:00.000Z",
  status: "prepared",
} as const;

function fixture(prepareRefusal?: WorkerEndpointOriginReservationError) {
  const prepareCalls: unknown[] = [];
  const activationCalls: unknown[] = [];
  const originReservations: WorkerEndpointOriginReservations = {
    async prepare(input) {
      prepareCalls.push(input);
      if (prepareRefusal) throw prepareRefusal;
      return PROJECTION;
    },
    async read() {
      return PROJECTION;
    },
    async release() {},
    async mintForWorker() {
      throw new Error("not called");
    },
    async bind() {
      throw new Error("not called");
    },
    async inspectBound() {
      throw new Error("not called");
    },
    async activate(input) {
      activationCalls.push(input);
      return PROJECTION;
    },
    async deactivate(input) {
      activationCalls.push(input);
      return PROJECTION;
    },
    async assignEndpoint() {
      throw new Error("not called");
    },
    async cancelEndpointAssignment() {
      throw new Error("not called");
    },
    async releaseEndpointAssignment() {
      throw new Error("not called");
    },
    async activateEndpointAssignment() {
      throw new Error("not called");
    },
    async endpointAssignment() {
      throw new Error("not called");
    },
    async deactivateEndpointAssignment() {
      throw new Error("not called");
    },
  };
  const accounts = {
    async authenticate(authorization: string | null) {
      if (authorization !== "Bearer organization-key") return null;
      return {
        hostPrincipalId: "api-key-principal",
        principalId: "owner-principal",
        organizationId: "org_from_key",
        scopes: ["resources:write"],
        kind: "api_key",
      } as const;
    },
  } as Pick<Accounts, "authenticate"> as Accounts;
  const control = createControlRoutes({
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    publicOrigin: "https://api.example.test",
    originReservations,
  });
  return {
    prepareCalls,
    activationCalls,
    fetch: createRouter({
      control,
      takoformV2Host: { fetch: async () => null },
      publicOrigin: "https://api.example.test",
    }),
  };
}

function request(body: unknown, suffix = ""): Request {
  return new Request(
    `https://api.example.test/v1/worker-endpoint-origin-reservations/reservation_01${suffix}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer organization-key",
        "content-type": "application/json",
        origin: "https://generic-client.example",
      },
      body: JSON.stringify(body),
    },
  );
}

async function sharedFixture(
  options: { missingSchema?: boolean; wrongOrigin?: boolean; ambiguous?: boolean } = {},
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const actual = createSqliteSql(db);
  let loseAck = false;
  let blockAfterCommit = false;
  let blockRead = false;
  let batches = 0;
  const sql: Sql = {
    ...actual,
    async query(query, params) {
      if (blockRead) throw new SqlError("unavailable", "fixture primary loss");
      return actual.query(query, params);
    },
    async batch(statements) {
      batches++;
      const result = await actual.batch(statements);
      if (loseAck) {
        loseAck = false;
        blockRead = blockAfterCommit;
        throw new SqlError("unavailable", "fixture lost ACK after actual commit");
      }
      return result;
    },
  };
  // UNALLOCATED shared fixture only. The original carrier table above is real canonical schema.
  if (!options.missingSchema)
    for (const realm of ["staging", "production"]) {
      const prefix = `shared_app_${realm}`;
      db.exec(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY,name TEXT NOT NULL,organization_id TEXT NOT NULL,product TEXT NOT NULL,
      reservation_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,script TEXT,released_at INTEGER,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,binding_kind TEXT,binding_json TEXT,
      UNIQUE(organization_id,reservation_id),CHECK(generation BETWEEN 1 AND 9007199254740990),
      CHECK(state IN ('reserved','active','released')),CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(updated_at>=created_at),CHECK((binding_kind IS NULL AND binding_json IS NULL
        AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
        OR (binding_kind IS 'form-v2@1' AND script IS NULL AND ((state IN ('reserved','released') AND binding_json IS NULL)
          OR (state='active' AND binding_json IS NOT NULL AND json_valid(binding_json)=1)))));
      CREATE TABLE ${prefix}_names (normalized_name TEXT PRIMARY KEY,incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
        generation INTEGER NOT NULL,state TEXT NOT NULL,released_at INTEGER,updated_at INTEGER NOT NULL,
        CHECK(generation BETWEEN 1 AND 9007199254740990),CHECK((state='released')=(released_at IS NOT NULL)));
      CREATE TABLE ${prefix}_batch_assertions (witness TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1),
        apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)));
      CREATE TABLE ${prefix}_route_commands (
        organization_id TEXT NOT NULL,product TEXT NOT NULL,reservation_id TEXT NOT NULL,name TEXT NOT NULL,
        incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
        action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')),command_ref TEXT NOT NULL,
        prior_generation INTEGER NOT NULL,prior_state TEXT NOT NULL,prior_script TEXT,next_script TEXT,
        endpoint_uid TEXT NOT NULL,endpoint_generation INTEGER NOT NULL,worker_uid TEXT NOT NULL,
        deployment_uid TEXT NOT NULL,deployment_generation INTEGER NOT NULL,source_operation_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,target_key TEXT NOT NULL,next_generation INTEGER NOT NULL,next_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,form_v2_original_json TEXT,
        PRIMARY KEY(organization_id,command_ref),UNIQUE(incarnation,next_generation),
        CHECK(next_generation=prior_generation+1),CHECK(next_generation BETWEEN 2 AND 9007199254740990))`);
    }
  if (!options.missingSchema)
    db.exec(`CREATE TABLE shared_app_staging_endpoint_bindings (
      incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
      organization_id TEXT NOT NULL,product TEXT NOT NULL,reservation_id TEXT NOT NULL,name TEXT NOT NULL,
      endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),endpoint_generation INTEGER NOT NULL,
      form_url TEXT NOT NULL,backend_id TEXT NOT NULL,target_key TEXT NOT NULL,
      create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
      current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
  let at = Date.parse("2026-10-15T00:00:00Z");
  const clock = () => new Date(at);
  const identity = {
    async verify({ assertion }: { assertion: string }) {
      return {
        providerSubject: assertion,
        email: `${assertion}@example.test`,
        displayName: assertion,
      };
    },
  };
  const accounts = createAccounts({ sql, clock, identity });
  const session = await accounts.signIn({ provider: "google", assertion: "shared-carrier-owner" });
  const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
  if (!actor) throw new Error("missing actual account");
  const org = await accounts.createOrganization({ actor, name: "Carrier owner" });
  const key = await accounts.createApiKey({
    actor,
    organizationId: org.id,
    name: "actual carrier writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3600,
  });
  const moduleForm = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (form) => form.identity.formRef.kind === "ModuleWorker",
  )?.identity.formRef;
  if (!moduleForm) throw new Error("missing actual stable ModuleWorker Form");
  const sold = (id: string): Offering => ({
    id,
    providerPackRef: "carrier-fixture",
    providerInstallationRef: "carrier-fixture.integration",
    supplyContractRef: "fixture:contract",
    pricePlanRef: `${id}.price`,
    resourceClass: "worker.module",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "fixture:support",
    abusePolicyRef: "fixture:abuse",
    kind: "ModuleWorker",
    displayName: "Carrier fixture",
    form: moduleForm,
    pricePlan: {
      id: `${id}.price`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: [],
    portability: {
      api: "portable",
      exportFormats: [],
      importFormats: [],
      migrationModes: ["offline"],
    },
    isolation: "shared-resource",
    available: true,
  });
  const offerings = [
    sold("carrier.worker.integration"),
    ...(options.ambiguous ? [sold("carrier.worker.other")] : []),
  ];
  const state = createFakeProviderState();
  let derives = 0;
  const provider = Object.assign(
    new FakeProvider({
      id: "carrier-fixture",
      state,
      offerings: offerings.map(
        (item): ProviderOffering => ({
          id: item.id,
          kind: "ModuleWorker",
          displayName: item.displayName,
          form: moduleForm,
          providedInterfaces: [],
          bindingRefs: [],
          capabilities: ["create", "delete", "observe"],
        }),
      ),
    }),
    {
      workerEndpointOriginReservations: {
        async derive({ requestedSubdomain }: { tenantRef: string; requestedSubdomain: string }) {
          derives++;
          return {
            canonicalPublicOrigin: `https://${requestedSubdomain}.${options.wrongOrigin ? "wrong.example.test" : "app-staging.takos.jp"}`,
          };
        },
      },
    },
  );
  const ledger = createSharedAppLedger({ environment: "staging", primary: () => sql, clock });
  const app = buildApp({
    sql,
    clock,
    identity,
    objects: createMemoryObjectStore(),
    publicOrigin: "https://carrier-api.example.test",
    settlement: {
      async verify() {
        throw new Error("not configured");
      },
    },
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings,
    providers: [provider],
    v2: {
      cursorSigningKey: new Uint8Array(32).fill(0x61),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/auth",
    },
    v2WorkerEndpointOrigin: {
      kind: "form-v2@1",
      ledger,
      formUrl: "https://forms.example.test/fixture/Carrier/1.0.0",
      backendId: "carrier-endpoint",
      targetKey: "carrier-integration",
    },
  });
  const call = (method: string, id = "carrier-original", body?: unknown, token = key.secret) =>
    app.fetch(
      new Request(`https://carrier-api.example.test/v1/worker-endpoint-origin-reservations/${id}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const body = (name = "integration-carrier") => ({
    format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
    requestedSubdomain: name,
    expiresInSeconds: 60,
  });
  const snapshot = async () => ({
    metadata: await actual.query(
      "SELECT * FROM worker_endpoint_origin_reservations ORDER BY reservation_id",
    ),
    names: await actual.query("SELECT * FROM shared_app_staging_names ORDER BY normalized_name"),
    assignments: await actual.query(
      "SELECT * FROM shared_app_staging_assignments ORDER BY incarnation",
    ),
    witnesses: await actual.query(
      "SELECT * FROM shared_app_staging_batch_assertions ORDER BY witness",
    ),
  });
  return {
    db,
    sql,
    actual,
    app,
    accounts,
    actor,
    org,
    key,
    ledger,
    call,
    body,
    snapshot,
    state,
    derives: () => derives,
    batches: () => batches,
    advance(ms: number) {
      at += ms;
    },
    loseAck(unavailableReadback = false) {
      loseAck = true;
      blockAfterCommit = unavailableReadback;
    },
    blockReads(value: boolean) {
      blockRead = value;
    },
  };
}

test("shared carrier actual authenticated PUT/GET keeps the seven-key wire and one original allocator", async () => {
  const f = await sharedFixture();
  try {
    const response = await f.call("PUT", "carrier-original", f.body());
    expect(response.status).toBe(201);
    const projection = await response.json();
    expect(Object.keys(projection).sort()).toEqual(
      [
        "format",
        "reservationId",
        "requestedSubdomain",
        "canonicalPublicOrigin",
        "revision",
        "expiresAt",
        "status",
      ].sort(),
    );
    expect(projection).toEqual({
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      reservationId: "carrier-original",
      requestedSubdomain: "integration-carrier",
      canonicalPublicOrigin: "https://integration-carrier.app-staging.takos.jp",
      revision: "1",
      expiresAt: "2026-10-15T00:01:00.000Z",
      status: "prepared",
    });
    const original = await f.ledger
      .forTrustedOwner({ organizationId: f.org.id, product: "takoserver" })
      .readOriginalRoute("carrier-original");
    expect(original?.kind).toBe("scalar");
    expect(original?.kind === "scalar" ? original.value.name : null).toBe("integration-carrier");
    const before = await f.snapshot();
    expect(before.names).toHaveLength(1);
    expect(before.metadata).toHaveLength(1);
    expect(before.witnesses).toEqual([]);
    expect(await (await f.call("GET")).json()).toEqual(projection);
    expect(await (await f.call("PUT", "carrier-original", f.body())).json()).toEqual(projection);
    expect(await f.snapshot()).toEqual(before);
    expect(f.state.sideEffectCount).toBe(0);
    expect(
      (await f.call("PUT", "carrier-original", { ...f.body(), expiresInSeconds: 120 })).status,
    ).toBe(409);
    expect((await f.call("DELETE")).status).toBe(204);
    expect((await f.snapshot()).metadata[0]).toMatchObject({ state: "released", revision: 2 });
  } finally {
    f.db.close();
  }
});

test("shared carrier cancels a never-accepted original as a permanent tombstone", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    const owner = f.ledger.forTrustedOwner({
      organizationId: f.org.id,
      product: "takoserver",
    });
    const original = await owner.readOriginalRoute("carrier-original");
    if (original?.kind !== "scalar") throw new Error("missing actual carrier original");
    expect(original.value.state).toBe("reserved");
    expect(original.value.generation).toBe(1);

    const response = await f.call("DELETE");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await owner.readOriginalRoute("carrier-original")).toEqual({
      kind: "scalar",
      value: {
        ...original.value,
        generation: 2,
        state: "released",
        releasedAt: Date.parse("2026-10-15T00:00:00Z"),
      },
    });
    expect(await f.ledger.readCurrentRoute(original.value.name)).toBeNull();
    expect((await f.call("GET")).status).toBe(404);
    const released = await f.snapshot();
    f.advance(10_000);
    expect((await f.call("DELETE")).status).toBe(204);
    expect(await f.snapshot()).toEqual(released);
    expect((await f.call("PUT", "replacement-original", f.body())).status).toBe(409);
    expect(await f.snapshot()).toEqual(released);
    expect(f.state.sideEffectCount).toBe(0);
  } finally {
    f.db.close();
  }
});

test("shared carrier cancellation metadata failure rolls back its whole original", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    await f.actual.run(`CREATE TRIGGER fixture_shared_cancel_metadata_failure
      BEFORE UPDATE OF state ON worker_endpoint_origin_reservations
      WHEN OLD.reservation_id='carrier-original' AND NEW.state='released'
      BEGIN SELECT RAISE(ABORT,'fixture actual cancellation metadata failure'); END`);
    const original = await f.snapshot();
    const writes = f.batches();
    expect((await f.call("DELETE")).status).toBe(503);
    expect(f.batches() - writes).toBe(1);
    expect(await f.snapshot()).toEqual(original);
    expect((await f.call("GET")).status).toBe(200);
    expect(f.state.sideEffectCount).toBe(0);
  } finally {
    f.db.close();
  }
});

test("shared carrier cancellation lost ACK settles the first timestamp without another writer", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    const owner = f.ledger.forTrustedOwner({
      organizationId: f.org.id,
      product: "takoserver",
    });
    const original = await owner.readOriginalRoute("carrier-original");
    if (original?.kind !== "scalar") throw new Error("missing actual carrier original");
    f.advance(2_000);
    const writes = f.batches();
    f.loseAck();
    expect((await f.call("DELETE")).status).toBe(204);
    expect(f.batches() - writes).toBe(1);
    expect(await owner.readOriginalRoute("carrier-original")).toEqual({
      kind: "scalar",
      value: {
        ...original.value,
        generation: 2,
        state: "released",
        releasedAt: Date.parse("2026-10-15T00:00:02Z"),
      },
    });
    const committed = await f.snapshot();
    f.advance(20_000);
    expect((await f.call("DELETE")).status).toBe(204);
    expect((await f.call("GET")).status).toBe(404);
    expect(f.batches() - writes).toBe(1);
    expect(await f.snapshot()).toEqual(committed);
    expect(f.state.sideEffectCount).toBe(0);
  } finally {
    f.db.close();
  }
});

test("shared carrier cancellation unresolved ACK retains its original for read-only recovery", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    const owner = f.ledger.forTrustedOwner({
      organizationId: f.org.id,
      product: "takoserver",
    });
    const original = await owner.readOriginalRoute("carrier-original");
    if (original?.kind !== "scalar") throw new Error("missing actual carrier original");
    f.advance(2_000);
    const writes = f.batches();
    f.loseAck(true);
    expect((await f.call("DELETE")).status).toBe(503);
    expect(f.batches() - writes).toBe(1);
    const committed = await f.snapshot();
    expect(committed.assignments).toHaveLength(1);
    expect(committed.assignments[0]).toMatchObject({
      reservation_id: "carrier-original",
      incarnation: original.value.incarnation,
      generation: 2,
      state: "released",
      released_at: Date.parse("2026-10-15T00:00:02Z"),
    });
    f.blockReads(false);
    f.advance(20_000);
    expect((await f.call("DELETE")).status).toBe(204);
    expect((await f.call("GET")).status).toBe(404);
    expect(f.batches() - writes).toBe(1);
    expect(await f.snapshot()).toEqual(committed);
    expect(f.state.sideEffectCount).toBe(0);
  } finally {
    f.db.close();
  }
});

test("shared carrier refuses active tagged retired and ambiguous originals without a cancellation writer", async () => {
  for (const scenario of ["active", "tagged", "retired", "ambiguous"] as const) {
    const f = await sharedFixture();
    try {
      expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
      const owner = f.ledger.forTrustedOwner({ organizationId: f.org.id, product: "takoserver" });
      const original = await owner.readOriginal("carrier-original");
      if (!original) throw new Error("missing actual original");
      if (scenario === "active") await owner.activate(original, "accepted-script");
      if (scenario === "tagged")
        await f.sql.run(
          "UPDATE shared_app_staging_assignments SET binding_kind='form-v2@1' WHERE incarnation=?",
          [original.incarnation],
        );
      if (scenario === "retired") {
        // Negative degraded fixture: a later non-serving generation is never an untouched hold.
        await f.sql.run(
          "UPDATE shared_app_staging_assignments SET generation=3 WHERE incarnation=?",
          [original.incarnation],
        );
        await f.sql.run("UPDATE shared_app_staging_names SET generation=3 WHERE incarnation=?", [
          original.incarnation,
        ]);
      }
      if (scenario === "ambiguous")
        await f.sql.run(
          `INSERT INTO shared_app_staging_assignments
          (incarnation,name,organization_id,product,reservation_id,generation,state,script,released_at,created_at,updated_at)
          VALUES (?,?,?,'takosumi-hosted','conflicting-original',1,'reserved',NULL,NULL,?,?)`,
          [
            crypto.randomUUID().replaceAll("-", ""),
            original.name,
            "another-org",
            Date.parse("2026-10-15T00:00:00Z"),
            Date.parse("2026-10-15T00:00:00Z"),
          ],
        );
      const before = await f.snapshot();
      const writes = f.batches();
      expect((await f.call("DELETE")).status).toBe(422);
      expect(f.batches()).toBe(writes);
      expect(await f.snapshot()).toEqual(before);
      expect(f.state.sideEffectCount).toBe(0);
    } finally {
      f.db.close();
    }
  }
}, 20_000);

test("shared carrier refuses retained native hostname rows across providers and both route generations", async () => {
  for (const state of ["active", "tombstone"] as const)
    for (const version of ["v1", "v2"] as const) {
      const f = await sharedFixture();
      try {
        expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
        await f.sql.run(
          `INSERT INTO cloudflare_managed_worker_routes
          (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
          VALUES ('different-provider','host',?,'retained-native-owner',1,'retained-native-operation',?,'{}')`,
          [`host/${version}/integration-carrier.app-staging.takos.jp`, state],
        );
        const before = await f.snapshot();
        const routes = await f.actual.query("SELECT * FROM cloudflare_managed_worker_routes");
        const writes = f.batches();
        expect((await f.call("DELETE")).status).toBe(422);
        expect(f.batches()).toBe(writes);
        expect(await f.snapshot()).toEqual(before);
        expect(await f.actual.query("SELECT * FROM cloudflare_managed_worker_routes")).toEqual(
          routes,
        );
      } finally {
        f.db.close();
      }
    }
}, 20_000);

test("shared carrier terminal CHECK rejects an ignored metadata update and retains all original rows", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    f.db.exec(`CREATE TRIGGER ignore_cancellation_metadata BEFORE UPDATE OF state ON worker_endpoint_origin_reservations
      WHEN NEW.state='released' BEGIN SELECT RAISE(IGNORE); END`);
    const before = await f.snapshot();
    const writes = f.batches();
    expect((await f.call("DELETE")).status).toBe(503);
    expect(f.batches() - writes).toBe(1);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.call("GET")).status).toBe(200);
  } finally {
    f.db.close();
  }
});

for (const scenario of ["ambiguous", "malformed-product", "malformed-binding"] as const)
  test(`shared carrier ${scenario} competing original stays unavailable after a refused allocation`, async () => {
    const f = await sharedFixture();
    try {
      expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
      const original = await f.ledger
        .forTrustedOwner({ organizationId: f.org.id, product: "takoserver" })
        .readOriginal("carrier-original");
      if (!original) throw new Error("missing real competing original");
      if (scenario === "ambiguous")
        await f.sql.run(
          `INSERT INTO shared_app_staging_assignments
          (incarnation,name,organization_id,product,reservation_id,generation,state,script,released_at,created_at,updated_at)
          VALUES (?,?,?,'takosumi-hosted','other-retained-original',1,'reserved',NULL,NULL,?,?)`,
          [
            crypto.randomUUID().replaceAll("-", ""),
            original.name,
            "another-org",
            Date.parse("2026-10-15T00:00:00Z"),
            Date.parse("2026-10-15T00:00:00Z"),
          ],
        );
      else if (scenario === "malformed-product")
        // Deliberately corrupt product data is not a new product/owner grant.
        await f.sql.run(
          "UPDATE shared_app_staging_assignments SET product='unknown-product' WHERE incarnation=?",
          [original.incarnation],
        );
      else {
        // The physical CHECK accepts valid JSON, but this is not a valid typed route binding.
        await f.sql.run(
          "UPDATE shared_app_staging_assignments SET state='active',binding_kind='form-v2@1',binding_json='{}' WHERE incarnation=?",
          [original.incarnation],
        );
        await f.sql.run("UPDATE shared_app_staging_names SET state='active' WHERE incarnation=?", [
          original.incarnation,
        ]);
      }
      const before = await f.snapshot();
      const writes = f.batches();
      expect((await f.call("PUT", "replacement-original", f.body())).status).toBe(503);
      expect(f.batches() - writes).toBe(1);
      expect(await f.snapshot()).toEqual(before);
      expect(f.state.sideEffectCount).toBe(0);
    } finally {
      f.db.close();
    }
  });

test("shared carrier compatibility expiry retains the permanent original without reclaim or renewal", async () => {
  const f = await sharedFixture();
  try {
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    const before = await f.snapshot();
    f.advance(61000);
    expect((await f.call("GET")).status).toBe(404);
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(409);
    expect((await f.call("PUT", "another-reference", f.body())).status).not.toBe(201);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("shared carrier normalizes one global name without allocating it to another authenticated Organization", async () => {
  const f = await sharedFixture();
  try {
    const other = await f.accounts.createOrganization({
      actor: f.actor,
      name: "Other actual carrier owner",
    });
    const otherKey = await f.accounts.createApiKey({
      actor: f.actor,
      organizationId: other.id,
      name: "other actual writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3600,
    });
    const first = await f.call("PUT", "carrier-original", f.body("ｉｎｔｅｇｒａｔｉｏｎ-carrier"));
    expect(first.status).toBe(201);
    const projection: unknown = await first.json();
    if (
      typeof projection !== "object" ||
      projection === null ||
      !("requestedSubdomain" in projection)
    )
      throw new Error("missing actual projection");
    expect(projection.requestedSubdomain).toBe("integration-carrier");
    const before = await f.snapshot();
    expect((await f.call("PUT", "other-original", f.body(), otherKey.secret)).status).not.toBe(201);
    expect(await f.snapshot()).toEqual(before);
    expect(
      await f.ledger
        .forTrustedOwner({ organizationId: other.id, product: "takoserver" })
        .readOriginalRoute("other-original"),
    ).toBeNull();
  } finally {
    f.db.close();
  }
});

test("shared carrier real metadata failure rolls back name, assignment and witness in the same writer", async () => {
  const f = await sharedFixture();
  try {
    await f.sql.run(`CREATE TRIGGER fixture_shared_metadata_failure BEFORE INSERT ON worker_endpoint_origin_reservations
      WHEN NEW.requested_subdomain='integration-carrier' AND EXISTS (SELECT 1 FROM shared_app_staging_names WHERE normalized_name=NEW.requested_subdomain)
      BEGIN SELECT RAISE(ABORT,'fixture real metadata fault after owning allocation'); END`);
    const before = await f.snapshot();
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(503);
    expect(await f.snapshot()).toEqual(before);
    expect(f.state.sideEffectCount).toBe(0);
  } finally {
    f.db.close();
  }
});

test("shared carrier lost actual commit ACK settles the same original without another write", async () => {
  const f = await sharedFixture();
  try {
    const before = f.batches();
    f.loseAck();
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    expect(f.batches() - before).toBe(1);
    const committed = await f.snapshot();
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    expect(f.batches() - before).toBe(1);
    expect(await f.snapshot()).toEqual(committed);
  } finally {
    f.db.close();
  }
});

test("shared carrier unresolved commit ACK retains the actual original and never repeats its allocation", async () => {
  const f = await sharedFixture();
  try {
    const before = f.batches();
    f.loseAck(true);
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(503);
    expect(f.batches() - before).toBe(1);
    const committed = await f.snapshot();
    expect(committed.assignments.length).toBe(1);
    expect(committed.metadata.length).toBe(1);
    f.blockReads(false);
    const read = await f.call("GET");
    expect(read.status).toBe(200);
    const projection = await read.json();
    expect(projection.reservationId).toBe("carrier-original");
    expect((await f.call("PUT", "carrier-original", f.body())).status).toBe(201);
    expect(f.batches() - before).toBe(1);
    expect(await f.snapshot()).toEqual(committed);
  } finally {
    f.db.close();
  }
});

test("shared carrier refuses absent schema, wrong derive, ambiguous Offering and insufficient real credential", async () => {
  for (const options of [{ missingSchema: true }, { wrongOrigin: true }, { ambiguous: true }]) {
    const f = await sharedFixture(options);
    try {
      expect((await f.call("PUT", "carrier-original", f.body())).status).not.toBe(201);
      expect(await f.actual.query("SELECT * FROM worker_endpoint_origin_reservations")).toEqual([]);
      expect(f.state.sideEffectCount).toBe(0);
    } finally {
      f.db.close();
    }
  }
  const f = await sharedFixture();
  try {
    const reader = await f.accounts.createApiKey({
      actor: f.actor,
      organizationId: f.org.id,
      name: "actual reader",
      scopes: ["resources:read"],
      expiresInSeconds: 3600,
    });
    expect((await f.call("PUT", "carrier-original", f.body(), reader.secret)).status).toBe(403);
    expect((await f.snapshot()).assignments).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("HTTP prepare accepts only a requested subdomain and derives organization authority from auth", async () => {
  const { fetch, prepareCalls } = fixture();
  const response = await fetch(
    request({
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      requestedSubdomain: "community-public",
      offeringId: "worker.module.test",
      expiresInSeconds: 600,
    }),
  );

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(PROJECTION);
  expect(prepareCalls).toEqual([
    {
      organizationId: "org_from_key",
      reservationId: "reservation_01",
      requestedSubdomain: "community-public",
      offeringId: "worker.module.test",
      expiresInSeconds: 600,
    },
  ]);
  expect(JSON.stringify(prepareCalls)).not.toMatch(/target|space|workerName|endpointName/);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("HTTP prepare rejects the retired v1 target and any body organization override", async () => {
  const { fetch, prepareCalls } = fixture();
  for (const body of [
    {
      format: "takoserver.worker-endpoint-origin-reservation.v1",
      target: { space: "default", workerName: "community", endpointName: "public" },
      expiresInSeconds: 600,
    },
    {
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      organizationId: "org_from_body",
      requestedSubdomain: "community-public",
      expiresInSeconds: 600,
    },
  ]) {
    const response = await fetch(request(body));
    expect(response.status).toBe(400);
  }
  expect(prepareCalls).toEqual([]);
});

test("HTTP activation accepts only the endpoint UID and never a restated worker identity", async () => {
  const { fetch, activationCalls } = fixture();
  const activated = await fetch(
    request(
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
      "/activation",
    ),
  );
  expect(activated.status).toBe(200);
  expect(activationCalls).toEqual([
    {
      organizationId: "org_from_key",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    },
  ]);

  const restated = await fetch(
    request(
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
        workerName: "community",
      },
      "/activation",
    ),
  );
  expect(restated.status).toBe(400);
  expect(activationCalls).toHaveLength(1);
});

/**
 * A Host-minted reservation is one no caller may write to, and one every
 * caller may read.
 *
 * Writing is what the fence is for: the id is derived from an address the
 * tenant knows, so a row a caller planted at that id would be adopted as one
 * this Host made. Reading it is the tenant's own derived origin, already scoped
 * to the authenticated organization — and refusing that would leave a tenant
 * unable to see the address their own Worker was given.
 */
test("the Host-minted namespace refuses every write and answers a read", async () => {
  const { fetch, prepareCalls, activationCalls } = fixture();
  const minted = "hostmint-0000000000000000000000000000000000000000";
  const call = (method: string, suffix = "", body?: unknown) =>
    fetch(
      new Request(
        `https://api.example.test/v1/worker-endpoint-origin-reservations/${minted}${suffix}`,
        {
          method,
          headers: {
            authorization: "Bearer organization-key",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    );

  for (const [method, suffix, body] of [
    [
      "PUT",
      "",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
        requestedSubdomain: "community-public",
        expiresInSeconds: 600,
      },
    ],
    ["DELETE", "", undefined],
    [
      "PUT",
      "/activation",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
    ],
    [
      "DELETE",
      "/activation",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
    ],
  ] as const) {
    expect((await call(method, suffix, body)).status).toBe(404);
  }
  expect(prepareCalls).toEqual([]);
  expect(activationCalls).toEqual([]);

  expect((await call("GET")).status).toBe(200);
});

/**
 * The reseller reading this route gets the same sentence as everybody else.
 *
 * A reservation refused because *this deployment* cannot publish the address it
 * would derive is the caller's to act on but not the caller's to have caused,
 * and `unsupported_capability` alone says which of those two it is and nothing
 * about which knob to turn. The boot diagnostic and the Takoform Host lane both
 * name the remedies; so does this.
 */
test("a reservation refused by this deployment's own configuration says which knob to turn", async () => {
  const remedy =
    "no Worker endpoint can be published here: this deployment's address is plain HTTP, " +
    "and WorkerEndpoint@0.1.0 admits only https on the default port.";
  const { fetch } = fixture(
    new WorkerEndpointOriginReservationError("unsupported_capability", 422, remedy),
  );
  const response = await fetch(
    request({
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      requestedSubdomain: "community-public",
      expiresInSeconds: 600,
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: "unsupported_capability", message: remedy, retryable: false },
  });
});
