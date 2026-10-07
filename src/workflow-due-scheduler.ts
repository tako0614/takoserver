import type { Clock, Row, Sql } from "./ports.ts";
import {
  type WorkflowRunOutcome,
  type WorkflowRuntime,
  WorkflowRuntimeError,
} from "./workflow-execution.ts";
import type { WorkflowScope } from "./workflow-instances.ts";
import { v2WorkflowLiveSql } from "./workflow-v2-resource-authority.ts";

/**
 * Private, one-shot SQL caller. It does not claim rows, select an executable
 * target, start a timer, or expose a consumer Workflow surface. `runOne` owns
 * every current-state check and all execution/termination fencing.
 */
export interface WorkflowDueSchedulerOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly runtime: Pick<WorkflowRuntime, "runOne">;
  readonly batchSize?: number;
  readonly concurrency?: number;
  /** Maximum primary-key rows fetched by one poll, including rows not due. */
  readonly scanLimit?: number;
  /** Host-selected v2 target; absent retains the legacy private scheduler contract. */
  readonly acceptedV2TargetKey?: string;
}

export interface WorkflowDuePollResult {
  /** Rows actually checked for due status; SQL may prefetch more, up to scanLimit. */
  readonly examined: number;
  readonly selected: number;
  readonly outcomes: readonly WorkflowRunOutcome[];
}

export interface WorkflowDueScheduler {
  pollDue(): Promise<WorkflowDuePollResult>;
}

type Candidate = { readonly scope: WorkflowScope; readonly id: string };
type Cursor = readonly [tenantId: string, workflowResourceUid: string, instanceId: string];
type ScannedRow = { readonly candidate: Candidate; readonly cursor: Cursor; readonly due: boolean };

const KEY = ["tenant_id", "workflow_resource_uid", "instance_id"] as const;
const ACTIVE = new Set(["queued", "running", "sleeping", "waiting"]);
const TERMINAL = new Set(["complete", "errored", "terminated"]);

export function createWorkflowDueScheduler(
  options: WorkflowDueSchedulerOptions,
): WorkflowDueScheduler {
  const batchSize = options.batchSize ?? 64;
  const concurrency = options.concurrency ?? Math.min(4, batchSize);
  const scanLimit = options.scanLimit ?? Math.max(256, batchSize);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 256 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > batchSize ||
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < batchSize ||
    scanLimit > 1_024 ||
    typeof options.sql?.query !== "function" ||
    typeof options.clock !== "function" ||
    typeof options.runtime?.runOne !== "function" ||
    (options.acceptedV2TargetKey !== undefined &&
      (typeof options.acceptedV2TargetKey !== "string" ||
        options.acceptedV2TargetKey.length === 0 ||
        options.acceptedV2TargetKey.length > 256))
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  // Snapshot trusted composition ports and target before the first awaited
  // scan; a mutable caller object cannot retarget an in-flight poll.
  const { sql, clock, runtime, acceptedV2TargetKey } = options;

  // Process-local round robin. Repeated polls eventually cross a sparse table;
  // one poll does not promise to find every due row, and a restart begins at
  // the first key again. No durable scheduling cursor or daemon is introduced.
  let cursor: Cursor | null = null;
  let inFlight: Promise<WorkflowDuePollResult> | null = null;

  function now(): number {
    const timestamp = clock().getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new WorkflowRuntimeError("backend_unavailable");
    }
    return timestamp;
  }

  async function scan(after: Cursor | null, limit: number, wrap: boolean): Promise<readonly Row[]> {
    // No due predicate in SQL: applying it before LIMIT would still scan an
    // unbounded sparse prefix. The primary-key window is the work budget.
    if (acceptedV2TargetKey !== undefined) {
      const key = KEY.map((column) => `instance.${column}`).join(", ");
      const keyFilter = after === null ? "" : `WHERE (${key}) ${wrap ? "<=" : ">"} (?, ?, ?)`;
      // The selector is computed per row, not placed in WHERE: foreign/v1
      // rows consume the finite scan budget and advance the keyset cursor.
      // runOne repeats the accepted SQL and native fencing before any effect.
      const rows = await sql.query(
        `SELECT ${key}, instance.status, instance.deadline_at, instance.retention_until, ` +
          "instance.termination_requested, instance.run_owner, instance.run_lease_until, " +
          "instance.wake_at, " +
          `CASE WHEN ${v2WorkflowLiveSql("instance.tenant_id", "instance.workflow_resource_uid")}
            AND EXISTS (
              SELECT 1 FROM tf_v2_resources AS selected_target
              WHERE selected_target.uid = instance.workflow_resource_uid
                AND selected_target.target_key = ?
            ) THEN 1 ELSE 0 END AS accepted_v2
           FROM tf_workflow_instances AS instance ${keyFilter}
           ORDER BY ${key} LIMIT ?`,
        [acceptedV2TargetKey, ...(after ?? []), limit],
      );
      if (rows.length > limit) throw new WorkflowRuntimeError("backend_unavailable");
      return rows;
    }
    const keyFilter =
      after === null ? "" : `WHERE (${KEY.join(", ")}) ${wrap ? "<=" : ">"} (?, ?, ?)`;
    const rows = await sql.query(
      `SELECT ${KEY.join(", ")}, status, deadline_at, retention_until, ` +
        "termination_requested, run_owner, run_lease_until, wake_at " +
        `FROM tf_workflow_instances ${keyFilter} ` +
        `ORDER BY ${KEY.join(", ")} LIMIT ?`,
      [...(after ?? []), limit],
    );
    if (rows.length > limit) throw new WorkflowRuntimeError("backend_unavailable");
    return rows;
  }

  async function pollOnce(): Promise<WorkflowDuePollResult> {
    const timestamp = now();
    const start = cursor;
    const selected: Candidate[] = [];
    let examined = 0;
    let lastExamined: Cursor | null = null;
    const consume = (rows: readonly Row[]): void => {
      for (const row of rows) {
        if (selected.length === batchSize) break;
        const accepted = row.accepted_v2;
        if (acceptedV2TargetKey !== undefined && accepted !== 0 && accepted !== 1)
          throw new WorkflowRuntimeError("backend_unavailable");
        const scanned = parseScannedRow(
          row,
          timestamp,
          acceptedV2TargetKey === undefined || accepted === 1,
        );
        examined += 1;
        lastExamined = scanned.cursor;
        if (scanned.due) selected.push(scanned.candidate);
      }
    };
    const first = await scan(start, scanLimit, false);
    consume(first);
    if (start !== null && first.length < scanLimit && selected.length < batchSize) {
      consume(await scan(start, scanLimit - examined, true));
    }
    if (lastExamined !== null) cursor = lastExamined;
    if (selected.length === 0) return { examined, selected: 0, outcomes: [] };

    // Wait for every started run even when one fails. A rejected poll must not
    // leave still-running work orphaned while its caller starts another poll.
    const settled: PromiseSettledResult<WorkflowRunOutcome>[] = new Array(selected.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
        for (;;) {
          const index = next++;
          const row = selected[index];
          if (row === undefined) return;
          try {
            settled[index] = {
              status: "fulfilled",
              value: await runtime.runOne(row.scope, row.id),
            };
          } catch (reason) {
            settled[index] = { status: "rejected", reason };
          }
        }
      }),
    );
    const errors = settled.flatMap((result) =>
      result?.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, `workflow due poll failed for ${errors.length} rows`);
    }
    return {
      examined,
      selected: selected.length,
      outcomes: settled.map((result) => {
        if (result?.status !== "fulfilled") throw new WorkflowRuntimeError("backend_unavailable");
        return result.value;
      }),
    };
  }

  return {
    pollDue() {
      if (inFlight !== null) return inFlight;
      inFlight = pollOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

function parseScannedRow(row: Row, timestamp: number, eligible = true): ScannedRow {
  const tenantId = row.tenant_id;
  const workflowResourceUid = row.workflow_resource_uid;
  const id = row.instance_id;
  if (
    typeof tenantId !== "string" ||
    tenantId.length === 0 ||
    typeof workflowResourceUid !== "string" ||
    workflowResourceUid.length === 0 ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  const candidate = { scope: { tenantId, workflowResourceUid }, id };
  const cursor: Cursor = [tenantId, workflowResourceUid, id];
  if (!eligible) return { candidate, cursor, due: false };
  const status = row.status;
  const owner = row.run_owner;
  const terminationRequested = row.termination_requested;
  if (
    typeof status !== "string" ||
    (owner !== null && typeof owner !== "string") ||
    (terminationRequested !== 0 && terminationRequested !== 1)
  ) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  const deadlineAt = integer(row.deadline_at);
  const retentionUntil = integer(row.retention_until);
  const wakeAt = optionalInteger(row.wake_at);
  const leaseUntil = optionalInteger(row.run_lease_until);
  if (owner === null ? leaseUntil !== null : leaseUntil === null) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  if (!ACTIVE.has(status) && !TERMINAL.has(status)) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  const due =
    retentionUntil > timestamp &&
    (terminationRequested === 1 ||
      (TERMINAL.has(status) && owner !== null) ||
      (ACTIVE.has(status) &&
        (deadlineAt <= timestamp ||
          ((wakeAt === null || wakeAt <= timestamp) &&
            (owner === null || (leaseUntil !== null && leaseUntil <= timestamp))))));
  return {
    candidate,
    cursor,
    due,
  };
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  return value;
}

function optionalInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
