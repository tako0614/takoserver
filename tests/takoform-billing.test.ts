import { describe, expect, test } from "bun:test";
import { buildEdgeForms, edgeProviderOffering } from "../src/edge-forms.ts";
import {
  buildApp,
  createCatalog,
  createEphemeralSql,
  createLedger,
  createMemoryObjectStore,
  createResourceDeploymentStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

/**
 * The join the old design was missing: declaring a resource through Takoform
 * provisions it on a backend *and* moves money, in that order, settling once.
 */

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
} as const;

const FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  desiredSchema: {
    type: "object",
    properties: { location: { type: "string" } },
    additionalProperties: false,
  },
  observedSchema: { type: "object", additionalProperties: true },
  operations: ["create", "read", "update", "delete", "observe"],
};

const PROVIDER_OFFERING: ProviderOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: FORM_REF,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
};

const SOLD: Offering = {
  id: PROVIDER_OFFERING.id,
  providerPackRef: "fake",
  providerInstallationRef: "fake.primary",
  supplyContractRef: "fake.test-contract",
  pricePlanRef: "storage.object.standard.price-v1",
  resourceClass: "storage.object",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: PROVIDER_OFFERING.kind,
  displayName: PROVIDER_OFFERING.displayName,
  form: FORM_REF,
  pricePlan: {
    id: "storage.object.standard.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 500 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: ["offline"],
  },
  isolation: "dedicated-resource",
  available: true,
};

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "settlement_1", amountMinor: 2_000, currency: "USD" };
  },
};

function newApp(options: { failOn?: readonly string[]; usageOnly?: boolean } = {}) {
  const sql = createEphemeralSql();
  const provider = new FakeProvider({
    offerings: [PROVIDER_OFFERING],
    ...(options.failOn ? { failOn: options.failOn } : {}),
  });
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [FORM],
    hostForms: [FORM],
    takoformHostFactory: createStaticStableTestTakoformHost,
    providers: [provider],
    offerings: [
      options.usageOnly
        ? {
            ...SOLD,
            pricePlan: {
              ...SOLD.pricePlan,
              provisioning: { meter: "resource.create", amountMinor: 0 },
              meters: [{ meter: "storage.gib-hour", amountMinor: 1, quantity: 1_000 }],
            },
          }
        : SOLD,
    ],
  });
  return { app, provider, ledger: createLedger(sql, () => new Date()), sql };
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** Signs in, creates an organization, funds it, and mints a provider key. */
async function tenant(fetch: (request: Request) => Promise<Response>) {
  const session = await call(fetch, "POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified",
  });
  const owner = { authorization: `Bearer ${String(session.body.sessionToken)}` };
  const organization = await call(fetch, "POST", "/v1/organizations", { name: "Acme" }, owner);
  const organizationId = String((organization.body.organization as { id: string }).id);
  await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/wallet/funding`,
    { settlementProof: "proof-1" },
    owner,
  );
  const key = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "takoform", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  return {
    organizationId,
    owner,
    provider: { authorization: `Bearer ${String(key.body.secret)}` },
  };
}

const LANE = "/apis/forms.takoform.com/v1";
const QUERY =
  `space=default&definitionVersion=${FORM_REF.definitionVersion}` +
  `&schemaDigest=${encodeURIComponent(FORM_REF.schemaDigest)}`;

async function applyBucket(
  fetch: (request: Request) => Promise<Response>,
  auth: Record<string, string>,
  name: string,
  spec: Record<string, unknown>,
  idempotencyKey: string,
) {
  const resource = {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name, space: "default" },
    spec,
  };
  const prepared = await call(fetch, "POST", `${LANE}/resources/prepare`, resource, auth);
  const review = prepared.body.review as { prepareDigest: string } | undefined;
  if (!review) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
  const path = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/${name}?${QUERY}`;
  const body = { ...resource, review: { prepareDigest: review.prepareDigest } };
  const headers = { ...auth, "idempotency-key": idempotencyKey, "if-none-match": "*" };
  const response = await call(fetch, "PUT", path, body, headers);
  // The replay is the identical request, not a fresh review: a reviewed
  // prepare belongs to the state it was taken against.
  return { ...response, replay: () => call(fetch, "PUT", path, body, headers) };
}

describe("Takoform apply on a real backend", () => {
  test("inherits one exact provider installation for a revision Form", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-19T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const bundle = await buildEdgeForms();
    const worker = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
    );
    const version = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
    );
    if (!worker || !version) throw new Error("released edge Forms missing");
    const versionOffering = edgeProviderOffering(version, {
      id: "cloudflare.worker-version",
    });
    const provider = new FakeProvider({ offerings: [versionOffering] });
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    await deployments.create({
      tenantId: "org_inherited",
      id: "dep_worker",
      resourceUid: "uid_worker",
      offeringId: "cloudflare.module-worker",
      providerPackRef: "fake",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "worker:script-name",
      state: "active",
      observed: { allocated: true },
      outputs: { scriptName: "script-name" },
    });
    const result = await driver.apply({
      operationId: "op_version",
      tenantId: "org_inherited",
      resourceUid: "uid_version",
      form: version,
      name: "v1",
      space: "default",
      spec: {},
      relations: [
        {
          pointer: "/worker",
          relation: "/worker",
          targetUid: "uid_worker",
          resource: {
            apiVersion: worker.identity.formRef.apiVersion,
            kind: worker.identity.formRef.kind,
            form: worker.identity,
            metadata: {
              name: "api",
              space: "default",
              uid: "uid_worker",
              generation: "1",
              revision: "1",
            },
            spec: {},
            status: { observedGeneration: "1", conditions: [] },
          },
        },
      ],
    });
    expect(result.observed).toEqual({});
    expect(await deployments.active("org_inherited", "uid_version")).toMatchObject({
      offeringId: "cloudflare.worker-version",
      providerPackRef: "fake",
      providerInstallationRef: "cloudflare.primary",
    });
    expect(await createLedger(sql, clock).wallet("org_inherited")).toMatchObject({
      settledMinor: 0,
      heldMinor: 0,
    });
  });

  test("does not charge a reseller reservation a second time inside the provider driver", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-18T18:00:00.000Z");
    const ledger = createLedger(sql, clock);
    const catalog = createCatalog([SOLD]);
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const driver = createProviderDriver({
      providers: [provider],
      catalog,
      ledger,
      deployments: createResourceDeploymentStore(sql, clock),
    });
    await ledger.fund({ organizationId: "org_reseller", fundingRef: "paid", amountMinor: 2_000 });

    await driver.apply({
      operationId: "op_reseller_create",
      tenantId: "org_reseller",
      resourceUid: "uid_reseller_bucket",
      form: FORM,
      name: "media",
      space: "opaque-tenant",
      spec: { location: "apac" },
      relations: [],
      commercialAuthority: {
        reservationId: "rsv_paid",
        offeringId: SOLD.id,
        offeringDigest: await catalog.digest(SOLD),
      },
    });

    expect(await ledger.wallet("org_reseller")).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
    });
    expect(provider.listResources()).toEqual(["org_reseller/opaque-tenant/media"]);
  });

  test("provisions and charges the wallet exactly once", async () => {
    const { app, provider, ledger } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const created = await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "apply-001");
    expect(created.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/assets`]);

    const wallet = await ledger.wallet(organizationId);
    expect(wallet).toMatchObject({ settledMinor: 1_500, heldMinor: 0 });

    // Replaying the same idempotency key must not provision or charge again.
    const replayed = await created.replay();
    expect(replayed.status).toBe(201);
    expect(await ledger.wallet(organizationId)).toMatchObject({ settledMinor: 1_500 });
  });

  test("resumes an executed provider receipt after the final atomic batch is lost", async () => {
    const durable = createEphemeralSql();
    let failFinalBatch = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        if (
          failFinalBatch &&
          statements.some((statement) =>
            statement.sql.includes("DELETE FROM tf_provider_mutation_sagas"),
          )
        ) {
          failFinalBatch = false;
          throw new SqlError("unavailable", "simulated lost final commit acknowledgement");
        }
        return await durable.batch(statements);
      },
    };
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
      clock,
    });
    const { organizationId, provider: auth } = await tenant(app.fetch);
    failFinalBatch = true;

    const first = await applyBucket(app.fetch, auth, "lost-ack", { location: "apac" }, "lost-001");
    expect(first.status).toBe(500);
    expect(provider.listResources()).toEqual([`${organizationId}/default/lost-ack`]);
    expect(
      await sql.query("SELECT phase FROM tf_provider_mutation_sagas WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([{ phase: "executed" }]);
    expect(
      await sql.query("SELECT id FROM tf_resource_deployments WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([]);

    const resumed = await first.replay();
    expect(resumed.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/lost-ack`]);
    expect(
      await sql.query("SELECT operation_id FROM tf_provider_mutation_sagas WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([]);
    expect(
      await sql.query(
        "SELECT resource_uid, state FROM tf_resource_deployments WHERE tenant_id = ?",
        [organizationId],
      ),
    ).toEqual([{ resource_uid: expect.any(String), state: "active" }]);
  });

  test("does not repeat a provider delete after losing its final atomic commit", async () => {
    const durable = createEphemeralSql();
    let failFinalBatch = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        if (
          failFinalBatch &&
          statements.some((statement) =>
            statement.sql.includes("DELETE FROM tf_provider_mutation_sagas"),
          )
        ) {
          failFinalBatch = false;
          throw new SqlError("unavailable", "simulated lost delete commit acknowledgement");
        }
        return await durable.batch(statements);
      },
    };
    const fake = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    let deleteCalls = 0;
    const provider: Provider = {
      id: fake.id,
      offerings: fake.offerings,
      apply: (input) => fake.apply(input),
      observe: (input) => fake.observe(input),
      delete: (input) => {
        deleteCalls += 1;
        return fake.delete(input);
      },
      adopt: (input) => fake.adopt(input),
    };
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
    });
    const { provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "delete-lost", {}, "create-delete-lost");
    expect(created.status).toBe(201);
    const resource = created.body as unknown as {
      metadata: { generation: string; revision: string };
    };
    const path = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/delete-lost?${QUERY}`;
    const headers = {
      ...auth,
      "idempotency-key": "delete-lost-0001",
      "if-match": `"${resource.metadata.revision}"`,
      "takoform-expected-generation": resource.metadata.generation,
    };
    failFinalBatch = true;

    const first = await call(app.fetch, "DELETE", path, undefined, headers);
    expect(first.status).toBe(500);
    expect(deleteCalls).toBe(1);
    expect(await sql.query("SELECT state FROM tf_resource_deployments")).toEqual([
      { state: "active" },
    ]);

    const resumed = await call(app.fetch, "DELETE", path, undefined, headers);
    expect(resumed.status).toBe(204);
    expect(deleteCalls).toBe(1);
    expect(await sql.query("SELECT state FROM tf_resource_deployments")).toEqual([
      { state: "deleted" },
    ]);
    expect(await sql.query("SELECT operation_id FROM tf_provider_mutation_sagas")).toEqual([]);
  });

  test("provisions a usage-only resource without a fake monthly or setup debit", async () => {
    const { app, provider, ledger } = newApp({ usageOnly: true });
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const created = await applyBucket(app.fetch, auth, "metered", {}, "apply-usage-only");

    expect(created.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/metered`]);
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
      availableMinor: 2_000,
    });
  });

  test("returns the hold when the backend refuses", async () => {
    const { app, ledger } = newApp({ failOn: ["doomed"] });
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const failed = await applyBucket(app.fetch, auth, "doomed", { location: "apac" }, "apply-002");
    expect(failed.status).toBe(503);
    // The customer keeps their money, and nothing is recorded as provisioned.
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
      availableMinor: 2_000,
    });
    const read = await call(
      app.fetch,
      "GET",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/doomed?${QUERY}`,
      undefined,
      auth,
    );
    expect(read.status).toBe(404);
  });

  test("refuses to provision what the wallet cannot pay for", async () => {
    const { app, provider, ledger } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);

    // Four buckets at 500 exhausts the 2,000 credited.
    for (const name of ["one", "two", "three", "four"]) {
      expect((await applyBucket(app.fetch, auth, name, {}, `apply-${name}`)).status).toBe(201);
    }
    expect(await ledger.wallet(organizationId)).toMatchObject({ availableMinor: 0 });

    const denied = await applyBucket(app.fetch, auth, "five", {}, "apply-five");
    expect(denied.status).toBe(402);
    expect(provider.listResources()).toHaveLength(4);
  });

  test("records the backend's own identity so a later read finds the same thing", async () => {
    const { app, ledger, sql } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "apply-003");
    const resource = created.body as unknown as { metadata: { uid: string } };

    // The wire Resource is logical. Provider identity belongs only to its
    // active Deployment, where a later migration may add a candidate beside it.
    expect(
      (await sql.query("PRAGMA table_info(tf_resources)")).map((column) => column.name),
    ).not.toContain("native_id");
    expect(
      await sql.query(
        `SELECT resource_uid, offering_id, provider_pack_ref, provider_installation_ref,
                native_id, state
         FROM tf_resource_deployments WHERE tenant_id = ? AND resource_uid = ?`,
        [organizationId, resource.metadata.uid],
      ),
    ).toEqual([
      {
        resource_uid: resource.metadata.uid,
        offering_id: SOLD.id,
        provider_pack_ref: "fake",
        provider_installation_ref: "fake.primary",
        native_id: `fake:${organizationId}/default/assets`,
        state: "active",
      },
    ]);

    const observed = await call(
      app.fetch,
      "POST",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/assets/observe?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "observe-001", "takoform-expected-generation": "1" },
    );
    expect(observed.status).toBe(200);
    // Observation reaches the backend by native identity and bills nothing.
    expect(await ledger.wallet(organizationId)).toMatchObject({ settledMinor: 1_500 });
  });

  test("deletes on the backend when the resource is deleted", async () => {
    const { app, provider, sql } = newApp();
    const { provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "assets", {}, "apply-004");
    const resource = created.body as unknown as { metadata: { uid: string } };
    expect(provider.listResources()).toHaveLength(1);

    const deleted = await call(
      app.fetch,
      "DELETE",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/assets?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "delete-001", "takoform-expected-generation": "1" },
    );
    expect(deleted.status).toBe(204);
    expect(provider.listResources()).toEqual([]);
    expect(
      await sql.query("SELECT state FROM tf_resource_deployments WHERE resource_uid = ?", [
        resource.metadata.uid,
      ]),
    ).toEqual([{ state: "deleted" }]);
  });
});

describe("orphaned declarations", () => {
  test("names resources whose Form is no longer installed", async () => {
    const sql = createEphemeralSql();
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const ports = {
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      providers: [provider],
      offerings: [SOLD],
    };

    const app = buildApp({
      ...ports,
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
    });
    const { provider: auth } = await tenant(app.fetch);
    await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "orphan-001");
    expect((await app.tick()).orphanedResources).toEqual([]);

    // The same deployment, restarted with a Form whose schema moved on without
    // a new definition version. The declaration is now unresolvable, and the
    // backend resource it describes is still running.
    const moved = buildApp({
      ...ports,
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      forms: [
        {
          ...FORM,
          identity: {
            formRef: { ...FORM_REF, schemaDigest: `sha256:${"9".repeat(64)}` },
          },
        },
      ],
    });
    expect((await moved.tick()).orphanedResources).toEqual(["default/ObjectBucket/assets"]);
  });
});
