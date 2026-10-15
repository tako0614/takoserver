import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// The canonical migration is required by default. An explicit draft source is
// permitted only for isolated focused candidate verification; it never supplies
// contiguous-lineage or shared/protected D1 qualification.
const MIGRATION = "0099_hosted_billing_extensions.sql";
const CANDIDATE = readFileSync(
  process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA ??
    new URL(`../migrations/${MIGRATION}`, import.meta.url),
  "utf8",
);
const START = "2026-10-01T00:00:00.000Z";
const END = "2026-11-01T00:00:00.000Z";
const NOW = "2026-10-15T12:00:00.000Z";
const SNAPSHOT = "a".repeat(32);

function existing() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter(({ name }) => name < MIGRATION)) db.exec(migration.sql);
  return db;
}

function fixture() {
  const db = existing();
  db.exec(CANDIDATE);
  return db;
}

function hold(db: Database, org = "org_a", workspace: string | null = null, ref = "hold_one") {
  db.query(`INSERT INTO org_wallet_holds
    (org_id, ref, ledger_ref, amount_micros, fingerprint, pricing_revision, created_at,
     expires_at, state, money_policy, workspace_ref, attribution_period_start, attribution_period_end)
    VALUES (?, ?, ?, 100, 'original-exact-fingerprint', 'revision', ?, ?, 'live',
            'usd-micros-v2', ?, ?, ?)`).run(org, ref, ref, NOW, END, workspace, START, END);
}

function snapshot(db: Database, ref = SNAPSHOT, org = "org_a") {
  db.query("INSERT OR IGNORE INTO org_wallet_workspace_bindings VALUES ('workspace_a', ?, ?)").run(
    org,
    NOW,
  );
  db.query(`INSERT INTO org_wallet_workspace_snapshots
    (snapshot_ref, org_id, snapshot_at, expires_at, period_start, period_end, summary_json)
    VALUES (?, ?, ?, '2026-10-15T12:10:00.000Z', ?, ?, '{}')`).run(ref, org, NOW, START, END);
  db.query(`INSERT INTO org_wallet_workspace_snapshot_rows
    (snapshot_ref, workspace_ref, used_micros, held_micros, pending_micros)
    VALUES (?, '', 0, 0, 0), (?, 'workspace_a', 7, 3, 2)`).run(ref, ref);
  db.query(`UPDATE org_wallet_workspace_snapshots
    SET used_micros = 7, held_micros = 3, pending_micros = 2, row_count = 1, status = 'ready'
    WHERE snapshot_ref = ?`).run(ref);
}

function command(db: Database, reference = "change_one") {
  db.query(`INSERT INTO stripe_billing_plan_changes
    (org_id, reference, fingerprint, kind, expected_subscription_ref, subscription_id,
     expected_generation, desired_json, frozen_json, state, created_at)
    VALUES ('org_a', ?, 'fingerprint', 'plan-change', 'opaque_target', 'sub_a',
            1, '{}', '{}', 'pending', ?)`).run(reference, NOW);
}

test("candidate extends the exact existing source without rewriting legacy money, fingerprints or attribution", () => {
  const db = existing();
  db.exec(`INSERT INTO org_wallet_holds
    (org_id, ref, ledger_ref, amount_micros, fingerprint, created_at, expires_at, state, money_policy)
    VALUES ('org_legacy', 'old_hold', 'old_hold', 1234, 'legacy-fingerprint', '${NOW}', '${END}', 'live', 'usd-micros-v2');
    INSERT INTO org_wallet_usage_records
    (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit, period_start,
     period_end, rate_numerator_micros, rate_denominator, amount_micros, state, created_at, money_policy)
    VALUES ('org_legacy', 'old_usage', 'legacy-measured', 'old', 'meter', '1', 'requests',
            '${START}', '${END}', '1234', '1', 1234, 'pending', '${NOW}', 'usd-micros-v2');
    INSERT INTO stripe_billing_subscriptions
    (org_id, subscription_id, customer_id, plan_key, pricing_revision, status,
     cancel_at_period_end, updated_at)
    VALUES ('org_legacy', 'sub_original', 'cus_original', 'old', 'old', 'active', 0, '${NOW}');`);
  const before = db.query("SELECT * FROM stripe_billing_subscriptions").all();
  db.exec(CANDIDATE);
  expect(db.query("SELECT * FROM stripe_billing_subscriptions").all()).toEqual(before);
  expect(
    db
      .query(`SELECT amount_micros, fingerprint, workspace_ref, attribution_period_start,
    attribution_period_end FROM org_wallet_holds`)
      .get(),
  ).toEqual({
    amount_micros: 1234,
    fingerprint: "legacy-fingerprint",
    workspace_ref: null,
    attribution_period_start: null,
    attribution_period_end: null,
  });
  expect(
    db
      .query(`SELECT amount_micros, fingerprint, workspace_ref, state
    FROM org_wallet_usage_records`)
      .get(),
  ).toEqual({
    amount_micros: 1234,
    fingerprint: "legacy-measured",
    workspace_ref: null,
    state: "pending",
  });
  expect(db.query("SELECT * FROM personal_organizations").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("personal mapping needs the exact local owner and membership and cannot be removed to mint another Org", () => {
  const db = fixture();
  db.exec(`INSERT INTO principals VALUES ('local_a','google','subject_a','a@example.test','A','${NOW}');
    INSERT INTO principals VALUES ('foreign_a','github','foreign_a','f@example.test','F','${NOW}');
    INSERT INTO orgs VALUES ('org_a','A','local_a','${NOW}');`);
  const insert = () =>
    db.exec(`INSERT INTO personal_organizations VALUES ('local_a','org_a','${NOW}')`);
  expect(insert).toThrow("owner proof");
  db.exec(`INSERT INTO org_memberships VALUES ('org_a','local_a','owner','${NOW}')`);
  insert();
  expect(() => db.exec("DELETE FROM personal_organizations")).toThrow("immutable");
  expect(() => db.exec("UPDATE personal_organizations SET org_id = 'another'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("DELETE FROM orgs WHERE id = 'org_a'")).toThrow("FOREIGN KEY");
  db.exec(`INSERT INTO orgs VALUES ('other','Other','foreign_a','${NOW}');
    INSERT INTO org_memberships VALUES ('other','foreign_a','owner','${NOW}')`);
  expect(() =>
    db.exec(`INSERT INTO personal_organizations VALUES ('local_a','other','${NOW}')`),
  ).toThrow();
  db.close();
});

test("attribution is exact-Org, frozen before capture, and historical rows cannot be relabeled", () => {
  const db = fixture();
  db.exec(`INSERT INTO org_wallet_workspace_bindings VALUES ('workspace_a','org_a','${NOW}')`);
  hold(db, "org_a", "workspace_a");
  expect(() => hold(db, "org_other", "workspace_a")).toThrow("invalid hold Workspace attribution");
  expect(() => db.exec("UPDATE org_wallet_holds SET workspace_ref = NULL")).toThrow("immutable");
  expect(() => db.exec("UPDATE org_wallet_holds SET org_id = 'org_other'")).toThrow("immutable");
  expect(() => db.exec(`UPDATE org_wallet_holds SET attribution_period_start = '${NOW}'`)).toThrow(
    "immutable",
  );
  db.exec(`UPDATE org_wallet_holds SET state = 'captured', captured_micros = 70,
    released_micros = 30, closed_at = '${NOW}', capture_fingerprint = 'captured'`);
  expect(
    db.query("SELECT workspace_ref, attribution_period_start FROM org_wallet_holds").get(),
  ).toEqual({
    workspace_ref: "workspace_a",
    attribution_period_start: START,
  });
  expect(() => db.exec("UPDATE org_wallet_workspace_bindings SET org_id = 'org_other'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("DELETE FROM org_wallet_workspace_bindings")).toThrow("immutable");
  db.close();
});

test("snapshot TTL and capacity are bounded, ready pages are frozen and whole-snapshot cleanup cascades", () => {
  const db = fixture();
  snapshot(db);
  expect(() =>
    db.exec(
      `UPDATE org_wallet_workspace_snapshots SET held_micros = 4 WHERE snapshot_ref = '${SNAPSHOT}'`,
    ),
  ).toThrow("immutable");
  expect(() =>
    db.exec(
      `UPDATE org_wallet_workspace_snapshot_rows SET held_micros = 4 WHERE snapshot_ref = '${SNAPSHOT}'`,
    ),
  ).toThrow("immutable");
  expect(() =>
    db.exec(`DELETE FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = '${SNAPSHOT}'`),
  ).toThrow("immutable");
  expect(() =>
    db.exec(`INSERT INTO org_wallet_workspace_snapshots
    (snapshot_ref,org_id,snapshot_at,expires_at,period_start,period_end,summary_json)
    VALUES ('${"b".repeat(32)}','org_a','${NOW}','2026-10-15T12:10:01.000Z','${START}','${END}','{}')`),
  ).toThrow();
  for (let i = 1; i < 8; i++) snapshot(db, i.toString(16).padStart(32, "0"));
  expect(() => snapshot(db, "c".repeat(32))).toThrow("capacity");
  db.query("DELETE FROM org_wallet_workspace_snapshots WHERE snapshot_ref = ?").run(SNAPSHOT);
  expect(
    db
      .query("SELECT * FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ?")
      .all(SNAPSHOT),
  ).toEqual([]);
  snapshot(db, "c".repeat(32));
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("top-up freezes processor request, first dispatch, object identity and terminal result across replay", () => {
  const db = fixture();
  db.exec(`INSERT INTO stripe_top_up_commands
    (org_id,reference,fingerprint,command_json,stripe_key,state,created_at,updated_at)
    VALUES ('org_a','purchase_one','f','{"amountMinor":1000}','key_one','pending','${NOW}','${NOW}')`);
  expect(() =>
    db.exec(`INSERT INTO stripe_top_up_commands
    (org_id,reference,fingerprint,command_json,stripe_key,state,created_at,updated_at)
    VALUES ('org_a','purchase_two','f','{}','key_two','pending','${NOW}','${NOW}')`),
  ).toThrow("UNIQUE");
  db.exec(`UPDATE stripe_top_up_commands SET dispatched_at = '${NOW}'`);
  expect(() => db.exec("UPDATE stripe_top_up_commands SET command_json = '{}'")).toThrow(
    "immutable",
  );
  expect(() => db.exec(`UPDATE stripe_top_up_commands SET dispatched_at = '${END}'`)).toThrow(
    "immutable",
  );
  expect(() => db.exec("UPDATE stripe_top_up_commands SET state = 'ready'")).toThrow();
  db.exec(
    "UPDATE stripe_top_up_commands SET state = 'ready', session_id = 'cs_a', session_url = 'https://checkout.stripe.com/test'",
  );
  db.exec("UPDATE stripe_top_up_commands SET state = 'paid'");
  expect(() => db.exec("UPDATE stripe_top_up_commands SET state = 'pending'")).toThrow("immutable");
  expect(() => db.exec("UPDATE stripe_top_up_commands SET session_id = 'cs_other'")).toThrow(
    "immutable",
  );
  expect(() =>
    db.exec("UPDATE stripe_top_up_commands SET session_url = 'https://wrong.example.test'"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM stripe_top_up_commands")).toThrow("durable");
  db.close();
});

test("subscription terms preserve historical phases and invalidate only a proven not-yet-effective phase", () => {
  const db = fixture();
  command(db);
  db.exec(`INSERT INTO stripe_billing_subscription_terms VALUES ('sub_a','${START}','org_a','{"price":"old"}',NULL);
    INSERT INTO stripe_billing_subscription_terms VALUES ('sub_a','${END}','org_a','{"price":"new"}','change_one');
    INSERT INTO stripe_billing_subscription_term_revocations
    VALUES ('sub_a','${END}','org_a','change_one','${NOW}','${NOW}')`);
  expect(() => db.exec("UPDATE stripe_billing_subscription_terms SET terms_json = '{}'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("DELETE FROM stripe_billing_subscription_term_revocations")).toThrow(
    "immutable",
  );
  expect(() =>
    db.exec(`INSERT INTO stripe_billing_subscription_term_revocations
    VALUES ('sub_a','${START}','org_a','change_one','${NOW}','${NOW}')`),
  ).toThrow();
  expect(() =>
    db.exec(`UPDATE stripe_billing_plan_changes SET expected_subscription_ref = 'other'`),
  ).toThrow("immutable");
  expect(() => db.exec("UPDATE stripe_billing_plan_changes SET state = 'verified'")).toThrow();
  db.exec(
    "UPDATE stripe_billing_plan_changes SET state = 'verified', receipt_json = '{\"result\":\"original\"}'",
  );
  expect(() => db.exec("UPDATE stripe_billing_plan_changes SET receipt_json = '{}'")).toThrow(
    "immutable",
  );
  db.close();
});

test("each schedule/cancellation step is separately pinned and dispatched custody cannot regress", () => {
  const db = fixture();
  command(db);
  db.exec(`INSERT INTO stripe_billing_plan_change_steps
    (org_id,reference,step,request_json,idempotency_key,state,created_at)
    VALUES ('org_a','change_one','create','{"schedule":true}','step_key','prepared','${NOW}')`);
  db.exec(
    `UPDATE stripe_billing_plan_change_steps SET state = 'dispatched', dispatched_at = '${NOW}'`,
  );
  expect(() => db.exec("UPDATE stripe_billing_plan_change_steps SET state = 'prepared'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("UPDATE stripe_billing_plan_change_steps SET request_json = '{}'")).toThrow(
    "immutable",
  );
  db.exec("UPDATE stripe_billing_plan_change_steps SET remote_id = 'schedule_a'");
  expect(() =>
    db.exec("UPDATE stripe_billing_plan_change_steps SET remote_id = 'schedule_b'"),
  ).toThrow("immutable");
  db.exec(
    `UPDATE stripe_billing_plan_change_steps SET state = 'verified', response_json = '{}', verified_at = '${NOW}'`,
  );
  expect(() =>
    db.exec("UPDATE stripe_billing_plan_change_steps SET response_json = '{\"changed\":true}'"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM stripe_billing_plan_change_steps")).toThrow("durable");
  db.close();
});

test("limit policy requires version progression and cap exposure preserves the authorized interval and terminal proof", () => {
  const db = fixture();
  db.exec(
    `INSERT INTO org_wallet_limit_policies VALUES ('org_a','stop',1,NULL,NULL,'owner','${NOW}')`,
  );
  expect(() => db.exec("UPDATE org_wallet_limit_policies SET on_limit = 'prepaid'")).toThrow(
    "next version",
  );
  db.exec("UPDATE org_wallet_limit_policies SET on_limit = 'prepaid', policy_version = 2");
  db.exec(`INSERT INTO org_wallet_cash_cap_buckets VALUES ('org_a','${START}','${END}');
    INSERT INTO org_wallet_cash_exposures
    VALUES ('org_a','exposure','${START}','${END}',2,'consent',1000,'reserved',NULL,'${NOW}',NULL)`);
  expect(() => db.exec("UPDATE org_wallet_cash_exposures SET amount_minor = 2000")).toThrow(
    "immutable",
  );
  expect(() =>
    db.exec(`UPDATE org_wallet_cash_exposures SET status = 'paid', closed_at = '${NOW}'`),
  ).toThrow();
  db.exec(
    `UPDATE org_wallet_cash_exposures SET status = 'paid', source_ref = 'verified_source', closed_at = '${NOW}'`,
  );
  expect(() =>
    db.exec("UPDATE org_wallet_cash_exposures SET status = 'reserved', closed_at = NULL"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM org_wallet_cash_exposures")).toThrow("durable");
  db.close();
});

test("warning receipt deduplicates a frozen Org period/threshold and a delivered warning cannot be rearmed", () => {
  const db = fixture();
  const insert = () =>
    db.exec(`INSERT INTO org_wallet_usage_warnings
    VALUES ('org_a','${START}','${END}',8000,'{"threshold":8000}','pending',NULL,NULL,'${NOW}',NULL)`);
  insert();
  expect(insert).toThrow("UNIQUE");
  expect(() => db.exec("UPDATE org_wallet_usage_warnings SET state = 'dispatching'")).toThrow();
  db.exec(
    `UPDATE org_wallet_usage_warnings SET state = 'dispatching', claim_token = 'attempt', claim_until = '${END}'`,
  );
  db.exec(
    `UPDATE org_wallet_usage_warnings SET state = 'delivered', claim_token = NULL, claim_until = NULL, delivered_at = '${NOW}'`,
  );
  expect(() =>
    db.exec("UPDATE org_wallet_usage_warnings SET state = 'pending', delivered_at = NULL"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM org_wallet_usage_warnings")).toThrow("durable");
  db.close();
});

test("failed personal mapping proof rolls back the complete Organization/member/mapping batch", async () => {
  const db = fixture();
  db.exec(
    `INSERT INTO principals VALUES ('local_a','google','subject_a','a@example.test','A','${NOW}')`,
  );
  const sql = createSqliteSql(db);
  await expect(
    sql.batch([
      { sql: "INSERT INTO orgs VALUES ('org_failed','A','local_a',?)", params: [NOW] },
      {
        sql: "INSERT INTO org_memberships VALUES ('org_failed','local_a','member',?)",
        params: [NOW],
      },
      {
        sql: "INSERT INTO personal_organizations VALUES ('local_a','org_failed',?)",
        params: [NOW],
      },
    ]),
  ).rejects.toThrow("owner proof");
  expect(db.query("SELECT * FROM orgs WHERE id = 'org_failed'").all()).toEqual([]);
  expect(db.query("SELECT * FROM org_memberships WHERE org_id = 'org_failed'").all()).toEqual([]);
  expect(db.query("SELECT * FROM personal_organizations").all()).toEqual([]);
  db.close();
});

test("snapshot finalization requires complete totals and rolls back a failed building batch", async () => {
  const db = fixture();
  const sql = createSqliteSql(db);
  await expect(
    sql.batch([
      {
        sql: `INSERT INTO org_wallet_workspace_snapshots
        (snapshot_ref, org_id, snapshot_at, expires_at, period_start, period_end, summary_json)
        VALUES (?, 'org_a', ?, '2026-10-15T12:10:00.000Z', ?, ?, '{}')`,
        params: [SNAPSHOT, NOW, START, END],
      },
      {
        sql: `INSERT INTO org_wallet_workspace_snapshot_rows
        VALUES (?, '', 7, 3, 2)`,
        params: [SNAPSHOT],
      },
      {
        sql: `UPDATE org_wallet_workspace_snapshots
        SET status = 'ready', used_micros = 8, held_micros = 3, pending_micros = 2
        WHERE snapshot_ref = ?`,
        params: [SNAPSHOT],
      },
    ]),
  ).rejects.toThrow("complete frozen rows");
  expect(db.query("SELECT * FROM org_wallet_workspace_snapshots").all()).toEqual([]);
  expect(db.query("SELECT * FROM org_wallet_workspace_snapshot_rows").all()).toEqual([]);
  db.close();
});

test("an invalid terminal command receipt cannot release its serialized Organization slot", async () => {
  const db = fixture();
  command(db);
  db.exec("INSERT INTO stripe_billing_plan_change_slots VALUES ('org_a','change_one',1)");
  const sql = createSqliteSql(db);
  await expect(
    sql.batch([
      { sql: "DELETE FROM stripe_billing_plan_change_slots WHERE org_id = 'org_a'" },
      { sql: "UPDATE stripe_billing_plan_changes SET state = 'verified' WHERE org_id = 'org_a'" },
    ]),
  ).rejects.toThrow();
  expect(db.query("SELECT reference FROM stripe_billing_plan_change_slots").get()).toEqual({
    reference: "change_one",
  });
  expect(db.query("SELECT state FROM stripe_billing_plan_changes").get()).toEqual({
    state: "pending",
  });
  db.close();
});

test("original admission consent cannot be replaced when hold settlement is retried under a later policy", () => {
  const db = fixture();
  db.exec(`INSERT INTO org_wallet_holds
    (org_id, ref, ledger_ref, amount_micros, created_at, expires_at, state, money_policy,
     admission_policy_json)
    VALUES ('org_a','held','held',100,'${NOW}','${END}','live','usd-micros-v2',
            '{"onLimit":"stop","policyVersion":1,"consentRevision":null,"allowPurchasedCredit":false}')`);
  expect(() =>
    db.exec(`UPDATE org_wallet_holds SET admission_policy_json =
    '{"onLimit":"prepaid","policyVersion":2,"consentRevision":"new","allowPurchasedCredit":true}'`),
  ).toThrow("immutable");
  db.exec(`UPDATE org_wallet_holds SET state = 'captured', captured_micros = 70,
    released_micros = 30, closed_at = '${NOW}'`);
  const row = db.query("SELECT admission_policy_json FROM org_wallet_holds").get() as {
    admission_policy_json: string;
  };
  expect(JSON.parse(row.admission_policy_json).allowPurchasedCredit).toBe(false);
  db.close();
});

test("migration leaves the account realm unbound and its eventual authenticated tuple cannot be replaced", () => {
  const db = fixture();
  expect(db.query("SELECT * FROM stripe_billing_account_realms").all()).toEqual([]);
  db.query(
    "INSERT INTO stripe_billing_account_realms VALUES (1, 'acct_testFixture', 'test', 'hosted:test-fixture', ?)",
  ).run(NOW);
  expect(() =>
    db.exec("UPDATE stripe_billing_account_realms SET account_id = 'acct_other'"),
  ).toThrow("immutable");
  expect(() => db.exec("UPDATE stripe_billing_account_realms SET mode = 'live'")).toThrow(
    "immutable",
  );
  expect(() =>
    db.exec("UPDATE stripe_billing_account_realms SET billing_authority = 'another-authority'"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM stripe_billing_account_realms")).toThrow("immutable");
  expect(() =>
    db
      .query(
        "INSERT OR REPLACE INTO stripe_billing_account_realms VALUES (1, 'acct_other', 'test', 'other', ?)",
      )
      .run(NOW),
  ).toThrow("immutable");
  expect(
    db.query("SELECT account_id, mode, billing_authority FROM stripe_billing_account_realms").get(),
  ).toEqual({
    account_id: "acct_testFixture",
    mode: "test",
    billing_authority: "hosted:test-fixture",
  });
  db.close();
});

test("realm schema checks opaque account/authority grammar and canonical time without minting activation authority", () => {
  const db = fixture();
  const insert = db.query("INSERT INTO stripe_billing_account_realms VALUES (?, ?, ?, ?, ?)");
  expect(() => insert.run(2, "acct_test", "test", "hosted:test", NOW)).toThrow();
  expect(() => insert.run(1, "acct_", "test", "hosted:test", NOW)).toThrow();
  expect(() => insert.run(1, "acct_a/b", "test", "hosted:test", NOW)).toThrow();
  expect(() => insert.run(1, "acct_test", "unknown", "hosted:test", NOW)).toThrow();
  expect(() => insert.run(1, "acct_test", "test", " bad authority", NOW)).toThrow();
  expect(() => insert.run(1, "acct_test", "test", "hosted:test", "2026-10-15 12:00:00")).toThrow();
  // Vocabulary support is not a live bootstrap/runtime capability. Those
  // boundaries separately require authenticated TEST identity and mode proof.
  insert.run(1, "acct_liveFixture", "live", "hosted:fixture", NOW);
  expect(db.query("SELECT mode FROM stripe_billing_account_realms").get()).toEqual({
    mode: "live",
  });
  db.close();
});

test("customer creation freezes its separate processor step before top-up can pin a verified association", () => {
  const db = fixture();
  db.query(`INSERT INTO stripe_billing_customer_commands
    (org_id, realm_json, request_json, fingerprint, stripe_key, state, created_at)
    VALUES ('org_a', '{"accountId":"acct_test"}', '{"organizationId":"org_a"}',
            'fingerprint', 'customer_step_key', 'prepared', ?)`).run(NOW);
  db.query(
    "UPDATE stripe_billing_customer_commands SET state = 'dispatched', dispatched_at = ?",
  ).run(NOW);
  expect(() => db.exec("UPDATE stripe_billing_customer_commands SET state = 'prepared'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("UPDATE stripe_billing_customer_commands SET realm_json = '{}'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("UPDATE stripe_billing_customer_commands SET request_json = '{}'")).toThrow(
    "immutable",
  );
  expect(() => db.exec("UPDATE stripe_billing_customer_commands SET state = 'verified'")).toThrow();
  expect(() =>
    db
      .query(
        "UPDATE stripe_billing_customer_commands SET state = 'verified', customer_id = 'cus_test', verified_at = ?",
      )
      .run(NOW),
  ).toThrow("exact Organization association");
  db.exec(`INSERT INTO stripe_billing_customers VALUES ('org_a','cus_test','${NOW}')`);
  db.query(
    "UPDATE stripe_billing_customer_commands SET state = 'verified', customer_id = 'cus_test', verified_at = ?",
  ).run(NOW);
  expect(() =>
    db.exec("UPDATE stripe_billing_customer_commands SET customer_id = 'cus_other'"),
  ).toThrow("constraint:");
  expect(() => db.exec("DELETE FROM stripe_billing_customer_commands")).toThrow("durable");
  expect(db.query("SELECT * FROM stripe_billing_customers").all()).toEqual([
    {
      org_id: "org_a",
      customer_id: "cus_test",
      created_at: NOW,
    },
  ]);
  db.close();
});

test("a conflicting customer association refuses the entire command-verification batch", async () => {
  const db = fixture();
  db.exec(`INSERT INTO stripe_billing_customer_commands
    (org_id,realm_json,request_json,fingerprint,stripe_key,state,dispatched_at,created_at)
    VALUES ('org_a','{}','{}','fingerprint','key','dispatched','${NOW}','${NOW}');
    INSERT INTO stripe_billing_customers VALUES ('org_a','cus_original','${NOW}')`);
  const sql = createSqliteSql(db);
  await expect(
    sql.batch([
      {
        sql: "INSERT OR IGNORE INTO stripe_billing_customers VALUES ('org_a','cus_unrelated',?)",
        params: [NOW],
      },
      {
        sql: "UPDATE stripe_billing_customer_commands SET state = 'verified', customer_id = 'cus_unrelated', verified_at = ? WHERE org_id = 'org_a'",
        params: [NOW],
      },
    ]),
  ).rejects.toThrow("exact Organization association");
  expect(
    db.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = 'org_a'").get(),
  ).toEqual({ customer_id: "cus_original" });
  expect(
    db
      .query(
        "SELECT state, customer_id FROM stripe_billing_customer_commands WHERE org_id = 'org_a'",
      )
      .get(),
  ).toEqual({ state: "dispatched", customer_id: null });
  db.close();
});

test("raw measured usage retains its original admission consent through a later rollup", () => {
  const db = fixture();
  db.exec(`INSERT INTO usage_events
    (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at, amount_unit,
     amount_numerator_micros, amount_denominator, admission_policy_json)
    VALUES ('request_one','org_a','resource_a','meter',1,100,'${NOW}','usd-micros-v2','100','1',
            '{"onLimit":"stop","policyVersion":1,"consentRevision":null,"allowPurchasedCredit":false}')`);
  expect(() =>
    db.exec(`UPDATE usage_events SET admission_policy_json =
    '{"onLimit":"prepaid","policyVersion":2,"consentRevision":"new","allowPurchasedCredit":true}'`),
  ).toThrow("immutable");
  db.exec("UPDATE usage_events SET rollup_id = 'closed_rollup'");
  const row = db.query("SELECT admission_policy_json FROM usage_events").get() as {
    admission_policy_json: string;
  };
  expect(JSON.parse(row.admission_policy_json).allowPurchasedCredit).toBe(false);
  db.close();
});
