import { type DatabaseSync, constants as SQLITE } from "node:sqlite";
import type {
  SQLiteMigrationApplicationPort,
  SQLiteMigrationEntry,
  SQLiteMigrationFileResult,
  SQLiteMigrationRecord,
} from "./sqlite-migration-application-port.ts";
import type { SQLiteDatabaseNativePort } from "./sqlite-native-store-port.ts";

const LEDGER = "_takoform_sqlite_migrations";

/** Self-host realization of the portable migration session. Never expose this to a Worker. */
export function createSQLiteMigrationApplicationNativePort(
  store: Pick<SQLiteDatabaseNativePort, "withAuthorizedDatabase">,
): SQLiteMigrationApplicationPort {
  return {
    withAuthorizedMigrationSession(input) {
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
                runFileAndLedger(database, sqlText, file.entry, file.sequence, file.operationId);
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
): void {
  let internalTransaction = false;
  let internalLedger = false;
  database.setAuthorizer((action, first, second, schema) => {
    if (action === SQLITE.SQLITE_TRANSACTION || action === SQLITE.SQLITE_SAVEPOINT) {
      return internalTransaction ? SQLITE.SQLITE_OK : SQLITE.SQLITE_DENY;
    }
    if (
      action === SQLITE.SQLITE_ATTACH ||
      action === SQLITE.SQLITE_DETACH ||
      action === SQLITE.SQLITE_PRAGMA ||
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
    if (schema !== null && schema !== "main") return SQLITE.SQLITE_DENY;
    if (first?.toLowerCase() === LEDGER || second?.toLowerCase() === LEDGER) {
      return internalLedger ? SQLITE.SQLITE_OK : SQLITE.SQLITE_DENY;
    }
    return SQLITE.SQLITE_OK;
  });
  let started = false;
  try {
    internalTransaction = true;
    database.exec("BEGIN IMMEDIATE");
    internalTransaction = false;
    started = true;
    database.exec(sqlText);
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
    database.setAuthorizer(null);
  }
}
