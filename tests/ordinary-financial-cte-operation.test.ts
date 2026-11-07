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
    const raw = createSqliteSql(database);
    return { database, raw, sql: createOrdinaryFinancialPublicSql(raw, grammar) };
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
    expect(database.query("SELECT id FROM orgs").all()).toEqual([{ id: "(" }]);
  });

  test(`${grammar} keeps the existing REPLACE refusal after an ordinary CTE`, async () => {
    const { database, sql } = fixture();
    await expect(
      sql.run("WITH ids AS (SELECT ? AS id) REPLACE INTO orgs(id) SELECT id FROM ids", [
        "ordinary-only",
      ]),
    ).rejects.toThrow("ordinary public SQL refused: REPLACE");
    expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
  });

  test(`${grammar} refuses unsupported separators before a raw read`, async () => {
    const { raw } = fixture();
    let queries = 0;
    const sql = createOrdinaryFinancialPublicSql(
      {
        run: raw.run,
        batch: raw.batch,
        async query(...args) {
          queries++;
          return raw.query(...args);
        },
      },
      grammar,
    );
    for (const separator of ["\u00a0", "\uFEFF", "\u3000"])
      await expect(sql.query(`SELECT${separator}1`)).rejects.toThrow("unknown token");
    expect(queries).toBe(0);
  });

  test(`${grammar} retains supported ASCII whitespace and quoted Unicode data`, async () => {
    const { database, sql } = fixture();
    const id = "label\u00a0\uFEFF\u3000";
    const write = await sql.run(
      "INSERT\nINTO\torgs(id)\rVALUES\f('label\u00a0\uFEFF\u3000') RETURNING id",
    );
    expect(write).toEqual({ changes: 1, rows: [{ id }] });
    expect(database.query("SELECT id FROM orgs").all()).toEqual([{ id }]);
  });

  test(`${grammar} documents the quotation rule for an operation-keyword CTE name`, async () => {
    const { database, sql } = fixture();
    await expect(
      sql.run("WITH replace AS (SELECT ? AS id) INSERT INTO orgs(id) SELECT id FROM replace", [
        "unquoted",
      ]),
    ).rejects.toThrow("ordinary public SQL refused: REPLACE");
    expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
    expect(
      await sql.run(
        'WITH "replace" AS (SELECT ? AS id) INSERT INTO orgs(id) SELECT id FROM "replace" RETURNING id',
        ["quoted"],
      ),
    ).toEqual({ changes: 1, rows: [{ id: "quoted" }] });
    expect(database.query("SELECT id FROM orgs").all()).toEqual([{ id: "quoted" }]);
  });

  test(`${grammar} rejects NUL statements before any backing method`, async () => {
    const { raw } = fixture();
    const calls = { query: 0, run: 0, batch: 0 };
    const sql = createOrdinaryFinancialPublicSql(
      {
        async query(...args) {
          calls.query++;
          return raw.query(...args);
        },
        async run(...args) {
          calls.run++;
          return raw.run(...args);
        },
        async batch(...args) {
          calls.batch++;
          return raw.batch(...args);
        },
      },
      grammar,
    );
    const statement = "SELECT 1 --\0";
    await expect(sql.query(statement)).rejects.toThrow("NUL statement");
    await expect(sql.run(statement)).rejects.toThrow("NUL statement");
    await expect(sql.batch([{ sql: statement }])).rejects.toThrow("NUL statement");
    expect(calls).toEqual({ query: 0, run: 0, batch: 0 });
  });

  test(`${grammar} retains NUL within bound data without treating it as SQL`, async () => {
    const { database, sql } = fixture();
    const id = "bound\0data";
    expect(await sql.run("INSERT INTO orgs(id) VALUES(?) RETURNING id", [id])).toEqual({
      changes: 1,
      rows: [{ id }],
    });
    expect(database.query("SELECT id FROM orgs").all()).toEqual([{ id }]);
  });
}
