import { type DatabaseSync, constants as SQLITE } from "node:sqlite";
import type { Clock, JsonObject, Sql } from "../../ports.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "../types.ts";
import type { SqlArtifactCustody } from "./artifact-custody.ts";
import { SQLITE_DATABASE_FORM_URL } from "./sqlite-database.ts";
import {
  parseSQLiteMigrationApplicationSpec,
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  SQLiteMigrationApplicationValidationError,
  sqliteMigrationApplicationReferences,
  validateSQLiteMigrationApplicationUpdate,
} from "./sqlite-migration-application.ts";
import type { SQLiteMigrationManifest } from "./sqlite-migration-set.ts";
import type { SQLiteDatabaseNativePort } from "./sqlite-native-store-port.ts";

export const SQLITE_MIGRATION_APPLICATION_BACKEND_ID =
  "selfhost-v2-sqlite-migration-application-native-v1";
const SQLITE_MIGRATION_LEDGER = "_takoform_sqlite_migrations";

interface MigrationEntry {
  readonly path: string;
  readonly sha256: string;
}

interface MigrationRecord extends MigrationEntry {
  readonly operationId: string;
}

type MigrationErrorCode =
  | "artifact_invalid"
  | "migration_history_conflict"
  | "migration_sql_error"
  | "database_busy"
  | "backend_unavailable";

class MigrationFailure extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    readonly newlyApplied: number,
    readonly appliedEntries: readonly MigrationEntry[],
  ) {
    super(code);
    this.name = "MigrationFailure";
  }
}

class MigrationHistoryUncertain extends Error {}

export function createSQLiteMigrationApplicationForm(options: {
  readonly sql: Sql;
  readonly store: Pick<SQLiteDatabaseNativePort, "withAuthorizedDatabase">;
  readonly custody: Pick<SqlArtifactCustody<SQLiteMigrationManifest>, "readVerified">;
  readonly targetKey: string;
  readonly now?: Clock;
}): V2Form {
  if (!options.targetKey || !options.store || !options.custody) {
    throw new TypeError("SQLiteMigrationApplication backend is incomplete");
  }
  const now = options.now ?? (() => new Date());

  async function stillAuthorized(input: V2Execution, databaseUid: string): Promise<boolean> {
    const nowMs = now().getTime();
    if (!Number.isSafeInteger(nowMs)) return false;
    const row = (
      await options.sql.query(
        `SELECT op.id FROM tf_v2_operations op
         JOIN tf_v2_resources consumer ON consumer.uid = op.resource_uid
         JOIN tf_v2_operation_reference_sets accepted_set
           ON accepted_set.operation_id = op.id AND accepted_set.sealed = 1
         JOIN tf_v2_operation_references accepted_ref
           ON accepted_ref.operation_id = op.id AND accepted_ref.target_uid = ?
         JOIN tf_v2_resource_references active_ref
           ON active_ref.referrer_uid = consumer.uid AND active_ref.target_uid = accepted_ref.target_uid
         JOIN tf_v2_resources target ON target.uid = accepted_ref.target_uid
         WHERE op.id = ? AND op.lease_token = ? AND op.lease_until_ms > ?
           AND op.status = 'reconciling' AND op.dispatch_possible = 1
           AND op.action IN ('create', 'update') AND op.action = ?
           AND op.resource_uid = ? AND op.principal = ? AND op.generation = ?
           AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
           AND consumer.principal = op.principal AND consumer.form_url = ?
           AND consumer.space = ? AND consumer.name = ?
           AND consumer.backend_id = op.backend_id AND consumer.target_key = op.target_key
           AND consumer.busy_operation = op.id AND consumer.last_operation = op.id
           AND consumer.generation = op.generation AND consumer.deleted_at IS NULL
           AND consumer.spec_json = op.accepted_spec_json
           AND accepted_ref.form_url = ? AND target.form_url = ?
           AND target.principal = op.principal AND target.space = consumer.space
           AND target.deleted_at IS NULL AND target.busy_operation IS NULL
           AND target.phase = 'idle' AND target.generation = target.observed_generation`,
        [
          databaseUid,
          input.operationId,
          input.leaseToken,
          nowMs,
          input.action,
          input.resourceUid,
          input.principal,
          input.generation,
          input.backendKey,
          input.backendId,
          input.targetKey,
          input.form,
          input.space,
          input.name,
          SQLITE_DATABASE_FORM_URL,
          SQLITE_DATABASE_FORM_URL,
        ],
      )
    )[0];
    return row?.id === input.operationId;
  }

  async function apply(input: V2Execution): Promise<V2BackendResult> {
    if (
      input.form !== SQLITE_MIGRATION_APPLICATION_FORM_URL ||
      input.targetKey !== options.targetKey
    ) {
      return { kind: "unknown", code: "backend_unavailable", message: "Backend identity changed" };
    }
    if (input.action === "delete") {
      // Deleting the relationship never runs down SQL, alters the ledger, or
      // deletes either referenced Resource.
      return { kind: "complete", observed: {}, output: {} };
    }
    let spec: ReturnType<typeof parseSQLiteMigrationApplicationSpec>;
    try {
      spec = parseSQLiteMigrationApplicationSpec(input.spec);
    } catch {
      return { kind: "no_effect", code: "artifact_invalid", message: "Accepted spec is invalid" };
    }
    const databaseUid = spec.database.resourceUid;
    const setUid = spec.migrationSet.resourceUid;
    if (!(await stillAuthorized(input, databaseUid))) {
      return {
        kind: "unknown",
        code: "backend_unavailable",
        message: "Database authority is unconfirmed",
      };
    }
    let held: Awaited<ReturnType<typeof options.custody.readVerified>>;
    try {
      held = await options.custody.readVerified({ execution: input, targetResourceUid: setUid });
    } catch {
      return {
        kind: "unknown",
        code: "backend_unavailable",
        message: "Migration custody is unconfirmed",
      };
    }
    const targetEntries = held.manifest.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
    }));
    if (held.files.length !== targetEntries.length || targetEntries.length === 0) {
      return {
        kind: "no_effect",
        code: "artifact_invalid",
        message: "Migration material is invalid",
      };
    }
    try {
      const appliedEntries = await options.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: () => stillAuthorized(input, databaseUid),
        use(database) {
          return applyHeldMigrations(database, targetEntries, held.files, input.operationId);
        },
      });
      return {
        kind: "complete",
        observed: observation(databaseUid, setUid, appliedEntries, targetEntries),
        output: {},
      };
    } catch (error) {
      if (error instanceof MigrationFailure) {
        return error.newlyApplied === 0
          ? { kind: "no_effect", code: error.code, message: error.code }
          : {
              kind: "partial",
              code: error.code,
              message: error.code,
              observed: observation(databaseUid, setUid, error.appliedEntries, targetEntries),
              output: {},
            };
      }
      if (error instanceof MigrationHistoryUncertain) {
        return {
          kind: "unknown",
          code: "migration_history_conflict",
          message: "Migration history cannot establish the outcome",
        };
      }
      if (isNativeBusy(error)) {
        return {
          kind: "unknown",
          code: "database_busy",
          message: "Database custody is busy",
        };
      }
      return {
        kind: "unknown",
        code: "backend_unavailable",
        message: "Migration outcome is unconfirmed",
      };
    }
  }

  return {
    validateCreate(spec) {
      try {
        parseSQLiteMigrationApplicationSpec(spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationApplicationValidationError) {
          throw new TakoformV2Error("invalid_spec", 422);
        }
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateSQLiteMigrationApplicationUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationApplicationValidationError) {
          throw new TakoformV2Error("invalid_spec", 422);
        }
        throw error;
      }
    },
    references(spec) {
      return sqliteMigrationApplicationReferences(parseSQLiteMigrationApplicationSpec(spec));
    },
    backend: {
      id: SQLITE_MIGRATION_APPLICATION_BACKEND_ID,
      targetKey: options.targetKey,
      execute: apply,
      reconcile: apply,
    },
  };
}

function isNativeBusy(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "busy";
}

function observation(
  databaseUid: string,
  migrationSetUid: string,
  appliedEntries: readonly MigrationEntry[],
  targetEntries: readonly MigrationEntry[],
): JsonObject {
  return {
    databaseUid,
    migrationSetUid,
    appliedEntries: appliedEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    targetEntries: targetEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    ready:
      appliedEntries.length === targetEntries.length &&
      appliedEntries.every(
        (entry, index) =>
          entry.path === targetEntries[index]?.path &&
          entry.sha256 === targetEntries[index]?.sha256,
      ),
  };
}

function applyHeldMigrations(
  database: DatabaseSync,
  target: readonly MigrationEntry[],
  files: readonly Uint8Array[],
  operationId: string,
): readonly MigrationEntry[] {
  let applied = readLedger(database);
  let newlyApplied = applied.filter((entry) => entry.operationId === operationId).length;
  if (!isPrefix(applied, target)) {
    throw new MigrationFailure("migration_history_conflict", newlyApplied, applied);
  }
  for (let index = applied.length; index < target.length; index += 1) {
    const entry = target[index];
    const bytes = files[index];
    if (!entry || !bytes) throw new MigrationFailure("artifact_invalid", newlyApplied, applied);
    let sqlText: string;
    try {
      sqlText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new MigrationFailure("artifact_invalid", newlyApplied, applied);
    }
    if (sqlText.includes("\0")) {
      throw new MigrationFailure("migration_sql_error", newlyApplied, applied);
    }
    try {
      runFileAndLedger(database, sqlText, entry, index + 1, operationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "rollback_unconfirmed") throw error;
      throw new MigrationFailure(
        /locked|busy/iu.test(message) ? "database_busy" : "migration_sql_error",
        newlyApplied,
        applied,
      );
    }
    newlyApplied += 1;
    applied = [...applied, { ...entry, operationId }];
  }
  return applied;
}

function readLedger(database: DatabaseSync): readonly MigrationRecord[] {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database
      .prepare(
        `SELECT sequence, path, sha256, operation_id FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
      )
      .all() as readonly Record<string, unknown>[];
  } catch {
    throw new MigrationHistoryUncertain();
  }
  if (rows.length > 512) throw new MigrationHistoryUncertain();
  return rows.map((row, index) => {
    if (
      row.sequence !== index + 1 ||
      typeof row.path !== "string" ||
      typeof row.sha256 !== "string" ||
      typeof row.operation_id !== "string" ||
      row.operation_id.length === 0 ||
      !/^[0-9a-f]{64}$/u.test(row.sha256)
    ) {
      throw new MigrationHistoryUncertain();
    }
    return { path: row.path, sha256: row.sha256, operationId: row.operation_id };
  });
}

function isPrefix(applied: readonly MigrationEntry[], target: readonly MigrationEntry[]): boolean {
  return (
    applied.length <= target.length &&
    applied.every(
      (entry, index) =>
        entry.path === target[index]?.path && entry.sha256 === target[index]?.sha256,
    )
  );
}

function runFileAndLedger(
  database: DatabaseSync,
  sqlText: string,
  entry: MigrationEntry,
  sequence: number,
  operationId: string,
): void {
  let internalTransaction = false;
  let internalLedger = false;
  const ledger = SQLITE_MIGRATION_LEDGER;
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
    if (first?.toLowerCase() === ledger || second?.toLowerCase() === ledger) {
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
      .prepare(
        `INSERT INTO ${SQLITE_MIGRATION_LEDGER} (sequence, path, sha256, operation_id) VALUES (?, ?, ?, ?)`,
      )
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
