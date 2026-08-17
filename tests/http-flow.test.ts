import { describe, expect, test } from "bun:test";
import {
  createExecutionGrantSigner,
  createHttpHandler,
  createResourceRuntime,
  createRuntimeGrantVerifier,
  createTakoserver,
  type ExternalIdentityVerifier,
  InMemoryGrantReplayStore,
  PortableFakeBackend,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
} from "../src/index.ts";

const offering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Standard object storage",
  form: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  price: { currency: "USD" as const, unit: "resource_month", unitPriceMinor: 300 },
  allowances: [
    {
      protocol: "s3" as const,
      mode: "direct" as const,
      authority: "resource_scoped_grant" as const,
    },
  ],
};

describe("Takoserver public vertical slice", () => {
  test("runs direct identity through prepaid resource usage without another product identity", async () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const backend = new PortableFakeBackend("portable", [offering]);
    const identity: ExternalIdentityVerifier = {
      async verify(input) {
        if (input.provider !== "github" || input.assertion !== "verified-github-assertion") {
          throw new Error("provider rejected assertion");
        }
        return { providerSubject: "github-42", email: "owner@example.com", displayName: "Owner" };
      },
    };
    const server = createTakoserver({
      identity,
      backends: [backend],
      grantSigner: createExecutionGrantSigner({
        issuer: "https://api.takoserver.com",
        keyId: "http-flow-key",
        privateKey: keys.privateKey,
      }),
      fundingSettlement: {
        async verify({ settlementProof }) {
          if (settlementProof !== "proof_http_payment") throw new Error("invalid proof");
          return {
            fundingRef: "settled_http_payment",
            amountMinor: 1_000,
            currency: "USD" as const,
          };
        },
      },
      clock: () => new Date(now),
    });
    const runtime = createResourceRuntime({
      backends: [backend],
      committer: { commit: (input) => server.commitProvisioning(input) },
      verifier: createRuntimeGrantVerifier({
        issuer: "https://api.takoserver.com",
        audience: "takoserver.runtime.v1",
        publicKeys: new Map([["http-flow-key", keys.publicKey]]),
        replayStore: new InMemoryGrantReplayStore(),
        clock: () => new Date(now + 1_000),
      }),
      clock: () => new Date(now + 1_000),
    });
    const handler = createHttpHandler({
      server,
      runtime,
      publicOrigin: "https://api.takoserver.com",
    });

    const session = await json(handler, "POST", "/v1/sessions", {
      provider: "github",
      assertion: "verified-github-assertion",
    });
    expect(session.status).toBe(200);
    const sessionToken = requiredString(session.body, "sessionToken");

    const organization = await json(
      handler,
      "POST",
      "/v1/organizations",
      { name: "Direct Reseller" },
      {
        authorization: `Bearer ${sessionToken}`,
      },
    );
    expect(organization.status).toBe(201);
    const organizationId = requiredString(requiredRecord(organization.body, "organization"), "id");

    const key = await json(
      handler,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      {
        name: "automation",
        scopes: ["catalog:read", "wallet:read", "reseller:write", "usage:read"],
        expiresInSeconds: 3_600,
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    expect(key.status).toBe(201);
    const apiKey = requiredString(key.body, "secret");
    const apiHeaders = { authorization: `Bearer ${apiKey}` };

    expect(
      (
        await json(
          handler,
          "POST",
          `/v1/organizations/${organizationId}/wallet/funding`,
          { settlementProof: "proof_http_payment" },
          {
            authorization: `Bearer ${sessionToken}`,
            "idempotency-key": "http-funding-001",
          },
        )
      ).status,
    ).toBe(200);

    const catalog = await json(
      handler,
      "GET",
      `/v1/catalog?organizationId=${organizationId}`,
      undefined,
      apiHeaders,
    );
    expect(catalog.status).toBe(200);
    expect(catalog.body).toMatchObject({ offerings: [{ id: offering.id, backendId: "portable" }] });

    const quote = await json(
      handler,
      "POST",
      "/v1/reseller/quotes",
      { organizationId, tenantRef: "opaque_customer_77", offeringId: offering.id, quantity: 1 },
      { ...apiHeaders, "idempotency-key": "http-quote-00001" },
    );
    const quoteId = requiredString(requiredRecord(quote.body, "quote"), "id");
    const reservation = await json(
      handler,
      "POST",
      "/v1/reseller/reservations",
      { organizationId, tenantRef: "opaque_customer_77", quoteId },
      { ...apiHeaders, "idempotency-key": "http-reserve-001" },
    );
    const reservationId = requiredString(requiredRecord(reservation.body, "reservation"), "id");
    const grant = await json(
      handler,
      "POST",
      `/v1/reseller/reservations/${reservationId}/grants`,
      {
        organizationId,
        tenantRef: "opaque_customer_77",
        operation: "resource.provision",
        intent: {
          name: "customer-media",
          space: "customer-space",
          spec: { location: "auto" },
        },
        expiresInSeconds: 120,
      },
      { ...apiHeaders, "idempotency-key": "http-grant-00001" },
    );
    const grantToken = requiredString(requiredRecord(grant.body, "grant"), "token");

    const substitutedResource = await json(
      handler,
      "POST",
      "/v1/resources",
      { name: "other-media", space: "customer-space", spec: { location: "auto" } },
      { authorization: `Bearer ${grantToken}`, "idempotency-key": "http-runtime-substitution" },
    );
    expect(substitutedResource.status).toBe(401);
    expect(substitutedResource.body).toEqual({
      error: { code: "wrong_intent", message: "execution grant rejected" },
    });

    const resource = await json(
      handler,
      "POST",
      "/v1/resources",
      { name: "customer-media", space: "customer-space", spec: { location: "auto" } },
      { authorization: `Bearer ${grantToken}`, "idempotency-key": "http-runtime-001" },
    );
    expect(resource.status).toBe(201);
    expect(resource.body).toMatchObject({
      resource: { tenantRef: "opaque_customer_77", backendId: "portable", state: "ready" },
    });
    const resourceRef = requiredString(requiredRecord(resource.body, "resource"), "id");
    const replayedResource = await json(
      handler,
      "POST",
      "/v1/resources",
      { name: "customer-media", space: "customer-space", spec: { location: "auto" } },
      { authorization: `Bearer ${grantToken}`, "idempotency-key": "http-runtime-001" },
    );
    expect(replayedResource.status).toBe(201);
    expect(requiredRecord(replayedResource.body, "resource").id).toBe(resourceRef);

    const dataGrant = await json(
      handler,
      "POST",
      `/v1/reseller/reservations/${reservationId}/grants`,
      {
        organizationId,
        tenantRef: "opaque_customer_77",
        operation: "s3.access",
        intent: {
          operation: "get",
          tenantRef: "opaque_customer_77",
          resourceRef,
          key: "welcome.txt",
        },
        expiresInSeconds: 120,
      },
      { ...apiHeaders, "idempotency-key": "http-data-grant-0001" },
    );
    expect(dataGrant.status).toBe(201);
    expect(dataGrant.body).toMatchObject({ grant: { operation: "s3.access" } });
    const disallowedDataGrant = await json(
      handler,
      "POST",
      `/v1/reseller/reservations/${reservationId}/grants`,
      {
        organizationId,
        tenantRef: "opaque_customer_77",
        operation: "ai.invoke",
        intent: {
          operation: "models.list",
          tenantRef: "opaque_customer_77",
          resourceRef,
        },
        expiresInSeconds: 120,
      },
      { ...apiHeaders, "idempotency-key": "http-disallowed-data-grant" },
    );
    expect(disallowedDataGrant.status).toBe(400);
    expect(disallowedDataGrant.body).toEqual({
      error: {
        code: "invalid_argument",
        message: "operation is not allowed by the provisioned resource",
      },
    });

    const statement = await json(
      handler,
      "GET",
      `/v1/reseller/reservations/${reservationId}/usage-statement?organizationId=${organizationId}&tenantRef=opaque_customer_77`,
      undefined,
      apiHeaders,
    );
    expect(statement.status).toBe(200);
    expect(statement.body).toMatchObject({
      statement: { tenantRef: "opaque_customer_77", amountMinor: 300 },
    });
  });
});

async function json(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found))
    throw new Error(`missing ${key}`);
  return found as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string") throw new Error(`missing ${key}`);
  return found;
}
