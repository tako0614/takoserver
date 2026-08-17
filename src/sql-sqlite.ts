import { Database } from "bun:sqlite";
import {
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
  type SqlWrite,
} from "./ports.ts";

/**
 * `Sql` over `bun:sqlite`, for the self-hosted entry and for tests.
 *
 * `batch()` runs inside `BEGIN IMMEDIATE ... COMMIT` so it commits all-or-none
 * exactly like D1's implicit batch transaction. Nothing here exposes a richer
 * primitive than D1 can honour — the two implementations must stay
 * interchangeable, and `BatchOnlySql` in the tests proves it.
 */
export function createSqliteSql(database: Database): Sql {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("a bun:sqlite Database is required");
  }
  database.exec("PRAGMA foreign_keys = ON");

  const execute = (statement: SqlStatement): SqlWrite => {
    const params = [...(statement.params ?? [])].map(bindable);
    let rows: Row[];
    try {
      rows = database.query(statement.sql).all(...params) as Row[];
    } catch (error) {
      throw sqlError(error);
    }
    // `changes` is connection-global, so it is read immediately after the
    // statement that produced it and never across an await.
    const changed = database.query("SELECT changes() AS changes").get() as {
      changes?: unknown;
    } | null;
    const changes = changed?.changes;
    return {
      rows,
      changes: typeof changes === "number" && Number.isSafeInteger(changes) ? changes : 0,
    };
  };

  return {
    async query(sql, params): Promise<readonly Row[]> {
      return execute({ sql, ...(params ? { params } : {}) }).rows;
    },

    async run(sql, params): Promise<SqlWrite> {
      return execute({ sql, ...(params ? { params } : {}) });
    },

    async batch(statements): Promise<readonly SqlWrite[]> {
      if (statements.length === 0) return [];
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error instanceof SqlError ? error : sqlError(error);
      }
    },
  };
}

/** Opens a private in-memory database. Used by tests and by `bun run dev`. */
export function createMemorySql(): Sql {
  return createSqliteSql(new Database(":memory:"));
}

function bindable(value: SqlParam): string | number | null | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function sqlError(error: unknown): SqlError {
  const message = error instanceof Error ? error.message : String(error);
  if (/constraint|unique|check/iu.test(message)) return new SqlError("constraint", message);
  return new SqlError("unavailable", message);
}
