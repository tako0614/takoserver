import type { TakoformInterfaceRef } from "./interface-ref.ts";
import { type Clock, type JsonObject, type Row, type Sql, SqlError } from "./ports.ts";
import {
  addDuration,
  DocumentValidationError,
  encodeDocument,
  generatedIdentifier,
  inputIdentifier,
  isUnicodeScalarString,
  normalizeScope,
  nullableString,
  parseDocument,
  plainInputRecord,
  rowValue,
  WorkflowInputError,
} from "./workflow-data.ts";
import {
  requireWorkflowResourceDeletionContribution,
  type WorkflowResourceDeletionContribution,
  workflowResourceLiveSql,
} from "./workflow-resource-lifecycle.ts";

export { WORKFLOW_MAX_DOCUMENT_BYTES, WORKFLOW_MAX_TOP_PROPERTIES } from "./workflow-data.ts";

/** The status vocabulary released by worker.workflow@1.0.0. */
export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "sleeping"
  | "waiting"
  | "complete"
  | "errored"
  | "terminated";

export type WorkflowErrorReason =
  | "run_threw"
  | "step_failed"
  | "step_limit_exceeded"
  | "lifetime_exceeded"
  /** Candidate-only execution definition mismatch; not in released 1.0.0. */
  | "step_definition_mismatch";

export interface WorkflowScope {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
}

export interface WorkflowCreateInput {
  readonly id?: string;
  readonly params?: unknown;
}

export interface WorkflowEventInput {
  readonly type: string;
  readonly payload?: unknown;
}

export interface WorkflowInstanceHandle {
  readonly id: string;
}

export interface WorkflowCreateResult extends WorkflowInstanceHandle {
  readonly status: "queued";
}

export interface WorkflowInstanceStatusError {
  readonly reason: WorkflowErrorReason;
  readonly message?: string;
}

export interface WorkflowInstanceStatusResult {
  readonly status: WorkflowInstanceStatus;
  readonly output?: JsonObject;
  readonly error?: WorkflowInstanceStatusError;
}

export interface WorkflowSweepOptions {
  readonly scope?: WorkflowScope;
  readonly limit?: number;
}

export type WorkflowInstanceErrorCode =
  | "instance_exists"
  | "invalid_params"
  | "document_too_large"
  | "unknown_instance"
  | "instance_terminal"
  | "event_queue_full"
  | "backend_unavailable";

/**
 * A closed operation error from the INSTANCE surface.
 *
 * The code is intentionally also used as Error.name.  The binding contract
 * describes these as ordinary Errors named for the portable refusal, while
 * the domain caller still needs a typed code before it renders a wire error.
 */
export class WorkflowInstanceError extends Error {
  constructor(readonly code: WorkflowInstanceErrorCode) {
    super(code);
    this.name = code;
  }
}

export interface WorkflowInstancesOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomId: () => string;
  /** Opt into the exact unpublished v3 event-retention contract. */
  readonly workflowInterfaceRef?: TakoformInterfaceRef;
  /** Exact source-only Resource admission, bound to this very Sql object. */
  readonly workflowResourceDeletion?: WorkflowResourceDeletionContribution;
}

export interface WorkflowInstances {
  create(scope: WorkflowScope, input?: WorkflowCreateInput): Promise<WorkflowCreateResult>;
  get(scope: WorkflowScope, id: string): Promise<WorkflowInstanceHandle>;
  status(scope: WorkflowScope, id: string): Promise<WorkflowInstanceStatusResult>;
  sendEvent(scope: WorkflowScope, id: string, input: WorkflowEventInput): Promise<void>;
  terminate(scope: WorkflowScope, id: string): Promise<void>;
  /** Delete at most `limit` rows whose terminal retention has elapsed. */
  sweepExpired(input?: WorkflowSweepOptions): Promise<number>;
}

/** Bounds are kept in seconds in the published contract; storage uses ms. */
export const WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS = 31_536_000;
export const WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS = 2_592_000;
const WORKFLOW_MAX_PENDING_EVENT_COUNT = 1_024;
const WORKFLOW_MAX_PENDING_EVENT_BYTES = 1_048_576;

const WORKFLOW_V3_INTERFACE_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.workflow",
  version: "3.0.0",
  schemaDigest: "sha256:2584721b4bc9f5feef94b272337c348fb67130de57317afaf84aa7ca55246f69",
} as const satisfies TakoformInterfaceRef;

export function isExactWorkflowV3InterfaceRef(value: unknown): value is TakoformInterfaceRef {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          key !== "apiVersion" && key !== "name" && key !== "version" && key !== "schemaDigest",
      )
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    return (
      ["apiVersion", "name", "version", "schemaDigest"].every((key) => {
        const descriptor = descriptors[key];
        return descriptor?.enumerable && "value" in descriptor;
      }) &&
      candidate.apiVersion === WORKFLOW_V3_INTERFACE_REF.apiVersion &&
      candidate.name === WORKFLOW_V3_INTERFACE_REF.name &&
      candidate.version === WORKFLOW_V3_INTERFACE_REF.version &&
      candidate.schemaDigest === WORKFLOW_V3_INTERFACE_REF.schemaDigest
    );
  } catch {
    return false;
  }
}

const MAX_SWEEP_ROWS = 64;
const NON_TERMINAL_SQL = "'queued', 'running', 'sleeping', 'waiting'";
const TERMINAL_STATUSES = new Set<WorkflowInstanceStatus>(["complete", "errored", "terminated"]);
const STATUS_VALUES = new Set<WorkflowInstanceStatus>([
  "queued",
  "running",
  "sleeping",
  "waiting",
  "complete",
  "errored",
  "terminated",
]);
const ERROR_REASONS = new Set<WorkflowErrorReason>([
  "run_threw",
  "step_failed",
  "step_limit_exceeded",
  "lifetime_exceeded",
  "step_definition_mismatch",
]);

const INSTANCE_LIFETIME_MS = WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000;
const TERMINAL_RETENTION_MS = WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000;
const LIFETIME_ERROR_JSON = '{"reason":"lifetime_exceeded"}';

/**
 * Durable state for one workflow class.  This module deliberately does not
 * inspect a Worker Deployment or execute a class; that capability check is a
 * caller-owned boundary.  It owns instance identity, status, events and the
 * two finite lifetime bounds.  The exact v3 profile additionally settles an
 * already-parked wait in the existing execution journal.
 */
export function createWorkflowInstances(options: WorkflowInstancesOptions): WorkflowInstances {
  if (typeof options.clock !== "function") {
    throw new TypeError("a workflow instance clock is required");
  }
  if (typeof options.randomId !== "function") {
    throw new TypeError("a workflow instance randomId function is required");
  }
  if (
    options.workflowInterfaceRef !== undefined &&
    !isExactWorkflowV3InterfaceRef(options.workflowInterfaceRef)
  ) {
    throw new TypeError("unsupported workflow interface reference");
  }
  const workflowV3Enabled = options.workflowInterfaceRef !== undefined;
  if (options.workflowResourceDeletion) {
    if (!workflowV3Enabled) throw new TypeError("Workflow Resource lifecycle requires exact v3");
    requireWorkflowResourceDeletionContribution(options.workflowResourceDeletion, options.sql);
  }
  const liveInstance = options.workflowResourceDeletion
    ? workflowResourceLiveSql(
        "tf_workflow_instances.tenant_id",
        "tf_workflow_instances.workflow_resource_uid",
      )
    : "1 = 1";
  const liveSelected = options.workflowResourceDeletion
    ? workflowResourceLiveSql("instance.tenant_id", "instance.workflow_resource_uid")
    : "1 = 1";

  const randomId = options.randomId;
  const now = (): number => {
    const timestamp = options.clock().getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("the workflow instance clock returned an invalid instant");
    }
    return timestamp;
  };
  const selectedResourceLive = async (scope: WorkflowScope): Promise<boolean> => {
    if (!options.workflowResourceDeletion) return true;
    const rows = await options.sql.query(
      `SELECT 1 AS live WHERE ${workflowResourceLiveSql("?", "?")}`,
      [scope.tenantId, scope.workflowResourceUid],
    );
    return rows.length === 1;
  };

  return {
    async create(scope, input = {}): Promise<WorkflowCreateResult> {
      const normalizedScope = normalizeScope(scope);
      const prepared = prepareCreateInput(input);
      return await withBackend(async () => {
        let instanceId = prepared.id;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (instanceId === undefined) {
            instanceId = generatedIdentifier(randomId(), "instance id");
          }
          const executionId = generatedIdentifier(randomId(), "execution id");
          const timestamp = now();
          const deadline = addDuration(timestamp, INSTANCE_LIFETIME_MS, "instance deadline");
          const retention = addDuration(deadline, TERMINAL_RETENTION_MS, "instance retention");
          let results: readonly { readonly changes: number }[];
          try {
            results = await options.sql.batch([
              {
                sql: `DELETE FROM tf_workflow_steps
                      WHERE EXISTS (
                        SELECT 1 FROM tf_workflow_instances AS instance
                        WHERE instance.execution_id = tf_workflow_steps.execution_id
                          AND instance.created_at = tf_workflow_steps.execution_created_at
                          AND instance.tenant_id = ? AND instance.workflow_resource_uid = ?
                          AND instance.instance_id = ? AND instance.retention_until <= ?
                      )`,
                params: [
                  normalizedScope.tenantId,
                  normalizedScope.workflowResourceUid,
                  instanceId,
                  timestamp,
                ],
              },
              {
                sql: `DELETE FROM tf_workflow_events
                      WHERE execution_id IN (
                        SELECT execution_id
                        FROM tf_workflow_instances
                        WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                          AND retention_until <= ?
                      )`,
                params: [
                  normalizedScope.tenantId,
                  normalizedScope.workflowResourceUid,
                  instanceId,
                  timestamp,
                ],
              },
              {
                sql: `DELETE FROM tf_workflow_instances
                      WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                        AND retention_until <= ?`,
                params: [
                  normalizedScope.tenantId,
                  normalizedScope.workflowResourceUid,
                  instanceId,
                  timestamp,
                ],
              },
              {
                sql: `INSERT INTO tf_workflow_instances
                        (tenant_id, workflow_resource_uid, instance_id, execution_id,
                         params_json, status, output_json, error_json,
                         created_at, updated_at, deadline_at, retention_until, revision)
                      SELECT ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, ?, 1
                      WHERE NOT EXISTS (
                        SELECT 1
                        FROM tf_workflow_instances
                        WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                      ) AND ${options.workflowResourceDeletion ? workflowResourceLiveSql("?", "?") : "1 = 1"}`,
                params: [
                  normalizedScope.tenantId,
                  normalizedScope.workflowResourceUid,
                  instanceId,
                  executionId,
                  prepared.paramsJson,
                  timestamp,
                  timestamp,
                  deadline,
                  retention,
                  normalizedScope.tenantId,
                  normalizedScope.workflowResourceUid,
                  instanceId,
                  ...(options.workflowResourceDeletion
                    ? [normalizedScope.tenantId, normalizedScope.workflowResourceUid]
                    : []),
                ],
              },
            ]);
          } catch (error) {
            // A private execution-id collision is recoverable by minting a new
            // fence.  A duplicate public id is represented by the guarded
            // INSERT as changes=0, not by a broad constraint catch.
            if (isConstraintError(error) && attempt < 7) continue;
            throw error;
          }
          if (results.length !== 4) throw new Error("workflow create batch was truncated");
          if (results[3]?.changes === 1) {
            return { id: instanceId, status: "queued" };
          }
          const current = await visibleInstance(normalizedScope, instanceId, timestamp);
          if (current) {
            if (prepared.id !== undefined) {
              throw new WorkflowInstanceError("instance_exists");
            }
            // The host-minted id collided.  Keep the same params and try a new
            // id; no caller-visible instance exists until the INSERT wins.
            instanceId = undefined;
            continue;
          }
          if (!(await selectedResourceLive(normalizedScope))) {
            throw new WorkflowInstanceError("unknown_instance");
          }
          throw new Error("workflow create guard did not produce an instance");
        }
        throw new Error("workflow instance id generation exhausted");
      });
    },

    async get(scope, id): Promise<WorkflowInstanceHandle> {
      const normalizedScope = normalizeScope(scope);
      const normalizedId = inputIdentifier(id, "instance id");
      return await withBackend(async () => {
        const timestamp = now();
        await settleExpired(normalizedScope, normalizedId, timestamp);
        const current = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!current) throw new WorkflowInstanceError("unknown_instance");
        return { id: normalizedId };
      });
    },

    async status(scope, id): Promise<WorkflowInstanceStatusResult> {
      const normalizedScope = normalizeScope(scope);
      const normalizedId = inputIdentifier(id, "instance id");
      return await withBackend(async () => {
        const timestamp = now();
        await settleExpired(normalizedScope, normalizedId, timestamp);
        const current = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!current) throw new WorkflowInstanceError("unknown_instance");
        return materializeStatus(current);
      });
    },

    async sendEvent(scope, id, input): Promise<void> {
      const normalizedScope = normalizeScope(scope);
      const normalizedId = inputIdentifier(id, "instance id");
      const event = prepareEventInput(input);
      await withBackend(async () => {
        const timestamp = now();
        await settleExpired(normalizedScope, normalizedId, timestamp);
        const current = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!current) throw new WorkflowInstanceError("unknown_instance");
        if (TERMINAL_STATUSES.has(current.status)) {
          throw new WorkflowInstanceError("instance_terminal");
        }
        if (workflowV3Enabled) {
          await sendV3Event(normalizedScope, normalizedId, current, event, timestamp);
          return;
        }
        const results = await options.sql.batch([
          {
            sql: `INSERT INTO tf_workflow_events
             (tenant_id, workflow_resource_uid, instance_id, execution_id,
              type, payload_json, created_at)
           SELECT tenant_id, workflow_resource_uid, instance_id, execution_id,
                  ?, ?, ?
           FROM tf_workflow_instances
           WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
             AND execution_id = ?
             AND created_at = ?
             AND retention_until > ? AND deadline_at > ?
             AND status NOT IN ('complete', 'errored', 'terminated')`,
            params: [
              event.type,
              event.payloadJson,
              timestamp,
              normalizedScope.tenantId,
              normalizedScope.workflowResourceUid,
              normalizedId,
              current.executionId,
              current.createdAt,
              timestamp,
              timestamp,
            ],
          },
          {
            sql: `UPDATE tf_workflow_instances
                  SET wake_at = CASE WHEN wake_at IS NULL OR wake_at > ? THEN ? ELSE wake_at END,
                      revision = revision + 1
                  WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                    AND execution_id = ? AND created_at = ?
                    AND retention_until > ? AND deadline_at > ?
                    AND status = 'waiting'
                    AND EXISTS (
                      SELECT 1 FROM tf_workflow_steps AS step
                      WHERE step.execution_id = tf_workflow_instances.execution_id
                        AND step.execution_created_at = tf_workflow_instances.created_at
                        AND step.name = tf_workflow_instances.pending_step_name
                        AND step.kind = 'wait' AND step.wait_type = ?
                        AND step.state = 'waiting'
                    )`,
            params: [
              timestamp,
              timestamp,
              normalizedScope.tenantId,
              normalizedScope.workflowResourceUid,
              normalizedId,
              current.executionId,
              current.createdAt,
              timestamp,
              timestamp,
              event.type,
            ],
          },
        ]);
        if (results.length !== 2) throw new Error("workflow event batch was truncated");
        if (results[0]?.changes === 1) return;

        // The guarded INSERT can lose because a concurrent operation
        // terminalized the instance.  The same sampled instant is used for
        // settlement, insertion and classification so this call has one clear
        // storage linearization point.
        const after = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!after) throw new WorkflowInstanceError("unknown_instance");
        if (after.executionId !== current.executionId || after.createdAt !== current.createdAt) {
          throw new Error("workflow event execution fence changed");
        }
        if (TERMINAL_STATUSES.has(after.status)) {
          throw new WorkflowInstanceError("instance_terminal");
        }
        throw new Error("workflow event guard did not retain an event");
      });
    },

    async terminate(scope, id): Promise<void> {
      const normalizedScope = normalizeScope(scope);
      const normalizedId = inputIdentifier(id, "instance id");
      await withBackend(async () => {
        const timestamp = now();
        await settleExpired(normalizedScope, normalizedId, timestamp);
        const current = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!current) throw new WorkflowInstanceError("unknown_instance");
        // Terminate is deliberately idempotent for every retained terminal
        // state, including a retry after a lost response.
        if (TERMINAL_STATUSES.has(current.status)) return;
        const results = await options.sql.batch([
          {
            sql: `UPDATE tf_workflow_instances
                  SET status = 'terminated', output_json = NULL, error_json = NULL,
                      wake_at = NULL, pending_step_name = NULL,
                      updated_at = ?, retention_until = ?, revision = revision + 1
                  WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                    AND execution_id = ?
                    AND created_at = ?
                    AND retention_until > ?
                    AND deadline_at > ?
                    AND status NOT IN ('complete', 'errored', 'terminated')`,
            params: [
              timestamp,
              addDuration(timestamp, TERMINAL_RETENTION_MS, "terminal retention"),
              normalizedScope.tenantId,
              normalizedScope.workflowResourceUid,
              normalizedId,
              current.executionId,
              current.createdAt,
              timestamp,
              timestamp,
            ],
          },
          {
            sql: `DELETE FROM tf_workflow_events
                  WHERE execution_id = ?
                    AND EXISTS (
                      SELECT 1
                      FROM tf_workflow_instances
                      WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                        AND execution_id = ? AND created_at = ?
                        AND retention_until > ? AND status = 'terminated'
                    )`,
            params: [
              current.executionId,
              normalizedScope.tenantId,
              normalizedScope.workflowResourceUid,
              normalizedId,
              current.executionId,
              current.createdAt,
              timestamp,
            ],
          },
          {
            sql: `DELETE FROM tf_workflow_steps
                  WHERE execution_id = ? AND execution_created_at = ?
                    AND EXISTS (
                      SELECT 1 FROM tf_workflow_instances
                      WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                        AND execution_id = ? AND created_at = ?
                        AND retention_until > ? AND status = 'terminated'
                    )`,
            params: [
              current.executionId,
              current.createdAt,
              normalizedScope.tenantId,
              normalizedScope.workflowResourceUid,
              normalizedId,
              current.executionId,
              current.createdAt,
              timestamp,
            ],
          },
        ]);
        if (results.length !== 3) throw new Error("workflow terminate batch was truncated");
        const after = await visibleInstance(normalizedScope, normalizedId, timestamp);
        if (!after) throw new WorkflowInstanceError("unknown_instance");
        if (after.executionId !== current.executionId || after.createdAt !== current.createdAt) {
          throw new Error("workflow terminate execution fence changed");
        }
        if (TERMINAL_STATUSES.has(after.status)) return;
        throw new Error("workflow terminate guard did not terminalize an instance");
      });
    },

    async sweepExpired(input = {}): Promise<number> {
      const { scope, limit } = normalizeSweep(input);
      return await withBackend(async () => {
        const timestamp = now();
        const scopeClause = scope ? " AND tenant_id = ? AND workflow_resource_uid = ?" : "";
        const queryParams = scope
          ? [timestamp, scope.tenantId, scope.workflowResourceUid, limit]
          : [timestamp, limit];
        const rows = await options.sql.query(
          `SELECT execution_id
           FROM tf_workflow_instances
           WHERE retention_until <= ?${scopeClause}
           ORDER BY retention_until ASC, tenant_id ASC, workflow_resource_uid ASC, instance_id ASC
           LIMIT ?`,
          queryParams,
        );
        const executionIds = rows.map((row) => {
          const value = rowValue(row, "execution_id");
          if (typeof value !== "string") throw new Error("workflow sweep returned an invalid id");
          return value;
        });
        if (executionIds.length === 0) return 0;
        const placeholders = executionIds.map(() => "?").join(", ");
        const deleteInstanceParams = [...executionIds, timestamp];
        const results = await options.sql.batch([
          {
            sql: `DELETE FROM tf_workflow_steps
                  WHERE EXISTS (
                    SELECT 1 FROM tf_workflow_instances AS instance
                    WHERE instance.execution_id = tf_workflow_steps.execution_id
                      AND instance.created_at = tf_workflow_steps.execution_created_at
                      AND instance.execution_id IN (${placeholders})
                      AND instance.retention_until <= ?
                  )`,
            params: deleteInstanceParams,
          },
          {
            sql: `DELETE FROM tf_workflow_events
                  WHERE execution_id IN (
                      SELECT execution_id
                      FROM tf_workflow_instances
                      WHERE execution_id IN (${placeholders})
                        AND retention_until <= ?
                    )`,
            params: deleteInstanceParams,
          },
          {
            sql: `DELETE FROM tf_workflow_instances
                  WHERE execution_id IN (${placeholders}) AND retention_until <= ?`,
            params: deleteInstanceParams,
          },
        ]);
        if (results.length !== 3) throw new Error("workflow sweep batch was truncated");
        return results[2]?.changes ?? 0;
      });
    },
  };

  async function sendV3Event(
    scope: WorkflowScope,
    instanceId: string,
    current: StoredWorkflowInstance,
    event: PreparedWorkflowEvent,
    timestamp: number,
  ): Promise<void> {
    let attempt = current;
    for (let retry = 0; retry < 8; retry += 1) {
      if (TERMINAL_STATUSES.has(attempt.status)) {
        throw new WorkflowInstanceError("instance_terminal");
      }
      const directWait =
        attempt.status === "waiting"
          ? await readPendingWait(scope, instanceId, attempt, event.type, timestamp)
          : null;
      const statements = directWait
        ? [
            {
              sql: `UPDATE tf_workflow_steps
                  SET state = 'complete', result_json = ?, error_json = NULL,
                      wake_at = NULL, updated_at = ?, revision = revision + 1
                  WHERE execution_id = ? AND execution_created_at = ? AND name = ?
                    AND kind = 'wait' AND state = 'waiting' AND wait_type = ?
                    AND timeout_at = ? AND revision = ?
                    AND EXISTS (
                      SELECT 1 FROM tf_workflow_instances AS instance
                      WHERE instance.tenant_id = ? AND instance.workflow_resource_uid = ?
                        AND instance.instance_id = ? AND instance.execution_id = ?
                        AND instance.created_at = ? AND instance.revision = ?
                        AND instance.status = 'waiting' AND instance.pending_step_name = ?
                        AND instance.run_owner IS NULL AND instance.run_lease_until IS NULL
                        AND instance.termination_requested = 0
                        AND instance.deadline_at > ? AND instance.retention_until > ?
                        AND ${liveSelected}
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM tf_workflow_events AS event
                      WHERE event.tenant_id = ? AND event.workflow_resource_uid = ?
                        AND event.instance_id = ? AND event.execution_id = ?
                        AND event.type = ? AND event.created_at <= ?
                    )`,
              params: [
                event.payloadJson,
                timestamp,
                attempt.executionId,
                attempt.createdAt,
                directWait.name,
                event.type,
                directWait.timeoutAt,
                directWait.revision,
                scope.tenantId,
                scope.workflowResourceUid,
                instanceId,
                attempt.executionId,
                attempt.createdAt,
                attempt.revision,
                directWait.name,
                timestamp,
                timestamp,
                scope.tenantId,
                scope.workflowResourceUid,
                instanceId,
                attempt.executionId,
                event.type,
                directWait.timeoutAt,
              ],
            },
            {
              sql: `UPDATE tf_workflow_instances
                  SET wake_at = ?, updated_at = ?, revision = revision + 1
                  WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
                    AND execution_id = ? AND created_at = ? AND revision = ?
                    AND status = 'waiting' AND pending_step_name = ?
                    AND run_owner IS NULL AND run_lease_until IS NULL
                    AND termination_requested = 0
                    AND deadline_at > ? AND retention_until > ?
                    AND ${liveInstance}
                    AND EXISTS (
                      SELECT 1 FROM tf_workflow_steps AS step
                      WHERE step.execution_id = tf_workflow_instances.execution_id
                        AND step.execution_created_at = tf_workflow_instances.created_at
                        AND step.name = ? AND step.kind = 'wait' AND step.state = 'complete'
                        AND step.wait_type = ? AND step.timeout_at = ?
                        AND step.revision = ? AND step.updated_at = ?
                        AND step.result_json IS ?
                    )`,
              params: [
                timestamp,
                timestamp,
                scope.tenantId,
                scope.workflowResourceUid,
                instanceId,
                attempt.executionId,
                attempt.createdAt,
                attempt.revision,
                directWait.name,
                timestamp,
                timestamp,
                directWait.name,
                event.type,
                directWait.timeoutAt,
                directWait.revision + 1,
                timestamp,
                event.payloadJson,
              ],
            },
            queueInsertStatement(scope, instanceId, attempt, event, timestamp),
          ]
        : [queueInsertStatement(scope, instanceId, attempt, event, timestamp)];
      const results = await options.sql.batch(statements);
      if (results.length !== statements.length) {
        throw new Error("workflow v3 event admission batch was truncated");
      }
      if (directWait !== null) {
        const stepChanged = results[0]?.changes === 1;
        const instanceChanged = results[1]?.changes === 1;
        if (stepChanged !== instanceChanged) {
          throw new Error("workflow v3 direct delivery lost its instance fence");
        }
        if (stepChanged) return;
      }
      const insertResult = results[directWait === null ? 0 : 2];
      if (insertResult?.changes === 1) return;

      const after = await visibleInstance(scope, instanceId, timestamp);
      if (!after) throw new WorkflowInstanceError("unknown_instance");
      if (after.executionId !== attempt.executionId || after.createdAt !== attempt.createdAt) {
        throw new Error("workflow event execution fence changed");
      }
      if (TERMINAL_STATUSES.has(after.status)) {
        throw new WorkflowInstanceError("instance_terminal");
      }
      if (after.revision === attempt.revision) {
        if (!(await selectedResourceLive(scope))) {
          throw new WorkflowInstanceError("unknown_instance");
        }
        const termination = await options.sql.query(
          `SELECT termination_requested FROM tf_workflow_instances
           WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
             AND execution_id = ? AND created_at = ? AND revision = ?`,
          [
            scope.tenantId,
            scope.workflowResourceUid,
            instanceId,
            attempt.executionId,
            attempt.createdAt,
            attempt.revision,
          ],
        );
        if (rowValue(termination[0] ?? {}, "termination_requested") === 1) {
          throw new WorkflowInstanceError("instance_terminal");
        }
        throw new WorkflowInstanceError("event_queue_full");
      }
      attempt = after;
    }
    throw new Error("workflow event admission lost repeated state races");
  }

  async function readPendingWait(
    scope: WorkflowScope,
    instanceId: string,
    current: StoredWorkflowInstance,
    eventType: string,
    timestamp: number,
  ): Promise<PendingWorkflowWait | null> {
    const rows = await options.sql.query(
      `SELECT step.name, step.wait_type, step.timeout_at, step.revision
       FROM tf_workflow_steps AS step
       JOIN tf_workflow_instances AS instance
         ON instance.execution_id = step.execution_id
        AND instance.created_at = step.execution_created_at
       WHERE instance.tenant_id = ? AND instance.workflow_resource_uid = ?
         AND instance.instance_id = ? AND instance.execution_id = ? AND instance.created_at = ?
         AND instance.revision = ? AND instance.status = 'waiting'
         AND instance.pending_step_name = step.name
         AND instance.run_owner IS NULL AND instance.run_lease_until IS NULL
         AND instance.termination_requested = 0
         AND instance.deadline_at > ? AND instance.retention_until > ?
         AND step.kind = 'wait' AND step.state = 'waiting' AND step.wait_type = ?
       LIMIT 2`,
      [
        scope.tenantId,
        scope.workflowResourceUid,
        instanceId,
        current.executionId,
        current.createdAt,
        current.revision,
        timestamp,
        timestamp,
        eventType,
      ],
    );
    if (rows.length > 1) throw new Error("workflow pending wait is ambiguous");
    const row = rows[0];
    if (!row) return null;
    const name = rowValue(row, "name");
    const waitType = rowValue(row, "wait_type");
    const timeoutAt = rowValue(row, "timeout_at");
    const revision = rowValue(row, "revision");
    if (
      typeof name !== "string" ||
      typeof waitType !== "string" ||
      !Number.isSafeInteger(timeoutAt) ||
      (timeoutAt as number) < timestamp ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1
    ) {
      return null;
    }
    return {
      name,
      timeoutAt: timeoutAt as number,
      revision: revision as number,
    };
  }

  function queueInsertStatement(
    scope: WorkflowScope,
    instanceId: string,
    current: StoredWorkflowInstance,
    event: PreparedWorkflowEvent,
    timestamp: number,
  ) {
    return {
      sql: `INSERT INTO tf_workflow_events
              (tenant_id, workflow_resource_uid, instance_id, execution_id,
               type, payload_json, created_at)
            SELECT instance.tenant_id, instance.workflow_resource_uid,
                   instance.instance_id, instance.execution_id, ?, ?, ?
            FROM tf_workflow_instances AS instance
            WHERE instance.tenant_id = ? AND instance.workflow_resource_uid = ?
              AND instance.instance_id = ? AND instance.execution_id = ?
              AND instance.created_at = ? AND instance.revision = ?
              AND instance.retention_until > ? AND instance.deadline_at > ?
              AND instance.status IN ('queued', 'running', 'sleeping', 'waiting')
              AND instance.termination_requested = 0
              AND ${liveSelected}
              AND (SELECT count(*) FROM tf_workflow_events AS existing
                   WHERE existing.tenant_id = instance.tenant_id
                     AND existing.workflow_resource_uid = instance.workflow_resource_uid
                     AND existing.instance_id = instance.instance_id
                     AND existing.execution_id = instance.execution_id) < ?
              AND (SELECT coalesce(sum(
                     CASE WHEN existing.payload_json IS NULL
                       THEN 9 + length(CAST(json_quote(existing.type) AS BLOB))
                       ELSE 20 + length(CAST(existing.payload_json AS BLOB))
                         + length(CAST(json_quote(existing.type) AS BLOB))
                     END
                   ), 0)
                   FROM tf_workflow_events AS existing
                   WHERE existing.tenant_id = instance.tenant_id
                     AND existing.workflow_resource_uid = instance.workflow_resource_uid
                     AND existing.instance_id = instance.instance_id
                     AND existing.execution_id = instance.execution_id) + ? <= ?`,
      params: [
        event.type,
        event.payloadJson,
        timestamp,
        scope.tenantId,
        scope.workflowResourceUid,
        instanceId,
        current.executionId,
        current.createdAt,
        current.revision,
        timestamp,
        timestamp,
        WORKFLOW_MAX_PENDING_EVENT_COUNT,
        event.documentBytes,
        WORKFLOW_MAX_PENDING_EVENT_BYTES,
      ],
    };
  }

  async function settleExpired(
    scope: WorkflowScope,
    instanceId: string,
    timestamp: number,
  ): Promise<void> {
    const results = await options.sql.batch([
      {
        sql: `DELETE FROM tf_workflow_steps
              WHERE EXISTS (
                SELECT 1 FROM tf_workflow_instances AS instance
                WHERE instance.execution_id = tf_workflow_steps.execution_id
                  AND instance.created_at = tf_workflow_steps.execution_created_at
                  AND instance.tenant_id = ? AND instance.workflow_resource_uid = ?
                  AND instance.instance_id = ?
                  AND instance.deadline_at <= ? AND instance.retention_until > ?
                  AND instance.status IN (${NON_TERMINAL_SQL})
              )`,
        params: [scope.tenantId, scope.workflowResourceUid, instanceId, timestamp, timestamp],
      },
      {
        sql: `DELETE FROM tf_workflow_events
              WHERE execution_id IN (
                SELECT execution_id
                FROM tf_workflow_instances
                WHERE tenant_id = ? AND workflow_resource_uid = ?
                  AND instance_id = ?
                  AND deadline_at <= ? AND retention_until > ?
                  AND status IN (${NON_TERMINAL_SQL})
              )`,
        params: [scope.tenantId, scope.workflowResourceUid, instanceId, timestamp, timestamp],
      },
      {
        sql: `UPDATE tf_workflow_instances
              SET status = 'errored', output_json = NULL, error_json = ?,
                  wake_at = NULL, pending_step_name = NULL,
                  updated_at = deadline_at, revision = revision + 1
              WHERE tenant_id = ? AND workflow_resource_uid = ?
                AND instance_id = ?
                AND deadline_at <= ? AND retention_until > ?
                AND status IN (${NON_TERMINAL_SQL})`,
        params: [
          LIFETIME_ERROR_JSON,
          scope.tenantId,
          scope.workflowResourceUid,
          instanceId,
          timestamp,
          timestamp,
        ],
      },
    ]);
    if (results.length !== 3) throw new Error("workflow lifetime batch was truncated");
  }

  async function visibleInstance(
    scope: WorkflowScope,
    instanceId: string,
    timestamp: number,
  ): Promise<StoredWorkflowInstance | null> {
    const rows = await options.sql.query(
      `SELECT execution_id, status, output_json, error_json, created_at, revision
       FROM tf_workflow_instances
       WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?
         AND retention_until > ?
       LIMIT 2`,
      [scope.tenantId, scope.workflowResourceUid, instanceId, timestamp],
    );
    if (rows.length > 1) throw new Error("workflow instance identity is ambiguous");
    const row = rows[0];
    return row === undefined ? null : parseStoredInstance(row);
  }
}

interface StoredWorkflowInstance {
  readonly executionId: string;
  readonly createdAt: number;
  readonly status: WorkflowInstanceStatus;
  readonly outputJson: string | null;
  readonly errorJson: string | null;
  readonly revision: number;
}

interface PendingWorkflowWait {
  readonly name: string;
  readonly timeoutAt: number;
  readonly revision: number;
}

interface PreparedWorkflowEvent {
  readonly type: string;
  readonly payloadJson: string | null;
  readonly documentBytes: number;
}

function prepareCreateInput(value: unknown): {
  readonly id?: string;
  readonly paramsJson: string | null;
} {
  let record: Record<string, unknown>;
  try {
    record = plainInputRecord(value, "create input");
  } catch {
    throw new WorkflowInstanceError("invalid_params");
  }
  for (const key of Object.keys(record)) {
    if (key !== "id" && key !== "params") {
      throw new WorkflowInstanceError("invalid_params");
    }
  }
  let id: string | undefined;
  if (Object.hasOwn(record, "id")) {
    if (record.id === undefined) throw new WorkflowInstanceError("invalid_params");
    try {
      id = inputIdentifier(record.id, "instance id");
    } catch {
      throw new WorkflowInstanceError("invalid_params");
    }
  }
  let paramsJson: string | null = null;
  if (Object.hasOwn(record, "params")) {
    if (record.params === undefined) throw new WorkflowInstanceError("invalid_params");
    try {
      paramsJson = encodeDocument(record.params);
    } catch (error) {
      if (error instanceof DocumentValidationError && error.kind === "too_large") {
        throw new WorkflowInstanceError("document_too_large");
      }
      throw new WorkflowInstanceError("invalid_params");
    }
  }
  return { ...(id === undefined ? {} : { id }), paramsJson };
}

function prepareEventInput(value: unknown): PreparedWorkflowEvent {
  const record = plainInputRecord(value, "workflow event input");
  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "payload") {
      throw new WorkflowInputError("workflow event input contains an unknown property");
    }
  }
  if (!Object.hasOwn(record, "type")) {
    throw new WorkflowInputError("workflow event type is required");
  }
  const type = inputIdentifier(record.type, "event type");
  let payloadJson: string | null = null;
  if (Object.hasOwn(record, "payload")) {
    if (record.payload === undefined) {
      throw new WorkflowInputError("workflow event payload cannot be undefined");
    }
    try {
      payloadJson = encodeDocument(record.payload);
    } catch (error) {
      if (error instanceof DocumentValidationError && error.kind === "too_large") {
        throw new WorkflowInstanceError("document_too_large");
      }
      throw new WorkflowInputError("workflow event payload must be data-only JSON");
    }
  }
  const documentBytes =
    payloadJson === null
      ? 9 + canonicalJsonStringBytes(type)
      : 20 + utf8ByteLength(payloadJson) + canonicalJsonStringBytes(type);
  return { type, payloadJson, documentBytes };
}

function canonicalJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // inputIdentifier has already rejected unpaired surrogates.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function normalizeSweep(input: WorkflowSweepOptions): {
  readonly scope?: WorkflowScope;
  readonly limit: number;
} {
  const record = plainInputRecord(input, "workflow sweep input");
  for (const key of Object.keys(record)) {
    if (key !== "scope" && key !== "limit") {
      throw new WorkflowInputError("workflow sweep input contains an unknown property");
    }
  }
  let scope: WorkflowScope | undefined;
  if (Object.hasOwn(record, "scope")) {
    if (record.scope === undefined) {
      throw new WorkflowInputError("workflow sweep scope cannot be undefined");
    }
    scope = normalizeScope(record.scope);
  }
  const limit = Object.hasOwn(record, "limit") ? record.limit : MAX_SWEEP_ROWS;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SWEEP_ROWS
  ) {
    throw new WorkflowInputError(
      `workflow sweep limit must be an integer between 1 and ${MAX_SWEEP_ROWS}`,
    );
  }
  return scope === undefined ? { limit } : { scope, limit };
}

function materializeStatus(instance: StoredWorkflowInstance): WorkflowInstanceStatusResult {
  if (instance.status === "complete") {
    const output = instance.outputJson === null ? undefined : parseDocument(instance.outputJson);
    return output === undefined ? { status: instance.status } : { status: instance.status, output };
  }
  if (instance.status === "errored") {
    const error = instance.errorJson === null ? undefined : parseError(instance.errorJson);
    return error === undefined ? { status: instance.status } : { status: instance.status, error };
  }
  return { status: instance.status };
}

function parseStoredInstance(row: Row): StoredWorkflowInstance {
  const executionId = rowValue(row, "execution_id");
  if (typeof executionId !== "string") throw new Error("workflow instance execution id is invalid");
  const createdAt = rowValue(row, "created_at");
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) {
    throw new Error("workflow instance created timestamp is invalid");
  }
  const rawStatus = rowValue(row, "status");
  if (typeof rawStatus !== "string" || !STATUS_VALUES.has(rawStatus as WorkflowInstanceStatus)) {
    throw new Error("workflow instance status is invalid");
  }
  const outputJson = nullableString(row, "output_json");
  const errorJson = nullableString(row, "error_json");
  const revision = rowValue(row, "revision");
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error("workflow instance revision is invalid");
  }
  return {
    executionId,
    createdAt: createdAt as number,
    status: rawStatus as WorkflowInstanceStatus,
    outputJson,
    errorJson,
    revision: revision as number,
  };
}

function parseError(value: string): WorkflowInstanceStatusError {
  const parsed = parseDocument(value);
  const keys = Object.keys(parsed).sort();
  if (
    keys.some((key) => key !== "reason" && key !== "message") ||
    typeof parsed.reason !== "string" ||
    !ERROR_REASONS.has(parsed.reason as WorkflowErrorReason)
  ) {
    throw new Error("workflow error record is invalid");
  }
  if (parsed.message !== undefined) {
    if (
      typeof parsed.message !== "string" ||
      !isUnicodeScalarString(parsed.message) ||
      [...parsed.message].length > 8_192
    ) {
      throw new Error("workflow error message is invalid");
    }
  }
  return {
    reason: parsed.reason as WorkflowErrorReason,
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  };
}

async function withBackend<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkflowInstanceError || error instanceof WorkflowInputError) {
      throw error;
    }
    throw new WorkflowInstanceError("backend_unavailable");
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof SqlError && error.code === "constraint";
}
