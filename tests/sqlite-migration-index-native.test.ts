import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { DatabaseSync, constants as SQLITE } from "node:sqlite";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationNativePort } from "../src/takoform-v2/forms/sqlite-migration-application-native.ts";

const LEDGER = "_takoform_sqlite_migrations";
const PROFILES = [
  ["0.2", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0],
  ["0.3", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0],
  ["0.4", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0],
] as const;

function fixture(form: string, setup = "") {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE ${LEDGER} (
        sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 512),
        path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        operation_id TEXT NOT NULL
      );
      CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO item VALUES(1,'a'),(2,'b');
      CREATE INDEX item_existing ON item(value);
      CREATE TABLE audit(value TEXT);`);
    if (setup) database.exec(setup);
  } catch (error) {
    database.close();
    throw error;
  }
  const port = createSQLiteMigrationApplicationNativePort({
    async withAuthorizedDatabase(input) {
      if (!(await input.stillAuthorized())) throw new Error("fixture authority lost");
      return input.use(database);
    },
  });
  return {
    database,
    async apply(sql: string) {
      const bytes = new TextEncoder().encode(sql);
      return port.withAuthorizedMigrationSession({
        resourceUid: "staging-index-database",
        execution: {
          operationId: "staging-index-operation",
          leaseToken: "staging-index-lease",
          backendKey: "staging-index-backend",
          backendId: "selfhost-v2-sqlite-migration-application-native-v1",
          targetKey: "staging-index-target",
          resourceUid: "staging-index-application",
          principal: "staging-index-owner",
          action: "create",
          generation: 1,
          form,
          space: "staging-index",
          name: "staging-index",
          spec: {},
        },
        stillAuthorized: async () => true,
        use: async (session) =>
          session.applyOneHeldFile({
            sequence: 1,
            expectedPrefix: [],
            entry: {
              path: "staging/index.sql",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            bytes,
            operationId: "staging-index-operation",
          }),
      });
    },
  };
}

function snapshot(database: DatabaseSync): string {
  const catalogs = ["main", "temp", "other"].flatMap((schema) => {
    if (
      !database
        .prepare("PRAGMA database_list")
        .all()
        .some((row) => row.name === schema)
    )
      return [];
    return [
      {
        schema,
        rows: database
          .prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema ORDER BY name`)
          .all(),
      },
    ];
  });
  return JSON.stringify({
    catalogs,
    rows: database.prepare("SELECT * FROM item ORDER BY id").all(),
    audit: database.prepare("SELECT * FROM audit").all(),
    ledger: database.prepare(`SELECT * FROM ${LEDGER}`).all(),
  });
}

const DENIED = [
  { name: "bare REINDEX", sql: "REINDEX;" },
  { name: "named REINDEX", sql: "REINDEX item_existing;" },
  { name: "qualified REINDEX", sql: "REINDEX main.item_existing;" },
  {
    name: "REINDEX in a later statement",
    sql: "CREATE INDEX new_index ON item(value); REINDEX new_index;",
  },
  {
    name: "REINDEX after a constraint-created index",
    sql: "CREATE TABLE constrained_before(value TEXT UNIQUE); REINDEX sqlite_autoindex_constrained_before_1;",
  },
  {
    name: "ANALYZE after an allowed index",
    sql: "CREATE INDEX new_index ON item(value); ANALYZE item;",
  },
  { name: "index on protected ledger", sql: `CREATE INDEX ledger_probe ON ${LEDGER}(path);` },
  { name: "protected ledger autoindex", sql: `REINDEX sqlite_autoindex_${LEDGER}_1;` },
  {
    name: "temporary index",
    setup: "CREATE TEMP TABLE transient_item(value TEXT)",
    sql: "CREATE INDEX temp.temp_index ON transient_item(value);",
  },
  {
    name: "attached index",
    setup: "ATTACH ':memory:' AS other; CREATE TABLE other.remote_item(value TEXT)",
    sql: "CREATE INDEX other.remote_index ON remote_item(value);",
  },
  {
    name: "unique failure rolls back earlier index and data",
    sql: "CREATE INDEX new_index ON item(value); INSERT INTO item VALUES(3,'a'); CREATE UNIQUE INDEX conflict ON item(value);",
  },
] as const;

for (const [version, form] of PROFILES) {
  test(`SQLite index native ${version}: ordinary and constraint indexes commit through genuine initial-build callbacks`, async () => {
    const f = fixture(form);
    const actions: {
      action: number;
      first: string | null;
      second: string | null;
      schema: string | null;
      origin: string | null;
      decision: number;
    }[] = [];
    const genuine = f.database.setAuthorizer.bind(f.database);
    const observer = spyOn(f.database, "setAuthorizer").mockImplementation((authorize) => {
      if (authorize == null) return genuine(null);
      return genuine((action, first, second, schema, origin) => {
        const decision = authorize(action, first, second, schema, origin);
        actions.push({ action, first, second, schema, origin, decision });
        return decision;
      });
    });
    try {
      expect(
        (
          await f.apply(`CREATE INDEX item_value ON item(value);
        CREATE UNIQUE INDEX IF NOT EXISTS item_unique ON item(value);
        CREATE INDEX IF NOT EXISTS item_value ON item(value);
        CREATE TABLE constrained(id INTEGER PRIMARY KEY, value TEXT UNIQUE, other TEXT, UNIQUE(value,other));
        INSERT INTO constrained VALUES(1,'ok','other');`)
        ).kind,
      ).toBe("applied");
      expect(
        f.database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name IN ('item','constrained') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "item_existing" },
        { name: "item_unique" },
        { name: "item_value" },
        { name: "sqlite_autoindex_constrained_1" },
        { name: "sqlite_autoindex_constrained_2" },
      ]);
      expect(() => f.database.exec("INSERT INTO item VALUES(3,'a')")).toThrow();
      expect(() => f.database.exec("INSERT INTO constrained VALUES(2,'ok','different')")).toThrow();
      expect(f.database.prepare(`SELECT sequence,operation_id FROM ${LEDGER}`).all()).toEqual([
        { sequence: 1, operation_id: "staging-index-operation" },
      ]);
      for (const index of ["item_value", "item_unique"]) {
        const creation = actions.findIndex(
          (event) =>
            event.action === SQLITE.SQLITE_CREATE_INDEX &&
            event.first === index &&
            event.schema === "main" &&
            event.origin === null &&
            event.decision === SQLITE.SQLITE_OK,
        );
        const initialBuild = actions.findIndex(
          (event) =>
            event.action === SQLITE.SQLITE_REINDEX &&
            event.first === index &&
            event.second === null &&
            event.schema === "main" &&
            event.origin === null &&
            event.decision === SQLITE.SQLITE_OK,
        );
        expect(creation).toBeGreaterThanOrEqual(0);
        expect(initialBuild).toBeGreaterThan(creation);
      }
      expect(f.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(f.database.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
    } finally {
      observer.mockRestore();
      f.database.close();
    }
  });

  for (const entry of DENIED) {
    test(`SQLite index native ${version}: refuses ${entry.name} and rolls back the whole file`, async () => {
      const f = fixture(form, "setup" in entry ? entry.setup : "");
      try {
        const before = snapshot(f.database);
        expect(await f.apply(`INSERT INTO audit VALUES('before'); ${entry.sql}`)).toEqual({
          kind: "rejected",
          code: "migration_sql_error",
        });
        expect(snapshot(f.database)).toBe(before);
        expect(f.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
        expect(f.database.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
      } finally {
        f.database.close();
      }
    });
  }
}
