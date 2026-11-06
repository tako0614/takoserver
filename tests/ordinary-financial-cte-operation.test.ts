import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

for (const grammar of ["ordinary", "retained-container"] as const) {
  function fixture() {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`CREATE TABLE orgs(id TEXT PRIMARY KEY);
      CREATE TABLE financial_source_events(id TEXT PRIMARY KEY)`);
    return { database, sql: createOrdinaryFinancialPublicSql(createSqliteSql(database), grammar) };
  }

  test(`${grammar} distinguishes a quoted CTE name from the outer operation`, async () => {
    const { database, sql } = fixture();
    await expect(
      sql.batch([
        {
          sql: 'WITH "SELECT" AS (SELECT 1) INSERT INTO financial_source_events(id) VALUES(?)',
          params: ["synthetic-only"],
        },
      ]),
    ).rejects.toThrow("protected write");
    expect(database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
      n: 0,
    });
  });

  test(`${grammar} retains ordinary safe CTE writes with a quoted name`, async () => {
    const { database, sql } = fixture();
    const writes = await sql.batch([
      {
        sql: 'WITH "SELECT" AS (SELECT ? AS id) INSERT INTO orgs(id) SELECT id FROM "SELECT" RETURNING id',
        params: ["kept"],
      },
    ]);
    expect(writes).toEqual([{ changes: 1, rows: [{ id: "kept" }] }]);
    expect(database.query("SELECT id FROM orgs").all()).toEqual([{ id: "kept" }]);
  });

  test(`${grammar} counts only actual parenthesis tokens in a benign CTE`, async () => {
    const { database, sql } = fixture();
    const write = await sql.run(
      "WITH labels AS (SELECT '(' AS label) INSERT INTO orgs(id) SELECT label FROM labels RETURNING id",
    );
    expect(write).toEqual({ changes: 1, rows: [{ id: "(" }] });
    expect(database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
      n: 0,
    });
  });
}
