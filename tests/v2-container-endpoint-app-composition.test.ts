/**
 * App/Store composer boundary checks with actual HTTP and acceptance paths.
 * The fixture Form and shared DDL permit conflicts and ordinary admissions.
 * There is no Container owner schema or native producer: no positive N claim.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type AppPorts, buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import type { Offering } from "../src/catalog.ts";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createV2ContainerHostAcceptance } from "../src/takoform-v2/container-owner-schema.ts";
import {
  prepareV2HostAcceptance,
  redeemV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2HostAcceptanceScope,
  type V2PreparedHostAcceptance,
} from "../src/takoform-v2/host-acceptance.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerEndpointOriginV2Acceptance } from "../src/worker-endpoint-origin-v2-acceptance.ts";

const ORIGIN = "https://api.app-origin-composition.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = C.formUrl;
const BACKEND = "fixture-app-origin-backend";
const TARGET = "fixture-app-origin-target";
const BINDINGS = "shared_app_staging_endpoint_bindings";
const AT = "2026-10-15T00:00:00.000Z";
const SPEC = Object.freeze({
  image: `registry.example/image@sha256:${"d".repeat(64)}`,
  httpPort: 8080,
  healthPath: "/",
  workloadRevision: "fixture-r1",
  requiredSensitiveVars: [],
  outboundInternet: true,
});
type Selection = NonNullable<AppPorts["v2WorkerEndpointOrigin"]>;

// Exact existing fixture constraints; still test-owned, UNALLOCATED DDL.
function sharedSchema(db: Database, includeBindings: boolean, typed = false): void {
  // Preserve the stronger original ledger fixture checks, not the relaxed route fixture.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    const variantChecks = typed
      ? `CHECK((binding_kind IS NULL AND binding_json IS NULL
          AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
        OR (binding_kind IS 'form-v2@1' AND script IS NULL AND
          ((state IN ('reserved','released') AND binding_json IS NULL)
            OR (state='active' AND binding_json IS NOT NULL AND json_valid(binding_json)=1))))`
      : `CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL)`;
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
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${typed ? ", binding_kind TEXT, binding_json TEXT" : ""},
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at),
      ${variantChecks})`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY
        CHECK(length(normalized_name) BETWEEN 3 AND 32
          AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
    db.exec(`CREATE TABLE ${prefix}_batch_assertions (witness TEXT PRIMARY KEY,
      ok INTEGER NOT NULL CHECK(ok=1),apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
    if (typed)
      db.exec(`CREATE TABLE ${prefix}_route_commands (
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

async function fixture(
  options: { shared?: boolean; bindings?: boolean; typed?: boolean; carrier?: boolean } = {},
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const raw = createSqliteSql(db);
  if (options.shared !== false)
    sharedSchema(db, options.bindings !== false, options.typed === true);
  const statements: SqlStatement[] = [];
  const batches: (readonly SqlStatement[])[] = [];
  let lastBatchError: unknown;
  let actualBatchCalls = 0;
  let pausedBatch:
    | {
        readonly entered: (batch: readonly SqlStatement[]) => void;
        readonly untilResumed: Promise<void>;
      }
    | undefined;
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
      const paused = pausedBatch;
      pausedBatch = undefined;
      if (paused) {
        paused.entered(captured);
        await paused.untilResumed;
      }
      lastBatchError = undefined;
      try {
        actualBatchCalls++;
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
  let typedOriginalReads = 0;
  let refuseOriginalRead = false;
  let originalReadGate:
    | {
        readonly entered: () => void;
        readonly untilResumed: Promise<void>;
        readonly settled: () => void;
      }
    | undefined;
  const actualForOwner = ledger.forTrustedOwner.bind(ledger);
  ledger.forTrustedOwner = (trustedOwner) => {
    const actual = actualForOwner(trustedOwner);
    return {
      ...actual,
      async readOriginal(id) {
        originalReads++;
        if (refuseOriginalRead) throw new SqlError("unavailable", "component read unavailable");
        const original = await actual.readOriginal(id);
        const gate = originalReadGate;
        originalReadGate = undefined;
        if (gate) {
          gate.entered();
          await gate.untilResumed;
          // Endpoint CREATE compiles synchronously after this original is
          // returned. The next event-loop task runs after its prepare promise
          // and the App's response continuations have had a microtask drain.
          setImmediate(gate.settled);
        }
        return original;
      },
      async readOriginalRoute(id) {
        typedOriginalReads++;
        if (refuseOriginalRead) throw new SqlError("unavailable", "component read unavailable");
        return actual.readOriginalRoute(id);
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
  const stableModule = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (item) => item.identity.formRef.kind === "ModuleWorker",
  )?.identity.formRef;
  if (!stableModule) throw new Error("stable ModuleWorker missing");
  const offering: Offering = {
    id: "carrier.app.integration",
    providerPackRef: "carrier-app",
    providerInstallationRef: "carrier-app.integration",
    supplyContractRef: "fixture:contract",
    pricePlanRef: "carrier.app.price",
    resourceClass: "worker.module",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "fixture:support",
    abusePolicyRef: "fixture:abuse",
    kind: "ModuleWorker",
    displayName: "Carrier app",
    form: stableModule,
    pricePlan: {
      id: "carrier.app.price",
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
  };
  const provider = Object.assign(
    new FakeProvider({
      id: "carrier-app",
      offerings: [
        {
          id: offering.id,
          kind: "ModuleWorker",
          displayName: offering.displayName,
          form: stableModule,
          providedInterfaces: [],
          bindingRefs: [],
          capabilities: ["create", "delete", "observe"],
        },
      ],
    }),
    {
      workerEndpointOriginReservations: {
        async derive({ requestedSubdomain }: { tenantRef: string; requestedSubdomain: string }) {
          return { canonicalPublicOrigin: `https://${requestedSubdomain}.app-staging.takos.jp` };
        },
      },
    },
  );
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
      ...(options.carrier ? { offerings: [offering], providers: [provider] } : {}),
      v2: {
        cursorSigningKey: new Uint8Array(32).fill(0x5a),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      ...(overrides.v2FormSelectionFactory === undefined
        ? { v2FormFactory: () => ({ [FORM]: form }) }
        : {}),
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
      body: JSON.stringify({ form: FORM, space, name, spec: SPEC }),
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
    control: (
      app: ReturnType<typeof buildApp>,
      method: string,
      reservationId: string,
      name: string,
    ) =>
      app.fetch(
        new Request(`${ORIGIN}/v1/worker-endpoint-origin-reservations/${reservationId}`, {
          method,
          headers: { authorization: `Bearer ${writer.secret}`, "content-type": "application/json" },
          ...(method === "PUT"
            ? {
                body: JSON.stringify({
                  format: "takoserver.worker-endpoint-origin-reservation.v2",
                  requestedSubdomain: name,
                  expiresInSeconds: 60,
                }),
              }
            : {}),
        }),
      ),
    statements,
    batches,
    actualBatches: () => actualBatchCalls,
    pauseNextBatch() {
      if (pausedBatch) throw new Error("an actual owner batch is already paused");
      let entered: ((batch: readonly SqlStatement[]) => void) | undefined;
      let resume: (() => void) | undefined;
      const reached = new Promise<readonly SqlStatement[]>((resolve) => {
        entered = resolve;
      });
      const untilResumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (!entered || !resume) throw new Error("actual batch pause was not constructed");
      pausedBatch = { entered, untilResumed };
      return Object.freeze({ reached, resume });
    },
    reserve: (name: string) =>
      ledger.forTrustedOwner(owner).reserve({ reservationId: `claim-${name}`, name }),
    lastBatchError: () => lastBatchError,
    originalReads: () => originalReads,
    typedOriginalReads: () => typedOriginalReads,
    pauseNextOriginalRead() {
      if (originalReadGate) throw new Error("an original read is already paused");
      let entered: (() => void) | undefined;
      let resume: (() => void) | undefined;
      let settle: (() => void) | undefined;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const untilResumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      if (!entered || !resume || !settle) throw new Error("original read gate was not constructed");
      originalReadGate = { entered, untilResumed, settled: settle };
      return Object.freeze({ reached, resume, settled });
    },
    refuseOriginalReads() {
      refuseOriginalRead = true;
    },
    close() {
      db.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function containerIssuer(sql: Sql): V2HostAcceptance {
  const issuer = createV2ContainerHostAcceptance({
    sql,
    installationId: "fixture-container-installation",
    backendId: BACKEND,
    targetKey: TARGET,
  });
  if (typeof issuer.prepareDelete !== "function")
    throw new Error("genuine Container lower DELETE preparation has not been integrated");
  return issuer;
}

function acceptedCoreBatches(f: Fixture): number {
  return f.batches.filter((batch) =>
    batch.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql)),
  ).length;
}

function assertNoCoreAcceptance(f: Fixture, before: number): void {
  expect(acceptedCoreBatches(f)).toBe(before);
  expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
  expect(f.db.query(`SELECT count(*) AS n FROM ${BINDINGS}`).get()).toEqual({ n: 0 });
}

function deferred() {
  let release: () => void = () => {
    throw new Error("uninitialized acceptance gate");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

function afterPromiseSettlementTurn(): Promise<void> {
  // This is an event-loop boundary, not a duration-based assertion: all
  // microtasks spawned by the marked preparation and HTTP path run first.
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function seedOrdinaryContainerResource(f: Fixture, name: string) {
  const app = f.makeApp();
  const response = await f.create(app, name, `seed-${name}-0001`);
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as { id: string; resourceUid: string };
  expect(await app.tickTakoformV2()).toMatchObject({ id: accepted.id, status: "succeeded" });
  return accepted;
}

function requestDelete(
  f: Fixture,
  app: ReturnType<Fixture["makeApp"]>,
  resourceUid: string,
  key: string,
  generation = 1,
) {
  return f.request(app, `/resources/${resourceUid}`, {
    method: "DELETE",
    headers: { "idempotency-key": key, "takoform-expected-generation": String(generation) },
  });
}

test("retained canonical Container Form cannot DELETE without its code issuer", async () => {
  const f = await fixture();
  try {
    const resource = await seedOrdinaryContainerResource(f, "container-retained-unsigned");
    const retained = f.makeApp(undefined, {
      v2FormSelectionFactory: () => ({ forms: {}, retainedForms: { [FORM]: f.form } }),
    });
    const beforeBatches = f.batches.length;
    const beforeOperations = f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get();
    const beforeResources = f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get();
    const response = await requestDelete(
      f,
      retained,
      resource.resourceUid,
      "container-retained-no-issuer-0001",
    );
    expect(response.status).not.toBe(202);
    expect(f.batches).toHaveLength(beforeBatches);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual(
      beforeOperations,
    );
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual(beforeResources);
    expect(f.lastBatchError()).toBeUndefined();
  } finally {
    f.close();
  }
});

test("configured Container DELETE issuer must be an own data method at App construction", async () => {
  const f = await fixture();
  try {
    const actual = containerIssuer(f.sql);
    const beforeBatches = f.batches.length;
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...actual }, "prepareDelete", {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error("untrusted DELETE getter ran");
      },
    });
    const inherited = Object.create({ prepareDelete: actual.prepareDelete });
    Object.assign(inherited, {
      assertSql: actual.assertSql,
      initialOutput: actual.initialOutput,
      prepare: actual.prepare,
    });
    for (const malformed of [
      { ...actual, prepareDelete: undefined },
      { ...actual, prepareDelete: "enabled" },
      accessor,
      inherited,
    ]) {
      expect(() =>
        f.makeApp(undefined, {
          v2ContainerHostAcceptance: malformed as V2HostAcceptance,
        }),
      ).toThrow("Container Host acceptance requires own prepareDelete method");
    }
    expect(getterCalls).toBe(0);
    expect(f.batches).toHaveLength(beforeBatches);
  } finally {
    f.close();
  }
});

test("canonical Container DELETE refuses an omitted or foreign-context prepared claim before batch", async () => {
  for (const kind of ["omitted", "foreign-context"] as const) {
    const f = await fixture();
    try {
      const resource = await seedOrdinaryContainerResource(f, `container-delete-${kind}`);
      // This is a hostile code-only issuer stub for a negative Store boundary
      // check. It is not a Container N compiler or a positive native claim.
      const issuer: V2HostAcceptance = {
        assertSql(sql) {
          if (sql !== f.sql) throw new TypeError("foreign Sql");
        },
        initialOutput() {
          return undefined;
        },
        prepare() {
          return undefined;
        },
        prepareDelete(context) {
          return kind === "omitted"
            ? undefined
            : Promise.resolve(
                prepareV2HostAcceptance(
                  f.sql,
                  { ...context },
                  { sql: "SELECT 1" },
                  { sql: "SELECT 1" },
                ),
              );
        },
      };
      const app = f.makeApp(undefined, { v2ContainerHostAcceptance: issuer });
      const beforeBatches = f.batches.length;
      const beforeOperations = f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get();
      const response = await requestDelete(
        f,
        app,
        resource.resourceUid,
        `container-delete-${kind}-0001`,
      );
      expect(response.status).not.toBe(202);
      expect(f.batches).toHaveLength(beforeBatches);
      expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual(
        beforeOperations,
      );
      expect(f.lastBatchError()).toBeUndefined();
    } finally {
      f.close();
    }
  }
});

test("Endpoint-only non-Container DELETE retains ordinary admission and never calls generic prepare", async () => {
  const f = await fixture();
  try {
    const otherForm = "https://forms.example.test/fixture/OtherEndpoint/1.0.0";
    const selected = { ...f.selection, formUrl: otherForm };
    const name = "endpoint-ordinary-delete";
    await f.reserve(name);
    const app = f.makeApp(selected, { v2FormFactory: () => ({ [otherForm]: f.form }) });
    const created = await f.request(app, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "endpoint-ordinary-create-0001" },
      body: JSON.stringify({
        form: otherForm,
        space: f.owner.organizationId,
        name,
        spec: SPEC,
      }),
    });
    expect(created.status).toBe(202);
    const resource = (await created.json()) as { id: string; resourceUid: string };
    expect(await app.tickTakoformV2()).toMatchObject({ id: resource.id, status: "succeeded" });
    const beforeReads = f.originalReads();
    const deleted = await requestDelete(
      f,
      app,
      resource.resourceUid,
      "endpoint-ordinary-delete-0001",
    );
    expect(deleted.status).toBe(202);
    expect(f.originalReads()).toBe(beforeReads);
    expect(f.lastBatchError()).toBeUndefined();
  } finally {
    f.close();
  }
});

test("no-composer non-Container CREATE, UPDATE, and DELETE keep ordinary admission", async () => {
  const f = await fixture();
  try {
    const otherForm = "https://forms.example.test/fixture/OrdinaryForm/1.0.0";
    const app = f.makeApp(undefined, { v2FormFactory: () => ({ [otherForm]: f.form }) });
    const created = await f.request(app, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "ordinary-no-composer-create-0001" },
      body: JSON.stringify({
        form: otherForm,
        space: f.owner.organizationId,
        name: "ordinary-no-composer",
        spec: SPEC,
      }),
    });
    expect(created.status).toBe(202);
    const resource = (await created.json()) as { id: string; resourceUid: string };
    expect(await app.tickTakoformV2()).toMatchObject({ id: resource.id, status: "succeeded" });
    const updated = await f.request(app, `/resources/${resource.resourceUid}`, {
      method: "PUT",
      headers: {
        "idempotency-key": "ordinary-no-composer-update-0001",
        "takoform-expected-generation": "1",
      },
      body: JSON.stringify({ spec: { ...SPEC, workloadRevision: "fixture-r2" } }),
    });
    expect(updated.status).toBe(202);
    const updateOperation = (await updated.json()) as { id: string };
    expect(await app.tickTakoformV2()).toMatchObject({
      id: updateOperation.id,
      status: "succeeded",
    });
    const deleted = await requestDelete(
      f,
      app,
      resource.resourceUid,
      "ordinary-no-composer-delete-0001",
      2,
    );
    expect(deleted.status).toBe(202);
    expect(f.lastBatchError()).toBeUndefined();
  } finally {
    f.close();
  }
});

test("actual Container and Endpoint preparations settle in either order before overlapping Core admission", async () => {
  for (const order of ["container-first", "endpoint-first"] as const) {
    const f = await fixture();
    const containerGate = deferred();
    const containerSettled = deferred();
    let endpointGate: ReturnType<typeof f.pauseNextOriginalRead> | undefined;
    try {
      const claim = await f.reserve(
        order === "container-first" ? "overlap-container" : "overlap-endpoint",
      );
      const actual = containerIssuer(f.sql);
      let initialScope: V2HostAcceptanceScope | undefined;
      let preparedContext: V2HostAcceptanceContext | undefined;
      const container: V2HostAcceptance = {
        assertSql(sql) {
          actual.assertSql(sql);
        },
        initialOutput(scope) {
          initialScope = scope;
          return actual.initialOutput(scope);
        },
        prepare(context) {
          preparedContext = context;
          const preparing = actual.prepare(context);
          if (preparing === undefined) return undefined;
          // The brand and context come from the genuine Container compiler;
          // only settlement is delayed to exercise the other completion order.
          return preparing.then(async (prepared) => {
            if (order === "endpoint-first") await containerGate.promise;
            containerSettled.release();
            return prepared;
          });
        },
        prepareDelete(context) {
          return actual.prepareDelete?.(context);
        },
      };
      const app = f.makeApp(f.selection, { v2ContainerHostAcceptance: container });
      const before = acceptedCoreBatches(f);
      endpointGate = f.pauseNextOriginalRead();
      let responseSettled = false;
      const pending = f.create(app, claim.name, `container-overlap-${order}-0001`).then(
        (response) => {
          responseSettled = true;
          return response;
        },
        (error) => {
          responseSettled = true;
          throw error;
        },
      );
      await endpointGate.reached;
      expect(initialScope).toMatchObject({
        form: FORM,
        backendId: BACKEND,
        targetKey: TARGET,
        name: claim.name,
      });
      expect(preparedContext).toMatchObject({
        action: "create",
        form: FORM,
        backendId: BACKEND,
        targetKey: TARGET,
        name: claim.name,
      });
      expect(preparedContext?.outputJson).toContain(`${claim.name}.app-staging.takos.jp`);
      if (!preparedContext) throw new Error("actual App preparation did not expose its context");
      assertNoCoreAcceptance(f, before);
      if (order === "container-first") {
        await containerSettled.promise;
        await afterPromiseSettlementTurn();
        expect(responseSettled).toBe(false);
        assertNoCoreAcceptance(f, before);
        endpointGate.resume();
        await endpointGate.settled;
      } else {
        endpointGate.resume();
        await endpointGate.settled;
        expect(responseSettled).toBe(false);
        assertNoCoreAcceptance(f, before);
        containerGate.release();
        await containerSettled.promise;
      }
      // Both genuine issuers have completed their selected CREATE path. The
      // App must now refuse the overlap before attempting an accepted batch.
      // A second genuine Endpoint issuer checks that the same exact context
      // compiles successfully, so an Endpoint compiler/configuration failure
      // cannot masquerade as the composed overlap refusal.
      const endpointWitness = createWorkerEndpointOriginV2Acceptance({
        sql: f.sql,
        ...f.selection,
      });
      const witnessPreparing = endpointWitness.prepare(preparedContext);
      if (witnessPreparing === undefined)
        throw new Error("selected Endpoint preparation was omitted");
      redeemV2HostAcceptance(await witnessPreparing, f.sql, preparedContext);
      const response = await pending;
      expect(response.status).not.toBe(202);
      assertNoCoreAcceptance(f, before);
      expect(f.lastBatchError()).toBeUndefined();
    } finally {
      endpointGate?.resume();
      containerGate.release();
      f.close();
    }
  }
});

test("sole genuine Container preparation keeps its original brand through composed App and Store", async () => {
  const f = await fixture();
  try {
    const actual = containerIssuer(f.sql);
    let originalContext: V2HostAcceptanceContext | undefined;
    let originalPrepared: V2PreparedHostAcceptance | undefined;
    const observed: V2HostAcceptance = {
      assertSql(sql) {
        actual.assertSql(sql);
      },
      initialOutput(scope) {
        return actual.initialOutput(scope);
      },
      prepare(context) {
        originalContext = context;
        const preparing = actual.prepare(context);
        return preparing?.then((prepared) => {
          originalPrepared = prepared;
          return prepared;
        });
      },
      prepareDelete(context) {
        return actual.prepareDelete?.(context);
      },
    };
    const otherEndpoint = {
      ...f.selection,
      formUrl: "https://forms.example.test/fixture/OtherEndpoint/1.0.0",
    };
    const app = f.makeApp(otherEndpoint, { v2ContainerHostAcceptance: observed });
    const before = acceptedCoreBatches(f);
    const response = await f.create(app, "container-sole-original", "container-sole-0001");
    expect(response.status).not.toBe(202);
    if (!originalContext || !originalPrepared)
      throw new Error("genuine Container preparation did not reach the Store");
    const fixed = redeemV2HostAcceptance(originalPrepared, f.sql, originalContext);
    const attempted = f.batches.find((batch) =>
      batch.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql)),
    );
    expect(acceptedCoreBatches(f)).toBe(before + 1);
    expect(attempted?.at(-1)?.sql).toBe(fixed.terminal.sql);
    expect(attempted?.at(-1)?.sql).toContain("INSERT INTO main.tf_v2_container_acceptances");
    expect(f.lastBatchError()).toBeInstanceOf(SqlError);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("rejected Container preparation waits for the held Endpoint preparation before refusing", async () => {
  const f = await fixture();
  const rejectionReached = deferred();
  let endpointGate: ReturnType<typeof f.pauseNextOriginalRead> | undefined;
  try {
    const claim = await f.reserve("overlap-rejection");
    const actual = containerIssuer(f.sql);
    const rejected: V2HostAcceptance = {
      assertSql(sql) {
        actual.assertSql(sql);
      },
      initialOutput(scope) {
        return actual.initialOutput(scope);
      },
      prepare(context) {
        const preparing = actual.prepare(context);
        return preparing?.then(() => {
          rejectionReached.release();
          throw new TypeError("injected Container preparation refusal");
        });
      },
      prepareDelete(context) {
        return actual.prepareDelete?.(context);
      },
    };
    const app = f.makeApp(f.selection, { v2ContainerHostAcceptance: rejected });
    const before = acceptedCoreBatches(f);
    endpointGate = f.pauseNextOriginalRead();
    let settled = false;
    const pending = f.create(app, claim.name, "container-rejection-0001").then(
      (response) => {
        settled = true;
        return response;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    await endpointGate.reached;
    await rejectionReached.promise;
    await afterPromiseSettlementTurn();
    expect(settled).toBe(false);
    assertNoCoreAcceptance(f, before);
    endpointGate.resume();
    await endpointGate.settled;
    const response = await pending;
    expect(response.status).not.toBe(202);
    assertNoCoreAcceptance(f, before);
  } finally {
    endpointGate?.resume();
    f.close();
  }
});

test("App rejects a Container issuer from a distinct Sql object before construction writes", async () => {
  const f = await fixture();
  try {
    const foreign = containerIssuer(f.raw);
    const before = f.batches.length;
    expect(() => f.makeApp(f.selection, { v2ContainerHostAcceptance: foreign })).toThrow(
      "Container Host acceptance belongs to another Sql",
    );
    expect(f.batches).toHaveLength(before);
    assertNoCoreAcceptance(f, acceptedCoreBatches(f));
  } finally {
    f.close();
  }
});
