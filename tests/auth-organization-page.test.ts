import { expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createControlRoutes } from "../src/control.ts";
import { type Sql, SqlError } from "../src/ports.ts";

async function fixture(count: number, name = "Organization") {
  const storage = createEphemeralSql();
  const reads: number[] = [];
  const plans: string[] = [];
  let unavailable = false;
  const sql: Sql = {
    ...storage,
    async query(statement, params) {
      if (unavailable && statement.includes("org_memberships"))
        throw new SqlError("unavailable", "local roster unavailable");
      const rows = await storage.query(statement, params);
      if (statement.includes("org_memberships")) reads.push(rows.length);
      if (statement.includes("ORDER BY org_id ASC LIMIT")) {
        plans.push(
          ...(await storage.query(`EXPLAIN QUERY PLAN ${statement}`, params)).map((row) =>
            String(row.detail),
          ),
        );
      }
      return rows;
    },
  };
  const accounts = createAccounts({
    sql,
    identity: {
      async verify() {
        return { providerSubject: "owner", email: "owner@example.test", displayName: "Owner" };
      },
    },
  });
  const signed = await accounts.signIn({ provider: "google", assertion: "synthetic-only" });
  await sql.run(
    "INSERT INTO orgs SELECT printf('org_%04d', value), ?, ?, '2026-11-12T00:00:00Z' FROM json_each(?)",
    [name, signed.principal.id, JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))],
  );
  await sql.run("INSERT INTO org_memberships SELECT id, ?, 'owner', created_at FROM orgs", [
    signed.principal.id,
  ]);
  reads.length = 0;
  return {
    accounts,
    sql,
    reads,
    signed,
    plans,
    makeUnavailable() {
      unavailable = true;
    },
  };
}

for (const count of [201, 1_001]) {
  test(`bounded organization pages enumerate all ${count} memberships in stable order`, async () => {
    const { accounts, signed, reads, plans } = await fixture(count);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await accounts.organizationPage(signed.principal.id, { limit: 100, cursor });
      expect(page.organizations.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(JSON.stringify(page.organizations)).length,
      ).toBeLessThanOrEqual(32_768);
      ids.push(...page.organizations.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(ids).toEqual(
      Array.from({ length: count }, (_, i) => `org_${String(i + 1).padStart(4, "0")}`),
    );
    expect(Math.max(...reads)).toBeLessThanOrEqual(101);
    expect(
      plans.some(
        (detail) =>
          detail.includes("org_memberships_principal") && detail.includes("principal_id=?"),
      ),
    ).toBe(true);
    expect(plans.some((detail) => /^SCAN (?:o|orgs)(?:\s|$)/u.test(detail))).toBe(false);
    // Complete success is never silently truncated, and overflow reads stay bounded.
    reads.length = 0;
    await expect(accounts.organizations(signed.principal.id)).rejects.toMatchObject({
      name: "OrganizationPaginationRequiredError",
      code: "invalid",
    });
    expect(Math.max(...reads)).toBeLessThanOrEqual(101);
  });
}

test("organization page cursors stay with their principal and an existing membership", async () => {
  const { accounts, signed, sql, reads } = await fixture(3);
  const first = await accounts.organizationPage(signed.principal.id, { limit: 1 });
  expect(first.nextCursor).toBeString();
  reads.length = 0;
  await expect(
    accounts.organizationPage("another-principal", {
      limit: 1,
      cursor: requiredCursor(first.nextCursor),
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(reads).toEqual([]);
  await expect(
    accounts.organizationPage(signed.principal.id, { limit: 1, cursor: "not-a-cursor" }),
  ).rejects.toMatchObject({ code: "invalid" });
  await sql.run("DELETE FROM org_memberships WHERE org_id = 'org_0001'");
  await expect(
    accounts.organizationPage(signed.principal.id, {
      limit: 1,
      cursor: requiredCursor(first.nextCursor),
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(
    (await accounts.organizationPage("another-principal", { limit: 1 })).organizations,
  ).toEqual([]);
});

test("page byte budget advances from the last returned row rather than dropping rows", async () => {
  const { accounts, signed } = await fixture(100, "組".repeat(128));
  const first = await accounts.organizationPage(signed.principal.id, { limit: 100 });
  expect(first.organizations.length).toBeGreaterThan(0);
  expect(first.organizations.length).toBeLessThan(100);
  expect(new TextEncoder().encode(JSON.stringify(first.organizations)).length).toBeLessThanOrEqual(
    32_768,
  );
  const second = await accounts.organizationPage(signed.principal.id, {
    limit: 100,
    cursor: requiredCursor(first.nextCursor),
  });
  expect([...first.organizations, ...second.organizations].map((o) => o.id)).toEqual(
    Array.from({ length: 100 }, (_, i) => `org_${String(i + 1).padStart(4, "0")}`),
  );
  expect(second.nextCursor).toBeNull();
});

test("the explicit /v1/me page mode is additive and keeps session authorization", async () => {
  const { accounts, signed, makeUnavailable } = await fixture(201);
  const control = createControlRoutes({
    publicOrigin: "https://api.example.test",
    clock: () => new Date(),
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
  });
  async function read(query: string, authenticated = true) {
    const request = new Request(`https://api.example.test/v1/me${query}`, {
      headers: authenticated ? { authorization: `Bearer ${signed.sessionToken}` } : {},
    });
    const response = await control(request, new URL(request.url));
    if (!response) throw new Error("test route not handled");
    return response;
  }
  const legacy = await read("");
  expect(legacy.status).toBe(400);
  const refusal = await legacy.json();
  expect(refusal.error.code).toBe("invalid_argument");
  expect(refusal.error.message).toContain("pagination");
  expect(refusal.organizations).toBeUndefined();
  const page = await read("?organizationPageSize=100");
  expect(page.status).toBe(200);
  const body = await page.json();
  expect(body.organizations).toHaveLength(100);
  expect(body.nextOrganizationCursor).toBeString();
  for (const query of [
    "?organizationPageSize=101",
    "?organizationPageSize=0",
    "?organizationPageSize=1&organizationPageSize=2",
    "?organizationCursor=missing-size",
  ]) {
    expect((await read(query)).status).toBe(400);
  }
  expect((await read("?organizationPageSize=100", false)).status).toBe(401);
  makeUnavailable();
  expect((await read("?organizationPageSize=100")).status).toBe(503);
});

test("an unavailable page query remains an error instead of an empty successful page", async () => {
  const sql = createEphemeralSql();
  const unavailable = new Error("local roster unavailable");
  const accounts = createAccounts({
    sql: {
      ...sql,
      async query() {
        throw unavailable;
      },
    },
    identity: {
      async verify() {
        throw new Error("unused");
      },
    },
  });
  await expect(accounts.organizationPage("owner", { limit: 100 })).rejects.toBe(unavailable);
});

function requiredCursor(cursor: string | null): string {
  if (cursor === null) throw new Error("expected a continuation page");
  return cursor;
}

test("a membership whose Organization was removed cannot silently end a bounded roster", async () => {
  const { accounts, signed, sql } = await fixture(3);
  await sql.run("DELETE FROM orgs WHERE id = 'org_0001'");
  // Existing schemas do not cascade membership rows. Treat the gap as
  // unavailable instead of telling the caller later Organizations do not exist.
  await expect(accounts.organizationPage(signed.principal.id, { limit: 1 })).rejects.toMatchObject({
    code: "unavailable",
  });
});

test("legacy complete rosters within budget keep oldest-first ordering and exact membership", async () => {
  const { accounts, signed, sql, reads } = await fixture(3);
  await sql.run("UPDATE orgs SET created_at = '2020-01-01T00:00:00Z' WHERE id = 'org_0003'");
  expect((await accounts.organizations(signed.principal.id)).map((org) => org.id)).toEqual([
    "org_0003",
    "org_0001",
    "org_0002",
  ]);
  expect(Math.max(...reads)).toBeLessThanOrEqual(101);
});

test("legacy roster byte overflow requires pagination instead of returning a partial array", async () => {
  const { accounts, signed } = await fixture(100, "組".repeat(128));
  await expect(accounts.organizations(signed.principal.id)).rejects.toMatchObject({
    name: "OrganizationPaginationRequiredError",
  });
});

test("oversized stored fields are refused before they are projected into application rows", async () => {
  const { accounts, signed, sql } = await fixture(1);
  await sql.run("UPDATE orgs SET created_at = ?", ["x".repeat(32769)]);
  const projected = await sql.query(
    `SELECT CASE WHEN length(CAST(created_at AS BLOB)) <= 32768 THEN created_at END AS created_at FROM orgs`,
  );
  expect(projected).toEqual([{ created_at: null }]);
  await expect(
    accounts.organizationPage(signed.principal.id, { limit: 100 }),
  ).rejects.toMatchObject({ code: "unavailable" });
});
