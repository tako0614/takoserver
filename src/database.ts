import { drizzle } from "drizzle-orm/sqlite-proxy";
import { databaseSchema } from "./database-schema.ts";
import type { Row, Sql, SqlParam, SqlStatement, SqlWrite } from "./ports.ts";

export type TakoserverDatabase = ReturnType<typeof createDatabase>;

/**
 * Runs one Drizzle query model over the existing D1-compatible SQL port.
 *
 * The proxy is deliberate: production D1 and self-host Bun SQLite keep the
 * same application query path. Guarded writes still use `Sql.run` directly so
 * callers can inspect D1's affected-row count, and multi-statement invariants
 * still use `Sql.batch` for the real all-or-none guarantee.
 */
export function createDatabase(sql: Sql) {
  return drizzle(
    async (query, params, method) =>
      drizzleResult(await execute(sql, { sql: query, params: sqlParams(params) }), method),
    async (queries) => {
      const results = await sql.batch(
        queries.map((query) => ({ sql: query.sql, params: sqlParams(query.params) })),
      );
      return results.map((result, index) => drizzleResult(result, queries[index]?.method ?? "run"));
    },
    { schema: databaseSchema },
  );
}

async function execute(sql: Sql, statement: SqlStatement): Promise<SqlWrite> {
  return await sql.run(statement.sql, statement.params);
}

function drizzleResult(
  result: Pick<SqlWrite, "rows">,
  method: "run" | "all" | "values" | "get",
): { rows: unknown[] } {
  if (method === "run") return { rows: [] };
  if (method === "get") return { rows: rowValues(result.rows[0]) };
  return { rows: result.rows.map(rowValues) };
}

function rowValues(row: Row | undefined): unknown[] {
  return row === undefined ? [] : Object.values(row);
}

function sqlParams(params: readonly unknown[]): readonly SqlParam[] {
  return params.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      value instanceof ArrayBuffer
    ) {
      return value;
    }
    throw new TypeError("Drizzle produced an unsupported SQL parameter");
  });
}
