import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, constants as SQLITE } from "node:sqlite";
import { prepareNativeMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationNativePort } from "../src/takoform-v2/forms/sqlite-migration-application-native.ts";
import type { SQLiteMigrationRecord } from "../src/takoform-v2/forms/sqlite-migration-application-port.ts";

const LEDGER = "_takoform_sqlite_migrations";
const ORDINARY =
  "CREATE TABLE docs(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO docs VALUES(1,'winter forest');";
const SEARCH =
  "CREATE VIRTUAL TABLE search USING fts5(body,content='docs',content_rowid='id',tokenize='trigram');";
const TRIGGERS = `CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN INSERT INTO search(rowid,body) VALUES(new.id,new.body); END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body); END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body); INSERT INTO search(rowid,body) VALUES(new.id,new.body); END;`;
const READY = ORDINARY + SEARCH + TRIGGERS + "INSERT INTO search(search) VALUES('rebuild');";

interface NativeAction {
  readonly statement: number | null;
  readonly sql: string | null;
  readonly action: number;
  readonly first: string | null;
  readonly second: string | null;
  readonly schema: string | null;
  readonly origin: string | null;
  readonly decision: number;
}

// A synthetic owner handle exercises the real native port. The observers call
// genuine methods/callbacks unchanged; there is no emulated authorizer or Host.
function fixture(
  setup = "",
  form: string = SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0,
  persistent = false,
) {
  const root = persistent ? mkdtempSync(join(tmpdir(), "sqlite-fts-")) : undefined;
  const path = root ? join(root, "database.sqlite") : ":memory:";
  let database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    database.exec(`CREATE TABLE ${LEDGER} (
      sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 512),
      path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),operation_id TEXT NOT NULL
    ); CREATE TABLE audit(value TEXT); CREATE TABLE evidence(value TEXT);`);
    if (setup) database.exec(setup);
  } catch (error) {
    database.close();
    if (root) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const actions: NativeAction[] = [];
  let statementSequence = 0;
  let active: { readonly id: number; readonly sql: string } | undefined;
  let restore = () => {};
  const observe = () => {
    const actualExec = database.exec.bind(database);
    const execObserver = spyOn(database, "exec").mockImplementation((sql) => {
      const prior = active;
      active = { id: ++statementSequence, sql };
      try {
        return actualExec(sql);
      } finally {
        active = prior;
      }
    });
    const actualAuthorizer = database.setAuthorizer.bind(database);
    const authorizerObserver = spyOn(database, "setAuthorizer").mockImplementation((authorize) => {
      if (authorize == null) return actualAuthorizer(null);
      return actualAuthorizer((action, first, second, schema, origin) => {
        const decision = authorize(action, first, second, schema, origin);
        actions.push({
          statement: active?.id ?? null,
          sql: active?.sql ?? null,
          action,
          first,
          second,
          schema,
          origin,
          decision,
        });
        return decision;
      });
    });
    restore = () => {
      authorizerObserver.mockRestore();
      execObserver.mockRestore();
    };
  };
  observe();
  const port = createSQLiteMigrationApplicationNativePort({
    async withAuthorizedDatabase(input) {
      if (!(await input.stillAuthorized())) throw new Error("fixture authority lost");
      return input.use(database);
    },
  });
  const prefix: SQLiteMigrationRecord[] = [];
  return {
    actions,
    get database() {
      return database;
    },
    async apply(sql: string) {
      const bytes = new TextEncoder().encode(sql);
      const result = await port.withAuthorizedMigrationSession({
        resourceUid: "staging-fts-database",
        execution: {
          operationId: "staging-fts-operation",
          leaseToken: "staging-fts-lease",
          backendKey: "staging-fts-backend",
          backendId: "selfhost-v2-sqlite-migration-application-native-v1",
          targetKey: "staging-fts-target",
          resourceUid: "staging-fts-application",
          principal: "staging-fts-owner",
          action: "create",
          generation: 1,
          form,
          space: "staging-fts",
          name: "staging-fts",
          spec: {},
        },
        stillAuthorized: async () => true,
        use: async (session) =>
          session.applyOneHeldFile({
            sequence: prefix.length + 1,
            expectedPrefix: prefix,
            entry: {
              path: `staging/${prefix.length + 1}.sql`,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            bytes,
            operationId: "staging-fts-operation",
          }),
      });
      if (result.kind === "applied") prefix.push(result.record);
      return result;
    },
    reopen() {
      if (!root) throw new Error("persistent fixture required");
      restore();
      database.close();
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        allowExtension: false,
      });
      observe();
    },
    close() {
      restore();
      try {
        database.close();
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function match(database: DatabaseSync, word: string): number {
  return Number(
    database.prepare("SELECT count(*) AS count FROM search WHERE search MATCH ?").get(word)?.count,
  );
}

function ordinaryState(database: DatabaseSync): string {
  return JSON.stringify({
    schema: database
      .prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY name")
      .all(),
    docs: database.prepare("SELECT * FROM docs ORDER BY id").all(),
    audit: database.prepare("SELECT * FROM audit").all(),
    ledger: database.prepare(`SELECT * FROM ${LEDGER}`).all(),
  });
}

test("FTS metadata uses the canonical token pass without changing executable bytes", () => {
  const sql = `/* outside */ CREATE VIRTUAL TABLE main."search" USING fts5("body", content='docs',content_rowid='id',tokenize='trigram');`;
  const statement = prepareNativeMigrationSql(sql, "introspection")[0];
  expect(statement?.sql).toBe(sql);
  expect(statement?.table).toMatchObject({
    kind: "virtual",
    schema: "main",
    name: "search",
    module: "fts5",
  });
  expect(
    statement?.table?.arguments.map((argument) => argument.map((token) => token.value)),
  ).toEqual([
    ["body"],
    ["content", "=", "docs"],
    ["content_rowid", "=", "id"],
    ["tokenize", "=", "trigram"],
  ]);
});

test("FTS 0.4 generic trigram rebuild, triggers, rollback, reopen and reprepare retain native callback fences", async () => {
  const f = fixture("", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0, true);
  try {
    expect((await f.apply(READY)).kind).toBe("applied");
    expect(match(f.database, "fore")).toBe(1);
    const before = ordinaryState(f.database);
    expect(
      await f.apply(
        "UPDATE docs SET body='desert canyon' WHERE id=1; INSERT INTO docs VALUES(1,'duplicate');",
      ),
    ).toEqual({ kind: "rejected", code: "migration_sql_error" });
    expect(ordinaryState(f.database)).toBe(before);
    expect(match(f.database, "fore")).toBe(1);
    expect(match(f.database, "cany")).toBe(0);
    expect((await f.apply("UPDATE docs SET body='desert canyon' WHERE id=1;")).kind).toBe(
      "applied",
    );
    expect(match(f.database, "fore")).toBe(0);
    expect(match(f.database, "cany")).toBe(1);
    expect(
      (await f.apply("DELETE FROM docs WHERE id=1; INSERT INTO docs VALUES(2,'summer meadow');"))
        .kind,
    ).toBe("applied");
    expect(match(f.database, "cany")).toBe(0);
    expect(match(f.database, "mead")).toBe(1);
    f.reopen();
    const reopened = f.actions.length;
    expect(
      (
        await f.apply(
          "INSERT INTO evidence SELECT rowid FROM search WHERE search MATCH 'mead'; INSERT INTO docs VALUES(3,'spring forest');",
        )
      ).kind,
    ).toBe("applied");
    expect(match(f.database, "fore")).toBe(1);
    expect(
      (
        await f.apply(
          "INSERT INTO evidence SELECT rowid FROM search WHERE search MATCH 'fore'; CREATE TABLE unrelated(value TEXT); INSERT INTO evidence SELECT rowid FROM search WHERE search MATCH 'mead';",
        )
      ).kind,
    ).toBe("applied");
    expect(f.database.prepare(`SELECT sequence FROM ${LEDGER} ORDER BY sequence`).all()).toEqual(
      [1, 2, 3, 4, 5].map((sequence) => ({ sequence })),
    );
    const metadata = f.actions.filter(
      (event) =>
        event.action === SQLITE.SQLITE_PRAGMA &&
        event.first === "data_version" &&
        event.decision === SQLITE.SQLITE_OK,
    );
    expect(metadata.length).toBeGreaterThanOrEqual(3);
    for (const event of metadata) {
      expect(event).toMatchObject({ schema: "main", second: null, origin: null });
      expect(event.statement).not.toBeNull();
      const index = f.actions.indexOf(event);
      expect(
        f.actions
          .slice(0, index)
          .some(
            (prior) =>
              prior.statement === event.statement &&
              prior.first === "search" &&
              prior.schema === "main" &&
              prior.decision === SQLITE.SQLITE_OK &&
              [
                SQLITE.SQLITE_READ,
                SQLITE.SQLITE_INSERT,
                SQLITE.SQLITE_UPDATE,
                SQLITE.SQLITE_DELETE,
              ].some((action) => action === prior.action),
          ),
      ).toBe(true);
    }
    expect(
      f.actions
        .slice(reopened)
        .some(
          (event) =>
            event.action === SQLITE.SQLITE_PRAGMA &&
            event.first === "data_version" &&
            event.decision === SQLITE.SQLITE_OK,
        ),
    ).toBe(true);
    expect(
      f.actions.some(
        (event) =>
          event.action === SQLITE.SQLITE_INSERT &&
          event.first === "search" &&
          event.origin === "docs_ai",
      ),
    ).toBe(true);
    expect(
      f.actions.some(
        (event) => event.action === SQLITE.SQLITE_PRAGMA && event.first === "table_list",
      ),
    ).toBe(false);
    expect(f.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(f.database.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
  } finally {
    f.close();
  }
});

for (const sql of [
  "CREATE VIRTUAL TABLE local_search USING fts5(body,tokenize='trigram'); INSERT INTO local_search VALUES('winter forest'); INSERT INTO evidence SELECT rowid FROM local_search WHERE local_search MATCH 'fore';",
  "CREATE VIRTUAL TABLE local_search USING fts5(body,content='',columnsize=0,tokenize='trigram'); INSERT INTO local_search(rowid,body) VALUES(1,'winter forest'); INSERT INTO evidence SELECT rowid FROM local_search WHERE local_search MATCH 'fore';",
]) {
  test(`FTS 0.4 verifies builtin shadow roles for ${sql.includes("content=''") ? "contentless" : "ordinary content"}`, async () => {
    const f = fixture();
    try {
      expect((await f.apply(sql)).kind).toBe("applied");
      expect(f.database.prepare("SELECT value FROM evidence").all()).toEqual([{ value: "1" }]);
    } finally {
      f.close();
    }
  });
}

const FORBIDDEN_READS = [
  {
    label: "same SQL after FTS READ",
    sql: "SELECT search.rowid,p.data_version FROM search CROSS JOIN pragma_data_version AS p WHERE search MATCH 'fore'",
  },
  {
    label: "quoted schema and alias",
    sql: "SELECT s.rowid,p.data_version FROM main.search AS s CROSS JOIN main.\"pragma_data_version\" AS p WHERE search MATCH 'fore'",
  },
  {
    label: "CTE",
    sql: "WITH hidden AS (SELECT * FROM pragma_data_version) SELECT s.rowid,p.data_version FROM search s CROSS JOIN hidden p WHERE search MATCH 'fore'",
  },
  {
    label: "view",
    setup: "CREATE VIEW hidden AS SELECT * FROM pragma_data_version;",
    sql: "SELECT search.rowid,hidden.data_version FROM search CROSS JOIN hidden WHERE search MATCH 'fore'",
  },
  {
    label: "trigger with earlier FTS READ",
    setup:
      "CREATE TRIGGER leak AFTER INSERT ON docs BEGIN INSERT INTO evidence SELECT rowid FROM search WHERE search MATCH 'fore'; INSERT INTO audit SELECT data_version FROM pragma_data_version; END;",
    sql: "INSERT INTO docs VALUES(2,'summer meadow')",
  },
  {
    label: "hidden schema",
    sql: "SELECT search.rowid,p.name FROM search CROSS JOIN pragma_table_xinfo AS p WHERE p.arg='docs' AND p.schema='main' AND search MATCH 'fore'",
  },
  {
    label: "hidden ledger target",
    ledger: true,
    sql: `SELECT search.rowid,p.name FROM search CROSS JOIN pragma_table_info AS p WHERE p.arg='${LEDGER}' AND p.schema='main' AND search MATCH 'fore'`,
  },
  {
    label: "other read-only PRAGMA function",
    sql: "SELECT search.rowid,p.foreign_keys FROM search CROSS JOIN pragma_foreign_keys AS p WHERE search MATCH 'fore'",
  },
] as const;

for (const entry of FORBIDDEN_READS) {
  test(`FTS 0.4 still denies resolved forbidden metadata via ${entry.label}`, async () => {
    const f = fixture(READY + ("setup" in entry ? entry.setup : ""));
    try {
      const before = ordinaryState(f.database);
      expect(await f.apply(`INSERT INTO audit VALUES('before'); ${entry.sql}`)).toEqual({
        kind: "rejected",
        code: "migration_sql_error",
      });
      expect(ordinaryState(f.database)).toBe(before);
      expect(
        f.actions.some(
          (event) =>
            event.decision === SQLITE.SQLITE_DENY &&
            ("ledger" in entry
              ? event.action === SQLITE.SQLITE_PRAGMA &&
                event.first === "table_info" &&
                event.second === LEDGER
              : event.action === SQLITE.SQLITE_READ &&
                (event.first === "pragma_data_version" ||
                  event.first === "pragma_foreign_keys" ||
                  event.first === "pragma_table_xinfo")),
        ),
      ).toBe(true);
      if (entry.label === "same SQL after FTS READ") {
        const forbidden = f.actions.findIndex(
          (event) =>
            event.action === SQLITE.SQLITE_READ &&
            event.first === "pragma_data_version" &&
            event.decision === SQLITE.SQLITE_DENY,
        );
        expect(
          f.actions
            .slice(0, forbidden)
            .some(
              (event) =>
                event.action === SQLITE.SQLITE_READ &&
                event.first === "search" &&
                event.decision === SQLITE.SQLITE_OK,
            ),
        ).toBe(true);
      }
    } finally {
      f.close();
    }
  });
}

test("FTS 0.4 keeps real ordinary pragma-prefixed tables and harmless literals", async () => {
  const f = fixture(READY);
  try {
    expect(
      (
        await f.apply(
          "CREATE TABLE pragma_notes(value TEXT); INSERT INTO pragma_notes VALUES('pragma_data_version'); INSERT INTO evidence SELECT value FROM pragma_notes; CREATE TABLE pragma_data_version(value TEXT); INSERT INTO pragma_data_version VALUES('ordinary table'); INSERT INTO evidence SELECT value FROM pragma_data_version;",
        )
      ).kind,
    ).toBe("applied");
    expect(f.database.prepare("SELECT value FROM evidence ORDER BY value").all()).toEqual([
      { value: "ordinary table" },
      { value: "pragma_data_version" },
    ]);
  } finally {
    f.close();
  }
});

for (const [label, form] of [
  ["0.2", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0],
  ["0.3", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0],
] as const) {
  test(`FTS retained ${label} does not acquire the new builtin module permission`, async () => {
    const f = fixture(ORDINARY, form);
    try {
      const before = ordinaryState(f.database);
      expect(await f.apply(SEARCH)).toEqual({ kind: "rejected", code: "migration_sql_error" });
      expect(ordinaryState(f.database)).toBe(before);
      expect(
        f.actions.some(
          (event) =>
            event.action === SQLITE.SQLITE_CREATE_VTABLE &&
            event.second === "fts5" &&
            event.decision === SQLITE.SQLITE_DENY,
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
}

for (const entry of [
  {
    label: "protected ledger content",
    sql: `CREATE VIRTUAL TABLE bad USING fts5(path,content='${LEDGER}',content_rowid='sequence');`,
  },
  {
    label: "another virtual content target",
    sql: "CREATE VIRTUAL TABLE bad USING fts5(body,content='search');",
  },
  {
    label: "owned shadow content target",
    sql: "CREATE VIRTUAL TABLE bad USING fts5(block,content='search_data');",
  },
  {
    label: "preexisting shadow collision",
    setup: "CREATE TABLE bad_data(id INTEGER PRIMARY KEY,block BLOB);",
    sql: "CREATE VIRTUAL TABLE bad USING fts5(body);",
  },
  {
    label: "temporary FTS target",
    setup: "CREATE TEMP TABLE local_docs(body TEXT);",
    sql: "CREATE VIRTUAL TABLE temp.bad USING fts5(body,content='local_docs');",
  },
  {
    label: "attached FTS target",
    setup: "ATTACH ':memory:' AS other; CREATE TABLE other.local_docs(body TEXT);",
    sql: "CREATE VIRTUAL TABLE other.bad USING fts5(body,content='local_docs');",
  },
  {
    label: "different builtin module",
    sql: "CREATE VIRTUAL TABLE bad USING fts5vocab(search,'row');",
  },
] as const) {
  test(`FTS 0.4 denies ${entry.label} before native module initialization`, async () => {
    const f = fixture(READY + ("setup" in entry ? entry.setup : ""));
    try {
      const before = ordinaryState(f.database);
      expect(await f.apply(`INSERT INTO audit VALUES('before'); ${entry.sql}`)).toEqual({
        kind: "rejected",
        code: "migration_sql_error",
      });
      expect(ordinaryState(f.database)).toBe(before);
      expect(
        f.actions.some(
          (event) =>
            event.decision === SQLITE.SQLITE_DENY &&
            (entry.label === "temporary FTS target"
              ? event.schema === "temp"
              : entry.label === "attached FTS target"
                ? event.schema === "other"
                : event.action === SQLITE.SQLITE_CREATE_VTABLE),
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
}

for (const sql of [
  "PRAGMA data_version",
  "PRAGMA main.data_version",
  'PRAGMA main."data_version"',
  "PRAGMA writable_schema=ON",
  "SELECT load_extension('/synthetic-not-opened')",
]) {
  test(`FTS 0.4 preserves the direct forbidden effect: ${sql}`, async () => {
    const f = fixture(READY);
    try {
      const before = ordinaryState(f.database);
      expect(
        await f.apply(
          `INSERT INTO audit SELECT rowid FROM search WHERE search MATCH 'fore'; ${sql};`,
        ),
      ).toEqual({ kind: "rejected", code: "migration_sql_error" });
      expect(ordinaryState(f.database)).toBe(before);
    } finally {
      f.close();
    }
  });
}
