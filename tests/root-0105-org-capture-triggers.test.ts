// Root 0105 Org history capture: exact H0 trigger text, self-host regression,
// capture interplay with Financial's H0 component, backfill and index plans.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-canonical-recipes.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { FINANCIAL_0104_ORG_TRACE_TABLES } from "../src/financial-0104-customer-schema.ts";
import { FINANCIAL_0104_DDL } from "../src/financial-0104-source-contract.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import {
  ROOT_0105_BIRTH_BACKFILL,
  ROOT_0105_DDL,
  ROOT_0105_OBJECTS,
  ROOT_0105_ORG_CAPTURE_TRIGGERS,
  ROOT_0105_PREDECESSOR,
  ROOT_0105_TRACE_INDEXES,
} from "../src/root-0105-org-capture-triggers.ts";
import {
  createHistoryH0Component,
  type HistoryEnrollment,
  type HistoryRoot,
  type HistoryScope,
} from "../src/shared-financial-customer-history.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const ROOT = resolve(import.meta.dir, "..");
const S = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const AT = "2026-10-15T00:00:00.000Z";

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

const root: HistoryRoot = {
  primaryRef: "primary:synthetic",
  primaryIncarnation: "primary-inc:1",
  physicalBindingRef: "binding:fixture",
  physicalBindingIncarnation: "binding-inc:1",
  resourceRef: "resource:fixture",
  lineageEvidenceRef: "lineage:fixture",
  qualificationRef: "qualification:synthetic-unmounted",
  profileRef: "profile:all-writers-fixture",
  accountId: "acct_synthetic",
  mode: "test",
  billingAuthority: "authority.synthetic",
  financialRealm: `realm:${"a".repeat(64)}`,
  writerEpoch: S("writer"),
};
const scope = (kind: HistoryScope["scopeKind"], ref: string): HistoryScope => ({
  scopeKind: kind,
  originalScopeRef: ref,
  originalScopeIncarnation: `inc:${ref}`,
  sourceRegistrationRef: "registration:synthetic",
  sourceIncarnation: "source-inc:1",
  sourceHeadRef: `head:${ref}`,
  sourceSequence: 1,
  evidenceRef: `evidence:${ref}`,
  evidenceDigest: S(ref),
  fenceRef: kind === "writer" || kind === "credential-alias" ? `fence:${ref}` : null,
  drainRef: kind === "writer" ? `drain:${ref}` : null,
  drainDisposition: kind === "writer" ? "retained-original" : "not-applicable",
  ownerPrincipalId: null,
  orgCreatedAt: null,
});
const run: HistoryEnrollment = {
  enrollmentRef: "enrollment:1",
  enrollmentIncarnation: "enrollment-inc:1",
  generation: 1,
  startReceiptRef: "receipt:start1",
  sealReceiptRef: "receipt:seal1",
  previousStartReceiptRef: null,
  previousSealRef: null,
  required: [
    {
      ...scope("physical-primary", root.primaryRef),
      originalScopeIncarnation: root.primaryIncarnation,
    },
    scope("writer", "customer"),
    scope("credential-alias", "alias:current"),
  ],
};

const count = (db: Database) =>
  (
    db.query("SELECT COUNT(*) n FROM financial_customer_history_birth_observations").get() as {
      n: number;
    }
  ).n;

describe("Root 0105 Org history capture", () => {
  test("is the exact H0 candidate trigger text and depends on 0104", async () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
      db.exec(
        readFileSync(
          new URL(
            "./fixtures/shared-financial-customer-history-component-schema.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const candidate = db
        .query(
          "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='orgs' ORDER BY rowid",
        )
        .all() as { name: string; sql: string }[];
      expect(Object.fromEntries(candidate.map((row) => [row.name, row.sql]))).toEqual({
        ...ROOT_0105_ORG_CAPTURE_TRIGGERS,
      });
    } finally {
      db.close();
    }
    expect(ROOT_0105_PREDECESSOR).toBe("0104_financial_custody.sql");
    expect(ROOT_0105_DDL).toBe(
      `${[
        ...Object.values(ROOT_0105_TRACE_INDEXES).map(([, sql]) => sql),
        ...Object.values(ROOT_0105_ORG_CAPTURE_TRIGGERS),
        ROOT_0105_BIRTH_BACKFILL,
      ]
        .map((sql) => `${sql};`)
        .join("\n")}\n`,
    );
  });

  test("its persistent objects are exactly the sqlite_schema rows the body adds", () => {
    const db = at0104();
    try {
      const before = new Set(
        (db.query("SELECT type||' '||name AS k FROM sqlite_schema").all() as { k: string }[]).map(
          ({ k }) => k,
        ),
      );
      db.exec(ROOT_0105_DDL);
      const added = (
        db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() as {
          type: string;
          name: string;
          tbl_name: string;
          sql: string;
        }[]
      ).filter((row) => !before.has(`${row.type} ${row.name}`));
      const sort = (rows: readonly { type: string; name: string }[]) =>
        [...rows].sort((a, b) => `${a.type} ${a.name}`.localeCompare(`${b.type} ${b.name}`));
      expect(sort(added)).toEqual(sort(ROOT_0105_OBJECTS.map((row) => ({ ...row }))));
      // Plain CREATE INDEX: a foreign same-name object refuses the whole body.
      const again = at0104();
      try {
        again.exec("CREATE INDEX usage_statements_by_org ON usage_statements(org_id)");
        expect(() => again.exec(ROOT_0105_DDL)).toThrow(/already exists/u);
      } finally {
        again.close();
      }
    } finally {
      db.close();
    }
  });

  test("Root regression: without money_cutover tables, Org create, rename, UPSERT, REPLACE and delete succeed on 0104+0105 and write only observations", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
        db.exec(migration.sql);
      for (const file of createAuth103CanonicalSourceArtifacts(ROOT).files) db.exec(file.sql);
      for (const table of [
        "money_cutover_freeze",
        "money_cutover_writer_permit",
        "money_cutover_authorized_epoch",
      ])
        expect(db.query("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)).toBeNull();
      db.exec(FINANCIAL_0104_DDL);
      db.exec(
        "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:self','google','self','self@invalid.example','Self','2026-10-15T00:00:00.000Z')",
      );
      // Orgs that exist before 0105 lands are backfilled with one raw birth each.
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:existing','Existing','principal:self','2026-10-14T00:00:00.000Z')",
      );
      db.exec(ROOT_0105_DDL);
      expect(
        db.query("SELECT org_id,phase FROM financial_customer_history_birth_observations").all(),
      ).toEqual([{ org_id: "org:existing", phase: "raw" }]);
      db.exec("DELETE FROM orgs WHERE id='org:existing'");
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Self','principal:self','2026-10-15T00:00:00.000Z')",
      );
      // Rename, identical owner-login UPSERT, identity change, REPLACE, delete and
      // re-create of the same id all succeed and only append observations.
      db.exec("UPDATE orgs SET name='Renamed' WHERE id='org:self'");
      db.exec(
        "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES ('org:self', 'Login', 'principal:self', '2026-10-16T00:00:00.000Z') ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_principal_id = excluded.owner_principal_id",
      );
      db.exec("UPDATE orgs SET owner_principal_id='principal:other' WHERE id='org:self'");
      db.exec(
        "INSERT OR REPLACE INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Replaced','principal:self','2026-10-15T00:00:00.000Z')",
      );
      db.exec("DELETE FROM orgs WHERE id='org:self'");
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:self','Again','principal:self','2026-10-17T00:00:00.000Z')",
      );
      expect(
        db
          .query(
            "SELECT org_id,phase FROM financial_customer_history_birth_observations ORDER BY rowid",
          )
          .all(),
      ).toEqual([
        { org_id: "org:existing", phase: "raw" },
        { org_id: "org:self", phase: "raw" },
      ]);
      expect(
        db
          .query(
            "SELECT change_seq,change_kind,org_id FROM financial_customer_history_org_changes ORDER BY change_seq",
          )
          .all(),
      ).toEqual([
        { change_seq: 1, change_kind: "delete", org_id: "org:existing" },
        { change_seq: 2, change_kind: "update", org_id: "org:self" },
        { change_seq: 3, change_kind: "replace", org_id: "org:self" },
        { change_seq: 4, change_kind: "delete", org_id: "org:self" },
      ]);
      for (const sql of Object.values(ROOT_0105_ORG_CAPTURE_TRIGGERS))
        expect(sql).not.toMatch(
          /money_cutover_(?:freeze|writer_permit|authorized_epoch)|RAISE|rowid|UPDATE financial_|DELETE FROM financial_/iu,
        );
    } finally {
      db.close();
    }
  });

  test("on 0104+0105 with the Money writer: an Org born during capture seals, a later Org is post-seal, an Org change only appends and blocks until the framed close", async () => {
    const db = at0104();
    try {
      db.exec(ROOT_0105_DDL);
      db.query("INSERT INTO stripe_mode_realm VALUES(1,'test',?)").run(AT);
      db.query("INSERT INTO stripe_billing_account_realms VALUES(1,?,'test',?,?)").run(
        root.accountId,
        root.billingAuthority,
        AT,
      );
      db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(root.writerEpoch);
      const raw = createSqliteSql(db);
      const h0 = createHistoryH0Component(createMoneyCutoverSql(raw, root.writerEpoch));
      await raw.run(
        "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:owner','google','subject:owner','owner@invalid.example','Owner',?)",
        [AT],
      );
      await h0.start(root, run);
      await raw.run(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:during','Org','principal:owner',?)",
        [AT],
      );
      for (const [index, item] of run.required.entries())
        await h0.inventory(root, run, item, `inventory:${index}`);
      await h0.seal(root, run, 0);
      await raw.run(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:new','Org','principal:owner',?)",
        [AT],
      );
      expect(
        db
          .query(
            "SELECT org_id,phase,complete_seal_ref FROM financial_customer_history_birth_observations ORDER BY rowid",
          )
          .all(),
      ).toEqual([
        { org_id: "org:during", phase: "during-enrollment", complete_seal_ref: null },
        { org_id: "org:new", phase: "post-seal", complete_seal_ref: run.sealReceiptRef },
      ]);
      // A forged birth for an Org that does not exist is refused.
      expect(() =>
        db.exec(
          "INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase) VALUES('birth:forged','org:none','principal:owner','Org','at','raw')",
        ),
      ).toThrow(/exact Org capture/u);
      // A raw Org change appends an observation and leaves the head sealed.
      await raw.run("UPDATE orgs SET owner_principal_id='principal:other' WHERE id='org:new'");
      expect(db.query("SELECT state FROM financial_history_enrollment_heads").get()).toEqual({
        state: "sealed",
      });
      expect(
        db.query("SELECT change_kind FROM financial_customer_history_org_changes").all(),
      ).toEqual([{ change_kind: "update" }]);
      // A raw head move is refused; the framed Financial close ends the capture.
      await expect(
        raw.run(
          "UPDATE financial_history_enrollment_heads SET state='closed',capture_sequence=capture_sequence+1",
        ),
      ).rejects.toThrow(/permit\/epoch required/u);
      await h0.close(root, run);
      expect(db.query("SELECT state FROM financial_history_enrollment_heads").get()).toEqual({
        state: "closed",
      });
    } finally {
      db.close();
    }
  });
  test("the 0105 backfill is idempotent and writes nothing while a capture is open", () => {
    const db = at0104();
    try {
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:a','A','principal:a','2026-10-14T00:00:00.000Z')",
      );
      db.exec(ROOT_0105_DDL);
      db.exec(ROOT_0105_BIRTH_BACKFILL);
      expect(
        db.query("SELECT org_id,phase FROM financial_customer_history_birth_observations").all(),
      ).toEqual([{ org_id: "org:a", phase: "raw" }]);
      // With a capture open, a later run of the backfill appends nothing.
      db.exec("PRAGMA foreign_keys=OFF");
      for (const trigger of db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='financial_history_enrollment_heads'",
        )
        .all() as { name: string }[])
        db.exec(`DROP TRIGGER ${trigger.name}`);
      db.exec(
        "INSERT INTO financial_history_enrollment_heads VALUES('primary:x','enrollment:x',1,0,'capturing','start:x')",
      );
      for (const trigger of db
        .query("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='orgs'")
        .all() as { name: string }[])
        db.exec(`DROP TRIGGER ${trigger.name}`);
      db.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:b','B','principal:b','2026-10-14T00:00:00.000Z')",
      );
      db.exec(ROOT_0105_BIRTH_BACKFILL);
      expect(count(db)).toBe(1);
    } finally {
      db.close();
    }
  });
  test("on 0104+0105 an Org id with a money row gets no post-seal birth; a brand-new id does", async () => {
    const db = at0104();
    try {
      db.exec(ROOT_0105_DDL);
      db.query("INSERT INTO stripe_mode_realm VALUES(1,'test',?)").run(AT);
      db.query("INSERT INTO stripe_billing_account_realms VALUES(1,?,'test',?,?)").run(
        root.accountId,
        root.billingAuthority,
        AT,
      );
      db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(root.writerEpoch);
      const raw = createSqliteSql(db);
      const h0 = createHistoryH0Component(createMoneyCutoverSql(raw, root.writerEpoch));
      await h0.start(root, run);
      for (const [index, item] of run.required.entries())
        await h0.inventory(root, run, item, `inventory:${index}`);
      await h0.seal(root, run, 0);
      db.exec(
        "INSERT INTO ledger(id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES('ledger:ghost','org:ghost','funding','ref:ghost',1,0,'2000-01-01T00:00:00.000Z')",
      );
      for (const id of ["org:ghost", "org:new"])
        db.query(
          "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,'Org','principal:owner','2000-01-01T00:00:00.000Z')",
        ).run(id);
      expect(
        db.query("SELECT org_id,phase FROM financial_customer_history_birth_observations").all(),
      ).toEqual([{ org_id: "org:new", phase: "post-seal" }]);
    } finally {
      db.close();
    }
  });
  test("at 0104+0105 every Org trace lookup and the Org INSERT trigger's trace check use an index", () => {
    const db = at0104();
    try {
      db.exec(ROOT_0105_DDL);
      for (const table of FINANCIAL_0104_ORG_TRACE_TABLES) {
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
      // The trigger's own trace clause, evaluated as written with NEW.id bound.
      const insert = ROOT_0105_ORG_CAPTURE_TRIGGERS.financial_history_capture_org_insert ?? "";
      const marker = "r.receipt_ref IS NOT NULL AND ";
      const start = insert.indexOf(`${marker}(`) + marker.length;
      const end = insert.indexOf(
        ");\n INSERT INTO financial_customer_history_birth_observations(",
        start,
      );
      expect(start).toBeGreaterThan(marker.length);
      expect(end).toBeGreaterThan(start);
      const clause = insert.slice(start, end).replaceAll("NEW.id", "?1");
      const lines = (
        db.query(`EXPLAIN QUERY PLAN SELECT 1 WHERE ${clause}`).all("org:plan") as {
          detail: string;
        }[]
      ).map((row) => row.detail);
      expect(lines.filter((line) => /^SEARCH m USING/u.test(line))).toHaveLength(
        FINANCIAL_0104_ORG_TRACE_TABLES.length,
      );
      // The only scan is the outer constant row of this probe SELECT itself.
      expect(lines.filter((line) => /^SCAN/u.test(line))).toEqual(["SCAN CONSTANT ROW"]);
    } finally {
      db.close();
    }
  });
});
