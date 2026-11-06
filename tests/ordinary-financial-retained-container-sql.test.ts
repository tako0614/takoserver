import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createV2ContainerHostAcceptance,
  V2_CONTAINER_F2_FORM,
} from "../src/takoform-v2/container-owner-schema.ts";
import {
  redeemV2HostAcceptance,
  type V2HostDeleteAcceptanceContext,
} from "../src/takoform-v2/host-acceptance.ts";

// This is a syntax-to-catalog counterexample. It never supplies native authority,
// returns a catalog, executes a batch, or claims actual Container DELETE success.
for (const { name, form } of [
  { name: "F1", form: CONTAINER_CONTRACT.formUrl },
  { name: "F2", form: V2_CONTAINER_F2_FORM },
]) {
  test(`unchanged ${name} issuer DELETE terminal reaches the ordinary catalog fence`, async () => {
    const catalogBoundary = new Error("synthetic catalog boundary reached; no DB submitted");
    const calls = { query: 0, run: 0, batch: 0 };
    const raw: Sql = {
      async query() {
        calls.query++;
        throw catalogBoundary;
      },
      async run() {
        calls.run++;
        throw new Error("body write not permitted");
      },
      async batch() {
        calls.batch++;
        throw new Error("body batch not permitted");
      },
    };
    const sql = createOrdinaryFinancialPublicSql(raw, "retained-container");
    const host = createV2ContainerHostAcceptance({
      sql,
      installationId: "synthetic-installation",
      backendId: "synthetic-backend",
      targetKey: "synthetic-target",
    });
    const context: V2HostDeleteAcceptanceContext = Object.freeze({
      action: "delete",
      principal: "synthetic-principal",
      key: "synthetic-original-key",
      fingerprint: "synthetic-fingerprint",
      operationId: "synthetic-operation",
      resourceUid: "synthetic-resource",
      generation: 2,
      at: "2026-11-06T00:00:00.000Z",
      retainUntil: "2026-11-07T00:00:00.000Z",
      form,
      space: "synthetic-space",
      name: "synthetic-name",
      backendId: "synthetic-backend",
      targetKey: "synthetic-target",
      specJson: JSON.stringify({
        image: `registry.example/image@sha256:${"d".repeat(64)}`,
        httpPort: 8080,
        healthPath: "/",
        workloadRevision: "v1",
        requiredSensitiveVars: [],
        outboundInternet: true,
      }),
      outputJson: "{}",
      referencesJson: null,
    });
    host.assertSql(sql);
    const prepareDelete = host.prepareDelete;
    if (prepareDelete === undefined) throw new Error("owning DELETE method unavailable");
    const prepared = await prepareDelete.call(host, context);
    expect(prepared).toBeDefined();
    if (prepared === undefined) throw new Error("owning DELETE preparation unavailable");
    const original = redeemV2HostAcceptance(prepared, sql, context);
    expect(calls).toEqual({ query: 0, run: 0, batch: 0 });
    const originalDigest = createHash("sha256")
      .update(JSON.stringify(original.terminal))
      .digest("hex");
    await expect(sql.batch([original.terminal])).rejects.toBe(catalogBoundary);
    expect(calls).toEqual({ query: 1, run: 0, batch: 0 });
    expect(createHash("sha256").update(JSON.stringify(original.terminal)).digest("hex")).toBe(
      originalDigest,
    );
  });
}

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(
  extra = "",
  grammar: "ordinary" | "retained-container" = "retained-container",
  wrap: (raw: Sql, database: Database) => Sql = (raw) => raw,
) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE financial_source_events(id TEXT PRIMARY KEY); ${extra}`);
  const raw = wrap(createSqliteSql(db), db);
  return { db, raw, sql: createOrdinaryFinancialPublicSql(raw, grammar) };
}
function count(db: Database, table = "orgs"): number {
  const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get();
  if (row === null) throw new Error("synthetic count row missing");
  return row.n;
}

test("direct retained INSERT preserves original statement, params and ACK", async () => {
  let submitted: readonly SqlStatement[] | undefined;
  const f = fixture("", "retained-container", (base) => ({
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      if (statements[0]?.sql.startsWith("INSERT")) submitted = statements;
      return base.batch(statements);
    },
  }));
  const original = {
    sql: "INSERT OR ABORT INTO main.orgs(id,name) VALUES(?,?) RETURNING id,name",
    params: ["one", "kept"],
  };
  const result = await f.sql.batch([original]);
  expect(result).toEqual([{ rows: [{ id: "one", name: "kept" }], changes: 1 }]);
  expect(submitted).toHaveLength(2); // original body + unchanged catalog guard
  expect(submitted?.[0]).toEqual(original);
  expect(count(f.db)).toBe(1);
});

test("bare OR ABORT and existing IGNORE keep their distinct conflict behavior", async () => {
  const f = fixture();
  expect((await f.sql.run("INSERT OR ABORT INTO orgs(id) VALUES('one')")).changes).toBe(1);
  expect((await f.sql.run("INSERT OR IGNORE INTO orgs(id) VALUES('one')")).changes).toBe(0);
  await expect(f.sql.run("INSERT OR ABORT INTO orgs(id) VALUES('one')")).rejects.toThrow();
  expect(count(f.db)).toBe(1);
});

test("ordinary/default caller retains old grammar and existing IGNORE", async () => {
  const f = fixture("", "ordinary");
  await expect(f.sql.run("INSERT OR ABORT INTO orgs(id) VALUES('one')")).rejects.toThrow(
    "INSERT conflict mode",
  );
  await expect(f.sql.run("INSERT INTO main.orgs(id) VALUES('one')")).rejects.toThrow(
    "qualified target",
  );
  expect((await f.sql.run("INSERT OR IGNORE INTO orgs(id) VALUES('one')")).changes).toBe(1);
  expect(count(f.db)).toBe(1);
});

test("default one-argument factory does not silently select retained grammar", async () => {
  const f = fixture();
  const originalDefault = createOrdinaryFinancialPublicSql(f.raw);
  await expect(
    originalDefault.run("INSERT OR ABORT INTO main.orgs(id) VALUES('one')"),
  ).rejects.toThrow("INSERT conflict mode");
  expect(count(f.db)).toBe(0);
});

test("CTE keeps old acceptance while terminal new syntax stays refused", async () => {
  const f = fixture();
  await expect(
    f.sql.run("WITH x AS (SELECT 'bad' AS id) INSERT OR ABORT INTO main.orgs(id) SELECT id FROM x"),
  ).rejects.toThrow("INSERT conflict mode");
  await expect(
    f.sql.run("WITH x AS (SELECT 'bad' AS id) INSERT INTO main.orgs(id) SELECT id FROM x"),
  ).rejects.toThrow("qualified target");
  expect(count(f.db)).toBe(0);
  expect(
    (await f.sql.run("WITH x AS (SELECT 'one' AS id) INSERT INTO orgs(id) SELECT id FROM x"))
      .changes,
  ).toBe(1);
});

test("retained recognition does not broaden qualified UPDATE or DELETE", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO orgs VALUES('one','original')");
  await expect(f.sql.run("UPDATE main.orgs SET name='bad' WHERE id='one'")).rejects.toThrow(
    "qualified target",
  );
  await expect(f.sql.run("DELETE FROM main.orgs WHERE id='one'")).rejects.toThrow(
    "qualified target",
  );
  expect(f.db.query("SELECT name FROM orgs").get()).toEqual({ name: "original" });
  expect((await f.sql.run("UPDATE orgs SET name='two' WHERE id='one'")).changes).toBe(1);
  expect((await f.sql.run("DELETE FROM orgs WHERE id='one'")).changes).toBe(1);
});

test("foreign, temp, quoted, multipart targets and other conflict modes refuse", async () => {
  const f = fixture();
  for (const statement of [
    "INSERT INTO temp.orgs(id) VALUES('bad')",
    "INSERT INTO attached.orgs(id) VALUES('bad')",
    "INSERT INTO \"main\".orgs(id) VALUES('bad')",
    "INSERT INTO main.\"orgs\"(id) VALUES('bad')",
    "INSERT INTO main.orgs.extra(id) VALUES('bad')",
    "INSERT INTO main..orgs(id) VALUES('bad')",
    "INSERT OR REPLACE INTO main.orgs(id) VALUES('bad')",
    "INSERT OR FAIL INTO main.orgs(id) VALUES('bad')",
    "INSERT OR ROLLBACK INTO main.orgs(id) VALUES('bad')",
    "INSERT OR \"ABORT\" INTO main.orgs(id) VALUES('bad')",
  ])
    await expect(f.sql.run(statement)).rejects.toThrow("ordinary public SQL refused");
  expect(count(f.db)).toBe(0);
});

test("the newly recognized direct syntax still denies protected targets", async () => {
  const f = fixture();
  for (const statement of [
    "INSERT OR ABORT INTO main.financial_source_events(id) VALUES('bad')",
    "INSERT OR ABORT INTO financial_source_events(id) VALUES('bad')",
    "INSERT INTO main.financial_source_events(id) VALUES('bad')",
  ])
    await expect(f.sql.run(statement)).rejects.toThrow("protected write");
  expect(count(f.db, "financial_source_events")).toBe(0);
});

test("trigger body OR ABORT does not inherit retained top-level syntax", async () => {
  const f = fixture(`CREATE TABLE ordinary_stage(id TEXT);
    CREATE TRIGGER unchanged AFTER INSERT ON orgs BEGIN
      INSERT OR ABORT INTO ordinary_stage(id) VALUES(NEW.id);
    END;`);
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('bad')")).rejects.toThrow(
    "INSERT conflict mode",
  );
  expect(count(f.db)).toBe(0);
  expect(count(f.db, "ordinary_stage")).toBe(0);
});

test("retained direct syntax cannot transitively trigger a protected write", async () => {
  const f = fixture(`CREATE TABLE ordinary_stage(id TEXT);
    CREATE TRIGGER first AFTER INSERT ON orgs BEGIN INSERT INTO ordinary_stage(id) VALUES(NEW.id); END;
    CREATE TRIGGER second AFTER INSERT ON ordinary_stage BEGIN INSERT INTO financial_source_events(id) VALUES(NEW.id); END;`);
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('bad')")).rejects.toThrow(
    "protected write",
  );
  expect(count(f.db)).toBe(0);
  expect(count(f.db, "ordinary_stage")).toBe(0);
  expect(count(f.db, "financial_source_events")).toBe(0);
});

test("existing FK cascade denial remains active under retained grammar", async () => {
  const f = fixture(`CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE financial_ordinary_retained_r1_receipts(id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);`);
  f.db.exec(
    "INSERT INTO parent VALUES('one'); INSERT INTO financial_ordinary_retained_r1_receipts VALUES('one')",
  );
  await expect(f.sql.run("DELETE FROM parent WHERE id='one'")).rejects.toThrow("protected write");
  expect(count(f.db, "parent")).toBe(1);
  expect(count(f.db, "financial_ordinary_retained_r1_receipts")).toBe(1);
});

test("explicit ABORT retains original batch atomic rollback", async () => {
  const f = fixture();
  await expect(
    f.sql.batch([
      { sql: "INSERT OR ABORT INTO main.orgs(id) VALUES('one')" },
      { sql: "INSERT OR ABORT INTO main.orgs(id) VALUES('one')" },
    ]),
  ).rejects.toThrow();
  expect(count(f.db)).toBe(0);
});

test("Money control references remain refused before metadata or body", async () => {
  const f = fixture();
  await expect(
    f.sql.run(
      "INSERT OR ABORT INTO main.orgs(id) SELECT writer_epoch FROM money_cutover_writer_permit",
    ),
  ).rejects.toThrow("Money cutover control reference");
  expect(count(f.db)).toBe(0);
});

test("temporary shadow catalog still refuses explicit main target", async () => {
  const f = fixture();
  f.db.exec("CREATE TEMP TABLE orgs(id TEXT)");
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('bad')")).rejects.toThrow(
    "temporary catalog",
  );
  expect(count(f.db, "main.orgs")).toBe(0);
  expect(count(f.db, "temp.orgs")).toBe(0);
});

test("catalog drift after preflight still rolls the body back", async () => {
  let bodyBatches = 0;
  const f = fixture("", "retained-container", (base, db) => ({
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      if (statements[0]?.sql.startsWith("INSERT")) {
        bodyBatches++;
        db.exec("CREATE TABLE late_catalog_entry(id TEXT)");
      }
      return base.batch(statements);
    },
  }));
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('bad')")).rejects.toThrow();
  expect(bodyBatches).toBe(1);
  expect(count(f.db)).toBe(0);
});

test("missing post-commit ACK rejects without retry or a zero-effect claim", async () => {
  let bodyBatches = 0;
  const f = fixture("", "retained-container", (base) => ({
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      const results = await base.batch(statements);
      if (!statements[0]?.sql.startsWith("INSERT")) return results;
      bodyBatches++;
      return results.slice(0, -1);
    },
  }));
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('one')")).rejects.toThrow(
    "acknowledgement missing",
  );
  expect(bodyBatches).toBe(1);
  expect(count(f.db)).toBe(1);
});

test("captured raw-method replacement is still refused before a body batch", async () => {
  const f = fixture();
  f.raw.run = async () => ({ rows: [], changes: 0 });
  await expect(f.sql.run("INSERT OR ABORT INTO main.orgs(id) VALUES('bad')")).rejects.toThrow();
  expect(count(f.db)).toBe(0);
});
