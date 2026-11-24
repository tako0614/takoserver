import type { Sql } from "../ports.ts";
import {
  createV2ForwardContainerBindingReader,
  type V2ForwardContainerBindingClaim,
} from "../takoform-v2/forward-container-binding-authority.ts";
import type { createLinuxOciOwnedBundle } from "./linux-oci-owned-bundle.ts";

/** Coordinates copied only from the original accepted native publication.
 * These bytes are selectors, never caller authentication or a native grant. */
export interface LinuxOciWorkerdContainerClaim extends V2ForwardContainerBindingClaim {
  readonly workerUid: string;
  readonly workerVersionFormUrl: string;
  readonly targetKey: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
}

/** Constructed by the original OCI Node composition, using its actual creator
 * and canonical Sql. There is no configurable endpoint or positive native
 * verifier. Native caller custody stays in the original Workerd owner. */
export function createLinuxOciContainerBindingSource(input: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly workerBackendId: string;
  readonly containerBackendId: string;
  readonly original: ReturnType<typeof createLinuxOciOwnedBundle>;
}) {
  const sql = input.sql;
  const targetKey = input.targetKey;
  const workerBackendId = input.workerBackendId;
  const containerBackendId = input.containerBackendId;
  const originalOpen = input.original.openServingHttp.bind(input.original);
  const readCurrentServingTarget = input.original.observeCurrentServingTarget.bind(input.original);
  const query = sql.query.bind(sql);
  const read = createV2ForwardContainerBindingReader({
    sql,
    targetKey,
    workerBackendId,
    containerBackendId,
    readCurrentServingTarget,
    // This accepted owner read does not authenticate a caller. Every use is
    // additionally fenced by its original private native Version and lease.
    async authorize(principal, space) {
      const rows = await query(
        `SELECT 1 AS accepted_owner FROM tf_v2_resources
         WHERE principal=? AND space=? AND target_key=? AND backend_id=?
           AND deleted_at IS NULL LIMIT 1`,
        [principal, space, targetKey, workerBackendId],
      );
      return rows.length === 1 && rows[0]?.accepted_owner === 1;
    },
  });
  return Object.freeze({
    assertSql(actual: Sql) {
      if (actual !== sql) throw new Error("oci_binding_foreign_sql");
    },
    targetKey,
    read,
    readCurrentServingTarget,
    /** Eligibility of the original accepted, still-in-flight Version is not
     * the settled-Version dispatch reader (which would create a readiness cycle).
     * Its original resolution proves sealed references/currentness separately. */
    async readVersionTarget(input: {
      principal: string;
      space: string;
      workerVersionUid: string;
      targetUid: string;
    }) {
      const rows = await query(
        `SELECT r.uid FROM tf_v2_resources r
         JOIN tf_v2_resource_references edge ON edge.target_uid=r.uid
         JOIN tf_v2_container_instances native ON native.resource_uid=r.uid
         WHERE edge.referrer_uid=? AND r.uid=? AND r.principal=? AND r.space=?
           AND r.target_key=? AND r.backend_id=? AND r.deleted_at IS NULL AND r.phase<>'deleting'
           AND native.principal=r.principal AND native.space=r.space AND native.target_key=r.target_key
           AND native.backend_id=r.backend_id AND native.form_url=r.form_url
           AND native.serving_generation=r.observed_generation AND native.retired_at_ms IS NULL
           AND json_extract(r.observed_json,'$.ready')=1
           AND json_extract(r.observed_json,'$.servingGeneration')=r.observed_generation LIMIT 2`,
        [
          input.workerVersionUid,
          input.targetUid,
          input.principal,
          input.space,
          targetKey,
          containerBackendId,
        ],
      );
      return rows.length === 1 && rows[0]?.uid === input.targetUid ? input.targetUid : null;
    },
    async open(
      snapshot: NonNullable<Awaited<ReturnType<typeof read>>>,
      request: Request,
      refuseIfRevoked: () => void,
    ) {
      if (snapshot.targetKey !== targetKey || request.signal.aborted)
        throw new Error("oci_binding_target_current");
      const serving = snapshot.nativeServing;
      if (serving) {
        const current = await readCurrentServingTarget({
          principal: snapshot.principal,
          space: snapshot.space,
          targetKey,
          targetUid: snapshot.targetUid,
          targetFormUrl: snapshot.targetFormUrl,
        });
        if (
          !current ||
          current.incarnationId !== serving.incarnationId ||
          current.generation !== serving.generation ||
          current.runtimeEpoch !== serving.runtimeEpoch ||
          current.revisionOperationId !== serving.revisionOperationId ||
          current.claimId !== serving.claimId ||
          request.signal.aborted
        )
          throw new Error("oci_binding_target_current");
        return originalOpen(
          {
            resourceUid: snapshot.targetUid,
            incarnationId: serving.incarnationId,
            generation: serving.generation,
          },
          request,
          refuseIfRevoked,
        );
      }
      const rows = await query(
        `SELECT incarnation_id FROM tf_v2_container_instances
         WHERE resource_uid=? AND principal=? AND space=? AND target_key=?
           AND backend_id=? AND form_url=? AND serving_generation=? AND retired_at_ms IS NULL`,
        [
          snapshot.targetUid,
          snapshot.principal,
          snapshot.space,
          snapshot.targetKey,
          containerBackendId,
          snapshot.targetFormUrl,
          snapshot.targetGeneration,
        ],
      );
      const incarnation = rows.length === 1 ? rows[0]?.incarnation_id : undefined;
      if (
        typeof incarnation !== "string" ||
        !/^[0-9a-f]{64}$/u.test(incarnation) ||
        request.signal.aborted
      )
        throw new Error("oci_binding_target_current");
      return originalOpen(
        {
          resourceUid: snapshot.targetUid,
          incarnationId: incarnation,
          generation: snapshot.targetGeneration,
        },
        request,
        refuseIfRevoked,
      );
    },
  });
}
export type LinuxOciContainerBindingSource = ReturnType<
  typeof createLinuxOciContainerBindingSource
>;
