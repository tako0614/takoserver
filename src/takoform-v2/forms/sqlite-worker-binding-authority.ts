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
    const versionRows = await options.sql.query(
      `SELECT r.generation, r.last_operation, r.spec_json, r.observed_json
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.accepted_spec_json = r.spec_json`,
      [
        claim.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
      ],
    );
    const version = versionRows.length === 1 ? versionRows[0] : null;
    if (
      !version ||
      typeof version.spec_json !== "string" ||
      typeof version.observed_json !== "string"
    )
      return null;
    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
      if (!isReadyWorkerVersionObservation(JSON.parse(version.observed_json), spec.bundle !== null))
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
    const references = await options.sql.query(
      `SELECT ref.target_uid, ref.form_url, ref.readiness, ref.target_spec_path, ref.target_spec_equals
       FROM tf_v2_operation_references ref JOIN tf_v2_operation_reference_sets sealed
         ON sealed.operation_id = ref.operation_id AND sealed.sealed = 1
       WHERE ref.operation_id = ? ORDER BY ref.target_uid`,
      [version.last_operation as string],
    );
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
    const edge = await options.sql.query(
      "SELECT 1 FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ? LIMIT 1",
      [claim.workerVersionUid, desired.resourceUid],
    );
    if (edge.length !== 1) return null;
    const databaseRows = await options.sql.query(
      `SELECT r.generation, r.last_operation, r.spec_json
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create', 'update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        desired.resourceUid,
        SQLITE_DATABASE_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
      ],
    );
    const database = databaseRows.length === 1 ? databaseRows[0] : null;
    if (database?.spec_json !== "{}") return null;
    return {
      resourceUid: desired.resourceUid,
      vector: JSON.stringify([
        version.generation,
        version.last_operation,
        database.generation,
        database.last_operation,
      ]),
    };
  }
  return Object.freeze({ resolveCurrentBinding });
}
