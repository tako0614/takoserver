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
import type {
  SQLiteMigrationApplicationPort,
  SQLiteMigrationEntry,
  SQLiteMigrationRecord,
  SQLiteMigrationSession,
} from "./sqlite-migration-application-port.ts";
import type { SQLiteMigrationManifest } from "./sqlite-migration-set.ts";

export const SQLITE_MIGRATION_APPLICATION_BACKEND_ID =
  "selfhost-v2-sqlite-migration-application-native-v1";
type MigrationErrorCode =
  | "artifact_invalid"
  | "migration_history_conflict"
  | "migration_sql_error"
  | "database_busy"
  | "backend_unavailable";

type MigrationRunResult =
  | { readonly kind: "complete"; readonly appliedEntries: readonly SQLiteMigrationEntry[] }
  | {
      readonly kind: "failure";
      readonly code: MigrationErrorCode;
      readonly newlyApplied: number;
      readonly appliedEntries: readonly SQLiteMigrationEntry[];
    }
  | {
      readonly kind: "unknown";
      readonly code: "migration_history_conflict" | "backend_unavailable";
    };

export function createSQLiteMigrationApplicationForm(options: {
  readonly sql: Sql;
  readonly migrationPort: SQLiteMigrationApplicationPort;
  readonly custody: Pick<SqlArtifactCustody<SQLiteMigrationManifest>, "readVerified">;
  readonly targetKey: string;
  readonly now?: Clock;
}): V2Form {
  if (!options.targetKey || !options.migrationPort || !options.custody) {
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
      const result = await options.migrationPort.withAuthorizedMigrationSession({
        resourceUid: databaseUid,
        execution: {
          operationId: input.operationId,
          leaseToken: input.leaseToken,
          backendKey: input.backendKey,
          backendId: input.backendId,
          targetKey: input.targetKey,
          resourceUid: input.resourceUid,
          principal: input.principal,
          action: input.action,
          generation: input.generation,
          form: input.form,
          space: input.space,
          name: input.name,
          spec: input.spec,
        },
        stillAuthorized: () => stillAuthorized(input, databaseUid),
        use(session) {
          return applyHeldMigrations(session, targetEntries, held.files, input.operationId);
        },
      });
      if (result.kind === "unknown") {
        return {
          kind: "unknown",
          code: result.code,
          message:
            result.code === "migration_history_conflict"
              ? "Migration history cannot establish the outcome"
              : "Migration outcome is unconfirmed",
        };
      }
      if (result.kind === "failure") {
        return result.newlyApplied === 0
          ? { kind: "no_effect", code: result.code, message: result.code }
          : {
              kind: "partial",
              code: result.code,
              message: result.code,
              observed: observation(databaseUid, setUid, result.appliedEntries, targetEntries),
              output: {},
            };
      }
      return {
        kind: "complete",
        observed: observation(databaseUid, setUid, result.appliedEntries, targetEntries),
        output: {},
      };
    } catch (error) {
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
  appliedEntries: readonly SQLiteMigrationEntry[],
  targetEntries: readonly SQLiteMigrationEntry[],
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

async function applyHeldMigrations(
  session: SQLiteMigrationSession,
  target: readonly SQLiteMigrationEntry[],
  files: readonly Uint8Array[],
  operationId: string,
): Promise<MigrationRunResult> {
  const initial = await session.readLedger();
  if (initial.kind === "unknown") {
    return { kind: "unknown", code: "migration_history_conflict" };
  }
  if (!validLedger(initial.entries)) {
    return { kind: "unknown", code: "migration_history_conflict" };
  }
  let applied = initial.entries;
  let newlyApplied = applied.filter((entry) => entry.operationId === operationId).length;
  if (!isPrefix(applied, target)) {
    return {
      kind: "failure",
      code: "migration_history_conflict",
      newlyApplied,
      appliedEntries: applied,
    };
  }
  for (let index = applied.length; index < target.length; index += 1) {
    const entry = target[index];
    const bytes = files[index];
    if (!entry || !bytes) {
      return { kind: "failure", code: "artifact_invalid", newlyApplied, appliedEntries: applied };
    }
    const result = await session.applyOneHeldFile({
      sequence: index + 1,
      expectedPrefix: applied,
      entry,
      bytes,
      operationId,
    });
    if (result.kind === "rejected") {
      return { kind: "failure", code: result.code, newlyApplied, appliedEntries: applied };
    }
    if (
      result.kind === "applied" &&
      (result.sequence !== index + 1 ||
        result.record.sequence !== index + 1 ||
        result.record.path !== entry.path ||
        result.record.sha256 !== entry.sha256 ||
        result.record.operationId !== operationId)
    ) {
      return { kind: "unknown", code: "backend_unavailable" };
    }
    if (result.kind === "unknown") {
      // The ACK alone cannot tell whether the SQL and ledger committed. A
      // session read is ordered after the attempt and under the same UID lock.
      const reread = await session.readLedger();
      if (
        reread.kind !== "read" ||
        !validLedger(reread.entries) ||
        !isPrefix(reread.entries, target) ||
        reread.entries.length !== index + 1 ||
        !applied.every(
          (previous, previousIndex) =>
            reread.entries[previousIndex]?.operationId === previous.operationId,
        ) ||
        reread.entries[index]?.operationId !== operationId
      ) {
        return { kind: "unknown", code: "backend_unavailable" };
      }
    }
    newlyApplied += 1;
    applied = [...applied, { ...entry, sequence: index + 1, operationId }];
  }
  return { kind: "complete", appliedEntries: applied };
}

function isPrefix(
  applied: readonly SQLiteMigrationRecord[],
  target: readonly SQLiteMigrationEntry[],
): boolean {
  return (
    applied.length <= target.length &&
    applied.every(
      (entry, index) =>
        entry.path === target[index]?.path && entry.sha256 === target[index]?.sha256,
    )
  );
}

function validLedger(entries: readonly SQLiteMigrationRecord[]): boolean {
  return (
    Array.isArray(entries) &&
    entries.length <= 512 &&
    entries.every(
      (entry, index) =>
        entry?.sequence === index + 1 &&
        typeof entry.path === "string" &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(entry.sha256) &&
        typeof entry.operationId === "string" &&
        entry.operationId.length > 0,
    )
  );
}
