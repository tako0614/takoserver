import { type DatabaseSync, constants as SQLITE } from "node:sqlite";
import {
  isMigrationDeferForeignKeysName,
  isMigrationDeferForeignKeysValue,
  isMigrationIntrospectionPragma,
  type MigrationSqlStatement,
  prepareNativeMigrationSql,
} from "../../sqlite-migration-policy.ts";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0,
  type SQLiteMigrationApplicationFormUrl,
} from "./sqlite-migration-application.ts";
import type {
  SQLiteMigrationApplicationPort,
  SQLiteMigrationEntry,
  SQLiteMigrationFileResult,
  SQLiteMigrationRecord,
} from "./sqlite-migration-application-port.ts";

const LEDGER = "_takoform_sqlite_migrations";

/** Host-only SQLite capability used by this adapter; never part of the Worker SDK port. */
interface AuthorizedSQLiteDatabaseStore {
  withAuthorizedDatabase<T>(input: {
    readonly resourceUid: string;
    readonly stillAuthorized: () => Promise<boolean>;
    readonly use: (database: DatabaseSync) => Promise<T> | T;
  }): Promise<T>;
}

/** Self-host realization of the portable migration session. Never expose this to a Worker. */
export function createSQLiteMigrationApplicationNativePort(
  store: AuthorizedSQLiteDatabaseStore,
): SQLiteMigrationApplicationPort {
  return {
    withAuthorizedMigrationSession(input) {
      const formUrl = input.execution.form;
      if (
        formUrl !== SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0 &&
        formUrl !== SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0 &&
        formUrl !== SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0
      )
        return Promise.reject(new Error("SQLiteMigrationApplication Form identity is unsupported"));
      return store.withAuthorizedDatabase({
        resourceUid: input.resourceUid,
        stillAuthorized: input.stillAuthorized,
        use(database) {
          let transactionUncertain = false;
          return input.use({
            async readLedger() {
              // The same handle may see its own uncommitted ledger writes after
              // a failed rollback. Never use that view as a durable receipt.
              if (transactionUncertain) return { kind: "unknown" };
              try {
                return { kind: "read", entries: readLedger(database) };
              } catch {
                return { kind: "unknown" };
              }
            },
            async applyOneHeldFile(file): Promise<SQLiteMigrationFileResult> {
              if (transactionUncertain) return { kind: "unknown" };
              // A stale or reordered caller cannot write a second history branch.
              if (!(await input.stillAuthorized())) return { kind: "unknown" };
              try {
                const ledger = readLedger(database);
                if (
                  ledger.length !== file.sequence - 1 ||
                  ledger.length !== file.expectedPrefix.length ||
                  !ledger.every(
                    (row, index) =>
                      row.sequence === file.expectedPrefix[index]?.sequence &&
                      row.path === file.expectedPrefix[index]?.path &&
                      row.sha256 === file.expectedPrefix[index]?.sha256 &&
                      row.operationId === file.expectedPrefix[index]?.operationId,
                  )
                ) {
                  return { kind: "unknown" };
                }
              } catch {
                return { kind: "unknown" };
              }
              if (!(file.bytes instanceof Uint8Array)) {
                return { kind: "rejected", code: "artifact_invalid" };
              }
              let sqlText: string;
              try {
                sqlText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
                  file.bytes,
                );
              } catch {
                return { kind: "rejected", code: "artifact_invalid" };
              }
              if (sqlText.includes("\0")) return { kind: "rejected", code: "migration_sql_error" };
              try {
                runFileAndLedger(
                  database,
                  sqlText,
                  file.entry,
                  file.sequence,
                  file.operationId,
                  formUrl,
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                if (message === "rollback_unconfirmed") {
                  transactionUncertain = true;
                  return { kind: "unknown" };
                }
                return {
                  kind: "rejected",
                  code: /locked|busy/iu.test(message) ? "database_busy" : "migration_sql_error",
                };
              }
              // A successful native call alone is not a durable receipt. If
              // readback fails after COMMIT, the orchestrator reconciles later.
              try {
                const ledger = readLedger(database);
                const record = ledger[file.sequence - 1];
                if (
                  ledger.length !== file.sequence ||
                  record?.path !== file.entry.path ||
                  record.sha256 !== file.entry.sha256 ||
                  record.operationId !== file.operationId
                ) {
                  return { kind: "unknown" };
                }
                return { kind: "applied", sequence: file.sequence, record };
              } catch {
                return { kind: "unknown" };
              }
            },
          });
        },
      });
    },
  };
}

function readLedger(database: DatabaseSync): readonly SQLiteMigrationRecord[] {
  const rows = database
    .prepare(`SELECT sequence, path, sha256, operation_id FROM ${LEDGER} ORDER BY sequence`)
    .all() as readonly Record<string, unknown>[];
  if (rows.length > 512) throw new Error("migration_history_uncertain");
  return rows.map((row, index) => {
    if (
      row.sequence !== index + 1 ||
      typeof row.path !== "string" ||
      typeof row.sha256 !== "string" ||
      typeof row.operation_id !== "string" ||
      row.operation_id.length === 0 ||
      !/^[0-9a-f]{64}$/u.test(row.sha256)
    ) {
      throw new Error("migration_history_uncertain");
    }
    return {
      sequence: index + 1,
      path: row.path,
      sha256: row.sha256,
      operationId: row.operation_id,
    };
  });
}

function runFileAndLedger(
  database: DatabaseSync,
  sqlText: string,
  entry: SQLiteMigrationEntry,
  sequence: number,
  operationId: string,
  formUrl: SQLiteMigrationApplicationFormUrl,
): void {
  // One canonical token pass; provider callers keep their older conservative
  // policy. Only the exact accepted 0.4 Form gains native introspection.
  const introspection = formUrl === SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0;
  const statements = prepareNativeMigrationSql(
    sqlText,
    formUrl === SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0
      ? "deny"
      : introspection
        ? "introspection"
        : "defer",
  );
  let internalTransaction = false;
  let internalLedger = false;
  let started = false;
  let currentStatement: MigrationSqlStatement | undefined;
  const protectedObjects = new Set([LEDGER]);
  const mainTables = new Set(["sqlite_master", "sqlite_schema"]);
  const mainIndexes = new Set<string>();
  const nonMainCatalogs: {
    readonly schema: string;
    readonly tables: ReadonlySet<string>;
    readonly indexes: ReadonlySet<string>;
  }[] = [];
  // These states are private to the exact trusted metadata methods below.
  // They admit only fixed read actions, never arbitrary SQL or a caller flag.
  let metadataQuery:
    | { readonly kind: "database-list" }
    | { readonly kind: "catalog"; readonly schema: string }
    | undefined;
  const readCatalog = (name: string): readonly Record<string, unknown>[] => {
    metadataQuery = { kind: "catalog", schema: asciiLower(name) as string };
    try {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return database.prepare(`SELECT name, type, tbl_name FROM ${quoted}.sqlite_schema`).all();
    } finally {
      metadataQuery = undefined;
    }
  };
  const updateMainCatalog = (objects: readonly Record<string, unknown>[]): void => {
    mainTables.clear();
    mainIndexes.clear();
    mainTables.add("sqlite_master");
    mainTables.add("sqlite_schema");
    for (const object of objects) {
      if (typeof object.name !== "string" || typeof object.tbl_name !== "string")
        throw new Error("migration_schema_unconfirmed");
      const name = asciiLower(object.name) as string;
      if (object.type === "index") mainIndexes.add(name);
      else if (object.type === "table" || object.type === "view") mainTables.add(name);
      if (asciiLower(object.tbl_name) === LEDGER) protectedObjects.add(name);
    }
  };
  const outsideMain = (name: string, indexInfo: boolean): boolean => {
    if (name === "sqlite_temp_master" || name === "sqlite_temp_schema") return true;
    // SQLite FindIndex searches all indexes first, then index_info falls back
    // to FindTable (WITHOUT ROWID). Each search is temp, main, attached order.
    if (indexInfo) {
      if (nonMainCatalogs.some((catalog) => catalog.schema === "temp" && catalog.indexes.has(name)))
        return true;
      if (mainIndexes.has(name)) return false;
      if (nonMainCatalogs.some((catalog) => catalog.schema !== "temp" && catalog.indexes.has(name)))
        return true;
    }
    if (nonMainCatalogs.some((catalog) => catalog.schema === "temp" && catalog.tables.has(name)))
      return true;
    if (mainTables.has(name)) return false;
    return nonMainCatalogs.some((catalog) => catalog.schema !== "temp" && catalog.tables.has(name));
  };
  database.setAuthorizer((action, first, second, schema, origin) => {
    const a = asciiLower(first);
    const b = asciiLower(second);
    const db = asciiLower(schema);
    if (metadataQuery?.kind === "database-list") {
      return action === SQLITE.SQLITE_PRAGMA &&
        a === "database_list" &&
        second === null &&
        schema === null
        ? SQLITE.SQLITE_OK
        : SQLITE.SQLITE_DENY;
    }
    if (metadataQuery?.kind === "catalog") {
      return action === SQLITE.SQLITE_SELECT ||
        (action === SQLITE.SQLITE_READ &&
          db === metadataQuery.schema &&
          isSchemaCatalog(a, true) &&
          (b === "name" || b === "type" || b === "tbl_name"))
        ? SQLITE.SQLITE_OK
        : SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_TRANSACTION || action === SQLITE.SQLITE_SAVEPOINT) {
      return internalTransaction ? SQLITE.SQLITE_OK : SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_PRAGMA) {
      if (
        !started ||
        !currentStatement ||
        internalTransaction ||
        internalLedger ||
        (schema !== null && db !== "main")
      )
        return SQLITE.SQLITE_DENY;
      if (introspection && isMigrationIntrospectionPragma(first)) {
        if (
          b !== null &&
          (protectedObjects.has(b) || (schema === null && outsideMain(b, a === "index_info")))
        )
          return SQLITE.SQLITE_DENY;
        return SQLITE.SQLITE_OK;
      }
      return formUrl !== SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0 &&
        currentStatement.pragma === "defer" &&
        isMigrationDeferForeignKeysName(first) &&
        isMigrationDeferForeignKeysValue(second)
        ? SQLITE.SQLITE_OK
        : SQLITE.SQLITE_DENY;
    }
    if (
      action === SQLITE.SQLITE_ATTACH ||
      action === SQLITE.SQLITE_DETACH ||
      action === SQLITE.SQLITE_REINDEX ||
      action === SQLITE.SQLITE_ANALYZE ||
      action === SQLITE.SQLITE_COPY ||
      action === SQLITE.SQLITE_CREATE_VTABLE ||
      action === SQLITE.SQLITE_DROP_VTABLE
    ) {
      return SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_FUNCTION && second?.toLowerCase() === "load_extension") {
      return SQLITE.SQLITE_DENY;
    }
    // ALTER reports its target schema in arg1. Its own temporary-catalog
    // maintenance is allowed only for a main-target ALTER statement below.
    if (action === SQLITE.SQLITE_ALTER_TABLE && a !== "main") return SQLITE.SQLITE_DENY;
    const alterTemporaryCatalog =
      introspection &&
      currentStatement?.command === "alter" &&
      origin === null &&
      db === "temp" &&
      isSchemaCatalog(a, true) &&
      (action === SQLITE.SQLITE_READ || action === SQLITE.SQLITE_UPDATE);
    if (schema !== null && db !== "main" && !alterTemporaryCatalog) return SQLITE.SQLITE_DENY;
    if (
      (action === SQLITE.SQLITE_INSERT ||
        action === SQLITE.SQLITE_UPDATE ||
        action === SQLITE.SQLITE_DELETE) &&
      isSchemaCatalog(a)
    ) {
      const ddl = currentStatement?.command;
      if (origin !== null || (ddl !== "create" && ddl !== "alter" && ddl !== "drop"))
        return SQLITE.SQLITE_DENY;
    }
    if ((a !== null && protectedObjects.has(a)) || b === LEDGER) {
      return internalLedger &&
        a === LEDGER &&
        (action === SQLITE.SQLITE_INSERT || action === SQLITE.SQLITE_READ)
        ? SQLITE.SQLITE_OK
        : SQLITE.SQLITE_DENY;
    }
    return SQLITE.SQLITE_OK;
  });
  try {
    internalTransaction = true;
    database.exec("BEGIN IMMEDIATE");
    internalTransaction = false;
    started = true;
    if (introspection) {
      // Snapshot after BEGIN IMMEDIATE, before tenant statements. Both Host
      // queries remain under the same authorizer with exact read-only actions.
      let schemas: readonly Record<string, unknown>[];
      metadataQuery = { kind: "database-list" };
      try {
        schemas = database.prepare("PRAGMA database_list").all();
      } finally {
        metadataQuery = undefined;
      }
      for (const row of schemas) {
        if (typeof row.name !== "string") throw new Error("migration_schema_unconfirmed");
        const schema = asciiLower(row.name) as string;
        const objects = readCatalog(row.name);
        if (schema === "main") {
          updateMainCatalog(objects);
          continue;
        }
        const tables = new Set<string>();
        const indexes = new Set<string>();
        for (const object of objects) {
          if (typeof object.name !== "string" || typeof object.tbl_name !== "string")
            throw new Error("migration_schema_unconfirmed");
          const name = asciiLower(object.name) as string;
          if (object.type === "index") indexes.add(name);
          else if (object.type === "table" || object.type === "view") tables.add(name);
        }
        nonMainCatalogs.push({ schema, tables, indexes });
      }
    }
    for (const statement of statements) {
      currentStatement = statement;
      try {
        database.exec(statement.sql);
      } finally {
        currentStatement = undefined;
      }
      if (
        introspection &&
        nonMainCatalogs.length > 0 &&
        (statement.command === "create" ||
          statement.command === "alter" ||
          statement.command === "drop")
      ) {
        updateMainCatalog(readCatalog("main"));
      }
    }
    internalLedger = true;
    database
      .prepare(`INSERT INTO ${LEDGER} (sequence, path, sha256, operation_id) VALUES (?, ?, ?, ?)`)
      .run(sequence, entry.path, entry.sha256, operationId);
    internalLedger = false;
    internalTransaction = true;
    database.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try {
        internalTransaction = true;
        database.exec("ROLLBACK");
      } catch {
        // A failed rollback is an unknown native outcome, not a safe retry.
        throw new Error("rollback_unconfirmed");
      }
    }
    throw error;
  } finally {
    internalTransaction = false;
    internalLedger = false;
    metadataQuery = undefined;
    currentStatement = undefined;
    database.setAuthorizer(null);
  }
}

function asciiLower(value: string | null): string | null {
  return value === null ? null : value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function isSchemaCatalog(value: string | null, includeTemporary = false): boolean {
  return (
    value === "sqlite_master" ||
    value === "sqlite_schema" ||
    (includeTemporary && (value === "sqlite_temp_master" || value === "sqlite_temp_schema"))
  );
}
