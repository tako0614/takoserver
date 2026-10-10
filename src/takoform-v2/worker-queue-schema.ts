import type { Sql } from "../ports.ts";

/** Repeated in each SQLite authority write, not used as a stale JS preflight. */
export function v2QueueBatchSQLiteSchemaReady(): string {
  return `NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table'
      AND name = 'queue_v2_batch_executions_next')
    AND (SELECT count(*) FROM pragma_table_info('queue_v2_batch_executions')
      WHERE name IN ('sqlite_drain_state', 'sqlite_drain_receipt_digest',
        'terminal_kind', 'terminal_receipt_digest')) = 4
    AND (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'queue_v2_batch_executions' AND name IN (
        'queue_v2_batch_execution_immutable',
        'queue_v2_batch_execution_sqlite_no_insert',
        'queue_v2_batch_execution_sqlite_monotonic',
        'queue_v2_batch_execution_sqlite_retirement_guard')) = 4`;
}

/** A profile/read selector only; writes carry their own 0090 seal. */
export async function inspectV2QueueBatchSQLiteSchema(sql: Sql): Promise<boolean> {
  try {
    return (await sql.query(`SELECT 1 WHERE ${v2QueueBatchSQLiteSchemaReady()}`)).length === 1;
  } catch {
    return false;
  }
}
