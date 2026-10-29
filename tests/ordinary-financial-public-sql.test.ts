import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { FINANCIAL_0104_FENCED_TABLES } from "../src/financial-0104-money-fence.ts";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(schema = "") {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(
    `CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE financial_source_events(id TEXT PRIMARY KEY); ${schema}`,
  );
  return { database, sql: createOrdinaryFinancialPublicSql(createSqliteSql(database)) };
}

test("direct fenced write refuses before mutation; Auth UPSERT keeps its row and ACK", async () => {
  const { database, sql } = fixture();
  await expect(sql.run("INSERT INTO financial_source_events(id) VALUES ('bad')")).rejects.toThrow();
  expect(database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
    n: 0,
  });
  const first = await sql.run(
    "INSERT INTO orgs(id,name) VALUES('o','one') ON CONFLICT(id) DO NOTHING",
  );
  const second = await sql.run(
    "INSERT INTO orgs(id,name) VALUES('o','two') ON CONFLICT(id) DO UPDATE SET name=excluded.name RETURNING id",
  );
  expect(first.changes).toBe(1);
  expect(second.rows).toEqual([{ id: "o" }]);
  expect(database.query("SELECT name FROM orgs WHERE id='o'").get()).toEqual({ name: "two" });
});

test("quoted and commented protected targets refuse; bounded Auth and wallet SQL retain batch results", async () => {
  const { database, sql } =
    fixture(`CREATE TABLE shared_auth_sessions(id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE org_wallet_holds(id TEXT PRIMARY KEY);`);
  await expect(
    sql.run(`/* harmless */ INSERT INTO "financial_source_events"(id) VALUES('bad')`),
  ).rejects.toThrow();
  await expect(
    sql.query(
      `WITH x AS (SELECT 1) INSERT INTO financial_source_events(id) VALUES('bad') RETURNING id`,
    ),
  ).rejects.toThrow();
  await expect(sql.run("CREATE TABLE financial_source_events_other(id TEXT)")).rejects.toThrow();
  await expect(sql.run("REPLACE INTO orgs(id,name) VALUES('o','bad')")).rejects.toThrow();
  const writes = await sql.batch([
    { sql: "INSERT INTO shared_auth_sessions(id,state) VALUES('s','pending')" },
    { sql: "UPDATE shared_auth_sessions SET state='ready' WHERE id='s' RETURNING state" },
    {
      sql: "WITH summary AS (SELECT 'h' AS id) INSERT INTO org_wallet_holds(id) SELECT id FROM summary",
    },
  ]);
  expect(writes).toHaveLength(3);
  expect(writes[1]?.rows).toEqual([{ state: "ready" }]);
  expect(database.query("SELECT id FROM org_wallet_holds").all()).toEqual([{ id: "h" }]);
});

test("an Auth org UPSERT may read fenced history in its 0105-style trigger without writing it", async () => {
  const { database, sql } = fixture(`
    CREATE TABLE financial_customer_history_birth_observations(id TEXT PRIMARY KEY);
    CREATE TRIGGER capture_org AFTER INSERT ON orgs BEGIN
      INSERT INTO financial_customer_history_birth_observations(id)
      SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM financial_source_events WHERE id=NEW.id);
    END;
  `);
  const result = await sql.run(
    "INSERT INTO orgs(id,name) VALUES('o','one') ON CONFLICT(id) DO NOTHING",
  );
  expect(result.changes).toBe(1);
  expect(
    database.query("SELECT id FROM financial_customer_history_birth_observations").all(),
  ).toEqual([{ id: "o" }]);
});

test("trigger, view, and cascading foreign-key protected writes refuse before submission", async () => {
  const trigger = fixture(
    `CREATE TRIGGER bad AFTER INSERT ON orgs BEGIN INSERT INTO financial_source_events(id) VALUES (NEW.id); END;`,
  );
  await expect(trigger.sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(trigger.database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });

  const view = fixture(`CREATE VIEW org_view AS SELECT * FROM orgs;
    CREATE TRIGGER bad_view INSTEAD OF INSERT ON org_view BEGIN INSERT INTO financial_source_events(id) VALUES (NEW.id); END;`);
  await expect(view.sql.run("INSERT INTO org_view(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(view.database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
    n: 0,
  });

  const cascade = fixture(`CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE financial_ordinary_retained_r1_receipts(id TEXT PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE);
    INSERT INTO parent VALUES('p'); INSERT INTO financial_ordinary_retained_r1_receipts VALUES('p');`);
  await expect(cascade.sql.run("DELETE FROM parent WHERE id='p'")).rejects.toThrow();
  expect(cascade.database.query("SELECT count(*) AS n FROM parent").get()).toEqual({ n: 1 });
  // A child insert that merely checks a protected parent is not a protected write.
  cascade.database.exec(
    "CREATE TABLE child(id TEXT REFERENCES financial_ordinary_retained_r1_receipts(id))",
  );
  expect((await cascade.sql.run("INSERT INTO child(id) VALUES('p')")).changes).toBe(1);
});

test("transitive trigger writes and DELETE/UPDATE FK actions are denied without denying checks", async () => {
  const transitive = fixture(`CREATE TABLE ordinary_stage(id TEXT);
    CREATE TRIGGER first AFTER INSERT ON orgs BEGIN INSERT INTO ordinary_stage(id) VALUES(NEW.id); END;
    CREATE TRIGGER second AFTER INSERT ON ordinary_stage BEGIN INSERT INTO financial_source_events(id) VALUES(NEW.id); END;`);
  await expect(transitive.sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(transitive.database.query("SELECT count(*) AS n FROM ordinary_stage").get()).toEqual({
    n: 0,
  });

  const update = fixture(`CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE financial_ordinary_history_enrollments(id TEXT REFERENCES parent(id) ON UPDATE CASCADE);
    INSERT INTO parent VALUES('a'); INSERT INTO financial_ordinary_history_enrollments VALUES('a');`);
  await expect(update.sql.run("UPDATE parent SET id='b' WHERE id='a'")).rejects.toThrow();
  expect(update.database.query("SELECT id FROM parent").all()).toEqual([{ id: "a" }]);
});

test("the final catalog guard rolls back a body write on same-connection schema drift", async () => {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  const base = createSqliteSql(database);
  const raw: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs")))
        database.exec("CREATE TABLE surprise(id TEXT)");
      return base.batch(statements);
    },
  };
  const sql = createOrdinaryFinancialPublicSql(raw);
  await expect(sql.run("INSERT INTO orgs(id) VALUES('o')")).rejects.toThrow();
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
});

test("metadata FK rows require an exact catalog match from the same atomic batch", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  let bodyBatchSubmitted = false;
  let metadataBatch: readonly SqlStatement[] | undefined;
  const standaloneForeignKeyQueries: string[] = [];
  const raw: Sql = {
    query: async (sql, params) => {
      if (sql.includes("pragma_foreign_key_list")) standaloneForeignKeyQueries.push(sql);
      return base.query(sql, params);
    },
    run: base.run,
    batch: async (statements) => {
      if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs"))) {
        bodyBatchSubmitted = true;
        return base.batch(statements);
      }
      metadataBatch = [...statements];
      const results = await base.batch(statements);
      if (!statements[0]?.sql.includes("main.sqlite_schema"))
        throw new Error("metadata snapshot did not batch catalog first");
      return results.map((result, index) =>
        index === 0
          ? {
              ...result,
              rows: result.rows.map((row) =>
                row.name === "orgs" ? { ...row, sql: "CREATE TABLE orgs(id TEXT)" } : row,
              ),
            }
          : result,
      );
    },
  };
  await expect(
    createOrdinaryFinancialPublicSql(raw).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
  ).rejects.toThrow("catalog changed during metadata snapshot");
  expect(bodyBatchSubmitted).toBe(false);
  expect(metadataBatch?.[1]?.sql).toBe("SELECT count(*) AS n FROM sqlite_temp_schema");
  expect(
    metadataBatch?.filter((statement) => statement.sql.includes("pragma_foreign_key_list")),
  ).toHaveLength(2);
  expect(standaloneForeignKeyQueries).toEqual([]);
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
});

test("metadata batch refuses missing or malformed positional acknowledgements", async () => {
  for (const mode of ["missing", "malformed"] as const) {
    const { database } = fixture();
    const base = createSqliteSql(database);
    let bodyBatchSubmitted = false;
    const raw: Sql = {
      query: base.query,
      run: base.run,
      batch: async (statements) => {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs"))) {
          bodyBatchSubmitted = true;
          return base.batch(statements);
        }
        const results = await base.batch(statements);
        if (mode === "missing") return results.slice(0, -1);
        return results.map((result, index) =>
          index === 0 ? ({ rows: null, changes: 0 } as unknown as typeof result) : result,
        );
      },
    };
    await expect(
      createOrdinaryFinancialPublicSql(raw).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
    ).rejects.toThrow();
    expect(bodyBatchSubmitted).toBe(false);
    expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
  }
});

test("plain SELECT uses only TEMP and selected query while CTE stays fully guarded", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  const queries: string[] = [];
  const batches: SqlStatement[][] = [];
  const raw: Sql = {
    query: async (sql, params) => {
      queries.push(sql);
      return base.query(sql, params);
    },
    run: base.run,
    batch: async (statements) => {
      batches.push([...statements]);
      return base.batch(statements);
    },
  };
  const sql = createOrdinaryFinancialPublicSql(raw);
  expect(await sql.query("SELECT id FROM orgs")).toEqual([]);
  expect(queries).toEqual(["SELECT count(*) AS n FROM sqlite_temp_schema", "SELECT id FROM orgs"]);
  expect(batches).toHaveLength(0);

  expect(await sql.query("WITH selected AS (SELECT 1 AS id) SELECT id FROM selected")).toEqual([
    { id: 1 },
  ]);
  expect(batches).toHaveLength(2);
  expect(batches[0]?.[0]?.sql).toContain("main.sqlite_schema");
  expect(batches[1]?.[0]?.sql).toContain("WITH selected");
});

test("TEMP objects, unsupported FK metadata, and an oversized catalog refuse before body batch", async () => {
  const temp = fixture();
  temp.database.exec("CREATE TEMP TABLE orgs(id TEXT)");
  await expect(temp.sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(temp.database.query("SELECT count(*) AS n FROM main.orgs").get()).toEqual({ n: 0 });

  const base = createSqliteSql(temp.database);
  let batches = 0;
  const unsupported: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      if (statements.some((statement) => statement.sql.includes("pragma_foreign_key_list")))
        throw new Error("unsupported");
      if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs"))) batches++;
      return base.batch(statements);
    },
  };
  temp.database.exec("DROP TABLE temp.orgs");
  await expect(
    createOrdinaryFinancialPublicSql(unsupported).run(
      "INSERT INTO orgs(id,name) VALUES('o','one')",
    ),
  ).rejects.toThrow();
  expect(batches).toBe(0);

  const oversized: Sql = {
    query: (statement, params) =>
      statement.includes("main.sqlite_schema")
        ? Promise.resolve([
            { type: "view", name: "huge", tbl_name: "huge", sql: "x".repeat(1_000_001) },
          ])
        : base.query(statement, params),
    run: base.run,
    batch: base.batch,
  };
  await expect(
    createOrdinaryFinancialPublicSql(oversized).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
  ).rejects.toThrow();
  expect(batches).toBe(0);
});

test("the fixed 36 Money, 5 R1, and 10 H0 targets are all deny-only", async () => {
  const r1AndH0 = [
    "financial_ordinary_action_source_registrations",
    "financial_ordinary_preproof_challenges",
    "financial_ordinary_preproof_challenge_receipts",
    "financial_ordinary_retained_r1_originals",
    "financial_ordinary_retained_r1_receipts",
    "financial_ordinary_history_primary_roots",
    "financial_ordinary_history_enrollments",
    "financial_ordinary_history_enrollment_roster",
    "financial_ordinary_history_enrollment_inventory",
    "financial_ordinary_history_enrollment_inventory_receipts",
    "financial_ordinary_history_enrollment_heads",
    "financial_ordinary_history_enrollment_receipts",
    "financial_ordinary_customer_history_coverages",
    "financial_ordinary_customer_history_scopes",
    "financial_ordinary_customer_history_coverage_receipts",
  ];
  const protectedTables = [...FINANCIAL_0104_FENCED_TABLES, ...r1AndH0];
  expect(FINANCIAL_0104_FENCED_TABLES).toHaveLength(36);
  expect(r1AndH0).toHaveLength(15);
  expect(new Set(protectedTables).size).toBe(51);

  const { database, sql } = fixture(
    protectedTables
      .filter((name) => name !== "orgs" && name !== "financial_source_events")
      .map((name) => `CREATE TABLE ${name}(id TEXT PRIMARY KEY);`)
      .join("\n"),
  );
  for (const table of protectedTables) {
    await expect(sql.run(`INSERT INTO ${table}(id) VALUES('blocked')`)).rejects.toThrow();
  }
  for (const table of protectedTables) {
    expect(database.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
});

test("Money cutover control tables retain existing public SQL read/write exclusion", async () => {
  const controls = [
    "money_cutover_freeze",
    "money_cutover_writer_permit",
    "money_cutover_authorized_epoch",
  ];
  const { database, sql } = fixture(
    controls
      .map((table) => `CREATE TABLE ${table}(singleton INTEGER PRIMARY KEY, value TEXT);`)
      .join("\n"),
  );
  for (const table of controls) {
    database.exec(`INSERT INTO ${table}(singleton,value) VALUES(1,'sealed')`);
    await expect(sql.query(`SELECT value FROM ${table}`)).rejects.toThrow();
    await expect(
      sql.run(`UPDATE ${table} SET value='changed' WHERE singleton=1`),
    ).rejects.toThrow();
  }
  for (const table of controls) {
    expect(database.query(`SELECT value FROM ${table}`).get()).toEqual({ value: "sealed" });
  }

  database.exec(`CREATE TRIGGER reject_control_mutation AFTER INSERT ON orgs BEGIN
    UPDATE money_cutover_freeze SET value='changed' WHERE singleton=1;
  END`);
  await expect(sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
  expect(database.query("SELECT value FROM money_cutover_freeze").get()).toEqual({
    value: "sealed",
  });
});

test("only exact D1 internal tables with FK-free CREATE TABLE SQL skip metadata inspection", async () => {
  const { database } = fixture(`CREATE TABLE "_cf_METADATA"(key INTEGER PRIMARY KEY, value BLOB);`);
  const base = createSqliteSql(database);
  const inspected: string[] = [];
  const raw: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      for (const statement of statements) {
        if (statement.sql.includes("pragma_foreign_key_list")) {
          const table = statement.params?.[0];
          if (typeof table === "string") inspected.push(table);
          if (table === "_cf_METADATA") throw new Error("internal table denied");
        }
      }
      return base.batch(statements);
    },
  };
  const result = await createOrdinaryFinancialPublicSql(raw).run(
    "INSERT INTO orgs(id,name) VALUES('o','one')",
  );
  expect(result.changes).toBe(1);
  expect(inspected).not.toContain("_cf_METADATA");
  expect(inspected).toContain("orgs");
});

test("unknown, malformed, or FK-bearing tables never use the D1 internal metadata skip", async () => {
  const cases = [
    {
      table: "_cf_OTHER",
      schema: "CREATE TABLE _cf_OTHER(id TEXT)",
      overrideCatalog: false,
    },
    {
      table: "_cf_metadata",
      schema:
        "CREATE TABLE parent_rows(id TEXT PRIMARY KEY); CREATE TABLE _cf_metadata(id TEXT REFERENCES parent_rows(id))",
      overrideCatalog: false,
    },
    {
      table: "_cf_metadata",
      schema: "CREATE TABLE _cf_metadata(id TEXT)",
      overrideCatalog: true,
    },
  ];
  for (const scenario of cases) {
    const { database } = fixture(scenario.schema);
    const base = createSqliteSql(database);
    let internalMetadataRequested = false;
    const raw: Sql = {
      query: async (sql, params) => {
        const rows = await base.query(sql, params);
        return sql.includes("main.sqlite_schema") && scenario.overrideCatalog
          ? rows.map((row) => (row.name === scenario.table ? { ...row, sql: null } : row))
          : rows;
      },
      run: base.run,
      batch: async (statements) => {
        if (
          statements.some(
            (statement) =>
              statement.sql.includes("pragma_foreign_key_list") &&
              statement.params?.[0] === scenario.table,
          )
        ) {
          internalMetadataRequested = true;
          throw new Error("FK metadata unavailable");
        }
        const results = await base.batch(statements);
        if (!scenario.overrideCatalog || !statements[0]?.sql.includes("main.sqlite_schema"))
          return results;
        return results.map((result, index) =>
          index === 0
            ? {
                ...result,
                rows: result.rows.map((row) =>
                  row.name === scenario.table ? { ...row, sql: null } : row,
                ),
              }
            : result,
        );
      },
    };
    await expect(
      createOrdinaryFinancialPublicSql(raw).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
    ).rejects.toThrow();
    expect(internalMetadataRequested).toBe(true);
    expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
  }
});

test("only the matching trigger event contributes a protected write", async () => {
  const { database, sql } = fixture(`
    CREATE TRIGGER reject_org_update AFTER UPDATE ON orgs BEGIN
      INSERT INTO financial_source_events(id) VALUES (NEW.id);
    END;
  `);
  expect((await sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).changes).toBe(1);
  await expect(sql.run("UPDATE orgs SET name='two' WHERE id='o'")).rejects.toThrow();
  expect(database.query("SELECT name FROM orgs WHERE id='o'").get()).toEqual({ name: "one" });
  expect(database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
    n: 0,
  });
});

test("statements are snapshotted before asynchronous catalog reads", async () => {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  database.exec("CREATE TABLE financial_source_events(id TEXT PRIMARY KEY)");
  const base = createSqliteSql(database);
  const statements = [{ sql: "INSERT INTO orgs(id) VALUES('o')" }];
  const raw: Sql = {
    query: async (sql, params) => {
      if (sql.includes("main.sqlite_schema")) {
        const [statement] = statements;
        if (!statement) throw new Error("statement missing in test fixture");
        statement.sql = "INSERT INTO financial_source_events(id) VALUES('bad')";
      }
      return base.query(sql, params);
    },
    run: base.run,
    batch: base.batch,
  };
  const result = await createOrdinaryFinancialPublicSql(raw).batch(statements);
  expect(result).toHaveLength(1);
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
  expect(database.query("SELECT count(*) AS n FROM financial_source_events").get()).toEqual({
    n: 0,
  });
});

test("a temporary object introduced after preflight aborts and rolls back the body", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  const raw: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs")))
        database.exec("CREATE TEMP TABLE late_temp(id TEXT)");
      return base.batch(statements);
    },
  };
  await expect(
    createOrdinaryFinancialPublicSql(raw).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
  ).rejects.toThrow();
  expect(database.query("SELECT count(*) AS n FROM main.orgs").get()).toEqual({ n: 0 });
  expect(database.query("SELECT count(*) AS n FROM sqlite_temp_schema").get()).toEqual({ n: 1 });
});

test("the facade is frozen and refuses a changed captured raw method before batch", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  let batches = 0;
  const raw: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      batches++;
      return base.batch(statements);
    },
  };
  const sql = createOrdinaryFinancialPublicSql(raw);
  expect(Object.isFrozen(sql)).toBe(true);
  raw.run = async () => ({ rows: [], changes: 0 });
  await expect(sql.run("INSERT INTO orgs(id,name) VALUES('o','one')")).rejects.toThrow();
  expect(batches).toBe(0);
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
});

test("a raw method changed during the body batch rejects after the single possibly committed write", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  let bodyBatches = 0;
  const raw: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      const results = await base.batch(statements);
      if (statements.some((statement) => statement.sql.includes("INSERT INTO orgs"))) {
        bodyBatches++;
        raw.query = async () => [];
      }
      return results;
    },
  };
  await expect(
    createOrdinaryFinancialPublicSql(raw).run("INSERT INTO orgs(id,name) VALUES('o','one')"),
  ).rejects.toThrow();
  expect(bodyBatches).toBe(1);
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
});

test("batch rejects missing body or final guard acknowledgements", async () => {
  const { database } = fixture();
  const base = createSqliteSql(database);
  const malformedBody: Sql = {
    query: base.query,
    run: base.run,
    batch: async (statements) => {
      const results = await base.batch(statements);
      if (!statements.some((statement) => statement.sql.includes("INSERT INTO orgs")))
        return results;
      return results.map((result, index) =>
        index === 0 ? ({ rows: null, changes: 1 } as unknown as typeof result) : result,
      );
    },
  };
  await expect(
    createOrdinaryFinancialPublicSql(malformedBody).run(
      "INSERT INTO orgs(id,name) VALUES('o','one')",
    ),
  ).rejects.toThrow();
  expect(database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });

  const missing = fixture();
  const missingBase = createSqliteSql(missing.database);
  const missingGuard: Sql = {
    query: missingBase.query,
    run: missingBase.run,
    batch: async (statements) => {
      const results = await missingBase.batch(statements);
      return statements.some((statement) => statement.sql.includes("INSERT INTO orgs"))
        ? results.slice(0, -1)
        : results;
    },
  };
  await expect(
    createOrdinaryFinancialPublicSql(missingGuard).run(
      "INSERT INTO orgs(id,name) VALUES('m','one')",
    ),
  ).rejects.toThrow();
  expect(missing.database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
});
