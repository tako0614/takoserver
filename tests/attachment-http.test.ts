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
  type TakoformInterfaceRef,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 7, 18, 12);
const POSTGRES = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "sql.postgresql.takoform.com",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const satisfies TakoformInterfaceRef;
const COMPUTE_FORM = form("compute.resources.takoform.com", "LinuxVirtualMachine", "b");
const DATABASE_FORM = form("data.resources.takoform.com", "PostgresDatabase", "c", [POSTGRES]);

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "owner", email: "owner@example.com", displayName: "Owner" };
  },
};
const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "unused", amountMinor: 1, currency: "USD" };
  },
};

test("the ordinary control API resolves Attachments and blocks provider deletion", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date(NOW);
  const pack = createProviderPack({
    id: "postgres-pack",
    providerType: "fake-postgres",
    provisioners: [],
    transferEndpoints: [],
    credentialIssuers: [],
    meterSources: [],
    costEstimators: [],
    attachmentFactories: [
      {
        id: "postgres-dsn",
        providerPackRef: "postgres-pack",
        supports: ({ interfaceRef }) => interfaceRef.name === POSTGRES.name,
        resolve: async ({ attachment, providerDeployment }) => ({
          kind: "credential-grant-ref" as const,
          ref: `grant:${attachment.id}:${providerDeployment.id}`,
        }),
      },
    ],
  });
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.test",
    forms: [COMPUTE_FORM, DATABASE_FORM],
    hostForms: [COMPUTE_FORM, DATABASE_FORM],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    providerPacks: [pack],
    clock,
    randomId: sequence(),
  });

  const session = await request(app.fetch, "POST", "/v1/sessions", {
    provider: "github",
    assertion: "verified",
  });
  const owner = { authorization: `Bearer ${String(session.body.sessionToken)}` };
  const organization = await request(
    app.fetch,
    "POST",
    "/v1/organizations",
    { name: "Attachment test" },
    owner,
  );
  const organizationId = String((organization.body.organization as { id: string }).id);
  const key = await request(
    app.fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    {
      name: "resource-client",
      scopes: ["resources:read", "resources:write"],
      expiresInSeconds: 3_600,
    },
    owner,
  );
  const bearer = { authorization: `Bearer ${String(key.body.secret)}` };
  const compute = await createResource(app.fetch, COMPUTE_FORM, "api", bearer);
  const database = await createResource(app.fetch, DATABASE_FORM, "main", bearer);

  const deployments = createResourceDeploymentStore(sql, clock);
  await deployments.create({
    tenantId: organizationId,
    id: "dep_compute_active",
    resourceUid: compute.uid,
    offeringId: "compute.vm.test",
    providerPackRef: "compute-pack",
    providerInstallationRef: "compute.test",
    nativeId: "vm:api",
    state: "active",
    observed: {},
    outputs: {},
  });
  await deployments.create({
    tenantId: organizationId,
    id: "dep_database_active",
    resourceUid: database.uid,
    offeringId: "database.postgresql.test",
    providerPackRef: "postgres-pack",
    providerInstallationRef: "postgres.test",
    nativeId: "postgres:main",
    state: "active",
    observed: {},
    outputs: {},
  });

  const attached = await request(
    app.fetch,
    "POST",
    `/v1/organizations/${organizationId}/attachments`,
    {
      id: "att_api_main_db",
      consumerResourceUid: compute.uid,
      providerResourceUid: database.uid,
      interfaceRef: POSTGRES,
      target: "DATABASE_URL",
      permissions: ["query", "mutate"],
    },
    bearer,
  );
  expect(attached.status).toBe(201);
  expect(attached.body).toMatchObject({
    attachment: {
      id: "att_api_main_db",
      resolution: {
        kind: "credential-grant-ref",
        ref: "grant:att_api_main_db:dep_database_active",
      },
    },
  });
  expect(JSON.stringify(attached.body)).not.toContain("postgres:main");

  const blocked = await deleteResource(app.fetch, DATABASE_FORM, "main", bearer);
  expect(blocked.status).toBe(409);
  expect(blocked.body).toMatchObject({ error: { code: "dependency_in_use" } });

  const removed = await request(
    app.fetch,
    "DELETE",
    `/v1/organizations/${organizationId}/attachments/att_api_main_db`,
    undefined,
    bearer,
  );
  expect(removed.status).toBe(204);
  expect((await deleteResource(app.fetch, DATABASE_FORM, "main", bearer)).status).toBe(204);
});

function form(
  apiVersion: string,
  kind: string,
  digestCharacter: string,
  providedInterfaces: readonly TakoformInterfaceRef[] = [],
): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion,
        kind,
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${digestCharacter.repeat(64)}`,
      },
    },
    providedInterfaces,
    desiredSchema: { type: "object", properties: {}, additionalProperties: false },
    operations: ["create", "read", "delete"],
  };
}

async function createResource(
  fetch: (request: Request) => Promise<Response>,
  installed: InstalledTakoformForm,
  name: string,
  headers: Record<string, string>,
): Promise<{ uid: string }> {
  const formRef = installed.identity.formRef;
  const body = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { name, space: "production" },
    spec: {},
  };
  const prepared = await request(
    fetch,
    "POST",
    "/apis/forms.takoform.com/v1/resources/prepare",
    body,
    headers,
  );
  expect(prepared.status).toBe(200);
  const review = prepared.body.review as { prepareDigest: string };
  const created = await request(
    fetch,
    "PUT",
    `/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/${name}`,
    { ...body, review: { prepareDigest: review.prepareDigest } },
    { ...headers, "idempotency-key": `create-${name}-0001`, "if-none-match": "*" },
  );
  expect(created.status).toBe(201);
  return { uid: String((created.body.metadata as { uid: string }).uid) };
}

async function deleteResource(
  fetch: (request: Request) => Promise<Response>,
  installed: InstalledTakoformForm,
  name: string,
  headers: Record<string, string>,
) {
  const formRef = installed.identity.formRef;
  const query = new URLSearchParams({
    space: "production",
    group: formRef.apiVersion,
    kind: formRef.kind,
    definitionVersion: formRef.definitionVersion,
    schemaDigest: formRef.schemaDigest,
  });
  return await request(
    fetch,
    "DELETE",
    `/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/${name}?${query}`,
    undefined,
    {
      ...headers,
      "idempotency-key": `delete-${name}-0001`,
      "takoform-expected-generation": "1",
    },
  );
}

async function request(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
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
