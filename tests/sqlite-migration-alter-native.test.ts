import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
const ROWS =
  "CREATE TABLE tenant_rows(id INTEGER PRIMARY KEY,body TEXT CHECK(length(body)>0)); INSERT INTO tenant_rows VALUES(1,'first'),(2,'second');";
const ADD =
  "ALTER TABLE tenant_rows ADD COLUMN attempts INTEGER NOT NULL DEFAULT 7 CHECK(attempts BETWEEN 0 AND 9);";
const PROFILES = [
  ["0.2", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0],
  ["0.3", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0],
  ["0.4", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0],
] as const;

interface NativeAction {
  readonly sql: string | null;
  readonly action: number;
  readonly first: string | null;
  readonly second: string | null;
  readonly schema: string | null;
  readonly origin: string | null;
  readonly decision: number;
}

function fixture(form: string, rows = ROWS, setup = "") {
  const database = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    database.exec(`CREATE TABLE ${LEDGER} (
      sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 512),
      path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),operation_id TEXT NOT NULL
    ); CREATE TABLE audit(value TEXT); CREATE TABLE evidence(value TEXT);`);
    database.exec(rows);
    if (setup) database.exec(setup);
  } catch (error) {
    database.close();
    throw error;
  }
  const actions: NativeAction[] = [];
  let activeSql: string | null = null;
  const actualExec = database.exec.bind(database);
  const execObserver = spyOn(database, "exec").mockImplementation((sql) => {
    const prior = activeSql;
    activeSql = sql;
    try {
      return actualExec(sql);
    } finally {
      activeSql = prior;
    }
  });
  const actualAuthorizer = database.setAuthorizer.bind(database);
  const authorizerObserver = spyOn(database, "setAuthorizer").mockImplementation((authorize) => {
    if (authorize == null) return actualAuthorizer(null);
    return actualAuthorizer((action, first, second, schema, origin) => {
      const decision = authorize(action, first, second, schema, origin);
      actions.push({ sql: activeSql, action, first, second, schema, origin, decision });
      return decision;
    });
  });
  const prefix: SQLiteMigrationRecord[] = [];
  const port = createSQLiteMigrationApplicationNativePort({
    async withAuthorizedDatabase(input) {
      if (!(await input.stillAuthorized())) throw new Error("fixture authority lost");
      return input.use(database);
    },
  });
  return {
    database,
    actions,
    async apply(sql: string) {
      const bytes = new TextEncoder().encode(sql);
      const sequence = prefix.length + 1;
      return port.withAuthorizedMigrationSession({
        resourceUid: "staging-alter-database",
        execution: {
          operationId: `staging-alter-operation-${sequence}`,
          leaseToken: "staging-alter-lease",
          backendKey: "staging-alter-backend",
          backendId: "selfhost-v2-sqlite-migration-application-native-v1",
          targetKey: "staging-alter-target",
          resourceUid: "staging-alter-application",
          principal: "staging-alter-owner",
          action: "create",
          generation: 1,
          form,
          space: "staging-alter",
          name: "staging-alter",
          spec: {},
        },
        stillAuthorized: async () => true,
        use: async (session) => {
          const result = await session.applyOneHeldFile({
            sequence,
            expectedPrefix: prefix.slice(),
            entry: {
              path: `staging/alter-${sequence}.sql`,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            bytes,
            operationId: `staging-alter-operation-${sequence}`,
          });
          if (result.kind === "applied") prefix.push(result.record);
          return result;
        },
      });
    },
    close() {
      authorizerObserver.mockRestore();
      execObserver.mockRestore();
      database.close();
    },
  };
}

function snapshot(database: DatabaseSync): string {
  // SQLite may lazily initialize this empty catalog while preparing main DDL.
  // Observe it before both snapshots; all actual objects remain compared.
  database.prepare("SELECT name FROM temp.sqlite_schema").all();
  const catalogs = database
    .prepare("PRAGMA database_list")
    .all()
    .map((row) => ({
      schema: row.name,
      rows: database
        .prepare(
          `SELECT type,name,tbl_name,sql FROM "${String(row.name).replaceAll('"', '""')}".sqlite_schema ORDER BY name`,
        )
        .all(),
    }));
  return JSON.stringify({
    catalogs,
    rows: database.prepare("SELECT * FROM tenant_rows ORDER BY id").all(),
    audit: database.prepare("SELECT * FROM audit").all(),
    evidence: database.prepare("SELECT * FROM evidence").all(),
    ledger: database.prepare(`SELECT * FROM ${LEDGER} ORDER BY sequence`).all(),
  });
}

function expectSettled(database: DatabaseSync) {
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

function expectInternalValidation(actions: readonly NativeAction[], target: string) {
  const checks = actions.filter(
    (event) =>
      event.action === SQLITE.SQLITE_PRAGMA &&
      event.first === "quick_check" &&
      event.decision === SQLITE.SQLITE_OK,
  );
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) {
    expect(check.second).toBe(target);
    expect(check.schema).toBe("main");
    expect(check.origin).toBe(null);
    const prior = actions.slice(0, actions.indexOf(check));
    expect(
      prior.some(
        (event) =>
          event.sql === check.sql &&
          event.action === SQLITE.SQLITE_ALTER_TABLE &&
          event.first === "main" &&
          event.second === target &&
          event.decision === SQLITE.SQLITE_OK,
      ),
    ).toBe(true);
    expect(
      prior.some(
        (event) =>
          event.sql === check.sql &&
          event.action === SQLITE.SQLITE_READ &&
          event.first === "pragma_quick_check" &&
          event.second === "quick_check" &&
          event.schema === "main" &&
          event.origin === null &&
          event.decision === SQLITE.SQLITE_OK,
      ),
    ).toBe(true);
  }
}

test("SQLite ALTER metadata comes from the same canonical tokens and preserves exact statement bytes", () => {
  const sql =
    '/* ordinary */ AlTeR TABLE [main]."Mixed Table" ADD /* column */ COLUMN `new value` INTEGER CHECK(1);\nALTER TABLE tenant_rows ADD bare INTEGER;\nALTER TABLE tenant_rows RENAME TO renamed;';
  const statements = prepareNativeMigrationSql(sql, "deny");
  expect(statements.map((statement) => statement.sql).join("")).toBe(sql);
  expect(statements.map((statement) => statement.alter)).toEqual([
    { kind: "add-column", schema: "main", name: "Mixed Table" },
    { kind: "add-column", schema: null, name: "tenant_rows" },
    undefined,
  ]);
  expect(
    prepareNativeMigrationSql(
      "CREATE TRIGGER t AFTER INSERT ON audit BEGIN SELECT 'ALTER TABLE tenant_rows ADD x'; END;",
      "deny",
    )[0]?.alter,
  ).toBeUndefined();
});

const DENIED = [
  { name: "direct PRAGMA", sql: "PRAGMA main.quick_check('tenant_rows');" },
  {
    name: "direct eponymous table",
    sql: "SELECT quick_check FROM pragma_quick_check('tenant_rows');",
    nativeDenial: true,
  },
  {
    name: "quoted main eponymous table after ADD",
    sql: `${ADD} SELECT q.quick_check FROM main."pragma_quick_check"('tenant_rows') AS q;`,
    nativeDenial: true,
  },
  {
    name: "CTE after ADD",
    sql: `${ADD} WITH q AS (SELECT quick_check FROM pragma_quick_check('tenant_rows')) SELECT * FROM q;`,
    nativeDenial: true,
  },
  {
    name: "view after ADD",
    setup: "CREATE VIEW quick_view AS SELECT quick_check FROM pragma_quick_check('tenant_rows');",
    sql: `${ADD} SELECT * FROM quick_view;`,
    nativeDenial: true,
  },
  {
    name: "trigger after ADD",
    setup:
      "CREATE TRIGGER tenant_audit AFTER INSERT ON audit BEGIN INSERT INTO evidence SELECT quick_check FROM pragma_quick_check('tenant_rows'); END;",
    sql: `${ADD} INSERT INTO audit VALUES('trigger');`,
    nativeDenial: true,
  },
  {
    name: "rename does not grant a later quick_check",
    sql: "ALTER TABLE tenant_rows RENAME TO renamed; SELECT quick_check FROM pragma_quick_check('renamed');",
    noValidationGrant: true,
  },
  {
    name: "protected ledger target",
    sql: `ALTER TABLE ${LEDGER} ADD COLUMN extra INTEGER CHECK(extra>0);`,
  },
  {
    name: "temporary target",
    setup: "CREATE TEMP TABLE temp_rows(id INTEGER CHECK(id>0)); INSERT INTO temp_rows VALUES(1);",
    sql: "ALTER TABLE temp.temp_rows ADD COLUMN extra INTEGER DEFAULT 1 CHECK(extra>0);",
  },
  {
    name: "attached target",
    setup:
      "ATTACH ':memory:' AS other; CREATE TABLE other.remote_rows(id INTEGER CHECK(id>0)); INSERT INTO other.remote_rows VALUES(1);",
    sql: "ALTER TABLE other.remote_rows ADD COLUMN extra INTEGER DEFAULT 1 CHECK(extra>0);",
  },
  {
    name: "implicit temporary shadow",
    setup:
      "CREATE TEMP TABLE tenant_rows(id INTEGER CHECK(id>0)); INSERT INTO temp.tenant_rows VALUES(1);",
    sql: ADD,
  },
  {
    name: "FTS shadow target",
    setup: "CREATE VIRTUAL TABLE search USING fts5(body);",
    sql: "ALTER TABLE search_config ADD COLUMN extra INTEGER DEFAULT 1 CHECK(extra>0);",
  },
  {
    name: "virtual target",
    setup: "CREATE VIRTUAL TABLE search USING fts5(body);",
    sql: "ALTER TABLE search ADD COLUMN extra INTEGER DEFAULT 1 CHECK(extra>0);",
  },
] as const;

for (const [version, form] of PROFILES) {
  test(`SQLite ALTER native ${version}: populated ADD DEFAULT CHECK uses native validation and retains its committed prefix`, async () => {
    const f = fixture(form);
    try {
      expect((await f.apply(ADD)).kind).toBe("applied");
      expect(f.database.prepare("SELECT attempts FROM tenant_rows ORDER BY id").all()).toEqual([
        { attempts: 7 },
        { attempts: 7 },
      ]);
      expectInternalValidation(f.actions, "tenant_rows");
      const before = snapshot(f.database);
      expect(
        await f.apply(
          "INSERT INTO audit VALUES('rollback'); ALTER TABLE tenant_rows ADD invalid INTEGER DEFAULT -1 CHECK(invalid>=0);",
        ),
      ).toEqual({ kind: "rejected", code: "migration_sql_error" });
      expect(snapshot(f.database)).toBe(before);
      expect(f.database.prepare(`SELECT sequence FROM ${LEDGER}`).all()).toEqual([{ sequence: 1 }]);
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  test(`SQLite ALTER native ${version}: existing CHECK is preserved when ordinary ADD needs no scan`, async () => {
    const f = fixture(form);
    try {
      expect((await f.apply("ALTER TABLE tenant_rows ADD note TEXT DEFAULT 'ok';")).kind).toBe(
        "applied",
      );
      expect(f.database.prepare("SELECT note FROM tenant_rows ORDER BY id").all()).toEqual([
        { note: "ok" },
        { note: "ok" },
      ]);
      expect(() => f.database.exec("UPDATE tenant_rows SET body='';")).toThrow();
      expect(f.database.prepare("SELECT id,body FROM tenant_rows ORDER BY id").all()).toEqual([
        { id: 1, body: "first" },
        { id: 2, body: "second" },
      ]);
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  test(`SQLite ALTER native ${version}: generated NOT NULL is validated without a new CHECK`, async () => {
    const f = fixture(
      form,
      "CREATE TABLE tenant_rows(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO tenant_rows VALUES(1,'first'),(2,'second');",
    );
    try {
      expect(
        (
          await f.apply(
            "ALTER TABLE tenant_rows ADD computed INTEGER GENERATED ALWAYS AS (id+10) VIRTUAL NOT NULL;",
          )
        ).kind,
      ).toBe("applied");
      expect(f.database.prepare("SELECT computed FROM tenant_rows ORDER BY id").all()).toEqual([
        { computed: 11 },
        { computed: 12 },
      ]);
      expectInternalValidation(f.actions, "tenant_rows");
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  test(`SQLite ALTER native ${version}: STRICT ADD validation remains native`, async () => {
    const f = fixture(
      form,
      "CREATE TABLE tenant_rows(id INTEGER PRIMARY KEY,body TEXT) STRICT; INSERT INTO tenant_rows VALUES(1,'first'),(2,'second');",
    );
    try {
      expect(
        (await f.apply("ALTER TABLE tenant_rows ADD note TEXT NOT NULL DEFAULT 'ok';")).kind,
      ).toBe("applied");
      expect(f.database.prepare("SELECT note FROM tenant_rows ORDER BY id").all()).toEqual([
        { note: "ok" },
        { note: "ok" },
      ]);
      expectInternalValidation(f.actions, "tenant_rows");
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  test(`SQLite ALTER native ${version}: same-file new table and quoted main ADD without COLUMN bind the actual target`, async () => {
    const f = fixture(form);
    try {
      expect(
        (
          await f.apply(
            'CREATE TABLE "Mixed Table"(id INTEGER PRIMARY KEY); INSERT INTO "Mixed Table" VALUES(1); ALTER TABLE [main]."Mixed Table" ADD `new value` INTEGER DEFAULT 3 CHECK(`new value`>=0);',
          )
        ).kind,
      ).toBe("applied");
      expect(f.database.prepare('SELECT "new value" FROM "Mixed Table"').all()).toEqual([
        { "new value": 3 },
      ]);
      expectInternalValidation(f.actions, "Mixed Table");
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  test(`SQLite ALTER native ${version}: real ordinary pragma_quick_check table is not an eponymous grant`, async () => {
    const f = fixture(form);
    try {
      expect(
        (
          await f.apply(
            "CREATE TABLE pragma_quick_check(quick_check TEXT); INSERT INTO pragma_quick_check VALUES('ordinary'); INSERT INTO evidence SELECT quick_check FROM pragma_quick_check;",
          )
        ).kind,
      ).toBe("applied");
      expect(f.database.prepare("SELECT * FROM evidence").all()).toEqual([{ value: "ordinary" }]);
      expect(
        f.actions.some(
          (event) => event.first === "quick_check" && event.decision === SQLITE.SQLITE_OK,
        ),
      ).toBe(false);
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });

  for (const entry of DENIED) {
    test(`SQLite ALTER native ${version}: refuses ${entry.name} without stale validation authority`, async () => {
      const f = fixture(form, ROWS, "setup" in entry ? entry.setup : "");
      try {
        const before = snapshot(f.database);
        expect(await f.apply(`INSERT INTO audit VALUES('before'); ${entry.sql}`)).toEqual({
          kind: "rejected",
          code: "migration_sql_error",
        });
        expect(snapshot(f.database)).toBe(before);
        if ("nativeDenial" in entry) {
          expect(
            f.actions.some(
              (event) =>
                event.action === SQLITE.SQLITE_READ &&
                event.first === "pragma_quick_check" &&
                event.decision === SQLITE.SQLITE_DENY,
            ),
          ).toBe(true);
        }
        if ("noValidationGrant" in entry) {
          expect(
            f.actions.some(
              (event) => event.first === "quick_check" && event.decision === SQLITE.SQLITE_OK,
            ),
          ).toBe(false);
        }
        expectSettled(f.database);
      } finally {
        f.close();
      }
    });
  }
}

test("SQLite ALTER native 0.4: ordinary rename keeps its existing behavior without a validation grant", async () => {
  const f = fixture(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0);
  try {
    expect((await f.apply("ALTER TABLE tenant_rows RENAME TO renamed;")).kind).toBe("applied");
    expect(f.database.prepare("SELECT count(*) AS n FROM renamed").get()).toEqual({ n: 2 });
    expect(
      f.actions.some(
        (event) => event.first === "quick_check" && event.decision === SQLITE.SQLITE_OK,
      ),
    ).toBe(false);
    expectSettled(f.database);
  } finally {
    f.close();
  }
});

for (const [version, form] of PROFILES.slice(0, 2)) {
  test(`SQLite ALTER native retained ${version}: Host catalog snapshots give no tenant introspection permission`, async () => {
    const f = fixture(form);
    try {
      const before = snapshot(f.database);
      expect(
        await f.apply(
          "INSERT INTO audit VALUES('rollback'); SELECT * FROM pragma_table_info('tenant_rows');",
        ),
      ).toEqual({ kind: "rejected", code: "migration_sql_error" });
      expect(snapshot(f.database)).toBe(before);
      expect(
        f.actions.some(
          (event) =>
            event.action === SQLITE.SQLITE_PRAGMA &&
            event.first === "table_info" &&
            event.decision === SQLITE.SQLITE_DENY,
        ),
      ).toBe(true);
      expectSettled(f.database);
    } finally {
      f.close();
    }
  });
}
