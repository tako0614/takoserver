import { expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  createProviderPack,
  createResourceDeploymentStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const NOW = Date.UTC(2026, 7, 18, 12);
const FORMAT = "sqlite.sql-dump.takoform.com/v1";
const FORM: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "data.resources.takoform.com",
      kind: "SqliteDatabase",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
  },
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "delete"],
};

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "owner", email: "owner@example.com", displayName: "Owner" };
  },
};
const settlement: FundingSettlementVerifier = {
  async verify({ settlementProof }) {
    return { fundingRef: settlementProof, amountMinor: 10_000, currency: "USD" };
  },
};

test("the migration API binds reservation, transfer, cutover, and capture", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date(NOW);
  const sourceOffering = sold("database.sqlite.source", "source", 500);
  const targetOffering = sold("database.sqlite.target", "target", 700);
  const transferEvents: string[] = [];
  const sourcePack = pack("source", sourceOffering, transferEvents);
  const targetPack = pack("target", targetOffering, transferEvents);
  const app = buildApp({
    takoformHostFactory: createStaticStableTestTakoformHost,
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.test",
    forms: [FORM],
    hostForms: [FORM],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [sourceOffering, targetOffering],
    providerPacks: [sourcePack, targetPack],
    clock,
    randomId: sequence(),
  });

  const session = await request(app.fetch, "POST", "/v1/sessions", {
    provider: "github",
    assertion: "verified",
  });
  const owner = { authorization: `Bearer ${String(session.body.sessionToken)}` };
  const createdOrganization = await request(
    app.fetch,
    "POST",
    "/v1/organizations",
    { name: "Migration test" },
    owner,
  );
  const organizationId = String((createdOrganization.body.organization as { id: string }).id);
  const createdKey = await request(
    app.fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    {
      name: "migration-client",
      scopes: [
        "resources:read",
        "resources:write",
        "reseller:write",
        "catalog:read",
        "wallet:read",
      ],
      expiresInSeconds: 3_600,
    },
    owner,
  );
  const bearer = { authorization: `Bearer ${String(createdKey.body.secret)}` };
  await request(
    app.fetch,
    "POST",
    `/v1/organizations/${organizationId}/wallet/funding`,
    { settlementProof: "migration-funds" },
    owner,
  );
  const quote = await request(
    app.fetch,
    "POST",
    "/v1/reseller/quotes",
    { tenantRef: "tenant_database", offeringId: targetOffering.id, quantity: 1 },
    bearer,
  );
  const reservation = await request(
    app.fetch,
    "POST",
    "/v1/reseller/reservations",
    {
      tenantRef: "tenant_database",
      quoteId: String((quote.body.quote as { id: string }).id),
    },
    bearer,
  );
  const reservationId = String((reservation.body.reservation as { id: string }).id);
  const resourceUid = await createResource(app.fetch, bearer);
  await createResourceDeploymentStore(sql, clock).create({
    tenantId: organizationId,
    id: "dep_source_active",
    resourceUid,
    offeringId: sourceOffering.id,
    providerPackRef: "source",
    providerInstallationRef: "source.primary",
    nativeId: "source:main",
    state: "active",
    observed: {},
    outputs: {},
  });

  const path = `/v1/organizations/${organizationId}/resources/${resourceUid}/migrations`;
  const wrongQuote = await request(
    app.fetch,
    "POST",
    "/v1/reseller/quotes",
    { tenantRef: "tenant_database", offeringId: sourceOffering.id, quantity: 1 },
    bearer,
  );
  const wrongReservation = await request(
    app.fetch,
    "POST",
    "/v1/reseller/reservations",
    {
      tenantRef: "tenant_database",
      quoteId: String((wrongQuote.body.quote as { id: string }).id),
    },
    bearer,
  );
  const wrongReservationId = String((wrongReservation.body.reservation as { id: string }).id);
  const refusedAuthority = await request(
    app.fetch,
    "POST",
    path,
    {
      id: "mig_wrong_authority",
      targetOfferingId: targetOffering.id,
      commercialTenantRef: "tenant_database",
      reservationId: wrongReservationId,
      mode: "offline",
      transferFormat: FORMAT,
    },
    bearer,
  );
  expect(refusedAuthority.status).toBe(409);
  expect(refusedAuthority.body).toMatchObject({
    error: { code: "migration_commercial_authority_invalid" },
  });
  await request(
    app.fetch,
    "POST",
    `/v1/reseller/reservations/${wrongReservationId}/release`,
    { tenantRef: "tenant_database" },
    bearer,
  );

  const cancelledQuote = await request(
    app.fetch,
    "POST",
    "/v1/reseller/quotes",
    { tenantRef: "tenant_database", offeringId: targetOffering.id, quantity: 1 },
    bearer,
  );
  const cancelledReservation = await request(
    app.fetch,
    "POST",
    "/v1/reseller/reservations",
    {
      tenantRef: "tenant_database",
      quoteId: String((cancelledQuote.body.quote as { id: string }).id),
    },
    bearer,
  );
  const cancelledReservationId = String(
    (cancelledReservation.body.reservation as { id: string }).id,
  );
  await request(
    app.fetch,
    "POST",
    path,
    {
      id: "mig_cancelled_before_execution",
      targetOfferingId: targetOffering.id,
      commercialTenantRef: "tenant_database",
      reservationId: cancelledReservationId,
      mode: "offline",
      transferFormat: FORMAT,
    },
    bearer,
  );
  const cancelledPath = `${path}/mig_cancelled_before_execution/cancel`;
  const cancelled = await request(app.fetch, "POST", cancelledPath, undefined, bearer);
  expect(cancelled.status).toBe(200);
  expect(cancelled.body).toMatchObject({
    migration: { state: "failed" },
    reservation: { id: cancelledReservationId, status: "released" },
  });
  expect((await request(app.fetch, "POST", cancelledPath, undefined, bearer)).status).toBe(200);

  const planned = await request(
    app.fetch,
    "POST",
    path,
    {
      id: "mig_main_to_target",
      targetOfferingId: targetOffering.id,
      commercialTenantRef: "tenant_database",
      reservationId,
      mode: "offline",
      transferFormat: FORMAT,
    },
    bearer,
  );
  expect(planned.status).toBe(201);
  expect(planned.body).toMatchObject({
    migration: {
      state: "planned",
      commercialAuthorizationRef: reservationId,
      commercialTenantRef: "tenant_database",
    },
  });

  const migrationPath = `${path}/mig_main_to_target`;
  const executed = await request(app.fetch, "POST", `${migrationPath}/execute`, undefined, bearer);
  expect(executed.status).toBe(200);
  expect(executed.body).toMatchObject({ migration: { state: "verified" } });
  expect(transferEvents).toEqual([
    "source:export",
    "target:import:transfer:database",
    "target:verify",
  ]);

  const cutover = await request(app.fetch, "POST", `${migrationPath}/cutover`, undefined, bearer);
  expect(cutover.status).toBe(200);
  expect(cutover.body).toMatchObject({
    migration: { state: "completed" },
    statement: { reservationId, amountMinor: 700 },
  });
  expect(
    (await request(app.fetch, "POST", `${migrationPath}/cutover`, undefined, bearer)).status,
  ).toBe(200);

  const wallet = await request(
    app.fetch,
    "GET",
    `/v1/organizations/${organizationId}/wallet`,
    undefined,
    bearer,
  );
  expect(wallet.body.wallet).toMatchObject({ settledMinor: 9_300, heldMinor: 0 });
  const listed = (await request(app.fetch, "GET", path, undefined, bearer)).body.migrations as {
    id: string;
    state: string;
  }[];
  expect(listed).toHaveLength(2);
  expect(listed.find((migration) => migration.id === "mig_main_to_target")).toMatchObject({
    state: "completed",
  });
  expect(
    listed.find((migration) => migration.id === "mig_cancelled_before_execution"),
  ).toMatchObject({ state: "failed" });
});

function sold(id: string, providerPackRef: string, amountMinor: number): Offering {
  return {
    id,
    providerPackRef,
    providerInstallationRef: `${providerPackRef}.primary`,
    supplyContractRef: `${providerPackRef}.contract`,
    pricePlanRef: `${id}.price`,
    resourceClass: "database.sqlite",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "support:test",
    abusePolicyRef: "abuse:test",
    kind: "sqlite_database",
    displayName: id,
    form: FORM.identity.formRef,
    pricePlan: {
      id: `${id}.price`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: ["test"],
    portability: {
      api: "portable",
      exportFormats: [FORMAT],
      importFormats: [FORMAT],
      migrationModes: ["offline"],
    },
    isolation: "dedicated-resource",
    available: true,
  };
}

function pack(id: string, offering: Offering, events: string[]) {
  const providerOffering: ProviderOffering = {
    id: offering.id,
    kind: offering.kind,
    displayName: offering.displayName,
    form: offering.form,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "import", "observe"],
  };
  return createProviderPack({
    id,
    providerType: id,
    provisioners: [new FakeProvider({ id, offerings: [providerOffering] })],
    attachmentFactories: [],
    transferEndpoints: [
      {
        id: `${id}-transfer`,
        exportFormats: [FORMAT],
        importFormats: [FORMAT],
        migrationModes: ["offline"],
        export: async () => {
          events.push(`${id}:export`);
          return { transferRef: "transfer:database" };
        },
        import: async ({ transferRef }) => {
          events.push(`${id}:import:${transferRef}`);
        },
        verify: async () => {
          events.push(`${id}:verify`);
          return {
            schema: true,
            rowCounts: true,
            checksums: true,
            evidenceDigest: `sha256:${"d".repeat(64)}`,
          };
        },
      },
    ],
    credentialIssuers: [],
    meterSources: [],
    costEstimators: [],
  });
}

async function createResource(
  fetch: (request: Request) => Promise<Response>,
  headers: Record<string, string>,
): Promise<string> {
  const formRef = FORM.identity.formRef;
  const body = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { name: "main", space: "production" },
    spec: {},
  };
  const prepared = await request(
    fetch,
    "POST",
    "/apis/forms.takoform.com/v1/resources/prepare",
    body,
    headers,
  );
  const digest = String((prepared.body.review as { prepareDigest: string }).prepareDigest);
  const created = await request(
    fetch,
    "PUT",
    `/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/main`,
    { ...body, review: { prepareDigest: digest } },
    { ...headers, "idempotency-key": "create-database-main-001", "if-none-match": "*" },
  );
  expect(created.status).toBe(201);
  return String((created.body.metadata as { uid: string }).uid);
}

async function request(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(
    new Request(`https://api.takoserver.test${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function sequence(): () => string {
  let value = 0;
  return () => `id${String(++value).padStart(30, "0")}`;
}
