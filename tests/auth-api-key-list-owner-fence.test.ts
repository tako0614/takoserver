import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  type ApiKeyAdministration,
  createAccounts,
  createApiKeyAdministration,
} from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

async function fixture() {
  const sql = createEphemeralSql();
  const administration = createApiKeyAdministration({ sql });
  let beforeList: (() => Promise<void>) | undefined;
  let afterList: (() => Promise<void>) | undefined;
  const delegated: ApiKeyAdministration = {
    ...administration,
    async list(...args) {
      if (beforeList) {
        const change = beforeList;
        beforeList = undefined;
        await change();
      }
      const result = await administration.list(...args);
      if (afterList) {
        const change = afterList;
        afterList = undefined;
        await change();
      }
      return result;
    },
  };
  const accounts = createAccounts({
    sql,
    apiKeyAdministration: delegated,
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
  const first = await accounts.signIn({ provider: "google", assertion: "synthetic-list-owner" });
  const next = await accounts.signIn({ provider: "google", assertion: "synthetic-list-successor" });
  const actor = await accounts.authenticate(`Bearer ${first.sessionToken}`);
  const successor = await accounts.authenticate(`Bearer ${next.sessionToken}`);
  if (!actor || !successor) throw new Error("fixture actor unavailable");
  const org = await accounts.createOrganization({ actor, name: "Synthetic key list" });
  const transfer = async () => {
    await sql.batch([
      { sql: "DELETE FROM org_memberships WHERE org_id = ?", params: [org.id] },
      {
        sql: "UPDATE orgs SET owner_principal_id = ? WHERE id = ?",
        params: [successor.principalId, org.id],
      },
      {
        sql: "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        params: [org.id, successor.principalId, org.createdAt],
      },
    ]);
    await accounts.createApiKey({
      actor: successor,
      organizationId: org.id,
      name: "successor-only-new-key",
      scopes: ["wallet:read"],
      expiresInSeconds: 60,
    });
  };
  return {
    accounts,
    administration,
    actor,
    successor,
    org,
    before(change: () => Promise<void>) {
      beforeList = change;
    },
    transferBeforeList() {
      beforeList = transfer;
    },
    transferAfterList() {
      afterList = transfer;
    },
    removeMembershipBeforeList() {
      beforeList = async () => {
        await sql.run("DELETE FROM org_memberships WHERE org_id = ?", [org.id]);
      };
    },
  };
}

test("owner key list refuses successor-only metadata created after the authorization", async () => {
  const f = await fixture();
  f.transferBeforeList();
  await expect(
    f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id }),
  ).rejects.toMatchObject({ code: "not_found" });
  const current = await f.accounts.apiKeys({ actor: f.successor, organizationId: f.org.id });
  expect(current.map((key) => key.name)).toEqual(["successor-only-new-key"]);
});

test("a current owner with genuinely no live keys sees an empty list", async () => {
  const f = await fixture();
  expect(await f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id })).toEqual([]);
});

test("membership loss at the key read is refused instead of shown as empty", async () => {
  const f = await fixture();
  f.removeMembershipBeforeList();
  await expect(
    f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id }),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a handoff after the key SELECT preserves only its authorized earlier snapshot", async () => {
  const f = await fixture();
  f.transferAfterList();
  expect(await f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id })).toEqual([]);
  expect(
    (await f.accounts.apiKeys({ actor: f.successor, organizationId: f.org.id }))[0]?.name,
  ).toBe("successor-only-new-key");
});

test("internal unfenced key listing remains available after an ownership handoff", async () => {
  const f = await fixture();
  f.transferBeforeList();
  await f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id }).catch(() => undefined);
  expect((await f.administration.list(f.org.id)).map((key) => key.name)).toEqual([
    "successor-only-new-key",
  ]);
});

test("owner key listing preserves descending order and the existing 200-key cap", async () => {
  const f = await fixture();
  for (let index = 0; index < 201; index++) {
    const result = await f.administration.issue({
      organizationId: f.org.id,
      expectedOwnerPrincipalId: f.actor.principalId,
      name: `synthetic-list-key-${index}`,
      scopes: ["wallet:read"],
      expiresInSeconds: 60,
    });
    expect(result.kind).toBe("issued");
  }
  const expected = await f.administration.list(f.org.id);
  const actual = await f.accounts.apiKeys({ actor: f.actor, organizationId: f.org.id });
  expect(actual).toHaveLength(200);
  expect(actual).toEqual(expected);
  for (let index = 1; index < actual.length; index++) {
    const previous = actual[index - 1],
      current = actual[index];
    if (!previous || !current) throw new Error("missing returned key");
    expect(
      previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id > current.id),
    ).toBe(true);
  }
});

test("the owner/empty-key distinction executes in local native D1", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "api-key-list-owner-query-test",
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
          env: { AUTH_DB: { type: "d1", id: "api-key-list-owner-query-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("AUTH_DB");
    const sql = createD1Sql(database.withSession("first-primary") as unknown as D1DatabaseLike, {
      acknowledgement: "explicit-d1-result",
    });
    // Mechanical SQL/null-row behavior only: these are not installed Auth or genuine issuer tables.
    await sql.run("CREATE TABLE orgs (id TEXT PRIMARY KEY, owner_principal_id TEXT)");
    await sql.run("CREATE TABLE org_memberships (org_id TEXT, principal_id TEXT, role TEXT)");
    await sql.run(
      "CREATE TABLE auth_tokens (secret_digest TEXT PRIMARY KEY, id TEXT UNIQUE, kind TEXT, principal_id TEXT, org_id TEXT, name TEXT, scopes_json TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT)",
    );
    await sql.run("INSERT INTO orgs VALUES ('org_native', 'first-owner')");
    await sql.run("INSERT INTO org_memberships VALUES ('org_native', 'first-owner', 'owner')");
    const administration = createApiKeyAdministration({ sql });
    expect(await administration.list("org_native", "first-owner")).toEqual([]);
    expect(
      (
        await administration.issue({
          organizationId: "org_native",
          expectedOwnerPrincipalId: "first-owner",
          name: "native-list-key",
          scopes: ["wallet:read"],
          expiresInSeconds: 60,
        })
      ).kind,
    ).toBe("issued");
    await sql.batch([
      { sql: "UPDATE orgs SET owner_principal_id = 'next-owner'", params: [] },
      { sql: "UPDATE org_memberships SET principal_id = 'next-owner'", params: [] },
    ]);
    await expect(administration.list("org_native", "first-owner")).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await administration.list("org_native", "next-owner"))[0]?.name).toBe(
      "native-list-key",
    );
    expect(await administration.list("org_native")).toHaveLength(1);
    await sql.run("DELETE FROM org_memberships");
    await expect(administration.list("org_native", "next-owner")).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await runtime.dispose();
  }
}, 60_000);
