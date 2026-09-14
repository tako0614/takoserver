import type { Clock, JsonObject, Row, Sql, SqlParam } from "./ports.ts";
import {
  addDuration,
  DocumentValidationError,
  encodeDocument,
  generatedIdentifier,
  inputIdentifier,
  normalizeScope,
  nullableString,
  parseDocument,
  rowValue,
} from "./workflow-data.ts";
import {
  createWorkflowInstances,
  WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS,
  type WorkflowErrorReason,
  WorkflowInstanceError,
  type WorkflowInstanceStatus,
  type WorkflowInstances,
  type WorkflowScope,
} from "./workflow-instances.ts";

/**
 * Private isolation protocol, NOT the JavaScript Binding/callee API.
 *
 * openPaused registers before resolving and evaluates no application code.
 * run and extendDeadline must refuse an already-stopped/expired context.
 * stop is linearizable against those operations: "stopped" acknowledges that
 * this exact registered context cannot execute again. "not_registered" does
 * not acknowledge an opening context. Deadlines must survive controller loss.
 *
 * No self-host or WfP adapter currently qualifies this protocol.
 */
export interface WorkflowExecutionHost {
  openPaused(
    identity: WorkflowRunIdentity,
    input: JsonObject | undefined,
    hardDeadline: number,
  ): Promise<WorkflowPausedSession>;
  stop(
    identity: WorkflowRunIdentity,
    reason: WorkflowStopReason,
  ): Promise<"stopped" | "not_registered">;
}

export interface WorkflowPausedSession {
  /** Resolve application outcomes; reject infrastructure failures. Select the current deployment here. */
  run(driver: WorkflowDriver): Promise<WorkflowApplicationOutcome>;
  /** Cannot resurrect a stopped context or one whose previous deadline elapsed. */
  extendDeadline(until: number): Promise<void>;
}

export type WorkflowApplicationOutcome =
  | { readonly kind: "complete"; readonly output?: JsonObject }
  | { readonly kind: "failed"; readonly reason: "run_threw" }
  // An isolated adapter must correlate an uncaught driver error back to the
  // original host-side object. A serialized/reconstructed Error is not proof.
  | { readonly kind: "failed"; readonly reason: "step_failed"; readonly error: WorkflowStepError };

type TerminalOutcome =
  | { readonly kind: "complete"; readonly output?: JsonObject }
  | { readonly kind: "failed"; readonly reason: WorkflowErrorReason };

export type WorkflowStopReason = "park" | "complete" | "run_failed" | "termination" | "lease_lost";

export interface WorkflowRunIdentity {
  readonly scope: WorkflowScope;
  readonly instanceId: string;
  readonly executionId: string;
  readonly createdAt: number;
  readonly epoch: number;
  readonly owner: string;
  /** Absolute lifetime ceiling, not the renewable run lease. */
  readonly deadlineAt: number;
}

export interface WorkflowDriver {
  do(
    name: string,
    retryDelaysSeconds: readonly number[],
    effect: () => Promise<JsonObject | undefined> | JsonObject | undefined,
  ): Promise<JsonObject | undefined>;
  sleep(name: string, seconds: number): Promise<void>;
  waitForEvent(name: string, type: string, timeoutSeconds: number): Promise<JsonObject | undefined>;
}

export interface WorkflowRuntimeOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomId: () => string;
  /** Resolve at or after the instant; cancellation may resolve or reject. */
  readonly waitUntil: (epochMs: number, signal: AbortSignal) => Promise<void>;
  readonly host: WorkflowExecutionHost;
  readonly leaseMs?: number;
}

export type WorkflowRunOutcome =
  | { readonly kind: "complete"; readonly output?: JsonObject }
  | { readonly kind: "parked" }
  | { readonly kind: "terminal"; readonly status: WorkflowInstanceStatus }
  | { readonly kind: "deferred"; readonly retryAt: number }
  | { readonly kind: "stale" };

export interface WorkflowRuntime {
  readonly instances: WorkflowInstances;
  runOne(scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome>;
}

/** Infrastructure/private-protocol failures never become application run_threw. */
export class WorkflowRuntimeError extends Error {
  constructor(
    readonly code:
      | "backend_unavailable"
      | "host_unavailable"
      | "stale_claim"
      | "invalid_runtime_input"
      | "step_conflict",
  ) {
    super(code);
    this.name = "WorkflowRuntimeError";
  }
}

/** Internal driver result; its app-facing JavaScript projection is not selected. */
export class WorkflowStepError extends Error {
  constructor(
    readonly code: "step_failed" | "wait_timeout" | "invalid_duration" | "document_too_large",
  ) {
    super(code);
    this.name = "WorkflowStepError";
  }
}

const ACTIVE = "'queued', 'running', 'sleeping', 'waiting'";
const TERMINAL = "'complete', 'errored', 'terminated'";
const RETENTION_MS = WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000;
const MAX_STEPS = 1_024;
const MAX_SECONDS = 31_536_000;
const CLAIM_ID =
  "tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ? AND execution_id = ? AND created_at = ? AND run_epoch = ? AND run_owner = ?";
const RUNNABLE = `${CLAIM_ID} AND status = 'running' AND run_lease_until > ? AND deadline_at > ? AND retention_until > ?`;
const STEP_ID = "execution_id = ? AND execution_created_at = ? AND name = ?";
const RUN_EXISTS = `EXISTS (SELECT 1 FROM tf_workflow_instances WHERE ${RUNNABLE})`;

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const leaseMs = options.leaseMs ?? 30_000;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 2 ||
    leaseMs > 86_400_000 ||
    typeof options.waitUntil !== "function" ||
    typeof options.host?.openPaused !== "function" ||
    typeof options.host?.stop !== "function"
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  const sql: Sql = {
    query: (statement, params) => backend(() => options.sql.query(statement, params)),
    run: (statement, params) => backend(() => options.sql.run(statement, params)),
    batch: (statements) =>
      backend(async () => {
        const result = await options.sql.batch(statements);
        if (result.length !== statements.length)
          throw new WorkflowRuntimeError("backend_unavailable");
        return result;
      }),
  };
  // The store owns its error mapping, including retryable private ID collisions.
  const store = createWorkflowInstances({
    sql: options.sql,
    clock: options.clock,
    randomId: options.randomId,
  });
  const now = (): number => {
    const value = options.clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new WorkflowRuntimeError("backend_unavailable");
    return value;
  };

  async function read(scope: WorkflowScope, id: string): Promise<InstanceRow | null> {
    const rows = await sql.query(
      "SELECT * FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?",
      [scope.tenantId, scope.workflowResourceUid, id],
    );
    if (rows.length > 1) throw new WorkflowRuntimeError("backend_unavailable");
    return rows[0] ? parseInstance(rows[0], scope, id) : null;
  }

  async function runnable(identity: WorkflowRunIdentity): Promise<boolean> {
    const timestamp = now();
    const rows = await sql.query(`SELECT 1 AS ok FROM tf_workflow_instances WHERE ${RUNNABLE}`, [
      ...claimParams(identity),
      timestamp,
      timestamp,
      timestamp,
    ]);
    return rows.length === 1;
  }

  /** Only call after acknowledgement or a proven hard-deadline expiry. */
  async function clearOwner(identity: WorkflowRunIdentity): Promise<void> {
    await sql.run(
      `UPDATE tf_workflow_instances SET run_owner = NULL, run_lease_until = NULL, revision = revision + 1 WHERE ${CLAIM_ID}`,
      claimParams(identity),
    );
  }

  async function stop(identity: WorkflowRunIdentity, reason: WorkflowStopReason): Promise<void> {
    for (;;) {
      const ack = await hostCall(() => options.host.stop(identity, reason));
      if (ack === "stopped") return;
      if (ack !== "not_registered") throw new WorkflowRuntimeError("host_unavailable");
      const timestamp = now();
      const current = await read(identity.scope, identity.instanceId);
      // An epoch can be replaced only after its lease expired or stop was
      // acknowledged. An owner may be cleared only by this same rule.
      if (
        !current ||
        !sameClaim(current, identity) ||
        current.leaseUntil === null ||
        current.leaseUntil <= timestamp ||
        identity.deadlineAt <= timestamp
      )
        return;
      const target = Math.min(current.leaseUntil, identity.deadlineAt);
      const controller = new AbortController();
      try {
        await options.waitUntil(target, controller.signal);
      } finally {
        controller.abort();
      }
      // Broken injected timers must not busy-loop or fabricate an expiry.
      if (now() < target) throw new WorkflowRuntimeError("host_unavailable");
    }
  }

  async function stopAndClear(
    identity: WorkflowRunIdentity,
    reason: WorkflowStopReason,
  ): Promise<void> {
    await stop(identity, reason);
    await clearOwner(identity);
  }

  const instances: WorkflowInstances = {
    ...store,
    async terminate(scope, id) {
      const normalizedScope = normalizeScope(scope);
      const normalizedId = inputIdentifier(id, "instance id");
      await store.terminate(normalizedScope, normalizedId);
      try {
        const current = await read(normalizedScope, normalizedId);
        if (current && isTerminal(current.status) && current.owner !== null) {
          // Repeated terminal requests still finish a stop abandoned by another
          // controller. A terminal SQL row by itself is not the acknowledgement.
          await stopAndClear(identityOf(current), "termination");
        }
      } catch {
        throw new WorkflowInstanceError("backend_unavailable");
      }
    },
  };

  async function runOne(scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome> {
    const normalizedScope = normalizeScope(scope);
    const normalizedId = inputIdentifier(id, "instance id");
    // Reuse the instance store's lifetime/retention authority.
    await store.get(normalizedScope, normalizedId);
    const current = await read(normalizedScope, normalizedId);
    if (!current) throw new WorkflowRuntimeError("stale_claim");
    if (isTerminal(current.status)) {
      if (current.owner !== null) await stopAndClear(identityOf(current), "termination");
      return { kind: "terminal", status: current.status };
    }
    const timestamp = now();
    const retryAt = Math.max(
      current.wakeAt ?? timestamp,
      current.owner === null ? timestamp : (current.leaseUntil ?? timestamp),
    );
    if (retryAt > timestamp)
      return { kind: "deferred", retryAt: Math.min(retryAt, current.deadlineAt) };
    const owner = generatedIdentifier(options.randomId(), "run owner");
    const leaseUntil = Math.min(current.deadlineAt, addDuration(timestamp, leaseMs, "run lease"));
    if (leaseUntil <= timestamp) return { kind: "deferred", retryAt: timestamp };
    const claimed = await sql.run(
      "UPDATE tf_workflow_instances SET status = 'running', run_epoch = run_epoch + 1, run_owner = ?, run_lease_until = ?, wake_at = NULL, pending_step_name = NULL, updated_at = ?, revision = revision + 1 " +
        "WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ? AND execution_id = ? AND created_at = ? AND run_epoch = ? " +
        "AND status IN (" +
        ACTIVE +
        ") AND deadline_at > ? AND retention_until > ? " +
        "AND (run_owner IS NULL OR run_lease_until <= ?) AND (wake_at IS NULL OR wake_at <= ?)",
      [
        owner,
        leaseUntil,
        timestamp,
        ...incarnationParams(current),
        current.epoch,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    if (claimed.changes !== 1) return { kind: "stale" };
    const identity: WorkflowRunIdentity = {
      ...identityOf({ ...current, owner }),
      epoch: current.epoch + 1,
    };
    return execute(identity, current.paramsJson, leaseUntil);
  }

  async function terminalize(
    identity: WorkflowRunIdentity,
    outcome: TerminalOutcome,
  ): Promise<WorkflowRunOutcome> {
    const timestamp = now();
    const expired = timestamp >= identity.deadlineAt;
    const status = expired || outcome.kind === "failed" ? "errored" : "complete";
    const endedAt = expired ? identity.deadlineAt : timestamp;
    const output =
      !expired && outcome.kind === "complete" && outcome.output !== undefined
        ? encodeDocument(outcome.output)
        : null;
    const reason = expired
      ? "lifetime_exceeded"
      : outcome.kind === "failed"
        ? outcome.reason
        : null;
    const terminalGuard =
      CLAIM_ID +
      " AND status IN (" +
      ACTIVE +
      ")" +
      (expired
        ? " AND deadline_at <= ?"
        : " AND status = 'running' AND run_lease_until > ? AND deadline_at > ?");
    const terminalParams = [...claimParams(identity), timestamp, ...(expired ? [] : [timestamp])];
    const cleanupGuard =
      "EXISTS (SELECT 1 FROM tf_workflow_instances WHERE " +
      CLAIM_ID +
      " AND status IN (" +
      TERMINAL +
      "))";
    const results = await sql.batch([
      {
        sql:
          "UPDATE tf_workflow_instances SET status = ?, output_json = ?, error_json = ?, retention_until = ?, wake_at = NULL, pending_step_name = NULL, updated_at = ?, revision = revision + 1 WHERE " +
          terminalGuard,
        params: [
          status,
          output,
          reason === null ? null : encodeDocument({ reason }),
          addDuration(endedAt, RETENTION_MS, "terminal retention"),
          endedAt,
          ...terminalParams,
        ],
      },
      {
        sql:
          "DELETE FROM tf_workflow_steps WHERE execution_id = ? AND execution_created_at = ? AND " +
          cleanupGuard,
        params: [identity.executionId, identity.createdAt, ...claimParams(identity)],
      },
      {
        sql: "DELETE FROM tf_workflow_events WHERE execution_id = ? AND " + cleanupGuard,
        params: [identity.executionId, ...claimParams(identity)],
      },
    ]);
    if (results[0]?.changes !== 1) return { kind: "stale" };
    if (status === "errored") return { kind: "terminal", status: "errored" };
    return output === null
      ? { kind: "complete" }
      : { kind: "complete", output: parseDocument(output) };
  }

  async function execute(
    identity: WorkflowRunIdentity,
    paramsJson: string | null,
    initialLease: number,
  ): Promise<WorkflowRunOutcome> {
    const heartbeatAbort = new AbortController();
    const interrupted = deferred<WorkflowRunOutcome>();
    let finishing = false;
    let fatal: unknown;
    let stepActive = false;
    const exhaustedStepErrors = new WeakSet<WorkflowStepError>();
    let heartbeat: Promise<void> = Promise.resolve();

    async function finish(outcome: TerminalOutcome): Promise<WorkflowRunOutcome> {
      finishing = true;
      heartbeatAbort.abort();
      const settled = await terminalize(identity, outcome);
      await stopAndClear(identity, outcome.kind === "complete" ? "complete" : "run_failed");
      return settled;
    }

    function failInfrastructure(error: unknown): void {
      fatal ??= error;
      finishing = true;
      heartbeatAbort.abort();
      interrupted.reject(error);
    }

    async function boundedFailure(
      reason: "lifetime_exceeded" | "step_limit_exceeded",
    ): Promise<never> {
      interrupted.resolve(await finish({ kind: "failed", reason }));
      return never();
    }

    async function park(
      name: string,
      status: "sleeping" | "waiting",
      wakeAt: number,
    ): Promise<never> {
      finishing = true;
      heartbeatAbort.abort();
      // The journal holds the private park intent. Publish sleeping/waiting
      // only after this execution context has actually stopped.
      await stop(identity, "park");
      const timestamp = now();
      const updated = await sql.run(
        "UPDATE tf_workflow_instances SET status = ?, pending_step_name = ?, " +
          // Close event-before-park even when sendEvent saw status=running.
          "wake_at = CASE WHEN ? = 'waiting' AND EXISTS (" +
          "SELECT 1 FROM tf_workflow_events AS event JOIN tf_workflow_steps AS step " +
          "ON event.execution_id = step.execution_id AND event.type = step.wait_type " +
          "WHERE step.execution_id = tf_workflow_instances.execution_id AND step.execution_created_at = tf_workflow_instances.created_at " +
          "AND step.name = ? AND event.created_at <= step.timeout_at) THEN ? ELSE ? END, " +
          "run_owner = NULL, run_lease_until = NULL, updated_at = ?, revision = revision + 1 WHERE " +
          RUNNABLE,
        [
          status,
          name,
          status,
          name,
          timestamp,
          wakeAt,
          timestamp,
          ...claimParams(identity),
          timestamp,
          timestamp,
          timestamp,
        ],
      );
      // Another terminal transition may have won while stop was pending.
      // Its same-claim owner can now be released; a replacement is untouched.
      if (updated.changes !== 1) await clearOwner(identity);
      interrupted.resolve(updated.changes === 1 ? { kind: "parked" } : { kind: "stale" });
      return never();
    }

    async function serialize<T>(work: () => Promise<T>): Promise<T> {
      if (stepActive || finishing) {
        failInfrastructure(new WorkflowRuntimeError("step_conflict"));
        return never();
      }
      stepActive = true;
      try {
        if (!(await runnable(identity))) throw new WorkflowRuntimeError("stale_claim");
        return await work();
      } catch (error) {
        if (error instanceof WorkflowStepError) {
          // Capture the classification before JavaScript receives the object.
          if (error.code === "step_failed") exhaustedStepErrors.add(error);
          throw error;
        }
        failInfrastructure(error);
        // Infrastructure faults cannot be caught by app code as a park/error
        // sentinel. The host is stopped by execute's rejection path.
        return never();
      } finally {
        stepActive = false;
      }
    }

    async function step(name: string, kind: StepKind, config: JsonObject): Promise<StepRow> {
      const existing = await readStep(identity, name);
      if (existing) {
        if (
          existing.state !== "complete" &&
          existing.state !== "errored" &&
          existing.kind !== kind
        ) {
          throw new WorkflowRuntimeError("step_conflict");
        }
        return existing;
      }
      const timestamp = now();
      const inserted = await sql.run(
        "INSERT INTO tf_workflow_steps (tenant_id, workflow_resource_uid, instance_id, execution_id, execution_created_at, name, kind, state, config_json, created_at, updated_at, revision) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1 WHERE " +
          RUN_EXISTS +
          " AND (SELECT COUNT(*) FROM tf_workflow_steps WHERE execution_id = ? AND execution_created_at = ?) < ?",
        [
          ...incarnationParams(identity),
          name,
          kind,
          encodeDocument(config),
          timestamp,
          timestamp,
          ...claimParams(identity),
          timestamp,
          timestamp,
          timestamp,
          identity.executionId,
          identity.createdAt,
          MAX_STEPS,
        ],
      );
      if (inserted.changes !== 1) {
        if (!(await runnable(identity))) throw new WorkflowRuntimeError("stale_claim");
        return boundedFailure("step_limit_exceeded");
      }
      const created = await readStep(identity, name);
      if (!created) throw new WorkflowRuntimeError("backend_unavailable");
      return created;
    }

    async function changeStep(
      name: string,
      prior: StepRow,
      assignment: string,
      values: readonly SqlParam[],
    ): Promise<StepRow> {
      const timestamp = now();
      const result = await sql.run(
        "UPDATE tf_workflow_steps SET " +
          assignment +
          ", updated_at = ?, revision = revision + 1 WHERE " +
          STEP_ID +
          " AND revision = ? AND " +
          RUN_EXISTS,
        [
          ...values,
          timestamp,
          identity.executionId,
          identity.createdAt,
          name,
          prior.revision,
          ...claimParams(identity),
          timestamp,
          timestamp,
          timestamp,
        ],
      );
      if (result.changes !== 1) throw new WorkflowRuntimeError("stale_claim");
      const updated = await readStep(identity, name);
      if (!updated) throw new WorkflowRuntimeError("stale_claim");
      return updated;
    }

    async function completeStep(
      name: string,
      prior: StepRow,
      output: JsonObject | undefined,
    ): Promise<JsonObject | undefined> {
      let json: string | null;
      try {
        json = output === undefined ? null : encodeDocument(output);
      } catch (error) {
        if (error instanceof DocumentValidationError && error.kind === "too_large") {
          throw new WorkflowStepError("document_too_large");
        }
        throw new WorkflowRuntimeError("invalid_runtime_input");
      }
      const saved = await changeStep(
        name,
        prior,
        "state = 'complete', result_json = ?, error_json = NULL, wake_at = NULL, timeout_at = NULL",
        [json],
      );
      return memo(saved);
    }

    const driver: WorkflowDriver = {
      do(name, retryDelaysSeconds, effect) {
        return serialize(async () => {
          const key = inputIdentifier(name, "step name");
          let current = await readStep(identity, key);
          if (current && (current.state === "complete" || current.state === "errored"))
            return memo(current);
          const delays = retryDelays(retryDelaysSeconds);
          if (typeof effect !== "function") throw new WorkflowRuntimeError("invalid_runtime_input");
          current = await step(key, "do", { retryDelaysSeconds: delays });
          if (current.state === "retry_wait") {
            const wake = integer(current.wakeAt);
            if (wake > now()) return park(key, "sleeping", Math.min(wake, identity.deadlineAt));
            current = await changeStep(key, current, "state = 'pending', wake_at = NULL", []);
          }
          // New code may choose a new explicit retry plan. Already-durable
          // wake times above are never recomputed from the new plan.
          const attempts =
            current.retryProgressJson === null
              ? 0
              : integer(parseDocument(current.retryProgressJson).attempt);
          let value: JsonObject | undefined;
          try {
            value = await effect();
          } catch (error) {
            if (error instanceof WorkflowRuntimeError) throw error;
            const delay = delays[attempts];
            if (delay === undefined) {
              await changeStep(key, current, "state = 'errored', error_json = ?", [
                '{"reason":"step_failed"}',
              ]);
              throw new WorkflowStepError("step_failed");
            }
            const wake = addDuration(now(), delay * 1_000, "retry wake");
            await changeStep(
              key,
              current,
              "state = 'retry_wait', retry_progress_json = ?, wake_at = ?",
              [encodeDocument({ attempt: attempts + 1 }), wake],
            );
            return park(key, "sleeping", Math.min(wake, identity.deadlineAt));
          }
          return completeStep(key, current, value);
        });
      },
      sleep(name, seconds) {
        return serialize(async () => {
          const key = inputIdentifier(name, "step name");
          const previous = await readStep(identity, key);
          if (previous && (previous.state === "complete" || previous.state === "errored")) {
            memo(previous);
            return;
          }
          const duration = secondsValue(seconds, 0);
          let current = await step(key, "sleep", { seconds: duration });
          const savedDuration = secondsValue(parseDocument(current.configJson).seconds, 0);
          const wake =
            current.wakeAt ?? addDuration(current.createdAt, savedDuration * 1_000, "sleep wake");
          if (wake > identity.deadlineAt) return boundedFailure("lifetime_exceeded");
          if (wake <= now()) {
            await completeStep(key, current, undefined);
            return;
          }
          if (current.state === "pending") {
            current = await changeStep(key, current, "state = 'waiting', wake_at = ?", [wake]);
          }
          return park(key, "sleeping", integer(current.wakeAt));
        });
      },
      waitForEvent(name, type, timeoutSeconds) {
        return serialize(async () => {
          const key = inputIdentifier(name, "step name");
          const previous = await readStep(identity, key);
          if (previous && (previous.state === "complete" || previous.state === "errored"))
            return memo(previous);
          const normalizedType = inputIdentifier(type, "event type");
          const timeout = secondsValue(timeoutSeconds, 1);
          let current = await step(key, "wait", { type: normalizedType, timeoutSeconds: timeout });
          const config = parseDocument(current.configJson);
          const savedType = inputIdentifier(config.type, "event type");
          const timeoutAt =
            current.timeoutAt ??
            addDuration(
              current.createdAt,
              secondsValue(config.timeoutSeconds, 1) * 1_000,
              "wait timeout",
            );
          if (current.state === "pending") {
            current = await changeStep(
              key,
              current,
              "state = 'waiting', wait_type = ?, timeout_at = ?, wake_at = ?",
              [savedType, timeoutAt, timeoutAt],
            );
          }
          const events = await sql.query(
            "SELECT event_id FROM tf_workflow_events WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ? AND execution_id = ? AND type = ? AND created_at <= ? ORDER BY event_id LIMIT 1",
            [...instanceParams(identity), identity.executionId, savedType, timeoutAt],
          );
          if (events[0]) {
            const eventId = integer(rowValue(events[0], "event_id"));
            const timestamp = now();
            const eventWhere =
              "event_id = ? AND tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ? AND execution_id = ? AND type = ? AND created_at <= ?";
            const eventParams = [
              eventId,
              ...instanceParams(identity),
              identity.executionId,
              savedType,
              timeoutAt,
            ];
            const results = await sql.batch([
              {
                sql:
                  "UPDATE tf_workflow_steps SET state = 'complete', result_json = (SELECT payload_json FROM tf_workflow_events WHERE " +
                  eventWhere +
                  "), error_json = NULL, wake_at = NULL, updated_at = ?, revision = revision + 1 WHERE " +
                  STEP_ID +
                  " AND revision = ? AND state = 'waiting' AND EXISTS (SELECT 1 FROM tf_workflow_events WHERE " +
                  eventWhere +
                  ") AND " +
                  RUN_EXISTS,
                params: [
                  ...eventParams,
                  timestamp,
                  identity.executionId,
                  identity.createdAt,
                  key,
                  current.revision,
                  ...eventParams,
                  ...claimParams(identity),
                  timestamp,
                  timestamp,
                  timestamp,
                ],
              },
              {
                sql:
                  "DELETE FROM tf_workflow_events WHERE " +
                  eventWhere +
                  " AND EXISTS (SELECT 1 FROM tf_workflow_steps WHERE " +
                  STEP_ID +
                  " AND revision = ? AND state = 'complete') AND " +
                  RUN_EXISTS,
                params: [
                  ...eventParams,
                  identity.executionId,
                  identity.createdAt,
                  key,
                  current.revision + 1,
                  ...claimParams(identity),
                  timestamp,
                  timestamp,
                  timestamp,
                ],
              },
            ]);
            if (results[0]?.changes !== 1 || results[1]?.changes !== 1)
              throw new WorkflowRuntimeError("stale_claim");
            const saved = await readStep(identity, key);
            if (!saved) throw new WorkflowRuntimeError("stale_claim");
            return memo(saved);
          }
          if (timeoutAt <= now()) {
            await changeStep(key, current, "state = 'errored', error_json = ?", [
              '{"reason":"wait_timeout"}',
            ]);
            throw new WorkflowStepError("wait_timeout");
          }
          return park(key, "waiting", Math.min(timeoutAt, identity.deadlineAt));
        });
      },
    };

    try {
      const session = await hostCall(() =>
        options.host.openPaused(
          identity,
          paramsJson === null ? undefined : parseDocument(paramsJson),
          initialLease,
        ),
      );
      if (typeof session?.run !== "function" || typeof session.extendDeadline !== "function") {
        throw new WorkflowRuntimeError("host_unavailable");
      }
      if (!(await runnable(identity))) {
        await stopAndClear(identity, "lease_lost");
        return { kind: "stale" };
      }
      heartbeat = (async () => {
        try {
          while (!heartbeatAbort.signal.aborted) {
            const target = Math.min(
              identity.deadlineAt,
              addDuration(now(), Math.max(1, Math.floor(leaseMs / 2)), "heartbeat"),
            );
            await options.waitUntil(target, heartbeatAbort.signal);
            if (heartbeatAbort.signal.aborted) return;
            if (now() < target) throw new WorkflowRuntimeError("host_unavailable");
            if (now() >= identity.deadlineAt) {
              interrupted.resolve(await finish({ kind: "failed", reason: "lifetime_exceeded" }));
              return;
            }
            const timestamp = now();
            const next = Math.min(
              identity.deadlineAt,
              addDuration(timestamp, leaseMs, "renewed lease"),
            );
            const result = await sql.run(
              "UPDATE tf_workflow_instances SET run_lease_until = ?, revision = revision + 1 WHERE " +
                RUNNABLE,
              [next, ...claimParams(identity), timestamp, timestamp, timestamp],
            );
            if (heartbeatAbort.signal.aborted) return;
            if (result.changes !== 1) throw new WorkflowRuntimeError("stale_claim");
            // SQL first; failed extension means no more settlement by this run.
            await hostCall(() => session.extendDeadline(next));
          }
        } catch (error) {
          if (!heartbeatAbort.signal.aborted) failInfrastructure(error);
        }
      })();
      const application = Promise.resolve()
        .then(() => session.run(driver))
        .then(
          async (outcome) => {
            if (finishing) return interrupted.promise;
            if (stepActive) throw new WorkflowRuntimeError("step_conflict");
            if (
              !outcome ||
              (outcome.kind !== "complete" && outcome.kind !== "failed") ||
              (outcome.kind === "failed" &&
                outcome.reason !== "run_threw" &&
                !(
                  outcome.reason === "step_failed" &&
                  exhaustedStepErrors.has(outcome.error) &&
                  outcome.error.code === "step_failed"
                ))
            ) {
              throw new WorkflowRuntimeError("host_unavailable");
            }
            return finish(outcome);
          },
          (error: unknown) => {
            // A successful stop may reject the host's outstanding run promise.
            // Parking/terminalization owns that outcome, not the transport race.
            if (finishing) return interrupted.promise;
            throw error;
          },
        );
      return await Promise.race([application, interrupted.promise]);
    } catch (error) {
      finishing = true;
      heartbeatAbort.abort();
      // Even failed opens may have registered a paused context. Never clear
      // their owner or let a new epoch start without stop/deadline proof.
      await stopAndClear(identity, "lease_lost");
      throw fatal ?? error;
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
    }
  }

  async function readStep(identity: WorkflowRunIdentity, name: string): Promise<StepRow | null> {
    const rows = await sql.query("SELECT * FROM tf_workflow_steps WHERE " + STEP_ID, [
      identity.executionId,
      identity.createdAt,
      name,
    ]);
    if (rows.length > 1) throw new WorkflowRuntimeError("backend_unavailable");
    return rows[0] ? parseStep(rows[0]) : null;
  }

  return { instances, runOne };
}

interface InstanceRow {
  readonly scope: WorkflowScope;
  readonly instanceId: string;
  readonly executionId: string;
  readonly createdAt: number;
  readonly epoch: number;
  readonly owner: string | null;
  readonly leaseUntil: number | null;
  readonly deadlineAt: number;
  readonly wakeAt: number | null;
  readonly status: WorkflowInstanceStatus;
  readonly paramsJson: string | null;
}
type StepKind = "do" | "sleep" | "wait";
interface StepRow {
  readonly kind: StepKind;
  readonly state: "pending" | "retry_wait" | "waiting" | "complete" | "errored";
  readonly revision: number;
  readonly createdAt: number;
  readonly configJson: string;
  readonly retryProgressJson: string | null;
  readonly resultJson: string | null;
  readonly errorJson: string | null;
  readonly wakeAt: number | null;
  readonly timeoutAt: number | null;
}

function instanceParams(
  identity: Pick<WorkflowRunIdentity, "scope" | "instanceId">,
): readonly SqlParam[] {
  return [identity.scope.tenantId, identity.scope.workflowResourceUid, identity.instanceId];
}
function incarnationParams(
  identity: Pick<WorkflowRunIdentity, "scope" | "instanceId" | "executionId" | "createdAt">,
): readonly SqlParam[] {
  return [...instanceParams(identity), identity.executionId, identity.createdAt];
}
function claimParams(identity: WorkflowRunIdentity): readonly SqlParam[] {
  return [...incarnationParams(identity), identity.epoch, identity.owner];
}
function identityOf(row: InstanceRow): WorkflowRunIdentity {
  if (row.owner === null) throw new WorkflowRuntimeError("backend_unavailable");
  return {
    scope: row.scope,
    instanceId: row.instanceId,
    executionId: row.executionId,
    createdAt: row.createdAt,
    epoch: row.epoch,
    owner: row.owner,
    deadlineAt: row.deadlineAt,
  };
}
function sameClaim(row: InstanceRow, identity: WorkflowRunIdentity): boolean {
  return (
    row.executionId === identity.executionId &&
    row.createdAt === identity.createdAt &&
    row.epoch === identity.epoch &&
    row.owner === identity.owner
  );
}
function isTerminal(status: WorkflowInstanceStatus): boolean {
  return status === "complete" || status === "errored" || status === "terminated";
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
  return value;
}
function numberOrNull(row: Row, key: string): number | null {
  const value = rowValue(row, key);
  return value === null ? null : integer(value);
}
function parseInstance(row: Row, scope: WorkflowScope, instanceId: string): InstanceRow {
  const status = rowValue(row, "status");
  const executionId = rowValue(row, "execution_id");
  if (
    typeof status !== "string" ||
    !["queued", "running", "sleeping", "waiting", "complete", "errored", "terminated"].includes(
      status,
    ) ||
    typeof executionId !== "string"
  )
    throw new WorkflowRuntimeError("backend_unavailable");
  const owner = nullableString(row, "run_owner");
  const leaseUntil = numberOrNull(row, "run_lease_until");
  if ((owner === null) !== (leaseUntil === null))
    throw new WorkflowRuntimeError("backend_unavailable");
  return {
    scope,
    instanceId,
    executionId,
    status: status as WorkflowInstanceStatus,
    createdAt: integer(rowValue(row, "created_at")),
    epoch: integer(rowValue(row, "run_epoch")),
    owner,
    leaseUntil,
    deadlineAt: integer(rowValue(row, "deadline_at")),
    wakeAt: numberOrNull(row, "wake_at"),
    paramsJson: nullableString(row, "params_json"),
  };
}
function parseStep(row: Row): StepRow {
  const kind = rowValue(row, "kind");
  const state = rowValue(row, "state");
  const configJson = nullableString(row, "config_json");
  if (
    typeof kind !== "string" ||
    !["do", "sleep", "wait"].includes(kind) ||
    typeof state !== "string" ||
    !["pending", "retry_wait", "waiting", "complete", "errored"].includes(state) ||
    configJson === null
  )
    throw new WorkflowRuntimeError("backend_unavailable");
  return {
    kind: kind as StepKind,
    state: state as StepRow["state"],
    configJson,
    revision: integer(rowValue(row, "revision")),
    createdAt: integer(rowValue(row, "created_at")),
    retryProgressJson: nullableString(row, "retry_progress_json"),
    resultJson: nullableString(row, "result_json"),
    errorJson: nullableString(row, "error_json"),
    wakeAt: numberOrNull(row, "wake_at"),
    timeoutAt: numberOrNull(row, "timeout_at"),
  };
}
function memo(step: StepRow): JsonObject | undefined {
  if (step.state === "errored") {
    const error = step.errorJson === null ? null : parseDocument(step.errorJson);
    if (error?.reason !== "step_failed" && error?.reason !== "wait_timeout") {
      throw new WorkflowRuntimeError("backend_unavailable");
    }
    throw new WorkflowStepError(error.reason);
  }
  return step.resultJson === null ? undefined : parseDocument(step.resultJson);
}
function secondsValue(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_SECONDS
  ) {
    throw new WorkflowStepError("invalid_duration");
  }
  return value;
}
function retryDelays(value: readonly number[]): number[] {
  if (!Array.isArray(value) || value.length > 99)
    throw new WorkflowRuntimeError("invalid_runtime_input");
  return value.map((delay) => {
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 43_200)
      throw new WorkflowRuntimeError("invalid_runtime_input");
    return delay;
  });
}
async function backend<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new WorkflowRuntimeError("backend_unavailable");
  }
}
async function hostCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new WorkflowRuntimeError("host_unavailable");
  }
}
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A fatal driver call can arrive before the outer race attaches.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
