import { CONTAINER_CONTRACT as C, type ContainerBindingClaim } from "../container-contract.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { CONTAINER_DOCKER_BACKEND_ID } from "./forms/container-backend.ts";
import {
  parseContainerWorkerVersionSpec,
  referencesForContainerWorkerVersion,
} from "./forms/worker-container-specs.ts";

const F = C.fields;

export type { ContainerBindingClaim } from "../container-contract.ts";

/** Core-owned SQL evidence, sampled on every call. No caller URL or target lookup. */
export function createContainerBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly authorize: (principal: string, space: string) => Promise<boolean>;
}) {
  const { sql, targetKey, authorize } = options;
  return async (
    claim: ContainerBindingClaim,
  ): Promise<{ resourceUid: string; incarnationId: string } | null> => {
    if (!(await authorize(claim.principal, claim.space))) return null;
    const rows = await sql.query(
      `SELECT op.accepted_spec_json, op.generation, r.observed_generation, r.observed_json
      FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
      WHERE op.id = ? AND r.uid = ? AND r.principal = ? AND r.space = ? AND r.target_key = ?
        AND r.form_url = ? AND r.deleted_at IS NULL AND r.phase <> 'deleting'
        AND op.principal = r.principal AND op.target_key = r.target_key AND op.backend_id = r.backend_id
        AND op.action IN ('create','update') AND op.status = 'succeeded' AND op.effect = 'complete'
        AND op.generation = r.observed_generation LIMIT 2`,
      [
        claim.operationId,
        claim.workerVersionUid,
        claim.principal,
        claim.space,
        targetKey,
        C.workerVersionUrl,
      ],
    );
    if (
      rows.length !== 1 ||
      typeof rows[0]?.accepted_spec_json !== "string" ||
      typeof rows[0].observed_json !== "string"
    )
      return null;
    let spec: ReturnType<typeof parseContainerWorkerVersionSpec>;
    try {
      spec = parseContainerWorkerVersionSpec(JSON.parse(rows[0].accepted_spec_json));
      if (JSON.parse(rows[0].observed_json)[F.ready] !== true) return null;
    } catch {
      return null;
    }
    if (
      !spec[F.containerBindings].some(
        (binding) =>
          binding[F.name] === claim.bindingName &&
          binding[F.resource][F.resourceUid] === claim.targetUid,
      )
    )
      return null;
    const sets = await sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [claim.operationId],
    );
    if (sets.length !== 1 || sets[0]?.sealed !== 1) return null;
    const references = await sql.query(
      "SELECT target_uid, form_url, readiness FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [claim.operationId],
    );
    const expected = referencesForContainerWorkerVersion(spec)
      .map((ref) => ({
        target_uid: ref.resourceUid,
        form_url: ref.formUrl,
        readiness: ref.readiness,
      }))
      .sort((a, b) => (a.target_uid < b.target_uid ? -1 : a.target_uid > b.target_uid ? 1 : 0));
    if (canonicalJson(references) !== canonicalJson(expected)) return null;
    const targets = await sql.query(
      `SELECT r.uid FROM tf_v2_resources r JOIN tf_v2_resource_references ref ON ref.target_uid = r.uid
      WHERE ref.referrer_uid = ? AND r.uid = ? AND r.principal = ? AND r.space = ? AND r.target_key = ?
        AND r.backend_id = ? AND r.form_url = ? AND r.deleted_at IS NULL AND r.phase <> 'deleting' LIMIT 2`,
      [
        claim.workerVersionUid,
        claim.targetUid,
        claim.principal,
        claim.space,
        targetKey,
        CONTAINER_DOCKER_BACKEND_ID,
        C.formUrl,
      ],
    );
    if (targets.length !== 1) return null;
    return { resourceUid: claim.targetUid, incarnationId: targetKey };
  };
}
