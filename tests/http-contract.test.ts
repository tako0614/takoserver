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
  "/v1/organizations/{organizationId}/worker-runtime-input-preparations/{operationId}",
  "/v1/worker-endpoint-origin-reservations/{reservationId}",
  "/v1/worker-endpoint-origin-reservations/{reservationId}/activation",
  "/v1/organizations/{organizationId}/resources/{resourceUid}",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cancel",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cutover",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/execute",
  "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/rollback",
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
    expect(JSON.stringify(openApiDocument)).not.toMatch(
      /s3-credentials|takoserver\.s3-connection|support\/standard-services/u,
    );
  });

  test("names one server and one bearer scheme", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.servers).toEqual([{ url: "https://api.takoserver.com" }]);
    expect(openApiDocument.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  test("describes the native residual response as a closed tri-state schema", () => {
    const path = openApiDocument.paths[
      "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual"
    ] as {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    residual: {
                      properties: {
                        status: { enum: readonly string[] };
                        source: { enum: readonly string[] };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
    expect(
      path.get.responses["200"].content["application/json"].schema.properties.residual.properties
        .status.enum,
    ).toEqual(["absent", "present", "indeterminate"]);
    expect(
      path.get.responses["200"].content["application/json"].schema.properties.residual.properties
        .source.enum,
    ).toEqual(["intrinsic", "provider"]);
    expect(JSON.stringify(path)).not.toContain("nativeId");
  });

  test("publishes closed reservation, activation, and plan-known runtime-input schemas", () => {
    const schemas = openApiDocument.components.schemas;
    expect(schemas.WorkerEndpointOriginReservationRequest.additionalProperties).toBe(false);
    expect(schemas.WorkerEndpointOriginReservationRequest.required).toEqual([
      "format",
      "requestedSubdomain",
      "expiresInSeconds",
    ]);
    expect(schemas.WorkerEndpointOriginReservationRequest.properties.format.const).toBe(
      "takoserver.worker-endpoint-origin-reservation.v2",
    );
    expect(schemas.WorkerEndpointOriginReservationRequest.properties.requestedSubdomain).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 63,
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    });
    expect(JSON.stringify(schemas.WorkerEndpointOriginReservationRequest)).not.toMatch(
      /target|space|workerName|endpointName|resourceUid/,
    );

    expect(schemas.WorkerEndpointOriginReservationV2.additionalProperties).toBe(false);
    expect(schemas.WorkerEndpointOriginReservationV2.properties.status.enum).toEqual([
      "prepared",
      "bound",
      "activated",
    ]);
    expect(schemas.WorkerEndpointOriginReservationBinding.additionalProperties).toBe(false);
    expect(schemas.WorkerEndpointOriginReservationBinding.required).toEqual([
      "space",
      "workerName",
      "workerResourceUid",
      "workerResourceRevision",
    ]);
    expect(schemas.WorkerEndpointOriginReservationBinding.oneOf).toEqual([
      {
        not: {
          anyOf: [
            { required: ["endpointName"] },
            { required: ["endpointResourceUid"] },
            { required: ["endpointResourceRevision"] },
          ],
        },
      },
      { required: ["endpointName", "endpointResourceUid", "endpointResourceRevision"] },
    ]);
    expect(schemas.WorkerEndpointOriginReservationV2.oneOf).toHaveLength(3);
    expect(schemas.WorkerEndpointOriginReservation.oneOf).toEqual([
      { $ref: "#/components/schemas/WorkerEndpointOriginReservationV2" },
      { $ref: "#/components/schemas/WorkerEndpointOriginReservationV1" },
    ]);
    expect(schemas.WorkerEndpointOriginReservationV1.properties.format.const).toBe(
      "takoserver.worker-endpoint-origin-reservation.v1",
    );

    expect(schemas.WorkerEndpointOriginReservationActivationRequest.additionalProperties).toBe(
      false,
    );
    expect(schemas.WorkerEndpointOriginReservationActivationRequest.required).toEqual([
      "format",
      "endpointResourceUid",
    ]);
    expect(schemas.WorkerEndpointOriginReservationActivationRequest.properties.format.const).toBe(
      "takoserver.worker-endpoint-origin-reservation-activation.v2",
    );
    expect(JSON.stringify(schemas.WorkerEndpointOriginReservationActivationRequest)).not.toMatch(
      /space|workerName|endpointName/,
    );

    const reservationPath = openApiDocument.paths[
      "/v1/worker-endpoint-origin-reservations/{reservationId}"
    ] as unknown as {
      readonly put: {
        readonly responses: {
          readonly "201": {
            readonly content: {
              readonly "application/json": { readonly schema: { readonly $ref: string } };
            };
          };
        };
      };
      readonly get: {
        readonly responses: {
          readonly "200": {
            readonly content: {
              readonly "application/json": { readonly schema: { readonly $ref: string } };
            };
          };
        };
      };
    };
    expect(reservationPath.put.responses["201"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/WorkerEndpointOriginReservationV2",
    );
    expect(reservationPath.get.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/WorkerEndpointOriginReservation",
    );

    expect(schemas.WorkerRuntimeInputPreparationRequest.additionalProperties).toBe(false);
    expect(schemas.WorkerRuntimeInputPreparationRequest.required).toContain("materialSetNonce");
    expect(schemas.WorkerRuntimeInputPreparationRequest.required).toContain(
      "runtimeInputReference",
    );
    expect(JSON.stringify(schemas.WorkerRuntimeInputPreparationRequest)).not.toContain(
      "canonicalPublicOrigin",
    );
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

  test("does not publish S3 credential or managed-service retail beside ObjectBucket", async () => {
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
