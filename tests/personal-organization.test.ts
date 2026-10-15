import { describe, expect, test } from "bun:test";
import {
  type Accounts,
  createAccounts,
  type ExternalIdentityVerifier,
  PersonalOrganizationError,
} from "../src/auth.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { type Sql, SqlError } from "../src/ports.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const identity: ExternalIdentityVerifier = {
  async verify({ provider, assertion }) {
    return {
      providerSubject: `${provider}:${assertion}`,
      email: "shared-email@example.test",
      displayName: assertion,
    };
  },
};

function accountsFor(sql: Sql) {
  return createAccounts({ sql, identity, clock: () => NOW });
}

async function session(
  accounts: Accounts,
  assertion = "Personal Owner",
  provider = "google" as const,
) {
  const signedIn = await accounts.signIn({ provider, assertion });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("fixture session did not authenticate");
  return { ...signedIn, actor };
}

async function count(sql: Sql, table: string): Promise<number> {
  return Number((await sql.query(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
}

async function tupleCounts(sql: Sql) {
  return {
    organizations: await count(sql, "orgs"),
    memberships: await count(sql, "org_memberships"),
    mappings: await count(sql, "personal_organizations"),
  };
}

describe("personal Organization durability", () => {
  test("creates the owner tuple from a local session without card, Stripe, or direct credit", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const result = await accounts.createPersonalOrganization({ actor: owner.actor });

    expect(result.created).toBe(true);
    expect(result.organization).toMatchObject({
      name: owner.principal.displayName,
      ownerPrincipalId: owner.principal.id,
      createdAt: NOW.toISOString(),
    });
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
    expect(await sql.query("SELECT * FROM personal_organizations")).toEqual([
      {
        principal_id: owner.principal.id,
        org_id: result.organization.id,
        created_at: NOW.toISOString(),
      },
    ]);
    expect(await accounts.requireOwner(owner.actor, result.organization.id)).toEqual(
      result.organization,
    );
    for (const table of [
      "ledger",
      "wallet_credit_lots",
      "org_wallet_grant_snapshots",
      "stripe_billing_customers",
      "stripe_billing_subscriptions",
      "stripe_billing_grants",
    ]) {
      expect(await count(sql, table)).toBe(0);
    }
  });

  test("replays after restart and later generic Org creation without changing either identity", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const first = await accounts.createPersonalOrganization({ actor: owner.actor });
    const generic = await accounts.createOrganization({ actor: owner.actor, name: "Company" });
    const restarted = accountsFor(sql);

    expect(await restarted.createPersonalOrganization({ actor: owner.actor })).toEqual({
      organization: first.organization,
      created: false,
    });
    expect(await restarted.organization(generic.id)).toEqual(generic);
    expect(await tupleCounts(sql)).toEqual({ organizations: 2, memberships: 2, mappings: 1 });
  });

  test("uses principal identity rather than shared email", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const first = await session(accounts, "First owner");
    const second = await session(accounts, "Second owner");
    expect(first.principal.email).toBe(second.principal.email);
    const a = await accounts.createPersonalOrganization({ actor: first.actor });
    const b = await accounts.createPersonalOrganization({ actor: second.actor });
    expect(a.organization.id).not.toBe(b.organization.id);
    expect(await tupleCounts(sql)).toEqual({ organizations: 2, memberships: 2, mappings: 2 });
  });

  test("elects exactly one creator across independent Accounts instances using real atomic batches", async () => {
    const sql = createEphemeralSql();
    const owner = await session(accountsFor(sql));
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        accountsFor(sql).createPersonalOrganization({ actor: owner.actor }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.organization.id)).size).toBe(1);
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
  });

  test("rolls back a stale creator's candidate after another batch commits", async () => {
    const sql = createEphemeralSql();
    const owner = await session(accountsFor(sql));
    let reached!: () => void;
    let release!: () => void;
    const atBatch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: Sql = {
      query: (query, params) => sql.query(query, params),
      run: (query, params) => sql.run(query, params),
      async batch(statements) {
        reached();
        await resume;
        return sql.batch(statements);
      },
    };
    const losing = accountsFor(delayed).createPersonalOrganization({ actor: owner.actor });
    await atBatch;
    const winner = await accountsFor(sql).createPersonalOrganization({ actor: owner.actor });
    release();
    expect(await losing).toEqual({ organization: winner.organization, created: false });
    expect(winner.created).toBe(true);
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
  });

  test("retains the committed mapping after a lost acknowledgement and retry", async () => {
    const sql = createEphemeralSql();
    const owner = await session(accountsFor(sql));
    const lostAck: Sql = {
      query: (query, params) => sql.query(query, params),
      run: (query, params) => sql.run(query, params),
      async batch(statements) {
        await sql.batch(statements);
        throw new SqlError("unavailable", "simulated lost acknowledgement");
      },
    };
    await expect(
      accountsFor(lostAck).createPersonalOrganization({ actor: owner.actor }),
    ).rejects.toBeInstanceOf(PersonalOrganizationError);
    const existing = (await accountsFor(sql).organizations(owner.principal.id))[0];
    expect(existing).toBeDefined();
    if (!existing) throw new Error("committed personal Organization was not found");
    expect(await accountsFor(sql).createPersonalOrganization({ actor: owner.actor })).toEqual({
      organization: existing,
      created: false,
    });
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
  });

  test("a rejected mapping write rolls back the Org and membership", async () => {
    const sql = createEphemeralSql();
    const owner = await session(accountsFor(sql));
    const rejected: Sql = {
      query: (query, params) => sql.query(query, params),
      run: (query, params) => sql.run(query, params),
      batch: (statements) =>
        sql.batch(
          statements.map((statement, index) =>
            index === 2
              ? {
                  ...statement,
                  params: [null, statement.params?.[1] ?? null, statement.params?.[2] ?? null],
                }
              : statement,
          ),
        ),
    };
    await expect(
      accountsFor(rejected).createPersonalOrganization({ actor: owner.actor }),
    ).rejects.toBeInstanceOf(PersonalOrganizationError);
    expect(await tupleCounts(sql)).toEqual({ organizations: 0, memberships: 0, mappings: 0 });
  });

  test("keeps a committed tuple if authoritative readback is temporarily unavailable", async () => {
    const sql = createEphemeralSql();
    const owner = await session(accountsFor(sql));
    let committed = false;
    const lostReadback: Sql = {
      async query(query, params) {
        if (committed && query.includes("LEFT JOIN personal_organizations")) {
          throw new SqlError("unavailable", "simulated readback outage");
        }
        return sql.query(query, params);
      },
      run: (query, params) => sql.run(query, params),
      async batch(statements) {
        const result = await sql.batch(statements);
        committed = true;
        return result;
      },
    };
    await expect(
      accountsFor(lostReadback).createPersonalOrganization({ actor: owner.actor }),
    ).rejects.toBeInstanceOf(PersonalOrganizationError);
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
    expect(
      (await accountsFor(sql).createPersonalOrganization({ actor: owner.actor })).created,
    ).toBe(false);
  });

  test("refuses changed ownership or missing owner membership without replacing the mapping", async () => {
    for (const drift of ["owner", "membership", "foreign-owner"] as const) {
      const sql = createEphemeralSql();
      const accounts = accountsFor(sql);
      const owner = await session(accounts);
      const foreign = await session(accounts, "Foreign owner");
      const personal = await accounts.createPersonalOrganization({ actor: owner.actor });
      if (drift === "owner") {
        await sql.run("UPDATE orgs SET owner_principal_id = ? WHERE id = ?", [
          foreign.principal.id,
          personal.organization.id,
        ]);
      } else if (drift === "membership") {
        await sql.run("DELETE FROM org_memberships WHERE org_id = ? AND principal_id = ?", [
          personal.organization.id,
          owner.principal.id,
        ]);
      } else {
        await sql.run(
          "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          [personal.organization.id, foreign.principal.id, NOW.toISOString()],
        );
      }
      await expect(
        accounts.createPersonalOrganization({ actor: owner.actor }),
      ).rejects.toBeInstanceOf(PersonalOrganizationError);
      expect(await count(sql, "orgs")).toBe(1);
      expect(await count(sql, "personal_organizations")).toBe(1);
    }
  });

  test("retains the mapping permanently and refuses deletion of its principal or Org", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const personal = await accounts.createPersonalOrganization({ actor: owner.actor });
    for (const [query, params] of [
      ["DELETE FROM personal_organizations WHERE principal_id = ?", [owner.principal.id]],
      [
        "UPDATE personal_organizations SET org_id = ? WHERE principal_id = ?",
        ["org_replacement", owner.principal.id],
      ],
      ["DELETE FROM principals WHERE id = ?", [owner.principal.id]],
      ["DELETE FROM orgs WHERE id = ?", [personal.organization.id]],
    ] as const) {
      await expect(sql.run(query, params)).rejects.toBeInstanceOf(SqlError);
    }
    expect(await accounts.createPersonalOrganization({ actor: owner.actor })).toEqual({
      organization: personal.organization,
      created: false,
    });
  });

  test("does not guess or mint a second free Org for unmapped generic ownership", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const generic = await accounts.createOrganization({ actor: owner.actor, name: "Initial Org" });
    const ledger = createLedger(sql, () => NOW);
    await ledger.fund({
      organizationId: generic.id,
      fundingRef: "existing-purchase",
      amountMicros: 25,
      kind: "purchased",
      consumptionClass: "purchased",
    });
    const before = await ledger.wallet(generic.id);
    await expect(accounts.createPersonalOrganization({ actor: owner.actor })).rejects.toMatchObject(
      {
        code: "personal_organization_unavailable",
        status: 503,
      },
    );
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 0 });
    expect(await ledger.wallet(generic.id)).toEqual(before);
  });

  test("refuses orphan owner evidence rather than silently replacing the missing Org", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    await sql.run(
      "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      ["org_missing_historical", owner.principal.id, NOW.toISOString()],
    );
    await expect(
      accounts.createPersonalOrganization({ actor: owner.actor }),
    ).rejects.toBeInstanceOf(PersonalOrganizationError);
    expect(await tupleCounts(sql)).toEqual({ organizations: 0, memberships: 1, mappings: 0 });
  });

  test("rechecks historical ownership in the batch if a generic creation wins the race", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    let reached!: () => void;
    let release!: () => void;
    const atBatch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: Sql = {
      query: (query, params) => sql.query(query, params),
      run: (query, params) => sql.run(query, params),
      async batch(statements) {
        reached();
        await resume;
        return sql.batch(statements);
      },
    };
    const personal = accountsFor(delayed).createPersonalOrganization({ actor: owner.actor });
    const outcome = personal.then(
      (result) => result,
      (error: unknown) => error,
    );
    await atBatch;
    const generic = await accounts.createOrganization({
      actor: owner.actor,
      name: "Concurrent Org",
    });
    release();
    expect(await outcome).toBeInstanceOf(PersonalOrganizationError);
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 0 });
    expect(await accounts.organization(generic.id)).toEqual(generic);
  });

  test("free allowance remains once per mapped Org when billing first accesses the wallet", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const first = await accounts.createPersonalOrganization({ actor: owner.actor });
    const config = parseBillingConfig(
      JSON.stringify({
        schemaVersion: 1,
        revision: "personal-free-test",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        currency: "USD",
        holdTtlSeconds: 60,
        freeIncludedMinor: 150,
        purchaseCreditExpiry: { kind: "none" },
        plans: {},
        meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
      }),
    );
    if (!config) throw new Error("fixture billing config missing");
    const billing = createOrgBilling({
      sql,
      clock: () => NOW,
      ledger: createLedger(sql, () => NOW),
      config,
    });
    expect((await billing.wallet(first.organization.id)).settledMicros).toBe(1_500_000);
    const replay = await accountsFor(sql).createPersonalOrganization({ actor: owner.actor });
    expect((await billing.wallet(replay.organization.id)).settledMicros).toBe(1_500_000);
    expect(await count(sql, "org_wallet_grant_snapshots")).toBe(1);
    expect(await count(sql, "wallet_credit_lots")).toBe(1);
    expect(await count(sql, "ledger")).toBe(1);
  });
});

describe("personal Organization authority", () => {
  test("rejects an API key even when it belongs to the mapped owner", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const owner = await session(accounts);
    const personal = await accounts.createPersonalOrganization({ actor: owner.actor });
    const key = await accounts.createApiKey({
      actor: owner.actor,
      organizationId: personal.organization.id,
      name: "Billing key",
      scopes: ["wallet:write", "payments:write"],
      expiresInSeconds: 3_600,
    });
    const actor = await accounts.authenticate(`Bearer ${key.secret}`);
    if (!actor) throw new Error("fixture key did not authenticate");
    await expect(accounts.createPersonalOrganization({ actor })).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await tupleCounts(sql)).toEqual({ organizations: 1, memberships: 1, mappings: 1 });
  });

  test("preserves Takos ID Organization authority without creating a local personal Org", async () => {
    const sql = createEphemeralSql();
    const accounts = accountsFor(sql);
    const signedIn = await accounts.signIn({ provider: "takos-id", assertion: "legal-owner" });
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("fixture Takos ID session did not authenticate");
    await expect(accounts.createPersonalOrganization({ actor })).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await tupleCounts(sql)).toEqual({ organizations: 0, memberships: 0, mappings: 0 });
  });
});
