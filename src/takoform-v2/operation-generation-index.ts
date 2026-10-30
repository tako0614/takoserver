import type { Sql } from "../ports.ts";

/** Optional physical accelerator required by the private Forward Container graph reader. */
export const V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME =
  "tf_v2_operations_resource_generation" as const;

/** Applied only by the owning private installation recipe, never by this reader. */
export const V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL =
  `CREATE INDEX ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME} ON tf_v2_operations(resource_uid,generation)` as const;

/** Fail closed if the exact main-schema physical index has not been installed. */
export async function hasV2ForwardContainerOperationGenerationIndex(
  sql: Pick<Sql, "query">,
): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_master
       WHERE name = ? LIMIT 2`,
      [V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME],
    );
    const row = rows.length === 1 ? rows[0] : null;
    return (
      row?.type === "index" &&
      row.name === V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME &&
      row.tbl_name === "tf_v2_operations" &&
      row.sql === V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL
    );
  } catch {
    return false;
  }
}
