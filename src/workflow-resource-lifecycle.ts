import { canonicalJson } from "./json.ts";
import type { Sql, SqlParam, SqlStatement } from "./ports.ts";
import { TakoformHostError, type TakoformV1Alpha3FormRef } from "./takoform/types.ts";

/**
 * The exact, unpublished joint Actor+Workflow source selection, not the
 * published DurableWorkflow Form or the worker.workflow Interface identity.
 * Rendered from takoform-forms source 0d8e5b7, tree 83d2467, with the
 * publisher's RFC 8785 Form digest command. This source-only contribution
 * neither installs the Form nor activates a Workflow runtime.
 */
const SELECTED_DURABLE_WORKFLOW_FORM_REF = Object.freeze({
  apiVersion: "edge.forms.takoform.com",
  kind: "DurableWorkflow",
  definitionVersion: "0.2.0",
  schemaDigest: "sha256:21b0c5cfd9722d58ca669297cf856120cf8443aa8f653a36f13d452ddf8e5585",
}) satisfies TakoformV1Alpha3FormRef;

/** Named opt-in; possession is tied to the very Sql object shared by Host and runtime. */
export interface WorkflowResourceDeletionContribution {
  readonly formRef: TakoformV1Alpha3FormRef;
}

const owners = new WeakMap<WorkflowResourceDeletionContribution, Sql>();
const TERMINAL = "'complete', 'errored', 'terminated'";
const FORM_REF_JSON = canonicalJson(SELECTED_DURABLE_WORKFLOW_FORM_REF).replaceAll("'", "''");
const FORM_REF_SQL = `'${FORM_REF_JSON}'`;

export function isSelectedWorkflowResourceFormRef(
  value: unknown,
): value is TakoformV1Alpha3FormRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.apiVersion === SELECTED_DURABLE_WORKFLOW_FORM_REF.apiVersion &&
    candidate.kind === SELECTED_DURABLE_WORKFLOW_FORM_REF.kind &&
    candidate.definitionVersion === SELECTED_DURABLE_WORKFLOW_FORM_REF.definitionVersion &&
    candidate.schemaDigest === SELECTED_DURABLE_WORKFLOW_FORM_REF.schemaDigest &&
    Reflect.ownKeys(candidate).length === 4
  );
}

export function createWorkflowResourceDeletionContribution(
  sql: Sql,
  exactSelectedFormRef: TakoformV1Alpha3FormRef,
): WorkflowResourceDeletionContribution {
  if (
    !sql ||
    typeof sql.query !== "function" ||
    typeof sql.run !== "function" ||
    typeof sql.batch !== "function" ||
    !isSelectedWorkflowResourceFormRef(exactSelectedFormRef)
  ) {
    throw new TypeError("the exact selected DurableWorkflow Form and Sql are required");
  }
  const contribution = Object.freeze({
    formRef: SELECTED_DURABLE_WORKFLOW_FORM_REF,
  });
  owners.set(contribution, sql);
  return contribution;
}

export function requireWorkflowResourceDeletionContribution(
  contribution: WorkflowResourceDeletionContribution,
  sql: Sql,
): void {
  if (owners.get(contribution) !== sql) {
    throw new TypeError("Workflow Resource lifecycle contribution belongs to another Sql");
  }
}

/**
 * A live Resource/attestation of the exact selected Form. The correlation
 * expressions must be trusted SQL identifiers from this module's callers.
 */
export function workflowResourceLiveSql(
  tenant: string,
  uid: string,
  state: "live" | "live-or-pending" = "live",
): string {
  return `EXISTS (
    SELECT 1 FROM tf_resources AS workflow_resource
    JOIN tf_resource_deletion_attestations AS workflow_attestation
      ON workflow_attestation.tenant_id = workflow_resource.tenant_id
     AND workflow_attestation.resource_uid = workflow_resource.uid
     AND workflow_attestation.space = workflow_resource.space
     AND workflow_attestation.api_version = workflow_resource.api_version
     AND workflow_attestation.kind = workflow_resource.kind
     AND workflow_attestation.name = workflow_resource.name
    WHERE workflow_resource.tenant_id = ${tenant}
      AND workflow_resource.uid = ${uid}
      AND workflow_resource.api_version = 'edge.forms.takoform.com'
      AND workflow_resource.kind = 'DurableWorkflow'
      AND workflow_attestation.state ${state === "live" ? "= 'live'" : "IN ('live', 'pending')"}
      AND workflow_attestation.form_ref_json = ${FORM_REF_SQL}
      AND json_extract(workflow_resource.resource_json, '$.form.formRef.apiVersion') = 'edge.forms.takoform.com'
      AND json_extract(workflow_resource.resource_json, '$.form.formRef.kind') = 'DurableWorkflow'
      AND json_extract(workflow_resource.resource_json, '$.form.formRef.definitionVersion') = '0.2.0'
      AND json_extract(workflow_resource.resource_json, '$.form.formRef.schemaDigest') = '${SELECTED_DURABLE_WORKFLOW_FORM_REF.schemaDigest}'
  )`;
}

/** Owner metadata alone is not a permanent dependency under a qualified host. */
function blockingExecutionSql(): string {
  return `CASE WHEN status IN (${TERMINAL}) AND (
    (run_owner IS NULL AND run_lease_until IS NULL)
    OR (run_owner IS NOT NULL AND run_lease_until IS NOT NULL AND run_lease_until <= ?)
  ) THEN 0 ELSE 1 END = 1`;
}

export function workflowDeletionReadyFence(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly now: number;
}): { readonly sql: string; readonly params: readonly SqlParam[] } {
  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM tf_workflow_instances
      WHERE tenant_id = ? AND workflow_resource_uid = ?
        AND (${blockingExecutionSql()})
    )`,
    params: [input.tenantId, input.resourceUid, input.now],
  };
}

/** Side-effect-free refusal before a Host accepts a deletion saga. */
export async function assertWorkflowResourceDeletionReady(
  contribution: WorkflowResourceDeletionContribution,
  input: { readonly tenantId: string; readonly resourceUid: string; readonly now: number },
): Promise<void> {
  const sql = owners.get(contribution);
  if (!sql) throw new TypeError("unbound Workflow Resource lifecycle contribution");
  const rows = await sql.query(
    `SELECT instance_id, status FROM tf_workflow_instances
     WHERE tenant_id = ? AND workflow_resource_uid = ?
       AND (${blockingExecutionSql()})
     ORDER BY instance_id LIMIT 1`,
    [input.tenantId, input.resourceUid, input.now],
  );
  const row = rows[0];
  if (row) {
    throw new TakoformHostError("dependency_in_use", 409, {
      dependencyKind: "workflow_execution",
      instanceId: row.instance_id,
      status: row.status,
    });
  }
}

/**
 * A final Host batch applies this only to the exact selected attestation.
 * Published/standalone DurableWorkflow incarnations remain unchanged.
 */
export function workflowDeletionCommitFence(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly now: number;
}): { readonly sql: string; readonly params: readonly SqlParam[] } {
  const ready = workflowDeletionReadyFence(input);
  return {
    sql: `(NOT EXISTS (
      SELECT 1 FROM tf_resource_deletion_attestations
      WHERE tenant_id = ? AND resource_uid = ? AND state = 'pending'
        AND form_ref_json = ${FORM_REF_SQL}
    ) OR ${ready.sql})`,
    params: [input.tenantId, input.resourceUid, ...ready.params],
  };
}

/** Called inside the same atomic Host batch after its Resource DELETE. */
export function workflowDeletionPurgeStatements(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
}): readonly SqlStatement[] {
  const exactClosed = `EXISTS (
    SELECT 1 FROM tf_resource_deletion_attestations
    WHERE tenant_id = ? AND resource_uid = ? AND state = 'closed'
      AND form_ref_json = ${FORM_REF_SQL}
  )`;
  const scope = [input.tenantId, input.resourceUid];
  return ["tf_workflow_steps", "tf_workflow_events", "tf_workflow_instances"].map((table) => ({
    sql: `DELETE FROM ${table}
      WHERE tenant_id = ? AND workflow_resource_uid = ? AND ${exactClosed}`,
    params: [...scope, ...scope],
  }));
}

/**
 * The ordinary Host tombstone-close UPDATE may change zero rows when another
 * provider effect remains open. Refuse the whole final batch rather than
 * delete the Resource while leaving its Workflow history behind.
 */
export function workflowDeletionClosedGuard(input: {
  readonly token: string;
  readonly tenantId: string;
  readonly resourceUid: string;
}): { readonly check: SqlStatement; readonly cleanup: SqlStatement } {
  return {
    check: {
      sql: `INSERT INTO tf_operation_commit_guards (token, valid)
        SELECT ?, CASE WHEN EXISTS (
          SELECT 1 FROM tf_resource_deletion_attestations
          WHERE tenant_id = ? AND resource_uid = ? AND state = 'pending'
            AND form_ref_json = ${FORM_REF_SQL}
        ) THEN 0 ELSE 1 END`,
      params: [input.token, input.tenantId, input.resourceUid],
    },
    cleanup: {
      sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
      params: [input.token],
    },
  };
}
