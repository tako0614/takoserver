import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  type Offering,
} from "../src/index.ts";

/**
 * The prepaid vertical, driven end to end over HTTP exactly as a customer
 * would: sign in, create an organization, mint a key, fund the wallet, price an
 * offering, reserve it, hand a runtime a single-use token, then capture.
 */

const OFFERING: Offering = {
  id: "storage.object.standard",
  providerPackRef: "cloudflare",
  providerInstallationRef: "cloudflare.primary",
  supplyContractRef: "cloudflare.test-contract",
  pricePlanRef: "storage.object.standard.price-v1",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  price: { currency: "USD", unit: "bucket-month", unitPriceMinor: 500 },
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
  async verify({ settlementProof }) {
    return { fundingRef: `settled_${settlementProof}`, amountMinor: 10_000, currency: "USD" };
  },
};

function newApp() {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [OFFERING],
  });
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
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

async function fundedOrganization(fetch: (request: Request) => Promise<Response>) {
  const session = await call(fetch, "POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified",
  });
  const sessionToken = String(session.body.sessionToken);
  const owner = { authorization: `Bearer ${sessionToken}` };

  const organization = await call(fetch, "POST", "/v1/organizations", { name: "Acme" }, owner);
  const organizationId = String((organization.body.organization as { id: string }).id);

  const key = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    {
      name: "reseller",
      scopes: ["reseller:write", "catalog:read", "wallet:read"],
      expiresInSeconds: 3_600,
    },
    owner,
  );
  const secret = String(key.body.secret);

  await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/wallet/funding`,
    { settlementProof: "proof-1" },
    owner,
  );
  return { organizationId, owner, keyHeaders: { authorization: `Bearer ${secret}` } };
}

describe("prepaid vertical over HTTP", () => {
  test("carries one reservation from quote to captured statement", async () => {
    const { fetch } = newApp();
    const { organizationId, owner, keyHeaders } = await fundedOrganization(fetch);

    const wallet = await call(
      fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(wallet.body.wallet).toMatchObject({ settledMinor: 10_000, availableMinor: 10_000 });

    const catalog = await call(
      fetch,
      "GET",
      `/v1/catalog?organizationId=${organizationId}`,
      undefined,
      keyHeaders,
    );
    expect(catalog.status).toBe(200);
    expect((catalog.body.offerings as unknown[]).length).toBe(1);

    const quote = await call(
      fetch,
      "POST",
      "/v1/reseller/quotes",
      { tenantRef: "tenant_x", offeringId: OFFERING.id, quantity: 2 },
      keyHeaders,
    );
    expect(quote.status).toBe(201);
    expect(quote.body.quote).toMatchObject({ amountMinor: 1_000 });

    const reservation = await call(
      fetch,
      "POST",
      "/v1/reseller/reservations",
      { tenantRef: "tenant_x", quoteId: String((quote.body.quote as { id: string }).id) },
      keyHeaders,
    );
    expect(reservation.status).toBe(201);
    const reservationId = String((reservation.body.reservation as { id: string }).id);

    const held = await call(
      fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(held.body.wallet).toMatchObject({ heldMinor: 1_000, availableMinor: 9_000 });

    const token = await call(
      fetch,
      "POST",
      `/v1/reseller/reservations/${reservationId}/provision-tokens`,
      { tenantRef: "tenant_x", expiresInSeconds: 120 },
      keyHeaders,
    );
    // No signing key is configured for this app, so minting must fail closed
    // rather than hand out an unverifiable credential.
    expect(token.status).toBe(400);

    const captured = await call(
      fetch,
      "POST",
      `/v1/reseller/reservations/${reservationId}/capture`,
      { tenantRef: "tenant_x", usage: { meter: "bucket-month", quantity: 2 } },
      keyHeaders,
    );
    expect(captured.status).toBe(200);
    expect(captured.body.statement).toMatchObject({ amountMinor: 1_000 });

    const settled = await call(
      fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(settled.body.wallet).toMatchObject({ settledMinor: 9_000, heldMinor: 0 });

    const statement = await call(
      fetch,
      "GET",
      `/v1/reseller/reservations/${reservationId}/usage-statement?tenantRef=tenant_x`,
      undefined,
      keyHeaders,
    );
    expect(statement.status).toBe(200);
  });

  test("keeps sessions and API keys in their own lanes", async () => {
    const { fetch } = newApp();
    const { organizationId, owner, keyHeaders } = await fundedOrganization(fetch);

    // An API key may not administer the organization that issued it.
    const keyAdmin = await call(
      fetch,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      { name: "escalated", scopes: ["reseller:write"], expiresInSeconds: 60 },
      keyHeaders,
    );
    expect(keyAdmin.status).toBe(401);

    // A session is not an organization actor on the reseller lane.
    const sessionReseller = await call(
      fetch,
      "POST",
      "/v1/reseller/quotes",
      { tenantRef: "tenant_x", offeringId: OFFERING.id, quantity: 1 },
      owner,
    );
    expect(sessionReseller.status).toBe(403);
  });

  test("hides another organization's wallet", async () => {
    const { fetch } = newApp();
    const first = await fundedOrganization(fetch);
    const second = await fundedOrganization(fetch);

    const crossed = await call(
      fetch,
      "GET",
      `/v1/organizations/${first.organizationId}/wallet`,
      undefined,
      second.keyHeaders,
    );
    expect(crossed.status).toBe(403);
  });

  test("refuses a reservation the wallet cannot cover, leaving the balance intact", async () => {
    const { fetch } = newApp();
    const { organizationId, owner, keyHeaders } = await fundedOrganization(fetch);

    const quote = await call(
      fetch,
      "POST",
      "/v1/reseller/quotes",
      { tenantRef: "tenant_x", offeringId: OFFERING.id, quantity: 100 },
      keyHeaders,
    );
    const reservation = await call(
      fetch,
      "POST",
      "/v1/reseller/reservations",
      { tenantRef: "tenant_x", quoteId: String((quote.body.quote as { id: string }).id) },
      keyHeaders,
    );
    expect(reservation.status).toBe(402);

    const wallet = await call(
      fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(wallet.body.wallet).toMatchObject({ heldMinor: 0, availableMinor: 10_000 });
  });

  test("credits a repeated settlement proof exactly once", async () => {
    const { fetch } = newApp();
    const { organizationId, owner } = await fundedOrganization(fetch);
    await call(
      fetch,
      "POST",
      `/v1/organizations/${organizationId}/wallet/funding`,
      { settlementProof: "proof-1" },
      owner,
    );
    const wallet = await call(
      fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(wallet.body.wallet).toMatchObject({ settledMinor: 10_000 });
  });

  test("returns expired holds when the background pass runs", async () => {
    let now = Date.UTC(2026, 7, 17, 12, 0, 0);
    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [OFFERING],
      clock: () => new Date(now),
    });
    const { organizationId, owner, keyHeaders } = await fundedOrganization(app.fetch);
    const quote = await call(
      app.fetch,
      "POST",
      "/v1/reseller/quotes",
      { tenantRef: "tenant_x", offeringId: OFFERING.id, quantity: 1 },
      keyHeaders,
    );
    await call(
      app.fetch,
      "POST",
      "/v1/reseller/reservations",
      { tenantRef: "tenant_x", quoteId: String((quote.body.quote as { id: string }).id) },
      keyHeaders,
    );

    expect((await app.tick()).expiredReservations).toBe(0);
    now += 61 * 60_000;
    expect((await app.tick()).expiredReservations).toBe(1);

    const wallet = await call(
      app.fetch,
      "GET",
      `/v1/organizations/${organizationId}/wallet`,
      undefined,
      owner,
    );
    expect(wallet.body.wallet).toMatchObject({ heldMinor: 0, availableMinor: 10_000 });
  });
});
