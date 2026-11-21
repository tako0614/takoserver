import type { Sql } from "../../ports.ts";
import { SQLITE_DATABASE_FORM_URL } from "./sqlite-database.ts";
import { referencesForWorkerVersion } from "./worker-references.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./worker-version-observed.ts";

/** Core-only authority input. Native version identity is checked by the Host broker. */
export interface SQLiteWorkerBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

/**
 * Resolves the current settled Resource/Operation vector, not a static DB
 * generation baked into a Worker Version. The accepted sealed reference set
 * and current active edge must both agree with the published spec.
 */
export function createSQLiteWorkerBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
}) {
  if (!options?.sql || !options.targetKey)
    throw new TypeError("SQLite binding authority is required");
  async function resolveCurrentBinding(
    claim: SQLiteWorkerBindingClaim,
    binding: string,
  ): Promise<{
    readonly resourceUid: string;
    readonly vector: string;
  } | null> {
    if (claim.targetKey !== options.targetKey) return null;
    const desired = claim.bindings.find((entry) => entry.name === binding);
    if (!desired) return null;
    // One SQL snapshot must prove the Version, its sealed reference set and
    // active edge, and the current database revision together. Separate
    // awaited reads can otherwise return a vector that never existed.
    const versionRows = await options.sql.query(
      `WITH current_binding AS (
       SELECT r.generation, r.last_operation, r.spec_json, r.observed_json,
              database_resource.generation AS database_generation,
              database_resource.last_operation AS database_last_operation
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       JOIN tf_v2_resources database_resource
         ON database_resource.uid = ? AND database_resource.form_url = ?
       JOIN tf_v2_operations database_op ON database_op.id = database_resource.last_operation
       JOIN tf_v2_operation_reference_sets sealed
         ON sealed.operation_id = op.id AND sealed.sealed = 1
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.accepted_spec_json = r.spec_json
         AND database_resource.principal = r.principal AND database_resource.space = r.space
         AND database_resource.target_key = r.target_key AND database_resource.spec_json = '{}'
         AND database_resource.deleted_at IS NULL AND database_resource.busy_operation IS NULL
         AND database_resource.phase = 'idle'
         AND database_resource.observed_generation = database_resource.generation
         AND database_op.resource_uid = database_resource.uid
         AND database_op.principal = database_resource.principal
         AND database_op.backend_id = database_resource.backend_id
         AND database_op.target_key = database_resource.target_key
         AND database_op.generation = database_resource.generation
         AND database_op.status = 'succeeded' AND database_op.effect = 'complete'
         AND database_op.action IN ('create', 'update')
         AND database_op.accepted_spec_json = database_resource.spec_json
         AND EXISTS (SELECT 1 FROM tf_v2_resource_references edge
                     WHERE edge.referrer_uid = r.uid AND edge.target_uid = database_resource.uid)
       )
       SELECT 'metadata' AS row_kind, generation, last_operation, spec_json, observed_json,
              database_generation, database_last_operation,
              NULL AS target_uid, NULL AS form_url, NULL AS readiness,
              NULL AS target_spec_path, NULL AS target_spec_equals
       FROM current_binding
       UNION ALL
       SELECT 'reference' AS row_kind, NULL, NULL, NULL, NULL, NULL, NULL,
              ref.target_uid, ref.form_url, ref.readiness, ref.target_spec_path, ref.target_spec_equals
       FROM current_binding chosen
       JOIN tf_v2_operation_references ref ON ref.operation_id = chosen.last_operation
       ORDER BY row_kind, target_uid`,
      [
        desired.resourceUid,
        SQLITE_DATABASE_FORM_URL,
        claim.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
      ],
    );
    const version = versionRows[0];
    if (
      !version ||
      version.row_kind !== "metadata" ||
      versionRows.slice(1).some((row) => row.row_kind !== "reference") ||
      typeof version.spec_json !== "string" ||
      typeof version.observed_json !== "string"
    )
      return null;
    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
      if (
        !isReadyWorkerVersionObservation(
          JSON.parse(version.observed_json),
          spec.bundle !== undefined,
        )
      )
        return null;
    } catch {
      return null;
    }
    if (spec.worker.resourceUid !== claim.workerUid) return null;
    if (
      spec.sqliteBindings.length !== claim.bindings.length ||
      spec.sqliteBindings.some(
        (entry) =>
          !claim.bindings.some(
            (chosen) =>
              chosen.name === entry.name && chosen.resourceUid === entry.resource.resourceUid,
          ),
      )
    )
      return null;
    const requirements = referencesForWorkerVersion(spec);
    // A large accepted spec is returned once, not once per outbound reference.
    const references = versionRows.slice(1);
    if (
      references.length !== requirements.length ||
      requirements.some((expected, index) => {
        const actual = references[index];
        return (
          actual?.target_uid !== expected.resourceUid ||
          actual.form_url !== expected.formUrl ||
          actual.readiness !== expected.readiness ||
          actual.target_spec_path !==
            (expected.targetSpecMatch ? `$.${expected.targetSpecMatch.path.join(".")}` : null) ||
          actual.target_spec_equals !== (expected.targetSpecMatch?.equals ?? null)
        );
      })
    )
      return null;
    return {
      resourceUid: desired.resourceUid,
      vector: JSON.stringify([
        version.generation,
        version.last_operation,
        version.database_generation,
        version.database_last_operation,
      ]),
    };
  }
  return Object.freeze({ resolveCurrentBinding });
}
