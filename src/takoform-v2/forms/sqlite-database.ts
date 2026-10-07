import type { JsonObject } from "../../ports.ts";

export const SQLITE_DATABASE_FORM_URL =
  "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/" as const;

export class SQLiteDatabaseValidationError extends TypeError {
  readonly code = "invalid_spec" as const;

  constructor() {
    super("SQLiteDatabase spec must be an empty object");
    this.name = "SQLiteDatabaseValidationError";
  }
}

/** The published 0.2.0 Form has no configurable fields or defaults. */
export function parseSQLiteDatabaseSpec(input: unknown): JsonObject {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 0
  ) {
    throw new SQLiteDatabaseValidationError();
  }
  return {};
}

export function validateSQLiteDatabaseUpdate(previous: unknown, next: unknown): JsonObject {
  parseSQLiteDatabaseSpec(previous);
  return parseSQLiteDatabaseSpec(next);
}
