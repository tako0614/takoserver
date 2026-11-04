import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createAccounts, createApiKeyAdministration } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

async function ownerFixture() {
  const original = createEphemeralSql();
  let beforeOwnerRead: (() => Promise<void>) | undefined;
  let beforeInsert: (() => Promise<void>) | undefined;
  let beforeRevoke: (() => Promise<void>) | undefined;
  let afterRevoke: (() => Promise<void>) | undefined;
  let revokeAttempts = 0;
  const sql: Sql = {
    async query(text, params) {
      if (text === "SELECT owner_principal_id FROM orgs WHERE id = ?" && beforeOwnerRead) {
        const change = beforeOwnerRead;
        beforeOwnerRead = undefined;
        await change();
      }
      return await original.query(text, params);
    },
    async run(text, params) {
      if (text.includes("INSERT INTO auth_tokens") && beforeInsert) {
        const change = beforeInsert;
        beforeInsert = undefined;
        await change();
      }
      const revoke = text.includes("UPDATE auth_tokens SET revoked_at");
      if (revoke) {
        revokeAttempts++;
        if (beforeRevoke) {
          const change = beforeRevoke;
          beforeRevoke = undefined;
          await change();
        }
      }
      const write = await original.run(text, params);
      if (revoke && afterRevoke) {
        const change = afterRevoke;
        afterRevoke = undefined;
        await change();
      }
      return write;
    },
    async batch(statements) {
      return await original.batch(statements);
    },
  };
  const accounts = createAccounts({
    sql,
    identity: {
      async verify({ provider, assertion }) {
        return {
          providerSubject: `${provider}:${assertion}`,
          email: `${assertion}@example.test`,
          displayName: assertion,
        };
      },
    },
  });
  const first = await accounts.signIn({ provider: "google", assertion: "first-owner" });
  const next = await accounts.signIn({ provider: "google", assertion: "next-owner" });
  const actor = await accounts.authenticate(`Bearer ${first.sessionToken}`);
  const successor = await accounts.authenticate(`Bearer ${next.sessionToken}`);
  if (!actor || !successor) throw new Error("fixture session unavailable");
  const organization = await accounts.createOrganization({ actor, name: "Owner handoff" });
  const transfer = async () => {
    await original.batch([
      {
        sql: "DELETE FROM org_memberships WHERE org_id = ?",
        params: [organization.id],
      },
      {
        sql: "UPDATE orgs SET owner_principal_id = ? WHERE id = ?",
        params: [successor.principalId, organization.id],
      },
      {
        sql: "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        params: [organization.id, successor.principalId, organization.createdAt],
      },
    ]);
  };

  return {
    accounts,
    actor,
    successor,
    organization,
    transferBeforeOwnerRead() {
      beforeOwnerRead = transfer;
    },
    transferBeforeInsert() {
      beforeInsert = transfer;
    },
    removeMembershipBeforeInsert() {
      beforeInsert = async () => {
        await original.run("DELETE FROM org_memberships WHERE org_id = ?", [organization.id]);
      };
    },
    transferBeforeRevoke() {
      beforeRevoke = transfer;
    },
    transferAfterRevoke() {
      afterRevoke = transfer;
    },
    removeMembershipBeforeRevoke(restoreAfter = false) {
      beforeRevoke = async () => {
        await original.run("DELETE FROM org_memberships WHERE org_id = ?", [organization.id]);
      };
      if (restoreAfter) {
        afterRevoke = async () => {
          await original.run(
            "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
            [organization.id, actor.principalId, organization.createdAt],
          );
        };
      }
    },
    loseRevokeAcknowledgement() {
      afterRevoke = async () => {
        throw new Error("synthetic_lost_revoke_ack");
      };
    },
    get revokeAttempts() {
      return revokeAttempts;
    },
    administration: createApiKeyAdministration({ sql }),
  };
}

test("a former owner cannot receive a successor's API key after the initial owner check", async () => {
  const fixture = await ownerFixture();
  fixture.transferBeforeOwnerRead();
  // Reduce a successful response to a tag so a failing test never prints a key.
  const outcome = await fixture.accounts
    .createApiKey({
      actor: fixture.actor,
      organizationId: fixture.organization.id,
      name: "owner-fence-key",
      scopes: ["resources:write"],
      expiresInSeconds: 60,
    })
    .then(
      () => ({ kind: "issued" }),
      (error: unknown) => ({
        kind: "refused",
        code: error instanceof Error && "code" in error ? error.code : "unknown",
      }),
    );

  expect(outcome).toEqual({ kind: "refused", code: "not_found" });
  expect(
    await fixture.accounts.apiKeys({
      actor: fixture.successor,
      organizationId: fixture.organization.id,
    }),
  ).toEqual([]);
});

test("the final key INSERT also refuses a removed owner membership", async () => {
  const fixture = await ownerFixture();
  fixture.removeMembershipBeforeInsert();
  const outcome = await fixture.accounts
    .createApiKey({
      actor: fixture.actor,
      organizationId: fixture.organization.id,
      name: "owner-fence-key",
      scopes: ["resources:write"],
      expiresInSeconds: 60,
    })
    .then(
      () => ({ kind: "issued" }),
      (error: unknown) => ({
        kind: "refused",
        code: error instanceof Error && "code" in error ? error.code : "unknown",
      }),
    );

  expect(outcome).toEqual({ kind: "refused", code: "not_found" });
  expect(await fixture.administration.list(fixture.organization.id)).toEqual([]);
});

test("the owner INSERT fence and unfenced operator exclusivity execute in local native D1", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "api-key-owner-fence-query-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { AUTH_DB: { type: "d1", id: "api-key-owner-fence-query-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("AUTH_DB");
    const original = createD1Sql(
      database.withSession("first-primary") as unknown as D1DatabaseLike,
      { acknowledgement: "explicit-d1-result" },
    );
    // Mechanical query/ACK qualification only. These minimal tables are not an
    // installed Auth schema, a native issuer or a genuine human credential.
    await original.run("CREATE TABLE orgs (id TEXT PRIMARY KEY, owner_principal_id TEXT)");
    await original.run("CREATE TABLE org_memberships (org_id TEXT, principal_id TEXT, role TEXT)");
    await original.run(`CREATE TABLE auth_tokens (
      secret_digest TEXT PRIMARY KEY, id TEXT UNIQUE, kind TEXT, principal_id TEXT,
      org_id TEXT, name TEXT, scopes_json TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT
    )`);
    await original.run("INSERT INTO orgs VALUES ('org_native', 'first-owner')");
    await original.run("INSERT INTO org_memberships VALUES ('org_native', 'first-owner', 'owner')");
    let transfer = false;
    const sql: Sql = {
      query: (text, params) => original.query(text, params),
      batch: (statements) => original.batch(statements),
      async run(text, params) {
        if (text.includes("INSERT INTO auth_tokens") && transfer) {
          transfer = false;
          await original.batch([
            { sql: "UPDATE orgs SET owner_principal_id = 'next-owner'", params: [] },
            {
              sql: "UPDATE org_memberships SET principal_id = 'next-owner'",
              params: [],
            },
          ]);
        }
        return await original.run(text, params);
      },
    };
    let id = 0;
    const administration = createApiKeyAdministration({
      sql,
      randomId: () => `native_${++id}`,
      randomSecret: () => `synthetic-local-owner-key-${id}`,
    });
    const input = {
      organizationId: "org_native",
      name: "native-owner-key",
      scopes: ["resources:read"] as const,
      expiresInSeconds: 60,
      expectedOwnerPrincipalId: "first-owner",
    };
    const first = await administration.issue(input);
    expect(first.kind).toBe("issued");
    transfer = true;
    await expect(administration.issue(input)).rejects.toMatchObject({ code: "not_found" });
    expect(await administration.list("org_native")).toHaveLength(1);

    const operatorInput = {
      organizationId: "org_native",
      name: "operator-exclusive",
      scopes: ["resources:read"] as const,
      expiresInSeconds: 60,
      apiKeyId: "key_native_operator",
      exclusiveUnrevokedName: "operator-exclusive",
    };
    expect((await administration.issue(operatorInput)).kind).toBe("issued");
    expect((await administration.issue(operatorInput)).kind).toBe("existing");
    expect(
      (await administration.issue({ ...operatorInput, apiKeyId: "key_native_conflict" })).kind,
    ).toBe("exclusive_conflict");
    expect(await administration.list("org_native")).toHaveLength(2);
    const revokeInput = {
      organizationId: "org_native",
      apiKeyId: "key_native_operator",
      expectedOwnerPrincipalId: "next-owner",
    };
    expect(
      await administration.revoke({ ...revokeInput, expectedOwnerPrincipalId: "first-owner" }),
    ).toBeNull();
    expect((await administration.status(revokeInput))?.present).toBe(true);
    expect((await administration.revoke(revokeInput))?.present).toBe(false);
    expect((await administration.revoke(revokeInput))?.present).toBe(false);
    expect(
      (
        await administration.revoke({
          organizationId: "org_native",
          apiKeyId: first.kind === "issued" ? first.apiKey.id : "unreachable",
        })
      )?.present,
    ).toBe(false);
    expect(
      await administration.revoke({ organizationId: "org_native", apiKeyId: "missing" }),
    ).toBeNull();
  } finally {
    await runtime.dispose();
  }
}, 60_000);

test("the final key INSERT refuses an owner handoff after the administration read", async () => {
  const fixture = await ownerFixture();
  fixture.transferBeforeInsert();
  const outcome = await fixture.accounts
    .createApiKey({
      actor: fixture.actor,
      organizationId: fixture.organization.id,
      name: "owner-fence-key",
      scopes: ["resources:write"],
      expiresInSeconds: 60,
    })
    .then(
      () => ({ kind: "issued" }),
      (error: unknown) => ({
        kind: "refused",
        code: error instanceof Error && "code" in error ? error.code : "unknown",
      }),
    );

  expect(outcome).toEqual({ kind: "refused", code: "not_found" });
  expect(
    await fixture.accounts.apiKeys({
      actor: fixture.successor,
      organizationId: fixture.organization.id,
    }),
  ).toEqual([]);
});

async function revocationFixture() {
  const fixture = await ownerFixture();
  const key = await fixture.accounts.createApiKey({
    actor: fixture.actor,
    organizationId: fixture.organization.id,
    name: "revocation-owner-fence",
    scopes: ["resources:read"],
    expiresInSeconds: 60,
  });
  const input = {
    actor: fixture.actor,
    organizationId: fixture.organization.id,
    apiKeyId: key.apiKey.id,
  };
  return {
    ...fixture,
    input,
    get revokeAttempts() {
      return fixture.revokeAttempts;
    },
  };
}

test("owner-fenced revoke refuses a handoff before UPDATE without revoking the key", async () => {
  const fixture = await revocationFixture();
  fixture.transferBeforeRevoke();
  await expect(fixture.accounts.revokeApiKey(fixture.input)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await fixture.administration.status(fixture.input))?.present).toBe(true);
});

test("owner-fenced revoke refuses a removed membership before UPDATE", async () => {
  const fixture = await revocationFixture();
  fixture.removeMembershipBeforeRevoke();
  await expect(fixture.accounts.revokeApiKey(fixture.input)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await fixture.administration.status(fixture.input))?.present).toBe(true);
});

test("owner-fenced revoke does not report success when the owner returns after a refused UPDATE", async () => {
  const fixture = await revocationFixture();
  fixture.removeMembershipBeforeRevoke(true);
  await expect(fixture.accounts.revokeApiKey(fixture.input)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await fixture.administration.status(fixture.input))?.present).toBe(true);
});

test("owner-fenced revoke with a handoff after UPDATE refuses metadata while preserving the committed effect", async () => {
  const fixture = await revocationFixture();
  fixture.transferAfterRevoke();
  await expect(fixture.accounts.revokeApiKey(fixture.input)).rejects.toMatchObject({
    code: "not_found",
  });
  // Refusal after the write is not evidence of no effect.
  expect((await fixture.administration.status(fixture.input))?.present).toBe(false);
});

test("owner-fenced revoke remains idempotent for the same current owner", async () => {
  const fixture = await revocationFixture();
  const first = await fixture.accounts.revokeApiKey(fixture.input);
  expect(await fixture.accounts.revokeApiKey(fixture.input)).toEqual(first);
  expect(fixture.revokeAttempts).toBe(1);
  expect((await fixture.administration.status(fixture.input))?.present).toBe(false);
});

test("owner-fenced revoke propagates a lost ACK without a second mutation", async () => {
  const fixture = await revocationFixture();
  fixture.loseRevokeAcknowledgement();
  await expect(fixture.accounts.revokeApiKey(fixture.input)).rejects.toThrow(
    "synthetic_lost_revoke_ack",
  );
  expect(fixture.revokeAttempts).toBe(1);
  expect((await fixture.administration.status(fixture.input))?.present).toBe(false);
});
