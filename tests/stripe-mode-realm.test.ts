import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStripeModeRealm } from "../scripts/deploy/stripe-mode-realm.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  assertStripeModeRealm,
  claimFreshStripeModeRealm,
  hasImmutableStripeModeRealmSchema,
  parseStripeMode,
  STRIPE_MODE_REALM_SCHEMA_QUERY,
  StripeModeRealmError,
} from "../src/stripe-mode-realm.ts";

async function openFileSql(path: string) {
  const db = new Database(path);
  for (const migration of MIGRATIONS) {
    if (migration.name === "0098_stripe_mode_realm.sql") continue;
    db.exec(migration.sql);
  }
  db.exec(
    await Bun.file(new URL("../migrations/0098_stripe_mode_realm.sql", import.meta.url)).text(),
  );
  return { db, sql: createSqliteSql(db) };
}

test("Stripe mode parsing defaults only an absent value to test", () => {
  expect(parseStripeMode(undefined)).toBe("test");
  expect(parseStripeMode("test")).toBe("test");
  expect(parseStripeMode("live")).toBe("live");
  for (const value of ["", null, "LIVE", "sandbox", 0]) {
    expect(() => parseStripeMode(value)).toThrow(StripeModeRealmError);
  }
});

test("a fresh source can be claimed and the pin survives restart without allowing a mode switch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = await openFileSql(path);
    await first.sql.run(
      "INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["principal_1", "google", "subject_1", "a@example.test", "A", "2026-10-14T00:00:00.000Z"],
    );
    await claimFreshStripeModeRealm(first.sql, "test");
    first.db.close();

    const restartedDb = new Database(path);
    const restarted = createSqliteSql(restartedDb);
    await assertStripeModeRealm(restarted, "test");
    await expect(claimFreshStripeModeRealm(restarted, "live")).rejects.toMatchObject({
      code: "mode_mismatch",
    });
    await expect(
      restarted.run("UPDATE stripe_mode_realm SET mode = 'live' WHERE singleton = 1"),
    ).rejects.toBeTruthy();
    await expect(
      restarted.run("DELETE FROM stripe_mode_realm WHERE singleton = 1"),
    ).rejects.toBeTruthy();
    expect(await restarted.query("SELECT singleton, mode FROM stripe_mode_realm")).toEqual([
      { singleton: 1, mode: "test" },
    ]);
    restartedDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent SQLite claims converge on one immutable pin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-race-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = await openFileSql(path);
    const secondDb = new Database(path);
    const second = createSqliteSql(secondDb);
    await Promise.all([
      claimFreshStripeModeRealm(first.sql, "live"),
      claimFreshStripeModeRealm(second, "live"),
    ]);
    await expect(claimFreshStripeModeRealm(first.sql, "test")).rejects.toMatchObject({
      code: "mode_mismatch",
    });
    expect(await second.query("SELECT mode FROM stripe_mode_realm WHERE singleton = 1")).toEqual([
      { mode: "live" },
    ]);
    first.db.close();
    secondDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unpinned database with any wallet or Stripe history refuses without changing rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-history-"));
  const path = join(directory, "control.sqlite");
  try {
    const { db, sql } = await openFileSql(path);
    db.exec(`INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
      VALUES ('ledger_1', 'org_1', 'funding', 'legacy', 100, 0, '2026-10-14T00:00:00.000Z')`);
    db.exec(`INSERT INTO stripe_events
      (event_id, type, livemode, object_id, event_created_at, received_at, outcome, settled_at)
      VALUES ('evt_old1', 'checkout.session.completed', 0, 'cs_test_old',
      '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z', 'ignored', '2026-10-14T00:00:00.000Z')`);
    db.exec(`INSERT INTO idempotency (scope_key, fingerprint, status, expires_at)
      VALUES ('ai:legacy', 'legacy', 200, 1)`);

    await expect(claimFreshStripeModeRealm(sql, "test")).rejects.toMatchObject({
      code: "legacy_history",
    });
    await expect(claimFreshStripeModeRealm(sql, "live")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(await sql.query("SELECT id, settled_delta_micros FROM ledger")).toEqual([
      { id: "ledger_1", settled_delta_micros: 100 },
    ]);
    expect(await sql.query("SELECT event_id, livemode FROM stripe_events")).toEqual([
      { event_id: "evt_old1", livemode: 0 },
    ]);
    expect(await sql.query("SELECT scope_key FROM idempotency")).toEqual([
      { scope_key: "ai:legacy" },
    ]);
    expect(await sql.query("SELECT singleton FROM stripe_mode_realm")).toEqual([]);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing pin schema fails closed", async () => {
  const db = new Database(":memory:");
  const sql = createSqliteSql(db);
  await expect(assertStripeModeRealm(sql, "test")).rejects.toBeTruthy();
  await expect(claimFreshStripeModeRealm(sql, "test")).rejects.toBeTruthy();
  db.close();
});

test("a pin without the immutable schema cannot authorize financial serving", async () => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const sql = createSqliteSql(db);
  await claimFreshStripeModeRealm(sql, "live");
  db.exec("DROP TRIGGER stripe_mode_realm_no_delete");
  await expect(assertStripeModeRealm(sql, "live")).rejects.toMatchObject({
    code: "unsafe_schema",
  });
  db.close();
});

test("fresh claiming does not create a pin when the immutability trigger is absent", async () => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  db.exec("DROP TRIGGER stripe_mode_realm_no_update");
  const sql = createSqliteSql(db);
  await expect(claimFreshStripeModeRealm(sql, "live")).rejects.toMatchObject({
    code: "unsafe_schema",
  });
  expect(await sql.query("SELECT mode FROM stripe_mode_realm")).toEqual([]);
  db.close();
});

test("the canonical 0098 source produces the exact accepted table and unconditional triggers", () => {
  const db = new Database(":memory:");
  const migration = MIGRATIONS.find((item) => item.name === "0098_stripe_mode_realm.sql");
  expect(migration).toBeDefined();
  db.exec(migration?.sql ?? "");
  const schema = db.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as {
    type: string;
    name: string;
    sql: string;
  }[];
  expect(hasImmutableStripeModeRealmSchema(schema)).toBe(true);
  expect(inspectStripeModeRealm({ schema, pins: [{ mode: "test" }] }, "test").ready).toBe(true);
  const weakenedTable = schema.map((row) =>
    row.name === "stripe_mode_realm"
      ? { ...row, sql: row.sql.replace("CHECK (mode IN ('test', 'live'))", "") }
      : row,
  );
  expect(hasImmutableStripeModeRealmSchema(weakenedTable)).toBe(false);
  db.close();
});

test("a disguised non-enforcing trigger cannot authorize runtime, migration, or deploy", async () => {
  for (const replacement of [
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
WHEN 0 BEGIN SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable'); END`,
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE OF pinned_at ON stripe_mode_realm
BEGIN SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable'); END`,
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
BEGIN SELECT 1; -- RAISE(ABORT, 'Stripe mode realm pin is immutable')
END`,
  ]) {
    const db = new Database(":memory:");
    migrateSqlite(db, { stripeMode: "test" });
    db.exec("DROP TRIGGER stripe_mode_realm_no_update");
    db.exec(replacement);
    const sql = createSqliteSql(db);
    const schema = db.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as {
      type: string;
      name: string;
      sql: string;
    }[];
    expect(hasImmutableStripeModeRealmSchema(schema)).toBe(false);
    await expect(assertStripeModeRealm(sql, "test")).rejects.toMatchObject({
      code: "unsafe_schema",
    });
    expect(() => migrateSqlite(db, { stripeMode: "test" })).toThrow(
      "Stripe realm immutability is unavailable",
    );
    expect(inspectStripeModeRealm({ schema, pins: [{ mode: "test" }] }, "test")).toMatchObject({
      ready: false,
      reason: "unsafe_schema",
    });
    expect(db.query("SELECT mode FROM stripe_mode_realm").all()).toEqual([{ mode: "test" }]);
    db.close();
  }
});
