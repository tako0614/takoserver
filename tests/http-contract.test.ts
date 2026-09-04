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
import {
  ROUTES,
  TAKOFORM_LANES,
  TAKOFORM_ROUTES,
  takoformRoutePattern,
} from "../src/route-table.ts";
import type { WorkerEndpointOriginReservations } from "../src/worker-endpoint-origin-reservations.ts";

const TAKOSUMI_TENANT_SPACE = "tenant:tsh_2IS0Th3vfHv-B1kAAJfyNKHM79GJ0SxuZdRM147QfvI";

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

/**
 * The reservation authority is an optional port, so a composition without one
 * answers its routes `not_found` — which would make the reachability check
 * below unable to tell an absent capability from an unknown route. The stub
 * only has to make the routes mountable.
 */
const RESERVATION_PROJECTION = {
  format: "takoserver.worker-endpoint-origin-reservation.v2",
  reservationId: "reservation_01",
  requestedSubdomain: "probe",
  canonicalPublicOrigin: "https://probe.workers.test",
  revision: "1",
  expiresAt: "2026-08-31T12:10:00.000Z",
  status: "prepared",
} as const;

function reservationStub(): WorkerEndpointOriginReservations {
  const refuse = () => {
    throw new Error("not reached by a surface probe");
  };
  return {
    async prepare() {
      return RESERVATION_PROJECTION;
    },
    async read() {
      return RESERVATION_PROJECTION;
    },
    async release() {},
    async activate() {
      return RESERVATION_PROJECTION;
    },
    async deactivate() {
      return RESERVATION_PROJECTION;
    },
    mintForWorker: refuse,
    bind: refuse,
    inspectBound: refuse,
    assignEndpoint: refuse,
    cancelEndpointAssignment: refuse,
    releaseEndpointAssignment: refuse,
  } as unknown as WorkerEndpointOriginReservations;
}

/** The whole surface composed, so no route is missing merely for want of a port. */
function completeHandler() {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    originReservations: reservationStub(),
  }).fetch;
}

const PATH_SAMPLES: Readonly<Record<string, string>> = {
  organizationId: "org_probe",
  deploymentId: "dep_probe",
  resourceUid: "uid_probe",
  migrationId: "mig_probe",
  attachmentId: "att_probe",
  apiKeyId: "key_probe",
  reservationId: "reservation_probe",
  operationKey: "opkey_probe1234",
  operationId: "op_probe",
  tenantRef: "tenant_probe",
  group: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  name: "probe",
  definitionVersion: "1.0.0",
  version: "v1",
  uploadId: "upload_probe",
  digest: `sha256:${"a".repeat(64)}`,
};

function concretePath(pattern: string): string {
  return pattern.replaceAll(/\{(\w+)\}/gu, (_match, parameter: string) => {
    const sample = PATH_SAMPLES[parameter];
    if (sample === undefined) throw new Error(`no sample for path parameter ${parameter}`);
    return sample;
  });
}

/** Every route the public Worker declares, including both Takoform lanes. */
const DECLARED_ROUTES = [
  ...ROUTES,
  ...TAKOFORM_LANES.flatMap((lane) =>
    TAKOFORM_ROUTES.map((route) => ({
      ...route,
      pattern: takoformRoutePattern(lane, route.pattern),
    })),
  ),
];

/** Every path the document is expected to publish, derived from the same table. */
const DOCUMENTED_PATTERNS = [...new Set(DECLARED_ROUTES.map((route) => route.pattern))].sort();

describe("published API description", () => {
  test("publishes exactly the paths the route table declares", () => {
    // Derived, not transcribed. The list this used to compare against was a
    // second hand-written copy of the document, so the two could only ever
    // agree — including about a route neither of them mentioned.
    expect(openApiPaths()).toEqual(DOCUMENTED_PATTERNS);
    expect(JSON.stringify(openApiDocument)).not.toMatch(
      /forms\.takoform\.com\/(?:v1alpha3|v1beta1|v1beta4)/u,
    );
    expect(JSON.stringify(openApiDocument)).not.toMatch(
      /s3-credentials|takoserver\.s3-connection|support\/standard-services/u,
    );
  });

  test("publishes the Console sign-out the surface has always served", () => {
    // `DELETE /v1/session` is called by `console/src/api.ts`. It was absent
    // from the document for as long as the document was written by hand.
    expect(openApiPaths()).toContain("/v1/session");
  });

  test("publishes no sponsorship surface", () => {
    expect(JSON.stringify(openApiDocument)).not.toMatch(/sponsorship/u);
  });

  test("every route the table declares is one the dispatcher knows", async () => {
    // The check the two hand-written lists could not make: go to the built
    // application and confirm each declared route resolves to a handler. An
    // unknown path is answered by `router.ts` with the code `not_found`; a
    // known one answers its own refusal (401, 403, 400) or succeeds.
    const fetch = completeHandler();
    const unknown: string[] = [];
    for (const route of DECLARED_ROUTES) {
      const response = await fetch(
        new Request(`https://api.takoserver.com${concretePath(route.pattern)}`, {
          method: route.method.toUpperCase(),
        }),
      );
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: { code?: string } } | null;
      if (body?.error?.code === "not_found") {
        unknown.push(`${route.method.toUpperCase()} ${route.pattern}`);
      }
    }
    expect(unknown).toEqual([]);
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

  test("publishes the closed value-free Resource execution evidence contract", () => {
    const path = openApiDocument.paths[
      "/v1/organizations/{organizationId}/resources/{resourceUid}/execution-evidence"
    ] as {
      get: {
        parameters: readonly { name: string; in: string; required: boolean }[];
        responses: {
          "200": { content: { "application/json": { schema: { $ref: string } } } };
        };
      };
    };
    expect(
      path.get.parameters.map(({ name, in: location, required }) => [name, location, required]),
    ).toEqual([
      ["organizationId", "path", true],
      ["resourceUid", "path", true],
      ["limit", "query", false],
      ["cursor", "query", false],
    ]);
    expect(path.get.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ResourceExecutionEvidenceResponse",
    );

    const schemas = openApiDocument.components.schemas;
    expect(schemas.ResourceExecutionEvidenceResponse.additionalProperties).toBe(false);
    expect(schemas.ResourceExecutionEvidence.additionalProperties).toBe(false);
    expect(schemas.ResourceExecutionCommit.additionalProperties).toBe(false);
    expect(schemas.ResourceExecutionEvidence.properties.format.const).toBe(
      "takoserver.resource-execution-evidence/v1",
    );
    expect(schemas.ResourceExecutionEvidence.properties.coverage.enum).toEqual([
      "complete",
      "partial",
    ]);
    const serialized = JSON.stringify({
      response: schemas.ResourceExecutionEvidenceResponse,
      evidence: schemas.ResourceExecutionEvidence,
      commit: schemas.ResourceExecutionCommit,
    });
    expect(serialized).not.toMatch(/credential|providerReceipt|nativeId|outputs|spec/i);
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
    const spaceSchema = {
      type: "string",
      description:
        "Opaque stable Host Space identifier: 1-255 Unicode code points, with no slash, C0/C1 control, or boundary whitespace.",
      minLength: 1,
      maxLength: 255,
      pattern:
        "^(?![\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff])(?![\\s\\S]*[/\\u0000-\\u001f\\u007f-\\u009f])(?![\\s\\S]*[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]$)[\\s\\S]+$",
    } as const;
    expect(schemas.WorkerEndpointOriginReservationBinding.properties.space).toEqual(spaceSchema);
    expect(schemas.WorkerEndpointOriginReservationLegacyTarget.properties.space).toEqual(
      spaceSchema,
    );
    const spacePattern = new RegExp(spaceSchema.pattern, "u");
    for (const valid of [TAKOSUMI_TENANT_SPACE, "内 部", `tenant:${"界".repeat(248)}`]) {
      expect(spacePattern.test(valid)).toBe(true);
    }
    for (const invalid of ["", " leading", "trailing ", "tenant/child", "tenant:\u0000child"]) {
      expect(spacePattern.test(invalid)).toBe(false);
    }
    const resourceList = openApiDocument.paths["/v1/organizations/{organizationId}/resources"] as {
      get: {
        parameters: readonly {
          name: string;
          in: string;
          required: boolean;
          schema: unknown;
        }[];
      };
    };
    expect(resourceList.get.parameters).toContainEqual({
      name: "space",
      in: "query",
      required: false,
      schema: spaceSchema,
    });
    const nativeResidual = openApiDocument.paths[
      "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual"
    ] as { get: { parameters: readonly { name: string; schema: unknown }[] } };
    expect(
      nativeResidual.get.parameters.find((parameter) => parameter.name === "space")?.schema,
    ).toEqual(spaceSchema);
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
    expect(schemas.WorkerRuntimeInputPreparationRequest.required).toContain("publicApply");
    expect(schemas.WorkerRuntimeInputPreparationRequest.required).toContain(
      "canonicalPublicOrigin",
    );
    // No secret value ever appears in the projection the caller reads back.
    expect(JSON.stringify(schemas.WorkerRuntimeInputPreparation)).not.toContain("bindings");
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

  test("keeps every retired sponsorship operation unreachable with or without a bearer", async () => {
    const fetch = handler();
    const base = ["", "v1", "sponsorship", "tenants", "tenant_probe"].join("/");
    const operations = [
      ["POST", base],
      ["GET", `${base}/wallet`],
      ["POST", `${base}/takoform-run-credentials`],
      ["POST", `${base}/interface-oauth-resources/authorize`],
      ["GET", `${base}/inventory`],
      ["POST", `${base}/funding`],
      ["GET", `${base}/resources`],
      ["PUT", `${base}/resources/resource_probe`],
      ["DELETE", `${base}/resources/resource_probe`],
    ] as const;
    for (const authorization of [undefined, "Bearer retired-credential"]) {
      for (const [method, path] of operations) {
        const response = await fetch(
          new Request(`https://api.takoserver.com${path}`, {
            method,
            ...(authorization === undefined ? {} : { headers: { authorization } }),
          }),
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
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
