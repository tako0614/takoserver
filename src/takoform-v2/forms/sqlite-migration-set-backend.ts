import type { Sql } from "../../ports.ts";
import { TakoformV2Error, type V2Form } from "../types.ts";
import { createSqlArtifactCustody } from "./artifact-custody.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";
import {
  parseSQLiteMigrationManifest,
  parseSQLiteMigrationSetSpec,
  SQLITE_MIGRATION_SET_FORM_URL,
  SQLITE_MIGRATION_SET_LIMITS,
  SQLiteMigrationSetValidationError,
  validateSQLiteMigrationPayload,
  validateSQLiteMigrationSetUpdate,
} from "./sqlite-migration-set.ts";

export const SQLITE_MIGRATION_SET_BACKEND_ID = "selfhost-v2-sqlite-migration-set-sql-v1";

/** Historical 0071 rows remain authoritative; only the mechanism is shared. */
export function createSQLiteMigrationSetForm(options: {
  sql: Sql;
  source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const apply = createSqlArtifactCustody({
    sql: options.sql,
    source: options.source,
    layout: "migration-set-0071",
    formUrl: SQLITE_MIGRATION_SET_FORM_URL,
    limits: SQLITE_MIGRATION_SET_LIMITS,
    parseSpec: parseSQLiteMigrationSetSpec,
    parseManifest: parseSQLiteMigrationManifest,
    validatePayload: validateSQLiteMigrationPayload,
    validateFile: validSqlFile,
    invalidArtifact: () => new SQLiteMigrationSetValidationError("invalid_artifact"),
    invalidManifest: () => new SQLiteMigrationSetValidationError("invalid_manifest"),
    failureNoun: "Migration",
  });
  return {
    validateCreate(spec) {
      try {
        parseSQLiteMigrationSetSpec(spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationSetValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateSQLiteMigrationSetUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationSetValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: SQLITE_MIGRATION_SET_BACKEND_ID,
      targetKey: options.targetKey,
      execute: apply.execute,
      reconcile: apply.execute,
    },
  };
}

async function validSqlFile(bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
