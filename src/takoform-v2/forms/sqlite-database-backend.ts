import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "../types.ts";
import {
  parseSQLiteDatabaseSpec,
  SQLITE_DATABASE_FORM_URL,
  SQLiteDatabaseValidationError,
  validateSQLiteDatabaseUpdate,
} from "./sqlite-database.ts";
import type { SQLiteDatabaseNativePort } from "./sqlite-native-store-port.ts";

export const SQLITE_DATABASE_BACKEND_ID = "selfhost-v2-sqlite-database-native-v1";

/**
 * Only Resource lifecycle lives here. Worker SQL is owned by the separately
 * authorized native plane; schema changes are SQLiteMigrationApplication's.
 */
export function createSQLiteDatabaseForm(options: {
  readonly store: Pick<
    SQLiteDatabaseNativePort,
    "targetKey" | "ensureCreated" | "inspect" | "ensureDeleted"
  >;
}): V2Form {
  if (!options.store?.targetKey) throw new TypeError("SQLiteDatabase store is required");

  async function apply(input: V2Execution): Promise<V2BackendResult> {
    if (input.form !== SQLITE_DATABASE_FORM_URL || input.targetKey !== options.store.targetKey) {
      return { kind: "unknown", code: "ownership_uncertain", message: "Ownership is unconfirmed" };
    }
    try {
      if (input.action === "create") {
        const state = await options.store.ensureCreated(input);
        return state === "present"
          ? { kind: "complete", observed: { databaseExists: true }, output: {} }
          : {
              kind: "unknown",
              code: "outcome_unconfirmed",
              message: "Database creation is unconfirmed",
            };
      }
      if (input.action === "update") {
        const state = await options.store.inspect(input);
        return state === "unknown"
          ? {
              kind: "unknown",
              code: "outcome_unconfirmed",
              message: "Database state is unconfirmed",
            }
          : { kind: "complete", observed: { databaseExists: state === "present" }, output: {} };
      }
      const state = await options.store.ensureDeleted(input);
      return state === "absent"
        ? { kind: "complete", observed: { databaseExists: false }, output: {} }
        : {
            kind: "unknown",
            code: "outcome_unconfirmed",
            message: "Database deletion is unconfirmed",
          };
    } catch {
      // A storage or transport exception can happen after the native effect.
      // Reconcile the same accepted UID/Operation; never send a new identity.
      return {
        kind: "unknown",
        code: "outcome_unconfirmed",
        message: "Database outcome is unconfirmed",
      };
    }
  }

  return {
    validateCreate(spec) {
      try {
        parseSQLiteDatabaseSpec(spec);
      } catch (error) {
        if (error instanceof SQLiteDatabaseValidationError) {
          throw new TakoformV2Error("invalid_spec", 422);
        }
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateSQLiteDatabaseUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof SQLiteDatabaseValidationError) {
          throw new TakoformV2Error("invalid_spec", 422);
        }
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: SQLITE_DATABASE_BACKEND_ID,
      targetKey: options.store.targetKey,
      execute: apply,
      reconcile: apply,
    },
  };
}
