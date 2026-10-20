import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-canonical-recipes.ts";
import { AUTH103_NATIVE_MIGRATIONS } from "../src/auth103-native-source-contract.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  assertFinancial0104CustomerWriteShape,
  FINANCIAL_0104_CUSTOMER_H0_SCHEMA,
  FINANCIAL_0104_ORG_TRACE_EXCLUSIONS,
  FINANCIAL_0104_ORG_TRACE_TABLES,
} from "../src/financial-0104-customer-schema.ts";
import {
  FINANCIAL_0104_C0_FENCE_SCHEMA,
  FINANCIAL_0104_CONSENT_FENCE_SCHEMA,
  FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA,
  FINANCIAL_0104_FENCED_TABLES,
  FINANCIAL_0104_RECEIVER_FENCE_SCHEMA,
  FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST,
  FINANCIAL_0104_UNFENCED_TABLES,
  FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST,
  financialStatementWriteTarget,
  isFinancialCustomerMoneyFencedBatch,
  isFinancialMoneyFencedBatch,
  ROOT_MONEY_GUARD_STRIPE_TABLES,
} from "../src/financial-0104-money-fence.ts";
import {
  createFinancial0104SourceRecipe,
  FINANCIAL_0104_CATALOG_QUERY,
  FINANCIAL_0104_DDL,
  FINANCIAL_0104_MIGRATION,
  FINANCIAL_0104_MONEY_FENCES,
  FINANCIAL_0104_MONEY_UPDATE_FENCES,
  FINANCIAL_0104_OBJECTS,
  FINANCIAL_0104_PREDECESSOR,
  FINANCIAL_0104_TABLES,
  financial0104RecipeDigest,
} from "../src/financial-0104-source-contract.ts";
import { canonicalDigest } from "../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { Sql } from "../src/ports.ts";
import {
  createSharedFinancialAdmissionComponent,
  prepareCustomerAdmissionBatch,
} from "../src/shared-financial-admission.ts";
import { prepareConsentBatch } from "../src/shared-financial-consent-data.ts";
import {
  buildFinancialR1AttemptCustodyStatement,
  buildFinancialR1BoundedAttemptCustodyStatement,
  buildFinancialR1ClaimedCoPreparationBatch,
  buildFinancialR1CoPreparationBatch,
  buildFinancialR1MechanicalBatch,
  FINANCIAL_R1_ATTEMPT_DDL,
} from "../src/shared-financial-retained-r1.ts";
import {
  createFinancialPreproofChallengeStore,
  FINANCIAL_SOURCE_ENROLLMENT_DDL,
} from "../src/shared-financial-source-enrollment.ts";
import { FINANCIAL_SOURCE_GENESIS_DDL } from "../src/shared-financial-source-genesis-schema.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { fixture as consentFixture } from "./fixtures/financial-customer-five-action-fixture.ts";
import { dropFinancial0104Fences, MONEY_FREEZE_ROW } from "./helpers/financial-0104-fenced.ts";
import { ACTIONS, AT, count, EPOCH, fixture } from "./helpers/financial-r1-custody-fixture.ts";

const ROOT = resolve(import.meta.dir, "..");
const ROTATED = `sha256:${"d".repeat(64)}` as const;
const CO_PREP_TABLES = [
  "financial_action_source_registrations",
  "financial_preproof_challenges",
  "financial_preproof_challenge_receipts",
  "financial_retained_r1_originals",
  "financial_retained_r1_receipts",
] as const;
const MONEY_WORDS =
  /\b(?:money_cutover_freeze|money_cutover_writer_permit|money_cutover_authorized_epoch)\b/u;
const scratch = mkdtempSync(join(tmpdir(), "financial-0104-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };
const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Exact 0100 prefix, then Root's own canonical 0101-0103 recipe bytes. The
 * state is built once per profile and copied for each caller. */
function at0103(path = ":memory:", options: { readonly money?: boolean } = {}): Database {
  const key = options.money === false ? "plain" : "money";
  const image = (at0103Images[key] ??= at0103Built(key === "money"));
  if (path === ":memory:") return Database.deserialize(image);
  writeFileSync(path, image, { flag: "wx", mode: 0o600 });
  return new Database(path);
}
const at0103Images: { money?: Uint8Array; plain?: Uint8Array } = {};
function at0103Built(money: boolean): Uint8Array {
  const db = new Database(":memory:");
  const prefix = MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100);
  expect(prefix).toHaveLength(100);
  for (const migration of prefix) db.exec(migration.sql);
  const recipes = createAuth103CanonicalSourceArtifacts(ROOT);
  expect(recipes.files.map((file) => file.name)).toEqual([...AUTH103_NATIVE_MIGRATIONS]);
  for (const file of recipes.files) db.exec(file.sql);
  // Root/Money's existing cutover guard rows; not part of the Financial body.
  // `money: false` keeps the pre-cutover / self-host shape without them.
  if (money) {
    db.exec(MONEY_CUTOVER_FREEZE_DDL);
    db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
    db.exec(MONEY_CUTOVER_PERMIT_DDL);
    db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  }
  const image = db.serialize();
  db.close();
  return image;
}
function schemaRows(db: Database, tables: readonly string[]): SchemaRow[] {
  return (
    db
      .query(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND tbl_name IN (${tables.map(() => "?").join(",")})`,
      )
      .all(...tables) as SchemaRow[]
  ).sort(byName);
}

const FENCED_0104_TABLES = FINANCIAL_0104_TABLES.filter(
  (table) => !Object.hasOwn(FINANCIAL_0104_UNFENCED_TABLES, table),
);

describe("Financial 0104 source recipe", () => {
  test("installs on the exact 0100+0103 state and owns only its declared objects", () => {
    const db = at0103();
    try {
      const before = (
        db.query("SELECT type,name FROM sqlite_schema ORDER BY name").all() as SchemaRow[]
      ).map((row) => `${row.type}:${row.name}`);
      for (const object of FINANCIAL_0104_OBJECTS)
        expect(before).not.toContain(`${object.type}:${object.name}`);
      db.exec(FINANCIAL_0104_DDL);
      // Every 0104 object sits on a 0104 table: the H0 Org capture triggers on
      // Root's orgs table are Root's 0105, not part of this body.
      expect(
        FINANCIAL_0104_OBJECTS.filter((o) => !FINANCIAL_0104_TABLES.includes(o.tbl_name)),
      ).toEqual([]);
      expect(FINANCIAL_0104_DDL).not.toContain(" ON orgs");
      const installed = schemaRows(db, FINANCIAL_0104_TABLES);
      expect(installed).toEqual(
        FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) => ({
          type,
          name,
          tbl_name,
          sql,
        })).sort(byName),
      );
      const catalog = db.query(FINANCIAL_0104_CATALOG_QUERY).all() as SchemaRow[];
      expect(catalog.sort(byName)).toEqual(installed);
      const after = (db.query("SELECT type,name FROM sqlite_schema").all() as SchemaRow[]).map(
        (row) => `${row.type}:${row.name}`,
      );
      const added = after.filter((entry) => !before.includes(entry));
      // Only the 0104 tables/triggers, plus their implicit sqlite_autoindex rows.
      expect(added.filter((entry) => !entry.startsWith("index:sqlite_autoindex_")).sort()).toEqual(
        FINANCIAL_0104_OBJECTS.map((o) => `${o.type}:${o.name}`).sort(),
      );
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("on a pre-cutover/self-host primary 0104 applies cleanly and every 0104 INSERT fails closed", () => {
    const db = at0103(":memory:", { money: false });
    try {
      // Only 0094's historical money_cutover proof tables exist here.
      for (const missing of [
        "money_cutover_freeze",
        "money_cutover_writer_permit",
        "money_cutover_authorized_epoch",
      ])
        expect(db.query("SELECT 1 FROM sqlite_schema WHERE name=?").get(missing)).toBeNull();
      // Trigger creation does not need the referenced money_cutover tables.
      db.exec(FINANCIAL_0104_DDL);
      expect(schemaRows(db, FINANCIAL_0104_TABLES)).toHaveLength(FINANCIAL_0104_OBJECTS.length);
      // An epoch-bearing table and a receiver table refuse before writing a row.
      for (const table of ["shared_customer_challenges", "financial_source_events"]) {
        expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(
          /no such table: (?:main\.)?money_cutover_/u,
        );
        expect(count(db, table)).toBe(0);
      }
      for (const table of FENCED_0104_TABLES) {
        expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(
          /no such table: (?:main\.)?money_cutover_/u,
        );
        expect(count(db, table)).toBe(0);
      }
      // The two unfenced 0104 tables carry no money fence here (Root's Money guard
      // fences the links at cutover; birth rows come only from Root's Org cascade),
      // and their own original guards still refuse a bare row.
      for (const table of Object.keys(FINANCIAL_0104_UNFENCED_TABLES)) {
        expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow();
        expect(count(db, table)).toBe(0);
      }
      // Unrelated non-0104 writes on the same primary still succeed.
      db.query(
        "INSERT INTO runtime_grant_keys(key_id,public_jwk,created_at_epoch_seconds) VALUES(?,?,?)",
      ).run("key:self-host", "{}", 1);
      expect(count(db, "runtime_grant_keys")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("every 0104 table, and every table a Financial batch writes, carries one money fence", () => {
    const db = at0103();
    try {
      db.exec(FINANCIAL_0104_DDL);
      const tables = (
        db
          .query(
            `SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${FINANCIAL_0104_TABLES.map(() => "?").join(",")}) ORDER BY name`,
          )
          .all(...FINANCIAL_0104_TABLES) as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual([...FINANCIAL_0104_TABLES].sort());
      // Exactly three named 0104 tables carry no Financial fence: Root's Money cutover
      // guard fences the links, and only Root's Org capture triggers append birth and
      // change observations.
      expect(Object.keys(FINANCIAL_0104_UNFENCED_TABLES).sort()).toEqual([
        "financial_customer_history_birth_observations",
        "financial_customer_history_org_changes",
        "stripe_customer_admission_links",
      ]);
      const fencedTables: string[] = [...FINANCIAL_0104_FENCED_TABLES];
      expect(fencedTables.sort()).toEqual([...FENCED_0104_TABLES].sort());
      expect(Object.keys(FINANCIAL_0104_MONEY_FENCES).sort()).toEqual(
        [...FENCED_0104_TABLES].sort(),
      );
      for (const table of Object.keys(FINANCIAL_0104_UNFENCED_TABLES))
        expect(
          db
            .query(
              "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%money_cutover_writer_permit%'",
            )
            .all(table),
        ).toEqual([]);
      for (const table of FENCED_0104_TABLES) {
        const fences = db
          .query(
            "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND name=?",
          )
          .all(table, `${table}_money_fence`) as { name: string; sql: string }[];
        expect(fences).toHaveLength(1);
        const sql = fences[0]?.sql ?? "";
        expect(
          sql.startsWith(`CREATE TRIGGER ${table}_money_fence BEFORE INSERT ON ${table}\n`),
        ).toBe(true);
        expect(sql).toContain("WHEN EXISTS(SELECT 1 FROM money_cutover_freeze)");
        expect(sql).toContain("money_cutover_writer_permit p");
        expect(sql).toContain(
          "money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch",
        );
        expect(sql).toContain("p.singleton=1 AND p.epoch='usd-micros-v2'");
        expect(sql).toContain("SELECT RAISE(ABORT,'constraint: Financial ");
      }
      // Tables that admit an UPDATE at all also carry an UPDATE fence; every
      // other table refuses every UPDATE through its existing immutable trigger.
      expect(Object.keys(FINANCIAL_0104_MONEY_UPDATE_FENCES).sort()).toEqual([
        "financial_customer_history_heads",
        "financial_history_enrollment_heads",
        "financial_source_heads",
        "financial_source_registrations",
      ]);
      for (const table of tables) {
        const update = FINANCIAL_0104_MONEY_UPDATE_FENCES[table];
        if (update) {
          const object = FINANCIAL_0104_OBJECTS.find((o) => o.name === update);
          expect(
            object?.sql.startsWith(`CREATE TRIGGER ${update} BEFORE UPDATE ON ${table}\n`),
          ).toBe(true);
          // Every UPDATE fence, H0 enrollment heads included, has no exemption.
          expect(object?.sql).toContain("WHEN EXISTS(SELECT 1 FROM money_cutover_freeze)");
          expect(object?.sql).toContain("p.singleton=1 AND p.epoch='usd-micros-v2'");
        } else
          expect(
            db
              .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
              .get(`${table}_no_update`),
          ).toEqual({
            sql: expect.stringMatching(
              new RegExp(
                `^CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}\\s+BEGIN\\b`,
                "u",
              ),
            ),
          });
      }
      // Every Financial-retained epoch is bound. The R1 registration and the four
      // receiver tables carry no epoch column, and a grant revocation must stay
      // possible after rotation (existing R1 registration shape).
      const epochless = [
        "financial_action_source_registrations",
        "financial_source_registrations",
        "financial_source_events",
        "financial_source_heads",
        "financial_source_receipts",
        "financial_payer_grant_revocations",
      ];
      for (const [table, name] of Object.entries(FINANCIAL_0104_MONEY_FENCES)) {
        const object = FINANCIAL_0104_OBJECTS.find((o) => o.name === name);
        if (!object) throw Error(`missing fence ${name}`);
        if (epochless.includes(table)) expect(object.sql).not.toContain("p.writer_epoch IS");
        else expect(object.sql).toContain("p.writer_epoch IS");
      }
    } finally {
      db.close();
    }
  });

  test("each fence alone refuses frozen and unpermitted INSERTs before any other guard", () => {
    for (const table of FENCED_0104_TABLES) {
      const db = new Database(":memory:");
      try {
        db.exec("PRAGMA foreign_keys=OFF");
        db.exec(MONEY_CUTOVER_FREEZE_DDL);
        db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
        db.exec(MONEY_CUTOVER_PERMIT_DDL);
        for (const object of FINANCIAL_0104_OBJECTS)
          if (object.type === "table") db.exec(object.sql);
        const fence = FINANCIAL_0104_OBJECTS.find(
          (o) => o.name === FINANCIAL_0104_MONEY_FENCES[table],
        );
        if (!fence) throw Error(`missing fence for ${table}`);
        db.exec(fence.sql);
        db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(EPOCH);
        const insert = () => db.exec(`INSERT INTO ${table} DEFAULT VALUES`);
        // No permit row.
        expect(insert).toThrow(/constraint: Financial .*permit/u);
        db.query("INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)").run(EPOCH);
        db.exec("INSERT INTO money_cutover_freeze VALUES(1,'b','o','k','w','s')");
        expect(insert).toThrow(/constraint: Financial .*permit/u);
        expect(count(db, table)).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  test("each fence alone passes the correct permit and refuses a foreign row epoch", () => {
    const rowValue = (column: string, epoch: string) =>
      column === "writer_epoch"
        ? epoch
        : column.endsWith("_json")
          ? JSON.stringify({ writerEpoch: epoch, scopeRealm: { writerEpoch: epoch } })
          : "k";
    const insertRow = (db: Database, table: string, epoch: string) => {
      // An INTEGER PRIMARY KEY (rowid alias) is left to SQLite.
      const columns = (
        db.query(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          pk: number;
        }[]
      )
        .filter((column) => !(column.pk === 1 && column.type === "INTEGER"))
        .map((column) => column.name);
      db.query(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...columns.map((column) => rowValue(column, epoch)));
    };
    const epochBearing = FENCED_0104_TABLES.filter((table) =>
      FINANCIAL_0104_OBJECTS.find(
        (o) => o.name === FINANCIAL_0104_MONEY_FENCES[table],
      )?.sql.includes("p.writer_epoch IS"),
    );
    // 14 epoch-bearing C0/M/G/R1/consent tables plus all 16 fenced Customer tables.
    expect(epochBearing).toHaveLength(30);
    for (const table of FENCED_0104_TABLES) {
      for (const rows of ["current", "foreign"] as const) {
        if (rows === "foreign" && !epochBearing.includes(table)) continue;
        const db = new Database(":memory:");
        try {
          // Only the fence under test exists; every other check is off so that
          // one synthetic row per table can satisfy the fence's own joins.
          db.exec("PRAGMA foreign_keys=OFF");
          db.exec("PRAGMA ignore_check_constraints=ON");
          db.exec(MONEY_CUTOVER_FREEZE_DDL);
          db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
          db.exec(MONEY_CUTOVER_PERMIT_DDL);
          for (const object of FINANCIAL_0104_OBJECTS)
            if (object.type === "table") db.exec(object.sql);
          const epoch = rows === "current" ? EPOCH : ROTATED;
          for (const other of FINANCIAL_0104_TABLES)
            if (other !== table) insertRow(db, other, epoch);
          const fence = FINANCIAL_0104_OBJECTS.find(
            (o) => o.name === FINANCIAL_0104_MONEY_FENCES[table],
          );
          if (!fence) throw Error(`missing fence for ${table}`);
          db.exec(fence.sql);
          db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(EPOCH);
          db.query("INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)").run(
            EPOCH,
          );
          if (rows === "current") {
            insertRow(db, table, EPOCH);
            expect(count(db, table)).toBe(1);
          } else {
            expect(() => insertRow(db, table, ROTATED)).toThrow(
              /constraint: Financial .*permit\/epoch/u,
            );
            expect(count(db, table)).toBe(0);
          }
        } finally {
          db.close();
        }
      }
    }
  });

  test("each UPDATE fence alone refuses frozen and unpermitted UPDATEs", () => {
    const rootJson = JSON.stringify({
      primaryRef: "primary:u",
      primaryIncarnation: "primary-inc:u",
      physicalBindingRef: "binding:u",
      physicalBindingIncarnation: "binding-inc:u",
      writerEpoch: EPOCH,
    });
    // Parent rows carry the epoch an epoch-bound fence reads; then one row to update.
    const rows: Record<string, { readonly seed: readonly string[]; readonly update: string }> = {
      financial_source_registrations: {
        seed: [
          `INSERT INTO financial_source_registrations
        (registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at)
        VALUES('registration:u','inc:u','receiver:u','target:u','${EPOCH}','${EPOCH}','{}','qualification:u','${AT}')`,
        ],
        update: "UPDATE financial_source_registrations SET registration_ref=registration_ref",
      },
      financial_source_heads: {
        seed: [
          `INSERT INTO financial_source_heads
        (registration_ref,incarnation,affected_ref,genesis_qualification_ref,created_at,sequence,event_digest,state,last_event_ref,updated_at)
        VALUES('registration:u','inc:u','affected:u','genesis:u','${AT}',0,'${EPOCH}','active',NULL,'${AT}')`,
        ],
        update: "UPDATE financial_source_heads SET registration_ref=registration_ref",
      },
      financial_customer_history_heads: {
        seed: [
          `INSERT INTO financial_customer_history_coverages
        (history_ref,coverage_incarnation,attempt_ref,expected_receipt_ref,coverage_kind,original_org_origin,organization_id,primary_ref,enrollment_ref,complete_seal_ref,seal_kind,realm_registration,realm_incarnation,realm_json,required_scopes_json,writer_epoch,previous_history_ref,created_at)
        VALUES('history:u','coverage-inc:u','attempt:u','receipt:u','qualified-genesis','birth:u','org:u','primary:u','enrollment:u','seal:u','complete-seal','realm:u','realm-inc:u','{}','[{}]','${EPOCH}',NULL,'${AT}')`,
          `INSERT INTO financial_customer_history_heads VALUES('birth:u','realm:u','realm-inc:u','history:u',0,'entry:u','receipt:u','active')`,
        ],
        update: "UPDATE financial_customer_history_heads SET journal_sequence=journal_sequence",
      },
      financial_history_enrollment_heads: {
        seed: [
          `INSERT INTO financial_history_primary_roots VALUES('primary:u','primary-inc:u','binding:u','binding-inc:u','${rootJson}')`,
          "INSERT INTO financial_history_enrollment_heads VALUES('primary:u','enrollment:u',1,0,'capturing','start:u')",
        ],
        update: "UPDATE financial_history_enrollment_heads SET state='sealed'",
      },
    };
    expect(Object.keys(rows).sort()).toEqual(
      Object.keys(FINANCIAL_0104_MONEY_UPDATE_FENCES).sort(),
    );
    for (const [table, name] of Object.entries(FINANCIAL_0104_MONEY_UPDATE_FENCES)) {
      const db = new Database(":memory:");
      try {
        db.exec("PRAGMA foreign_keys=OFF");
        db.exec(MONEY_CUTOVER_FREEZE_DDL);
        db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
        db.exec(MONEY_CUTOVER_PERMIT_DDL);
        for (const object of FINANCIAL_0104_OBJECTS)
          if (object.type === "table") db.exec(object.sql);
        const selected = rows[table];
        if (!selected) throw Error(`missing row for ${table}`);
        for (const seed of selected.seed) db.exec(seed);
        const fence = FINANCIAL_0104_OBJECTS.find((o) => o.name === name);
        if (!fence) throw Error(`missing fence ${name}`);
        db.exec(fence.sql);
        db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(EPOCH);
        const update = () => db.exec(selected.update);
        expect(update).toThrow(/constraint: Financial .*permit/u);
        db.query("INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)").run(EPOCH);
        db.exec("INSERT INTO money_cutover_freeze VALUES(1,'b','o','k','w','s')");
        expect(update).toThrow(/constraint: Financial .*permit/u);
        if (table === "financial_history_enrollment_heads") {
          // No head UPDATE is exempt: a bare capture advance, a close, a jump or an
          // advance with any other change all need the frame (Root's Org triggers
          // never move a head).
          for (const forged of [
            "UPDATE financial_history_enrollment_heads SET capture_sequence=capture_sequence+1",
            "UPDATE financial_history_enrollment_heads SET state='closed',capture_sequence=capture_sequence+1",
            "UPDATE financial_history_enrollment_heads SET capture_sequence=capture_sequence+2",
            "UPDATE financial_history_enrollment_heads SET capture_sequence=capture_sequence+1,expected_receipt_ref='forged'",
          ])
            expect(() => db.exec(forged)).toThrow(/constraint: Financial .*permit/u);
        }
        db.exec("DELETE FROM money_cutover_freeze");
        expect(update).not.toThrow();
        if (table !== "financial_source_registrations" && table !== "financial_source_heads") {
          // A current permit for another epoch is refused by the epoch-bound fence.
          db.exec("DELETE FROM money_cutover_writer_permit");
          db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(ROTATED);
          db.query("INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)").run(
            ROTATED,
          );
          expect(update).toThrow(/constraint: Financial .*permit\/epoch/u);
        }
      } finally {
        db.close();
      }
    }
  });

  test("the fixture SQL the existing tests install equals the 0104 objects minus the new fences", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(
        readFileSync(
          new URL("./fixtures/shared-financial-source-component-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
      db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
      db.exec(
        readFileSync(
          new URL("./fixtures/shared-financial-retained-r1-component-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(FINANCIAL_R1_ATTEMPT_DDL);
      db.exec(
        readFileSync(
          new URL(
            "./fixtures/financial-five-action-consent-schema.unnumbered.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      // The Customer candidates: L1, H0 and journal. The H0 fixture also carries
      // Root's Org capture triggers on orgs; they are not 0104 rows.
      db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
      for (const file of [
        "customer-l1-schema.unnumbered.sql",
        "shared-financial-customer-history-component-schema.sql",
        "customer-journal-schema.unnumbered.sql",
      ])
        db.exec(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
      const added = new Set([
        ...Object.keys(FINANCIAL_0104_RECEIVER_FENCE_SCHEMA),
        ...Object.keys(FINANCIAL_0104_C0_FENCE_SCHEMA),
        ...Object.keys(FINANCIAL_0104_CONSENT_FENCE_SCHEMA),
        ...Object.keys(FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA),
      ]);
      expect(Object.keys(FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA)).toHaveLength(18);
      expect(added.size).toBe(36);
      expect(schemaRows(db, FINANCIAL_0104_TABLES)).toEqual(
        FINANCIAL_0104_OBJECTS.filter((o) => !added.has(o.name))
          .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql }))
          .sort(byName),
      );
    } finally {
      db.close();
    }
  });

  test("depends on 0103 only; every foreign-key parent exists at the 0103+0104 state", () => {
    const db = at0103();
    try {
      db.exec(FINANCIAL_0104_DDL);
      const present = new Set(
        (db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as SchemaRow[]).map(
          (row) => row.name,
        ),
      );
      const parents = new Set<string>();
      for (const table of FINANCIAL_0104_TABLES)
        for (const fk of db.query(`PRAGMA foreign_key_list(${table})`).all() as {
          table: string;
        }[])
          parents.add(fk.table);
      const auth103 = ["auth_principal_incarnations", "shared_principal_bindings"];
      for (const table of [...auth103, "credential_authority_classes"])
        expect(parents.has(table)).toBe(true);
      expect([...parents].filter((table) => !present.has(table))).toEqual([]);
      // Customer rows also reference Root's existing 0095/0099 Stripe customer tables.
      expect([...parents].filter((table) => !FINANCIAL_0104_TABLES.includes(table)).sort()).toEqual(
        [
          "auth_principal_incarnations",
          "credential_authority_classes",
          "shared_principal_bindings",
          "stripe_billing_customer_commands",
          "stripe_billing_customers",
        ],
      );
    } finally {
      db.close();
    }
  });

  test("receiver readiness pins exactly the unfenced candidate or the exact fenced 0104 rows", async () => {
    const query = `SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('financial_source_registrations','financial_source_heads','financial_source_events','financial_source_receipts') AND sql IS NOT NULL ORDER BY type,name`;
    const installed = at0103();
    const fixtureDb = new Database(":memory:");
    try {
      installed.exec(FINANCIAL_0104_DDL);
      expect(await canonicalDigest(await createSqliteSql(installed).query(query))).toBe(
        FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST,
      );
      fixtureDb.exec(
        readFileSync(
          new URL("./fixtures/shared-financial-source-component-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(await canonicalDigest(await createSqliteSql(fixtureDb).query(query))).toBe(
        FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST,
      );
      // Any partial fence set matches neither pinned shape.
      fixtureDb.exec(
        Object.values(FINANCIAL_0104_RECEIVER_FENCE_SCHEMA)[0] ?? "SELECT RAISE(ABORT,'none')",
      );
      const partial = await canonicalDigest(await createSqliteSql(fixtureDb).query(query));
      expect([
        FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST,
        FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST,
      ]).not.toContain(partial);
    } finally {
      installed.close();
      fixtureDb.close();
    }
  });

  test("recipe DATA is the exact body digest, name and 0103 predecessor", async () => {
    const recipe = await createFinancial0104SourceRecipe();
    const expected: string = `sha256:${createHash("sha256").update(FINANCIAL_0104_DDL).digest("hex")}`;
    expect<string>(recipe.recipeDigest).toBe(expected);
    expect<string>(await financial0104RecipeDigest()).toBe(expected);
    expect(recipe.name).toBe(FINANCIAL_0104_MIGRATION);
    expect(recipe.name.startsWith("0104_")).toBe(true);
    expect(recipe.predecessor).toBe(FINANCIAL_0104_PREDECESSOR);
    expect<string | undefined>(FINANCIAL_0104_PREDECESSOR).toBe(AUTH103_NATIVE_MIGRATIONS[2]);
    expect(AUTH103_NATIVE_MIGRATIONS).toHaveLength(3);
    expect(recipe.sql).toBe(FINANCIAL_0104_DDL);
    expect(recipe.catalogProjection).toEqual(
      FINANCIAL_0104_OBJECTS.map((o) => [o.type, o.name, o.tbl_name]),
    );
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(await createFinancial0104SourceRecipe()).toEqual(recipe);
    // Every table precedes all of its triggers in source order.
    for (const [index, object] of FINANCIAL_0104_OBJECTS.entries())
      if (object.type === "trigger")
        expect(
          FINANCIAL_0104_OBJECTS.findIndex((o) => o.type === "table" && o.name === object.tbl_name),
        ).toBeLessThan(index);
  });

  test("the builder refusal admits only non-empty batches whose every write is fenced", () => {
    expect(isFinancialMoneyFencedBatch([])).toBe(false);
    expect(isFinancialMoneyFencedBatch([{ sql: "INSERT INTO orgs(id) VALUES(?)" }])).toBe(false);
    expect(
      isFinancialMoneyFencedBatch([{ sql: "SELECT 1 FROM financial_retained_r1_originals" }]),
    ).toBe(false);
    expect(
      isFinancialMoneyFencedBatch([
        { sql: "INSERT INTO financial_retained_r1_receipts(receipt_ref) VALUES(?)" },
        { sql: "UPDATE ledger SET org_id=?" },
      ]),
    ).toBe(false);
    expect(
      financialStatementWriteTarget(
        "WITH i(a) AS (VALUES(?)) INSERT INTO financial_retained_r1_originals(a) SELECT a FROM i",
      ),
    ).toBe("financial_retained_r1_originals");
    // Customer batches may also write Root's Money-guard Stripe tables, but only
    // alongside a Financial-fenced write, and never any other table.
    expect([...ROOT_MONEY_GUARD_STRIPE_TABLES].sort()).toEqual([
      "stripe_billing_customer_commands",
      "stripe_billing_customers",
      "stripe_customer_admission_links",
    ]);
    expect(
      isFinancialCustomerMoneyFencedBatch([
        { sql: "INSERT INTO stripe_billing_customer_commands(org_id) VALUES(?)" },
      ]),
    ).toBe(false);
    expect(
      isFinancialCustomerMoneyFencedBatch([
        { sql: "INSERT INTO financial_customer_admissions(admission_ref) VALUES(?)" },
        { sql: "UPDATE stripe_billing_customer_commands SET state='dispatched'" },
      ]),
    ).toBe(true);
    expect(
      isFinancialCustomerMoneyFencedBatch([
        { sql: "INSERT INTO financial_customer_admissions(admission_ref) VALUES(?)" },
        { sql: "UPDATE stripe_billing_subscriptions SET status='active'" },
      ]),
    ).toBe(false);
    expect(
      isFinancialMoneyFencedBatch([
        { sql: "INSERT INTO stripe_customer_admission_links(org_id) VALUES(?)" },
      ]),
    ).toBe(false);
    // Birth observations are Root's Org-trigger rows: no Financial batch may write them.
    for (const write of [
      "INSERT INTO financial_customer_history_birth_observations(birth_ref) VALUES(?)",
      "UPDATE financial_customer_history_birth_observations SET phase='raw'",
      "DELETE FROM financial_customer_history_birth_observations",
    ]) {
      const batch = [
        { sql: "INSERT INTO financial_customer_history_entries(entry_ref) VALUES(?)" },
        { sql: write },
      ];
      expect(isFinancialMoneyFencedBatch(batch)).toBe(false);
      expect(isFinancialCustomerMoneyFencedBatch(batch)).toBe(false);
    }
  });

  test("without money_cutover tables, 0104 plus the H0 Org capture triggers keep Org create, rename and delete working", () => {
    // Root's Org capture triggers, exactly as the H0 candidate fixture (and Root's
    // 0105 reference) define them.
    const scratchDb = new Database(":memory:");
    let orgTriggers: string[];
    try {
      scratchDb.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
      scratchDb.exec(
        readFileSync(
          new URL(
            "./fixtures/shared-financial-customer-history-component-schema.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      orgTriggers = (
        scratchDb
          .query(
            "SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='orgs' ORDER BY rowid",
          )
          .all() as { sql: string }[]
      ).map((row) => row.sql);
    } finally {
      scratchDb.close();
    }
    expect(orgTriggers).toHaveLength(4);
    // No Org trigger names a fenced table or a money_cutover table.
    for (const sql of orgTriggers) {
      // Reads of the org-keyed trace tables are allowed (0094's money_cutover_aggregates
      // exists on every migrated primary); the cutover-only guard tables are not.
      expect(sql).not.toMatch(
        /money_cutover_(?:freeze|writer_permit|authorized_epoch)|RAISE|rowid/iu,
      );
      expect(sql).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM)\s+financial_/u);
      const writes = [...sql.matchAll(/INSERT INTO ([a-z_]+)/gu)].map((m) => m[1] ?? "");
      expect(writes.length).toBeGreaterThan(0);
      for (const table of writes)
        expect(Object.keys(FINANCIAL_0104_UNFENCED_TABLES)).toContain(table);
    }
    const db = at0103(":memory:", { money: false });
    try {
      db.exec(FINANCIAL_0104_DDL);
      for (const sql of orgTriggers) db.exec(sql);
      db.exec(
        "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:self','google','self','self@invalid.example','Self','2026-10-15T00:00:00.000Z')",
      );
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Self','principal:self','2026-10-15T00:00:00.000Z')",
      );
      // Rename, identical owner-login UPSERT, identity change, REPLACE, delete and
      // re-create of the same id all succeed.
      db.exec("UPDATE orgs SET name='Renamed' WHERE id='org:self'");
      const upsert = `INSERT INTO orgs (id, name, owner_principal_id, created_at)
                    VALUES ('org:self', 'Login', 'principal:self', '2026-10-16T00:00:00.000Z')
                    ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                      owner_principal_id = excluded.owner_principal_id`;
      db.exec(upsert);
      db.exec("UPDATE orgs SET owner_principal_id='principal:other' WHERE id='org:self'");
      db.exec(
        "INSERT OR REPLACE INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Replaced','principal:self','2026-10-15T00:00:00.000Z')",
      );
      db.exec("DELETE FROM orgs WHERE id='org:self'");
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Again','principal:self','2026-10-17T00:00:00.000Z')",
      );
      expect(
        db.query("SELECT org_id,phase FROM financial_customer_history_birth_observations").all(),
      ).toEqual([{ org_id: "org:self", phase: "raw" }]);
      expect(
        db
          .query(
            "SELECT change_seq,change_kind FROM financial_customer_history_org_changes ORDER BY change_seq",
          )
          .all(),
      ).toEqual([
        { change_seq: 1, change_kind: "update" },
        { change_seq: 2, change_kind: "replace" },
        { change_seq: 3, change_kind: "delete" },
      ]);
      // Only observations were written among the 0104 tables.
      for (const table of FINANCIAL_0104_TABLES)
        if (!Object.hasOwn(FINANCIAL_0104_UNFENCED_TABLES, table)) expect(count(db, table)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("the Org trace table set is every org_id table at the 0104 state minus the named exclusions, in both SQL texts", () => {
    const db = at0103();
    let derived: string[];
    try {
      db.exec(FINANCIAL_0104_DDL);
      const tables = (
        db.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      derived = tables.filter((table) =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
          (column) => column.name === "org_id",
        ),
      );
    } finally {
      db.close();
    }
    const exclusions = Object.keys(FINANCIAL_0104_ORG_TRACE_EXCLUSIONS).sort();
    for (const table of exclusions) expect(derived).toContain(table);
    expect([...FINANCIAL_0104_ORG_TRACE_TABLES].sort()).toEqual(
      derived.filter((table) => !exclusions.includes(table)).sort(),
    );
    const named = (sql: string, column: string) =>
      [
        ...sql.matchAll(
          new RegExp(`EXISTS\\(SELECT 1 FROM ([a-z_0-9]+) m WHERE m\\.org_id=${column}\\)`, "gu"),
        ),
      ]
        .map((match) => match[1] ?? "")
        .sort();
    // The 0104 birth guard and Root's Org INSERT trigger (as the H0 candidate) both
    // name exactly this set.
    const guard =
      FINANCIAL_0104_CUSTOMER_H0_SCHEMA.financial_customer_history_birth_observations_org_capture ??
      "";
    expect(named(guard, "NEW\\.org_id")).toEqual([...FINANCIAL_0104_ORG_TRACE_TABLES].sort());
    const scratchDb = new Database(":memory:");
    try {
      scratchDb.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
      scratchDb.exec(
        readFileSync(
          new URL(
            "./fixtures/shared-financial-customer-history-component-schema.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const insert = (
        scratchDb
          .query("SELECT sql FROM sqlite_schema WHERE name='financial_history_capture_org_insert'")
          .get() as { sql: string }
      ).sql;
      expect(named(insert, "NEW\\.id")).toEqual([...FINANCIAL_0104_ORG_TRACE_TABLES].sort());
    } finally {
      scratchDb.close();
    }
  });

  test("every 0104-created Org trace table answers an org_id lookup through an index", () => {
    const db = at0103();
    try {
      db.exec(FINANCIAL_0104_DDL);
      const own = FINANCIAL_0104_ORG_TRACE_TABLES.filter((table) =>
        FINANCIAL_0104_TABLES.includes(table),
      );
      expect(own.length).toBeGreaterThan(0);
      for (const table of own) {
        const plan = (
          db
            .query(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} m WHERE m.org_id=?`)
            .all("org:plan") as { detail: string }[]
        ).map((row) => row.detail);
        expect({ table, plan }).toEqual({
          table,
          plan: [expect.stringMatching(/^SEARCH m USING (?:COVERING )?INDEX /u)],
        });
      }
    } finally {
      db.close();
    }
  });

  test("birth and change observations are append-only and no Financial source writes them", async () => {
    const db = at0103();
    try {
      db.exec(FINANCIAL_0104_DDL);
      const triggers = (
        db
          .query(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='financial_customer_history_birth_observations' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(triggers).toEqual([
        "financial_customer_history_birth_observations_no_delete",
        "financial_customer_history_birth_observations_no_replace",
        "financial_customer_history_birth_observations_no_update",
        "financial_customer_history_birth_observations_org_capture",
      ]);
      db.exec("PRAGMA foreign_keys=OFF");
      const birth = (ref: string, org: string, name: string) =>
        db.exec(
          `INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase) VALUES('${ref}','${org}','owner','${name}','at','raw')`,
        );
      // A forged row with no matching Org is refused, frozen or not.
      db.exec(MONEY_FREEZE_ROW);
      expect(() => birth("birth:forged", "org:a", "name")).toThrow(/exact Org capture/u);
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:a','name','owner','at')",
      );
      // The Org exists but the row disagrees with it.
      expect(() => birth("birth:forged", "org:a", "other")).toThrow(/exact Org capture/u);
      // Exactly what the Org INSERT cascade writes while no capture is open.
      birth("birth:a", "org:a", "name");
      expect(() =>
        db.exec("UPDATE financial_customer_history_birth_observations SET org_name='changed'"),
      ).toThrow(/constraint: retained history mutation/u);
      expect(() => db.exec("DELETE FROM financial_customer_history_birth_observations")).toThrow(
        /constraint: retained history deletion/u,
      );
      expect(count(db, "financial_customer_history_birth_observations")).toBe(1);
      // A second raw row for the same Org row is refused.
      expect(() => birth("birth:again", "org:a", "name")).toThrow(/constraint/u);
      // Change observations are append-only too and admit only the exact Org change.
      const change = (ref: string, name: string) =>
        db.exec(
          `INSERT INTO financial_customer_history_org_changes(change_ref,change_seq,change_kind,org_id,old_owner_principal_id,old_org_name,old_org_created_at,new_org_id,new_owner_principal_id,new_org_name,new_org_created_at) VALUES('${ref}',COALESCE((SELECT max(change_seq) FROM financial_customer_history_org_changes),0)+1,'update','org:a','owner','old','at','org:a','owner','${name}','at')`,
        );
      expect(() => change("change:forged", "other")).toThrow(/exact Org change/u);
      change("change:a", "name");
      expect(() =>
        db.exec("UPDATE financial_customer_history_org_changes SET old_org_name='x'"),
      ).toThrow(/constraint: retained history mutation/u);
      expect(() => db.exec("DELETE FROM financial_customer_history_org_changes")).toThrow(
        /constraint: retained history deletion/u,
      );
    } finally {
      db.close();
    }
    // Financial source only reads the table; its one writer is Root's Org cascade.
    const writers = new Bun.Glob("src/{financial-,shared-financial-}*.ts").scanSync({ cwd: ROOT });
    for (const path of writers) {
      const source = readFileSync(join(ROOT, path), "utf8");
      expect({
        path,
        writes:
          /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+financial_customer_history_(?:birth_observations|org_changes)\b/iu.test(
            source,
          ),
      }).toEqual({ path, writes: false });
    }
  });

  test("Customer writes require exactly the fenced 0104 Customer shape", async () => {
    const db = at0103();
    try {
      const sql = createSqliteSql(db);
      // Unfenced candidates (the existing fixtures) are readable but never written.
      for (const file of [
        "financial-five-action-consent-schema.unnumbered.sql",
        "customer-l1-schema.unnumbered.sql",
        "shared-financial-customer-history-component-schema.sql",
        "customer-journal-schema.unnumbered.sql",
      ])
        db.exec(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
      await expect(assertFinancial0104CustomerWriteShape(sql)).rejects.toThrow(
        "exact fenced shape",
      );
      // Every fence but one is still a partial shape.
      const fences = Object.values(FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA);
      for (const fence of fences.slice(1)) db.exec(fence);
      await expect(assertFinancial0104CustomerWriteShape(sql)).rejects.toThrow(
        "exact fenced shape",
      );
      db.exec(fences[0] ?? "");
      await expect(assertFinancial0104CustomerWriteShape(sql)).resolves.toBeUndefined();
      // Root's Money cutover-guard fence on the links table is Root's; an extra
      // object on a Financial-owned Customer table is not the exact shape.
      db.exec(
        "CREATE TRIGGER money_cutover_fence_stripe_customer_admission_links_insert BEFORE INSERT ON stripe_customer_admission_links BEGIN SELECT 1; END",
      );
      await expect(assertFinancial0104CustomerWriteShape(sql)).resolves.toBeUndefined();
      db.exec(
        "CREATE TRIGGER foreign_extra BEFORE INSERT ON financial_customer_history_entries BEGIN SELECT 1; END",
      );
      await expect(assertFinancial0104CustomerWriteShape(sql)).rejects.toThrow(
        "exact fenced shape",
      );
    } finally {
      db.close();
    }
    const installed = at0103();
    try {
      installed.exec(FINANCIAL_0104_DDL);
      await expect(
        assertFinancial0104CustomerWriteShape(createSqliteSql(installed)),
      ).resolves.toBeUndefined();
    } finally {
      installed.close();
    }
  });
});

/** A real file at the exact 0104 state, then the existing R1 custody fixture over it. */
async function at0104() {
  const path = join(scratch, `primary-${crypto.randomUUID()}.sqlite`);
  const db = at0103(path);
  db.exec(FINANCIAL_0104_DDL);
  db.query("INSERT INTO stripe_mode_realm VALUES(1,'test',?)").run(AT);
  db.query(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_enrollment','test','enrollment',?)",
  ).run(AT);
  db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(EPOCH);
  db.close();
  return fixture(path, false);
}
function action(index: number) {
  const selected = ACTIONS[index];
  if (!selected) throw Error(`missing action ${index}`);
  return selected;
}
const counts = (db: Database) => CO_PREP_TABLES.map((table) => count(db, table));

describe("Financial 0104 co-preparation through the existing Money writer", () => {
  for (const action of ACTIONS) {
    test(`${action.kind}: all five statements pass createMoneyCutoverSql unchanged and commit`, async () => {
      const f = await at0104();
      try {
        assertMoneyCutoverSqlOrigin(f.sql, { writerEpoch: EPOCH });
        const command = await f.command(action);
        const batch = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
        expect(batch).toHaveLength(5);
        for (const statement of batch) expect(statement.sql).not.toMatch(MONEY_WORDS);
        expect(batch.map((statement) => financialStatementWriteTarget(statement.sql))).toEqual([
          ...CO_PREP_TABLES,
        ]);
        const result = await f.sql.batch(batch);
        expect(result.map((write) => write.changes)).toEqual([1, 1, 1, 1, 1]);
        expect(counts(f.db)).toEqual([1, 1, 1, 1, 1]);
        expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
        const retained = await f.store.readRetainedR1Original(command);
        expect(retained.status).toBe("found");
        if (retained.status === "found") expect(retained.original).toEqual(command.original);
      } finally {
        f.close();
      }
    });
  }

  test("Money freeze rolls the whole batch back with no row and no residual permit", async () => {
    const f = await at0104();
    try {
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
      ]);
      const command = await f.command(action(0), "frozen");
      const batch = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      await expect(f.sql.batch(batch)).rejects.toThrow(/constraint: Financial .*permit/u);
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await f.base.run("DELETE FROM money_cutover_freeze WHERE singleton=1");
      expect(await f.sql.batch(batch)).toHaveLength(5);
      expect(counts(f.db)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      f.close();
    }
  });

  test("a revoked or foreign epoch rolls the whole batch back atomically", async () => {
    const f = await at0104();
    try {
      const command = await f.command(action(1), "epoch");
      const batch = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [ROTATED],
      );
      // The writer's own epoch is no longer authorized: the permit insert aborts.
      await expect(f.sql.batch(batch)).rejects.toThrow();
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      // The permit is current but the retained rows carry the old epoch: fences abort.
      const rotated = createMoneyCutoverSql(f.raw, ROTATED);
      assertMoneyCutoverSqlOrigin(rotated, { writerEpoch: ROTATED });
      await expect(rotated.batch(batch)).rejects.toThrow(/permit\/epoch required/u);
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [EPOCH],
      );
      expect(await f.sql.batch(batch)).toHaveLength(5);
      expect(counts(f.db)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      f.close();
    }
  });

  test("outside the permit frame the batch and the C0 pair alone are refused", async () => {
    const f = await at0104();
    try {
      const command = await f.command(action(2), "unpermitted");
      const batch = await buildFinancialR1CoPreparationBatch(f.options, command, AT);
      await expect(f.base.batch(batch)).rejects.toThrow(/permit/u);
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      const c0 = createFinancialPreproofChallengeStore(f.options).buildPreparationBatch(
        command.original.c0,
        AT,
      );
      expect(c0).toEqual(batch.slice(1, 3));
      await expect(f.base.batch(c0)).rejects.toThrow(/Financial C0 challenge permit\/epoch/u);
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      // The same C0 pair inside the actual writer commits alone, fenced.
      expect(await f.sql.batch(c0)).toHaveLength(2);
      expect(counts(f.db)).toEqual([0, 1, 1, 0, 0]);
    } finally {
      f.close();
    }
  });

  test("a missing claim still makes the claimed five-statement batch roll back entirely", async () => {
    const f = await at0104();
    try {
      const command = await f.command(action(3), "claimed");
      const batch = await buildFinancialR1ClaimedCoPreparationBatch(f.options, command, AT);
      expect(batch).toHaveLength(5);
      for (const statement of batch) expect(statement.sql).not.toMatch(MONEY_WORDS);
      await expect(f.sql.batch(batch)).rejects.toThrow();
      expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      // With its exact first claim retained, the same five statements commit.
      const claim = await buildFinancialR1AttemptCustodyStatement(f.options, command, AT);
      expect(claim.sql).not.toMatch(MONEY_WORDS);
      expect((await f.sql.run(claim.sql, claim.params)).changes).toBe(1);
      expect(await f.sql.batch(batch)).toHaveLength(5);
      expect(counts(f.db)).toEqual([1, 1, 1, 1, 1]);
      expect(count(f.db, "financial_r1_preparation_attempts")).toBe(1);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("Financial 0104 R1 builders refuse a schema missing their fences", () => {
  const FREEZE = "INSERT INTO money_cutover_freeze VALUES(1,'b','o','k','w','s')";
  test("mechanical batch: built and committed when fenced; refused under freeze without its fences", async () => {
    const f = await at0104();
    try {
      await f.registerFixtureData();
      const command = await f.command(action(0), "mechanical");
      const batch = await buildFinancialR1MechanicalBatch(f.options, command);
      expect(await f.sql.batch(batch)).toHaveLength(2);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      for (const name of [
        "financial_retained_r1_originals_money_fence",
        "financial_retained_r1_receipts_money_fence",
      ])
        f.db.exec(`DROP TRIGGER ${name}`);
      f.db.exec(FREEZE);
      const other = await f.command(action(1), "mechanical-unfenced");
      await expect(buildFinancialR1MechanicalBatch(f.options, other)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
    } finally {
      f.close();
    }
  });

  test("attempt builders: built and committed when fenced; refused under freeze without the attempt fence", async () => {
    const f = await at0104();
    try {
      const first = await f.command(action(0), "attempt");
      const claim = await buildFinancialR1AttemptCustodyStatement(f.options, first, AT);
      expect((await f.sql.run(claim.sql, claim.params)).changes).toBe(1);
      expect(count(f.db, "financial_r1_preparation_attempts")).toBe(1);
      f.db.exec("DROP TRIGGER financial_r1_preparation_attempts_money_fence");
      f.db.exec(FREEZE);
      const second = await f.command(action(1), "attempt-unfenced");
      await expect(
        buildFinancialR1AttemptCustodyStatement(f.options, second, AT),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        buildFinancialR1BoundedAttemptCustodyStatement(f.options, second, AT),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(count(f.db, "financial_r1_preparation_attempts")).toBe(1);
    } finally {
      f.close();
    }
  });

  test("attempt builders are refused under freeze once an R1 fence is missing", async () => {
    const f = await at0104();
    try {
      f.db.exec("DROP TRIGGER financial_retained_r1_originals_money_fence");
      f.db.exec(FREEZE);
      const command = await f.command(action(3), "attempt-r1-unfenced");
      await expect(
        buildFinancialR1AttemptCustodyStatement(f.options, command, AT),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        buildFinancialR1BoundedAttemptCustodyStatement(f.options, command, AT),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(count(f.db, "financial_r1_preparation_attempts")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("co-preparation is refused under freeze once any R1 or 0104 fence is missing", async () => {
    for (const drop of ["r1", "c0"] as const) {
      const f = await at0104();
      try {
        if (drop === "r1")
          f.db.exec("DROP TRIGGER financial_action_source_registrations_money_fence");
        else dropFinancial0104Fences(f.db);
        f.db.exec(FREEZE);
        const command = await f.command(action(2), `co-prep-${drop}`);
        await expect(
          buildFinancialR1CoPreparationBatch(f.options, command, AT),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(counts(f.db)).toEqual([0, 0, 0, 0, 0]);
      } finally {
        f.close();
      }
    }
  });
});

describe("Financial 0104 consent batch through the existing Money writer", () => {
  const CONSENT_TABLES = [
    "financial_payer_grants",
    "financial_payer_consent_witnesses",
    "financial_payer_consent_receipts",
  ] as const;
  test("commits with the authorized epoch; freeze, revoked or foreign epoch and no permit roll back", async () => {
    const f = await consentFixture();
    try {
      // The fixture's own first consent committed through the actual writer.
      const before = CONSENT_TABLES.map((table) => count(f.db, table));
      expect(before).toEqual([1, 1, 1]);
      const second = {
        ...f.input,
        challengeRef: "challenge:fenced",
        grantRef: "grant:fenced",
        grantIncarnation: "grant-inc:fenced",
        consentRef: "consent-original:fenced",
        issuanceAttempt: "attempt:fenced",
        receiptRef: "consent-receipt:fenced",
      };
      await f.challenge(second);
      const epoch = (
        f.db.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get() as {
          writer_epoch: string;
        }
      ).writer_epoch;
      const batch = prepareConsentBatch(second, f.org);
      expect(batch).toHaveLength(3);
      for (const statement of batch) expect(statement.sql).not.toMatch(MONEY_WORDS);
      expect(batch.map((statement) => financialStatementWriteTarget(statement.sql))).toEqual([
        ...CONSENT_TABLES,
      ]);
      const writer = createMoneyCutoverSql(f.sql, epoch);
      const unchanged = () =>
        expect(CONSENT_TABLES.map((table) => count(f.db, table))).toEqual(before);
      // Freeze.
      f.db.exec(MONEY_FREEZE_ROW);
      await expect(writer.batch(batch)).rejects.toThrow(/constraint: Financial consent/u);
      unchanged();
      f.db.exec("DELETE FROM money_cutover_freeze");
      // Revoked epoch: the writer's permit insert aborts.
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(ROTATED);
      await expect(writer.batch(batch)).rejects.toThrow();
      unchanged();
      // Foreign epoch: a current permit that is not the retained challenge's.
      await expect(createMoneyCutoverSql(f.sql, ROTATED).batch(batch)).rejects.toThrow(
        /constraint: Financial consent grant permit\/epoch/u,
      );
      unchanged();
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(epoch);
      // No permit frame.
      await expect(f.sql.batch(batch)).rejects.toThrow(/constraint: Financial consent/u);
      unchanged();
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
      // On the unfenced consent candidate the batch refuses in-statement: S1/S2
      // select nothing and the unconditional receipt CHECK aborts all three.
      const fences = Object.values(FINANCIAL_0104_CONSENT_FENCE_SCHEMA);
      for (const name of Object.keys(FINANCIAL_0104_CONSENT_FENCE_SCHEMA))
        f.db.exec(`DROP TRIGGER ${name}`);
      await expect(writer.batch(batch)).rejects.toThrow(
        /mandatory consent receipt|all_rows_match/u,
      );
      unchanged();
      for (const sql of fences) f.db.exec(sql);
      // Inside the actual writer with the authorized epoch all three rows commit.
      expect((await writer.batch(batch)).map((write) => write.changes)).toEqual([1, 1, 1]);
      expect(CONSENT_TABLES.map((table) => count(f.db, table))).toEqual([2, 2, 2]);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("a grant issued under an old epoch stays revocable after rotation, never frozen or unpermitted", async () => {
    const f = await consentFixture();
    try {
      const revoke = {
        sql: `INSERT INTO financial_payer_grant_revocations(grant_ref,revocation_ref,reason,authority_evidence_ref,revoked_at)
          VALUES(?,?,?,?,?)`,
        params: [
          "grant:1",
          "revocation:1",
          "rotation",
          "evidence:rotation",
          new Date().toISOString(),
        ],
      };
      const issued = (
        f.db
          .query("SELECT writer_epoch FROM shared_customer_challenges WHERE challenge_ref=?")
          .get("challenge:1") as { writer_epoch: string }
      ).writer_epoch;
      expect(issued).not.toBe(ROTATED);
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(ROTATED);
      const rotated = createMoneyCutoverSql(f.sql, ROTATED);
      f.db.exec(MONEY_FREEZE_ROW);
      await expect(rotated.batch([revoke])).rejects.toThrow(/consent revocation permit required/u);
      f.db.exec("DELETE FROM money_cutover_freeze");
      await expect(f.sql.batch([revoke])).rejects.toThrow(/consent revocation permit required/u);
      expect(count(f.db, "financial_payer_grant_revocations")).toBe(0);
      expect(await rotated.batch([revoke])).toHaveLength(1);
      expect(count(f.db, "financial_payer_grant_revocations")).toBe(1);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("Financial 0104 Customer admission through the existing Money writer", () => {
  const ROWS = [
    "financial_customer_admissions",
    "stripe_billing_customer_commands",
    "stripe_customer_admission_links",
    "financial_customer_admission_receipts",
    "money_cutover_writer_permit",
  ] as const;
  test("acceptCustomerCreation refuses raw Sql, a foreign writer and an unfenced shape, rolls back under freeze, then commits", async () => {
    const f = await consentFixture();
    try {
      const epoch = (
        f.db.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get() as {
          writer_epoch: string;
        }
      ).writer_epoch;
      const batch = prepareCustomerAdmissionBatch(f.admission);
      expect(batch).toHaveLength(4);
      for (const statement of batch) expect(statement.sql).not.toMatch(MONEY_WORDS);
      const counts = () => ROWS.map((table) => count(f.db, table));
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      // A raw Sql is refused before any SQL is sent.
      const calls: string[] = [];
      const raw: Sql = {
        async query(sql, params) {
          calls.push("query");
          return f.sql.query(sql, params);
        },
        async run(sql, params) {
          calls.push("run");
          return f.sql.run(sql, params);
        },
        async batch(statements) {
          calls.push("batch");
          return f.sql.batch(statements);
        },
      };
      await expect(
        createSharedFinancialAdmissionComponent(raw, { writerEpoch: epoch }).acceptCustomerCreation(
          f.admission,
        ),
      ).rejects.toThrow("Root's Money writer");
      expect(calls).toEqual([]);
      // A Money writer for any other epoch is refused the same way.
      await expect(
        createSharedFinancialAdmissionComponent(createMoneyCutoverSql(f.sql, ROTATED), {
          writerEpoch: epoch,
        }).acceptCustomerCreation(f.admission),
      ).rejects.toThrow("Root's Money writer");
      const component = createSharedFinancialAdmissionComponent(f.money, { writerEpoch: epoch });
      // An unfenced shape (one Customer fence missing) is never written.
      const fence = "financial_customer_admissions_money_fence";
      const fenceSql = FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA[fence] ?? "";
      f.db.exec(`DROP TRIGGER ${fence}`);
      await expect(component.acceptCustomerCreation(f.admission)).rejects.toThrow(
        "exact fenced shape",
      );
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      f.db.exec(fenceSql);
      // Freeze: the whole four-row batch, Stripe rows included, rolls back.
      f.db.exec(MONEY_FREEZE_ROW);
      await expect(component.acceptCustomerCreation(f.admission)).rejects.toThrow(
        /constraint: Financial Customer admission/u,
      );
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      f.db.exec("DELETE FROM money_cutover_freeze");
      // Missing permit: the same statements on the raw Sql are refused.
      await expect(f.sql.batch(batch)).rejects.toThrow(/constraint: Financial Customer/u);
      expect(counts()).toEqual([0, 0, 0, 0, 0]);
      const receipt = await component.acceptCustomerCreation(f.admission);
      expect(receipt.receiptRef).toBe(f.admission.receiptRef);
      expect(counts()).toEqual([1, 1, 1, 1, 0]);
      // Historical exact readback, no second write.
      expect(await component.acceptCustomerCreation(f.admission)).toEqual(receipt);
      expect(counts()).toEqual([1, 1, 1, 1, 0]);
    } finally {
      f.close();
    }
  });
});
