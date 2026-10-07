import type { JsonObject } from "../../ports.ts";
import type { V2ReferenceRequirement } from "../types.ts";
import { SQLITE_DATABASE_FORM_URL } from "./sqlite-database.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "./sqlite-migration-set.ts";

export const SQLITE_MIGRATION_APPLICATION_FORM_URL =
  "https://edge.forms.takoform.com/forms/SQLiteMigrationApplication/0.2.0/" as const;

const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class SQLiteMigrationApplicationValidationError extends TypeError {
  readonly code = "invalid_spec" as const;

  constructor() {
    super("SQLiteMigrationApplication spec is invalid");
    this.name = "SQLiteMigrationApplicationValidationError";
  }
}

export interface SQLiteMigrationApplicationSpec {
  readonly database: { readonly resourceUid: string };
  readonly migrationSet: { readonly resourceUid: string };
}

export function parseSQLiteMigrationApplicationSpec(
  input: unknown,
): SQLiteMigrationApplicationSpec {
  const value = exactRecord(input, ["database", "migrationSet"]);
  const database = exactRecord(value.database, ["resourceUid"]);
  const migrationSet = exactRecord(value.migrationSet, ["resourceUid"]);
  if (
    typeof database.resourceUid !== "string" ||
    !RESOURCE_UID.test(database.resourceUid) ||
    typeof migrationSet.resourceUid !== "string" ||
    !RESOURCE_UID.test(migrationSet.resourceUid)
  ) {
    throw new SQLiteMigrationApplicationValidationError();
  }
  return {
    database: { resourceUid: database.resourceUid },
    migrationSet: { resourceUid: migrationSet.resourceUid },
  };
}

export function validateSQLiteMigrationApplicationUpdate(
  previousInput: unknown,
  nextInput: unknown,
): SQLiteMigrationApplicationSpec {
  const previous = parseSQLiteMigrationApplicationSpec(previousInput);
  const next = parseSQLiteMigrationApplicationSpec(nextInput);
  if (
    previous.database.resourceUid !== next.database.resourceUid ||
    previous.migrationSet.resourceUid !== next.migrationSet.resourceUid
  ) {
    throw new SQLiteMigrationApplicationValidationError();
  }
  return next;
}

export function sqliteMigrationApplicationReferences(
  spec: SQLiteMigrationApplicationSpec,
): readonly V2ReferenceRequirement[] {
  return [
    {
      resourceUid: spec.database.resourceUid,
      formUrl: SQLITE_DATABASE_FORM_URL,
      readiness: "observed",
    },
    {
      resourceUid: spec.migrationSet.resourceUid,
      formUrl: SQLITE_MIGRATION_SET_FORM_URL,
      readiness: "observed",
    },
  ];
}

export function sqliteMigrationApplicationSpecJson(
  spec: SQLiteMigrationApplicationSpec,
): JsonObject {
  return {
    database: { resourceUid: spec.database.resourceUid },
    migrationSet: { resourceUid: spec.migrationSet.resourceUid },
  };
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SQLiteMigrationApplicationValidationError();
  }
  const record = input as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new SQLiteMigrationApplicationValidationError();
  }
  return record;
}
