import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  assertSafeMigrationSql,
  MigrationSqlCapacityError,
  prepareMigrationSql,
} from "../src/providers/sqlite-migration-policy.ts";

const utf8 = (value: string): number => new TextEncoder().encode(value).byteLength;

test("migration preparation returns exact SQLite-complete slices and preserves its source prefix", () => {
  const trigger = [
    ";;; -- empty separators\r\n",
    "CREATE /* between keywords */ TEMP TRIGGER audit_insert AFTER INSERT ON source ",
    "BEGIN\r\n",
    "  INSERT INTO audit VALUES (CASE WHEN NEW.value = 'semi;''quote' THEN 1 ELSE 2 END);\r\n",
    "  /* inner ; comment */ UPDATE audit SET `tick;column` = [bracket;column];\r\n",
    "END;",
  ].join("");
  const quoted = [
    "\r\n/* inter-statement trivia */ SELECT ",
    "'astral 😀; and ''single''' AS \"double;\"\"quote\", ",
    "[bracket;name], `backtick;name`;",
  ].join("");
  const trailingNoOp = "; -- trailing separator and comment\r\n/* done */";
  const sql = trigger + quoted + trailingNoOp;

  const statements = prepareMigrationSql(sql);
  expect(statements).toEqual([trigger, quoted]);
  const preparedPrefix = statements.join("");
  expect(preparedPrefix).toBe(sql.slice(0, preparedPrefix.length));
  expect(sql.slice(preparedPrefix.length)).toBe(trailingNoOp);

  const noFinalSemicolon = "\ufeff\r\nSELECT 'no final; 😀' AS value -- retained comment";
  expect(prepareMigrationSql(noFinalSemicolon)).toEqual([noFinalSemicolon]);
  expect(prepareMigrationSql("")).toEqual([]);
  expect(prepareMigrationSql(";;; -- no executable statement\r\n/* still none */;")).toEqual([]);

  const temporaryTrigger =
    "CREATE /*a*/ TEMPORARY /*b*/ TRIGGER t AFTER INSERT ON source " +
    "BEGIN SELECT CASE WHEN 1 THEN 'END;' ELSE 'x' END; END";
  expect(prepareMigrationSql(temporaryTrigger)).toEqual([temporaryTrigger]);

  const explainedTrigger =
    "EXPLAIN CREATE TRIGGER explained AFTER INSERT ON source BEGIN SELECT 1; END;";
  expect(prepareMigrationSql(explainedTrigger)).toEqual([explainedTrigger]);

  const bomTrigger = "CREATE \ufeffTRIGGER bom_trigger AFTER INSERT ON source BEGIN SELECT 1; END;";
  expect(prepareMigrationSql(bomTrigger)).toEqual([bomTrigger]);
  expect(prepareMigrationSql(bomTrigger)[0]).toContain("\ufeff");
});

test("a BOM is trivia only when SQLite encounters it at a token boundary", () => {
  expect(() => prepareMigrationSql("SELECT 1;\ufeffCOMMIT;")).toThrow();

  const database = new Database(":memory:");
  try {
    database.exec(
      "CREATE TABLE source (value INTEGER); CREATE TABLE audit (value INTEGER NOT NULL)",
    );
    const spaced =
      "CREATE \ufeffTRIGGER bom_trigger AFTER INSERT ON source " +
      "BEGIN INSERT INTO audit VALUES (NEW.value); END;";
    expect(prepareMigrationSql(spaced)).toEqual([spaced]);
    database.exec(spaced);
    database.exec("INSERT INTO source VALUES (7)");
    expect(database.query("SELECT value FROM audit").all()).toEqual([{ value: 7 }]);

    // At an identifier continuation the same code point remains part of the
    // token, matching native SQLite rather than being normalized away.
    const noSpace =
      "CREATE\ufeffTRIGGER invalid_bom_trigger AFTER INSERT ON source " +
      "BEGIN INSERT INTO audit VALUES (9); END;";
    expect(() => prepareMigrationSql(noSpace)).toThrow();
    expect(() => database.exec(noSpace)).toThrow();

    const identifierSql = "CREATE TABLE a\ufeffb (value INTEGER);";
    expect(prepareMigrationSql(identifierSql)).toEqual([identifierSql]);
    database.exec(identifierSql);
    expect(
      database.query("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
    ).toContainEqual({ name: "a\ufeffb" });
  } finally {
    database.close();
  }
});

test("migration preparation refuses incomplete frames and every authority escape", () => {
  const incomplete = [
    "SELECT 'unterminated",
    'SELECT "unterminated',
    "SELECT `unterminated",
    "SELECT [unterminated",
    "SELECT 1; /* unterminated",
    "CREATE TRIGGER t AFTER INSERT ON source BEGIN SELECT 1;",
    "CREATE TEMP TRIGGER t AFTER INSERT ON source BEGIN SELECT CASE WHEN 1 THEN 1 END;",
  ];
  for (const sql of incomplete) expect(() => prepareMigrationSql(sql)).toThrow();

  const forbiddenCommands = [
    "BEGIN",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT nested",
    "RELEASE nested",
    "ATTACH 'other.db' AS other",
    "DETACH other",
    "VACUUM",
  ];
  for (const command of forbiddenCommands) {
    expect(() => prepareMigrationSql(`${command}; SELECT 1`)).toThrow();
  }
  expect(() => prepareMigrationSql("EXPLAIN ATTACH 'other.db' AS other;")).toThrow();
  expect(() => prepareMigrationSql("\ufeffBEGIN; SELECT 1;")).toThrow();

  const forbiddenPolicy = [
    "PRAGMA journal_mode=WAL",
    "PRAGMA main.writable_schema=ON",
    "SELECT * FROM pragma_table_list",
    "CREATE TABLE _takoform_sqlite_migrations (value TEXT)",
    "SELECT * FROM _cf_KV",
    "SELECT load_extension('unsafe')",
  ];
  for (const sql of forbiddenPolicy) expect(() => prepareMigrationSql(sql)).toThrow();

  expect(() =>
    assertSafeMigrationSql(
      "PRAGMA foreign_keys=ON; PRAGMA main.user_version=1; " +
        "CREATE TABLE commit_log (value TEXT DEFAULT 'BEGIN; ATTACH');",
    ),
  ).not.toThrow();
});

test("the native statement capacity is counted from exact UTF-8 slices after full policy scan", () => {
  const maximum = 100_000;
  const shellBytes = utf8("SELECT ''");
  const astralCount = Math.floor((maximum - shellBytes) / 4);
  const asciiPadding = maximum - shellBytes - astralCount * 4;
  const atLimit = `SELECT '${"😀".repeat(astralCount)}${"x".repeat(asciiPadding)}'`;
  expect(utf8(atLimit)).toBe(maximum);
  expect(prepareMigrationSql(atLimit, maximum)).toEqual([atLimit]);

  const overLimit = `${atLimit} `;
  expect(utf8(overLimit)).toBe(maximum + 1);
  try {
    prepareMigrationSql(overLimit, maximum);
    throw new Error("expected a native statement capacity error");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSqlCapacityError);
    expect(error).toMatchObject({
      maximumStatementBytes: maximum,
      actualStatementBytes: maximum + 1,
    });
  }

  // Capacity is reported only after the complete file has been scanned, so a
  // later authority escape is never hidden by an oversized earlier statement.
  try {
    prepareMigrationSql(`${overLimit}; ATTACH 'other.db' AS other;`, maximum);
    throw new Error("expected a migration policy error");
  } catch (error) {
    expect(error).not.toBeInstanceOf(MigrationSqlCapacityError);
  }
});

const WORKERD_COMPLETE_ORACLE = `
import { DurableObject } from "cloudflare:workers";

export class CompleteOracle extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  complete(sql) {
    return this.ctx.storage.sql.ingest(sql);
  }
}

export default {
  async fetch(request, env) {
    const fixtures = await request.json();
    const results = [];
    for (let index = 0; index < fixtures.length; index += 1) {
      const stub = env.ORACLES.getByName("complete-oracle-" + index);
      try {
        results.push({ ok: true, value: await stub.complete(fixtures[index]) });
      } catch (error) {
        results.push({ ok: false, error: String(error) });
      }
    }
    return Response.json(results);
  },
};
`;

test("prepared boundaries agree with the pinned workerd SQLite completion FSM", async () => {
  const fixtures = [
    "SELECT ';' AS single; SELECT 'it''s; ok' AS escaped;",
    [
      "CREATE TABLE source (value TEXT);",
      "CREATE TABLE audit (value TEXT, result INTEGER);",
      "CREATE TRIGGER audit_insert AFTER INSERT ON source BEGIN ",
      "INSERT INTO audit VALUES (NEW.value, CASE WHEN NEW.value = 'a;b' THEN 1 ELSE 2 END); ",
      "UPDATE audit SET value = 'escaped '' quote;'; END;",
      "INSERT INTO source VALUES ('a;b');",
    ].join("\r\n"),
    'CREATE TABLE "odd;table" (`tick;column` TEXT, [bracket;column] TEXT); ' +
      "INSERT INTO \"odd;table\" VALUES ('astral 😀;', 'value');",
    "SELECT 1; -- trailing comment without newline",
    "SELECT 1; /* complete */ SELECT 2",
  ];
  const prepared = fixtures.map((sql) => prepareMigrationSql(sql));

  // `ingest` is used only as a differential oracle under the explicitly
  // experimental flag. Production code uses stable `sql.exec` exclusively.
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "sqlite-complete-oracle",
          type: "worker",
          compatibilityDate: "2026-08-18",
          compatibilityFlags: ["experimental"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: WORKERD_COMPLETE_ORACLE } },
          },
          exports: { CompleteOracle: { type: "durable-object", storage: "sqlite" } },
          env: {
            ORACLES: {
              type: "durable-object",
              workerName: "sqlite-complete-oracle",
              exportName: "CompleteOracle",
            },
          },
          triggers: [],
        },
      },
    ],
  });

  try {
    const response = await runtime.dispatchFetch("https://oracle.example/", {
      method: "POST",
      body: JSON.stringify(fixtures),
    });
    const text = await response.text();
    expect({ status: response.status, text }).toMatchObject({ status: 200 });
    const actual = JSON.parse(text) as (
      | { ok: true; value: { remainder: string; statementCount: number } }
      | { ok: false; error: string }
    )[];
    expect(actual).toHaveLength(fixtures.length);

    for (const [index, result] of actual.entries()) {
      if (!result.ok) throw new Error(`workerd oracle fixture ${index}: ${result.error}`);
      const sql = fixtures[index];
      const statements = prepared[index];
      if (sql === undefined || statements === undefined) throw new Error("missing oracle fixture");
      const completeCount = sql.endsWith("SELECT 2") ? statements.length - 1 : statements.length;
      const preparedBytes = statements
        .slice(0, completeCount)
        .reduce((total, statement) => total + statement.length, 0);
      expect(result.value.statementCount).toBe(completeCount);
      expect(result.value.remainder).toBe(sql.slice(preparedBytes));
    }
  } finally {
    await runtime.dispose();
  }
}, 30_000);
