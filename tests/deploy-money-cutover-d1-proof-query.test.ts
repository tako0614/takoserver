import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  readMoneyAggregateDigest,
  readMoneyPreimageDigest,
} from "../scripts/deploy/schema-money-unit-cutover.ts";

test("money proofs retain the exact SQLite digest within D1 compound SELECT limits", async () => {
  const setup = [
    "CREATE TABLE ledger (id TEXT, org_id TEXT, settled_delta INTEGER, held_delta INTEGER)",
    "CREATE TABLE wallet_credit_lots (org_id TEXT, ref TEXT, amount_minor INTEGER)",
    "CREATE TABLE wallet_credit_allocations (org_id TEXT, debit_type TEXT, debit_ref TEXT, lot_ref TEXT, amount_minor INTEGER)",
    "CREATE TABLE org_wallet_holds (org_id TEXT, ref TEXT, amount_minor INTEGER, captured_minor INTEGER, released_minor INTEGER)",
    "CREATE TABLE org_wallet_usage_records (org_id TEXT, ref TEXT, amount_minor INTEGER)",
    "CREATE TABLE org_wallet_grant_snapshots (org_id TEXT, ref TEXT, amount_minor INTEGER)",
    "CREATE TABLE org_wallet_monthly_tariffs (month TEXT, amount_minor INTEGER)",
    "INSERT INTO ledger VALUES ('b', 'org_b', 900719925473, -25), ('a', 'org_a', -100, 0)",
    "INSERT INTO wallet_credit_lots VALUES ('org_b', 'lot', 900719925473)",
    "INSERT INTO wallet_credit_allocations VALUES ('org_b', 'usage', 'debit', 'lot', 25)",
    "INSERT INTO org_wallet_holds VALUES ('org_b', 'hold', 50, 25, 0)",
    "INSERT INTO org_wallet_usage_records VALUES ('org_b', 'usage', 25)",
    "INSERT INTO org_wallet_grant_snapshots VALUES ('org_b', 'grant', 10)",
    "INSERT INTO org_wallet_monthly_tariffs VALUES ('2026-10', 15)",
  ];
  const sqlite = new Database(":memory:");
  sqlite.exec(`${setup.join(";\n")};`);
  const local = {
    async query(_phase: unknown, _description: unknown, sql: string) {
      return sqlite.query(sql).all() as Record<string, unknown>[];
    },
  };
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "money-proof-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: "export default {};" } },
          },
          env: { STATE_DB: { type: "d1", id: "money-proof-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const expectedPreimage = await readMoneyPreimageDigest(local, "preflight");
    const expectedAggregate = await readMoneyAggregateDigest(local, "preflight");
    const d1 = await runtime.getD1Database("STATE_DB");
    await d1.batch(setup.map((sql) => d1.prepare(sql)));
    let queries = 0;
    const native = {
      async query(_phase: unknown, _description: unknown, sql: string) {
        queries += 1;
        return (await d1.prepare(sql).all()).results as Record<string, unknown>[];
      },
    };
    expect(await readMoneyPreimageDigest(native, "preflight")).toBe(expectedPreimage);
    expect(await readMoneyAggregateDigest(native, "preflight")).toBe(expectedAggregate);
    expect(queries).toBe(2);
  } finally {
    sqlite.close();
    await runtime.dispose();
  }
}, 60_000);
