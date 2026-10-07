import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { createSelfhostV2SqlitePlane } from "../src/providers/selfhost-v2-sqlite-plane.ts";

test("Host-injected SQLite handle executes one safe statement with bound values", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  database.exec("CREATE TABLE _takoform_sqlite_migrations (sequence INTEGER)");
  database.exec("CREATE TABLE audit (value TEXT NOT NULL)");
  database.exec("ATTACH DATABASE ':memory:' AS other");
  database.exec("CREATE TABLE other.secret (value TEXT NOT NULL)");
  database.exec(
    "CREATE TRIGGER item_audit AFTER INSERT ON item BEGIN INSERT INTO audit(value) VALUES ('ATTACH; DROP; PRAGMA'); END",
  );
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  try {
    expect(
      await plane.execute("INSERT INTO item (id, value) VALUES (?1, ?2)", [7, "safe; -- value"]),
    ).toEqual({ rows: [], rowsWritten: 1 });
    expect(
      await plane.query(
        "SELECT id, value FROM item WHERE id = ?1 /* trailing comment */; -- end",
        [7],
      ),
    ).toEqual({ rows: [{ id: 7, value: "safe; -- value" }], rowsWritten: 0 });
    expect(await plane.execute("SELECT 'attach; pragma' AS safe /* DROP TABLE */")).toEqual({
      rows: [{ safe: "attach; pragma" }],
      rowsWritten: 0,
    });
    expect(
      await plane.query(
        "SELECT 1 AS [attach], 'safe' AS \"sqlite_schema\" /* ; DROP TABLE item; load_extension */",
      ),
    ).toEqual({ rows: [{ attach: 1, sqlite_schema: "safe" }], rowsWritten: 0 });
    expect(await plane.query("SELECT value FROM audit")).toEqual({
      rows: [{ value: "ATTACH; DROP; PRAGMA" }],
      rowsWritten: 0,
    });

    for (const sql of [
      "SELECT 1; SELECT 2",
      "CREATE TABLE forbidden (id INTEGER)",
      "BEGIN",
      "SAVEPOINT forbidden",
      "ATTACH DATABASE ':memory:' AS other",
      "DETACH main",
      "VACUUM",
      "PRAGMA user_version",
      "SELECT * FROM pragma_table_info('item')",
      "SELECT load_extension('x')",
      "SELECT name FROM sqlite_schema",
      "SELECT * FROM _takoform_sqlite_migrations",
      "SELECT value FROM other.secret",
      "INSERT INTO _takoform_sqlite_migrations VALUES (1)",
    ]) {
      await expect(plane.execute(sql)).rejects.toMatchObject({ name: "sql_error" });
    }
  } finally {
    plane.close();
  }
});

test("query always rolls back while a transaction commits atomically or rolls back on failure", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  try {
    expect(
      await plane.query("INSERT INTO item VALUES (?1, ?2) RETURNING id", [1, "query"]),
    ).toEqual({ rows: [{ id: 1 }], rowsWritten: 0 });
    expect(await plane.query("SELECT count(*) AS count FROM item")).toEqual({
      rows: [{ count: 0 }],
      rowsWritten: 0,
    });

    expect(
      await plane.transaction([
        { sql: "INSERT INTO item VALUES (?1, ?2) RETURNING id", params: [2, "first"] },
        { sql: "INSERT INTO item VALUES (?1, ?2) RETURNING id", params: [3, "second"] },
      ]),
    ).toEqual({
      results: [
        { rows: [{ id: 2 }], rowsWritten: 1 },
        { rows: [{ id: 3 }], rowsWritten: 1 },
      ],
    });

    await expect(
      plane.transaction([
        { sql: "INSERT INTO item VALUES (?1, ?2)", params: [4, "rolled-back"] },
        { sql: "INSERT INTO item VALUES (?1, ?2)", params: [4, "constraint"] },
      ]),
    ).rejects.toMatchObject({ name: "sql_error" });
    await expect(plane.execute("SELECT 1 AS duplicate, 2 AS duplicate")).rejects.toMatchObject({
      name: "sql_error",
    });
    await expect(
      plane.transaction([
        { sql: "INSERT INTO item VALUES (?1, ?2)", params: [5, "duplicate-rollback"] },
        { sql: "SELECT 1 AS duplicate, 2 AS duplicate" },
      ]),
    ).rejects.toMatchObject({ name: "sql_error" });
    expect(await plane.query("SELECT id, value FROM item ORDER BY id")).toEqual({
      rows: [
        { id: 2, value: "first" },
        { id: 3, value: "second" },
      ],
      rowsWritten: 0,
    });
  } finally {
    plane.close();
  }
});

test("portable values preserve base64 blobs, reject malformed inputs, and refuse unsafe integers", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE item (value TEXT NOT NULL, payload BLOB NOT NULL)");
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  try {
    const blob = { encoding: "base64", data: "AAH/gA==" } as const;
    expect(await plane.execute("INSERT INTO item VALUES (?1, ?2)", ["portable", blob])).toEqual({
      rows: [],
      rowsWritten: 1,
    });
    expect(await plane.query("SELECT value, payload FROM item")).toEqual({
      rows: [{ value: "portable", payload: blob }],
      rowsWritten: 0,
    });

    await expect(plane.execute("SELECT 9223372036854775807 AS value")).rejects.toMatchObject({
      name: "numeric_out_of_range",
    });
    expect(await plane.query("SELECT value FROM item")).toEqual({
      rows: [{ value: "portable" }],
      rowsWritten: 0,
    });
    await expect(plane.execute("SELECT 1", [true as unknown as null])).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      plane.execute("SELECT 1", [{ encoding: "base64", data: "AA===" } as never]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      plane.execute("SELECT 1", [{ encoding: "base64", data: "AA==", extra: true } as never]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(plane.transaction([])).rejects.toBeInstanceOf(TypeError);
  } finally {
    plane.close();
  }
});

test("transaction output limits are checked before any statement is committed", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE item (id INTEGER PRIMARY KEY)");
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  try {
    await expect(
      plane.execute(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 8500) INSERT INTO item(id) SELECT x FROM n RETURNING hex(zeroblob(500)) AS payload",
      ),
    ).rejects.toMatchObject({ name: "sql_error" });
    expect(await plane.query("SELECT count(*) AS count FROM item")).toEqual({
      rows: [{ count: 0 }],
      rowsWritten: 0,
    });

    await expect(
      plane.transaction([
        { sql: "INSERT INTO item VALUES (1)" },
        {
          sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 8500) SELECT hex(zeroblob(500)) AS payload FROM n",
        },
      ]),
    ).rejects.toMatchObject({ name: "sql_error" });
    expect(await plane.query("SELECT count(*) AS count FROM item")).toEqual({
      rows: [{ count: 0 }],
      rowsWritten: 0,
    });
  } finally {
    plane.close();
  }
});

test("row, column, SQL, and parameter limits return the contract error classes", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE item (id INTEGER PRIMARY KEY)");
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  try {
    await expect(
      plane.query(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 10001) SELECT x FROM n",
      ),
    ).rejects.toMatchObject({ name: "sql_error" });
    await expect(
      plane.query(
        `SELECT ${Array.from({ length: 101 }, (_, index) => `1 AS c${index}`).join(",")}`,
      ),
    ).rejects.toMatchObject({ name: "sql_error" });
    await expect(plane.query(`SELECT 1 AS "${"x".repeat(129)}"`)).rejects.toMatchObject({
      name: "sql_error",
    });
    await expect(
      plane.query(
        "SELECT printf('%.*c', 800000, 'x') AS a, printf('%.*c', 800000, 'y') AS b, printf('%.*c', 800000, 'z') AS c",
      ),
    ).rejects.toMatchObject({ name: "sql_error" });
    await expect(plane.execute(`SELECT ${" ".repeat(100_001)}`)).rejects.toMatchObject({
      name: "sql_error",
    });
    await expect(
      plane.execute(
        "SELECT 1",
        Array.from({ length: 101 }, () => null),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      plane.transaction(Array.from({ length: 101 }, () => ({ sql: "SELECT 1" }))),
    ).rejects.toBeInstanceOf(TypeError);
  } finally {
    plane.close();
  }
});

test("the injected Host connection and ledger identity stay explicit through close", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE _takoform_sqlite_migrations (sequence INTEGER)");
  database.exec("CREATE VIEW migration_view AS SELECT sequence FROM _takoform_sqlite_migrations");
  const plane = createSelfhostV2SqlitePlane({
    database,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  });

  await expect(plane.query("SELECT * FROM migration_view")).rejects.toMatchObject({
    name: "sql_error",
  });
  plane.close();
  expect(database.isOpen).toBe(false);
  await expect(plane.query("SELECT 1")).rejects.toMatchObject({ name: "backend_unavailable" });

  const activeTransaction = new DatabaseSync(":memory:");
  activeTransaction.exec("BEGIN");
  expect(() =>
    createSelfhostV2SqlitePlane({
      database: activeTransaction,
      migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
    }),
  ).toThrow(TypeError);
  activeTransaction.exec("ROLLBACK");
  activeTransaction.close();

  const badLedger = new DatabaseSync(":memory:");
  expect(() =>
    createSelfhostV2SqlitePlane({
      database: badLedger,
      migrationLedger: { schema: "temp", table: "_takoform_sqlite_migrations" },
    }),
  ).toThrow(TypeError);
  badLedger.close();
});

test("the plane stays on its exact injected connection and rejects extra positional arguments", async () => {
  const original = new DatabaseSync(":memory:");
  const replacement = new DatabaseSync(":memory:");
  original.exec("CREATE TABLE item (value TEXT NOT NULL); INSERT INTO item VALUES ('original')");
  replacement.exec(
    "CREATE TABLE item (value TEXT NOT NULL); INSERT INTO item VALUES ('replacement')",
  );
  const options = {
    database: original,
    migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
  };
  const plane = createSelfhostV2SqlitePlane(options);
  options.database = replacement;

  try {
    expect(await plane.query("SELECT value FROM item")).toEqual({
      rows: [{ value: "original" }],
      rowsWritten: 0,
    });
    await expect(
      Reflect.apply(plane.query, plane, ["SELECT 1", [], "unexpected"]),
    ).rejects.toBeInstanceOf(TypeError);
  } finally {
    plane.close();
    expect(original.isOpen).toBe(false);
    expect(replacement.isOpen).toBe(true);
    replacement.close();
  }
});
