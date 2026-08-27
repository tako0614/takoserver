import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  openApiDocument,
  openApiPaths,
} from "../src/index.ts";

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "settlement_1", amountMinor: 1_000, currency: "USD" };
  },
};

function handler(publicOrigin = "https://api.takoserver.com") {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  }).fetch;
}

/** The one stable Takoform Host lane; Form family groups are versionless. */
const TAKOFORM_SUFFIXES = [
  "/forms",
  "/form-definitions/{group}/{kind}",
  "/support/forms",
  "/support/forms/{group}/{kind}/{definitionVersion}",
  "/support/interfaces/{name}/{version}",
  "/support/bindings/{name}/{version}",
  "/support/standard-services/{protocol}",
  "/resources/validate",
  "/resources/prepare",
  "/resources/{group}/{kind}/{name}",
  "/resources/{group}/{kind}/{name}/observe",
  "/resources/{group}/{kind}/{name}/import",
  "/operations/{operationId}",
  "/operations/{operationId}/cancel",
  "/artifacts/uploads",
  "/artifacts/uploads/{uploadId}",
  "/artifacts/uploads/{uploadId}/commit",
  "/artifacts/uploads/{uploadId}/blobs/{digest}",
  "/artifacts/{digest}",
  "/artifacts/blobs/{digest}",
];

const PUBLIC_PATHS = [
  "/",
  "/.well-known/takoform/v1",
  "/.well-known/takoserver",
  "/openapi.json",
  "/v1/catalog",
  "/v1/forms",
  "/v1/identity/providers",
  "/v1/me",
  "/v1/ai/models",
  "/v1/ai/chat/completions",
  "/v1/organizations",
  "/v1/organizations/{organizationId}/attachments",
  "/v1/organizations/{organizationId}/attachments/{attachmentId}",
  "/v1/organizations/{organizationId}/api-keys",
  "/v1/organizations/{organizationId}/api-keys/{apiKeyId}",
  "/v1/organizations/{organizationId}/operations",
  "/v1/organizations/{organizationId}/resources",
  "/v1/organizations/{organizationId}/resources/{resourceUid}",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cancel",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cutover",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/execute",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/rollback",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/s3-credentials",
  "/v1/organizations/{organizationId}/wallet",
  "/v1/organizations/{organizationId}/wallet/checkout",
  "/v1/organizations/{organizationId}/wallet/funding",
  "/v1/reseller/quotes",
  "/v1/reseller/reservations",
  "/v1/reseller/reservations/{reservationId}/capture",
  "/v1/reseller/reservations/{reservationId}/provision-tokens",
  "/v1/reseller/reservations/{reservationId}/release",
  "/v1/reseller/reservations/{reservationId}/takoform-run-tokens",
  "/v1/reseller/reservations/{reservationId}/usage-statement",
  "/v1/sessions",
];

describe("published API description", () => {
  test("declares exactly the one literal stable Host surface", () => {
    const expected = [
      ...PUBLIC_PATHS,
      ...TAKOFORM_SUFFIXES.map((suffix) => `/apis/forms.takoform.com/v1${suffix}`),
    ].sort();
    expect(openApiPaths()).toEqual(expected);
    expect(TAKOFORM_SUFFIXES.length + PUBLIC_PATHS.length).toBe(openApiPaths().length);
    expect(JSON.stringify(openApiDocument)).not.toMatch(
      /forms\.takoform\.com\/(?:v1alpha3|v1beta1|v1beta4)/u,
    );
  });

  test("names one server and one bearer scheme", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.servers).toEqual([{ url: "https://api.takoserver.com" }]);
    expect(openApiDocument.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  test("mentions no other product and leaks no upstream identity vocabulary", () => {
    const serialized = JSON.stringify(openApiDocument);
    expect(serialized).not.toMatch(/takosumi/i);
    // The reseller lane speaks only in opaque tenant references.
    expect(serialized).not.toMatch(/workspace|userId|principalId/);
  });

  test("serves the document it describes", async () => {
    const fetch = handler();
    const response = await fetch(new Request("https://api.takoserver.com/openapi.json"));
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual(
      JSON.parse(JSON.stringify(openApiDocument)) as unknown,
    );
  });

  test("advertises the deployment public origin for staging and production", async () => {
    for (const publicOrigin of [
      "https://takoserver-api-staging.shoutatomiyama0614.workers.dev",
      "https://api.takoserver.com",
    ]) {
      const fetch = handler(publicOrigin);
      const document = await fetch(new Request(`${publicOrigin}/openapi.json`));
      const discovery = await fetch(new Request(`${publicOrigin}/.well-known/takoserver`));
      const body = (await document.json()) as { servers: readonly unknown[] };
      expect(body.servers).toEqual([{ url: publicOrigin }]);
      expect((await discovery.json()) as { endpoints: { api: string } }).toMatchObject({
        endpoints: { api: publicOrigin },
      });
    }
  });

  test("keeps the configured public origin when a request arrives on an alias", async () => {
    const publicOrigin = "https://api.takoserver.com";
    const fetch = handler(publicOrigin);
    const alias = "https://api-alias.takoserver.com";
    const document = await fetch(new Request(`${alias}/openapi.json`));
    const discovery = await fetch(new Request(`${alias}/.well-known/takoserver`));

    expect(((await document.json()) as { servers: readonly unknown[] }).servers).toEqual([
      { url: publicOrigin },
    ]);
    expect((await discovery.json()) as { endpoints: { api: string } }).toMatchObject({
      endpoints: { api: publicOrigin },
    });
  });

  test("answers discovery and the console without a credential", async () => {
    const fetch = handler();
    for (const path of [
      "/",
      "/openapi.json",
      "/.well-known/takoserver",
      "/v1/identity/providers",
    ]) {
      expect((await fetch(new Request(`https://api.takoserver.com${path}`))).status).toBe(200);
    }
  });

  test("refuses an unknown path rather than guessing", async () => {
    const fetch = handler();
    const response = await fetch(new Request("https://api.takoserver.com/v1/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("does not publish a Takoserver-specific object protocol beside standard S3", async () => {
    const fetch = handler();
    for (const path of [
      "/data/v1/objects/uid_bucket/file.txt",
      "/v1/organizations/org_1/resources/uid_bucket/data-tokens",
    ]) {
      expect((await fetch(new Request(`https://api.takoserver.com${path}`))).status).toBe(404);
    }
  });

  test("refuses a public origin that is not a bare HTTPS origin", () => {
    for (const publicOrigin of [
      "http://api.takoserver.com",
      "https://api.takoserver.com/base",
      "https://user:pw@api.takoserver.com",
    ]) {
      expect(() =>
        buildApp({
          sql: createEphemeralSql(),
          objects: createMemoryObjectStore(),
          identity,
          settlement,
          publicOrigin,
          forms: [],
          hostForms: [],
          driver: new InMemoryTakoformResourceDriver(),
          offerings: [],
        }),
      ).toThrow();
    }
    // Loopback stays usable so a self-hosted server needs no certificate.
    expect(() =>
      buildApp({
        sql: createEphemeralSql(),
        objects: createMemoryObjectStore(),
        identity,
        settlement,
        publicOrigin: "http://localhost:8787",
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
      }),
    ).not.toThrow();
  });
});
