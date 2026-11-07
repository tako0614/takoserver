import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(schema: string, grammar: "ordinary" | "retained-container" = "ordinary") {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON; ${schema}`);
  const original = createSqliteSql(database);
  let batches = 0;
  const sql = createOrdinaryFinancialPublicSql(
    {
      query: original.query,
      run: original.run,
      async batch(statements) {
        batches++;
        return original.batch(statements);
      },
    },
    grammar,
  );
  return { database, sql, batches: () => batches };
}

test("table-declared replacement cannot cascade a bare INSERT into protected receipts", async () => {
  const f = fixture(`
    CREATE TABLE parent(id TEXT PRIMARY KEY ON CONFLICT REPLACE, value TEXT);
    CREATE TABLE financial_ordinary_retained_r1_receipts(
      id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);
    INSERT INTO parent VALUES ('p','original');
    INSERT INTO financial_ordinary_retained_r1_receipts VALUES ('p');
  `);
  await expect(
    f.sql.run("INSERT INTO parent(id,value) VALUES (?,?)", ["p", "replacement"]),
  ).rejects.toThrow("table conflict mode");
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([{ id: "p", value: "original" }]);
  expect(f.database.query("SELECT * FROM financial_ordinary_retained_r1_receipts").all()).toEqual([
    { id: "p" },
  ]);
  expect(f.batches()).toBe(1);
});

for (const grammar of ["ordinary", "retained-container"] as const) {
  for (const definition of [
    "id TEXT, value TEXT, PRIMARY KEY(id) ON CONFLICT REPLACE",
    "id TEXT PRIMARY KEY, value TEXT UNIQUE ON CONFLICT REPLACE",
    "id TEXT PRIMARY KEY, value TEXT, UNIQUE(value) ON CONFLICT REPLACE",
    "id TEXT PRIMARY KEY ON /* policy */ CONFLICT -- split words\n REPLACE, value TEXT",
  ]) {
    test(`${grammar} refuses schema replacement policy: ${definition}`, async () => {
      const f = fixture(
        `CREATE TABLE parent(${definition});
         CREATE TABLE financial_ordinary_retained_r1_receipts(
           id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);
         INSERT INTO parent VALUES ('p','original');
         INSERT INTO financial_ordinary_retained_r1_receipts VALUES ('p');`,
        grammar,
      );
      await expect(
        f.sql.run("INSERT INTO parent(id,value) VALUES (?,?)", ["p", "original"]),
      ).rejects.toThrow("table conflict mode");
      expect(f.database.query("SELECT * FROM parent").all()).toEqual([
        { id: "p", value: "original" },
      ]);
      expect(
        f.database.query("SELECT * FROM financial_ordinary_retained_r1_receipts").all(),
      ).toEqual([{ id: "p" }]);
      expect(f.batches()).toBe(1);
    });
  }

  test(`${grammar} refuses UPDATE replacement before a protected cascade`, async () => {
    const f = fixture(
      `CREATE TABLE parent(id TEXT PRIMARY KEY, value TEXT UNIQUE ON CONFLICT REPLACE);
       CREATE TABLE financial_ordinary_retained_r1_receipts(
         id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);
       INSERT INTO parent VALUES ('p','one'),('q','two');
       INSERT INTO financial_ordinary_retained_r1_receipts VALUES ('q');`,
      grammar,
    );
    await expect(f.sql.run("UPDATE parent SET value='two' WHERE id='p'")).rejects.toThrow(
      "table conflict mode",
    );
    expect(f.database.query("SELECT * FROM parent ORDER BY id").all()).toEqual([
      { id: "p", value: "one" },
      { id: "q", value: "two" },
    ]);
    expect(f.database.query("SELECT * FROM financial_ordinary_retained_r1_receipts").all()).toEqual(
      [{ id: "q" }],
    );
    expect(f.batches()).toBe(1);
  });
}

test("NOT NULL replacement is conservatively unsupported even with an explicit conflict override", async () => {
  const f = fixture(`CREATE TABLE parent(
    id TEXT PRIMARY KEY, value TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'replacement');`);
  await expect(
    f.sql.run("INSERT OR IGNORE INTO parent(id,value) VALUES ('p',NULL)"),
  ).rejects.toThrow("table conflict mode");
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([]);
  expect(f.batches()).toBe(1);
});

test("a trigger-reached replacement table refuses before either row is written", async () => {
  const f = fixture(`
    CREATE TABLE orgs(id TEXT PRIMARY KEY);
    CREATE TABLE parent(id TEXT PRIMARY KEY ON CONFLICT REPLACE);
    CREATE TABLE financial_ordinary_retained_r1_receipts(
      id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);
    INSERT INTO parent VALUES ('p');
    INSERT INTO financial_ordinary_retained_r1_receipts VALUES ('p');
    CREATE TRIGGER relay AFTER INSERT ON orgs BEGIN INSERT INTO parent VALUES (NEW.id); END;
  `);
  await expect(f.sql.run("INSERT INTO orgs VALUES ('p')")).rejects.toThrow("table conflict mode");
  expect(f.database.query("SELECT * FROM orgs").all()).toEqual([]);
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([{ id: "p" }]);
  expect(f.database.query("SELECT * FROM financial_ordinary_retained_r1_receipts").all()).toEqual([
    { id: "p" },
  ]);
  expect(f.batches()).toBe(1);
});

test("an UPDATE cascade reaching a replacement table refuses before its body", async () => {
  const f = fixture(`
    CREATE TABLE root(id TEXT PRIMARY KEY);
    CREATE TABLE parent(id TEXT PRIMARY KEY,
      root_id TEXT UNIQUE ON CONFLICT REPLACE REFERENCES root(id) ON UPDATE CASCADE);
    INSERT INTO root VALUES ('r');
    INSERT INTO parent VALUES ('p','r');
  `);
  await expect(f.sql.run("UPDATE root SET id='next' WHERE id='r'")).rejects.toThrow(
    "table conflict mode",
  );
  expect(f.database.query("SELECT * FROM root").all()).toEqual([{ id: "r" }]);
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([{ id: "p", root_id: "r" }]);
  expect(f.batches()).toBe(1);
});

for (const definition of [
  "id TEXT PRIMARY KEY, note TEXT DEFAULT 'ON CONFLICT REPLACE'",
  "id TEXT PRIMARY KEY /* ON CONFLICT REPLACE */, note TEXT",
  'id TEXT PRIMARY KEY, "ON CONFLICT REPLACE" TEXT',
  "id TEXT PRIMARY KEY, `ON CONFLICT REPLACE` TEXT",
  "id TEXT PRIMARY KEY, [ON CONFLICT REPLACE] TEXT",
]) {
  test(`non-keyword replacement text is not a catalog policy: ${definition}`, async () => {
    const f = fixture(`CREATE TABLE parent(${definition});`);
    const result = await f.sql.run("INSERT INTO parent(id) VALUES ('p') RETURNING id");
    expect(result.changes).toBe(1);
    expect(result.rows).toEqual([{ id: "p" }]);
    expect(f.batches()).toBe(2);
  });
}

test("catalog lexical analysis retains its catalog bound for long literal defaults", async () => {
  const value = "ON CONFLICT REPLACE ".repeat(6_000);
  const f = fixture(`CREATE TABLE parent(id TEXT PRIMARY KEY, note TEXT DEFAULT '${value}');`);
  const result = await f.sql.run("INSERT INTO parent(id) VALUES ('p') RETURNING id");
  expect(result.rows).toEqual([{ id: "p" }]);
  expect(f.database.query<{ note: string }, []>("SELECT note FROM parent").get()?.note).toBe(value);
  expect(f.batches()).toBe(2);
});

test("an unrelated replacement table does not block ordinary writes or safe DELETE", async () => {
  const f = fixture(`
    CREATE TABLE parent(id TEXT PRIMARY KEY ON CONFLICT REPLACE);
    CREATE TABLE orgs(id TEXT PRIMARY KEY);
    INSERT INTO parent VALUES ('p');
  `);
  const inserted = await f.sql.run("INSERT INTO orgs VALUES ('o') RETURNING id");
  const removed = await f.sql.run("DELETE FROM parent WHERE id='p' RETURNING id");
  expect(inserted.rows).toEqual([{ id: "o" }]);
  expect(removed.rows).toEqual([{ id: "p" }]);
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([]);
});

test("catalog inspection preserves safe unquoted Unicode column identifiers", async () => {
  const f = fixture("CREATE TABLE parent(id TEXT PRIMARY KEY, 列 TEXT DEFAULT 'present');");
  const result = await f.sql.run("INSERT INTO parent(id) VALUES ('p') RETURNING id");
  expect(result.rows).toEqual([{ id: "p" }]);
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([{ id: "p", 列: "present" }]);
});

test("Unicode identifier bytes are not ASCII SQL keyword separators in catalog DDL", async () => {
  const f = fixture(
    "CREATE TABLE parent(id TEXT PRIMARY KEY, ON\u00a0CONFLICT\u00a0REPLACE TEXT);",
  );
  const result = await f.sql.run("INSERT INTO parent(id) VALUES ('p') RETURNING id");
  expect(result.rows).toEqual([{ id: "p" }]);
});

test("catalog Unicode support does not broaden the caller statement grammar", async () => {
  const f = fixture("CREATE TABLE parent(id TEXT PRIMARY KEY, 列 TEXT);");
  await expect(f.sql.run("INSERT INTO parent(id,列) VALUES ('p','value')")).rejects.toThrow(
    "unknown token",
  );
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([]);
  expect(f.batches()).toBe(0);
});

test("Unicode catalog identifiers cannot hide an actual replacement policy", async () => {
  const f = fixture("CREATE TABLE parent(id TEXT PRIMARY KEY ON CONFLICT REPLACE, 列 TEXT);");
  await expect(f.sql.run("INSERT INTO parent(id) VALUES ('p')")).rejects.toThrow(
    "table conflict mode",
  );
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([]);
  expect(f.batches()).toBe(1);
});

test("SQLite BOM tokens cannot conceal a table replacement policy", async () => {
  const f = fixture(
    "CREATE TABLE parent(id TEXT PRIMARY KEY ON \uFEFFCONFLICT \uFEFFREPLACE, value TEXT);",
  );
  await expect(f.sql.run("INSERT INTO parent(id) VALUES ('p')")).rejects.toThrow(
    "table conflict mode",
  );
  expect(f.database.query("SELECT * FROM parent").all()).toEqual([]);
  expect(f.batches()).toBe(1);
});
