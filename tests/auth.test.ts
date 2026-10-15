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
  test("proves only an existing exact organization owner without creating durable rows", async () => {
    const { principal, organization } = await ownerWithOrganization();
    const countsBefore = {
      principals: Number((await sql.query("SELECT COUNT(*) AS count FROM principals"))[0]?.count),
      sessions: Number(
        (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'session'"))[0]
          ?.count,
      ),
      apiKeys: Number(
        (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key'"))[0]
          ?.count,
      ),
    };

    await expect(
      accounts.proveExistingOwner({
        provider: "google",
        assertion: "owner",
        organizationId: organization.id,
        audience: "https://api.example.test",
        method: "operator-assertion",
      }),
    ).resolves.toEqual({ principal, organization });

    await expect(
      accounts.proveExistingOwner({
        provider: "github",
        assertion: "unknown",
        organizationId: organization.id,
        audience: "https://api.example.test",
        method: "operator-assertion",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(Number((await sql.query("SELECT COUNT(*) AS count FROM principals"))[0]?.count)).toBe(
      countsBefore.principals,
    );
    expect(
      Number(
        (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'session'"))[0]
          ?.count,
      ),
    ).toBe(countsBefore.sessions);
    expect(
      Number(
        (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key'"))[0]
          ?.count,
      ),
    ).toBe(countsBefore.apiKeys);
  });

  test("refuses stale owner membership when the Organization names another principal", async () => {
    const { actor, organization } = await ownerWithOrganization();
    const successor = await accounts.signIn({ provider: "github", assertion: "successor" });
    await sql.run("UPDATE orgs SET owner_principal_id = ? WHERE id = ?", [
      successor.principal.id,
      organization.id,
    ]);

    await expect(
      accounts.proveExistingOwner({
        provider: "google",
        assertion: "owner",
        organizationId: organization.id,
        audience: "https://api.example.test",
        method: "operator-assertion",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.requireOwner(actor, organization.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

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

  test("issues a 60-second session from one clock instant even when time advances", async () => {
    let tick = 0;
    const advancing = createAccounts({
      sql,
      identity,
      clock: () => new Date(Date.UTC(2026, 8, 3, 12, 0, 0) + tick++ * 250),
    });
    const signedIn = await advancing.signIn({
      provider: "google",
      assertion: "advancing-clock-owner",
      sessionTtlSeconds: 60,
    });
    const sessions = await sql.query(
      "SELECT created_at, expires_at FROM auth_tokens WHERE kind = 'session'",
    );
    expect(sessions).toEqual([
      {
        created_at: "2026-09-03T12:00:00.250Z",
        expires_at: "2026-09-03T12:01:00.250Z",
      },
    ]);
    await advancing.revokeSession(`Bearer ${signedIn.sessionToken}`);
    expect(await advancing.authenticate(`Bearer ${signedIn.sessionToken}`)).toBeNull();
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

  test("revokes only the exact session bearer", async () => {
    const first = await accounts.signIn({
      provider: "google",
      assertion: "first-session",
    });
    const second = await accounts.signIn({
      provider: "google",
      assertion: "second-session",
    });

    await accounts.revokeSession(`Bearer ${first.sessionToken}`);

    expect(await accounts.authenticate(`Bearer ${first.sessionToken}`)).toBeNull();
    expect(await accounts.authenticate(`Bearer ${second.sessionToken}`)).not.toBeNull();
    const revoked = await sql.query("SELECT revoked_at FROM auth_tokens WHERE id LIKE 'ses_%'");
    expect(revoked.filter((row) => row.revoked_at !== null)).toHaveLength(1);
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

describe("Accounts token capture", () => {
  const captureAccounts = () => createAccounts({ sql, identity, clock: () => new Date(now) });

  test("retains an actual session row without changing its ordinary Actor or requiring Auth103", async () => {
    const backend = captureAccounts();
    const signedIn = await backend.signIn({ provider: "google", assertion: "capture-owner" });
    const authorization = `Bearer ${signedIn.sessionToken}`;
    const actor = await backend.authenticate(authorization);
    const captured = await backend.captureAuthenticatedToken(authorization);
    if (!captured) throw new Error("Expected a captured session");
    const retained = backend.inspectAuthenticatedTokenCapture(captured);
    if (!retained) throw new Error("Expected the owning capture record");
    const rows = await sql.query("SELECT * FROM auth_tokens WHERE principal_id = ?", [
      signedIn.principal.id,
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const isDigest = (value: unknown): value is `sha256:${string}` =>
      typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
    if (
      !row ||
      typeof row.id !== "string" ||
      !isDigest(row.secret_digest) ||
      typeof row.created_at !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      throw new Error("Expected the actual raw token identity and timestamps");
    }
    expect(retained).toEqual({
      tokenId: row.id,
      digest: row.secret_digest,
      kind: "session",
      principalId: signedIn.principal.id,
      organizationId: null,
      scopesJson: "[]",
      scopes: [],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
    expect(await backend.authenticate(authorization)).toEqual(actor);
    expect(actor).toEqual({
      hostPrincipalId: signedIn.principal.id,
      principalId: signedIn.principal.id,
      scopes: [],
      kind: "session",
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.scopes)).toBe(true);
    expect(Object.keys(captured)).toEqual([]);
    expect(JSON.stringify(captured)).toBe("{}");
    expect("class" in retained).toBe(false);
    expect(
      await sql.query(
        "SELECT name FROM sqlite_schema WHERE name IN ('auth_principal_incarnations', 'credential_authority_classes')",
      ),
    ).toEqual([]);
  });

  test("keeps actual key owner Org raw scope and legacy creation text without inferring a payer", async () => {
    const { actor, organization, principal } = await ownerWithOrganization();
    const issued = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "capture-key",
      scopes: ["payments:write", "catalog:read"],
      expiresInSeconds: 3600,
    });
    const rawScopes = '[ "payments:write", "catalog:read" ]';
    const rawCreatedAt = "2026-08-17 12:00:00";
    await sql.run("UPDATE auth_tokens SET scopes_json = ?, created_at = ? WHERE id = ?", [
      rawScopes,
      rawCreatedAt,
      issued.apiKey.id,
    ]);
    const backend = captureAccounts();
    const authorization = `Bearer ${issued.secret}`;
    const ordinary = await backend.authenticate(authorization);
    const captured = await backend.captureAuthenticatedToken(authorization);
    if (!captured) throw new Error("Expected a captured key");
    const retained = backend.inspectAuthenticatedTokenCapture(captured);
    if (!retained) throw new Error("Expected the owning key record");
    expect(retained.tokenId).toBe(issued.apiKey.id);
    expect(retained.kind).toBe("api_key");
    expect(retained.principalId).toBe(principal.id);
    expect(retained.organizationId).toBe(organization.id);
    expect(retained.scopesJson).toBe(rawScopes);
    expect(retained.scopes).toEqual(["payments:write", "catalog:read"]);
    expect(retained.createdAt).toBe(rawCreatedAt);
    expect(retained.expiresAt).toBe(issued.apiKey.expiresAt);
    expect(ordinary).toEqual({
      hostPrincipalId: `api-key:${issued.apiKey.id}`,
      principalId: principal.id,
      organizationId: organization.id,
      scopes: ["payments:write", "catalog:read"],
      kind: "api_key",
    });
    expect("class" in retained).toBe(false);
    expect("payer" in retained).toBe(false);
  });

  test("refuses absent malformed expired and revoked credentials without issuing replacement rows", async () => {
    const backend = captureAccounts();
    for (const authorization of [
      null,
      "",
      "Basic abc",
      "Bearer short",
      `Bearer ${"f".repeat(64)}`,
    ]) {
      expect(await backend.captureAuthenticatedToken(authorization)).toBeNull();
    }
    const revoked = await backend.signIn({ provider: "google", assertion: "revoke-capture" });
    const original = await backend.captureAuthenticatedToken(`Bearer ${revoked.sessionToken}`);
    if (!original) throw new Error("Expected initial capture");
    await backend.revokeSession(`Bearer ${revoked.sessionToken}`);
    expect(await backend.captureAuthenticatedToken(`Bearer ${revoked.sessionToken}`)).toBeNull();
    expect(await backend.authenticate(`Bearer ${revoked.sessionToken}`)).toBeNull();
    // An old observation can remain inspectable; it is not reusable permission.
    expect(backend.inspectAuthenticatedTokenCapture(original)?.kind).toBe("session");
    const expired = await backend.signIn({
      provider: "github",
      assertion: "expire-capture",
      sessionTtlSeconds: 60,
    });
    const before = await sql.query("SELECT COUNT(*) AS total FROM auth_tokens");
    now += 60_000;
    expect(await backend.captureAuthenticatedToken(`Bearer ${expired.sessionToken}`)).toBeNull();
    expect(await backend.authenticate(`Bearer ${expired.sessionToken}`)).toBeNull();
    expect(await sql.query("SELECT COUNT(*) AS total FROM auth_tokens")).toEqual(before);
  });

  test("rejects malformed raw scope data using the actual token lookup", async () => {
    const { actor, organization } = await ownerWithOrganization();
    const issued = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "bad-capture-scopes",
      scopes: ["catalog:read"],
      expiresInSeconds: 3600,
    });
    const backend = captureAccounts();
    for (const scopesJson of [
      "not-json",
      "null",
      '{"scope":"catalog:read"}',
      "[1]",
      "[]",
      '["admin:everything"]',
      '["catalog:read","catalog:read"]',
    ]) {
      await sql.run("UPDATE auth_tokens SET scopes_json = ? WHERE id = ?", [
        scopesJson,
        issued.apiKey.id,
      ]);
      expect(await backend.captureAuthenticatedToken(`Bearer ${issued.secret}`)).toBeNull();
    }
  });

  test("refuses corrupted token kinds and session Org or scope mismatches", async () => {
    const backend = captureAccounts();
    const signedIn = await backend.signIn({ provider: "google", assertion: "corrupt-capture" });
    const rows = await sql.query("SELECT id FROM auth_tokens WHERE principal_id = ?", [
      signedIn.principal.id,
    ]);
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new Error("Expected actual token id");
    // Only this isolated SQLite fixture bypasses its CHECK to exercise corrupt-row parsing.
    await sql.run("PRAGMA ignore_check_constraints = ON");
    try {
      await sql.run("UPDATE auth_tokens SET kind = 'foreign-kind' WHERE id = ?", [id]);
      expect(await backend.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`)).toBeNull();
    } finally {
      await sql.run("UPDATE auth_tokens SET kind = 'session' WHERE id = ?", [id]);
      await sql.run("PRAGMA ignore_check_constraints = OFF");
    }
    await sql.run("UPDATE auth_tokens SET org_id = 'org_unselected' WHERE id = ?", [id]);
    expect(await backend.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`)).toBeNull();
    await sql.run(
      "UPDATE auth_tokens SET org_id = NULL, scopes_json = '[\"catalog:read\"]' WHERE id = ?",
      [id],
    );
    expect(await backend.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`)).toBeNull();
  });

  test("inspects only its own opaque handle and rejects clones foreign factories and Actors", async () => {
    const owner = captureAccounts();
    const foreign = captureAccounts();
    const signedIn = await owner.signIn({ provider: "google", assertion: "opaque-capture" });
    const handle = await owner.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`);
    if (!handle) throw new Error("Expected a captured handle");
    expect(owner.inspectAuthenticatedTokenCapture(handle)).not.toBeNull();
    expect(foreign.inspectAuthenticatedTokenCapture(handle)).toBeNull();
    expect(owner.inspectAuthenticatedTokenCapture({ ...handle })).toBeNull();
    expect(owner.inspectAuthenticatedTokenCapture(JSON.parse(JSON.stringify(handle)))).toBeNull();
    expect(owner.inspectAuthenticatedTokenCapture(Object.create(handle))).toBeNull();
    expect(
      owner.inspectAuthenticatedTokenCapture(
        await owner.authenticate(`Bearer ${signedIn.sessionToken}`),
      ),
    ).toBeNull();
    expect(owner.inspectAuthenticatedTokenCapture(null)).toBeNull();
    expect(owner.inspectAuthenticatedTokenCapture("opaque-capture")).toBeNull();
  });

  test("refuses expiry reached while its actual SQLite lookup was awaited", async () => {
    const signedIn = await accounts.signIn({
      provider: "google",
      assertion: "await-expiry",
      sessionTtlSeconds: 60,
    });
    const primary = sql;
    const delayed: Sql = {
      async query(statement, params) {
        const rows = await primary.query(statement, params);
        if (statement.includes("FROM auth_tokens")) now += 60_000;
        return rows;
      },
      run: (statement, params) => primary.run(statement, params),
      batch: (statements) => primary.batch(statements),
    };
    const backend = createAccounts({ sql: delayed, identity, clock: () => new Date(now) });
    expect(await backend.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`)).toBeNull();
  });
});
