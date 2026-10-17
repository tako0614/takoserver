import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, constants as SQLITE } from "node:sqlite";
import { test } from "node:test";
import { createSelfhostV2SqlitePlane } from "../src/providers/selfhost-v2-sqlite-plane.ts";

const LEDGER = "_takoform_sqlite_migrations";
const READY = `
CREATE TABLE ${LEDGER}(sequence INTEGER PRIMARY KEY,path TEXT,sha256 TEXT,operation_id TEXT);
INSERT INTO ${LEDGER} VALUES(1,'held.sql','digest','accepted-operation');
CREATE TABLE docs(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE audit(value TEXT);
CREATE VIRTUAL TABLE search USING fts5(body,content='docs',content_rowid='id',tokenize='trigram');
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO search(rowid,body) VALUES(new.id,new.body);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body);
  INSERT INTO search(rowid,body) VALUES(new.id,new.body);
END;
INSERT INTO docs VALUES(1,'winter forest');
CREATE VIRTUAL TABLE local_search USING fts5(body,tokenize='trigram');
`;

interface NativeAction {
  readonly authorizerEpoch: number;
  readonly action: number;
  readonly first: string | null;
  readonly second: string | null;
  readonly schema: string | null;
  readonly origin: string | null;
  readonly decision: number;
}

// The fixture injects a genuine native connection into the production plane.
// Its observer forwards every callback to the actual installed authorizer.
function fixture(setup = "", persistent = false) {
  const root = persistent ? mkdtempSync(join(tmpdir(), "worker-fts-native-")) : undefined;
  const path = root ? join(root, "database.sqlite") : ":memory:";
  const actions: NativeAction[] = [];
  let authorizerEpoch = 0;
  let database = new DatabaseSync(path, { allowExtension: false });
  try {
    database.exec(READY + setup);
  } catch (error) {
    database.close();
    if (root) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let reprepareSql: string | undefined;
  const openPlane = () => {
    const actualAuthorize = database.setAuthorizer.bind(database);
    const actualPrepare = database.prepare.bind(database);
    let installed: Parameters<DatabaseSync["setAuthorizer"]>[0];
    database.setAuthorizer = (authorize) => {
      installed =
        authorize == null
          ? authorize
          : (action, first, second, schema, origin) => {
              const decision = authorize(action, first, second, schema, origin);
              actions.push({ authorizerEpoch, action, first, second, schema, origin, decision });
              return decision;
            };
      actualAuthorize(installed);
    };
    database.prepare = (sql) => {
      const statement = actualPrepare(sql);
      if (sql === reprepareSql) {
        reprepareSql = undefined;
        // Reinstall the identical real authorizer to expire the native VDBE.
        // SQLite must authorize its automatic reprepare; no decision is forged.
        assert.equal(typeof installed, "function");
        authorizerEpoch += 1;
        actualAuthorize(installed);
      }
      return statement;
    };
    return createSelfhostV2SqlitePlane({
      database,
      migrationLedger: { schema: "main", table: LEDGER },
    });
  };
  let plane = openPlane();
  return {
    actions,
    get plane() {
      return plane;
    },
    reprepare(sql: string) {
      reprepareSql = sql;
    },
    reopen() {
      assert.ok(root, "persistent fixture required");
      plane.close();
      database = new DatabaseSync(path, { allowExtension: false });
      plane = openPlane();
    },
    close() {
      try {
        plane.close();
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function match(f: ReturnType<typeof fixture>, word: string, table = "search") {
  const result = await f.plane.query(
    `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`,
    [word],
  );
  return result.rows.map((row) => row.id);
}

async function rejected(f: ReturnType<typeof fixture>, sql: string) {
  await assert.rejects(f.plane.execute(sql), { name: "sql_error", code: "sql_error" });
}

test("Worker plane runs native FTS5 trigram DML and MATCH through external-content triggers", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await match(f, "fore"), [1]);
    await f.plane.execute("INSERT INTO docs VALUES(2,?)", ["summer meadow"]);
    assert.deepEqual(await match(f, "mead"), [2]);
    await f.plane.execute("UPDATE docs SET body=? WHERE id=2", ["autumn forest"]);
    assert.deepEqual(await match(f, "mead"), []);
    assert.deepEqual(await match(f, "fore"), [1, 2]);
    await f.plane.execute("DELETE FROM docs WHERE id=1");
    assert.deepEqual(await match(f, "fore"), [2]);
    await f.plane.execute("INSERT INTO search(search) VALUES('rebuild')");
    assert.deepEqual(await match(f, "fore"), [2]);
    await f.plane.execute("INSERT INTO local_search(rowid,body) VALUES(7,'silver forest')");
    assert.deepEqual(await match(f, "fore", "local_search"), [7]);
    await f.plane.execute("UPDATE local_search SET body='golden meadow' WHERE rowid=7");
    assert.deepEqual(await match(f, "fore", "local_search"), []);
    assert.deepEqual(await match(f, "mead", "local_search"), [7]);
    await f.plane.execute("DELETE FROM local_search WHERE rowid=7");
    assert.deepEqual(await match(f, "mead", "local_search"), []);
    assert.ok(
      f.actions.some(
        (event) =>
          event.action === SQLITE.SQLITE_PRAGMA &&
          event.first === "data_version" &&
          event.second === null &&
          event.schema === "main" &&
          event.origin === null &&
          event.decision === SQLITE.SQLITE_OK,
      ),
      "the production plane admitted the genuine FTS runtime callback",
    );
    assert.ok(
      !f.actions.some(
        (event) => event.action === SQLITE.SQLITE_PRAGMA && event.first === "table_list",
      ),
      "catalog discovery must never initialize virtual tables via table_list",
    );
  } finally {
    f.close();
  }
});

test("Worker FTS descriptors survive close/reopen and native automatic reprepare", async () => {
  const f = fixture("", true);
  try {
    await f.plane.execute("INSERT INTO docs VALUES(2,'summer meadow')");
    f.reopen();
    const sql = "SELECT rowid AS id FROM search WHERE search MATCH 'mead'";
    f.actions.length = 0;
    f.reprepare(sql);
    assert.deepEqual(
      (await f.plane.query(sql)).rows.map((row) => row.id),
      [2],
    );
    const readEpochs = new Set(
      f.actions
        .filter(
          (event) =>
            event.action === SQLITE.SQLITE_READ &&
            event.first === "search" &&
            event.decision === SQLITE.SQLITE_OK,
        )
        .map((event) => event.authorizerEpoch),
    );
    assert.equal(
      readEpochs.size,
      2,
      "both original preparation and native reprepare must authorize the actual FTS target",
    );
    await rejected(f, "PRAGMA main.data_version");
    assert.deepEqual(await match(f, "mead"), [2]);
  } finally {
    f.close();
  }
});

test("Worker plane verifies ordinary and contentless builtin FTS5 shadow roles", async () => {
  const f = fixture(`
    CREATE VIRTUAL TABLE plain_search USING fts5(body);
    CREATE VIRTUAL TABLE contentless_search USING fts5(body,content='',columnsize=0,tokenize='trigram');
  `);
  try {
    await f.plane.execute("INSERT INTO plain_search(rowid,body) VALUES(3,'generic forest')");
    assert.deepEqual(await match(f, "forest", "plain_search"), [3]);
    await f.plane.execute("INSERT INTO contentless_search(rowid,body) VALUES(4,'silent meadow')");
    assert.deepEqual(await match(f, "mead", "contentless_search"), [4]);
    await rejected(f, "SELECT * FROM pragma_table_list");
    assert.deepEqual(await match(f, "forest", "plain_search"), [3]);
  } finally {
    f.close();
  }
});

test("Worker FTS query writes, failed batches, and invalid output all roll back before commit", async () => {
  const f = fixture();
  try {
    const rolledBack = await f.plane.query(
      "INSERT INTO docs VALUES(2,'query meadow') RETURNING id",
    );
    assert.equal(rolledBack.rowsWritten, 0);
    assert.deepEqual(await match(f, "mead"), []);
    await assert.rejects(
      f.plane.transaction([
        { sql: "INSERT INTO docs VALUES(2,'atomic meadow')" },
        { sql: "INSERT INTO docs VALUES(2,'duplicate')" },
      ]),
      { name: "sql_error" },
    );
    assert.deepEqual(await match(f, "mead"), []);
    await assert.rejects(
      f.plane.transaction([
        { sql: "INSERT INTO docs VALUES(2,'overflow meadow')" },
        { sql: "SELECT hex(zeroblob(500001)) AS oversized" },
      ]),
      { name: "sql_error" },
    );
    assert.deepEqual(await match(f, "mead"), []);
    await assert.rejects(
      f.plane.transactionStaged(function* () {
        yield { sql: "INSERT INTO docs VALUES(2,'staged meadow')" };
        yield { sql: "SELECT 1 AS duplicate,2 AS duplicate" };
      }),
      { name: "sql_error" },
    );
    assert.deepEqual(await match(f, "mead"), []);
    const committed = await f.plane.transaction([
      { sql: "INSERT INTO docs VALUES(2,'committed meadow')" },
      { sql: "SELECT rowid AS id FROM search WHERE search MATCH 'mead'" },
    ]);
    assert.deepEqual(
      committed.results[1]?.rows.map((row) => row.id),
      [2],
    );
  } finally {
    f.close();
  }
});

const HIDDEN_READS = [
  {
    label: "same statement after FTS READ",
    sql: "SELECT search.rowid,p.data_version FROM search CROSS JOIN pragma_data_version p WHERE search MATCH 'fore'",
  },
  {
    label: "quoted schema and alias",
    sql: "SELECT s.rowid,p.data_version FROM main.search s CROSS JOIN main.\"pragma_data_version\" p WHERE search MATCH 'fore'",
  },
  {
    label: "CTE",
    sql: "WITH hidden AS (SELECT * FROM pragma_data_version) SELECT search.rowid,hidden.data_version FROM search CROSS JOIN hidden WHERE search MATCH 'fore'",
  },
  {
    label: "view",
    setup: "CREATE VIEW hidden AS SELECT * FROM pragma_data_version;",
    sql: "SELECT search.rowid,hidden.data_version FROM search CROSS JOIN hidden WHERE search MATCH 'fore'",
  },
  {
    label: "trigger after FTS READ",
    setup:
      "CREATE TRIGGER leak AFTER INSERT ON docs BEGIN INSERT INTO audit SELECT rowid FROM search WHERE search MATCH 'fore'; INSERT INTO audit SELECT data_version FROM pragma_data_version; END;",
    sql: "INSERT INTO docs VALUES(2,'forbidden meadow')",
  },
  {
    label: "MigrationApplication-only table_info read",
    sql: "SELECT search.rowid,p.name FROM search CROSS JOIN pragma_table_info p WHERE p.arg='docs' AND p.schema='main' AND search MATCH 'fore'",
  },
  {
    label: "hidden ledger metadata",
    sql: `SELECT search.rowid,p.name FROM search CROSS JOIN pragma_table_info p WHERE p.arg='${LEDGER}' AND p.schema='main' AND search MATCH 'fore'`,
  },
  {
    label: "table_xinfo",
    sql: "SELECT search.rowid,p.name FROM search CROSS JOIN pragma_table_xinfo p WHERE p.arg='docs' AND p.schema='main' AND search MATCH 'fore'",
  },
  {
    label: "unrelated read-only metadata",
    sql: "SELECT search.rowid,p.foreign_keys FROM search CROSS JOIN pragma_foreign_keys p WHERE search MATCH 'fore'",
  },
] as const;

for (const entry of HIDDEN_READS) {
  test(`Worker FTS denies resolved eponymous metadata through ${entry.label}`, async () => {
    const f = fixture("setup" in entry ? entry.setup : "");
    try {
      const firstEvent = f.actions.length;
      await assert.rejects(
        f.plane.transaction([
          { sql: "INSERT INTO audit VALUES('must roll back')" },
          { sql: entry.sql },
        ]),
        { name: "sql_error" },
      );
      assert.ok(
        f.actions
          .slice(firstEvent)
          .some(
            (event) =>
              event.action === SQLITE.SQLITE_READ &&
              event.first?.startsWith("pragma_") &&
              event.decision === SQLITE.SQLITE_DENY,
          ),
        "the resolved forbidden table must be denied before its step-time PRAGMA",
      );
      if (entry.label === "same statement after FTS READ") {
        const events = f.actions.slice(firstEvent);
        const denied = events.findIndex(
          (event) =>
            event.action === SQLITE.SQLITE_READ &&
            event.first === "pragma_data_version" &&
            event.decision === SQLITE.SQLITE_DENY,
        );
        assert.ok(
          events
            .slice(0, denied)
            .some(
              (event) =>
                event.action === SQLITE.SQLITE_READ &&
                event.first === "search" &&
                event.decision === SQLITE.SQLITE_OK,
            ),
          "a positive FTS READ must not hide a later forbidden metadata effect",
        );
      }
      assert.deepEqual((await f.plane.query("SELECT value FROM audit")).rows, []);
      assert.deepEqual(await match(f, "mead"), []);
      assert.deepEqual(await match(f, "fore"), [1]);
    } finally {
      f.close();
    }
  });
}

test("Worker keeps all user PRAGMA, schema, ledger, and external effects forbidden after FTS", async () => {
  const f = fixture(`
    CREATE INDEX docs_body ON docs(body);
    CREATE VIEW ledger_view AS SELECT * FROM ${LEDGER};
    CREATE TRIGGER ledger_write AFTER INSERT ON audit BEGIN DELETE FROM ${LEDGER}; END;
    ATTACH DATABASE ':memory:' AS other;
    CREATE TABLE other.secret(value TEXT);
    CREATE VIRTUAL TABLE temp.temporary_search USING fts5(body);
  `);
  try {
    assert.deepEqual(await match(f, "fore"), [1]);
    for (const sql of [
      "PRAGMA data_version",
      'PRAGMA main."data_version"',
      "PRAGMA foreign_keys=OFF",
      "PRAGMA defer_foreign_keys=ON",
      "PRAGMA table_info(docs)",
      "PRAGMA foreign_key_list(docs)",
      "PRAGMA index_list(docs)",
      "PRAGMA index_info(docs)",
      "SELECT * FROM pragma_foreign_key_list('docs')",
      "SELECT * FROM pragma_index_list('docs')",
      "SELECT * FROM pragma_index_info('docs')",
      "SELECT name FROM sqlite_schema",
      `SELECT * FROM ${LEDGER}`,
      "SELECT * FROM ledger_view",
      `DELETE FROM ${LEDGER}`,
      "INSERT INTO audit VALUES('ledger trigger')",
      "CREATE TABLE forbidden(value TEXT)",
      "CREATE TEMP TABLE forbidden(value TEXT)",
      "CREATE INDEX forbidden ON docs(body)",
      "CREATE VIEW forbidden AS SELECT 1",
      "CREATE TRIGGER forbidden AFTER INSERT ON docs BEGIN SELECT 1; END",
      "CREATE VIRTUAL TABLE forbidden USING fts5(body)",
      "DROP TABLE docs",
      "ALTER TABLE docs ADD COLUMN forbidden TEXT",
      "REINDEX docs_body",
      "ANALYZE",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT forbidden",
      "ATTACH DATABASE ':memory:' AS forbidden",
      "DETACH other",
      "VACUUM",
      "SELECT load_extension('forbidden')",
      "SELECT * FROM other.secret",
      "SELECT * FROM temp.temporary_search",
      "SELECT 1; SELECT 2",
    ]) {
      await rejected(f, sql);
    }
    assert.deepEqual(await match(f, "fore"), [1]);
  } finally {
    f.close();
  }
});

test("real ordinary pragma-prefixed tables and harmless quoted words remain usable", async () => {
  const f = fixture(`
    CREATE TABLE pragma_notes(value TEXT);
    INSERT INTO pragma_notes VALUES('pragma_data_version');
    CREATE TABLE pragma_data_version(value TEXT);
    INSERT INTO pragma_data_version VALUES('ordinary table');
  `);
  try {
    assert.deepEqual(await match(f, "fore"), [1]);
    assert.deepEqual(
      (await f.plane.query("SELECT value FROM pragma_notes")).rows.map((r) => r.value),
      ["pragma_data_version"],
    );
    assert.deepEqual(
      (await f.plane.query("SELECT value FROM pragma_data_version")).rows.map((r) => r.value),
      ["ordinary table"],
    );
    assert.deepEqual(
      (
        await f.plane.query("SELECT 'PRAGMA data_version; ATTACH' AS sqlite_schema /* DROP */")
      ).rows.map((r) => r.sqlite_schema),
      ["PRAGMA data_version; ATTACH"],
    );
    await rejected(f, "PRAGMA data_version");
  } finally {
    f.close();
  }
});

test("a catalog FTS declaration backed by the protected ledger never acquires runtime permission", async () => {
  const f = fixture(
    `CREATE VIRTUAL TABLE ledger_search USING fts5(path,content='${LEDGER}',content_rowid='sequence');`,
  );
  try {
    f.actions.length = 0;
    await rejected(f, "SELECT path FROM ledger_search");
    assert.ok(
      !f.actions.some(
        (event) => event.action === SQLITE.SQLITE_PRAGMA && event.decision === SQLITE.SQLITE_OK,
      ),
    );
    assert.deepEqual(await match(f, "fore"), [1]);
  } finally {
    f.close();
  }
});
