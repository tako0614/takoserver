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
      return await original.run(text, params);
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
