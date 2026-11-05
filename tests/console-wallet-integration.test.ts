import { expect, test } from "bun:test";
import { createApi } from "../console/src/api.ts";
import { createAccounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type BillingGrant, createStripeBillingStore } from "../src/stripe-billing-store.ts";
import { databaseAfter } from "./helpers/migrated-database.ts";

const NOW = "2026-10-14T00:00:00.000Z";

test("Console decodes frozen wallet fields from the real authorized control API", async () => {
  const database = databaseAfter(MIGRATIONS.map((migration) => migration.sql));
  const originalFetch = globalThis.fetch;
  try {
    const sql = createSqliteSql(database);
    const clock = () => new Date(NOW);
    let keySequence = 0;
    const accounts = createAccounts({
      sql,
      clock,
      randomSecret: () => `local_console_wallet_key_${keySequence++}`,
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
    const session = await accounts.signIn({ provider: "google", assertion: "owner" });
    const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
    if (!actor) throw new Error("owner fixture failed to authenticate");
    const organization = await accounts.createOrganization({ actor, name: "Wallet Org" });
    const otherOrganization = await accounts.createOrganization({ actor, name: "Other Org" });
    const key = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "wallet reader",
      scopes: ["wallet:read"],
      expiresInSeconds: 3600,
    });
    const ledger = createLedger(sql, clock);
    const stripe = createStripeBillingStore({ sql, clock });
    const grant: BillingGrant = {
      organizationId: organization.id,
      fundingRef: "stripe:cs_console_frozen",
      kind: "purchased",
      amountMicros: 100,
      expiresAt: "2026-11-14T00:00:00.000Z",
      sourceType: "checkout",
      sourceId: "cs_console_frozen",
      chargeId: "ch_console_frozen",
      customerId: "cus_console_frozen",
      subscriptionId: null,
      planKey: null,
      pricingRevision: null,
      stripePriceId: null,
      periodStart: null,
      periodEnd: null,
      considerationMicros: 100,
    };
    await stripe.grant(grant);
    expect(
      await ledger.debitUsage({
        organizationId: organization.id,
        reference: "console-wallet-usage",
        amountMicros: 60,
      }),
    ).toBe(true);
    const unrelatedCredit = {
      ...grant,
      fundingRef: "stripe:cs_console_unrelated",
      amountMicros: 50,
      sourceId: "cs_console_unrelated",
      chargeId: "ch_console_unrelated",
      customerId: "cus_console_unrelated",
      considerationMicros: 50,
    };
    await stripe.grant(unrelatedCredit);
    const fenceGeneration = await stripe.freezeFunding(organization.id, grant.fundingRef);

    const routes = createControlRoutes({
      publicOrigin: "https://api.example.test",
      accounts,
      inventory: {} as never,
      deployments: {} as never,
      attachments: {} as never,
      migrations: {} as never,
      forms: [],
      identityProviders: [],
      ledger,
      catalog: {} as never,
      reseller: {} as never,
      tokens: {} as never,
      settlement: {
        async verify() {
          throw new Error("settlement must not run");
        },
      },
      clock,
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const response = await routes(request, url);
        return response ?? new Response(null, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const api = createApi({
      origin: "https://api.example.test",
      token: () => key.secret,
      onSessionLost: () => {},
    });

    const result = await api.wallet(organization.id);
    expect(result.wallet).toMatchObject({
      organizationId: organization.id,
      currency: "USD",
      settledMicros: "90",
      heldMicros: "0",
      frozenMicros: "40",
      availableMicros: "50",
      refundReceivableMicros: "0",
    });
    expect(
      await stripe.refund({
        refundId: "re_console_frozen",
        grant,
        amountMicros: 100,
        cumulativeRefundedMicros: 100,
        fenceGeneration,
      }),
    ).toMatchObject({ debitMicros: 40, receivableMicros: 60 });
    expect(await api.wallet(organization.id)).toMatchObject({
      wallet: {
        settledMicros: "50",
        heldMicros: "0",
        availableMicros: "50",
        frozenMicros: "0",
        refundReceivableMicros: "60",
      },
    });
    await expect(api.wallet(otherOrganization.id)).rejects.toMatchObject({
      code: "permission_denied",
    });
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
