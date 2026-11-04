import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { SqlError } from "../src/ports.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

async function fixture(count: number) {
  const sql = createEphemeralSql();
  let now = Date.UTC(2026, 10, 4);
  const accounts = createAccounts({
    sql,
    clock: () => new Date(now),
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: `${assertion}@example.test`,
          displayName: assertion,
        };
      },
    },
  });
  const owner = await accounts.signIn({ provider: "google", assertion: "roster-owner" });
  const actor = await accounts.authenticate(`Bearer ${owner.sessionToken}`);
  if (!actor) throw new Error("local owner session missing");
  const created = [];
  for (let index = 0; index < count; index++) {
    now++;
    created.push(await accounts.createOrganization({ actor, name: `Organization ${index}` }));
  }
  return { sql, accounts, owner, actor, created };
}

test("the complete identity roster includes the 201st create ACK and excludes foreign membership", async () => {
  const { sql, accounts, owner, created } = await fixture(201);
  const stranger = await accounts.signIn({ provider: "google", assertion: "stranger" });
  const strangerActor = await accounts.authenticate(`Bearer ${stranger.sessionToken}`);
  if (!strangerActor) throw new Error("local stranger session missing");
  await accounts.createOrganization({ actor: strangerActor, name: "Foreign organization" });

  expect(await accounts.organizations(owner.principal.id)).toEqual(created);
  await sql.run("DELETE FROM org_memberships WHERE org_id = ? AND principal_id = ?", [
    created[100]!.id,
    owner.principal.id,
  ]);
  expect(await accounts.organizations(owner.principal.id)).toEqual(
    created.filter((_, index) => index !== 100),
  );
  expect(await accounts.organizations("unknown-principal")).toEqual([]);
});

test("the identity roster includes more than 1000 memberships and observes removal", async () => {
  const { sql, accounts, owner, actor, created } = await fixture(1_000);
  expect(await accounts.organizations(owner.principal.id)).toEqual(created);
  const extra = await accounts.createOrganization({ actor, name: "One more Organization" });
  const complete = await accounts.organizations(owner.principal.id);
  expect(complete).toHaveLength(1_001);
  expect(complete).toContainEqual(extra);

  await sql.run("DELETE FROM org_memberships WHERE org_id = ? AND principal_id = ?", [
    created[0]!.id,
    owner.principal.id,
  ]);
  const recovered = await accounts.organizations(owner.principal.id);
  expect(recovered).toHaveLength(1_000);
  expect(recovered).toContainEqual(extra);
  expect(recovered).not.toContainEqual(created[0]!);
});

test("the complete roster query preserves every membership and principal filter in local native D1", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "organization-roster-query-test",
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
          env: { AUTH_DB: { type: "d1", id: "organization-roster-query-test" } },
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
    // Only the read-model columns are needed: this fixture is not an installed
    // Auth schema, a credential issuer, or proof of native session admission.
    await sql.run(
      "CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT, owner_principal_id TEXT, created_at TEXT)",
    );
    await sql.run("CREATE TABLE org_memberships (org_id TEXT, principal_id TEXT)");
    await sql.run(
      "INSERT INTO orgs SELECT printf('org_%04d', value), printf('Organization %04d', value), 'roster-owner', printf('%04d', value) FROM json_each(?)",
      [JSON.stringify(Array.from({ length: 1_001 }, (_, index) => index + 1))],
    );
    await sql.run("INSERT INTO org_memberships SELECT id, 'roster-owner' FROM orgs");
    await sql.run("INSERT INTO orgs VALUES ('org_foreign', 'Foreign', 'stranger', '0000')");
    await sql.run("INSERT INTO org_memberships VALUES ('org_foreign', 'stranger')");
    const accounts = createAccounts({ sql, identity });
    expect(await accounts.organizations("roster-owner")).toHaveLength(1_001);
    await sql.run("DELETE FROM org_memberships WHERE org_id = 'org_1001'");
    const complete = await accounts.organizations("roster-owner");
    expect(complete.map((organization) => organization.id)).toEqual(
      Array.from({ length: 1_000 }, (_, index) => `org_${String(index + 1).padStart(4, "0")}`),
    );
    await sql.run(
      "DELETE FROM org_memberships WHERE org_id > 'org_0201' AND principal_id = 'roster-owner'",
    );
    const last = (await accounts.organizations("roster-owner")).at(-1);
    expect(last?.id).toBe("org_0201");
    expect(await accounts.organizations("unknown-principal")).toEqual([]);
  } finally {
    await runtime.dispose();
  }
}, 60_000);

test("an unavailable roster query is not returned as a successful empty roster", async () => {
  const failure = new SqlError("unavailable", "synthetic roster read failure");
  const accounts = createAccounts({
    identity,
    sql: {
      ...createEphemeralSql(),
      async query() {
        throw failure;
      },
    },
  });
  await expect(accounts.organizations("roster-owner")).rejects.toBe(failure);
});

const identity = {
  async verify() {
    throw new Error("the native roster-read fixture must not issue credentials");
  },
};
