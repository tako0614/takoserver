import {
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
  type SqlWrite,
} from "./ports.ts";

/**
 * The D1 shape this adapter needs. It is declared structurally rather than
 * imported from the Workers types so this file stays compilable in the Bun type
 * world; the generated `Env` satisfies it.
 */
export interface D1StatementLike {
  bind(...values: readonly SqlParam[]): D1StatementLike;
  all(): Promise<D1ResultLike>;
}

export interface D1ResultLike {
  readonly results?: readonly Row[] | null;
  readonly meta?: { readonly changes?: number | null } | null;
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: readonly D1StatementLike[]): Promise<readonly D1ResultLike[]>;
}

/**
 * `Sql` over a D1 binding. `batch()` is D1's implicit transaction: the whole
 * array commits or none of it does, which is exactly the guarantee the guarded
 * writes upstream are built on.
 */
export function createD1Sql(database: D1DatabaseLike): Sql {
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new TypeError("a D1 database binding is required");
  }

  const prepared = (statement: SqlStatement): D1StatementLike => {
    const params = statement.params ?? [];
    const base = database.prepare(statement.sql);
    return params.length === 0 ? base : base.bind(...params);
  };

  const run = async (sql: string, params?: readonly SqlParam[]): Promise<SqlWrite> => {
    let result: D1ResultLike;
    try {
      result = await prepared({ sql, ...(params ? { params } : {}) }).all();
    } catch (error) {
      throw sqlError(error);
    }
    return write(result);
  };

  return {
    async query(sql, params): Promise<readonly Row[]> {
      return (await run(sql, params)).rows;
    },

    run,

    async batch(statements): Promise<readonly SqlWrite[]> {
      if (statements.length === 0) return [];
      let results: readonly D1ResultLike[];
      try {
        results = await database.batch(statements.map(prepared));
      } catch (error) {
        throw sqlError(error);
      }
      if (results.length !== statements.length) {
        throw new SqlError("unavailable", "D1 returned a truncated batch result");
      }
      return results.map(write);
    },
  };
}

function write(result: D1ResultLike): SqlWrite {
  const changes = result.meta?.changes;
  return {
    rows: result.results ?? [],
    changes: typeof changes === "number" && Number.isSafeInteger(changes) ? changes : 0,
  };
}

/**
 * Constraint violations are load-bearing here: a `CHECK` or `UNIQUE` is how a
 * batch aborts when a guard cannot be expressed as a `WHERE`. They must stay
 * distinguishable from a database that is merely unreachable.
 */
function sqlError(error: unknown): SqlError {
  const message = error instanceof Error ? error.message : String(error);
  if (/constraint|unique|check/iu.test(message)) return new SqlError("constraint", message);
  return new SqlError("unavailable", message);
}
