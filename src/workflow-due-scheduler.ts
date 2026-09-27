import type { Clock, Row, Sql } from "./ports.ts";
import {
  type WorkflowRunOutcome,
  type WorkflowRuntime,
  WorkflowRuntimeError,
} from "./workflow-execution.ts";
import type { WorkflowScope } from "./workflow-instances.ts";

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
}

export interface WorkflowDuePollResult {
  readonly selected: number;
  readonly outcomes: readonly WorkflowRunOutcome[];
}

export interface WorkflowDueScheduler {
  pollDue(): Promise<WorkflowDuePollResult>;
}

type Candidate = { readonly scope: WorkflowScope; readonly id: string };
type Cursor = readonly [tenantId: string, workflowResourceUid: string, instanceId: string];

const KEY = ["tenant_id", "workflow_resource_uid", "instance_id"] as const;
const ACTIVE = "'queued', 'running', 'sleeping', 'waiting'";
const TERMINAL = "'complete', 'errored', 'terminated'";

export function createWorkflowDueScheduler(
  options: WorkflowDueSchedulerOptions,
): WorkflowDueScheduler {
  const batchSize = options.batchSize ?? 64;
  const concurrency = options.concurrency ?? Math.min(4, batchSize);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 256 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > batchSize ||
    typeof options.sql?.query !== "function" ||
    typeof options.clock !== "function" ||
    typeof options.runtime?.runOne !== "function"
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }

  let cursor: Cursor | null = null;
  let inFlight: Promise<WorkflowDuePollResult> | null = null;

  function now(): number {
    const timestamp = options.clock().getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new WorkflowRuntimeError("backend_unavailable");
    }
    return timestamp;
  }

  async function select(
    timestamp: number,
    after: Cursor | null,
    limit: number,
    wrap: boolean,
  ): Promise<readonly Candidate[]> {
    // A current-state hint only: races and replacement incarnations are
    // resolved by runOne's claim CAS. In particular, termination intent and
    // a terminal row with a residual owner cannot wait for wake_at.
    const due =
      "retention_until > ? AND (termination_requested = 1 OR " +
      `status IN (${TERMINAL}) AND run_owner IS NOT NULL OR ` +
      `status IN (${ACTIVE}) AND (deadline_at <= ? OR ` +
      "(wake_at IS NULL OR wake_at <= ?) AND " +
      "(run_owner IS NULL OR run_lease_until <= ?)))";
    const keyFilter =
      after === null ? "" : ` AND (${KEY.join(", ")}) ${wrap ? "<=" : ">"} (?, ?, ?)`;
    const rows = await options.sql.query(
      `SELECT ${KEY.join(", ")} FROM tf_workflow_instances WHERE ${due}${keyFilter} ` +
        `ORDER BY ${KEY.join(", ")} LIMIT ?`,
      [timestamp, timestamp, timestamp, timestamp, ...(after ?? []), limit],
    );
    if (rows.length > limit) throw new WorkflowRuntimeError("backend_unavailable");
    return rows.map(candidate);
  }

  async function pollOnce(): Promise<WorkflowDuePollResult> {
    const timestamp = now();
    const first = await select(timestamp, cursor, batchSize, false);
    const selected =
      cursor !== null && first.length < batchSize
        ? [...first, ...(await select(timestamp, cursor, batchSize - first.length, true))]
        : first;
    if (selected.length === 0) return { selected: 0, outcomes: [] };
    const last = selected[selected.length - 1];
    if (last === undefined) throw new WorkflowRuntimeError("backend_unavailable");
    cursor = [last.scope.tenantId, last.scope.workflowResourceUid, last.id];

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
              value: await options.runtime.runOne(row.scope, row.id),
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

function candidate(row: Row): Candidate {
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
  return { scope: { tenantId, workflowResourceUid }, id };
}
