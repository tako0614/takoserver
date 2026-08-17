import { describe, expect, test } from "bun:test";
import {
  createExecutionGrantSigner,
  createRuntimeGrantVerifier,
  createTakoserver,
  type ExecutionGrantSigner,
  type ExternalIdentityVerifier,
  InMemoryGrantReplayStore,
  PortableFakeBackend,
  TakoserverError,
  type TakoserverModule,
} from "../src/index.ts";
import { TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM } from "../src/takoform-released-provider.ts";

export const objectBucketOffering = {
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

describe("Takoserver prepaid commercial seam", () => {
  test("conserves money from verified funding through hold, capture, and usage", async () => {
    const context = await commercialContext();
    const auth = `Bearer ${context.apiKey}`;

    const funded = await context.server.execute({
      kind: "wallet.fund",
      authorization: `Bearer ${context.sessionToken}`,
      organizationId: context.organizationId,
      settlementProof: "proof_payment_001",
      idempotencyKey: "funding-request-001",
    });
    expect(funded.kind).toBe("wallet.funded");

    const quoted = await context.server.execute({
      kind: "reseller.quote",
      authorization: auth,
      organizationId: context.organizationId,
      tenantRef: "tenant_opaque_B7x9",
      offeringId: objectBucketOffering.id,
      quantity: 1,
      idempotencyKey: "quote-request-0001",
    });
    expect(quoted.kind).toBe("reseller.quoted");
    if (quoted.kind !== "reseller.quoted") throw new Error("unexpected result");
    expect(quoted.quote).toMatchObject({
      tenantRef: "tenant_opaque_B7x9",
      amountMinor: 300,
      currency: "USD",
    });

    const reserved = await context.server.execute({
      kind: "reseller.reserve",
      authorization: auth,
      organizationId: context.organizationId,
      tenantRef: "tenant_opaque_B7x9",
      quoteId: quoted.quote.id,
      idempotencyKey: "reserve-request-01",
    });
    expect(reserved.kind).toBe("reseller.reserved");
    if (reserved.kind !== "reseller.reserved") throw new Error("unexpected result");
    expect(reserved.wallet).toMatchObject({
      settledMinor: 1_000,
      heldMinor: 300,
      availableMinor: 700,
    });

    const captured = await context.server.execute({
      kind: "reseller.capture",
      authorization: auth,
      organizationId: context.organizationId,
      tenantRef: "tenant_opaque_B7x9",
      reservationId: reserved.reservation.id,
      usage: { meter: "resource_month", quantity: 1 },
      idempotencyKey: "capture-request-01",
    });
    expect(captured.kind).toBe("reseller.captured");
    if (captured.kind !== "reseller.captured") throw new Error("unexpected result");
    expect(captured.wallet).toMatchObject({
      settledMinor: 700,
      heldMinor: 0,
      availableMinor: 700,
    });
    expect(captured.statement).toMatchObject({
      tenantRef: "tenant_opaque_B7x9",
      amountMinor: 300,
      currency: "USD",
      usage: { meter: "resource_month", quantity: 1 },
    });

    const read = await context.server.execute({
      kind: "wallet.get",
      authorization: auth,
      organizationId: context.organizationId,
    });
    if (read.kind !== "wallet.read") throw new Error("unexpected result");
    expect(
      read.wallet.entries.map(({ settledDeltaMinor, heldDeltaMinor }) => [
        settledDeltaMinor,
        heldDeltaMinor,
      ]),
    ).toEqual([
      [1_000, 0],
      [0, 300],
      [-300, -300],
    ]);
    expect(read.wallet.settledMinor - read.wallet.heldMinor).toBe(read.wallet.availableMinor);
  });

  test("deduplicates a settled funding reference across request-key replay", async () => {
    const context = await commercialContext();
    const base = {
      kind: "wallet.fund" as const,
      authorization: `Bearer ${context.sessionToken}`,
      organizationId: context.organizationId,
      settlementProof: "proof_payment_replayed",
    };
    const first = await context.server.execute({ ...base, idempotencyKey: "funding-first-001" });
    const replay = await context.server.execute({ ...base, idempotencyKey: "funding-second-01" });
    if (first.kind !== "wallet.funded" || replay.kind !== "wallet.funded") {
      throw new Error("unexpected result");
    }
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.wallet.settledMinor).toBe(1_000);
    expect(replay.wallet.entries).toHaveLength(1);

    await expect(
      context.server.execute({
        ...base,
        settlementProof: "proof_payment_replayed_conflict",
        idempotencyKey: "funding-third-001",
      }),
    ).rejects.toEqual(
      new TakoserverError("conflict", 409, "funding reference was reused with different input"),
    );

    await expect(
      context.server.execute({
        ...base,
        authorization: `Bearer ${context.apiKey}`,
        idempotencyKey: "funding-api-key-denied",
      }),
    ).rejects.toEqual(new TakoserverError("permission_denied", 403));
  });

  test("fails before creating a hold when prepaid funds are insufficient", async () => {
    const context = await commercialContext();
    const authorization = `Bearer ${context.apiKey}`;
    const quote = await context.server.execute({
      kind: "reseller.quote",
      authorization,
      organizationId: context.organizationId,
      tenantRef: "tenant_without_funds",
      offeringId: objectBucketOffering.id,
      quantity: 1,
      idempotencyKey: "quote-no-funds-01",
    });
    if (quote.kind !== "reseller.quoted") throw new Error("unexpected result");
    await expect(
      context.server.execute({
        kind: "reseller.reserve",
        authorization,
        organizationId: context.organizationId,
        tenantRef: "tenant_without_funds",
        quoteId: quote.quote.id,
        idempotencyKey: "reserve-no-funds",
      }),
    ).rejects.toEqual(new TakoserverError("insufficient_funds", 402));
    const wallet = await context.server.execute({
      kind: "wallet.get",
      authorization,
      organizationId: context.organizationId,
    });
    if (wallet.kind !== "wallet.read") throw new Error("unexpected result");
    expect(wallet.wallet.entries).toEqual([]);
    expect(wallet.wallet.availableMinor).toBe(0);
  });

  test("releases a reservation once and rejects a later capture", async () => {
    const context = await fundedReservation();
    const releaseCommand = {
      kind: "reseller.release" as const,
      authorization: `Bearer ${context.apiKey}`,
      organizationId: context.organizationId,
      tenantRef: "tenant_release_01",
      reservationId: context.reservationId,
      idempotencyKey: "release-request-001",
    };
    const released = await context.server.execute(releaseCommand);
    const replay = await context.server.execute(releaseCommand);
    if (released.kind !== "reseller.released" || replay.kind !== "reseller.released") {
      throw new Error("unexpected result");
    }
    expect(released.reservation.status).toBe("released");
    expect(released.wallet).toMatchObject({
      settledMinor: 1_000,
      heldMinor: 0,
      availableMinor: 1_000,
    });
    expect(replay.entry.id).toBe(released.entry.id);
    expect(replay.wallet.entries).toHaveLength(3);

    await expect(
      context.server.execute({
        kind: "reseller.capture",
        authorization: `Bearer ${context.apiKey}`,
        organizationId: context.organizationId,
        tenantRef: "tenant_release_01",
        reservationId: context.reservationId,
        usage: { meter: "resource_month", quantity: 1 },
        idempotencyKey: "capture-after-release",
      }),
    ).rejects.toEqual(new TakoserverError("conflict", 409, "reservation is not active"));
  });

  test("expires a reservation by releasing its hold before any later capture", async () => {
    const context = await fundedReservation();
    context.advance(5 * 60 * 1_000 + 1);

    const wallet = await context.server.execute({
      kind: "wallet.get",
      authorization: `Bearer ${context.apiKey}`,
      organizationId: context.organizationId,
    });
    if (wallet.kind !== "wallet.read") throw new Error("unexpected result");
    expect(wallet.wallet).toMatchObject({
      settledMinor: 1_000,
      heldMinor: 0,
      availableMinor: 1_000,
    });
    expect(wallet.wallet.entries.at(-1)).toMatchObject({
      type: "release",
      settledDeltaMinor: 0,
      heldDeltaMinor: -300,
    });

    await expect(
      context.server.execute({
        kind: "reseller.capture",
        authorization: `Bearer ${context.apiKey}`,
        organizationId: context.organizationId,
        tenantRef: "tenant_release_01",
        reservationId: context.reservationId,
        usage: { meter: "resource_month", quantity: 1 },
        idempotencyKey: "capture-after-expiry",
      }),
    ).rejects.toEqual(new TakoserverError("expired", 409));
  });

  test("issues a tenant-only provision grant without capturing before provider success", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const signer = createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "service-grant-key",
      privateKey: keys.privateKey,
    });
    const context = await fundedReservation(signer);
    const command = {
      kind: "reseller.grant" as const,
      authorization: `Bearer ${context.apiKey}`,
      organizationId: context.organizationId,
      tenantRef: "tenant_release_01",
      reservationId: context.reservationId,
      operation: "resource.provision" as const,
      intent: {
        name: "tenant-media",
        space: "tenant-space",
        spec: { location: "auto" },
      },
      expiresInSeconds: 120,
      idempotencyKey: "grant-request-0001",
    };
    const granted = await context.server.execute(command);
    const replay = await context.server.execute(command);
    if (granted.kind !== "reseller.granted" || replay.kind !== "reseller.granted") {
      throw new Error("unexpected result");
    }
    expect(replay.grant.token).toBe(granted.grant.token);
    const payloadPart = granted.grant.token.split(".")[1];
    if (!payloadPart) throw new Error("missing payload");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    expect(payload).toMatchObject({
      securityDomainId: expect.stringMatching(/^domain_/),
      tenantRef: "tenant_release_01",
      reservationId: context.reservationId,
      offeringId: objectBucketOffering.id,
      operation: "resource.provision",
    });
    expect(Object.keys(payload)).not.toContain("organizationId");
    expect(Object.keys(payload)).not.toContain("workspaceId");
    expect(Object.keys(payload)).not.toContain("userId");

    const verified = await createRuntimeGrantVerifier({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      publicKeys: new Map([["service-grant-key", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      clock: () => new Date("2026-08-17T12:00:01.000Z"),
    }).verifyAndConsume(granted.grant.token, { operation: "resource.provision" });
    expect(verified.tenantRef).toBe("tenant_release_01");
    const wallet = await context.server.execute({
      kind: "wallet.get",
      authorization: `Bearer ${context.apiKey}`,
      organizationId: context.organizationId,
    });
    expect(wallet).toMatchObject({
      kind: "wallet.read",
      wallet: { settledMinor: 1_000, heldMinor: 300, availableMinor: 700 },
    });
    await expect(
      context.server.execute({
        kind: "usage.get",
        authorization: `Bearer ${context.apiKey}`,
        organizationId: context.organizationId,
        tenantRef: "tenant_release_01",
        reservationId: context.reservationId,
      }),
    ).rejects.toEqual(new TakoserverError("not_found", 404));
  });

  test("rejects a data-plane grant before a resource was successfully provisioned", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const context = await fundedReservation(
      createExecutionGrantSigner({
        issuer: "https://api.takoserver.com",
        keyId: "allowance-key",
        privateKey: keys.privateKey,
      }),
    );

    await expect(
      context.server.execute({
        kind: "reseller.grant",
        authorization: `Bearer ${context.apiKey}`,
        organizationId: context.organizationId,
        tenantRef: "tenant_release_01",
        reservationId: context.reservationId,
        operation: "ai.invoke",
        intent: { tenantRef: "tenant_release_01", resourceRef: "bucket_01" },
        expiresInSeconds: 120,
        idempotencyKey: "grant-wrong-allowance",
      }),
    ).rejects.toEqual(new TakoserverError("conflict", 409, "resource is not provisioned"));
  });
});

async function commercialContext(grantSigner?: ExecutionGrantSigner): Promise<{
  readonly server: TakoserverModule;
  readonly organizationId: string;
  readonly apiKey: string;
  readonly sessionToken: string;
  readonly advance: (milliseconds: number) => void;
}> {
  let sequence = 0;
  let now = Date.parse("2026-08-17T12:00:00.000Z");
  const identity: ExternalIdentityVerifier = {
    async verify({ provider }) {
      return {
        providerSubject: `${provider}-commercial-owner`,
        email: "commercial-owner@example.com",
        displayName: "Commercial Owner",
      };
    },
  };
  const server = createTakoserver({
    identity,
    backends: [new PortableFakeBackend("fake-primary", [objectBucketOffering])],
    randomToken: () => `commercial-${++sequence}`,
    clock: () => new Date(now),
    fundingSettlement: {
      async verify({ settlementProof }) {
        const settlement = FUNDING_SETTLEMENTS[settlementProof];
        if (!settlement) throw new TakoserverError("invalid_argument", 400, "invalid proof");
        return settlement;
      },
    },
    ...(grantSigner ? { grantSigner } : {}),
  });
  const signedIn = await server.execute({
    kind: "identity.exchange",
    provider: "github",
    assertion: "valid-github",
  });
  if (signedIn.kind !== "identity.exchanged") throw new Error("unexpected result");
  const organization = await server.execute({
    kind: "organization.create",
    authorization: `Bearer ${signedIn.sessionToken}`,
    name: "Reseller",
  });
  if (organization.kind !== "organization.created") throw new Error("unexpected result");
  const key = await server.execute({
    kind: "api-key.create",
    authorization: `Bearer ${signedIn.sessionToken}`,
    organizationId: organization.organization.id,
    name: "commercial API",
    scopes: ["catalog:read", "wallet:read", "reseller:write", "usage:read"],
    expiresInSeconds: 3_600,
  });
  if (key.kind !== "api-key.created") throw new Error("unexpected result");
  return {
    server,
    organizationId: organization.organization.id,
    apiKey: key.secret,
    sessionToken: signedIn.sessionToken,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

async function fundedReservation(grantSigner?: ExecutionGrantSigner) {
  const context = await commercialContext(grantSigner);
  const authorization = `Bearer ${context.apiKey}`;
  await context.server.execute({
    kind: "wallet.fund",
    authorization: `Bearer ${context.sessionToken}`,
    organizationId: context.organizationId,
    settlementProof: "proof_release_payment",
    idempotencyKey: "fund-release-request",
  });
  const quote = await context.server.execute({
    kind: "reseller.quote",
    authorization,
    organizationId: context.organizationId,
    tenantRef: "tenant_release_01",
    offeringId: objectBucketOffering.id,
    quantity: 1,
    idempotencyKey: "quote-release-0001",
  });
  if (quote.kind !== "reseller.quoted") throw new Error("unexpected result");
  const reservation = await context.server.execute({
    kind: "reseller.reserve",
    authorization,
    organizationId: context.organizationId,
    tenantRef: "tenant_release_01",
    quoteId: quote.quote.id,
    idempotencyKey: "reserve-release-01",
  });
  if (reservation.kind !== "reseller.reserved") throw new Error("unexpected result");
  return { ...context, reservationId: reservation.reservation.id };
}

const FUNDING_SETTLEMENTS: Readonly<
  Record<
    string,
    { readonly fundingRef: string; readonly amountMinor: number; readonly currency: "USD" }
  >
> = {
  proof_payment_001: {
    fundingRef: "settled_payment_001",
    amountMinor: 1_000,
    currency: "USD",
  },
  proof_payment_replayed: {
    fundingRef: "settled_payment_replayed",
    amountMinor: 1_000,
    currency: "USD",
  },
  proof_payment_replayed_conflict: {
    fundingRef: "settled_payment_replayed",
    amountMinor: 2_000,
    currency: "USD",
  },
  proof_release_payment: {
    fundingRef: "settled_release_payment",
    amountMinor: 1_000,
    currency: "USD",
  },
};
