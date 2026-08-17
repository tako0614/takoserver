import { describe, expect, test } from "bun:test";
import {
  createTakoserver,
  type ExternalIdentityVerifier,
  PortableFakeBackend,
  TakoserverError,
} from "../src/index.ts";

describe("Takoserver account seam", () => {
  test.each(["google", "github"] as const)(
    "exchanges a verified %s identity for a Takoserver session",
    async (provider) => {
      const identity: ExternalIdentityVerifier = {
        async verify(input) {
          expect(input).toEqual({ provider, assertion: `valid-${provider}` });
          return {
            providerSubject: `${provider}-subject-1`,
            email: `owner@${provider}.example`,
            displayName: "Owner",
          };
        },
      };
      const server = createTakoserver({
        identity,
        backends: [new PortableFakeBackend("fake-primary", [])],
      });

      const result = await server.execute({
        kind: "identity.exchange",
        provider,
        assertion: `valid-${provider}`,
      });

      expect(result.kind).toBe("identity.exchanged");
      if (result.kind !== "identity.exchanged") throw new Error("unexpected result");
      expect(result.principal.identity).toEqual({
        provider,
        providerSubject: `${provider}-subject-1`,
      });
      expect(result.sessionToken.startsWith("tks_session_")).toBe(true);
    },
  );
});

describe("Takoserver organization and API-key seam", () => {
  test("creates an organization and a scoped one-time API-key secret", async () => {
    const server = testServer();
    const signIn = await server.execute({
      kind: "identity.exchange",
      provider: "google",
      assertion: "valid-google",
    });
    if (signIn.kind !== "identity.exchanged") throw new Error("unexpected result");

    const created = await server.execute({
      kind: "organization.create",
      authorization: `Bearer ${signIn.sessionToken}`,
      name: "Acme Hosting",
    });
    expect(created.kind).toBe("organization.created");
    if (created.kind !== "organization.created") throw new Error("unexpected result");

    const key = await server.execute({
      kind: "api-key.create",
      authorization: `Bearer ${signIn.sessionToken}`,
      organizationId: created.organization.id,
      name: "reseller production",
      scopes: ["wallet:read", "reseller:write"],
      expiresInSeconds: 3_600,
    });
    expect(key.kind).toBe("api-key.created");
    if (key.kind !== "api-key.created") throw new Error("unexpected result");
    expect(key.secret.startsWith("tks_key_")).toBe(true);
    expect(key.apiKey).toMatchObject({
      organizationId: created.organization.id,
      name: "reseller production",
      scopes: ["wallet:read", "reseller:write"],
    });

    const wallet = await server.execute({
      kind: "wallet.get",
      authorization: `Bearer ${key.secret}`,
      organizationId: created.organization.id,
    });
    expect(wallet).toMatchObject({
      kind: "wallet.read",
      wallet: { currency: "USD", settledMinor: 0, heldMinor: 0, availableMinor: 0 },
    });

    const revoked = await server.execute({
      kind: "api-key.revoke",
      authorization: `Bearer ${signIn.sessionToken}`,
      organizationId: created.organization.id,
      apiKeyId: key.apiKey.id,
    });
    expect(revoked).toMatchObject({ kind: "api-key.revoked", apiKey: { id: key.apiKey.id } });
    await expect(
      server.execute({
        kind: "wallet.get",
        authorization: `Bearer ${key.secret}`,
        organizationId: created.organization.id,
      }),
    ).rejects.toEqual(new TakoserverError("unauthenticated", 401));
  });

  test("fails closed for an unknown bearer", async () => {
    const server = testServer();
    await expect(
      server.execute({
        kind: "organization.create",
        authorization: "Bearer unknown",
        name: "Must not exist",
      }),
    ).rejects.toEqual(new TakoserverError("unauthenticated", 401));
  });
});

function testServer() {
  let sequence = 0;
  const identity: ExternalIdentityVerifier = {
    async verify({ provider, assertion }) {
      if (assertion !== `valid-${provider}`) throw new Error("invalid external assertion");
      return {
        providerSubject: `${provider}-subject-1`,
        email: `owner@${provider}.example`,
        displayName: "Owner",
      };
    },
  };
  return createTakoserver({
    identity,
    backends: [new PortableFakeBackend("fake-primary", [])],
    randomToken: () => `token-${++sequence}`,
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
  });
}
