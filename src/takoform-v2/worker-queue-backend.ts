import type { JsonObject, Sql } from "../ports.ts";
import {
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  parseAtLeastOnceQueueSpec,
  validateAtLeastOnceQueueUpdate,
} from "./forms/at-least-once-queue.ts";
import type { V2BackendResult, V2Execution, V2Form } from "./types.ts";
import {
  ownsV2QueueClaim,
  snapshotV2QueueClaim,
  V2_QUEUE_CLAIM_SQL,
  v2QueueClaimParams,
  v2QueueId,
} from "./worker-queue-delivery.ts";

export const V2_QUEUE_BACKEND_ID = "selfhost-v2-at-least-once-queue-sql-v1";
const PAGE = 64;
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";
const UNKNOWN: V2BackendResult = {
  kind: "unknown",
  code: "queue_unconfirmed",
  message: "The Queue operation is not yet confirmed",
};

function emptyPrivateInputs(inputs: Readonly<Record<string, string>> | undefined): void {
  if (inputs === undefined) return;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new TypeError("AtLeastOnceQueue private inputs must be empty");
  }
  const prototype = Object.getPrototypeOf(inputs);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(inputs).length !== 0
  ) {
    throw new TypeError("AtLeastOnceQueue private inputs must be empty");
  }
}

/**
 * Self-host Queue namespace is the exact v2 Resource UID. No second namespace
 * table or blind provider create is needed; messages live under a UID-derived
 * internal id, and every destructive step is fenced by the accepted Operation.
 * This internal Form is not registered in the normal Host until producer and
 * native delivery authorization are connected.
 */
export function createAtLeastOnceQueueForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
}): V2Form {
  const { sql, targetKey } = options;
  if (!sql || typeof targetKey !== "string" || targetKey.length === 0) {
    throw new TypeError("Queue SQL and targetKey are required");
  }

  async function run(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== AT_LEAST_ONCE_QUEUE_FORM_URL ||
      execution.backendId !== V2_QUEUE_BACKEND_ID ||
      execution.targetKey !== targetKey
    )
      return UNKNOWN;
    const claim = snapshotV2QueueClaim(execution);
    const queueId = v2QueueId(execution.resourceUid);
    const spec = parseAtLeastOnceQueueSpec(execution.spec);
    if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;
    if (execution.action === "update") {
      // Current retention applies to already admitted messages, measured from
      // each original acceptance time. Work is bounded and resumable without
      // a second cursor; a row already changed to this value is not reselected.
      const write = await sql.run(
        `UPDATE selfhost_queue_messages
         SET expires_at_ms = enqueued_at_ms + ? * 1000
         WHERE rowid IN (
           SELECT rowid FROM selfhost_queue_messages
           WHERE queue_id = ? AND expires_at_ms > ${DB_NOW_MS}
             AND expires_at_ms <> enqueued_at_ms + ? * 1000
           ORDER BY message_id LIMIT ?
         ) AND ${V2_QUEUE_CLAIM_SQL}`,
        [
          spec.messageRetentionSeconds,
          queueId,
          spec.messageRetentionSeconds,
          PAGE,
          ...v2QueueClaimParams(claim),
        ],
      );
      if (write.changes > 0) return { kind: "continue" };
    } else if (execution.action === "delete") {
      const write = await sql.run(
        `DELETE FROM selfhost_queue_messages
         WHERE rowid IN (
           SELECT rowid FROM selfhost_queue_messages WHERE queue_id = ?
           ORDER BY message_id LIMIT ?
         ) AND ${V2_QUEUE_CLAIM_SQL}`,
        [queueId, PAGE, ...v2QueueClaimParams(claim)],
      );
      if (write.changes > 0) return { kind: "continue" };
    }
    if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;
    const remaining = await sql.query(
      execution.action === "delete"
        ? "SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ? LIMIT 1"
        : `SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ?
           AND expires_at_ms > ${DB_NOW_MS}
           AND expires_at_ms <> enqueued_at_ms + ? * 1000 LIMIT 1`,
      execution.action === "delete" ? [queueId] : [queueId, spec.messageRetentionSeconds],
    );
    if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;
    if (remaining.length > 0) return { kind: "continue" };
    return {
      kind: "complete",
      observed: { queueExists: execution.action !== "delete" } satisfies JsonObject,
      output: {},
    };
  }

  return {
    validateCreate(spec) {
      parseAtLeastOnceQueueSpec(spec);
    },
    validateUpdate(previous, spec) {
      validateAtLeastOnceQueueUpdate(previous, spec);
    },
    privateInputs: {
      validateCreate(_spec, inputs) {
        emptyPrivateInputs(inputs);
      },
      validateUpdate(_previous, _spec, inputs) {
        emptyPrivateInputs(inputs);
      },
    },
    backend: { id: V2_QUEUE_BACKEND_ID, targetKey, execute: run, reconcile: run },
  };
}
