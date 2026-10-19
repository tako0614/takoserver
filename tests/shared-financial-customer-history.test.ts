import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { canonicalJson } from "../src/json.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  createHistoryH0Component,
  type HistoryEnrollment,
  type HistoryRoot,
  type HistoryScope,
  prepareHistoryInventory,
  prepareHistoryReceiptRead,
  prepareHistorySeal,
  prepareHistoryStart,
} from "../src/shared-financial-customer-history.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { installFinancial0104Fences } from "./helpers/financial-0104-fenced.ts";

const ddl = readFileSync(
  new URL("./fixtures/shared-financial-customer-history-component-schema.sql", import.meta.url),
  "utf8",
);
/** The rest of the 0104 Customer candidates. H0 writes require the whole exact
 * fenced 0104 Customer shape, so the fixture installs it with every fence. */
const customerDdl = [
  "financial-five-action-consent-schema.unnumbered.sql",
  "customer-l1-schema.unnumbered.sql",
  "customer-journal-schema.unnumbered.sql",
].map((file) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
const ownTemporaryDirectories = new Set<string>();
afterEach(() => {
  for (const path of ownTemporaryDirectories) rmSync(path, { recursive: true, force: true });
  ownTemporaryDirectories.clear();
});
const S = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const at = "2026-10-15T12:00:00.000Z";
const tables = [
  "financial_history_primary_roots",
  "financial_history_enrollments",
  "financial_history_enrollment_inventory",
  "financial_history_enrollment_heads",
  "financial_history_enrollment_receipts",
  "financial_customer_history_birth_observations",
];
const profile: { label: string; statements: readonly SqlStatement[] }[] = [];
const root: HistoryRoot = {
  primaryRef: "primary:synthetic",
  primaryIncarnation: "primary-inc:1",
  physicalBindingRef: "binding:fixture",
  physicalBindingIncarnation: "binding-inc:1",
  resourceRef: "resource:fixture",
  lineageEvidenceRef: "lineage:fixture",
  qualificationRef: "qualification:synthetic-unmounted",
  profileRef: "profile:all-writers-fixture",
  accountId: "acct_Synthetic",
  mode: "test",
  billingAuthority: "authority:synthetic",
  financialRealm: `realm:${"a".repeat(64)}`,
  writerEpoch: S("writer"),
};
function scope(
  kind: HistoryScope["scopeKind"],
  ref: string,
  owner: string | null = null,
): HistoryScope {
  return {
    scopeKind: kind,
    originalScopeRef: ref,
    originalScopeIncarnation: `inc:${ref}`,
    sourceRegistrationRef: "registration:synthetic",
    sourceIncarnation: "source-inc:1",
    sourceHeadRef: `head:${ref}`,
    sourceSequence: 1,
    evidenceRef: `evidence:${ref}`,
    evidenceDigest: S(ref),
    fenceRef: ["writer", "credential-alias"].includes(kind) ? `fence:${ref}` : null,
    drainRef: kind === "writer" ? `drain:${ref}` : null,
    drainDisposition: kind === "writer" ? "retained-original" : "not-applicable",
    ownerPrincipalId: owner,
    orgCreatedAt: owner ? at : null,
  };
}
function enrollment(extra: readonly HistoryScope[] = []): HistoryEnrollment {
  return {
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
      ...[
        "customer",
        "topup",
        "subscription",
        "plan",
        "card",
        "on-demand",
        "legacy-settlement",
        "events",
      ].map((n) => scope("writer", n)),
      scope("credential-alias", "alias:current"),
      scope("credential-alias", "alias:retired"),
      scope("retired-namespace", "org:retired", "principal:retired"),
      ...extra,
    ],
  };
}

/** The actual Money writer for the root's own epoch over a fixture transport. */
const money = (transport: Sql) => createMoneyCutoverSql(transport, root.writerEpoch);
function fixture(file = false, fenced = true) {
  const temporaryDirectory = file ? mkdtempSync(join(tmpdir(), "takoserver-history-h0-")) : null;
  if (temporaryDirectory) ownTemporaryDirectories.add(temporaryDirectory);
  const filename = temporaryDirectory ? join(temporaryDirectory, "history.sqlite") : ":memory:";
  const db = new Database(filename),
    raw = createSqliteSql(db);
  for (const m of MIGRATIONS) db.exec(m.sql);
  expect(MIGRATIONS).toHaveLength(100);
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  db.exec(ddl);
  for (const candidate of customerDdl) db.exec(candidate);
  if (fenced) installFinancial0104Fences(db, { customer: true });
  db.exec("PRAGMA recursive_triggers=OFF");
  // Root hands H0 only its Money writer; raw is the fixture transport beneath it.
  const sql = money(raw);
  db.query("INSERT INTO stripe_mode_realm VALUES(1,'test',?)").run(at);
  db.query("INSERT INTO stripe_billing_account_realms VALUES(1,?,'test',?,?)").run(
    root.accountId,
    root.billingAuthority,
    at,
  );
  db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(root.writerEpoch);
  const component = createHistoryH0Component(sql);
  const snapshot = () =>
    JSON.stringify(
      Object.fromEntries(
        [...tables, "orgs", "org_memberships"].map((t) => [
          t,
          db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
        ]),
      ),
    );
  async function org(id = "org:fixture") {
    await sql.run(
      "INSERT OR IGNORE INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:owner','google','subject:owner','owner@invalid.example','Owner',?)",
      [at],
    );
    return sql.run(
      "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,'Org','principal:owner',?)",
      [id, at],
    );
  }
  async function inventory(run = enrollment()) {
    for (const [i, s] of run.required.entries())
      await component.inventory(root, run, s, `inventory:${run.generation}:${i}`);
  }
  async function seal(run = enrollment()) {
    const h = db.query("SELECT capture_sequence FROM financial_history_enrollment_heads").get() as {
      capture_sequence: number;
    };
    return component.seal(root, run, h.capture_sequence);
  }
  return { db, raw, sql, component, snapshot, org, inventory, seal, filename };
}
async function constraint(call: () => Promise<unknown>) {
  let error: unknown;
  try {
    await call();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SqlError);
  expect((error as SqlError).code).toBe("constraint");
}

test("zero Org/A/payer/H1 start, complete typed fixture inventory and mandatory seal", async () => {
  const f = fixture();
  try {
    expect(f.db.query("SELECT COUNT(*) n FROM orgs").get()).toEqual({ n: 0 });
    // The exact 0104 Customer shape holds the payer/H1 tables, but H0 needs and
    // writes none of their rows.
    const dependents = (
      f.db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'financial_payer_%' OR name LIKE 'financial_customer_history_coverages')",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(dependents.length).toBeGreaterThan(0);
    const empty = () =>
      dependents.map((table) => f.db.query(`SELECT COUNT(*) n FROM ${table}`).get());
    expect(empty()).toEqual(dependents.map(() => ({ n: 0 })));
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    const r = await f.seal(run);
    expect(r?.receipt_kind).toBe("complete-seal");
    expect(r?.all_rows_match).toBe(1);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(empty()).toEqual(dependents.map(() => ({ n: 0 })));
    expect(f.db.query("SELECT COUNT(*) n FROM money_cutover_writer_permit").get()).toEqual({
      n: 0,
    });
    profile.push(
      { label: "start", statements: prepareHistoryStart(root, run) },
      {
        label: "inventory",
        statements: [prepareHistoryInventory(root, run, run.required[0]!, "inventory:profile")],
      },
      { label: "seal", statements: prepareHistorySeal(root, run, 0) },
    );
  } finally {
    f.db.close();
  }
});
test("actual Accounts.createOrganization observes only already completed seal, safe metadata is not genesis", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    await f.seal(run);
    const accounts = createAccounts({
      sql: f.sql,
      identity: {
        async verify() {
          return {
            providerSubject: "actual-auth-fixture",
            email: "human@invalid.example",
            displayName: "Human",
          };
        },
      },
      clock: () => new Date(at),
      randomId: () => "fixed-auth-fixture",
    });
    const signed = await accounts.signIn({
      provider: "google",
      assertion: "synthetic-not-genuine-auth",
    });
    const actor = await accounts.authenticate(`Bearer ${signed.sessionToken}`);
    if (!actor) throw Error("fixture actor missing");
    const org = await accounts.createOrganization({ actor, name: "Actual method" });
    const birth = f.db
      .query(
        "SELECT phase,complete_seal_ref,org_id FROM financial_customer_history_birth_observations",
      )
      .get();
    expect(birth).toEqual({
      phase: "post-seal",
      complete_seal_ref: run.sealReceiptRef,
      org_id: org.id,
    });
    expect(f.db.query("SELECT COUNT(*) n FROM org_memberships WHERE org_id=?").get(org.id)).toEqual(
      { n: 1 },
    );
  } finally {
    f.db.close();
  }
});
test("raw and during births stay original after later start and seal", async () => {
  const f = fixture();
  try {
    await f.org("org:raw");
    const raw = f.db.query("SELECT * FROM financial_customer_history_birth_observations").get();
    const run = enrollment([scope("org-namespace", "org:raw", "principal:owner")]);
    await f.component.start(root, run);
    await f.org("org:during");
    await f.inventory(run);
    await f.seal(run);
    expect(
      f.db
        .query("SELECT * FROM financial_customer_history_birth_observations WHERE org_id='org:raw'")
        .get(),
    ).toEqual(raw);
    expect(
      f.db
        .query(
          "SELECT phase,complete_seal_ref FROM financial_customer_history_birth_observations WHERE org_id='org:during'",
        )
        .get(),
    ).toEqual({ phase: "during-enrollment", complete_seal_ref: null });
  } finally {
    f.db.close();
  }
});
test("concurrent birth advances watermark and rejects old seal without upgrading during observation", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    const stale = prepareHistorySeal(root, run, 0);
    await f.org("org:race");
    const before = f.snapshot();
    await constraint(() => f.sql.batch(stale));
    expect(f.snapshot()).toBe(before);
    await f.seal(run);
    expect(
      f.db.query("SELECT phase FROM financial_customer_history_birth_observations").get(),
    ).toEqual({ phase: "during-enrollment" });
  } finally {
    f.db.close();
  }
});
for (const omit of [0, 1, 2])
  test(`start conditional stage ${omit + 1} zero rows rolls back every prefix`, async () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const ss = [...prepareHistoryStart(root, enrollment())];
      ss[omit] = { sql: "SELECT 0 WHERE 0" };
      await constraint(() => f.sql.batch(ss));
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  });
for (const failure of ["NULL", "late-unique"] as const)
  test(`unconditional start receipt ${failure} rolls back root/run/head`, async () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const ss = [...prepareHistoryStart(root, enrollment())];
      if (failure === "NULL")
        ss[3] = { ...ss[3]!, sql: ss[3]!.sql.replace("THEN 1 ELSE NULL", "THEN NULL ELSE NULL") };
      else ss.push(ss[3]!);
      await constraint(() => f.sql.batch(ss));
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  });
test("seal missing any writer/alias/retired/primary inventory rolls back head", async () => {
  for (const kind of ["physical-primary", "writer", "credential-alias", "retired-namespace"]) {
    const f = fixture();
    try {
      const run = enrollment();
      await f.component.start(root, run);
      for (const [i, s] of run.required.entries())
        if (s.scopeKind !== kind) await f.component.inventory(root, run, s, `inventory:${i}`);
      const before = f.snapshot();
      await constraint(() => f.seal(run));
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  }
});
test("wrong source/incarnation/drain and extra inventory cannot substitute original typed scope", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    const s = run.required[1]!;
    for (const changed of [
      { ...s, sourceIncarnation: "foreign:source" },
      { ...s, drainRef: "foreign:drain" },
      { ...s, originalScopeRef: "foreign:writer" },
    ]) {
      const before = f.snapshot();
      const statement = {
        sql: "INSERT INTO financial_history_enrollment_inventory VALUES(?,?,?,?,?,?,?)",
        params: [
          "bad",
          run.enrollmentRef,
          root.primaryRef,
          changed.scopeKind,
          changed.originalScopeRef,
          changed.originalScopeIncarnation,
          canonicalJson(changed),
        ],
      };
      await constraint(() => f.sql.batch([statement]));
      expect(f.snapshot()).toBe(before);
    }
  } finally {
    f.db.close();
  }
});
test("missing local Org exact namespace defeats count-only completeness", async () => {
  const f = fixture();
  try {
    await f.org("org:legacy");
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    const before = f.snapshot();
    await constraint(() => f.seal(run));
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("account/mode mismatch and epoch/freeze await drift fail in original SQL batch", async () => {
  const a = fixture();
  try {
    const wrong = { ...root, accountId: "acct_Foreign" };
    const before = a.snapshot();
    await constraint(() => a.sql.batch(prepareHistoryStart(wrong, enrollment())));
    expect(a.snapshot()).toBe(before);
  } finally {
    a.db.close();
  }
  for (const drift of ["epoch", "freeze"]) {
    const f = fixture();
    try {
      const run = enrollment();
      await f.component.start(root, run);
      await f.inventory(run);
      const planned = prepareHistorySeal(root, run, 0);
      if (drift === "epoch")
        await f.raw.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [S("revoked")]);
      else
        await f.raw.run(
          "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
        );
      const before = f.snapshot();
      await constraint(() => f.sql.batch(planned));
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  }
});
test("birth trigger failure rolls back actual Accounts Org INSERT, no successful fake birth", async () => {
  const f = fixture();
  try {
    await f.org("org:prior");
    const accounts = createAccounts({
      sql: f.sql,
      identity: {
        async verify() {
          return {
            providerSubject: "rollback",
            email: "rollback@invalid.example",
            displayName: "Human",
          };
        },
      },
      clock: () => new Date(at),
      randomId: () => "rollback-fixture",
    });
    const s = await accounts.signIn({ provider: "github", assertion: "synthetic" });
    const actor = await accounts.authenticate(`Bearer ${s.sessionToken}`);
    if (!actor) throw Error("actor");
    const before = f.snapshot();
    f.db.exec(
      "CREATE TRIGGER fixture_birth_fail BEFORE INSERT ON financial_customer_history_birth_observations BEGIN SELECT RAISE(ABORT,'constraint: fixture late birth failure'); END;",
    );
    await constraint(() => accounts.createOrganization({ actor, name: "Should rollback" }));
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("retired namespace and same-ID OR REPLACE retain all raw/post-seal observations with recursive OFF", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    await f.seal(run);
    await f.org("org:retired");
    const first = f.db.query("SELECT * FROM financial_customer_history_birth_observations").get();
    await f.sql.run(
      "INSERT OR REPLACE INTO orgs(id,name,owner_principal_id,created_at)VALUES('org:retired','Replacement','principal:owner',?)",
      [at],
    );
    expect(
      f.db
        .query(
          "SELECT COUNT(*) n FROM financial_customer_history_birth_observations WHERE org_id='org:retired'",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      f.db
        .query("SELECT * FROM financial_customer_history_birth_observations ORDER BY rowid LIMIT 1")
        .get(),
    ).toEqual(first);
    expect(
      f.db
        .query(
          "SELECT COUNT(*) n FROM financial_history_enrollment_inventory WHERE scope_kind='retired-namespace'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(f.db.query("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
  } finally {
    f.db.close();
  }
});
test("Org UPDATE/DELETE close capture without deleting original root/run/seal/birth", async () => {
  for (const verb of [
    "UPDATE orgs SET name='Changed' WHERE id='org:fixture'",
    "DELETE FROM orgs WHERE id='org:fixture'",
  ]) {
    const f = fixture();
    try {
      const run = enrollment();
      await f.component.start(root, run);
      await f.inventory(run);
      await f.seal(run);
      await f.org();
      await f.sql.run(verb);
      expect(f.db.query("SELECT state FROM financial_history_enrollment_heads").get()).toEqual({
        state: "closed",
      });
      expect(await f.component.receipt(run.sealReceiptRef)).not.toBeNull();
      expect(
        f.db.query("SELECT COUNT(*) n FROM financial_customer_history_birth_observations").get(),
      ).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  }
});
test("all retained PK/UNIQUE replacement victims, UPDATE and DELETE survive recursive OFF", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    await f.seal(run);
    await f.org();
    for (const table of tables) {
      const before = f.snapshot();
      const row = f.db.query(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string, unknown>;
      const keys = Object.keys(row);
      const params = keys.map((k) => row[k] as string | number | null);
      await constraint(() =>
        f.sql.run(
          `INSERT OR REPLACE INTO ${table}(${keys.join(",")})VALUES(${keys.map(() => "?").join(",")})`,
          params,
        ),
      );
      expect(f.snapshot()).toBe(before);
      if (table !== "financial_history_enrollment_heads") {
        await constraint(() => f.sql.run(`UPDATE ${table} SET ${keys[0]}=${keys[0]}`));
        expect(f.snapshot()).toBe(before);
      }
      await constraint(() => f.sql.run(`DELETE FROM ${table}`));
      expect(f.snapshot()).toBe(before);
      // Foreign PK but same other UNIQUE must not erase original childless/history victim.
      if (keys.length > 1) {
        const changed = [...params];
        changed[0] = `different:${table}`;
        await constraint(() =>
          f.sql.run(
            `INSERT OR REPLACE INTO ${table}(${keys.join(",")})VALUES(${keys.map(() => "?").join(",")})`,
            changed,
          ),
        );
        expect(f.snapshot()).toBe(before);
      }
    }
  } finally {
    f.db.close();
  }
});
test("NULL qualified birth provenance is rejected and original history unchanged", async () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    await constraint(() =>
      f.sql.run(
        "INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase)VALUES('birth:forged','org:forged','owner','name',?,'post-seal')",
        [at],
      ),
    );
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("committed DB ACK is actually dropped, then original replay uses retained rows without current auth", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    let drop = true;
    // The ACK is dropped by the transport beneath Root's Money writer.
    const transport: Sql = {
      query: (q, p) => f.raw.query(q, p),
      run: (q, p) => f.raw.run(q, p),
      async batch(s) {
        const r = await f.raw.batch(s);
        if (drop) {
          drop = false;
          throw new SqlError("unavailable", "synthetic ACK drop after actual commit");
        }
        return r;
      },
    };
    const sql = money(transport);
    await expect(createHistoryH0Component(sql).start(root, run)).rejects.toMatchObject({
      code: "unavailable",
    });
    const before = f.snapshot();
    await createHistoryH0Component(sql).start(root, run);
    expect(f.snapshot()).toBe(before);
    await f.inventory(run);
    await f.seal(run);
    await f.raw.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [S("revoked")]);
    const after = f.snapshot();
    await createHistoryH0Component(f.sql).seal(root, run, 0);
    expect(f.snapshot()).toBe(after);
    await constraint(() =>
      createHistoryH0Component(f.sql).start({ ...root, profileRef: "different:profile" }, run),
    );
    expect(f.snapshot()).toBe(after);
  } finally {
    f.db.close();
  }
});
test("adapter close and reopen is durable recovery, not OS restart or ACK-drop proof", async () => {
  const f = fixture(true);
  const run = enrollment();
  await f.component.start(root, run);
  await f.inventory(run);
  await f.seal(run);
  const before = f.snapshot();
  f.db.close();
  const db = new Database(f.filename);
  try {
    const sql = money(createSqliteSql(db));
    expect(await createHistoryH0Component(sql).seal(root, run, 0)).not.toBeNull();
    expect(
      JSON.stringify(
        Object.fromEntries(
          [...tables, "orgs", "org_memberships"].map((t) => [
            t,
            db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
          ]),
        ),
      ),
    ).toBe(before);
  } finally {
    db.close();
  }
});
test("closed prior seal remains readable after next enrollment; old run never reactivated", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    await f.seal(run);
    await f.org();
    await f.sql.run("DELETE FROM orgs");
    const original = await f.component.receipt(run.sealReceiptRef);
    const next: HistoryEnrollment = {
      ...enrollment(),
      enrollmentRef: "enrollment:2",
      enrollmentIncarnation: "enrollment-inc:2",
      generation: 2,
      startReceiptRef: "receipt:start2",
      sealReceiptRef: "receipt:seal2",
      previousStartReceiptRef: run.startReceiptRef,
      previousSealRef: run.sealReceiptRef,
    };
    await f.component.start(root, next);
    expect(await f.component.receipt(run.sealReceiptRef)).toEqual(original);
    const before = f.snapshot();
    await constraint(() =>
      f.sql.run(
        "UPDATE financial_history_enrollment_heads SET enrollment_ref=?,generation=1,state='capturing',expected_receipt_ref=?",
        [run.enrollmentRef, run.startReceiptRef],
      ),
    );
    expect(f.snapshot()).toBe(before);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.db.close();
  }
});
test("closed input syntax rejects incomplete/empty DTO without minting genuine profile", () => {
  const run = enrollment();
  for (const bad of [
    { ...run, required: [] },
    { ...run, required: run.required.filter((s) => s.scopeKind !== "writer") },
    { ...run, required: [...run.required, run.required[0]!] },
    {
      ...run,
      required: run.required.map((s) => (s.scopeKind === "writer" ? { ...s, drainRef: null } : s)),
    },
  ])
    expect(() => prepareHistoryStart(root, bad)).toThrow(SqlError);
  expect(() => prepareHistoryStart({ ...root, qualificationRef: "" }, run)).toThrow(SqlError);
  expect(() =>
    prepareHistoryStart(root, {
      ...run,
      required: run.required.map((s) =>
        s.scopeKind === "physical-primary"
          ? { ...s, originalScopeIncarnation: "foreign:physical-inc" }
          : s,
      ),
    }),
  ).toThrow(SqlError);
});
test("same batch Org-before-seal remains during, partial sealed head cannot qualify its birth", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    await f.sql.run(
      "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:owner','google','same-batch','same@invalid.example','Owner',?)",
      [at],
    );
    const org: SqlStatement = {
      sql: "INSERT INTO orgs(id,name,owner_principal_id,created_at)VALUES('org:samebatch','Same','principal:owner',?)",
      params: [at],
    };
    await f.sql.batch([org, ...prepareHistorySeal(root, run, 1)]);
    expect(
      f.db
        .query("SELECT phase,complete_seal_ref FROM financial_customer_history_birth_observations")
        .get(),
    ).toEqual({ phase: "during-enrollment", complete_seal_ref: null });
    expect(await f.component.receipt(run.sealReceiptRef)).not.toBeNull();
  } finally {
    f.db.close();
  }
  const g = fixture();
  try {
    const run = enrollment();
    await g.component.start(root, run);
    await g.inventory(run);
    await g.sql.run(
      "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:owner','google','partial','partial@invalid.example','Owner',?)",
      [at],
    );
    const before = g.snapshot();
    const seal = prepareHistorySeal(root, run, 0);
    await constraint(() =>
      g.sql.batch([
        seal[0]!,
        {
          sql: "INSERT INTO orgs(id,name,owner_principal_id,created_at)VALUES('org:partial','Partial','principal:owner',?)",
          params: [at],
        },
        seal[1]!,
      ]),
    );
    expect(g.snapshot()).toBe(before);
  } finally {
    g.db.close();
  }
});
test("childless unique victims survive INSERT OR REPLACE on every root/enrollment alternate key", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    const ss = prepareHistoryStart(root, run);
    await f.sql.run(ss[0]!.sql, ss[0]!.params);
    const rootRow = f.db.query("SELECT * FROM financial_history_primary_roots").get() as Record<
      string,
      string
    >;
    const rootKeys = Object.keys(rootRow);
    for (const keep of [
      ["primary_ref"],
      ["primary_incarnation"],
      ["physical_binding_ref", "physical_binding_incarnation"],
    ]) {
      const candidate = {
        ...rootRow,
        primary_ref: "different:root",
        primary_incarnation: "different:inc",
        physical_binding_ref: "different:binding",
        physical_binding_incarnation: "different:binding-inc",
      };
      for (const key of keep) candidate[key as keyof typeof candidate] = rootRow[key]!;
      (candidate as typeof candidate & { root_json: string }).root_json = canonicalJson({
        ...root,
        primaryRef: candidate.primary_ref,
        primaryIncarnation: candidate.primary_incarnation,
        physicalBindingRef: candidate.physical_binding_ref,
        physicalBindingIncarnation: candidate.physical_binding_incarnation,
      });
      const before = f.snapshot();
      await constraint(() =>
        f.sql.run(
          `INSERT OR REPLACE INTO financial_history_primary_roots(${rootKeys.join(",")})VALUES(${rootKeys.map(() => "?").join(",")})`,
          rootKeys.map((k) => candidate[k as keyof typeof candidate]),
        ),
      );
      expect(f.snapshot()).toBe(before);
    }
    await f.sql.run(ss[1]!.sql, ss[1]!.params);
    const row = f.db.query("SELECT * FROM financial_history_enrollments").get() as Record<
      string,
      string | number | null
    >;
    const keys = Object.keys(row);
    for (const keep of [
      ["enrollment_ref"],
      ["enrollment_incarnation"],
      ["primary_ref", "generation"],
      ["expected_start_receipt_ref"],
      ["expected_seal_ref"],
    ]) {
      const candidate = {
        ...row,
        enrollment_ref: "other:run",
        enrollment_incarnation: "other:inc",
        generation: 2,
        expected_start_receipt_ref: "other:start",
        expected_seal_ref: "other:seal",
      };
      for (const key of keep)
        (candidate as Record<string, string | number | null>)[key] = row[key]!;
      const before = f.snapshot();
      await constraint(() =>
        f.sql.run(
          `INSERT OR REPLACE INTO financial_history_enrollments(${keys.join(",")})VALUES(${keys.map(() => "?").join(",")})`,
          keys.map((k) => (candidate as Record<string, string | number | null>)[k]!),
        ),
      );
      expect(f.snapshot()).toBe(before);
    }
  } finally {
    f.db.close();
  }
});
test("same-original concurrent start has one winner and loser retains original without new key", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    const result = await Promise.allSettled([
      f.component.start(root, run),
      createHistoryH0Component(f.sql).start(root, run),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const before = f.snapshot();
    expect(await f.component.start(root, run)).not.toBeNull();
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("selected mode mismatch fails start in SQL and leaves all component tables empty", async () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    await constraint(() =>
      f.sql.batch(prepareHistoryStart({ ...root, mode: "live" }, enrollment())),
    );
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("finite H0 query binding profiles stay within the local component limit", () => {
  expect(profile.length).toBe(3);
  for (const group of profile)
    for (const s of group.statements) expect((s.params ?? []).length).toBeLessThanOrEqual(100);
});

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { wait, seen, release, reached };
}
function queryBarrier(sql: Sql) {
  const barrier = gate();
  let once = true;
  const wrapped: Sql = {
    query: async (q, params) => {
      const rows = await sql.query(q, params);
      if (once && q.includes("financial_history_enrollment_receipts")) {
        once = false;
        barrier.reached();
        await barrier.wait;
      }
      return rows;
    },
    run: (q, params) => sql.run(q, params),
    batch: (s) => sql.batch(s),
  };
  return { barrier, wrapped };
}
function batchBarrier(sql: Sql) {
  const barrier = gate();
  const wrapped: Sql = {
    query: (q, params) => sql.query(q, params),
    run: (q, params) => sql.run(q, params),
    batch: async (s) => {
      const rows = await sql.batch(s);
      barrier.reached();
      await barrier.wait;
      return rows;
    },
  };
  return { barrier, wrapped };
}
async function completeAndClose(f: ReturnType<typeof fixture>, run: HistoryEnrollment) {
  await f.component.start(root, run);
  await f.inventory(run);
  await f.seal(run);
  await f.org("org:close");
  await f.sql.run("DELETE FROM orgs WHERE id='org:close'");
}

for (const mutation of ["UPDATE orgs SET name='Changed'", "DELETE FROM orgs"]) {
  test(`closed unsealed first capture recaptures after actual ${mutation.split(" ")[0]} without fake seal`, async () => {
    const f = fixture();
    try {
      const first = enrollment();
      await f.component.start(root, first);
      await f.org("org:interrupted");
      await f.sql.run(mutation);
      const oldStart = await f.component.receipt(first.startReceiptRef);
      if (!oldStart) throw new Error("fixture original start missing");
      expect(await f.component.receipt(first.sealReceiptRef)).toBeNull();
      const extra = mutation.startsWith("UPDATE")
        ? [scope("org-namespace", "org:interrupted", "principal:owner")]
        : [];
      const next: HistoryEnrollment = {
        ...enrollment(extra),
        enrollmentRef: "run:2",
        enrollmentIncarnation: "inc:2",
        generation: 2,
        startReceiptRef: "start:2",
        sealReceiptRef: "seal:2",
        previousStartReceiptRef: first.startReceiptRef,
        previousSealRef: null,
      };
      await f.component.start(root, next);
      await f.inventory(next);
      expect((await f.seal(next))?.receipt_kind).toBe("complete-seal");
      expect(await f.component.receipt(first.startReceiptRef)).toEqual(oldStart);
      expect(await f.component.receipt(first.sealReceiptRef)).toBeNull();
      expect(await f.component.start(root, first)).toEqual(oldStart);
      const before = f.snapshot();
      await constraint(() => f.component.seal(root, first, 0));
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  });
}
test("next enrollment binds actual closed predecessor start, generation, primary and optional exact completed seal", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await completeAndClose(f, run);
    const next: HistoryEnrollment = {
      ...enrollment(),
      enrollmentRef: "run:2",
      enrollmentIncarnation: "inc:2",
      generation: 2,
      startReceiptRef: "start:2",
      sealReceiptRef: "seal:2",
      previousStartReceiptRef: run.startReceiptRef,
      previousSealRef: run.sealReceiptRef,
    };
    for (const bad of [
      { ...next, previousStartReceiptRef: run.sealReceiptRef },
      { ...next, previousSealRef: null },
      { ...next, generation: 3 },
    ]) {
      const before = f.snapshot();
      await constraint(() => f.component.start(root, bad));
      expect(f.snapshot()).toBe(before);
    }
    const otherRoot: HistoryRoot = {
      ...root,
      primaryRef: "primary:other",
      primaryIncarnation: "primary-inc:other",
      physicalBindingRef: "binding:other",
    };
    const other: HistoryEnrollment = {
      ...enrollment(),
      enrollmentRef: "run:other",
      enrollmentIncarnation: "inc:other",
      startReceiptRef: "start:other",
      sealReceiptRef: "seal:other",
      required: enrollment().required.map((x) =>
        x.scopeKind === "physical-primary"
          ? {
              ...x,
              originalScopeRef: otherRoot.primaryRef,
              originalScopeIncarnation: otherRoot.primaryIncarnation,
            }
          : x,
      ),
    };
    await f.component.start(otherRoot, other);
    const before = f.snapshot();
    await constraint(() =>
      f.component.start(root, { ...next, previousStartReceiptRef: other.startReceiptRef }),
    );
    expect(f.snapshot()).toBe(before);
    await f.component.start(root, next);
    const opened = f.snapshot();
    await constraint(() =>
      f.component.start(root, {
        ...next,
        enrollmentRef: "run:3",
        enrollmentIncarnation: "inc:3",
        generation: 3,
        startReceiptRef: "start:3",
        sealReceiptRef: "seal:3",
        previousStartReceiptRef: next.startReceiptRef,
        previousSealRef: null,
      }),
    );
    expect(f.snapshot()).toBe(opened);
  } finally {
    f.db.close();
  }
});
test("cross-role refs and prefix staging cannot borrow another run/phase receipt", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await completeAndClose(f, run);
    const next: HistoryEnrollment = {
      ...enrollment(),
      enrollmentRef: "run:2",
      enrollmentIncarnation: "inc:2",
      generation: 2,
      startReceiptRef: "start:2",
      sealReceiptRef: "seal:2",
      previousStartReceiptRef: run.startReceiptRef,
      previousSealRef: run.sealReceiptRef,
    };
    for (const bad of [
      { ...next, startReceiptRef: run.sealReceiptRef },
      { ...next, sealReceiptRef: run.startReceiptRef },
    ]) {
      const before = f.snapshot();
      await constraint(() => f.sql.batch(prepareHistoryStart(root, bad).slice(0, 2)));
      expect(f.snapshot()).toBe(before);
      await constraint(() => f.component.start(root, bad));
      expect(f.snapshot()).toBe(before);
      await constraint(() => f.component.seal(root, bad, 0));
      expect(f.snapshot()).toBe(before);
    }
    await f.sql.batch(prepareHistoryStart(root, next).slice(0, 2));
    const staging = f.snapshot();
    expect(await f.component.receipt(next.startReceiptRef)).toBeNull();
    await constraint(() =>
      f.component.start(root, { ...next, startReceiptRef: run.sealReceiptRef }),
    );
    expect(f.snapshot()).toBe(staging);
  } finally {
    f.db.close();
  }
});
test("strict original receipt keeps own replay after later head, rejects wrong watermark/full tuple", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await completeAndClose(f, run);
    const saved = await f.component.receipt(run.sealReceiptRef);
    if (!saved) throw new Error("fixture original seal missing");
    await f.raw.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [S("revoked")]);
    const before = f.snapshot();
    expect(await f.component.seal(root, run, 0)).toEqual(saved);
    await constraint(() => f.component.seal(root, run, 1));
    await constraint(() =>
      f.component.seal(
        { ...root, primaryIncarnation: "foreign:inc" },
        {
          ...run,
          required: run.required.map((scope) =>
            scope.scopeKind === "physical-primary"
              ? { ...scope, originalScopeIncarnation: "foreign:inc" }
              : scope,
          ),
        },
        0,
      ),
    );
    await constraint(() =>
      f.component.seal(root, { ...run, enrollmentIncarnation: "foreign:run" }, 0),
    );
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
for (const method of ["start", "seal"] as const)
  test(`preawait snapshot prevents nested required-input repair in ${method} saved lookup`, async () => {
    const f = fixture();
    try {
      const run = enrollment();
      await f.component.start(root, run);
      if (method === "seal") {
        await f.inventory(run);
        await f.seal(run);
      }
      const mutable = JSON.parse(JSON.stringify(run)) as HistoryEnrollment;
      const expected = mutable.required[1]!.sourceHeadRef;
      (mutable.required[1] as { sourceHeadRef: string }).sourceHeadRef = "head:wrong-at-entry";
      const { barrier, wrapped } = queryBarrier(f.raw);
      const api = createHistoryH0Component(money(wrapped));
      const before = f.snapshot();
      const pending = method === "start" ? api.start(root, mutable) : api.seal(root, mutable, 0);
      const outcome = pending.then(
        () => ({ ok: true, error: null }),
        (error: unknown) => ({ ok: false, error }),
      );
      await barrier.seen;
      (mutable.required[1] as { sourceHeadRef: string }).sourceHeadRef = expected;
      barrier.release();
      const observed = await outcome;
      expect(observed.ok).toBe(false);
      expect(observed.error).toMatchObject({ code: "constraint" });
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  });
test("postcommit mutation of root/run cannot redirect start readback to an older original", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await completeAndClose(f, run);
    const mutable: HistoryEnrollment = {
      ...enrollment(),
      enrollmentRef: "run:2",
      enrollmentIncarnation: "inc:2",
      generation: 2,
      startReceiptRef: "start:2",
      sealReceiptRef: "seal:2",
      previousStartReceiptRef: run.startReceiptRef,
      previousSealRef: run.sealReceiptRef,
    };
    const mutableRoot = { ...root };
    const { barrier, wrapped } = batchBarrier(f.raw);
    const pending = createHistoryH0Component(money(wrapped)).start(mutableRoot, mutable);
    await barrier.seen;
    Object.assign(mutable, run);
    mutableRoot.profileRef = "profile:changed-after-commit";
    barrier.release();
    const saved = await pending;
    expect(saved?.receipt_ref).toBe("start:2");
    expect(saved?.enrollment_ref).toBe("run:2");
  } finally {
    f.db.close();
  }
});
test("postcommit seal mutation cannot substitute old ref or nested original selection", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.inventory(run);
    const mutable = JSON.parse(JSON.stringify(run)) as HistoryEnrollment;
    const { barrier, wrapped } = batchBarrier(f.raw);
    const pending = createHistoryH0Component(money(wrapped)).seal(root, mutable, 0);
    await barrier.seen;
    (mutable as { sealReceiptRef: string }).sealReceiptRef = run.startReceiptRef;
    (mutable.required[1] as { sourceHeadRef: string }).sourceHeadRef = "head:changed-after-commit";
    barrier.release();
    expect((await pending)?.receipt_ref).toBe(run.sealReceiptRef);
  } finally {
    f.db.close();
  }
});
for (const raw of [
  "2026-10-15 12:00:00",
  "+010000-01-01T00:00:00.000Z",
  "-000001-01-01T00:00:00.000Z",
  "",
]) {
  test(`legacy raw namespace TEXT retained exactly: ${JSON.stringify(raw)}`, async () => {
    const f = fixture();
    try {
      await f.org("org:legacy");
      await f.sql.run("UPDATE orgs SET created_at=? WHERE id='org:legacy'", [raw]);
      const run = enrollment([
        { ...scope("org-namespace", "org:legacy", "principal:owner"), orgCreatedAt: raw },
      ]);
      await f.component.start(root, run);
      await f.inventory(run);
      const saved = await f.seal(run);
      expect(saved?.receipt_kind).toBe("complete-seal");
      expect(f.db.query("SELECT created_at FROM orgs").get()).toEqual({ created_at: raw });
      const before = f.snapshot();
      expect(await f.seal(run)).toEqual(saved);
      await constraint(() =>
        f.component.start(root, {
          ...run,
          required: run.required.map((x) =>
            x.scopeKind === "org-namespace" ? { ...x, orgCreatedAt: at } : x,
          ),
        }),
      );
      expect(f.snapshot()).toBe(before);
    } finally {
      f.db.close();
    }
  });
}
test("actual Accounts Clock extended-year original remains legal before H0; raw value mismatch still blocks seal", async () => {
  const f = fixture();
  try {
    const raw = "+010000-01-01T00:00:00.000Z";
    const accounts = createAccounts({
      sql: f.sql,
      identity: {
        async verify() {
          return {
            providerSubject: "extended-clock",
            email: "extended@invalid.example",
            displayName: "Human",
          };
        },
      },
      clock: () => new Date(raw),
      randomId: () => "extended-clock",
    });
    const signed = await accounts.signIn({ provider: "google", assertion: "fixture" });
    const actor = await accounts.authenticate(`Bearer ${signed.sessionToken}`);
    if (!actor) throw Error("fixture actor");
    const org = await accounts.createOrganization({ actor, name: "Extended" });
    expect(org.createdAt).toBe(raw);
    const run = enrollment([
      { ...scope("org-namespace", org.id, org.ownerPrincipalId), orgCreatedAt: org.createdAt },
    ]);
    await f.component.start(root, run);
    await f.inventory(run);
    expect((await f.seal(run))?.receipt_kind).toBe("complete-seal");
  } finally {
    f.db.close();
  }
  const g = fixture();
  try {
    await g.org("org:mismatch");
    await g.sql.run("UPDATE orgs SET created_at='legacy raw' WHERE id='org:mismatch'");
    const run = enrollment([
      { ...scope("org-namespace", "org:mismatch", "principal:owner"), orgCreatedAt: at },
    ]);
    await g.component.start(root, run);
    await g.inventory(run);
    const before = g.snapshot();
    await constraint(() => g.seal(run));
    expect(g.snapshot()).toBe(before);
  } finally {
    g.db.close();
  }
});
test("strict receipt and next-generation query profiles remain finite", () => {
  const run = enrollment();
  profile.push({
    label: "strict-receipts",
    statements: [
      prepareHistoryReceiptRead(root, run, "capture-start", null),
      prepareHistoryReceiptRead(root, run, "complete-seal", 0),
    ],
  });
  const next: HistoryEnrollment = {
    ...enrollment(),
    enrollmentRef: "run:2",
    enrollmentIncarnation: "inc:2",
    generation: 2,
    startReceiptRef: "start:2",
    sealReceiptRef: "seal:2",
    previousStartReceiptRef: run.startReceiptRef,
    previousSealRef: null,
  };
  profile.push({ label: "recapture-start", statements: prepareHistoryStart(root, next) });
  expect(profile.length).toBe(5);
});

test("H0 writes refuse raw Sql and a foreign Money writer before any SQL, and commit only inside the writer", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    const first = run.required[0];
    if (!first) throw new Error("fixture scope missing");
    const calls: string[] = [];
    const counted: Sql = {
      async query(q, p) {
        calls.push("query");
        return f.raw.query(q, p);
      },
      async run(q, p) {
        calls.push("run");
        return f.raw.run(q, p);
      },
      async batch(s) {
        calls.push("batch");
        return f.raw.batch(s);
      },
    };
    const before = f.snapshot();
    for (const sql of [counted, f.raw, createMoneyCutoverSql(counted, S("foreign"))]) {
      const component = createHistoryH0Component(sql);
      await expect(component.start(root, run)).rejects.toThrow("Root's Money writer");
      await expect(component.inventory(root, run, first, "inventory:raw")).rejects.toThrow(
        "Root's Money writer",
      );
      await expect(component.seal(root, run, 0)).rejects.toThrow("Root's Money writer");
    }
    expect(calls).toEqual([]);
    expect(f.snapshot()).toBe(before);
    // Outside the permit frame every prepared H0 statement is refused by its fence.
    await constraint(() => f.raw.batch(prepareHistoryStart(root, run)));
    expect(f.snapshot()).toBe(before);
    // Inside the actual writer for the root's own epoch the same statements commit.
    expect((await f.sql.batch(prepareHistoryStart(root, run))).map((x) => x.changes)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(f.db.query("SELECT COUNT(*) n FROM money_cutover_writer_permit").get()).toEqual({
      n: 0,
    });
  } finally {
    f.db.close();
  }
});
test("unfenced H0 shape stays readable for recovery but every write is refused, even inside the writer", async () => {
  const fenced = fixture();
  const run = enrollment();
  try {
    await fenced.component.start(root, run);
    await fenced.inventory(run);
    const saved = await fenced.seal(run);
    const first = run.required[0];
    if (!first) throw new Error("fixture scope missing");
    // Drop one H0 fence: the original receipt remains a GET, a new write is refused.
    fenced.db.exec("DROP TRIGGER financial_history_enrollment_receipts_money_fence");
    expect(await fenced.component.seal(root, run, 0)).toEqual(saved);
    const rows = fenced.snapshot();
    await expect(
      fenced.component.inventory(root, run, first, "inventory:after-unfence"),
    ).rejects.toThrow("exact fenced shape");
    expect(fenced.snapshot()).toBe(rows);
  } finally {
    fenced.db.close();
  }
  // The unfenced candidate: freeze, a foreign epoch or raw Sql never write.
  const f = fixture(false, false);
  try {
    const before = f.snapshot();
    await f.raw.run(
      "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
    );
    await expect(f.component.start(root, run)).rejects.toThrow("exact fenced shape");
    await f.raw.run("DELETE FROM money_cutover_freeze");
    await expect(f.component.start(root, run)).rejects.toThrow("exact fenced shape");
    await expect(createHistoryH0Component(f.raw).start(root, run)).rejects.toThrow(
      "Root's Money writer",
    );
    await expect(
      createHistoryH0Component(createMoneyCutoverSql(f.raw, S("foreign"))).start(root, run),
    ).rejects.toThrow("Root's Money writer");
    expect(f.snapshot()).toBe(before);
  } finally {
    f.db.close();
  }
});
test("epoch-bound H0 fences refuse a current permit for another epoch and roll the whole batch back", async () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    const rotated = S("rotated");
    await f.raw.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [rotated]);
    await constraint(() =>
      createMoneyCutoverSql(f.raw, rotated).batch(prepareHistoryStart(root, enrollment())),
    );
    expect(f.snapshot()).toBe(before);
    expect(f.db.query("SELECT COUNT(*) n FROM money_cutover_writer_permit").get()).toEqual({
      n: 0,
    });
  } finally {
    f.db.close();
  }
});
test("forged birth rows and head closes are refused outside the frame; the Org cascade still captures", async () => {
  const f = fixture();
  try {
    const run = enrollment();
    await f.component.start(root, run);
    await f.raw.run(
      "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
    );
    const before = f.snapshot();
    // A raw birth row with no matching Org, or disagreeing with the current head, is refused.
    await constraint(() =>
      f.raw.run(
        "INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase,primary_ref,enrollment_ref,capture_sequence) VALUES('birth:forged','org:none','principal:owner','Org',?,'during-enrollment',?,?,1)",
        [at, root.primaryRef, run.enrollmentRef],
      ),
    );
    // A raw close (the Org UPDATE/DELETE cascade's shape) needs Root's Money frame.
    await constraint(() =>
      f.raw.run(
        "UPDATE financial_history_enrollment_heads SET state='closed',capture_sequence=capture_sequence+1",
      ),
    );
    expect(f.snapshot()).toBe(before);
    // Root's Org INSERT cascade still captures outside the frame, even frozen.
    await f.raw.run(
      "INSERT OR IGNORE INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:owner','google','subject:owner','owner@invalid.example','Owner',?)",
      [at],
    );
    await f.raw.run(
      "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:frozen','Org','principal:owner',?)",
      [at],
    );
    expect(
      f.db
        .query(
          "SELECT phase,capture_sequence FROM financial_customer_history_birth_observations WHERE org_id='org:frozen'",
        )
        .all(),
    ).toEqual([{ phase: "during-enrollment", capture_sequence: 1 }]);
    // A forged copy of that row cannot be appended at the same capture.
    await constraint(() =>
      f.raw.run(
        "INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase,primary_ref,enrollment_ref,capture_sequence) VALUES('birth:copy','org:frozen','principal:owner','Org',?,'during-enrollment',?,?,1)",
        [at, root.primaryRef, run.enrollmentRef],
      ),
    );
    // An Org change during capture closes it only inside Root's unfrozen Money frame.
    await constraint(() => f.raw.run("UPDATE orgs SET name='Changed' WHERE id='org:frozen'"));
    await constraint(() => f.sql.run("UPDATE orgs SET name='Changed' WHERE id='org:frozen'"));
    await f.raw.run("DELETE FROM money_cutover_freeze");
    await f.sql.run("UPDATE orgs SET name='Changed' WHERE id='org:frozen'");
    expect(f.db.query("SELECT state FROM financial_history_enrollment_heads").get()).toEqual({
      state: "closed",
    });
  } finally {
    f.db.close();
  }
});
