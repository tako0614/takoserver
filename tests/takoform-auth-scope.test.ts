import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
} from "../src/index.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "EdgeObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};

const FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "update", "delete", "import", "observe"],
};

const IDENTITY: ExternalIdentityVerifier = {
  async verify({ assertion }) {
    return {
      providerSubject: `subject:${assertion}`,
      email: `${assertion}@example.test`,
      displayName: assertion,
    };
  },
};

const SETTLEMENT: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "funding_1", amountMinor: 10_000, currency: "USD" };
  },
};

describe("Takoform Host resource scopes", () => {
  test("allows resource readers to read only, while writers retain read/write access", async () => {
    let now = Date.UTC(2026, 7, 28, 12, 0, 0);
    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity: IDENTITY,
      settlement: SETTLEMENT,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      takoformHostFactory: createStaticStableTestTakoformHost,
      clock: () => new Date(now),
    });

    const session = await call(app.fetch, "POST", "/v1/sessions", {
      provider: "github",
      assertion: "owner",
    });
    const sessionToken = stringField(session.body, "sessionToken");
    const owner = { authorization: `Bearer ${sessionToken}` };
    const organization = await call(
      app.fetch,
      "POST",
      "/v1/organizations",
      { name: "Acme" },
      owner,
    );
    const organizationId = stringField(recordField(organization.body, "organization"), "id");
    const writer = await createApiKey(app.fetch, organizationId, owner, "writer", [
      "resources:write",
    ]);
    const reader = await createApiKey(app.fetch, organizationId, owner, "reader", [
      "resources:read",
    ]);

    const own = resource("owned", "space-a");
    const prepared = await call(
      app.fetch,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      own,
      writer.headers,
    );
    expect(prepared.status).toBe(200);
    const prepareDigest = stringField(recordField(prepared.body, "review"), "prepareDigest");
    const resourcePath = resourcePathFor("owned");
    const created = await call(
      app.fetch,
      "PUT",
      resourcePath,
      { ...own, review: { prepareDigest } },
      { ...writer.headers, "idempotency-key": "writer-create-1", "if-none-match": "*" },
    );
    expect(created.status).toBe(201);

    const query = resourceQuery("space-a");
    const writerRead = await call(
      app.fetch,
      "GET",
      `${resourcePath}?${query}`,
      undefined,
      writer.headers,
    );
    expect(writerRead.status).toBe(200);
    const readerRead = await call(
      app.fetch,
      "GET",
      `${resourcePath}?${query}`,
      undefined,
      reader.headers,
    );
    expect(readerRead.status).toBe(200);

    const missing = await call(
      app.fetch,
      "GET",
      `${resourcePathFor("missing")}?${query}`,
      undefined,
      reader.headers,
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "resource_not_found" } });

    const readerPrepare = await call(
      app.fetch,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      resource("reader-preview", "space-a"),
      reader.headers,
    );
    expect(readerPrepare.status).toBe(403);
    expect(readerPrepare.body).toMatchObject({ error: { code: "permission_denied" } });

    const readerPut = await call(
      app.fetch,
      "PUT",
      resourcePath,
      { ...own, review: { prepareDigest } },
      { ...reader.headers, "idempotency-key": "reader-put-1", "if-none-match": "*" },
    );
    expect(readerPut.status).toBe(403);
    expect(readerPut.body).toMatchObject({ error: { code: "permission_denied" } });

    const readerImport = await call(
      app.fetch,
      "POST",
      `${resourcePath}/import`,
      { ...own, nativeId: "native-reader" },
      { ...reader.headers, "idempotency-key": "reader-import-1", "if-none-match": "*" },
    );
    expect(readerImport.status).toBe(403);

    const readerDelete = await call(app.fetch, "DELETE", `${resourcePath}?${query}`, undefined, {
      ...reader.headers,
      "idempotency-key": "reader-delete-1",
      "takoform-expected-generation": "1",
    });
    expect(readerDelete.status).toBe(403);

    const foreignOrganization = await call(
      app.fetch,
      "POST",
      "/v1/organizations",
      { name: "Other" },
      owner,
    );
    const foreignOrganizationId = stringField(
      recordField(foreignOrganization.body, "organization"),
      "id",
    );
    const foreignWriter = await createApiKey(
      app.fetch,
      foreignOrganizationId,
      owner,
      "foreign-writer",
      ["resources:write"],
    );
    const foreign = resource("foreign", "space-a");
    const foreignPrepared = await call(
      app.fetch,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      foreign,
      foreignWriter.headers,
    );
    const foreignDigest = stringField(recordField(foreignPrepared.body, "review"), "prepareDigest");
    expect(
      (
        await call(
          app.fetch,
          "PUT",
          resourcePathFor("foreign"),
          { ...foreign, review: { prepareDigest: foreignDigest } },
          { ...foreignWriter.headers, "idempotency-key": "foreign-create-1", "if-none-match": "*" },
        )
      ).status,
    ).toBe(201);

    const foreignRead = await call(
      app.fetch,
      "GET",
      `${resourcePathFor("foreign")}?${query}`,
      undefined,
      reader.headers,
    );
    expect(foreignRead.status).toBe(404);
    expect(foreignRead.body).toMatchObject({ error: { code: "resource_not_found" } });

    await call(
      app.fetch,
      "DELETE",
      `/v1/organizations/${organizationId}/api-keys/${reader.id}`,
      undefined,
      owner,
    );
    const revokedRead = await call(
      app.fetch,
      "GET",
      `${resourcePath}?${query}`,
      undefined,
      reader.headers,
    );
    expect(revokedRead.status).toBe(401);

    const expiringReader = await createApiKey(
      app.fetch,
      organizationId,
      owner,
      "expiring-reader",
      ["resources:read"],
      1,
    );
    now += 2_000;
    const expiredRead = await call(
      app.fetch,
      "GET",
      `${resourcePath}?${query}`,
      undefined,
      expiringReader.headers,
    );
    expect(expiredRead.status).toBe(401);
  });
});

async function createApiKey(
  fetch: (request: Request) => Promise<Response>,
  organizationId: string,
  owner: Readonly<Record<string, string>>,
  name: string,
  scopes: readonly string[],
  expiresInSeconds = 3_600,
): Promise<{ readonly id: string; readonly headers: { readonly authorization: string } }> {
  const created = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name, scopes, expiresInSeconds },
    owner,
  );
  return {
    id: stringField(recordField(created.body, "apiKey"), "id"),
    headers: { authorization: `Bearer ${stringField(created.body, "secret")}` },
  };
}

function resource(name: string, space: string) {
  return {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name, space },
    spec: {},
  };
}

function resourcePathFor(name: string): string {
  return `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/${name}`;
}

function resourceQuery(space: string): string {
  return new URLSearchParams({
    space,
    definitionVersion: FORM_REF.definitionVersion,
    schemaDigest: FORM_REF.schemaDigest,
  }).toString();
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string") throw new Error(`missing ${key}`);
  return found;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new Error(`missing ${key}`);
  }
  return found as Record<string, unknown>;
}
