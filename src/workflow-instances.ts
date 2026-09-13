import { type Clock, type JsonObject, type Row, type Sql, SqlError } from "./ports.ts";

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
  | "lifetime_exceeded";

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

/** Largest data-only document accepted by params and event payloads. */
export const WORKFLOW_MAX_DOCUMENT_BYTES = 1_048_576;

/** Maximum number of top-level object properties in a data-only document. */
export const WORKFLOW_MAX_TOP_PROPERTIES = 1_024;

/** Bounds are kept in seconds in the published contract; storage uses ms. */
export const WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS = 31_536_000;
export const WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS = 2_592_000;

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
]);

const INSTANCE_LIFETIME_MS = WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000;
const TERMINAL_RETENTION_MS = WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000;
const LIFETIME_ERROR_JSON = '{"reason":"lifetime_exceeded"}';

/**
 * Durable state for one workflow class.  This module deliberately does not
 * inspect a Worker Deployment or execute a class; that capability check is a
 * caller-owned boundary.  It only owns instance identity, status, events and
 * the two finite lifetime bounds.
 */
export function createWorkflowInstances(options: WorkflowInstancesOptions): WorkflowInstances {
  if (typeof options.clock !== "function") {
    throw new TypeError("a workflow instance clock is required");
  }
  if (typeof options.randomId !== "function") {
    throw new TypeError("a workflow instance randomId function is required");
  }

  const randomId = options.randomId;
  const now = (): number => {
    const timestamp = options.clock().getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("the workflow instance clock returned an invalid instant");
    }
    return timestamp;
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
                      )`,
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
          if (results.length !== 3) throw new Error("workflow create batch was truncated");
          if (results[2]?.changes === 1) {
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
        const inserted = await options.sql.run(
          `INSERT INTO tf_workflow_events
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
          [
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
        );
        if (inserted.changes === 1) return;

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
        ]);
        if (results.length !== 2) throw new Error("workflow terminate batch was truncated");
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
        if (results.length !== 2) throw new Error("workflow sweep batch was truncated");
        return results[1]?.changes ?? 0;
      });
    },
  };

  async function settleExpired(
    scope: WorkflowScope,
    instanceId: string,
    timestamp: number,
  ): Promise<void> {
    const results = await options.sql.batch([
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
    if (results.length !== 2) throw new Error("workflow lifetime batch was truncated");
  }

  async function visibleInstance(
    scope: WorkflowScope,
    instanceId: string,
    timestamp: number,
  ): Promise<StoredWorkflowInstance | null> {
    const rows = await options.sql.query(
      `SELECT execution_id, status, output_json, error_json, created_at
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
}

function normalizeScope(value: unknown): WorkflowScope {
  const record = plainInputRecord(value, "workflow scope");
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "tenantId" || keys[1] !== "workflowResourceUid") {
    throw new WorkflowInputError("workflow scope must contain tenantId and workflowResourceUid");
  }
  return {
    tenantId: scopeIdentifier(record.tenantId, "tenant id"),
    workflowResourceUid: scopeIdentifier(record.workflowResourceUid, "workflow resource uid"),
  };
}

function scopeIdentifier(value: unknown, label: string): string {
  return inputIdentifier(value, label, 4_096);
}

function inputIdentifier(value: unknown, label: string, maxCharacters = 256): string {
  if (typeof value !== "string" || !isUnicodeScalarString(value)) {
    throw new WorkflowInputError(`${label} must be a Unicode string`);
  }
  const length = [...value].length;
  if (length < 1 || length > maxCharacters) {
    throw new WorkflowInputError(`${label} must contain 1-${maxCharacters} Unicode characters`);
  }
  return value;
}

function generatedIdentifier(value: unknown, label: string): string {
  try {
    return inputIdentifier(value, label, 256);
  } catch {
    // A malformed injected id is a host/storage failure, not caller input.
    throw new Error(`the workflow ${label} generator returned an invalid id`);
  }
}

function addDuration(timestamp: number, duration: number, label: string): number {
  const result = timestamp + duration;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`the workflow ${label} exceeds the safe timestamp range`);
  }
  return result;
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

function prepareEventInput(value: unknown): {
  readonly type: string;
  readonly payloadJson: string | null;
} {
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
  return { type, payloadJson };
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
  return {
    executionId,
    createdAt: createdAt as number,
    status: rawStatus as WorkflowInstanceStatus,
    outputJson,
    errorJson,
  };
}

function parseDocument(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("workflow document is not valid JSON");
  }
  try {
    encodeDocument(parsed);
  } catch {
    throw new Error("workflow document is not data-only JSON");
  }
  if (!isPlainObjectValue(parsed)) throw new Error("workflow document is not an object");
  return parsed as JsonObject;
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

function rowValue(row: Row, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor && descriptor.get === undefined
    ? descriptor.value
    : undefined;
}

function nullableString(row: Row, key: string): string | null {
  const value = rowValue(row, key);
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`workflow row ${key} is invalid`);
  return value;
}

function plainInputRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowInputError(`${label} must be a plain object`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowInputError(`${label} must be a plain object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new WorkflowInputError(`${label} has a symbol property`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new WorkflowInputError(`${label} contains an accessor or hidden property`);
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch (error) {
    if (error instanceof WorkflowInputError) throw error;
    throw new WorkflowInputError(`${label} could not be inspected`);
  }
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

type DocumentValidationKind = "invalid" | "too_large";

class DocumentValidationError extends Error {
  constructor(readonly kind: DocumentValidationKind) {
    super(kind);
  }
}

/**
 * Encodes data without ever calling a user `toJSON` method or reading a user
 * getter.  An explicit stack keeps nesting independent from the JavaScript
 * call stack, while chunks are counted against the UTF-8 bound before they are
 * retained.  The final join therefore never needs to build an over-limit
 * document.
 */
function encodeDocument(value: unknown): string {
  if (!isPlainDataObject(value)) throw new DocumentValidationError("invalid");
  const keys = ownDataKeys(value);
  if (keys.length > WORKFLOW_MAX_TOP_PROPERTIES) {
    throw new DocumentValidationError("invalid");
  }
  const chunks: string[] = [];
  let encodedBytes = 0;
  const encoder = new TextEncoder();
  const append: DocumentChunkAppender = (chunk) => {
    if (chunk.length === 0) return;
    const remaining = WORKFLOW_MAX_DOCUMENT_BYTES - encodedBytes;
    // UTF-16 code-unit length is a safe lower bound for a JSON string chunk;
    // this avoids allocating a huge scalar before the byte guard can reject it.
    if (chunk.length > remaining) throw new DocumentValidationError("too_large");
    const bytes = encoder.encode(chunk).byteLength;
    if (bytes > remaining) throw new DocumentValidationError("too_large");
    encodedBytes += bytes;
    chunks.push(chunk);
  };
  try {
    encodeNode(value, new Set<object>(), append);
  } catch (error) {
    if (error instanceof DocumentValidationError) throw error;
    throw new DocumentValidationError("invalid");
  }
  return chunks.join("");
}

type DocumentChunkAppender = (chunk: string) => void;

type DocumentEncodingTask =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "array";
      readonly value: readonly unknown[];
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly kind: "object";
      readonly value: Record<string, unknown>;
      readonly keys: readonly string[];
      readonly index: number;
    }
  | { readonly kind: "leave"; readonly value: object };

function encodeNode(value: unknown, seen: Set<object>, append: DocumentChunkAppender): void {
  const stack: DocumentEncodingTask[] = [{ kind: "value", value }];
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) continue;
    if (task.kind === "leave") {
      seen.delete(task.value);
      continue;
    }
    if (task.kind === "array") {
      if (task.index >= task.length) {
        append("]");
        continue;
      }
      if (task.index > 0) append(",");
      const descriptor = Object.getOwnPropertyDescriptor(task.value, String(task.index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new DocumentValidationError("invalid");
      }
      stack.push({
        kind: "array",
        value: task.value,
        index: task.index + 1,
        length: task.length,
      });
      stack.push({ kind: "value", value: descriptor.value });
      continue;
    }
    if (task.kind === "object") {
      if (task.index >= task.keys.length) {
        append("}");
        continue;
      }
      if (task.index > 0) append(",");
      const key = task.keys[task.index];
      if (key === undefined) throw new DocumentValidationError("invalid");
      const descriptor = Object.getOwnPropertyDescriptor(task.value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new DocumentValidationError("invalid");
      }
      appendJsonString(key, append);
      append(":");
      stack.push({
        kind: "object",
        value: task.value,
        keys: task.keys,
        index: task.index + 1,
      });
      stack.push({ kind: "value", value: descriptor.value });
      continue;
    }

    const current = task.value;
    if (current === null) {
      append("null");
      continue;
    }
    switch (typeof current) {
      case "string":
        appendJsonString(current, append);
        continue;
      case "boolean":
        append(current ? "true" : "false");
        continue;
      case "number": {
        if (!Number.isFinite(current)) throw new DocumentValidationError("invalid");
        const encoded = JSON.stringify(current);
        if (encoded === undefined) throw new DocumentValidationError("invalid");
        append(encoded);
        continue;
      }
      case "object":
        break;
      default:
        // In particular, undefined, bigint, symbol and functions are refused;
        // JSON.stringify's silent omission/coercion is not a data contract.
        throw new DocumentValidationError("invalid");
    }
    if (typeof current !== "object") throw new DocumentValidationError("invalid");
    if (seen.has(current)) throw new DocumentValidationError("invalid");
    seen.add(current);
    if (Array.isArray(current)) {
      if (!isPlainDataArray(current)) throw new DocumentValidationError("invalid");
      append("[");
      stack.push({ kind: "leave", value: current });
      stack.push({ kind: "array", value: current, index: 0, length: arrayLength(current) });
      continue;
    }
    if (!isPlainDataObject(current)) throw new DocumentValidationError("invalid");
    append("{");
    stack.push({ kind: "leave", value: current });
    stack.push({
      kind: "object",
      value: current,
      keys: ownDataKeys(current).sort(),
      index: 0,
    });
  }
}

function appendJsonString(value: string, append: DocumentChunkAppender): void {
  if (!isUnicodeScalarString(value)) throw new DocumentValidationError("invalid");
  append('"');
  let literalStart = 0;
  let escapedRun = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    switch (code) {
      case 0x08:
        escaped = "\\b";
        break;
      case 0x09:
        escaped = "\\t";
        break;
      case 0x0a:
        escaped = "\\n";
        break;
      case 0x0c:
        escaped = "\\f";
        break;
      case 0x0d:
        escaped = "\\r";
        break;
      case 0x22:
        escaped = '\\"';
        break;
      case 0x5c:
        escaped = "\\\\";
        break;
      default:
        if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (escaped === undefined) {
      if (escapedRun.length > 0) {
        append(escapedRun);
        escapedRun = "";
      }
      continue;
    }
    if (index > literalStart) {
      if (escapedRun.length > 0) {
        append(escapedRun);
        escapedRun = "";
      }
      append(value.slice(literalStart, index));
    }
    escapedRun += escaped;
    if (escapedRun.length >= 4_096) {
      append(escapedRun);
      escapedRun = "";
    }
    literalStart = index + 1;
  }
  if (escapedRun.length > 0) append(escapedRun);
  if (literalStart < value.length) append(value.slice(literalStart));
  append('"');
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObjectValue(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPlainDataArray(value: readonly unknown[]): value is readonly unknown[] {
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length = arrayLength(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) return false;
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= length) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function arrayLength(value: readonly unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new DocumentValidationError("invalid");
  }
  return length as number;
}

function ownDataKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") throw new DocumentValidationError("invalid");
    result.push(key);
  }
  return result;
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return false;
    const trailing = value.charCodeAt(index + 1);
    if (!Number.isInteger(trailing) || trailing < 0xdc00 || trailing > 0xdfff) return false;
    index += 1;
  }
  return true;
}

class WorkflowInputError extends TypeError {}

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
