import type { Sql } from "./ports.ts";

export const DURABLE_WORKFLOW_FORM_URL =
  "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/" as const;

/** Opaque, boot-selected authority. The instance engine never accepts caller SQL. */
export interface V2WorkflowResourceAuthority {
  readonly kind: "takoserver.v2-workflow-resource-authority";
}

const owners = new WeakMap<V2WorkflowResourceAuthority, Sql>();

export function createV2WorkflowResourceAuthority(sql: Sql): V2WorkflowResourceAuthority {
  if (
    !sql ||
    typeof sql.query !== "function" ||
    typeof sql.run !== "function" ||
    typeof sql.batch !== "function"
  ) {
    throw new TypeError("v2 Workflow authority requires SQL");
  }
  const authority = Object.freeze({ kind: "takoserver.v2-workflow-resource-authority" as const });
  owners.set(authority, sql);
  return authority;
}

export function requireV2WorkflowResourceAuthority(
  authority: V2WorkflowResourceAuthority,
  sql: Sql,
): void {
  if (owners.get(authority) !== sql)
    throw new TypeError("v2 Workflow authority belongs to another SQL store");
}

/**
 * `tenantId` is the accepted v2 principal and `uid` is the Host-issued Resource UID.
 * A successful incarnation, even during a same-spec PUT, can continue. DELETE
 * changes phase before execution and event writes can commit. The predicate is
 * embedded in those writes, not merely checked before a race-producing await.
 */
export function v2WorkflowLiveSql(tenantId: string, uid: string): string {
  return `EXISTS (
    SELECT 1 FROM tf_v2_resources AS workflow_resource
    WHERE workflow_resource.principal = ${tenantId}
      AND workflow_resource.uid = ${uid}
      AND workflow_resource.form_url = '${DURABLE_WORKFLOW_FORM_URL}'
      AND workflow_resource.deleted_at IS NULL
      AND workflow_resource.phase IN ('idle', 'pending')
      AND EXISTS (
        SELECT 1 FROM tf_v2_operations AS workflow_prior
        WHERE workflow_prior.resource_uid = workflow_resource.uid
          AND workflow_prior.principal = workflow_resource.principal
          AND workflow_prior.action IN ('create', 'update')
          AND workflow_prior.status = 'succeeded' AND workflow_prior.effect = 'complete'
      )
  )`;
}

/** New instances additionally need the current settled, Ready observation. */
export function v2WorkflowReadySql(tenantId: string, uid: string): string {
  return `EXISTS (
    SELECT 1 FROM tf_v2_resources AS workflow_resource
    JOIN tf_v2_operations AS workflow_op ON workflow_op.id = workflow_resource.last_operation
    WHERE workflow_resource.principal = ${tenantId}
      AND workflow_resource.uid = ${uid}
      AND workflow_resource.form_url = '${DURABLE_WORKFLOW_FORM_URL}'
      AND workflow_resource.deleted_at IS NULL
      AND workflow_resource.phase = 'idle'
      AND workflow_resource.busy_operation IS NULL
      AND workflow_resource.generation = workflow_resource.observed_generation
      AND workflow_op.resource_uid = workflow_resource.uid
      AND workflow_op.principal = workflow_resource.principal
      AND workflow_op.generation = workflow_resource.generation
      AND workflow_op.action IN ('create', 'update')
      AND workflow_op.status = 'succeeded' AND workflow_op.effect = 'complete'
      AND workflow_op.accepted_spec_json = workflow_resource.spec_json
      AND json_extract(workflow_resource.observed_json, '$.ready') = 1
  )`;
}
