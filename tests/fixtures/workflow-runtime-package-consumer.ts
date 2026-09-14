import {
  type Clock,
  createWorkflowRuntime,
  type JsonObject,
  type Row,
  type Sql,
  type WorkflowApplicationOutcome,
  type WorkflowDriver,
  type WorkflowExecutionHost,
  type WorkflowPausedSession,
  type WorkflowRunIdentity,
  type WorkflowRuntime,
} from "@takoserver/core/workflow-runtime";

const clock: Clock = () => new Date(0);

const sql: Sql = {
  async query(_statement, _params): Promise<readonly Row[]> {
    return [];
  },
  async run(_statement, _params) {
    return { rows: [], changes: 0 };
  },
  async batch(statements) {
    return statements.map(() => ({ rows: [], changes: 0 }));
  },
};

const host: WorkflowExecutionHost = {
  async openPaused(
    _identity: WorkflowRunIdentity,
    _input: JsonObject | undefined,
    _hardDeadline: number,
  ): Promise<WorkflowPausedSession> {
    return {
      async run(_driver: WorkflowDriver): Promise<WorkflowApplicationOutcome> {
        return { kind: "complete" };
      },
      async extendDeadline(_until: number): Promise<void> {
        return;
      },
    };
  },
  async stop(_identity: WorkflowRunIdentity, _reason): Promise<"stopped" | "not_registered"> {
    return "not_registered";
  },
};

/** A downstream package consumer can implement the neutral ports without internals. */
export function createPackageOnlyRuntime(): WorkflowRuntime {
  return createWorkflowRuntime({
    sql,
    clock,
    randomId: () => "a".repeat(64),
    waitUntil: async (_epochMs, _signal) => undefined,
    host,
  });
}
