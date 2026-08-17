import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createLedger,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";

/**
 * The join the old design was missing: declaring a resource through Takoform
 * provisions it on a backend *and* moves money, in that order, settling once.
 */

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
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
  unit: "bucket-month",
  unitPriceMinor: 500,
  protocols: ["s3"],
  capabilities: ["create", "update", "delete", "observe"],
};

const SOLD: Offering = {
  id: PROVIDER_OFFERING.id,
  providerId: "fake",
  kind: PROVIDER_OFFERING.kind,
  displayName: PROVIDER_OFFERING.displayName,
  form: FORM_REF,
  price: { currency: "USD", unit: "bucket-month", unitPriceMinor: 500 },
  protocols: ["s3"],
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

function newApp(options: { failOn?: readonly string[] } = {}) {
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
    providers: [provider],
    offerings: [SOLD],
  });
  return { app, provider, ledger: createLedger(sql, () => new Date()) };
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

const LANE = "/apis/forms.takoform.com/v1alpha3";
const QUERY =
  `space=default&group=${encodeURIComponent(FORM_REF.apiVersion)}&kind=${FORM_REF.kind}` +
  `&definitionVersion=${FORM_REF.definitionVersion}` +
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
  const path = `${LANE}/resources/edge.forms.takoform.com/v1beta1/ObjectBucket/${name}?${QUERY}`;
  const body = { ...resource, review: { prepareDigest: review.prepareDigest } };
  const headers = { ...auth, "idempotency-key": idempotencyKey, "if-none-match": "*" };
  const response = await call(fetch, "PUT", path, body, headers);
  // The replay is the identical request, not a fresh review: a reviewed
  // prepare belongs to the state it was taken against.
  return { ...response, replay: () => call(fetch, "PUT", path, body, headers) };
}

describe("Takoform apply on a real backend", () => {
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
      `${LANE}/resources/edge.forms.takoform.com/v1beta1/ObjectBucket/doomed?${QUERY}`,
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
    const { app, ledger } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);
    await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "apply-003");

    const observed = await call(
      app.fetch,
      "POST",
      `${LANE}/resources/edge.forms.takoform.com/v1beta1/ObjectBucket/assets/observe?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "observe-001", "takoform-expected-generation": "1" },
    );
    expect(observed.status).toBe(200);
    // Observation reaches the backend by native identity and bills nothing.
    expect(await ledger.wallet(organizationId)).toMatchObject({ settledMinor: 1_500 });
  });

  test("deletes on the backend when the resource is deleted", async () => {
    const { app, provider } = newApp();
    const { provider: auth } = await tenant(app.fetch);
    await applyBucket(app.fetch, auth, "assets", {}, "apply-004");
    expect(provider.listResources()).toHaveLength(1);

    const deleted = await call(
      app.fetch,
      "DELETE",
      `${LANE}/resources/edge.forms.takoform.com/v1beta1/ObjectBucket/assets?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "delete-001", "takoform-expected-generation": "1" },
    );
    expect(deleted.status).toBe(204);
    expect(provider.listResources()).toEqual([]);
  });
});
