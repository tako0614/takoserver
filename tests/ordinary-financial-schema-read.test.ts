import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import { assertOrgBillingSchema } from "../src/org-billing.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(
  grammar: "ordinary" | "retained-container" = "ordinary",
  wrap: (sql: Sql, database: Database) => Sql = (sql) => sql,
) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT)");
  const raw = wrap(createSqliteSql(database), database);
  return { database, raw, sql: createOrdinaryFinancialPublicSql(raw, grammar) };
}

for (const grammar of ["ordinary", "retained-container"] as const) {
  test(`${grammar} runs the actual billing schema reader without any write`, async () => {
    const database = new Database(":memory:");
    databases.push(database);
    migrateSqlite(database);
    const base = createSqliteSql(database);
    let writes = 0;
    const sql = createOrdinaryFinancialPublicSql(
      {
        query: base.query,
        async run(...args) {
          writes++;
          return base.run(...args);
        },
        async batch(...args) {
          writes++;
          return base.batch(...args);
        },
      },
      grammar,
    );
    await assertOrgBillingSchema(sql);
    expect(writes).toBe(0);
  });
}

test("table_info uses the captured query exactly once after the TEMP check", async () => {
  const queries: string[] = [];
  const f = fixture("ordinary", (base) => ({
    run: base.run,
    batch: base.batch,
    async query(sql, params) {
      queries.push(sql);
      return base.query(sql, params);
    },
  }));
  const statement = "pragma table_info(orgs);";
  const rows = await f.sql.query(statement);
  expect(rows.map((row) => row.name)).toEqual(["id", "name"]);
  expect(queries).toEqual(["SELECT count(*) AS n FROM sqlite_temp_schema", statement]);
});

test("other PRAGMA shapes refuse before any raw query or write", async () => {
  let calls = 0;
  const f = fixture("retained-container", (base) => ({
    async query(...args) {
      calls++;
      return base.query(...args);
    },
    async run(...args) {
      calls++;
      return base.run(...args);
    },
    async batch(...args) {
      calls++;
      return base.batch(...args);
    },
  }));
  for (const statement of [
    "PRAGMA foreign_keys = OFF",
    "PRAGMA writable_schema = ON",
    "PRAGMA table_xinfo(orgs)",
    "PRAGMA main.table_info(orgs)",
    "PRAGMA table_info(main.orgs)",
    "PRAGMA table_info('orgs')",
    'PRAGMA table_info("orgs")',
    "PRAGMA table_info '(' orgs ')'",
    "PRAGMA table_info(?)",
    "PRAGMA table_info(orgs,ledger)",
    "PRAGMA table_info(orgs) = 1",
    "PRAGMA table_info(orgs); DELETE FROM orgs",
    "PRAGMA table_info(money_cutover_freeze)",
  ])
    await expect(f.sql.query(statement)).rejects.toThrow("ordinary public SQL refused");
  expect(calls).toBe(0);
});

test("run and batch never inherit the query-only schema allowance", async () => {
  const f = fixture();
  await expect(f.sql.run("PRAGMA table_info(orgs)")).rejects.toThrow("statement kind");
  await expect(f.sql.batch([{ sql: "PRAGMA table_info(orgs)" }])).rejects.toThrow("statement kind");
});

test("schema read keeps TEMP rejection and post-query method reassertion", async () => {
  const temp = fixture();
  temp.database.exec("CREATE TEMP TABLE shadow(id TEXT)");
  await expect(temp.sql.query("PRAGMA table_info(orgs)")).rejects.toThrow("temporary catalog");
  const drift = fixture("ordinary", (base) => ({
    run: base.run,
    batch: base.batch,
    async query(sql, params) {
      const result = await base.query(sql, params);
      if (sql.startsWith("PRAGMA")) drift.raw.batch = async () => [];
      return result;
    },
  }));
  await expect(drift.sql.query("PRAGMA table_info(orgs)")).rejects.toThrow("raw SQL drift");
});

test("malformed schema read acknowledgement refuses instead of becoming empty", async () => {
  const f = fixture("ordinary", (base) => ({
    run: base.run,
    batch: base.batch,
    async query(sql, params) {
      return sql.startsWith("PRAGMA") ? [null as never] : base.query(sql, params);
    },
  }));
  await expect(f.sql.query("PRAGMA table_info(orgs)")).rejects.toThrow(
    "query acknowledgement malformed",
  );
});
