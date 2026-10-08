import type { Sql } from "../ports.ts";

export type V2WorkerInvocationSchema = "endpoint" | "service";

const commonColumns = [
  "version_uid",
  "endpoint_uid",
  "endpoint_generation",
  "no_native_dispatch_at_ms",
  "retired_at_ms",
  "retirement_receipt_digest",
];
const serviceColumns = [
  "ingress_kind",
  "service_caller_worker_uid",
  "service_caller_version_uid",
  "service_caller_version_generation",
  "service_caller_version_operation_id",
  "service_binding_name",
  "service_caller_execution_ref",
];

/**
 * This predicate is repeated inside every absence or retirement statement:
 * a PRAGMA result before an await cannot authorize a later SQL mutation. The
 * _next table fences the 0086 copy window; the final trigger/index closure
 * fences the interval between the copy and a completed migration.
 */
export function v2WorkerInvocationSchemaReady(kind: V2WorkerInvocationSchema): string {
  const serviceIndex = `SELECT count(*) FROM sqlite_schema WHERE type = 'index'
    AND tbl_name = 'tf_v2_worker_invocations'
    AND name = 'tf_v2_worker_invocations_service_caller_version_unresolved'`;
  return `NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table'
      AND name = 'tf_v2_worker_invocations_next')
    AND EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table'
      AND name = 'tf_v2_worker_invocations')
    AND (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'tf_v2_worker_invocations' AND name IN (
      'tf_v2_worker_invocations_identity_immutable',
      'tf_v2_worker_invocations_no_delete',
      'tf_v2_worker_invocations_no_retired_insert',
      'tf_v2_worker_invocations_retirement_monotonic',
      'tf_v2_worker_invocations_no_dispatch_insert',
      'tf_v2_worker_invocations_no_dispatch_monotonic'
    )) = 6
    AND (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'tf_v2_operations' AND name =
      'tf_v2_worker_invocation_version_delete_guard') = 1
    AND (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'tf_v2_worker_native_deletions' AND name IN (
      'tf_v2_worker_native_deletion_send_guard',
      'tf_v2_worker_native_deletion_presend_absence_guard'
    )) = 2
    AND (SELECT count(*) FROM sqlite_schema WHERE type = 'index'
      AND tbl_name = 'tf_v2_worker_invocations' AND name IN (
      'tf_v2_worker_invocations_deployment_unresolved',
      'tf_v2_worker_invocations_retirement_receipt'
    )) = 2
    AND (${serviceIndex}) = ${kind === "service" ? 1 : 0}`;
}

/** Only selects SQL shape; the selected statement must repeat its own seal. */
export async function inspectV2WorkerInvocationSchema(
  sql: Sql,
): Promise<V2WorkerInvocationSchema | null> {
  try {
    const columns = new Set(
      (await sql.query("PRAGMA table_info(tf_v2_worker_invocations)"))
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!commonColumns.every((name) => columns.has(name))) return null;
    const kind = serviceColumns.every((name) => columns.has(name))
      ? "service"
      : serviceColumns.some((name) => columns.has(name))
        ? null
        : "endpoint";
    if (!kind) return null;
    const rows = await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady(kind)}`);
    return rows.length === 1 ? kind : null;
  } catch {
    return null;
  }
}
