import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import { type MigratableDatabase, migrateSqlite } from "../src/migrate-sqlite.ts";
import type { StripeMode } from "../src/stripe-mode-realm.ts";

function oldThrough(db: Database, count: number): void {
  db.exec(
    "CREATE TABLE applied_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, count)) {
    db.exec(migration.sql);
    db.query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)").run(
      migration.name,
      "2026-10-14T00:00:00.000Z",
    );
  }
}

const old97 = (db: Database) => oldThrough(db, 97);

function snapshot(db: Database) {
  return {
    schema: db
      .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
    applied: db.query("SELECT name, applied_at FROM applied_migrations ORDER BY rowid").all(),
  };
}

test("old 97 Stripe history refuses either realm before 98 changes schema or ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "stripe-mode-old97-"));
  const path = join(root, "control.sqlite");
  try {
    const db = new Database(path);
    old97(db);
    db.exec(`INSERT INTO stripe_events
      (event_id, type, livemode, object_id, event_created_at, received_at, outcome, settled_at)
      VALUES ('evt_old', 'invoice.paid', 0, 'in_old', '2026-10-14T00:00:00.000Z',
      '2026-10-14T00:00:00.000Z', 'ignored', '2026-10-14T00:00:00.000Z')`);
    const before = snapshot(db);
    for (const stripeMode of ["test", "live"] as const) {
      expect(() => migrateSqlite(db, { stripeMode })).toThrow(
        "existing wallet, money, or Stripe history has no realm",
      );
      expect(snapshot(db)).toEqual(before);
      expect(db.query("SELECT event_id FROM stripe_events").all()).toEqual([
        { event_id: "evt_old" },
      ]);
    }
    db.close();
    const reopened = new Database(path);
    expect(snapshot(reopened)).toEqual(before);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-billed 97 predecessor upgrades and pins LIVE atomically, then restarts read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "stripe-mode-upgrade-"));
  const path = join(root, "control.sqlite");
  try {
    const db = new Database(path);
    old97(db);
    db.exec(`INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
      VALUES ('principal_1', 'google', 'subject_1', 'a@example.test', 'A', '2026-10-14T00:00:00.000Z')`);
    expect(migrateSqlite(db, { stripeMode: "live" })).toEqual({
      applied: ["0098_stripe_mode_realm.sql"],
      alreadyApplied: 97,
    });
    const committed = snapshot(db);
    expect(db.query("SELECT mode FROM stripe_mode_realm").all()).toEqual([{ mode: "live" }]);
    db.close();

    const restarted = new Database(path);
    expect(migrateSqlite(restarted, { stripeMode: "live" })).toEqual({
      applied: [],
      alreadyApplied: 98,
    });
    expect(() => migrateSqlite(restarted, { stripeMode: "test" })).toThrow("not pinned to 'test'");
    expect(snapshot(restarted)).toEqual(committed);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh selected TEST and LIVE boots claim the realm before any financial serving", () => {
  for (const stripeMode of ["test", "live"] as const) {
    const db = new Database(":memory:");
    const report = migrateSqlite(db, { stripeMode });
    expect(report.applied).toHaveLength(98);
    expect(db.query("SELECT mode FROM stripe_mode_realm").all()).toEqual([{ mode: stripeMode }]);
    expect(migrateSqlite(db, { stripeMode }).applied).toEqual([]);
    db.close();
  }
});

test("invalid mode and a raced legacy write both refuse without recording 98", () => {
  const db = new Database(":memory:");
  old97(db);
  const before = snapshot(db);
  expect(() => migrateSqlite(db, { stripeMode: "LIVE" as StripeMode })).toThrow(
    "exactly 'test' or 'live'",
  );
  expect(snapshot(db)).toEqual(before);

  let raced = false;
  const writer: MigratableDatabase = {
    query: (sql) => db.query(sql),
    exec(sql) {
      if (sql === "BEGIN IMMEDIATE" && !raced) {
        raced = true;
        db.exec(`INSERT INTO ledger
          (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
          VALUES ('ledger_race', 'org_1', 'funding', 'old', 100, 0, '2026-10-14T00:00:00.000Z')`);
      }
      return db.exec(sql);
    },
  };
  expect(() => migrateSqlite(writer, { stripeMode: "live" })).toThrow(
    "existing wallet, money, or Stripe history has no realm",
  );
  expect(raced).toBe(true);
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT id FROM ledger").all()).toEqual([{ id: "ledger_race" }]);
  db.close();
});

test("a late 98 execution failure rolls back every pending migration in the same writer", () => {
  for (const failingStatement of [
    "CREATE TABLE stripe_mode_realm",
    "INSERT INTO stripe_mode_realm",
  ]) {
    const db = new Database(":memory:");
    oldThrough(db, 96);
    const before = snapshot(db);
    const failing: MigratableDatabase = {
      query: (sql) => db.query(sql),
      exec(sql) {
        if (sql.startsWith(failingStatement)) throw new Error("injected 98 failure");
        return db.exec(sql);
      },
    };
    expect(() => migrateSqlite(failing, { stripeMode: "live" })).toThrow(
      `migration ${failingStatement.startsWith("CREATE") ? "0098_stripe_mode_realm.sql" : "Stripe realm claim"} failed`,
    );
    expect(snapshot(db)).toEqual(before);
    db.close();
  }
});

test("an unrecorded realm schema cannot be silently adopted during upgrade", () => {
  const db = new Database(":memory:");
  old97(db);
  const realm = MIGRATIONS.find((migration) => migration.name === "0098_stripe_mode_realm.sql");
  expect(realm).toBeDefined();
  db.exec(realm?.sql ?? "");
  const before = snapshot(db);
  expect(() => migrateSqlite(db, { stripeMode: "live" })).toThrow(
    "Stripe mode realm schema and recorded migration disagree",
  );
  expect(snapshot(db)).toEqual(before);
  db.close();
});
