import type { Clock, Sql } from "../ports.ts";
import type { WorkflowRuntime } from "../workflow-execution.ts";
import {
  DURABLE_WORKFLOW_FORM_URL,
  type DurableWorkflowSpec,
  DurableWorkflowValidationError,
  durableWorkflowReferences,
  parseDurableWorkflowSpec,
  validateDurableWorkflowUpdate,
} from "./forms/durable-workflow.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2BackendResult,
  type V2Execution,
  type V2Form,
} from "./types.ts";

export const DURABLE_WORKFLOW_BACKEND_ID = "selfhost-v2-durable-workflow-v1";

/**
 * A boot-selected held-byte/native class qualification. It must inspect every
 * active and pending weighted WorkerVersion and return a same-statement SQL
 * guard over the exact accepted graph. No Form factory may provide a mere flag.
 */
export interface V2WorkflowClassAdmission {
  prepare(input: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly resourceUid: string;
    readonly spec: DurableWorkflowSpec;
  }): Promise<
    | { readonly kind: "qualified"; readonly predicate: V2AdmissionPredicate }
    | { readonly kind: "incompatible" }
    | { readonly kind: "unavailable" }
  >;
  observe(input: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly resourceUid: string;
    readonly spec: DurableWorkflowSpec;
  }): Promise<"ready" | "not_ready" | "unavailable">;
}

const UNKNOWN: V2BackendResult = {
  kind: "unknown",
  code: "outcome_unconfirmed",
  message: "Workflow outcome is unconfirmed",
};
const PAGE = 64;
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

function claimSql(): string {
  return `EXISTS (
    SELECT 1 FROM tf_v2_resources AS workflow_resource
    JOIN tf_v2_operations AS workflow_op ON workflow_op.id = workflow_resource.busy_operation
    WHERE workflow_resource.uid = ? AND workflow_resource.principal = ?
      AND workflow_resource.space = ? AND workflow_resource.target_key = ?
      AND workflow_resource.form_url = ? AND workflow_resource.deleted_at IS NULL
      AND workflow_resource.generation = ? AND workflow_resource.last_operation = ?
      AND workflow_resource.busy_operation = ?
      AND workflow_resource.phase = ?
      AND workflow_op.resource_uid = workflow_resource.uid
      AND workflow_op.principal = workflow_resource.principal
      AND workflow_op.backend_id = ? AND workflow_op.target_key = ?
      AND workflow_op.generation = workflow_resource.generation
      AND workflow_op.action = ? AND workflow_op.status IN ('running','reconciling')
      AND workflow_op.lease_token = ? AND workflow_op.lease_until_ms > ${DB_NOW_MS}
      AND workflow_op.accepted_spec_json = workflow_resource.spec_json
  )`;
}

function claimParams(input: V2Execution): (string | number)[] {
  return [
    input.resourceUid,
    input.principal,
    input.space,
    input.targetKey,
    DURABLE_WORKFLOW_FORM_URL,
    input.generation,
    input.operationId,
    input.operationId,
    input.action === "delete" ? "deleting" : "pending",
    input.backendId,
    input.targetKey,
    input.action,
    input.leaseToken,
  ];
}

/**
 * The public Resource/Operation is the only management ledger. Instance rows
 * are execution data under its UID; DELETE is a bounded drain of that data.
 */
export function createDurableWorkflowForm(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly targetKey: string;
  readonly classAdmission: V2WorkflowClassAdmission;
  readonly runtime: Pick<WorkflowRuntime, "instances" | "retireExpiredForResourceDelete">;
}): V2Form {
  const { sql, clock, targetKey, classAdmission, runtime } = options;
  if (
    !sql ||
    typeof sql.query !== "function" ||
    typeof sql.run !== "function" ||
    typeof sql.batch !== "function" ||
    typeof clock !== "function" ||
    typeof targetKey !== "string" ||
    !targetKey ||
    typeof classAdmission?.prepare !== "function" ||
    typeof classAdmission?.observe !== "function" ||
    typeof runtime?.instances?.terminate !== "function" ||
    typeof runtime?.retireExpiredForResourceDelete !== "function"
  ) {
    throw new TypeError("v2 Workflow requires SQL, clock, class qualification and execution owner");
  }

  const now = (): number => {
    const value = clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid Workflow clock");
    return value;
  };
  const owns = async (input: V2Execution): Promise<boolean> => {
    const rows = await sql.query(`SELECT 1 AS claimed WHERE ${claimSql()}`, claimParams(input));
    return rows.length === 1;
  };

  const counts = async (input: V2Execution): Promise<Record<string, number>> => {
    const result: Record<string, number> = {
      queued: 0,
      running: 0,
      sleeping: 0,
      waiting: 0,
      complete: 0,
      errored: 0,
      terminated: 0,
    };
    const rows = await sql.query(
      `SELECT status, count(*) AS total FROM tf_workflow_instances
       WHERE tenant_id = ? AND workflow_resource_uid = ? GROUP BY status`,
      [input.principal, input.resourceUid],
    );
    for (const row of rows) {
      if (
        typeof row.status !== "string" ||
        !Object.hasOwn(result, row.status) ||
        typeof row.total !== "number" ||
        !Number.isSafeInteger(row.total) ||
        row.total < 0
      ) {
        throw new Error("invalid Workflow instance counts");
      }
      result[row.status] = row.total;
    }
    return result;
  };

  async function drain(input: V2Execution): Promise<V2BackendResult> {
    const scope = { tenantId: input.principal, workflowResourceUid: input.resourceUid };
    // Acceptance sets Resource.phase=deleting. Every subsequent create, event,
    // wake and execution write has a same-statement v2 live predicate.
    if (!(await owns(input))) return UNKNOWN;
    const rows = await sql.query(
      `SELECT instance_id, retention_until FROM tf_workflow_instances
       WHERE tenant_id = ? AND workflow_resource_uid = ?
       ORDER BY instance_id LIMIT ?`,
      [scope.tenantId, scope.workflowResourceUid, PAGE],
    );
    if (rows.length > PAGE) return UNKNOWN;
    for (const row of rows) {
      if (
        typeof row.instance_id !== "string" ||
        typeof row.retention_until !== "number" ||
        !Number.isSafeInteger(row.retention_until) ||
        !(await owns(input))
      )
        return UNKNOWN;
      // This is the core's physical-stop path, including terminal rows still
      // carrying an owner. A failed stop retains history and keeps DELETE open.
      if (row.retention_until <= now())
        await runtime.retireExpiredForResourceDelete(scope, row.instance_id);
      else await runtime.instances.terminate(scope, row.instance_id);
    }
    if (!(await owns(input))) return UNKNOWN;
    if (rows.length === 0) {
      const instanceCounts = await counts(input);
      if (!(await owns(input))) return UNKNOWN;
      return {
        kind: "complete",
        observed: { ready: false, instanceCounts },
        output: {},
      };
    }
    const ids = rows.map((row) => row.instance_id as string);
    const slots = ids.map(() => "?").join(", ");
    const guard = claimSql();
    const guardParams = claimParams(input);
    const parent = `tenant_id = ? AND workflow_resource_uid = ? AND instance_id IN (${slots})
      AND (status IN ('complete','errored','terminated') OR retention_until <= ?)
      AND run_owner IS NULL AND run_lease_until IS NULL`;
    const parentParams = [scope.tenantId, scope.workflowResourceUid, ...ids, now()];
    // Child journal rows are removed by their exact execution incarnation.
    // Every statement repeats the accepted Operation lease predicate, so an
    // expired former worker cannot purge after a replacement claim.
    const statements = ["tf_workflow_steps", "tf_workflow_events", "tf_workflow_instances"].map(
      (table) => ({
        sql: `DELETE FROM ${table} WHERE ${
          table === "tf_workflow_instances"
            ? parent
            : `execution_id IN (SELECT execution_id FROM tf_workflow_instances WHERE ${parent})`
        }
          AND ${guard}`,
        params: [...parentParams, ...guardParams],
      }),
    );
    const deleted = await sql.batch(statements);
    if (deleted.length !== 3 || deleted[2]?.changes !== rows.length) return UNKNOWN;
    return { kind: "continue" };
  }

  async function apply(input: V2Execution): Promise<V2BackendResult> {
    if (
      input.form !== DURABLE_WORKFLOW_FORM_URL ||
      input.backendId !== DURABLE_WORKFLOW_BACKEND_ID ||
      input.targetKey !== targetKey
    )
      return UNKNOWN;
    try {
      const spec = parseDurableWorkflowSpec(input.spec);
      if (!(await owns(input))) return UNKNOWN;
      if (input.action === "delete") return await drain(input);
      const readiness = await classAdmission.observe({
        principal: input.principal,
        space: input.space,
        targetKey,
        resourceUid: input.resourceUid,
        spec,
      });
      if (readiness === "unavailable" || !(await owns(input))) return UNKNOWN;
      const instanceCounts = await counts(input);
      if (!(await owns(input))) return UNKNOWN;
      return {
        kind: "complete",
        observed: { ready: readiness === "ready", instanceCounts },
        output: {},
      };
    } catch {
      // After acceptance, never claim no effect or re-mint a Resource UID.
      return UNKNOWN;
    }
  }

  return {
    validateCreate(spec) {
      try {
        parseDurableWorkflowSpec(spec);
      } catch (error) {
        if (error instanceof DurableWorkflowValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateDurableWorkflowUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof DurableWorkflowValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    references(spec) {
      return durableWorkflowReferences(parseDurableWorkflowSpec(spec));
    },
    async prepareAdmission(input) {
      if (input.form !== DURABLE_WORKFLOW_FORM_URL) throw new TakoformV2Error("invalid_spec", 422);
      const spec = parseDurableWorkflowSpec(input.spec);
      const result = await classAdmission.prepare({
        principal: input.principal,
        space: input.space,
        targetKey,
        resourceUid: input.resourceUid,
        spec,
      });
      if (result.kind === "unavailable") throw new TakoformV2Error("resource_busy", 409);
      if (result.kind === "incompatible") return null;
      return result.predicate;
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: DURABLE_WORKFLOW_BACKEND_ID,
      targetKey,
      execute: apply,
      reconcile: apply,
    },
  };
}
