import { beforeEach, describe, expect, test } from "bun:test";
import {
  type Accounts,
  AuthError,
  createAccounts,
  type ExternalIdentityVerifier,
} from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";

const identity: ExternalIdentityVerifier = {
  async verify({ provider, assertion }) {
    return {
      providerSubject: `${provider}:${assertion}`,
      email: `${assertion}@example.com`,
      displayName: assertion,
    };
  },
};

let sql: Sql;
let accounts: Accounts;
let now: number;

beforeEach(() => {
  sql = createEphemeralSql();
  now = Date.UTC(2026, 7, 17, 12, 0, 0);
  accounts = createAccounts({ sql, identity, clock: () => new Date(now) });
});

async function ownerWithOrganization() {
  const { principal, sessionToken } = await accounts.signIn({
    provider: "google",
    assertion: "owner",
  });
  const actor = await accounts.authenticate(`Bearer ${sessionToken}`);
  if (!actor) throw new Error("session did not authenticate");
  const organization = await accounts.createOrganization({
    actor,
    name: "Acme",
  });
  return { principal, sessionToken, actor, organization };
}

describe("accounts", () => {
  test("returns the same principal for a repeated sign-in", async () => {
    const first = await accounts.signIn({
      provider: "google",
      assertion: "owner",
    });
    const second = await accounts.signIn({
      provider: "google",
      assertion: "owner",
    });
    expect(second.principal.id).toBe(first.principal.id);
    // A second sign-in mints a new session rather than reusing the old secret.
    expect(second.sessionToken).not.toBe(first.sessionToken);

    const other = await accounts.signIn({
      provider: "github",
      assertion: "owner",
    });
    expect(other.principal.id).not.toBe(first.principal.id);
  });

  test("projects Takos ID legal Organizations and will not mint a second one", async () => {
    let organizations = [{ id: "org_legal", name: "Legal Ltd.", role: "owner" as const }];
    const externalAccounts = createAccounts({
      sql,
      clock: () => new Date(now),
      identity: {
        async verify() {
          return {
            providerSubject: "pairwise-takoserver-owner",
            email: "owner@example.test",
            displayName: "Owner",
            organizations,
          };
        },
      },
    });
    const signedIn = await externalAccounts.signIn({
      provider: "takos-id",
      assertion: "signed-id-token",
      method: "oidc",
    });
    const actor = await externalAccounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("Takos ID session did not authenticate");

    expect(await externalAccounts.organizations(signedIn.principal.id)).toEqual([
      {
        id: "org_legal",
        name: "Legal Ltd.",
        ownerPrincipalId: signedIn.principal.id,
        createdAt: new Date(now).toISOString(),
      },
    ]);
    await expect(externalAccounts.requireOwner(actor, "org_legal")).resolves.toMatchObject({
      id: "org_legal",
    });
    await expect(
      externalAccounts.createOrganization({ actor, name: "Second authority" }),
    ).rejects.toMatchObject({ code: "invalid" });

    organizations = [];
    const signedInAfterRevocation = await externalAccounts.signIn({
      provider: "takos-id",
      assertion: "new-signed-id-token",
      method: "oidc",
    });
    const actorAfterRevocation = await externalAccounts.authenticate(
      `Bearer ${signedInAfterRevocation.sessionToken}`,
    );
    if (!actorAfterRevocation) throw new Error("new Takos ID session did not authenticate");
    expect(await externalAccounts.organizations(signedIn.principal.id)).toEqual([]);
    await expect(
      externalAccounts.requireOwner(actorAfterRevocation, "org_legal"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("hands out an API key secret exactly once and keeps only its digest", async () => {
    const { actor, organization } = await ownerWithOrganization();
    const { apiKey, secret } = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "deployer",
      scopes: ["resources:write", "catalog:read"],
      expiresInSeconds: 3_600,
    });
    expect(apiKey.scopes).toEqual(["resources:write", "catalog:read"]);

    const stored = await sql.query("SELECT secret_digest FROM auth_tokens WHERE id = ?", [
      apiKey.id,
    ]);
    expect(String(stored[0]?.secret_digest)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(secret);

    const resolved = await accounts.authorize(`Bearer ${secret}`, "resources:write");
    expect(resolved).toMatchObject({
      organizationId: organization.id,
      kind: "api_key",
    });
    // A scope the key was not granted is refused even though the key is valid.
    expect(await accounts.authorize(`Bearer ${secret}`, "wallet:read")).toBeNull();
  });

  test("treats each API key as a separate Host principal without changing its owner", async () => {
    const { actor, principal, organization } = await ownerWithOrganization();
    const first = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "first workload",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    const second = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "second workload",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });

    const firstActor = await accounts.authenticate(`Bearer ${first.secret}`);
    const secondActor = await accounts.authenticate(`Bearer ${second.secret}`);
    expect(firstActor).toMatchObject({
      principalId: principal.id,
      organizationId: organization.id,
      hostPrincipalId: `api-key:${first.apiKey.id}`,
    });
    expect(secondActor).toMatchObject({
      principalId: principal.id,
      organizationId: organization.id,
      hostPrincipalId: `api-key:${second.apiKey.id}`,
    });
    expect(firstActor?.hostPrincipalId).not.toBe(secondActor?.hostPrincipalId);
    if (!firstActor) throw new Error("first API key did not authenticate");
    await expect(accounts.requireOwner(firstActor, organization.id)).resolves.toEqual(organization);
  });

  test("stops accepting a key once revoked or expired", async () => {
    const { actor, organization } = await ownerWithOrganization();
    const { apiKey, secret } = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "temporary",
      scopes: ["catalog:read"],
      expiresInSeconds: 60,
    });
    expect(await accounts.authorize(`Bearer ${secret}`, "catalog:read")).not.toBeNull();

    now += 61_000;
    expect(await accounts.authenticate(`Bearer ${secret}`)).toBeNull();

    now -= 61_000;
    await accounts.revokeApiKey({
      actor,
      organizationId: organization.id,
      apiKeyId: apiKey.id,
    });
    expect(await accounts.authenticate(`Bearer ${secret}`)).toBeNull();
  });

  test("refuses to act on an organization the caller does not own", async () => {
    const { organization } = await ownerWithOrganization();
    const intruder = await accounts.signIn({
      provider: "github",
      assertion: "intruder",
    });
    const actor = await accounts.authenticate(`Bearer ${intruder.sessionToken}`);
    if (!actor) throw new Error("session did not authenticate");

    // Not-found rather than forbidden: ownership must not be probeable.
    await expect(
      accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "stolen",
        scopes: ["catalog:read"],
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.requireOwner(actor, "org_does_not_exist")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("fails closed on anything that is not a live bearer secret", async () => {
    for (const authorization of [
      null,
      "",
      "Basic abc",
      "Bearer ",
      "Bearer short",
      `Bearer ${"f".repeat(64)}`,
    ]) {
      expect(await accounts.authenticate(authorization)).toBeNull();
    }
  });

  test("refuses an unknown or duplicated scope", async () => {
    const { actor, organization } = await ownerWithOrganization();
    for (const scopes of [[], ["catalog:read", "catalog:read"], ["admin:everything"]]) {
      await expect(
        accounts.createApiKey({
          actor,
          organizationId: organization.id,
          name: "bad",
          scopes: scopes as never,
          expiresInSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(AuthError);
    }
  });

  test("does not treat a bare session as an organization actor", async () => {
    const { sessionToken } = await ownerWithOrganization();
    // A session proves who you are, not which organization you are acting for.
    expect(await accounts.authorize(`Bearer ${sessionToken}`, "catalog:read")).toBeNull();
  });
});
