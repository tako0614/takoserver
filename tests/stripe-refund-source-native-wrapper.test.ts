import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createLedger, LedgerError, stripeRefundSource } from "../src/ledger.ts";
import { createFreshNativeSql, createMoneyCutoverSql } from "../src/money-cutover-sql.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import type { Sql } from "../src/ports.ts";
import { createHostedBillingRealmTestDatabase } from "./helpers/hosted-billing-realm-fixture.ts";

const ORG = "refund_source_wrapper_org";
const WRITER = `sha256:${"a".repeat(64)}`;
const CONFIG = parseBillingConfig(
  JSON.stringify({
    schemaVersion: 1,
    revision: "refund-wrapper-r1",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 60,
    freeIncludedMinor: 0,
    purchaseCreditExpiry: { kind: "none" },
    plans: {},
    meters: {},
  }),
);
if (!CONFIG) throw new Error("test billing config missing");

async function ordinary0105() {
  const fixture = await createHostedBillingRealmTestDatabase({ mode: null });
  const source = readFinancial0104CanonicalMigrationSource(process.cwd());
  try {
    fixture.db.exec(
      "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    for (const file of source.artifact105.files.slice(0, 99))
      fixture.db.query("INSERT INTO d1_migrations(name) VALUES (?)").run(file.name);
    for (const file of source.artifact105.files.slice(99)) {
      fixture.db.exec(readFileSync(file.path, "utf8"));
      fixture.db.query("INSERT INTO d1_migrations(name) VALUES (?)").run(file.name);
    }
    return fixture;
  } catch (error) {
    fixture.db.close();
    throw error;
  } finally {
    source.dispose();
  }
}

test("stripeRefundSource reads ordinary 0105 through both actual native SQL wrappers", async () => {
  const wrappers: readonly ((sql: Sql) => Sql)[] = [
    createFreshNativeSql,
    (sql) => createMoneyCutoverSql(sql, WRITER),
  ];
  for (const wrap of wrappers) {
    const fixture = await ordinary0105();
    try {
      expect(await stripeRefundSource(wrap(fixture.sql))).toBe(
        "stripe_billing_refund_receipts_all",
      );
    } finally {
      fixture.db.close();
    }
  }
});

test("Org billing summary and workspace reads retain source success and composite-FK refusal", async () => {
  const fixture = await ordinary0105();
  try {
    const sql = createFreshNativeSql(fixture.sql);
    const clock = () => new Date("2026-10-15T00:00:00.000Z");
    const billing = createOrgBilling({
      sql,
      clock,
      ledger: createLedger(sql, clock),
      config: CONFIG,
    });
    expect((await billing.usageSummary(ORG)).organizationId).toBe(ORG);

    const moneySql = createMoneyCutoverSql(fixture.sql, WRITER);
    // Invalid cursor proves the workspace service passed refund-source qualification;
    // it is not a successful workspace-page assertion.
    await expect(
      createOrgBilling({
        sql: moneySql,
        clock,
        ledger: createLedger(moneySql, clock),
        config: CONFIG,
      }).workspaceUsage(ORG, { cursor: "invalid" }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });

    fixture.db.exec("PRAGMA foreign_keys = OFF");
    fixture.db.exec(
      "CREATE TEMP TABLE refund_rows_without_fk AS SELECT * FROM stripe_billing_on_demand_refunds WHERE 0",
    );
    fixture.db.exec("DROP TABLE stripe_billing_on_demand_refunds");
    fixture.db.exec(
      "CREATE TABLE stripe_billing_on_demand_refunds AS SELECT * FROM refund_rows_without_fk",
    );
    fixture.db.exec("DROP TABLE refund_rows_without_fk");
    await expect(stripeRefundSource(moneySql)).rejects.toBeInstanceOf(LedgerError);
    await expect(
      createOrgBilling({
        sql: moneySql,
        clock,
        ledger: createLedger(moneySql, clock),
        config: CONFIG,
      }).workspaceUsage(ORG, { cursor: "invalid" }),
    ).rejects.toMatchObject({ name: "OrgBillingError", code: "billing_unavailable", status: 503 });
  } finally {
    fixture.db.close();
  }
});
