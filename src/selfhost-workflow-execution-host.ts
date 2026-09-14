import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { JsonObject } from "./ports.ts";
import {
  spawnWorkerdExecutionGuard,
  type WorkerdExecutionGuard,
  type WorkerdExecutionRegistration,
  type WorkerdExecutionServiceGateway,
} from "./workerd-execution-guard.ts";
import {
  encodeDocument,
  inputIdentifier,
  normalizeScope,
  parseDocument,
  plainInputRecord,
} from "./workflow-data.ts";
import type {
  WorkflowApplicationOutcome,
  WorkflowDriver,
  WorkflowExecutionHost,
  WorkflowRunIdentity,
} from "./workflow-execution.ts";
import {
  createWorkflowTransportJournal,
  type WorkflowTransportJournal,
  WorkflowTransportJournalError,
} from "./workflow-transport-journal.ts";

/**
 * Host-private prepared execution, not a public Binding. Preparation selects
 * the then-current deployment and snapshots its verified modules/env without
 * importing or evaluating application code in the controller. On rejection,
 * preparation retains responsibility for its partial artifacts.
 */
export interface PreparedWorkerdWorkflow {
  readonly configPath: string;
  /** Private per-binding listeners the guard must bind before START. */
  readonly serviceGateways?: readonly WorkerdExecutionServiceGateway[];
  /** Bounded synchronous control latch for one already-correlated frame. */
  acceptFrame(sequence: number, payload: string): void;
  /** Called once, only after the exact guard acknowledges start. */
  run(driver: WorkflowDriver): Promise<WorkflowApplicationOutcome>;
  /**
   * After physical stop, close and join the physical payload ingress. The host
   * seals its journal only after this resolves, so no late frame may reach the
   * driver after the stop barrier. If ingress cannot be accounted for, reject:
   * merely rejecting run() does not prove this barrier or permit a stop ACK.
   * This must not await parked step results. Socket EOF alone is insufficient.
   * Must support retry after a failed drain.
   */
  drainAfterStop(): Promise<void>;
  /** Idempotent artifact cleanup, called only after reap and transport seal. */
  dispose(): Promise<void>;
}

export class SelfhostWorkflowHostError extends Error {
  constructor(readonly code: "invalid_input" | "capacity" | "already_registered" | "stopped") {
    super(code);
    this.name = "SelfhostWorkflowHostError";
  }
}

interface Registration {
  readonly identity: WorkflowRunIdentity;
  readonly input: JsonObject | undefined;
  readonly journalToken: string;
  readonly journal: WorkflowTransportJournal;
  readonly guard: Promise<WorkerdExecutionGuard>;
  readonly abort: AbortController;
  liveUntil: number;
  /** Includes unacknowledged renewals, which might have reached the guard. */
  retainUntil: number;
  running: boolean;
  startRequested: boolean;
  stopping: boolean;
  stopped: boolean;
  reaped: boolean;
  drained: boolean;
  journalSealed: boolean;
  transportFailure?: WorkflowTransportJournalError;
  prepared?: Promise<PreparedWorkerdWorkflow>;
  preparedValue?: PreparedWorkerdWorkflow;
  stopAttempt?: Promise<void>;
}

/**
 * Dormant self-host composition. The registry owns process lifecycle and the
 * prepare port owns loader construction while this host owns the private
 * journal composition. No serving entry selects this module, and a fake
 * prepared transport does not qualify a Workflow host.
 * Each registration owns one guarded process, never the shared HTTP workerd.
 */
export function createWorkerdWorkflowExecutionHost(options: {
  readonly guardBinary: string;
  readonly workerdBinary: string;
  readonly maximumRegistrations: number;
  readonly prepare: (
    identity: WorkflowRunIdentity,
    input: JsonObject | undefined,
    signal: AbortSignal,
    channel: {
      readonly journalToken: string;
      readonly recordPayload: (sequence: number, payload: string) => void;
    },
  ) => Promise<PreparedWorkerdWorkflow>;
  readonly clock?: () => number;
  /**
   * Private test seam; production uses the explicit retained binary paths.
   * A throwing factory owns cleanup of any partial construction; it must not
   * strand a process without returning its handle. No factory may send START.
   */
  readonly spawnGuard?: (
    registration: WorkerdExecutionRegistration,
    onJournalMarker: (sequence: number) => void,
  ) => WorkerdExecutionGuard;
}): WorkflowExecutionHost & { close(): Promise<void> } {
  const { guardBinary, workerdBinary, maximumRegistrations, prepare } = options;
  if (
    !isAbsolute(guardBinary) ||
    !isAbsolute(workerdBinary) ||
    !Number.isSafeInteger(maximumRegistrations) ||
    maximumRegistrations < 1 ||
    typeof prepare !== "function"
  ) {
    throw new SelfhostWorkflowHostError("invalid_input");
  }
  const readClock = options.clock ?? Date.now;
  const spawn =
    options.spawnGuard ??
    ((registration: WorkerdExecutionRegistration, onJournalMarker: (sequence: number) => void) =>
      spawnWorkerdExecutionGuard({
        guardBinary,
        workerdBinary,
        registration,
        onJournalMarker,
      }));
  const registrations = new Map<string, Registration>();
  let closed = false;

  function now(): number {
    const value = readClock();
    if (!instant(value)) throw new SelfhostWorkflowHostError("invalid_input");
    return value;
  }

  function requireLive(entry: Registration): void {
    if (entry.stopping || closed || now() >= entry.liveUntil) {
      throw new SelfhostWorkflowHostError("stopped");
    }
  }

  function stop(entry: Registration): Promise<void> {
    entry.stopping = true;
    entry.abort.abort();
    if (entry.stopped) return Promise.resolve();
    if (entry.stopAttempt) return entry.stopAttempt;
    const attempt = (async () => {
      let guard: WorkerdExecutionGuard;
      try {
        guard = await entry.guard;
      } catch {
        // The factory owns partial construction on failure. No handle was
        // returned and this registry could not have sent START.
        entry.reaped = true;
        entry.stopped = true;
        return;
      }
      // Do not wait for preparation, START or application completion to stop
      // the CPU. Guard STOP can preempt an unresolved START acknowledgement.
      if (!entry.reaped) {
        try {
          await guard.stop();
        } catch (error) {
          if (entry.startRequested) throw error;
          // Only a never-started guard may use its exit as stop proof: this
          // registry has sent no command that could evaluate application code.
          // After START, guard exit is explicitly NOT child/message proof.
          await guard.exited;
        }
        entry.reaped = true;
      }
      const prepared = await entry.prepared?.catch(() => undefined);
      if (!entry.drained) {
        if (prepared) await prepared.drainAfterStop();
        entry.drained = true;
      }
      if (!entry.journalSealed) {
        entry.journal.seal();
        entry.journalSealed = true;
      }
      if (entry.transportFailure) throw entry.transportFailure;
      if (prepared) {
        await prepared.dispose();
      }
      entry.stopped = true;
    })();
    entry.stopAttempt = attempt;
    void attempt.catch(() => {
      // Keep identity, files and the stop latch. A later stop may retry a
      // failed transport seal/cleanup; it can never reopen the execution.
      if (entry.stopAttempt === attempt) delete entry.stopAttempt;
    });
    return attempt;
  }

  return {
    async openPaused(identityInput, input, hardDeadline) {
      const identity = snapshotIdentity(identityInput);
      const timestamp = now();
      if (
        !instant(hardDeadline) ||
        hardDeadline <= timestamp ||
        hardDeadline > identity.deadlineAt
      ) {
        throw new SelfhostWorkflowHostError("invalid_input");
      }
      if (closed) throw new SelfhostWorkflowHostError("stopped");
      const key = identityKey(identity);
      for (const [oldKey, entry] of registrations) {
        // Only proved-stopped entries can be forgotten. An expired local
        // timer is not reap/message proof. Keep tombstones through all renewals.
        if (entry.stopped && entry.retainUntil <= timestamp) registrations.delete(oldKey);
      }
      if (registrations.has(key)) throw new SelfhostWorkflowHostError("already_registered");
      if (registrations.size >= maximumRegistrations) {
        throw new SelfhostWorkflowHostError("capacity");
      }
      const inputSnapshot = input === undefined ? undefined : parseDocument(encodeDocument(input));
      const journalToken = randomBytes(32).toString("hex");
      let entry!: Registration;
      const journal = createWorkflowTransportJournal({
        dispatch(sequence, payload) {
          const prepared = entry.preparedValue;
          if (!prepared) {
            const error = new WorkflowTransportJournalError("invalid_frame");
            entry.transportFailure ??= error;
            throw error;
          }
          prepared.acceptFrame(sequence, payload);
        },
      });
      const recordPayload = (sequence: number, payload: string): void => {
        if (entry.transportFailure) throw entry.transportFailure;
        if (entry.journalSealed) {
          journal.recordPayload(sequence, payload);
          return;
        }
        if (!entry.preparedValue) {
          const error = new WorkflowTransportJournalError("invalid_frame");
          entry.transportFailure ??= error;
          throw error;
        }
        journal.recordPayload(sequence, payload);
      };
      const onJournalMarker = (sequence: number): void => {
        if (entry.transportFailure) throw entry.transportFailure;
        if (entry.journalSealed) {
          journal.recordMarker(sequence);
          return;
        }
        if (!entry.preparedValue) {
          const error = new WorkflowTransportJournalError("invalid_frame");
          entry.transportFailure ??= error;
          throw error;
        }
        journal.recordMarker(sequence);
      };
      entry = {
        identity,
        input: inputSnapshot,
        journalToken,
        journal,
        // Schedule spawn after reserving the identity. stop(opening) must not
        // report not_registered while a guard is being constructed/registered.
        guard: Promise.resolve().then(() =>
          spawn(
            { identity: key, deadlineAt: identity.deadlineAt, until: hardDeadline, journalToken },
            onJournalMarker,
          ),
        ),
        abort: new AbortController(),
        liveUntil: hardDeadline,
        retainUntil: hardDeadline,
        running: false,
        startRequested: false,
        stopping: false,
        stopped: false,
        reaped: false,
        drained: false,
        journalSealed: false,
      };
      registrations.set(key, entry);
      try {
        const guard = await entry.guard;
        await guard.registered;
        requireLive(entry);
        return {
          async run(driver) {
            requireLive(entry);
            if (entry.running) throw new SelfhostWorkflowHostError("stopped");
            entry.running = true;
            entry.prepared = Promise.resolve().then(() => {
              requireLive(entry);
              return prepare(entry.identity, entry.input, entry.abort.signal, {
                journalToken: entry.journalToken,
                recordPayload,
              });
            });
            try {
              const prepared = await entry.prepared;
              requireLive(entry);
              if (entry.transportFailure) throw entry.transportFailure;
              if (
                typeof prepared?.configPath !== "string" ||
                !isAbsolute(prepared.configPath) ||
                typeof prepared.acceptFrame !== "function" ||
                typeof prepared.run !== "function" ||
                typeof prepared.drainAfterStop !== "function" ||
                typeof prepared.dispose !== "function"
              ) {
                throw new SelfhostWorkflowHostError("invalid_input");
              }
              entry.preparedValue = prepared;
              entry.startRequested = true;
              await guard.start(prepared.configPath, prepared.serviceGateways);
              requireLive(entry);
              return await prepared.run(driver);
            } catch (error) {
              // Infrastructure failure never becomes an application outcome.
              // Independently request stop; do not deadlock on a pending run.
              void stop(entry).catch(() => {});
              throw error;
            }
          },
          async extendDeadline(until) {
            requireLive(entry);
            if (!instant(until) || until <= entry.liveUntil || until > identity.deadlineAt) {
              throw new SelfhostWorkflowHostError("invalid_input");
            }
            entry.retainUntil = Math.max(entry.retainUntil, until);
            await guard.extendDeadline(until);
            // A late ACK cannot clear a concurrent stop latch.
            if (entry.stopping || closed) throw new SelfhostWorkflowHostError("stopped");
            entry.liveUntil = Math.max(entry.liveUntil, until);
          },
        };
      } catch (error) {
        void stop(entry).catch(() => {});
        throw error;
      }
    },
    async stop(identity) {
      const entry = registrations.get(identityKey(snapshotIdentity(identity)));
      if (!entry) return "not_registered";
      await stop(entry);
      return "stopped";
    },
    async close() {
      closed = true;
      // All stops begin together, so one stuck transport cannot leave other
      // CPUs running. Failure retains entries; close can safely be retried.
      const results = await Promise.allSettled([...registrations.values()].map(stop));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function snapshotIdentity(input: WorkflowRunIdentity): WorkflowRunIdentity {
  const value = plainInputRecord(input, "workflow run identity");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "createdAt,deadlineAt,epoch,executionId,instanceId,owner,scope") {
    throw new SelfhostWorkflowHostError("invalid_input");
  }
  const scope = Object.freeze(normalizeScope(value.scope));
  if (
    !instant(value.createdAt) ||
    !instant(value.deadlineAt) ||
    value.deadlineAt <= value.createdAt ||
    !instant(value.epoch) ||
    value.epoch < 1
  ) {
    throw new SelfhostWorkflowHostError("invalid_input");
  }
  return Object.freeze({
    scope,
    instanceId: inputIdentifier(value.instanceId, "instance id"),
    executionId: inputIdentifier(value.executionId, "execution id"),
    createdAt: value.createdAt,
    epoch: value.epoch,
    owner: inputIdentifier(value.owner, "owner"),
    deadlineAt: value.deadlineAt,
  });
}

function identityKey(identity: WorkflowRunIdentity): string {
  // snapshotIdentity fixes property order and rejects accessors/unknown fields.
  return createHash("sha256").update(encodeDocument(identity)).digest("hex");
}
