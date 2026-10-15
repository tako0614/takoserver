import { type DatabaseSync, constants as SQLITE } from "node:sqlite";
import {
  isMigrationDeferForeignKeysName,
  isMigrationDeferForeignKeysValue,
  isMigrationIntrospectionPragma,
  type MigrationSqlStatement,
  type MigrationSqlTable,
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
  let catalogEpoch = 0;
  let alterValidation:
    | {
        readonly statement: MigrationSqlStatement;
        readonly target: string;
        readonly epoch: number;
      }
    | undefined;
  let ftsAction:
    | {
        readonly statement: MigrationSqlStatement;
        readonly descriptor: NativeFtsDescriptor;
        readonly epoch: number;
      }
    | undefined;
  let ftsCreate:
    | { readonly statement: MigrationSqlStatement; readonly declaration: FtsDeclaration }
    | undefined;
  let createdFts: string | undefined;
  let initialIndexBuild:
    | { readonly statement: MigrationSqlStatement; readonly index: string; readonly schema: "main" }
    | undefined;
  const protectedObjects = new Set([LEDGER]);
  const mainTables = new Set(["sqlite_master", "sqlite_schema"]);
  const mainIndexes = new Set<string>();
  const mainObjects = new Map<string, Record<string, unknown>>();
  const mainDeclarations = new Map<string, MigrationSqlTable>();
  const catalogDeclarations = new Map<string, MigrationSqlTable | undefined>();
  const virtualTables = new Set<string>();
  const ftsDescriptors = new Map<string, NativeFtsDescriptor>();
  const ftsShadows = new Set<string>();
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
      return database
        .prepare(`SELECT name, type, tbl_name, sql FROM ${quoted}.sqlite_schema`)
        .all();
    } finally {
      metadataQuery = undefined;
    }
  };
  const ordinaryMain = (name: string): boolean => {
    const object = mainObjects.get(name);
    return (
      object?.type === "table" &&
      asciiLower(typeof object.tbl_name === "string" ? object.tbl_name : null) === name &&
      mainDeclarations.get(name)?.kind === "ordinary" &&
      !protectedObjects.has(name)
    );
  };
  const updateMainCatalog = (objects: readonly Record<string, unknown>[]): void => {
    mainTables.clear();
    mainIndexes.clear();
    mainObjects.clear();
    mainDeclarations.clear();
    virtualTables.clear();
    ftsDescriptors.clear();
    ftsShadows.clear();
    ftsAction = undefined;
    alterValidation = undefined;
    catalogEpoch += 1;
    mainTables.add("sqlite_master");
    mainTables.add("sqlite_schema");
    for (const object of objects) {
      if (typeof object.name !== "string" || typeof object.tbl_name !== "string")
        throw new Error("migration_schema_unconfirmed");
      const name = asciiLower(object.name) as string;
      mainObjects.set(name, object);
      if (object.type === "index") mainIndexes.add(name);
      else if (object.type === "table" || object.type === "view") mainTables.add(name);
      if (asciiLower(object.tbl_name) === LEDGER) protectedObjects.add(name);
      if (object.type === "table" && typeof object.sql === "string") {
        if (!catalogDeclarations.has(object.sql)) {
          let declaration: MigrationSqlTable | undefined;
          try {
            declaration = prepareNativeMigrationSql(object.sql, "introspection")[0]?.table;
          } catch {
            /* Unsupported catalog SQL never acquires FTS authority. */
          }
          catalogDeclarations.set(object.sql, declaration);
        }
        const declaration = catalogDeclarations.get(object.sql);
        if (
          declaration &&
          asciiLower(declaration.name) === name &&
          (declaration.schema === null || asciiLower(declaration.schema) === "main")
        ) {
          mainDeclarations.set(name, declaration);
          if (declaration.kind === "virtual") virtualTables.add(name);
        }
      }
    }
    const candidates = new Map<string, FtsDeclaration>();
    for (const [name, table] of mainDeclarations) {
      const declaration = ftsDeclaration(table);
      if (!declaration || protectedObjects.has(name)) continue;
      candidates.set(name, declaration);
      for (const shadow of declaration.shadows) ftsShadows.add(asciiLower(shadow) as string);
    }
    for (const [name, declaration] of candidates) {
      const content =
        declaration.content === null ? null : (asciiLower(declaration.content) as string);
      // The real catalog's fts5 declaration binds these exact builtin roles.
      // A table merely sharing a name prefix is never an FTS descriptor.
      if (content !== null && (!ordinaryMain(content) || ftsShadows.has(content))) continue;
      if (!declaration.shadows.every((shadow) => ordinaryMain(asciiLower(shadow) as string)))
        continue;
      ftsDescriptors.set(name, { ...declaration, epoch: catalogEpoch });
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
          (b === "name" || b === "type" || b === "tbl_name" || b === "sql"))
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
      if (a === "quick_check") {
        return alterValidation !== undefined &&
          alterValidation.statement === currentStatement &&
          alterValidation.epoch === catalogEpoch &&
          second === alterValidation.target &&
          schema === "main" &&
          origin === null
          ? SQLITE.SQLITE_OK
          : SQLITE.SQLITE_DENY;
      }
      if (
        introspection &&
        a === "data_version" &&
        second === null &&
        schema === "main" &&
        origin === null &&
        ftsAction !== undefined &&
        ftsAction.statement === currentStatement &&
        ftsAction.epoch === catalogEpoch &&
        ftsDescriptors.get(asciiLower(ftsAction.descriptor.name) as string) === ftsAction.descriptor
      )
        return SQLITE.SQLITE_OK;
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
      action === SQLITE.SQLITE_ANALYZE ||
      action === SQLITE.SQLITE_COPY ||
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
    if (action === SQLITE.SQLITE_READ && a === "pragma_quick_check" && !mainObjects.has(a)) {
      // SQLite prepares this fixed table-valued query for ADD constraint
      // validation, then exposes its actual target in the step-time PRAGMA.
      // A user SELECT/view/trigger has no admitted same-statement ALTER.
      return started &&
        !internalLedger &&
        !internalTransaction &&
        alterValidation !== undefined &&
        alterValidation.statement === currentStatement &&
        alterValidation.epoch === catalogEpoch &&
        second === "quick_check" &&
        schema === "main" &&
        origin === null
        ? SQLITE.SQLITE_OK
        : SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_ALTER_TABLE) {
      const target = currentStatement?.alter;
      const object = b === null ? undefined : mainObjects.get(b);
      alterValidation =
        started &&
        !internalLedger &&
        !internalTransaction &&
        currentStatement?.command === "alter" &&
        target?.kind === "add-column" &&
        (target.schema === null || asciiLower(target.schema) === "main") &&
        a === "main" &&
        schema === null &&
        origin === null &&
        second !== null &&
        b !== null &&
        asciiLower(target.name) === b &&
        object?.name === second &&
        ordinaryMain(b) &&
        !b.startsWith("sqlite_") &&
        !ftsShadows.has(b)
          ? { statement: currentStatement, target: second, epoch: catalogEpoch }
          : undefined;
    }
    if (
      introspection &&
      action === SQLITE.SQLITE_READ &&
      a?.startsWith("pragma_") &&
      !mainObjects.has(a) &&
      !isMigrationIntrospectionPragma(a.slice(7))
    ) {
      // This is a resolved eponymous table, not a string/identifier search.
      // Deny even if an earlier callback in this SQL has already used FTS.
      return SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_CREATE_VTABLE) {
      if (
        !introspection ||
        !started ||
        !currentStatement ||
        currentStatement.command !== "create" ||
        ftsCreate === undefined ||
        ftsCreate.statement !== currentStatement ||
        schema !== "main" ||
        origin !== null ||
        b !== "fts5" ||
        a === null ||
        a !== asciiLower(ftsCreate.declaration.name)
      )
        return SQLITE.SQLITE_DENY;
      createdFts = a;
      return SQLITE.SQLITE_OK;
    }
    if (
      introspection &&
      a !== null &&
      schema === "main" &&
      (action === SQLITE.SQLITE_READ ||
        action === SQLITE.SQLITE_INSERT ||
        action === SQLITE.SQLITE_UPDATE ||
        action === SQLITE.SQLITE_DELETE)
    ) {
      const descriptor = ftsDescriptors.get(a);
      if (virtualTables.has(a) && !descriptor) return SQLITE.SQLITE_DENY;
      if (descriptor && currentStatement && started && !internalLedger && !internalTransaction) {
        ftsAction = { statement: currentStatement, descriptor, epoch: catalogEpoch };
      }
    }
    if (action === SQLITE.SQLITE_REINDEX) {
      // SQLite authorizes an initial index population as REINDEX too. Only a
      // genuine CREATE_INDEX that passed every guard above can admit it, once,
      // for the identical target in this same canonical CREATE statement.
      const initialBuild =
        started &&
        currentStatement === initialIndexBuild?.statement &&
        first === initialIndexBuild?.index &&
        schema === initialIndexBuild?.schema &&
        schema === "main" &&
        second === null &&
        origin === null;
      initialIndexBuild = undefined;
      return initialBuild ? SQLITE.SQLITE_OK : SQLITE.SQLITE_DENY;
    }
    if (action === SQLITE.SQLITE_CREATE_INDEX) {
      initialIndexBuild =
        started &&
        currentStatement?.command === "create" &&
        schema === "main" &&
        origin === null &&
        first !== null &&
        second !== null
          ? { statement: currentStatement, index: first, schema }
          : undefined;
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
    } else {
      // Older Forms gain no tenant metadata permission. This fixed Host read
      // only resolves the ordinary target of SQLite's own ADD validation.
      updateMainCatalog(readCatalog("main"));
    }
    for (const statement of statements) {
      const declaration = introspection ? ftsDeclaration(statement.table) : undefined;
      if (declaration) {
        // Refresh before creation too: its content table may have been created
        // by an earlier canonical statement in this very migration file.
        updateMainCatalog(readCatalog("main"));
        const content =
          declaration.content === null ? null : (asciiLower(declaration.content) as string);
        if (
          !mainObjects.has(asciiLower(declaration.name) as string) &&
          !protectedObjects.has(asciiLower(declaration.name) as string) &&
          declaration.shadows.every(
            (shadow) =>
              !mainObjects.has(asciiLower(shadow) as string) &&
              !protectedObjects.has(asciiLower(shadow) as string),
          ) &&
          (content === null || (ordinaryMain(content) && !ftsShadows.has(content)))
        ) {
          ftsCreate = { statement, declaration };
        }
      }
      currentStatement = statement;
      createdFts = undefined;
      try {
        database.exec(statement.sql);
      } finally {
        alterValidation = undefined;
        ftsAction = undefined;
        ftsCreate = undefined;
        initialIndexBuild = undefined;
        currentStatement = undefined;
      }
      if (
        statement.command === "create" ||
        statement.command === "alter" ||
        statement.command === "drop"
      ) {
        updateMainCatalog(readCatalog("main"));
      }
      if (createdFts !== undefined && !ftsDescriptors.has(createdFts))
        throw new Error("migration_fts_schema_unconfirmed");
      createdFts = undefined;
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
    alterValidation = undefined;
    ftsAction = undefined;
    ftsCreate = undefined;
    createdFts = undefined;
    initialIndexBuild = undefined;
    currentStatement = undefined;
    database.setAuthorizer(null);
  }
}

interface FtsDeclaration {
  readonly name: string;
  readonly content: string | null;
  readonly shadows: readonly string[];
}

interface NativeFtsDescriptor extends FtsDeclaration {
  readonly epoch: number;
}

/** FTS module arguments are tokens from the one canonical SQL lexical pass. */
function ftsDeclaration(table: MigrationSqlTable | undefined): FtsDeclaration | undefined {
  if (
    table?.kind !== "virtual" ||
    asciiLower(table.module) !== "fts5" ||
    (table.schema !== null && asciiLower(table.schema) !== "main")
  )
    return;
  let content: string | undefined;
  let contentSeen = false;
  let columnsize = true;
  let contentlessUnindexed = false;
  let unindexed = false;
  let columns = 0;
  for (const argument of table.arguments) {
    const name = argument[0];
    if (!name || name.kind === "symbol") return;
    if (argument[1]?.kind === "symbol" && argument[1]?.value === "=") {
      const value = argument[2];
      if (
        argument.length !== 3 ||
        !value ||
        value.kind === "symbol" ||
        (name.kind === "quoted" && name.quote !== "'")
      )
        return;
      const key = asciiLower(name.value) as string;
      if (!key) return;
      // FTS5's native config parser accepts these ASCII option prefixes in
      // this order. Interpret content/role options identically; SQLite still
      // validates tokenizer, column and all other native option semantics.
      if ("content".startsWith(key)) {
        if (contentSeen) return;
        content = value.value;
        contentSeen = true;
      } else if ("contentless_delete".startsWith(key)) {
        // This changes update semantics, not the owned shadow roles.
      } else if ("contentless_unindexed".startsWith(key)) {
        contentlessUnindexed = value.value === "1";
      } else if ("content_rowid".startsWith(key)) {
        // SQLite resolves this column in the already-bound content table.
      } else if ("columnsize".startsWith(key)) {
        columnsize = value.value !== "0";
      }
    } else {
      if (
        argument.length > 2 ||
        (argument[1] &&
          (argument[1].kind !== "word" || asciiLower(argument[1].value) !== "unindexed"))
      )
        return;
      columns += 1;
      unindexed ||= argument.length === 2;
    }
  }
  if (columns === 0) return;
  const roles = ["data", "idx", "config"];
  if (columnsize) roles.push("docsize");
  if (content === undefined || (content === "" && contentlessUnindexed && unindexed))
    roles.push("content");
  return {
    name: table.name,
    content: content ? content : null,
    shadows: roles.map((role) => `${table.name}_${role}`),
  };
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
