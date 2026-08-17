const json = { "application/json": { schema: { type: "object" } } } as const;
const ok = { description: "Successful response", content: json } as const;
const created = { description: "Created", content: json } as const;
const errors = {
  "400": { description: "Invalid request", content: json },
  "401": { description: "Authentication failed", content: json },
  "403": { description: "Permission denied", content: json },
  "409": { description: "Conflict, expiry, or replay", content: json },
} as const;
const bearer = [{ BearerAuth: [] }] as const;
const takoformBearer = [{ TakoformBearer: [] }] as const;

const takoformV3Paths = {
  "/apis/forms.takoform.com/v1alpha3/forms": {
    get: takoformOperation("listTakoformForms", false),
  },
  "/apis/forms.takoform.com/v1alpha3/form-definitions/{formGroup}/{formVersion}/{kind}": {
    get: takoformOperation("getTakoformFormDefinition", false),
  },
  "/apis/forms.takoform.com/v1alpha3/resources/validate": {
    post: takoformOperation("validateTakoformResource", true),
  },
  "/apis/forms.takoform.com/v1alpha3/resources/prepare": {
    post: takoformOperation("prepareTakoformResource", true),
  },
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}": {
    get: takoformOperation("getTakoformResource", false),
    put: takoformOperation("applyTakoformResource", true),
    delete: takoformOperation("deleteTakoformResource", false),
  },
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}/import": {
    post: takoformOperation("importTakoformResource", true),
  },
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}/observe": {
    post: takoformOperation("observeTakoformResource", false),
  },
  "/apis/forms.takoform.com/v1alpha3/operations/{operationId}": {
    get: takoformOperation("getTakoformOperation", false),
  },
  "/apis/forms.takoform.com/v1alpha3/operations/{operationId}/cancel": {
    post: takoformOperation("cancelTakoformOperation", false),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads": {
    post: takoformOperation("startTakoformArtifactUpload", true),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}/blobs/{sha256}": {
    put: takoformOperation("putTakoformArtifactBlob", false),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}/commit": {
    post: takoformOperation("commitTakoformArtifactUpload", false),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}": {
    delete: takoformOperation("abandonTakoformArtifactUpload", false),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/{manifestDigest}": {
    get: takoformOperation("getTakoformArtifactManifest", false),
  },
  "/apis/forms.takoform.com/v1alpha3/artifacts/blobs/{sha256}": {
    head: takoformOperation("headTakoformArtifactBlob", false),
  },
  "/apis/forms.takoform.com/v1alpha3/support/forms": {
    get: takoformOperation("listTakoformFormSupport", false),
  },
  "/apis/forms.takoform.com/v1alpha3/support/forms/{formGroup}/{formVersion}/{kind}/{definitionVersion}":
    {
      get: takoformOperation("getTakoformFormSupport", false),
    },
  "/apis/forms.takoform.com/v1alpha3/support/interfaces/{name}/{version}": {
    get: takoformOperation("getTakoformInterfaceSupport", false),
  },
  "/apis/forms.takoform.com/v1alpha3/support/bindings/{name}/{version}": {
    get: takoformOperation("getTakoformBindingSupport", false),
  },
} as const;

const takoformProviderV21Paths = Object.fromEntries(
  Object.entries(takoformV3Paths).map(([path, operation]) => [
    path.replaceAll("v1alpha3", "v1beta1"),
    operation,
  ]),
);

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Takoserver API",
    version: "0.1.0",
    description:
      "Independent Takoserver identity, organization, prepaid billing, reseller, resource, and usage contract.",
  },
  servers: [{ url: "https://api.takoserver.com" }],
  paths: {
    "/": {
      get: {
        operationId: "getConsole",
        summary: "Minimal direct Takoserver Console",
        responses: { "200": ok },
      },
    },
    "/.well-known/takoserver": {
      get: { operationId: "getTakoserverDiscovery", responses: { "200": ok } },
    },
    "/.well-known/takoform/v1alpha3": {
      get: { operationId: "getTakoformDiscovery", responses: { "200": ok } },
    },
    "/.well-known/takoform/v1beta1": {
      get: { operationId: "getReleasedProviderTakoformDiscovery", responses: { "200": ok } },
    },
    "/openapi.json": {
      get: { operationId: "getOpenApi", responses: { "200": ok } },
    },
    "/v1/identity/providers": {
      get: { operationId: "listIdentityProviders", responses: { "200": ok } },
    },
    "/v1/sessions": {
      post: {
        operationId: "exchangeIdentity",
        requestBody: body("IdentityExchangeRequest"),
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/organizations": {
      post: {
        operationId: "createOrganization",
        security: bearer,
        requestBody: body("OrganizationCreateRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/organizations/{organizationId}/api-keys": {
      post: {
        operationId: "createApiKey",
        security: bearer,
        parameters: [pathParameter("organizationId")],
        requestBody: body("ApiKeyCreateRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/organizations/{organizationId}/api-keys/{apiKeyId}": {
      delete: {
        operationId: "revokeApiKey",
        security: bearer,
        parameters: [pathParameter("organizationId"), pathParameter("apiKeyId")],
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/organizations/{organizationId}/wallet": {
      get: {
        operationId: "getWallet",
        security: bearer,
        parameters: [pathParameter("organizationId")],
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/organizations/{organizationId}/wallet/funding": {
      post: {
        operationId: "recordSettledFunding",
        security: bearer,
        parameters: [pathParameter("organizationId"), idempotencyHeader()],
        requestBody: body("WalletFundingRequest"),
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/catalog": {
      get: {
        operationId: "listCatalog",
        security: bearer,
        parameters: [queryParameter("organizationId", true)],
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/resources": {
      post: {
        operationId: "provisionResource",
        security: [{ ExecutionGrant: [] }],
        parameters: [idempotencyHeader()],
        requestBody: body("ResourceProvisionRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/storage/object": {
      get: dataOperation("getObject"),
      put: dataOperation("putObject"),
      head: dataOperation("headObject"),
      delete: dataOperation("deleteObject"),
    },
    "/v1/storage/objects": {
      get: dataOperation("listObjects"),
    },
    "/v1/ai/models": {
      get: dataOperation("listAiModels"),
    },
    "/v1/ai/chat/completions": {
      post: dataOperation("createAiChatCompletion"),
    },
    "/v1/reseller/quotes": {
      post: {
        operationId: "createResellerQuote",
        security: bearer,
        parameters: [idempotencyHeader()],
        requestBody: body("ResellerQuoteRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/reseller/reservations": {
      post: {
        operationId: "createResellerReservation",
        security: bearer,
        parameters: [idempotencyHeader()],
        requestBody: body("ResellerReservationRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/reseller/reservations/{reservationId}/grants": {
      post: {
        operationId: "issueResellerExecutionGrant",
        security: bearer,
        parameters: [pathParameter("reservationId"), idempotencyHeader()],
        requestBody: body("ResellerGrantRequest"),
        responses: { "201": created, ...errors },
      },
    },
    "/v1/reseller/reservations/{reservationId}/capture": {
      post: {
        operationId: "captureResellerReservation",
        security: bearer,
        parameters: [pathParameter("reservationId"), idempotencyHeader()],
        requestBody: body("ResellerCaptureRequest"),
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/reseller/reservations/{reservationId}/release": {
      post: {
        operationId: "releaseResellerReservation",
        security: bearer,
        parameters: [pathParameter("reservationId"), idempotencyHeader()],
        requestBody: body("ResellerReleaseRequest"),
        responses: { "200": ok, ...errors },
      },
    },
    "/v1/reseller/reservations/{reservationId}/usage-statement": {
      get: {
        operationId: "getResellerUsageStatement",
        security: bearer,
        parameters: [
          pathParameter("reservationId"),
          queryParameter("organizationId", true),
          queryParameter("tenantRef", true),
        ],
        responses: { "200": ok, ...errors },
      },
    },
    ...takoformV3Paths,
    ...takoformProviderV21Paths,
  },
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Takoserver session or API key" },
      ExecutionGrant: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Takoserver Ed25519 execution grant",
      },
      TakoformBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Takoserver organization API key or scoped run token",
      },
    },
    schemas: {
      IdentityExchangeRequest: objectSchema(
        {
          provider: { type: "string", enum: ["google", "github"] },
          assertion: { type: "string", minLength: 1, maxLength: 16_384 },
        },
        ["provider", "assertion"],
      ),
      OrganizationCreateRequest: objectSchema({ name: shortString() }, ["name"]),
      ApiKeyCreateRequest: objectSchema(
        {
          name: shortString(),
          scopes: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "catalog:read",
                "resources:write",
                "wallet:read",
                "reseller:write",
                "usage:read",
              ],
            },
          },
          expiresInSeconds: {
            type: "integer",
            minimum: 1,
            maximum: 7_776_000,
          },
        },
        ["name", "scopes", "expiresInSeconds"],
      ),
      WalletFundingRequest: objectSchema(
        { settlementProof: { type: "string", minLength: 1, maxLength: 16_384 } },
        ["settlementProof"],
      ),
      ResellerQuoteRequest: objectSchema(
        {
          organizationId: opaqueRef(),
          tenantRef: opaqueRef(),
          offeringId: opaqueRef(),
          quantity: positiveInteger(),
        },
        ["organizationId", "tenantRef", "offeringId", "quantity"],
      ),
      ResellerReservationRequest: objectSchema(
        { organizationId: opaqueRef(), tenantRef: opaqueRef(), quoteId: opaqueRef() },
        ["organizationId", "tenantRef", "quoteId"],
      ),
      ResellerGrantRequest: objectSchema(
        {
          organizationId: opaqueRef(),
          tenantRef: opaqueRef(),
          operation: {
            type: "string",
            enum: ["resource.provision", "resource.delete", "ai.invoke", "s3.access"],
          },
          intent: { type: "object" },
          expiresInSeconds: { type: "integer", minimum: 1, maximum: 300 },
        },
        ["organizationId", "tenantRef", "operation", "intent", "expiresInSeconds"],
      ),
      ResellerCaptureRequest: objectSchema(
        {
          organizationId: opaqueRef(),
          tenantRef: opaqueRef(),
          usage: objectSchema(
            { meter: opaqueRef(), quantity: { type: "number", exclusiveMinimum: 0 } },
            ["meter", "quantity"],
          ),
        },
        ["organizationId", "tenantRef", "usage"],
      ),
      ResellerReleaseRequest: objectSchema(
        { organizationId: opaqueRef(), tenantRef: opaqueRef() },
        ["organizationId", "tenantRef"],
      ),
      ResourceProvisionRequest: objectSchema(
        { name: opaqueRef(), space: opaqueRef(), spec: { type: "object" } },
        ["name", "space", "spec"],
      ),
      TakoformResourceCreateRequest: objectSchema(
        {
          apiVersion: {
            type: "string",
            pattern: "^[a-z0-9.-]+/v[0-9]+(?:alpha|beta)?[0-9]*$",
          },
          kind: opaqueRef(),
          form: { type: "object" },
          metadata: { type: "object" },
          spec: { type: "object" },
        },
        ["apiVersion", "kind", "form", "metadata", "spec"],
      ),
      ServiceAllowance: objectSchema(
        {
          protocol: { type: "string", enum: ["s3", "openai"] },
          mode: { const: "direct" },
          authority: { const: "resource_scoped_grant" },
        },
        ["protocol", "mode", "authority"],
      ),
      Error: objectSchema(
        {
          error: objectSchema({ code: { type: "string" }, message: { type: "string" } }, [
            "code",
            "message",
          ]),
        },
        ["error"],
      ),
    },
  },
} as const;

function body(schema: string) {
  return {
    required: true,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  } as const;
}

function takoformOperation(operationId: string, request: boolean) {
  return {
    operationId,
    security: takoformBearer,
    ...(request ? { requestBody: { required: true, content: json } } : {}),
    responses: { "200": ok, "201": created, "204": { description: "No content" }, ...errors },
  } as const;
}

function dataOperation(operationId: string) {
  return {
    operationId,
    security: [{ ExecutionGrant: [] }],
    responses: { "200": ok, "201": created, "204": { description: "No content" }, ...errors },
  } as const;
}

function pathParameter(name: string) {
  return { name, in: "path", required: true, schema: opaqueRef() } as const;
}

function queryParameter(name: string, required: boolean) {
  return { name, in: "query", required, schema: opaqueRef() } as const;
}

function idempotencyHeader() {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    schema: { type: "string", minLength: 8, maxLength: 128 },
  } as const;
}

function objectSchema(properties: Readonly<Record<string, unknown>>, required: readonly string[]) {
  return { type: "object", additionalProperties: false, properties, required } as const;
}

function opaqueRef() {
  return {
    type: "string",
    minLength: 3,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]+$",
  } as const;
}

function shortString() {
  return { type: "string", minLength: 1, maxLength: 128 } as const;
}

function positiveInteger() {
  return { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
}
