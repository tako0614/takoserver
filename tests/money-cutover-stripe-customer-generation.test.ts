// Money cutover guard Stripe customer generation: exact fence shape, install on
// a guarded 0104 state, and the Financial Customer batch only inside the writer.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-canonical-recipes.ts";
import { moneyFenceTriggerName } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { ROOT_MONEY_GUARD_STRIPE_TABLES } from "../src/financial-0104-money-fence.ts";
import { FINANCIAL_0104_DDL } from "../src/financial-0104-source-contract.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES,
  moneyCutoverFinancialTriggerSql,
  moneyCutoverStripeCustomerGuardDefinitions,
  moneyCutoverStripeCustomerTriggerSql,
} from "../src/money-cutover-sql.ts";
import { prepareCustomerAdmissionBatch } from "../src/shared-financial-admission.ts";
import { fixture as customerFixture } from "./fixtures/financial-customer-five-action-fixture.ts";
import { MONEY_FREEZE_ROW } from "./helpers/financial-0104-fenced.ts";

const ROOT = resolve(import.meta.dir, "..");
const stripeInstallSql = () =>
  moneyCutoverStripeCustomerGuardDefinitions()
    .map(([, sql]) => `${sql};`)
    .join("\n");
const EPOCH = `sha256:${"c".repeat(64)}`;
const VERBS = ["INSERT", "UPDATE", "DELETE"] as const;
const ROWS = [
  "stripe_billing_customer_commands",
  "stripe_customer_admission_links",
  "financial_customer_admissions",
  "financial_customer_admission_receipts",
  "money_cutover_writer_permit",
] as const;

function at0104(): Database {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
    db.exec(migration.sql);
  for (const file of createAuth103CanonicalSourceArtifacts(ROOT).files) db.exec(file.sql);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  db.exec(FINANCIAL_0104_DDL);
  return db;
}

describe("Money cutover guard Stripe customer generation", () => {
  test("is exactly the 0092 fence shape on the three Customer Stripe tables", () => {
    expect([...MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES].sort()).toEqual(
      [...ROOT_MONEY_GUARD_STRIPE_TABLES].sort(),
    );
    expect(moneyCutoverStripeCustomerGuardDefinitions()).toEqual(
      MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES.flatMap((table) =>
        VERBS.map((verb) => [
          moneyFenceTriggerName(table, verb),
          moneyCutoverStripeCustomerTriggerSql(table, verb),
        ]),
      ),
    );
    // The same fence shape as the 0092 set, only the table differs.
    expect(moneyCutoverStripeCustomerTriggerSql("stripe_billing_customers", "INSERT")).toBe(
      moneyCutoverFinancialTriggerSql("ledger", "INSERT").replaceAll(
        "ledger",
        "stripe_billing_customers",
      ),
    );
    // The 0092 set stays exactly as it was: no Stripe table joins it.
    expect(() => moneyCutoverFinancialTriggerSql("stripe_billing_customers", "INSERT")).toThrow(
      "unknown money cutover financial table",
    );
    expect(() => moneyCutoverStripeCustomerTriggerSql("ledger", "INSERT")).toThrow(
      "unknown money cutover Stripe customer table",
    );
  });

  test("installs through the cutover path on the 0104 state and each fence refuses outside the frame", () => {
    const db = at0104();
    try {
      db.exec(stripeInstallSql());
      for (const [name, sql] of moneyCutoverStripeCustomerGuardDefinitions())
        expect(db.query("SELECT sql FROM sqlite_schema WHERE name=?").get(name)).toEqual({ sql });
      db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(EPOCH);
      db.exec("PRAGMA foreign_keys=OFF");
      const insert = () =>
        db.exec(
          "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES('org:g','cus_G','2026-10-15T00:00:00.000Z')",
        );
      expect(insert).toThrow(/money cutover writer permit required/u);
      db.query("INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)").run(EPOCH);
      db.exec(MONEY_FREEZE_ROW);
      expect(insert).toThrow(/money cutover writer permit required/u);
      db.exec("DELETE FROM money_cutover_freeze");
      expect(insert).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("the Customer admission batch commits its Stripe rows only inside the Money writer", async () => {
    const f = await customerFixture();
    try {
      f.db.exec(stripeInstallSql());
      const batch = prepareCustomerAdmissionBatch(f.admission);
      const counts = () =>
        ROWS.map(
          (table) => (f.db.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n,
        );
      await expect(
        f.sql.run(
          "INSERT INTO stripe_billing_customer_commands(org_id,realm_json,request_json,fingerprint,stripe_key,state,created_at) VALUES('org:x','{}','{}','f','k','prepared','2026-10-15T00:00:00.000Z')",
        ),
      ).rejects.toThrow(/money cutover writer permit required/u);
      f.db.exec(MONEY_FREEZE_ROW);
      await expect(f.money.batch(batch)).rejects.toThrow(/constraint: |permit required/u);
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      f.db.exec("DELETE FROM money_cutover_freeze");
      await expect(f.sql.batch(batch)).rejects.toThrow(/constraint: |permit required/u);
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      const epoch = (
        f.db.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get() as {
          writer_epoch: string;
        }
      ).writer_epoch;
      expect(
        (await createMoneyCutoverSql(f.sql, epoch).batch(batch)).map((x) => x.changes),
      ).toEqual([1, 1, 1, 1]);
      expect(counts()).toEqual([1, 1, 1, 1, 0]);
    } finally {
      f.close();
    }
  });
});
