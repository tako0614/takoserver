import { describe, expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import {
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
  type TakoformHost,
  type TakoformResourceDriver,
} from "../src/index.ts";
import { createLedger } from "../src/ledger.ts";
import type { Sql } from "../src/ports.ts";
import { createReseller } from "../src/reseller.ts";
import { createTokenService, type SigningKey, type TokenService } from "../src/token.ts";
import { createStaticStableEphemeralTakoformHost as createTakoformHost } from "./helpers/historical-takoform-host.ts";

const ISSUER = "https://api.takoserver.test";
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com/v1alpha1",
  kind: "EdgeObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
} as const;

const INSTALLED_FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  displayName: "Edge object bucket",
  desiredSchema: {
    type: "object",
    additionalProperties: false,
    properties: { location: { type: "string" } },
    required: ["location"],
  },
  operations: ["create", "read", "update", "delete", "observe"],
};

const OFFERING: Offering = {
  id: "storage.object.standard",
  providerPackRef: "fake",
  providerInstallationRef: "fake.primary",
  supplyContractRef: "fake.test-contract",
  pricePlanRef: "storage.object.standard.price-v1",
  resourceClass: "storage.object",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: FORM_REF,
  pricePlan: {
    id: "storage.object.standard.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 500 },
    meters: [],
  },
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

const ORG = "org-reseller";
const TENANT = "tenant:alpha";

async function provisionKey(sql: Sql): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await sql.run(
    "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
    ["sign-test", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }), 0],
  );
  return { keyId: "sign-test", privateKey: pair.privateKey };
}

interface Lane {
  readonly host: TakoformHost;
  readonly tokens: TokenService;
  readonly issueToken: (overrides?: {
    readonly tenantRef?: string;
    readonly offeringDigest?: `sha256:${string}`;
  }) => Promise<string>;
  readonly reseller: ReturnType<typeof createReseller>;
  readonly reservation: { readonly id: string; readonly offeringDigest: `sha256:${string}` };
  readonly quoteMeter: string;
}

async function fundedLane(
  driver: TakoformResourceDriver = new InMemoryTakoformResourceDriver(),
): Promise<Lane> {
  const sql = createEphemeralSql();
  const clock = () => new Date(NOW);
  const ledger = createLedger(sql, clock);
  const catalog = createCatalog([OFFERING]);
  const reseller = createReseller({ sql, ledger, catalog, clock });
  const tokens = createTokenService({
    sql,
    issuer: ISSUER,
    clock,
    keyCacheSeconds: 0,
    signingKey: await provisionKey(sql),
  });
  const host = createTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    // The organization lane stays closed in these tests: everything a
    // provision token can do must not depend on any other credential.
    authenticate: async () => null,
    forms: [INSTALLED_FORM],
    driver,
    clock,
    provision: { tokens, catalog },
  });

  await ledger.fund({ organizationId: ORG, fundingRef: "pay_1", amountMinor: 10_000 });
  const quote = await reseller.quote({
    organizationId: ORG,
    tenantRef: TENANT,
    offeringId: OFFERING.id,
    quantity: 1,
  });
  const reservation = await reseller.reserve({
    organizationId: ORG,
    tenantRef: TENANT,
    quoteId: quote.id,
  });

  const issueToken = async (overrides?: {
    readonly tenantRef?: string;
    readonly offeringDigest?: `sha256:${string}`;
  }): Promise<string> => {
    const issued = await tokens.issueProvisionToken({
      organizationId: ORG,
      tenantRef: overrides?.tenantRef ?? TENANT,
      reservationId: reservation.id,
      offeringId: OFFERING.id,
      offeringDigest: overrides?.offeringDigest ?? reservation.offeringDigest,
      ttlSeconds: 120,
    });
    return issued.token;
  };

  return {
    host,
    tokens,
    issueToken,
    reseller,
    reservation: { id: reservation.id, offeringDigest: reservation.offeringDigest },
    quoteMeter: quote.meter,
  };
}

function resourceBody(space = TENANT): Record<string, unknown> {
  return {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { space, name: "media" },
    spec: { location: "eu" },
  };
}

async function laneRequest(
  host: TakoformHost,
  method: string,
  path: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await host.handle(
    new Request(`${ISSUER}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response) throw new Error(`lane did not answer ${method} ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function preparedDigest(
  host: TakoformHost,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const prepared = await laneRequest(host, "POST", "/provision/v1/resources/prepare", token, body);
  expect(prepared.status).toBe(200);
  const review = prepared.body.review as { prepareDigest: string };
  return review.prepareDigest;
}

const APPLY_PATH = `/provision/v1/resources/edge.forms.takoform.com/v1alpha1/EdgeObjectBucket/media`;

describe("provision-token redemption lane", () => {
  test("passes the reservation authority into the provider apply", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let commercialAuthority: Parameters<TakoformResourceDriver["apply"]>[0]["commercialAuthority"];
    const lane = await fundedLane({
      async apply(input) {
        commercialAuthority = input.commercialAuthority;
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
      import: (input) => memory.import(input),
    });
    const token = await lane.issueToken();
    const body = resourceBody();
    const prepareDigest = await preparedDigest(lane.host, token, body);
    const applied = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      token,
      { ...body, review: { prepareDigest } },
      { "idempotency-key": "provision-commercial-authority", "if-none-match": "*" },
    );

    expect(applied.status).toBe(201);
    expect(commercialAuthority).toEqual({
      reservationId: lane.reservation.id,
      offeringId: OFFERING.id,
      offeringDigest: lane.reservation.offeringDigest,
    });
  });

  test("a token prepares and applies exactly the purchased resource, once", async () => {
    const lane = await fundedLane();
    const token = await lane.issueToken();
    const body = resourceBody();
    const prepareDigest = await preparedDigest(lane.host, token, body);

    const applied = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      token,
      { ...body, review: { prepareDigest } },
      { "idempotency-key": "provision-1", "if-none-match": "*" },
    );
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({
      kind: FORM_REF.kind,
      metadata: { space: TENANT, name: "media" },
    });

    // The token is spent: the identical request loses to the replay ledger.
    const replayed = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      token,
      { ...body, review: { prepareDigest } },
      { "idempotency-key": "provision-1", "if-none-match": "*" },
    );
    expect(replayed.status).toBe(409);
    expect(replayed.body).toMatchObject({ error: { code: "token_replayed" } });

    // Once the provision token has been spent, the reservation's hold is the
    // payment authority for the resource that now exists. Releasing that hold
    // would leave a live provider resource unpaid.
    await expect(
      lane.reseller.release({
        organizationId: ORG,
        tenantRef: TENANT,
        reservationId: lane.reservation.id,
      }),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    await expect(
      lane.reseller.capture({
        organizationId: ORG,
        tenantRef: TENANT,
        reservationId: lane.reservation.id,
        usage: { meter: lane.quoteMeter, quantity: 1 },
      }),
    ).resolves.toMatchObject({ reservationId: lane.reservation.id, amountMinor: 500 });
  });

  test("the body must be the purchased form in the token's space", async () => {
    const lane = await fundedLane();

    const wrongSpace = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      await lane.issueToken(),
      resourceBody("tenant:beta"),
      { "idempotency-key": "provision-2", "if-none-match": "*" },
    );
    expect(wrongSpace.status).toBe(409);
    expect(wrongSpace.body).toMatchObject({ error: { code: "space_mismatch" } });

    const foreignForm = resourceBody();
    foreignForm.form = { formRef: { ...FORM_REF, definitionVersion: "2.0.0" } };
    const wrongForm = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      await lane.issueToken(),
      foreignForm,
      { "idempotency-key": "provision-3", "if-none-match": "*" },
    );
    expect(wrongForm.status).toBe(409);
    expect(wrongForm.body).toMatchObject({ error: { code: "offering_mismatch" } });
  });

  test("changed commercial terms are detected, not silently honoured", async () => {
    const lane = await fundedLane();
    const stale = await lane.issueToken({
      offeringDigest: `sha256:${"f".repeat(64)}`,
    });
    const drifted = await laneRequest(lane.host, "PUT", APPLY_PATH, stale, resourceBody(), {
      "idempotency-key": "provision-4",
      "if-none-match": "*",
    });
    expect(drifted.status).toBe(409);
    expect(drifted.body).toMatchObject({ error: { code: "offering_changed" } });
  });

  test("a token only creates: the create precondition is demanded up front", async () => {
    const lane = await fundedLane();
    const refused = await laneRequest(
      lane.host,
      "PUT",
      APPLY_PATH,
      await lane.issueToken(),
      resourceBody(),
      { "idempotency-key": "provision-5" },
    );
    expect(refused.status).toBe(400);
  });

  test("garbage bearers stay outside", async () => {
    const lane = await fundedLane();
    const refused = await laneRequest(lane.host, "PUT", APPLY_PATH, "not-a-token", resourceBody(), {
      "idempotency-key": "provision-6",
      "if-none-match": "*",
    });
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ error: { code: "unauthenticated" } });
  });

  test("meter rides the quote and reservation, and capture no longer needs it", async () => {
    const lane = await fundedLane();
    expect(lane.quoteMeter).toBe("resource.create");
    const statement = await lane.reseller.capture({
      organizationId: ORG,
      tenantRef: TENANT,
      reservationId: lane.reservation.id,
      usage: { quantity: 1 },
    });
    expect(statement.usage).toEqual({ meter: "resource.create", quantity: 1 });
  });
});

describe("Takoform run-token lane", () => {
  test("reuses a short-lived bearer only for its exact Form, space, and resource address", async () => {
    const stableFormRef = { ...FORM_REF, apiVersion: "edge.forms.takoform.com" } as const;
    const stableInstalledForm: InstalledTakoformForm = {
      ...INSTALLED_FORM,
      identity: { formRef: stableFormRef },
    };
    const stableOffering: Offering = { ...OFFERING, form: stableFormRef };
    const stableResourceBody = (space = TENANT): Record<string, unknown> => ({
      apiVersion: stableFormRef.apiVersion,
      kind: stableFormRef.kind,
      form: { formRef: stableFormRef },
      metadata: { space, name: "media" },
      spec: { location: "eu" },
    });
    const sql = createEphemeralSql();
    const clock = () => new Date(NOW);
    const catalog = createCatalog([stableOffering]);
    const ledger = createLedger(sql, clock);
    const reseller = createReseller({ sql, ledger, catalog, clock });
    await ledger.fund({ organizationId: ORG, fundingRef: "pay_run", amountMinor: 10_000 });
    const quote = await reseller.quote({
      organizationId: ORG,
      tenantRef: TENANT,
      offeringId: stableOffering.id,
      quantity: 1,
    });
    const reservation = await reseller.reserve({
      organizationId: ORG,
      tenantRef: TENANT,
      quoteId: quote.id,
    });
    const tokens = createTokenService({
      sql,
      issuer: ISSUER,
      clock,
      keyCacheSeconds: 0,
      signingKey: await provisionKey(sql),
    });
    const issued = await tokens.issueTakoformRunToken({
      organizationId: ORG,
      tenantRef: TENANT,
      reservationId: reservation.id,
      offeringId: stableOffering.id,
      offeringDigest: await catalog.digest(stableOffering),
      formRef: stableFormRef,
      resourceName: "media",
      mode: "provision",
      ttlSeconds: 600,
    });
    let mode: "provision" | "manage" = "provision";
    const host = createTakoformHost({
      sql,
      objects: createMemoryObjectStore(),
      authenticate: async (authorization) => {
        const token = authorization?.replace(/^Bearer /u, "");
        if (!token) return null;
        const claims = await tokens.verifyTakoformRunToken(token);
        return {
          tenantId: claims.organizationId,
          principalId: `run:${claims.tokenId}`,
          scope: {
            space: claims.tenantRef,
            formRef: claims.formRef,
            resourceName: claims.resourceName,
            mode,
            claimCreate: async () => {
              await tokens.claimTakoformRunTokenForCreate(token);
            },
          },
        };
      },
      forms: [stableInstalledForm],
      driver: new InMemoryTakoformResourceDriver(),
      clock,
    });

    const foreign = await laneRequest(
      host,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      issued.token,
      { ...stableResourceBody(), metadata: { space: TENANT, name: "other" } },
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: { code: "resource_not_found" } });

    const query = new URLSearchParams({
      space: TENANT,
      group: stableFormRef.apiVersion,
      kind: stableFormRef.kind,
      definitionVersion: stableFormRef.definitionVersion,
      schemaDigest: stableFormRef.schemaDigest,
    });
    const mutationPath = `/apis/forms.takoform.com/v1/resources/${stableFormRef.apiVersion}/${stableFormRef.kind}/media`;
    const resourcePath = `${mutationPath}?${query}`;
    const unreviewed = await laneRequest(
      host,
      "PUT",
      mutationPath,
      issued.token,
      { ...stableResourceBody(), review: { prepareDigest: `sha256:${"f".repeat(64)}` } },
      { "idempotency-key": "run-unreviewed", "if-none-match": "*" },
    );
    expect(unreviewed.status).toBe(400);
    expect(await sql.query("SELECT COUNT(*) AS total FROM provision_token_consumptions")).toEqual([
      { total: 0 },
    ]);

    const prepared = await laneRequest(
      host,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      issued.token,
      stableResourceBody(),
    );
    expect(prepared.status).toBe(200);
    const prepareDigest = String((prepared.body.review as { prepareDigest: string }).prepareDigest);
    const applied = await laneRequest(
      host,
      "PUT",
      mutationPath,
      issued.token,
      { ...stableResourceBody(), review: { prepareDigest } },
      { "idempotency-key": "run-apply-1", "if-none-match": "*" },
    );
    expect(applied.status).toBe(201);

    mode = "manage";
    const observed = await laneRequest(
      host,
      "POST",
      `${resourcePath.replace(`?${query}`, "/observe")}?${query}`,
      issued.token,
      {},
      { "idempotency-key": "run-observe-1", "takoform-expected-generation": "1" },
    );
    expect(observed.status).toBe(200);
  });
});
