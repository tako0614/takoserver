import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { claimFreshStripeModeRealm } from "../src/stripe-mode-realm.ts";

const NOW = "2026-10-15T00:00:00.000Z";
const POLICY = `INSERT INTO org_wallet_limit_policies
  VALUES ('org_fixture','prepaid',1,'prepaid-usage-v1',NULL,'fixture-owner','${NOW}')`;

function sourceDatabase() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  return db;
}

test("an absent mode pin cannot classify new billing policy, command, attribution or account history", async () => {
  for (const seed of [
    POLICY,
    `INSERT INTO stripe_billing_customer_commands
      (org_id,realm_json,request_json,fingerprint,stripe_key,state,created_at)
      VALUES ('org_fixture','{}','{}','fingerprint','key','prepared','${NOW}')`,
    `INSERT INTO org_wallet_workspace_bindings VALUES ('workspace_fixture','org_fixture','${NOW}')`,
    `INSERT INTO stripe_billing_account_realms VALUES (1,'acct_testFixture','test','hosted:fixture','${NOW}')`,
  ]) {
    const db = sourceDatabase();
    try {
      db.exec(seed);
      const sql = createSqliteSql(db);
      for (const mode of ["test", "live"] as const)
        await expect(claimFreshStripeModeRealm(sql, mode)).rejects.toMatchObject({
          code: "legacy_history",
        });
      expect(await sql.query("SELECT mode FROM stripe_mode_realm")).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  }
});

test("future financial tables are discovered regardless of case and history stays untouched", async () => {
  const db = sourceDatabase();
  try {
    db.exec(
      "CREATE TABLE Stripe_Future_Receipts (id TEXT PRIMARY KEY); INSERT INTO Stripe_Future_Receipts VALUES ('original')",
    );
    await expect(claimFreshStripeModeRealm(createSqliteSql(db), "test")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(db.query("SELECT * FROM Stripe_Future_Receipts").all()).toEqual([{ id: "original" }]);
    expect(db.query("SELECT * FROM stripe_mode_realm").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("fresh claim repeats the exact discovered inventory in its guarded INSERT", async () => {
  const db = sourceDatabase();
  try {
    const base = createSqliteSql(db);
    let changed = false;
    const racing: Sql = {
      query: base.query,
      batch: base.batch,
      async run(sql, params) {
        if (!changed && sql.startsWith("INSERT INTO stripe_mode_realm")) {
          changed = true;
          db.exec(
            "CREATE TABLE stripe_future_delivery (id TEXT PRIMARY KEY); INSERT INTO stripe_future_delivery VALUES ('arrived')",
          );
        }
        expect(params?.length ?? 0).toBeLessThanOrEqual(2);
        return await base.run(sql, params);
      },
    };
    await expect(claimFreshStripeModeRealm(racing, "live")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(changed).toBe(true);
    expect(db.query("SELECT * FROM stripe_mode_realm").all()).toEqual([]);
    expect(db.query("SELECT * FROM stripe_future_delivery").all()).toEqual([{ id: "arrived" }]);
  } finally {
    db.close();
  }
});

test("Bun refuses unknown future financial history before applying a pending 0096-0099 suffix", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE applied_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter(({ name }) => name <= "0095_stripe_billing.sql")) {
      db.exec(migration.sql);
      db.query("INSERT INTO applied_migrations VALUES (?, ?)").run(migration.name, NOW);
    }
    db.exec(
      "CREATE TABLE org_wallet_future_receipts (id TEXT PRIMARY KEY); INSERT INTO org_wallet_future_receipts VALUES ('unclassified')",
    );
    const before = db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    for (const mode of ["test", "live"] as const)
      expect(() => migrateSqlite(db, { stripeMode: mode })).toThrow(
        "existing wallet, money, or Stripe history has no realm",
      );
    expect(db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(
      before,
    );
    expect(db.query("SELECT COUNT(*) AS n FROM applied_migrations").get()).toEqual({ n: 95 });
    expect(db.query("SELECT * FROM org_wallet_future_receipts").all()).toEqual([
      { id: "unclassified" },
    ]);
  } finally {
    db.close();
  }
});

test("empty 0095 advances atomically to the current suffix without auto-binding an account", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE applied_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter(({ name }) => name <= "0095_stripe_billing.sql")) {
      db.exec(migration.sql);
      db.query("INSERT INTO applied_migrations VALUES (?, ?)").run(migration.name, NOW);
    }
    const report = migrateSqlite(db, { stripeMode: "test" });
    expect(report.applied).toEqual(MIGRATIONS.slice(95).map(({ name }) => name));
    expect(db.query("SELECT mode FROM stripe_mode_realm").get()).toEqual({ mode: "test" });
    expect(db.query("SELECT * FROM stripe_billing_account_realms").all()).toEqual([]);
    db.exec(POLICY);
    expect(migrateSqlite(db, { stripeMode: "test" })).toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.length,
    });
    expect(() => migrateSqlite(db, { stripeMode: "live" })).toThrow("not pinned to 'live'");
    expect(db.query("SELECT on_limit FROM org_wallet_limit_policies").get()).toEqual({
      on_limit: "prepaid",
    });
  } finally {
    db.close();
  }
});

test("native D1 refuses 0099 and future history, while a truly fresh mode claim stays valid", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "stripe-mode-future-history",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('mode fixture'); } };",
              },
            },
          },
          env: {
            STATE_DB: { type: "d1", id: "stripe-mode-future-history" },
            FRESH_DB: { type: "d1", id: "stripe-mode-fresh-history" },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    const fresh = await runtime.getD1Database("FRESH_DB");
    for (const migration of MIGRATIONS)
      for (const target of [database, fresh])
        await target.batch(
          splitMigration(migration.sql).map((statement) => target.prepare(statement)),
        );
    const freshSql = createD1Sql(fresh);
    await claimFreshStripeModeRealm(freshSql, "test");
    expect(await freshSql.query("SELECT mode FROM stripe_mode_realm")).toEqual([{ mode: "test" }]);
    expect(await freshSql.query("SELECT * FROM stripe_billing_account_realms")).toEqual([]);
    const sql = createD1Sql(database);
    await sql.run(POLICY);
    await expect(claimFreshStripeModeRealm(sql, "live")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(await sql.query("SELECT mode FROM stripe_mode_realm")).toEqual([]);
    await sql.run("CREATE TABLE Stripe_Future_Receipts (id TEXT PRIMARY KEY)");
    await sql.run("INSERT INTO Stripe_Future_Receipts VALUES ('unclassified')");
    // An existing known history fact also remains preserved through refusal.
    expect(await sql.query("SELECT on_limit FROM org_wallet_limit_policies")).toEqual([
      { on_limit: "prepaid" },
    ]);
    await expect(claimFreshStripeModeRealm(sql, "test")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(await sql.query("SELECT * FROM Stripe_Future_Receipts")).toEqual([
      { id: "unclassified" },
    ]);
  } finally {
    await runtime.dispose();
  }
}, 60_000);

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    if (/^CREATE\s+TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary));
      rest = rest.slice(boundary).trim();
    } else {
      const boundary = rest.indexOf(";");
      if (boundary < 0) {
        statements.push(rest);
        break;
      }
      statements.push(rest.slice(0, boundary));
      rest = rest.slice(boundary + 1).trim();
    }
  }
  return statements.filter((statement) => statement.trim().length > 0);
}
